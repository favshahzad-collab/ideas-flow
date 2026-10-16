import { describe, expect, it } from 'vitest'
import type { ApiNotification, ApiNotificationType } from '../types/notification'
import { mapApiNotificationToItem, mapNotificationCategory } from './notificationMapper'

/**
 * The inbox row. The category picks the icon and the colour, so a mapping that
 * silently falls through leaves a notification with no visual identity at all
 * - and the one that does that is the one nobody notices, because it is the
 * rare type.
 */

const notification = (
  overrides: Partial<ApiNotification> = {},
): ApiNotification => ({
  id: 'n1',
  type: 'APPROVAL_NEEDED',
  title: 'Approval Required',
  message: 'Document "Warehouse lease" requires your approval.',
  documentId: 'd1',
  workflowRunId: 'r1',
  isRead: false,
  readAt: null,
  createdAt: new Date().toISOString(),
  needsAction: true,
  ...overrides,
})

/**
 * Every value of `enum NotificationType` in `schema.prisma`, copied here.
 *
 * Declared once because it used to be declared twice, and the two disagreed:
 * one list carried the comment on it saying "this is the list, in one place"
 * while already missing `APPROVAL_OVERDUE` and `COMMENT_ADDED`, which is
 * exactly the drift it existed to catch. A guard that is itself out of date
 * is worse than no guard, because it reads as coverage.
 */
const FROM_THE_SCHEMA: ApiNotificationType[] = [
  'APPROVAL_NEEDED',
  'APPROVAL_OVERDUE',
  'APPROVAL_REMINDER',
  'COMMENT_ADDED',
  'REVISION_REQUESTED',
  'REJECTED',
  'APPROVED',
  'RESUBMITTED',
  'DOCUMENT_DELETED',
  'DELEGATION_STARTED',
  'DELEGATION_ENDED',
  'STEP_SKIPPED',
  'STEP_REASSIGNED',
  'SECURITY_ALERT',
]

describe('mapNotificationCategory', () => {
  it.each([
    ['APPROVAL_NEEDED', 'action'],
    ['APPROVED', 'approved'],
    ['REVISION_REQUESTED', 'revision'],
    ['REJECTED', 'rejected'],
    ['RESUBMITTED', 'submitted'],
    ['DOCUMENT_DELETED', 'deleted'],
  ] as const)('maps %s to %s', (type, expected) => {
    expect(mapNotificationCategory(type)).toBe(expected)
  })

  it('has a category for every type the API can send', () => {
    // The switch has no default, so a new backend type would return undefined
    // and render an inbox row with no icon.
    for (const type of FROM_THE_SCHEMA) {
      expect(mapNotificationCategory(type), type).toBeTruthy()
    }
  })
})

describe('mapApiNotificationToItem', () => {
  it('carries the fields the row renders', () => {
    const item = mapApiNotificationToItem(
      notification({ title: 'Document Rejected', type: 'REJECTED' }),
    )

    expect(item).toMatchObject({
      id: 'n1',
      category: 'rejected',
      title: 'Document Rejected',
      documentId: 'd1',
      isRead: false,
    })
  })

  it('adds both a relative and an absolute time', () => {
    // The row shows "5m ago" and the tooltip shows the date; a row with one
    // and not the other reads as either vague or unreadable.
    const item = mapApiNotificationToItem(
      notification({ createdAt: new Date(Date.now() - 5 * 60_000).toISOString() }),
    )

    expect(item.relativeTime).toBe('5m ago')
    expect(item.displayDate).toMatch(/^[A-Z][a-z]{2} \d{1,2}, \d{4}$/)
  })

  it('keeps a null documentId rather than inventing one', () => {
    // Not every notification points at a document, and a row that links to
    // /documents/null is worse than a row that does not link.
    const item = mapApiNotificationToItem(notification({ documentId: null }))

    expect(item.documentId).toBeNull()
  })

  it('carries whether the memo is still waiting on the reader', () => {
    expect(
      [true, false].map(
        needsAction => mapApiNotificationToItem(notification({ needsAction })).needsAction,
      ),
    ).toEqual([true, false])
  })

  it('preserves the read state', () => {
    expect(
      mapApiNotificationToItem(notification({ isRead: true })).isRead,
    ).toBe(true)
  })
})

