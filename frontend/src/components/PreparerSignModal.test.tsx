import { screen, waitFor, fireEvent } from '@testing-library/react'
import { SIGNING_CONSENT_STATEMENT } from './SigningConsent'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { blobToDataUrl, fetchMySignature } from '../services/userSignatureApi'
import { makeUser, renderWithProviders } from '../test/render'
import type { PdfPlacement } from '../utils/pdfCoordinates'
import PreparerSignModal, { type PreparerSignaturePayload } from './PreparerSignModal'
import type { PdfPageMetrics } from './PdfDocumentViewer'

/**
 * The dialog a preparer signs through on their way into the approval
 * workflow - both when first submitting a document and when resubmitting one
 * that came back for revision. Unlike the approver's dialog it does not call
 * the API itself: it hands a signature payload to the screen that owns the
 * upload. That split is where the interesting failures live.
 *
 * What a person stands to lose here is the submission itself. Confirm twice
 * and the same document can be filed twice. Confirm into a failing upload and
 * the dialog has to keep the drawn signature and say why, because the only
 * alternative is drawing it again with no idea whether the first one landed.
 *
 * The PDF surface is stubbed - pdf.js needs a canvas and a worker jsdom does
 * not have - but the stub fires the same two callbacks the real viewer does,
 * so the dialog is driven by the same events a mouse would produce.
 */

/**
 * Every test here mounts a dialog that renders a PDF surface and runs an
 * async profile load. Under the 5s default one of these times out on a loaded
 * machine roughly one run in three - a red suite that says nothing about the
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
    page: 3,
    signatureX: 90,
    signatureY: 620,
    signatureWidth: 150,
    signatureHeight: 50,
  },
  metrics: { pdfWidth: 612, pdfHeight: 792, displayWidth: 612, displayHeight: 792 },
}))

vi.mock('./PdfDocumentViewer', () => ({
  default: function PdfViewerStub({
    file,
    placementHint,
    onPlacement,
    onInkChange,
    signoffPreview,
    onRemovePlacement,
  }: {
    file: Blob | null
    placementHint?: string
    onPlacement?: (placement: PdfPlacement, metrics: PdfPageMetrics) => void
    onInkChange?: (dataUrl: string | null) => void
    signoffPreview?: {
      name?: string | null
      designation?: string | null
      department?: string | null
      capacity?: string | null
      onOwnLine?: boolean
    } | null
    onRemovePlacement?: () => void
  }) {
    return (
      <div>
        <p>{file ? 'Page 1 of the document' : 'No document'}</p>
        <p>{placementHint}</p>
        {/* The block the backend draws under the mark. The real viewer shows
            it to scale and keeps room for it; what matters here is whether
            the dialog tells the viewer it exists at all, which is what it
            was not doing. */}
        <p data-testid="signoff-block">
          {signoffPreview?.onOwnLine
            ? 'on a line the page prints'
            : signoffPreview
            ? [
                signoffPreview.name,
                signoffPreview.designation,
                signoffPreview.department,
                signoffPreview.capacity,
              ]
                .filter(Boolean)
                .join(' | ')
            : 'no block'}
        </p>
        {onRemovePlacement && (
          <button type="button" onClick={onRemovePlacement}>
            Remove signature
          </button>
        )}
        <button type="button" onClick={() => onInkChange?.(stub.ink)}>
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
        <button type="button" onClick={() => onInkChange?.(null)}>
          Erase the ink from the page
        </button>
      </div>
    )
  },
}))

vi.mock('../services/userSignatureApi', () => ({
  fetchMySignature: vi.fn(),
  blobToDataUrl: vi.fn(),
  uploadMySignature: vi.fn(),
  deleteMySignature: vi.fn(),
}))

const loadSignature = vi.mocked(fetchMySignature)
const readSignature = vi.mocked(blobToDataUrl)

const TITLE = 'Warehouse lease extension'
const PDF = () => new Blob(['%PDF-1.7'], { type: 'application/pdf' })

/** A promise the test holds open, so "while the upload is running" is a real state. */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

type PreparerProps = Parameters<typeof PreparerSignModal>[0]
/** The callbacks stay mocks so a test can read what the dialog handed over. */
type PreparerOverrides = Partial<Omit<PreparerProps, 'onClose' | 'onConfirm'>>

function props(overrides: PreparerOverrides = {}) {
  return {
    open: true,
    pdfFile: PDF(),
    documentTitle: TITLE,
    ...overrides,
    onClose: vi.fn(),
    onConfirm: vi.fn<(payload: PreparerSignaturePayload) => Promise<void>>(),
  }
}

/** The preparer has no signature on file, so the dialog opens in draw mode. */
function renderModal(overrides: PreparerOverrides = {}) {
  const modalProps = props(overrides)
  const view = renderWithProviders(<PreparerSignModal {...modalProps} />, {
    router: false,
    currentUser: { user: makeUser({ hasSignature: false }) },
  })
  return { ...view, props: modalProps, user: userEvent.setup({ delay: null }) }
}

