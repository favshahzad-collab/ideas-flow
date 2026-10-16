import { describe, expect, it } from "vitest";
import { SignJWT } from "jose";
import { issueTokens, verifyToken } from "./tokens";
import { env } from "./env";

const secret = new TextEncoder().encode(env.JWT_SECRET);
const USER = "11111111-1111-4111-8111-111111111111";

describe("issueTokens", () => {
  it("returns a pair that both verify as their own type", async () => {
    const { accessToken, refreshToken } = await issueTokens(USER);

    expect(await verifyToken(accessToken, "access")).toMatchObject({ id: USER });
    expect(await verifyToken(refreshToken, "refresh")).toMatchObject({ id: USER });
  });

  it("gives every token a different identity", async () => {
    // Without a jti a JWT is a pure function of its payload, and the standard
    // issued-at counts whole seconds - so two sign-ins by the same person in
    // the same second used to produce byte-identical tokens. The session
    // table keys on the token's digest, so the second sign-in collided with
    // the first and failed outright.
    const [first, second] = await Promise.all([issueTokens(USER), issueTokens(USER)]);

    expect(first.accessToken).not.toBe(second.accessToken);
    expect(first.refreshToken).not.toBe(second.refreshToken);
  });

  it("says when it was issued, to the millisecond", async () => {
    // Revocation compares this against a cutoff on the account. At one-second
    // resolution a token issued in the same second as the cutoff cannot be
    // told from one issued just after it, which means either signing somebody
    // out of the session they are creating or honouring a revoked token for
    // up to a second.
    const before = Date.now();
    const { accessToken } = await issueTokens(USER);
    const claim = await verifyToken(accessToken, "access");

    expect(claim?.issuedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(claim?.issuedAt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("refuses a token with no millisecond claim on it", async () => {
    // A token this version did not mint cannot be placed against a
    // revocation, and guessing in the permissive direction is how a revoked
    // session keeps working.
    const legacy = await new SignJWT({ typ: "access" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(USER)
      .setIssuer("daws")
      .setAudience("daws-api")
      .setIssuedAt()
      .setExpirationTime("2h")
      .sign(secret);

    expect(await verifyToken(legacy, "access")).toBeNull();
  });
});

describe("verifyToken", () => {
  /**
   * The reason both tokens can share a signing secret. If this ever passes,
   * a stolen 30-day refresh token becomes a 30-day API key.
   */
  it("refuses a refresh token presented as an access token", async () => {
    const { refreshToken } = await issueTokens(USER);

    expect(await verifyToken(refreshToken, "access")).toBeNull();
  });

  it("refuses an access token presented as a refresh token", async () => {
    const { accessToken } = await issueTokens(USER);

    expect(await verifyToken(accessToken, "refresh")).toBeNull();
  });

  it("refuses a token signed with a different secret", async () => {
    const foreign = await new SignJWT({ typ: "access" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(USER)
      .setIssuer("daws")
      .setAudience("daws-api")
      .setIssuedAt()
      .setExpirationTime("2h")
      .sign(new TextEncoder().encode("not-the-real-secret-not-the-real-secret"));

    expect(await verifyToken(foreign, "access")).toBeNull();
  });

  it("refuses a token from another issuer or audience", async () => {
    const sign = (issuer: string, audience: string) =>
      new SignJWT({ typ: "access" })
        .setProtectedHeader({ alg: "HS256" })
        .setSubject(USER)
        .setIssuer(issuer)
        .setAudience(audience)
        .setIssuedAt()
        .setExpirationTime("2h")
        .sign(secret);

    expect(await verifyToken(await sign("evil", "daws-api"), "access")).toBeNull();
    expect(await verifyToken(await sign("daws", "evil"), "access")).toBeNull();
  });

  it("refuses an expired token", async () => {
    const expired = await new SignJWT({ typ: "access" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(USER)
      .setIssuer("daws")
      .setAudience("daws-api")
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
      .sign(secret);

    expect(await verifyToken(expired, "access")).toBeNull();
  });

  it("refuses a token with no subject", async () => {
    const subjectless = await new SignJWT({ typ: "access" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer("daws")
      .setAudience("daws-api")
      .setIssuedAt()
      .setExpirationTime("2h")
      .sign(secret);

    expect(await verifyToken(subjectless, "access")).toBeNull();
  });

  it("returns null rather than throwing on malformed input", async () => {
    for (const bad of ["", "not.a.jwt", "a.b", "....", "null"]) {
      expect(await verifyToken(bad, "access")).toBeNull();
    }
  });
});
