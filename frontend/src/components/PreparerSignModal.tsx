import { X, AlertCircle } from 'lucide-react'
import { useCallback, useEffect, useId, useState } from 'react'
import {
  blobToDataUrl,
  deleteMySignature,
  fetchMySignature,
  uploadMySignature,
} from '../services/userSignatureApi'
import type { ApproveDocumentPayload } from '../services/approvalApi'
import type { PdfPlacement } from '../utils/pdfCoordinates'
import PdfDocumentViewer, { type PdfPageMetrics } from './PdfDocumentViewer'
import SignatureInput, { type SignatureMode } from './SignatureInput'
import SigningConsent, { CONSENT_MISSING } from './SigningConsent'
import { useCurrentUser } from '../contexts/currentUser'
import { useDialogA11y } from '../hooks/useDialogA11y'
import Button from './ui/Button'

export type PreparerSignaturePayload = ApproveDocumentPayload

interface PreparerSignModalProps {
  open: boolean
  pdfFile: File | Blob | null
  documentTitle: string
  /**
   * The line this memo already prints for the person signing, if it has one.
   *
   * A memo typed in the portal is drawn with a signature strip at its foot -
   * a ruled line per signatory with their name under it - and this is the
   * preparer's own. Given one, the dialog starts with the signature on that
   * line rather than making somebody aim at it: the strip exists precisely so
   * that nobody has to decide where a signature goes.
   *
   * Null for an uploaded PDF, which has no strip and is placed by hand as it
   * always has been.
   */
  slot?: PdfPlacement | null
  /**
   * The memo was attached as a PDF rather than typed in the portal. It was
   * written in Word and prints its own signatories' names and titles, so the
   * server draws nothing under the signature - and neither does the preview.
   */
  attachedPdf?: boolean
  confirmLabel?: string
  /**
   * The caller's own in-flight state, for work that outlives this dialog -
   * an upload it starts before mounting, say. The dialog latches on its own
   * as well; this only ever adds to that.
   */
  submitting?: boolean
  onClose: () => void
  onConfirm: (payload: PreparerSignaturePayload) => void | Promise<void>
}

/**
 * Mount the dialog only while it is open, so its state is created fresh on
 * each open and destroyed on close. It used to stay mounted and clear itself
 * through an effect, which meant a render pass still showing the previous
 * signature and placement.
 */
export default function PreparerSignModal(props: PreparerSignModalProps) {
  if (!props.open) return null
  return <PreparerSignDialog {...props} />
}

