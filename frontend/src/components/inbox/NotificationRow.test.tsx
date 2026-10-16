import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { NotificationItem, NotificationUiCategory } from '../../types/notification'
import NotificationRow from './NotificationRow'

/**
 * One line of the inbox. It is the only thing that tells a person an approval
 * is waiting on them, and the only route from that fact to the document, so
 * three things have to hold: the "you have not looked at this" state has to
 * reach somebody who cannot see the tint, the row has to be a real control
 * rather than a tappable box, and the button it offers has to promise exactly
 * what the next screen delivers - "Open to sign", never "Approve", because
 * approving here means placing a signature on a rendered PDF.
 *
 * The grouping rules live in utils/inboxGroups and are covered there. What is
 * asserted here is what the row itself says and what it fires when pressed.
 */

const DOC_ID = '3f2a9b1c-0d4e-4f5a-8b6c-7d8e9f0a1b2c'
const TITLE = 'Approval needed: Warehouse lease extension'

function notification(overrides: Partial<NotificationItem> = {}): NotificationItem {
  return {
    id: 'n-1',
    category: 'action',
    title: TITLE,
    message: 'Ayesha Khan submitted this for your review.',
    documentId: DOC_ID,
    createdAt: '2026-09-05T09:00:00.000Z',
    relativeTime: '2h ago',
    displayDate: 'Sep 5, 2026',
    isRead: false,
    needsAction: true,
    ...overrides,
  }
}

function renderRow(
  overrides: Partial<NotificationItem> = {},
  { deleting = false }: { deleting?: boolean } = {},
) {
  const onOpen = vi.fn()
  const onMarkRead = vi.fn()
  const onDelete = vi.fn()

  return {
    ...render(
      <NotificationRow
        notification={notification(overrides)}
        onOpen={onOpen}
        onMarkRead={onMarkRead}
        onDelete={onDelete}
        deleting={deleting}
      />,
    ),
    onOpen,
    onMarkRead,
    onDelete,
  }
}

