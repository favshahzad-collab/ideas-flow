import { describe, expect, it } from 'vitest'
import {
  SIGNATURE_HEIGHT_PDF,
  SIGNATURE_WIDTH_PDF,
  clampToPage,
  clickToPdfPlacement,
  movePdfPlacement,
  pdfPlacementToScreen,
  resizePdfPlacement,
  screenRectToPdfPlacement,
  signoffBlockHeight,
  type PdfPlacement,
} from './pdfCoordinates'

/**
 * Placing a signature: moving it, keeping it on the page, and keeping it where
 * it was put whatever the viewer is doing.
 *
 * The companion of `pdfCoordinates.test.ts`, which covers the conversions
 * themselves. These are about the placement surviving - a drag that keeps the
 * size, a page that keeps its own placement, and a coordinate that means the
 * same thing at every zoom, because the coordinate is in PDF points and the
 * zoom is only how large the page happens to be drawn.
 */

/** A4 at 72dpi. */
const PDF_W = 595
const PDF_H = 842
const DISP_W = 892.5
const DISP_H = 1263

const placed = (over: Partial<PdfPlacement> = {}): PdfPlacement => ({
  page: 1,
  signatureX: 200,
  signatureY: 400,
  signatureWidth: SIGNATURE_WIDTH_PDF,
  signatureHeight: SIGNATURE_HEIGHT_PDF,
  ...over,
})

describe('moving a placed signature', () => {
  it('moves by the distance it was given, in PDF points', () => {
    const moved = movePdfPlacement(placed(), 30, -25, PDF_W, PDF_H)

    expect(moved.signatureX).toBe(230)
    expect(moved.signatureY).toBe(375)
  })

  it('keeps the size it was given, which is the whole point of dragging', () => {
    /*
     * Re-placing used to hand back a fresh default box, so any nudge after a
     * resize silently undid the resize. Moving is moving.
     */
    const moved = movePdfPlacement(
      placed({ signatureWidth: 260, signatureHeight: 90 }),
      10,
      10,
      PDF_W,
      PDF_H,
    )

    expect(moved.signatureWidth).toBe(260)
    expect(moved.signatureHeight).toBe(90)
  })

  it('stops at each page edge rather than going past it', () => {
    expect(movePdfPlacement(placed(), -9999, 0, PDF_W, PDF_H).signatureX).toBe(0)
    expect(movePdfPlacement(placed(), 9999, 0, PDF_W, PDF_H).signatureX).toBe(
      PDF_W - SIGNATURE_WIDTH_PDF,
    )
    expect(movePdfPlacement(placed(), 0, -9999, PDF_W, PDF_H).signatureY).toBe(0)
    expect(movePdfPlacement(placed(), 0, 9999, PDF_W, PDF_H).signatureY).toBe(
      PDF_H - SIGNATURE_HEIGHT_PDF,
    )
  })

  it('never produces a negative coordinate', () => {
    const moved = movePdfPlacement(
      placed({ signatureX: 1, signatureY: 1 }),
      -50,
      -50,
      PDF_W,
      PDF_H,
    )

    expect(moved.signatureX).toBeGreaterThanOrEqual(0)
    expect(moved.signatureY).toBeGreaterThanOrEqual(0)
  })

  it('stays on the page it belongs to', () => {
    expect(movePdfPlacement(placed({ page: 4 }), 5, 5, PDF_W, PDF_H).page).toBe(4)
  })

  it('keeps room under it for the name block, which is drawn downwards', () => {
    /*
     * The backend reserves this by moving the signature UP. Reserving it here
     * too is the difference between the box somebody dragged and the box that
     * comes back in the PDF - without it a signature dropped at the foot of a
     * page is relocated after they have stopped looking at it.
     */
    const reserved = 42

    const moved = movePdfPlacement(placed(), 0, 9999, PDF_W, PDF_H, reserved)

    expect(moved.signatureY).toBe(PDF_H - SIGNATURE_HEIGHT_PDF - reserved)
  })
})

