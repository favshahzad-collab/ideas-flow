import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  authorizeUrl,
  createPkcePair,
  discover,
  exchangeCode,
  forgetEntraDiscovery,
  type EntraConfig,
} from "./entra";

/**
 * The sign-in round trip, without a directory.
 *
 * Three things here are worth pinning and none of them needs a tenant. The
 * PKCE pair has to be a real one, because a challenge that is not the SHA-256
 * of the verifier fails at Microsoft with a message about neither. The
 * discovery document decides which issuer this deployment will trust, and
 * accepting a multi-tenant one would mean accepting an assertion from any
 * directory in the world - including one an attacker owns. And the token
 * endpoint's refusals carry AADSTS numbers that are the whole difference
 * between two minutes on a secret and an hour in the portal.
 */

const config: EntraConfig = {
  tenantId: "11111111-2222-3333-4444-555555555555",
  clientId: "66666666-7777-8888-9999-000000000000",
  clientSecret: "a-client-secret",
  redirectUri: "https://flow.example.com/api/auth/sso/callback",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const openidConfig = (overrides: Record<string, unknown> = {}) =>
  json({
    issuer: `https://login.microsoftonline.com/${config.tenantId}/v2.0`,
    authorization_endpoint: `https://login.microsoftonline.com/${config.tenantId}/oauth2/v2.0/authorize`,
    token_endpoint: `https://login.microsoftonline.com/${config.tenantId}/oauth2/v2.0/token`,
    jwks_uri: `https://login.microsoftonline.com/${config.tenantId}/discovery/v2.0/keys`,
    ...overrides,
  });

const fetchMock = vi.fn();

beforeEach(() => {
  forgetEntraDiscovery();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the PKCE pair", () => {
  it("makes a challenge that is genuinely the digest of the verifier", async () => {
    const { verifier, challenge } = createPkcePair();

    const expected = Buffer.from(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))
    ).toString("base64url");

    expect(challenge).toBe(expected);
  });

  it("is a different pair every time", () => {
    const first = createPkcePair();
    const second = createPkcePair();

    expect(first.verifier).not.toBe(second.verifier);
  });

  it("stays inside the length the spec allows", () => {
    const { verifier } = createPkcePair();

    // 43 to 128 characters of unreserved alphabet, or Microsoft rejects it.
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
    expect(verifier).toMatch(/^[A-Za-z0-9\-._~]+$/);
  });
});

describe("finding the directory", () => {
  it("asks the tenant rather than assembling the endpoints here", async () => {
    fetchMock.mockResolvedValue(openidConfig());

    const found = await discover(config.tenantId);

    expect(fetchMock.mock.calls[0][0]).toContain(
      "/.well-known/openid-configuration"
    );
    expect(found.issuer).toContain(config.tenantId);
  });

  it("asks once and remembers, so a sign-in does not wait on it twice", async () => {
    fetchMock.mockResolvedValue(openidConfig());

    await discover(config.tenantId);
    await discover(config.tenantId);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses a multi-tenant endpoint outright", async () => {
    /*
     * `common` and `organizations` answer with a literal {tenantid} in the
     * issuer, which means "whoever signed this". An HR system that accepts
     * that accepts an assertion from a directory the attacker controls.
     */
    fetchMock.mockResolvedValue(
      openidConfig({
        issuer: "https://login.microsoftonline.com/{tenantid}/v2.0",
      })
    );

    await expect(discover("common")).rejects.toThrow(
      /any Microsoft directory in the world/i
    );
  });

  it("says which field to go and look at when the directory is unknown", async () => {
    fetchMock.mockResolvedValue(json({ error: "not found" }, 400));

    await expect(discover(config.tenantId)).rejects.toThrow(
      /Directory \(tenant\) ID/
    );
  });

  it("does not remember a failure as if it were an answer", async () => {
    fetchMock.mockResolvedValueOnce(json({}, 500));
    await expect(discover(config.tenantId)).rejects.toThrow();

    fetchMock.mockResolvedValueOnce(openidConfig());
    await expect(discover(config.tenantId)).resolves.toMatchObject({
      issuer: expect.stringContaining(config.tenantId),
    });
  });
});