describe('NotificationRow', () => {
  it('says "unread" out loud rather than only tinting the row', () => {
    renderRow({ isRead: false })

    // The unread state is carried by a background wash and a 7px dot. Neither
    // survives a screen reader or a colour-vision deficiency, so the dot has
    // to be a named image - otherwise "which of these have I dealt with" is
    // simply unanswerable without sight.
    expect(screen.getByRole('img', { name: 'Unread' })).toBeInTheDocument()
  })

  it('drops the unread marker once it has been read', () => {
    renderRow({ isRead: true })

    // A marker that never clears would make every row look outstanding, which
    // is the same as marking none of them.
    expect(screen.queryByRole('img', { name: 'Unread' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Mark read' })).not.toBeInTheDocument()
  })

  it('makes the title one real button, not a clickable block', async () => {
    const user = userEvent.setup({ delay: null })
    const { onOpen } = renderRow()

    const title = screen.getByRole('button', { name: TITLE })
    // The title is truncated to one line by CSS, so on a narrow window the
    // only way back to the whole subject line is the tooltip. Without it a
    // row reads "Approval needed: Warehouse lease ext..." and the person
    // cannot tell two leases apart without opening both.
    expect(title).toHaveAttribute('title', TITLE)

    await user.click(title)

    // A <div onClick> here would be unreachable by Tab and by a switch, and
    // the inbox is the entry point to every approval in the product.
    expect(onOpen).toHaveBeenCalledWith(DOC_ID, expect.anything())
    // Exactly once. Wrapping the row in a second handler - the obvious way to
    // make "the whole card is clickable" work - leaves the title firing twice
    // through the bubble, which double-navigates and double-marks-read.
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('is operable from the keyboard alone', async () => {
    const user = userEvent.setup({ delay: null })
    const { onOpen } = renderRow()

    await user.tab()
    expect(screen.getByRole('button', { name: TITLE })).toHaveFocus()
    await user.keyboard('{Enter}')

    expect(onOpen).toHaveBeenCalledWith(DOC_ID, expect.anything())
  })

  it('marks a notification read on the way to the document', async () => {
    const user = userEvent.setup({ delay: null })
    const { onMarkRead, onOpen } = renderRow({ isRead: false })

    await user.click(screen.getByRole('button', { name: TITLE }))

    // Opening it IS reading it. Leaving it bold afterwards means the unread
    // count never falls and stops meaning anything.
    expect(onMarkRead).toHaveBeenCalledWith('n-1')
    expect(onOpen).toHaveBeenCalledWith(DOC_ID, expect.anything())
  })

  it('does not re-mark a notification that was already read', async () => {
    const user = userEvent.setup({ delay: null })
    const { onMarkRead, onOpen } = renderRow({ isRead: true })

    await user.click(screen.getByRole('button', { name: TITLE }))

    // A needless write on every open, and every one of them a request that
    // can fail and surface an error for something the person did not ask for.
    expect(onMarkRead).not.toHaveBeenCalled()
    expect(onOpen).toHaveBeenCalledWith(DOC_ID, expect.anything())
  })

  it('leaves a notification with no document unopenable, but still readable', () => {
    renderRow({ category: 'deleted', documentId: null, title: 'Document deleted' })

    // The document is gone; a link to it would 404. The text still has to be
    // there - a deletion you cannot read about is worse than one you cannot
    // click through to.
    expect(screen.queryByRole('button', { name: 'Document deleted' })).not.toBeInTheDocument()
    expect(screen.getByText('Document deleted')).toBeInTheDocument()
    // And no second route to it either: an "Open document" button on a row
    // whose document is gone is the same 404 by another name.
    expect(screen.queryByRole('button', { name: /^Open/ })).not.toBeInTheDocument()
  })

  it('withholds the action button when the document behind the request is gone', async () => {
    const user = userEvent.setup({ delay: null })
    const { onOpen, onMarkRead } = renderRow({
      category: 'action',
      documentId: null,
      isRead: false,
    })

    // The case above pairs a missing document with a category that never had
    // an action button anyway, so it says nothing about the `documentId`
    // half of the guard. This is the combination that exercises it: an
    // approval that IS waiting on somebody, whose document was deleted out
    // from under it. Drop the guard and the row renders "Open to sign" over
    // a handler that returns immediately - a button that does nothing at all,
    // on the one row in the inbox somebody is most likely to press.
    expect(screen.queryByRole('button', { name: 'Open to sign' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: TITLE })).not.toBeInTheDocument()

    // What is left has to still work: the row can be dismissed even though it
    // can no longer be opened, or it sits in the inbox forever.
    expect(screen.getByText(TITLE)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Mark read' }))
    expect(onMarkRead).toHaveBeenCalledWith('n-1')
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('sends an approval request to the signing screen, and says so', async () => {
    const user = userEvent.setup({ delay: null })
    const { onOpen, onMarkRead } = renderRow({ category: 'action', isRead: false })

    // "Sign & approve" on a list row would promise an approval that completes
    // here. It cannot: approving means placing a signature on the PDF, so no
    // control on this row may offer to approve anything.
    expect(screen.queryByRole('button', { name: /approve/i })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Open to sign' }))

    // The promise has to be kept as well as made: a button that says "Open to
    // sign" and goes nowhere is a worse lie than the wrong wording.
    expect(onOpen).toHaveBeenCalledWith(DOC_ID, { toSign: true })
    expect(onMarkRead).toHaveBeenCalledWith('n-1')
  })

  it('offers no "Open to sign" once the memo is no longer waiting on the reader', async () => {
    const user = userEvent.setup({ delay: null })
    // Signed already, moved to somebody else, or on a memo since deleted: the
    // server says the work is gone. The row is news now, still openable by its
    // title, but it must not ask for a signature nobody can give.
    const { onOpen } = renderRow({ category: 'action', needsAction: false })

    expect(screen.queryByRole('button', { name: 'Open to sign' })).not.toBeInTheDocument()
    // The title still reads as it was sent, so the row says the ask is over.
    expect(screen.getByText('Done: this memo is no longer waiting on you.')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: TITLE }))
    expect(onOpen).toHaveBeenCalledWith(DOC_ID, { toSign: false })
  })

  it('says nothing of the kind while the memo is still waiting', () => {
    renderRow({ category: 'action', needsAction: true })

    expect(screen.queryByText(/^Done:/)).not.toBeInTheDocument()
  })

  it('sends a revision request to the revision it is about', async () => {
    const user = userEvent.setup({ delay: null })
    const { onOpen } = renderRow({ category: 'revision', isRead: true })

    await user.click(screen.getByRole('button', { name: 'Open revision' }))

    expect(onOpen).toHaveBeenCalledWith(DOC_ID, { toSign: false })
  })

  it('offers no action button on a notification that is only news', async () => {
    const user = userEvent.setup({ delay: null })
    const NEWS = 'Approved: Warehouse lease extension'
    const { onOpen } = renderRow({ category: 'approved', title: NEWS })

    // "Needs you" and "for your information" have to look different, or the
    // inbox stops being a work list. An approved-notice has nothing to do.
    expect(screen.queryByRole('button', { name: /^Open/ })).not.toBeInTheDocument()

    // But "nothing to do" is not "nowhere to go", and an absence proves
    // nothing on its own - a row that rendered no controls whatsoever would
    // satisfy the line above. The title still has to reach the document the
    // news is about, or the only way to see what was approved is to go and
    // find it in the documents list.
    await user.click(screen.getByRole('button', { name: NEWS }))
    expect(onOpen).toHaveBeenCalledWith(DOC_ID, { toSign: false })
  })

  it('names the delete control by the notification it would destroy', () => {
    renderRow()

    // Six rows of identically named "Delete" buttons is how somebody removes
    // the wrong one. There is no undo on the other side of this.
    expect(
      screen.getByRole('button', { name: `Delete notification: ${TITLE}` }),
    ).toBeInTheDocument()
  })

  it('deletes the notification it is named after, and nothing else', async () => {
    const user = userEvent.setup({ delay: null })
    const { onDelete, onOpen, onMarkRead } = renderRow()

    await user.click(
      screen.getByRole('button', { name: `Delete notification: ${TITLE}` }),
    )

    // Named correctly but wired to the wrong id - or to nothing - is the
    // failure the label above cannot see. And removing a row must not also
    // walk the person into the document they just decided to get rid of.
    expect(onDelete).toHaveBeenCalledWith('n-1')
    expect(onDelete).toHaveBeenCalledTimes(1)
    expect(onOpen).not.toHaveBeenCalled()
    expect(onMarkRead).not.toHaveBeenCalled()
  })

  it('genuinely disables the delete control while the deletion is in flight', async () => {
    const user = userEvent.setup({ delay: null })
    const { onDelete } = renderRow({}, { deleting: true })

    const remove = screen.getByRole('button', { name: `Delete notification: ${TITLE}` })
    expect(remove).toBeDisabled()

    await user.click(remove)

    // Greyed-but-live would fire a second DELETE for a row already gone.
    expect(onDelete).not.toHaveBeenCalled()
  })

  it('marks a notification read without leaving the inbox', async () => {
    const user = userEvent.setup({ delay: null })
    const { onMarkRead, onOpen } = renderRow({ isRead: false })

    await user.click(screen.getByRole('button', { name: 'Mark read' }))

    // Dismissing something you have already handled elsewhere must not drag
    // you into the document to do it.
    expect(onMarkRead).toHaveBeenCalledWith('n-1')
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('keeps the exact instant behind the relative time', () => {
    renderRow({
      relativeTime: '2h ago',
      createdAt: '2026-09-05T09:00:00.000Z',
      displayDate: 'Sep 5, 2026',
    })

    // "2h ago" is unusable in a dispute about when an approval was requested.
    // The machine-readable stamp is what makes the row auditable.
    const stamp = screen.getByText('2h ago')
    // `datetime` is inert on anything but <time>: on a <span> it is a data
    // attribute nothing parses, so the row would look right and still be
    // unreadable to anything that harvests timestamps.
    expect(stamp.tagName).toBe('TIME')
    expect(stamp).toHaveAttribute('datetime', '2026-09-05T09:00:00.000Z')
    expect(stamp).toHaveAttribute('title', 'Sep 5, 2026')
  })

  it('shows the whole message, however long, rather than an ellipsis with no title', () => {
    const message = `The finance team asked for the indexation clause to be restated. ${'x'.repeat(400)}`
    renderRow({ message })

    // The message is the only place the reason lives; truncating it in the
    // DOM would lose it rather than merely hide it.
    expect(screen.getByText(message)).toBeInTheDocument()
  })

  it('survives a notification category this build has never heard of', () => {
    // `mapNotificationCategory` has an exhaustive switch over the API types
    // this build knows, so a type added by the backend later maps to
    // `undefined` - and CATEGORY[undefined] is destructured without a
    // fallback. One unrecognised notification throws during render and takes
    // the entire inbox with it, including the approvals waiting in it.
    // ActionBadge guards exactly this case (`TONES[action] ?? 'neutral'`);
    // this row does not.
    renderRow({ category: 'escalated' as NotificationUiCategory })

    expect(screen.getByText(TITLE)).toBeInTheDocument()
  })
})
