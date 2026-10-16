import { Card, Avatar } from '../ui/Card'
import type { AdministrationEntry } from '../../services/auditApi'
import { describeChanges, readableAction } from '../../utils/changeHistory'
import { formatDisplayDate } from '../../utils/format'
import { formatFullName } from '../../utils/user'

/**
 * One row per change to the system.
 *
 * The four things somebody opens this to find are who, what, to which thing,
 * and when. The fifth - the address it came from - is here because the
 * question that brings an administrator to this screen is often "was that
 * really them", and it is the only column that can speak to it.
 */

function when(iso: string): string {
  const at = new Date(iso)
  const time = at.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  })
  return `${formatDisplayDate(iso)}, ${time}`
}

export default function ChangeHistoryTable({
  entries,
}: {
  entries: AdministrationEntry[]
}) {
  return (
    <Card>
      <div className="overflow-x-auto">
        <table className="w-full text-left">
          <caption className="sr-only">
            Changes to the system, newest first
          </caption>
          <thead>
            <tr className="border-b border-line-soft">
              <th scope="col" className="px-3 py-2 text-meta font-medium text-content-subtle">
                When
              </th>
              <th scope="col" className="px-3 py-2 text-meta font-medium text-content-subtle">
                Who
              </th>
              <th scope="col" className="px-3 py-2 text-meta font-medium text-content-subtle">
                What
              </th>
              <th scope="col" className="px-3 py-2 text-meta font-medium text-content-subtle">
                Changed
              </th>
              <th scope="col" className="px-3 py-2 text-meta font-medium text-content-subtle">
                From
              </th>
            </tr>
          </thead>
          <tbody>
            {entries.map(entry => (
              <tr key={entry.id} className="border-b border-line-soft last:border-b-0">
                <td className="whitespace-nowrap px-3 py-2.5 font-mono text-data text-content-subtle">
                  {when(entry.at)}
                </td>
                <td className="px-3 py-2.5">
                  {entry.actor ? (
                    <span className="flex items-center gap-2">
                      <Avatar
                        firstName={entry.actor.firstName}
                        lastName={entry.actor.lastName}
                        size="xs"
                      />
                      <span className="text-ui text-content">
                        {formatFullName(entry.actor.firstName, entry.actor.lastName)}
                      </span>
                    </span>
                  ) : (
                    /* The account was deleted afterwards. The row stays, and
                       says so - dropping it would let removing somebody erase
                       what they did. */
                    <span className="text-ui text-content-subtle">
                      No longer a user
                    </span>
                  )}
                </td>
                <td className="px-3 py-2.5">
                  <span className="text-ui text-content">
                    {readableAction(entry.action)}
                  </span>
                  <span className="mt-0.5 block text-meta text-content-subtle">
                    {entry.area}
                    {entry.subject ? ` · ${entry.subject}` : ''}
                  </span>
                </td>
                <td className="max-w-80 px-3 py-2.5 text-meta leading-relaxed text-content-muted">
                  {describeChanges(entry)}
                </td>
                <td className="whitespace-nowrap px-3 py-2.5 font-mono text-data text-content-subtle">
                  {entry.ipAddress ?? '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  )
}
