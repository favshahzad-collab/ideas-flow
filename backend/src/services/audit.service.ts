import { prisma } from "../prisma";
import { errors } from "../lib/errors";
import { AuditAction, Prisma } from "../generated/prisma/client";
import { buildCsv } from "../utils/csv";
import { viewerFor } from "./viewer.service";
import {
  canUserViewDocument,
  documentHasUserActed,
  prismaDocumentAccessFilter,
} from "../lib/documentAccess";

type CreateAuditLogInput = {
  actorId?: string;
  action: AuditAction;
  entityType: string;
  entityId: string;
  oldValue?: Prisma.InputJsonValue;
  newValue?: Prisma.InputJsonValue;
  ipAddress?: string;
  userAgent?: string;
  tx?: Prisma.TransactionClient;
};

type AuditHistoryEntry = {
  id: string;
  date: Date;
  time: Date;
  user: {
    id: string;
    firstName: string;
    lastName: string;
    designation: string | null;
  };
  /**
   * Whose approval it was, when somebody signed it under a delegation. Null
   * for every ordinary approval - and never merged into `user`, because the
   * two names answer different questions: who put the signature on the page,
   * and whose authority it carried.
   */
  onBehalfOf: {
    id: string;
    firstName: string;
    lastName: string;
    designation: string | null;
  } | null;
  role: string;
  action: string;
  comments: string | null;
};

type DocumentAuditEntry = AuditHistoryEntry & {
  documentId: string;
  /** The memo reference, so an exported row can be read against the paper file. */
  documentReference: string | null;
  documentTitle: string;
  documentStatus: string;
};

type PagedDocumentAuditHistory = {
  auditHistory: DocumentAuditEntry[];
  total: number;
  returned: number;
};

const DOCUMENT_LIFECYCLE_AUDIT_ACTIONS: AuditAction[] = [
  "DOCUMENT_SUBMITTED",
  "DOCUMENT_CREATED",
  "DOCUMENT_DELETED",
  // Written on every serve and every print, and until now read back nowhere:
  // the rows existed and the trail did not show them. A memo that left the
  // building on paper is the one thing the trail most needs to say.
  "DOCUMENT_DOWNLOADED",
  "DOCUMENT_VIEWED",
  "DOCUMENT_PRINTED",
  /*
   * Two things that happen to a memo without anybody approving anything.
   *
   * A memo's history is assembled from two tables - the approval actions, and
   * the audit rows listed here - and both of these write only to the second.
   * So both were recorded and neither was readable: the ledger showed a memo
   * whose chain had changed hands with nothing on the page accounting for it,
   * and a memo that had sat for six weeks with no sign that anybody had ever
   * chased it.
   *
   * Skipping a step is absent from this list and belongs absent: it writes an
   * approval action of its own, and reaches the ledger through the other half.
   */
  "WORKFLOW_STEP_REASSIGNED",
  "APPROVAL_REMINDER_SENT",
  // Withdrawn by its preparer, or cancelled by an administrator - each with
  // the reason, which the trail shows as the row's comment.
  "DOCUMENT_WITHDRAWN",
  "DOCUMENT_CANCELLED",
  // Its preparer left a rejected memo as rejected, closing it.
  "REJECTION_CLOSED",
];

/**
 * The capacity these rows were written in, for the trail's `role` column.
 *
 * Reassigning is an administrator's and only an administrator's - the route
 * carries `requireAdmin` - so that one is known from the action alone. A
 * reminder can come from either the preparer or an administrator, so the
 * capacity is written into the row when it is sent and read back from there
 * rather than guessed here.
 */
const WORKFLOW_ROW_ROLES: Partial<Record<AuditAction, string>> = {
  WORKFLOW_STEP_REASSIGNED: "Administrator",
  DOCUMENT_CANCELLED: "Administrator",
};

/** Rows that record somebody reading the memo rather than acting on it. */
const VIEWER_AUDIT_ACTIONS = new Set<AuditAction>([
  "DOCUMENT_DOWNLOADED",
  "DOCUMENT_VIEWED",
  "DOCUMENT_PRINTED",
]);

