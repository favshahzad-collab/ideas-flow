import { createHash, randomUUID } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { env } from "./env";

/**
 * Local JWT issuing and verification, replacing Supabase Auth.
 *
 * Two tokens: a short-lived access token the client sends on every request,
 * and a longer-lived refresh token it exchanges for a new pair. Both are
 * signed with the same secret but carry a `typ` claim, so a refresh token
 * cannot be replayed as an access token.
 *
 * Both also carry the moment they were issued, and every one of them is
 * checked against a cutoff on the account. That is what makes a signed token
 * revocable at all: nothing else here can reach a token the client is holding
 * and has not presented yet, so "sign out everywhere" has to be a fact the
 * account carries rather than a message sent to the token.
 */

const ISSUER = "daws";
const AUDIENCE = "daws-api";

const ACCESS_TTL = "2h";
const REFRESH_TTL = "30d";
/**
 * A step-up: proof that the person at the keyboard typed their password or a
 * code just now, not two hours ago when the session began. Short, because it
 * stands in for that typing.
 */
const STEP_UP_TTL = "5m";
export const STEP_UP_TTL_MS = 5 * 60 * 1000;

const secret = new TextEncoder().encode(env.JWT_SECRET);

type TokenType = "access" | "refresh" | "step-up";

/*
 * Two claims of our own, and both are load-bearing.
 *
 * `jti` makes every token unique. Without it a JWT is a pure function of its
 * payload, and the standard `iat` counts whole seconds - so two sign-ins by
 * the same person in the same second produced byte-identical tokens. That is
 * not merely untidy: the session table keys on the token's digest, so the
 * second sign-in collided with the first and failed outright.
 *
 * `ms` is the issuing moment in milliseconds. Revocation compares a token's
 * age against a cutoff on the account, and at one-second resolution a token
 * issued in the same second as the cutoff cannot be told from one issued
 * just after it - which means either signing somebody out of the session they
 * are creating, or letting a revoked token through for up to a second. With
 * a millisecond claim there is nothing to guess.
 */
async function sign(
  userId: string,
  typ: TokenType,
  ttl: string,
  extra: Record<string, string> = {}
): Promise<string> {
  return new SignJWT({ ...extra, typ, jti: randomUUID(), ms: Date.now() })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(ttl)
    .sign(secret);
}

export async function issueTokens(userId: string) {
  const [accessToken, refreshToken] = await Promise.all([
    sign(userId, "access", ACCESS_TTL),
    sign(userId, "refresh", REFRESH_TTL),
  ]);
  return { accessToken, refreshToken };
}

/**
 * How somebody proved it was them for a step-up. Carried in the confirmation
 * so a signature certificate can say which - it used to print "Password or
 * authenticator code" for everybody, including people who confirmed with a
 * fresh Microsoft sign-in, which is a false statement on a sealed page.
 */
export type IdentityMethod = "PASSWORD" | "AUTHENTICATOR" | "MICROSOFT";

const IDENTITY_METHODS: readonly string[] = ["PASSWORD", "AUTHENTICATOR", "MICROSOFT"];

/** A step-up confirmation for this person, good for five minutes. */
export async function issueStepUpToken(userId: string, how?: IdentityMethod): Promise<string> {
  return sign(userId, "step-up", STEP_UP_TTL, how ? { how } : {});
}

/** How long a refresh token lives, so a session row can record its expiry. */
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export async function verifyToken(
  token: string,
  expected: TokenType
): Promise<{ id: string; issuedAt: Date; how: IdentityMethod | null } | null> {
  try {
    const { payload } = await jwtVerify(token, secret, {
      issuer: ISSUER,
      audience: AUDIENCE,
    });

    if (payload.typ !== expected || !payload.sub || typeof payload.ms !== "number") {
      return null;
    }

    // Refused outright when the millisecond claim is missing rather than
    // falling back to `iat`: a token that cannot be placed precisely against
    // a revocation is a token that might predate one, and guessing in that
    // direction is how a revoked session keeps working.
    const how =
      typeof payload.how === "string" && IDENTITY_METHODS.includes(payload.how)
        ? (payload.how as IdentityMethod)
        : null;
    return { id: payload.sub, issuedAt: new Date(payload.ms), how };
  } catch {
    return null;
  }
}

/**
 * What is stored for a refresh token, which is never the token.
 *
 * A database dump must not be a drawer full of live sessions. The hash is
 * enough to recognise the token somebody presents and useless to anybody
 * reading the table - and it is not a password, so nothing here is slow on
 * purpose: the token is 200-odd bits of signed randomness, not a guess
 * anybody is going to make.
 */
export function refreshTokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
