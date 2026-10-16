/**
 * Whether the person submitting a document also signs it.
 *
 * One function, because four places need the same answer and disagreeing is
 * expensive in a way that is hard to see: the screen decides whether to open
 * the signing dialog, the schema decides whether a signature may be absent,
 * the strip decides whether to print the preparer a ruled line, and the
 * service decides whether to stamp one. A strip that printed a line the
 * submit flow never offers to fill leaves every filed memo looking
 * unfinished, and there is no way to redraw it afterwards.
 *
 * Submitting used to mean signing, always. It is the default still: every
 * document already filed was signed by its preparer at the moment they
 * submitted it, and a deployment that has said nothing has not asked for that
 * to change.
 *
 * The rule, in order:
 *
 *   1. The memo type, when it states a preference. A memo somebody authors
 *      and recommends in their own name is signed by them whatever the
 *      organisation's default is; a form they merely lodge is not.
 *   2. Otherwise the organisation's policy, which is also the only answer
 *      available for an uploaded document - it has no memo type to ask.
 */
import { preparerSignsOnSubmit } from "./env";
import { findMemoType } from "./memoTypes";

export function preparerMustSign(memoType: string | null | undefined): boolean {
  const definition = memoType ? findMemoType(memoType) : null;

  if (definition && typeof definition.preparerSigns === "boolean") {
    return definition.preparerSigns;
  }

  return preparerSignsOnSubmit();
}
