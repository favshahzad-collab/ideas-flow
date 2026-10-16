import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  addMemoDictionaryWord,
  fetchMemoDictionary,
  removeMemoDictionaryWord,
  type DictionaryWord,
} from '../services/memoDictionaryApi'
import { renderWithProviders } from '../test/render'
import DictionaryPage from './DictionaryPage'

/**
 * The organisation's dictionary, as an administrator keeps it: the list,
 * a word added, a word removed, and the screen saying what each means for
 * the editor.
 */

vi.mock('../services/memoDictionaryApi', () => ({
  fetchMemoDictionary: vi.fn(),
  addMemoDictionaryWord: vi.fn(),
  removeMemoDictionaryWord: vi.fn(),
}))

const read = vi.mocked(fetchMemoDictionary)
const add = vi.mocked(addMemoDictionaryWord)
const remove = vi.mocked(removeMemoDictionaryWord)

const word = (overrides: Partial<DictionaryWord> = {}): DictionaryWord => ({
  id: 'w1',
  word: 'Gymkhana',
  createdAt: '2026-09-26T09:00:00.000Z',
  addedBy: { firstName: 'Shahzad', lastName: 'Ali' },
  ...overrides,
})

beforeEach(() => {
  read.mockReset()
  add.mockReset()
  remove.mockReset()
})

describe('the list', () => {
  it('shows each word and who added it, and says names need no adding', async () => {
    read.mockResolvedValue({ words: [word(), word({ id: 'w2', word: 'Somrow', addedBy: null })] })
    renderWithProviders(<DictionaryPage />)

    expect(await screen.findByText('Gymkhana')).toBeInTheDocument()
    expect(screen.getByText('Somrow')).toBeInTheDocument()
    expect(screen.getAllByText(/by Shahzad Ali/)).toHaveLength(1)
    expect(screen.getByText(/already known from the directory/)).toBeInTheDocument()
  })

  it('says when there is nothing yet', async () => {
    read.mockResolvedValue({ words: [] })
    renderWithProviders(<DictionaryPage />)

    expect(await screen.findByText(/Nothing yet/)).toBeInTheDocument()
  })

  it('says when it cannot be read, and offers to try again', async () => {
    read.mockRejectedValueOnce(new Error('The server is away'))
    read.mockResolvedValueOnce({ words: [word()] })
    renderWithProviders(<DictionaryPage />)

    expect(await screen.findByRole('alert')).toHaveTextContent('The server is away')

    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))

    expect(await screen.findByText('Gymkhana')).toBeInTheDocument()
  })
})

describe('adding a word', () => {
  it('sends the word and lists it, in its place', async () => {
    read.mockResolvedValue({ words: [word({ word: 'Somrow' })] })
    add.mockResolvedValue({ word: word({ id: 'w2', word: 'Bahria' }) })
    renderWithProviders(<DictionaryPage />)
    await screen.findByText('Somrow')

    await userEvent.type(screen.getByLabelText('Word'), 'Bahria')
    await userEvent.click(screen.getByRole('button', { name: 'Add to the dictionary' }))

    await waitFor(() => expect(add).toHaveBeenCalledWith('Bahria'))
    expect(await screen.findByRole('status')).toHaveTextContent('“Bahria” added')
    const items = screen.getAllByRole('listitem').map(item => within(item).getByText(/Bahria|Somrow/).textContent)
    expect(items).toEqual(['Bahria', 'Somrow'])
    expect(screen.getByLabelText('Word')).toHaveValue('')
  })

  it('refuses two words before asking the server', async () => {
    read.mockResolvedValue({ words: [] })
    renderWithProviders(<DictionaryPage />)
    await screen.findByText(/Nothing yet/)

    await userEvent.type(screen.getByLabelText('Word'), 'two words')
    await userEvent.click(screen.getByRole('button', { name: 'Add to the dictionary' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('One word at a time.')
    expect(add).not.toHaveBeenCalled()
  })

  it('shows what the server refused', async () => {
    read.mockResolvedValue({ words: [] })
    add.mockRejectedValue(new Error('“Somrow” is already in the dictionary.'))
    renderWithProviders(<DictionaryPage />)
    await screen.findByText(/Nothing yet/)

    await userEvent.type(screen.getByLabelText('Word'), 'somrow')
    await userEvent.click(screen.getByRole('button', { name: 'Add to the dictionary' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('already in the dictionary')
  })
})

describe('removing a word', () => {
  it('takes it off the list and says the editor flags it again', async () => {
    read.mockResolvedValue({ words: [word()] })
    remove.mockResolvedValue({ word: word() })
    renderWithProviders(<DictionaryPage />)
    await screen.findByText('Gymkhana')

    await userEvent.click(screen.getByRole('button', { name: 'Remove Gymkhana' }))

    await waitFor(() => expect(remove).toHaveBeenCalledWith('w1'))
    expect(await screen.findByRole('status')).toHaveTextContent('“Gymkhana” removed. The editor flags it again.')
    expect(screen.queryByText('Gymkhana')).toBeNull()
  })
})
