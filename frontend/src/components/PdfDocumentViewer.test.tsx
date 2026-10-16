import { render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import PdfDocumentViewer from './PdfDocumentViewer'
import {
  SIGNATURE_HEIGHT_PDF,
  SIGNATURE_WIDTH_PDF,
  signoffBlockHeight,
  type PdfPlacement,
} from '../utils/pdfCoordinates'
import { cropInkFromCanvas } from '../utils/inkCrop'

/* Stubbed so a stroke can be "drawn" without a real canvas to read pixels
   back from. The cropper has its own tests over a real one; what matters here
   is what the viewer does with the rect it hands back. */
vi.mock('../utils/inkCrop', () => ({ cropInkFromCanvas: vi.fn(() => null) }))

/**
 * Placing a signature on the page.
 *
 * This component had no tests, which is how it shipped with no way to move a
 * signature at all: the overlay swallowed its pointer events and did nothing
 * with them, so the only way to reposition a mark was to click elsewhere on
 * the page - which re-placed it at the default size, and could not reach any
 * spot underneath the box, because those were the clicks being swallowed. Both
 * modals that use it mock it out, so nothing exercised it.
 *
 * Everything below is about the placement the backend will actually receive,
 * in PDF points, and never about pixels on a screen.
 */

const PDF_W = 595
const PDF_H = 842
/** The panel width the container reports, so the page renders 1:1 at 100%. */
const PANEL = PDF_W

vi.mock('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url', () => ({ default: 'worker-stub' }))

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => {
  const page = {
    getViewport: ({ scale }: { scale: number }) => ({
      width: PDF_W * scale,
      height: PDF_H * scale,
    }),
    render: () => ({ promise: Promise.resolve(), cancel: vi.fn() }),
  }

  return {
    GlobalWorkerOptions: { workerSrc: '' },
    getDocument: () => ({
      promise: Promise.resolve({ numPages: 3, getPage: () => Promise.resolve(page) }),
    }),
  }
})

/** The rendered page, as the browser would measure it at the given zoom. */
function stubCanvasGeometry(zoom = 1) {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
  } as unknown as CanvasRenderingContext2D)

  // The page is drawn at the panel width times the zoom, with its top-left at
  // the viewport origin — so a client coordinate IS an offset into the page,
  // which keeps the arithmetic in these tests readable.
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({
    left: 0,
    top: 0,
    width: PANEL * zoom,
    height: PDF_H * zoom,
    right: PANEL * zoom,
    bottom: PDF_H * zoom,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  })

  vi.spyOn(HTMLDivElement.prototype, 'clientWidth', 'get').mockReturnValue(PANEL)
}

const file = () => new Blob(['%PDF-1.4'], { type: 'application/pdf' })

/**
 * Render the viewer as a controlled placement editor, the way the signing
 * modals do, and hand back a way to read the latest placement.
 */
function renderEditor(
  options: {
    initial?: PdfPlacement | null
    signoffPreview?: { name: string; designation?: string | null } | null
    onRemovePlacement?: () => void
    /** Freehand mode, the one anybody without a saved signature image gets. */
    drawOnPdf?: boolean
  } = {},
) {
  const onPlacement = vi.fn()
  let latest: PdfPlacement | null = options.initial ?? null

  /* One blob for the life of the harness. Built inside the component it would
     be a new object every render, and the viewer reloads the document whenever
     `file` changes identity - which unmounts the page, and with it the overlay
     and whatever had focus. */
  const pdfFile = file()

  function Harness() {
    const [placement, setPlacement] = useState<PdfPlacement | null>(options.initial ?? null)
    const [inkReset, setInkReset] = useState(0)

    return (
      <>
      {/* Wiping the ink is the modals' Clear button, which bumps this. */}
      <button type="button" onClick={() => setInkReset(key => key + 1)}>
        Wipe the ink
      </button>
      <PdfDocumentViewer
        file={pdfFile}
        placementMode
        drawOnPdf={options.drawOnPdf}
        inkResetKey={inkReset}
        placement={placement}
        signaturePreviewUrl="data:image/png;base64,iVBORw0KGgo="
        signoffPreview={options.signoffPreview ?? null}
        onRemovePlacement={options.onRemovePlacement}
        onPlacement={next => {
          latest = next
          onPlacement(next)
          setPlacement(next)
        }}
      />
      </>
    )
  }

  const view = render(<Harness />)
  return { ...view, onPlacement, read: () => latest }
}