describe('keeping a box on the page', () => {
  it('pins it to the top when the block under it is taller than the page', () => {
    // Nothing fits. The top is the honest answer; a negative ceiling would
    // clamp it off the top edge instead.
    expect(clampToPage(placed(), PDF_W, PDF_H, PDF_H * 2).signatureY).toBe(0)
  })

  it('shrinks a box wider than the page rather than letting it hang off', () => {
    const clamped = clampToPage(placed({ signatureWidth: PDF_W + 200 }), PDF_W, PDF_H)

    expect(clamped.signatureWidth).toBe(PDF_W)
    expect(clamped.signatureX).toBe(0)
  })

  it('leaves a box that already fits exactly where it is', () => {
    const untouched = clampToPage(placed(), PDF_W, PDF_H)

    expect(untouched).toEqual(placed())
  })
})

describe('dropping a signature somewhere else', () => {
  it('carries an existing size across instead of resetting it', () => {
    const dropped = clickToPdfPlacement(400, 600, DISP_W, DISP_H, PDF_W, PDF_H, {
      width: 260,
      height: 90,
    })

    expect(dropped.signatureWidth).toBe(260)
    expect(dropped.signatureHeight).toBe(90)
  })

  it('belongs to the page it was dropped on, not page 1', () => {
    /*
     * It used to answer 1 and rely on the caller to correct it, which held
     * only for as long as every caller remembered - and a placement filed
     * against the wrong page is stamped onto a page nobody was looking at.
     */
    expect(
      clickToPdfPlacement(400, 600, DISP_W, DISP_H, PDF_W, PDF_H, { page: 3 }).page,
    ).toBe(3)
  })

  it('reserves room for the name block when dropped at the foot of the page', () => {
    const dropped = clickToPdfPlacement(400, DISP_H, DISP_W, DISP_H, PDF_W, PDF_H, {
      reservedBelow: 42,
    })

    expect(dropped.signatureY + dropped.signatureHeight + 42).toBeLessThanOrEqual(PDF_H)
  })
})

describe('resizing against the page', () => {
  it('keeps room for the name block when a corner is dragged downwards', () => {
    const reserved = 42

    const resized = resizePdfPlacement(
      placed(),
      'se',
      500,
      PDF_H + 500,
      PDF_W,
      PDF_H,
      true,
      reserved,
    )

    expect(resized.signatureY + resized.signatureHeight + reserved).toBeLessThanOrEqual(
      PDF_H,
    )
  })

  it('never returns a zero or negative size', () => {
    const collapsed = resizePdfPlacement(placed(), 'se', -9999, -9999, PDF_W, PDF_H)

    expect(collapsed.signatureWidth).toBeGreaterThan(0)
    expect(collapsed.signatureHeight).toBeGreaterThan(0)
  })
})

describe('zoom independence', () => {
  it('maps the same spot on the page to the same PDF coordinate at every zoom', () => {
    /*
     * THE acceptance criterion. The placement is held in PDF points and zoom
     * only changes how large the page is drawn, so one physical spot has to
     * come back as one coordinate however far in the viewer is zoomed.
     * Storing screen pixels is exactly what this forbids.
     */
    const results = [0.5, 0.75, 1, 1.25, 1.5, 2].map(zoom => {
      const displayWidth = PDF_W * zoom
      const displayHeight = PDF_H * zoom

      // The same place on the page - three quarters across, two thirds down -
      // expressed in that zoom's own pixels.
      return clickToPdfPlacement(
        displayWidth * 0.75,
        displayHeight * (2 / 3),
        displayWidth,
        displayHeight,
        PDF_W,
        PDF_H,
      )
    })

    for (const result of results) {
      expect(result.signatureX).toBeCloseTo(results[0].signatureX, 6)
      expect(result.signatureY).toBeCloseTo(results[0].signatureY, 6)
    }
  })

  it('round-trips a placement through the screen and back at any zoom', () => {
    const placement = placed()

    for (const zoom of [0.5, 1, 2]) {
      const displayWidth = PDF_W * zoom
      const displayHeight = PDF_H * zoom

      const screen = pdfPlacementToScreen(placement, displayWidth, displayHeight, PDF_W, PDF_H)
      const back = screenRectToPdfPlacement(
        screen.left,
        screen.top,
        screen.width,
        screen.height,
        displayWidth,
        displayHeight,
        PDF_W,
        PDF_H,
        1,
      )

      expect(back.signatureX).toBeCloseTo(placement.signatureX, 6)
      expect(back.signatureY).toBeCloseTo(placement.signatureY, 6)
      expect(back.signatureWidth).toBeCloseTo(placement.signatureWidth, 6)
      expect(back.signatureHeight).toBeCloseTo(placement.signatureHeight, 6)
    }
  })

  it('maps a landscape page as faithfully as a portrait one', () => {
    // Nothing here assumes which side is longer, and a landscape memo is
    // ordinary enough that an assumption would be found by a user rather than
    // by a test.
    const landscapeW = 842
    const landscapeH = 595

    const dropped = clickToPdfPlacement(
      landscapeW * 2 * 0.9,
      landscapeH * 2 * 0.5,
      landscapeW * 2,
      landscapeH * 2,
      landscapeW,
      landscapeH,
    )

    expect(dropped.signatureX + dropped.signatureWidth).toBeLessThanOrEqual(landscapeW)
    expect(dropped.signatureY + dropped.signatureHeight).toBeLessThanOrEqual(landscapeH)
  })
})

