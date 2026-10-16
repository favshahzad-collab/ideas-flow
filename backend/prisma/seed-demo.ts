/**
 * Review fixtures: a database you can actually look at.
 *
 * `seed.ts` creates departments and one administrator, which is the right
 * thing to run against a real deployment and leaves every screen in the app
 * empty. The queue, the ledger, the inbox and the document tables cannot be
 * reviewed — or accessibility-audited — with nothing in them, and the fixtures
 * that made the redesign reviewable lived in ad-hoc SQL on one machine. This
 * is that data, reproducible.
 *
 *   npm run seed        # departments + admin  (safe anywhere)
 *   npm run seed:demo   # + people, documents, workflows, ledger, inbox
 *
 * Two properties matter:
 *
 * IDEMPOTENT. Every id is derived from a name, so a second run replaces the
 * same rows instead of stacking a second set. Anything created through the app
 * has a random id and is left alone.
 *
 * DEV ONLY. It refuses to run when NODE_ENV is production. These are invented
 * documents with invented approvals; the one thing worse than an empty audit
 * ledger is a populated one nobody can vouch for.
 *
 * Dates are relative to now, so ages stay meaningful however long after
 * writing this it runs: the overdue document is always overdue.
 */
import "dotenv/config";
import { createHash } from "node:crypto";
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { sha256 } from "../src/lib/checksum";
import { hashPassword } from "../src/lib/password";
import {
  CAPACITY_LABEL,
  formatSignoffDate,
  type SignoffCapacity,
} from "../src/lib/pdfSignature";
import { storageService } from "../src/lib/storage";
import { formatMemoReference } from "../src/schemas/documents.schema";

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

/** A stable UUID for a given name, so re-running targets the same rows. */
function uid(name: string): string {
  const h = createHash("sha1").update(`daws-demo:${name}`).digest("hex");
  return [
    h.slice(0, 8),
    h.slice(8, 12),
    `5${h.slice(13, 16)}`,
    `8${h.slice(17, 20)}`,
    h.slice(20, 32),
  ].join("-");
}

const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(Date.now() - days * DAY);
/** The other direction, for a delegation that has not ended yet. */
const ahead = (days: number) => new Date(Date.now() + days * DAY);

// ---------------------------------------------------------------- people

type PersonKey = "admin" | "maria" | "priya" | "tom" | "omar";

const PEOPLE: Record<
  Exclude<PersonKey, "admin">,
  { first: string; last: string; email: string; department: string; designation: string }
> = {
  maria: { first: "Maria", last: "Chen", email: "maria.chen@example.com", department: "Finance", designation: "Manager" },
  priya: { first: "Priya", last: "Nair", email: "priya.nair@example.com", department: "Procurement", designation: "Assistant Manager" },
  tom: { first: "Tom", last: "Becker", email: "tom.becker@example.com", department: "Information Technology", designation: "Head of Department" },
  omar: { first: "Omar", last: "Haddad", email: "omar.haddad@example.com", department: "Internal Audit", designation: "Chief Internal Auditor" },
};

// ------------------------------------------------------------- documents

type Step = { type: "REVIEWER" | "APPROVER" | "FINAL_APPROVER"; who: PersonKey };

interface Fixture {
  key: string;
  title: string;
  description: string;
  preparer: PersonKey;
  /** Where the run has got to: how many chain steps have already acted. */
  done: number;
  /** Days since the document last moved - what the Age column reads. */
  age: number;
  outcome: "in-flight" | "approved" | "rejected" | "revision" | "draft" | "deleted";
  chain: Step[];
  /** Why it was rejected or sent back. Shown under the chain. */
  closingComment?: string;
  comments?: { who: PersonKey; text: string; daysAgo: number }[];
}

/**
 * Fifteen documents chosen to cover every status, several positions within a
 * chain, and the full range of the age scale - fresh, ageing, overdue and the
 * one that has been sitting long enough to be embarrassing. The admin account
 * is a holder on four of them, so "My queue" is not empty on first login.
 */
