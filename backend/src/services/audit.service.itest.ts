import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import app from "../app";
import { issueTokens } from "../lib/tokens";
import { prisma } from "../prisma";
import { parseCsv } from "../utils/csv";
import { allowStepSkipInThisSuite } from "../test/stepSkip";
import {
  chainOf,
  makeCast,
  missingId,
  resubmitDocument,
  signature,
  submitDocument,
  useCleanDatabase,
} from "../test/db";
import {
  exportDocumentAuditSchema,
  getAllDocumentsAuditSchema,
  getAuditHistorySchema,
} from "../schemas/audit.schema";
import { approvalService } from "./approval.service";
import { auditService } from "./audit.service";
import { documentsService } from "./documents.service";

/**
 * The audit trail: what happened to a document, who did it, and when.
 *
 * It is assembled from two tables that do not know about each other -
 * approval actions and lifecycle audit rows - and the merge is where the
 * interesting behaviour lives. A submission has to read as an upload, a
 * submission after a revision request has to read as a resubmission, and the
 * two streams have to come back in one order.
 */

useCleanDatabase();

// The fixture below includes a skipped step, which a deployment has to
// switch on before it is possible at all.
allowStepSkipInThisSuite();

let cast: Awaited<ReturnType<typeof makeCast>>;
let documentId: string;

beforeEach(async () => {
  cast = await makeCast();
  const document = await submitDocument({
    preparerId: cast.preparer.id,
    approvalChain: chainOf(cast.reviewer, cast.approver, cast.finalApprover),
    title: "Warehouse lease extension",
  });
  documentId = document.id;
});

const approveOn = (targetDocumentId: string, actorId: string) => {
  const { useSavedSignature: _saved, ...placement } = signature();
  return approvalService.approve(targetDocumentId, actorId, {
    ...placement,
    useSavedSignature: false,
  });
};

const approveAs = (actorId: string) => approveOn(documentId, actorId);

const history = (userId = cast.preparer.id) =>
  auditService.getDocumentAuditHistory(documentId, userId);

/**
 * Extra lifecycle rows on the same document, backdated a minute apart.
 *
 * Paging a merged ledger is only testable when the order is decided by the
 * data; rows inserted at machine speed share a timestamp and the page boundary
 * then depends on how fast the inserts ran.
 */
const addOlderEntries = (count: number) =>
  prisma.auditLog.createMany({
    data: Array.from({ length: count }, (_, index) => ({
      actorId: cast.preparer.id,
      action: "DOCUMENT_SUBMITTED" as const,
      entityType: "Document",
      entityId: documentId,
      createdAt: new Date(Date.now() - (index + 1) * 60_000),
    })),
  });

