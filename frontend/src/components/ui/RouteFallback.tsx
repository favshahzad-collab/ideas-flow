/**
 * The placeholder shown while a route's code chunk is downloading or the
 * session check is in flight. Four near-identical copies of this markup
 * existed across `RouteGuards` and `AppLayout`, drifting in width and bar
 * count; this is the single version.
 *
 * `full` covers the viewport for checks that happen before the shell is
 * rendered. Inside the shell the sidebar stays put, so it only needs to
 * fill the content column.
 */
export default function RouteFallback({
  label = 'Loading',
  full = false,
}: {
  label?: string
  full?: boolean
}) {
  return (
    <div
      className={`flex ${
        full ? 'min-h-screen' : 'min-h-[50vh]'
      } items-center justify-center bg-canvas`}
    >
      <div className="w-full max-w-md space-y-3 px-6" aria-hidden="true">
        <div className="h-6 w-40 animate-pulse rounded bg-line-soft" />
        <div className="h-24 animate-pulse rounded-card bg-line-soft" />
      </div>
      {/* Announced, because a skeleton is invisible to a screen reader. */}
      <div aria-live="polite" className="sr-only">
        {label}
      </div>
    </div>
  )
}
