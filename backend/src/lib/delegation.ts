/**
 * When one person's approvals count as another person's to give.
 *
 * A delegation is an authorisation with dates on it, and everything that
 * matters about it is a question about time: is it in force *now*, was it in
 * force when that signature was placed, does this new one overlap one that
 * already exists. Those questions are answered here, on plain values, so the
 * service can be about rows and the rules can be about rules.
 *
 * Nothing here decides who may create a delegation - that is
 * `delegations.service` - and nothing here reaches the database.
 */

export type DelegationWindow = {
  startsAt: Date;
  /** Null means open-ended: in force until somebody revokes it. */
  endsAt: Date | null;
  revokedAt: Date | null;
};

/**
 * Is this delegation in force at `at`?
 *
 * Both ends are inclusive. A delegation that starts today covers a signature
 * given today, and one that ends today covers one given today - a person told
 * "you are covering until the 20th" signs on the 20th, and being refused at
 * one minute past midnight on a boundary nobody explained is the kind of
 * detail that makes a system feel arbitrary.
 *
 * Revocation is immediate: from the moment it is revoked the delegate cannot
 * act, whatever the dates said. The row is kept - it is the record of what was
 * possible between which dates - and the approvals given under it stand.
 */
export function isDelegationActive(
  delegation: DelegationWindow,
  at: Date
): boolean {
  if (delegation.revokedAt !== null && delegation.revokedAt <= at) {
    return false;
  }

  if (delegation.startsAt > at) {
    return false;
  }

  return delegation.endsAt === null || delegation.endsAt >= at;
}

/**
 * Do two delegations from the same person cover any of the same time?
 *
 * One person has one delegate at a time. Two overlapping delegations would
 * make "who may sign for Ayesha on Tuesday" a question with two answers, and
 * an authorisation nobody can state is not one.
 */
export function delegationsOverlap(
  a: { startsAt: Date; endsAt: Date | null },
  b: { startsAt: Date; endsAt: Date | null }
): boolean {
  const aEndsBeforeBStarts = a.endsAt !== null && a.endsAt < b.startsAt;
  const bEndsBeforeAStarts = b.endsAt !== null && b.endsAt < a.startsAt;

  return !aEndsBeforeBStarts && !bEndsBeforeAStarts;
}

/** The people whose steps this person may act on, themselves included. */
export function actingAs(
  userId: string,
  delegatorIds: readonly string[]
): string[] {
  return [userId, ...delegatorIds.filter((id) => id !== userId)];
}

/**
 * What a delegation's memo types are called for a memo uploaded as a PDF,
 * which has no memo type of its own.
 */
export const UPLOADED_MEMO = "UPLOADED";

/** The longest a delegation may run: agreed after the fit-gap review. */
export const MAX_DELEGATION_DAYS = 90;

/**
 * Does a delegation limited to `memoTypes` cover a memo of this type?
 *
 * Empty is full cover - every memo - which is the default and what every
 * delegation made before scopes existed carries. `memoType` is the memo's
 * own: null for an uploaded one.
 */
export function coversMemoType(
  memoTypes: readonly string[],
  memoType: string | null
): boolean {
  return memoTypes.length === 0 || memoTypes.includes(memoType ?? UPLOADED_MEMO);
}

/** The people whose steps on a memo of this type somebody covers. */
export function actingForMemo(
  cover: readonly { delegatorId: string; memoTypes: readonly string[] }[],
  memoType: string | null
): string[] {
  return cover
    .filter((held) => coversMemoType(held.memoTypes, memoType))
    .map((held) => held.delegatorId);
}
