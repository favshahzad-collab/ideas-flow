/**
 * Day one: from an empty install to a signed memo, over HTTP.
 *
 * The requirement this repo is written against says the process must run
 * "without manual intervention outside the application". Every rehearsal we
 * had started from the demo seed - people, departments, routes and documents
 * already in place - which is the one state a new customer never has. So the
 * things a first morning actually depends on were covered nowhere: that the
 * import template the app hands out is the shape the import accepts, that a
 * person can sign in with the password a spreadsheet gave them and then change
 * it, that a route can be built when none exists, and that a memo submitted
 * against it reaches an approver and comes out signed.
 *
 * It talks HTTP to a running API on purpose. The integration suite calls the
 * services directly, which is the right level for workflow rules and the wrong
 * one for this: half of what a first morning trips over lives in the routes -
 * validation, permissions, multipart parsing, response envelopes - and none of
 * that is exercised by calling a service.
 *
 *   npm run build && npm start &
 *   npx tsx scripts/fresh-install-check.ts
 *
 * It writes to the database it is pointed at, so it refuses to run against one
 * that has anything in it. See `assertNothingHereYet`.
 */

import fs from "node:fs";
import path from "node:path";
import { PDFDocument } from "pdf-lib";

const API = process.env.FRESH_CHECK_API ?? "http://localhost:3000";

/*
 * Defaults match `prisma/seed.ts` with no SEED_ADMIN_* set, which is what CI
 * seeds. A deployment that set its own has to say so here too.
 */
const ADMIN_EMAIL = process.env.FRESH_CHECK_EMAIL ?? "admin@example.com";
const ADMIN_PASSWORD = process.env.FRESH_CHECK_PASSWORD ?? "password";

/** Set it to also assert the uploaded file reached the disk. */
const STORAGE_DIR = process.env.FRESH_CHECK_STORAGE;

/**
 * Fixture people.
 *
 * `example.com` is reserved for exactly this by RFC 2606, which matters more
 * than it looks: these rows become accounts with mail addresses, and a run
 * against a deployment with a live relay would send to whatever is written
 * here. Nothing in this file may name a real domain.
 */
const HEADERS = [
  "firstName",
  "lastName",
  "email",
  "password",
  "department",
  "role",
  "designation",
] as const;

const PREPARER = "fresh-check-preparer@example.com";
const REVIEWER = "fresh-check-reviewer@example.com";
const APPROVER = "fresh-check-approver@example.com";

const PEOPLE: readonly (readonly string[])[] = [
  ["Fresh", "Preparer", PREPARER, "import-password-1", "Human Resources", "USER", "HR Officer"],
  ["Fresh", "Reviewer", REVIEWER, "import-password-2", "Human Resources", "USER", "Manager HR"],
  ["Fresh", "Approver", APPROVER, "import-password-3", "Finance", "USER", "Head of Finance"],
  ["Fresh", "Deputy", "fresh-check-deputy@example.com", "import-password-4", "Information Technology", "ADMINISTRATOR", "IT Manager"],
];

const CHOSEN_PASSWORD = "chosen-by-them-alone";

/** A 1x1 transparent PNG, which is what the sign-here canvas sends. */
const SIGNATURE_IMAGE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const signature = () => ({
  // The signer ticks "this is my signature": a signature without it is refused.
  consent: true,
  useSavedSignature: false,
  signatureImage: SIGNATURE_IMAGE,
  signaturePage: 1,
  signatureX: 100,
  signatureY: 200,
  signatureWidth: 120,
  signatureHeight: 40,
});

let failures = 0;

function check(label: string, passed: boolean, detail = ""): void {
  console.log(`  ${passed ? "PASS" : "FAIL"}  ${label}${detail ? ` -- ${detail}` : ""}`);
  if (!passed) failures += 1;
}

function step(number: number, title: string): void {
  console.log(`\n[${number}] ${title}`);
}

type Reply = { status: number; body: unknown };

async function call(
  method: string,
  url: string,
  options: { token?: string; json?: unknown; form?: FormData; stepUp?: string } = {}
): Promise<Reply> {
  const headers: Record<string, string> = {};
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  const stepUp = options.stepUp ?? (options.token ? confirmations.get(options.token) : undefined);
  if (stepUp) headers["X-Step-Up"] = stepUp;

  let body: string | FormData | undefined;
  if (options.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(options.json);
  } else if (options.form) {
    body = options.form;
  }

  const response = await fetch(API + url, { method, headers, body });
  const text = await response.text();

  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      // A non-JSON body is itself worth reporting, so keep it rather than
      // throwing: "HTTP 502 <html>..." names the problem, a parse error does
      // not.
      parsed = text;
    }
  }

  return { status: response.status, body: parsed };
}

