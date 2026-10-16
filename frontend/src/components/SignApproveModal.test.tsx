import { screen, waitFor, within, fireEvent } from '@testing-library/react'
import { SIGNING_CONSENT_STATEMENT } from './SigningConsent'
import userEvent from '@testing-library/user-event'
import { useEffect, useRef, useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { approveDocument } from '../services/approvalApi'
import { fetchDocumentFile } from '../services/documentDetailApi'
import { blobToDataUrl, fetchMySignature, uploadMySignature } from '../services/userSignatureApi'
import { makeUser, renderWithProviders } from '../test/render'
import type { PdfPlacement } from '../utils/pdfCoordinates'
import SignApproveModal from './SignApproveModal'
import type { PdfPageMetrics } from './PdfDocumentViewer'

/**
 * The dialog an approver uses to put their signature on somebody else's
 * document. Confirming here is irreversible from the person's side: the
 * approval is recorded against their name, the signature is burned into the
 * PDF at the coordinates this dialog sends, and the document moves to the
 * next person in the chain.
 *
 * So the questions worth asking are all about the confirm path. Does it
 * refuse when there is nothing to stamp? Does it stamp exactly where the
 * person put the signature? Does pressing the button twice approve twice?
 * When the server says no, does the person find out, and is the signature
 * they just drew still there to retry with?
 *
 * The PDF surface is a stub: pdf.js needs a canvas and a worker that jsdom
 * has neither of, and what is under test is the dialog's decisions, not the
 * rendering of page 2. The stub exposes the same two callbacks the real
 * viewer fires - "the ink changed" and "the signature was placed here" - so
 * every test drives the dialog through the same events a mouse would.
 */

/**
 * Every test here mounts a dialog that renders a PDF surface and runs two
 * async loads. Under the 5s default one of these times out on a loaded machine
 * roughly one run in three - a red suite that says nothing about the
 * component. The budget is generous because a slow test is cheap and a flaky
 * one costs the next person an afternoon.
 *
 * `userEvent.setup({ delay: null })` at every call site is the other half of
 * that: the default inserts a real-timer wait between every keystroke and
 * click, which is what made these two files the slowest in the suite (92s of
 * test time down to 18s) and slow enough to lose a pool worker to a startup
 * timeout. It drops the artificial wait, not the act() flush - every
 * assertion in this file still goes red when its expected value is flipped.
 */
vi.setConfig({ testTimeout: 20_000 })

const stub = vi.hoisted(() => ({
  ink: 'data:image/png;base64,DRAWN-INK',
  savedUrl: 'data:image/png;base64,SAVED-SIGNATURE',
  placement: {
    page: 2,
    signatureX: 120,
    signatureY: 340,
    signatureWidth: 150,
    signatureHeight: 50,
  },
  metrics: { pdfWidth: 612, pdfHeight: 792, displayWidth: 612, displayHeight: 792 },
}))

vi.mock('./PdfDocumentViewer', () => ({
  default: function PdfViewerStub({
    file,
    placementHint,
    signaturePreviewUrl,
    inkResetKey = 0,
    onPlacement,
    onInkChange,
  }: {
    file: Blob | null
    placementHint?: string
    signaturePreviewUrl?: string | null
    inkResetKey?: number
    onPlacement?: (placement: PdfPlacement, metrics: PdfPageMetrics) => void
    onInkChange?: (dataUrl: string | null) => void
  }) {
    /**
     * The two outputs are stubbed as well as the two callbacks, because they
     * are the only way the dialog's state becomes something the person can
     * see. The real viewer draws `signaturePreviewUrl` over the page as an
     * `<img alt="Signature preview">`, and wipes its ink canvas whenever
     * `inkResetKey` changes. Without both, a drawing the dialog forgot to
     * drop and strokes it never wiped look exactly like a dialog that
     * cleaned up after itself - which is how a whole class of stale-ink
     * mutations survived this file.
     */
    const [drawn, setDrawn] = useState(false)

    /*
     * Only a CHANGE of key wipes the page, never the mount.
     *
     * Written without this guard the effect also ran on mount, and passive
     * effects flush after the DOM is committed rather than with it. So
     * `findByRole` could return on the commit, the test could click "Draw ink
     * on the page" and set `drawn` true, and the pending MOUNT effect could
     * then flush and set it straight back to false - a click that had already
     * happened, undone by an effect scheduled before it.
     *
     * The window between commit and flush is a few microseconds on an idle
     * machine and wider on a loaded CI runner, which is where this first
     * failed: green here for months, red on the runner, in a test about
     * signatures not surviving a mode change.
     *
     * It is also what the real viewer does. A canvas that has just mounted is
     * already empty; there is nothing to wipe until somebody asks for a reset.
     */
    const mounted = useRef(false)
    useEffect(() => {
      if (!mounted.current) {
        mounted.current = true
        return
      }
      setDrawn(false)
    }, [inkResetKey])

    return (
      <div>
        <p>{file ? 'Page 1 of the document' : 'No document'}</p>
        <p>{placementHint}</p>
        <p>{drawn ? 'Ink on the page' : 'Nothing drawn on the page'}</p>
        {signaturePreviewUrl && <img src={signaturePreviewUrl} alt="Signature preview" />}
        <button
          type="button"
          onClick={() => {
            setDrawn(true)
            onInkChange?.(stub.ink)
          }}
        >
          Draw ink on the page
        </button>
        <button
          type="button"
          onClick={() => onPlacement?.(stub.placement as PdfPlacement, stub.metrics)}
        >
          Place the signature
        </button>
        {/* The real viewer fires this with null when the person rubs the
            drawing out on the page. It is a different code path from the
            Clear button in the side panel, and it is the one that leaves a
            placement behind if the dialog forgets to drop it. */}
        <button
          type="button"
          onClick={() => {
            setDrawn(false)
            onInkChange?.(null)
          }}
        >
          Erase the ink from the page
        </button>
      </div>
    )
  },
}))

vi.mock('../services/approvalApi', () => ({ approveDocument: vi.fn() }))
vi.mock('../services/documentDetailApi', () => ({ fetchDocumentFile: vi.fn() }))
vi.mock('../services/userSignatureApi', () => ({
  fetchMySignature: vi.fn(),
  blobToDataUrl: vi.fn(),
  uploadMySignature: vi.fn(),
  deleteMySignature: vi.fn(),
}))

const approve = vi.mocked(approveDocument)
const loadFile = vi.mocked(fetchDocumentFile)
const loadSignature = vi.mocked(fetchMySignature)
const readSignature = vi.mocked(blobToDataUrl)
const storeSignature = vi.mocked(uploadMySignature)

const DOCUMENT_ID = 'doc-0000-0000-0000-000000000001'
const TITLE = 'Warehouse lease extension'

/** A promise the test holds open, so "while the request is in flight" is a real state. */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function props(overrides: Partial<Parameters<typeof SignApproveModal>[0]> = {}) {
  return {
    open: true,
    documentId: DOCUMENT_ID,
    documentTitle: TITLE,
    onClose: vi.fn(),
    onSuccess: vi.fn(),
    ...overrides,
  }
}

/** The approver has no signature on file, so the dialog opens in draw mode. */
function renderModal(overrides: Partial<Parameters<typeof SignApproveModal>[0]> = {}) {
  const modalProps = props(overrides)
  const view = renderWithProviders(<SignApproveModal {...modalProps} />, {
    router: false,
    currentUser: { user: makeUser({ hasSignature: false }) },
  })
  return { ...view, props: modalProps, user: userEvent.setup({ delay: null }) }
}

/** The approver already saved a signature to their profile. */
function renderModalWithSavedSignature(
  overrides: Partial<Parameters<typeof SignApproveModal>[0]> = {},
) {
  loadSignature.mockResolvedValue(new Blob(['png'], { type: 'image/png' }))
  readSignature.mockResolvedValue(stub.savedUrl)
  const modalProps = props(overrides)
  const view = renderWithProviders(<SignApproveModal {...modalProps} />, {
    router: false,
    currentUser: { user: makeUser({ hasSignature: true }) },
  })
  return { ...view, props: modalProps, user: userEvent.setup({ delay: null }) }
}

/** Both async loads have landed once the signature panel has replaced its skeleton. */
/**
 * The "this is my signature" box, ticked.
 *
 * Every signature needs it, so the readiness helpers below tick it for the
 * tests that are about something else. The dialog checks it last, after the
 * placement and the mark, so a test about a missing placement still sees that
 * refusal rather than this one; the box itself has its own tests.
 */
function agreeToSign() {
  const box = screen.queryByRole('checkbox', { name: SIGNING_CONSENT_STATEMENT })
  if (box instanceof HTMLInputElement && !box.checked) fireEvent.click(box)
}

async function readyToDraw() {
  const ready = await screen.findByRole('button', { name: 'Clear' })
  agreeToSign()
  return ready
}

async function readyToPlaceSaved() {
  const ready = await screen.findByRole('img', { name: 'Saved signature' })
  agreeToSign()
  return ready
}

/**
 * The hidden input behind "Choose image" and "Replace". It has no accessible
 * name - it is driven by those two buttons - so a query is the only way to
 * reach it, exactly as SignatureInput's own tests do.
 */
function signatureFileInput() {
  return document.querySelector<HTMLInputElement>('input[type="file"]')!
}

const PNG = (name = 'signature.png') => new File(['png'], name, { type: 'image/png' })

/**
 * jsdom has no layout, so `offsetParent` is null for every element on the
 * page. The dialog's focus trap uses `offsetParent !== null` as its "is this
 * control visible" test, which means that under plain jsdom the trap sees
 * exactly one focusable element - the one that already has focus - and
 * wrapping to it is indistinguishable from no trap at all.
 *
 * This makes `offsetParent` answer the way a browser would: the parent
 * element, unless the control is inside something display:none (Tailwind's
 * `hidden`, which is how the file input is kept off screen). Only then does
 * "Shift+Tab wrapped to the last control" mean anything.
 */

/** The display:none check, taking the element as an argument rather than
 *  reading `this` inside the getter - the aliasing form trips no-this-alias
 *  and failed `eslint .`. */
function inHiddenSubtree(start: HTMLElement): boolean {
  for (let el: HTMLElement | null = start; el; el = el.parentElement) {
    if (el.classList.contains('hidden')) return true
  }
  return false
}

function withLayout() {
  const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetParent')
  Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
    configurable: true,
    get(this: HTMLElement) {
      return inHiddenSubtree(this) ? null : this.parentElement
    },
  })
  return () => {
    if (original) Object.defineProperty(HTMLElement.prototype, 'offsetParent', original)
  }
}

