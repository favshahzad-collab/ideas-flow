import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearGraphTokenCache,
  sendGraphMail,
  testGraphConnection,
  type GraphMailConfig,
} from "./graphMailer";

/**
 * Talking to Microsoft, without talking to Microsoft.
 *
 * Two things are worth testing here and neither needs a tenant. The first is
 * the token cache: a queue sweep sends many notices, and a token per notice is
 * both slow and a good way to meet a rate limit on the morning a backlog
 * clears. The second is the error translation, which is most of the value this
 * file adds - Entra and Graph both answer with codes that name the real
 * problem, and "invalid_client" versus "Authorization_RequestDenied" is the
 * difference between two minutes on a secret and an hour in the portal.
 */

const config: GraphMailConfig = {
  tenantId: "11111111-2222-3333-4444-555555555555",
  clientId: "66666666-7777-8888-9999-000000000000",
  clientSecret: "a-client-secret",
  mailbox: "no-reply@example.com",
  fromName: "Ideas Flow",
  fromAddress: "no-reply@example.com",
  saveToSentItems: true,
};

const message = { to: "someone@example.com", subject: "Hello", text: "Body" };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const tokenResponse = () =>
  json({ access_token: "a-token", expires_in: 3600 });

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  clearGraphTokenCache();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearGraphTokenCache();
});

/** The URL of the nth call, so tests can say where a request went. */
const urlOf = (call: number) => String(fetchMock.mock.calls[call][0]);
const initOf = (call: number) =>
  fetchMock.mock.calls[call][1] as RequestInit | undefined;

/**
 * The request body of the nth call, as text.
 *
 * Narrowed rather than stringified: `BodyInit` includes shapes whose default
 * stringification is "[object Object]", and a test that asserted against that
 * would pass while proving nothing.
 */
const bodyOf = (call: number): string => {
  const body = initOf(call)?.body;
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  return "";
};

describe("getting a token", () => {
  it("asks for an application token, not a user one", async () => {
    // The client credentials flow: no user, no browser, no callback - which is
    // why localhost never has to be publicly reachable for this to work.
    fetchMock.mockResolvedValueOnce(tokenResponse());
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 202 }));

    await sendGraphMail(config, message);

    expect(urlOf(0)).toBe(
      `https://login.microsoftonline.com/${config.tenantId}/oauth2/v2.0/token`
    );
    const body = bodyOf(0);
    expect(body).toContain("grant_type=client_credentials");
    expect(body).toContain(
      encodeURIComponent("https://graph.microsoft.com/.default")
    );
  });

  it("reuses one token across many sends", async () => {
    fetchMock.mockResolvedValueOnce(tokenResponse());
    fetchMock.mockResolvedValue(new Response(null, { status: 202 }));

    await sendGraphMail(config, message);
    await sendGraphMail(config, message);
    await sendGraphMail(config, message);

    const tokenCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes("/oauth2/v2.0/token")
    );
    expect(tokenCalls).toHaveLength(1);
  });

  it("asks for a new one after a 401, rather than retrying a dead token", async () => {
    // A secret rotated or a consent revoked while the process was running.
    // Without this the cached token is retried until it expires on its own.
    fetchMock.mockResolvedValueOnce(tokenResponse());
    fetchMock.mockResolvedValueOnce(json({ error: { code: "InvalidAuthenticationToken" } }, 401));
    fetchMock.mockResolvedValueOnce(tokenResponse());
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 202 }));

    await expect(sendGraphMail(config, message)).rejects.toThrow();
    await sendGraphMail(config, message);

    const tokenCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes("/oauth2/v2.0/token")
    );
    expect(tokenCalls).toHaveLength(2);
  });
});