describe("where the browser is sent", () => {
  beforeEach(() => {
    fetchMock.mockResolvedValue(openidConfig());
  });

  it("carries everything the round trip is proved with", async () => {
    const url = new URL(
      await authorizeUrl(config, {
        state: "a-state",
        nonce: "a-nonce",
        codeChallenge: "a-challenge",
      })
    );

    expect(url.searchParams.get("client_id")).toBe(config.clientId);
    expect(url.searchParams.get("redirect_uri")).toBe(config.redirectUri);
    expect(url.searchParams.get("state")).toBe("a-state");
    expect(url.searchParams.get("nonce")).toBe("a-nonce");
    expect(url.searchParams.get("code_challenge")).toBe("a-challenge");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("response_type")).toBe("code");
  });

  it("asks Microsoft to say when the password was entered, but only for a confirmation", async () => {
    /*
     * Microsoft leaves `auth_time` out of ID tokens unless asked, and without
     * it a remembered sign-in cannot be told from a fresh one.
     */
    const confirming = new URL(
      await authorizeUrl(config, {
        state: "s",
        nonce: "n",
        codeChallenge: "c",
        prompt: "login",
      })
    );
    expect(confirming.searchParams.get("prompt")).toBe("login");
    expect(JSON.parse(confirming.searchParams.get("claims")!)).toEqual({
      id_token: { auth_time: { essential: true } },
    });

    const signingIn = new URL(
      await authorizeUrl(config, { state: "s", nonce: "n", codeChallenge: "c" })
    );
    expect(signingIn.searchParams.get("claims")).toBeNull();
  });

  it("asks who somebody is and nothing else", async () => {
    // No Graph permission, no offline_access: the session that follows is
    // this application's own, and Microsoft's tokens are read once and
    // thrown away.
    const url = new URL(
      await authorizeUrl(config, {
        state: "s",
        nonce: "n",
        codeChallenge: "c",
      })
    );

    expect(url.searchParams.get("scope")).toBe("openid profile email");
  });
});

describe("trading the code", () => {
  beforeEach(() => {
    fetchMock.mockResolvedValueOnce(openidConfig());
  });

  it("sends the verifier and the secret, because they prove different things", async () => {
    fetchMock.mockResolvedValueOnce(json({ id_token: "an-id-token" }));

    await exchangeCode(config, { code: "a-code", codeVerifier: "a-verifier" });

    const body = fetchMock.mock.calls[1][1].body as URLSearchParams;
    // PKCE proves it is the same browser that started; the secret proves it
    // is this application. Neither stands in for the other.
    expect(body.get("code_verifier")).toBe("a-verifier");
    expect(body.get("client_secret")).toBe(config.clientSecret);
    expect(body.get("grant_type")).toBe("authorization_code");
  });

  it("carries the AADSTS number through, which is the part worth searching", async () => {
    fetchMock.mockResolvedValueOnce(
      json(
        {
          error: "invalid_client",
          error_description:
            "AADSTS7000215: Invalid client secret provided.\r\nTrace ID: abc",
        },
        401
      )
    );

    await expect(
      exchangeCode(config, { code: "c", codeVerifier: "v" })
    ).rejects.toThrow(/AADSTS7000215/);
  });

  it("drops the trace id, which names nothing anybody here can act on", async () => {
    fetchMock.mockResolvedValueOnce(
      json(
        {
          error: "invalid_grant",
          error_description: "AADSTS50011: Redirect URI mismatch.\r\nTrace ID: xyz",
        },
        400
      )
    );

    // Read the message and assert on it directly. `rejects.not.toThrow` reads
    // like it says this, and passes whether or not it does.
    let message = "";

    try {
      await exchangeCode(config, { code: "c", codeVerifier: "v" });
    } catch (thrown) {
      message = (thrown as Error).message;
    }

    expect(message).toContain("AADSTS50011");
    expect(message).not.toContain("Trace ID");
  });

  it("still says something when Microsoft explains nothing", async () => {
    fetchMock.mockResolvedValueOnce(json({}, 503));

    await expect(
      exchangeCode(config, { code: "c", codeVerifier: "v" })
    ).rejects.toThrow(/HTTP 503/);
  });
});

describe("when Microsoft cannot be reached at all", () => {
  it("names the network fault rather than saying fetch failed", async () => {
    // The whole point of the shared `reach` wrapper: DNS, a firewall and TLS
    // interception all arrive as `TypeError: fetch failed`, and have entirely
    // different fixes.
    const failure = new TypeError("fetch failed");
    (failure as { cause?: unknown }).cause = { code: "ENOTFOUND" };
    fetchMock.mockRejectedValue(failure);

    await expect(discover(config.tenantId)).rejects.toThrow(
      /cannot look up login\.microsoftonline\.com.*DNS/is
    );
  });
});
