import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { CommentView } from '../../types/documentDetail'
import CommentsTab from './CommentsTab'

/**
 * The discussion attached to a document under approval. Comments are where an
 * approver records what they want changed before they will sign, so the thing
 * that matters most is not how they render - it is that a comment somebody
 * typed cannot evaporate. Clearing the box before the POST has landed loses
 * the text with no draft and no undo, and the person who typed it usually
 * does not notice until the reviewer asks again.
 *
 * The other half is the submit gate: a blank or whitespace-only comment must
 * not be postable, because an empty comment row in the trail reads as an
 * approver who had something to say and said nothing.
 */

function comment(overrides: Partial<CommentView> = {}): CommentView {
  return {
    id: 'c-1',
    user: 'Bilal Ahmed',
    initials: 'BA',
    comment: 'Please restate the indexation clause before I sign.',
    date: 'Sep 4, 2026',
    ...overrides,
  }
}

function renderTab({
  comments = [] as CommentView[],
  onAddComment = vi.fn().mockResolvedValue(undefined),
  commentLoading = false,
} = {}) {
  return {
    ...render(
      <CommentsTab
        comments={comments}
        onAddComment={onAddComment}
        commentLoading={commentLoading}
      />,
    ),
    onAddComment,
  }
}

const box = () => screen.getByLabelText('Add comment')
const submit = () => screen.getByRole('button', { name: 'Add comment' })

/**
 * The block holding one comment - its body, its author and its date. The list
 * is a stack of unlabelled <div>s with no list, no article and no accessible
 * grouping to query, so the only way to check that a comment is filed under
 * the right name is to walk up from the body text. That is reported as a
 * defect, not worked around silently.
 */
function commentBlock(body: string): HTMLElement {
  const block = screen.getByText(body).parentElement
  if (!block) throw new Error(`"${body}" is not inside a comment block`)
  return block
}

