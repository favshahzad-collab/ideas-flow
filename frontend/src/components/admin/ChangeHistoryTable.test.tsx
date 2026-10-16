import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { AdministrationEntry } from '../../services/auditApi'
import { describeChanges, readableAction } from '../../utils/changeHistory'
import ChangeHistoryTable from './ChangeHistoryTable'

/**
 * The rows of the change history.
 *
 * Two things matter more than the layout. A value the server withheld must
 * read as "changed" rather than as a blank or, worse, as something invented -
 * the withheld ones are credentials. And a row whose actor has since been
 * deleted has to stay, and say so: dropping it would let removing an account
 * erase what that account did.
 */

const entry = (overrides: Partial<AdministrationEntry> = {}): AdministrationEntry => ({
  id: 'a1',
  at: '2026-09-15T09:30:00.000Z',
  actor: { id: 'u1', firstName: 'Ayesha', lastName: 'Khan' },
  action: 'USER_UPDATED',
  area: 'People',
  entityType: 'User',
  entityId: 'u2',
  subject: 'bilal@example.com',
  changes: [{ field: 'loginRole', from: 'USER', to: 'ADMINISTRATOR' }],
  ipAddress: '203.0.113.7',
  ...overrides,
})

describe('readableAction', () => {
  it('turns an enum into something a person reads', () => {
    expect(readableAction('USER_UPDATED')).toBe('User updated')
    expect(readableAction('SSO_SETTINGS_CLEARED')).toBe('Sso settings cleared')
  })
})

describe('describeChanges', () => {
  it('shows what a value changed from and to', () => {
    expect(describeChanges(entry())).toBe('loginRole: USER → ADMINISTRATOR')
  })

  it('reads a creation as an arrival, not as a change from nothing', () => {
    expect(
      describeChanges(entry({ changes: [{ field: 'name', from: null, to: 'Legal' }] })),
    ).toBe('name: Legal')
  })

  it('names a withheld field without inventing a value for it', () => {
    /*
     * The fields the server declines to print are the ones holding
     * credentials. "clientSecret changed" is the whole of what this screen is
     * allowed to say, and it is also everything the reader needs.
     */
    const described = describeChanges(
      entry({ changes: [{ field: 'clientSecret', from: null, to: null }] }),
    )

    expect(described).toBe('clientSecret changed')
    expect(described).not.toContain('null')
  })

  it('puts a dash where nothing differed, rather than an empty cell', () => {
    expect(describeChanges(entry({ changes: [] }))).toBe('—')
  })
})

describe('the table', () => {
  it('names who made the change and what it was about', () => {
    render(<ChangeHistoryTable entries={[entry()]} />)

    expect(screen.getByText('Ayesha Khan')).toBeInTheDocument()
    expect(screen.getByText('User updated')).toBeInTheDocument()
    expect(screen.getByText(/bilal@example.com/)).toBeInTheDocument()
  })

  it('keeps a row whose actor has since been deleted, and says so', () => {
    render(<ChangeHistoryTable entries={[entry({ actor: null })]} />)

    expect(screen.getByText('No longer a user')).toBeInTheDocument()
    expect(screen.getByText('User updated')).toBeInTheDocument()
  })

  it('shows where it came from, which is the only column that can answer "was that them"', () => {
    render(<ChangeHistoryTable entries={[entry()]} />)

    expect(screen.getByText('203.0.113.7')).toBeInTheDocument()
  })

  it('puts a dash where no address was recorded', () => {
    render(<ChangeHistoryTable entries={[entry({ ipAddress: null, changes: [] })]} />)

    expect(screen.getAllByText('—').length).toBeGreaterThan(0)
  })
})
