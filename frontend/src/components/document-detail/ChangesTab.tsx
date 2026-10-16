/**
 * What changed since the version before this one.
 *
 * A memo sent back for correction comes round again, and every approver on
 * the chain is asked to read it again. This tab shows them the difference
 * instead: the paragraph that changed with the words that moved marked in
 * it, the table row whose figure changed, the item added to a list - and
 * everything else shown unchanged, so the reader can see where the change
 * sits in the memo rather than a list of fragments.
 *
 * The comparing is done on the server (`lib/memoDiff`), from the bodies each
 * version was drawn from. This draws the result. Nothing here is a colour
 * alone: every added or removed stretch is an `<ins>` or `<del>` with a word
 * for screen readers, and every block carries its label.
 */
import { AlertCircle, Minus, Pencil, Plus } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'

import { fetchDocumentChanges } from '../../services/documentDetailApi'
import type { MemoBlockNode, MemoParagraphNode, MemoTextNode } from '../../types/memo'
import type {
  ApiMemoChanges,
  MemoDiffBlock,
  MemoDiffCell,
  MemoDiffItem,
  MemoDiffKind,
  MemoDiffRow,
  MemoDiffRun,
} from '../../types/memoChanges'
import { formatDisplayDate } from '../../utils/format'
import { LoadingAnnouncer, Skeleton } from '../ui/Skeleton'

type Loaded = {
  key: string
  data: ApiMemoChanges | null
  error: string | null
}

export default function ChangesTab({ documentId }: { documentId: string }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [onlyChanges, setOnlyChanges] = useState(false)

  useEffect(() => {
    let cancelled = false

    void fetchDocumentChanges(documentId).then(
      data => {
        if (!cancelled) setLoaded({ key: documentId, data, error: null })
      },
      (err: unknown) => {
        if (!cancelled) {
          setLoaded({
            key: documentId,
            data: null,
            error: err instanceof Error ? err.message : 'Failed to load what changed',
          })
        }
      },
    )

    return () => {
      cancelled = true
    }
  }, [documentId])

  const current = loaded?.key === documentId ? loaded : null

  if (!current) {
    return (
      <section className="card p-5" aria-busy="true">
        <LoadingAnnouncer loading />
        <div aria-hidden="true" className="space-y-3">
          <Skeleton className="h-5 w-72 max-w-full" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-11/12" />
          <Skeleton className="h-4 w-4/5" />
        </div>
      </section>
    )
  }

  if (current.error || !current.data) {
    return (
      <div
        role="alert"
        className="flex items-start gap-2 rounded-control border border-danger-line bg-danger-soft px-4 py-3 text-ui text-danger-ink"
      >
        <AlertCircle size={16} aria-hidden="true" className="mt-0.5 flex-shrink-0" />
        {current.error ?? 'Failed to load what changed'}
      </div>
    )
  }

  const { data } = current

  if (!data.previous || !data.current) {
    return (
      <Quiet>
        This is the first version of this memo. There is nothing before it to
        compare with.
      </Quiet>
    )
  }

  if (!data.changes) {
    const uploaded = data.current.typed ? data.previous : data.current
    return (
      <Quiet>
        Version {uploaded.versionNumber} was uploaded as a PDF, so its text
        cannot be compared. Open each version from the preview to read them
        side by side.
      </Quiet>
    )
  }

  const { changes, notes, returned } = data
  const visible = onlyChanges
    ? changes.blocks.filter(block => block.kind !== 'same')
    : changes.blocks
  const notesChanged =
    notes !== null &&
    (notes.added.length > 0 || notes.removed.length > 0 || notes.moved > 0)

  return (
    <section className="card overflow-hidden">
      <div className="border-b border-line-soft px-4 py-4 sm:px-5">
        <h2 className="text-section font-semibold text-content">
          Version {data.current.versionNumber} compared with version{' '}
          {data.previous.versionNumber}
        </h2>
        <p className="mt-1 text-meta text-content-subtle">
          Version {data.previous.versionNumber} filed{' '}
          {formatDisplayDate(data.previous.filedAt)}; version{' '}
          {data.current.versionNumber} filed {formatDisplayDate(data.current.filedAt)}.
        </p>

        {returned && (
          <p className="mt-2 text-ui leading-relaxed text-content-muted">
            Sent back by <span className="font-medium text-content">{returned.by}</span>{' '}
            on {formatDisplayDate(returned.at)}
            {returned.comment ? (
              <>
                : <q className="text-content">{returned.comment}</q>
              </>
            ) : (
              '.'
            )}
          </p>
        )}

        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <ul aria-label="Summary of changes" className="flex flex-wrap gap-2">
            <Chip kind="added" count={changes.summary.added} />
            <Chip kind="removed" count={changes.summary.removed} />
            <Chip kind="changed" count={changes.summary.changed} />
          </ul>

          <label className="inline-flex items-center gap-2 text-meta text-content-muted">
            <input
              type="checkbox"
              className="accent-accent"
              checked={onlyChanges}
              onChange={event => setOnlyChanges(event.target.checked)}
            />
            Only what changed
          </label>
        </div>
      </div>

      <div className="px-4 py-4 sm:px-5">
        {changes.identical ? (
          <p className="text-ui text-content-muted">
            The text is the same in both versions.
          </p>
        ) : (
          <ol className="space-y-3">
            {visible.map((block, index) => (
              <li key={index}>
                <DiffBlockView block={block} />
              </li>
            ))}
          </ol>
        )}

        {onlyChanges && changes.summary.same > 0 && (
          <p className="mt-3 text-meta text-content-subtle">
            {changes.summary.same} unchanged{' '}
            {changes.summary.same === 1 ? 'block is' : 'blocks are'} hidden.
          </p>
        )}
      </div>

      {notesChanged && notes && (
        <div className="border-t border-line-soft px-4 py-4 sm:px-5">
          <h3 className="text-ui font-semibold text-content">Notes on the page</h3>
          <ul className="mt-2 space-y-1.5 text-ui">
            {notes.added.map((text, index) => (
              <li key={`added-${index}`} className="flex items-baseline gap-2">
                <KindLabel kind="added" />
                <ins className="whitespace-pre-wrap text-content decoration-success-mark">
                  {text}
                </ins>
              </li>
            ))}
            {notes.removed.map((text, index) => (
              <li key={`removed-${index}`} className="flex items-baseline gap-2">
                <KindLabel kind="removed" />
                <del className="whitespace-pre-wrap text-content-muted decoration-danger-mark">
                  {text}
                </del>
              </li>
            ))}
            {notes.moved > 0 && (
              <li className="text-content-muted">
                {notes.moved} {notes.moved === 1 ? 'note was' : 'notes were'} moved on
                the page without a change to the words.
              </li>
            )}
          </ul>
        </div>
      )}
    </section>
  )
}

