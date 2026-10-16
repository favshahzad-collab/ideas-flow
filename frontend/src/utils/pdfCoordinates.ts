/** Default signature box size in PDF points (1/72 inch). */
export const SIGNATURE_WIDTH_PDF = 150
export const SIGNATURE_HEIGHT_PDF = 50

export const MIN_SIGNATURE_WIDTH_PDF = 40
export const MIN_SIGNATURE_HEIGHT_PDF = 20
export const MAX_SIGNATURE_WIDTH_PDF = 400
export const MAX_SIGNATURE_HEIGHT_PDF = 200

export type ResizeHandle = 'nw' | 'ne' | 'sw' | 'se'

/*
 * The sign-off block's layout, in points.
 *
 * MIRRORS `backend/src/lib/pdfSignature.ts`, which is what actually draws it.
 * The editor needs the height for two reasons, and both are about the placed
 * signature meaning what it says:
 *
 *   - the block is drawn DOWNWARDS from the foot of the image, so a signature
 *     dropped near the bottom of the page has its name and designation drawn
 *     off the edge unless the room is reserved while placing;
 *   - the backend reserves it anyway, by moving the signature UP. Reserving it
 *     here too is the difference between the box you dragged and the box that
 *     comes back in the PDF.
 *
 * `signoffBlockHeight` in both files is pinned to the same numbers by tests on
 * both sides, so a change to one that is not made to the other fails a gate
 * rather than quietly shifting every future signature.
 */
const RULE_OFFSET = 5
/** The gap under a signature on a line the page already printed. */
const OWN_LINE_OFFSET = 1
const RULE_THICKNESS = 0.75
const NAME_SIZE = 9
const DETAIL_SIZE = 7.5
const LINE_GAP = 3.5
const DESCENDER_TAIL = 2

/** What the block will say, which decides how tall it is. */
export interface SignoffPreview {
  name?: string | null
  designation?: string | null
  department?: string | null
  /**
   * Stands in for the attestation line - the capacity, the date, or both.
   *
   * Its value is never drawn here. The block counts that line once however it
   * is filled, so a caller with nothing to quote but the date sets this to
   * say the line exists rather than reading a clock during render. Drawn on
   * an uploaded document only; a memo typed in the portal carries no
   * attestation under a signature.
   */
  capacity?: string | null
  signedAt?: Date | string | null
  onBehalfOf?: string | null
  /**
   * The page already prints this person's name and title under where the
   * signature goes: their own line on a typed memo's strip, or any attached
   * PDF, which is written in Word with its signatories on it. Nothing is
   * drawn under the mark then but a delegate's "Signed for" line.
   */
  onOwnLine?: boolean
}

function filled(value: string | null | undefined): boolean {
  return Boolean((value ?? '').replace(/\s+/g, ' ').trim())
}

/**
 * How far below the signature image the name/designation block reaches.
 *
 * Zero only when there is no name to draw. The preparer's signing screen used
 * to pass nothing here on the belief that the backend drew nothing for a
 * preparer - it does, the same block as every approver gets - so the editor
 * reserved no room and the name, title and date were drawn off the bottom of
 * the page. Zero is the answer for an empty block, never a default.
 */
export function signoffBlockHeight(signoff?: SignoffPreview | null): number {
  if (!signoff || !filled(signoff.name)) return 0

  if (signoff.onOwnLine) {
    return filled(signoff.onBehalfOf)
      ? OWN_LINE_OFFSET + LINE_GAP + DETAIL_SIZE + DESCENDER_TAIL
      : 0
  }

  const sizes: number[] = [NAME_SIZE]
  if (filled(signoff.designation) || filled(signoff.department)) sizes.push(DETAIL_SIZE)
  // The capacity, on an uploaded file; no date is drawn under any signature.
  if (filled(signoff.capacity)) sizes.push(DETAIL_SIZE)
  if (filled(signoff.onBehalfOf)) sizes.push(DETAIL_SIZE)

  return (
    sizes.reduce((total, size) => total + LINE_GAP + size, RULE_OFFSET + RULE_THICKNESS) +
    DESCENDER_TAIL
  )
}

