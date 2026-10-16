/**
 * Whether a memo taken out of circulation was cancelled by an administrator,
 * rather than withdrawn by its own preparer. Both are stored as DELETED; the
 * difference is who did it. A withdrawal can be sent round again, a cancel is
 * final - the server refuses a resubmission of one by the same rule.
 */
export function isCancelledByAdministrator(document: {
  preparerId: string
  withdrawnById?: string | null
}): boolean {
  return Boolean(document.withdrawnById) && document.withdrawnById !== document.preparerId
}