function Quiet({ children }: { children: ReactNode }) {
  return (
    <div className="card px-4 py-10 text-center text-ui text-content-muted sm:px-5">
      {children}
    </div>
  )
}

// ── Labels and frames ───────────────────────────────────────────────────────

const LABEL: Record<MemoDiffKind, string> = {
  same: 'Unchanged',
  added: 'Added',
  removed: 'Removed',
  changed: 'Changed',
}

const INK: Record<MemoDiffKind, string> = {
  same: 'text-content-subtle',
  added: 'text-success-ink',
  removed: 'text-danger-ink',
  changed: 'text-warning-ink',
}

const FRAME: Record<MemoDiffKind, string> = {
  same: 'border-l-2 border-line-soft pl-3',
  added: 'border-l-4 border-success-mark bg-success-soft pl-3 py-1.5 pr-2 rounded-r-control',
  removed: 'border-l-4 border-danger-mark bg-danger-soft pl-3 py-1.5 pr-2 rounded-r-control',
  changed: 'border-l-4 border-warning-mark pl-3 py-1.5',
}

const ICON: Record<'added' | 'removed' | 'changed', typeof Plus> = {
  added: Plus,
  removed: Minus,
  changed: Pencil,
}

function KindLabel({ kind }: { kind: MemoDiffKind }) {
  return (
    <span className={`text-2xs font-semibold uppercase tracking-wide ${INK[kind]}`}>
      {LABEL[kind]}
    </span>
  )
}

function Chip({ kind, count }: { kind: 'added' | 'removed' | 'changed'; count: number }) {
  const Icon = ICON[kind]
  const tint =
    kind === 'added'
      ? 'bg-success-soft text-success-ink'
      : kind === 'removed'
        ? 'bg-danger-soft text-danger-ink'
        : 'bg-warning-soft text-warning-ink'

  return (
    <li className={`inline-flex items-center gap-1 rounded-chip px-2 py-0.5 text-meta ${tint}`}>
      <Icon size={12} aria-hidden="true" />
      {count} {kind}
    </li>
  )
}

// ── Runs ────────────────────────────────────────────────────────────────────

