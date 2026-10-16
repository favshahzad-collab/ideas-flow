import { NavLink } from 'react-router-dom'
import { ROUTES } from '../../types/routes'

/**
 * The two halves of one subject: who the people are, and what each role they
 * can be given may do.
 *
 * These were two rows in the sidebar, side by side, opened by the same
 * capability — `users.manage` — so neither ever appeared without the other.
 * Two rows for one subject is how a rail stops being scannable, and the
 * second of them is a read-only reference somebody consults *while* setting
 * a role, which is the definition of a tab rather than a destination.
 *
 * Links, not `role="tab"`. Each half has its own URL and always has: they are
 * bookmarked, they are offered by the command palette, and the modal that
 * asks for a System role links straight to the matrix. `role="tab"` would
 * promise arrow-key movement between panels of one page and would leave the
 * browser's Back button doing something the widget never mentioned.
 */
const TABS = [
  { to: ROUTES.people, label: 'People & delegation' },
  { to: ROUTES.accessControl, label: 'Access control' },
] as const

export default function PeopleTabs() {
  return (
    <nav
      aria-label="People sections"
      className="-mt-2 mb-4 flex gap-1 overflow-x-auto border-b border-line-soft"
    >
      {TABS.map(tab => (
        <NavLink
          key={tab.to}
          to={tab.to}
          end
          className={({ isActive }) =>
            /* The underline sits on the strip's own border, which is what
               `-mb-px` is for — without it the active tab draws a second
               line one pixel below the first. */
            `-mb-px flex-shrink-0 border-b-2 px-3 py-2 text-ui transition-colors ${
              isActive
                ? 'border-accent font-semibold text-content'
                : 'border-transparent text-content-muted hover:text-content'
            }`
          }
        >
          {tab.label}
        </NavLink>
      ))}
    </nav>
  )
}
