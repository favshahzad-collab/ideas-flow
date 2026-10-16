import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { latestDelegationEnd } from '../../utils/delegationLimits'
import MemoScopeField from './MemoScopeField'

/** Which memos a delegation covers: every one, or chosen kinds. */

vi.mock('../../services/memoApi', () => ({
  fetchMemoTypes: () =>
    Promise.resolve({
      memoTypes: [{ key: 'APPROVAL_REQUEST', label: 'Approval Request' }],
      page: {},
    }),
}))

function Harness({ onChange }: { onChange: (next: string[]) => void }) {
  const [value, setValue] = useState<string[]>([])
  return (
    <MemoScopeField
      value={value}
      onChange={next => {
        setValue(next)
        onChange(next)
      }}
    />
  )
}

describe('what a delegation covers', () => {
  it('covers every memo until somebody narrows it', () => {
    render(<Harness onChange={vi.fn()} />)

    expect(screen.getByLabelText('Every memo')).toBeChecked()
  })

  it('narrows to the kinds ticked', async () => {
    const user = userEvent.setup({ delay: null })
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)

    await user.click(screen.getByLabelText('Only some kinds'))
    await user.click(await screen.findByLabelText('Approval Request'))
    await user.click(screen.getByLabelText('Uploaded PDF'))

    expect(onChange).toHaveBeenLastCalledWith(['APPROVAL_REQUEST', 'UPLOADED'])
  })

  it('goes back to every memo, and says so', async () => {
    const user = userEvent.setup({ delay: null })
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)

    await user.click(screen.getByLabelText('Only some kinds'))
    await user.click(screen.getByLabelText('Uploaded PDF'))
    await user.click(screen.getByLabelText('Every memo'))

    expect(onChange).toHaveBeenLastCalledWith([])
  })
})

describe('how long it may run', () => {
  it('ends no later than ninety days on', () => {
    expect(latestDelegationEnd(new Date('2026-10-06T10:00:00Z'))).toBe('2027-01-04')
  })
})
