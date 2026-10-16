import { useEffect, useState } from 'react'
import { Check, Minus, ShieldCheck, Users } from 'lucide-react'
import { Page, PageHeader } from '../components/ui/Page'
import { Card, CardHeader, Badge } from '../components/ui/Card'
import Eyebrow from '../components/ui/Eyebrow'
import PeopleTabs from '../components/people/PeopleTabs'
import AdministratorsCard from '../components/people/AdministratorsCard'
import { fetchAccessControl, type AccessControlMatrix } from '../services/AdminApi'

/**
 * What each role may do, recited from the server.
 *
 * The reason this screen exists: an administrator setting somebody's System
 * role was choosing between two words with nothing to tell them what either
 * one bought. The rules were real and enforced — spread across fourteen route
 * files and the document-scoping rules — but there was nowhere to read them.
 *
 * Every cell comes from `GET /api/admin/access-control`, and the route test
 * refuses to pass if the matrix describes a route that is not guarded the way
 * it claims. A page that says "administrators only" about something anybody
 * can reach would be worse than no page, because it would be believed.
 */

const ROLE_LABELS: Record<string, string> = {
  ADMINISTRATOR: 'Administrator',
  USER: 'Staff',
}

const ROLE_HINTS: Record<string, string> = {
  ADMINISTRATOR: 'Runs the system. Everything Staff can do, and the administration screens.',
  USER: 'Prepares memos and acts on the approvals assigned to them.',
}

function roleLabel(role: string) {
  return ROLE_LABELS[role] ?? role
}