/**
 * The placed signature, which is the thing being dragged.
 *
 * Awaited rather than fetched: the page control appears as soon as the
 * document loads, but the overlay cannot be positioned until the first page
 * has actually rendered and been measured.
 */
const findBox = () => screen.findByRole('group', { name: /Signature on page/ })

const placedMidPage: PdfPlacement = {
  page: 1,
  signatureX: 200,
  signatureY: 400,
  signatureWidth: SIGNATURE_WIDTH_PDF,
  signatureHeight: SIGNATURE_HEIGHT_PDF,
}

beforeEach(() => {
  stubCanvasGeometry()
  vi.mocked(cropInkFromCanvas).mockReturnValue(null)
  // jsdom has no pointer capture, and the ink surface claims it on every stroke.
  HTMLCanvasElement.prototype.setPointerCapture = vi.fn()
  HTMLCanvasElement.prototype.releasePointerCapture = vi.fn()
})

describe('placing a signature', () => {
  it('places it where the page was clicked, on the page being looked at', async () => {
    const user = userEvent.setup()
    const editor = renderEditor()

    await screen.findByText(/Page 1 of 3/)
    await user.click(document.querySelector('canvas') as HTMLCanvasElement)

    await waitFor(() => expect(editor.read()).not.toBeNull())
    expect(editor.read()?.page).toBe(1)
  })

  it('offers the page controls a multi-page document needs', async () => {
    renderEditor()

    expect(await screen.findByText(/Page 1 of 3/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Next/ })).toBeEnabled()
    expect(screen.getByRole('button', { name: /Previous/ })).toBeDisabled()
  })

  it('carries the placement to the page it was made on', async () => {
    const user = userEvent.setup()
    renderEditor({ initial: placedMidPage })

    await screen.findByText(/Page 1 of 3/)
    expect(await findBox()).toBeInTheDocument()

    // Page 2 has no placement of its own, so nothing is drawn over it. A
    // signature that followed the reader from page to page would be stamped
    // onto whichever page happened to be open at the end.
    await user.click(screen.getByRole('button', { name: /Next/ }))

    await waitFor(() =>
      expect(screen.queryByRole('group', { name: /Signature on page/ })).not.toBeInTheDocument(),
    )
  })

  it('previews the signature fitted inside the box, never stretched to fill it', async () => {
    /*
     * This is half of a rule, and the other half is `embedSignatureInPdf` on
     * the backend, which fits the image into the placement the same way and
     * centres what is left over.
     *
     * It used to be half of a DISagreement: the preview contained the image
     * and `page.drawImage` was handed the box's own width and height, which
     * fills it. So a signature that was not the shape of the box - which is
     * every uploaded one, because the box a click makes is always 150 x 50 -
     * previewed at its own proportions and was filed stretched. Nowhere in
     * the product showed that until the memo was signed.
     *
     * Asserting the class is asserting the contract: `object-cover` or
     * `object-fill` here, and the two halves drift apart again in silence.
     */
    renderEditor({ initial: placedMidPage })

    expect(await screen.findByAltText('Signature preview')).toHaveClass('object-contain')
  })
})

