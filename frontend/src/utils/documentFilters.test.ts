import { describe, expect, it } from 'vitest'
import type { DashboardDocument } from '../types/document'
import { filterDocuments, filterMyQueue } from './documentFilters'

/**
 * The document table's search box and status tabs. Both of them decide what a
 * person is allowed to conclude is not there - so "no results" has to mean the
 * same thing every time.
 */

const doc = (overrides: Partial<DashboardDocument>): DashboardDocument =>
  ({
    id: 'aaaaaaaa-0000-4000-8000-000000000001',
    title: 'Warehouse lease extension',
    description: '',
    status: 'pending_review',
    preparerId: 'p1',
    submittedBy: 'Ayesha Khan',
    submittedByInitials: 'AK',
    currentHolder: 'Bilal Ahmed',
    currentHolderInitials: 'BA',
    currentStep: 1,
    totalSteps: 3,
    lastUpdated: '',
    submittedDate: '',
    submittedAt: '',
    updatedAt: '',
    versionNumber: 1,
    approvalType: null,
    actionLabel: '',
    nextHolder: null,
    fileType: 'pdf',
    isAwaitingMyAction: false,
    ...overrides,
  }) as DashboardDocument

const titles = (documents: DashboardDocument[]) => documents.map(d => d.title)

describe('filterDocuments: search', () => {
  const documents = [
    doc({ title: 'Warehouse lease extension' }),
    doc({ title: 'Stationery order', submittedBy: 'Chandni Rao' }),
    doc({ title: 'Fleet insurance', currentHolder: 'Dawood Iqbal' }),
    doc({ title: 'Payroll change', id: 'ffffffff-0000-4000-8000-00000000000f' }),
  ]

  it('returns everything for an empty search', () => {
    expect(filterDocuments(documents, '', 'all')).toHaveLength(4)
  })

  it('finds a memo by the reference number people quote', () => {
    const referenced = [
      ...documents,
      doc({ title: 'Generator service', referenceNumber: 'MEMO-2026-0043' }),
    ]
    expect(titles(filterDocuments(referenced, 'memo-2026-0043', 'all'))).toEqual([
      'Generator service',
    ])
  })

  it('finds a memo by words in its description', () => {
    const described = [
      ...documents,
      doc({ title: 'Generator service', description: 'Annual maintenance contract for the backup generator' }),
    ]
    expect(titles(filterDocuments(described, 'maintenance contract', 'all'))).toEqual([
      'Generator service',
    ])
  })

  it('ignores surrounding whitespace', () => {
    expect(titles(filterDocuments(documents, '  warehouse  ', 'all'))).toEqual([
      'Warehouse lease extension',
    ])
  })

  it('matches the title without regard to case', () => {
    expect(titles(filterDocuments(documents, 'STATIONERY', 'all'))).toEqual([
      'Stationery order',
    ])
  })

  it('matches the person who submitted it', () => {
    expect(titles(filterDocuments(documents, 'chandni', 'all'))).toEqual([
      'Stationery order',
    ])
  })

  it('matches whoever is holding it', () => {
    // Which is the search a manager actually does: not "which document", but
    // "what is sitting with Dawood".
    expect(titles(filterDocuments(documents, 'dawood', 'all'))).toEqual([
      'Fleet insurance',
    ])
  })

  it('matches the id, so a reference from an email finds the row', () => {
    expect(titles(filterDocuments(documents, 'ffffffff', 'all'))).toEqual([
      'Payroll change',
    ])
  })

  it('matches on a fragment, not just a whole word', () => {
    expect(filterDocuments(documents, 'lease ext', 'all')).toHaveLength(1)
  })

  it('returns nothing when nothing matches', () => {
    expect(filterDocuments(documents, 'zzzz', 'all')).toEqual([])
  })
})

describe('filterDocuments: status', () => {
  const documents = [
    doc({ title: 'In review', status: 'pending_review' }),
    doc({ title: 'With approver', status: 'pending_approval' }),
    doc({ title: 'Done', status: 'approved' }),
    doc({ title: 'Turned down', status: 'rejected' }),
    doc({ title: 'Sent back', status: 'revision_requested' }),
  ]

  it('lets everything through on all', () => {
    expect(filterDocuments(documents, '', 'all')).toHaveLength(5)
  })

  it('treats pending as review and approval together', () => {
    // The two are one thing to a person waiting: it has not been decided yet.
    expect(titles(filterDocuments(documents, '', 'pending'))).toEqual([
      'In review',
      'With approver',
    ])
  })

  it.each([
    ['pending_review', 'In review'],
    ['pending_approval', 'With approver'],
    ['approved', 'Done'],
    ['rejected', 'Turned down'],
    ['revision_requested', 'Sent back'],
  ] as const)('narrows %s to exactly that status', (filter, expected) => {
    expect(titles(filterDocuments(documents, '', filter))).toEqual([expected])
  })

  it('applies the search and the status together, not either', () => {
    expect(
      filterDocuments(documents, 'In review', 'approved'),
    ).toEqual([])
  })
})

describe('filterMyQueue', () => {
  it('keeps only what is both mine and undecided', () => {
    const documents = [
      doc({ title: 'Mine, waiting', status: 'pending_review', isAwaitingMyAction: true }),
      doc({ title: 'Mine, approving', status: 'pending_approval', isAwaitingMyAction: true }),
      doc({ title: 'Not mine', status: 'pending_review', isAwaitingMyAction: false }),
      doc({ title: 'Mine but done', status: 'approved', isAwaitingMyAction: true }),
      doc({
        title: 'Mine but sent back',
        status: 'revision_requested',
        isAwaitingMyAction: true,
      }),
    ]

    // A queue that includes anything already decided is a queue people stop
    // trusting as a to-do list.
    expect(titles(filterMyQueue(documents))).toEqual([
      'Mine, waiting',
      'Mine, approving',
    ])
  })

  it('is empty rather than undefined when there is nothing to do', () => {
    expect(filterMyQueue([])).toEqual([])
  })
})