beforeEach(() => {
  // `restoreMocks` restores spies, but these are module-factory mocks: their
  // call history survives into the next test, and "was approve called?" is
  // the question half of this file asks.
  vi.clearAllMocks()
  // The unremarkable case, re-stated per test: the PDF loads, no signature
  // is on file.
  loadFile.mockResolvedValue(new Blob(['%PDF-1.7'], { type: 'application/pdf' }))
  loadSignature.mockResolvedValue(null)
  readSignature.mockResolvedValue(stub.savedUrl)
  storeSignature.mockResolvedValue(undefined)
  approve.mockResolvedValue({})
})

describe('SignApproveModal, before anything is signed', () => {
  it('stays out of the DOM until it is opened, and fetches no document', () => {
    renderModal({ open: false })

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    // A closed dialog that still ran its effects would download the PDF of
    // every document listed on the screen behind it.
    expect(loadFile).not.toHaveBeenCalled()
    // Same for the profile signature: one lookup per row of a 50-row list.
    expect(loadSignature).not.toHaveBeenCalled()
  })

  it('fetches the document it was actually given, not some other one', async () => {
    renderModal({ documentId: 'doc-0000-0000-0000-000000000099' })
    await readyToDraw()

    // Nothing else in this file pins the id down. Fetching the wrong document
    // shows the person a PDF they are not approving and burns their signature
    // into it at coordinates chosen against a page they never read.
    expect(loadFile).toHaveBeenCalledWith(
      'doc-0000-0000-0000-000000000099',
      'view',
    )
    expect(loadFile).toHaveBeenCalledTimes(1)
  })

  it('names itself for the act it is about to perform and the document it will change', async () => {
    renderModal()

    const dialog = screen.getByRole('dialog')
    // A screen reader user hears only the dialog's name and description on
    // open. "Sign & approve" plus the title is the difference between
    // knowing and guessing which document is about to carry your name.
    expect(dialog).toHaveAccessibleName('Sign & approve')
    expect(dialog).toHaveAccessibleDescription(TITLE)
    expect(dialog).toHaveAttribute('aria-modal', 'true')

    await readyToDraw()
  })

  it('says the document is still loading rather than showing a silent grey panel', () => {
    const pdf = deferred<Blob>()
    loadFile.mockReturnValue(pdf.promise)

    renderModal()

    // The skeleton is aria-hidden, so without this line the wait is invisible
    // to a screen reader - an empty dialog that never announces anything.
    // Rendering the words is not enough: they have to be in a region that
    // speaks, or they are just more silent markup behind the aria-hidden.
    const notice = screen.getByText('Loading document')
    expect(notice.closest('[aria-live]')).toHaveAttribute('aria-live', 'polite')

    // Nothing to sign yet, so there must be no button offering to sign it -
    // and nothing else to interact with either. The skeleton being
    // aria-hidden is what makes this list short; if it stopped being hidden,
    // a screen reader user would be handed a pile of nameless boxes.
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getAllByRole('button').map(b => b.getAttribute('aria-label') ?? b.textContent)).toEqual([
      'Close dialog',
    ])
  })

  it('explains a failed document load instead of offering a signature surface for nothing', async () => {
    loadFile.mockRejectedValue(new Error('Document storage is unreachable'))

    renderModal()

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Could not load this document')
    // The reason has to reach the person: "could not load" alone leaves them
    // retrying forever against an outage nobody told them about.
    expect(alert).toHaveTextContent('Document storage is unreachable')
    expect(screen.queryByRole('button', { name: 'Sign & approve' })).not.toBeInTheDocument()
    // No signing surface either. Mounting the viewer against a null file is
    // how the real pdf.js surface throws where nobody is catching.
    expect(screen.queryByText('Page 1 of the document')).not.toBeInTheDocument()
  })

  /**
   * DEFECT, pinned down rather than wished away.
   *
   * The load-error branch replaces the whole two-column body, buttons
   * included, so the person is told the document could not be loaded and left
   * with no Cancel to press. The only pointer exit is the icon-only X in the
   * header - the same gap the preparer's dialog has in its empty state.
   *
   * Asserting the gap exactly, rather than with `it.fails`: this goes red the
   * day someone adds the Cancel back (invert it then), and red if anything
   * else in the error state breaks.
   */
  it('strands a failed load with no Cancel, only the header X (known defect)', async () => {
    loadFile.mockRejectedValue(new Error('Document storage is unreachable'))
    const { user, props: modalProps } = renderModal()
    await screen.findByRole('alert')

    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument()
    const exits = within(screen.getByRole('dialog')).getAllByRole('button')
    expect(exits).toHaveLength(1)
    expect(exits[0]).toHaveAttribute('aria-label', 'Close dialog')

    // The one exit that is left has to actually work, or the dialog is a
    // dead end for anyone not reaching for Escape.
    await user.click(exits[0])
    expect(modalProps.onClose).toHaveBeenCalledTimes(1)
    expect(approve).not.toHaveBeenCalled()
  })

  it('still closes on Escape when the document failed to load', async () => {
    loadFile.mockRejectedValue(new Error('Document storage is unreachable'))
    const { user, props: modalProps } = renderModal()
    await screen.findByRole('alert')

    // The keyboard exit is wired to the panel, not to the body that the error
    // branch replaces, so it survives where Cancel does not. With the Cancel
    // gone this is the only exit a keyboard user has.
    await user.keyboard('{Escape}')

    expect(modalProps.onClose).toHaveBeenCalledTimes(1)
  })

  it('shows the whole title of a long-named document, since that is what identifies it', async () => {
    const longTitle =
      'Q4 2026 warehouse lease extension and amended service schedule for the Karachi site'
    renderModal({ documentTitle: longTitle })

    const dialog = screen.getByRole('dialog')
    const described = document.getElementById(dialog.getAttribute('aria-describedby') ?? '')

    // The header truncates this with CSS, which keeps the whole string in the
    // DOM for a screen reader to read out and for the person to select and
    // copy. Trimming it in JS with an ellipsis instead would look identical
    // and lose the half of the title that says which site and which quarter.
    expect(described).toHaveTextContent(longTitle)
    expect(described?.textContent).toBe(longTitle)
    expect(described?.textContent).not.toContain('…')

    await readyToDraw()
  })
})