describe('moving it', () => {
  it('drags with the pointer, in PDF points', async () => {
    /*
     * The defect this component shipped with. The overlay called
     * `stopPropagation` on pointerdown and implemented nothing, so a signature
     * could not be moved at all - only re-placed by clicking somewhere the box
     * was not.
     */
    const editor = renderEditor({ initial: placedMidPage })
    await screen.findByText(/Page 1 of 3/)

    const target = await findBox()
    target.dispatchEvent(
      new PointerEvent('pointerdown', {
        pointerId: 1,
        clientX: 250,
        clientY: 420,
        bubbles: true,
        cancelable: true,
      }),
    )
    window.dispatchEvent(
      new PointerEvent('pointermove', {
        pointerId: 1,
        clientX: 300,
        clientY: 460,
        bubbles: true,
        cancelable: true,
      }),
    )
    window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, bubbles: true }))

    await waitFor(() => expect(editor.read()?.signatureX).toBeCloseTo(250, 3))
    expect(editor.read()?.signatureY).toBeCloseTo(440, 3)
  })

  it('keeps the size while dragging, so a resize is not undone by a nudge', async () => {
    const editor = renderEditor({
      initial: { ...placedMidPage, signatureWidth: 260, signatureHeight: 90 },
    })
    await screen.findByText(/Page 1 of 3/)

    const target = await findBox()
    target.dispatchEvent(
      new PointerEvent('pointerdown', { pointerId: 1, clientX: 250, clientY: 420, bubbles: true }),
    )
    window.dispatchEvent(
      new PointerEvent('pointermove', { pointerId: 1, clientX: 400, clientY: 500, bubbles: true }),
    )
    window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, bubbles: true }))

    await waitFor(() => expect(editor.read()?.signatureX).not.toBe(200))
    expect(editor.read()?.signatureWidth).toBe(260)
    expect(editor.read()?.signatureHeight).toBe(90)
  })

  it('does not let the drag carry it off the page', async () => {
    const editor = renderEditor({ initial: placedMidPage })
    await screen.findByText(/Page 1 of 3/)

    const target = await findBox()
    target.dispatchEvent(
      new PointerEvent('pointerdown', { pointerId: 1, clientX: 250, clientY: 420, bubbles: true }),
    )
    window.dispatchEvent(
      new PointerEvent('pointermove', {
        pointerId: 1,
        clientX: 99999,
        clientY: 99999,
        bubbles: true,
      }),
    )
    window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, bubbles: true }))

    await waitFor(() => expect(editor.read()?.signatureX).toBe(PDF_W - SIGNATURE_WIDTH_PDF))
    expect(editor.read()?.signatureY).toBe(PDF_H - SIGNATURE_HEIGHT_PDF)
  })

  it('moves with the arrow keys, which the handles never allowed', async () => {
    // The resize handles were buttons listening only for a pointer, so a
    // keyboard user could reach them and then do nothing at all.
    const user = userEvent.setup()
    const editor = renderEditor({ initial: placedMidPage })
    await screen.findByText(/Page 1 of 3/)

    const target = await findBox()
    target.focus()
    await user.keyboard('{ArrowRight}{ArrowDown}')

    await waitFor(() => expect(editor.read()?.signatureX).toBe(201))
    expect(editor.read()?.signatureY).toBe(401)
  })

  it('moves further with shift held', async () => {
    const user = userEvent.setup()
    const editor = renderEditor({ initial: placedMidPage })
    await screen.findByText(/Page 1 of 3/)

    const target = await findBox()
    target.focus()
    await user.keyboard('{Shift>}{ArrowRight}{/Shift}')

    await waitFor(() => expect(editor.read()?.signatureX).toBe(210))
  })
})

describe('resizing it', () => {
  it('grows and shrinks from the keyboard without distorting the signature', async () => {
    const user = userEvent.setup()
    const editor = renderEditor({ initial: placedMidPage })
    await screen.findByText(/Page 1 of 3/)
    const aspect = SIGNATURE_WIDTH_PDF / SIGNATURE_HEIGHT_PDF

    const target = await findBox()
    target.focus()
    await user.keyboard('+')

    await waitFor(() =>
      expect(editor.read()!.signatureWidth).toBeGreaterThan(SIGNATURE_WIDTH_PDF),
    )
    const grown = editor.read()!
    expect(grown.signatureWidth / grown.signatureHeight).toBeCloseTo(aspect, 6)

    await user.keyboard('-')
    await waitFor(() =>
      expect(editor.read()!.signatureWidth).toBeLessThan(grown.signatureWidth),
    )
    const shrunk = editor.read()!
    expect(shrunk.signatureWidth / shrunk.signatureHeight).toBeCloseTo(aspect, 6)
  })

  it('offers a handle at each corner', async () => {
    renderEditor({ initial: placedMidPage })
    await findBox()

    for (const corner of ['nw', 'ne', 'sw', 'se']) {
      expect(screen.getByRole('button', { name: `Resize signature ${corner}` })).toBeInTheDocument()
    }
  })

  it('can still be moved after being resized', async () => {
    const user = userEvent.setup()
    const editor = renderEditor({ initial: placedMidPage })
    await screen.findByText(/Page 1 of 3/)

    const target = await findBox()
    target.focus()
    await user.keyboard('+')
    await waitFor(() =>
      expect(editor.read()!.signatureWidth).toBeGreaterThan(SIGNATURE_WIDTH_PDF),
    )
    const width = editor.read()!.signatureWidth

    await user.keyboard('{ArrowRight}')

    await waitFor(() => expect(editor.read()!.signatureX).toBe(201))
    expect(editor.read()!.signatureWidth).toBe(width)
  })
})

