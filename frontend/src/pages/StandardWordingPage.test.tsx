import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createMemoClause,
  fetchMemoClauses,
  updateMemoClause,
  type MemoClause,
} from '../services/memoClausesApi'
import { renderWithProviders } from '../test/render'
import StandardWordingPage from './StandardWordingPage'

/**
 * The library of standard wording.
 *
 * What is tested is what the screen promises: the list an administrator
 * sees, that a clause is written in the memo editor and saved as a memo
 * body, and that archiving is a state a clause can come back from - said in
 * words, with the reassurance that nothing already written changes.
 */

vi.mock('../services/memoClausesApi', () => ({
  fetchMemoClauses: vi.fn(),
  createMemoClause: vi.fn(),
  updateMemoClause: vi.fn(),
}))

const read = vi.mocked(fetchMemoClauses)
const create = vi.mocked(createMemoClause)
const update = vi.mocked(updateMemoClause)

const paragraph = (text: string) => ({
  type: 'paragraph' as const,
  content: [{ type: 'text' as const, text }],
})

const clause = (overrides: Partial<MemoClause> = {}): MemoClause => ({
  id: 'c1',
  title: 'Recommendation',
  body: { type: 'doc', content: [paragraph('Approval is solicited.')] },
  archivedAt: null,
  createdAt: '2026-09-25T09:00:00.000Z',
  updatedAt: '2026-09-25T09:00:00.000Z',
  updatedBy: { firstName: 'Shahzad', lastName: 'Ali' },
  ...overrides,
})

beforeEach(() => {
  read.mockReset()
  create.mockReset()
  update.mockReset()
})

describe('the list', () => {
  it('shows each clause, who last changed it, and which are archived', async () => {
    read.mockResolvedValue({
      clauses: [
        clause(),
        clause({ id: 'c2', title: 'Old condition', archivedAt: '2026-09-20T09:00:00.000Z' }),
      ],
    })
    renderWithProviders(<StandardWordingPage />)

    expect(await screen.findByText('Recommendation')).toBeInTheDocument()
    expect(screen.getAllByText(/by Shahzad Ali/)).toHaveLength(2)

    const old = screen.getByText('Old condition').closest('li')!
    expect(within(old).getByText('Archived')).toBeInTheDocument()
    expect(within(old).getByRole('button', { name: 'Restore Old condition' })).toBeInTheDocument()
  })

  it('says when there is nothing yet', async () => {
    read.mockResolvedValue({ clauses: [] })
    renderWithProviders(<StandardWordingPage />)

    expect(await screen.findByText(/Nothing yet/)).toBeInTheDocument()
  })

  it('says when it cannot be read, and offers to try again', async () => {
    read.mockRejectedValueOnce(new Error('The server is away'))
    read.mockResolvedValueOnce({ clauses: [clause()] })
    renderWithProviders(<StandardWordingPage />)

    expect(await screen.findByRole('alert')).toHaveTextContent('The server is away')

    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))

    expect(await screen.findByText('Recommendation')).toBeInTheDocument()
  })
})

describe('adding wording', () => {
  it('saves a title and the body written in the memo editor', async () => {
    read.mockResolvedValue({ clauses: [] })
    create.mockResolvedValue({ clause: clause({ id: 'new', title: 'Opening line' }) })
    renderWithProviders(<StandardWordingPage />)
    await screen.findByText(/Nothing yet/)

    await userEvent.click(screen.getByRole('button', { name: 'New wording' }))
    await userEvent.type(screen.getByLabelText('Title'), 'Opening line')

    const region = screen.getByRole('textbox', { name: 'Wording' })
    region.innerHTML = '<p>It is submitted for kind consideration that</p>'
    fireEvent.input(region)

    await userEvent.click(screen.getByRole('button', { name: 'Add to the library' }))

    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({
        title: 'Opening line',
        body: { type: 'doc', content: [paragraph('It is submitted for kind consideration that')] },
      }),
    )
    expect(await screen.findByRole('status')).toHaveTextContent('“Opening line” saved')
    expect(screen.getByText('Opening line')).toBeInTheDocument()
  })

  it('refuses a clause with nothing written, before asking the server', async () => {
    read.mockResolvedValue({ clauses: [] })
    renderWithProviders(<StandardWordingPage />)
    await screen.findByText(/Nothing yet/)

    await userEvent.click(screen.getByRole('button', { name: 'New wording' }))
    await userEvent.type(screen.getByLabelText('Title'), 'Empty')
    await userEvent.click(screen.getByRole('button', { name: 'Add to the library' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Write the wording before saving it.')
    expect(create).not.toHaveBeenCalled()
  })
})

describe('archiving', () => {
  it('takes a clause off the list and says nothing already written changes', async () => {
    read.mockResolvedValue({ clauses: [clause()] })
    update.mockResolvedValue({
      clause: clause({ archivedAt: '2026-09-25T10:00:00.000Z' }),
    })
    renderWithProviders(<StandardWordingPage />)
    await screen.findByText('Recommendation')

    await userEvent.click(screen.getByRole('button', { name: 'Archive Recommendation' }))

    await waitFor(() => expect(update).toHaveBeenCalledWith('c1', { archived: true }))
    expect(await screen.findByRole('status')).toHaveTextContent(
      'stays on every memo that already carries it',
    )
    expect(screen.getByText('Archived')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Restore Recommendation' })).toBeInTheDocument()
  })
})
