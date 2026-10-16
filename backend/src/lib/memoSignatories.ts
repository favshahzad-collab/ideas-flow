/**
 * Who gets a ruled line at the foot of a generated memo.
 *
 * One place, because two paths need the same answer and must never disagree:
 * the preview the preparer signs on, and the artefact the submission files.
 * If the preview drew three columns and the submission drew four, every
 * signature the preparer placed would land in the wrong column of a document
 * that is immutable by the time anybody notices.
 *
 * The rule is: everybody who will put a signature on this memo, in the order
 * they will do it. The preparer signs first - their signature is burned into
 * `v1.pdf` before the chain starts - so they take the first column, and each
 * approval step follows in chain order.
 *
 * That rule is also the fix for what the Phase 3 walkthrough exposed: the
 * strip used to name only the approvers, so the preparer had no line to sign
 * on and stamped their signature into the body, while the lines that were
 * printed stayed empty. A printed line nobody can sign is not a signature
 * block; it is a decoration that makes the document look unfinished forever.
 */
import type { MemoSignatory } from "./memoTemplate";

export type SignatoryPerson = {
  id: string;
  firstName: string;
  lastName: string;
  designation?: string | null;
  /**
   * The office they sign for, printed under the designation.
   *
   * Either the joined row or a plain name, because `department` is a relation
   * and Prisma hands back `{ name }` - accepting both keeps every call site a
   * plain `select` instead of a mapping step each one could get wrong.
   */
  department?: { name: string } | string | null;
};

/** The office's name, whichever shape it arrived in. */
function officeName(
  department: SignatoryPerson["department"]
): string | null {
  if (!department) return null;
  return typeof department === "string" ? department : department.name;
}

export function personName(person: {
  firstName: string;
  lastName: string;
}): string {
  return `${person.firstName} ${person.lastName}`.trim();
}

/**
 * The strip, left to right.
 *
 * `key` is the user id, which is what lets a slot be matched back to the
 * person whose signature belongs in it. Anybody named twice - a chain that
 * includes the preparer, which submission refuses but a half-written draft
 * may well hold - gets one column, at their first position: two columns with
 * one key would make the slots ambiguous precisely where they are used.
 */
export function buildMemoSignatories(
  preparer: SignatoryPerson,
  chain: { userId: string }[],
  chainPeople: SignatoryPerson[],
  /**
   * Whether the preparer takes the first column.
   *
   * False when submitting this kind of document does not mean signing it, and
   * then the strip starts at the first approver. Printing them a line anyway
   * would leave a ruled line with their name under it that nothing in the
   * product will ever fill, on a page that cannot be redrawn - the exact
   * failure the strip was built to end, arrived at from the other direction.
   *
   * Defaulted rather than required so that every existing caller, and every
   * memo already filed, keeps the column it has.
   */
  options: { preparerSigns?: boolean } = {}
): MemoSignatory[] {
  const byId = new Map(chainPeople.map((person) => [person.id, person]));
  const seen = new Set<string>();
  const signatories: MemoSignatory[] = [];

  const add = (person: SignatoryPerson): void => {
    if (seen.has(person.id)) return;
    seen.add(person.id);
    signatories.push({
      key: person.id,
      name: personName(person),
      designation: person.designation ?? null,
      department: officeName(person.department),
    });
  };

  if (options.preparerSigns ?? true) add(preparer);

  for (const step of chain) {
    const person = byId.get(step.userId);
    // A step naming somebody who could not be resolved is skipped rather than
    // drawn as a blank column. Submission refuses such a chain outright; a
    // draft preview should still render what it can.
    if (person) add(person);
  }

  return signatories;
}