const FIXTURES: Fixture[] = [
  {
    key: "capex-conveyor",
    title: "Capex request - Plant 3 conveyor upgrade",
    description: "Replacement of the ageing belt line feeding the packing hall.",
    preparer: "maria",
    done: 0,
    age: 1,
    outcome: "in-flight",
    chain: [
      { type: "REVIEWER", who: "admin" },
      { type: "APPROVER", who: "priya" },
      { type: "APPROVER", who: "tom" },
      { type: "FINAL_APPROVER", who: "maria" },
    ],
    comments: [
      { who: "priya", text: "Quotes from all three vendors are attached to the request.", daysAgo: 1 },
    ],
  },
  {
    key: "vendor-sialkot",
    title: "Vendor onboarding - Sialkot Textiles",
    description: "New supplier for the winter fabric run.",
    preparer: "priya",
    done: 0,
    age: 5,
    outcome: "in-flight",
    chain: [
      { type: "REVIEWER", who: "admin" },
      { type: "FINAL_APPROVER", who: "omar" },
    ],
  },
  {
    key: "warehouse-lahore",
    title: "Warehouse lease extension - Lahore",
    description: "Three-year extension on the Ferozepur Road facility.",
    preparer: "maria",
    done: 2,
    age: 28,
    outcome: "in-flight",
    chain: [
      { type: "REVIEWER", who: "omar" },
      { type: "APPROVER", who: "admin" },
      { type: "APPROVER", who: "tom" },
      { type: "FINAL_APPROVER", who: "maria" },
    ],
  },
  {
    key: "it-hardware",
    title: "IT hardware refresh - finance floor",
    description: "Forty workstations at end of support.",
    preparer: "omar",
    done: 1,
    age: 9,
    outcome: "in-flight",
    chain: [
      { type: "REVIEWER", who: "tom" },
      { type: "APPROVER", who: "admin" },
      { type: "FINAL_APPROVER", who: "maria" },
    ],
  },
  {
    key: "q3-framework",
    title: "Q3 procurement framework agreement",
    description: "Standing terms for the packaging category.",
    preparer: "omar",
    done: 1,
    age: 3,
    outcome: "in-flight",
    chain: [
      { type: "REVIEWER", who: "priya" },
      { type: "APPROVER", who: "tom" },
      { type: "FINAL_APPROVER", who: "maria" },
    ],
  },
  {
    key: "maintenance-renewal",
    title: "Annual maintenance contract renewal",
    description: "HVAC and generator cover for the head office.",
    preparer: "tom",
    done: 0,
    age: 46,
    outcome: "in-flight",
    chain: [
      { type: "REVIEWER", who: "admin" },
      { type: "FINAL_APPROVER", who: "omar" },
    ],
  },
  {
    key: "brand-campaign",
    title: "Brand campaign media buy - autumn",
    description: "Outdoor and digital placement for the autumn collection.",
    preparer: "maria",
    done: 1,
    age: 12,
    outcome: "in-flight",
    chain: [
      { type: "REVIEWER", who: "priya" },
      { type: "APPROVER", who: "omar" },
      { type: "FINAL_APPROVER", who: "tom" },
    ],
  },
  {
    key: "staff-uniform",
    title: "Retail staff uniform refresh",
    description: "Replacement uniform for 240 front-of-house staff.",
    preparer: "priya",
    done: 3,
    age: 2,
    outcome: "approved",
    chain: [
      { type: "REVIEWER", who: "tom" },
      { type: "APPROVER", who: "omar" },
      { type: "FINAL_APPROVER", who: "maria" },
    ],
  },
  {
    key: "cold-storage",
    title: "Cold storage electricity tariff switch",
    description: "Move to the industrial time-of-use tariff.",
    preparer: "tom",
    done: 2,
    age: 16,
    outcome: "approved",
    chain: [
      { type: "REVIEWER", who: "priya" },
      { type: "FINAL_APPROVER", who: "omar" },
    ],
  },
  {
    key: "fleet-lease",
    title: "Fleet lease - six delivery vans",
    description: "Four-year operating lease for the Karachi depot.",
    preparer: "omar",
    done: 3,
    age: 34,
    outcome: "approved",
    chain: [
      { type: "REVIEWER", who: "admin" },
      { type: "APPROVER", who: "tom" },
      { type: "FINAL_APPROVER", who: "maria" },
    ],
  },
  {
    key: "capex-plant2",
    title: "Capex request - Plant 2 boiler replacement",
    description: "Unplanned replacement following the failed pressure test.",
    preparer: "maria",
    done: 2,
    age: 10,
    outcome: "rejected",
    closingComment: "Scope does not match the approved capex plan for this quarter.",
    chain: [
      { type: "REVIEWER", who: "omar" },
      { type: "APPROVER", who: "tom" },
      { type: "APPROVER", who: "priya" },
      { type: "FINAL_APPROVER", who: "maria" },
    ],
  },
  {
    key: "consultancy-retainer",
    title: "Consultancy retainer - supply chain review",
    description: "Six-month engagement to map the inbound network.",
    preparer: "tom",
    done: 1,
    age: 21,
    outcome: "rejected",
    closingComment: "Duplicates work already commissioned under the logistics review.",
    // The administrator reviews this one so that a REJECTED memo is visible to
    // the account the accessibility walk signs in as. That screen carries the
    // banner quoting why it was refused, and the list is scoped to documents
    // the signed-in user prepared or has actually been asked to act on - so
    // without a step here, the rejected banner is a screen the gate can never
    // reach. The revision fixture below is readable for the same reason.
    chain: [
      { type: "REVIEWER", who: "admin" },
      { type: "FINAL_APPROVER", who: "omar" },
    ],
  },
  {
    key: "export-licence",
    title: "Export licence renewal - EU shipments",
    description: "Annual renewal covering the Hamburg and Rotterdam lanes.",
    preparer: "priya",
    done: 1,
    age: 6,
    outcome: "revision",
    closingComment: "Please attach the updated customs classification before this goes further.",
    chain: [
      { type: "REVIEWER", who: "admin" },
      { type: "APPROVER", who: "maria" },
      { type: "FINAL_APPROVER", who: "omar" },
    ],
  },
  {
    key: "safety-remediation",
    title: "Safety audit remediation plan",
    description: "Actions closing the findings from the March inspection.",
    preparer: "tom",
    done: 1,
    age: 13,
    outcome: "revision",
    closingComment: "Timeline for the two high-risk findings needs to be specific, not 'Q4'.",
    chain: [
      { type: "REVIEWER", who: "omar" },
      { type: "APPROVER", who: "priya" },
      { type: "FINAL_APPROVER", who: "maria" },
    ],
  },
  {
    key: "office-relocation",
    title: "Office relocation feasibility study",
    description: "Draft - not yet submitted for approval.",
    preparer: "maria",
    done: 0,
    age: 4,
    outcome: "draft",
    chain: [],
  },
];

