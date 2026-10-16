import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { fetchDocumentChanges } from '../../services/documentDetailApi'
import type { MemoBlockNode, MemoTableNode } from '../../types/memo'
import type { ApiMemoChanges } from '../../types/memoChanges'
import ChangesTab from './ChangesTab'

vi.mock('../../services/documentDetailApi', () => ({
  fetchDocumentChanges: vi.fn(),
}))

const mocked = vi.mocked(fetchDocumentChanges)

/**
 * The tab an approver reads instead of re-reading the whole memo.
 *
 * The comparison is the server's; what is tested here is that every kind of
 * difference it can report is drawn so that a reader can find it - and that
 * an addition or a removal is never a colour alone.
 */

const p = (text: string): MemoBlockNode => ({
  type: 'paragraph',
  content: [{ type: 'text', text }],
})
const h = (text: string): MemoBlockNode => ({
  type: 'heading',
  attrs: { level: 1 },
  content: [{ type: 'text', text }],
})
const table: MemoTableNode = {
  type: 'table',
  content: [
    {
      type: 'tableRow',
      content: [
        { type: 'tableHeader', content: [p('Name') as never] },
        { type: 'tableHeader', content: [p('Amount') as never] },
      ],
    },
  ],
}

const response: ApiMemoChanges = {
  current: { versionNumber: 2, filedAt: '2026-09-25T09:00:00.000Z', typed: true },
  previous: { versionNumber: 1, filedAt: '2026-09-20T09:00:00.000Z', typed: true },
  returned: {
    by: 'Kazim Zaidi',
    at: '2026-09-22T09:00:00.000Z',
    comment: 'The figure is out of date.',
  },
  changes: {
    identical: false,
    summary: { same: 2, added: 1, removed: 1, changed: 2 },
    blocks: [
      { kind: 'same', block: h('BACKGROUND:') },
      {
        kind: 'changed',
        type: 'text',
        before: p('The allowance is PKR 10,000 per month.') as never,
        after: p('The allowance is PKR 12,000 per month.') as never,
        runs: [
          { kind: 'same', text: 'The allowance is PKR ' },
          { kind: 'removed', text: '10,000' },
          { kind: 'added', text: '12,000' },
          { kind: 'same', text: ' per month.' },
        ],
        emphasisOnly: false,
      },
      { kind: 'added', block: p('Effective from 1 October.') },
      { kind: 'removed', block: p('This supersedes the memo of 3 March.') },
      { kind: 'same', block: h('Recommendation') },
      {
        kind: 'changed',
        type: 'table',
        before: table,
        after: table,
        layoutOnly: false,
        rows: [
          {
            kind: 'same',
            header: true,
            cells: [
              { kind: 'same', text: 'Name' },
              { kind: 'same', text: 'Amount' },
            ],
          },
          {
            kind: 'changed',
            header: false,
            cells: [
              { kind: 'same', text: 'Inayat' },
              {
                kind: 'changed',
                text: '12,000',
                runs: [
                  { kind: 'removed', text: '10,000' },
                  { kind: 'added', text: '12,000' },
                ],
              },
            ],
          },
          {
            kind: 'added',
            header: false,
            cells: [
              { kind: 'added', text: 'Moiz' },
              { kind: 'added', text: '8,000' },
            ],
          },
        ],
      },
    ],
  },
  notes: { added: ['Please treat as urgent.'], removed: [], moved: 0 },
}

beforeEach(() => {
  mocked.mockReset()
})

describe('while the comparison loads', () => {
  it('announces loading rather than showing grey rectangles alone', () => {
    mocked.mockReturnValue(new Promise(() => {}))
    render(<ChangesTab documentId="doc-1" />)

    expect(screen.getByText('Loading')).toBeInTheDocument()
  })
})

describe('when it cannot be loaded', () => {
  it('says so where the reader is looking', async () => {
    mocked.mockRejectedValue(new Error('The server is away'))
    render(<ChangesTab documentId="doc-1" />)

    expect(await screen.findByRole('alert')).toHaveTextContent('The server is away')
  })
})

describe('a memo with nothing to compare', () => {
  it('says a first version has nothing before it', async () => {
    mocked.mockResolvedValue({ ...response, previous: null, changes: null, returned: null })
    render(<ChangesTab documentId="doc-1" />)

    expect(await screen.findByText(/first version of this memo/)).toBeInTheDocument()
  })

  it('says which version was uploaded as a PDF', async () => {
    mocked.mockResolvedValue({
      ...response,
      previous: { versionNumber: 1, filedAt: '2026-09-20T09:00:00.000Z', typed: false },
      changes: null,
    })
    render(<ChangesTab documentId="doc-1" />)

    expect(
      await screen.findByText(/Version 1 was uploaded as a PDF/),
    ).toBeInTheDocument()
  })

  it('says when the text is the same in both', async () => {
    mocked.mockResolvedValue({
      ...response,
      changes: {
        identical: true,
        summary: { same: 1, added: 0, removed: 0, changed: 0 },
        blocks: [{ kind: 'same', block: p('Same.') }],
      },
    })
    render(<ChangesTab documentId="doc-1" />)

    expect(await screen.findByText(/the same in both versions/)).toBeInTheDocument()
  })
})

