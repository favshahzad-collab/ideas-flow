import { Badge, type Tone } from '../ui/Card'
import type { AuditActionLabel } from '../../types/audit'

/**
 * One approval-log event, tinted by what actually happened.
 *
 * There were two of these. The ledger screen mapped each action to its
 * semantic tone; the copy inside the document detail drew every badge in
 * accent, so a REJECTION rendered green — colour asserting the opposite of
 * the event it labelled, which is worse than no colour at all. One map now,
 * two consumers.
 */

const TONES: Record<AuditActionLabel, Tone> = {
  Approved: 'accent',
  Rejected: 'danger',
  'Revision Requested': 'revision',
  'Step Skipped': 'warning',
  'Document Uploaded': 'neutral',
  'Document Resubmitted': 'info',
  'Document Withdrawn': 'neutral',
  'Document Cancelled': 'neutral',
  // The preparer's decision about a rejection already shown in danger red.
  'Left as Rejected': 'neutral',
  // A copy taken, not a decision made - so no semantic colour, the same as an
  // upload. Colouring it would put a read on the same footing as an approval.
  Downloaded: 'neutral',
  Viewed: 'neutral',
  Printed: 'neutral',
  // The step changed hands. Informational, and pointedly not the warning tone
  // that Skipped carries: skipping moves a memo on without an approval, this
  // asks somebody else for the same approval.
  'Step Reassigned': 'info',
  // Somebody asked. Nothing happened to the memo, so no semantic colour.
  'Reminder Sent': 'neutral',
  'Unrecognised action': 'neutral',
}

/** The dense spelling. The action filter keeps the long names. */
const SHORT: Record<AuditActionLabel, string> = {
  Approved: 'Approved',
  Rejected: 'Rejected',
  'Revision Requested': 'Revision',
  'Step Skipped': 'Skipped',
  'Document Uploaded': 'Uploaded',
  'Document Resubmitted': 'Resubmitted',
  'Document Withdrawn': 'Withdrawn',
  'Document Cancelled': 'Cancelled',
  'Left as Rejected': 'Closed',
  Downloaded: 'Downloaded',
  Viewed: 'Viewed',
  Printed: 'Printed',
  'Step Reassigned': 'Reassigned',
  'Reminder Sent': 'Reminded',
  'Unrecognised action': 'Unrecognised',
}

export default function ActionBadge({
  action,
  verbose = false,
}: {
  action: AuditActionLabel
  /** Spell the action out where the row has room for it. */
  verbose?: boolean
}) {
  /* An action the map does not know still has to render — and must not
     borrow another event's colour to do it. */
  const tone = TONES[action] ?? 'neutral'
  const label = verbose ? action : (SHORT[action] ?? action)

  return (
    <Badge tone={tone} dot>
      <span title={action}>{label}</span>
    </Badge>
  )
}