/** Diff runs, each addition and removal marked for the eye and the ear. */
function Runs({ runs }: { runs: MemoDiffRun[] }) {
  return (
    <>
      {runs.map((run, index) => {
        if (run.kind === 'same') return <span key={index}>{run.text}</span>
        if (run.kind === 'added') {
          return (
            <ins
              key={index}
              className="rounded-xs bg-success-soft text-success-ink decoration-success-mark"
            >
              <span className="sr-only">added: </span>
              {run.text}
            </ins>
          )
        }
        return (
          <del
            key={index}
            className="rounded-xs bg-danger-soft text-danger-ink decoration-danger-mark"
          >
            <span className="sr-only">removed: </span>
            {run.text}
          </del>
        )
      })}
    </>
  )
}

/** A block's own text, with the emphasis it carries. */
function Text({ runs }: { runs: MemoTextNode[] | undefined }) {
  return (
    <>
      {(runs ?? []).map((run, index) => {
        const marks = (run.marks ?? []).map(mark => mark.type)
        let node: ReactNode = run.text
        if (marks.includes('underline')) node = <u>{node}</u>
        if (marks.includes('italic')) node = <em>{node}</em>
        if (marks.includes('bold')) node = <strong>{node}</strong>
        return <span key={index}>{node}</span>
      })}
    </>
  )
}

const paragraphsText = (paragraphs: MemoParagraphNode[] | undefined): string =>
  (paragraphs ?? [])
    .map(paragraph => (paragraph.content ?? []).map(run => run.text).join(''))
    .join(' ')

// ── Blocks ──────────────────────────────────────────────────────────────────

