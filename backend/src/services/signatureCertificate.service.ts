import { ApprovalActionType } from "../generated/prisma/client";
import { CAPACITY_LABEL } from "../lib/pdfSignature";
import {
  isTimeZone,
  type CertificateData,
  type CertificateSigner,
  type CertificateSkippedStep,
} from "../lib/signatureCertificate";
import { prisma } from "../prisma";

/**
 * The zone the certificate's times are shown in.
 *
 * `TIME_ZONE` when it is set and real, otherwise Pakistan time - this is a
 * deployment for an organisation in Karachi, and a page of UTC times would be
 * read wrongly by the people it is for. UTC is printed beside every time
 * anyway, so a page read abroad is never ambiguous.
 */
export function certificateTimeZone(): string {
  const configured = process.env.TIME_ZONE?.trim();
  if (configured && isTimeZone(configured)) return configured;
  return "Asia/Karachi";
}

type SignedEntry = {
  actorId: string | null;
  createdAt: Date;
  ipAddress: string | null;
  value: {
    capacity?: string;
    versionNumber?: number;
    stepOrder?: number;
    method?: "SAVED_SIGNATURE" | "DRAWN";
    identityConfirmedAt?: string | null;
    identityConfirmedBy?: "PASSWORD" | "AUTHENTICATOR" | "MICROSOFT" | null;
    consentStatement?: string | null;
  };
};

const fullName = (person: { firstName: string; lastName: string }) =>
  `${person.firstName} ${person.lastName}`.trim();

const fromEntry = (entry: SignedEntry | undefined): Partial<CertificateSigner> =>
  entry
    ? {
        method: entry.value.method ?? null,
        identityConfirmedAt: entry.value.identityConfirmedAt
          ? new Date(entry.value.identityConfirmedAt)
          : null,
        identityConfirmedBy: entry.value.identityConfirmedBy ?? null,
        agreedToStatement: Boolean(entry.value.consentStatement),
      }
    : {};

/**
 * Everything the certificate prints, gathered from the records the workflow
 * already keeps: the approval rows for this run, and the DOCUMENT_SIGNED
 * ledger entries for this version. The signature being made right now is not
 * in either yet - the certificate is drawn before that transaction opens - so
 * the caller passes it in as `current`.
 *
 * A signature made before the signing checks existed has no DOCUMENT_SIGNED
 * entry. It still appears, with what the approval row knows, and the page says
 * plainly that the rest was not recorded.
 */
export async function certificateFor(args: {
  documentId: string;
  workflowRunId: string;
  version: { versionNumber: number; storageChecksum: string | null };
  current: CertificateSigner;
  approvedAt: Date;
  sealedBy?: string | null;
}): Promise<CertificateData> {
  const { documentId, workflowRunId, version } = args;

  const [document, actions, logs] = await Promise.all([
    prisma.document.findUniqueOrThrow({
      where: { id: documentId },
      select: {
        id: true,
        title: true,
        referenceNumber: true,
        submittedAt: true,
        preparer: { select: { id: true, firstName: true, lastName: true, designation: true } },
      },
    }),
    prisma.approvalAction.findMany({
      where: {
        workflowRunId,
        action: { in: [ApprovalActionType.APPROVE, ApprovalActionType.SKIP] },
      },
      orderBy: { createdAt: "asc" },
      select: {
        action: true,
        actorId: true,
        approvalType: true,
        comment: true,
        createdAt: true,
        ipAddress: true,
        actor: { select: { firstName: true, lastName: true, designation: true } },
        onBehalfOf: { select: { firstName: true, lastName: true } },
        chainStep: {
          select: { stepOrder: true, assignedUser: { select: { firstName: true, lastName: true } } },
        },
      },
    }),
    prisma.auditLog.findMany({
      where: { entityId: documentId, action: { in: ["DOCUMENT_SIGNED", "DOCUMENT_SUBMITTED"] } },
      orderBy: { createdAt: "asc" },
      select: { action: true, actorId: true, createdAt: true, ipAddress: true, newValue: true },
    }),
  ]);

  const ofThisVersion = (value: unknown) =>
    (value as { versionNumber?: number } | null)?.versionNumber === version.versionNumber;
  const signed: SignedEntry[] = logs
    .filter((log) => log.action === "DOCUMENT_SIGNED" && ofThisVersion(log.newValue))
    .map((log) => ({ ...log, value: (log.newValue ?? {}) as SignedEntry["value"] }));

  const signers: CertificateSigner[] = [];

  // The preparer, when they signed this version.
  const preparerEntry = signed.find((entry) => entry.value.capacity === "PREPARER");
  const submitted = logs
    .filter((log) => log.action === "DOCUMENT_SUBMITTED" && ofThisVersion(log.newValue))
    .at(-1);
  const preparerSigned =
    preparerEntry !== undefined ||
    (submitted?.newValue as { preparerSigned?: boolean } | null)?.preparerSigned === true;
  if (preparerSigned) {
    signers.push({
      name: fullName(document.preparer),
      designation: document.preparer.designation,
      role: "Preparer",
      signedAt: preparerEntry?.createdAt ?? submitted?.createdAt ?? document.submittedAt ?? args.approvedAt,
      ipAddress: preparerEntry?.ipAddress ?? submitted?.ipAddress ?? null,
      ...fromEntry(preparerEntry),
    });
  }

  const skipped: CertificateSkippedStep[] = [];
  for (const action of actions) {
    const role = CAPACITY_LABEL[action.approvalType];
    if (action.action === ApprovalActionType.SKIP) {
      skipped.push({
        role,
        assignee: fullName(action.chainStep.assignedUser),
        skippedBy: fullName(action.actor),
        at: action.createdAt,
        reason: action.comment,
      });
      continue;
    }
    const entry = signed.find(
      (candidate) =>
        candidate.actorId === action.actorId && candidate.value.stepOrder === action.chainStep.stepOrder
    );
    signers.push({
      name: fullName(action.actor),
      designation: action.actor.designation,
      role,
      signedAt: action.createdAt,
      ipAddress: action.ipAddress,
      onBehalfOf: action.onBehalfOf ? fullName(action.onBehalfOf) : null,
      ...fromEntry(entry),
    });
  }

  signers.push(args.current);

  return {
    title: document.title,
    referenceNumber: document.referenceNumber,
    documentId: document.id,
    versionNumber: version.versionNumber,
    submittedAt: document.submittedAt,
    submittedChecksum: version.storageChecksum,
    approvedAt: args.approvedAt,
    signers,
    skipped,
    timeZone: certificateTimeZone(),
    sealedBy: args.sealedBy ?? null,
  };
}
