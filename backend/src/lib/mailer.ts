import nodemailer, { type Transporter } from "nodemailer";
import {
  clearGraphTokenCache,
  sendGraphMail,
  testGraphConnection,
  type GraphMailConfig,
} from "./graphMailer";

/**
 * The one place that talks to a mail server.
 *
 * Everything above this deals in queued rows: the outbox is written in the
 * same transaction as the notification it carries, and delivery is a separate
 * act afterwards. That split is what makes an unreachable mail server a
 * delayed notice rather than a failed approval.
 *
 * Configuration is optional on purpose. A developer, the test suite and CI all
 * run with none, and must: a system that cannot start without an SMTP host is
 * a system nobody can run locally. With none configured nothing is sent, the
 * queue still records what would have gone, and the API says so once at
 * startup rather than failing silently.
 */

export type MailMessage = {
  to: string;
  subject: string;
  text: string;
};

type MailConfig = {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
  from: string;
};

/**
 * Mail configuration held in the database, when an administrator has set it.
 *
 * Kept in a module variable rather than read per send, because everything that
 * reaches this file - `sendMail`, `isMailConfigured`, `appUrl` - is called from
 * places that are not async and should not become async to ask a question whose
 * answer changes about once a year. `mailSettingsService` pushes it in at boot
 * and again whenever the form is saved, which are the only two moments it can
 * change.
 */
export type MailProviderName = "SMTP" | "MICROSOFT_GRAPH";

export type StoredMailConfig = {
  provider: MailProviderName;
  /** SMTP only. */
  host?: string | null;
  port?: number | null;
  secure: boolean;
  user?: string;
  pass?: string;
  /** Graph only. */
  tenantId?: string | null;
  clientId?: string | null;
  clientSecret?: string;
  mailbox?: string | null;
  saveToSentItems?: boolean;
  /**
   * A secret is stored but could not be decrypted - the SMTP password, the
   * Graph client secret, or both. Almost always a rotated `JWT_SECRET`.
   */
  secretUnreadable?: boolean;
  fromName?: string | null;
  fromAddress: string;
  appUrl?: string | null;
};

let stored: StoredMailConfig | null = null;

/** Called at boot and after a save. Null puts the environment back in charge. */
export function useStoredMailConfig(config: StoredMailConfig | null): void {
  stored = config;
}

/**
 * The address a notice comes from, as a mail header.
 *
 * Held as a name and an address because Graph wants them apart, and glued
 * back together here because SMTP wants them together.
 */
function formatFrom(name: string | null | undefined, address: string): string {
  const trimmed = name?.trim();
  return trimmed ? `${trimmed} <${address}>` : address;
}

/** Graph, if that is what this deployment is configured for. */
function readGraphConfig(): GraphMailConfig | null {
  if (stored) {
    if (stored.provider !== "MICROSOFT_GRAPH") return null;
    if (!stored.tenantId || !stored.clientId || !stored.clientSecret) return null;

    return {
      tenantId: stored.tenantId,
      clientId: stored.clientId,
      clientSecret: stored.clientSecret,
      mailbox: stored.mailbox || stored.fromAddress,
      fromName: stored.fromName,
      fromAddress: stored.fromAddress,
      saveToSentItems: stored.saveToSentItems ?? true,
    };
  }

  if (process.env.MAIL_PROVIDER?.trim().toLowerCase() !== "microsoft-graph") {
    return null;
  }

  const tenantId = process.env.MICROSOFT_TENANT_ID?.trim();
  const clientId = process.env.MICROSOFT_CLIENT_ID?.trim();
  const clientSecret = process.env.MICROSOFT_CLIENT_SECRET?.trim();
  const fromAddress = process.env.MAIL_FROM_ADDRESS?.trim();

  if (!tenantId || !clientId || !clientSecret || !fromAddress) return null;

  return {
    tenantId,
    clientId,
    clientSecret,
    mailbox: process.env.GRAPH_MAILBOX?.trim() || fromAddress,
    fromName: process.env.MAIL_FROM_NAME?.trim() || null,
    fromAddress,
    saveToSentItems:
      (process.env.GRAPH_SAVE_TO_SENT_ITEMS?.trim() || "true").toLowerCase() !==
      "false",
  };
}

