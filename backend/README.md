# DAWS - Document Approval Workflow System

A PostgreSQL-based document approval workflow system with multi-stage review and approval processes, built with Prisma ORM v7.

## Features

- Multi-stage sequential approval workflows
- Document versioning and revision tracking
- Digital signature support
- Real-time notifications
- Comprehensive audit logging
- Department-based user management
- Role-based access control (Administrator/User)

## Checks

```bash
npm run typecheck   # src/, prisma/ and the tests - each build excludes some
npm run lint        # ESLint, type-aware
npm test            # vitest - 360 tests, no database
npm run test:db     # vitest - 702 tests against a real Postgres, including the
                    # end-to-end memo acceptance suite (src/routes/memo-workflow.itest.ts)
```

`npm test` opens no connection, reads no network and writes nothing outside a
temp directory, so it runs on a fresh clone with no `.env` and no Postgres.
`vitest.config.mts` is what keeps that true, and says why. **Keep it true**: a
suite that needs a database is a suite that gets skipped.

What it covers is the logic that is expensive to get wrong and cheap to pin
down - who may see a document (`lib/documentAccess`), what a storage path is
allowed to address (`lib/storage`), where a signature lands on the page
(`lib/pdfSignature`), the approval-chain rules (`lib/approvalChain`), tokens,
passwords, the CSV and spreadsheet importers, what the submit schema
refuses, and the workflow-template compiler. The rest of the services are
covered by `npm run test:db` - see below.

### The integration suite

`npm run test:db` runs the real `documentsService` and `approvalService`
against a real Postgres. That is the only way to check what those two are
actually for: submitting a document writes eight kinds of row, a file and a
transaction in an order that matters, and most of the approval rules are about
*refusal* - who may act, when, and how often. A mock will agree that the wrong
person was refused long after the query deciding it has drifted.

One-time setup:

```bash
docker exec daws-postgres psql -U daws -d postgres -c "CREATE DATABASE daws_test"
# then set TEST_DATABASE_URL in .env - see .env.example
```

Migrations are applied at the start of every run, so pulling a new one needs
no extra step. The whole suite takes about 75 seconds.

Between tests it empties every table with `DELETE` under
`session_replication_role = replica`, not `TRUNCATE`: TRUNCATE locks and
rewrites every table and measured at ~400ms a time, against ~25ms for the
delete, which over three hundred tests is the difference between a suite
people run and one they do not. If the database role may not set that, it
falls back to TRUNCATE and says so on stderr.

**The suite truncates every table between tests.** `vitest.config.integration.mts`
is what stops that reaching a database anyone cares about: TEST_DATABASE_URL
has no default, must name a database ending in `_test`, must not equal
DATABASE_URL or DIRECT_URL, and refuses NODE_ENV=production. Each of those
four has been checked by trying it.

Every service is covered - documents, approval, auth, admin, users, comments,
notifications, workflow and audit - and the route layer, over real HTTP
against an ephemeral port.

The route tests are the ones that catch a class of bug no service test can:
a route that forgets `authenticate`, or an admin route that forgets
`requireAdmin`. Every route is listed in a table and asked for a 401 without a
token, and the table is checked against the number of routes Express actually
registered - so a route added without being listed fails the suite rather than
being quietly unchecked.

### One thing the tests found and fixed

**The comment thread on a document had no access check at all.** Neither
`getComments` nor `createComment` looked at who was asking, and the routes
only checked that the caller was signed in - so any authenticated user could
read the whole thread of any document by id, and post into it. The thread is
where the approval service writes rejection reasons, revision requests and the
note naming whoever was skipped and why. The document itself and its audit
trail were both closed; this was the way round them. It now follows the
document's own rule: you may read the conversation about a document exactly
when you may read the document.

### Six things the tests found and fixed

**A decision node routed a document that FAILED its condition down the `yes`
branch.** A decision drawn with only a Yes handle connected — the ordinary way
to say "if the title says CAPITAL, add the CFO" — produced one outgoing edge
labelled `yes`. When the condition did not match there was no `no` edge and no
`default`, so the compiler fell through to `outgoing[0]`, which is that same
Yes edge. The document went through approvers it was never meant to reach, and
nothing recorded that it had. The route now ends there instead; an explicit
`default` still wins, and a single *unlabelled* edge is still followed, because
an edge with no branch label carries no yes/no meaning. A decision that has
labelled branches but no condition is refused rather than guessed.

