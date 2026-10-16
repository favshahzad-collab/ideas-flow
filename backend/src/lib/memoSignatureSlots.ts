/**
 * Landing a signature on the line that was printed for it.
 *
 * A generated memo carries a printed strip at its foot: a ruled line per
 * signatory with their name underneath, exactly as the paper form has always
 * had. The stamping path, which predates the strip by a long way, drops a
 * signature image wherever the signer dragged their box and draws its own
 * name, title and date beneath it.
 *
 * Left alone, those two produce a document that is wrong either way round.
 * Sign away from the strip and the printed lines stay blank forever while the
 * signatures float in the body - every approver's name on the page twice, once
 * signed and once not. Sign on top of the strip and the stamped name block
 * lands on the printed name and neither can be read.
 *
 * So: when a signature is placed on somebody's own line, it is snapped to that
 * line and the block below it is reduced to the date. The name and title are
 * already printed a few points below, in the strip, which is the whole point
 * of the strip.
 */
import type { MemoSignatureSlot } from "./memoTemplate";
import type { SignaturePlacement } from "./pdfSignature";

/**
 * Air left under the image, inside the slot, above the printed line.
 *
 * Sixteen points, once: the stamping path used to write the date there, and
 * the box stopped short of the line to make room for it. No date is drawn
 * under a signature on its own line any more (the ledger keeps it), so the
 * signature comes down to sit on the line, as ink does - leaving it sixteen
 * points up would leave a gap exactly where the date used to be. The name is
 * kept so the frontend's mirror still pairs with it by name.
 *
 * MIRRORED in `frontend/src/utils/pdfCoordinates.ts`.
 */
export const SLOT_DATE_LANE = 2;

/**
 * Is this placement an attempt to sign on that line?
 *
 * By the centre of the box rather than by an exact match. The client is given
 * the slot and normally sends it back untouched, but a signer who nudges their
 * box by two points has not stopped meaning the same line, and a rule that
 * demanded equality would silently fall back to the free-floating behaviour
 * this exists to replace.
 */
export function placementIsInSlot(
  placement: SignaturePlacement,
  slot: MemoSignatureSlot
): boolean {
  if (placement.signaturePage !== slot.page) return false;

  const centreX = placement.signatureX + placement.signatureWidth / 2;
  const centreY = placement.signatureY + placement.signatureHeight / 2;

  return (
    centreX >= slot.x &&
    centreX <= slot.x + slot.width &&
    centreY >= slot.y &&
    centreY <= slot.y + slot.height
  );
}

/**
 * The box a slotted signature is actually drawn into.
 *
 * Snapped to the slot rather than used as sent: the printed line is a fixed
 * width and the signature belongs above it, centred on it. A box the signer
 * dragged to two thirds of the width, or overlapping the line below, would
 * make one column of the strip look different from the others on a document
 * that is filed for years.
 */
export function placementForSlot(
  slot: MemoSignatureSlot
): SignaturePlacement {
  return {
    signaturePage: slot.page,
    signatureX: slot.x,
    signatureY: slot.y,
    signatureWidth: slot.width,
    signatureHeight: Math.max(1, slot.height - SLOT_DATE_LANE),
  };
}

/**
 * One person's slot from a version's recorded strip.
 *
 * The column is JSON, so its contents are whatever some build of the renderer
 * wrote. A row that cannot be read gives no slot, and the signature is placed
 * by hand - which is what every uploaded memo does and what this feature
 * replaced. Failing to sign would be a far worse answer than failing to
 * offer a convenience.
 */
export function findSignatureSlot(
  slots: unknown,
  userId: string
): MemoSignatureSlot | null {
  if (!Array.isArray(slots)) return null;

  const numeric = (value: unknown): value is number =>
    typeof value === "number" && Number.isFinite(value);

  const mine = slots.find((slot): slot is MemoSignatureSlot => {
    if (typeof slot !== "object" || slot === null) return false;
    const candidate = slot as Record<string, unknown>;

    return (
      candidate.key === userId &&
      numeric(candidate.page) &&
      numeric(candidate.x) &&
      numeric(candidate.y) &&
      numeric(candidate.width) &&
      numeric(candidate.height)
    );
  });

  return mine ?? null;
}

/**
 * Whose printed line a placement lands on, if anybody's.
 *
 * `findSignatureSlot` answers "where does this person sign"; this answers the
 * question the other way round, which is the one a permission check needs:
 * given where somebody is trying to put their mark, whose line is that?
 *
 * The strip is drawn into the filed PDF and names every signatory, so the
 * coordinates of a future approver's line are not a secret and never could
 * be - they are printed on a page anyone entitled to read the memo can open.
 * What has to be impossible is *writing* there. A signer whose request lands
 * on a line that is not theirs is refused rather than quietly moved, because
 * silently correcting it would file a valid-looking document and leave no
 * trace that somebody tried.
 *
 * Returns the owning signatory's key, or null when the placement is in open
 * space - which is where every uploaded memo's signature goes, and is not
 * something this has an opinion about.
 */
export function slotOwnerAt(
  slots: unknown,
  placement: SignaturePlacement
): string | null {
  if (!Array.isArray(slots)) return null;

  for (const slot of slots) {
    if (typeof slot !== "object" || slot === null) continue;
    const candidate = slot as Record<string, unknown>;
    if (typeof candidate.key !== "string") continue;

    const numeric = (value: unknown): value is number =>
      typeof value === "number" && Number.isFinite(value);

    if (
      !numeric(candidate.page) ||
      !numeric(candidate.x) ||
      !numeric(candidate.y) ||
      !numeric(candidate.width) ||
      !numeric(candidate.height)
    ) {
      continue;
    }

    if (placementIsInSlot(placement, candidate as unknown as MemoSignatureSlot)) {
      return candidate.key;
    }
  }

  return null;
}

/**
 * Whether these slots mean the memo was typed in the portal.
 *
 * A typed memo's version carries the strip its template drew. An attached
 * PDF's version can now carry slots too - the signing lines found above its
 * printed names (`lib/signatoryLines.ts`), marked `detected`. Everything that
 * asks "was this typed?" must not mistake those for a drawn strip: what is
 * drawn under a signature, and which resubmission path applies, both differ.
 */
export function isTypedMemoSlots(slots: unknown): boolean {
  return (
    Array.isArray(slots) &&
    !slots.some(
      (slot) => typeof slot === "object" && slot !== null && (slot as { detected?: unknown }).detected === true
    )
  );
}