function readConfig(): MailConfig | null {
  /*
   * The database wins where it has an answer. An administrator who fills in
   * the form expects the form to be what happens, and a server variable
   * quietly overriding it would be undebuggable from inside the application -
   * the screen would show one thing and the queue would do another.
   */
  if (stored) {
    if (stored.provider !== "SMTP" || !stored.host || !stored.port) return null;

    return {
      host: stored.host,
      port: stored.port,
      secure: stored.secure,
      user: stored.user,
      pass: stored.pass,
      from: formatFrom(stored.fromName, stored.fromAddress),
    };
  }

  if (process.env.MAIL_PROVIDER?.trim().toLowerCase() === "microsoft-graph") {
    // Graph is configured from the environment; SMTP is not what this
    // deployment uses.
    return null;
  }

  const host = process.env.SMTP_HOST?.trim();
  const from = process.env.MAIL_FROM?.trim();

  if (!host || !from) {
    return null;
  }

  const port = Number(process.env.SMTP_PORT?.trim() || 587);

  return {
    host,
    port: Number.isFinite(port) ? port : 587,
    // 465 is the implicit-TLS port; everything else starts in the clear and
    // upgrades. Overridable, because plenty of internal relays disagree.
    secure: (process.env.SMTP_SECURE?.trim() || "").toLowerCase() === "true" || port === 465,
    user: process.env.SMTP_USER?.trim() || undefined,
    pass: process.env.SMTP_PASSWORD?.trim() || undefined,
    from,
  };
}

/**
 * Is there anything to send through at all? Read at call time, like the flags.
 *
 * Either provider counts. The queue asks this before it bothers sweeping, and
 * it does not care which one answers.
 */
export function isMailConfigured(): boolean {
  return readConfig() !== null || readGraphConfig() !== null;
}

/**
 * Enough of an identifier to recognise, and not enough to use.
 *
 * A tenant or client id is not a secret, but the two together name a target,
 * and this screen ends up in screenshots. Showing the tail is what lets an
 * administrator confirm they pasted the right one without publishing it.
 */
function mask(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.length <= 8
    ? "\u2022".repeat(trimmed.length)
    : `${"\u2022".repeat(8)}${trimmed.slice(-4)}`;
}

/**
 * What this deployment will actually do with a notice, in a form an
 * administrator can read.
 *
 * `configured` on its own was not enough to act on: it says two environment
 * variables are set, not that the host answers, that the credentials are
 * accepted, or that the links point anywhere useful. An operator who sets
 * SMTP_HOST and forgets APP_URL gets a green light and sends every approver a
 * link to localhost.
 *
 * The password is deliberately not here, and never should be. Whether there is
 * one is worth knowing - a relay that expects authentication and is being
 * given none fails in a way that reads like a network problem - so that is
 * reported as a boolean and nothing more.
 */
export type MailSettings = {
  configured: boolean;
  host: string | null;
  port: number | null;
  secure: boolean;
  from: string | null;
  authenticated: boolean;
  appUrl: string;
  /** True when links would point at the development UI on a real deployment. */
  appUrlIsDefault: boolean;
  /**
   * Which of the two the running configuration came from.
   *
   * Worth reporting because both are legitimate and they look identical from
   * the outside. An administrator staring at a host they did not type needs to
   * be told it is coming from the server, or they will edit the form and
   * wonder why nothing changed.
   */
  source: "database" | "environment" | "none";
  /** A stored secret that cannot be decrypted. See `StoredMailConfig`. */
  passwordUnreadable: boolean;
  /** Which way notices leave: through a relay, or through Graph. */
  provider: MailProviderName;
  /** The two halves of the sender, apart, because Graph needs them apart. */
  fromName: string | null;
  fromAddress: string | null;
  /** Graph, reported so an administrator can check what they pasted. */
  tenantIdMasked: string | null;
  clientIdMasked: string | null;
  /** Whether a client secret is stored. Never the secret. */
  hasClientSecret: boolean;
  /** The mailbox Graph sends as. Not a secret and the whole point of the screen. */
  mailbox: string | null;
  saveToSentItems: boolean;
};