**An approval node with no approver was dropped from the compiled chain.**
Silently — the document was routed past somebody the graph included. It is now
refused at submission, naming the step: *Approval step "Finance review" has
nobody assigned.* Refusing is safe because a chain is compiled once, at
submission: documents already in flight carry a materialised chain and are
never recompiled. The save-time schema (`graphRefine`) already refused this
shape, so what reaches the compiler is a template stored before it did, or one
written straight to the database.

**A join node compiled after the first branch that reached it.** The walk was
depth-first over a shared `visited` set, so a graph drawn as "left and right,
then join" compiled as "left, join, right" — and since the join is usually the
Final Approver, the submission was refused with *"Final Approver must be the
last step"*, told to somebody whose graph plainly had it last. Compilation is
now two passes: resolve the decisions, then emit in topological order over what
survives. A diamond routes as drawn.

**A cyclic template compiled one lap and stopped.** The `visited` set hid the
loop, so a graph describing an approval that goes round for ever quietly
produced a chain. There is no right chain to make from it, so it is refused.

**One audit row with no actor made a whole document's trail unreadable.**
`mapAuditLogToHistoryEntry` threw, so a single row took down every action, for
everyone, on that document. Not dropped, though: `actorId` is nullable, the
relation defaults to `SetNull`, and `deleteUser` guards on documents, versions,
chain steps, approvals and comments — not on audit rows. Skipping the row would
mean deleting a user erases what they did from the ledger, which is the one
thing a ledger exists to prevent. The row stays and reads "Unknown user".

**An approved document could be deleted by its preparer alone.** `deleteDocument`
checked the preparer and whether it was already deleted, and nothing else.
Deleting is for retracting something still in flight; an approved document is a
finished record whose final version carries the approvers' signatures and which
the audit trail cites — and a resubmit afterwards wrote over that file. It is
now refused with a 409. A rejected document can still be retracted: rejection
produces no signature, and dropping a dead memo is why the feature exists.

### Two things about how failures were reported

**Every limit multer enforces itself answered 500.** The `fileFilter`s raise
`AppError`s and always arrived correctly, but the `limits` throw a
`MulterError`, which is a plain `Error` — so choosing a 25 MB PDF told the
person the server had broken rather than that their file was too big, and sent
them to support instead of back to the file picker. `errorHandler` now maps
each code to 413 or 400.

**Three caller mistakes in `documents.routes.ts` were raised as bare `Error`.**
A malformed `approvalChain` or `signature` JSON part, and a missing PDF, each
answered 500 with the written message discarded.

### Three things the acceptance pass closed

**The audit trail was looser than the document it describes.** `audit.service`
gated on `prismaDocumentAccessFilter`, which asks only whether you are in the
chain, while the document, its workflow view and its comment thread all used
`canUserViewDocument`, which also asks whether the workflow has reached you —
so an approver at step 3 who could not open a document could read its entire
history. Both audit paths now apply `canUserViewDocument`: the database filter
narrows the read, and the rule decides. Two rules over one document means the
looser one is the real policy whether or not anybody meant it to be.

**The preparer could pass over an approver.** `skipWorkflowStep` demanded a
written reason, wrote an audit row and a comment naming who was passed over,
and refused to touch the final approver — but it was still a bypass in the
hands of the person who most wants the memo through, and the requirement is
that no approval can be skipped. It is off unless a deployment sets
`ALLOW_STEP_SKIP=true` (with `VITE_FEATURE_STEP_SKIP` to match, or the button
is offered and the API refuses it). The code and its tests are intact for an
organisation that decides it needs it.

**Nothing written down described the bytes.** Signed artefacts were already
immutable — nothing overwrites one — but immutability is a promise about what
the code does, and a digest is a fact about the file. Every artefact now
carries a SHA-256 taken when it was written: the upload, the memo as
submitted, each approver's signed copy, and the approved version. The file is
checked against it on the way out, and a memo that no longer matches what was
signed is refused rather than served with a caveat. Memos approved before this
existed read as `unrecorded`, which is neither a pass nor a failure.

