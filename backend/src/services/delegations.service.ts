import { prisma } from "../prisma";
import { memoTypeKeys } from "../lib/memoTypes";
import { errors } from "../lib/errors";
import {
  delegationsOverlap,
  coversMemoType,
  isDelegationActive,
  MAX_DELEGATION_DAYS,
  UPLOADED_MEMO,
} from "../lib/delegation";
import type { CreateDelegationInput } from "../schemas/delegations.schema";
import { auditService } from "./audit.service";
import { logger } from "../lib/logger";
import { notificationsService } from "./notifications.service";

/**
 * Handing one person's approvals to another while they are away.
 *
 * This is the only place in the product where somebody may act on a step that
 * is not theirs, so every refusal here is load-bearing:
 *
 *   - only the person themselves, or an administrator, may arrange it;
 *   - nobody delegates to themselves, and an administrator arranging cover for
 *     somebody else cannot name themselves as that cover;
 *   - one delegate at a time, so "who may sign for Ayesha on Tuesday" has one
 *     answer;
 *   - no onward delegation, in either direction - a person who is away
 *     cannot be handed somebody else's approvals on top of their own, and a
 *     person covering for a colleague cannot route their own onward;
 *   - it is revoked, never edited or deleted, so the record of what was
 *     possible between which dates outlives the arrangement.
 *
 * What it does NOT do is take the step away from the person who owns it. Being
 * away is a fact about a diary, not a lock: if they sign it themselves the
 * approval is theirs, and the delegation was simply not used.
 */

const USER_REF = {
  id: true,
  firstName: true,
  lastName: true,
  designation: true,
  email: true,
} as const;

const DELEGATION_SHAPE = {
  id: true,
  delegatorId: true,
  delegateId: true,
  memoTypes: true,
  startsAt: true,
  endsAt: true,
  reason: true,
  revokedAt: true,
  createdAt: true,
  delegator: { select: USER_REF },
  delegate: { select: USER_REF },
} as const;

export type Actor = { id: string; isAdministrator: boolean };

/** The same shape the trail and the approval stamps use. */
const fullName = (user: { firstName: string; lastName: string }): string =>
  `${user.firstName} ${user.lastName}`.trim();

class DelegationsService {
  /**
   * The people whose steps this person may act on right now.
   *
   * Called on the access paths, so it asks the database one narrow question
   * and answers with ids alone. An empty array is the overwhelmingly common
   * answer and costs one indexed lookup.
   */
  async delegatorIdsFor(
    userId: string,
    at: Date = new Date()
  ): Promise<string[]> {
    const held = await prisma.delegation.findMany({
      where: {
        delegateId: userId,
        revokedAt: null,
        startsAt: { lte: at },
        OR: [{ endsAt: null }, { endsAt: { gte: at } }],
      },
      select: { delegatorId: true },
    });

    return [...new Set(held.map((row) => row.delegatorId))].filter(
      (id) => id !== userId
    );
  }

  /**
   * Who this person covers for right now, and for which memo types. The
   * scoped twin of `delegatorIdsFor`, for the paths that decide whether a
   * memo is waiting on somebody - where a delegation limited to some memo
   * types must not make the others look like theirs.
   */
  async coverHeldBy(
    userId: string,
    at: Date = new Date()
  ): Promise<{ delegatorId: string; memoTypes: string[] }[]> {
    const held = await prisma.delegation.findMany({
      where: {
        delegateId: userId,
        revokedAt: null,
        startsAt: { lte: at },
        OR: [{ endsAt: null }, { endsAt: { gte: at } }],
      },
      select: { delegatorId: true, memoTypes: true },
    });

    return held.filter((row) => row.delegatorId !== userId);
  }

  /**
   * The delegation covering this person's approvals now, if there is one.
   *
   * With `memoType` - null for an uploaded memo - only a delegation that
   * covers that kind of memo answers. Left out, any does.
   */
  async activeDelegationFor(
    delegatorId: string,
    at: Date = new Date(),
    memoType?: string | null
  ) {
    const candidates = await prisma.delegation.findMany({
      where: { delegatorId, revokedAt: null },
      select: DELEGATION_SHAPE,
      orderBy: { startsAt: "desc" },
    });

    return (
      candidates.find(
        (delegation) =>
          isDelegationActive(delegation, at) &&
          (memoType === undefined || coversMemoType(delegation.memoTypes, memoType))
      ) ?? null
    );
  }