describe('the name block height', () => {
  /*
   * PINNED TO THE BACKEND. `backend/src/lib/pdfSignature.ts` is what actually
   * draws this block, and has a test asserting these same numbers for these
   * same inputs. They are two implementations of one layout; the pair of tests
   * is what stops one drifting from the other and quietly relocating every
   * signature placed from then on.
   */
  it('is nothing at all when there is no name to draw', () => {
    expect(signoffBlockHeight(null)).toBe(0)
    expect(signoffBlockHeight({ name: '   ' })).toBe(0)
  })

  it('counts a name on its own', () => {
    // RULE_OFFSET 5 + RULE_THICKNESS 0.75 + (LINE_GAP 3.5 + NAME 9) + TAIL 2
    expect(signoffBlockHeight({ name: 'Kazim Zaidi' })).toBeCloseTo(20.25, 6)
  })

  it('counts designation and department as the one line they share', () => {
    expect(
      signoffBlockHeight({ name: 'Kazim Zaidi', designation: 'Deputy Manager' }),
    ).toBeCloseTo(31.25, 6)
    expect(signoffBlockHeight({ name: 'Kazim Zaidi', department: 'Finance' })).toBeCloseTo(
      31.25,
      6,
    )
    expect(
      signoffBlockHeight({
        name: 'Kazim Zaidi',
        designation: 'Deputy Manager',
        department: 'Finance',
      }),
    ).toBeCloseTo(31.25, 6)
  })

  it('counts the capacity line, and nothing for a date, which is never drawn', () => {
    expect(signoffBlockHeight({ name: 'Kazim Zaidi', capacity: 'Approver' })).toBeCloseTo(
      31.25,
      6,
    )
    // A date alone draws no line under the mark - the ledger keeps it.
    expect(signoffBlockHeight({ name: 'Kazim Zaidi', signedAt: new Date(0) })).toBeCloseTo(
      20.25,
      6,
    )
    expect(
      signoffBlockHeight({ name: 'Kazim Zaidi', capacity: 'Approver', signedAt: new Date(0) }),
    ).toBeCloseTo(31.25, 6)
  })

  it('counts the whole block an approver with a designation actually gets', () => {
    expect(
      signoffBlockHeight({
        name: 'Kazim Zaidi',
        designation: 'Deputy Manager',
        department: 'Finance',
        capacity: 'Approver',
        signedAt: new Date(0),
      }),
    ).toBeCloseTo(42.25, 6)
  })

  it('counts the delegation line only when there is one', () => {
    expect(signoffBlockHeight({ name: 'Kazim Zaidi', onBehalfOf: 'Aamir Raza' })).toBeCloseTo(
      31.25,
      6,
    )
  })

  it('reserves nothing where the page already names the signer, bar a delegate line', () => {
    // A printed line, or any attached PDF: the backend draws no name, post or
    // capacity there. Pinned to backend/src/lib/pdfSignature.test.ts.
    expect(
      signoffBlockHeight({
        name: 'Kazim Zaidi',
        designation: 'Deputy Manager',
        capacity: 'Approver',
        onOwnLine: true,
      }),
    ).toBe(0)
    expect(
      signoffBlockHeight({ name: 'Kazim Zaidi', onBehalfOf: 'Aamir Raza', onOwnLine: true }),
    ).toBeCloseTo(14, 6)
  })
})

