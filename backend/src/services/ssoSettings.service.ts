import { auditService } from "./audit.service";
import { decryptSecret, encryptSecret } from "../lib/secretBox";
import { errors } from "../lib/errors";
import { forgetEntraDiscovery, type EntraConfig } from "../lib/entra";
import { appUrl } from "../lib/mailer";
import { logger } from "../lib/logger";
import { prisma } from "../prisma";
import type { UpdateSsoSettingsInput } from "../schemas/admin.schema";

/**
 * The Microsoft app registration people sign in through.
 *
 * Emphatically NOT the one that sends mail. That registration is app-only: it
 * holds `Mail.Send`, never sees a browser and has no redirect URI. This one is
 * a delegated sign-in that redirects back here and asks for nothing but
 * `openid profile email`. Pasting one into the other is the obvious mistake,
 * so they are separate rows and the screen says why.
 *
 * Off until it is configured and switched on, and the sign-in button is drawn
 * from that: a button that cannot work would sit on the one screen nobody can
 * get past, which reads as the product being broken rather than the feature
 * being unconfigured.
 */

const SINGLETON = "singleton";

/** The fixed entity id for the trail. Mail took `...0001`, workflow `...0002`. */
const SSO_SETTINGS_AUDIT_ID = "00000000-0000-4000-8000-000000000003";

function maskTail(value: string | null): string | null {
  if (!value) return null;
  // Not a secret, but a tenant and a client id together name a target, and
  // this screen ends up in screenshots.
  return value.length <= 6 ? "…" : `…${value.slice(-6)}`;
}

export type SsoSettingsView = {
  /** Whether the button should be drawn at all. */
  enabled: boolean;
  /** Whether everything it needs is actually present. */
  configured: boolean;
  tenantIdTail: string | null;
  clientIdTail: string | null;
  hasClientSecret: boolean;
  redirectUri: string | null;
  /**
   * True when a secret is stored but cannot be read back - almost always a
   * rotated `JWT_SECRET`. Its own state because otherwise it looks exactly
   * like "no secret", and the fix is different: re-enter it.
   */
  secretUnreadable: boolean;
};

/**
 * The live configuration, or null when sign-in is not available.
 *
 * Returns null rather than a half-filled object: every caller is about to send
 * somebody to Microsoft, and there is no useful partial answer to that.
 */
export async function entraConfig(): Promise<EntraConfig | null> {
  const row = await prisma.ssoSetting.findUnique({ where: { id: SINGLETON } });

  if (!row?.enabled) return null;
  if (!row.tenantId || !row.clientId || !row.clientSecretCipher) return null;
  if (!row.redirectUri) return null;

  const clientSecret = decryptSecret(row.clientSecretCipher);

  if (clientSecret === null) {
    logger.error("sso.settings.secret_unreadable", {
      note: "Could not be decrypted. Re-enter it in Administration -> Single sign-on.",
    });
    return null;
  }

  return {
    tenantId: row.tenantId,
    clientId: row.clientId,
    clientSecret,
    redirectUri: row.redirectUri,
  };
}

/**
 * Where to send the browser once the round trip is over.
 *
 * The origin of the REGISTERED REDIRECT URI, and deliberately not the mail
 * app URL. Those are two settings answering two different questions, and it
 * cost a broken sign-in to notice:
 *
 *   - `appUrl` is where a link inside an email should point. It has to be the
 *     public address, because the person opening it is on their phone, on a
 *     different network, a week later.
 *   - This is where the browser that just came back from Microsoft already
 *     lives. By definition it is the origin Entra was told to redirect to,
 *     because that is the request being answered.
 *
 * They are equal in production and differ on every developer machine. Here
 * the mail setting says `https://flow.ideas.com.pk` while the redirect URI
 * says `http://localhost:5173`, so a local sign-in ended on the production
 * host - carrying the handover code, which is exchangeable for a session, in
 * the query string of an origin that had not started the sign-in.
 *
 * Falls back to `appUrl()` only when no redirect URI is stored, which is the
 * one case where there is nothing better to say.
 */
export async function returnOrigin(): Promise<string> {
  const row = await prisma.ssoSetting.findUnique({
    where: { id: SINGLETON },
    select: { redirectUri: true },
  });

  if (!row?.redirectUri) return appUrl();

  try {
    return new URL(row.redirectUri).origin;
  } catch {
    // Saving validates the shape, so this is a row that predates the rule or
    // was edited underneath the application. Log it and fall back rather than
    // throw: this runs while answering Microsoft, and a 500 here would strand
    // somebody mid-sign-in with nothing to read.
    logger.error("sso.settings.redirect_uri_unparseable", {
      note: "Not a URL. Re-enter it in Administration -> Single sign-on.",
    });

    return appUrl();
  }
}