describe('the types the server can actually send', () => {
  /*
   * Found by reading `enum NotificationType` in `schema.prisma` beside the
   * union in `types/notification.ts`. Two were missing: `APPROVAL_OVERDUE`,
   * which the deadline sweep raises, and `COMMENT_ADDED`. The switch is
   * exhaustive over the union, so a type the union does not name maps to
   * `undefined` - the row falls back to a plain bell and the inbox files it
   * as news.
   *
   * It never showed because no deadline had ever been set on this deployment,
   * so the sweep had never raised one. The administration screen that lets
   * somebody set a deadline is what makes it reachable.
   */

  it('gives an overdue approval its own category, not the ordinary one', () => {
    // Not folded into `action`: the difference between "this needs you" and
    // "this needed you three days ago" is the whole reason the sweep exists.
    expect(mapNotificationCategory('APPROVAL_OVERDUE')).toBe('overdue')
    expect(mapNotificationCategory('APPROVAL_NEEDED')).toBe('action')
  })

  it('gives a comment one too', () => {
    expect(mapNotificationCategory('COMMENT_ADDED')).toBe('comment')
  })

  it('treats both directions of a delegation as the same kind of fact', () => {
    // Opposites, deliberately sharing a category: the title says which way
    // round, and a delegate scanning a list should see one kind of row.
    expect(mapNotificationCategory('DELEGATION_STARTED')).toBe('delegation')
    expect(mapNotificationCategory('DELEGATION_ENDED')).toBe('delegation')
  })

  it('keeps a skipped approval out of the category that means work', () => {
    /*
     * It used to map to `action`, because the server sent APPROVAL_NEEDED for
     * want of a type that said what happened. Nothing is being asked of
     * somebody who was passed over.
     */
    expect(mapNotificationCategory('STEP_SKIPPED')).toBe('skipped')
    expect(mapNotificationCategory('STEP_SKIPPED')).not.toBe('action')
  })

  it('keeps a reassignment apart from a skip, which means the opposite', () => {
    /*
     * Skipped says the memo went on with that approval never given.
     * Reassigned says the approval is still required and is now somebody
     * else's. Sharing a category would put one icon on two events, one of
     * which is the reader losing a job and the other the reader's job being
     * dropped - and it is the approvers behind the step who most need to be
     * able to tell those apart at a glance.
     */
    expect(mapNotificationCategory('STEP_REASSIGNED')).toBe('reassigned')
    expect(mapNotificationCategory('STEP_REASSIGNED')).not.toBe('skipped')
    // And not work: there is nothing for the reader to do about it.
    expect(mapNotificationCategory('STEP_REASSIGNED')).not.toBe('action')
  })

  it('gives a security alert its own category, apart from every memo one', () => {
    /*
     * The only type that is not about a memo at all. It carries no
     * documentId, so a row that mapped it to a memo category would offer an
     * Open button with nothing behind it.
     */
    expect(mapNotificationCategory('SECURITY_ALERT')).toBe('security')
  })

  it('has a category for every type the backend enum holds', () => {
    /*
     * Copied from `enum NotificationType` in `schema.prisma`. If the two drift
     * again this fails, which is the point - the previous drift shipped and
     * nothing said a word about it.
     */
    for (const type of FROM_THE_SCHEMA) {
      expect(mapNotificationCategory(type)).toBeDefined()
    }
  })
})

describe('a reminder is not a breach', () => {
  it('files "somebody is waiting" under work, not under overdue', () => {
    /*
     * Overdue is a statement about a deadline that has passed. Most memos
     * here have no deadline set on them at all, so filing a nudge as overdue
     * would put a late-looking row in somebody's inbox about a memo nothing
     * ever said was late - and would make the sweep's own notice, which IS
     * about a missed deadline, indistinguishable from it.
     */
    expect(mapNotificationCategory('APPROVAL_REMINDER')).toBe('action')
    expect(mapNotificationCategory('APPROVAL_OVERDUE')).toBe('overdue')
  })
})
