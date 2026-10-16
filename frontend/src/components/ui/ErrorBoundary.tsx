import { Component, type ErrorInfo, type ReactNode } from 'react'
import { AlertTriangle, RefreshCw, RotateCcw } from 'lucide-react'
import Button from './Button'

/**
 * The app had no error boundary at all, so any exception thrown while
 * rendering unmounted the whole tree and left a white screen — no message,
 * no way back, and nothing on screen to suggest a reload would help.
 *
 * Two failures reach this. A genuine render bug, which a retry may survive if
 * it came from transient state; and a route chunk that no longer exists on the
 * server, which every open tab hits the moment a new build is deployed. The
 * second is the common one in practice and only a reload fixes it, so it gets
 * its own wording.
 */

/**
 * Browsers disagree on the wording, so match all three rather than one.
 * Chrome: "Failed to fetch dynamically imported module"
 * Firefox: "error loading dynamically imported module"
 * Safari: "Importing a module script failed"
 */
function isChunkLoadError(error: Error): boolean {
  const message = `${error.name} ${error.message}`.toLowerCase()
  return (
    message.includes('dynamically imported module') ||
    message.includes('importing a module script failed') ||
    message.includes('chunkloaderror')
  )
}

interface Props {
  children: ReactNode
  /** Cover the viewport rather than just the content column. */
  full?: boolean
}

interface State {
  error: Error | null
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // No logging backend to send this to, so the console is the only record
    // there is. Without it a caught error leaves no trace at all.
    console.error('Unhandled render error:', error, info.componentStack)
  }

  private retry = (): void => {
    this.setState({ error: null })
  }

  private reload = (): void => {
    window.location.reload()
  }

  render(): ReactNode {
    const { error } = this.state

    if (!error) {
      return this.props.children
    }

    const stale = isChunkLoadError(error)

    return (
      <div
        className={`flex ${
          this.props.full ? 'min-h-screen' : 'min-h-[50vh]'
        } items-center justify-center bg-canvas px-6 py-12`}
      >
        <div role="alert" className="w-full max-w-md text-center">
          <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-full bg-danger-soft">
            <AlertTriangle size={20} className="text-danger-ink" aria-hidden="true" />
          </div>

          <h1 className="mt-4 text-pane font-semibold text-content">
            {stale ? 'A new version is available' : 'Something went wrong'}
          </h1>

          <p className="mt-2 text-ui leading-relaxed text-content-muted">
            {stale
              ? 'This page was updated while you had it open. Reload to pick up the latest version — nothing you have submitted is affected.'
              : 'This page stopped responding. Your work is saved on the server; nothing has been lost.'}
          </p>

          <div className="mt-6 flex items-center justify-center gap-3">
            {stale ? (
              <Button
                onClick={this.reload}
                icon={<RefreshCw size={15} aria-hidden="true" />}
              >
                Reload the page
              </Button>
            ) : (
              <>
                <Button
                  onClick={this.retry}
                  icon={<RotateCcw size={15} aria-hidden="true" />}
                >
                  Try again
                </Button>
                <Button variant="secondary" onClick={this.reload}>
                  Reload the page
                </Button>
              </>
            )}
          </div>

          {/* The message itself, for a bug report. Collapsed, because it
              means nothing to most people who will read this screen. */}
          {!stale && (
            <details className="mt-6 text-left">
              <summary className="cursor-pointer text-meta text-content-subtle hover:text-content-muted">
                Technical details
              </summary>
              <p className="mt-2 break-words rounded-control bg-sunken px-3 py-2 font-mono text-2xs text-content-muted">
                {error.message || error.name || 'Unknown error'}
              </p>
            </details>
          )}
        </div>
      </div>
    )
  }
}