function PreparerSignDialog({
  pdfFile,
  slot = null,
  attachedPdf = false,
  documentTitle,
  confirmLabel = 'Sign & submit',
  submitting = false,
  onClose,
  onConfirm,
}: Omit<PreparerSignModalProps, 'open'>) {
  const { user, refetch: refetchUser } = useCurrentUser()
  // Starts on the printed line when the memo has one. The dialog is mounted
  // fresh on each open, so this is a genuine initial value rather than an
  // effect reacting to a prop.
  const [placement, setPlacement] = useState<PdfPlacement | null>(slot)
  const [signatureImage, setSignatureImage] = useState<string | null>(null)
  const [signatureMode, setSignatureMode] = useState<SignatureMode>('draw')
  const [savedSignatureUrl, setSavedSignatureUrl] = useState<string | null>(null)
  const [loadingSignature, setLoadingSignature] = useState(true)
  const [uploadingSignature, setUploadingSignature] = useState(false)
  const [removingSignature, setRemovingSignature] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [consented, setConsented] = useState(false)
  const [inkResetKey, setInkResetKey] = useState(0)
  /* The dialog's own latch. Double-submit protection used to rest entirely
     on the optional `submitting` prop, so a caller that forgot it could file
     the same document twice and somebody downstream had to notice the
     duplicate in the queue and withdraw it by hand. */
  const [confirming, setConfirming] = useState(false)

  const busy = submitting || confirming

  const hasSignature = user?.hasSignature ?? false

  /** Returns the loaded data URL so callers can act on it without a second effect. */
  const loadSavedSignature = useCallback(async () => {
    setLoadingSignature(true)
    try {
      const blob = await fetchMySignature()
      const url = blob ? await blobToDataUrl(blob) : null
      setSavedSignatureUrl(url)
      return url
    } catch {
      setSavedSignatureUrl(null)
      return null
    } finally {
      setLoadingSignature(false)
    }
  }, [])

  useEffect(() => {
    let cancelled = false

    void (async () => {
      const url = await loadSavedSignature()
      // Prefer the saved signature when there is one. This was a second effect
      // reacting to the first one's state, which is the cascade the rule warns
      // about; doing it here keeps it to one pass.
      if (!cancelled && url && hasSignature) setSignatureMode('saved')
    })()

    return () => {
      cancelled = true
    }
  }, [loadSavedSignature, hasSignature])

  const titleId = useId()
  const descId = useId()
  const panelRef = useDialogA11y(true, () => {
    if (!busy) onClose()
  })

  const handlePlacement = (nextPlacement: PdfPlacement, _metrics: PdfPageMetrics) => {
    /*
     * Drawing produces the mark; the printed line decides where it goes.
     *
     * In draw mode the viewer reports the ink's own bounding box as the
     * placement, so the signature landed wherever the pen happened to
     * travel - on a memo that prints a ruled line with this person's name
     * under it, leaving the line blank and the signature somewhere in the
     * prose. The dialog says "it will sit on your line at the foot of the
     * memo", and this is what makes that true.
     *
     * It holds for a dragged saved signature too, which it did not used to.
     * The server now decides this: a signer who has a line signs on it, and a
     * request aimed at somebody else's line is refused outright. Letting the
     * box be dragged would offer a choice that no longer exists, and the only
     * way to act on it would be to have the submission rejected.
     */
    setPlacement(slot ?? nextPlacement)
    setSubmitError(null)
  }

  const handleInkChange = (dataUrl: string | null) => {
    setSignatureImage(dataUrl)
    if (!dataUrl) setPlacement(slot)
  }

  const handleModeChange = (mode: SignatureMode) => {
    /* Re-selecting the mode already showing is not a request to start over.
       Without this, the upload path - which switches to "saved" once the
       file lands, on top of the switch this dialog has already made - would
       detach the signature it had just attached. */
    if (mode === signatureMode) return
    setSignatureMode(mode)
    // Back to the printed line, not to nowhere: changing how the signature is
    // made does not change where it belongs.
    setPlacement(slot)
    setSubmitError(null)
    /* Whichever way the mode changes. Cleared only on the way into draw, a
       drawing survived the switch to "saved" and stood in for a saved
       signature, so the guard below passed and the document was filed as
       `useSavedSignature: true` for an account that may hold nothing. */
    setSignatureImage(null)
    setInkResetKey(key => key + 1)
  }

  const handleClearInk = () => {
    setInkResetKey(key => key + 1)
    setSignatureImage(null)
    setPlacement(slot)
  }

  const handleRemoveSavedSignature = async () => {
    setRemovingSignature(true)
    setUploadError(null)
    try {
      await deleteMySignature()
      await refetchUser()
      setSavedSignatureUrl(null)
      handleModeChange('draw')
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Failed to remove signature')
      throw err
    } finally {
      setRemovingSignature(false)
    }
  }

  const handleUploadSavedSignature = async (file: File) => {
    setUploadingSignature(true)
    setUploadError(null)
    try {
      await uploadMySignature(file)
      await refetchUser()
      await loadSavedSignature()
      setSignatureMode('saved')
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Failed to upload signature')
      throw err
    } finally {
      setUploadingSignature(false)
    }
  }

  const handleConfirm = async () => {
    // A second press while the first submission is still going files the same
    // document twice, and somebody downstream has to withdraw the duplicate.
    if (busy) return

    if (!placement) {
      setSubmitError(
        signatureMode === 'saved'
          ? 'Click or drag your signature onto the document to choose placement.'
          : 'Draw your signature on the document before submitting.',
      )
      return
    }

    /* The two modes are satisfied by different things - ink drawn in this
       session, or an image on the profile - so one question cannot answer
       for both. Asking only about the ink is what let a leftover drawing
       file a document on behalf of a profile with no signature saved. */
    const signature =
      signatureMode === 'saved'
        ? savedSignatureUrl
          ? { useSavedSignature: true as const }
          : null
        : signatureImage
          ? { signatureImage }
          : null

    if (!signature) {
      setSubmitError(
        signatureMode === 'saved'
          ? 'Upload or select your saved signature before submitting.'
          : 'Draw your signature on the document before submitting.',
      )
      return
    }

    if (!consented) {
      setSubmitError(CONSENT_MISSING)
      return
    }

    setConfirming(true)
    setSubmitError(null)

    try {
      await onConfirm({
        ...signature,
        consent: true,
        signaturePage: placement.page,
        signatureX: placement.signatureX,
        signatureY: placement.signatureY,
        signatureWidth: placement.signatureWidth,
        signatureHeight: placement.signatureHeight,
      })
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Failed to submit document')
    } finally {
      /* Released even on failure: a transient upload error must not cost the
         person the signature they drew and the only button that sends it. */
      setConfirming(false)
    }
  }

  /*
   * What the backend will print under the mark, so the editor can show it and
   * keep room for it.
   *
   * The preparer's signature gets the same block as every approver's - name,
   * title, department and the date - and this screen passed nothing, so no
   * room was reserved: a signature dropped at the foot of a page had its
   * block drawn below the bottom edge and lost, on the first mark the memo
   * carries and the one every approver then signs around.
   *
   * `capacity` is the stand-in for the attestation line. The preparer's real
   * block carries only the date there - they are none of Reviewer, Approver
   * or Final Approver - but it is one line either way, and naming it here
   * beats reading the clock during render for a value nothing draws.
   */
  const signoffPreview = user
    ? {
        name: `${user.firstName} ${user.lastName}`.trim(),
        designation: user.designation,
        department: user.department,
        capacity: 'Preparer',
        // Signing where the page already names them: their own printed line,
        // or anywhere on an attached PDF.
        onOwnLine: attachedPdf || Boolean(slot),
      }
    : null

  /*
   * A memo typed in the portal prints a ruled line with this person's name
   * under it, and the signature starts there. Telling them to put it anywhere
   * would be describing the uploaded path at somebody looking at a document
   * that has already decided where the signature goes.
   */
  const placementHint = slot
    ? signatureMode === 'saved'
      ? 'Your signature goes on your line at the foot of the memo.'
      : 'Draw your signature — it will sit on your line at the foot of the memo.'
    : attachedPdf
      ? /* The server finds the preparer's printed name on an attached PDF
           only once it is submitted, and puts the signature on the line
           above it. Said here, so the move does not come as a surprise. */
        signatureMode === 'saved'
        ? 'Place your signature. If your name is printed under a signature line, it goes on that line.'
        : 'Draw your signature. If your name is printed under a signature line, it goes on that line.'
      : signatureMode === 'saved'
        ? 'Drag or click to place your signature, then drag the corner handles to resize'
        : 'Draw your signature anywhere on the document'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-scrim/50 p-3 backdrop-blur-[2px] sm:p-6">
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        tabIndex={-1}
        className="flex max-h-[95vh] w-full max-w-6xl flex-col rounded-card border border-line bg-surface shadow-overlay outline-none"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex flex-shrink-0 items-start justify-between gap-4 border-b border-line-soft px-4 py-4 sm:px-6">
          <div className="min-w-0">
            <h2 id={titleId} className="text-pane font-semibold text-content">
              Sign Document
            </h2>
            <p id={descId} className="mt-0.5 truncate text-meta text-content-muted">
              {documentTitle}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label="Close dialog"
            className="-mr-1.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-control text-content-subtle transition-colors hover:bg-sunken hover:text-content disabled:opacity-50"
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 sm:p-6">
          {!pdfFile ? (
            <div role="alert" className="py-12 text-center">
              <AlertCircle size={20} className="mx-auto mb-3 text-danger-ink" aria-hidden="true" />
              <p className="text-ui font-semibold text-content">No document selected</p>
              <p className="mt-1 text-ui text-content-muted">
                Go back and choose a PDF to sign.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,2fr)_minmax(260px,1fr)] gap-5">
              <PdfDocumentViewer
                file={pdfFile}
                placementMode
                placement={placement}
                onPlacement={handlePlacement}
                signaturePreviewUrl={signatureImage}
                /* Nothing to drop when the memo prints a line for this
                   signer: it is the only place their signature can go, and
                   the server refuses any request aimed at another line. */
                allowSignatureDrop={
                  !slot && signatureMode === 'saved' && Boolean(savedSignatureUrl)
                }
                placementHint={placementHint}
                drawOnPdf={signatureMode === 'draw'}
                inkResetKey={inkResetKey}
                onInkChange={handleInkChange}
                signoffPreview={signoffPreview}
                /* In draw mode the placement is derived from the ink, so
                   dropping one without the other leaves a drawing on the page
                   that nothing accounts for. Removing means starting over. */
                onRemovePlacement={
                  signatureMode === 'draw' ? handleClearInk : () => setPlacement(null)
                }
              />

              <div className="space-y-4">
                <div className="rounded-control border border-line bg-sunken p-3">
                  <p className="mb-2 text-meta font-semibold text-content">Instructions</p>
                  <ol className="list-inside list-decimal space-y-1.5 text-meta text-content-muted">
                    <li>Choose to draw on the PDF or use your saved signature</li>
                    <li>
                      {slot
                        ? 'It is placed on your line at the foot of the memo — drag it if you want it elsewhere'
                        : signatureMode === 'saved'
                          ? 'Click or drag your signature onto the PDF, then resize'
                          : 'Draw your signature anywhere on the page'}
                    </li>
                    <li>Confirm to send it down the approval chain</li>
                  </ol>
                </div>

                {loadingSignature ? (
                  <div className="space-y-2 py-2" aria-hidden="true">
                    <div className="h-8 animate-pulse rounded-control bg-line-soft" />
                    <div className="h-24 animate-pulse rounded-control bg-line-soft" />
                  </div>
                ) : (
                  <SignatureInput
                    mode={signatureMode}
                    onModeChange={handleModeChange}
                    onChange={setSignatureImage}
                    savedSignatureUrl={savedSignatureUrl}
                    hasSavedSignature={Boolean(savedSignatureUrl)}
                    onUploadSavedSignature={handleUploadSavedSignature}
                    onRemoveSavedSignature={handleRemoveSavedSignature}
                    uploading={uploadingSignature}
                    removing={removingSignature}
                    uploadError={uploadError}
                    onClearInk={handleClearInk}
                    hasOwnLine={Boolean(slot)}
                  />
                )}

                {placement && (
                  <div className="space-y-1 rounded-control border border-line p-3 text-meta text-content-muted">
                    <p>
                      <span className="font-semibold text-content">Page:</span>{' '}
                      <span className="tabular-nums">{placement.page}</span>
                    </p>
                    <p>
                      <span className="font-semibold text-content">Position:</span>{' '}
                      <span className="tabular-nums">
                        x {Math.round(placement.signatureX)}, y{' '}
                        {Math.round(placement.signatureY)}
                      </span>
                    </p>
                    <p>
                      <span className="font-semibold text-content">Size:</span>{' '}
                      <span className="tabular-nums">
                        {Math.round(placement.signatureWidth)} ×{' '}
                        {Math.round(placement.signatureHeight)}
                      </span>
                    </p>
                  </div>
                )}

                <SigningConsent
                  checked={consented}
                  onChange={next => {
                    setConsented(next)
                    if (next) setSubmitError(null)
                  }}
                  disabled={busy}
                />

                <div aria-live="polite" aria-atomic="true">
                  {submitError && (
                    <p className="flex items-start gap-1.5 text-meta text-danger-ink">
                      <AlertCircle size={13} className="mt-px flex-shrink-0" aria-hidden="true" />
                      {submitError}
                    </p>
                  )}
                </div>

                <div className="flex flex-col gap-2">
                  <Button onClick={handleConfirm} pending={busy} className="w-full">
                    {confirmLabel}
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={onClose}
                    disabled={busy}
                    className="w-full"
                  >
                    Back
                  </Button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