// ------------------------------------------------------------- templates

const TEMPLATES = [
  {
    key: "standard-procurement",
    name: "Standard procurement approval",
    description: "Two reviews then a final sign-off. Used for routine purchase requests.",
    graph: {
      nodes: [
        { id: "start", type: "start", position: { x: 0, y: 120 }, data: { label: "Submitted" } },
        { id: "a1", type: "approval", position: { x: 220, y: 120 }, data: { label: "Category review", approvalType: "REVIEWER" } },
        { id: "a2", type: "approval", position: { x: 440, y: 120 }, data: { label: "Budget check", approvalType: "APPROVER" } },
        { id: "a3", type: "approval", position: { x: 660, y: 120 }, data: { label: "Final sign-off", approvalType: "FINAL_APPROVER" } },
        { id: "end", type: "end", position: { x: 880, y: 120 }, data: { label: "Approved" } },
      ],
      edges: [
        { id: "e1", source: "start", target: "a1" },
        { id: "e2", source: "a1", target: "a2" },
        { id: "e3", source: "a2", target: "a3" },
        { id: "e4", source: "a3", target: "end" },
      ],
    },
  },
  {
    key: "capex-routing",
    name: "Capex routing",
    description: "Branches on the document title; high-value requests take the longer path.",
    graph: {
      nodes: [
        { id: "start", type: "start", position: { x: 0, y: 160 }, data: { label: "Submitted" } },
        { id: "d1", type: "decision", position: { x: 220, y: 160 }, data: { label: "Capex?", condition: { field: "title", operator: "contains", value: "Capex" } } },
        { id: "a1", type: "approval", position: { x: 460, y: 40 }, data: { label: "Technical review", approvalType: "REVIEWER" } },
        { id: "a2", type: "approval", position: { x: 680, y: 40 }, data: { label: "Finance approval", approvalType: "APPROVER" } },
        { id: "a3", type: "approval", position: { x: 460, y: 280 }, data: { label: "Line manager", approvalType: "APPROVER" } },
        { id: "a4", type: "approval", position: { x: 900, y: 160 }, data: { label: "Final sign-off", approvalType: "FINAL_APPROVER" } },
        { id: "end", type: "end", position: { x: 1120, y: 160 }, data: { label: "Approved" } },
      ],
      edges: [
        { id: "e1", source: "start", target: "d1" },
        { id: "e2", source: "d1", target: "a1", data: { branch: "yes" }, label: "Yes" },
        { id: "e3", source: "d1", target: "a3", data: { branch: "no" }, label: "No" },
        { id: "e4", source: "a1", target: "a2" },
        { id: "e5", source: "a2", target: "a4" },
        { id: "e6", source: "a3", target: "a4" },
        { id: "e7", source: "a4", target: "end" },
      ],
    },
  },
];