### Signing out, which signed tokens are worst at

There was no way to sign out at all. Tokens were signed and stateless, so
"sign out" meant the client forgetting them and the server never knowing: a
refresh token stayed good for thirty days in anybody's hands, and changing a
password because a laptop was stolen changed nothing the thief was holding.

A JWT is a claim the holder carries, and nothing here can reach into their
laptop and take it back — so revocation has to be something this side
remembers and checks. Two things are remembered, because they answer two
different fears:

- **A row per sign-in** (`refresh_sessions`), so signing out on a shared
  machine ends exactly that session and leaves the phone alone. The refresh
  token itself is never stored, only its SHA-256: a database dump must not be
  a drawer full of live sessions.
- **A cutoff on the account** (`users.sessions_valid_from`), so "sign out
  everywhere" ends *everything*, including an access token sitting unused in a
  tab. No session row can reach that one — the client is holding it and has
  not presented it — which is exactly the token somebody worried about a
  stolen laptop means.

Refresh tokens now **rotate**: the token presented is revoked and a new one
issued, so each is good exactly once. `authenticate` reads the account on every
request to check the cutoff, which is one indexed read and worth it — without
it a deleted account goes on approving memos for two hours.

Changing a password or a role ends that account's sessions. That is most of
the point of being able to change either.

Two defects surfaced while building it, both in the tokens themselves. Without
a `jti` a JWT is a pure function of its payload and the standard `iat` counts
whole seconds, so **two sign-ins in the same second produced byte-identical
tokens** — and since the session table keys on the token's digest, the second
sign-in collided with the first and failed outright. And at one-second
resolution a token issued in the same second as a revocation cannot be told
from one issued just after it, so tokens now carry the millisecond they were
minted and the comparison is exact.

### Deadlines, and why there were none

The redesign asked for an SLA countdown and it stayed switched off for a long
time, for a good reason: there was no due date anywhere in the product, so a
countdown would have been a number invented on the screen. An invented deadline
on an approval queue is worse than no column - people reorder their day around
it.

