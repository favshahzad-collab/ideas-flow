import { prisma } from "../prisma";
import { Prisma } from "../generated/prisma/client";
import { issueTokens, refreshTokenHash, REFRESH_TTL_MS } from "../lib/tokens";
import { auditService } from "./audit.service";

/**
 * Ending a session, which a signed token cannot do for itself.
 *
 * A JWT is a claim the client holds. Nothing here can reach into a laptop and
 * take one back, so revocation has to be something the *server* remembers and
 * checks. Two things are remembered, because they answer two questions:
 *
 *   - a row per sign-in, so "sign out of this device" can end exactly one
 *     session and leave the others alone;
 *   - a cutoff on the account, so "sign out everywhere" - and a password
 *     change, and an account being deleted - ends every token at once,
 *     including access tokens, which no session row can reach because the
 *     client has not presented them yet.
 *
 * The refresh token is never stored, only its SHA-256. A database dump must
 * not be a drawer full of live sessions.
 */

/**
 * How long a token just exchanged may come back without it counting as stolen:
 * long enough for two tabs refreshing at once, far shorter than any real reuse.
 */
export const REUSE_GRACE_MS = 60 * 1000;

/** Who is signing in, for the row that records it. */
export type SessionContext = {
  ipAddress?: string | null;
  userAgent?: string | null;
};

class SessionsService {
  /**
   * Issue a pair and record the session it belongs to.
   *
   * Every path that hands out tokens goes through here - sign-in, sign-up and
   * refresh - so there is one place where a token exists without a row, and it
   * is inside this function.
   */
  async issue(userId: string, context: SessionContext = {}) {
    const { accessToken, refreshToken } = await issueTokens(userId);

    await prisma.refreshSession.create({
      data: {
        userId,
        tokenHash: refreshTokenHash(refreshToken),
        expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
        ipAddress: context.ipAddress ?? null,
        userAgent: context.userAgent?.slice(0, 500) ?? null,
      },
    });

    // Housekeeping on the way past, for this user only. A sweep on a timer
    // would be a fourth one running; this bounds the table against everybody
    // who still signs in, which is everybody who matters.
    await this.pruneExpired(userId);

    return { accessToken, refreshToken };
  }

  /**
   * Swap a refresh token for a new pair, ending the old session.
   *
   * Rotation, not reuse: the token presented is revoked and a new one issued,
   * so a refresh token is good exactly once. That is what makes a stolen one
   * worth less than a stolen password - it stops working the moment the real
   * client refreshes.
   *
   * Two things this did not do:
   *
   *   - It read the row and then revoked it, so two requests carrying the same
   *     token could both read it as live and both be issued a session. The
   *     claim is now the write itself: exactly one request moves the row from
   *     live to spent, and only that one is issued anything.
   *   - A spent token presented again was simply refused. But the real client
   *     never presents a token twice - it stored the new one - so a spent
   *     token coming back means somebody else has a copy. Refusing that one
   *     request left the thief's newer session, from whichever of the two
   *     rotated first, running. Now every session on the account ends, and
   *     the trail says why.
   *
   * The exception is a spent token back within a few seconds. Two tabs of one
   * browser share one stored token and can both decide to refresh at the same
   * moment; the second is not an attack, and ending everything would sign the
   * person out for opening a second tab.
   */
  async rotate(
    refreshToken: string,
    userId: string,
    context: SessionContext = {}
  ) {
    const tokenHash = refreshTokenHash(refreshToken);
    const now = new Date();

    const claimed = await prisma.refreshSession.updateMany({
      where: { tokenHash, userId, revokedAt: null, expiresAt: { gt: now } },
      data: { revokedAt: now, rotatedAt: now },
    });

    if (claimed.count === 1) {
      return this.issue(userId, context);
    }

    // No row means it was issued before sessions were recorded, or it has been
    // pruned, or it was never ours. Refused either way: a token this server
    // cannot account for is not one it should honour.
    const spent = await prisma.refreshSession.findUnique({
      where: { tokenHash },
      select: { id: true, userId: true, rotatedAt: true },
    });

    if (
      spent &&
      spent.userId === userId &&
      spent.rotatedAt &&
      now.getTime() - spent.rotatedAt.getTime() > REUSE_GRACE_MS
    ) {
      await this.endAll(userId, { ipAddress: context.ipAddress ?? undefined });
      await auditService.createAuditLog({
        actorId: userId,
        action: "REFRESH_TOKEN_REUSED",
        entityType: "User",
        entityId: userId,
        newValue: { session: spent.id, exchangedAt: spent.rotatedAt.toISOString() },
        ipAddress: context.ipAddress ?? undefined,
        userAgent: context.userAgent?.slice(0, 500) ?? undefined,
      });
    }

    return null;
  }

