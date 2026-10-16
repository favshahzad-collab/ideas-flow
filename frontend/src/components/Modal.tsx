import { X } from 'lucide-react'
import { useId, useRef, type ReactNode } from 'react'
import { useDialogA11y } from '../hooks/useDialogA11y'

interface ModalProps {
  open: boolean
  onClose: () => void
  title: string
  description?: string
  children: ReactNode
  size?: 'sm' | 'md' | 'lg'
}

const WIDTHS = {
  sm: 'max-w-sm',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
} as const

export default function Modal({
  open,
  onClose,
  title,
  description,
  children,
  size = 'md',
}: ModalProps) {
  const titleId = useId()
  const descId = useId()
  const panelRef = useDialogA11y(open, onClose)
  const pressedOnBackdrop = useRef(false)

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-scrim/50 p-4 backdrop-blur-[2px]"
      /*
       * Both ends of the gesture, not just the release.
       *
       * A browser fires `click` on the nearest common ancestor of the press
       * and the release - so selecting the text of a reason and letting go
       * past the edge of the panel fired a click on the backdrop, and the
       * dialog closed with everything typed in it. Dismissing has to be a
       * press *and* a release on the dimmed area.
       */
      onMouseDown={event => {
        pressedOnBackdrop.current = event.target === event.currentTarget
      }}
      onClick={event => {
        if (event.target !== event.currentTarget) return
        if (!pressedOnBackdrop.current) return
        onClose()
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        className={`w-full ${WIDTHS[size]} max-h-[90vh] overflow-y-auto rounded-card border border-line bg-surface shadow-overlay outline-none`}
        onClick={e => e.stopPropagation()}
      >
        <div className="sticky top-0 flex items-start justify-between gap-4 border-b border-line-soft bg-surface px-6 py-4">
          <div className="min-w-0">
            <h2 id={titleId} className="text-pane font-semibold text-content">
              {title}
            </h2>
            {description && (
              <p id={descId} className="mt-0.5 text-meta text-content-muted">
                {description}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close dialog"
            className="-mr-1.5 -mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-control text-content-subtle transition-colors hover:bg-sunken hover:text-content"
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>
        <div className="px-6 py-5">{children}</div>
      </div>
    </div>
  )
}
