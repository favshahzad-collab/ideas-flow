import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import SigningConsent, { SIGNING_CONSENT_STATEMENT } from './SigningConsent'
// That the server records this same sentence is pinned on the backend side,
// in signingAttestation.test.ts, where a test can read both packages.

describe('the "this is my signature" box', () => {
  it('is a labelled checkbox that reports its state', async () => {
    const user = userEvent.setup({ delay: null })
    const onChange = vi.fn()
    render(<SigningConsent checked={false} onChange={onChange} />)

    await user.click(screen.getByRole('checkbox', { name: SIGNING_CONSENT_STATEMENT }))
    expect(onChange).toHaveBeenCalledWith(true)
  })
})