// ------------------------------------------------------------------ PDFs

/**
 * The sign-off blocks an approved memo carries, drawn onto the last page.
 *
 * The real thing is `embedSignatureInPdf`, which puts the approver's own mark
 * on the page and this text under it. Nobody drew a mark for a fixture, so
 * these are the text blocks alone - the names, the offices, the capacity and
 * the date, which is the part that is read. Every page already says it is a
 * seeded fixture, so nothing here can be mistaken for a real approval.
 */
async function withSignOffBlocks(
  base: Buffer,
  signers: { name: string; designation: string; department: string; capacity: SignoffCapacity; when: Date }[],
): Promise<Buffer> {
  const pdf = await PDFDocument.load(base);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const page = pdf.getPages()[pdf.getPageCount() - 1];

  // Stacked upward from just above the footer, so the block never lands on it
  // however many people signed.
  const STEP = 44;
  let y = 86 + STEP * (signers.length - 1);

  for (const signer of signers) {
    page.drawLine({
      start: { x: 56, y: y + 24 }, end: { x: 250, y: y + 24 },
      thickness: 0.75, color: rgb(0.45, 0.48, 0.55),
    });
    page.drawText(signer.name, { x: 56, y: y + 12, size: 9, font: bold });
    const office = [signer.designation, signer.department].filter(Boolean).join(", ");
    if (office) {
      page.drawText(office, {
        x: 56, y: y + 2, size: 7.5, font, color: rgb(0.35, 0.39, 0.45),
      });
    }
    page.drawText(
      `${CAPACITY_LABEL[signer.capacity]} · ${formatSignoffDate(signer.when)}`,
      { x: 56, y: y - 8, size: 7.5, font, color: rgb(0.35, 0.39, 0.45) },
    );
    y -= STEP;
  }

  return Buffer.from(await pdf.save());
}

/**
 * A real PDF per document, because the detail screen renders one and a
 * zero-byte placeholder makes the viewer look broken rather than empty.
 */
async function makePdf(title: string, preparer: string, pages = 2): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  for (let i = 0; i < pages; i++) {
    const page = pdf.addPage([595, 842]); // A4
    page.drawText("IDEAS PVT LTD", {
      x: 56, y: 780, size: 9, font: bold, color: rgb(0.4, 0.44, 0.5),
    });
    page.drawText(title.slice(0, 60), { x: 56, y: 748, size: 16, font: bold });
    page.drawText(`Prepared by ${preparer}`, {
      x: 56, y: 726, size: 10, font, color: rgb(0.35, 0.39, 0.45),
    });
    page.drawLine({
      start: { x: 56, y: 712 }, end: { x: 539, y: 712 },
      thickness: 0.75, color: rgb(0.85, 0.87, 0.9),
    });
    for (let line = 0; line < 22; line++) {
      page.drawLine({
        start: { x: 56, y: 670 - line * 22 }, end: { x: 539 - (line % 4) * 40, y: 670 - line * 22 },
        thickness: 7, color: rgb(0.93, 0.94, 0.95),
      });
    }
    page.drawText(`Page ${i + 1} of ${pages}  ·  Seeded fixture for local review`, {
      x: 56, y: 56, size: 8, font, color: rgb(0.6, 0.63, 0.68),
    });
    if (i === pages - 1) {
      page.drawText("Signature", {
        x: 380, y: 190, size: 9, font, color: rgb(0.6, 0.63, 0.68),
      });
      page.drawLine({
        start: { x: 380, y: 180 }, end: { x: 539, y: 180 },
        thickness: 0.75, color: rgb(0.7, 0.73, 0.78),
      });
    }
  }
  return Buffer.from(await pdf.save());
}

// ------------------------------------------------------------------ main