/** A held capability, or a plainly absent one. Never colour alone. */
function Held({ held, role, what }: { held: boolean; role: string; what: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-meta font-medium ${
        held ? 'text-accent-ink' : 'text-content-faint'
      }`}
    >
      <span
        aria-hidden="true"
        className={`flex h-4.5 w-4.5 items-center justify-center rounded-pill ${
          held ? 'bg-accent-soft' : 'bg-sunken'
        }`}
      >
        {held ? <Check size={11} strokeWidth={3} /> : <Minus size={11} strokeWidth={3} />}
      </span>
      <span className="sr-only">
        {roleLabel(role)}: {held ? 'can' : 'cannot'} {what}
      </span>
      <span aria-hidden="true">{held ? 'Yes' : 'No'}</span>
    </span>
  )
}

export default function AccessControlPage() {
  const [matrix, setMatrix] = useState<AccessControlMatrix | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    fetchAccessControl()
      .then(result => {
        if (!cancelled) setMatrix(result)
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Could not load access control')
        }
      })

    return () => {
      cancelled = true
    }
  }, [])

  const groups = matrix
    ? [...new Set(matrix.capabilities.map(capability => capability.group))]
    : []

  return (
    <Page>
      <PageHeader
        eyebrow="Administration · Access control"
        title="Access control"
        description="Who administers the system and what each administrator may do. The Super Administrator hands the role over and chooses everybody else's rights here; below is what every role can do."
      />

      <PeopleTabs />

      {error && (
        <Card className="mb-4">
          <p role="alert" className="px-3.5 py-3 text-ui text-danger-ink">
            {error}
          </p>
        </Card>
      )}

      {!matrix && !error && (
        <Card>
          <p className="px-3.5 py-6 text-ui text-content-muted">Loading the rules…</p>
        </Card>
      )}

      {matrix && (
        <div className="space-y-4">
          {/* Who administers, and what each of them may do - the part of
              this screen that changes anything. */}
          <AdministratorsCard matrix={matrix} />

          {/* The roles themselves, before the grid of what they hold. */}
          <div className="grid gap-3 sm:grid-cols-2">
            {matrix.roles.map(role => (
              <Card key={role} accent={role === 'ADMINISTRATOR' ? 'accent' : 'neutral'}>
                <div className="flex items-start gap-2.5 px-3.5 py-3">
                  <span
                    aria-hidden="true"
                    className={`flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-control ${
                      role === 'ADMINISTRATOR'
                        ? 'bg-accent-soft text-accent-ink'
                        : 'bg-neutral-soft text-content-muted'
                    }`}
                  >
                    {role === 'ADMINISTRATOR' ? <ShieldCheck size={15} /> : <Users size={15} />}
                  </span>
                  <div className="min-w-0">
                    <h2 className="text-section font-semibold text-content">
                      {roleLabel(role)}
                    </h2>
                    <p className="mt-0.5 text-meta leading-relaxed text-content-muted">
                      {ROLE_HINTS[role] ?? 'No description for this role yet.'}
                    </p>
                    <p className="mt-1.5 font-mono text-data uppercase tracking-wide text-content-faint">
                      {
                        matrix.capabilities.filter(capability =>
                          capability.roles.includes(role)
                        ).length
                      }{' '}
                      of {matrix.capabilities.length} capabilities
                    </p>
                  </div>
                </div>
              </Card>
            ))}
          </div>

          {groups.map(group => (
            <Card key={group}>
              <CardHeader
                title={group}
                hint={`What each role may do with ${group.toLowerCase()}.`}
              />
              {/* Wide content scrolls inside its own container, never the page.
                  On a phone there is no room for a column per role, so each
                  capability becomes a block with the roles listed under it -
                  the same table, laid out by CSS, so nothing is said twice. */}
              <div className="overflow-x-auto">
                <table className="block w-full border-collapse text-left sm:table sm:min-w-160">
                  <thead className="max-sm:sr-only">
                    <tr className="border-b border-line-soft">
                      <th scope="col" className="px-3.5 py-2">
                        <Eyebrow as="span">Capability</Eyebrow>
                      </th>
                      {matrix.roles.map(role => (
                        <th key={role} scope="col" className="w-28 px-3.5 py-2">
                          <Eyebrow as="span">{roleLabel(role)}</Eyebrow>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="block sm:table-row-group">
                    {matrix.capabilities
                      .filter(capability => capability.group === group)
                      .map(capability => (
                        <tr
                          key={capability.id}
                          className="flex flex-wrap gap-x-5 border-b border-line-soft px-3.5 pb-3 last:border-0 sm:table-row sm:p-0"
                        >
                          <th
                            scope="row"
                            className="block w-full pt-3 pb-2 font-normal sm:table-cell sm:w-auto sm:px-3.5 sm:pb-3"
                          >
                            <span className="block text-ui font-medium text-content">
                              {capability.title}
                            </span>
                            {/* The limits live here — "only once the workflow
                                has reached their step" is the part somebody
                                actually needs when they are deciding. */}
                            <span className="mt-0.5 block max-w-prose text-meta leading-relaxed text-content-muted">
                              {capability.detail}
                            </span>
                          </th>
                          {matrix.roles.map(role => (
                            <td
                              key={role}
                              className="flex items-center gap-2 align-top sm:table-cell sm:px-3.5 sm:py-3"
                            >
                              {/* The column heading, which a phone does not show. */}
                              <span aria-hidden="true" className="text-meta text-content-muted sm:hidden">
                                {roleLabel(role)}
                              </span>
                              <Held
                                held={capability.roles.includes(role)}
                                role={role}
                                what={capability.title.toLowerCase()}
                              />
                            </td>
                          ))}
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </Card>
          ))}

          <Card accent="info">
            <CardHeader
              title="Reviewer and Approver are not system roles"
              hint="They are positions on a memo, which is why they are not columns above."
            />
            <div className="space-y-2.5 px-3.5 py-3 text-ui leading-relaxed text-content-muted">
              <p className="max-w-prose">
                Somebody becomes a reviewer or an approver by being placed on a
                particular memo&rsquo;s approval chain. That is what lets the same
                person review one memo and give final approval on another, without
                needing a second account.
              </p>
              <p className="max-w-prose">
                What that placement buys is already narrow, and it is enforced on
                every request rather than by hiding a link:
              </p>
              <ul className="max-w-prose list-disc space-y-1 pl-5">
                <li>
                  They see the memo only once the approval chain has{' '}
                  <strong className="font-medium text-content">reached their step</strong>
                  . A later approver cannot read a memo still sitting with an
                  earlier one.
                </li>
                <li>
                  They can decide{' '}
                  <strong className="font-medium text-content">their own step only</strong>
                  . No role lets anybody act on a step assigned to somebody else.
                </li>
                <li>
                  Everything else in the organisation stays invisible to them
                  unless they prepared it.
                </li>
              </ul>
              <p className="max-w-prose">
                <Badge tone="info">Workflows are built in Workflow studio</Badge>
              </p>
            </div>
          </Card>
        </div>
      )}
    </Page>
  )
}