describe('SignApproveModal, what it refuses to send', () => {
  it('refuses to approve when nothing has been drawn, and says what is missing', async () => {
    const { user } = renderModal()
    await readyToDraw()

    await user.click(screen.getByRole('button', { name: 'Sign & approve' }))

    expect(
      await screen.findByText('Draw your signature on the document before approving.'),
    ).toBeInTheDocument()
    // The whole point: an approval with no signature is an approval the
    // document cannot evidence afterwards.
    expect(approve).not.toHaveBeenCalled()
  })

  it('refuses when ink exists but no placement was ever computed for it', async () => {
    const { user } = renderModal()
    await readyToDraw()

    await user.click(screen.getByRole('button', { name: 'Draw ink on the page' }))
    await user.click(screen.getByRole('button', { name: 'Sign & approve' }))

    // Ink without a placement means the dialog does not know which page or
    // where. Sending it anyway would stamp the signature at whatever the
    // server defaults to, which is not where the person drew it.
    expect(approve).not.toHaveBeenCalled()
    expect(
      screen.getByText('Draw your signature on the document before approving.'),
    ).toBeInTheDocument()
  })

  it('takes the placement and the ink away together when Clear is pressed', async () => {
    const { user } = renderModal()
    await readyToDraw()

    await user.click(screen.getByRole('button', { name: 'Draw ink on the page' }))
    await user.click(screen.getByRole('button', { name: 'Place the signature' }))
    expect(screen.getByRole('dialog')).toHaveTextContent('Page: 2')

    await user.click(screen.getByRole('button', { name: 'Clear' }))

    // A summary left standing after Clear claims a signature is going onto
    // page 2 of the document when there is no longer one to put there.
    expect(screen.getByRole('dialog')).not.toHaveTextContent('Page:')

    // Placing again is what separates "the summary was hidden" from "the ink
    // is really gone": with a fresh placement the first guard is satisfied,
    // so only a genuinely cleared `signatureImage` stops this from approving
    // with the strokes the person just wiped out.
    await user.click(screen.getByRole('button', { name: 'Place the signature' }))
    await user.click(screen.getByRole('button', { name: 'Sign & approve' }))

    expect(approve).not.toHaveBeenCalled()
    expect(
      await screen.findByText('Draw your signature on the document before approving.'),
    ).toBeInTheDocument()
  })

  it('drops the placement when the drawing is erased off the page', async () => {
    const { user } = renderModal()
    await readyToDraw()

    await user.click(screen.getByRole('button', { name: 'Draw ink on the page' }))
    await user.click(screen.getByRole('button', { name: 'Place the signature' }))
    expect(screen.getByRole('dialog')).toHaveTextContent('Page: 2')

    await user.click(screen.getByRole('button', { name: 'Erase the ink from the page' }))

    // The box was measured around strokes that no longer exist. Keeping it
    // would let the next placement-free confirm sail past the first guard.
    expect(screen.getByRole('dialog')).not.toHaveTextContent('Page:')

    await user.click(screen.getByRole('button', { name: 'Sign & approve' }))
    expect(approve).not.toHaveBeenCalled()
    expect(
      await screen.findByText('Draw your signature on the document before approving.'),
    ).toBeInTheDocument()
  })

  it('forgets a placement made for the other signature when the mode is switched', async () => {
    const { user } = renderModal()
    await readyToDraw()

    await user.click(screen.getByRole('button', { name: 'Draw ink on the page' }))
    await user.click(screen.getByRole('button', { name: 'Place the signature' }))
    expect(screen.getByText('Page:')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Saved signature' }))

    // A placement sized around drawn ink is the wrong box for a stamped
    // saved signature; carrying it over would stamp it at the wrong size.
    expect(screen.queryByText('Page:')).not.toBeInTheDocument()

    // The summary vanishing is only the visible half. What matters is that
    // the dialog now genuinely has no placement: pressing confirm has to be
    // refused, not sent with the box that was measured for the other
    // signature. A component that merely hid the panel would pass the line
    // above and still approve.
    await user.click(screen.getByRole('button', { name: 'Sign & approve' }))

    expect(approve).not.toHaveBeenCalled()
    expect(
      await screen.findByText(
        'Click or drag your signature onto the document to choose placement.',
      ),
    ).toBeInTheDocument()
  })

  it('asks a saved-signature approver to place it, in the words that match what they must do', async () => {
    const { user } = renderModalWithSavedSignature()
    await readyToPlaceSaved()

    await user.click(screen.getByRole('button', { name: 'Sign & approve' }))

    // Telling someone with a stored signature to "draw" one sends them
    // looking for a pen they do not need.
    expect(
      await screen.findByText(
        'Click or drag your signature onto the document to choose placement.',
      ),
    ).toBeInTheDocument()
    expect(approve).not.toHaveBeenCalled()
  })

  /**
   * FIXED - this test was the inverse of itself, asserting the defect.
   *
   * Switching draw -> saved cleared the placement but left the drawn ink in
   * `signatureImage`, so the guard that should have printed "Upload or
   * select your saved signature before approving." never fired and the
   * dialog sent `useSavedSignature: true` on behalf of an account holding
   * nothing. It is reachable with a mouse: in saved mode the viewer places
   * on a plain page click, without consulting `allowSignatureDrop`.
   *
   * The ink is now dropped whichever way the mode changes, and the guard
   * asks the question that belongs to the mode selected - saved mode wants
   * an image on the profile, not ink from this session.
   */
  it('refuses a saved-signature approval from an account with nothing saved', async () => {
    const { user, props: modalProps } = renderModal()
    await readyToDraw()

    await user.click(screen.getByRole('button', { name: 'Draw ink on the page' }))
    await user.click(screen.getByRole('button', { name: 'Saved signature' }))
    await user.click(screen.getByRole('button', { name: 'Place the signature' }))
    await user.click(screen.getByRole('button', { name: 'Sign & approve' }))

    // An approval sent this way is recorded against the person's name with
    // no signature to evidence it, and reported as a success so nobody
    // downstream learns anything is wrong.
    expect(
      await screen.findByText('Upload or select your saved signature before approving.'),
    ).toBeInTheDocument()
    expect(approve).not.toHaveBeenCalled()
    expect(modalProps.onSuccess).not.toHaveBeenCalled()
    expect(modalProps.onClose).not.toHaveBeenCalled()
  })

  it('does not carry drawn ink over into the saved mode as a preview', async () => {
    const { user } = renderModalWithSavedSignature()
    await readyToPlaceSaved()

    await user.click(screen.getByRole('button', { name: 'Draw' }))
    await user.click(screen.getByRole('button', { name: 'Draw ink on the page' }))
    await user.click(screen.getByRole('button', { name: 'Saved signature' }))
    await user.click(screen.getByRole('button', { name: 'Place the signature' }))
    await user.click(screen.getByRole('button', { name: 'Sign & approve' }))

    // With a signature on file the approval does go through - and it must be
    // the stored one. Sending the drawing that was left in state would stamp
    // the scribble the person abandoned onto somebody else's document.
    await waitFor(() => expect(approve).toHaveBeenCalledTimes(1))
    expect(approve.mock.calls[0][1]).toEqual({
      consent: true,
      useSavedSignature: true,
      signaturePage: 2,
      signatureX: 120,
      signatureY: 340,
      signatureWidth: 150,
      signatureHeight: 50,
    })
  })

  /**
   * ADDED after mutation testing.
   *
   * Reverting the stale-ink fix on its own - clearing the drawing only on
   * the way into draw mode, the way it used to - kept every test in this
   * file green, because the mode-aware guard added at the same time covers
   * for it on the confirm path. Two guards for one defect, and the suite
   * only noticed when both were gone at once. Each has to be pinned by
   * itself or a later tidy-up removes one and nothing goes red.
   *
   * This is the half you can see: the drawing stays on the page, floating
   * over a document the person is now signing with the profile signature.
   */
  it('stops showing the drawing over the page once the saved mode is chosen', async () => {
    const { user } = renderModal()
    await readyToDraw()

    await user.click(screen.getByRole('button', { name: 'Draw ink on the page' }))
    await user.click(screen.getByRole('button', { name: 'Place the signature' }))
    expect(screen.getByRole('img', { name: 'Signature preview' })).toHaveAttribute(
      'src',
      stub.ink,
    )

    await user.click(screen.getByRole('button', { name: 'Saved signature' }))

    // Saved mode signs with whatever is on the profile - this account has
    // nothing. A drawing still hanging over the page says the opposite, and
    // it is the picture the person checks before they press approve.
    expect(screen.queryByRole('img', { name: 'Signature preview' })).not.toBeInTheDocument()
  })

  /**
   * ADDED after mutation testing: dropping the `inkResetKey` bump from the
   * mode switch left every test green, because nothing in this file ever
   * looked at the key. It is the only thing that wipes the ink canvas, so
   * without it the strokes stay drawn across the PDF after the person has
   * moved to the signature on their profile.
   */
  it('wipes the strokes off the page when the mode changes', async () => {
    const { user } = renderModal()
    await readyToDraw()

    await user.click(screen.getByRole('button', { name: 'Draw ink on the page' }))
    expect(screen.getByText('Ink on the page')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Saved signature' }))
    expect(screen.getByText('Nothing drawn on the page')).toBeInTheDocument()

    // And it stays wiped on the way back, so the person who returns to draw
    // starts on a clean page rather than on top of the strokes they left.
    await user.click(screen.getByRole('button', { name: 'Draw' }))
    expect(screen.getByText('Nothing drawn on the page')).toBeInTheDocument()
  })
})

describe('SignApproveModal, the confirm path', () => {
  it('sends the drawn signature with the exact page and box the person placed it in', async () => {
    const { user, props: modalProps } = renderModal()
    await readyToDraw()

    await user.click(screen.getByRole('button', { name: 'Draw ink on the page' }))
    await user.click(screen.getByRole('button', { name: 'Place the signature' }))
    await user.click(screen.getByRole('button', { name: 'Sign & approve' }))

    // Every number here ends up burned into the PDF. A dropped page number
    // or a swapped x/y puts a legally-signed name across somebody's clause.
    await waitFor(() =>
      expect(approve).toHaveBeenCalledWith(DOCUMENT_ID, {
        consent: true,
        signatureImage: stub.ink,
        signaturePage: 2,
        signatureX: 120,
        signatureY: 340,
        signatureWidth: 150,
        signatureHeight: 50,
      }),
    )
    expect(modalProps.onSuccess).toHaveBeenCalledTimes(1)
    expect(modalProps.onClose).toHaveBeenCalledTimes(1)
  })

  it('shows where the signature will land before the person commits to it', async () => {
    const { user } = renderModal()
    await readyToDraw()

    const dialog = screen.getByRole('dialog')
    // Nothing placed yet, so there is nothing to claim about where it lands.
    expect(dialog).not.toHaveTextContent('Page:')

    await user.click(screen.getByRole('button', { name: 'Draw ink on the page' }))
    await user.click(screen.getByRole('button', { name: 'Place the signature' }))

    // The person is approving on the strength of what this panel says, so
    // page and position must be readable text and not only a dotted outline
    // somewhere in a scrolled-out-of-view part of the PDF.
    //
    // Read as whole labelled facts against the dialog rather than by walking
    // up to a container div: a label separated from its number is a different
    // bug from a wrong number, and `.closest('div')` broke on restyling
    // without anything the person sees having changed.
    expect(dialog).toHaveTextContent('Page: 2')
    expect(dialog).toHaveTextContent('Position: x 120, y 340')
    expect(dialog).toHaveTextContent('Size: 150 × 50')
    // x and y transposed still reads as a plausible summary, and still lands
    // the signature in the wrong place.
    expect(dialog).not.toHaveTextContent('x 340, y 120')
  })

  it('sends a saved signature by reference instead of re-uploading the image', async () => {
    const { user } = renderModalWithSavedSignature()
    await readyToPlaceSaved()

    await user.click(screen.getByRole('button', { name: 'Place the signature' }))
    await user.click(screen.getByRole('button', { name: 'Sign & approve' }))

    await waitFor(() => expect(approve).toHaveBeenCalledTimes(1))
    const payload = approve.mock.calls[0][1]
    // Whole-payload equality, not two spot checks: it is the only form that
    // also proves the coordinates survived the saved-signature path, and that
    // no extra field crept in alongside `useSavedSignature`.
    expect(payload).toEqual({
      consent: true,
      useSavedSignature: true,
      signaturePage: 2,
      signatureX: 120,
      signatureY: 340,
      signatureWidth: 150,
      signatureHeight: 50,
    })
    // Round-tripping the stored image through the browser would let a tampered
    // page substitute a different signature for the one on the profile.
    expect(payload).not.toHaveProperty('signatureImage')
    // This line used to read `toHaveBeenCalledWith(DOCUMENT_ID, payload)` with
    // `payload` pulled out of the very call it was checking - the second
    // argument could never disagree with itself, so only the id half of it
    // could ever fail. Say the id half plainly instead.
    expect(approve.mock.calls[0][0]).toBe(DOCUMENT_ID)
  })

  it('approves once when the button is pressed twice', async () => {
    const gate = deferred<unknown>()
    approve.mockReturnValue(gate.promise)
    const { user } = renderModal()
    await readyToDraw()

    await user.click(screen.getByRole('button', { name: 'Draw ink on the page' }))
    await user.click(screen.getByRole('button', { name: 'Place the signature' }))

    const confirm = screen.getByRole('button', { name: 'Sign & approve' })
    await user.click(confirm)
    // Genuinely disabled, not merely greyed: a styled-only button still fires
    // and records a second approval on a workflow step that has already moved.
    expect(confirm).toBeDisabled()
    // Greying out is invisible to a screen reader mid-request. Without this
    // the person hears an ordinary enabled button and presses it again.
    expect(confirm).toHaveAttribute('aria-busy', 'true')

    await user.click(confirm)
    gate.resolve({})

    await waitFor(() => expect(approve).toHaveBeenCalledTimes(1))
    // Once it lands the busy state has to come off with it. A dialog left
    // permanently aria-busy and disabled cannot be retried after a later
    // failure, and keeps announcing a request that finished.
    await waitFor(() => expect(confirm).not.toHaveAttribute('aria-busy'))
    expect(confirm).toBeEnabled()
  })

  /**
   * ADDED after mutation testing, and honest about which defence it pins.
   *
   * Deleting `if (submitting) return` from the top of `handleApprove` left
   * every test in this file green, and no test can change that: the handler
   * is reachable only through this button, and while a request is in flight
   * React refuses to call a click listener on a control whose props say
   * `disabled` - stripping the attribute off the DOM node, as below, does
   * not get past it. The refusal that actually stops the second approval is
   * the `disabled` the house Button derives from `pending`.
   *
   * So this pins that one, end to end: not the attribute in isolation, but
   * that the control is inert in fact when the dialog says it is busy. It
   * goes red the day `pending` becomes a spinner with no `disabled` behind
   * it - which is the day a second press starts a second approval, recorded
   * again against the person's name on a step that has already moved on.
   */
  it('will not start a second approval from a confirm button that has been forced live', async () => {
    const gate = deferred<unknown>()
    approve.mockReturnValue(gate.promise)
    const { user } = renderModal()
    await readyToDraw()

    await user.click(screen.getByRole('button', { name: 'Draw ink on the page' }))
    await user.click(screen.getByRole('button', { name: 'Place the signature' }))

    const confirm = screen.getByRole('button', { name: 'Sign & approve' })
    await user.click(confirm)
    expect(confirm).toBeDisabled()

    // Defeat the attribute, the way a stale style or an automated tool does,
    // and press again. Nothing may reach the dialog.
    confirm.removeAttribute('disabled')
    await user.click(confirm)

    gate.resolve({})
    await waitFor(() => expect(approve).toHaveBeenCalledTimes(1))
    expect(approve).toHaveBeenCalledTimes(1)
  })

  it('keeps the dialog open and readable when the server rejects the approval', async () => {
    approve.mockRejectedValue(new Error('This step was already approved by someone else'))
    const { user, props: modalProps } = renderModal()
    await readyToDraw()

    await user.click(screen.getByRole('button', { name: 'Draw ink on the page' }))
    await user.click(screen.getByRole('button', { name: 'Place the signature' }))
    await user.click(screen.getByRole('button', { name: 'Sign & approve' }))

    expect(
      await screen.findByText('This step was already approved by someone else'),
    ).toBeInTheDocument()
    // Closing on failure would throw away the signature they just drew and
    // leave them believing the approval went through.
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(modalProps.onSuccess).not.toHaveBeenCalled()
    expect(modalProps.onClose).not.toHaveBeenCalled()
    // The whole placement, not just the word "Page:". A half-reset that kept
    // the label and lost the numbers would have passed the old line here,
    // and it is the numbers the retry sends.
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveTextContent('Page: 2')
    expect(dialog).toHaveTextContent('Position: x 120, y 340')
    expect(dialog).toHaveTextContent('Size: 150 × 50')
    // And it must be pressable again, otherwise a transient failure ends the
    // approval for good.
    expect(screen.getByRole('button', { name: 'Sign & approve' })).toBeEnabled()
  })

  it('retries with the same signature and box after a failure, and clears the stale error', async () => {
    approve.mockRejectedValueOnce(new Error('Network request failed'))
    const { user, props: modalProps } = renderModal()
    await readyToDraw()

    await user.click(screen.getByRole('button', { name: 'Draw ink on the page' }))
    await user.click(screen.getByRole('button', { name: 'Place the signature' }))
    await user.click(screen.getByRole('button', { name: 'Sign & approve' }))
    await screen.findByText('Network request failed')

    await user.click(screen.getByRole('button', { name: 'Sign & approve' }))

    await waitFor(() => expect(approve).toHaveBeenCalledTimes(2))
    // Anchored to the real numbers rather than only to the first call, so two
    // equally-wrong payloads cannot agree their way to green.
    expect(approve.mock.calls[1][1]).toEqual({
      consent: true,
      signatureImage: stub.ink,
      signaturePage: 2,
      signatureX: 120,
      signatureY: 340,
      signatureWidth: 150,
      signatureHeight: 50,
    })
    expect(approve.mock.calls[1][1]).toEqual(approve.mock.calls[0][1])
    // A failure message still on screen after a successful approval tells the
    // person the second attempt failed too, and they file it again by hand.
    await waitFor(() =>
      expect(screen.queryByText('Network request failed')).not.toBeInTheDocument(),
    )
    expect(modalProps.onSuccess).toHaveBeenCalledTimes(1)
  })

  it('clears a standing complaint once the signature is actually placed', async () => {
    const { user } = renderModal()
    await readyToDraw()

    await user.click(screen.getByRole('button', { name: 'Draw ink on the page' }))
    await user.click(screen.getByRole('button', { name: 'Sign & approve' }))
    const complaint = 'Draw your signature on the document before approving.'
    expect(await screen.findByText(complaint)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Place the signature' }))

    // The complaint has been answered. Leaving it up beside a filled-in
    // placement summary reads as a dialog that will refuse again, and it is
    // in a polite live region, so it is also re-announced as still-broken.
    expect(screen.queryByText(complaint)).not.toBeInTheDocument()
    expect(screen.getByRole('dialog')).toHaveTextContent('Page: 2')
  })

  it('announces the failure in a live region rather than only painting it red', async () => {
    approve.mockRejectedValue(new Error('Network request failed'))
    const { user } = renderModal()
    await readyToDraw()

    await user.click(screen.getByRole('button', { name: 'Draw ink on the page' }))
    await user.click(screen.getByRole('button', { name: 'Place the signature' }))

    // The region has to already be in the DOM and empty before the failure.
    // A live region inserted at the same moment as its first message is not
    // announced by most screen readers - the failure would be silent for
    // exactly the person who most needs to hear it.
    const region = screen.getByRole('dialog').querySelector('[aria-live]')
    expect(region).toBeInTheDocument()
    expect(region).toBeEmptyDOMElement()

    await user.click(screen.getByRole('button', { name: 'Sign & approve' }))

    const message = await screen.findByText('Network request failed')
    // Colour alone is not an announcement; the person who cannot see the red
    // needs the region to speak. Polite, not assertive: it must not cut off
    // whatever is being read at the time.
    expect(message.closest('[aria-live]')).toHaveAttribute('aria-live', 'polite')
    // Without aria-atomic the region can be re-read as a fragment, so one
    // error replacing another is announced as half a sentence.
    expect(message.closest('[aria-live]')).toHaveAttribute('aria-atomic', 'true')
    // Same node that was empty a moment ago, so this really is an update to a
    // standing region rather than a freshly mounted one.
    expect(message.closest('[aria-live]')).toBe(region)
  })

  it('approves nothing when the person cancels', async () => {
    const { user, props: modalProps } = renderModal()
    await readyToDraw()

    await user.click(screen.getByRole('button', { name: 'Draw ink on the page' }))
    await user.click(screen.getByRole('button', { name: 'Place the signature' }))
    await user.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(modalProps.onClose).toHaveBeenCalledTimes(1)
    // Cancel next to a placed signature is the one click that must never be
    // mistaken for confirm.
    expect(approve).not.toHaveBeenCalled()
    expect(modalProps.onSuccess).not.toHaveBeenCalled()
  })
})

describe('SignApproveModal, keyboard and focus', () => {
  it('closes on Escape while nothing is in flight', async () => {
    const { user, props: modalProps } = renderModal()
    await readyToDraw()

    await user.keyboard('{Escape}')

    expect(modalProps.onClose).toHaveBeenCalledTimes(1)
  })

  it('locks every exit while an approval is in flight', async () => {
    const gate = deferred<unknown>()
    approve.mockReturnValue(gate.promise)
    const { user, props: modalProps } = renderModal()
    await readyToDraw()

    await user.click(screen.getByRole('button', { name: 'Draw ink on the page' }))
    await user.click(screen.getByRole('button', { name: 'Place the signature' }))
    await user.click(screen.getByRole('button', { name: 'Sign & approve' }))

    // Leaving mid-request would unmount the dialog with the outcome unknown:
    // the approval may still land, and the person has no way to find out.
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Close dialog' })).toBeDisabled()

    await user.keyboard('{Escape}')
    expect(modalProps.onClose).not.toHaveBeenCalled()

    gate.resolve({})
    await waitFor(() => expect(modalProps.onClose).toHaveBeenCalledTimes(1))
  })

  it('gives the icon-only close control a name and hides the decorative glyph', async () => {
    renderModal()

    const close = screen.getByRole('button', { name: 'Close dialog' })

    // `getByRole(..., { name })` already selected on the name, so re-asserting
    // it here could never fail. What is actually worth proving is *why* the
    // name has to be authored: the control has no text of its own, so with
    // the aria-label gone it is announced as a bare "button" - and the glyph
    // inside must not leak in as its name either.
    expect(close).toHaveTextContent('')
    expect(close).toHaveAttribute('aria-label', 'Close dialog')
    expect(close.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')

    await readyToDraw()
  })

  it('closes on the header X without approving what was placed', async () => {
    const { user, props: modalProps } = renderModal()
    await readyToDraw()

    await user.click(screen.getByRole('button', { name: 'Draw ink on the page' }))
    await user.click(screen.getByRole('button', { name: 'Place the signature' }))
    await user.click(screen.getByRole('button', { name: 'Close dialog' }))

    // Nothing else here presses the X. It is named and focusable and gets a
    // disabled test while a request is in flight, all of which would pass on
    // a button wired to nothing - and in the failed-load state it is the only
    // pointer exit there is.
    expect(modalProps.onClose).toHaveBeenCalledTimes(1)
    expect(approve).not.toHaveBeenCalled()
    expect(modalProps.onSuccess).not.toHaveBeenCalled()
  })

  it('moves focus into the dialog, locks the page behind it, and hands focus back on close', async () => {
    const user = userEvent.setup({ delay: null })

    function Harness() {
      const [open, setOpen] = useState(false)
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Start signing
          </button>
          <SignApproveModal
            open={open}
            documentId={DOCUMENT_ID}
            documentTitle={TITLE}
            onClose={() => setOpen(false)}
            onSuccess={() => {}}
          />
        </>
      )
    }

    renderWithProviders(<Harness />, {
      router: false,
      currentUser: { user: makeUser({ hasSignature: false }) },
    })

    const trigger = screen.getByRole('button', { name: 'Start signing' })
    trigger.focus()
    await user.click(trigger)

    expect(screen.getByRole('button', { name: 'Close dialog' })).toHaveFocus()
    // The page behind must stop scrolling, or a stray wheel event scrolls the
    // list away underneath the dialog.
    expect(document.body.style.overflow).toBe('hidden')

    await readyToDraw()
    await user.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    // Without the hand-back, focus falls to the top of the document and a
    // keyboard user has to tab all the way back to where they were.
    expect(trigger).toHaveFocus()
    expect(document.body.style.overflow).toBe('')
  })

  it('wraps Shift+Tab round to the last control instead of stepping out of the dialog', async () => {
    const user = userEvent.setup({ delay: null })
    const restoreLayout = withLayout()

    try {
      renderWithProviders(
        <>
          <button type="button">Behind the dialog</button>
          <SignApproveModal {...props()} />
        </>,
        { router: false, currentUser: { user: makeUser({ hasSignature: false }) } },
      )
      await readyToDraw()

      const close = screen.getByRole('button', { name: 'Close dialog' })
      close.focus()
      await user.tab({ shift: true })

      // "Focus is still somewhere inside" is what this used to assert, and
      // under plain jsdom it could not fail: with no layout every element
      // reports offsetParent null, the trap sees only the already-focused
      // control, and wrapping to itself looks identical to a trap that was
      // never wired up. `withLayout` gives the trap a real list to walk, so
      // naming the control focus must land on is now a claim with teeth.
      // The footer reads Cancel, then Sign & approve, so the last control is
      // the one that signs.
      expect(screen.getByRole('button', { name: 'Sign & approve' })).toHaveFocus()

      // Backwards out of the first control is exactly where an untrapped
      // dialog leaks: the person lands on a page they cannot see and clicks
      // blind on the list behind.
      expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true)
      expect(screen.getByRole('button', { name: 'Behind the dialog' })).not.toHaveFocus()

      // And forwards off the end comes back to the first control rather than
      // escaping into the browser chrome.
      await user.tab()
      expect(close).toHaveFocus()
    } finally {
      restoreLayout()
    }
  })

  it('does not discard a placed signature when the person clicks beside the dialog', async () => {
    const { user, props: modalProps } = renderModal()
    await readyToDraw()

    await user.click(screen.getByRole('button', { name: 'Draw ink on the page' }))
    await user.click(screen.getByRole('button', { name: 'Place the signature' }))

    // The scrim covers the whole viewport, and a mis-aimed click at a dialog
    // this size is easy. Dismissing on it would throw away the signature the
    // person just drew with no confirmation and no way back to it.
    const scrim = screen.getByRole('dialog').parentElement as HTMLElement
    await user.click(scrim)

    expect(modalProps.onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByRole('dialog')).toHaveTextContent('Page: 2')
    expect(approve).not.toHaveBeenCalled()
  })
})

/**
 * ADDED after mutation testing. Nothing in this file drove the upload that
 * SignatureInput hands up to the dialog, so two of the dialog's own defences
 * were never reached from here: the re-selection guard on `handleModeChange`
 * (the upload path switches to "saved" a second time, on top of the switch
 * the dialog has already made) and the mode-aware confirm guard.
 */
describe('SignApproveModal, uploading a signature from inside the dialog', () => {
  it('keeps the signature it has just uploaded attached to the placement', async () => {
    const { user } = renderModal()
    await readyToDraw()

    await user.click(screen.getByRole('button', { name: 'Saved signature' }))
    expect(screen.getByText('Upload your signature once')).toBeInTheDocument()

    // The profile has one from this point on.
    loadSignature.mockResolvedValue(new Blob(['png'], { type: 'image/png' }))
    await user.upload(signatureFileInput(), PNG())

    // The file really goes to the server, not just into local state.
    await waitFor(() => expect(storeSignature).toHaveBeenCalledTimes(1))
    expect(storeSignature.mock.calls[0][0].name).toBe('signature.png')
    await readyToPlaceSaved()

    await user.click(screen.getByRole('button', { name: 'Place the signature' }))

    // The upload path asks for "saved" mode a second time, after the dialog
    // has already switched. Passed on, that second request clears the image
    // the dialog just attached, and the person drops their new signature onto
    // the page to find an empty box where it should be.
    expect(screen.getByRole('img', { name: 'Signature preview' })).toHaveAttribute(
      'src',
      stub.savedUrl,
    )

    await user.click(screen.getByRole('button', { name: 'Sign & approve' }))
    await waitFor(() => expect(approve).toHaveBeenCalledTimes(1))
    expect(approve.mock.calls[0][1]).toEqual({
      consent: true,
      useSavedSignature: true,
      signaturePage: 2,
      signatureX: 120,
      signatureY: 340,
      signatureWidth: 150,
      signatureHeight: 50,
    })
  })

  it('refuses to approve when the replacement it uploaded is not on the profile afterwards', async () => {
    const { user } = renderModalWithSavedSignature()
    await readyToPlaceSaved()

    // The replacement is accepted and then cannot be read back - storage lost
    // it, or the read raced the write. The dialog is now in saved mode with
    // nothing saved, holding the previous signature in state.
    loadSignature.mockResolvedValue(null)
    await user.upload(signatureFileInput(), PNG('replacement.png'))

    await screen.findByText('Upload your signature once')

    // Saved mode still places on a plain page click, so the person can get
    // this far without noticing anything has gone wrong.
    await user.click(screen.getByRole('button', { name: 'Place the signature' }))
    await user.click(screen.getByRole('button', { name: 'Sign & approve' }))

    // Asking about the ink instead of about the profile is what let this
    // approve as `useSavedSignature: true` for an account holding nothing:
    // the approval is recorded, the PDF carries no signature, and it is
    // reported as a success so nobody downstream learns anything is wrong.
    expect(
      await screen.findByText('Upload or select your saved signature before approving.'),
    ).toBeInTheDocument()
    expect(approve).not.toHaveBeenCalled()
  })
})

describe('SignApproveModal, moving on to another document', () => {
  it('starts clean for the next document instead of carrying the last placement over', async () => {
    const { user, rerender } = renderModal()
    await readyToDraw()

    await user.click(screen.getByRole('button', { name: 'Draw ink on the page' }))
    await user.click(screen.getByRole('button', { name: 'Place the signature' }))
    expect(screen.getByRole('dialog')).toHaveTextContent('Page: 2')

    const next = 'doc-0000-0000-0000-000000000002'
    rerender(
      <SignApproveModal
        {...props({ documentId: next, documentTitle: 'Vendor NDA' })}
      />,
    )
    await readyToDraw()

    // The dialog is keyed on the document id precisely so this cannot happen.
    // Reusing the state would show the second document with the first one's
    // ink and placement still loaded, and approving would stamp a signature
    // sized for a page nobody has looked at.
    expect(screen.getByRole('dialog')).not.toHaveTextContent('Page:')
    expect(screen.getByRole('dialog')).toHaveAccessibleDescription('Vendor NDA')
    expect(loadFile).toHaveBeenCalledWith(next, 'view')

    // And with the placement gone it must refuse, not send the stale one.
    await user.click(screen.getByRole('button', { name: 'Sign & approve' }))
    expect(approve).not.toHaveBeenCalled()
  })
})

describe('signing for somebody else', () => {
  const TOM = { id: 'u-tom', firstName: 'Tom', lastName: 'Becker' }

  it('says whose approval this is, before the button', async () => {
    /*
     * The delegate is the one person who cannot work this out from the
     * screen. The memo is in their queue, the chain names somebody else
     * against the step, and the page they are about to produce will carry
     * that other name under their own mark - so it is said here, beside the
     * control that does it, rather than discovered on the signed PDF.
     */
    renderModal({ actingFor: TOM })
    await readyToDraw()

    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveTextContent('You are approving in place of')
    expect(dialog).toHaveTextContent('Tom Becker')
    expect(dialog).toHaveTextContent('Signed for Tom Becker')
  })

  it('says nothing of the sort when the approval is your own', async () => {
    // The overwhelmingly common case. A warning shown to everybody is a
    // warning nobody reads.
    renderModal()
    await readyToDraw()

    expect(screen.getByRole('dialog')).not.toHaveTextContent('in place of')
  })
})

/**
 * A memo typed in the portal prints a ruled line for every person who will
 * sign it, and the server records where each line landed. Given their own,
 * this dialog starts with the signature on it.
 *
 * The reason it matters that the signature STARTS there rather than merely
 * being allowed there: the server only suppresses the printed name block when
 * the placement falls inside the slot, and nobody lands inside a 150x24 box by
 * dragging. Without this the strip printed three names above three signatures
 * that had each drawn their own name again, somewhere else on the page.
 */
describe('SignApproveModal, signing on the line the memo prints', () => {
  const SLOT: PdfPlacement = {
    page: 1,
    signatureX: 49,
    signatureY: 372,
    signatureWidth: 150,
    signatureHeight: 24,
  }

  it('approves on the offered line without anybody placing anything', async () => {
    const { user } = renderModal({ slot: SLOT })
    await readyToDraw()

    await user.click(screen.getByRole('button', { name: 'Draw ink on the page' }))
    await user.click(screen.getByRole('button', { name: 'Sign & approve' }))

    await waitFor(() =>
      expect(approve).toHaveBeenCalledWith(DOCUMENT_ID, {
        consent: true,
        signatureImage: stub.ink,
        signaturePage: 1,
        signatureX: 49,
        signatureY: 372,
        signatureWidth: 150,
        signatureHeight: 24,
      }),
    )
  })

  it('keeps the ink on the line however the pen travelled', async () => {
    /*
     * Drawing produces the mark; the printed line decides where it goes. The
     * viewer reports the ink's own bounding box, and taking that as the
     * placement left the ruled line blank and the signature somewhere in the
     * prose - on a page that prints this approver's name under that line.
     */
    const { user } = renderModal({ slot: SLOT })
    await readyToDraw()

    await user.click(screen.getByRole('button', { name: 'Draw ink on the page' }))
    await user.click(screen.getByRole('button', { name: 'Place the signature' }))
    await user.click(screen.getByRole('button', { name: 'Sign & approve' }))

    await waitFor(() =>
      expect(approve).toHaveBeenCalledWith(
        DOCUMENT_ID,
        expect.objectContaining({ signaturePage: 1, signatureX: 49 }),
      ),
    )
  })

  it('keeps a saved signature on the line too, wherever it is dropped', async () => {
    // This used to let the drop stand, on the reasoning that dragging is a
    // decision about position. The server settled the question the other way:
    // a signer who has a line signs on it, and a request aimed at another
    // signatory's line is refused. Honouring the drop here would offer a
    // choice whose only outcome is a rejected submission.
    const { user } = renderModalWithSavedSignature({ slot: SLOT })
    await readyToPlaceSaved()

    await user.click(screen.getByRole('button', { name: 'Place the signature' }))
    await user.click(screen.getByRole('button', { name: 'Sign & approve' }))

    await waitFor(() =>
      expect(approve).toHaveBeenCalledWith(
        DOCUMENT_ID,
        expect.objectContaining({ signaturePage: 1, signatureX: 49 }),
      ),
    )
  })

  it('leaves a signer with no line free to place it themselves', async () => {
    // An uploaded memo prints no strip, so there is no line to hold anybody
    // to and nobody else's line to land on. That path must not start
    // refusing or snapping, or every uploaded document becomes unsignable.
    const { user } = renderModalWithSavedSignature({ slot: null })
    await readyToPlaceSaved()

    await user.click(screen.getByRole('button', { name: 'Place the signature' }))
    await user.click(screen.getByRole('button', { name: 'Sign & approve' }))

    await waitFor(() =>
      expect(approve).toHaveBeenCalledWith(
        DOCUMENT_ID,
        expect.objectContaining({ signaturePage: 2, signatureX: 120 }),
      ),
    )
  })

  it('goes back to the line when the ink is cleared, not to nowhere', async () => {
    const { user } = renderModal({ slot: SLOT })
    await readyToDraw()

    await user.click(screen.getByRole('button', { name: 'Draw ink on the page' }))
    await user.click(screen.getByRole('button', { name: 'Place the signature' }))
    await user.click(screen.getByRole('button', { name: 'Clear' }))
    await user.click(screen.getByRole('button', { name: 'Draw ink on the page' }))
    await user.click(screen.getByRole('button', { name: 'Sign & approve' }))

    await waitFor(() =>
      expect(approve).toHaveBeenCalledWith(
        DOCUMENT_ID,
        expect.objectContaining({ signaturePage: 1, signatureX: 49 }),
      ),
    )
  })

  it('offers no line while covering somebody else s approval', async () => {
    /*
     * A delegated signature carries a second name - "Signed for Tom Becker" -
     * which the printed line does not. Starting it on that line would stack
     * that block on top of the name already printed under it, so it is placed
     * by hand like any signature on an uploaded PDF.
     */
    const { user } = renderModal({
      slot: SLOT,
      actingFor: { id: 'u9', firstName: 'Tom', lastName: 'Becker' },
    })
    await readyToDraw()

    await user.click(screen.getByRole('button', { name: 'Draw ink on the page' }))
    await user.click(screen.getByRole('button', { name: 'Sign & approve' }))

    expect(approve).not.toHaveBeenCalled()
    expect(
      screen.getByText('Draw your signature on the document before approving.'),
    ).toBeInTheDocument()
  })

  it('says the memo has already decided where the signature goes', async () => {
    renderModal({ slot: SLOT })
    await readyToDraw()

    expect(
      screen.getAllByText(/on your line at the foot of the memo/).length,
    ).toBeGreaterThan(0)
  })
})

describe('agreeing that this is your signature', () => {
  it('will not sign until the box is ticked, and says so', async () => {
    const { user } = renderModal()
    await readyToDraw()
    // The readiness helper ticks it; take that back.
    await user.click(screen.getByRole('checkbox', { name: SIGNING_CONSENT_STATEMENT }))
    await user.click(screen.getByRole('button', { name: 'Draw ink on the page' }))
    await user.click(screen.getByRole('button', { name: 'Place the signature' }))

    await user.click(screen.getByRole('button', { name: 'Sign & approve' }))

    expect(await screen.findByText('Tick the box to confirm this is your signature.')).toBeInTheDocument()
    expect(approve).not.toHaveBeenCalled()
  })
})