The answer is the one the step-skip took: **a deadline is a policy an
organisation owns, not a constant this code can pick.** A step has a deadline
only if somebody set one, either as `slaDays` on that step (from the submitted
chain, or from a workflow template's approval node) or as `SLA_DEFAULT_DAYS`
for the whole deployment. Set neither and `dueAt` is null on every row, the
documents table goes on showing age - which is true - and nothing is chased.

What a deadline is, precisely:

- **whole working days**, counted from the day after the memo reached the
  approver. A memo landing at four on Friday afternoon with two days is due at
  the end of Tuesday, not at four on Sunday;
- **ending at the end of the day**, so nothing expires early;
- Saturdays and Sundays are the only days skipped. Public holidays differ by
  country and by year, nothing here knows them, and inventing a calendar would
  be the same mistake as inventing the deadline. A deployment whose holidays
  matter should give the step more days rather than expect this to know about
  Eid.

The clock is `workflow_runs.current_step_started_at`, moved on every advance,
so the deadline belongs to whoever is holding the memo now rather than to the
submission. `dueAt` itself is computed on read from that column and the step's
allowance - a third stored copy is one more thing that can drift away from both.

**Being late is told, not acted on.** A sweep finds steps past their deadline
and notifies the approver holding it and the person who prepared it, once each,
through the same inbox and outbox as every other notice; `breach_notified_at`
records that it went and is cleared when the step advances, so nobody inherits
the last approver's chase. Nothing is reassigned, escalated or skipped - the
memo still needs that signature, and a system that routed around an approver
because they were slow would undo the guarantee the whole product exists for.
That is also why the designer has a Deadline select and no "On breach" select:
every option that one would offer is an action the workflow cannot take.

### What it does at ten thousand memos

`scripts/bench.ts` calls the services directly against a database seeded to
whatever size you want to ask about - one at a time, not concurrently, because
concurrency hides the thing worth finding: a query that is linear in the size
of the whole corpus rather than in the size of a page.

At ten thousand memos it found one, and it was the screen everybody opens
first. Listing documents took **716ms for an administrator and 942ms for an
approver, and the same on page forty as on page one**.

The cause is worth being precise about, because the obvious fix is the wrong
one. Whether a workflow has actually reached a person is decided in
JavaScript, deliberately - expressing it in SQL is how a memo becomes readable
by an approver whose turn has not come - so every candidate row has to be
*considered*. That part is fine. What was not fine was fetching each one in
full to do it: every matching document with its chain, every step, and a user
object per step. Thirty thousand nested rows built, shipped and discarded to
show twenty-five.

It is two passes now. The first reads only what the rule needs - an id, a
preparer, step orders - and the second fetches the rich shape for the page,
which is twenty-five rows however large the corpus grows. Same rule, same
place, same answers: **214ms and 220ms**, and the tests unchanged.

Two things stay above 300ms and are meant to. Verifying the whole audit chain
is 376ms for eighteen thousand records and is linear in the trail by
definition - it is on demand, administrators only, and doing less would mean
checking less. The audit trail's first page is 337ms and is next if it matters.

### The gap between "guarded" and "works"

`routes.itest.ts` asks whether each route is behind `authenticate` and, where
it should be, `requireAdmin`. `memo-workflow.itest.ts` walks the one journey
the business asked for. Between them sat a class of fault nothing looked at: a
route that is guarded, reachable, mounted in the right order, and still falls
over on the first real body.

Delegation did exactly that, and had since the day it shipped. `validate`
parses the body and writes the coerced value back onto the request; the handler
then parsed the same body a second time, by which point `startsAt` and `endsAt`
are Date objects and the schema that produced them expects strings. The
ZodError was thrown inside the handler - past the middleware that turns those
into a 400 - so it left as `Internal server error`. The panel always sends an
end date, so every delegation the interface tried to save failed. Its
thirty-nine service tests passed throughout, because none of them went through
a route.

`request-bodies.itest.ts` closes that gap: it sends a body to every endpoint
that takes one and is not already driven elsewhere - comments, the two
notification writes, creating and editing a person, saving and renaming a
workflow template, sign-up, refresh, and delegation - and checks two things
each time. That the ordinary request succeeds, and that a bad one comes back as
a refusal somebody can read rather than as "Internal server error". Nothing
else it covered turned out to be broken, which is the other half of the point:
the suite is now the record of what has actually been driven.

### Sealing the audit trail

Append-only was a property of the API, not of the data. There is no endpoint
that updates or deletes an audit record - and anyone who can reach the database
can edit one to move an approval onto somebody else's name, or delete the
rejection that came before it, and nothing in the application would notice. The
trail would simply read as though it had always said that.

Every audit record now carries a digest taken over its own contents **and the
digest of the record before it**, so changing one record invalidates every
record after it. What that buys, precisely:

- an edited record is caught, and named - `content`;
- a deleted record leaves a gap in the numbering, which is caught and named -
  `missing`;
- a reordered or spliced chain no longer links up - `link`;
- and a chain rebuilt end to end - the thorough attack, where every digest
  after the edit is recomputed so the chain agrees with itself again - is
  caught by `ledger_checkpoints`, which records where the chain had reached
  each time a batch was sealed and is never updated. That table is also the
  only thing that catches records cut off the *end* of the trail: a shorter
  chain verifies perfectly against itself.

**Sealing is a sweep, not part of the write.** Chaining has to be serialised -
each record needs the digest of the one before it - and an approval must not
queue behind somebody else's audit write to commit. So records are written
unsealed and sealed shortly afterwards, under an advisory lock, in batches.
`LEDGER_SEAL_SECONDS` sets the interval (30 by default, minimum 5).

The honest limit of the claim, and it is worth stating rather than burying: a
record removed inside that window leaves nothing behind, and someone who can
write to the table can recompute the chain and the witnesses together. What
they cannot do is change one record and leave the rest alone - which is what
tampering in an approval system actually looks like - and if the tip digest has
been written down anywhere outside this database, they cannot hide a
recomputation either.

`GET /api/audit/ledger` reports how far the seal has reached and the digest
that closes it; it is open to anyone signed in, because the people relying on
the trail are the ones who need to be able to check it, and it exposes counts
and one digest rather than any record's contents. `POST /api/audit/ledger/verify`
seals whatever is outstanding and then reads every record back and recomputes
it - administrators only, not because the answer is sensitive but because on a
long trail the work is.

`ledger.test.ts` proves the arithmetic with no database in sight - what goes
into a digest, in what order, and that nothing about a `jsonb` round trip
changes it. `ledger.service.itest.ts` does every kind of tampering with raw
SQL, because that is exactly the threat: somebody with a database prompt and a
reason to want the record to say something else.

### Telling people outside the application

Until now an approver learned a memo was waiting by opening the application.
There was no mailer in the tree at all - `EMAIL_SENT` was an audit action
nobody wrote - so a memo could sit in somebody's queue for a week with nothing
in the world saying so.

Notices now go out by email as well, through an outbox rather than a send call:

- the row is written in the **same transaction** as the notification it
  carries, so a memo that reached somebody's queue and a notice that never
  left the building cannot disagree;
- delivery is a sweep afterwards, which is what makes an unreachable mail
  server a delayed notice rather than a failed approval - there is a test that
  approves a memo with the mail server down and watches the workflow advance;
- a transient refusal is retried for ten sweeps; a 5xx is a permanent no and
  is not retried at all; anything still unsent after 24 hours is expired
  rather than delivered, because a mail server that comes back after two days
  must not post a fortnight of stale approval requests;
- a claim is a status change, not a row lock, so two API processes sweeping
  the same queue cannot both send the same notice, and a claim left by a
  process that died is reclaimed after five minutes.

**All of it is optional.** With no `SMTP_HOST` and `MAIL_FROM` the application
runs exactly as before: notices are queued and visible, nothing is delivered,
and the API says so once at startup. That is what the test suite and CI run
with, and it is why nothing here can stop a developer starting the API.

`GET /api/admin/mail` and the card beside the people table report what is
waiting, what went and what was refused with the reason each was given -
"why was I never told?" is asked of an administrator, and this is the answer.

`email.service.itest.ts` proves the queue against a real database with the
mail server mocked; `email.delivery.itest.ts` starts a real SMTP server in
process and reads back what actually arrived on the wire, which is the only
way to catch a transport built with the wrong options or a body that arrives
empty.

### Delegation, the thing the panel used to promise

An approver going on leave is the commonest disruption to a real approval
chain, and for a long time the only answer here was `skipWorkflowStep` — which
is a different act: it records that a step was passed over, not that somebody
else signed in that person's place. The panel that collected out-of-office and
a delegate saved nothing.

It saves now. A `Delegation` row is an authorisation with dates on it, and
while one is in force the delegate may act on the steps assigned to the person
who gave it. Because this is the only place in the product where somebody may
act on a step that is not theirs, the refusals around it are the feature:

- only the person themselves, or an administrator, may arrange or end one;
- nobody delegates to themselves;
- one delegate at a time, so "who may sign for Ayesha on Tuesday" has one
  answer;
- no onward delegation — somebody whose own approvals are already routed away
  cannot be handed anybody else's;
- it is revoked, never edited or deleted, so what was possible between which
  dates outlives the arrangement;
- an approval given under it stands after it ends: it was authorised when it
  was given, and the kept row shows that;
- **the preparer is still refused.** That check runs before the step check, so
  a memo's author cannot approve their own memo by being handed the approver's
  authority. It is the one route by which delegation could have undone the
  workflow's whole claim, and it has its own test in two suites.

Every approval given this way records both names — on the action row, in the
ledger, in the CSV export and on the page of the memo itself, where the block
under the signature reads `Signed for <the approver>`. The delegate is told
when a memo reaches a step they are covering, and the person who is away is
told as well: being out of office is a diary entry, not a lock, and if they
sign it themselves the approval is simply theirs.

`delegations.service.itest.ts` is where the rules are proven; the memo
acceptance suite covers the same ground over HTTP, beside the criterion it
belongs to.

Lint currently reports warnings and no errors. They are one shape — values
arriving from outside the type system (a parsed body, a Prisma `Json` column, a
spreadsheet cell) flowing on untyped. Left as warnings deliberately: off means
nobody sees them again, error means the command is red on day one and stops
being read. The count should only go down.

## Seeding

```bash
npm run seed        # departments + one administrator - safe anywhere
npm run seed:demo   # + people, documents, chains, ledger, inbox (dev only)
```

`seed:demo` is idempotent and refuses to run when `NODE_ENV` is production.
Without it every screen in the app is empty.

## Prerequisites

Before you begin, ensure you have the following installed:

- **Node.js**: v18 or higher
- **npm**: v8 or higher
- **PostgreSQL**: v14 or higher (Docker is the easiest local option)

## Getting Started

### 1. Clone the repository

```bash
git clone https://github.com/favshahzad-collab/daws.git
cd daws/backend
```

### 2. Install dependencies

```bash
npm install
```

### 3. Set up environment variables

Create a `.env` file in the `backend` directory and configure your database connection:

```env
DATABASE_URL="postgresql://USER:PASSWORD@HOST:PORT/DATABASE"
DIRECT_URL="postgresql://USER:PASSWORD@HOST:PORT/DATABASE"

# Signs access and refresh tokens. Required in production (32+ chars).
JWT_SECRET="generate-with: openssl rand -base64 48"

# Where signed PDFs and signature images are written
STORAGE_DIR="./storage"
```

**No local Postgres?** Start one in Docker:

```bash
docker run -d --name daws-postgres --restart unless-stopped   -e POSTGRES_USER=daws -e POSTGRES_PASSWORD=CHANGE_ME_STRONG_PASSWORD -e POSTGRES_DB=daws   -p 15432:5432 -v daws_pgdata:/var/lib/postgresql/data postgres:16-alpine
```

Then use `postgresql://daws:CHANGE_ME_STRONG_PASSWORD@127.0.0.1:15432/daws` for both URLs.

**Why 15432 and not 55432.** It used to be 55432, which sits inside Windows'
ephemeral port range (49152-65535 by default: `netsh int ipv4 show dynamicport
tcp`). Windows hands those out to whatever asks, and reserves blocks of them
across a reboot, so eventually something claims the port while Docker is not
holding it. The container then refuses to start with

```
ports are not available: ... bind: An attempt was made to access a socket in
a way forbidden by its access permissions
```

which reads like a permissions problem and is not one - nothing is listening,
the port is simply spoken for. Anything below 49152 is never taken this way.

If you hit it on a container you cannot move, an administrator can free the
block with `net stop winnat`, start the container, then `net start winnat`.

**Note:** `DIRECT_URL` is only used during migrations and is configured in `prisma.config.ts`.
If `DATABASE_URL` points at a pooler, `DIRECT_URL` must not.

### 4. Generate Prisma Client

```bash
npm run prisma:generate
```

This generates the Prisma Client with your database schema types.

### 5. Run database migrations

Create and apply the initial database schema:

```bash
npm run prisma:migrate
```

When prompted, enter a descriptive name for the migration (e.g., `initial_schema`).

This will:
- Create all tables defined in `prisma/schema.prisma`
- Generate SQL migration files in `prisma/migrations/`
- Apply the migration to your database
- Regenerate the Prisma Client

### 6. Start the development server

```bash
npm run dev
npm run dev -- --host
```

The application will start with hot-reload enabled. You should see:
```
Database connection established.
```

## Available Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start development server with hot-reload (using tsx) |
| `npm run build` | Compile TypeScript to JavaScript |
| `npm start` | Run the production build |
| `npm run prisma:generate` | Generate Prisma Client from schema |
| `npm run prisma:migrate` | Create and apply new migrations |
| `npm run prisma:studio` | Open Prisma Studio (database GUI) |

## Project Structure

```
backend/
├── prisma/
│   ├── schema.prisma          # Database schema definition
│   └── migrations/            # Migration history (generated)
├── src/
├── lib/
│   ├── env.ts              # Environment config with validation
│   ├── errors.ts           # Error handling utilities
│   ├── password.ts         # scrypt password hashing
│   ├── tokens.ts           # JWT issue / verify
│   └── storage.ts          # local file storage
├── middleware/
│   ├── auth.ts             # Bearer token verification
│   └── errorHandler.ts     # Global error handler
├── routes/
│   ├── auth.routes.ts      # Login & refresh endpoints
│   └── users.routes.ts     # Protected user routes
└── index.ts                # Express app setup
├── prisma.config.ts          # Prisma v7 configuration
├── tsconfig.json             # TypeScript configuration
├── package.json              # Dependencies and scripts
└── .env                      # Environment variables (not in git)
```

## Database Schema Overview

The system includes the following core entities:

- **Users & Departments**: User management with department associations
- **Documents**: Document metadata and status tracking
- **Document Versions**: Immutable version history
- **Approval Chains**: Configurable multi-stage approval workflows
- **Approval Chain Steps**: Individual review/approval stages
- **Workflow Runs**: Execution instances for each document submission
- **Approval Actions**: Audit trail of all approval decisions
- **Notifications**: User notifications for workflow events
- **Audit Logs**: Comprehensive system activity logging

## Development Tools

### Prisma Studio

Launch an interactive database browser:

```bash
npm run prisma:studio
```

This opens a web interface at `http://localhost:5555` where you can:
- View and edit data
- Explore relationships
- Run queries

### Database Migrations

**Create a new migration:**
```bash
npx prisma migrate dev --name migration_name
```

**Apply migrations in production:**
```bash
npx prisma migrate deploy
```

**Reset database (⚠️ deletes all data):**
```bash
npx prisma migrate reset
```

## Technology Stack

- **Runtime**: Node.js with TypeScript
- **Database**: PostgreSQL (v14+)
- **ORM**: Prisma v7
- **Database Adapter**: @prisma/adapter-pg
- **Environment**: dotenv
- **Dev Tools**: tsx (TypeScript execution with hot-reload)

## Authentication

Authentication is handled entirely by this API — there is no external identity provider.

- Passwords are hashed with **scrypt** (`node:crypto`, no native module) and stored in
  `users.password_hash`. The cost parameter is embedded in each record, so it can be raised
  later without invalidating existing hashes.
- Login returns a short-lived **access token** (2h) and a **refresh token** (30d), both signed
  with `JWT_SECRET` using HS256. Each carries a `typ` claim, so a refresh token cannot be
  replayed as an access token.
- `POST /api/auth/login` and `POST /api/auth/refresh` are public. Everything else requires
  `Authorization: Bearer <accessToken>`.
- Creating users is admin-only, via `POST /api/auth/sign-up` or the Administration screen.

## Seeding the first administrator

```bash
npm run seed
```

Creates the departments and one ADMINISTRATOR — `admin@example.com` / `password` by default.
Override with `SEED_ADMIN_EMAIL` and `SEED_ADMIN_PASSWORD`; the seed refuses to use the default
password when `NODE_ENV=production`. Safe to re-run.

## File storage

Signed PDFs and signature images are written to `STORAGE_DIR` (default `./storage`), under
`documents/` and `signatures/`. Files are served only through authenticated API routes, never as
static assets. Back this directory up — losing it loses the documents.

## Project layout

- `src/routes` — Express routers, one per resource
- `src/services` — business logic; routes stay thin
- `src/middleware` — `authenticate`, `requireAdmin`, validation, error handling
- `src/lib` — `password`, `tokens`, `storage`, `env`, `errors`, `pdfSignature`
- `src/schemas` — zod request schemas

## Troubleshooting

### TypeScript errors with `process.env`

If you see errors about `process` not being defined:
1. Ensure `@types/node` is installed (already in devDependencies)
2. Restart your TypeScript server: `Ctrl+Shift+P` → "TypeScript: Restart TS Server"

### Migration failures

- Ensure your `DATABASE_URL` is correct and accessible
- Check that your database user has CREATE TABLE permissions

### Connection issues

- Verify your database is running
- Check firewall rules for PostgreSQL port (5432)

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/your-feature`
3. Commit your changes: `git commit -m 'Add your feature'`
4. Push to the branch: `git push origin feature/your-feature`
5. Open a Pull Request

## License

ISC

## Support

For issues and questions, please open an issue on the [GitHub repository](https://github.com/favshahzad-collab/daws/issues).
