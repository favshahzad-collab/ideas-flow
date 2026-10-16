/**
 * The one call in this application that carries no token.
 *
 * `GET /api/health` is public by design - a load balancer and a container
 * healthcheck both need it before anybody has signed in - and it reports the
 * database and the three background sweeps. It goes through `fetch` rather
 * than `apiClient` for exactly that reason: the client attaches a session and
 * handles a 401 by ending one, and there is no session here to end.
 */

export type SystemHealth =
  | { state: 'ok' }
  /** Reachable, and saying something is wrong. `parts` names what. */
  | { state: 'degraded'; parts: string[] }
  /** Not reachable at all, which is worth saying: the form will not work. */
  | { state: 'unreachable' }

type HealthBody = {
  status?: string
  database?: string
  jobs?: Record<string, string>
}

export async function fetchSystemHealth(): Promise<SystemHealth> {
  try {
    /*
     * A short leash. This is decoration on a form somebody is trying to use,
     * so a slow answer must never be the reason the screen sits unfinished -
     * an abort lands in the catch below and reads as unreachable, which is
     * what a caller who waited five seconds has in fact experienced.
     */
    const response = await fetch('/api/health', {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    })

    // 503 is a real answer with a real body: the endpoint reports being
    // unhealthy that way, so the body is read either way.
    const body = (await response.json()) as HealthBody

    const parts = [
      ...(body.database && body.database !== 'up' ? ['database'] : []),
      ...Object.entries(body.jobs ?? {})
        .filter(([, value]) => value !== 'ok')
        .map(([name]) => name),
    ]

    if (parts.length > 0) return { state: 'degraded', parts }
    if (body.status !== 'ok') return { state: 'degraded', parts: ['service'] }

    return { state: 'ok' }
  } catch {
    return { state: 'unreachable' }
  }
}