describe('the name and designation under it', () => {
  it('shows the block, so the signer can see it is part of what they are placing', async () => {
    renderEditor({
      initial: placedMidPage,
      signoffPreview: { name: 'Kazim Zaidi', designation: 'Deputy Manager' },
    })
    await findBox()

    expect(screen.getByText('Kazim Zaidi')).toBeInTheDocument()
    expect(screen.getByText('Deputy Manager')).toBeInTheDocument()
  })

  it('keeps room for it, so the backend does not have to move the signature up', async () => {
    /*
     * The block is drawn downwards from the foot of the mark, and the backend
     * reserves its height by moving the signature UP. Reserving it here is
     * what makes the placed box and the stamped box the same box.
     */
    const editor = renderEditor({
      initial: placedMidPage,
      signoffPreview: { name: 'Kazim Zaidi', designation: 'Deputy Manager' },
    })
    await screen.findByText(/Page 1 of 3/)

    const target = await findBox()
    target.focus()
    // Far past the bottom edge.
    for (let i = 0; i < 60; i += 1) {
      await userEvent.keyboard('{Shift>}{ArrowDown}{/Shift}')
    }

    await waitFor(() => {
      const placement = editor.read()!
      // 31.25pt for a name plus a designation line.
      expect(placement.signatureY + placement.signatureHeight + 31.25).toBeLessThanOrEqual(
        PDF_H + 0.001,
      )
    })
  })
})

describe('the controls around it', () => {
  it('offers the zoom stops the placement has to survive', async () => {
    renderEditor({ initial: placedMidPage })
    await screen.findByText(/Page 1 of 3/)

    const zoom = screen.getByLabelText('Zoom')
    for (const percent of ['50%', '75%', '100%', '125%', '150%', '200%']) {
      expect(screen.getByRole('option', { name: percent })).toBeInTheDocument()
    }
    expect(zoom).toHaveValue('1')
  })

  it('leaves the placement untouched when the zoom changes', async () => {
    /*
     * The coordinates are PDF points, so zooming redraws the page at a new
     * scale and the signature is painted over the same place on it. Nothing
     * about the stored placement may move.
     */
    const user = userEvent.setup()
    const editor = renderEditor({ initial: placedMidPage })
    await screen.findByText(/Page 1 of 3/)

    await user.selectOptions(screen.getByLabelText('Zoom'), '2')
    await waitFor(() => expect(screen.getByLabelText('Zoom')).toHaveValue('2'))

    expect(editor.read()).toEqual(placedMidPage)
  })

  it('offers a way to take the signature off again', async () => {
    const user = userEvent.setup()
    const onRemovePlacement = vi.fn()
    renderEditor({ initial: placedMidPage, onRemovePlacement })
    await screen.findByText(/Page 1 of 3/)

    await user.click(screen.getByRole('button', { name: 'Remove signature' }))

    expect(onRemovePlacement).toHaveBeenCalledTimes(1)
  })

  it('does not offer to remove one that was never placed', async () => {
    renderEditor({ onRemovePlacement: vi.fn() })
    await screen.findByText(/Page 1 of 3/)

    expect(screen.queryByRole('button', { name: 'Remove signature' })).not.toBeInTheDocument()
  })
})

/**
 * Freehand drawing, and what happens to it afterwards.
 *
 * Drag, resize and the arrow keys were built for a saved signature image and
 * gated off entirely when the page was a drawing surface. Anybody who has not
 * uploaded a signature draws - which in practice is most people - and what
 * they drew landed where it landed. A centimetre out meant rubbing it out and
 * drawing it again with a steadier hand.
 *
 * Drawing and dragging cannot share a surface, so the pen stays live until
 * the drawing is adopted. These are about that handover.
 */
const ADOPT = 'Done — adjust placement'
const inkOnThePage = { ...placedMidPage }