/** The preparer already saved a signature to their profile. */
function renderModalWithSavedSignature(overrides: PreparerOverrides = {}) {
  loadSignature.mockResolvedValue(new Blob(['png'], { type: 'image/png' }))
  readSignature.mockResolvedValue(stub.savedUrl)
  const modalProps = props(overrides)
  const view = renderWithProviders(<PreparerSignModal {...modalProps} />, {
    router: false,
    currentUser: { user: makeUser({ hasSignature: true }) },
  })
  return { ...view, props: modalProps, user: userEvent.setup({ delay: null }) }
}

/** The signature panel replaces its skeleton once the profile lookup lands. */
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
  // `restoreMocks` restores spies, but these are module-factory mocks and the
  // props are fresh vi.fn()s per render; clearing keeps "was it submitted?"
  // answerable from this test alone.
  vi.clearAllMocks()
  loadSignature.mockResolvedValue(null)
  readSignature.mockResolvedValue(stub.savedUrl)
})

describe('PreparerSignModal, before anything is signed', () => {
  it('stays out of the DOM until it is opened, and looks nothing up', () => {
    renderModal({ open: false })

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    // "Renders nothing" is only half the contract. The early return has to
    // happen before the effects, or every closed copy of this dialog on a
    // list screen fetches the profile signature on mount.
    expect(loadSignature).not.toHaveBeenCalled()
  })

  it('names itself and the document it is about to put into the workflow', async () => {
    renderModal()

    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveAccessibleName('Sign Document')
    // The title is the only thing distinguishing this from any other document
    // the preparer has open; a screen reader user hears it only if it is the
    // dialog's description.
    expect(dialog).toHaveAccessibleDescription(TITLE)
    expect(dialog).toHaveAttribute('aria-modal', 'true')

    await readyToDraw()
  })

  it('labels the confirm button with what the caller says will happen', async () => {
    renderModal({ confirmLabel: 'Sign & resubmit' })
    await readyToDraw()

    // Submitting for the first time and resubmitting a revision are different
    // acts with different consequences, and the button is the only place the
    // dialog admits which one this is.
    expect(screen.getByRole('button', { name: 'Sign & resubmit' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Sign & submit' })).not.toBeInTheDocument()
  })

  it('defaults to submitting when the caller does not say otherwise', async () => {
    renderModal()
    await readyToDraw()

    expect(screen.getByRole('button', { name: 'Sign & submit' })).toBeInTheDocument()
    // The default has to be the *first* submission's wording. Falling back to
    // the resubmit label would tell a preparer filing a new document that they
    // are re-filing one that came back for revision.
    expect(screen.queryByRole('button', { name: 'Sign & resubmit' })).not.toBeInTheDocument()
  })

  it('says so plainly when there is no document to sign', () => {
    renderModal({ pdfFile: null })

    const alert = screen.getByRole('alert')
    // An empty signing surface with no explanation reads as a broken dialog,
    // and the preparer waits for a PDF that is never coming.
    expect(alert).toHaveTextContent('No document selected')
    expect(alert).toHaveTextContent('Go back and choose a PDF to sign.')
    expect(screen.queryByRole('button', { name: 'Sign & submit' })).not.toBeInTheDocument()
    // No viewer either. Mounting it against a null file is how the real
    // pdf.js surface throws where nobody is catching.
    expect(screen.queryByText('Page 1 of the document')).not.toBeInTheDocument()
    expect(screen.queryByText('No document')).not.toBeInTheDocument()
  })

  /**
   * DEFECT, pinned down rather than wished away.
   *
   * The empty state tells the person to "go back" and then renders no Back
   * button: the whole right-hand column, buttons included, sits inside the
   * `pdfFile` branch. The only exit is the icon-only X in the header.
   *
   * This was written as `it.fails`, which is a trap - `it.fails` passes when
   * the body throws for ANY reason, so a render that broke outright would
   * have kept it green while proving nothing. Asserting the gap exactly is
   * the honest version: it goes red when someone adds the Back button (invert
   * it then), and equally red if anything else here breaks.
   */
  it('leaves the empty state with no Back button, only the header X (known defect)', () => {
    renderModal({ pdfFile: null })

    expect(screen.getByRole('alert')).toHaveTextContent('Go back and choose a PDF to sign.')
    // Told to go back, given nothing to go back with.
    expect(screen.queryByRole('button', { name: 'Back' })).not.toBeInTheDocument()

    const exits = screen.getAllByRole('button')
    expect(exits).toHaveLength(1)
    expect(exits[0]).toHaveAttribute('aria-label', 'Close dialog')
  })

  it('lets the person out of the empty state through the one exit it does give them', async () => {
    const { user, props: modalProps } = renderModal({ pdfFile: null })

    // The test above proves the X is the only exit; it does not prove the X
    // works. A dead X here is a dialog the preparer cannot leave with a mouse
    // at all, which is a worse bug than the missing Back button.
    await user.click(screen.getByRole('button', { name: 'Close dialog' }))
    expect(modalProps.onClose).toHaveBeenCalledTimes(1)

    await user.keyboard('{Escape}')
    // Escape is wired to the panel rather than to the body the empty state
    // replaces, so it survives where Back does not.
    expect(modalProps.onClose).toHaveBeenCalledTimes(2)
    expect(modalProps.onConfirm).not.toHaveBeenCalled()
  })
})

describe('PreparerSignModal, what it refuses to submit', () => {
  it('refuses to submit when nothing has been drawn, and says what is missing', async () => {
    const { user, props: modalProps } = renderModal()
    await readyToDraw()

    await user.click(screen.getByRole('button', { name: 'Sign & submit' }))

    expect(
      await screen.findByText('Draw your signature on the document before submitting.'),
    ).toBeInTheDocument()
    // A document filed with no signature has to be chased down and resubmitted
    // by hand once someone downstream notices.
    expect(modalProps.onConfirm).not.toHaveBeenCalled()
  })

  it('refuses when ink exists but no placement was ever computed for it', async () => {
    const { user, props: modalProps } = renderModal()
    await readyToDraw()

    await user.click(screen.getByRole('button', { name: 'Draw ink on the page' }))
    await user.click(screen.getByRole('button', { name: 'Sign & submit' }))

    // Without a placement the dialog does not know which page or where, and
    // the signature would be burned in wherever the server guesses.
    expect(modalProps.onConfirm).not.toHaveBeenCalled()
    // Refusing silently is its own bug: the person presses the button, sees
    // nothing happen, and presses it again. Say what is missing.
    expect(
      await screen.findByText('Draw your signature on the document before submitting.'),
    ).toBeInTheDocument()
    // Still there to try again with, not cleared out from under them.
    expect(screen.getByRole('button', { name: 'Sign & submit' })).toBeEnabled()
  })

  it('takes the placement and the ink away together when Clear is pressed', async () => {
    const { user, props: modalProps } = renderModal()
    await readyToDraw()

    await user.click(screen.getByRole('button', { name: 'Draw ink on the page' }))
    await user.click(screen.getByRole('button', { name: 'Place the signature' }))
    expect(screen.getByRole('dialog')).toHaveTextContent('Page: 3')

    await user.click(screen.getByRole('button', { name: 'Clear' }))

    // A summary left standing after Clear claims a signature is going onto
    // page 3 of the document when there is no longer one to put there.
    expect(screen.getByRole('dialog')).not.toHaveTextContent('Page:')

    // Placing again is what separates "the summary was hidden" from "the ink
    // is really gone": with a fresh placement the first guard is satisfied,
    // so only a genuinely cleared `signatureImage` stops this from filing the
    // document with the strokes the person just wiped out.
    await user.click(screen.getByRole('button', { name: 'Place the signature' }))
    await user.click(screen.getByRole('button', { name: 'Sign & submit' }))

    expect(modalProps.onConfirm).not.toHaveBeenCalled()
    expect(
      await screen.findByText('Draw your signature on the document before submitting.'),
    ).toBeInTheDocument()
  })

  it('drops the placement when the drawing is erased off the page', async () => {
    const { user, props: modalProps } = renderModal()
    await readyToDraw()

    await user.click(screen.getByRole('button', { name: 'Draw ink on the page' }))
    await user.click(screen.getByRole('button', { name: 'Place the signature' }))
    expect(screen.getByRole('dialog')).toHaveTextContent('Page: 3')

    await user.click(screen.getByRole('button', { name: 'Erase the ink from the page' }))

    // The box was measured around strokes that no longer exist. Keeping it
    // would let the next signature-free confirm sail past the first guard.
    expect(screen.getByRole('dialog')).not.toHaveTextContent('Page:')

    await user.click(screen.getByRole('button', { name: 'Sign & submit' }))
    expect(modalProps.onConfirm).not.toHaveBeenCalled()
    expect(
      await screen.findByText('Draw your signature on the document before submitting.'),
    ).toBeInTheDocument()
  })

  it('clears a standing complaint once the signature is actually placed', async () => {
    const { user } = renderModal()
    await readyToDraw()

    await user.click(screen.getByRole('button', { name: 'Draw ink on the page' }))
    await user.click(screen.getByRole('button', { name: 'Sign & submit' }))
    const complaint = 'Draw your signature on the document before submitting.'
    expect(await screen.findByText(complaint)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Place the signature' }))

    // The complaint has been answered. Leaving it up beside a filled-in
    // placement summary reads as a dialog that will refuse again, and it is
    // in a polite live region, so it is also re-announced as still-broken.
    expect(screen.queryByText(complaint)).not.toBeInTheDocument()
    expect(screen.getByRole('dialog')).toHaveTextContent('Page: 3')
  })

  it('asks a saved-signature preparer to place it, in the words that match what they must do', async () => {
    const { user, props: modalProps } = renderModalWithSavedSignature()
    await readyToPlaceSaved()

    await user.click(screen.getByRole('button', { name: 'Sign & submit' }))

    // Telling someone with a stored signature to "draw" one sends them looking
    // for a pen they do not need.
    expect(
      await screen.findByText(
        'Click or drag your signature onto the document to choose placement.',
      ),
    ).toBeInTheDocument()
    expect(modalProps.onConfirm).not.toHaveBeenCalled()
  })

  it('forgets a placement made for the other signature when the mode is switched', async () => {
    const { user, props: modalProps } = renderModal()
    await readyToDraw()

    await user.click(screen.getByRole('button', { name: 'Draw ink on the page' }))
    await user.click(screen.getByRole('button', { name: 'Place the signature' }))
    expect(screen.getByText('Page:')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Saved signature' }))

    // A box sized around drawn ink is the wrong box for a stamped saved
    // signature; carrying it over would stamp it at the wrong size.
    expect(screen.queryByText('Page:')).not.toBeInTheDocument()

    // The summary vanishing is only the visible half. What matters is that
    // the dialog now genuinely has no placement: confirming has to be
    // refused, not sent with the box measured for the other signature. A
    // component that merely hid the panel would pass the line above and
    // submit anyway.
    await user.click(screen.getByRole('button', { name: 'Sign & submit' }))

    expect(modalProps.onConfirm).not.toHaveBeenCalled()
    expect(
      await screen.findByText(
        'Click or drag your signature onto the document to choose placement.',
      ),
    ).toBeInTheDocument()
  })

  it('changes its placement guidance when the signature mode changes', async () => {
    const { user } = renderModal()
    await readyToDraw()

    const drawHint = 'Draw your signature anywhere on the document'
    const savedHint =
      'Drag or click to place your signature, then drag the corner handles to resize'

    expect(screen.getByText(drawHint)).toBeInTheDocument()
    expect(screen.queryByText(savedHint)).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Saved signature' }))

    // The selected mode is otherwise carried only by the tab's fill colour;
    // this sentence is the one non-colour signal that the mode changed.
    expect(screen.getByText(savedHint)).toBeInTheDocument()
    // Guidance for the mode you are no longer in is worse than none - it
    // tells the person to draw on a surface that has stopped taking ink.
    expect(screen.queryByText(drawHint)).not.toBeInTheDocument()

    // And back again, so this is a live reflection of the mode and not a
    // one-way switch that happens to have been flipped.
    await user.click(screen.getByRole('button', { name: 'Draw' }))
    expect(screen.getByText(drawHint)).toBeInTheDocument()
    expect(screen.queryByText(savedHint)).not.toBeInTheDocument()
  })

  /**
   * FIXED - this test was the inverse of itself, asserting the defect.
   *
   * Switching draw -> saved cleared the placement but left the drawn ink in
   * `signatureImage`, so the guard that should have printed "Upload or
   * select your saved signature before submitting." never fired and the
   * dialog submitted `useSavedSignature: true` for an account holding
   * nothing. It is reachable with a mouse: in saved mode the viewer places
   * on a plain page click, without consulting `allowSignatureDrop`.
   *
   * The ink is now dropped whichever way the mode changes, and the guard
   * asks the question that belongs to the mode selected - saved mode wants
   * an image on the profile, not ink from this session.
   */
  it('refuses to submit a saved-signature payload for an account with nothing saved', async () => {
    const { user, props: modalProps } = renderModal()
    await readyToDraw()

    await user.click(screen.getByRole('button', { name: 'Draw ink on the page' }))
    await user.click(screen.getByRole('button', { name: 'Saved signature' }))
    await user.click(screen.getByRole('button', { name: 'Place the signature' }))
    await user.click(screen.getByRole('button', { name: 'Sign & submit' }))

    // The server has no signature to stamp for this account, so the document
    // enters the workflow unsigned and has to be chased down by hand.
    expect(
      await screen.findByText('Upload or select your saved signature before submitting.'),
    ).toBeInTheDocument()
    expect(modalProps.onConfirm).not.toHaveBeenCalled()
  })

  it('does not carry drawn ink over into the saved mode as a preview', async () => {
    const { user, props: modalProps } = renderModalWithSavedSignature()
    await readyToPlaceSaved()

    await user.click(screen.getByRole('button', { name: 'Draw' }))
    await user.click(screen.getByRole('button', { name: 'Draw ink on the page' }))
    await user.click(screen.getByRole('button', { name: 'Saved signature' }))
    await user.click(screen.getByRole('button', { name: 'Place the signature' }))
    await user.click(screen.getByRole('button', { name: 'Sign & submit' }))

    // With a signature on file the submission does go through - and it must
    // be the stored one. Sending the drawing left in state would file the
    // document under the scribble the person abandoned.
    await waitFor(() => expect(modalProps.onConfirm).toHaveBeenCalledTimes(1))
    expect(modalProps.onConfirm.mock.calls[0][0]).toEqual({
      consent: true,
      useSavedSignature: true,
      signaturePage: 3,
      signatureX: 90,
      signatureY: 620,
      signatureWidth: 150,
      signatureHeight: 50,
    })
  })
})

describe('PreparerSignModal, the confirm path', () => {
  it('hands over the drawn signature with the exact page and box it was placed in', async () => {
    const { user, props: modalProps } = renderModal()
    await readyToDraw()

    await user.click(screen.getByRole('button', { name: 'Draw ink on the page' }))
    await user.click(screen.getByRole('button', { name: 'Place the signature' }))
    await user.click(screen.getByRole('button', { name: 'Sign & submit' }))

    // These numbers are burned into the PDF the approvers will read. A dropped
    // page number puts the preparer's signature across somebody's clause.
    await waitFor(() =>
      expect(modalProps.onConfirm).toHaveBeenCalledWith({
        consent: true,
        signatureImage: stub.ink,
        signaturePage: 3,
        signatureX: 90,
        signatureY: 620,
        signatureWidth: 150,
        signatureHeight: 50,
      }),
    )
  })

  it('hands over a saved signature by reference instead of re-uploading the image', async () => {
    const { user, props: modalProps } = renderModalWithSavedSignature()
    await readyToPlaceSaved()

    await user.click(screen.getByRole('button', { name: 'Place the signature' }))
    await user.click(screen.getByRole('button', { name: 'Sign & submit' }))

    await waitFor(() => expect(modalProps.onConfirm).toHaveBeenCalledTimes(1))
    const payload = modalProps.onConfirm.mock.calls[0][0]
    // Whole-payload equality, not two spot checks: it is the only form that
    // also proves the coordinates survived the saved-signature path, and that
    // no extra field crept in alongside `useSavedSignature`.
    expect(payload).toEqual({
      consent: true,
      useSavedSignature: true,
      signaturePage: 3,
      signatureX: 90,
      signatureY: 620,
      signatureWidth: 150,
      signatureHeight: 50,
    })
    // Round-tripping the stored image through the browser would let a tampered
    // page substitute a different signature for the one on the profile.
    expect(payload).not.toHaveProperty('signatureImage')
  })

  it('keeps the dialog open with the signature intact when the submission fails', async () => {
    const { user, props: modalProps } = renderModal()
    modalProps.onConfirm.mockRejectedValue(new Error('Upload failed: file too large'))
    await readyToDraw()

    await user.click(screen.getByRole('button', { name: 'Draw ink on the page' }))
    await user.click(screen.getByRole('button', { name: 'Place the signature' }))
    await user.click(screen.getByRole('button', { name: 'Sign & submit' }))

    expect(await screen.findByText('Upload failed: file too large')).toBeInTheDocument()
    // Closing on failure would discard the signature they just drew and leave
    // them believing the document had been filed.
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(modalProps.onClose).not.toHaveBeenCalled()
    // The whole placement, not just the word "Page:". A half-reset that kept
    // the label and lost the numbers would have passed the old line here,
    // and it is the numbers the retry hands over.
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveTextContent('Page: 3')
    expect(dialog).toHaveTextContent('Position: x 90, y 620')
    expect(dialog).toHaveTextContent('Size: 150 × 50')
    // And it must be pressable again, or a transient upload failure ends the
    // submission for good.
    expect(screen.getByRole('button', { name: 'Sign & submit' })).toBeEnabled()
  })

  it('lets the person retry the same signature after a failure', async () => {
    const { user, props: modalProps } = renderModal()
    modalProps.onConfirm.mockRejectedValueOnce(new Error('Network request failed'))
    await readyToDraw()

    await user.click(screen.getByRole('button', { name: 'Draw ink on the page' }))
    await user.click(screen.getByRole('button', { name: 'Place the signature' }))
    await user.click(screen.getByRole('button', { name: 'Sign & submit' }))
    await screen.findByText('Network request failed')

    await user.click(screen.getByRole('button', { name: 'Sign & submit' }))

    // The retry has to carry the same placement, not a half-cleared one, or
    // the second attempt files a differently-signed document than the first.
    await waitFor(() => expect(modalProps.onConfirm).toHaveBeenCalledTimes(2))
    // Anchored to the real numbers first: two calls compared only against
    // each other agree just as happily when both are wrong.
    expect(modalProps.onConfirm.mock.calls[1][0]).toEqual({
      consent: true,
      signatureImage: stub.ink,
      signaturePage: 3,
      signatureX: 90,
      signatureY: 620,
      signatureWidth: 150,
      signatureHeight: 50,
    })
    expect(modalProps.onConfirm.mock.calls[1][0]).toEqual(
      modalProps.onConfirm.mock.calls[0][0],
    )
    // And the stale failure must not still be on screen after a good attempt.
    await waitFor(() =>
      expect(screen.queryByText('Network request failed')).not.toBeInTheDocument(),
    )
  })

  it('announces the failure in a live region rather than only painting it red', async () => {
    const { user, props: modalProps } = renderModal()
    modalProps.onConfirm.mockRejectedValue(new Error('Upload failed: file too large'))
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

    await user.click(screen.getByRole('button', { name: 'Sign & submit' }))

    const message = await screen.findByText('Upload failed: file too large')
    // Polite, not assertive: it must not cut off whatever is being read.
    expect(message.closest('[aria-live]')).toHaveAttribute('aria-live', 'polite')
    // Without aria-atomic the region can be re-read as a fragment, so one
    // error replacing another is announced as half a sentence.
    expect(message.closest('[aria-live]')).toHaveAttribute('aria-atomic', 'true')
    // Same node that was empty a moment ago, so this really is an update to a
    // standing region rather than a freshly mounted one.
    expect(message.closest('[aria-live]')).toBe(region)
  })

  it('submits nothing when the person goes back', async () => {
    const { user, props: modalProps } = renderModal()
    await readyToDraw()

    await user.click(screen.getByRole('button', { name: 'Draw ink on the page' }))
    await user.click(screen.getByRole('button', { name: 'Place the signature' }))
    await user.click(screen.getByRole('button', { name: 'Back' }))

    expect(modalProps.onClose).toHaveBeenCalledTimes(1)
    // Back sits directly under the confirm button; mistaking one for the other
    // would file the document the person was trying to go and fix.
    expect(modalProps.onConfirm).not.toHaveBeenCalled()
  })

  it('does not submit again while the caller reports a submission in flight', async () => {
    const { user, props: modalProps } = renderModal({ submitting: true })
    await readyToDraw()

    await user.click(screen.getByRole('button', { name: 'Draw ink on the page' }))
    await user.click(screen.getByRole('button', { name: 'Place the signature' }))

    const confirm = screen.getByRole('button', { name: 'Sign & submit' })
    // Genuinely disabled, not merely greyed: a styled-only button still fires
    // and files the same document a second time.
    expect(confirm).toBeDisabled()
    // Greying out is invisible to a screen reader mid-upload. Without this the
    // person hears an ordinary button that simply does not respond.
    expect(confirm).toHaveAttribute('aria-busy', 'true')
    await user.click(confirm)

    expect(modalProps.onConfirm).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Close dialog' })).toBeDisabled()
  })

  /**
   * FIXED - this test was the inverse of itself, asserting the defect.
   *
   * The dialog kept no in-flight state of its own: `submitting` is an
   * optional prop, so a caller that omitted it got a confirm button that
   * stayed live and fired `onConfirm` again on every press while the first
   * upload was still running - a duplicate document in the approval queue
   * for somebody downstream to notice and withdraw by hand.
   *
   * It now latches internally, the way the approver's dialog always has. The
   * prop still adds to that, for a caller whose work outlives the dialog.
   */
  it('submits once when the button is pressed twice and the caller passes no submitting flag', async () => {
    const { user, props: modalProps } = renderModal()
    const gate = deferred<void>()
    modalProps.onConfirm.mockReturnValue(gate.promise)
    await readyToDraw()

    await user.click(screen.getByRole('button', { name: 'Draw ink on the page' }))
    await user.click(screen.getByRole('button', { name: 'Place the signature' }))

    const confirm = screen.getByRole('button', { name: 'Sign & submit' })
    await user.click(confirm)

    // Genuinely disabled, not merely greyed: a styled-only button still fires
    // and files the same document a second time.
    expect(confirm).toBeDisabled()
    // Greying out is invisible to a screen reader mid-upload. Without this
    // the person hears an ordinary button that simply does not respond.
    expect(confirm).toHaveAttribute('aria-busy', 'true')

    await user.click(confirm)
    gate.resolve()

    // One document filed, not two.
    await waitFor(() => expect(modalProps.onConfirm).toHaveBeenCalledTimes(1))
    // And the payload is the real one, so this is a submission that latched
    // rather than a button that stopped working.
    expect(modalProps.onConfirm.mock.calls[0][0]).toEqual({
      consent: true,
      signatureImage: stub.ink,
      signaturePage: 3,
      signatureX: 90,
      signatureY: 620,
      signatureWidth: 150,
      signatureHeight: 50,
    })
    // The latch has to come off with the request. Left on, a dialog the
    // caller keeps open after a failure can never be retried.
    await waitFor(() => expect(confirm).not.toHaveAttribute('aria-busy'))
    expect(confirm).toBeEnabled()
  })

  it('locks its own exits while a submission it started is still running', async () => {
    const { user, props: modalProps } = renderModal()
    const gate = deferred<void>()
    modalProps.onConfirm.mockReturnValue(gate.promise)
    await readyToDraw()

    await user.click(screen.getByRole('button', { name: 'Draw ink on the page' }))
    await user.click(screen.getByRole('button', { name: 'Place the signature' }))
    await user.click(screen.getByRole('button', { name: 'Sign & submit' }))

    // Leaving mid-upload unmounts the dialog with the outcome unknown: the
    // document may still be filed, and the preparer cannot find out from
    // here. The caller used to have to pass `submitting` to get this.
    expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Close dialog' })).toBeDisabled()

    await user.keyboard('{Escape}')
    expect(modalProps.onClose).not.toHaveBeenCalled()

    gate.resolve()
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Back' })).toBeEnabled(),
    )
  })

  it('does not discard a placed signature when the person clicks beside the dialog', async () => {
    const { user, props: modalProps } = renderModal()
    await readyToDraw()

    await user.click(screen.getByRole('button', { name: 'Draw ink on the page' }))
    await user.click(screen.getByRole('button', { name: 'Place the signature' }))

    // The scrim covers the whole viewport, and a mis-aimed click at a dialog
    // this size is easy. Dismissing on it would throw away the signature the
    // person just drew, with no confirmation and no way back to it.
    const scrim = screen.getByRole('dialog').parentElement as HTMLElement
    await user.click(scrim)

    expect(modalProps.onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByRole('dialog')).toHaveTextContent('Page: 3')
    expect(modalProps.onConfirm).not.toHaveBeenCalled()
  })
})

describe('PreparerSignModal, keyboard and focus', () => {
  it('closes on Escape while nothing is in flight', async () => {
    const { user, props: modalProps } = renderModal()
    await readyToDraw()

    await user.keyboard('{Escape}')

    expect(modalProps.onClose).toHaveBeenCalledTimes(1)
  })

  it('ignores Escape while the caller reports a submission in flight', async () => {
    const { user, props: modalProps } = renderModal({ submitting: true })
    await readyToDraw()

    await user.keyboard('{Escape}')

    // Unmounting mid-upload leaves the outcome unknown: the document may still
    // be filed, and the preparer has no way to find out from here.
    expect(modalProps.onClose).not.toHaveBeenCalled()
  })

  it('gives the icon-only close control a name and hides the decorative glyph', async () => {
    renderModal()

    const close = screen.getByRole('button', { name: 'Close dialog' })

    // `getByRole(..., { name })` already selected on the name, so re-asserting
    // it here could never fail. What is worth proving is *why* the name has
    // to be authored: the control has no text of its own, so with the
    // aria-label gone it is announced as a bare "button".
    expect(close).toHaveTextContent('')
    expect(close).toHaveAttribute('aria-label', 'Close dialog')
    // An unhidden glyph adds nothing to the name and is one more thing a
    // screen reader stops on.
    expect(close.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')

    await readyToDraw()
  })

  it('closes on the header X without submitting what was placed', async () => {
    const { user, props: modalProps } = renderModal()
    await readyToDraw()

    await user.click(screen.getByRole('button', { name: 'Draw ink on the page' }))
    await user.click(screen.getByRole('button', { name: 'Place the signature' }))
    await user.click(screen.getByRole('button', { name: 'Close dialog' }))

    // Nothing else here presses the X. It is named, focusable and disabled
    // mid-upload, all of which would pass on a button wired to nothing - and
    // in the empty state it is the only pointer exit the dialog offers.
    expect(modalProps.onClose).toHaveBeenCalledTimes(1)
    expect(modalProps.onConfirm).not.toHaveBeenCalled()
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
          <PreparerSignModal
            open={open}
            pdfFile={PDF()}
            documentTitle={TITLE}
            onClose={() => setOpen(false)}
            onConfirm={() => {}}
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
    // form away underneath the dialog.
    expect(document.body.style.overflow).toBe('hidden')

    await readyToDraw()
    await user.click(screen.getByRole('button', { name: 'Back' }))

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
          <PreparerSignModal {...props()} />
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
      expect(screen.getByRole('button', { name: 'Back' })).toHaveFocus()

      // Backwards out of the first control is exactly where an untrapped
      // dialog leaks: the person lands on a page they cannot see and types
      // blind into the form behind.
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
})

/**
 * What the backend prints under the preparer's mark.
 *
 * The approver's dialog has always told the viewer about this block; this one
 * passed nothing, on the belief that a preparer's signature was stamped bare.
 * It is not - documents.service draws the same name, title, department and
 * date every approver gets - so the editor reserved no room for it and a
 * signature dropped at the foot of a page had its block drawn off the bottom
 * edge, on the first mark the memo carries.
 */
describe('the block drawn under the signature', () => {
  it('tells the viewer whose name goes under the mark', async () => {
    renderModal()
    await readyToDraw()

    // Name, title and department, plus the attestation line the date fills.
    expect(screen.getByTestId('signoff-block')).toHaveTextContent(
      'Ayesha Khan | Deputy Manager | Finance | Preparer',
    )
  })

  it('counts the same number of lines the backend will draw', async () => {
    // Three: the name, "designation, department", and the date. The height is
    // what the editor reserves, so a line counted here and not drawn there -
    // or the reverse - moves the signature away from where it was put.
    renderModal()
    await readyToDraw()

    const block = screen.getByTestId('signoff-block').textContent ?? ''
    const [name, designation, department, attestation] = block.split(' | ')

    expect(name).toBe('Ayesha Khan')
    expect([designation, department].join(', ')).toBe('Deputy Manager, Finance')
    expect(attestation).toBeTruthy()
  })

  it('draws nothing under the mark on an attached PDF, which names its own signatories', async () => {
    // A memo written in Word prints each signatory's name and title under
    // the line they sign on; the backend puts the signature on alone there.
    renderModal({ attachedPdf: true })
    await readyToDraw()

    expect(screen.getByTestId('signoff-block')).toHaveTextContent('on a line the page prints')
  })
})

describe('removing a placed signature', () => {
  it('is offered, and drops the placement', async () => {
    // The approver's dialog offers this; the preparer's did not, so a
    // signature put in the wrong place could be moved but never taken back
    // off - and in saved-signature mode the only way out was switching mode,
    // which throws the signature away with it.
    const { user } = renderModal()
    await readyToDraw()

    await user.click(screen.getByRole('button', { name: 'Draw ink on the page' }))
    await user.click(screen.getByRole('button', { name: 'Place the signature' }))

    expect(await screen.findByText('Position:')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Remove signature' }))

    await waitFor(() => {
      expect(screen.queryByText('Position:')).not.toBeInTheDocument()
    })
  })

  it('keeps the drawn signature, so it can be placed again', async () => {
    // Removing where it went is not removing what was drawn. Clearing both
    // would send the preparer back to the canvas for a signature that was
    // never the problem.
    const { user } = renderModal()
    await readyToDraw()

    await user.click(screen.getByRole('button', { name: 'Draw ink on the page' }))
    await user.click(screen.getByRole('button', { name: 'Place the signature' }))
    await user.click(screen.getByRole('button', { name: 'Remove signature' }))

    await user.click(screen.getByRole('button', { name: 'Place the signature' }))

    expect(await screen.findByText('Position:')).toBeInTheDocument()
  })
})

/**
 * A memo typed in the portal prints a ruled line with the signer's name under
 * it. The signature belongs there, and the dialog should not make somebody
 * aim at a position the document already knows.
 */
describe('signing on a line the memo already prints', () => {
  const slot = {
    page: 1,
    signatureX: 49,
    signatureY: 670,
    signatureWidth: 150,
    signatureHeight: 24,
  }

  it('starts with the signature on that line', async () => {
    renderModal({ slot })

    // The placement panel reports the box, and it is the slot - not a default
    // box waiting somewhere in the middle of the page.
    expect(await screen.findByText(/x 49/)).toBeInTheDocument()
    expect(screen.getByText(/150 × 24/)).toBeInTheDocument()
  })

  it('says the line is already chosen rather than telling them to aim', async () => {
    renderModal({ slot })

    // Said twice on purpose - once beside the page, once in the numbered
    // instructions - so both are asserted rather than one being a surprise.
    expect(
      await screen.findAllByText(/on your line at the foot of the memo/i),
    ).toHaveLength(2)
  })

  it('still tells an uploaded memo to place it anywhere', async () => {
    renderModal({})

    expect(
      (await screen.findAllByText(/draw your signature anywhere/i)).length,
    ).toBeGreaterThan(0)
  })
})

describe('agreeing that this is your signature', () => {
  it('will not sign until the box is ticked, and says so', async () => {
    const { user, props: modalProps } = renderModal()
    await readyToDraw()
    // The readiness helper ticks it; take that back.
    await user.click(screen.getByRole('checkbox', { name: SIGNING_CONSENT_STATEMENT }))
    await user.click(screen.getByRole('button', { name: 'Draw ink on the page' }))
    await user.click(screen.getByRole('button', { name: 'Place the signature' }))

    await user.click(screen.getByRole('button', { name: 'Sign & submit' }))

    expect(await screen.findByText('Tick the box to confirm this is your signature.')).toBeInTheDocument()
    expect(modalProps.onConfirm).not.toHaveBeenCalled()
  })
})

describe('signing an attached PDF', () => {
  it('says the signature goes on the line above the preparer\u2019s printed name, if there is one', async () => {
    renderModal({ attachedPdf: true })
    await readyToDraw()
    expect(screen.getByText(/If your name is printed under a signature line, it goes on that line\./)).toBeInTheDocument()
  })
})
