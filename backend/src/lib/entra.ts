import { createHash, randomBytes } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { logger } from "./logger";
import { reach } from "./reach";

/**
 * Signing in with a Microsoft work account: the parts that talk to Microsoft.
 *
 * Authorization code with PKCE, against one named tenant. Nothing here reaches
 * Graph and nothing here asks for a Graph permission - the only question being
 * put is "who is this", and the answer is the `id_token`. The session that
 * follows is this application's own; Microsoft's tokens are read once and
 * thrown away.
 *
 * Everything is a pure function of a configuration object so the whole flow can
 * be argued with in a test. The two that cannot be - the discovery document and
 * the signing keys - are the two that go over the network, and both are
 * fetched from the tenant rather than assembled from string constants here.
 */

/** `openid` identifies, `profile` and `email` fill in the name and address. */
const SCOPES = "openid profile email";

/**
 * How long a discovery document is trusted.
 *
 * Microsoft's changes rarely, and re-fetching it on every sign-in would put an
 * outbound request in front of a person waiting at a login screen. An hour is
 * short enough that a tenant that moves something is picked up the same
 * morning.
 */
const DISCOVERY_TTL_MS = 60 * 60 * 1000;

export type EntraConfig = {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
};

type Discovery = {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
};

type CachedDiscovery = { value: Discovery; fetchedAt: number };

const discoveryCache = new Map<string, CachedDiscovery>();
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

/** For tests, and for the settings screen after a tenant is changed. */
export function forgetEntraDiscovery(): void {
  discoveryCache.clear();
  jwksCache.clear();
}

function base64url(input: Buffer): string {
  return input.toString("base64url");
}

/** A PKCE verifier: 43-128 characters of unreserved alphabet. */
export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(48));
  const challenge = base64url(createHash("sha256").update(verifier).digest());

  return { verifier, challenge };
}

export function createNonce(): string {
  return base64url(randomBytes(24));
}

/**
 * Where this tenant keeps its endpoints and its signing keys.
 *
 * Asked for rather than assembled, because the answer is what pins the issuer
 * this deployment will accept. A multi-tenant endpoint - `common`,
 * `organizations`, `consumers` - answers with a literal `{tenantid}` inside
 * its issuer, meaning "any tenant", and it is refused here: an HR system that
 * accepts an assertion from any directory in the world accepts one from a
 * directory the attacker owns.
 */
export async function discover(tenantId: string): Promise<Discovery> {
  const cached = discoveryCache.get(tenantId);

  if (cached && Date.now() - cached.fetchedAt < DISCOVERY_TTL_MS) {
    return cached.value;
  }

  const url = `https://login.microsoftonline.com/${encodeURIComponent(
    tenantId
  )}/v2.0/.well-known/openid-configuration`;

  const response = await reach(url, undefined, "sso.entra.unreachable");

  if (!response.ok) {
    throw new Error(
      `Microsoft does not recognise the directory "${tenantId}". Check the Directory (tenant) ID on the app registration's Overview page. (HTTP ${response.status})`
    );
  }

  const body = (await response.json()) as {
    issuer?: string;
    authorization_endpoint?: string;
    token_endpoint?: string;
    jwks_uri?: string;
  };

  if (
    !body.issuer ||
    !body.authorization_endpoint ||
    !body.token_endpoint ||
    !body.jwks_uri
  ) {
    throw new Error(
      "Microsoft's reply did not describe this directory's sign-in endpoints. Nothing has been changed."
    );
  }

  if (body.issuer.includes("{tenantid}")) {
    throw new Error(
      'That is a multi-tenant sign-in endpoint, which would accept an account from any Microsoft directory in the world. Name your own directory instead: use the Directory (tenant) ID, not "common" or "organizations".'
    );
  }

  const value: Discovery = {
    issuer: body.issuer,
    authorizationEndpoint: body.authorization_endpoint,
    tokenEndpoint: body.token_endpoint,
    jwksUri: body.jwks_uri,
  };

  discoveryCache.set(tenantId, { value, fetchedAt: Date.now() });

  return value;
}