describe("sending", () => {
  it("posts as the configured mailbox", async () => {
    fetchMock.mockResolvedValueOnce(tokenResponse());
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 202 }));

    await sendGraphMail(config, message);

    expect(urlOf(1)).toBe(
      "https://graph.microsoft.com/v1.0/users/no-reply%40example.com/sendMail"
    );
  });

  it("sends plain text, with the sender's name on it", async () => {
    fetchMock.mockResolvedValueOnce(tokenResponse());
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 202 }));

    await sendGraphMail(config, message);

    const sent = JSON.parse(bodyOf(1)) as {
      message: {
        body: { contentType: string; content: string };
        from: { emailAddress: { address: string; name?: string } };
        toRecipients: { emailAddress: { address: string } }[];
      };
      saveToSentItems: boolean;
    };
    // Text rather than HTML: declaring HTML would mean escaping a memo title
    // somebody else typed.
    expect(sent.message.body.contentType).toBe("Text");
    expect(sent.message.from.emailAddress).toEqual({
      address: "no-reply@example.com",
      name: "Ideas Flow",
    });
    expect(sent.message.toRecipients[0].emailAddress.address).toBe(
      "someone@example.com"
    );
    expect(sent.saveToSentItems).toBe(true);
  });

  it("treats 202 Accepted as sent", async () => {
    // Graph queues it and answers with no body at all. Anything that expects
    // 200, or a JSON body, marks every delivered notice as failed.
    fetchMock.mockResolvedValueOnce(tokenResponse());
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 202 }));

    await expect(sendGraphMail(config, message)).resolves.toBeUndefined();
  });

  it("can be told not to keep a copy", async () => {
    fetchMock.mockResolvedValueOnce(tokenResponse());
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 202 }));

    await sendGraphMail({ ...config, saveToSentItems: false }, message);

    const sent = JSON.parse(bodyOf(1)) as { saveToSentItems: boolean };
    expect(sent.saveToSentItems).toBe(false);
  });
});

describe("what it says when Microsoft refuses", () => {
  const refusal = async (body: unknown, status: number) => {
    clearGraphTokenCache();
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(json(body, status));

    return sendGraphMail(config, message).catch((error: unknown) =>
      error instanceof Error ? error.message : String(error)
    );
  };

  it("names the secret when the secret is wrong", async () => {
    expect(
      await refusal(
        { error: "invalid_client", error_description: "AADSTS7000215: Invalid client secret provided." },
        401
      )
    ).toMatch(/client secret/i);
  });

  it("names the ids when the application is not in the directory", async () => {
    expect(
      await refusal(
        { error: "unauthorized_client", error_description: "AADSTS700016: Application not found." },
        400
      )
    ).toMatch(/tenant ID and client ID/i);
  });

  it("names consent when the permission was never granted", async () => {
    // The most common failure on a first attempt, and the one most likely to
    // be misread as a bad secret.
    expect(
      await refusal(
        { error: { code: "Authorization_RequestDenied", message: "Insufficient privileges." } },
        403
      )
    ).toMatch(/Mail\.Send.*admin consent/i);
  });

  it("names the policy when Exchange is blocking the mailbox", async () => {
    /*
     * The failure a correctly configured tenant hits deliberately: an
     * application access policy is how a tenant stops app-only Mail.Send being
     * good for every mailbox in the directory, and somebody who has just set
     * one up needs to recognise its refusal.
     */
    expect(
      await refusal(
        {
          error: {
            code: "ErrorAccessDenied",
            message: "Access to OData is disabled. ApplicationAccessPolicy blocked.",
          },
        },
        403
      )
    ).toMatch(/application access policy/i);
  });

  it("names the mailbox when the mailbox does not exist", async () => {
    expect(
      await refusal({ error: { code: "ResourceNotFound", message: "Resource not found." } }, 404)
    ).toMatch(/cannot find that mailbox/i);
  });

  it("says to wait when it is being rate-limited", async () => {
    expect(
      await refusal({ error: { code: "TooManyRequests", message: "Throttled." } }, 429)
    ).toMatch(/rate-limiting/i);
  });

  it("never puts the client secret in the message", async () => {
    // This message reaches the outbox row, the screen, and the logs.
    const said = await refusal(
      { error: "invalid_client", error_description: "bad secret a-client-secret" },
      401
    );
    expect(said).not.toContain(config.clientSecret);
  });

  it("carries the AADSTS number, because one sentence covers several of them", async () => {
    /*
     * `invalid_client` is returned for a wrong secret, an expired secret, and
     * a secret that belongs to a different registration than the client ID.
     * The sentence names the likeliest; the number is what separates them, and
     * what somebody can paste into a search or a ticket.
     */
    expect(
      await refusal(
        { error: "invalid_client", error_description: "AADSTS7000222: The provided client secret keys are expired." },
        401
      )
    ).toContain("(AADSTS7000222)");
  });

  it("carries the Graph error code when there is no AADSTS number", async () => {
    expect(
      await refusal({ error: { code: "ResourceNotFound", message: "Resource not found." } }, 404)
    ).toContain("(ResourceNotFound)");
  });

  it("explains a refusal from the send itself, not only from the token", async () => {
    /*
     * Every other case in this block refuses at the token endpoint, because
     * `refusal` queues a single response. That left the second throw in
     * `sendGraphMail` - the one for a refusal of the send - with no test at
     * all, and a change to how errors are read broke it while this file stayed
     * green. The compiler caught it; this test is so the next one does not
     * need to.
     */
    clearGraphTokenCache();
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(tokenResponse());
    fetchMock.mockResolvedValueOnce(
      json(
        {
          error: {
            code: "ErrorAccessDenied",
            message: "ApplicationAccessPolicy blocked this mailbox.",
          },
        },
        403
      )
    );

    await expect(sendGraphMail(config, message)).rejects.toThrow(
      /application access policy.*\(ErrorAccessDenied\)/i
    );
  });

  it("carries the code without the free text around it", async () => {
    // The identifier is safe to repeat; an error description is somewhere a
    // credential could be echoed back at us, so none of it is carried over.
    const said = await refusal(
      {
        error: "invalid_client",
        error_description: "AADSTS7000215: Invalid secret a-client-secret provided.",
      },
      401
    );
    expect(said).toContain("(AADSTS7000215)");
    expect(said).not.toContain(config.clientSecret);
    expect(said).not.toContain("Invalid secret");
  });
});

