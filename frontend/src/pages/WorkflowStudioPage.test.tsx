import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeUser, renderWithProviders } from '../test/render'
import {
  archiveAdminTemplate,
  fetchAdminTemplates,
  restoreAdminTemplate,
} from '../services/workflowTemplateApi'
import type { WorkflowTemplateSummary } from '../types/workflowTemplate'
import WorkflowStudioPage from './WorkflowStudioPage'

/**
 * One "New template" on screen, never two.
 *
 * The header action and the empty state's action are the same button, and on
 * an installation with no templates yet both rendered - which is exactly the
 * moment a first-time administrator is reading the screen to work out what a
 * template even is. Same defect as the documents list, same rule.
 */

/* The route-per-memo-type card has its own reads; its behaviour is in
   MemoTypeRoutesCard.test.tsx. Settled quietly here. */
vi.mock('../services/memoTypeRoutesApi', () => ({
  fetchMemoTypeRoutes: () => Promise.resolve([]),
  saveMemoTypeRoute: vi.fn(),
  fetchStartingRoutes: () => Promise.resolve({}),
}))

vi.mock('../services/workflowTemplateApi', () => ({
  fetchAdminTemplates: vi.fn(),
  updateAdminTemplate: vi.fn(),
  archiveAdminTemplate: vi.fn(),
  restoreAdminTemplate: vi.fn(),
  fetchActiveTemplates: () => Promise.resolve([]),
}))

const read = vi.mocked(fetchAdminTemplates)
const archive = vi.mocked(archiveAdminTemplate)
const restore = vi.mocked(restoreAdminTemplate)

const template = (
  overrides: Partial<WorkflowTemplateSummary> = {},
): WorkflowTemplateSummary => ({
  id: 'tmpl-0001',
  name: 'Standard HR memo',
  description: 'Reviewer, approver, final approver.',
  isActive: true,
  archivedAt: null,
  createdById: null,
  createdAt: '2026-09-01T09:00:00.000Z',
  updatedAt: '2026-09-05T09:00:00.000Z',
  ...overrides,
})

const list = () =>
  renderWithProviders(<WorkflowStudioPage />, {
    currentUser: { user: makeUser({ role: 'ADMINISTRATOR' }) },
  })

beforeEach(() => {
  vi.clearAllMocks()
})

describe('New template', () => {
  it('appears once with templates listed — in the header', async () => {
    read.mockResolvedValue([template()])
    list()

    expect(await screen.findByText('Standard HR memo')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /new template/i })).toHaveLength(1)
  })

  it('appears once on a fresh install — in the empty state, not twice', async () => {
    read.mockResolvedValue([])
    list()

    expect(await screen.findByText('No workflow templates yet')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /new template/i })).toHaveLength(1)
  })

  it('stays in the header when a search is what emptied the list', async () => {
    // Searched to nothing is not the same state as having nothing: templates
    // exist, the empty state offers "Clear search", and the header keeps the
    // only New template.
    const user = userEvent.setup()
    read.mockResolvedValue([template()])
    list()

    await screen.findByText('Standard HR memo')
    await user.type(screen.getByRole('searchbox'), 'nothing matches this')

    expect(await screen.findByText('No templates match your search')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /clear search/i })).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /new template/i })).toHaveLength(1)
  })
})

describe('retiring a template', () => {
  /*
   * Templates are archived, not deleted: deleting threw the design away, and
   * an archived template is kept, with its history, and can be restored.
   */
  const menuFor = async (user: ReturnType<typeof userEvent.setup>, name: string) => {
    await user.click(await screen.findByRole('button', { name: `Actions for ${name}` }))
  }

  it('offers Archive, and no Delete', async () => {
    const user = userEvent.setup()
    read.mockResolvedValue([template()])
    list()

    await menuFor(user, 'Standard HR memo')

    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual([
      'Open in the designer',
      'Deactivate',
      'Archive template',
    ])
  })

  it('asks first, says what archiving keeps, then archives and reloads the list', async () => {
    const user = userEvent.setup()
    read.mockResolvedValueOnce([template()]).mockResolvedValueOnce([])
    archive.mockResolvedValue({} as never)
    list()

    await menuFor(user, 'Standard HR memo')
    await user.click(screen.getByRole('menuitem', { name: 'Archive template' }))
    const dialog = screen.getByRole('dialog', { name: 'Archive this template?' })
    expect(dialog).toHaveTextContent('It is kept, with its design and its history, and can be restored.')
    expect(archive).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Archive' }))

    expect(archive.mock.calls).toEqual([['tmpl-0001']])
    expect(await screen.findByText('No workflow templates yet')).toBeInTheDocument()
    expect(read.mock.calls).toEqual([[{ archived: false }], [{ archived: false }]])
  })

  it('keeps the dialog open with the reason when archiving fails', async () => {
    const user = userEvent.setup()
    read.mockResolvedValue([template()])
    archive.mockRejectedValue(new Error('This template is already archived.'))
    list()

    await menuFor(user, 'Standard HR memo')
    await user.click(screen.getByRole('menuitem', { name: 'Archive template' }))
    await user.click(screen.getByRole('button', { name: 'Archive' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('This template is already archived.')
    expect(screen.getByRole('dialog', { name: 'Archive this template?' })).toBeInTheDocument()
  })

  it('shows the archive on its own, and restores from it', async () => {
    const user = userEvent.setup()
    const retired = template({ name: 'Old expense claim', isActive: false, archivedAt: '2026-09-20T09:00:00.000Z' })
    read.mockResolvedValueOnce([template()]).mockResolvedValueOnce([retired]).mockResolvedValueOnce([])
    restore.mockResolvedValue({} as never)
    list()

    await screen.findByText('Standard HR memo')
    await user.click(screen.getByRole('button', { name: 'Archived' }))

    expect(await screen.findByText('Old expense claim')).toBeInTheDocument()
    expect(screen.queryByText('Standard HR memo')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Archived' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText('Archived', { selector: 'span *, span' })).toBeInTheDocument()

    await menuFor(user, 'Old expense claim')
    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual([
      'Open (read only)',
      'Restore',
    ])
    await user.click(screen.getByRole('menuitem', { name: 'Restore' }))

    expect(restore.mock.calls).toEqual([['tmpl-0001']])
    expect(await screen.findByText('No archived templates')).toBeInTheDocument()
    expect(read.mock.calls).toEqual([[{ archived: false }], [{ archived: true }], [{ archived: true }]])
  })

  it('says what the archive is for when it is empty, and does not offer New template twice', async () => {
    const user = userEvent.setup()
    read.mockResolvedValueOnce([template()]).mockResolvedValueOnce([])
    list()

    await screen.findByText('Standard HR memo')
    await user.click(screen.getByRole('button', { name: 'Archived' }))

    expect(await screen.findByText('No archived templates')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /new template/i })).toHaveLength(1)
  })
})

describe('when the list cannot be read', () => {
  it('says why, instead of claiming there are no templates', async () => {
    read.mockRejectedValue(new Error('The server did not answer.'))
    list()

    expect(await screen.findByRole('alert')).toHaveTextContent('The server did not answer.')
  })
})
