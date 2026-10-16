import { logger } from "./logger";
import { reach as reachHost } from "./reach";

/** Every Graph call goes through the shared wrapper, tagged as mail. */
const reach = (url: string, init?: RequestInit) =>
  reachHost(url, init, "mail.graph.unreachable");

/**
 * Sending through Microsoft Graph, app-only.
 *
 * The application authenticates as itself with the client credentials flow -
 * no user, no browser, no callback - and hands the finished message to
 * Exchange Online. Nothing here is reachable from the browser: the secret
 * lives on this side and the frontend only ever asks this API to send.
 *
 * Why this is the one to prefer on Microsoft 365: the message never crosses
 * SMTP, so it is not something SPF has an opinion about. A relay has to be
 * authorised in DNS before anybody believes it, and the failure when it is not
 * is silent - notices land in Junk and the memos simply sit. Graph moves that
 * whole problem inside the tenant.
 *
 * The one thing this file cannot do is limit which mailbox it may send as.
 * `Mail.Send` as an application permission is tenant-wide, so the token is
 * good for every mailbox in the directory. Naming one in the configuration
 * keeps this application honest, but the control that actually binds is an
 * Exchange application access policy, and that is a tenant setting rather than
 * anything code can assert. Said out loud here because a reader would
 * otherwise reasonably assume `mailbox` is a restriction.
 */

const LOGIN_HOST = "https://login.microsoftonline.com";
const GRAPH = "https://graph.microsoft.com/v1.0";

export type GraphMailConfig = {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  /** The mailbox to send as. */
  mailbox: string;
  fromName?: string | null;
  fromAddress: string;
  saveToSentItems: boolean;
};

export type GraphMessage = {
  to: string;
  subject: string;
  text: string;
};

/**
 * One token per application, reused until shortly before it expires.
 *
 * Tokens last an hour and every notice in a sweep would otherwise fetch its
 * own, which is both slow and a good way to meet a rate limit on a morning
 * when a queue has backed up. Sixty seconds of headroom so a token cannot
 * expire between the check and the request that uses it.
 */
type CachedToken = { value: string; expiresAt: number };
const tokens = new Map<string, CachedToken>();
const EXPIRY_HEADROOM_MS = 60_000;

const cacheKey = (config: GraphMailConfig) =>
  `${config.tenantId}:${config.clientId}`;

/** Drop every cached token. For a settings change, and for tests. */
export function clearGraphTokenCache(): void {
  tokens.clear();
}

/**
 * What went wrong, in words an administrator can act on.
 *
 * Graph and Entra both answer with a code that names the actual problem, and
 * the difference between "the secret is wrong" and "nobody has consented to
 * the permission" is the difference between a two-minute fix and an hour in
 * the portal. The raw code is kept on the end for anyone searching for it.
 */
function explain(code: string, message: string, status: number): string {
  const text = `${code} ${message}`;

  /*
   * The code itself, on the end of whichever sentence we choose.
   *
   * `invalid_client` covers several distinct AADSTS numbers - a wrong secret,
   * an expired one, and a secret belonging to a different registration than
   * the client ID - and they need different fixes. The sentence names the
   * likeliest, and this is what tells somebody which of them they actually
   * have, and what they can paste into a search or a ticket.
   *
   * Only the identifier is carried over, never the free text around it: this
   * string reaches the outbox, the screen and the logs, and an error
   * description is somewhere a credential could be echoed back at us.
   */
  const identifier = /AADSTS\d+/i.exec(text)?.[0] ?? (/^[\w.]+$/.test(code) ? code : "");
  const said = (sentence: string) =>
    identifier ? `${sentence} (${identifier})` : sentence;

  if (/AADSTS7000215|invalid_client/i.test(text)) {
    return said(
      "Microsoft rejected the client secret. Check it has been copied whole, that it has not expired, and that it belongs to this client ID."
    );
  }
  if (/AADSTS700016|unauthorized_client/i.test(text)) {
    return said(
      "Microsoft does not recognise that application in that directory. Check the tenant ID and client ID."
    );
  }
  if (/AADSTS90002/i.test(text)) {
    return said("Microsoft does not recognise that tenant ID.");
  }
  // Before the general access-denied below: a policy refusal arrives as one,
  // so testing for the broad case first means never reporting the narrow one.
  if (/ApplicationAccessPolicy|access to OData is disabled/i.test(text)) {
    return said(
      "An Exchange application access policy is blocking this mailbox. Add it to the group the policy allows."
    );
  }
  if (/Authorization_RequestDenied|ErrorAccessDenied|insufficient/i.test(text)) {
    return said(
      "The application is not allowed to send. Grant the Mail.Send application permission and give it admin consent."
    );
  }
  if (/ResourceNotFound|ErrorInvalidUser|does not exist/i.test(text) || status === 404) {
    return said("Microsoft cannot find that mailbox. Check the sending address exists in this tenant.");
  }
  if (status === 429) {
    return said("Microsoft is rate-limiting this application. Wait a minute and try again.");
  }

  return `Microsoft refused the request: ${message || code || `HTTP ${status}`}`;
}

/**
 * The sentence for a person, and the code for the caller.
 *
 * The code comes back separately because one status can mean two unrelated
 * things: a 403 from the directory is this application declining to hold a
 * permission it does not need, while a 403 from Exchange is a refusal to send.
 * Only the code separates them.
 */