/**
 * Put a box on the page and keep it there, leaving room under it for whatever
 * is drawn below.
 *
 * The single place every move, resize and drop passes through, so "cannot be
 * dragged off the page" is one rule rather than four copies of it.
 */
export function clampToPage(
  placement: PdfPlacement,
  pdfWidth: number,
  pdfHeight: number,
  reservedBelow = 0,
): PdfPlacement {
  const signatureWidth = Math.min(placement.signatureWidth, pdfWidth)
  const signatureHeight = Math.min(placement.signatureHeight, pdfHeight)

  /* A block taller than the page it sits on would give a negative ceiling and
     clamp the signature to a position off the top. Nothing fits in that case,
     so the top of the page is the honest answer. */
  const lowestTop = Math.max(0, pdfHeight - signatureHeight - reservedBelow)

  return {
    page: placement.page,
    signatureX: Math.max(0, Math.min(placement.signatureX, pdfWidth - signatureWidth)),
    signatureY: Math.max(0, Math.min(placement.signatureY, lowestTop)),
    signatureWidth,
    signatureHeight,
  }
}

/**
 * Move a placed signature by a distance in PDF points.
 *
 * The whole point of dragging: the size it was given is the size it keeps.
 * Re-placing by clicking elsewhere used to hand back a fresh default box, so
 * any nudge after a resize silently undid the resize.
 */
export function movePdfPlacement(
  placement: PdfPlacement,
  deltaPdfX: number,
  deltaPdfY: number,
  pdfWidth: number,
  pdfHeight: number,
  reservedBelow = 0,
): PdfPlacement {
  return clampToPage(
    {
      ...placement,
      signatureX: placement.signatureX + deltaPdfX,
      signatureY: placement.signatureY + deltaPdfY,
    },
    pdfWidth,
    pdfHeight,
    reservedBelow,
  )
}

export interface PdfPlacement {
  page: number
  signatureX: number
  signatureY: number
  signatureWidth: number
  signatureHeight: number
}

export interface ScreenPlacement {
  left: number
  top: number
  width: number
  height: number
}

/**
 * Map a click on the rendered page to PDF coordinates (top-left origin).
 *
 * `options.width`/`height` carry the size the signature already had, so
 * dropping it somewhere else keeps it. Without them a click handed back the
 * default box, and every nudge after a resize quietly undid the resize.
 *
 * `options.page` is the page being looked at. It used to be hardcoded to 1 and
 * corrected by the caller afterwards, which worked only for as long as every
 * caller remembered to.
 */
export function clickToPdfPlacement(
  clickX: number,
  clickY: number,
  displayWidth: number,
  displayHeight: number,
  pdfWidth: number,
  pdfHeight: number,
  options: {
    width?: number
    height?: number
    page?: number
    reservedBelow?: number
  } = {},
): PdfPlacement {
  const signatureWidth = options.width ?? SIGNATURE_WIDTH_PDF
  const signatureHeight = options.height ?? SIGNATURE_HEIGHT_PDF

  const centerX = (clickX / displayWidth) * pdfWidth
  const centerY = (clickY / displayHeight) * pdfHeight

  return clampToPage(
    {
      page: options.page ?? 1,
      signatureX: centerX - signatureWidth / 2,
      signatureY: centerY - signatureHeight / 2,
      signatureWidth,
      signatureHeight,
    },
    pdfWidth,
    pdfHeight,
    options.reservedBelow ?? 0,
  )
}

/** Convert PDF placement to screen overlay position for preview. */
export function pdfPlacementToScreen(
  placement: Pick<PdfPlacement, 'signatureX' | 'signatureY' | 'signatureWidth' | 'signatureHeight'>,
  displayWidth: number,
  displayHeight: number,
  pdfWidth: number,
  pdfHeight: number,
): ScreenPlacement {
  return {
    left: (placement.signatureX / pdfWidth) * displayWidth,
    top: (placement.signatureY / pdfHeight) * displayHeight,
    width: (placement.signatureWidth / pdfWidth) * displayWidth,
    height: (placement.signatureHeight / pdfHeight) * displayHeight,
  }
}