/**
 * Ink drawn straight onto the page.
 *
 * Every other way of placing a signature goes through `clampToPage`, which is
 * what keeps room below it for the block naming the signer. This one kept its
 * own copy of the clamp - correct about the page edges, and ignorant of the
 * block - so a signature drawn along the bottom edge was filed with nowhere
 * for its own name to go and the backend lifted it clear afterwards. The
 * person who drew it there was never told it had moved.
 *
 * Drawing is the path anybody without a saved signature image takes.
 */
describe('a rect drawn on the page', () => {
  /** What the signing screens pass: name, title, department, date line. */
  const block = {
    name: 'Maria Chen',
    designation: 'Manager',
    department: 'Finance',
    capacity: 'Preparer',
  }

  const drawnAtTheFoot = (reservedBelow?: number) =>
    screenRectToPdfPlacement(
      DISP_W * 0.1,
      DISP_H - 60,
      200,
      60,
      DISP_W,
      DISP_H,
      PDF_W,
      PDF_H,
      1,
      reservedBelow,
    )

  it('keeps room below for the block it will be given', () => {
    const reserved = signoffBlockHeight(block)
    const drawn = drawnAtTheFoot(reserved)

    expect(reserved).toBeGreaterThan(0)
    expect(
      PDF_H - drawn.signatureY - drawn.signatureHeight,
      'the block has to fit between the signature and the bottom edge',
    ).toBeGreaterThanOrEqual(reserved)
  })

  it('lifts it by exactly the block, and no further', () => {
    const reserved = signoffBlockHeight(block)
    const drawn = drawnAtTheFoot(reserved)

    // As close to where it was drawn as the block allows. Lifting further
    // would be the same defect with the sign flipped.
    expect(drawn.signatureY).toBeCloseTo(
      drawnAtTheFoot(0).signatureY - reserved,
      6,
    )
  })

  it('reserves nothing when there is no block to draw', () => {
    // An approver signing a document whose signer cannot be named gets the
    // page edge and nothing more, which is what it always did.
    const drawn = drawnAtTheFoot(0)

    expect(drawn.signatureY + drawn.signatureHeight).toBeCloseTo(PDF_H, 6)
  })

  it('leaves a rect with room to spare exactly where it was drawn', () => {
    const reserved = signoffBlockHeight(block)
    const middle = screenRectToPdfPlacement(
      DISP_W * 0.2,
      DISP_H * 0.3,
      200,
      60,
      DISP_W,
      DISP_H,
      PDF_W,
      PDF_H,
      1,
      reserved,
    )

    expect(middle.signatureY).toBeCloseTo(PDF_H * 0.3, 6)
  })

  it('answers the same as every other way of placing the same box', () => {
    /*
     * The point of sharing the clamp rather than keeping a second copy: a
     * near-miss between two copies is a signature that lands somewhere
     * nobody chose, and nothing would fail.
     */
    const reserved = signoffBlockHeight(block)
    const drawn = drawnAtTheFoot(reserved)

    expect(drawn).toEqual(
      clampToPage(drawnAtTheFoot(0), PDF_W, PDF_H, reserved),
    )
  })

  it('keeps a drawing taller than the page on the page', () => {
    const huge = screenRectToPdfPlacement(
      0,
      0,
      DISP_W * 3,
      DISP_H * 3,
      DISP_W,
      DISP_H,
      PDF_W,
      PDF_H,
      1,
      signoffBlockHeight(block),
    )

    expect(huge.signatureX).toBe(0)
    expect(huge.signatureY).toBe(0)
    expect(huge.signatureWidth).toBeLessThanOrEqual(PDF_W)
    expect(huge.signatureHeight).toBeLessThanOrEqual(PDF_H)
  })
})
