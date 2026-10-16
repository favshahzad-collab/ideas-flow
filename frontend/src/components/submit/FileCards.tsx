import {
  AlertCircle,
  FileText,
  Paperclip,
  Plus,
  RefreshCw,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import { useRef, useState, type DragEvent } from 'react'
import {
  MAX_SUPPORTING_FILES,
  SUPPORTING_FILE_ACCEPT,
  describeFileType,
  formatFileSize,
} from '../../utils/submitDocument'
import { Card, CardHeader, Badge } from '../ui/Card'
import Button from '../ui/Button'

function FieldError({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <p id={id} role="alert" className="field-error">
      <AlertCircle size={13} aria-hidden="true" className="flex-shrink-0" />
      {children}
    </p>
  )
}

export function PrimaryFileCard({
  file,
  pdfPages,
  pdfUnreadable,
  error,
  onSelect,
  onClear,
}: {
  file: File | null
  pdfPages: number | null
  pdfUnreadable: boolean
  error: string | null
  onSelect: (file: File) => void
  onClear: () => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragActive, setDragActive] = useState(false)

  const handleDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault()
    setDragActive(false)
    const dropped = event.dataTransfer.files[0]
    if (dropped) onSelect(dropped)
  }

  return (
    <Card>
      <CardHeader
        icon={Upload}
        tone="revision"
        title="Upload Document"
        hint="The PDF that will be signed and routed. One file, 20 MB maximum."
      />
      <div className="p-4 sm:p-5">
        <input
          ref={inputRef}
          type="file"
          className="hidden"
          accept=".pdf,application/pdf"
          onChange={event => {
            const selected = event.target.files?.[0]
            if (selected) onSelect(selected)
            event.target.value = ''
          }}
        />

        {file ? (
          <div className="rounded-card border border-line bg-sunken/40 p-4">
            <div className="flex flex-wrap items-start gap-3">
              <span
                aria-hidden="true"
                className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-control bg-accent-soft text-accent-ink"
              >
                <FileText size={22} />
              </span>

              <div className="min-w-0 flex-1">
                <p className="break-all text-ui font-semibold text-content">
                  {file.name}
                </p>
                {/* Self-describing values: a visually hidden label for each
                    would only be read back as "Last modified Modified 9/1/2026". */}
                <p className="mt-1.5 text-2xs text-content-subtle">
                  PDF document
                  <span aria-hidden="true"> · </span>
                  <span className="tabular-nums">{formatFileSize(file.size)}</span>
                  {pdfPages !== null && (
                    <>
                      <span aria-hidden="true"> · </span>
                      <span className="tabular-nums">
                        {pdfPages} page{pdfPages === 1 ? '' : 's'}
                      </span>
                    </>
                  )}
                  <span aria-hidden="true"> · </span>
                  Modified {new Date(file.lastModified).toLocaleDateString()}
                </p>
              </div>

              <div className="flex flex-shrink-0 gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => inputRef.current?.click()}
                  icon={<RefreshCw size={13} aria-hidden="true" />}
                >
                  Replace
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={onClear}
                  icon={<Trash2 size={13} aria-hidden="true" />}
                >
                  Remove
                </Button>
              </div>
            </div>

            {pdfUnreadable && (
              <p
                role="alert"
                className="mt-3 flex items-start gap-2 rounded-control border border-warning-line bg-warning-soft px-3 py-2 text-2xs text-warning-ink"
              >
                <AlertCircle
                  size={13}
                  aria-hidden="true"
                  className="mt-px flex-shrink-0"
                />
                This PDF could not be opened for preview. You may not be able to place
                your signature on it — try re-exporting the file.
              </p>
            )}
          </div>
        ) : (
          <button
            type="button"
            id="submit-doc-file-drop"
            onDragOver={event => {
              event.preventDefault()
              setDragActive(true)
            }}
            onDragLeave={() => setDragActive(false)}
            onDrop={handleDrop}
            onClick={() => inputRef.current?.click()}
            /* The error as well as the hint. `role="alert"` announces the
               refusal once and then it is unreachable - tabbing back to the
               drop zone said "PDF only, up to 20 MB" as though nothing were
               wrong. The title field wires its error up exactly this way. */
            aria-describedby={
              error
                ? 'submit-doc-file-error submit-doc-file-hint'
                : 'submit-doc-file-hint'
            }
            aria-invalid={error ? true : undefined}
            className={`flex min-h-[190px] w-full flex-col items-center justify-center rounded-card border-2 border-dashed px-4 text-center transition-colors sm:min-h-[220px] ${
              dragActive
                ? 'border-accent bg-accent-soft'
                : 'border-line-strong bg-sunken/40 hover:border-accent hover:bg-accent-soft/30'
            }`}
          >
            <span
              aria-hidden="true"
              className={`mb-3 flex h-12 w-12 items-center justify-center rounded-card ${
                dragActive
                  ? 'bg-accent text-on-accent'
                  : 'bg-line-soft text-content-subtle'
              }`}
            >
              <Upload size={23} />
            </span>

            <span className="text-ui font-medium text-content">
              {dragActive ? 'Drop the PDF to attach it' : 'Drag and drop your PDF here'}
            </span>
            <span className="mt-1 text-meta text-accent-ink underline underline-offset-2">
              or click to browse your computer
            </span>

            <span
              id="submit-doc-file-hint"
              className="mt-4 text-2xs text-content-subtle"
            >
              PDF only · up to 20 MB · this is the file everyone signs
            </span>
          </button>
        )}

        {error && <FieldError id="submit-doc-file-error">{error}</FieldError>}
      </div>
    </Card>
  )
}