describe("when Microsoft cannot be reached at all", () => {
  /*
   * Not a refusal - a request that never arrived. `fetch` throws the same
   * `TypeError: fetch failed` for a DNS miss, a blocked port and a broken TLS
   * chain, and that bare message used to land in the outbox row and on the
   * mail screen. It cost a real afternoon: the server lost its connection for
   * ten seconds, the send failed, and all the screen said was "fetch failed" -
   * which reads as a broken configuration rather than a broken network.
   */
  const unreachable = (code?: string) => {
    const error = new TypeError("fetch failed");
    if (code) {
      (error as { cause?: unknown }).cause = Object.assign(new Error("socket"), {
        code,
      });
    }
    return error;
  };

  const failure = async (code?: string) => {
    clearGraphTokenCache();
    fetchMock.mockReset();
    fetchMock.mockRejectedValueOnce(unreachable(code));

    return sendGraphMail(config, message).catch((error: unknown) =>
      error instanceof Error ? error.message : String(error)
    );
  };

  it("never reports the bare 'fetch failed'", async () => {
    const said = await failure("UND_ERR_CONNECT_TIMEOUT");

    expect(said).not.toMatch(/^fetch failed$/i);
    // Which host went unanswered is half the diagnosis.
    expect(said).toContain("login.microsoftonline.com");
  });

  it("names a timeout, and where to go looking for it", async () => {
    const said = await failure("UND_ERR_CONNECT_TIMEOUT");

    expect(said).toMatch(/timed out/i);
    expect(said).toMatch(/firewall or proxy/i);
  });

  it("names DNS when the host has no answer", async () => {
    expect(await failure("ENOTFOUND")).toMatch(/DNS/);
  });

  it("names interception when the certificate is refused", async () => {
    expect(await failure("CERT_HAS_EXPIRED")).toMatch(/intercepting/i);
  });

  it("carries the code, because it is what separates the causes", async () => {
    expect(await failure("ECONNREFUSED")).toContain("(ECONNREFUSED)");
  });

  it("still says something useful when there is no code", async () => {
    const said = await failure();

    expect(said).toMatch(/could not reach/i);
    // An empty bracket is what a naive template leaves behind.
    expect(said).not.toContain("()");
  });

  it("covers the send itself, not only the token", async () => {
    clearGraphTokenCache();
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(tokenResponse());
    fetchMock.mockRejectedValueOnce(unreachable("ETIMEDOUT"));

    await expect(sendGraphMail(config, message)).rejects.toThrow(
      /graph.microsoft.com/
    );
  });

  it("covers the connection test too", async () => {
    clearGraphTokenCache();
    fetchMock.mockReset();
    fetchMock.mockRejectedValueOnce(unreachable("ENOTFOUND"));

    await expect(testGraphConnection(config)).rejects.toThrow(/DNS/);
  });
});

