import { forwardRef } from 'react'
import { Clock } from 'lucide-react'
import Keycap from '../ui/Keycap'
import { Badge } from '../ui/Card'
import {
  formatMemoReference,
  formatWaitingDuration,
  formatWaitingShort,
  getWaitingSeverity,
  type WaitingSeverity,
} from '../../utils/format'
import type { DashboardDocument } from '../../types/document'
import { QUEUE_TABS, type QueueTab } from '../../utils/pendingQueue'

const SEVERITY_DOTS: Record<WaitingSeverity, string> = {
  fresh: 'bg-accent-mark',
  ageing: 'bg-warning-mark',
  overdue: 'bg-danger-mark',
  critical: 'bg-danger-mark',
}

/* How long it has waited, coloured by urgency. A chip, not the `<kbd>` it
   used to be drawn with: "21m" in a key cap read as a shortcut to press. */
const AGE_TONES: Record<WaitingSeverity, string> = {
  fresh: 'border-line bg-surface text-content-subtle',
  ageing: 'border-warning-line bg-warning-soft text-warning-ink',
  overdue: 'border-danger-line bg-danger-soft text-danger-ink',
  critical: 'border-danger-line bg-danger-soft text-danger-ink',
}

const LEGEND = [
  { keys: ['J', 'K'], label: 'move' },
  { keys: ['A'], label: 'approve' },
  { keys: ['R'], label: 'revision' },
  { keys: ['X'], label: 'reject' },
]

interface QueueListProps {
  documents: DashboardDocument[]
  counts: Record<QueueTab, number>
  tab: QueueTab
  onTab: (tab: QueueTab) => void
  cursor: number
  onCursor: (index: number) => void
  rowRefs: React.MutableRefObject<(HTMLButtonElement | null)[]>
}

/**
 * The 400px scanning column. Everything an approver needs to decide which
 * document to open next, and nothing else.
 */
const QueueList = forwardRef<HTMLDivElement, QueueListProps>(function QueueList(
  { documents, counts, tab, onTab, cursor, onCursor, rowRefs },
  scrollRef,
) {
  return (
    <div className="flex h-full w-full flex-col border-line bg-surface lg:w-100 lg:flex-shrink-0 lg:border-r">
      <div className="flex-shrink-0 border-b border-line-soft px-4 py-3.5">
        <div className="flex items-baseline justify-between gap-2">
          <h1 className="text-pane font-semibold text-content">My queue</h1>
          <span className="font-mono text-2xs uppercase tracking-wide text-content-subtle tabular-nums">
            {counts.all} item{counts.all === 1 ? '' : 's'}
          </span>
        </div>

        {/*
          * A group of toggles, not a tablist.
          *
          * `role="tab"` inside `role="tablist"` tells a screen-reader user
          * "tab 2 of 4" and teaches them to press the arrow keys - and there
          * was no roving tabindex, no arrow handling and no `aria-controls`
          * behind it. Worse, the arrow keys are already taken on this screen:
          * pressing one moves the document cursor in the pane they cannot
          * see. `aria-pressed` promises nothing that is not here, and is what
          * these actually are.
          */}
        <div
          className="mt-2.5 flex flex-wrap gap-1.5"
          role="group"
          aria-label="Queue filter"
        >
          {QUEUE_TABS.map(item => {
            const active = tab === item.id
            return (
              <button
                key={item.id}
                type="button"
                aria-pressed={active}
                onClick={() => onTab(item.id)}
                title={item.hint}
                className={`inline-flex h-6.5 items-center gap-1.5 rounded-pill border px-2.5 text-meta font-medium transition-colors ${
                  active
                    ? 'border-transparent bg-dark-surface text-dark-content'
                    : 'border-line bg-surface text-content-muted hover:bg-sunken'
                }`}
              >
                {item.label}
                <span className="font-mono tabular-nums opacity-80">
                  {counts[item.id]}
                </span>
              </button>
            )
          })}
        </div>
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        {/* Named, so the rows are addressable as a set - by a screen reader
            moving between landmarks, and by a test that wants a memo rather
            than the filter chip beside it that happens to share a word. */}
        <ul aria-label="Queue">
          {documents.map((doc, index) => {
            const severity = getWaitingSeverity(doc.updatedAt)
            const selected = index === cursor
            const isReviewer = doc.approvalType === 'REVIEWER'

            return (
              <li key={doc.id}>
                <button
                  type="button"
                  ref={element => {
                    rowRefs.current[index] = element
                  }}
                  onClick={() => onCursor(index)}
                  aria-current={selected ? 'true' : undefined}
                  className={`flex w-full gap-2.5 border-b border-line-soft px-4 py-3 text-left transition-colors ${
                    selected ? 'bg-accent-soft/50' : 'hover:bg-canvas'
                  }`}
                >
                  {/* The 3px rail is the selected marker that survives at a
                      glance down a long list; the tint alone is too quiet. */}
                  <span
                    aria-hidden="true"
                    className={`-my-3 -ml-4 w-0.75 flex-shrink-0 ${
                      selected ? 'bg-accent' : 'bg-transparent'
                    }`}
                  />

                  <span className="min-w-0 flex-1">
                    <span className="flex items-start gap-2">
                      <span
                        aria-hidden="true"
                        className={`mt-1 h-1.75 w-1.75 flex-shrink-0 rounded-pill ${SEVERITY_DOTS[severity]}`}
                      />
                      <span className="line-clamp-2 min-w-0 flex-1 text-ui font-semibold text-content">
                        {doc.title}
                      </span>
                      <span
                        title={`Waiting ${formatWaitingDuration(doc.updatedAt)}`}
                        className={`inline-flex flex-shrink-0 items-center gap-1 rounded-chip border px-1.5 py-0.5 text-data font-medium tabular-nums ${AGE_TONES[severity]}`}
                      >
                        <Clock size={11} aria-hidden="true" />
                        {formatWaitingShort(doc.updatedAt)}
                        <span className="sr-only"> waiting</span>
                      </span>
                    </span>

                    <span className="mt-1 block pl-4 font-mono text-data text-content-subtle">
                      {formatMemoReference(doc.referenceNumber, doc.id)}{' '}
                      <span className="font-sans">&middot; From {doc.submittedBy}</span>
                    </span>

                    <span className="mt-1.5 flex flex-wrap items-center gap-2 pl-4">
                      <Badge tone={isReviewer ? 'info' : 'accent'} dot>
                        {isReviewer ? 'Reviewer' : 'Approver'}
                      </Badge>
                      <span className="text-meta tabular-nums text-content-subtle">
                        Step {doc.currentStep} of {doc.totalSteps}
                      </span>
                    </span>
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      </div>

      <div className="hidden flex-shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-line bg-canvas px-4 py-2.25 lg:flex">
        {LEGEND.map(entry => (
          <span key={entry.label} className="flex items-center gap-1">
            {entry.keys.map(key => (
              <Keycap key={key}>{key}</Keycap>
            ))}
            <span className="text-meta text-content-subtle">{entry.label}</span>
          </span>
        ))}
      </div>
    </div>
  )
})

export default QueueList
