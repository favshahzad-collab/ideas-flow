/**
 * The shortest new password the server accepts, checked here too so a form can
 * say so before the round trip. The rest of the rule - not a common password,
 * not the person's own name or email - is the server's, and it answers in
 * words a form shows as they are (`backend/src/lib/passwordPolicy.ts`).
 *
 * It was 6, written out separately on three screens.
 */
export const PASSWORD_MIN_LENGTH = 12
