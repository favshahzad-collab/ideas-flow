import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import type { MemoBody } from '../../types/memo'
import RewriteMemoCard from './RewriteMemoCard'

/**
 * Correcting a memo that was typed here and came back.
 *
 * The thing worth being exact about: a memo nobody uploaded cannot be revised
 * by uploading a corrected PDF, because there is no file anywhere to correct.
 * So this control is the only way such a memo ever moves again, and it has to
 * open on the text that is actually in flight rather than on a blank page.
 */

const body = (text: string): MemoBody => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
})

const outlineOnly: MemoBody = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'BACKGROUND:' }] },
    { type: 'paragraph' },
  ],
}

function setup(props: Partial<React.ComponentProps<typeof RewriteMemoCard>> = {}) {
  const onContinue = vi.fn()

  render(
    <RewriteMemoCard
      body={body('The allowance is PKR 9,000 per month.')}
      memoTo="Sir BMD"
      memoFrom="Human Resource Department"
      memoDate="2026-08-06"
      onContinue={onContinue}
      {...props}
    />,
  )

  return { onContinue }
}

describe('rewriting a memo that came back', () => {
  it('opens on the memo as it stands, not on a blank page', () => {
    setup()

    expect(screen.getByRole('textbox', { name: 'The memo' })).toHaveTextContent(
      'The allowance is PKR 9,000 per month.',
    )
  })

  it('opens with the addressee it already has', () => {
    setup()

    expect(screen.getByLabelText('To:')).toHaveValue('Sir BMD')
    expect(screen.getByLabelText('From:')).toHaveValue(
      'Human Resource Department',
    )
  })

  it('hands back the text and the header when it is sent on to signing', async () => {
    const { onContinue } = setup()

    await userEvent.click(screen.getByRole('button', { name: 'Continue to sign' }))

    expect(onContinue).toHaveBeenCalledWith({
      body: expect.objectContaining({ type: 'doc' }),
      memoTo: 'Sir BMD',
      memoFrom: 'Human Resource Department',
      memoDate: '2026-08-06',
    })
  })

  it('trims the header lines, which are printed on the page', async () => {
    const { onContinue } = setup()

    const to = screen.getByLabelText('To:')
    await userEvent.clear(to)
    await userEvent.type(to, '  The Managing Director  ')
    await userEvent.click(screen.getByRole('button', { name: 'Continue to sign' }))

    expect(onContinue.mock.calls[0]![0].memoTo).toBe('The Managing Director')
  })

  it('refuses an outline with nothing written under it', async () => {
    const { onContinue } = setup({ body: outlineOnly })

    await userEvent.click(screen.getByRole('button', { name: 'Continue to sign' }))

    expect(onContinue).not.toHaveBeenCalled()
    expect(
      screen.getByText('Write the memo before resubmitting it.'),
    ).toBeInTheDocument()
  })

  it('refuses a memo addressed to nobody', async () => {
    const { onContinue } = setup()

    await userEvent.clear(screen.getByLabelText('To:'))
    await userEvent.click(screen.getByRole('button', { name: 'Continue to sign' }))

    expect(onContinue).not.toHaveBeenCalled()
    expect(screen.getByText('Say who the memo is addressed to.')).toBeInTheDocument()
  })

  it('says nothing is wrong until somebody tries', () => {
    setup({ body: outlineOnly })

    expect(
      screen.queryByText('Write the memo before resubmitting it.'),
    ).not.toBeInTheDocument()
  })

  it('shows what the server refused, over its own complaint', () => {
    setup({ error: 'Approval chain missing' })

    expect(screen.getByText('Approval chain missing')).toBeInTheDocument()
  })

  it('locks the controls while the memo is being drawn', () => {
    setup({ preparing: true })

    expect(screen.getByLabelText('To:')).toBeDisabled()
    expect(screen.getByRole('button', { name: /Preparing/ })).toBeDisabled()
  })
})

describe('the date a correction carries', () => {
  it('opens on the date the memo already bears, not today', () => {
    // A correction is the same memo. Re-dating it to the day the correction
    // happened would make v2 claim to be a different document from the v1
    // that three people have already signed.
    setup()

    expect(screen.getByLabelText('Date:')).toHaveValue('2026-08-06')
  })

  it('can be changed deliberately', async () => {
    const { onContinue } = setup()

    await userEvent.clear(screen.getByLabelText('Date:'))
    await userEvent.type(screen.getByLabelText('Date:'), '2026-09-01')
    await userEvent.click(screen.getByRole('button', { name: 'Continue to sign' }))

    expect(onContinue.mock.calls[0]![0].memoDate).toBe('2026-09-01')
  })

  it('refuses a memo with its date cleared', async () => {
    const { onContinue } = setup()

    await userEvent.clear(screen.getByLabelText('Date:'))
    await userEvent.click(screen.getByRole('button', { name: 'Continue to sign' }))

    expect(onContinue).not.toHaveBeenCalled()
    expect(screen.getByText('Give the memo a date.')).toBeInTheDocument()
  })
})