/*
 * The responses are read as plain records. Typing every envelope in the API
 * twice - once in the service and once here - is how a check drifts from the
 * thing it checks; reading them loosely means a renamed field fails this
 * script, which is the point of having it.
 */
type Bag = Record<string, unknown>;

const bag = (value: unknown): Bag => (value && typeof value === "object" ? (value as Bag) : {});
const list = (value: unknown): Bag[] => (Array.isArray(value) ? (value as Bag[]) : []);
const str = (value: unknown): string => (typeof value === "string" ? value : "");
const num = (value: unknown): number => (typeof value === "number" ? value : Number.NaN);

/*
 * "Confirm it's you", made through the real endpoint with the person's own
 * password, and sent with their requests from then on - as the app does once
 * somebody has confirmed. Every signature needs one; a day one where nobody
 * can sign would be caught here.
 */
const confirmations = new Map<string, string>();

async function confirmIdentity(token: string, password: string): Promise<void> {
  const reply = await call("POST", "/api/auth/step-up", { token, json: { password } });
  const stepUpToken = str(bag(reply.body).stepUpToken);
  if (reply.status !== 200 || !stepUpToken) {
    throw new Error(`Could not confirm identity: HTTP ${reply.status} ${JSON.stringify(reply.body)}`);
  }
  confirmations.set(token, stepUpToken);
}

async function signIn(email: string, password: string): Promise<string> {
  const reply = await call("POST", "/api/auth/login", { json: { email, password } });
  if (reply.status !== 200) {
    throw new Error(`Could not sign in as ${email}: HTTP ${reply.status} ${JSON.stringify(reply.body)}`);
  }
  const token = str(bag(reply.body).accessToken);
  if (!token) throw new Error(`Signed in as ${email} but got no access token back`);
  return token;
}

/**
 * Refuse to run anywhere but a fresh install.
 *
 * This script creates accounts and submits a document. Pointed at a live
 * deployment by a mistyped URL it would put fixture people into a real staff
 * list and a fixture memo into a real audit trail, and nothing downstream can
 * tell those apart from the genuine article afterwards. So the first thing it
 * does is establish that the install really is untouched, and stop if it is
 * not - before it writes anything.
 */
async function assertNothingHereYet(token: string): Promise<void> {
  const users = await call("GET", "/api/admin/users?limit=100", { token });
  const accounts = list(bag(users.body).data ?? bag(users.body).users ?? users.body).length;

  /*
   * The document lists are no use here, and it is worth saying why: every one
   * of them is scoped to what the caller is party to, so an administrator who
   * is in nobody's approval chain reads zero on an install full of memos. A
   * guard that asks a scoped question gets a reassuring answer and waves the
   * run through.
   *
   * The ledger is the one view that is global by construction - it seals every
   * audit row the system writes, whoever wrote it - so it is the honest
   * measure of whether anything has happened here.
   */
  const ledger = await call("GET", "/api/audit/ledger", { token });
  const sealed = num(bag(ledger.body).sealed);
  const activity = Number.isNaN(sealed) ? 0 : sealed;

  if (accounts === 1 && activity === 0) return;

  console.error(
    `\nRefusing to run: this install is not empty ` +
      `(${accounts} account(s), ${activity} sealed audit entries; a fresh install has 1 and 0).\n\n` +
      "This check writes fixture people and a fixture memo, which cannot be told\n" +
      "apart from real ones once they are in an audit trail. Point it at a database\n" +
      "that has been migrated and seeded and nothing more."
  );
  process.exit(2);
}