/** Map a CSS-pixel rectangle on the rendered page to PDF placement (top-left origin). */
export function screenRectToPdfPlacement(
  left: number,
  top: number,
  width: number,
  height: number,
  displayWidth: number,
  displayHeight: number,
  pdfWidth: number,
  pdfHeight: number,
  page: number,
  reservedBelow = 0,
): PdfPlacement {
  const topLeft = screenPointToPdf(left, top, displayWidth, displayHeight, pdfWidth, pdfHeight)
  const bottomRight = screenPointToPdf(
    left + width,
    top + height,
    displayWidth,
    displayHeight,
    pdfWidth,
    pdfHeight,
  )

  /* Through the same clamp as every other placement. This used to keep its
     own copy, which kept the box on the page but knew nothing about the block
     hanging below it - so a signature drawn along the bottom edge was filed
     with no room for its own name, and the backend lifted it clear of the
     margin afterwards. The person who drew it there was never told. */
  return clampToPage(
    {
      page,
      signatureX: topLeft.x,
      signatureY: topLeft.y,
      signatureWidth: Math.max(1, bottomRight.x - topLeft.x),
      signatureHeight: Math.max(1, bottomRight.y - topLeft.y),
    },
    pdfWidth,
    pdfHeight,
    reservedBelow,
  )
}

/** Map a screen point on the canvas to PDF coordinates (top-left origin). */
export function screenPointToPdf(
  screenX: number,
  screenY: number,
  displayWidth: number,
  displayHeight: number,
  pdfWidth: number,
  pdfHeight: number,
): { x: number; y: number } {
  return {
    x: (screenX / displayWidth) * pdfWidth,
    y: (screenY / displayHeight) * pdfHeight,
  }
}

/**
 * Resize a placed signature from a corner handle.
 * Keeps aspect ratio by default so uploaded signatures don't stretch.
 */