describe('a memo that changed', () => {
  beforeEach(() => {
    mocked.mockResolvedValue(response)
  })

  it('names the two versions and who sent the first one back', async () => {
    render(<ChangesTab documentId="doc-1" />)

    expect(
      await screen.findByRole('heading', { name: 'Version 2 compared with version 1' }),
    ).toBeInTheDocument()
    expect(screen.getByText('Kazim Zaidi')).toBeInTheDocument()
    expect(screen.getByText('The figure is out of date.')).toBeInTheDocument()
  })

  it('counts what changed', async () => {
    render(<ChangesTab documentId="doc-1" />)

    const summary = await screen.findByRole('list', { name: 'Summary of changes' })
    expect(summary).toHaveTextContent('1 added')
    expect(summary).toHaveTextContent('1 removed')
    expect(summary).toHaveTextContent('2 changed')
  })

  it('marks the words that moved, as insertions and deletions', async () => {
    /*
     * <ins> and <del> rather than coloured spans: the meaning survives a
     * screen reader, a print in black and white, and a colour scheme that
     * uses these hues for something else.
     */
    render(<ChangesTab documentId="doc-1" />)
    await screen.findByRole('heading', { name: /compared with/ })

    const inserted = screen.getAllByText('12,000', { selector: 'ins' })
    const deleted = screen.getAllByText('10,000', { selector: 'del' })
    // Once in the paragraph, once in the table cell.
    expect(inserted).toHaveLength(2)
    expect(deleted).toHaveLength(2)
    expect(inserted[0]).toHaveTextContent('added:')
    expect(deleted[0]).toHaveTextContent('removed:')
  })

  it('labels every block with a word, not a colour', async () => {
    render(<ChangesTab documentId="doc-1" />)
    await screen.findByRole('heading', { name: /compared with/ })

    expect(screen.getAllByText('Added').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Removed').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Changed').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Unchanged').length).toBeGreaterThan(0)
  })

  it('shows the unchanged blocks too, so the reader can see where the change sits', async () => {
    render(<ChangesTab documentId="doc-1" />)

    expect(await screen.findByText('BACKGROUND:')).toBeInTheDocument()
    expect(screen.getByText('Recommendation')).toBeInTheDocument()
  })

  it('can hide the unchanged blocks, and says how many it hid', async () => {
    render(<ChangesTab documentId="doc-1" />)
    await screen.findByText('BACKGROUND:')

    await userEvent.click(screen.getByRole('checkbox', { name: 'Only what changed' }))

    expect(screen.queryByText('BACKGROUND:')).toBeNull()
    expect(screen.getByText('Effective from 1 October.')).toBeInTheDocument()
    expect(screen.getByText('2 unchanged blocks are hidden.')).toBeInTheDocument()
  })

  it('draws the table with its added row and its changed cell', async () => {
    render(<ChangesTab documentId="doc-1" />)
    await screen.findByRole('heading', { name: /compared with/ })

    expect(screen.getByText('Moiz')).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'Name' })).toBeInTheDocument()
    expect(screen.getAllByText('row', { selector: '.sr-only' }).length).toBeGreaterThan(0)
  })

  it('lists a note added to the page', async () => {
    render(<ChangesTab documentId="doc-1" />)

    expect(await screen.findByText('Please treat as urgent.')).toBeInTheDocument()
    expect(screen.getByText('Notes on the page')).toBeInTheDocument()
  })
})

describe('a picture in the memo', () => {
  it('is shown, with its description under it', async () => {
    mocked.mockResolvedValue({
      ...response,
      changes: {
        identical: false,
        summary: { same: 0, added: 1, removed: 0, changed: 0 },
        blocks: [
          {
            kind: 'added',
            block: {
              type: 'image',
              attrs: { src: 'data:image/png;base64,QUJD', alt: 'The tray', share: 0.5 },
            },
          },
        ],
      },
    })

    render(<ChangesTab documentId="doc-1" />)

    const img = await screen.findByRole('img', { name: 'The tray' })
    expect(img).toHaveAttribute('src', 'data:image/png;base64,QUJD')
    expect(img).toHaveStyle({ width: '50%' })
    expect(screen.getByText('The tray')).toBeInTheDocument()
  })
})
