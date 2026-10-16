import { X, AlertCircle } from 'lucide-react'
import { useCallback, useEffect, useId, useState } from 'react'
import { approveDocument } from '../services/approvalApi'
import { fetchDocumentFile } from '../services/documentDetailApi'
import {
  blobToDataUrl,
  deleteMySignature,
  fetchMySignature,
  uploadMySignature,
} from '../services/userSignatureApi'
import type { PdfPlacement } from '../utils/pdfCoordinates'
import PdfDocumentViewer, { type PdfPageMetrics } from './PdfDocumentViewer'
import SignatureInput, { type SignatureMode } from './SignatureInput'
import SigningConsent, { CONSENT_MISSING } from './SigningConsent'
import { useCurrentUser } from '../contexts/currentUser'
import { useDialogA11y } from '../hooks/useDialogA11y'
import Button from './ui/Button'

interface SignApproveModalProps {
  open: boolean
  documentId: string
  documentTitle: string
  /**
   * Whose approval this is, when it is not the signer's own.
   *
   * Null in the ordinary case. Set while covering somebody's approvals, and
   * said before the button rather than after: the page this produces carries
   * BOTH names - the mark is the signer's, and a line beneath it reads
   * "Signed for" the person who is away - and somebody putting their
   * signature on a memo is entitled to know whose approval they are giving.
   */
  actingFor?: { id: string; firstName: string; lastName: string } | null
  /**
   * The ruled line this memo prints for this approver, if it prints one.
   *
   * A memo typed in the portal ends with a signature strip naming everybody
   * who will sign it, and the server records where each line landed. Given
   * that line the dialog starts with the signature on it, and the server
   * draws only the date underneath, because the name and the role are
   * already printed there.
   *
   * Null for an uploaded PDF, and null while covering somebody else's
   * approval - a delegated signature carries a second name that the printed
   * line does not, so it is placed by hand and gets the full block.
   */
  slot?: PdfPlacement | null
  /**
   * The memo was attached as a PDF rather than typed in the portal. It was
   * written in Word and prints its own signatories' names and titles, so the
   * server draws nothing under the signature - and neither does the preview.
   */
  attachedPdf?: boolean
  onClose: () => void
  onSuccess: () => void
}

/**
 * Mount the dialog only while it is open, so its state is created fresh on
 * each open and destroyed on close. It used to stay mounted and clear itself
 * through an effect, which meant a render pass with the previous approval's
 * placement and signature still on screen.
 */
export default function SignApproveModal(props: SignApproveModalProps) {
  if (!props.open) return null
  return <SignApproveDialog key={props.documentId} {...props} />
}

