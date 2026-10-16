import { useId, useState } from 'react'

import type { MemoBody } from '../../types/memo'
import { memoBodyHasNoProse } from '../../utils/memoDom'
import MemoBodyEditor from '../submit/MemoBodyEditor'
import Button from '../ui/Button'

/**
 * Rewriting a memo that was typed in the portal and came back.
 *
 * A memo that nobody ever uploaded cannot be revised by uploading one - there
 * is no Word file on anybody's desktop to correct and re-export, which is the
 * whole point of typing it here. So the revision is the memo itself, opened
 * where the preparer left it, and the server redraws it into the next version.
 *
 * The two address lines are editable because "send it to the MD instead" is a
 * revision reviewers actually ask for, and the alternative is a preparer who
 * has to withdraw the memo and start again to change one line.
 */

interface RewriteMemoCardProps {
  body: MemoBody
  memoTo: string
  memoFrom: string
  /** The date the memo already bears, as `2026-08-06`. */
  memoDate: string
  /** True while the server is drawing the memo for the signing step. */
  preparing?: boolean
  error?: string | null
  onContinue: (revision: {
    body: MemoBody
    memoTo: string
    memoFrom: string
    memoDate: string
  }) => void
}

export default function RewriteMemoCard({
  body: initialBody,
  memoTo: initialTo,
  memoFrom: initialFrom,
  memoDate: initialDate,
  preparing = false,
  error = null,
  onContinue,
}: RewriteMemoCardProps) {
  const [body, setBody] = useState<MemoBody>(initialBody)
  const [memoTo, setMemoTo] = useState(initialTo)
  const [memoFrom, setMemoFrom] = useState(initialFrom)
  const [memoDate, setMemoDate] = useState(initialDate)
  const [attempted, setAttempted] = useState(false)

  const toId = useId()
  const fromId = useId()
  const dateId = useId()
  const bodyLabelId = useId()
  const errorId = useId()

  /*
   * An outline on its own is not a memo, and neither is an empty page. The
   * same rule the submit screen applies, for the same reason: the server
   * refuses an empty body, and finding that out after the signing dialog has
   * opened is finding it out too late.
   */
  const missing = memoBodyHasNoProse(body)
    ? 'Write the memo before resubmitting it.'
    : !memoTo.trim()
      ? 'Say who the memo is addressed to.'
      : !memoFrom.trim()
        ? 'Say which department it is from.'
        : !memoDate
          ? 'Give the memo a date.'
          : null

  const shown = error ?? (attempted ? missing : null)

  const handleContinue = () => {
    setAttempted(true)
    if (missing) return
    onContinue({
      body,
      memoTo: memoTo.trim(),
      memoFrom: memoFrom.trim(),
      memoDate,
    })
  }

  return (
    <div className="space-y-4">
      {/*
        The memo being corrected, on the same sheet it was written on.

        A correction is the same document, so it is edited the same way: the
        header lines sit where the template prints them and the text is typed
        straight onto the page below. The alternative - a row of form fields
        beside a box of text - made a rewrite look like a different job from
        writing the memo in the first place.
      */}
      <div className="memo-sheet">
        <div className="memo-sheet-brand">
          <span className="text-2xs uppercase tracking-wide text-content-faint">
            Letterhead
          </span>
        </div>

        <div className="memo-sheet-rule" />

        <div className="memo-sheet-header">
          <label htmlFor={toId} className="memo-sheet-label">
            To:
          </label>
          <input
            id={toId}
            type="text"
            value={memoTo}
            maxLength={200}
            disabled={preparing}
            onChange={event => setMemoTo(event.target.value)}
            className="memo-sheet-value"
          />

          <label htmlFor={fromId} className="memo-sheet-label">
            From:
          </label>
          <input
            id={fromId}
            type="text"
            value={memoFrom}
            maxLength={200}
            disabled={preparing}
            onChange={event => setMemoFrom(event.target.value)}
            className="memo-sheet-value"
          />

          <label htmlFor={dateId} className="memo-sheet-label">
            Date:
          </label>
          <div>
            <input
              id={dateId}
              type="date"
              value={memoDate}
              disabled={preparing}
              onChange={event => setMemoDate(event.target.value)}
              className="memo-sheet-value"
            />
            {/*
              * A correction is the same memo, so this opens on the date it
              * already bears rather than today's. Changing it is deliberate.
              */}
            <p className="mt-0.5 text-meta text-content-subtle">
              What the memo is dated. It keeps the date it already carries
              unless you change it.
            </p>
          </div>
        </div>

        <div className="mt-6">
          <h3 id={bodyLabelId} className="sr-only">
            The memo
          </h3>
          <MemoBodyEditor
            initialBody={initialBody}
            onChange={setBody}
            disabled={preparing}
            labelledBy={bodyLabelId}
            framed={false}
            {...(shown ? { describedBy: errorId, invalid: true } : {})}
          />
        </div>
      </div>

      {shown && (
        <p id={errorId} role="alert" className="text-ui text-danger-ink">
          {shown}
        </p>
      )}

      <div className="flex justify-end">
        <Button pending={preparing} onClick={handleContinue}>
          {preparing ? 'Preparing…' : 'Continue to sign'}
        </Button>
      </div>
    </div>
  )
}