async function readError(
  response: Response
): Promise<{ message: string; code: string }> {
  const body = await response.text();

  try {
    const parsed = JSON.parse(body) as {
      error?: string | { code?: string; message?: string };
      error_description?: string;
    };

    // The two endpoints disagree about the shape: the token endpoint answers
    // `{error, error_description}`, Graph answers `{error: {code, message}}`.
    if (typeof parsed.error === "string") {
      return {
        message: explain(parsed.error, parsed.error_description ?? "", response.status),
        code: parsed.error,
      };
    }
    return {
      message: explain(
        parsed.error?.code ?? "",
        parsed.error?.message ?? "",
        response.status
      ),
      code: parsed.error?.code ?? "",
    };
  } catch {
    return { message: explain("", body.slice(0, 200), response.status), code: "" };
  }
}


async function accessToken(config: GraphMailConfig): Promise<string> {
  const key = cacheKey(config);
  const cached = tokens.get(key);

  if (cached && cached.expiresAt > Date.now() + EXPIRY_HEADROOM_MS) {
    return cached.value;
  }

  const response = await reach(
    `${LOGIN_HOST}/${encodeURIComponent(config.tenantId)}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      /*
       * `.default` asks for every application permission already consented to
       * for this app, which is how the client credentials flow works: there is
       * no user to consent to anything at request time, so the scope is
       * whatever an administrator granted in advance.
       */
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        scope: "https://graph.microsoft.com/.default",
        grant_type: "client_credentials",
      }),
    }
  );

  if (!response.ok) {
    // Deliberately not logging the body: a failed token response echoes the
    // request back in some cases, and this is the one place a secret could
    // reach a log file.
    logger.error("mail.graph.token_failed", { status: response.status });
    throw new Error((await readError(response)).message);
  }

  const payload = (await response.json()) as {
    access_token?: string;
    expires_in?: number;
  };

  if (!payload.access_token) {
    throw new Error("Microsoft returned no access token.");
  }

  tokens.set(key, {
    value: payload.access_token,
    expiresAt: Date.now() + (payload.expires_in ?? 3600) * 1000,
  });

  return payload.access_token;
}

/**
 * Prove as much as can be proved without sending anything.
 *
 * The token is the part that matters, and it is conclusive: Entra issues one
 * only if the tenant, the application and the secret all agree. Everything a
 * wrong value in this form can do shows up here.
 *
 * Reading the mailbox afterwards is a bonus, and it is allowed to fail. It
 * asks the directory, and `GET /users/{id}` wants `User.Read.All`, which
 * sending mail does not: `POST /users/{id}/sendMail` needs `Mail.Send` alone.
 * So a correctly configured application - one holding exactly the permission
 * it needs and nothing more - is refused here, and an earlier version of this
 * function reported that refusal as a failure and told the administrator to go
 * and grant Mail.Send, which they had already done. The directory being closed
 * to us is the right answer, not a fault, and the only honest thing to say
 * afterwards is that the mailbox itself is unconfirmed until a test email goes
 * through it.
 */
export async function testGraphConnection(config: GraphMailConfig): Promise<{
  mailbox: string;
  displayName: string | null;
  /** Whether the directory confirmed the mailbox, rather than us assuming it. */
  mailboxConfirmed: boolean;
}> {
  const token = await accessToken(config);

  const response = await reach(
    `${GRAPH}/users/${encodeURIComponent(config.mailbox)}?$select=mail,userPrincipalName,displayName`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  if (!response.ok) {
    const refusal = await readError(response);

    /*
     * Only the directory's own refusal is excused, and only by its code. A
     * mailbox that does not exist still answers 404, and an Exchange
     * application access policy still answers with its own code - both are
     * real findings about this configuration, and both stay failures.
     */
    if (response.status === 403 && /Authorization_RequestDenied/i.test(refusal.code)) {
      return { mailbox: config.mailbox, displayName: null, mailboxConfirmed: false };
    }

    throw new Error(refusal.message);
  }

  const user = (await response.json()) as {
    mail?: string;
    userPrincipalName?: string;
    displayName?: string;
  };

  return {
    mailbox: user.mail ?? user.userPrincipalName ?? config.mailbox,
    displayName: user.displayName ?? null,
    mailboxConfirmed: true,
  };
}

/**
 * Send one message.
 *
 * Throws on refusal, like the SMTP path does, because the caller is the outbox
 * worker and a throw is how a row is marked for another attempt.
 */
export async function sendGraphMail(
  config: GraphMailConfig,
  message: GraphMessage
): Promise<void> {
  const token = await accessToken(config);

  const response = await reach(
    `${GRAPH}/users/${encodeURIComponent(config.mailbox)}/sendMail`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: {
          subject: message.subject,
          // Text rather than HTML: every notice this application sends is
          // plain text, and declaring HTML would mean escaping a memo title
          // somebody else typed.
          body: { contentType: "Text", content: message.text },
          toRecipients: [{ emailAddress: { address: message.to } }],
          from: {
            emailAddress: {
              address: config.fromAddress,
              ...(config.fromName ? { name: config.fromName } : {}),
            },
          },
        },
        saveToSentItems: config.saveToSentItems,
      }),
    }
  );

  // 202 Accepted is the success here; Graph queues it and answers with no body.
  if (!response.ok) {
    if (response.status === 401) {
      // A token that was fine a moment ago and is not now - a rotated secret,
      // or a revoked consent. Dropping it means the next attempt asks for a
      // new one rather than retrying with a token that will never work again.
      tokens.delete(cacheKey(config));
    }
    throw new Error((await readError(response)).message);
  }
}
