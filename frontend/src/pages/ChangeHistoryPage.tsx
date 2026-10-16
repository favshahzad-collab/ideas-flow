import { useEffect, useState } from 'react'
import { History, ShieldCheck } from 'lucide-react'
import { Page, PageHeader, EmptyState } from '../components/ui/Page'
import { Card } from '../components/ui/Card'
import Button from '../components/ui/Button'
import { LoadingAnnouncer, Skeleton } from '../components/ui/Skeleton'
import ChangeHistoryTable from '../components/admin/ChangeHistoryTable'
import {
  fetchAdministrationActivity,
  type AdministrationActivity,
} from '../services/auditApi'

/**
 * What was done to the system itself, rather than to any memo.
 *
 * Every row on this screen was already being recorded and sealed into the
 * ledger, and none of it could be read anywhere. The audit trail filters to
 * memos, and the ledger endpoint answers with counts and a digest - so "who
 * made this account", "who changed that role", "who saved the mail
 * credentials" all had answers reachable only from a database console. A
 * record nobody can read cannot answer the question it was written for.
 *
 * One page at a time rather than everything: the trail only grows, and a
 * screen that fetches all of it gets slower every month it is not opened.
 */

const PAGE_SIZE = 50

export default function ChangeHistoryPage() {
  const [area, setArea] = useState<string | null>(null)
  const [page, setPage] = useState(0)
  const [attempt, setAttempt] = useState(0)

  /*
   * The answer, stamped with the request it answers.
   *
   * Clearing the old rows when the filter changes has to happen without a
   * setState in the effect body - the house rule, and a real one: that is a
   * cascading render, and this screen would do it on every page turn.
   * Comparing the stamp at render time gets the same empty-while-loading
   * state out of the state that is already there.
   */
  const key = `${area ?? ''}:${page}:${attempt}`
  const [loaded, setLoaded] = useState<{
    key: string
    data: AdministrationActivity | null
    error: string | null
  } | null>(null)
  const current = loaded?.key === key ? loaded : null

  useEffect(() => {
    let cancelled = false

    fetchAdministrationActivity({
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
      ...(area ? { area } : {}),
    })
      .then(result => {
        if (!cancelled) setLoaded({ key, data: result, error: null })
      })
      .catch((problem: unknown) => {
        if (!cancelled) {
          setLoaded({
            key,
            data: null,
            error:
              problem instanceof Error
                ? problem.message
                : 'Could not read the change history.',
          })
        }
      })

    return () => {
      cancelled = true
    }
  }, [area, page, attempt, key])

  const data = current?.data ?? null
  const error = current?.error ?? null

  const header = (
    <PageHeader
      eyebrow="Administration · Change history"
      title="Change history"
      description="Every change to the system rather than to a memo — accounts, departments, delegations, approval routes, mail and sign-on. Memos have their own trail on the Audit ledger."
    />
  )

  if (error) {
    return (
      <Page>
        {header}
        <Card>
          <div className="space-y-3 p-4">
            <p role="alert" className="field-error">
              {error}
            </p>
            <Button variant="secondary" onClick={() => setAttempt(n => n + 1)}>
              Try again
            </Button>
          </div>
        </Card>
      </Page>
    )
  }

  if (!data) {
    return (
      <Page>
        {header}
        <LoadingAnnouncer loading label="Reading the change history" />
        <Card>
          <div className="space-y-2.5 p-4">
            {[0, 1, 2, 3, 4].map(row => (
              <Skeleton key={row} className="h-9 w-full" />
            ))}
          </div>
        </Card>
      </Page>
    )
  }

  const shown = page * PAGE_SIZE + data.returned
  const hasMore = shown < data.total

  return (
    <Page>
      {header}

      <div className="mb-3 flex flex-wrap items-center gap-2">
        {/* Drawn from the answer rather than hard-coded, so an area the server
            gains does not need a matching edit here to become reachable. */}
        <nav aria-label="Filter by area" className="flex flex-wrap gap-1.5">
          {[null, ...data.areas].map(option => (
            <button
              key={option ?? 'all'}
              type="button"
              aria-pressed={area === option}
              onClick={() => {
                setArea(option)
                setPage(0)
              }}
              className={`rounded-pill border px-2.5 py-1 text-meta transition-colors ${
                area === option
                  ? 'border-accent bg-accent-soft text-accent-ink'
                  : 'border-line text-content-muted hover:bg-sunken'
              }`}
            >
              {option ?? 'Everything'}
            </button>
          ))}
        </nav>
      </div>

      {data.entries.length === 0 ? (
        <Card>
          <EmptyState
            icon={History}
            title={
              area
                ? `Nothing recorded under ${area}`
                : 'Nothing has been changed yet'
            }
            description={
              area
                ? 'Try another area, or Everything.'
                : 'Accounts, departments, approval routes and configuration appear here as they are changed.'
            }
          />
        </Card>
      ) : (
        <>
          <ChangeHistoryTable entries={data.entries} />

          <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
            {/* What is on screen against what matched, because a page that
                counts its own rows and calls that the total is the one thing a
                ledger must never do. */}
            <p className="text-meta text-content-subtle">
              {`Showing ${shown} of ${data.total} ${data.total === 1 ? 'change' : 'changes'}`}
            </p>
            <div className="flex gap-2">
              <Button
                variant="secondary"
                onClick={() => setPage(n => Math.max(0, n - 1))}
                disabled={page === 0}
              >
                Newer
              </Button>
              <Button
                variant="secondary"
                onClick={() => setPage(n => n + 1)}
                disabled={!hasMore}
              >
                Older
              </Button>
            </div>
          </div>
        </>
      )}

      <p className="mt-4 flex items-start gap-2 text-meta leading-relaxed text-content-subtle">
        <ShieldCheck size={14} aria-hidden="true" className="mt-0.5 flex-shrink-0" />
        <span>
          These rows are sealed into the same hash chain as the memo trail — the
          Audit ledger reports whether it is intact. Values are shown only for
          fields the server prints; a credential is recorded as having changed,
          never as what it changed to.
        </span>
      </p>
    </Page>
  )
}