describe('a signature drawn on the page', () => {
  it('keeps the page for the pen until the drawing is adopted', async () => {
    // No box and no handles yet: a stroke inside the box would be
    // indistinguishable from a grab, so the surface belongs to one of them.
    renderEditor({ drawOnPdf: true, initial: inkOnThePage })
    await screen.findByText(/Page 1 of 3/)

    expect(screen.queryByRole('group', { name: /Signature on page/ })).not.toBeInTheDocument()
    expect(screen.queryAllByRole('button', { name: /^Resize signature/ })).toHaveLength(0)
    expect(screen.getByRole('button', { name: ADOPT })).toBeInTheDocument()
  })

  it('offers nothing to adopt before anything is drawn', async () => {
    renderEditor({ drawOnPdf: true })
    await screen.findByText(/Page 1 of 3/)

    expect(screen.queryByRole('button', { name: ADOPT })).not.toBeInTheDocument()
  })

  it('hands it to the placement controls once adopted', async () => {
    const user = userEvent.setup()
    renderEditor({ drawOnPdf: true, initial: inkOnThePage })
    await screen.findByText(/Page 1 of 3/)

    await user.click(screen.getByRole('button', { name: ADOPT }))

    expect(await findBox()).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /^Resize signature/ })).toHaveLength(4)
    expect(screen.queryByRole('button', { name: ADOPT })).not.toBeInTheDocument()
  })

  it('adopts it exactly where it was drawn', async () => {
    // Adopting is a handover, not a move. A drawing that jumped the moment it
    // was adopted would be worse than one that could not be moved at all.
    const user = userEvent.setup()
    const editor = renderEditor({ drawOnPdf: true, initial: inkOnThePage })
    await screen.findByText(/Page 1 of 3/)

    await user.click(screen.getByRole('button', { name: ADOPT }))
    await findBox()

    expect(editor.read()).toMatchObject({
      signatureX: inkOnThePage.signatureX,
      signatureY: inkOnThePage.signatureY,
      signatureWidth: inkOnThePage.signatureWidth,
      signatureHeight: inkOnThePage.signatureHeight,
    })
  })

  it('drags an adopted drawing, in PDF points', async () => {
    const user = userEvent.setup()
    const editor = renderEditor({ drawOnPdf: true, initial: inkOnThePage })
    await screen.findByText(/Page 1 of 3/)
    await user.click(screen.getByRole('button', { name: ADOPT }))

    const target = await findBox()
    target.dispatchEvent(
      new PointerEvent('pointerdown', {
        pointerId: 1,
        clientX: 250,
        clientY: 420,
        bubbles: true,
        cancelable: true,
      }),
    )
    window.dispatchEvent(
      new PointerEvent('pointermove', {
        pointerId: 1,
        clientX: 300,
        clientY: 460,
        bubbles: true,
        cancelable: true,
      }),
    )
    window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, bubbles: true }))

    await waitFor(() => expect(editor.read()?.signatureX).toBeCloseTo(250, 3))
    expect(editor.read()?.signatureY).toBeCloseTo(440, 3)
  })

  it('nudges and resizes an adopted drawing from the keyboard', async () => {
    const user = userEvent.setup()
    const editor = renderEditor({ drawOnPdf: true, initial: inkOnThePage })
    await screen.findByText(/Page 1 of 3/)
    await user.click(screen.getByRole('button', { name: ADOPT }))

    const box = await findBox()
    box.focus()
    await user.keyboard('{ArrowRight}')
    await waitFor(() =>
      expect(editor.read()?.signatureX).toBeCloseTo(inkOnThePage.signatureX + 1, 3),
    )

    await user.keyboard('+')
    await waitFor(() =>
      expect(editor.read()?.signatureWidth).toBeGreaterThan(inkOnThePage.signatureWidth),
    )
  })

  it('puts the pen back when the ink is wiped', async () => {
    // Clear starts a new drawing, and a new drawing has not been adopted -
    // otherwise the page would still be refusing strokes for a signature that
    // is no longer on it.
    const user = userEvent.setup()
    renderEditor({ drawOnPdf: true, initial: inkOnThePage })
    await screen.findByText(/Page 1 of 3/)
    await user.click(screen.getByRole('button', { name: ADOPT }))
    await findBox()

    await user.click(screen.getByRole('button', { name: 'Wipe the ink' }))

    await waitFor(() =>
      expect(screen.queryByRole('group', { name: /Signature on page/ })).not.toBeInTheDocument(),
    )
    expect(screen.getByRole('button', { name: ADOPT })).toBeInTheDocument()
  })

  it('leaves the saved-signature path alone', async () => {
    // Nothing to adopt there: the box is the signature from the first click,
    // and always was.
    renderEditor({ initial: inkOnThePage })
    await screen.findByText(/Page 1 of 3/)

    expect(await findBox()).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: ADOPT })).not.toBeInTheDocument()
  })
})

