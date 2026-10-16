import { randomUUID } from "node:crypto";
import { PDFDocument } from "pdf-lib";
import { afterAll, beforeEach } from "vitest";
import { ApprovalType, LoginRole } from "../generated/prisma/client";
import { AppError } from "../lib/errors";
import { prisma } from "../prisma";
import { documentsService } from "../services/documents.service";
import { useStoredWorkflowPolicy } from "../lib/workflowPolicy";
import { useOfficeCalendar } from "../lib/officeCalendar";
import { solidPngDataUrl } from "./png";

/**
 * Fixtures for the integration suite.
 *
 * Documents are created by calling the real `documentsService.createDocument`
 * rather than by inserting rows. Hand-built fixtures drift: they end up
 * describing a shape the service stopped producing, and then the tests pass
 * against a state the application can no longer reach. Going in through the
 * front door costs a PDF render per document and keeps that from happening.
 *
 * `vitest.config.integration.mts` is what guarantees this is pointed at a
 * throwaway database. Read it before changing anything here.
 */

// ---------------------------------------------------------------- lifecycle

type ResetStatements = { fast: string; fallback: string };

let statements: ResetStatements | null = null;
let fastPathWorks = true;

async function buildResetStatements(): Promise<ResetStatements> {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
  `;

  if (tables.length === 0) {
    throw new Error(
      "The test database has no tables. Run `npx prisma migrate deploy` " +
        "against TEST_DATABASE_URL, or check that it points where you think."
    );
  }

  const quoted = tables.map((row) => `"public"."${row.tablename}"`);

  /*
   * TRUNCATE takes an ACCESS EXCLUSIVE lock on every table and rewrites each
   * file, which measures at ~400ms here - per test, of which there are three
   * hundred. DELETE on empty-to-tiny tables is ~25ms.
   *
   * DELETE has to respect foreign keys, and this schema cannot be ordered to
   * satisfy them: `documents.current_workflow_run_id` points at workflow_runs
   * and `workflow_runs.document_id` points back, so there is no order that
   * works. `session_replication_role = replica` turns the FK triggers off for
   * the session, which is what it is for.
   *
   * All of it goes in ONE statement string on purpose: the adapter holds a
   * pool, so a `SET` sent separately would land on a different connection
   * than the deletes. One string is one simple query on one connection, in
   * one implicit transaction - and if any part of it fails, the `SET` is
   * rolled back with it rather than leaking replica mode into later tests.
   */
  const fast = [
    "SET session_replication_role = 'replica'",
    ...quoted.map((table) => `DELETE FROM ${table}`),
    "SET session_replication_role = 'origin'",
  ].join("; ");

  const fallback = `TRUNCATE TABLE ${quoted.join(", ")} RESTART IDENTITY CASCADE`;

  return { fast, fallback };
}

/** Empty every table. Between tests, not after: a failure leaves its rows behind to look at. */
export async function resetDatabase(): Promise<void> {
  statements ??= await buildResetStatements();

  if (fastPathWorks) {
    try {
      await prisma.$executeRawUnsafe(statements.fast);
      return;
    } catch (error) {
      // Most likely the role may not set session_replication_role. Say so
      // once, then take the slow road for the rest of the run - a suite that
      // silently got fifteen times slower is worse than one that says why.
      //
      // Straight to stderr rather than console.warn: vitest captures console
      // output from hooks and this one never appeared, which made the whole
      // point of announcing it moot.
      fastPathWorks = false;
      process.stderr.write(`
  Fast database reset unavailable, falling back to TRUNCATE.
  The suite will be several times slower.
  Reason: ${error instanceof Error ? error.message : String(error)}

`);
    }
  }

  await prisma.$executeRawUnsafe(statements.fallback);
}

/** Call once at the top of an integration file. */
export function useCleanDatabase(): void {
  beforeEach(async () => {
    await resetDatabase();

    /*
     * The workflow policy lives in a module variable, not the database, so
     * truncating the table does not take it away. Left behind, a test that
     * switched a deadline on would silently set one for every test after it
     * in the file - and those tests would pass, because a deadline makes more
     * things happen rather than fewer.
     */
    useStoredWorkflowPolicy(null);
    // The office calendar too, for the same reason.
    useOfficeCalendar({ timeZone: null, holidays: [] });
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });
}

// ----------------------------------------------------------------- fixtures

let sequence = 0;
const unique = () => `${Date.now().toString(36)}-${++sequence}`;

export async function makeDepartment(name = "Finance") {
  return prisma.department.create({
    data: { name: `${name} ${unique()}` },
  });
}

export async function makeUser(
  overrides: {
    firstName?: string;
    lastName?: string;
    departmentId?: string;
    loginRole?: LoginRole;
    /**
     * For an ADMINISTRATOR: a Super Administrator unless this says otherwise,
     * which is what every suite written before the two tiers expects.
     */
    superAdmin?: boolean;
    /** The powers of a limited administrator. */
    adminPowers?: string[];
  } = {}
) {
  const departmentId =
    overrides.departmentId ?? (await makeDepartment()).id;
  const loginRole = overrides.loginRole ?? LoginRole.USER;

  return prisma.user.create({
    data: {
      firstName: overrides.firstName ?? "Test",
      lastName: overrides.lastName ?? "User",
      email: `user-${unique()}@example.com`,
      departmentId,
      loginRole,
      isSuperAdmin: loginRole === LoginRole.ADMINISTRATOR && (overrides.superAdmin ?? true),
      adminPowers: overrides.adminPowers ?? [],
    },
  });
}

/** A preparer and three approvers, all in one department. */
export async function makeCast() {
  const department = await makeDepartment();
  const inDept = (firstName: string) =>
    makeUser({ firstName, departmentId: department.id });

  const [preparer, reviewer, approver, finalApprover, bystander] =
    await Promise.all([
      inDept("Preparer"),
      inDept("Reviewer"),
      inDept("Approver"),
      inDept("Final"),
      inDept("Bystander"),
    ]);

  return { department, preparer, reviewer, approver, finalApprover, bystander };
}

/**
 * A signature as a data url, the way the sign-here canvas sends one.
 *
 * 3:1, which is the shape of the default box in `signature()` below and about
 * the shape of a name written by hand. It was a 1x1 PNG, and a 1x1 is the one
 * image that fits any box exactly however it is fitted - so no test here could
 * tell a signature drawn at its own proportions from one stretched to fill the
 * box it was dropped in.
 */
export const SIGNATURE_IMAGE = solidPngDataUrl(360, 120);

export const signature = (overrides: Record<string, unknown> = {}) => ({
  // What a real request carries: the signer ticked "this is my signature".
  consent: true as const,
  useSavedSignature: false,
  signatureImage: SIGNATURE_IMAGE,
  signaturePage: 1,
  signatureX: 100,
  signatureY: 200,
  signatureWidth: 120,
  signatureHeight: 40,
  ...overrides,
});

export async function makePdf(pages = 1): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i += 1) {
    doc.addPage([595, 842]);
  }
  return Buffer.from(await doc.save());
}

export async function makeUpload(
  pages = 1,
  originalname = "document.pdf"
): Promise<Express.Multer.File> {
  const buffer = await makePdf(pages);
  return {
    fieldname: "file",
    originalname,
    encoding: "7bit",
    mimetype: "application/pdf",
    size: buffer.length,
    buffer,
    stream: undefined,
    destination: "",
    filename: originalname,
    path: "",
  } as unknown as Express.Multer.File;
}

type ChainStep = { userId: string; approvalType: ApprovalType };

/** The step list for the usual reviewer -> approver -> final chain. */
export const chainOf = (
  ...users: { id: string }[]
): ChainStep[] =>
  users.map((user, index) => ({
    userId: user.id,
    approvalType:
      index === users.length - 1
        ? ApprovalType.FINAL_APPROVER
        : index === 0
          ? ApprovalType.REVIEWER
          : ApprovalType.APPROVER,
  }));

/**
 * Submit a document through the real service.
 *
 * `createDocument` answers `{ message, document }`; this unwraps it, because a
 * fixture that returns the envelope makes every test using it read as though
 * the envelope were the subject.
 */
export async function submitDocument(options: {
  preparerId: string;
  approvalChain?: ChainStep[];
  templateId?: string;
  title?: string;
  description?: string;
  pages?: number;
}) {
  const { document } = await documentsService.createDocument(
    {
      title: options.title ?? `Document ${unique()}`,
      description: options.description,
      ...(options.templateId
        ? { templateId: options.templateId }
        : { approvalChain: options.approvalChain }),
      signature: signature(),
    },
    await makeUpload(options.pages ?? 1),
    options.preparerId
  );

  return document;
}

/** Resubmit a document after a revision request, through the real service. */
export async function resubmitDocument(options: {
  documentId: string;
  preparerId: string;
  approvalChain?: ChainStep[];
  title?: string;
}) {
  return documentsService.updateDocument(
    options.documentId,
    {
      ...(options.title ? { title: options.title } : {}),
      ...(options.approvalChain ? { approvalChain: options.approvalChain } : {}),
      signature: signature(),
    },
    await makeUpload(),
    options.preparerId
  );
}

/** The run row plus the step the workflow is sitting on. */
export async function currentPosition(documentId: string) {
  const document = await prisma.document.findUniqueOrThrow({
    where: { id: documentId },
    include: {
      currentWorkflowRun: {
        include: { chain: { include: { steps: { orderBy: { stepOrder: "asc" } } } } },
      },
    },
  });

  const run = document.currentWorkflowRun;

  return {
    status: document.status,
    runStatus: run?.status ?? null,
    stepOrder: run?.currentStepOrder ?? null,
    assignedTo:
      run?.chain.steps.find((step) => step.stepOrder === run.currentStepOrder)
        ?.assignedUserId ?? null,
  };
}

/**
 * The error a call rejected with, typed.
 *
 * `promise.catch((e) => e as AppError)` widens to a union with the success
 * type - which vitest transpiles straight past and `tsc` refuses. Use this
 * when two rejections have to be compared with each other; `rejects.toMatchObject`
 * is better when only one is in play.
 */
export async function rejection(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    return error as AppError;
  }
  throw new Error("expected the call to reject, and it resolved");
}

/** Somewhere to hang a value that has to be a uuid but must not exist. */
export const missingId = () => randomUUID();

/**
 * Switch the database's append-only guard on the audit ledger off for the
 * length of `fn`, and back on however `fn` ends.
 *
 * For the tests that tamper with the ledger on purpose, to prove the hash
 * chain catches it - which is the owner's power the guard cannot take away,
 * and exactly the case the chain exists for - or to wind a row's clock back
 * to stand in for time passing, which nothing else can do. Never to set up
 * ordinary state: if a test needs an audit row to look different, write it
 * that way.
 */
export async function tamperWithLedger<T>(fn: () => Promise<T>): Promise<T> {
  await prisma.$executeRawUnsafe(
    "ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_append_only"
  );
  await prisma.$executeRawUnsafe(
    "ALTER TABLE ledger_checkpoints DISABLE TRIGGER ledger_checkpoints_append_only"
  );
  try {
    return await fn();
  } finally {
    await prisma.$executeRawUnsafe(
      "ALTER TABLE audit_logs ENABLE TRIGGER audit_logs_append_only"
    );
    await prisma.$executeRawUnsafe(
      "ALTER TABLE ledger_checkpoints ENABLE TRIGGER ledger_checkpoints_append_only"
    );
  }
}