export function SupportingFilesCard({
  files,
  error,
  onAdd,
  onRemove,
}: {
  files: File[]
  error: string | null
  onAdd: (list: FileList | null) => void
  onRemove: (index: number) => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const totalBytes = files.reduce((sum, item) => sum + item.size, 0)

  return (
    <Card>
      <CardHeader
        icon={Paperclip}
        tone="info"
        title="Supporting Documents"
        hint="Reference files approvers can open alongside the PDF · PDF, images, Word, Excel, TXT, CSV"
        actions={
          <Badge className="tabular-nums">
            {files.length}/{MAX_SUPPORTING_FILES}
          </Badge>
        }
      />
      <div className="space-y-3 p-4 sm:p-5">
        <input
          ref={inputRef}
          type="file"
          className="hidden"
          multiple
          accept={SUPPORTING_FILE_ACCEPT}
          onChange={event => {
            onAdd(event.target.files)
            event.target.value = ''
          }}
        />

        {files.length > 0 && (
          <ul className="space-y-2">
            {files.map((item, index) => (
              <li
                key={`${item.name}-${item.size}-${index}`}
                className="flex items-center justify-between gap-3 rounded-control border border-line px-3 py-2.5"
              >
                <div className="flex min-w-0 items-center gap-2.5">
                  <span
                    aria-hidden="true"
                    className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-control bg-info-soft text-info-ink"
                  >
                    <FileText size={15} />
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-ui text-content">{item.name}</p>
                    <p className="text-2xs text-content-subtle">
                      {describeFileType(item.name)} ·{' '}
                      <span className="tabular-nums">{formatFileSize(item.size)}</span>
                    </p>
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onRemove(index)}
                  aria-label={`Remove supporting file ${item.name}`}
                  className="flex-shrink-0 text-content-subtle hover:text-danger-ink"
                  icon={<X size={14} aria-hidden="true" />}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}

        {files.length < MAX_SUPPORTING_FILES && (
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="flex min-h-[76px] w-full flex-col items-center justify-center gap-1 rounded-card border-2 border-dashed border-line-strong bg-sunken/40 text-ui text-content-muted transition-colors hover:border-info hover:bg-info-soft/40"
          >
            <Plus size={17} aria-hidden="true" className="text-info-ink" />
            <span className="font-medium text-content">Add supporting files</span>
            <span className="text-2xs text-content-subtle">
              {MAX_SUPPORTING_FILES - files.length} slot
              {MAX_SUPPORTING_FILES - files.length === 1 ? '' : 's'} left · 20 MB each
            </span>
          </button>
        )}

        {files.length > 0 && (
          <p className="text-2xs text-content-subtle">
            {files.length} file{files.length === 1 ? '' : 's'} attached ·{' '}
            <span className="tabular-nums">{formatFileSize(totalBytes)}</span> total
          </p>
        )}

        {error && <FieldError id="supporting-error">{error}</FieldError>}
      </div>
    </Card>
  )
}