/**
 * How much of the whole-organisation ledger one request may carry.
 *
 * The list used to answer with the newest 100 rows and say nothing about the
 * rest, so the screen counted what it was handed and called it the total. On a
 * ledger that is the worst thing a page can do: an action that was recorded
 * reads as one that never happened. The window is now asked for and the count
 * behind it is reported, so a short answer says it is short.
 */
/**
 * Everything the trail records that is not about a memo, grouped the way
 * somebody looking for it would ask.
 *
 * Keyed on `entityType` rather than on the action, so an action added later
 * lands in the right group without anybody remembering to come back here -
 * and one written against a new kind of thing shows up under its own name
 * instead of silently vanishing from the screen.
 */
/** Signing in, kept out of Change history. See `getAdministrationActivity`. */
const SIGN_IN_ACTIONS: AuditAction[] = [
  "SIGN_IN_SUCCEEDED",
  "SIGN_IN_FAILED",
  "SIGN_IN_THROTTLED",
];

const ADMINISTRATION_AREAS: Record<string, string> = {
  User: "People",
  Department: "Departments",
  Delegation: "Delegations",
  WorkflowTemplate: "Workflows",
  WorkflowSetting: "Workflows",
  MailSetting: "Configuration",
  SsoSetting: "Configuration",
  EmailMessage: "Mail",
};

/**
 * Keys whose VALUES are safe and useful to print beside a change.
 *
 * Everything else is reported as a field that changed, by name, without its
 * contents. The settings rows are already shaped to keep secrets out of the
 * trail - "whether, never what" - and this is the second fence: a key nobody
 * has thought about cannot reach a screen just because somebody added it to
 * an audit payload.
 */
const PRINTABLE_CHANGE_KEYS = new Set([
  "name",
  "email",
  "loginRole",
  "isActive",
  "enabled",
  "provider",
  "designation",
  "status",
  "subject",
  "to",
  "allowStepSkip",
  "preparerSignsOnSubmit",
  "sealApprovedMemos",
  "appliedToInProgress",
  "slaDefaultDays",
  "redirectUri",
  "host",
  "port",
  "fromAddress",
  "reason",
]);

/** Values worth naming a subject after, best first. */
const SUBJECT_KEYS = ["name", "email", "to", "subject", "provider"];

/**
 * Keys that describe the ROW rather than the thing it is about.
 *
 * `changed` is a list of field names the writer put there itself. It is used
 * below to decide what to report, and reporting it as well produced the line
 * "changed changed" on the screen - bookkeeping about the record, printed as
 * though it were a property of the person.
 */
const NON_CONTENT_KEYS = new Set(["changed"]);

export type AdministrationChange = {
  field: string;
  /** Null where the value is not one this screen prints. */
  from: string | null;
  to: string | null;
};

export type AdministrationActivityEntry = {
  id: string;
  at: Date;
  actor: { id: string; firstName: string; lastName: string } | null;
  action: AuditAction;
  area: string;
  entityType: string;
  entityId: string;
  /** What it was about, in words, where the row carries enough to say. */
  subject: string | null;
  changes: AdministrationChange[];
  ipAddress: string | null;
};

const ADMINISTRATION_DEFAULT_LIMIT = 50;
const ADMINISTRATION_MAX_LIMIT = 200;

const ALL_DOCUMENTS_DEFAULT_LIMIT = 50;
const ALL_DOCUMENTS_MAX_LIMIT = 200;

/**
 * The two halves of the ledger are separate tables, so reaching row N of the
 * merge means reading N rows of each before they can be interleaved. That makes
 * a deep offset a large read on both, and past this point the export - which is
 * never windowed - is the honest way to reach the rest.
 */
const ALL_DOCUMENTS_MAX_OFFSET = 10000;