/** Where to send the browser. */
export async function authorizeUrl(
  config: EntraConfig,
  params: {
    state: string;
    nonce: string;
    codeChallenge: string;
    /**
     * "login" makes Microsoft ask for the credentials again even when the
     * browser is already signed in there - what a confirmation needs, since
     * a remembered Microsoft session proves no more than an open tab here.
     */
    prompt?: "login";
  }
): Promise<string> {
  const { authorizationEndpoint } = await discover(config.tenantId);
  const url = new URL(authorizationEndpoint);

  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("response_mode", "query");
  url.searchParams.set("scope", SCOPES);
  url.searchParams.set("state", params.state);
  url.searchParams.set("nonce", params.nonce);
  url.searchParams.set("code_challenge", params.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (params.prompt) {
    url.searchParams.set("prompt", params.prompt);
    /*
     * And say when the password was entered. Microsoft leaves `auth_time`
     * out of ID tokens unless it is asked for, and without it nothing here
     * can tell a fresh sign-in from a remembered one - so a confirmation asks
     * for it, as an essential claim, every time.
     */
    url.searchParams.set("claims", JSON.stringify({ id_token: { auth_time: { essential: true } } }));
  }

  return url.toString();
}

/**
 * Trade the code for an identity.
 *
 * The client secret goes in the body because this is a confidential client:
 * PKCE proves the request comes from whoever started the flow, the secret
 * proves it comes from this application, and neither substitutes for the
 * other.
 */
export async function exchangeCode(
  config: EntraConfig,
  params: { code: string; codeVerifier: string }
): Promise<string> {
  const { tokenEndpoint } = await discover(config.tenantId);

  const response = await reach(
    tokenEndpoint,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        grant_type: "authorization_code",
        code: params.code,
        redirect_uri: config.redirectUri,
        code_verifier: params.codeVerifier,
        scope: SCOPES,
      }),
    },
    "sso.entra.unreachable"
  );

  const body = (await response.json()) as {
    id_token?: string;
    error?: string;
    error_description?: string;
  };

  if (!response.ok || !body.id_token) {
    /*
     * Microsoft's `error_description` carries an AADSTS number and a
     * paragraph, and the number is the part worth keeping: AADSTS50011 is a
     * redirect URI that does not match the registration, AADSTS7000215 a wrong
     * secret, AADSTS650057 a missing permission. Carried through so an
     * administrator can search it, trimmed because the paragraph after it
     * repeats itself and sometimes names a correlation id.
     */
    const detail = (body.error_description ?? body.error ?? "")
      .split("\r\n")[0]
      .slice(0, 300);

    logger.error("sso.entra.token_refused", { status: response.status });

    throw new Error(
      detail
        ? `Microsoft refused the sign-in: ${detail}`
        : `Microsoft refused the sign-in. (HTTP ${response.status})`
    );
  }

  return body.id_token;
}

export type EntraIdentity = {
  /** Lower-cased. The only thing an account is matched on. */
  email: string;
  name: string | null;
  /** The directory's own immutable id for the person, for the log. */
  objectId: string | null;
  /** When Microsoft last had the person enter their credentials, if it says. */
  authenticatedAt: Date | null;
};

/**
 * Check the assertion, then read it. Never the other way round.
 *
 * `jose` does signature, issuer, audience and expiry; the nonce is checked
 * here because only the caller knows which sign-in it started. Without that
 * check a valid token for this application, captured from another sign-in,
 * would be replayable into somebody else's browser.
 */
export async function verifyIdToken(
  config: EntraConfig,
  idToken: string,
  expectedNonce: string
): Promise<EntraIdentity> {
  const { issuer, jwksUri } = await discover(config.tenantId);

  let jwks = jwksCache.get(jwksUri);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(jwksUri));
    jwksCache.set(jwksUri, jwks);
  }

  const { payload } = await jwtVerify(idToken, jwks, {
    issuer,
    audience: config.clientId,
  });

  if (payload.nonce !== expectedNonce) {
    throw new Error(
      "That sign-in did not match the one this browser started. Try signing in again."
    );
  }

  const claims = payload as {
    email?: unknown;
    preferred_username?: unknown;
    name?: unknown;
    oid?: unknown;
    auth_time?: unknown;
  };

  /*
   * `email` where the directory publishes one, `preferred_username` otherwise
   * - which is what a work account normally carries, and is the address people
   * recognise as theirs. Neither is guaranteed to exist, and an account with
   * no address cannot be matched to anybody here, so that is a refusal rather
   * than a guess.
   */
  const raw =
    typeof claims.email === "string"
      ? claims.email
      : typeof claims.preferred_username === "string"
        ? claims.preferred_username
        : "";

  if (!raw.includes("@")) {
    throw new Error(
      "That Microsoft account did not come with an email address, so it cannot be matched to a person here."
    );
  }

  return {
    email: raw.trim().toLowerCase(),
    name: typeof claims.name === "string" ? claims.name : null,
    objectId: typeof claims.oid === "string" ? claims.oid : null,
    authenticatedAt:
      typeof claims.auth_time === "number" ? new Date(claims.auth_time * 1000) : null,
  };
}
