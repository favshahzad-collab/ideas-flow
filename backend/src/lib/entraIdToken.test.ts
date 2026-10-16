import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { forgetEntraDiscovery, verifyIdToken, type EntraConfig } from "./entra";

/**
 * Checking the assertion, with a real signature.
 *
 * This is the one function in the flow where being wrong lets the wrong person
 * in, so it is tested against a token that is actually signed rather than a
 * stub that returns claims. A key pair is generated here, the public half is
 * served as the tenant's JWKS, and every refusal below is a token that differs
 * from a good one in exactly one way.
 *
 * The nonce check is the reason this file exists. Signature, issuer, audience
 * and expiry are `jose`'s job and it does them well; the nonce is the only one
 * that depends on which sign-in this browser started, so it is the only one
 * that could have been left out and still looked right.
 */

const TENANT = "11111111-2222-3333-4444-555555555555";
const CLIENT = "66666666-7777-8888-9999-000000000000";
const ISSUER = `https://login.microsoftonline.com/${TENANT}/v2.0`;
const JWKS_URI = `https://login.microsoftonline.com/${TENANT}/discovery/v2.0/keys`;

const config: EntraConfig = {
  tenantId: TENANT,
  clientId: CLIENT,
  clientSecret: "a-client-secret",
  redirectUri: "https://flow.example.com/api/auth/sso/callback",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

let privateKey: CryptoKey;
let publicJwk: Record<string, unknown>;
const fetchMock = vi.fn();

/** A token that differs from a good one only where a test says it does. */
async function token(
  claims: Record<string, unknown> = {},
  overrides: { issuer?: string; audience?: string } = {}
) {
  return new SignJWT({ nonce: "the-nonce", ...claims })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(overrides.issuer ?? ISSUER)
    .setAudience(overrides.audience ?? CLIENT)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
}

beforeEach(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  privateKey = pair.privateKey;
  publicJwk = { ...(await exportJWK(pair.publicKey)), kid: "test-key", alg: "RS256" };

  forgetEntraDiscovery();
  fetchMock.mockReset();
  fetchMock.mockImplementation((url: string | URL) => {
    const href = url.toString();

    if (href.includes("openid-configuration")) {
      return Promise.resolve(
        json({
          issuer: ISSUER,
          authorization_endpoint: `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize`,
          token_endpoint: `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`,
          jwks_uri: JWKS_URI,
        })
      );
    }

    return Promise.resolve(json({ keys: [publicJwk] }));
  });

  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a token that is entirely in order", () => {
  it("gives back the person it is about", async () => {
    const identity = await verifyIdToken(
      config,
      await token({ email: "Adnan.Mumtaz@Ideas.com.pk", name: "Adnan Mumtaz", oid: "an-oid" }),
      "the-nonce"
    );

    expect(identity).toEqual({
      // Lower-cased here, because this is the only place that knows the claim
      // is an address and the directory is free to send any casing it likes.
      email: "adnan.mumtaz@ideas.com.pk",
      name: "Adnan Mumtaz",
      objectId: "an-oid",
      authenticatedAt: null,
    });
  });

  it("takes preferred_username when there is no email claim", async () => {
    // Which is what a work account normally carries, and the address people
    // recognise as theirs.
    const identity = await verifyIdToken(
      config,
      await token({ preferred_username: "KAZIM.ZAIDI@ideas.com.pk" }),
      "the-nonce"
    );

    expect(identity.email).toBe("kazim.zaidi@ideas.com.pk");
  });

  it("prefers the email claim where the directory publishes both", async () => {
    const identity = await verifyIdToken(
      config,
      await token({
        email: "real@ideas.com.pk",
        preferred_username: "other@ideas.com.pk",
      }),
      "the-nonce"
    );

    expect(identity.email).toBe("real@ideas.com.pk");
  });
});

describe("a token that should not be accepted", () => {
  it("refuses one answering a different sign-in", async () => {
    /*
     * The check `jose` cannot make. A token genuinely signed by the tenant,
     * genuinely for this application, captured from somebody else's sign-in -
     * without the nonce it would be replayable into this browser.
     */
    await expect(
      verifyIdToken(
        config,
        await token({ email: "a@ideas.com.pk", nonce: "a-different-sign-in" }),
        "the-nonce"
      )
    ).rejects.toThrow(/did not match the one this browser started/i);
  });

  it("refuses one with no nonce at all", async () => {
    await expect(
      verifyIdToken(
        config,
        await token({ email: "a@ideas.com.pk", nonce: undefined }),
        "the-nonce"
      )
    ).rejects.toThrow(/did not match the one this browser started/i);
  });

  it("refuses one issued for another application", async () => {
    await expect(
      verifyIdToken(
        config,
        await token({ email: "a@ideas.com.pk" }, { audience: "another-app" }),
        "the-nonce"
      )
    ).rejects.toThrow();
  });

  it("refuses one from another directory", async () => {
    await expect(
      verifyIdToken(
        config,
        await token(
          { email: "a@ideas.com.pk" },
          { issuer: "https://login.microsoftonline.com/somebody-else/v2.0" }
        ),
        "the-nonce"
      )
    ).rejects.toThrow();
  });

  it("refuses one signed by a key the directory does not publish", async () => {
    const impostor = await generateKeyPair("RS256", { extractable: true });
    const forged = await new SignJWT({ nonce: "the-nonce", email: "a@ideas.com.pk" })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(ISSUER)
      .setAudience(CLIENT)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(impostor.privateKey);

    await expect(verifyIdToken(config, forged, "the-nonce")).rejects.toThrow();
  });

  it("refuses an account with no address, rather than guessing one", async () => {
    // There is nothing to match against a person here, and inventing a match
    // is the one thing this must never do.
    await expect(
      verifyIdToken(config, await token({ name: "No Address" }), "the-nonce")
    ).rejects.toThrow(/did not come with an email address/i);
  });

  it("refuses a claim that is not an address at all", async () => {
    await expect(
      verifyIdToken(
        config,
        await token({ preferred_username: "not-an-address" }),
        "the-nonce"
      )
    ).rejects.toThrow(/did not come with an email address/i);
  });
});
