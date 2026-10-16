import type { IdentityMethod } from "./tokens";
/**
 * What a signer agrees to, and what the record keeps about how they signed.
 *
 * A signature image on a page proves very little by itself: anybody holding
 * the file can paste one. What makes it the signer's act is the record around
 * it - that they proved who they were moments before, that they agreed in
 * words to sign, and how the mark was made. Each signature writes a
 * `DOCUMENT_SIGNED` entry to the audit ledger carrying exactly that.
 *
 * The statement is stored with every signature, not referred to by a version
 * number, so a later change to the wording cannot alter what somebody agreed
 * to years ago. The frontend shows the same sentence beside the tick box; the
 * copy recorded is this one, because it is the server's record.
 */
export const SIGNING_CONSENT_STATEMENT =
  "I confirm this is my signature, and that signing here has the same effect as signing this memo on paper.";

/** What the route proved before the signature was applied. */
export type SigningAttestation = {
  /** When the signer last confirmed it was them, with a password or a code. */
  identityConfirmedAt: Date;
  /** How: password, authenticator code or a fresh Microsoft sign-in. */
  identityConfirmedBy?: IdentityMethod | null;
  /** They ticked the box: the request carried `consent: true`. */
  consented: true;
  /** Where the request came from, for the signature certificate. */
  ipAddress?: string;
};

/** How the mark itself was made, for the record. */
export const signatureMethod = (input: { useSavedSignature?: boolean }) =>
  input.useSavedSignature ? "SAVED_SIGNATURE" : "DRAWN";

/**
 * The `DOCUMENT_SIGNED` ledger entry, the same shape for the preparer and for
 * every approver: who signed is the entry's actor, and this is the rest of
 * what an auditor asks of a signature.
 *
 * `identityConfirmedAt` and the statement are recorded only when the route
 * proved them. A signature applied by some other caller - a script, a test -
 * says so by leaving them null rather than claiming checks that never ran.
 */
export function signedRecord(args: {
  capacity: "PREPARER" | "REVIEWER" | "APPROVER" | "FINAL_APPROVER";
  versionNumber: number;
  stepOrder?: number;
  method: ReturnType<typeof signatureMethod>;
  signaturePage: number;
  signedPdfChecksum: string;
  /** SHA-256 of the signature image that went on the page. */
  signatureImageChecksum?: string | null;
  onBehalfOfId?: string | null;
  attestation?: SigningAttestation;
  /** Final approval only: whose seal the approved file carries, null if none. */
  sealedBy?: string | null;
}) {
  return {
    status: "SIGNED",
    capacity: args.capacity,
    versionNumber: args.versionNumber,
    ...(args.stepOrder !== undefined ? { stepOrder: args.stepOrder } : {}),
    method: args.method,
    signaturePage: args.signaturePage,
    signedPdfChecksum: args.signedPdfChecksum,
    signatureImageChecksum: args.signatureImageChecksum ?? null,
    onBehalfOfId: args.onBehalfOfId ?? null,
    identityConfirmedAt: args.attestation?.identityConfirmedAt.toISOString() ?? null,
    identityConfirmedBy: args.attestation?.identityConfirmedBy ?? null,
    consentStatement: args.attestation?.consented ? SIGNING_CONSENT_STATEMENT : null,
    ...(args.sealedBy !== undefined ? { sealedBy: args.sealedBy } : {}),
  };
}