  /** End one session - the one whose token is presented. */
  async endOne(
    refreshToken: string,
    userId: string,
    ipAddress?: string
  ): Promise<{ ended: boolean }> {
    const result = await prisma.refreshSession.updateMany({
      where: {
        tokenHash: refreshTokenHash(refreshToken),
        userId,
        revokedAt: null,
      },
      data: { revokedAt: new Date() },
    });

    if (result.count > 0) {
      await auditService.createAuditLog({
        actorId: userId,
        action: "SESSION_ENDED",
        entityType: "User",
        entityId: userId,
        ipAddress,
      });
    }

    // True whether or not a row moved. Signing out is not a place to tell
    // somebody their token was already dead: the client's job afterwards is
    // the same either way, and the answer would be a probe.
    return { ended: true };
  }

  /**
   * End every session this account holds, including tokens already issued.
   *
   * The cutoff is what does the work. Revoking the rows ends refreshes; moving
   * `sessionsValidFrom` is the only thing that reaches an access token sitting
   * unused in a tab, and that is the one somebody worried about a stolen
   * laptop actually means.
   */
  async endAll(
    userId: string,
    options: { actorId?: string; ipAddress?: string; tx?: Prisma.TransactionClient } = {}
  ): Promise<{ ended: number }> {
    const client = options.tx ?? prisma;
    const now = new Date();

    const revoked = await client.refreshSession.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: now },
    });

    await client.user.update({
      where: { id: userId },
      data: { sessionsValidFrom: now },
    });

    await auditService.createAuditLog({
      actorId: options.actorId ?? userId,
      action: "SESSIONS_ENDED_EVERYWHERE",
      entityType: "User",
      entityId: userId,
      newValue: { sessionsRevoked: revoked.count },
      ipAddress: options.ipAddress,
      tx: options.tx,
    });

    return { ended: revoked.count };
  }

  /** What this account currently has open, newest first. */
  async listFor(userId: string) {
    const sessions = await prisma.refreshSession.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { issuedAt: "desc" },
      take: 50,
      select: {
        id: true,
        issuedAt: true,
        expiresAt: true,
        ipAddress: true,
        userAgent: true,
      },
    });

    return { sessions, total: sessions.length };
  }

  /**
   * Who is signed in across the organisation, and who just left.
   *
   * `listFor` answers this for one account and is what a person sees about
   * their own devices. This is the administrator's version, and it is a
   * different question: not "where am I signed in" but "who is in the system
   * right now" - which is the question asked when an account is suspected, when
   * somebody has left, and when a memo was approved by a person who says they
   * were not at their desk.
   *
   * Recently ended sessions come back too, and they are the more useful half.
   * A row that is gone tells you nothing; a row that says "signed out at 14:02
   * from that address" is what makes the active list mean something. They
   * survive a week, which is the same grace `pruneExpired` gives them.
   */
  async listAll(options: { endedWithinHours?: number } = {}) {
    const now = new Date();
    const endedSince = new Date(
      now.getTime() - (options.endedWithinHours ?? 24 * 7) * 60 * 60 * 1000
    );

    const person = {
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        loginRole: true,
        department: { select: { id: true, name: true } },
      },
    } as const;

    const [active, ended] = await Promise.all([
      prisma.refreshSession.findMany({
        where: { revokedAt: null, expiresAt: { gt: now } },
        orderBy: { issuedAt: "desc" },
        take: 200,
        select: {
          id: true,
          issuedAt: true,
          expiresAt: true,
          ipAddress: true,
          userAgent: true,
          user: person,
        },
      }),
      prisma.refreshSession.findMany({
        where: { revokedAt: { not: null, gte: endedSince } },
        orderBy: { revokedAt: "desc" },
        take: 100,
        select: {
          id: true,
          issuedAt: true,
          revokedAt: true,
          ipAddress: true,
          userAgent: true,
          user: person,
        },
      }),
    ]);

    /*
     * People, not sessions. Somebody with a laptop and a phone is one person
     * signed in twice, and a screen that says "14 signed in" when seven people
     * are at work is worse than no number: it is a number that will be quoted.
     */
    const peopleSignedIn = new Set(active.map((session) => session.user.id)).size;

    return {
      active,
      ended,
      summary: {
        peopleSignedIn,
        sessionsOpen: active.length,
        endedWithinHours: options.endedWithinHours ?? 24 * 7,
      },
    };
  }

  /**
   * Drop sessions that expired long enough ago to be no use to anybody.
   *
   * A week's grace rather than deleting on the stroke of expiry: a revoked
   * session is a small piece of evidence about when somebody signed out, and
   * an administrator asking that question is usually asking about the last few
   * days.
   */
  async pruneExpired(userId?: string): Promise<{ removed: number }> {
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const result = await prisma.refreshSession.deleteMany({
      where: {
        ...(userId ? { userId } : {}),
        expiresAt: { lt: cutoff },
      },
    });

    return { removed: result.count };
  }
}

export const sessionsService = new SessionsService();
