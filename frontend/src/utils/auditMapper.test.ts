import { describe, expect, it } from 'vitest'
import type { ApiAuditEntry, AuditRecord } from '../types/audit'
import {
  getAuditActionFilterOptions,
  mapApiAuditEntryToRecord,
  mapAuditActionLabel,
  mapAuditRoleLabel,
} from './auditMapper'

/**
 * The ledger row. It is the record somebody reads to establish what happened,
 * so an action or a role it does not recognise has to say so rather than
 * render an empty cell or a raw enum nobody can interpret.
 */

const entry = (overrides: Partial<ApiAuditEntry> = {}): ApiAuditEntry =>
  ({
    id: 'a1',
    date: new Date(2026, 8, 5, 14, 30, 45).toISOString(),
    time: '',
    user: { id: 'u1', firstName: 'Ayesha', lastName: 'Khan' },
    role: 'REVIEWER',
    action: 'APPROVE',
    comments: 'Looks right to me.',
    documentId: '3f2a9b1c-0d4e-4f5a-8b6c-7d8e9f0a1b2c',
    documentTitle: 'Warehouse lease extension',
    documentStatus: 'PENDING_REVIEW',
    ...overrides,
  }) as ApiAuditEntry

describe('mapAuditActionLabel', () => {
  it.each([
    ['APPROVE', 'Approved'],
    ['REJECT', 'Rejected'],
    ['REQUEST_REVISION', 'Revision Requested'],
    ['SKIP', 'Step Skipped'],
    ['DOCUMENT_UPLOADED', 'Document Uploaded'],
    ['DOCUMENT_RESUBMITTED', 'Document Resubmitted'],
    ['DOCUMENT_DELETED', 'Document Withdrawn'],
    ['DOCUMENT_DOWNLOADED', 'Downloaded'],
    ['DOCUMENT_PRINTED', 'Printed'],
  ])('writes %s as %s', (action, expected) => {
    expect(mapAuditActionLabel(action)).toBe(expected)
  })

  it('covers every action the backend audit service can emit', () => {
    // These are the exact strings audit.service maps to. A backend action
    // with no label here shows as "Unrecognised action" in the ledger, which
    // is honest but useless - so the list is asserted rather than assumed.
    for (const action of [
      'APPROVE',
      'REJECT',
      'REQUEST_REVISION',
      'SKIP',
      'DOCUMENT_UPLOADED',
      'DOCUMENT_RESUBMITTED',
      'DOCUMENT_DELETED',
      'DOCUMENT_DOWNLOADED',
      // Was missing from this list while being mapped, which is the drift the
      // comment above warns about happening to the list itself.
      'DOCUMENT_VIEWED',
      'DOCUMENT_PRINTED',
      'WORKFLOW_STEP_REASSIGNED',
      'APPROVAL_REMINDER_SENT',
    ]) {
      expect(mapAuditActionLabel(action), action).not.toBe('Unrecognised action')
    }
  })

  it('says so rather than showing a raw enum it does not know', () => {
    expect(mapAuditActionLabel('SOME_FUTURE_ACTION')).toBe('Unrecognised action')
    expect(mapAuditActionLabel('')).toBe('Unrecognised action')
  })
})

describe('mapAuditRoleLabel', () => {
  it.each([
    ['REVIEWER', 'Reviewer'],
    ['APPROVER', 'Approver'],
    ['FINAL_APPROVER', 'Final Approver'],
    ['Preparer', 'Preparer'],
    ['Viewer', 'Viewer'],
  ])('writes %s as %s', (role, expected) => {
    expect(mapAuditRoleLabel(role)).toBe(expected)
  })

  it('passes an unknown role through rather than blanking the cell', () => {
    // Unlike the action, a role is free text on the backend side, so showing
    // it as sent is more useful than replacing it.
    expect(mapAuditRoleLabel('Observer')).toBe('Observer')
  })
})

describe('mapApiAuditEntryToRecord', () => {
  it('carries the identifying fields through untouched', () => {
    const record = mapApiAuditEntryToRecord(entry())

    expect(record).toMatchObject({
      id: 'a1',
      document: 'Warehouse lease extension',
      documentId: '3f2a9b1c-0d4e-4f5a-8b6c-7d8e9f0a1b2c',
      documentStatus: 'PENDING_REVIEW',
      action: 'Approved',
      actionRaw: 'APPROVE',
      role: 'Reviewer',
    })
  })

  it('keeps the raw timestamp beside the formatted one', () => {
    // `occurredAt` is what the grouping sorts on; the display date has lost
    // the time by then.
    const record = mapApiAuditEntryToRecord(entry())

    expect(record.occurredAt).toBe(entry().date)
    expect(record.date).toBe('Sep 5, 2026')
  })

  it('writes the time as 24-hour, so 2pm is not read as 2am', () => {
    const record = mapApiAuditEntryToRecord(entry())

    expect(record.time).toBe('14:30:45')
  })

  it('names the person and their initials', () => {
    const record = mapApiAuditEntryToRecord(entry())

    expect(record.user).toBe('Ayesha Khan')
    expect(record.initials).toBe('AK')
  })

  it('carries the second name on a delegated approval', () => {
    // Two people in one act: the signature is the delegate's, the authority
    // was somebody else's. The avatar stays the signer's - they are who put
    // their name to it - and the row says whose approval it was.
    const record = mapApiAuditEntryToRecord(
      entry({ onBehalfOf: { id: 'u2', firstName: 'Priya', lastName: 'Nair' } }),
    )

    expect(record.user).toBe('Ayesha Khan')
    expect(record.initials).toBe('AK')
    expect(record.onBehalfOf).toBe('Priya Nair')
  })

  it('leaves it null on an ordinary approval, rather than repeating the actor', () => {
    // A row that reads "Ayesha Khan for Ayesha Khan" would make every
    // approval look like a delegated one.
    expect(mapApiAuditEntryToRecord(entry()).onBehalfOf).toBeNull()
    expect(mapApiAuditEntryToRecord(entry({ onBehalfOf: null })).onBehalfOf).toBeNull()
  })

  it('puts a dash in the comment cell rather than leaving it blank', () => {
    for (const comments of [null, '', '   ']) {
      expect(mapApiAuditEntryToRecord(entry({ comments })).comments).toBe('—')
    }
  })

  it('trims a comment rather than rendering its padding', () => {
    expect(
      mapApiAuditEntryToRecord(entry({ comments: '  needs the survey  ' })).comments,
    ).toBe('needs the survey')
  })
})

describe('getAuditActionFilterOptions', () => {
  const record = (action: string) =>
    ({ action }) as unknown as AuditRecord

  it('always offers the unfiltered option first', () => {
    expect(getAuditActionFilterOptions([])).toEqual(['All Actions'])
  })

  it('lists each action once, in order', () => {
    const options = getAuditActionFilterOptions([
      record('Rejected'),
      record('Approved'),
      record('Rejected'),
      record('Document Uploaded'),
    ])

    expect(options).toEqual([
      'All Actions',
      'Approved',
      'Document Uploaded',
      'Rejected',
    ])
  })

  it('offers only actions that are actually in the list', () => {
    // A dropdown offering filters that match nothing invites the user to
    // conclude the ledger is empty when it is the filter that is.
    expect(getAuditActionFilterOptions([record('Approved')])).toEqual([
      'All Actions',
      'Approved',
    ])
  })
})
