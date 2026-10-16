import { describe, expect, it } from 'vitest'
import type { AuditRecord } from '../types/audit'
import { filterAuditRecords, groupAuditRecordsByDocument } from './auditFilters'

/**
 * The audit ledger's search and grouping. The ledger is what somebody opens
 * when they need to establish what happened, so "not found" has to mean it is
 * not there - not that they searched the wrong column.
 */

const record = (overrides: Partial<AuditRecord>): AuditRecord =>
  ({
    id: 'a1',
    occurredAt: '2026-09-05T12:00:00.000Z',
    date: '2026-09-05',
    time: '12:00',
    document: 'Warehouse lease extension',
    documentId: '3f2a9b1c-0d4e-4f5a-8b6c-7d8e9f0a1b2c',
    documentStatus: 'PENDING_REVIEW',
    user: 'Ayesha Khan',
    initials: 'AK',
    role: 'REVIEWER',
    action: 'Approved',
    actionRaw: 'APPROVE',
    comments: '',
    ...overrides,
  }) as AuditRecord

describe('filterAuditRecords', () => {
  const records = [
    record({ id: 'a1', document: 'Warehouse lease extension', user: 'Ayesha Khan' }),
    record({ id: 'a2', document: 'Stationery order', user: 'Bilal Ahmed', action: 'Rejected' }),
    record({
      id: 'a3',
      document: 'Fleet insurance',
      user: 'Chandni Rao',
      documentId: 'ffffffff-0d4e-4f5a-8b6c-7d8e9f0a1b2c',
    }),
  ]

  const ids = (found: AuditRecord[]) => found.map(entry => entry.id)

  it('returns everything with no search and no action filter', () => {
    expect(filterAuditRecords(records, '', 'All Actions')).toHaveLength(3)
  })

  it('searches the document title', () => {
    expect(ids(filterAuditRecords(records, 'warehouse', 'All Actions'))).toEqual(['a1'])
  })

  it('searches the person', () => {
    expect(ids(filterAuditRecords(records, 'chandni', 'All Actions'))).toEqual(['a3'])
  })

  it('searches the full document id', () => {
    expect(
      ids(filterAuditRecords(records, 'ffffffff-0d4e-4f5a-8b6c-7d8e9f0a1b2c', 'All Actions')),
    ).toEqual(['a3'])
  })

  it('searches the short id the screen actually shows', () => {
    // Every row displays `FFFFFFFF`, so that is what somebody copies out of
    // it and pastes back into the search box.
    expect(ids(filterAuditRecords(records, 'FFFFFFFF', 'All Actions'))).toEqual(['a3'])
    expect(ids(filterAuditRecords(records, 'ffffffff', 'All Actions'))).toEqual(['a3'])
  })

  it('ignores case and surrounding whitespace', () => {
    expect(ids(filterAuditRecords(records, '  STATIONERY  ', 'All Actions'))).toEqual(['a2'])
  })

  it('narrows to one action', () => {
    expect(ids(filterAuditRecords(records, '', 'Rejected'))).toEqual(['a2'])
  })

  it('applies the search and the action together', () => {
    expect(filterAuditRecords(records, 'warehouse', 'Rejected')).toEqual([])
  })

  it('returns nothing when nothing matches, rather than everything', () => {
    expect(filterAuditRecords(records, 'nothing like this', 'All Actions')).toEqual([])
  })
})

describe('groupAuditRecordsByDocument', () => {
  const at = (iso: string, overrides: Partial<AuditRecord> = {}) =>
    record({ occurredAt: iso, id: iso, ...overrides })

  it('gathers every action on one document into one group', () => {
    const groups = groupAuditRecordsByDocument([
      at('2026-09-01T10:00:00.000Z'),
      at('2026-09-03T10:00:00.000Z'),
      at('2026-09-02T10:00:00.000Z'),
    ])

    expect(groups).toHaveLength(1)
    expect(groups[0].actions).toHaveLength(3)
  })

  it('orders the actions inside a group newest first', () => {
    const groups = groupAuditRecordsByDocument([
      at('2026-09-01T10:00:00.000Z'),
      at('2026-09-03T10:00:00.000Z'),
      at('2026-09-02T10:00:00.000Z'),
    ])

    expect(groups[0].actions.map(action => action.occurredAt)).toEqual([
      '2026-09-03T10:00:00.000Z',
      '2026-09-02T10:00:00.000Z',
      '2026-09-01T10:00:00.000Z',
    ])
  })

  it('names the latest action as the one the collapsed row shows', () => {
    const groups = groupAuditRecordsByDocument([
      at('2026-09-01T10:00:00.000Z', { action: 'Approved' }),
      at('2026-09-03T10:00:00.000Z', { action: 'Rejected' }),
    ])

    expect(groups[0].latestAction.action).toBe('Rejected')
    expect(groups[0].latestAction).toBe(groups[0].actions[0])
  })

  it('orders the groups by their most recent activity', () => {
    // Not by title, and not by when each document started: the ledger is read
    // top-down for "what has been happening".
    const groups = groupAuditRecordsByDocument([
      at('2026-09-01T10:00:00.000Z', { documentId: 'old-doc', document: 'Older' }),
      at('2026-09-09T10:00:00.000Z', { documentId: 'new-doc', document: 'Newer' }),
      at('2026-08-01T10:00:00.000Z', { documentId: 'new-doc', document: 'Newer' }),
    ])

    expect(groups.map(group => group.document)).toEqual(['Newer', 'Older'])
  })

  it('carries the title and status from the newest row, not the oldest', () => {
    // A document renamed, or moved to APPROVED, should show its current
    // state on the collapsed row rather than what it was called first.
    const groups = groupAuditRecordsByDocument([
      at('2026-09-01T10:00:00.000Z', { document: 'Old title', documentStatus: 'PENDING_REVIEW' }),
      at('2026-09-09T10:00:00.000Z', { document: 'New title', documentStatus: 'APPROVED' }),
    ])

    expect(groups[0].document).toBe('New title')
    expect(groups[0].documentStatus).toBe('APPROVED')
  })

  it('returns nothing for nothing', () => {
    expect(groupAuditRecordsByDocument([])).toEqual([])
  })

  it('does not mutate what it was given', () => {
    // It sorts, and sorting in place would reorder the caller's array under
    // React state that has already been handed to a child.
    const input = [
      at('2026-09-01T10:00:00.000Z'),
      at('2026-09-03T10:00:00.000Z'),
    ]
    const order = input.map(entry => entry.occurredAt)

    groupAuditRecordsByDocument(input)

    expect(input.map(entry => entry.occurredAt)).toEqual(order)
  })
})
