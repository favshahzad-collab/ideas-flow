import { useId } from 'react'
import { ArrowDownUp, Search, X } from 'lucide-react'
import { Chip } from '../ui/Card'
import type { DocumentStatusFilter } from '../../utils/documentFilters'
import { FEATURES } from '../../config/features'

export type SortOrder = 'newest' | 'oldest'

const STATUS_CHIPS: { value: DocumentStatusFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'pending', label: 'In progress' },
  { value: 'approved', label: 'Approved' },
  { value: 'revision_requested', label: 'Revision' },
  { value: 'rejected', label: 'Rejected' },
]

/**
 * The filter row above the table.
 *
 * The design puts search behind ⌘K and leaves only chips here. The palette
 * does not exist yet (step 7), so the field stays — removing the only way to
 * search this screen before its replacement works would be a regression.
 *
 * "Department" and "Value" chips from the design are absent: neither field is
 * on the document the API returns.
 */
export default function DocumentFilters({
  search,
  onSearch,
  status,
  onStatus,
  sort,
  onSort,
  resultCount,
  totalCount,
}: {
  search: string
  onSearch: (value: string) => void
  status: DocumentStatusFilter
  onStatus: (value: DocumentStatusFilter) => void
  sort: SortOrder
  onSort: (value: SortOrder) => void
  resultCount: number
  totalCount: number
}) {
  const searchId = useId()

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-line-soft px-3.5 py-2.5">
      {/* Its own full-width row on a phone, where sharing one with the chips
          cut its placeholder off mid-word. */}
      <div className="relative w-full sm:w-auto sm:min-w-45 sm:max-w-70 sm:flex-1">
        <label htmlFor={searchId} className="sr-only">
          Search documents
        </label>
        <Search
          size={14}
          aria-hidden="true"
          className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-content-subtle"
        />
        <input
          id={searchId}
          type="search"
          value={search}
          onChange={event => onSearch(event.target.value)}
          placeholder="Search reference, title or person"
          className="field h-7 pl-8 pr-8 text-ui"
        />
        {search && (
          <button
            type="button"
            onClick={() => onSearch('')}
            aria-label="Clear search"
            className="absolute right-1 top-1/2 flex h-5.5 w-5.5 -translate-y-1/2 items-center justify-center rounded-pill text-content-subtle transition-colors hover:bg-sunken hover:text-content"
          >
            <X size={12} aria-hidden="true" />
          </button>
        )}
      </div>

      {STATUS_CHIPS.map(chip => (
        <Chip
          key={chip.value}
          /* `readStatus` in DocumentPage accepts `pending_review` and
             `pending_approval` from the URL and no chip carries either value,
             so a link with one came back filtered with every chip - including
             "All" - unpressed, and nothing on screen explained why documents
             were missing. Both are halves of "In progress". */
          active={
            status === chip.value ||
            (chip.value === 'pending' &&
              (status === 'pending_review' || status === 'pending_approval'))
          }
          onClick={() => onStatus(chip.value)}
        >
          {chip.label}
        </Chip>
      ))}

      <Chip
        active={sort === 'oldest'}
        onClick={() => onSort(sort === 'oldest' ? 'newest' : 'oldest')}
        aria-label={`Sort: ${sort === 'oldest' ? 'oldest first' : 'newest first'}. Activate to switch.`}
      >
        <ArrowDownUp size={12} aria-hidden="true" className="mr-1.5" />
        {sort === 'oldest' ? 'Oldest first' : 'Newest first'}
      </Chip>

      <p className="ml-auto text-meta text-content-subtle tabular-nums" aria-live="polite">
        {resultCount} of {totalCount}
      </p>

      {FEATURES.savedViews && (
        <button
          type="button"
          disabled
          title="Needs POST /api/saved-views"
          className="text-meta font-medium text-accent-ink disabled:cursor-not-allowed disabled:opacity-50"
        >
          Save as view
        </button>
      )}
    </div>
  )
}