export function resizePdfPlacement(
  placement: PdfPlacement,
  handle: ResizeHandle,
  pointerPdfX: number,
  pointerPdfY: number,
  pdfWidth: number,
  pdfHeight: number,
  lockAspectRatio = true,
  /** Room to keep under the box for the name/designation block drawn there. */
  reservedBelow = 0,
): PdfPlacement {
  const aspect =
    placement.signatureHeight > 0
      ? placement.signatureWidth / placement.signatureHeight
      : SIGNATURE_WIDTH_PDF / SIGNATURE_HEIGHT_PDF

  const fixedRight = placement.signatureX + placement.signatureWidth
  const fixedBottom = placement.signatureY + placement.signatureHeight
  const fixedLeft = placement.signatureX
  const fixedTop = placement.signatureY

  let signatureX = placement.signatureX
  let signatureY = placement.signatureY
  // No initialiser: every branch below assigns both, so seeding them from the
  // incoming placement only looked like a fallback that could never apply.
  // (X and Y do keep theirs — the `se` handle leaves them untouched.)
  let signatureWidth: number
  let signatureHeight: number

  if (!lockAspectRatio) {
    if (handle === 'se') {
      signatureWidth = pointerPdfX - fixedLeft
      signatureHeight = pointerPdfY - fixedTop
    } else if (handle === 'sw') {
      signatureWidth = fixedRight - pointerPdfX
      signatureHeight = pointerPdfY - fixedTop
      signatureX = pointerPdfX
    } else if (handle === 'ne') {
      signatureWidth = pointerPdfX - fixedLeft
      signatureHeight = fixedBottom - pointerPdfY
      signatureY = pointerPdfY
    } else {
      signatureWidth = fixedRight - pointerPdfX
      signatureHeight = fixedBottom - pointerPdfY
      signatureX = pointerPdfX
      signatureY = pointerPdfY
    }
  } else {
    // Anchor opposite corner; size from the larger projected axis.
    let nextWidth: number
    let nextHeight: number

    if (handle === 'se') {
      nextWidth = pointerPdfX - fixedLeft
      nextHeight = pointerPdfY - fixedTop
    } else if (handle === 'sw') {
      nextWidth = fixedRight - pointerPdfX
      nextHeight = pointerPdfY - fixedTop
    } else if (handle === 'ne') {
      nextWidth = pointerPdfX - fixedLeft
      nextHeight = fixedBottom - pointerPdfY
    } else {
      nextWidth = fixedRight - pointerPdfX
      nextHeight = fixedBottom - pointerPdfY
    }

    nextWidth = Math.max(nextWidth, MIN_SIGNATURE_WIDTH_PDF)
    nextHeight = Math.max(nextHeight, MIN_SIGNATURE_HEIGHT_PDF)

    if (nextWidth / aspect >= nextHeight) {
      signatureWidth = nextWidth
      signatureHeight = signatureWidth / aspect
    } else {
      signatureHeight = nextHeight
      signatureWidth = signatureHeight * aspect
    }

    if (handle === 'se') {
      signatureX = fixedLeft
      signatureY = fixedTop
    } else if (handle === 'sw') {
      signatureX = fixedRight - signatureWidth
      signatureY = fixedTop
    } else if (handle === 'ne') {
      signatureX = fixedLeft
      signatureY = fixedBottom - signatureHeight
    } else {
      signatureX = fixedRight - signatureWidth
      signatureY = fixedBottom - signatureHeight
    }
  }

  signatureWidth = Math.max(
    MIN_SIGNATURE_WIDTH_PDF,
    Math.min(signatureWidth, MAX_SIGNATURE_WIDTH_PDF, pdfWidth),
  )
  signatureHeight = Math.max(
    MIN_SIGNATURE_HEIGHT_PDF,
    Math.min(signatureHeight, MAX_SIGNATURE_HEIGHT_PDF, pdfHeight),
  )

  if (lockAspectRatio) {
    const heightForWidth = signatureWidth / aspect
    const widthForHeight = signatureHeight * aspect
    if (heightForWidth <= MAX_SIGNATURE_HEIGHT_PDF && heightForWidth <= pdfHeight) {
      signatureHeight = heightForWidth
    } else {
      signatureWidth = widthForHeight
    }

    if (handle === 'sw' || handle === 'nw') {
      signatureX = fixedRight - signatureWidth
    }
    if (handle === 'ne' || handle === 'nw') {
      signatureY = fixedBottom - signatureHeight
    }
    if (handle === 'se' || handle === 'ne') {
      signatureX = fixedLeft
    }
    if (handle === 'se' || handle === 'sw') {
      signatureY = fixedTop
    }
  }

  return clampToPage(
    {
      page: placement.page,
      signatureX,
      signatureY,
      signatureWidth,
      signatureHeight,
    },
    pdfWidth,
    pdfHeight,
    reservedBelow,
  )
}

/**
 * Air kept under a signature that sits on a printed line.
 *
 * MIRRORS `SLOT_DATE_LANE` in `backend/src/lib/memoSignatureSlots.ts`. A memo
 * typed in the portal prints a ruled line per signatory, and the signature
 * sits on it. This was sixteen points when the date was written between the
 * mark and the line; no date is drawn there now, so the mark comes down to
 * the line.
 *
 * The server snaps a slotted signature to exactly this box, so getting it
 * wrong here would not misplace anything - it would do something worse, and
 * show the preparer a box that is not the one they are going to get.
 */
export const SLOT_DATE_LANE = 2

/**
 * A printed signature line as a placement the signing editor can show.
 *
 * Centred on the line and sized to it, because that is what the server will
 * do with it. Nobody should have to aim at a line the document already knows
 * the position of.
 */
export function slotToPlacement(slot: {
  page: number
  x: number
  y: number
  width: number
  height: number
}): PdfPlacement {
  return {
    page: slot.page,
    signatureX: slot.x,
    signatureY: slot.y,
    signatureWidth: slot.width,
    signatureHeight: Math.max(1, slot.height - SLOT_DATE_LANE),
  }
}
