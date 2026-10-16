import { auditService } from "./audit.service";
import { closeMailTransport, useStoredMailConfig } from "../lib/mailer";
import { decryptSecret, encryptSecret } from "../lib/secretBox";
import { errors } from "../lib/errors";
import { logger } from "../lib/logger";
import { prisma } from "../prisma";
import type { UpdateMailSettingsInput } from "../schemas/admin.schema";

/**
 * Mail configuration an administrator can change without a shell.
 *
 * It used to be environment variables only, which is the safer place for a
 * credential and the wrong place for everything else about it: the host, the
 * port and above all `APP_URL` are things an administrator discovers is wrong
 * at four o'clock on the day of go-live, and "edit a file on the server and
 * restart the API" is not an answer they have. So the row wins over the
 * environment, and the environment stays supported for deployments that
 * already manage it that way.
 *
 * The password is the part that got worse by moving, and `lib/secretBox` is
 * the answer to that: encrypted with a key derived from `JWT_SECRET`, so the
 * table alone does not give it up.
 */

const SINGLETON = "singleton";

/*
 * The same row, named again for the audit trail.
 *
 * `audit_logs.entity_id` is a UUID column - every other entity it records has
 * one - and this row's key is a word, because one row does not need a
 * generated id and "singleton" is what makes the table readable. So the trail
 * gets a fixed id of the right shape. It is a constant, never generated, so
 * every mail change in the history groups under one entity.
 */
const MAIL_SETTINGS_AUDIT_ID = "00000000-0000-4000-8000-000000000001";

/**
 * Push whatever is stored into the mailer.
 *
 * Called at boot and after every save. Everything downstream - the queue, the
 * test message, the settings screen - reads the mailer, so this is the only
 * place the two can get out of step.
 */
export async function applyStoredMailSettings(): Promise<void> {
  const row = await prisma.mailSetting.findUnique({ where: { id: SINGLETON } });

  if (!row) {
    useStoredMailConfig(null);
    return;
  }

  let unreadable = false;

  /*
   * Almost always a rotated JWT_SECRET. Whichever secret it is, sending
   * without it fails in a way that reads like a network problem - a relay
   * refusing an unauthenticated connection, or Microsoft refusing a token -
   * so this is carried to the screen as its own state rather than quietly
   * becoming "no credentials".
   */
  const read = (cipher: string | null, what: string): string | undefined => {
    if (!cipher) return undefined;

    const plain = decryptSecret(cipher);

    if (plain === null) {
      unreadable = true;
      logger.error("mail.settings.secret_unreadable", {
        secret: what,
        note: "Could not be decrypted. Re-enter it in Administration -> Mail.",
      });
      return undefined;
    }

    return plain;
  };

  const password = read(row.passwordCipher, "smtp_password");
  const clientSecret = read(row.clientSecretCipher, "graph_client_secret");

  useStoredMailConfig({
    provider: row.provider,
    host: row.host,
    port: row.port,
    secure: row.secure,
    user: row.username ?? undefined,
    pass: password,
    tenantId: row.tenantId,
    clientId: row.clientId,
    clientSecret,
    mailbox: row.graphMailbox,
    saveToSentItems: row.saveToSentItems,
    fromName: row.fromName,
    fromAddress: row.fromAddress,
    appUrl: row.appUrl,
    secretUnreadable: unreadable,
  });
}

/**
 * What an administrator changed, in a form that can be exported.
 *
 * Booleans where the secrets are. The audit trail leaves this building, and
 * "there is a client secret" is the whole of what is safe to write down about
 * one - the identifiers are already masked everywhere else and there is no
 * reason for them to be readable here either.
 */
function auditShape(row: {
  provider: string;
  host: string | null;
  port: number | null;
  secure: boolean;
  fromName: string | null;
  fromAddress: string;
  username: string | null;
  passwordCipher: string | null;
  tenantId: string | null;
  clientId: string | null;
  clientSecretCipher: string | null;
  graphMailbox: string | null;
  saveToSentItems: boolean;
  appUrl: string | null;
}) {
  return {
    provider: row.provider,
    host: row.host,
    port: row.port,
    secure: row.secure,
    fromName: row.fromName,
    fromAddress: row.fromAddress,
    hasUsername: Boolean(row.username),
    hasPassword: Boolean(row.passwordCipher),
    hasTenantId: Boolean(row.tenantId),
    hasClientId: Boolean(row.clientId),
    hasClientSecret: Boolean(row.clientSecretCipher),
    mailbox: row.graphMailbox,
    saveToSentItems: row.saveToSentItems,
    appUrl: row.appUrl,
  };
}