describe("testing the connection", () => {
  it("reads the mailbox rather than sending anything", async () => {
    fetchMock.mockResolvedValueOnce(tokenResponse());
    fetchMock.mockResolvedValueOnce(
      json({ mail: "no-reply@example.com", displayName: "Ideas Flow" })
    );

    const who = await testGraphConnection(config);

    expect(urlOf(1)).toContain("/users/no-reply%40example.com");
    expect(fetchMock.mock.calls.every(([url]) => !String(url).includes("sendMail"))).toBe(true);
    expect(who).toEqual({
      mailbox: "no-reply@example.com",
      displayName: "Ideas Flow",
      mailboxConfirmed: true,
    });
  });

  it("passes when the directory is closed to it, because sending does not need the directory", async () => {
    /*
     * The case that matters, and the one this used to get wrong.
     *
     * `GET /users/{id}` wants User.Read.All; `POST /users/{id}/sendMail` wants
     * Mail.Send. An application holding exactly what it needs to send is
     * therefore refused by the directory, and reporting that as a failure sent
     * an administrator off to grant a permission they had already granted -
     * and, worse, invited them to add a tenant-wide directory read that this
     * application has no business holding.
     */
    fetchMock.mockResolvedValueOnce(tokenResponse());
    fetchMock.mockResolvedValueOnce(
      json(
        { error: { code: "Authorization_RequestDenied", message: "Insufficient privileges." } },
        403
      )
    );

    const who = await testGraphConnection(config);

    expect(who.mailboxConfirmed).toBe(false);
    // It falls back to the address it was given rather than inventing one.
    expect(who.mailbox).toBe(config.mailbox);
  });

  it("still fails when Exchange is the one refusing", async () => {
    // A policy refusal is about sending, not about the directory, so it is a
    // real finding and stays a failure.
    fetchMock.mockResolvedValueOnce(tokenResponse());
    fetchMock.mockResolvedValueOnce(
      json(
        {
          error: {
            code: "ErrorAccessDenied",
            message: "ApplicationAccessPolicy blocked this mailbox.",
          },
        },
        403
      )
    );

    await expect(testGraphConnection(config)).rejects.toThrow(/application access policy/i);
  });

  it("fails with the mailbox message when the mailbox is missing", async () => {
    fetchMock.mockResolvedValueOnce(tokenResponse());
    fetchMock.mockResolvedValueOnce(
      json({ error: { code: "ResourceNotFound", message: "not found" } }, 404)
    );

    await expect(testGraphConnection(config)).rejects.toThrow(/cannot find that mailbox/i);
  });

  it("fails outright when the token is refused, whatever the mailbox says", async () => {
    // Nothing past the token is worth reporting if the token itself is wrong.
    fetchMock.mockResolvedValueOnce(
      json({ error: "invalid_client", error_description: "AADSTS7000215: bad secret." }, 401)
    );

    await expect(testGraphConnection(config)).rejects.toThrow(/client secret/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
