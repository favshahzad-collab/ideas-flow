import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  downloadLedgerExport,
  fetchLedgerSummary,
  verifyLedger,
  type LedgerReport,
  type LedgerSummary,
} from '../../services/auditApi'
import LedgerSeal from './LedgerSeal'

/**
 * The strip at the top of the audit ledger.
 *
 * Its job is to keep two claims apart. "Sealed" is known from a count and is
 * true the moment the page loads. "Verified" is only true after the chain has
 * been read back, and only about the moment it was read. Most of what is
 * tested here is that the first never quietly reads as the second.
 */

vi.mock('../../services/auditApi', () => ({
  downloadLedgerExport: vi.fn(),
  fetchLedgerSummary: vi.fn(),
  verifyLedger: vi.fn(),
}))

const mockedExport = vi.mocked(downloadLedgerExport)

const mockedSummary = vi.mocked(fetchLedgerSummary)
const mockedVerify = vi.mocked(verifyLedger)

const HASH = '4f2a91c0b7d3e5860a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f6071'

const summary = (overrides: Partial<LedgerSummary> = {}): LedgerSummary => ({
  sealed: 412,
  unsealed: 0,
  tip: { seq: '412', hash: HASH, sealedAt: new Date().toISOString() },
  witnesses: 26,
  ...overrides,
})

const report = (overrides: Partial<LedgerReport> = {}): LedgerReport => ({
  ...summary(),
  checked: 412,
  intact: true,
  break: null,
  checkedAt: new Date().toISOString(),
  durationMs: 84,
  ...overrides,
})

beforeEach(() => {
  mockedSummary.mockReset()
  mockedVerify.mockReset()
  mockedSummary.mockResolvedValue(summary())
})

describe('while it is reading', () => {
  it('says so rather than showing an empty strip', () => {
    render(<LedgerSeal canVerify />)

    expect(screen.getByText('Reading the seal…')).toBeInTheDocument()
  })
})

describe('at rest', () => {
  it('says how far the seal has reached', async () => {
    render(<LedgerSeal canVerify />)

    expect(await screen.findByText('Sealed to 412')).toBeInTheDocument()
    expect(screen.getByText(/412 records chained/)).toBeInTheDocument()
  })

  it('does not claim the chain has been verified', async () => {
    // The whole point. Records carrying digests is not the same statement as
    // those digests having been recomputed, and only one of them is free.
    render(<LedgerSeal canVerify />)

    await screen.findByText('Sealed to 412')

    expect(screen.queryByText('Ledger verified')).not.toBeInTheDocument()
    expect(screen.queryByText(/recomputed/)).not.toBeInTheDocument()
  })

  it('shows the head of the tip digest, with the whole of it reachable', async () => {
    render(<LedgerSeal canVerify />)

    const digest = await screen.findByTitle(HASH)
    expect(digest).toHaveTextContent('4f2a91c0b7d3e586')
  })

  it('counts records written since the last sweep separately', async () => {
    mockedSummary.mockResolvedValue(summary({ unsealed: 3 }))
    render(<LedgerSeal canVerify />)

    expect(await screen.findByText(/3 waiting/)).toBeInTheDocument()
  })

  it('says nothing is sealed yet, and that nothing is lost by that', async () => {
    // A first boot, or a sweep that has not run. Three records with no seal
    // must not read as three records that failed one.
    mockedSummary.mockResolvedValue(summary({ sealed: 0, unsealed: 3, tip: null, witnesses: 0 }))
    render(<LedgerSeal canVerify />)

    expect(await screen.findByText('Nothing sealed yet')).toBeInTheDocument()
    expect(screen.getByText(/Nothing is lost/)).toBeInTheDocument()
  })

  it('reports a seal it could not read as an alert, not as zero', async () => {
    mockedSummary.mockRejectedValue(new Error('Session expired'))
    render(<LedgerSeal canVerify />)

    expect(await screen.findByRole('alert')).toHaveTextContent('Session expired')
  })
})

describe('who can run a verification', () => {
  it('offers it to an administrator', async () => {
    render(<LedgerSeal canVerify />)

    expect(
      await screen.findByRole('button', { name: /Verify ledger/ }),
    ).toBeInTheDocument()
  })

  it('does not offer it to anybody else, rather than offering it disabled', async () => {
    // Walking the chain is minutes of work on a long trail. A button that is
    // there but refuses reads as a permission problem; this is a cost one.
    render(<LedgerSeal canVerify={false} />)

    await screen.findByText('Sealed to 412')

    expect(screen.queryByRole('button', { name: /Verify ledger/ })).not.toBeInTheDocument()
  })

  it('still shows everyone how far the seal has reached', async () => {
    render(<LedgerSeal canVerify={false} />)

    expect(await screen.findByText('Sealed to 412')).toBeInTheDocument()
    expect(await screen.findByTitle(HASH)).toBeInTheDocument()
  })
})