/** A promise the test resolves or rejects when it chooses. */
function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('CommentsTab', () => {
  it('says the discussion is empty rather than showing a blank panel', () => {
    renderTab({ comments: [] })

    // A card with a heading and nothing under it reads as a fetch that
    // failed. "No comments yet" is the difference between "nobody has
    // objected" and "I cannot tell whether anybody objected".
    expect(screen.getByText('No comments yet.')).toBeInTheDocument()
  })

  it('drops the empty notice once there is something to read', () => {
    renderTab({ comments: [comment()] })

    expect(screen.queryByText('No comments yet.')).not.toBeInTheDocument()
    expect(screen.getByText('Bilal Ahmed')).toBeInTheDocument()
  })

  it('attributes every comment to a person and a date', () => {
    renderTab({
      comments: [
        comment({ id: 'c-1', user: 'Bilal Ahmed', comment: 'Clause 4 is wrong.' }),
        comment({
          id: 'c-2',
          user: 'Chandni Rao',
          comment: 'Fixed in v3.',
          date: 'Sep 5, 2026',
        }),
      ],
    })

    // An unattributed comment on an approval is worthless: "somebody objected
    // to clause 4" cannot be actioned or challenged. And it is not enough for
    // both names to be somewhere on the panel - each has to sit on its own
    // comment, or the objection is filed against the wrong approver.
    const objection = commentBlock('Clause 4 is wrong.')
    expect(within(objection).getByText('Bilal Ahmed')).toBeInTheDocument()
    expect(within(objection).getByText('Sep 4, 2026')).toBeInTheDocument()
    expect(within(objection).queryByText('Chandni Rao')).not.toBeInTheDocument()

    const reply = commentBlock('Fixed in v3.')
    expect(within(reply).getByText('Chandni Rao')).toBeInTheDocument()
    expect(within(reply).getByText('Sep 5, 2026')).toBeInTheDocument()
    expect(within(reply).queryByText('Bilal Ahmed')).not.toBeInTheDocument()
  })

  it('reaches the box by its label, not by its placeholder', async () => {
    const user = userEvent.setup({ delay: null })
    renderTab()

    // A placeholder disappears as soon as you type and is not a label. If it
    // were the only handle, a screen reader user would be typing into an
    // unnamed textarea - so the name has to come from the label while the
    // placeholder stays a hint.
    expect(box()).toHaveAccessibleName('Add comment')
    expect(box()).toHaveAttribute('placeholder', 'Write a comment...')

    await user.type(box(), 'Clause 4 is wrong.')

    // And it has to be a box that keeps what is typed into it: a controlled
    // `value` whose change handler was dropped renders identically, swallows
    // every keystroke, and leaves the submit button disabled forever.
    expect(box()).toHaveValue('Clause 4 is wrong.')
    expect(submit()).toBeEnabled()
  })

  it('refuses to post an empty comment', async () => {
    const user = userEvent.setup({ delay: null })
    const { onAddComment } = renderTab()

    // Disabled, and disabled in the way that actually stops a request: a
    // button styled grey with a live handler still files the empty comment,
    // and the trail cannot tell that row from an approver who declined to
    // explain themselves.
    expect(submit()).toBeDisabled()
    await user.click(submit())
    expect(onAddComment).not.toHaveBeenCalled()
  })

  it('refuses to post a comment that is only whitespace', async () => {
    const user = userEvent.setup({ delay: null })
    const { onAddComment } = renderTab()

    await user.type(box(), '    ')

    // Genuinely disabled, not styled grey: an all-spaces comment in the trail
    // is indistinguishable from a reviewer who said nothing at all.
    expect(submit()).toBeDisabled()
    expect(onAddComment).not.toHaveBeenCalled()
  })

  it('posts the comment with its surrounding whitespace trimmed', async () => {
    const user = userEvent.setup({ delay: null })
    const { onAddComment } = renderTab()

    await user.type(box(), '   Clause 4 is wrong.   ')
    await user.click(submit())

    // Whatever is sent here is stored verbatim and shown to every approver
    // afterwards, indented by however many spaces were typed by accident.
    expect(onAddComment).toHaveBeenCalledWith('Clause 4 is wrong.')
    // Once. A comment cannot be deleted from the trail, so a handler that
    // fires on both click and a bubbled submit files the objection twice.
    expect(onAddComment).toHaveBeenCalledTimes(1)
  })

  it('holds the text in the box until the post has actually landed', async () => {
    const user = userEvent.setup({ delay: null })
    const inFlight = deferred()
    const onAddComment = vi.fn().mockReturnValue(inFlight.promise)
    renderTab({ onAddComment })

    await user.type(box(), 'Clause 4 is wrong.')
    await user.click(submit())

    // This is the whole claim of this panel, and the success test below
    // cannot make it: against an already-resolved promise, clearing on the
    // way OUT of the handler and clearing after the `await` are
    // indistinguishable. Hold the request open and they separate - and the
    // first one is the version that loses a paragraph the moment the network
    // drops, because by then there is nothing left in the box to retry with.
    expect(onAddComment).toHaveBeenCalledWith('Clause 4 is wrong.')
    expect(box()).toHaveValue('Clause 4 is wrong.')

    inFlight.resolve()

    // And once it has landed, it goes - a box still holding the text after a
    // success invites a second, duplicate post of the same objection.
    await waitFor(() => expect(box()).toHaveValue(''))
  })

  it('empties the box once the post has actually landed', async () => {
    const user = userEvent.setup({ delay: null })
    renderTab()

    await user.type(box(), 'Clause 4 is wrong.')
    await user.click(submit())

    // And only then: a box still holding the text after a success invites a
    // second, duplicate post of the same objection.
    await waitFor(() => expect(box()).toHaveValue(''))
    expect(submit()).toBeDisabled()
  })

  it('keeps the typed comment when the post fails, and says why', async () => {
    const user = userEvent.setup({ delay: null })
    const onAddComment = vi
      .fn()
      .mockRejectedValue(new Error('Comment could not be saved'))
    renderTab({ onAddComment })

    await user.type(box(), 'Please restate the indexation clause before I sign.')
    await user.click(submit())

    // This is the bug worth pinning. Clearing on the way out - rather than
    // after the await resolves - throws away a paragraph somebody wrote, with
    // no draft, no undo and no clipboard copy. The retry has to be one click,
    // not a retype from memory.
    expect(await screen.findByText('Comment could not be saved')).toBeInTheDocument()
    expect(box()).toHaveValue('Please restate the indexation clause before I sign.')
    expect(submit()).toBeEnabled()
  })

  it('reports a rejection that carries no message at all', async () => {
    const user = userEvent.setup({ delay: null })
    const onAddComment = vi.fn().mockRejectedValue('network down')
    renderTab({ onAddComment })

    await user.type(box(), 'Clause 4 is wrong.')
    await user.click(submit())

    // A thrown non-Error - an aborted fetch, a string from a stray reject -
    // must still turn into words. Silence here looks like a successful post.
    expect(await screen.findByText('Failed to add comment')).toBeInTheDocument()
    expect(box()).toHaveValue('Clause 4 is wrong.')
  })

  it('clears a stale failure when the next attempt is made', async () => {
    const user = userEvent.setup({ delay: null })
    const first = deferred()
    const onAddComment = vi
      .fn()
      .mockRejectedValueOnce(new Error('Comment could not be saved'))
      .mockReturnValueOnce(first.promise)
    renderTab({ onAddComment })

    await user.type(box(), 'Clause 4 is wrong.')
    await user.click(submit())
    expect(await screen.findByText('Comment could not be saved')).toBeInTheDocument()

    await user.click(submit())

    // A failure message left standing over a retry that is still in flight
    // tells somebody their second attempt also failed, when it has not
    // finished.
    await waitFor(() =>
      expect(screen.queryByText('Comment could not be saved')).not.toBeInTheDocument(),
    )
    first.resolve()
  })

  it('blocks a second post while the first is still in flight', async () => {
    const user = userEvent.setup({ delay: null })
    const { onAddComment } = renderTab({ commentLoading: true })

    await user.type(box(), 'Clause 4 is wrong.')

    // Two clicks on a slow connection would file the same objection twice
    // against the document, and there is no way to delete one afterwards.
    expect(submit()).toBeDisabled()
    expect(submit()).toHaveAttribute('aria-busy', 'true')

    await user.click(submit())
    expect(onAddComment).not.toHaveBeenCalled()
  })

  it('survives a comment long enough to fill the panel', () => {
    const long = `Clause 4 is wrong. ${'The indexation basis is stated twice.'.repeat(60)}`
    renderTab({ comments: [comment({ comment: long })] })

    // The body is the substance of the objection; dropping the tail of it in
    // the DOM would lose the part that says what to change.
    expect(screen.getByText(long)).toBeInTheDocument()
  })

  it('announces a failed post to a screen reader', async () => {
    const user = userEvent.setup({ delay: null })
    const onAddComment = vi
      .fn()
      .mockRejectedValue(new Error('Comment could not be saved'))
    renderTab({ onAddComment })

    await user.type(box(), 'Clause 4 is wrong.')
    await user.click(submit())
    await screen.findByText('Comment could not be saved')

    // The message is painted in red under the textarea with no live region
    // and no tie to the field, so a screen reader user presses "Add comment",
    // hears nothing change, and walks away believing the comment was filed.
    // The inbox already does this correctly (`role="alert"` in
    // pages/Notifications.tsx); this panel does not.
    expect(screen.getByRole('alert')).toHaveTextContent('Comment could not be saved')
  })
})