  /**
   * May this person act on a step assigned to `assignedUserId`?
   *
   * Answers with the delegation that allows it, so the caller can record which
   * authorisation was used rather than merely that one existed.
   */
  async authorityOver(
    assignedUserId: string,
    actorId: string,
    at: Date = new Date(),
    /** The memo's type, null for an uploaded one: a scoped cover must cover it. */
    memoType?: string | null
  ): Promise<{ allowed: boolean; onBehalfOfId: string | null }> {
    if (assignedUserId === actorId) {
      return { allowed: true, onBehalfOfId: null };
    }

    const delegation = await this.activeDelegationFor(assignedUserId, at, memoType);

    if (delegation && delegation.delegateId === actorId) {
      return { allowed: true, onBehalfOfId: assignedUserId };
    }

    return { allowed: false, onBehalfOfId: null };
  }

  /** Everything one person has given away and everything they hold. */
  async listForUser(userId: string) {
    const [given, held] = await Promise.all([
      prisma.delegation.findMany({
        where: { delegatorId: userId },
        select: DELEGATION_SHAPE,
        orderBy: { createdAt: "desc" },
      }),
      prisma.delegation.findMany({
        where: { delegateId: userId },
        select: DELEGATION_SHAPE,
        orderBy: { createdAt: "desc" },
      }),
    ]);

    const now = new Date();
    const withState = <T extends { startsAt: Date; endsAt: Date | null; revokedAt: Date | null }>(
      rows: T[]
    ) => rows.map((row) => ({ ...row, isActive: isDelegationActive(row, now) }));

    return { given: withState(given), held: withState(held) };
  }