function SignApproveDialog({
  documentId,
  documentTitle,
  actingFor = null,
  slot: offeredSlot = null,
  attachedPdf = false,
  onClose,
  onSuccess,
}: Omit<SignApproveModalProps, 'open'>) {
  // Nobody signs on somebody else's printed line, and a delegated signature
  // is exactly that: the line under it names the person who is away.
  const slot = actingFor ? null : offeredSlot
  const { user, refetch: refetchUser } = useCurrentUser()
  const [pdfFile, setPdfFile] = useState<Blob | null>(null)
  const [loadingPdf, setLoadingPdf] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [placement, setPlacement] = useState<PdfPlacement | null>(slot)
  const [signatureImage, setSignatureImage] = useState<string | null>(null)
  const [signatureMode, setSignatureMode] = useState<SignatureMode>('draw')
  const [savedSignatureUrl, setSavedSignatureUrl] = useState<string | null>(null)
  const [loadingSignature, setLoadingSignature] = useState(true)
  const [uploadingSignature, setUploadingSignature] = useState(false)
  const [removingSignature, setRemovingSignature] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [inkResetKey, setInkResetKey] = useState(0)
  const [consented, setConsented] = useState(false)

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

    fetchDocumentFile(documentId, 'view')
      .then(blob => {
        if (!cancelled) setPdfFile(blob)
      })
      .catch(err => {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : 'Failed to load PDF')
          setPdfFile(null)
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingPdf(false)
      })

    return () => {
      cancelled = true
    }
  }, [documentId, loadSavedSignature, hasSignature])

  const titleId = useId()
  const descId = useId()
  const panelRef = useDialogA11y(true, () => {
    if (!submitting) onClose()
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
    // Back to the offered line, not to nowhere. Clearing the ink is starting
    // the signature again, not declining the line the memo prints.
    if (!dataUrl) setPlacement(slot)
  }

  const handleModeChange = (mode: SignatureMode) => {
    /* Re-selecting the mode already showing is not a request to start over.
       Without this, the upload path - which switches to "saved" once the
       file lands, on top of the switch this dialog has already made - would
       detach the signature it had just attached. */
    if (mode === signatureMode) return
    setSignatureMode(mode)
    setPlacement(slot)
    setSubmitError(null)
    /* Whichever way the mode changes. Cleared only on the way into draw, a
       drawing survived the switch to "saved" and stood in for a saved
       signature, so the guard below passed and the approval went out as
       `useSavedSignature: true` for an account that may hold nothing. */
    setSignatureImage(null)
    setInkResetKey(key => key + 1)
  }

  const handleClearInk = () => {
    setInkResetKey(key => key + 1)
    setSignatureImage(null)
    // Back to the line the memo prints for this approver, where there is one.
    // Starting the signature again is not declining the line.
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

  const handleApprove = async () => {
    // One approval per press, whatever the button's disabled state does.
    if (submitting) return

    if (!placement) {
      setSubmitError(
        signatureMode === 'saved'
          ? 'Click or drag your signature onto the document to choose placement.'
          : 'Draw your signature on the document before approving.',
      )
      return
    }

    /* The two modes are satisfied by different things - ink drawn in this
       session, or an image on the profile - so one question cannot answer
       for both. Asking only about the ink is what let a leftover drawing
       approve on behalf of a profile with no signature saved. */
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
          ? 'Upload or select your saved signature before approving.'
          : 'Draw your signature on the document before approving.',
      )
      return
    }

    if (!consented) {
      setSubmitError(CONSENT_MISSING)
      return
    }

    setSubmitting(true)
    setSubmitError(null)

    try {
      await approveDocument(documentId, {
        ...signature,
        consent: true,
        signaturePage: placement.page,
        signatureX: placement.signatureX,
        signatureY: placement.signatureY,
        signatureWidth: placement.signatureWidth,
        signatureHeight: placement.signatureHeight,
      })
      onSuccess()
      onClose()
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Approval failed')
    } finally {
      setSubmitting(false)
    }
  }

  /*
   * What the backend will print under the mark, so the editor can show it and
   * keep room for it.
   *
   * `capacity` stands in for the capacity-and-date line every approval gets.
   * Its value is not read - the block's height counts that line once whether
   * it is filled by the capacity, the date or both - so the real capacity is
   * not fetched and today's date is not stamped here, which would be a clock
   * read during render for a number that cannot change.
   */
  const signoffPreview = user
    ? {
        name: `${user.firstName} ${user.lastName}`.trim(),
        designation: user.designation,
        department: user.department,
        capacity: 'Approver',
        /* A delegated signature carries a fourth line - "Signed for ..." -
           and the block is that much taller. Left out, the editor reserves
           one line too little and the backend moves the signature up to fit,
           which is the very mismatch the reservation exists to prevent. */
        onBehalfOf: actingFor
          ? `${actingFor.firstName} ${actingFor.lastName}`.trim()
          : null,
        // Signing where the page already names them: their own printed line,
        // or anywhere on an attached PDF. Not a delegate: the name printed
        // there is the person they cover, so their block says who they are.
        onOwnLine: (attachedPdf && !actingFor) || Boolean(slot),
      }
    : null

  /*
   * What this document is asking for. A memo that prints a line with this
   * approver's name under it has already decided where their signature goes,
   * and telling them to put it anywhere describes the uploaded path at
   * somebody looking at a page that does not work that way.
   */
  const placementHint = slot
    ? signatureMode === 'saved'
      ? 'Your signature goes on your line at the foot of the memo.'
      : 'Draw your signature — it will sit on your line at the foot of the memo.'
    : signatureMode === 'saved'
      ? 'Drag or click to place your signature, then drag the corner handles to resize'
      : 'Draw your signature anywhere on the document'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-scrim/50 backdrop-blur-[2px] sm:p-6">
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        tabIndex={-1}
        className="flex h-full w-full max-w-6xl flex-col bg-surface shadow-overlay outline-none sm:h-auto sm:max-h-[95vh] sm:rounded-card sm:border sm:border-line"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex flex-shrink-0 items-start justify-between gap-4 border-b border-line-soft px-4 py-4 sm:px-6">
          <div className="min-w-0">
            <h2 id={titleId} className="text-pane font-semibold text-content">
              Sign &amp; approve
            </h2>
            <p id={descId} className="mt-0.5 truncate text-meta text-content-muted">
              {documentTitle}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            aria-label="Close dialog"
            className="-mr-1.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-control text-content-subtle transition-colors hover:bg-sunken hover:text-content disabled:opacity-50"
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 sm:p-6">
          {loadingPdf ? (
            <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(260px,1fr)]">
              <div
                className="min-h-[420px] animate-pulse rounded-card bg-line-soft"
                aria-hidden="true"
              />
              <div className="space-y-4" aria-hidden="true">
                <div className="h-24 animate-pulse rounded-control bg-line-soft" />
                <div className="h-40 animate-pulse rounded-control bg-line-soft" />
                <div className="h-10 animate-pulse rounded-control bg-line-soft" />
              </div>
              <div aria-live="polite" className="sr-only">
                Loading document
              </div>
            </div>
          ) : loadError ? (
            <div role="alert" className="py-12 text-center">
              <AlertCircle
                size={20}
                className="mx-auto mb-3 text-danger-ink"
                aria-hidden="true"
              />
              <p className="text-ui font-semibold text-content">
                Could not load this document
              </p>
              <p className="mx-auto mt-1 max-w-sm text-ui text-content-muted">
                {loadError}
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
                {actingFor && (
                  /* Said here, beside the button, rather than anywhere else on
                     the screen: this is the last moment before a signature
                     with somebody else's name under it becomes part of an
                     approved document. */
                  <div className="rounded-control border border-warning-line bg-warning-soft px-3 py-2.5">
                    <p className="text-meta leading-relaxed text-warning-ink">
                      You are approving in place of{' '}
                      <span className="font-semibold">
                        {actingFor.firstName} {actingFor.lastName}
                      </span>
                      , whose approvals you are covering. Your signature is
                      recorded, with a line beneath it reading &ldquo;Signed for{' '}
                      {actingFor.firstName} {actingFor.lastName}&rdquo;.
                    </p>
                  </div>
                )}

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
                    <li>Confirm to approve the document</li>
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
                        x {Math.round(placement.signatureX)}, y {Math.round(placement.signatureY)}
                      </span>
                    </p>
                    <p>
                      <span className="font-semibold text-content">Size:</span>{' '}
                      <span className="tabular-nums">
                        {Math.round(placement.signatureWidth)} × {Math.round(placement.signatureHeight)}
                      </span>
                    </p>
                  </div>
                )}

              </div>
            </div>
          )}
        </div>

        {/*
          * The decision, always on screen. It used to sit at the foot of the
          * right-hand column, which on a phone is below the whole PDF and the
          * instructions - somebody signing had to scroll past everything to
          * find the button, with nothing telling them it was there.
          */}
        {!loadingPdf && !loadError && (
          <div className="flex-shrink-0 space-y-2.5 border-t border-line-soft bg-surface px-4 py-3 sm:px-6">
            <SigningConsent
              checked={consented}
              onChange={next => {
                setConsented(next)
                if (next) setSubmitError(null)
              }}
              disabled={submitting}
            />

            <div aria-live="polite" aria-atomic="true">
              {submitError && (
                <p className="flex items-start gap-1.5 text-meta text-danger-ink">
                  <AlertCircle
                    size={13}
                    className="mt-px flex-shrink-0"
                    aria-hidden="true"
                  />
                  {submitError}
                </p>
              )}
            </div>

            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button
                variant="secondary"
                onClick={onClose}
                disabled={submitting}
                className="w-full sm:w-auto"
              >
                Cancel
              </Button>
              <Button
                onClick={handleApprove}
                pending={submitting}
                className="w-full sm:w-auto"
              >
                Sign &amp; approve
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
