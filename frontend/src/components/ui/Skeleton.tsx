/**
 * Layout-preserving placeholders. A skeleton mirrors the shape of the
 * content that is coming, so nothing jumps when data lands — which a
 * centred spinner cannot do.
 *
 * All of these are aria-hidden: the loading state is announced through
 * a live region, not by describing grey rectangles.
 */

export function Skeleton({ className = '' }: { className?: string }) {
  return (
    <div
      className={`animate-pulse rounded bg-line-soft ${className}`}
      aria-hidden="true"
    />
  )
}

/** Announces async state to assistive tech without showing anything. */
export function LoadingAnnouncer({
  loading,
  label = 'Loading',
  doneLabel = '',
}: {
  loading: boolean
  label?: string
  doneLabel?: string
}) {
  return (
    <div aria-live="polite" aria-atomic="true" className="sr-only">
      {loading ? label : doneLabel}
    </div>
  )
}

/**
 * Mirrors `PageHeader` — the same two line heights and the same
 * `mb-6 sm:mb-8`, so the title does not shift when the real header replaces
 * it. Loading branches used to draw an `h-6` bar with the *old* page padding,
 * which moved every screen down and to the right the moment data landed.
 */
/**
 * Mirrors `PageHeader` exactly — the eyebrow line, the 24px title, the
 * description, and its `mb-5 sm:mb-6`. If those change, change these: three
 * screens once used the pre-`Page` spacing here and so shifted the whole
 * layout by a few pixels the moment data landed.
 */
export function SkeletonPageHeader({
  titleWidth = '13rem',
  description = true,
}: {
  titleWidth?: string
  /** Set false on a header that is eyebrow + title only, or the page jumps. */
  description?: boolean
}) {
  return (
    <div className="mb-5 sm:mb-6" aria-hidden="true">
      <div className="mb-1.5 h-2.5 w-40 animate-pulse rounded bg-line-soft" />
      <div
        className="h-7.5 animate-pulse rounded bg-line-soft"
        style={{ width: titleWidth }}
      />
      {description && (
        <div className="mt-1.5 h-4 w-full max-w-md animate-pulse rounded bg-line-soft" />
      )}
    </div>
  )
}

/** Mirrors a row of the document / audit / user tables. */
export function SkeletonTableRows({
  rows = 6,
  columns = 5,
}: {
  rows?: number
  columns?: number
}) {
  return (
    <>
      {Array.from({ length: rows }, (_, r) => (
        <tr key={r} aria-hidden="true">
          {Array.from({ length: columns }, (_, c) => (
            <td key={c} className="px-4 py-3.5">
              <div
                className="h-3.5 animate-pulse rounded bg-line-soft"
                style={{ width: c === 0 ? '75%' : c === columns - 1 ? '45%' : '60%' }}
              />
            </td>
          ))}
        </tr>
      ))}
    </>
  )
}

/** Mirrors a stacked card in the mobile list views. */
export function SkeletonCards({ count = 4 }: { count?: number }) {
  return (
    <div className="divide-y divide-line-soft" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="p-4 space-y-2.5">
          <div className="flex items-center gap-3">
            <div className="h-8 w-8 flex-shrink-0 animate-pulse rounded-control bg-line-soft" />
            <div className="h-3.5 w-1/2 animate-pulse rounded bg-line-soft" />
            <div className="ml-auto h-5 w-16 animate-pulse rounded-pill bg-line-soft" />
          </div>
          <div className="h-3 w-3/4 animate-pulse rounded bg-line-soft" />
        </div>
      ))}
    </div>
  )
}

/** Mirrors the summary/stat cards above a list. */
export function SkeletonStats({ count = 5 }: { count?: number }) {
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <div
          key={i}
          className="rounded-card border border-line bg-surface p-3"
          aria-hidden="true"
        >
          <div className="h-3 w-16 animate-pulse rounded bg-line-soft" />
          <div className="mt-2 h-6 w-10 animate-pulse rounded bg-line-soft" />
        </div>
      ))}
    </>
  )
}