/**
 * Everything the visibility rule needs to be decided, and nothing else.
 *
 * The database can only answer the coarse half of the question - is this
 * person on the chain at all - because the other half compares two columns
 * across a relation: their step against how far the run has got. So the rows
 * come back with those two columns attached and the rule is applied here.
 */
const ACCESS_SHAPE = {
  id: true,
  preparerId: true,
  // The administrator rule reads it: a draft stays its author's.
  status: true,
  approvalChain: {
    select: { steps: { select: { assignedUserId: true, stepOrder: true } } },
  },
} as const;

class AuditService {
  private documentAccessFilter(
    userId: string,
    actingFor: readonly string[] = [],
    isAdministrator = false
  ): Prisma.DocumentWhereInput {
    return prismaDocumentAccessFilter(userId, actingFor, isAdministrator);
  }

  /**
   * The history is exactly as visible as the document it describes.
   *
   * It used to be looser: this asked only whether you were somewhere on the
   * chain, while the document, its workflow and its comments also asked
   * whether the run had reached you. An approver at step 3 could not open the
   * memo and could read its entire history - who signed, what they wrote in
   * the comment, when. One rule, applied in both places, or the stricter one
   * is decoration.
   */
  private canRead(
    document: {
      preparerId: string;
      status: string;
      approvalChain: {
        steps: { assignedUserId: string; stepOrder: number }[];
      } | null;
      workflowRuns: { currentStepOrder: number; actions: { id: string }[] }[];
    },
    userId: string,
    actingFor: readonly string[] = [],
    isAdministrator = false
  ): boolean {
    return canUserViewDocument({
      preparerId: document.preparerId,
      status: document.status,
      userId,
      actingFor,
      isAdministrator,
      approvalChain: document.approvalChain,
      workflowRunHistory: document.workflowRuns,
      hasUserActed: documentHasUserActed(document.workflowRuns),
    });
  }

  private mapActionToHistoryEntry(action: {
    id: string;
    createdAt: Date;
    approvalType: string;
    action: string;
    comment: string | null;
    actor: {
      id: string;
      firstName: string;
      lastName: string;
      designation: string | null;
    };
    onBehalfOf?: {
      id: string;
      firstName: string;
      lastName: string;
      designation: string | null;
    } | null;
  }): AuditHistoryEntry {
    return {
      id: action.id,
      date: action.createdAt,
      time: action.createdAt,
      user: action.actor,
      onBehalfOf: action.onBehalfOf ?? null,
      role: action.approvalType,
      action: action.action,
      comments: action.comment,
    };
  }

  private mapDocumentUploadAction(
    action: AuditAction,
    oldValue: Prisma.JsonValue | null,
    /* Unused on purpose: a resubmission is recognised by what the document
       WAS, not what it became. Kept so the signature matches its siblings. */
    _newValue: Prisma.JsonValue | null
  ): string {
    const oldStatus =
      oldValue &&
      typeof oldValue === "object" &&
      !Array.isArray(oldValue) &&
      "status" in oldValue
        ? String((oldValue as { status?: unknown }).status)
        : null;

    if (
      action === "DOCUMENT_SUBMITTED" &&
      (oldStatus === "REVISION_REQUESTED" || oldStatus === "DELETED")
    ) {
      return "DOCUMENT_RESUBMITTED";
    }

    if (
      action === "DOCUMENT_SUBMITTED" ||
      action === "DOCUMENT_CREATED"
    ) {
      return "DOCUMENT_UPLOADED";
    }

    if (action === "DOCUMENT_DELETED") {
      return "DOCUMENT_DELETED";
    }

    return action;
  }

