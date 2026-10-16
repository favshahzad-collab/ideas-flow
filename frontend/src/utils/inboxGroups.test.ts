import { describe, expect, it } from 'vitest'
import type { NotificationItem, NotificationUiCategory } from '../types/notification'
import {
  groupKeyFor,
  groupNotifications,
  isActionable,
  summariseInbox,
} from './inboxGroups'

const NOW = new Date('2026-09-04T12:00:00Z').getTime()
const DAY = 24 * 60 * 60 * 1000
const ago = (ms: number) => new Date(NOW - ms).toISOString()

let seq = 0

function item(over: Partial<NotificationItem> = {}): NotificationItem {
  seq += 1
  return {
    id: `n${seq}`,
    category: 'approved',
    title: 'Document approved',
    message: 'Capex request cleared step 2.',
    documentId: 'd1',
    createdAt: ago(DAY),
    relativeTime: '1d ago',
    displayDate: 'Sep 3, 2026',
    isRead: false,
    needsAction: true,
    ...over,
  }
}

describe('isActionable', () => {
  it('is true for the categories that ask something of the reader', () => {
    expect(isActionable(item({ category: 'action' }))).toBe(true)
    expect(isActionable(item({ category: 'revision' }))).toBe(true)
    // A rejection asks its preparer to resubmit or leave it as rejected.
    expect(isActionable(item({ category: 'rejected' }))).toBe(true)
  })

  it('is false for approval work the memo is no longer waiting on', () => {
    // Signed, returned, moved to somebody else or deleted: the server says so
    // per notice, and a finished one is news like any other.
    for (const category of ['action', 'overdue', 'revision', 'rejected'] as const) {
      expect(isActionable(item({ category, needsAction: false }))).toBe(false)
    }
  })

  it('keeps a security alert actionable whatever the server says of memos', () => {
    // It is not about a memo, so no memo can finish it.
    expect(isActionable(item({ category: 'security', needsAction: false }))).toBe(true)
  })

  it('is false for the outcomes', () => {
    const outcomes: NotificationUiCategory[] = [
      'approved',
      'submitted',
      'deleted',
    ]
    for (const category of outcomes) {
      expect(isActionable(item({ category }))).toBe(false)
    }
  })
})

describe('groupKeyFor', () => {
  it('puts anything actionable in NEEDS YOU regardless of age', () => {
    expect(groupKeyFor(item({ category: 'action', createdAt: ago(90 * DAY) }), NOW)).toBe(
      'needsYou',
    )
  })

  it('keeps an actionable notification in NEEDS YOU after it has been read', () => {
    // Having glanced at an approval request does not complete it.
    expect(groupKeyFor(item({ category: 'action', isRead: true }), NOW)).toBe('needsYou')
  })

  it('files a finished approval by its date, not under NEEDS YOU', () => {
    expect(groupKeyFor(item({ category: 'action', needsAction: false }), NOW)).toBe('thisWeek')
    expect(
      groupKeyFor(item({ category: 'action', needsAction: false, createdAt: ago(30 * DAY) }), NOW),
    ).toBe('older')
  })

  it('splits the rest on a week', () => {
    expect(groupKeyFor(item({ createdAt: ago(6 * DAY) }), NOW)).toBe('thisWeek')
    expect(groupKeyFor(item({ createdAt: ago(8 * DAY) }), NOW)).toBe('older')
  })

  it('treats an unparseable date as recent rather than burying it', () => {
    expect(groupKeyFor(item({ createdAt: 'not-a-date' }), NOW)).toBe('thisWeek')
  })
})

describe('groupNotifications', () => {
  it('orders the groups and drops the empty ones', () => {
    const groups = groupNotifications(
      [
        item({ createdAt: ago(30 * DAY) }),
        item({ category: 'action', createdAt: ago(2 * DAY) }),
      ],
      NOW,
    )

    expect(groups.map(group => group.key)).toEqual(['needsYou', 'older'])
  })

  it('sorts newest first inside a group', () => {
    const older = item({ createdAt: ago(5 * DAY) })
    const newer = item({ createdAt: ago(1 * DAY) })

    const [group] = groupNotifications([older, newer], NOW)
    expect(group.items.map(entry => entry.id)).toEqual([newer.id, older.id])
  })

  it('returns nothing for an empty inbox', () => {
    expect(groupNotifications([], NOW)).toEqual([])
  })
})

describe('summariseInbox', () => {
  it('counts unread and actionable separately', () => {
    const summary = summariseInbox([
      item({ category: 'action', isRead: false }),
      item({ category: 'revision', isRead: true }),
      item({ category: 'approved', isRead: false }),
    ])

    expect(summary).toBe('2 unread · 2 need action')
  })

  it('does not count approval work that is already finished', () => {
    const summary = summariseInbox([
      item({ category: 'action', isRead: false }),
      item({ category: 'action', isRead: false, needsAction: false }),
      item({ category: 'overdue', isRead: true, needsAction: false }),
    ])

    expect(summary).toBe('2 unread · 1 need action')
  })

  it('says so when there is nothing', () => {
    expect(summariseInbox([])).toBe('Inbox · empty')
  })
})

describe('an approval that has run past its deadline', () => {
  it('sorts into Needs you, not into the news', () => {
    /*
     * The one notification that exists BECAUSE somebody is late was the one
     * not in the group of things to do: it fell through to "This week" and sat
     * under items nobody has to act on. A consequence of `overdue` being
     * missing from the category union entirely.
     */
    expect(groupKeyFor(item({ category: 'overdue', createdAt: ago(0) }), NOW)).toBe(
      'needsYou',
    )
  })

  it('stays there however old it is', () => {
    // Age is what made it overdue in the first place. Ageing out of the group
    // would hide exactly the memo that has been waiting longest.
    expect(
      groupKeyFor(item({ category: 'overdue', createdAt: ago(60 * DAY) }), NOW),
    ).toBe('needsYou')
  })

  it('leaves a delegation as news: the work it implies arrives on its own', () => {
    // Covering for somebody is not itself a task. The memos that follow come
    // through as ordinary approval requests, and those do reach "Needs you".
    expect(
      groupKeyFor(item({ category: 'delegation', createdAt: ago(0) }), NOW),
    ).toBe('thisWeek')
  })

  it('leaves a skipped approval as news, since nothing is left to do on it', () => {
    // It reached "Needs you" while the server typed it APPROVAL_NEEDED, which
    // is the group this file exists to keep honest.
    expect(groupKeyFor(item({ category: 'skipped', createdAt: ago(0) }), NOW)).toBe(
      'thisWeek',
    )
  })

  it('puts a security alert in front of the reader, not under the memos', () => {
    /*
     * "Two-factor was turned off on your account" asks the reader to confirm
     * it was them and to raise it now if it was not. It is also the one row
     * here whose cost of being read late is highest - by the time it reaches
     * "Older", whoever turned the factor off has had a week.
     */
    expect(groupKeyFor(item({ category: 'security', createdAt: ago(0) }), NOW)).toBe(
      'needsYou',
    )
  })

  it('keeps it there even when it is old, because it is still unanswered', () => {
    expect(
      groupKeyFor(item({ category: 'security', createdAt: ago(40) }), NOW),
    ).toBe('needsYou')
  })

  it('leaves a comment as news rather than a task', () => {
    // A comment is something to read, not something to do. Putting every one
    // in "Needs you" empties that group of the meaning it has.
    expect(groupKeyFor(item({ category: 'comment', createdAt: ago(0) }), NOW)).toBe(
      'thisWeek',
    )
  })
})
