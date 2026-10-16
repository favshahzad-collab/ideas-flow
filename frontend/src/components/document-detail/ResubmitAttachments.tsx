import { useId } from 'react'
import { Paperclip, X } from 'lucide-react'
import type { SupportingDocumentView } from '../../types/documentDetail'

/**
 * The supporting files the next version will carry.
 *
 * Agreed after the fit-gap review: a revision keeps the files the last
 * version carried unless the preparer takes one off, and new files are added
 * beside them. Nothing is deleted - a file taken off stays with the versions
 * that carried it - so this is a choice about the new version only, and the
 * screen says so.
 */
export default function ResubmitAttachments({
  current,
  removeIds,
  onToggleKeep,
  added,
  onAdd,
  onRemoveAdded,
}: {
  current: SupportingDocumentView[]
  removeIds: string[]
  onToggleKeep: (id: string, keep: boolean) => void
  added: File[]
  onAdd: (files: File[]) => void
  onRemoveAdded: (index: number) => void
}) {
  const inputId = useId()
  const headingId = useId()

  return (
    <section aria-labelledby={headingId} className="card mb-4 p-4">
      <h3 id={headingId} className="flex items-center gap-2 text-ui font-semibold text-content">
        <Paperclip size={15} aria-hidden="true" />
        Supporting files for the new version
      </h3>
      <p className="mt-1 text-meta text-content-muted">
        The files below stay attached unless you untick them. Unticked files are
        kept with the earlier version, not deleted.
      </p>

      {current.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {current.map(doc => {
            const id = `keep-${doc.id}`
            return (
              <li key={doc.id} className="flex items-center gap-2.5">
                <input
                  id={id}
                  type="checkbox"
                  checked={!removeIds.includes(doc.id)}
                  onChange={event => onToggleKeep(doc.id, event.target.checked)}
                  className="h-4 w-4 flex-shrink-0 accent-accent"
                />
                <label htmlFor={id} className="min-w-0 truncate text-ui text-content">
                  Keep {doc.fileName}
                  <span className="ml-1.5 text-meta text-content-subtle">{doc.sizeLabel}</span>
                </label>
              </li>
            )
          })}
        </ul>
      )}

      {added.length > 0 && (
        <ul className="mt-3 space-y-1.5" aria-label="Files to add">
          {added.map((file, index) => (
            <li key={`${file.name}-${index}`} className="flex items-center gap-2 text-ui text-content">
              <span className="min-w-0 truncate">Add {file.name}</span>
              <button
                type="button"
                onClick={() => onRemoveAdded(index)}
                aria-label={`Do not add ${file.name}`}
                className="rounded-control p-1 text-content-muted hover:bg-sunken"
              >
                <X size={14} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-3">
        <label htmlFor={inputId} className="field-label">
          Add supporting files
        </label>
        <input
          id={inputId}
          type="file"
          multiple
          onChange={event => {
            const files = Array.from(event.target.files ?? [])
            if (files.length > 0) onAdd(files)
            event.target.value = ''
          }}
          className="block text-meta text-content-muted"
        />
      </div>
    </section>
  )
}