/**
 * Where a drawing ends up when it is drawn along the bottom edge.
 *
 * Every other way of placing a signature goes through the shared clamp, which
 * keeps room below for the block naming the signer. Ink kept its own copy -
 * right about the page edges, ignorant of the block - so a signature drawn
 * along the bottom was filed with nowhere for its own name, and the backend
 * lifted it clear afterwards. Nobody was told it had moved.
 */
describe('ink drawn near the bottom of the page', () => {
  const block = { name: 'Maria Chen', designation: 'Deputy Manager' }
  const reserved = signoffBlockHeight(block)
  const INK_H = 40

  /** Draw a stroke, with the cropper reporting ink in the given screen rect. */
  async function drawInk(top: number) {
    vi.mocked(cropInkFromCanvas).mockReturnValue({
      dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
      left: 60,
      top,
      width: 150,
      height: INK_H,
    })

    /*
     * The ink surface by name, and only once it has been sized.
     *
     * It used to be "the last canvas in the document", which is a different
     * element depending on how many of the three pages have finished
     * rendering - so the stroke landed on a page canvas, nothing was ever
     * adopted, and the wait below timed out. And a surface that exists but
     * has no metrics yet drops the stroke just as silently, which is what
     * the width stands in for.
     */
    const ink = await screen.findByTestId('pdf-ink-surface')
    await waitFor(() => expect(ink.style.width).not.toBe(''))

    ink.dispatchEvent(
      new PointerEvent('pointerdown', { pointerId: 7, clientX: 60, clientY: top, bubbles: true }),
    )
    ink.dispatchEvent(
      new PointerEvent('pointermove', {
        pointerId: 7,
        clientX: 200,
        clientY: top + 10,
        bubbles: true,
      }),
    )
    ink.dispatchEvent(new PointerEvent('pointerup', { pointerId: 7, bubbles: true }))
  }

  it('lifts it far enough for the block to fit', async () => {
    const editor = renderEditor({ drawOnPdf: true, signoffPreview: block })
    await screen.findByText(/Page 1 of 3/)

    // Drawn with its foot on the very last row of the page.
    await drawInk(PDF_H - INK_H)

    await waitFor(() => expect(editor.read()).not.toBeNull())
    const drawn = editor.read()!
    expect(
      PDF_H - drawn.signatureY - drawn.signatureHeight,
      'the block has to fit between the signature and the bottom edge',
    ).toBeGreaterThanOrEqual(reserved)
  })

  it('says so while the pen is still live, before anything moves', async () => {
    // The one case where adopting a drawing shifts it. Discovering that after
    // the fact, on a page that cannot be redrawn, is the whole complaint.
    const editor = renderEditor({ drawOnPdf: true, signoffPreview: block })
    await screen.findByText(/Page 1 of 3/)

    await drawInk(PDF_H - INK_H)

    expect(await screen.findByText(/too close to the bottom edge/i)).toBeInTheDocument()
    expect(editor.read()).not.toBeNull()
  })

  it('leaves a drawing with room to spare exactly where it was drawn', async () => {
    const editor = renderEditor({ drawOnPdf: true, signoffPreview: block })
    await screen.findByText(/Page 1 of 3/)

    await drawInk(300)

    await waitFor(() => expect(editor.read()).not.toBeNull())
    expect(editor.read()?.signatureY).toBeCloseTo(300, 3)
    expect(screen.queryByText(/too close to the bottom edge/i)).not.toBeInTheDocument()
  })

  it('keeps the page edge for a signature with no block under it', async () => {
    // No name to draw means nothing to reserve, which is what it always did.
    const editor = renderEditor({ drawOnPdf: true })
    await screen.findByText(/Page 1 of 3/)

    await drawInk(PDF_H - INK_H)

    await waitFor(() => expect(editor.read()).not.toBeNull())
    expect(editor.read()!.signatureY + editor.read()!.signatureHeight).toBeCloseTo(PDF_H, 3)
    expect(screen.queryByText(/too close to the bottom edge/i)).not.toBeInTheDocument()
  })
})