async function main() {
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "Refusing to write demo fixtures to a production database. These are " +
        "invented documents with invented approvals."
    );
  }

  console.log("Seeding review fixtures...");

  /* -------- people ------------------------------------------------- */
  const passwordHash = await hashPassword(process.env.SEED_DEMO_PASSWORD || "password");
  const userIds: Record<PersonKey, string> = {} as Record<PersonKey, string>;

  const admin = await prisma.user.findUnique({
    where: { email: (process.env.SEED_ADMIN_EMAIL || "admin@example.com").toLowerCase() },
  });
  if (!admin) {
    throw new Error("Run `npm run seed` first - the administrator account is missing.");
  }
  userIds.admin = admin.id;

  for (const [key, person] of Object.entries(PEOPLE)) {
    const department =
      (await prisma.department.findFirst({ where: { name: person.department } })) ??
      (await prisma.department.findFirst());
    if (!department) throw new Error("No departments - run `npm run seed` first.");

    const user = await prisma.user.upsert({
      where: { email: person.email },
      update: {
        firstName: person.first,
        lastName: person.last,
        // Upserted as well as created: the fixtures predate designations, so
        // a database seeded before them would otherwise keep signing memos
        // with a name and no office.
        designation: person.designation,
        passwordHash,
      },
      create: {
        id: uid(`user:${key}`),
        firstName: person.first,
        lastName: person.last,
        designation: person.designation,
        email: person.email,
        passwordHash,
        departmentId: department.id,
        loginRole: "USER",
      },
    });
    userIds[key as PersonKey] = user.id;
  }
  console.log(`  people: ${Object.keys(userIds).length}`);

  /* -------- templates ---------------------------------------------- */
  for (const template of TEMPLATES) {
    const id = uid(`template:${template.key}`);
    await prisma.workflowTemplate.upsert({
      where: { id },
      update: { name: template.name, description: template.description, graph: template.graph },
      create: {
        id,
        name: template.name,
        description: template.description,
        graph: template.graph,
        isActive: true,
        createdById: userIds.admin,
      },
    });
  }
  console.log(`  workflow templates: ${TEMPLATES.length}`);

  /* -------- clear the previous fixture set -------------------------- */
  /* Every id below is deterministic, so this removes exactly what a previous
     run created and leaves anything made through the app alone. Order is the
     reverse of creation, because the foreign keys are real. */
  const documentIds = FIXTURES.map(f => uid(`document:${f.key}`));
  await prisma.$transaction([
    prisma.notification.deleteMany({ where: { documentId: { in: documentIds } } }),
    /* The audit table refuses DELETE (migration 20260929180000). This seed
       never runs against production, and removing the previous fixtures'
       rows is the one thing it needs to do there; the trigger goes back on at
       the end of this transaction, and a failure rolls the switch back with
       everything else. The ledger will report these rows as missing, as it
       did before the trigger existed - re-seeding is not a clean ledger. */
    prisma.$executeRawUnsafe("ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_append_only"),
    prisma.auditLog.deleteMany({ where: { entityId: { in: documentIds } } }),
    prisma.$executeRawUnsafe("ALTER TABLE audit_logs ENABLE TRIGGER audit_logs_append_only"),
    prisma.documentComment.deleteMany({ where: { documentId: { in: documentIds } } }),
    prisma.document.updateMany({
      where: { id: { in: documentIds } },
      data: { currentWorkflowRunId: null, revisionRequestedByActionId: null },
    }),
    prisma.approvalAction.deleteMany({ where: { workflowRun: { documentId: { in: documentIds } } } }),
    prisma.workflowRun.deleteMany({ where: { documentId: { in: documentIds } } }),
    prisma.approvalChainStep.deleteMany({ where: { chain: { documentId: { in: documentIds } } } }),
    prisma.approvalChain.deleteMany({ where: { documentId: { in: documentIds } } }),
    prisma.documentVersion.deleteMany({ where: { documentId: { in: documentIds } } }),
    prisma.document.deleteMany({ where: { id: { in: documentIds } } }),
  ]);

  /* -------- documents ---------------------------------------------- */
  const name = (key: PersonKey) =>
    key === "admin" ? "Admin User" : `${PEOPLE[key].first} ${PEOPLE[key].last}`;

  let notifications = 0;
  let auditRows = 0;

  /*
   * A reference for every fixture that was actually submitted, in the same
   * format the service mints - imported, not spelled a second time.
   *
   * Numbering continues after whatever the year already holds, so a demo memo
   * never takes a reference the app has issued, and the fixture rows were
   * deleted above, so re-running the seed hands out the same numbers again.
   */
  const nextInYear = new Map<number, number>();
  const nextReference = async (when: Date): Promise<string> => {
    const year = when.getFullYear();

    if (!nextInYear.has(year)) {
      const [row] = await prisma.$queryRaw<{ next: number }[]>`
        SELECT COALESCE(MAX(substring(reference_number FROM '[0-9]+$')::int), 0) + 1 AS next
        FROM documents
        WHERE reference_number LIKE ${`MEMO-${year}-%`}
      `;
      nextInYear.set(year, Number(row?.next ?? 1));
    }

    const sequence = nextInYear.get(year)!;
    nextInYear.set(year, sequence + 1);
    return formatMemoReference(year, sequence);
  };

  /** The sign-off one person's approval puts on the page, read off their row. */
  const signOffFor = async (
    key: PersonKey,
    capacity: SignoffCapacity,
    when: Date,
  ) => {
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: userIds[key] },
      include: { department: true },
    });

    return {
      name: `${user.firstName} ${user.lastName}`.trim(),
      designation: user.designation ?? "",
      department: user.department?.name ?? "",
      capacity,
      when,
    };
  };

  for (const fixture of FIXTURES) {
    const documentId = uid(`document:${fixture.key}`);
    const submitted = ago(fixture.age + fixture.chain.length * 2 + 1);
    const moved = ago(fixture.age);
    const status =
      fixture.outcome === "approved" ? "APPROVED"
      : fixture.outcome === "rejected" ? "REJECTED"
      : fixture.outcome === "revision" ? "REVISION_REQUESTED"
      : fixture.outcome === "draft" ? "DRAFT"
      : fixture.outcome === "deleted" ? "DELETED"
      : "PENDING_REVIEW";

    await prisma.document.create({
      data: {
        id: documentId,
        // Drafts have none, exactly as in the app: the reference is minted at
        // submission, so a draft that never goes out never holds a number.
        referenceNumber:
          fixture.outcome === "draft" ? null : await nextReference(submitted),
        title: fixture.title,
        description: fixture.description,
        status,
        preparerId: userIds[fixture.preparer],
        currentVersionNumber: 1,
        submittedAt: fixture.outcome === "draft" ? null : submitted,
        approvedAt: fixture.outcome === "approved" ? moved : null,
        rejectedAt: fixture.outcome === "rejected" ? moved : null,
        createdAt: submitted,
        updatedAt: moved,
        templateId: fixture.title.includes("Capex") ? uid("template:capex-routing") : null,
      },
    });

    /* The file the detail screen renders. The storage service owns the bucket
       layout - writing under `storage/` directly puts the file where nothing
       can find it. `overwriteDocument` rather than `uploadDocument`, for two
       reasons: uploadDocument takes a Multer file and reads `.buffer` off it
       (hand it a Buffer and it silently writes the underlying ArrayBuffer),
       and this seed has to be safe to run twice. */
    const storagePath = `documents/${documentId}/v1.pdf`;
    const submittedPdf = await makePdf(fixture.title, name(fixture.preparer));
    await storageService.overwriteDocument(storagePath, submittedPdf);

    const versionId = uid(`version:${fixture.key}`);
    await prisma.documentVersion.create({
      data: {
        id: versionId,
        documentId,
        versionNumber: 1,
        storagePath,
        // The file is checked against this every time it is served, so a
        // fixture without one would be the only document in the system that
        // cannot be verified.
        storageChecksum: sha256(submittedPdf),
        uploadedById: userIds[fixture.preparer],
        uploadedAt: submitted,
      },
    });

    await prisma.auditLog.create({
      data: {
        id: uid(`audit:${fixture.key}:created`),
        actorId: userIds[fixture.preparer],
        action: "DOCUMENT_CREATED",
        entityType: "Document",
        entityId: documentId,
        createdAt: submitted,
      },
    });
    auditRows++;

    if (fixture.chain.length === 0) continue; // a draft has no chain yet

    /* -------- the chain ------------------------------------------- */
    const chainId = uid(`chain:${fixture.key}`);
    await prisma.approvalChain.create({
      data: { id: chainId, documentId, createdById: userIds[fixture.preparer], createdAt: submitted },
    });

    const stepIds: string[] = [];
    for (const [index, step] of fixture.chain.entries()) {
      const stepId = uid(`step:${fixture.key}:${index}`);
      stepIds.push(stepId);
      await prisma.approvalChainStep.create({
        data: {
          id: stepId,
          chainId,
          stepOrder: index + 1,
          approvalType: step.type,
          assignedUserId: userIds[step.who],
        },
      });
    }

    await prisma.auditLog.create({
      data: {
        id: uid(`audit:${fixture.key}:submitted`),
        actorId: userIds[fixture.preparer],
        action: "DOCUMENT_SUBMITTED",
        entityType: "Document",
        entityId: documentId,
        createdAt: submitted,
      },
    });
    auditRows++;

    /* -------- the run --------------------------------------------- */
    const runId = uid(`run:${fixture.key}`);
    const runStatus =
      fixture.outcome === "approved" ? "APPROVED"
      : fixture.outcome === "rejected" ? "REJECTED"
      : fixture.outcome === "revision" ? "SUPERSEDED"
      : "IN_PROGRESS";

    await prisma.workflowRun.create({
      data: {
        id: runId,
        documentId,
        documentVersionId: versionId,
        chainId,
        status: runStatus,
        currentStepOrder: Math.min(fixture.done + 1, fixture.chain.length),
        startedAt: submitted,
        endedAt: runStatus === "IN_PROGRESS" ? null : moved,
      },
    });
    await prisma.document.update({
      where: { id: documentId },
      data: { currentWorkflowRunId: runId },
    });

    /* -------- what has already happened on it --------------------- */
    /* Without these the chain renders every early step as "pending" even
       where the run has plainly moved past it. */
    const gap = (fixture.age + fixture.chain.length * 2 + 1 - fixture.age) / (fixture.done + 1 || 1);

    /*
     * Which step the closing action belongs to, and therefore where this loop
     * has to stop.
     *
     * Every approved fixture has `done` equal to the length of its chain, so
     * this loop used to write an approval for the last step and the closing
     * block then wrote a second one on the same step - a duplicate approval,
     * in the demo data, of exactly the kind the product refuses. The screens
     * showed it: two signatures against one approver in the chain and two
     * rows in the audit trail.
     */
    const closingIndex =
      fixture.outcome === "in-flight" || fixture.outcome === "draft"
        ? null
        : Math.min(fixture.done, fixture.chain.length - 1);
    const actedBeforeClosing = closingIndex ?? fixture.done;

    for (let i = 0; i < actedBeforeClosing; i++) {
      await prisma.approvalAction.create({
        data: {
          id: uid(`action:${fixture.key}:${i}`),
          workflowRunId: runId,
          chainStepId: stepIds[i],
          documentVersionId: versionId,
          actorId: userIds[fixture.chain[i].who],
          approvalType: fixture.chain[i].type,
          action: "APPROVE",
          comment: i === 0 ? "Checked against the budget line. Cleared." : null,
          createdAt: ago(fixture.age + gap * (fixture.done - i)),
        },
      });
    }

    /* The action that closed it, which is a different verb and carries the
       comment the screen shows under the chain. */
    if (closingIndex !== null) {
      const index = closingIndex;
      const closing =
        fixture.outcome === "approved" ? "APPROVE"
        : fixture.outcome === "rejected" ? "REJECT"
        : "REQUEST_REVISION";

      const action = await prisma.approvalAction.create({
        data: {
          id: uid(`action:${fixture.key}:closing`),
          workflowRunId: runId,
          chainStepId: stepIds[index],
          documentVersionId: versionId,
          actorId: userIds[fixture.chain[index].who],
          approvalType: fixture.chain[index].type,
          action: closing,
          comment: fixture.closingComment ?? null,
          createdAt: moved,
        },
      });

      if (fixture.outcome === "revision") {
        await prisma.document.update({
          where: { id: documentId },
          data: { revisionRequestedByActionId: action.id },
        });
      }

      /*
       * The approved copy: the file HR prints, fixed against the document the
       * way the last approver's signature fixes it in the app.
       *
       * Without it an approved fixture is the "approved before the approved
       * copy was recorded" case, and Print - the last step of the whole
       * workflow - is refused on every document in the demo.
       */
      if (fixture.outcome === "approved") {
        const signers = await Promise.all([
          ...fixture.chain.slice(0, index).map((step, i) =>
            signOffFor(step.who, step.type, ago(fixture.age + gap * (fixture.done - i))),
          ),
          signOffFor(fixture.chain[index].who, fixture.chain[index].type, moved),
        ]);

        const approvedCopy = await withSignOffBlocks(submittedPdf, signers);
        const approvedPath = `documents/${documentId}/v1/step-${index + 1}-${stepIds[index]}.pdf`;
        await storageService.overwriteDocument(approvedPath, approvedCopy);
        const approvedChecksum = sha256(approvedCopy);

        await prisma.approvalAction.update({
          where: { id: action.id },
          data: {
            signedPdfStoragePath: approvedPath,
            signedPdfChecksum: approvedChecksum,
          },
        });

        await prisma.document.update({
          where: { id: documentId },
          data: {
            finalSignedStoragePath: approvedPath,
            finalSignedChecksum: approvedChecksum,
          },
        });
      }

      await prisma.auditLog.create({
        data: {
          id: uid(`audit:${fixture.key}:closed`),
          actorId: userIds[fixture.chain[index].who],
          action:
            fixture.outcome === "approved" ? "WORKFLOW_COMPLETED"
            : fixture.outcome === "rejected" ? "WORKFLOW_REJECTED"
            : "WORKFLOW_REVISION_REQUESTED",
          entityType: "Document",
          entityId: documentId,
          createdAt: moved,
        },
      });
      auditRows++;
    }

    /* -------- the inbox ------------------------------------------- */
    /* One notification per document, addressed to whoever the state actually
       concerns, dated so the three inbox groups all have something in them. */
    const holder = fixture.chain[Math.min(fixture.done, fixture.chain.length - 1)];
    const [recipient, type, title, message] =
      fixture.outcome === "in-flight"
        ? [holder.who, "APPROVAL_NEEDED", "Waiting for your approval", `${fixture.title} is at your step.`]
      : fixture.outcome === "approved"
        ? [fixture.preparer, "APPROVED", "Approved", `${fixture.title} completed its approval chain.`]
      : fixture.outcome === "rejected"
        ? [fixture.preparer, "REJECTED", "Rejected", fixture.closingComment ?? "The workflow ended here."]
      : fixture.outcome === "revision"
        ? [fixture.preparer, "REVISION_REQUESTED", "Revision requested", fixture.closingComment ?? "A new version is needed."]
        : [null, null, null, null];

    if (recipient) {
      await prisma.notification.create({
        data: {
          id: uid(`notification:${fixture.key}`),
          recipientId: userIds[recipient],
          type: type as "APPROVAL_NEEDED",
          title: title,
          message: message,
          documentId,
          workflowRunId: runId,
          isRead: fixture.age > 14,
          readAt: fixture.age > 14 ? moved : null,
          createdAt: moved,
        },
      });
      notifications++;
    }

    /* -------- conversation ---------------------------------------- */
    for (const [index, comment] of (fixture.comments ?? []).entries()) {
      await prisma.documentComment.create({
        data: {
          id: uid(`comment:${fixture.key}:${index}`),
          documentId,
          authorId: userIds[comment.who],
          comment: comment.text,
          createdAt: ago(comment.daysAgo),
        },
      });
    }
  }

  /* -------- one person away, covered by a colleague ----------------- */
  /* So the availability column, the queue bar and the delegation panel all
     have something real to show. Deterministic id, like everything else here,
     so a second run replaces it rather than stacking a second arrangement on
     the same person - which the API would refuse anyway. */
  const delegationId = uid("delegation:tom");
  await prisma.delegation.deleteMany({ where: { id: delegationId } });
  await prisma.delegation.create({
    data: {
      id: delegationId,
      delegatorId: userIds.tom,
      delegateId: userIds.omar,
      startsAt: ago(2),
      endsAt: ahead(9),
      reason: "Site visit to the Sialkot plant.",
      createdById: userIds.admin,
      createdAt: ago(2),
    },
  });

  console.log(`  documents: ${FIXTURES.length} (with a PDF and a chain each)`);
  console.log(`  notifications: ${notifications}`);
  console.log(`  audit entries: ${auditRows}`);
  console.log("  delegations: 1 (Tom Becker, covered by Omar Haddad)");
  console.log("Review fixtures ready.");
}

main()
  .catch(err => {
    console.error("Demo seed failed:");
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