/** A memo block drawn plainly, as the memo shows it. */
function BlockView({ block }: { block: MemoBlockNode }) {
  switch (block.type) {
    case 'paragraph':
      return (
        <p className="whitespace-pre-wrap text-ui leading-relaxed text-content">
          <Text runs={block.content} />
        </p>
      )
    case 'heading':
      return block.attrs.level === 1 ? (
        <h3 className="text-ui font-semibold uppercase tracking-wide text-content">
          <Text runs={block.content} />
        </h3>
      ) : (
        <h4 className="text-ui font-semibold text-content">
          <Text runs={block.content} />
        </h4>
      )
    case 'bulletList':
    case 'orderedList': {
      const Tag = block.type === 'orderedList' ? 'ol' : 'ul'
      return (
        <Tag
          className={`${block.type === 'orderedList' ? 'list-decimal' : 'list-disc'} space-y-1 pl-5 text-ui text-content`}
        >
          {block.content.map((item, index) => (
            <li key={index}>{paragraphsText(item.content)}</li>
          ))}
        </Tag>
      )
    }
    case 'table':
      return (
        <div className="overflow-x-auto">
          <table className="w-full text-meta">
            <tbody>
              {block.content.map((row, r) => (
                <tr key={r}>
                  {row.content.map((cell, c) =>
                    cell.type === 'tableHeader' ? (
                      <th
                        key={c}
                        scope="col"
                        colSpan={cell.attrs?.colspan}
                        className="border border-line-soft bg-canvas px-2 py-1 text-left align-top font-semibold text-content"
                      >
                        {paragraphsText(cell.content)}
                      </th>
                    ) : (
                      <td
                        key={c}
                        colSpan={cell.attrs?.colspan}
                        className="border border-line-soft px-2 py-1 align-top text-content"
                      >
                        {paragraphsText(cell.content)}
                      </td>
                    ),
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    case 'pageBreak':
      return <p className="text-meta text-content-subtle">— page break —</p>
    case 'image':
      return (
        <figure className="space-y-1">
          <img
            src={block.attrs.src}
            alt={block.attrs.alt ?? 'A picture in the memo'}
            className="max-w-full rounded-control border border-line-soft"
            style={block.attrs.share ? { width: `${block.attrs.share * 100}%` } : undefined}
          />
          {block.attrs.alt && (
            <figcaption className="text-meta text-content-subtle">{block.attrs.alt}</figcaption>
          )}
        </figure>
      )
  }
}

function DiffBlockView({ block }: { block: MemoDiffBlock }) {
  return (
    <div className={FRAME[block.kind]}>
      <div className="mb-1">
        <KindLabel kind={block.kind} />
        {block.kind === 'changed' && block.type === 'text' && block.emphasisOnly && (
          <span className="ml-2 text-2xs text-content-subtle">only the emphasis changed</span>
        )}
        {block.kind === 'changed' && block.type === 'table' && block.layoutOnly && (
          <span className="ml-2 text-2xs text-content-subtle">
            only the column widths or row heights changed
          </span>
        )}
      </div>
      <DiffBlockBody block={block} />
    </div>
  )
}

function DiffBlockBody({ block }: { block: MemoDiffBlock }) {
  if (block.kind === 'same') return <BlockView block={block.block} />

  if (block.kind === 'added' || block.kind === 'removed') {
    const isText = block.block.type === 'paragraph' || block.block.type === 'heading'
    if (!isText) return <BlockView block={block.block} />
    return block.kind === 'added' ? (
      <ins className="block decoration-success-mark">
        <BlockView block={block.block} />
      </ins>
    ) : (
      <del className="block text-content-muted decoration-danger-mark">
        <BlockView block={block.block} />
      </del>
    )
  }

  if (block.type === 'text') {
    if (block.emphasisOnly) return <BlockView block={block.after} />
    const runs = <Runs runs={block.runs} />
    if (block.after.type === 'heading') {
      return block.after.attrs.level === 1 ? (
        <h3 className="whitespace-pre-wrap text-ui font-semibold uppercase tracking-wide text-content">
          {runs}
        </h3>
      ) : (
        <h4 className="whitespace-pre-wrap text-ui font-semibold text-content">{runs}</h4>
      )
    }
    return <p className="whitespace-pre-wrap text-ui leading-relaxed text-content">{runs}</p>
  }

  if (block.type === 'table') {
    if (block.layoutOnly) return <BlockView block={block.after} />
    return <DiffTable rows={block.rows} />
  }

  return <DiffList items={block.items} ordered={block.after.type === 'orderedList'} />
}

// ── Tables and lists ────────────────────────────────────────────────────────

const ROW_TINT: Record<MemoDiffKind, string> = {
  same: '',
  added: 'bg-success-soft',
  removed: 'bg-danger-soft',
  changed: 'bg-warning-soft',
}

function CellText({ cell }: { cell: MemoDiffCell }) {
  if (cell.runs) return <Runs runs={cell.runs} />
  if (cell.kind === 'added') {
    return (
      <ins className="text-success-ink decoration-success-mark">
        <span className="sr-only">added: </span>
        {cell.text}
      </ins>
    )
  }
  if (cell.kind === 'removed') {
    return (
      <del className="text-danger-ink decoration-danger-mark">
        <span className="sr-only">removed: </span>
        {cell.text}
      </del>
    )
  }
  return <>{cell.text}</>
}

function DiffTable({ rows }: { rows: MemoDiffRow[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-meta">
        <tbody>
          {rows.map((row, r) => (
            <tr key={r} className={ROW_TINT[row.kind]}>
              <td className="whitespace-nowrap px-1.5 py-1 align-top">
                {row.kind === 'same' ? (
                  <span className="sr-only">Unchanged row</span>
                ) : (
                  <span className={`text-2xs font-semibold uppercase tracking-wide ${INK[row.kind]}`}>
                    {LABEL[row.kind]} <span className="sr-only">row</span>
                  </span>
                )}
              </td>
              {row.cells.map((cell, c) =>
                row.header ? (
                  <th
                    key={c}
                    scope="col"
                    className="whitespace-pre-wrap border border-line-soft bg-canvas px-2 py-1 text-left align-top font-semibold text-content"
                  >
                    <CellText cell={cell} />
                  </th>
                ) : (
                  <td
                    key={c}
                    className="whitespace-pre-wrap border border-line-soft px-2 py-1 align-top text-content"
                  >
                    <CellText cell={cell} />
                  </td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function DiffList({ items, ordered }: { items: MemoDiffItem[]; ordered: boolean }) {
  const Tag = ordered ? 'ol' : 'ul'
  return (
    <Tag className={`${ordered ? 'list-decimal' : 'list-disc'} space-y-1 pl-5 text-ui text-content`}>
      {items.map((item, index) => (
        <li key={index} className={`whitespace-pre-wrap rounded-xs ${ROW_TINT[item.kind]}`}>
          {item.kind !== 'same' && (
            <>
              <KindLabel kind={item.kind} />{' '}
            </>
          )}
          {item.runs ? (
            <Runs runs={item.runs} />
          ) : item.kind === 'added' ? (
            <ins className="decoration-success-mark">{item.text}</ins>
          ) : item.kind === 'removed' ? (
            <del className="text-content-muted decoration-danger-mark">{item.text}</del>
          ) : (
            item.text
          )}
        </li>
      ))}
    </Tag>
  )
}
