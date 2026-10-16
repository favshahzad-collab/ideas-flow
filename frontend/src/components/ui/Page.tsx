import type { ComponentType, ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import Eyebrow from './Eyebrow'
import { useViewOnly } from './viewOnly'

/**
 * The page shell. Seven screens each hand-rolled their own container width,
 * padding and title block, which is why one of them was 1100px wide, one was
 * 900px and the rest were 1400px. There is one of each now.
 */
export function Page({
  children,
  width = 'wide',
}: {
  children: ReactNode
  /** `wide` for lists and dashboards, `narrow` for a single reading column. */
  width?: 'wide' | 'narrow'
}) {
  return (
    <div
      /* 22px top, 24px sides, 40px bottom — the denser rhythm the redesign
         asks for. The extra bottom padding keeps the last row clear of the
         viewport edge on a screen that scrolls. */
      className={`mx-auto w-full px-4 pb-10 pt-5.5 sm:px-6 ${
        width === 'narrow' ? 'max-w-225' : 'max-w-350'
      }`}
    >
      {children}
    </div>
  )
}

export interface Crumb {
  label: string
  to?: string
}

/**
 * A page title with optional breadcrumbs and trailing actions.
 * Breadcrumbs are locations only — the document screen previously rendered
 * "Dashboard / Back / 4B6DFDCC", and "Back" is not a place.
 */
export function PageHeader({
  title,
  description,
  eyebrow,
  crumbs,
  actions,
}: {
  title: string
  description?: string
  /**
   * The mono kicker above the title — "WORKSPACE · YOUR DOCUMENTS", "STEP 3
   * OF 4 · ROUTING". It lives on the header rather than in each screen so
   * the gap below it cannot drift from one page to the next.
   */
  eyebrow?: string
  crumbs?: Crumb[]
  actions?: ReactNode
}) {
  const navigate = useNavigate()
  const viewOnly = useViewOnly()

  return (
    <div className="mb-5 sm:mb-6">
      {viewOnly && (
        <p
          role="note"
          className="mb-4 rounded-control border border-info-line bg-info-soft px-3 py-2 text-meta text-info-ink"
        >
          You can see this screen but not change it. A Super Administrator can
          give you the power to change it.
        </p>
      )}
      {eyebrow && (
        <Eyebrow className="mb-1.5">{eyebrow}</Eyebrow>
      )}
      {crumbs && crumbs.length > 0 && (
        <nav aria-label="Breadcrumb" className="mb-3">
          <ol className="flex flex-wrap items-center gap-2 text-meta sm:text-ui">
            {crumbs.map((crumb, i) => (
              <li key={crumb.label} className="flex items-center gap-2">
                {i > 0 && (
                  <span aria-hidden="true" className="text-content-subtle">
                    /
                  </span>
                )}
                {crumb.to ? (
                  <button
                    type="button"
                    onClick={() => navigate(crumb.to!)}
                    className="rounded text-content-subtle transition-colors hover:text-content-muted"
                  >
                    {crumb.label}
                  </button>
                ) : (
                  <span aria-current="page" className="font-medium text-accent-ink">
                    {crumb.label}
                  </span>
                )}
              </li>
            ))}
          </ol>
        </nav>
      )}

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          {/* 24px semibold. At this size bold reads as heavy rather than
              important, and the size is already doing the work. */}
          <h1 className="text-title font-semibold tracking-[-0.02em] text-content">
            {title}
          </h1>
          {description && (
            <p className="mt-1.5 max-w-2xl text-ui leading-relaxed text-content-muted">
              {description}
            </p>
          )}
        </div>
        {actions && (
          <div className="flex flex-shrink-0 items-center gap-2">{actions}</div>
        )}
      </div>
    </div>
  )
}

/**
 * The "nothing here yet" panel. Five screens drew their own; this keeps the
 * icon size, spacing and copy hierarchy identical across all of them.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: ComponentType<{ size?: number; className?: string }>
  title: string
  description?: string
  action?: ReactNode
}) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
      <span
        aria-hidden="true"
        className="mb-4 flex h-12 w-12 items-center justify-center rounded-card bg-accent-soft text-accent-ink"
      >
        <Icon size={22} />
      </span>
      {/* `text-section`, matching every other panel heading — an empty state
          is a panel's heading when the panel has nothing else in it. */}
      <h2 className="text-section font-semibold text-content">{title}</h2>
      {description && (
        <p className="mt-1 max-w-sm text-meta text-content-muted">{description}</p>
      )}
      {action && <div className="mt-5">{action}</div>}
    </div>
  )
}
