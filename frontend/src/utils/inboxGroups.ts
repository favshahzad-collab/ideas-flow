import type { NotificationItem, NotificationUiCategory } from '../types/notification'

/**
 * Inbox grouping. The old page had an All / Unread tab pair, which sorted by
 * a property nobody acts on — "unread" says whether you have looked at
 * something, not whether it wants anything from you. These three groups sort
 * by what you have to do instead, so the top of the page is the work.
 */

export type InboxGroupKey = 'needsYou' | 'thisWeek' | 'older'

export const INBOX_GROUP_LABELS: Record<InboxGroupKey, string> = {
  needsYou: 'Needs you',
  thisWeek: 'Earlier this week',
  older: 'Older',
}

const GROUP_ORDER: InboxGroupKey[] = ['needsYou', 'thisWeek', 'older']

const WEEK_MS = 7 * 24 * 60 * 60 * 1000

/**
 * The categories that ask something of the reader: an approval waiting on
 * them, one that has run past its deadline, and a revision they have to make.
 * Read state is deliberately not part of this — having glanced at an approval
 * request does not complete it.
 *
 * `overdue` was missing along with the type itself, so a chased approval sorted
 * into "This week" underneath things nobody has to do. The one notification
 * that exists because somebody is late was the one not in "Needs you".
 *
 * `rejected` asks its preparer for a decision - resubmit it, or leave it as
 * rejected - and the server says `needsAction` only for them, only until they
 * make one.
 *
 * `comment` is deliberately absent: it is news about a memo, not a task, and
 * putting every comment in "Needs you" empties that group of its meaning.
 *
 * The first three are about a memo, and only count while the memo is still
 * waiting on the reader. They used to count for ever: nothing took an
 * approval notice back once it was signed, returned or moved, so "Needs you"
 * filled with work that was finished and repeated My queue with it. The
 * server now says, per notice, whether the work is still there
 * (`needsAction`), and a finished one sorts by date like any other news.
 *
 * `security` is present on its own terms: "two-factor was turned off on your
 * account" asks the reader to confirm it was them, and to raise it now if it
 * was not. It is the one row here that is not about a memo, and the one whose
 * cost of being read late is highest.
 */
const MEMO_WORK = new Set<NotificationUiCategory>(['action', 'overdue', 'revision', 'rejected'])

export function isActionable(notification: NotificationItem): boolean {
  if (notification.category === 'security') return true
  return MEMO_WORK.has(notification.category) && notification.needsAction
}

export function groupKeyFor(
  notification: NotificationItem,
  now: number = Date.now(),
): InboxGroupKey {
  if (isActionable(notification)) return 'needsYou'

  const age = now - new Date(notification.createdAt).getTime()
  /* An unparseable date sorts as recent rather than vanishing into OLDER at
     the bottom of the page, where nobody would find it. */
  if (!Number.isFinite(age) || age < WEEK_MS) return 'thisWeek'
  return 'older'
}

export interface InboxGroup {
  key: InboxGroupKey
  label: string
  items: NotificationItem[]
}

/** Groups in fixed order, newest first inside each, empty groups dropped. */
export function groupNotifications(
  notifications: NotificationItem[],
  now: number = Date.now(),
): InboxGroup[] {
  const buckets = new Map<InboxGroupKey, NotificationItem[]>(
    GROUP_ORDER.map(key => [key, []]),
  )

  for (const notification of notifications) {
    buckets.get(groupKeyFor(notification, now))!.push(notification)
  }

  return GROUP_ORDER.map(key => ({
    key,
    label: INBOX_GROUP_LABELS[key],
    items: [...buckets.get(key)!].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    ),
  })).filter(group => group.items.length > 0)
}

/**
 * The eyebrow above the title — "4 UNREAD · 2 NEED ACTION". Both halves are
 * counted from the list on screen, never assumed.
 */
export function summariseInbox(notifications: NotificationItem[]): string {
  const unread = notifications.filter(notification => !notification.isRead).length
  const needAction = notifications.filter(isActionable).length

  if (notifications.length === 0) return 'Inbox · empty'
  return `${unread} unread · ${needAction} need action`
}