describe("one document's trail", () => {
  it("starts with the submission, read as an upload of version 1", async () => {
    const entries = await history();

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      action: "DOCUMENT_UPLOADED",
      role: "Preparer",
      comments: "Version 1",
    });
    expect(entries[0].user.id).toBe(cast.preparer.id);
  });

  it("adds each approval with who did it and in what capacity", async () => {
    await approveAs(cast.reviewer.id);

    const entries = await history();

    expect(entries.map((entry) => entry.action)).toEqual([
      "APPROVE",
      "DOCUMENT_UPLOADED",
    ]);
    expect(entries[0]).toMatchObject({ role: "REVIEWER" });
    expect(entries[0].user.id).toBe(cast.reviewer.id);
  });

  it("keeps the reason attached to the action it explains", async () => {
    await approvalService.reject(documentId, cast.reviewer.id, {
      comment: "The guarantor has not signed.",
    });

    const entries = await history();

    expect(entries[0]).toMatchObject({
      action: "REJECT",
      comments: "The guarantor has not signed.",
    });
  });

  it("comes back newest first, whichever table each entry came from", async () => {
    await approveAs(cast.reviewer.id);
    await approveAs(cast.approver.id);

    const entries = await history();
    const times = entries.map((entry) => entry.date.getTime());

    expect(times).toEqual([...times].sort((a, b) => b - a));
    expect(entries.map((entry) => entry.action)).toEqual([
      "APPROVE",
      "APPROVE",
      "DOCUMENT_UPLOADED",
    ]);
  });

  it("reads a submission after a revision request as a resubmission", async () => {
    // Not an upload: the difference between "they sent it in" and "they sent
    // it back in because we asked" is the whole point of the entry.
    await approvalService.requestRevision(documentId, cast.reviewer.id, {
      comment: "Page 2 is unsigned.",
    });
    await resubmitDocument({ documentId, preparerId: cast.preparer.id });

    const actions = (await history()).map((entry) => entry.action);

    expect(actions).toContain("DOCUMENT_RESUBMITTED");
    expect(actions.filter((action) => action === "DOCUMENT_UPLOADED")).toHaveLength(
      1
    );
  });

  it("records a withdrawal, with its reason", async () => {
    await documentsService.withdrawDocument(documentId, cast.preparer.id, "No longer needed");

    const entry = (await history()).find((row) => row.action === "DOCUMENT_WITHDRAWN");
    expect(entry?.comments).toBe("No longer needed");
  });

  it("records a skip against the preparer who made it", async () => {
    await approvalService.skipWorkflowStep(documentId, cast.preparer.id, {
      reason: "On leave until next month.",
    });

    const entries = await history();

    expect(entries[0]).toMatchObject({
      action: "SKIP",
      comments: "On leave until next month.",
    });
    expect(entries[0].user.id).toBe(cast.preparer.id);
  });

  it("refuses a stranger and reports a missing document as missing", async () => {
    await expect(history(cast.bystander.id)).rejects.toMatchObject({
      statusCode: 403,
    });
    await expect(
      auditService.getDocumentAuditHistory(missingId(), cast.preparer.id)
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  /*
   * The history is exactly as visible as the document it describes.
   *
   * This gate used to ask only whether you were somewhere on the chain, while
   * the document itself also asked whether the run had reached you - so the
   * approver at step 3 was refused the memo and handed its entire history:
   * who signed, what they wrote, when. The two rules are one rule now, and
   * these are the tests that say so.
   */
  it("refuses an approver the run has not reached yet", async () => {
    // Third on the chain; the run is still at the first step.
    await expect(history(cast.finalApprover.id)).rejects.toMatchObject({
      statusCode: 403,
    });

    // And nothing about it leaks through the whole-organisation ledger either.
    const { auditHistory, total } =
      await auditService.getAllDocumentsAuditHistory(cast.finalApprover.id);
    expect(auditHistory).toEqual([]);
    expect(total).toBe(0);
  });

  it("opens the history to them once it does reach them", async () => {
    await approveAs(cast.reviewer.id);
    await approveAs(cast.approver.id);

    const entries = await history(cast.finalApprover.id);

    expect(entries.length).toBeGreaterThan(0);
    const { total } = await auditService.getAllDocumentsAuditHistory(
      cast.finalApprover.id
    );
    expect(total).toBeGreaterThan(0);
  });

  it("keeps it open to an approver the memo has moved past", async () => {
    await approveAs(cast.reviewer.id);

    // The reviewer's own step is behind the run now. What they signed, and
    // what happened after it, is still their record to read.
    expect((await history(cast.reviewer.id)).length).toBeGreaterThan(0);
  });

  describe("a lifecycle row whose actor is gone", () => {
    /*
     * `actorId` is nullable and the relation defaults to SetNull, so deleting
     * a user blanked the actor on every row they wrote. People can no longer
     * be deleted, but a deployment that deleted somebody before that change
     * still holds rows like these, and they must still read.
     */
    beforeEach(async () => {
      await prisma.auditLog.create({
        data: {
          actorId: null,
          action: "DOCUMENT_SUBMITTED",
          entityType: "Document",
          entityId: documentId,
        },
      });
    });

    it("does not take the rest of the trail down with it", async () => {
      // It used to throw, so one row made the audit tab empty for everyone,
      // for every action on that document.
      const entries = await history();

      expect(entries.length).toBeGreaterThan(1);
    });

    it("keeps the row rather than quietly dropping it", async () => {
      // Skipping it would mean deleting a user erases what they did from the
      // ledger - which is the one thing a ledger exists to prevent. The row
      // is an upload like any other; only the person is missing.
      const entries = await history();
      const orphans = entries.filter((entry) => entry.user.id === "");

      expect(orphans).toHaveLength(1);
      expect(orphans[0].action).toBe("DOCUMENT_UPLOADED");
    });

    it("says the person is unknown rather than naming the wrong one", async () => {
      const entries = await history();
      const orphan = entries.find((entry) => entry.user.id === "");

      expect(orphan).toBeDefined();
      expect(`${orphan?.user.firstName} ${orphan?.user.lastName}`).toBe(
        "Unknown user"
      );
    });
  });
});

describe("the trail across every document", () => {
  // This used to answer with a bare array of the newest N rows. It now answers
  // { auditHistory, total, returned } so the ledger screen can say which slice
  // of the trail it is showing instead of counting the slice and calling that
  // the total.
  it("covers only the documents the caller can see", async () => {
    const other = await makeCast();
    await submitDocument({
      preparerId: other.preparer.id,
      approvalChain: chainOf(other.finalApprover),
      title: "Somebody else's document",
    });

    const { auditHistory } = await auditService.getAllDocumentsAuditHistory(
      cast.preparer.id
    );

    expect(auditHistory.map((entry) => entry.documentTitle)).toEqual([
      "Warehouse lease extension",
    ]);
  });

  it("names the document each entry belongs to", async () => {
    await approveAs(cast.reviewer.id);

    const { auditHistory } = await auditService.getAllDocumentsAuditHistory(
      cast.preparer.id
    );

    expect(auditHistory[0]).toMatchObject({
      documentId,
      documentTitle: "Warehouse lease extension",
      documentStatus: "PENDING_REVIEW",
    });
  });

  it("caps the result at the limit it was given", async () => {
    await approveAs(cast.reviewer.id);
    await approveAs(cast.approver.id);

    const page = await auditService.getAllDocumentsAuditHistory(
      cast.preparer.id,
      { limit: 2 }
    );

    expect(page.auditHistory).toHaveLength(2);
    expect(page.returned).toBe(2);
  });

  it("takes the newest when it caps", async () => {
    // The limit is applied to the approval actions before the upload rows are
    // merged in, so this is worth asserting rather than assuming.
    await approveAs(cast.reviewer.id);

    const {
      auditHistory: [newest],
    } = await auditService.getAllDocumentsAuditHistory(cast.preparer.id, {
      limit: 1,
    });

    expect(newest.action).toBe("APPROVE");
  });

  it("counts everything behind the page, not the rows it handed back", async () => {
    // The whole point of the change: a reader who is told "3 entries" when
    // there are 8 concludes the other five actions were never recorded.
    await addOlderEntries(7);

    const page = await auditService.getAllDocumentsAuditHistory(
      cast.preparer.id,
      { limit: 3 }
    );

    expect(page.returned).toBe(3);
    expect(page.total).toBe(8);
  });

  it("counts approval actions and lifecycle rows together", async () => {
    // The two halves are separate tables merged in memory, so a total taken
    // from either one alone would understate the ledger by the other.
    await approveAs(cast.reviewer.id);
    await addOlderEntries(2);

    const { total } = await auditService.getAllDocumentsAuditHistory(
      cast.preparer.id,
      { limit: 1 }
    );

    expect(total).toBe(4);
  });

  it("hands back the next entries when asked for the next page", async () => {
    await approveAs(cast.reviewer.id);
    await addOlderEntries(5);

    const first = await auditService.getAllDocumentsAuditHistory(
      cast.preparer.id,
      { limit: 3, offset: 0 }
    );
    const second = await auditService.getAllDocumentsAuditHistory(
      cast.preparer.id,
      { limit: 3, offset: 3 }
    );
    const whole = await auditService.getAllDocumentsAuditHistory(
      cast.preparer.id,
      { limit: 7 }
    );

    // Two pages laid end to end must be the ledger itself. If the offset were
    // applied to each source before the merge, the seam would repeat rows from
    // one table and skip them from the other - and a skipped audit row is an
    // action nobody can find.
    expect([...first.auditHistory, ...second.auditHistory].map((e) => e.id))
      .toEqual(whole.auditHistory.slice(0, 6).map((e) => e.id));
    expect(second.total).toBe(first.total);
  });

  it("runs out of entries rather than wrapping round at the end", async () => {
    await addOlderEntries(3);

    const past = await auditService.getAllDocumentsAuditHistory(
      cast.preparer.id,
      { limit: 5, offset: 10 }
    );

    expect(past.auditHistory).toEqual([]);
    expect(past.returned).toBe(0);
    // The count still describes the ledger, not the empty page, so the screen
    // can tell "you have paged past the end" from "there is nothing here".
    expect(past.total).toBe(4);
  });

  it("holds a request for a huge page down to the maximum", async () => {
    await addOlderEntries(210);

    const page = await auditService.getAllDocumentsAuditHistory(
      cast.preparer.id,
      { limit: 5000 }
    );

    expect(page.returned).toBe(200);
    expect(page.total).toBe(211);
  });

  it("answers with a page rather than the whole ledger when asked for nothing in particular", async () => {
    await addOlderEntries(60);

    const page = await auditService.getAllDocumentsAuditHistory(
      cast.preparer.id
    );

    expect(page.returned).toBe(50);
    expect(page.total).toBe(61);
  });

  it("keeps another organisation's approvals out of the rows and out of the count", async () => {
    // The document filter scopes the rows AND both counts, and each of the
    // four places has to carry it. A second cast that only submits proves
    // none of them: it has no approval actions to leak. This one approves,
    // so an unscoped `approvalAction.findMany` shows their reviewer's name
    // and their document's title here, and an unscoped `approvalAction.count`
    // tells this caller the ledger is bigger than anything they can open.
    const other = await makeCast();
    const theirs = await submitDocument({
      preparerId: other.preparer.id,
      approvalChain: chainOf(other.reviewer, other.finalApprover),
      title: "Somebody else's document",
    });
    await approveOn(theirs.id, other.reviewer.id);
    await approveAs(cast.reviewer.id);

    const page = await auditService.getAllDocumentsAuditHistory(
      cast.preparer.id
    );

    expect(page.auditHistory.map((entry) => entry.documentId)).toEqual([
      documentId,
      documentId,
    ]);
    expect(page.total).toBe(2);
    expect(page.returned).toBe(2);

    // And the window is not a way round the filter: a page that starts after
    // this caller's own entries is empty, not the next person's.
    const past = await auditService.getAllDocumentsAuditHistory(
      cast.preparer.id,
      { limit: 50, offset: 2 }
    );

    expect(past.auditHistory).toEqual([]);
    expect(past.total).toBe(2);
  });

  it("serves a row when asked for a page of none", async () => {
    // A limit of 0 slices nothing out of a ledger that has rows, and an empty
    // page on this screen reads as "nothing was recorded". The floor is what
    // keeps a bad number from saying that.
    await addOlderEntries(2);

    const page = await auditService.getAllDocumentsAuditHistory(
      cast.preparer.id,
      { limit: 0 }
    );

    expect(page.returned).toBe(1);
    expect(page.total).toBe(3);
  });

  it("reads a negative offset as the start, not as a walk back from the end", async () => {
    // `slice(-5)` counts from the end of the array, so an unclamped negative
    // offset answers a request for the newest entries with the oldest ones -
    // and reading `take: -3` backwards out of both tables first.
    await addOlderEntries(5);

    const first = await auditService.getAllDocumentsAuditHistory(
      cast.preparer.id,
      { limit: 2, offset: 0 }
    );
    const backwards = await auditService.getAllDocumentsAuditHistory(
      cast.preparer.id,
      { limit: 2, offset: -5 }
    );

    expect(backwards.auditHistory.map((entry) => entry.id)).toEqual(
      first.auditHistory.map((entry) => entry.id)
    );
    expect(backwards.total).toBe(6);
  });

  it("is empty for somebody with no documents", async () => {
    expect(
      await auditService.getAllDocumentsAuditHistory(cast.bystander.id)
    ).toEqual({ auditHistory: [], total: 0, returned: 0 });
  });
});

describe("the csv exports", () => {
  it("gives one document's trail a header and a row per entry", async () => {
    await approveAs(cast.reviewer.id);

    const rows = parseCsv(
      await auditService.exportDocumentAuditCsv(documentId, cast.preparer.id)
    );

    expect(Object.keys(rows[0])).toEqual([
      // Every row self-identifies: this file gets printed and put in a
      // folder, and separated from its filename it would otherwise name no
      // memo at all.
      "Reference",
      "Date",
      "User",
      "Role",
      "Action",
      "Comments",
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0].Action).toBe("APPROVE");
    expect(rows[0].User).toBe(
      `${cast.reviewer.firstName} ${cast.reviewer.lastName}`
    );
  });

  it("survives a comment with a comma and a quote in it", async () => {
    // Which is what an actual rejection reason looks like, and the reason the
    // export is built with buildCsv rather than join(",").
    await approvalService.reject(documentId, cast.reviewer.id, {
      comment: 'The term is wrong, and the "guarantor" has not signed.',
    });

    const rows = parseCsv(
      await auditService.exportDocumentAuditCsv(documentId, cast.preparer.id)
    );

    expect(rows[0].Comments).toBe(
      'The term is wrong, and the "guarantor" has not signed.'
    );
  });

  it("writes timestamps a spreadsheet can sort", async () => {
    const rows = parseCsv(
      await auditService.exportDocumentAuditCsv(documentId, cast.preparer.id)
    );

    expect(rows[0].Date).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("carries the document columns in the whole-organisation export", async () => {
    const rows = parseCsv(
      await auditService.exportAllDocumentsAuditCsv(cast.preparer.id)
    );

    expect(Object.keys(rows[0])).toEqual([
      "Document ID",
      "Reference",
      "Document Title",
      "Document Status",
      "Date",
      "User",
      "Role",
      "Action",
      "Comments",
    ]);
    expect(rows[0]["Document Title"]).toBe("Warehouse lease extension");
  });

  it("refuses to export a document the caller cannot read", async () => {
    // An export is the easiest guard to leave off, and the easiest one to
    // walk out of the building with.
    await expect(
      auditService.exportDocumentAuditCsv(documentId, cast.bystander.id)
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("carries the whole ledger, not the page the list would have shown", async () => {
    // The list is windowed; the export is the only thing left that answers
    // "everything you may see". A spreadsheet that stops at the page size shows
    // the reader no seam, so they file it as the complete record.
    await addOlderEntries(60);

    const rows = parseCsv(
      await auditService.exportAllDocumentsAuditCsv(cast.preparer.id)
    );
    const page = await auditService.getAllDocumentsAuditHistory(
      cast.preparer.id
    );

    expect(rows).toHaveLength(page.total);
    expect(rows.length).toBeGreaterThan(page.returned);
  });

  it("is not capped by the maximum page either", async () => {
    // A cap of 200 on an export is the same lie as a cap of 100, told later.
    await addOlderEntries(210);

    expect(
      parseCsv(await auditService.exportAllDocumentsAuditCsv(cast.preparer.id))
    ).toHaveLength(211);
  });

  it("carries every entry of one document's trail", async () => {
    await addOlderEntries(60);

    expect(
      parseCsv(
        await auditService.exportDocumentAuditCsv(documentId, cast.preparer.id)
      )
    ).toHaveLength(61);
  });

  it("exports nothing for somebody with no documents", async () => {
    const csv = await auditService.exportAllDocumentsAuditCsv(
      cast.bystander.id
    );

    expect(parseCsv(csv)).toEqual([]);
  });
});

describe("what the audit routes accept", () => {
  const params = (id: string) => ({ params: { id }, query: {}, body: {} });
  const listQuery = (query: Record<string, string>) =>
    getAllDocumentsAuditSchema.safeParse({ query, params: {}, body: {} });

  it("refuses a document id that is not a uuid", () => {
    // Unchecked, the id reaches a uuid column and Prisma's rejection is not an
    // AppError, so a link that lost a character answers 500 "Internal server
    // error" - the reader is told the system broke rather than that the
    // document is not there.
    expect(getAuditHistorySchema.safeParse(params("not-a-uuid")).success).toBe(
      false
    );
    expect(
      exportDocumentAuditSchema.safeParse(params("not-a-uuid")).success
    ).toBe(false);
    expect(getAuditHistorySchema.safeParse(params(missingId())).success).toBe(
      true
    );
  });

  it("reads the window off the query string", () => {
    const parsed = listQuery({ limit: "25", offset: "50" });

    expect(parsed.data?.query).toEqual({ limit: 25, offset: 50 });
  });

  it("still accepts a request that asks for no window", () => {
    // The frontend sends only a limit today, and the ledger has to keep
    // loading for it while paging is wired up on the screen.
    expect(listQuery({}).data?.query).toEqual({});
    expect(listQuery({ limit: "100" }).data?.query).toEqual({ limit: 100 });
  });

  it("refuses an offset too deep to serve", () => {
    // Reaching row N of the merge means reading N rows of both tables, so an
    // unbounded offset is a way to ask the database for everything at once.
    expect(listQuery({ offset: "10001" }).success).toBe(false);
  });

  it("says what to do about a broken link rather than 'Invalid uuid'", () => {
    // The refusal is read by whoever followed the stale link, so it has to
    // say what to do next. Zod's default says what a uuid is.
    const refusal = getAuditHistorySchema.safeParse(params("not-a-uuid"));

    expect(refusal.error?.issues.map((issue) => issue.message)).toEqual([
      "That document link is not valid. Open it again from the ledger.",
    ]);
  });

  it("refuses a page larger than the ledger will serve", () => {
    // The service clamps to the same ceiling, but a clamp is invisible: the
    // caller who asked for 5000 and got 200 has no way to tell that from a
    // ledger with 200 entries in it. Refusing says which it was.
    expect(listQuery({ limit: "201" }).success).toBe(false);
    expect(listQuery({ limit: "200" }).success).toBe(true);
  });

  it("refuses a window that asks for nothing, or for rows before the first", () => {
    expect(listQuery({ limit: "0" }).success).toBe(false);
    expect(listQuery({ offset: "-1" }).success).toBe(false);
  });
});

/**
 * The endpoints, over real HTTP.
 *
 * Everything above calls the service directly, which cannot see the route: a
 * handler that parses `limit` and `offset` and then calls the service with
 * neither serves page one forever, and a handler that answers with only the
 * rows leaves the screen counting them again. Both pass every service test
 * ever written.
 */
describe("the audit endpoints over http", () => {
  type LedgerPage = {
    auditHistory: { id: string; documentId: string }[];
    total: number;
    returned: number;
  };

  let server: Server;
  let base: string;
  let token: string;

  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        resolve();
      });
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  beforeEach(async () => {
    token = (await issueTokens(cast.preparer.id)).accessToken;
  });

  const get = async (path: string) => {
    const response = await fetch(`${base}${path}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const text = await response.text();
    let json: unknown = null;

    try {
      json = JSON.parse(text) as unknown;
    } catch {
      // A CSV export, or an empty body. The status is still the point.
    }

    return { status: response.status, json, text, headers: response.headers };
  };

  const ledger = async (query = "") =>
    ((await get(`/api/audit/documents${query}`)).json) as LedgerPage;

  it("answers with the rows, the count behind them, and how many it sent", async () => {
    await addOlderEntries(3);

    const { status, json } = await get("/api/audit/documents");
    const page = json as LedgerPage;

    expect(status).toBe(200);
    expect(page.auditHistory).toHaveLength(4);
    expect(page.total).toBe(4);
    expect(page.returned).toBe(4);
  });

  it("serves the window the query string asked for", async () => {
    await addOlderEntries(5);

    const first = await ledger("?limit=2&offset=0");
    const second = await ledger("?limit=2&offset=2");

    expect(first.returned).toBe(2);
    expect(second.returned).toBe(2);
    expect(second.auditHistory.map((entry) => entry.id)).not.toEqual(
      first.auditHistory.map((entry) => entry.id)
    );
    expect(first.total).toBe(6);
    expect(second.total).toBe(6);
  });

  it("answers a page past the end with an empty page, not an error", async () => {
    const { status, json } = await get("/api/audit/documents?limit=5&offset=100");
    const page = json as LedgerPage;

    expect(status).toBe(200);
    expect(page.auditHistory).toEqual([]);
    expect(page.returned).toBe(0);
    expect(page.total).toBe(1);
  });

  it("refuses an offset deeper than it will serve, and says what to do instead", async () => {
    const { status, json } = await get("/api/audit/documents?offset=10001");

    expect(status).toBe(400);
    expect(json).toMatchObject({
      error: {
        message:
          "That is too far back to page to. Export the ledger to read the rest.",
      },
    });
  });

  it("refuses a broken document link with a sentence rather than a 500", async () => {
    // Unvalidated, the id reaches a uuid column and Prisma's rejection is not
    // an AppError - so the reader of a truncated link is told the server
    // broke. Both routes carry their own params check for this reason.
    for (const path of [
      "/api/documents/not-a-uuid/audit",
      "/api/documents/not-a-uuid/audit/export",
    ]) {
      const { status, json } = await get(path);

      expect(status, path).toBe(400);
      expect(json, path).toMatchObject({
        error: {
          message:
            "That document link is not valid. Open it again from the ledger.",
        },
      });
    }
  });

  it("sends the export as a whole csv file, page size or no page size", async () => {
    await addOlderEntries(60);

    const { status, text, headers } = await get("/api/audit/documents/export");

    expect(status).toBe(200);
    expect(headers.get("content-type")).toContain("text/csv");
    expect(parseCsv(text)).toHaveLength(61);
  });
});