  async create(input: CreateDelegationInput, actor: Actor, ipAddress?: string) {
    const delegatorId = input.delegatorId ?? actor.id;

    if (delegatorId !== actor.id && !actor.isAdministrator) {
      throw errors.forbidden(
        "You can only hand over your own approvals. An administrator can do it for somebody else."
      );
    }

    if (delegatorId === input.delegateId) {
      throw errors.badRequest(
        "Approvals cannot be delegated to the person they already belong to."
      );
    }

    /*
     * An administrator may arrange cover for somebody else, but not name
     * themselves as the cover. That would let one person decide that an
     * approver is away and then sign in their place - granting the authority
     * and using it in the same breath. The approver can still hand their own
     * approvals to an administrator; it is the administrator choosing it for
     * them that is refused.
     */
    if (delegatorId !== actor.id && input.delegateId === actor.id) {
      throw errors.forbidden(
        "You cannot arrange for somebody's approvals to be handed to you. Ask them to set it up, or choose another person to cover."
      );
    }

    const [delegator, delegate] = await Promise.all([
      prisma.user.findUnique({
        where: { id: delegatorId },
        select: { id: true, firstName: true, lastName: true, deactivatedAt: true },
      }),
      prisma.user.findUnique({
        where: { id: input.delegateId },
        select: { id: true, firstName: true, lastName: true, deactivatedAt: true },
      }),
    ]);

    if (!delegator) {
      throw errors.notFound("That person is no longer listed.");
    }

    if (!delegate) {
      throw errors.notFound("The delegate is no longer listed.");
    }

    /*
     * Neither end of it can be an account that is switched off.
     *
     * The delegate is the obvious half: somebody who cannot sign in cannot
     * sign anything, so handing them a colleague's approvals routes that
     * colleague's memos into a dead end - the exact failure a delegation
     * exists to prevent.
     *
     * The delegator is the half worth stating. Arranging cover for somebody
     * who has left reads like the right thing to do and is not: their steps
     * should be MOVED, with a reason on the memo, rather than quietly signed
     * by a stand-in under a name that no longer works here.
     */
    if (delegate.deactivatedAt) {
      throw errors.badRequest(
        `${delegate.firstName}'s account has been switched off, so they cannot take anybody's approvals.`
      );
    }

    if (delegator.deactivatedAt) {
      throw errors.badRequest(
        `${delegator.firstName}'s account has been switched off. Move their steps to somebody else instead of arranging cover.`
      );
    }

    const startsAt = input.startsAt ?? new Date();

    /*
     * At most ninety days (fit-gap decision 6). Open-ended authority to sign
     * in somebody's name is how a delegation for a fortnight's leave is
     * still in force a year later. No end date means the longest allowed,
     * which the screen says; a longer one is refused rather than trimmed.
     */
    const longest = new Date(startsAt.getTime() + MAX_DELEGATION_DAYS * 24 * 60 * 60 * 1000);
    longest.setUTCHours(23, 59, 59, 999);
    const endsAt = input.endsAt ?? longest;

    if (endsAt > longest) {
      throw errors.badRequest(
        `A delegation can run for at most ${MAX_DELEGATION_DAYS} days. Choose an end date on or before ${longest.toISOString().slice(0, 10)}, and arrange another after it if it is still needed.`
      );
    }

    // Only kinds of memo that exist; an empty list is full cover.
    const memoTypes = [...new Set(input.memoTypes ?? [])];
    const known = new Set([...memoTypeKeys(), UPLOADED_MEMO]);
    const unknown = memoTypes.find((key) => !known.has(key));
    if (unknown) {
      throw errors.badRequest(`"${unknown}" is not a kind of memo here. Choose from the list.`);
    }

    if (endsAt && endsAt < startsAt) {
      throw errors.badRequest("The delegation cannot end before it starts.");
    }

    if (endsAt && endsAt < new Date()) {
      throw errors.badRequest(
        "That end date has already passed, so the delegation would never apply."
      );
    }

    /*
     * Every live arrangement either of these two people is part of, in one
     * read, because all three refusals below are the same question asked of a
     * different column: does this new window share any days with that one.
     *
     * Days, not the starting instant. The rule this replaced asked whether
     * the delegate was away *as the handover began*, which is true of an
     * arrangement that has already started and false of one beginning on
     * Thursday - so a delegate who is here today and away from Thursday
     * passed it, and the memo was stranded from Thursday on. The harm was
     * not avoided, only postponed.
     */
    const window = { startsAt, endsAt };
    const live = await prisma.delegation.findMany({
      where: {
        revokedAt: null,
        OR: [
          { delegatorId: { in: [delegatorId, input.delegateId] } },
          { delegateId: delegatorId },
        ],
      },
      select: {
        delegatorId: true,
        delegateId: true,
        startsAt: true,
        endsAt: true,
      },
    });

    const clashes = live.filter((row) => delegationsOverlap(row, window));

    // One delegate at a time. Two overlapping arrangements would make "who
    // may sign for this person on Tuesday" a question with two answers.
    if (clashes.some((row) => row.delegatorId === delegatorId)) {
      throw errors.conflict(
        `${delegator.firstName} already has a delegation covering those dates. Revoke it first.`
      );
    }

    /*
     * No onward delegation, in either direction - one rule, and it was only
     * ever enforced one way round.
     *
     * The way it was enforced: somebody whose own approvals are already
     * routed away is not there to receive anybody else's.
     */
    if (clashes.some((row) => row.delegatorId === input.delegateId)) {
      throw errors.conflict(
        `${delegate.firstName} has handed their own approvals to somebody else, so they cannot take these on.`
      );
    }

    /*
     * The way it was not: somebody already covering for a colleague cannot
     * then route their own approvals onward. This is the half that strands a
     * memo. The colleague's steps stay addressed to the person covering -
     * that is what a delegation does - so handing that person's own approvals
     * to a third makes no difference to them: the steps still arrive at
     * somebody who is away, and the third person has neither the authority to
     * sign them nor any notice that they exist.
     */
    if (clashes.some((row) => row.delegateId === delegatorId)) {
      throw errors.conflict(
        `${delegator.firstName} is covering approvals for somebody else over those dates, so their own cannot be handed on. End that arrangement first.`
      );
    }

    const delegation = await prisma.delegation.create({
      data: {
        delegatorId,
        delegateId: input.delegateId,
        startsAt,
        endsAt,
        reason: input.reason?.trim() || null,
        memoTypes,
        createdById: actor.id,
      },
      select: DELEGATION_SHAPE,
    });

    await auditService.createAuditLog({
      actorId: actor.id,
      action: "DELEGATION_CREATED",
      entityType: "Delegation",
      entityId: delegation.id,
      newValue: {
        delegatorId,
        delegateId: input.delegateId,
        startsAt: startsAt.toISOString(),
        endsAt: endsAt.toISOString(),
        reason: delegation.reason,
        memoTypes,
      },
      ipAddress,
    });

    await this.tellThemBoth(actor, "DELEGATION_STARTED", {
      delegator: delegation.delegator,
      delegate: delegation.delegate,
      toDelegate: {
        title: "You are covering approvals",
        message: `You are now covering approvals for ${fullName(delegation.delegator)}. Anything waiting on them will come to you, and your signature on it records that you signed for them.`,
      },
      toDelegator: {
        title: "Your approvals were handed over",
        message: `Your approvals have been handed to ${fullName(delegation.delegate)} - they can now sign in your place. If you did not arrange this, tell your administrator now.`,
      },
    });

    return { ...delegation, isActive: isDelegationActive(delegation, new Date()) };
  }

