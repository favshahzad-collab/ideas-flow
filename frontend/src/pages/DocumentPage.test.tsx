import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeUser, renderWithProviders } from '../test/render'
import type { DashboardDocument } from '../types/document'
import MyDocuments from './DocumentPage'

/**
 * The actions this screen offers, and the ones it must not.
 *
 * Both defects these tests hold shut were the same mistake in different
 * clothes: a control on screen that is not a way to do something. One was
 * permanently disabled and had no endpoint behind it; the other was a second
 * copy of a button already on the page.
 */

const docsState: { documents: DashboardDocument[]; loading: boolean; error: string | null } = {
  documents: [],
  loading: false,
  error: null,
}

vi.mock('../hooks/useDocuments', () => ({
  useDocuments: () => ({
    documents: docsState.documents,
    currentUserId: 'user-0000-0000-0000-000000000001',
    userName: 'Ayesha Khan',
    loading: docsState.loading,
    error: docsState.error,
    refetch: () => {},
  }),
}))

function makeDoc(overrides: Partial<DashboardDocument> = {}): DashboardDocument {
  return {
    id: '3f2a9b1c-0d4e-4f5a-8b6c-7d8e9f0a1b2c',
    referenceNumber: null,
    title: 'Warehouse lease extension',
    description: 'Two-year extension on the Korangi warehouse.',
    status: 'pending_review',
    preparerId: 'user-0000-0000-0000-000000000002',
    submittedBy: 'Bilal Ahmed',
    submittedByInitials: 'BA',
    currentHolder: 'Chandni Rao',
    currentHolderInitials: 'CR',
    currentStep: 2,
    totalSteps: 4,
    lastUpdated: '2h',
    submittedDate: '2026-09-01',
    submittedAt: '2026-09-01T09:00:00.000Z',
    updatedAt: '2026-09-05T09:00:00.000Z',
    versionNumber: 1,
    approvalType: 'REVIEWER',
    actionLabel: 'Review',
    nextHolder: 'Danish Iqbal',
    fileType: 'pdf',
    isAwaitingMyAction: true,
    dueAt: null,
    ...overrides,
  }
}

const list = (documents: DashboardDocument[], route = '/dashboard') => {
  docsState.documents = documents
  return renderWithProviders(<MyDocuments />, {
    route,
    currentUser: { user: makeUser() },
  })
}

beforeEach(() => {
  docsState.documents = []
  docsState.loading = false
  docsState.error = null
})

describe('the Export button', () => {
  it('is gone, because there is no endpoint behind it', () => {
    /*
     * It sat in the header permanently disabled, carrying
     * `title="Needs an export endpoint"`. A control that can never be pressed
     * is a screen claiming the product does something it does not do, and the
     * person who needs the export goes looking for why it is greyed out and
     * finds nothing. This test is what keeps it off the screen until
     * `GET /api/documents/export` exists.
     */
    list([makeDoc()])

    expect(screen.queryByRole('button', { name: /export/i })).not.toBeInTheDocument()
  })
})

describe('Submit document', () => {
  it('appears once on a list with documents in it — in the header', () => {
    list([makeDoc()])

    const offered = screen.getAllByRole('button', { name: /submit document/i })
    expect(offered).toHaveLength(1)
    expect(screen.queryByText('No documents found')).not.toBeInTheDocument()
  })

  it('appears once on an empty list — in the empty state, not twice', () => {
    // The defect: the header action and the empty state's action are the same
    // button, and both used to render. An identical control twice in one view
    // is the first thing somebody sees on their first day.
    list([])

    expect(screen.getByText('No documents found')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /submit document/i })).toHaveLength(1)
  })

  it('stays in the header when a filter is what emptied the list', async () => {
    /*
     * Filtered to nothing is not the same state as having nothing: there ARE
     * documents, the empty state offers "Clear filters" rather than a second
     * Submit, and the header keeps the only one.
     */
    const user = userEvent.setup()
    list([makeDoc({ title: 'Warehouse lease extension' })])

    await user.type(screen.getByRole('searchbox'), 'nothing matches this')

    expect(await screen.findByText(/No documents found/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /clear filters/i })).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /submit document/i })).toHaveLength(1)
  })
})

describe('the header', () => {
  it('still says whose documents these are', () => {
    // Removing an action must not take the eyebrow with it: an administrator
    // sees every memo in the organisation and the screen has to say so.
    const { container } = list([makeDoc()])

    expect(within(container).getByText(/Workspace/)).toBeInTheDocument()
  })
})

describe('when the list cannot be loaded', () => {
  const failWith = (capabilities: string[]) => {
    docsState.error = 'The server did not answer.'
    return renderWithProviders(<MyDocuments />, {
      route: '/dashboard',
      // The page reads the session's capabilities to decide what to call
      // the list, so both contexts carry the same person.
      auth: { sessionUser: makeUser({ capabilities: capabilities as never }) },
      currentUser: { user: makeUser({ capabilities: capabilities as never }) },
    })
  }

  it('tells somebody their own documents failed to load', () => {
    failWith(['memos.view.own', 'memos.view.assigned'])

    expect(screen.getByRole('alert')).toHaveTextContent('Could not load your documents')
    expect(screen.getByRole('alert')).toHaveTextContent('The server did not answer.')
  })

  it('does not say "your documents" to somebody looking at every memo', () => {
    // The same rule as the eyebrow: an administrator's list is the whole
    // organisation's, and the heading says so when it loads.
    failWith(['memos.view.own', 'memos.view.assigned', 'memos.view.all'])

    expect(screen.getByRole('alert')).toHaveTextContent('Could not load the documents')
    expect(screen.getByRole('alert')).not.toHaveTextContent('your documents')
  })
})
