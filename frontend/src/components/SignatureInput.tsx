import { Check, Eraser, Trash2, Upload } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import Button from './ui/Button'

export type SignatureMode = 'draw' | 'saved'

const MODES: { value: SignatureMode; label: string }[] = [
  { value: 'draw', label: 'Draw' },
  { value: 'saved', label: 'Saved signature' },
]

/* Enforced here as well as by the picker's `accept`, because a file dragged
   onto the panel never meets that filter: without this, a 30 MB scan is
   uploaded in full and refused by the server a minute later. The numbers are
   the ones the panel promises in "PNG or JPEG, up to 2 MB". */
const ACCEPTED_TYPES = ['image/png', 'image/jpeg']
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024

interface SignatureInputProps {
  mode: SignatureMode
  onModeChange: (mode: SignatureMode) => void
  onChange: (dataUrl: string | null) => void
  savedSignatureUrl: string | null
  hasSavedSignature: boolean
  onUploadSavedSignature: (file: File) => Promise<void>
  /** Deletes the signature stored on the profile, not just this session's use of it. */
  onRemoveSavedSignature: () => Promise<void>
  uploading?: boolean
  removing?: boolean
  uploadError?: string | null
  onClearInk?: () => void
  /**
   * True when the document prints a ruled line for this signer.
   *
   * It changes one sentence, and it has to: telling somebody to sign anywhere
   * on a page that has already decided where their signature goes reads as a
   * contradiction of the instruction three lines above it.
   */
  hasOwnLine?: boolean
}