  async revoke(delegationId: string, actor: Actor, ipAddress?: string) {
    const delegation = await prisma.delegation.findUnique({
      where: { id: delegationId },
      select: { ...DELEGATION_SHAPE, createdById: true },
    });

    if (!delegation) {
      throw errors.notFound("That delegation no longer exists.");
    }

    if (delegation.delegatorId !== actor.id && !actor.isAdministrator) {
      throw errors.forbidden(
        "You can only end a delegation of your own approvals. An administrator can end anybody's."
      );
    }

    if (delegation.revokedAt) {
      throw errors.conflict("That delegation has already been ended.");
    }

    const revoked = await prisma.delegation.update({
      where: { id: delegationId },
      data: { revokedAt: new Date(), revokedById: actor.id },
      select: DELEGATION_SHAPE,
    });

    await auditService.createAuditLog({
      actorId: actor.id,
      action: "DELEGATION_REVOKED",
      entityType: "Delegation",
      entityId: delegationId,
      oldValue: {
        delegatorId: delegation.delegatorId,
        delegateId: delegation.delegateId,
      },
      newValue: { revokedAt: revoked.revokedAt?.toISOString() ?? null },
      ipAddress,
    });

    await this.tellThemBoth(actor, "DELEGATION_ENDED", {
      delegator: revoked.delegator,
      delegate: revoked.delegate,
      toDelegate: {
        title: "You are no longer covering approvals",
        message: `You are no longer covering approvals for ${fullName(revoked.delegator)}. Anything still waiting goes back to them.`,
      },
      toDelegator: {
        title: "Your approvals are back with you",
        message: `${fullName(revoked.delegate)} is no longer covering your approvals. Anything waiting is with you again.`,
      },
    });

    // Approvals already given under it stand: they were authorised when they
    // were given, which is what the dates on the kept row show.
    return { ...revoked, isActive: false };
  }

  /**
   * Tell the two people an arrangement concerns - and never the one who did it.
   *
   * One rule covers all four cases. Somebody handing over their own approvals
   * is told nothing, because they just did it; an ADMINISTRATOR doing it for
   * two other people tells both, which is the case this was written for and
   * the one that was silent. Same on the way back.
   *
   * Outside the write, and never allowed to fail it. An arrangement that
   * exists in the table but was refused because a mail row would not write is
   * worse than one nobody was told about - the second at least has a trail.
   */
  private async tellThemBoth(
    actor: Actor,
    type: "DELEGATION_STARTED" | "DELEGATION_ENDED",
    input: {
      delegator: { id: string; firstName: string; lastName: string };
      delegate: { id: string; firstName: string; lastName: string };
      toDelegate: { title: string; message: string };
      toDelegator: { title: string; message: string };
    }
  ) {
    const notices = [
      { recipientId: input.delegate.id, type, ...input.toDelegate },
      { recipientId: input.delegator.id, type, ...input.toDelegator },
    ].filter((notice) => notice.recipientId !== actor.id);

    try {
      await notificationsService.createNotifications(notices);
    } catch (error) {
      logger.error("delegation.notice.failed", {
        type,
        delegatorId: input.delegator.id,
        delegateId: input.delegate.id,
        message: error instanceof Error ? error.message : "unknown",
      });
    }
  }
}

export const delegationsService = new DelegationsService();