describe('running a verification', () => {
  it('says what it found, and when it looked', async () => {
    mockedVerify.mockResolvedValue(report())
    const user = userEvent.setup({ delay: null })
    render(<LedgerSeal canVerify />)

    await user.click(await screen.findByRole('button', { name: /Verify ledger/ }))

    expect(await screen.findByText('Ledger verified')).toBeInTheDocument()
    expect(screen.getByText(/412 records read back and recomputed/)).toBeInTheDocument()
    // A verification is a statement about a moment, so it names the moment.
    expect(screen.getByText(/Checked Just now/)).toBeInTheDocument()
  })

  it('names the position a break was found at, and what kind it is', async () => {
    mockedVerify.mockResolvedValue(
      report({
        intact: false,
        checked: 87,
        break: {
          kind: 'content',
          seq: '88',
          recordId: 'ab12cd34-0000-4000-8000-000000000001',
          detail: 'This record has been changed since it was sealed.',
        },
      }),
    )
    const user = userEvent.setup({ delay: null })
    render(<LedgerSeal canVerify />)

    await user.click(await screen.findByRole('button', { name: /Verify ledger/ }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('The trail has been altered at position 88')
    expect(alert).toHaveTextContent('This record has been changed since it was sealed.')
    // Which record, so somebody can go and look at it.
    expect(alert).toHaveTextContent('ab12cd34-0000-4000-8000-000000000001')
  })

  it('says how much of the trail was clean before the break', async () => {
    // "Broken" on its own invites throwing the whole trail away. Eighty-seven
    // records that still verify are eighty-seven records of evidence.
    mockedVerify.mockResolvedValue(
      report({
        intact: false,
        checked: 87,
        break: { kind: 'link', seq: '88', recordId: null, detail: 'Out of order.' },
      }),
    )
    const user = userEvent.setup({ delay: null })
    render(<LedgerSeal canVerify />)

    await user.click(await screen.findByRole('button', { name: /Verify ledger/ }))

    expect(await screen.findByText(/87 records were recomputed and matched/)).toBeInTheDocument()
  })

  it('shows the counts the verification came back with, not the stale ones', async () => {
    // Verifying seals whatever was outstanding on its way through, so the
    // numbers on screen are a moment behind by the time it answers.
    mockedSummary.mockResolvedValue(summary({ sealed: 412, unsealed: 3 }))
    mockedVerify.mockResolvedValue(
      report({ sealed: 415, unsealed: 0, checked: 415, tip: { seq: '415', hash: HASH, sealedAt: null } }),
    )
    const user = userEvent.setup({ delay: null })
    render(<LedgerSeal canVerify />)

    await user.click(await screen.findByRole('button', { name: /Verify ledger/ }))

    expect(await screen.findByText(/415 records chained/)).toBeInTheDocument()
    expect(screen.queryByText(/3 waiting/)).not.toBeInTheDocument()
  })

  it('says it is working, and cannot be asked twice at once', async () => {
    let release: (report: LedgerReport) => void = () => {}
    mockedVerify.mockReturnValue(
      new Promise<LedgerReport>(resolve => {
        release = resolve
      }),
    )
    const user = userEvent.setup({ delay: null })
    render(<LedgerSeal canVerify />)

    await user.click(await screen.findByRole('button', { name: /Verify ledger/ }))

    const button = screen.getByRole('button', { name: /Reading the ledger/ })
    expect(button).toBeDisabled()

    release(report())
    expect(await screen.findByText('Ledger verified')).toBeInTheDocument()
  })

  it('reports a verification that could not be run, rather than a clean bill', async () => {
    mockedVerify.mockRejectedValue(new Error('Admin access required'))
    const user = userEvent.setup({ delay: null })
    render(<LedgerSeal canVerify />)

    await user.click(await screen.findByRole('button', { name: /Verify ledger/ }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Admin access required')
    expect(screen.queryByText('Ledger verified')).not.toBeInTheDocument()
  })
})

describe('the landmark', () => {
  it('is findable by name', async () => {
    render(<LedgerSeal canVerify />)

    expect(
      await screen.findByRole('region', { name: 'Ledger seal' }),
    ).toBeInTheDocument()
  })
})

describe('the export for an auditor', () => {
  it('is offered to an administrator, and downloads the file', async () => {
    mockedExport.mockResolvedValue(undefined)
    render(<LedgerSeal canVerify />)

    await userEvent.click(await screen.findByRole('button', { name: /Export for auditor/ }))

    expect(mockedExport).toHaveBeenCalledTimes(1)
  })

  it('says why when the export fails', async () => {
    mockedExport.mockRejectedValue(new Error('Confirm it is you to make this change.'))
    render(<LedgerSeal canVerify />)

    await userEvent.click(await screen.findByRole('button', { name: /Export for auditor/ }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Confirm it is you')
  })

  it('is not offered to anybody else', async () => {
    render(<LedgerSeal canVerify={false} />)

    await screen.findByText('Sealed to 412')
    expect(screen.queryByRole('button', { name: /Export for auditor/ })).not.toBeInTheDocument()
  })
})