export default function SignatureInput({
  mode,
  onModeChange,
  onChange,
  savedSignatureUrl,
  hasSavedSignature,
  onUploadSavedSignature,
  onRemoveSavedSignature,
  uploading = false,
  removing = false,
  uploadError = null,
  hasOwnLine = false,
  onClearInk,
}: SignatureInputProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  /* Confirmed inline rather than in a dialog: this sits inside a modal that
     already traps focus, and a second trap over the first is how a keyboard
     user gets stuck. */
  const [confirmingRemove, setConfirmingRemove] = useState(false)
  /* A file refused before it was ever sent has no parent request to report
     it, so the panel has to say why itself - otherwise dropping a PDF looks
     exactly like dropping nothing. */
  const [refusedFile, setRefusedFile] = useState<string | null>(null)

  /* The bar has to outlive the press that starts the deletion. Torn down in
     the same tick, `removing` has no control left to spin on and the screen
     snaps back to looking exactly as it did, so the person presses Remove a
     second time. */
  const showRemoveConfirm = confirmingRemove || removing
  /* The local refusal wins while it stands: it is always the newer of the
     two, and the parent's message is about a file the person has already
     replaced. Choosing a valid file clears both. */
  const errorMessage = refusedFile ?? uploadError

  useEffect(() => {
    if (mode === 'saved' && savedSignatureUrl) {
      onChange(savedSignatureUrl)
    }
  }, [mode, savedSignatureUrl, onChange])

  const handleModeChange = (nextMode: SignatureMode) => {
    /* Tapping the mode you are already in is a reflex - people confirm the
       tab before they start. Passing it on would have the parent drop the
       placement and wipe the ink, so a signature already drawn on the PDF
       disappears with no warning and no way back. */
    if (nextMode === mode) return
    onModeChange(nextMode)
    if (nextMode === 'draw') {
      onChange(null)
    }
  }

  const handleRemove = async () => {
    setConfirmingRemove(false)
    try {
      await onRemoveSavedSignature()
    } catch {
      // Parent surfaces the failure in the same place upload errors appear.
    }
  }

  const handleFile = async (file: File | undefined) => {
    if (!file) return
    // A second file sent while the first is still going means whichever lands
    // last wins, and the person cannot tell which signature they kept.
    if (uploading) return

    setRefusedFile(null)
    if (!ACCEPTED_TYPES.includes(file.type)) {
      setRefusedFile(`${file.name} is not a PNG or JPEG image.`)
      return
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setRefusedFile(`${file.name} is larger than 2 MB.`)
      return
    }

    await onUploadSavedSignature(file)
    onModeChange('saved')
  }

  const handleUploadInput = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    try {
      await handleFile(file)
    } catch {
      // Parent surfaces upload errors.
    }
  }

  const handleDropUpload = async (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setDragging(false)
    try {
      const file = event.dataTransfer.files?.[0]
      await handleFile(file)
    } catch {
      // Parent surfaces upload errors.
    }
  }

  return (
    <div className="space-y-3">
      {/* The two modes send completely different requests, so which one is
          selected cannot be carried by fill colour alone: `aria-pressed`
          says it out loud, and the tick says it to anyone who cannot
          separate the accent from the surface. */}
      <div
        role="group"
        aria-label="How to sign"
        className="flex rounded-control border border-line p-1 bg-surface"
      >
        {MODES.map(({ value, label }) => {
          const active = mode === value
          return (
            <button
              key={value}
              type="button"
              onClick={() => handleModeChange(value)}
              aria-pressed={active}
              className={`flex flex-1 items-center justify-center gap-1.5 rounded-control px-3 py-1.5 text-meta font-medium transition-colors ${
                active
                  ? // Already selected, so no hover: pressing the segment you
                    // are on does nothing, and the house toggle (ThemeToggle)
                    // draws its pressed state the same way.
                    'bg-accent text-on-accent'
                  : 'text-content-muted hover:bg-sunken hover:text-content active:bg-line-soft'
              }`}
            >
              {/* Held in place rather than mounted on selection, so the two
                  labels do not jump sideways as the mode changes. */}
              <Check
                size={13}
                aria-hidden="true"
                className={active ? 'flex-shrink-0' : 'invisible flex-shrink-0'}
              />
              {label}
            </button>
          )
        })}
      </div>

      {/* Somebody with nothing saved lands on Draw, and nothing told them a
          saved signature exists - so every memo meant drawing again. Said
          once, here, with the way to fix it one press away. Drawing still
          works: nobody is stopped from signing for want of a saved image. */}
      {mode === 'draw' && !hasSavedSignature && (
        <div className="rounded-control border border-accent/40 bg-accent-soft/50 p-3">
          <p className="text-meta font-medium text-content">You haven&rsquo;t saved a signature yet</p>
          <p className="mt-0.5 text-2xs text-content-muted">
            Save one once and it is put in place for you every time you sign. Or draw it below, this once.
          </p>
          <Button size="sm" variant="secondary" className="mt-2" onClick={() => handleModeChange('saved')}>
            Save a signature
          </Button>
        </div>
      )}

      {mode === 'draw' ? (
        <div>
          <div className="flex items-center justify-between mb-2">
            <p className="text-meta font-medium text-content-muted">Draw on the document</p>
            <button
              type="button"
              onClick={onClearInk}
              className="inline-flex items-center gap-1 rounded-control px-1 text-meta text-content-muted transition-colors hover:text-content active:text-accent-active"
            >
              <Eraser size={13} aria-hidden="true" />
              Clear
            </button>
          </div>
          <p className="text-2xs text-content-muted">
            {hasOwnLine
              ? 'Draw with your mouse, stylus or finger. It will sit on your line at the foot of the memo. Use Clear to start over.'
              : 'Sign anywhere on the PDF with your mouse, stylus, or finger. Use Clear to start over.'}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {hasSavedSignature && savedSignatureUrl ? (
            <div>
              {showRemoveConfirm ? (
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2 rounded-control border border-danger-line bg-danger-soft px-2.5 py-1.5">
                  <p className="text-meta text-danger-ink">
                    Delete the signature saved to your profile?
                  </p>
                  <span className="flex items-center gap-1.5">
                    <Button variant="dangerSolid" size="sm" pending={removing} onClick={handleRemove}>
                      Delete
                    </Button>
                    <button
                      type="button"
                      onClick={() => setConfirmingRemove(false)}
                      disabled={removing}
                      className="rounded-control border border-line px-2 py-1 text-meta font-medium text-content-muted transition-colors hover:bg-surface active:bg-line-soft disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Cancel
                    </button>
                  </span>
                </div>
              ) : (
                <div className="flex items-center justify-between mb-2">
                  <p className="text-meta font-medium text-content-muted">Drag onto the document</p>
                  <span className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={uploading}
                      className="inline-flex items-center gap-1 rounded-control px-1 text-meta text-accent-ink transition-colors hover:text-accent-active active:text-accent-active disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <Eraser size={13} aria-hidden="true" />
                      Replace
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmingRemove(true)}
                      className="inline-flex items-center gap-1 rounded-control px-1 text-meta text-content-muted transition-colors hover:text-danger-ink active:text-danger-ink"
                    >
                      <Trash2 size={13} aria-hidden="true" />
                      Remove
                    </button>
                  </span>
                </div>
              )}
              <div className="rounded-control border border-dashed border-accent-line bg-accent-soft/40 p-4 flex items-center justify-center">
                <img
                  src={savedSignatureUrl}
                  alt="Saved signature"
                  draggable
                  onDragStart={event => {
                    event.dataTransfer.setData('application/x-docflow-signature', 'saved')
                    event.dataTransfer.effectAllowed = 'copy'
                  }}
                  className="max-h-24 max-w-full object-contain cursor-grab active:cursor-grabbing"
                />
              </div>
              <p className="mt-2 text-2xs text-content-muted">
                Drag this signature onto the PDF, or click on the document to place it.
              </p>
            </div>
          ) : (
            <div
              onDragOver={event => {
                event.preventDefault()
                setDragging(true)
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={handleDropUpload}
              className={`rounded-control border-2 border-dashed p-6 text-center transition-colors ${
                dragging
                  ? 'border-accent bg-accent-soft'
                  : 'border-line bg-sunken'
              }`}
            >
              <Upload
                size={20}
                aria-hidden="true"
                className="mx-auto mb-2 text-content-subtle"
              />
              <p className="text-meta font-medium text-content-muted mb-1">
                Upload your signature once
              </p>
              <p className="text-2xs text-content-muted mb-3">
                It will be saved to your profile for future approvals.
              </p>
              <Button size="sm" pending={uploading} onClick={() => fileInputRef.current?.click()}>
                Choose image
              </Button>
              <p className="mt-2 text-2xs text-content-subtle">PNG or JPEG, up to 2 MB</p>
            </div>
          )}

          {/* Standing empty rather than mounted with its first message: a
              live region inserted at the same moment as the text is not
              announced, and the refusal arrives after a round trip that
              moves no focus - so a blind person is left with a picker that
              closed and a signature that never arrived. */}
          <div aria-live="polite" aria-atomic="true">
            {errorMessage && <p className="text-meta text-danger-ink">{errorMessage}</p>}
          </div>
        </div>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg"
        className="hidden"
        onChange={handleUploadInput}
      />
    </div>
  )
}
