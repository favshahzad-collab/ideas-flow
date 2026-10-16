/**
 * Whether a memo taken out of circulation was cancelled by an administrator,
 * rather than withdrawn by its own preparer.
 *
 * Both are stored the same way - status DELETED, with who did it and why - so
 * the difference is who did it. A withdrawal can be sent round again; a
 * cancel is final. The memo page tells the two apart by the same rule.
 */
export function isCancelledByAdministrator(document: {
  preparerId: string;
  withdrawnById: string | null;
}): boolean {
  return document.withdrawnById !== null && document.withdrawnById !== document.preparerId;
}