  private buildUploadComment(
    newValue: Prisma.JsonValue | null
  ): string | null {
    const fields = this.objectFields(newValue);

    if (fields && "versionNumber" in fields) {
      return `Version ${String(fields.versionNumber)}`;
    }

    /*
     * Why a step was moved, and which one. The whole point of requiring a
     * reason is that somebody reading the trail later can see it without
     * being told where else to look.
     *
     * The step number matters now that a step still ahead of the memo can be
     * moved as well as the one it is sitting on: a memo can carry two of
     * these, and without the number they read as the same event twice. Only
     * the reassignment rows carry both a reason and a step order, so the two
     * fields together are what identify one.
     */
    if (fields && typeof fields.reason === "string") {
      return typeof fields.stepOrder === "number"
        ? `Step ${fields.stepOrder} — ${fields.reason}`
        : fields.reason;
    }

    return null;
  }

  /** A json column as a plain object, or null when it is anything else. */
  private objectFields(
    value: Prisma.JsonValue | null
  ): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : null;
  }

  /**
   * What the `role` cell says for a row that came from the audit log.
   *
   * Reading rather than viewing is the old distinction; these two add a
   * third, which is acting on the workflow without approving anything.
   */
  private roleForAuditLogRow(
    action: AuditAction,
    newValue: Prisma.JsonValue | null
  ): string {
    if (VIEWER_AUDIT_ACTIONS.has(action)) return "Viewer";

    const known = WORKFLOW_ROW_ROLES[action];
    if (known) return known;

    const actedAs = this.objectFields(newValue)?.actedAs;
    if (typeof actedAs === "string") return actedAs;

    return "Preparer";
  }

  private mapAuditLogToHistoryEntry(log: {
    id: string;
    createdAt: Date;
    action: AuditAction;
    oldValue: Prisma.JsonValue | null;
    newValue: Prisma.JsonValue | null;
    actor: {
      id: string;
      firstName: string;
      lastName: string;
      designation: string | null;
    } | null;
  }): AuditHistoryEntry {
    // `actorId` is nullable and the relation defaults to SetNull, so deleting
    // a user blanks the actor on every row they wrote. This used to throw,
    // which took the whole document's trail down - every action, for everyone
    // - over one row. Dropping the row instead would be worse still: deleting
    // a user would quietly erase what they did from the ledger. So the row
    // stays, and says plainly that the person is no longer known.
    const actor = log.actor ?? {
      id: "",
      firstName: "Unknown",
      lastName: "user",
      designation: null,
    };

    return {
      id: log.id,
      date: log.createdAt,
      time: log.createdAt,
      user: actor,
      // Uploading, downloading and printing are done by the person who did
      // them; nobody does those under somebody else's authority.
      onBehalfOf: null,
      role: this.roleForAuditLogRow(log.action, log.newValue),
      action: this.mapDocumentUploadAction(
        log.action,
        log.oldValue,
        log.newValue
      ),
      comments: this.buildUploadComment(log.newValue),
    };
  }

  private sortHistoryEntries(entries: AuditHistoryEntry[]): AuditHistoryEntry[] {
    return [...entries].sort(
      (a, b) => b.date.getTime() - a.date.getTime()
    );
  }

  private async getAccessibleDocumentIds(userId: string): Promise<string[]> {
    const { actingFor, isAdministrator } = await viewerFor(userId);
    const documents = await prisma.document.findMany({
      // The coarse prefilter narrows the read to documents this person could
      // possibly see; `canRead` then decides which of them they actually can.
      where: this.documentAccessFilter(userId, actingFor, isAdministrator),
      select: {
        ...ACCESS_SHAPE,
        workflowRuns: {
          select: {
            currentStepOrder: true,
            // Only whether THIS person has acted, and only that one row: an
            // approver who has signed keeps sight of the memo afterwards,
            // however far past them it has since moved.
            actions: { where: { actorId: userId }, select: { id: true }, take: 1 },
          },
        },
      },
    });

    return documents
      .filter((document) => this.canRead(document, userId, actingFor))
      .map((document) => document.id);
  }

  private documentUploadLogFilter(
    documentIds: string[]
  ): Prisma.AuditLogWhereInput {
    return {
      entityType: "Document",
      entityId: { in: documentIds },
      action: { in: DOCUMENT_LIFECYCLE_AUDIT_ACTIONS },
    };
  }

  private async fetchDocumentUploadLogs(
    documentIds: string[],
    // Absent means every row, which is what one document's trail and both CSV
    // exports need. A windowed caller passes the depth it has to reach.
    take?: number
  ) {
    if (documentIds.length === 0) {
      return [];
    }

    return prisma.auditLog.findMany({
      where: this.documentUploadLogFilter(documentIds),
      // `createdAt` alone leaves rows written in one transaction tied -
      // it is the transaction's start time, identical to the microsecond -
      // so the reader saw them in whatever order came back, and a page
      // boundary landing on a tie could repeat or drop one. `writeSeq`
      // settles it in the order they were actually written.
      orderBy: [{ createdAt: "desc" }, { writeSeq: "desc" }],
      ...(take !== undefined && { take }),
      include: {
        actor: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            designation: true,
          },
        },
      },
    });
  }

  private async assertDocumentAccess(documentId: string, userId: string) {
    const document = await prisma.document.findUnique({
      where: { id: documentId },
      select: {
        ...ACCESS_SHAPE,
        workflowRuns: {
          select: {
            currentStepOrder: true,
            actions: { where: { actorId: userId }, select: { id: true }, take: 1 },
          },
        },
      },
    });

    // Missing and forbidden are kept apart on purpose: "not found" for a
    // document that exists would tell a caller nothing, and telling them it
    // exists tells them nothing they could not learn from the reference on
    // the memo they were copied on.
    if (!document) {
      throw errors.notFound("Document not found.");
    }

    const viewer = await viewerFor(userId);

    if (
      !this.canRead(document, userId, viewer.actingFor, viewer.isAdministrator)
    ) {
      throw errors.forbidden("Access denied.");
    }
  }

  async createAuditLog(input: CreateAuditLogInput) {
    const client = input.tx ?? prisma;

    return client.auditLog.create({
      data: {
        actorId: input.actorId ?? null,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId,
        oldValue: input.oldValue ?? undefined,
        newValue: input.newValue ?? undefined,
        ipAddress: input.ipAddress ?? null,
        userAgent: input.userAgent ?? null,
      },
    });
  }

  async getDocumentAuditHistory(documentId: string, userId: string) {
    await this.assertDocumentAccess(documentId, userId);

    const [actions, uploadLogs] = await Promise.all([
      prisma.approvalAction.findMany({
        where: {
          workflowRun: {
            documentId,
          },
        },
        orderBy: {
          createdAt: "desc",
        },
        include: {
          actor: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              designation: true,
            },
          },
          onBehalfOf: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              designation: true,
            },
          },
        },
      }),
      this.fetchDocumentUploadLogs([documentId]),
    ]);

    const history = [
      ...actions.map((action) => this.mapActionToHistoryEntry(action)),
      ...uploadLogs.map((log) => this.mapAuditLogToHistoryEntry(log)),
    ];

    return this.sortHistoryEntries(history);
  }

  private formatUserName(user: {
    firstName: string;
    lastName: string;
  }): string {
    return `${user.firstName} ${user.lastName}`.trim();
  }

  /**
   * The name for an exported row: who acted, and whose approval it was where
   * those differ. Printed as one cell rather than two columns so the export
   * keeps the shape people already have filters and pivot tables against.
   */
  private formatActorCell(entry: AuditHistoryEntry): string {
    const actor = this.formatUserName(entry.user);

    return entry.onBehalfOf
      ? `${actor} (for ${this.formatUserName(entry.onBehalfOf)})`
      : actor;
  }

  private formatTimestamp(date: Date): string {
    return date.toISOString();
  }

  async exportAllDocumentsAuditCsv(userId: string): Promise<string> {
    // No window on purpose. The list is paged, so the export is the only thing
    // that still answers "everything you are allowed to see" - and a file that
    // stops at the page size is worse than a short list, because a spreadsheet
    // gives the reader no hint that it was cut.
    const { entries: history } = await this.collectAllDocumentsAuditEntries(
      userId
    );

    const headers = [
      "Document ID",
      "Reference",
      "Document Title",
      "Document Status",
      "Date",
      "User",
      "Role",
      "Action",
      "Comments",
    ];

    const rows = history.map((entry) => [
      entry.documentId,
      entry.documentReference ?? "",
      entry.documentTitle,
      entry.documentStatus,
      this.formatTimestamp(entry.date),
      this.formatActorCell(entry),
      entry.role,
      entry.action,
      entry.comments ?? "",
    ]);

    return buildCsv(headers, rows);
  }

  async exportDocumentAuditCsv(documentId: string, userId: string): Promise<string> {
    const history = await this.getDocumentAuditHistory(documentId, userId);

    // The reference is the same on every row, and that is the point: this
    // file gets printed and put in a folder, and a page of rows with no memo
    // reference on it cannot be matched back to the memo once it is separated
    // from its filename.
    const document = await prisma.document.findUnique({
      where: { id: documentId },
      select: { referenceNumber: true },
    });
    const reference = document?.referenceNumber ?? "";

    const headers = ["Reference", "Date", "User", "Role", "Action", "Comments"];

    const rows = history.map((entry) => [
      reference,
      this.formatTimestamp(entry.date),
      this.formatActorCell(entry),
      entry.role,
      entry.action,
      entry.comments ?? "",
    ]);

    return buildCsv(headers, rows);
  }

  /**
   * One page of the whole-organisation trail, plus how much there is.
   *
   * `total` is counted, not measured off the rows returned: the eyebrow on the
   * ledger screen states it, and stating the size of the window instead is how
   * an organisation with thousands of records came to be told it had 100.
   */
  async getAllDocumentsAuditHistory(
    userId: string,
    options: { limit?: number; offset?: number } = {}
  ): Promise<PagedDocumentAuditHistory> {
    const limit = Math.min(
      Math.max(options.limit ?? ALL_DOCUMENTS_DEFAULT_LIMIT, 1),
      ALL_DOCUMENTS_MAX_LIMIT
    );
    const offset = Math.min(
      Math.max(options.offset ?? 0, 0),
      ALL_DOCUMENTS_MAX_OFFSET
    );

    const { entries, total } = await this.collectAllDocumentsAuditEntries(
      userId,
      offset + limit
    );

    const auditHistory = entries.slice(offset, offset + limit);

    return { auditHistory, total, returned: auditHistory.length };
  }

  /**
   * The merged ledger, and the count behind it.
   *
   * `depth` is how far into the merge the caller has to see. Both sources are
   * read that deep rather than `limit` deep, because either one of them could
   * supply every row of the requested window; anything shallower would drop
   * rows that belong on the page. Undefined reads all of it, for the exports.
   */
  private async collectAllDocumentsAuditEntries(
    userId: string,
    depth?: number
  ): Promise<{ entries: DocumentAuditEntry[]; total: number }> {
    const accessibleDocumentIds = await this.getAccessibleDocumentIds(userId);
    // The same set of documents the upload rows are drawn from, so the two
    // halves of the merged ledger cannot disagree about what is visible.
    const approvalActionFilter: Prisma.ApprovalActionWhereInput = {
      workflowRun: {
        documentId: { in: accessibleDocumentIds },
      },
    };

    const [actions, uploadLogs, documents, actionTotal, uploadLogTotal] =
      await Promise.all([
        prisma.approvalAction.findMany({
          where: approvalActionFilter,
          orderBy: {
            createdAt: "desc",
          },
          ...(depth !== undefined && { take: depth }),
          include: {
            actor: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                designation: true,
              },
            },
            onBehalfOf: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                designation: true,
              },
            },
            workflowRun: {
              include: {
                document: {
                  select: {
                    id: true,
                    title: true,
                    status: true,
                    referenceNumber: true,
                  },
                },
              },
            },
          },
        }),
        this.fetchDocumentUploadLogs(accessibleDocumentIds, depth),
        prisma.document.findMany({
          where: {
            id: { in: accessibleDocumentIds },
          },
          select: {
            id: true,
            title: true,
            status: true,
            referenceNumber: true,
          },
        }),
        prisma.approvalAction.count({ where: approvalActionFilter }),
        prisma.auditLog.count({
          where: this.documentUploadLogFilter(accessibleDocumentIds),
        }),
      ]);

    const documentMap = new Map(
      documents.map((document) => [document.id, document])
    );

    const approvalEntries = actions.map(
      (action): DocumentAuditEntry => ({
        documentId: action.workflowRun.document.id,
        documentTitle: action.workflowRun.document.title,
        documentReference: action.workflowRun.document.referenceNumber,
        documentStatus: action.workflowRun.document.status,
        ...this.mapActionToHistoryEntry(action),
      })
    );

    const uploadEntries = uploadLogs.flatMap((log) => {
      const document = documentMap.get(log.entityId);
      if (!document) {
        return [];
      }

      return [
        {
          documentId: document.id,
          documentTitle: document.title,
          documentReference: document.referenceNumber,
          documentStatus: document.status,
          ...this.mapAuditLogToHistoryEntry(log),
        },
      ];
    });

    // Both counts are of rows this caller can see, and every fetched upload log
    // has its document in the map, so nothing is counted that cannot be paged
    // to - a total the reader cannot reach would be its own kind of lie.
    return {
      entries: this.sortDocumentAuditEntries([
        ...approvalEntries,
        ...uploadEntries,
      ]),
      total: actionTotal + uploadLogTotal,
    };
  }

  /**
   * Everything the trail holds that is not about a memo.
   *
   * Every one of these was already being written - accounts created, roles
   * changed, a second factor reset, mail and sign-on credentials saved, the
   * workflow policy changed, approval routes rewritten - and sealed into the
   * ledger along with everything else. None of it was readable. The document
   * trail filters to `entityType: "Document"`, and the ledger endpoint
   * answers with counts and a digest, so the only way to see any of it was a
   * database console. A record nobody can read is not much better than no
   * record: it cannot answer the question it was written for.
   *
   * Administrators only, and deliberately not scoped to the caller. This is
   * the record of what administrators did, so showing an administrator only
   * their own would defeat the point of keeping it.
   */
  async getAdministrationActivity(options?: {
    limit?: number;
    offset?: number;
    /** One of the areas above. Anything else narrows to nothing, not to all. */
    area?: string;
  }): Promise<{
    entries: AdministrationActivityEntry[];
    total: number;
    returned: number;
    areas: string[];
  }> {
    const limit = Math.min(
      options?.limit ?? ADMINISTRATION_DEFAULT_LIMIT,
      ADMINISTRATION_MAX_LIMIT
    );
    const offset = options?.offset ?? 0;

    const entityTypes = options?.area
      ? Object.keys(ADMINISTRATION_AREAS).filter(
          (type) => ADMINISTRATION_AREAS[type] === options.area
        )
      : null;

    /*
     * "Not a document" rather than a list of administrative actions. A list
     * would have to be added to every time somebody records something new,
     * and the failure mode of forgetting is silence - which is the failure
     * this screen exists to end.
     */
    const where: Prisma.AuditLogWhereInput = {
      ...(entityTypes
        ? { entityType: { in: entityTypes } }
        : { entityType: { not: "Document" } }),
      // Sign-ins are about a User but are not a change anybody made to one.
      // Every person signing in every morning would otherwise bury the handful
      // of rows this screen exists to show. They are in the sealed trail and
      // the export, and named here so a new one is left out on purpose.
      action: { notIn: SIGN_IN_ACTIONS },
    };

    const [rows, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        // `createdAt` ties for rows written in one transaction; `writeSeq`
        // settles them in the order they were actually written, so a page
        // boundary landing on a tie cannot repeat or drop one.
        orderBy: [{ createdAt: "desc" }, { writeSeq: "desc" }],
        skip: offset,
        take: limit,
        select: {
          id: true,
          createdAt: true,
          action: true,
          entityType: true,
          entityId: true,
          oldValue: true,
          newValue: true,
          ipAddress: true,
          actor: {
            select: { id: true, firstName: true, lastName: true },
          },
        },
      }),
      prisma.auditLog.count({ where }),
    ]);

    return {
      entries: rows.map((row) => ({
        id: row.id,
        at: row.createdAt,
        // Null where the account has since been deleted, which blanks the
        // actor rather than removing the row: what was done survives the
        // person who did it.
        actor: row.actor,
        action: row.action,
        area: ADMINISTRATION_AREAS[row.entityType] ?? row.entityType,
        entityType: row.entityType,
        entityId: row.entityId,
        subject: this.subjectOf(row.newValue, row.oldValue),
        changes: this.changesBetween(row.oldValue, row.newValue),
        ipAddress: row.ipAddress,
      })),
      total,
      returned: rows.length,
      areas: [...new Set(Object.values(ADMINISTRATION_AREAS))].sort(),
    };
  }

  /** The best name the row itself carries for the thing it is about. */
  private subjectOf(
    newValue: Prisma.JsonValue | null,
    oldValue: Prisma.JsonValue | null
  ): string | null {
    for (const source of [newValue, oldValue]) {
      const fields = this.objectFields(source);
      if (!fields) continue;

      for (const key of SUBJECT_KEYS) {
        const value = fields[key];
        if (typeof value === "string" && value.trim() !== "") return value;
      }
    }

    return null;
  }

  /**
   * What differed, and what it differed from, where that is printable.
   *
   * A row with only a `newValue` - a creation - reports its fields as arrivals
   * rather than as changes from nothing, which is why `from` is null there and
   * not the string "null".
   */
  private changesBetween(
    oldValue: Prisma.JsonValue | null,
    newValue: Prisma.JsonValue | null
  ): AdministrationChange[] {
    const before = this.objectFields(oldValue) ?? {};
    const after = this.objectFields(newValue) ?? {};

    /*
     * Some rows name the fields the request touched, in a `changed` list the
     * writer put there. Where one exists it beats a diff: it knows the
     * difference between a field the request set and one that merely reads
     * the same on both sides.
     */
    const declared = Array.isArray(after.changed)
      ? after.changed.filter((field): field is string => typeof field === "string")
      : null;

    const keys = declared ?? [
      ...new Set([...Object.keys(before), ...Object.keys(after)]),
    ];

    const changes: AdministrationChange[] = [];

    for (const field of [...keys].sort()) {
      if (NON_CONTENT_KEYS.has(field)) continue;

      const from = before[field];
      const to = after[field];

      // Only where the row did not already say what changed: there, a field
      // reading the same on both sides is still a field that was written.
      if (!declared && JSON.stringify(from) === JSON.stringify(to)) continue;

      changes.push({
        field,
        from: this.printableValue(field, from),
        to: this.printableValue(field, to),
      });
    }

    return changes;
  }

  /** A value fit to print, or null - which the screen reads as "changed". */
  private printableValue(field: string, value: unknown): string | null {
    if (value === undefined || value === null) return null;

    /*
     * Numbers and flags print on sight. The allowlist exists to keep a string
     * nobody has vetted off a screen, because a string is where a credential
     * could hide; a count or a switch cannot be one. Withholding them made
     * useful rows unreadable - a template creation read "edgeCount changed ·
     * nodeCount changed", five words that say nothing.
     */
    if (typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }

    if (typeof value === "string" && PRINTABLE_CHANGE_KEYS.has(field)) {
      return value;
    }

    return null;
  }

  private sortDocumentAuditEntries(
    entries: DocumentAuditEntry[]
  ): DocumentAuditEntry[] {
    return [...entries].sort(
      (a, b) => b.date.getTime() - a.date.getTime()
    );
  }
}

export const auditService = new AuditService();