export function mailSettings(): MailSettings {
  const config = readConfig();
  const graph = readGraphConfig();
  const provider: MailProviderName = graph ? "MICROSOFT_GRAPH" : "SMTP";

  const fromName = graph ? graph.fromName ?? null : stored?.fromName ?? null;
  const fromAddress = graph
    ? graph.fromAddress
    : stored?.fromAddress ?? config?.from ?? null;

  return {
    configured: config !== null || graph !== null,
    host: config?.host ?? null,
    port: config?.port ?? null,
    secure: config?.secure ?? false,
    from: graph
      ? formatFrom(graph.fromName, graph.fromAddress)
      : config?.from ?? null,
    authenticated: Boolean(config?.user && config.pass),
    appUrl: appUrl(),
    appUrlIsDefault: !storedAppUrl() && !process.env.APP_URL?.trim(),
    source:
      stored !== null
        ? "database"
        : config !== null || graph !== null
          ? "environment"
          : "none",
    provider,
    fromName,
    fromAddress,
    tenantIdMasked: mask(graph?.tenantId ?? stored?.tenantId),
    clientIdMasked: mask(graph?.clientId ?? stored?.clientId),
    hasClientSecret: Boolean(graph?.clientSecret ?? stored?.clientSecret),
    mailbox: graph?.mailbox ?? stored?.mailbox ?? null,
    saveToSentItems: graph?.saveToSentItems ?? stored?.saveToSentItems ?? true,
    /*
     * No username here, deliberately, even though the settings form would find
     * one convenient. A username is half a credential and names a real
     * mailbox, and this object goes to a browser and from there into
     * screenshots. `authenticated` is the part worth reporting; the form
     * treats the account and its password as write-only, the way a password
     * field is everywhere else.
     */
    passwordUnreadable: Boolean(stored?.secretUnreadable),
  };
}

function storedAppUrl(): string | undefined {
  return stored?.appUrl?.trim() || undefined;
}

/** Where the queue's links should point. Falls back to the dev UI. */
export function appUrl(): string {
  return (
    storedAppUrl() ||
    process.env.APP_URL?.trim() ||
    "http://localhost:5173"
  ).replace(/\/+$/, "");
}

let transport: Transporter | null = null;
let transportKey = "";

/**
 * One transport, reused, rebuilt only if the configuration changes.
 *
 * nodemailer pools connections, and building a transport per message is how a
 * queue sweep opens (and leaks) one connection per notice.
 */
function getTransport(config: MailConfig): Transporter {
  const key = JSON.stringify(config);

  if (!transport || key !== transportKey) {
    transport = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      ...(config.user && config.pass
        ? { auth: { user: config.user, pass: config.pass } }
        : {}),
      pool: true,
      maxConnections: 3,
    });
    transportKey = key;
  }

  return transport;
}

/**
 * Send one message.
 *
 * Throws if there is no configuration or the server refuses: the caller is the
 * queue, and a throw is how a row is marked for another attempt. Nothing above
 * the queue calls this.
 */
export async function sendMail(message: MailMessage): Promise<void> {
  // Graph first: when it is configured, it is what this deployment uses, and
  // `readConfig` has already declined to answer for SMTP.
  const graph = readGraphConfig();

  if (graph) {
    await sendGraphMail(graph, message);
    return;
  }

  const config = readConfig();

  if (!config) {
    throw new Error(
      "No mail server is configured. Set one under Administration -> Mail, or with SMTP_HOST and MAIL_FROM."
    );
  }

  await getTransport(config).sendMail({
    from: config.from,
    to: message.to,
    subject: message.subject,
    text: message.text,
  });
}

/**
 * Prove the configuration works, without sending anything.
 *
 * Worth being a separate act from the test message: "can this application
 * reach Microsoft and see the mailbox" and "does a message arrive" fail for
 * different reasons and are fixed in different places. Under SMTP there is no
 * cheap equivalent - a connection that opens proves very little - so this
 * reports honestly that the way to test SMTP is to send something.
 */
export async function testMailConnection(): Promise<{
  provider: MailProviderName;
  detail: string;
}> {
  const graph = readGraphConfig();

  if (graph) {
    const who = await testGraphConnection(graph);

    /*
     * Said plainly, because the difference matters. A confirmed mailbox has
     * been read back out of the directory; an unconfirmed one only means this
     * application holds Mail.Send and not User.Read.All, which is the correct
     * way round. What is proven either way is the tenant, the application and
     * the secret - Entra issues no token otherwise.
     */
    if (!who.mailboxConfirmed) {
      return {
        provider: "MICROSOFT_GRAPH",
        detail: `Connected. The tenant, application and secret are accepted. Whether ${who.mailbox} can actually send is not proven here - reading the directory needs User.Read.All, which sending does not. Send a test email to prove the rest.`,
      };
    }

    return {
      provider: "MICROSOFT_GRAPH",
      detail: who.displayName
        ? `Connected. Sending as ${who.displayName} <${who.mailbox}>.`
        : `Connected. Sending as ${who.mailbox}.`,
    };
  }

  if (!readConfig()) {
    throw new Error("No mail server is configured.");
  }

  return {
    provider: "SMTP",
    detail:
      "SMTP has no connection test that proves anything on its own. Send a test email instead.",
  };
}

/** Drop the pooled transport and any cached token. For tests and shutdown. */
export function closeMailTransport(): void {
  clearGraphTokenCache();
  transport?.close();
  transport = null;
  transportKey = "";
}
