/**
 * What this API does at ten thousand memos.
 *
 * Not a load generator - it calls the services directly, in process, one at a
 * time. Concurrency hides the thing worth finding: a query that is linear in
 * the size of the whole corpus rather than in the size of the page. Run it
 * against a database seeded to whatever size you want to ask about.
 *
 *   DATABASE_URL=...daws_load npx tsx scripts/bench.ts
 *
 * Numbers from one machine are not a benchmark of anything absolute. What
 * they are good for is comparisons: this query against that one, and this
 * query before a change against the same one after.
 */

import { prisma } from "../src/prisma";
import { documentsService } from "../src/services/documents.service";
import { auditService } from "../src/services/audit.service";
import { adminService } from "../src/services/admin.service";
import { ledgerService } from "../src/services/ledger.service";
import { slaService } from "../src/services/sla.service";

const RUNS = 3;

async function time(name: string, run: () => Promise<unknown>) {
  // One untimed pass: the first call pays for the connection and the query
  // plan, and reporting that as the cost of the query is unfair to it.
  await run();

  const taken: number[] = [];
  for (let i = 0; i < RUNS; i += 1) {
    const started = performance.now();
    await run();
    taken.push(performance.now() - started);
  }

  const best = Math.min(...taken);
  const worst = Math.max(...taken);
  const flag = best > 1000 ? "  <-- SLOW" : best > 300 ? "  <-- watch" : "";

  console.log(
    `${name.padEnd(46)} ${best.toFixed(0).padStart(6)}ms  (worst ${worst.toFixed(0)}ms)${flag}`
  );
}

async function main() {
  const [documents, inFlight, audit] = await Promise.all([
    prisma.document.count(),
    prisma.document.count({ where: { status: "PENDING_REVIEW" } }),
    prisma.auditLog.count(),
  ]);

  const admin = await prisma.user.findFirstOrThrow({
    where: { loginRole: "ADMINISTRATOR" },
  });
  const approver = await prisma.user.findFirstOrThrow({
    where: { loginRole: "USER" },
  });

  console.log(
    `\n${documents} documents · ${inFlight} in flight · ${audit} audit records\n`
  );

  await time("documents, first page (administrator)", () =>
    documentsService.getDocuments(admin.id, { limit: 25 })
  );

  await time("documents, first page (an approver)", () =>
    documentsService.getDocuments(approver.id, { limit: 25 })
  );

  await time("documents, page 40", () =>
    documentsService.getDocuments(admin.id, { limit: 25, offset: 1000 })
  );

  await time("documents, searching", () =>
    documentsService.getDocuments(admin.id, { limit: 25, q: "Memorandum 7421" })
  );

  await time("pending approvals count", () =>
    documentsService.getPendingApprovalCount(approver.id)
  );

  await time("oversight board", () => documentsService.getApprovalOversight());

  await time("audit trail, first page", () =>
    auditService.getAllDocumentsAuditHistory(admin.id, { limit: 50 })
  );

  await time("people, first page", () => adminService.listUsers({ limit: 50 }));

  await time("ledger: seal a pass", () => ledgerService.seal());
  await time("ledger: verify the whole chain", () => ledgerService.verify());
  await time("ledger: summary", () => ledgerService.summary());

  await time("deadlines: count what is overdue", () => slaService.overdueCount());
  await time("deadlines: a sweep", () => slaService.chaseOverdue());

  console.log("");
  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