async function main(): Promise<void> {
  step(1, "The administrator signs in to an install nobody has used yet");
  const admin = await signIn(ADMIN_EMAIL, ADMIN_PASSWORD);
  check("the administrator can sign in", Boolean(admin));

  const me = await call("GET", "/api/auth/me", { token: admin });
  check("and is an administrator", JSON.stringify(me.body).includes("ADMINISTRATOR"));

  await assertNothingHereYet(admin);

  step(2, "The departments are already there, so the import has something to match");
  const departments = await call("GET", "/api/admin/departments", { token: admin });
  const names = list(
    bag(departments.body).data ?? bag(departments.body).departments ?? departments.body
  ).map((department) => str(department.name));
  check("departments were seeded", names.length > 0, `${names.length}`);
  // The seed upserts on name, so it can add a department but never rename one:
  // a correction that ships as a rename leaves both spellings in every database
  // that already ran the old seed. These two are where that has happened.
  check(
    "Human Resources appears exactly once",
    names.filter((name) => name === "Human Resources").length === 1
  );
  check(
    "Procurement is spelt correctly and only once",
    names.filter((name) => name === "Fabric Sourcing & Procurement").length === 1
  );

  step(3, "The administrator imports a staff list on the template the app hands out");
  // Byte for byte the header row `downloadUserImportTemplate` writes. If the
  // template and the importer ever disagree about a column, this row is where
  // it shows.
  // The leading byte-order mark is written as an escape rather than pasted in:
  // an invisible character at the head of a template literal is one careless
  // editor away from being lost, and its absence would not fail anything here.
  const csv = `\uFEFF${[HEADERS.join(","), ...PEOPLE.map((row) => row.join(","))].join("\r\n")}`;
  const importForm = new FormData();
  importForm.append("file", new Blob([csv], { type: "text/csv" }), "staff.csv");

  // Importing people asks the administrator to confirm it is them first, as
  // the app does with its "Confirm it's you" dialog.
  const stepUpReply = await call("POST", "/api/auth/step-up", {
    token: admin,
    json: { password: ADMIN_PASSWORD },
  });
  check("the administrator can confirm it is them", stepUpReply.status === 200, `HTTP ${stepUpReply.status}`);
  const stepUp = str(bag(stepUpReply.body).stepUpToken);

  const imported = await call("POST", "/api/admin/users/bulk", {
    token: admin,
    form: importForm,
    stepUp,
  });
  check("the import was accepted", imported.status === 201 || imported.status === 200, `HTTP ${imported.status}`);
  const outcome = bag(imported.body);
  check("every row was created", num(outcome.created) === PEOPLE.length, `created ${String(outcome.created)}`);
  check("no row failed", list(outcome.failed).length === 0, JSON.stringify(outcome.failed ?? []));

  const users = await call("GET", "/api/admin/users?limit=100", { token: admin });
  const byEmail = new Map(
    list(bag(users.body).data ?? bag(users.body).users ?? users.body).map((user) => [
      str(user.email),
      user,
    ])
  );
  check("the imported people are listed", byEmail.size === PEOPLE.length + 1, `${byEmail.size} accounts`);

  const preparer = byEmail.get(PREPARER);
  // The column that names the office printed under a signature. Left out of the
  // template once, and every account in an organisation arrives without one.
  check(
    "designation survived the import",
    str(preparer?.designation) === "HR Officer",
    JSON.stringify(preparer?.designation)
  );
  check("department was matched by name", Boolean(preparer?.department ?? preparer?.departmentId));
  check(
    "a second administrator can be made by import",
    str(byEmail.get("fresh-check-deputy@example.com")?.loginRole) === "ADMINISTRATOR"
  );

  step(4, "An imported person signs in with the password from the spreadsheet");
  const firstSignIn = await signIn(PREPARER, "import-password-1");
  check("an imported account can sign in", Boolean(firstSignIn));
  const reviewer = await signIn(REVIEWER, "import-password-2");
  const approver = await signIn(APPROVER, "import-password-3");
  // Both sign later, and a signature needs a fresh "confirm it's you".
  await confirmIdentity(reviewer, "import-password-2");
  await confirmIdentity(approver, "import-password-3");
  check("so can the other two", Boolean(reviewer) && Boolean(approver));

  step(5, "That person changes the password somebody else chose for them");
  const changed = await call("PATCH", "/api/users/me/password", {
    token: firstSignIn,
    json: { currentPassword: "import-password-1", newPassword: CHOSEN_PASSWORD },
  });
  check("the change was accepted", changed.status === 200, `HTTP ${changed.status}`);
  // Most of the point of changing one: the sessions the old password opened
  // have to stop working, or the change is a gesture.
  const stale = await call("GET", "/api/auth/me", { token: firstSignIn });
  check("the old session was ended", stale.status === 401, `HTTP ${stale.status}`);
  const preparerToken = await signIn(PREPARER, CHOSEN_PASSWORD);
  await confirmIdentity(preparerToken, CHOSEN_PASSWORD);
  check("the new password works", Boolean(preparerToken));

  step(6, "The administrator builds the first approval route");
  const reviewerId = str(byEmail.get(REVIEWER)?.id);
  const approverId = str(byEmail.get(APPROVER)?.id);
  const template = await call("POST", "/api/admin/workflow-templates/", {
    token: admin,
    json: {
      name: "Fresh install check",
      description: "Reviewed once, then signed off.",
      isActive: true,
      graph: {
        nodes: [
          { id: "start", type: "start", position: { x: 0, y: 0 }, data: { label: "Submitted" } },
          {
            id: "review",
            type: "approval",
            position: { x: 200, y: 0 },
            data: { label: "Manager HR", approverId: reviewerId, approvalType: "REVIEWER", slaDays: 2 },
          },
          {
            id: "final",
            type: "approval",
            position: { x: 400, y: 0 },
            data: { label: "Head of Finance", approverId, approvalType: "FINAL_APPROVER", slaDays: 3 },
          },
          { id: "end", type: "end", position: { x: 600, y: 0 }, data: { label: "Approved" } },
        ],
        edges: [
          { id: "e1", source: "start", target: "review" },
          { id: "e2", source: "review", target: "final" },
          { id: "e3", source: "final", target: "end" },
        ],
      },
    },
  });
  check(
    "the route was saved",
    template.status === 201 || template.status === 200,
    `HTTP ${template.status} ${JSON.stringify(template.body).slice(0, 200)}`
  );
  const templateId = str(bag(template.body).id);

  const offered = await call("GET", "/api/workflow-templates/", { token: preparerToken });
  const offeredList = list(
    bag(offered.body).data ?? bag(offered.body).templates ?? offered.body
  );
  check("a standard user can pick it", offeredList.some((row) => str(row.id) === templateId));

  step(7, "A person submits a memo against that route");
  const pdf = await PDFDocument.create();
  pdf.addPage([595, 842]);
  // Copied into a buffer of its own rather than handed straight to `Blob`.
  // `save()` returns a view over whatever allocator it used, and a view's
  // backing store is not necessarily the bytes you think you are sending -
  // the copy costs nothing at this size and removes the question.
  const pdfBytes = new Uint8Array(await pdf.save());

  const submitForm = new FormData();
  submitForm.append("file", new Blob([pdfBytes], { type: "application/pdf" }), "memo.pdf");
  submitForm.append("title", "Fresh install check memo");
  submitForm.append("description", "Submitted by scripts/fresh-install-check.ts");
  submitForm.append("templateId", templateId);
  submitForm.append("signature", JSON.stringify(signature()));

  const submitted = await call("POST", "/api/documents/", { token: preparerToken, form: submitForm });
  check(
    "the memo was accepted",
    submitted.status === 201 || submitted.status === 200,
    `HTTP ${submitted.status} ${JSON.stringify(submitted.body).slice(0, 200)}`
  );
  const document = bag(bag(submitted.body).document ?? submitted.body);
  const documentId = str(document.id);
  check(
    "it was given a memo reference",
    /^MEMO-\d{4}-\d{4,}$/.test(str(document.referenceNumber)),
    str(document.referenceNumber)
  );
  check("it is pending, not a draft", str(document.status) === "PENDING_REVIEW", str(document.status));

  step(8, "It reaches the reviewer, who signs it");
  const queue = await call("GET", "/api/documents/?status=PENDING_REVIEW", { token: reviewer });
  const queued = list(bag(queue.body).documents ?? bag(queue.body).data ?? queue.body);
  check("it is in the reviewer's queue", queued.some((row) => str(row.id) === documentId));

  const badge = await call("GET", "/api/documents/pending-count", { token: reviewer });
  check("the queue badge counts it", num(bag(badge.body).count) === 1, JSON.stringify(badge.body));

  const firstApproval = await call("POST", `/api/documents/${documentId}/approve`, {
    token: reviewer,
    json: signature(),
  });
  check(
    "the reviewer can approve",
    firstApproval.status === 200,
    `HTTP ${firstApproval.status} ${JSON.stringify(firstApproval.body).slice(0, 200)}`
  );

  const midway = await call("GET", `/api/documents/${documentId}`, { token: preparerToken });
  const midwayStatus = str(bag(bag(midway.body).document ?? midway.body).status);
  check("it is still pending after step one of two", midwayStatus === "PENDING_REVIEW", midwayStatus);

  const again = await call("POST", `/api/documents/${documentId}/approve`, {
    token: reviewer,
    json: signature(),
  });
  check("the same person cannot approve twice", again.status === 403, `HTTP ${again.status}`);

  step(9, "It reaches the final approver, who signs it");
  const lastApproval = await call("POST", `/api/documents/${documentId}/approve`, {
    token: approver,
    json: signature(),
  });
  check(
    "the final approver can approve",
    lastApproval.status === 200,
    `HTTP ${lastApproval.status} ${JSON.stringify(lastApproval.body).slice(0, 200)}`
  );

  const finished = await call("GET", `/api/documents/${documentId}`, { token: preparerToken });
  const finalStatus = str(bag(bag(finished.body).document ?? finished.body).status);
  check("the memo is APPROVED", finalStatus === "APPROVED", finalStatus);

  step(10, "The things an approved memo is supposed to leave behind");
  const file = await fetch(`${API}/api/documents/${documentId}/file`, {
    headers: { Authorization: `Bearer ${preparerToken}` },
  });
  const bytes = Buffer.from(await file.arrayBuffer());
  check("the signed file downloads", file.status === 200, `HTTP ${file.status}`);
  check("it is a PDF", bytes.subarray(0, 4).toString() === "%PDF", bytes.subarray(0, 8).toString());
  const rendered = await PDFDocument.load(bytes);
  check("the signed PDF still has its page", rendered.getPageCount() >= 1, `${rendered.getPageCount()} page(s)`);

  const audit = await call("GET", `/api/documents/${documentId}/audit`, { token: preparerToken });
  const trail = list(bag(audit.body).auditHistory);
  const actions = trail.map((row) => str(row.action));
  check("the document has an audit trail", trail.length >= 3, `${trail.length} rows`);
  check(
    "it records the upload and both approvals",
    actions.includes("DOCUMENT_UPLOADED") && actions.filter((action) => action === "APPROVE").length === 2,
    actions.join(", ")
  );
  // Without the designation column this row names a person with no office
  // behind them, on every approval, permanently.
  const uploaded = bag(trail.find((row) => str(row.action) === "DOCUMENT_UPLOADED"));
  check(
    "the trail names the person and their office",
    str(bag(uploaded.user).designation) === "HR Officer",
    JSON.stringify(uploaded.user)
  );
  check("every row is stamped with a time", trail.every((row) => Boolean(row.date)));

  const ledger = await call("POST", "/api/audit/ledger/verify", { token: admin, json: {} });
  check(
    "the ledger verifies",
    ledger.status === 200 && bag(ledger.body).intact === true,
    JSON.stringify(ledger.body).slice(0, 200)
  );

  const notifications = await call("GET", "/api/notifications/", { token: reviewer });
  const notices = list(
    bag(notifications.body).data ?? bag(notifications.body).notifications ?? notifications.body
  );
  check("the reviewer was notified in the app", notices.length > 0, `${notices.length}`);

  /*
   * Mail is written to an outbox and drained by a worker on a timer.
   *
   * With no SMTP host configured - which is how CI and every developer machine
   * runs, deliberately - nothing is sent and the queue still records what would
   * have gone. That is the thing worth asserting either way: a workflow that
   * advances in silence is the failure this product exists to prevent. Where a
   * host *is* configured the check goes further and waits for the queue to
   * empty, because an outbox that fills and never drains looks exactly like a
   * working one until somebody asks why they were never told.
   */
  const mail = await call("GET", "/api/admin/mail", { token: admin });
  const settings = bag(bag(mail.body).settings);
  const counts = bag(bag(mail.body).counts);
  const raised = Object.values(counts).reduce<number>((total, value) => total + num(value), 0);
  check("mail was raised for the approvers", raised > 0, `${raised} message(s)`);

  if (settings.configured === true) {
    let drained = counts;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      if (num(drained.PENDING) === 0 && num(drained.SENDING) === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 10_000));
      const polled = await call("GET", "/api/admin/mail", { token: admin });
      drained = bag(bag(polled.body).counts);
    }
    check("the worker delivered every one", num(drained.SENT) === raised, JSON.stringify(drained));
    check(
      "nothing failed or expired",
      num(drained.FAILED) === 0 && num(drained.EXPIRED) === 0,
      JSON.stringify(drained)
    );
  } else {
    console.log("  ....  no SMTP host configured, so delivery is not checked here");
  }


  step(11, "A memo nobody uploads: typed in the portal and drawn by the server");

  /*
   * The whole point of this step is that no PDF exists anywhere before it.
   * The preparer types a body, the server draws it, and everything from the
   * signature onwards is the path an uploaded memo already takes. A day-one
   * install that can only accept memos somebody made in Word elsewhere is
   * exactly the thing in-app authoring was added to remove.
   */
  const memoTypes = await call("GET", "/api/memo-types", { token: preparerToken });
  const availableTypes = list(bag(memoTypes.body).memoTypes ?? memoTypes.body);
  check("the install ships memo types to write against", availableTypes.length > 0, `${availableTypes.length}`);
  const memoTypeKey = str(bag(availableTypes[0]).key);

  const memoBody = {
    type: "doc",
    content: [
      { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "BACKGROUND:" }] },
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: "This memo was typed in the portal by scripts/fresh-install-check.ts. Nothing was uploaded.",
          },
        ],
      },
      { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "RECOMMENDATION:" }] },
      {
        type: "paragraph",
        content: [{ type: "text", text: "Approval is solicited please." }],
      },
    ],
  };

  const typedChain = [
    { userId: reviewerId, approvalType: "REVIEWER", slaDays: 2 },
    { userId: approverId, approvalType: "FINAL_APPROVER", slaDays: 3 },
  ];

  const preview = await call("POST", "/api/memo-drafts/preview", {
    token: preparerToken,
    json: {
      title: "Fresh install check, typed",
      memoTo: "The Managing Director",
      memoFrom: "Human Resource Department",
      body: memoBody,
      chain: typedChain,
    },
  });
  check(
    "the server draws the memo before anybody signs it",
    preview.status === 200,
    `HTTP ${preview.status} ${JSON.stringify(preview.body).slice(0, 200)}`
  );

  const drawn = Buffer.from(str(bag(preview.body).pdfBase64), "base64");
  check("what comes back is a PDF", drawn.subarray(0, 4).toString() === "%PDF", drawn.subarray(0, 8).toString());
  check(
    "it has pages to sign on",
    (await PDFDocument.load(drawn)).getPageCount() >= 1
  );

  /*
   * A ruled line per signatory, preparer first. The preparer signs on their
   * own, which is what the printed strip is for - the alternative is three
   * printed lines left blank and three signatures somewhere in the prose.
   */
  const slots = list(bag(preview.body).slots);
  const preparerId = str(byEmail.get(PREPARER)?.id);
  check("a line is printed for everyone who will sign", slots.length === 3, `${slots.length}`);
  const mySlot = bag(slots.find((slot) => str(slot.key) === preparerId));
  check("one of them is the preparer's own", Object.keys(mySlot).length > 0, JSON.stringify(slots.map((s) => s.key)));

  const placementOn = (slot: Record<string, unknown>) => ({
    consent: true,
    useSavedSignature: false,
    signatureImage: SIGNATURE_IMAGE,
    signaturePage: num(slot.page),
    signatureX: num(slot.x),
    signatureY: num(slot.y),
    signatureWidth: num(slot.width),
    signatureHeight: num(slot.height) - 16,
  });

  const typedForm = new FormData();
  typedForm.append("title", "Fresh install check, typed");
  typedForm.append("description", "Typed by scripts/fresh-install-check.ts");
  typedForm.append("memoType", memoTypeKey);
  typedForm.append("memoTo", "The Managing Director");
  typedForm.append("memoFrom", "Human Resource Department");
  typedForm.append("body", JSON.stringify(memoBody));
  typedForm.append("approvalChain", JSON.stringify(typedChain));
  typedForm.append("signature", JSON.stringify(placementOn(mySlot)));

  const typedSubmit = await call("POST", "/api/documents/", { token: preparerToken, form: typedForm });
  check(
    "a memo with no file attached is accepted",
    typedSubmit.status === 201 || typedSubmit.status === 200,
    `HTTP ${typedSubmit.status} ${JSON.stringify(typedSubmit.body).slice(0, 200)}`
  );
  const typedDocument = bag(bag(typedSubmit.body).document ?? typedSubmit.body);
  const typedId = str(typedDocument.id);
  check(
    "it was given a memo reference like any other",
    /^MEMO-\d{4}-\d{4,}$/.test(str(typedDocument.referenceNumber)),
    str(typedDocument.referenceNumber)
  );

  const typedFile = await fetch(`${API}/api/documents/${typedId}/file`, {
    headers: { Authorization: `Bearer ${preparerToken}` },
  });
  const typedBytes = Buffer.from(await typedFile.arrayBuffer());
  check("the memo it drew can be downloaded", typedFile.status === 200, `HTTP ${typedFile.status}`);
  check("and it is a PDF", typedBytes.subarray(0, 4).toString() === "%PDF");

  /*
   * The approver is offered their own line rather than having to aim at it.
   * Without this the strip prints their name and they sign somewhere else.
   */
  const reviewerView = await call("GET", `/api/documents/${typedId}`, { token: reviewer });
  const reviewerSlot = bag(bag(bag(reviewerView.body).document ?? reviewerView.body).mySignatureSlot);
  check(
    "the reviewer is told where their own signature belongs",
    Object.keys(reviewerSlot).length > 0,
    JSON.stringify(reviewerSlot)
  );

  const typedReview = await call("POST", `/api/documents/${typedId}/approve`, {
    token: reviewer,
    json: placementOn(reviewerSlot),
  });
  check(
    "the reviewer signs on the line printed for them",
    typedReview.status === 200,
    `HTTP ${typedReview.status} ${JSON.stringify(typedReview.body).slice(0, 200)}`
  );

  const approverView = await call("GET", `/api/documents/${typedId}`, { token: approver });
  const approverSlot = bag(bag(bag(approverView.body).document ?? approverView.body).mySignatureSlot);
  const typedFinal = await call("POST", `/api/documents/${typedId}/approve`, {
    token: approver,
    json:
      Object.keys(approverSlot).length > 0 ? placementOn(approverSlot) : signature(),
  });
  check(
    "the final approver signs it off",
    typedFinal.status === 200,
    `HTTP ${typedFinal.status} ${JSON.stringify(typedFinal.body).slice(0, 200)}`
  );

  const typedDone = await call("GET", `/api/documents/${typedId}`, { token: preparerToken });
  const typedStatus = str(bag(bag(typedDone.body).document ?? typedDone.body).status);
  check("the typed memo is APPROVED", typedStatus === "APPROVED", typedStatus);

  const typedAudit = await call("GET", `/api/documents/${typedId}/audit`, { token: preparerToken });
  const typedTrail = list(bag(typedAudit.body).auditHistory);
  check(
    "its trail records both approvals",
    typedTrail.filter((row) => str(row.action) === "APPROVE").length === 2,
    typedTrail.map((row) => str(row.action)).join(", ")
  );

  /*
   * And the guard that stops a memo of empty boxes being sealed. No bundled
   * font draws Arabic script, and the alternative to refusing is an immutable
   * artefact full of blanks signed by four people.
   */
  const unprintable = await call("POST", "/api/memo-drafts/preview", {
    token: preparerToken,
    json: {
      title: "Unprintable",
      body: {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "السلام" }] },
        ],
      },
    },
  });
  check(
    "a memo the fonts cannot draw is refused rather than drawn blank",
    unprintable.status === 400,
    `HTTP ${unprintable.status} ${JSON.stringify(unprintable.body).slice(0, 200)}`
  );

  const ledgerAfterTyped = await call("POST", "/api/audit/ledger/verify", { token: admin, json: {} });
  check(
    "the ledger still verifies with a drawn memo in it",
    ledgerAfterTyped.status === 200 && bag(ledgerAfterTyped.body).intact === true,
    JSON.stringify(ledgerAfterTyped.body).slice(0, 200)
  );

  if (STORAGE_DIR) {
    const documents = path.join(STORAGE_DIR, "documents");
    const stored = fs.existsSync(documents) ? fs.readdirSync(documents) : [];
    check("the file reached the disk", stored.length > 0, `${stored.length} file(s)`);
  }
}

main()
  .then(() => {
    console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch((error: unknown) => {
    console.error(`\nThe check could not finish: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