export const mailSettingsService = {
  applyStoredMailSettings,

  /** Whether anything is stored at all - the screen says where config came from. */
  async isStored(): Promise<boolean> {
    return (
      (await prisma.mailSetting.count({ where: { id: SINGLETON } })) > 0
    );
  },

  /**
   * Write the form, then make it live.
   *
   * A blank password means "leave whatever is there", which is the only
   * behaviour that lets somebody change a port without knowing the relay
   * password. Clearing it is therefore explicit - `clearPassword` - rather
   * than something an empty field does by accident.
   */
  async save(
    input: UpdateMailSettingsInput,
    actorId: string,
    ipAddress?: string
  ) {
    const existing = await prisma.mailSetting.findUnique({
      where: { id: SINGLETON },
    });

    const graph = input.provider === "MICROSOFT_GRAPH";
    /*
     * Anything already stored survives a blank field.
     *
     * This is the rule the screen states - "it is not shown here, leave it
     * blank to keep it" - and it has to hold for every value the screen
     * refuses to show, not only the two passwords. An earlier version applied
     * it to the passwords alone, so changing the sender address with the
     * account field blank (which is how that field always looks, because it is
     * never sent back) deleted the relay account and its password on the way
     * past. The next notice then failed to authenticate, which a relay reports
     * in a way that reads like a network problem.
     */
    const keep = <T>(typed: T | null | undefined, stored: T | null): T | null =>
      typed ? typed : stored;

    let passwordCipher = existing?.passwordCipher ?? null;
    let username = existing?.username ?? null;

    if (input.clearPassword) {
      // The account and its password are a pair - a username with no password
      // is refused below - so one switch removes both. Anything else leaves a
      // state this service would not accept if it were typed in.
      username = null;
      passwordCipher = null;
    } else {
      username = keep(input.username, username);
      if (input.password) {
        passwordCipher = encryptSecret(input.password);
      }
    }

    let clientSecretCipher = existing?.clientSecretCipher ?? null;
    let tenantId = existing?.tenantId ?? null;
    let clientId = existing?.clientId ?? null;

    if (input.clearClientSecret) {
      clientSecretCipher = null;
    } else if (input.clientSecret) {
      clientSecretCipher = encryptSecret(input.clientSecret);
    }
    tenantId = keep(input.tenantId, tenantId);
    clientId = keep(input.clientId, clientId);

    const mailbox = keep(input.mailbox, existing?.graphMailbox ?? null);

    if (graph) {
      /*
       * Refused here rather than at Microsoft. A missing secret comes back
       * from Entra as `invalid_client`, which reads like the secret being
       * wrong rather than absent, and sends somebody to regenerate a
       * perfectly good one.
       */
      if (!tenantId || !clientId) {
        throw errors.badRequest(
          "Microsoft Graph needs a tenant ID and a client ID."
        );
      }
      if (!clientSecretCipher) {
        throw errors.badRequest(
          "Microsoft Graph needs a client secret. Enter the value from the app registration."
        );
      }
    } else {
      if (!input.host || !input.port) {
        throw errors.badRequest("SMTP needs a hostname and a port.");
      }

      // A username with no password is a misconfiguration that fails at the
      // relay rather than here, so it is worth refusing while somebody is
      // looking at the form.
      if (username && !passwordCipher) {
        throw errors.badRequest(
          "That account needs a password. Enter one, or remove the stored account to send without authentication."
        );
      }

      if (!username) {
        passwordCipher = null;
      }
    }

    const data = {
      provider: input.provider,
      host: graph ? null : input.host,
      port: graph ? null : input.port,
      secure: graph ? false : input.secure,
      fromName: input.fromName || null,
      fromAddress: input.fromAddress,
      username: graph ? null : username,
      passwordCipher: graph ? null : passwordCipher,
      tenantId: graph ? tenantId : null,
      clientId: graph ? clientId : null,
      clientSecretCipher: graph ? clientSecretCipher : null,
      // Defaults to the address it sends from, which is what it is in every
      // deployment that has not deliberately made them differ.
      graphMailbox: graph ? mailbox || input.fromAddress : null,
      saveToSentItems: input.saveToSentItems ?? true,
      appUrl: input.appUrl || null,
      updatedById: actorId,
    };

    const row = await prisma.mailSetting.upsert({
      where: { id: SINGLETON },
      create: { id: SINGLETON, ...data },
      update: data,
    });

    /*
     * The audit row names what changed and never what it changed to for the
     * password - `true`/`false` is the whole of what is safe to write down,
     * and the audit trail is exported.
     */
    await auditService.createAuditLog({
      actorId,
      action: "MAIL_SETTINGS_UPDATED",
      entityType: "MailSetting",
      entityId: MAIL_SETTINGS_AUDIT_ID,
      oldValue: existing ? auditShape(existing) : undefined,
      newValue: auditShape(row),
      ipAddress,
    });

    // The pooled transport is built from the old host and would go on using
    // it. Dropping it is what makes "Save" mean the next message goes to the
    // new server rather than the one before it.
    closeMailTransport();
    await applyStoredMailSettings();

    return row;
  },

  /**
   * Hand mail back to the environment.
   *
   * Not a nicety: it is the way out of a configuration that cannot reach a
   * relay, for somebody who cannot get a shell on the server either.
   */
  async clear(actorId: string, ipAddress?: string) {
    const existing = await prisma.mailSetting.findUnique({
      where: { id: SINGLETON },
    });

    if (!existing) {
      return;
    }

    await prisma.mailSetting.delete({ where: { id: SINGLETON } });

    await auditService.createAuditLog({
      actorId,
      action: "MAIL_SETTINGS_CLEARED",
      entityType: "MailSetting",
      entityId: MAIL_SETTINGS_AUDIT_ID,
      oldValue: auditShape(existing),
      newValue: { cleared: true },
      ipAddress,
    });

    closeMailTransport();
    await applyStoredMailSettings();
  },
};