export const ssoSettingsService = {
  entraConfig,
  returnOrigin,

  async get(): Promise<SsoSettingsView> {
    const row = await prisma.ssoSetting.findUnique({ where: { id: SINGLETON } });

    const secretUnreadable = row?.clientSecretCipher
      ? decryptSecret(row.clientSecretCipher) === null
      : false;

    return {
      enabled: row?.enabled ?? false,
      configured: Boolean(
        row?.tenantId &&
          row.clientId &&
          row.clientSecretCipher &&
          row.redirectUri &&
          !secretUnreadable
      ),
      tenantIdTail: maskTail(row?.tenantId ?? null),
      clientIdTail: maskTail(row?.clientId ?? null),
      hasClientSecret: Boolean(row?.clientSecretCipher),
      redirectUri: row?.redirectUri ?? null,
      secretUnreadable,
    };
  },

  /**
   * Write the registration, then make it live.
   *
   * A blank secret means "leave the stored one alone", the rule the screen
   * states and the only one that lets somebody correct a redirect URI without
   * knowing the secret. The same rule holds for the tenant and client ids,
   * which are never sent back in full and so always arrive blank unless
   * deliberately retyped - an earlier version of the mail screen applied it to
   * the password alone and deleted the account on the way past.
   */
  async save(
    input: UpdateSsoSettingsInput,
    actorId: string,
    ipAddress?: string
  ) {
    const existing = await prisma.ssoSetting.findUnique({
      where: { id: SINGLETON },
    });

    const keep = (typed: string | undefined, stored: string | null) =>
      typed?.trim() ? typed.trim() : stored;

    const tenantId = keep(input.tenantId, existing?.tenantId ?? null);
    const clientId = keep(input.clientId, existing?.clientId ?? null);
    const redirectUri = keep(input.redirectUri, existing?.redirectUri ?? null);

    const clientSecretCipher = input.clientSecret?.trim()
      ? encryptSecret(input.clientSecret.trim())
      : (existing?.clientSecretCipher ?? null);

    /*
     * Refusing to switch on something that cannot work, rather than storing it
     * and drawing a button that fails. The one screen nobody can get past is
     * the worst place to find out.
     */
    if (input.enabled && !(tenantId && clientId && clientSecretCipher && redirectUri)) {
      throw errors.badRequest(
        "Sign-in with Microsoft needs the directory ID, the application ID, a client secret and the redirect URI before it can be switched on.",
        "SSO_INCOMPLETE"
      );
    }

    const data = {
      enabled: input.enabled,
      tenantId,
      clientId,
      clientSecretCipher,
      redirectUri,
      updatedById: actorId,
    };

    const row = await prisma.ssoSetting.upsert({
      where: { id: SINGLETON },
      create: { id: SINGLETON, ...data },
      update: data,
    });

    const shape = (value: {
      enabled: boolean;
      tenantId: string | null;
      clientId: string | null;
      clientSecretCipher: string | null;
      redirectUri: string | null;
    }) => ({
      enabled: value.enabled,
      tenantId: maskTail(value.tenantId),
      clientId: maskTail(value.clientId),
      // Whether, never what. The trail is exported.
      hasClientSecret: Boolean(value.clientSecretCipher),
      redirectUri: value.redirectUri,
    });

    await auditService.createAuditLog({
      actorId,
      action: "SSO_SETTINGS_UPDATED",
      entityType: "SsoSetting",
      entityId: SSO_SETTINGS_AUDIT_ID,
      oldValue: existing ? shape(existing) : { configured: false },
      newValue: shape(row),
      ipAddress,
    });

    // The endpoints and signing keys were cached against the old directory.
    forgetEntraDiscovery();

    return row;
  },

  /** Turn it off and forget the registration entirely. */
  async clear(actorId: string, ipAddress?: string) {
    const existing = await prisma.ssoSetting.findUnique({
      where: { id: SINGLETON },
    });

    if (!existing) return;

    await prisma.ssoSetting.delete({ where: { id: SINGLETON } });

    await auditService.createAuditLog({
      actorId,
      action: "SSO_SETTINGS_CLEARED",
      entityType: "SsoSetting",
      entityId: SSO_SETTINGS_AUDIT_ID,
      oldValue: {
        enabled: existing.enabled,
        tenantId: maskTail(existing.tenantId),
        clientId: maskTail(existing.clientId),
      },
      newValue: { cleared: true },
      ipAddress,
    });

    forgetEntraDiscovery();
  },
};
