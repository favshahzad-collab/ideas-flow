# Production deployment

DAWS is two apps: a React UI (`frontend`) and an Express API (`backend`). They must be served on the **same origin**. The UI calls `/api/...` with no separate API URL. In development Vite proxies `/api` to port 3000; in production a reverse proxy must do the same.

## What to provision

- Node.js 18 or newer
- PostgreSQL 14 or newer
- A writable directory for uploaded files
- A reverse proxy (IIS, nginx, Caddy, or similar), and a TLS certificate for it
- A hostname, and the DNS record pointing it at the server
- A process manager for the API (Windows Service, NSSM, PM2, or systemd)

There is no external auth or storage provider. Authentication is issued and verified by this API, and uploaded documents live on disk.

## Environment (backend only)

Copy [`backend/.env.example`](backend/.env.example) on the server.

```env
DATABASE_URL=postgresql://USER:PASSWORD@HOST:PORT/DATABASE
DIRECT_URL=postgresql://USER:PASSWORD@HOST:PORT/DATABASE
JWT_SECRET=<32+ random characters>
STORAGE_DIR=/var/lib/daws/storage
PORT=3000
NODE_ENV=production
TRUST_PROXY=1
```

Use `DIRECT_URL` for Prisma migrations. `DATABASE_URL` may use a pooler.

**`JWT_SECRET` is required in production** and must be at least 32 characters — the API refuses to start otherwise. Generate one with `openssl rand -base64 48`. Changing it invalidates every existing session.

**`STORAGE_DIR`** must be writable by the API process and must persist across deploys. It holds the signed PDFs and signature images, so it belongs on durable storage and in your backup schedule — losing it loses the documents. Keep it outside the web root; it is served only through authenticated API routes, never as static files.

Every file under it is written once and never rewritten, and a SHA-256 of each is stored on the row that points at it. The API checks the file against that digest before serving it and refuses a document that no longer matches what was signed. Two things follow for an operator: restoring `STORAGE_DIR` from a backup taken at a different moment than the database will make the affected memos unservable rather than quietly wrong (**restore the two together**), and a mismatch reported to you is a real finding — the log line names the document and the path.

**`TRUST_PROXY` must be set if anything stands in front of the API**, and the
configuration below puts nginx there. Express reads the client's address off
the socket unless told otherwise, and behind a proxy that address is the
proxy's — so without this, three things go quietly wrong at once: every
approval's audit row records the proxy instead of the approver, the
per-address sign-in cap becomes a cap on **the whole organisation** (forty
failed attempts by anyone locks out everyone for fifteen minutes), and the
per-account cap loses the half meant to keep one office off another's back.
`TRUST_PROXY=1` for the single proxy below; a number for each additional hop.

A count rather than `true`: `true` believes the left-most `X-Forwarded-For`
entry, which any client can write. A count makes Express walk in from the
socket end and stop at the address the proxy itself appended, which is why
`$proxy_add_x_forwarded_for` in the configuration below is the correct pairing
and a client sending its own `X-Forwarded-For` is ignored.

**Email is optional, and off until you configure it — and you can now do that
in the application.** **Administration → Mail** holds the mail server, the
address notices come from, and the address people click in an email; it takes
effect immediately, without a restart, and it wins over the variables below.
The SMTP password is encrypted at rest with a key derived from `JWT_SECRET` —
which means **rotating `JWT_SECRET` makes that password unreadable** and the
screen will ask you to type it in again.

The environment still works and is still the better place for a credential if
you manage configuration that way: set `SMTP_HOST` and `MAIL_FROM` together (plus `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD` and `SMTP_SECURE` as your relay needs) and set `APP_URL` to the address people reach the application on — it is what the links in those emails point at. With none of it set the application runs exactly as before: every notice is still written to the recipient's inbox in the app and to the outbox table, nothing is delivered, and the API says so once at startup rather than failing quietly.

### Which provider

Two, and on Microsoft 365 the choice is not close.

**Microsoft Graph — recommended.** The backend authenticates as itself with the
client credentials flow and hands the message to Exchange Online through the
API. It never touches SMTP, so **SPF is not in the way**: there is no relay for
a DNS record to authorise, and the failure mode an SPF record causes when it is
wrong — notices delivered to Junk, memos quietly sitting — cannot happen. There
is no user sign-in, no consent prompt at send time and no callback URL, so the
server never needs to be publicly reachable for mail to work.

What you need, once, in Entra ID:

1. Register an application. Note the **Directory (tenant) ID** and the
   **Application (client) ID**.
2. Add the **`Mail.Send`** permission of type **Application** — not Delegated —
   and **Grant admin consent**.
3. Create a **client secret** and copy its **Value** (not its Secret ID; they
   look alike and only one of them works).
4. Put the three into **Administration → Mail**, with the sending address.

`Mail.Send` is the only permission to grant. In particular **do not add
`User.Read.All`**: sending needs `POST /users/{mailbox}/sendMail`, which
`Mail.Send` covers on its own, and a directory read is a far larger grant than
this application has any business holding.

One consequence to expect. **Test connection** acquires a token — which is
conclusive about the tenant ID, the client ID and the secret, because Entra
issues none if any of them is wrong — and then tries to read the mailbox out of
the directory, which `Mail.Send` alone is not allowed to do. So it reports the
mailbox as unconfirmed and says so. That is the correct result for a correctly
scoped application, not a fault. **Send a test email** is what proves the
mailbox and the send permission.

> **The permission is tenant-wide.** `Mail.Send` as an application permission
> lets that app send as *any* mailbox in the directory. Naming one in the
> application does not restrict it and cannot: the token is honoured by
> Exchange, not by this code. Bind it properly with an application access
> policy:
>
> ```powershell
> New-ApplicationAccessPolicy -AppId <client-id> `
>   -PolicyScopeGroupId ideas-flow-senders@ideas.com.pk `
>   -AccessRight RestrictAccess `
>   -Description "Ideas Flow may only send as noreply"
> ```
>
> where the group contains only the sending mailbox. Test it with
> `Test-ApplicationAccessPolicy`. Until this exists, a compromised backend can
> send as anyone in the organisation.

**SMTP — the alternative.** For any other mail server, and still perfectly
serviceable on Microsoft 365. It needs the sending host authorised in your SPF
record, which Graph does not. On Microsoft 365 use `smtp.office365.com`, port
`587`, with **TLS off** — that port starts in the clear and upgrades with
STARTTLS. Turning TLS on there produces
`ssl3_get_record:wrong version number`, which reads like a certificate problem
and is not one.

### Where to set it

Either place works. They are not equal, and it is worth knowing which you are
using — the **Administration → Mail** screen says so at the top.

| | In the application | In the environment |
|---|---|---|
| Where | **Administration → Mail** | `backend/.env`, or the service's environment file |
| Takes effect | immediately | on restart |
| Who can change it | any administrator | whoever has a shell on the server |
| The password lives | encrypted in the database | in a root-only file |
| Wins when both are set | **yes** | no |

Stored settings win deliberately: an administrator who fills in the form expects
the form to be what happens, and a variable quietly overriding it would be
undebuggable from inside the application — the screen would show one thing and
the queue would do another. The screen has a **Hand back to the server** button
that deletes the stored row and returns the environment to charge, which is the
way out of a configuration that cannot reach a relay for somebody who has no
shell either.

### Turning it on against Microsoft 365

Every recipient here is a colleague, so the simplest method Microsoft offers is
the one that fits: **Direct Send**. No mailbox, no licence, no credentials, no
connector.

| | |
|---|---|
| `SMTP_HOST` | your MX endpoint — `yourdomain-com.mail.protection.outlook.com` |
| `SMTP_PORT` | `25` |
| `SMTP_SECURE` | `false` — port 25 starts in the clear and upgrades with STARTTLS |
| `SMTP_USER` / `SMTP_PASSWORD` | leave unset |
| `MAIL_FROM` | any address in an accepted domain; it does not need a mailbox |

The catch is in the name: Direct Send delivers **only to your own domains**.
Every approver is internal, so that is fine — but the day somebody routes a
memo to a contractor on an outside address, it will not arrive.

**Add the sending server to your SPF record.** Microsoft's own guidance says
so for both Direct Send and relay, and the failure mode without it is not a
bounce: approval notices land in Junk, nobody sees them, and the memos simply
sit. That looks exactly like an application that is not sending mail.

If you need to reach outside addresses too, use **SMTP relay** instead: the
same host and port, plus an inbound connector in the Exchange admin centre
authenticated by a TLS certificate (Microsoft's recommendation) or by a static
public IP. Note that a static, unshared address is required — a dynamic one is
not supported, and a shared one is somebody else's reputation.

**Avoid client SMTP submission** (`smtp.office365.com:587` with a username and
password) unless you have a reason. It needs a licensed mailbox, it is the path
Microsoft has been steering applications away from, and it ties approval
notices to one person's credentials.

### Proving it works

Set the variables, restart, then open **People & delegation** and press **Send
a test** on the Email notices card. It sends a real message through the real
transport to your own address — not to any address, because an endpoint that
mails chosen text to a chosen address is an open relay — and shows you what the
server said. `connect ECONNREFUSED` is a firewall or the wrong host;
`535 5.7.3 Authentication unsuccessful` is credentials; `5.7.64 TenantAttribution`
means the connector did not recognise the sender.

The card also shows the host, the sender and **what the links in every notice
will point at**. Read that last one twice. `APP_URL` falls back to the
development UI, so a deployment that configures mail perfectly and forgets it
sends every approver a link to `localhost` — the mail is accepted, the queue
reads clean, and nothing else in the product would ever mention it. The card
warns when that is the case, and so does the log at startup
(`mail.app_url_missing`).

Delivery is a sweep over a queue, not part of the request: a notice is written in the same transaction as the approval that caused it, and sent afterwards. An unreachable mail server therefore delays notices instead of failing approvals. A message is retried for ten sweeps, given up on immediately if the server refuses it outright (a 5xx), and expired unsent after 24 hours — a mail server that comes back after two days must not post a backlog of stale approval requests. `GET /api/admin/mail` (administrators only) reports the counts by state and the last refusals with the reason each was given, which is the answer to "why was I never told?".

**`SLA_DEFAULT_DAYS` decides whether this deployment has deadlines at all.**
Unset - the delivered default - and no approval step has one: the queue shows
how long a memo has been waiting, which is true, and nothing is ever chased.
Set it to a whole number and every step gets that many **working days** from
the day after the memo reaches its approver, unless the chain or the workflow
template names its own. Weekends are skipped, and so are the **public holidays**
an administrator keeps under Workflow policy → Office calendar.

A step past its deadline is *told about*, not routed around: the approver
holding it, whoever is covering for them, and the person who prepared it are
each notified once, and the memo still needs that signature. Two working days
after that, if it has still not moved, it is **escalated**, once: the
approver's line manager (set on People) and the administrators holding the
Control room power are told. `SLA_SWEEP_MINUTES` (default 15) sets how often
both are looked for.

Deadlines end at midnight in the **office time zone**, set under Workflow
policy → Office calendar. Until one is saved, `OFFICE_TIME_ZONE` (an IANA name
such as `Asia/Karachi`) answers, and without that UTC - which is how deadlines
were always counted.

**The audit ledger seals itself**, and there is nothing to configure for it.
Every audit record carries a digest over its own contents and the digest of the
record before it, so a record edited or deleted in the database invalidates
every record after it. Sealing runs as a sweep rather than inside the write -
chaining has to be serialised, and an approval must not queue behind somebody
else's audit row - so a record is sealed shortly after it is written rather
than at the moment. `LEDGER_SEAL_SECONDS` sets that interval; it defaults to 30
and the minimum is 5.

Two things follow for an operator. `ledger_checkpoints` is part of the
evidence, not a cache: it records where the chain had reached each time a batch
was sealed, and it is the only thing that catches records removed from the
*end* of the trail, so **back it up with the rest of the database and never
truncate it**. And the tip digest reported by `GET /api/audit/ledger` is worth
recording somewhere outside this database - a monitoring check, a monthly note
in the file - because a chain rebuilt from scratch by someone with write access
is consistent with itself, and a digest you wrote down last month is what makes
that visible. `POST /api/audit/ledger/verify` (administrators only) reads the
whole chain back and names the first record that does not match.

### Protecting the audit ledger in the database

The chain *catches* an edited or deleted record; since migration
`20260929180000_protect_audit_ledger` the database also *refuses* one. Two
triggers:

- **`audit_logs`**: any `DELETE` is refused. An `UPDATE` is refused unless it
  is the sealer's - giving a row that has no `seq` yet its `seq`, `hash`,
  `prev_hash` and `sealed_at`, with every other column exactly as it was.
  Re-sealing, unsealing and changing content are all refused.
- **`ledger_checkpoints`**: any `UPDATE` or `DELETE` is refused.

A refusal is an error with SQLSTATE `23000` and a message beginning
`audit_logs is append-only`. One consequence worth knowing: **a user who ever
acted can no longer be deleted even from a database prompt**, because the
foreign key would blank their name on the audit rows. People are switched off,
never deleted, and the database now holds that line too.

What it does **not** stop: `TRUNCATE` (row triggers do not fire for it), and
the tables' owner, who can `ALTER TABLE ... DISABLE TRIGGER`. The hash chain and
the checkpoints are what catch those, which is why the tip digest is worth
writing down somewhere else. To close the owner gap, run the API as a database
role that does not own the tables - owner for migrations, a separate role with
`SELECT, INSERT, UPDATE` for the application. That is a change to how the
database is set up, not to this code, and is listed in the enterprise roadmap.

**Applying it.** It is an ordinary migration: `npx prisma migrate deploy`, as
for every release. It changes no data and takes a moment. It needs the
go-ahead of whoever owns the live database, and the check afterwards is:

```sql
SELECT tgname FROM pg_trigger
WHERE tgname IN ('audit_logs_append_only', 'ledger_checkpoints_append_only');
-- two rows
```

and `POST /api/audit/ledger/verify` still reporting the chain intact.

**Removing it**, should that ever be necessary (it takes the owner):

```sql
DROP TRIGGER audit_logs_append_only ON audit_logs;
DROP TRIGGER ledger_checkpoints_append_only ON ledger_checkpoints;
DROP FUNCTION audit_logs_append_only();
DROP FUNCTION ledger_checkpoints_append_only();
```

**`ALLOW_STEP_SKIP`** is off unless you set it to `true`. Left alone, no approval on a chain can be passed over by anybody: every approver signs for themselves, which is what the audit ledger then says. Setting it to `true` restores the preparer's ability to skip a non-final approver — with a written reason, an audit row and a comment naming who was passed over — and is a decision to make deliberately.

Nothing needs setting in the frontend build to match it. The button follows the server's answer, read from `GET /api/auth/me`, so the two cannot disagree. There was a `VITE_FEATURE_STEP_SKIP` build flag and it was deliberately removed: once the setting became a row an administrator could change, a compiled bundle could no longer follow it, and the flag's only remaining effect was to hide a button the API would have allowed or show one it would refuse.

**Administration → Workflow policy** stores that row, and it wins over this variable entirely — including when an administrator clears it. The variable is the answer for a deployment that has no such row.

## Build and run

### Checking the ledger outside the application

An auditor can check the whole audit ledger without access to this application or its database.

**Taking the export.** An administrator opens **Audit ledger** and presses **Export for auditor**. They are asked to confirm it is them, because the file carries every record's content, IP addresses included, and the export is itself written to the ledger (`LEDGER_EXPORTED`). The file is named `ideas-flow-ledger-YYYY-MM-DD.jsonl`.

**Checking it.** Give the auditor the file and `backend/scripts/verify-ledger-export.mjs`. The script needs nothing but Node, no packages and nothing from this repository:

```
node verify-ledger-export.mjs ideas-flow-ledger-2026-10-05.jsonl
```

It prints `VERIFIED: …` and the last digest, and exits 0, when every record's digest recomputes from its content, every record links to the one before, positions run without a gap, and every checkpoint names a record that is present with the same digest. It prints `NOT VERIFIED: …` and exits 1 at the first record that was changed after sealing, or when the chain was cut short or rebuilt. Comparing the last digest with one written down earlier, outside this system, closes the remaining gap: somebody with database access rewriting the whole chain.

**The format**, for anybody who would rather check it with their own tool. JSON Lines. The first line is a header: `format` (`ideas-flow-ledger`), `version` (1), `exportedAt`, `genesisHash` (64 zeros, what comes before record 1) and `checkpoints` (`seq`, `hash`, `sealedAt`, taken each time records were sealed). Every other line is one record: `seq`, `prevHash`, `hash`, `sealedAt` and `record` (`id`, `actorId`, `action`, `entityType`, `entityId`, `oldValue`, `newValue`, `ipAddress`, `userAgent`, `createdAt`). A record's `hash` is the SHA-256, as lowercase hex, of the UTF-8 bytes of this JSON, with no spaces and keys in exactly this order:

```
{"v":1,"seq":"<seq>","prevHash":"<prevHash>","id":…,"actorId":…,"action":…,"entityType":…,"entityId":…,"oldValue":…,"newValue":…,"ipAddress":…,"userAgent":…,"createdAt":"<ISO 8601>"}
```

`seq` is a string. `oldValue` and `newValue` have their object keys sorted, at every depth, and are `null` when empty.

**Other evidence on each memo.** Every signature's ledger entry records the SHA-256 of the signature image that went on the page (`signatureImageChecksum`). The final approval's entry, and the memo itself (shown beside its fingerprint), record whose digital seal the approved file carries, or that it carries none. Replacing or removing a saved signature asks the person to confirm it is them, and is recorded (`SIGNATURE_SAVED`, `SIGNATURE_REMOVED`) with the image's fingerprint.

### Backend

```bash
cd backend
npm ci
npx prisma generate
npx prisma migrate deploy
npm run build
npm start
```

`migrate deploy` applies existing migrations. Do not use `npm run prisma:migrate` in production (that is `migrate dev`).

**The Prisma client is regenerated for you.** `npm ci` (through `postinstall`), `npm run build` and `npm run dev` each run `prisma generate` first, so the explicit step above is belt and braces. It matters because the client in `src/generated/prisma` is not committed: an update that adds a column, run without regenerating, starts normally and then fails with a 500 on the first query that names the column. Workflow studio and the template picker did exactly that after template archiving shipped. If you ever start the API some other way (`tsx src/index.ts`, or a copied `dist/`), run `npx prisma generate` yourself after every update.

**`npm ci`, not `npm ci --omit=dev`.** Both the build (`tsc`) and the seed (`tsx`) are development dependencies. A production-only install cannot compile the API or create the first administrator. Install everything, build, and then prune if you want to — `npm start` itself runs plain Node against `dist/`.

To create the first administrator, set the five `SEED_ADMIN_*` variables and
run `npm run seed`:

```bash
SEED_ADMIN_EMAIL=firstname.lastname@example.com \
SEED_ADMIN_PASSWORD='<strong>' \
SEED_ADMIN_FIRST_NAME=Firstname \
SEED_ADMIN_LAST_NAME=Lastname \
SEED_ADMIN_DESIGNATION='Head of Human Resources' \
npm run seed
```

The seed refuses to run in production without a password. It is safe to
re-run; it upserts, updating the password and designation but never the name.

**Set the address and the name, not just the password.** Both default to a
demo identity — `admin@example.com`, called "Admin User" — and neither is
cosmetic. Mail is delivered to that address, so an account nobody can receive
mail at cannot be recovered; and the first and last name are printed under
that person's signature on every memo they sign, which is a thing the ledger
keeps for good.

Getting it wrong is awkward to undo rather than impossible: the account can be
renamed and re-addressed from **People & delegation**, but it cannot be
deleted once it has prepared or signed anything — the API refuses, because
removing it would orphan the audit ledger. Demoting it to a plain user is the
available exit, and even that is refused while it is the only administrator.

**Do not run `npm run seed:demo` on a real server.** It invents five people
and fifteen memos. It refuses to run against a production database, but the
refusal keys off `NODE_ENV`.

The API listens on `PORT` (default 3000).

### It checks its environment before it starts

Every environment variable is checked once, at startup (`src/lib/config.ts`),
and a value the code cannot use stops the API with every problem named:

```text
The environment has 2 problems:
  - SLA_DEFAULT_DAYS must be a whole number from 1 up
  - ALLOW_STEP_SKIP must be true or false
```

Until this version those values were silently replaced by their defaults -
`SLA_DEFAULT_DAYS=5d` meant no deadline, `ALLOW_STEP_SKIP=yes` meant no,
`NODE_ENV=prod` meant development. **So a server whose environment has a typo
in it that nobody noticed will now refuse to start.** Before deploying this
version, run the same check against that server's environment, without
starting anything:

```bash
cd backend
npm run check:env
```

It exits 0 and says so when the API would start. It reads the database once,
to see whether `APP_URL` is stored on **Administration → Mail**, and writes
nothing.

In production two more things are required, where they used to be warnings:

- **`TRUST_PROXY`**, set to what is actually in front of the API: `1` behind
  the one reverse proxy below, or `false` if nothing is. Unset used to mean
  "no proxy", and behind one that records the proxy as every approver.
- **`APP_URL`**, in the environment or on **Administration → Mail**. Without
  either, every emailed link points at `localhost`.

### Stopping it

On `SIGTERM`, `SIGINT` (Ctrl+C) or `SIGBREAK`, the API stops taking requests,
lets the ones in flight finish and the mail, ledger and deadline sweeps finish
any pass under way, then closes mail and the database and exits 0. If that has
not happened within **9 seconds** it exits 1 anyway and logs
`server.stop.timeout`. A second signal exits at once.

Your process manager has to wait that long before it kills the process, and
two of them do not by default:

| Process manager | Sends | Waits by default | Set |
| --- | --- | --- | --- |
| systemd | SIGTERM | 90 s | nothing |
| Docker | SIGTERM | 10 s | nothing |
| PM2 | SIGINT | 1.6 s | `kill_timeout: 12000` in the ecosystem file |
| NSSM (Windows service) | Ctrl+C | 1.5 s | `nssm set daws AppStopMethodConsole 12000` |

With the defaults on PM2 or NSSM the process is killed mid-shutdown, which is
what happened on every restart before this version too - it is just now
something you can fix.

### `backend/assets/` must be deployed alongside `dist/`

The API generates memo PDFs itself, and it reads the typefaces and the
letterhead for them from `backend/assets/`:

```
backend/assets/fonts/   PlusJakartaSans-{Regular,Italic,SemiBold,Bold,BoldItalic}.ttf
                        OFL.txt  — the licence these are redistributed under
                        LiberationSerif-{Regular,Italic,Bold,BoldItalic}.ttf
                        LiberationSans-{Regular,Italic,Bold,BoldItalic}.ttf
                        LIBERATION-LICENSE  — SIL Open Font Licence, for both
backend/assets/brand/   ideas-logo.png
```

**`tsc` does not copy this directory.** It is not TypeScript, so a deployment
that ships only `dist/` and `node_modules/` will build cleanly, start
cleanly, serve every existing memo, and then fail the first time somebody
submits a typed memo. Copy `assets/` with the rest of the backend.

The failure is deliberately loud rather than silent — the renderer refuses to
start a document it cannot set — and it names the file it could not find.

There is no new environment variable. The directory is located by walking up
from the running module, so it works the same under `dist/`, under `tsx`, and
under the test runner, with nothing to configure.

**Nothing is fetched at render time.** The fonts are on disk precisely so that
a server with no route out can still produce a memo. This is the one place the
backend differs from the frontend, which does pull the same two families from
Google Fonts and degrades to system faces when it cannot.

A memo containing characters these fonts cannot draw — Arabic script, for
instance — is **refused at submission** with a message naming the characters.
That is on purpose: the alternative is a row of empty boxes sealed into an
immutable, digested artefact and signed by four people. If a deployment needs
another script, add a font that covers it to `assets/fonts/` rather than
removing the check.

### Drawing a memo costs CPU, on the thread that serves everybody

`POST /api/memo-drafts/preview` renders the memo so the preparer has a page to
place their signature on. It is the only route in the API that does a
measurable amount of work per request — it embeds five typefaces and lays out
up to 120,000 characters — and Node runs it on the one thread that is also
serving every other request.

It is rate limited to 150 calls per fifteen minutes **per account**, which is
far more previewing than anybody does while writing a memo and far less than a
loop could hold the event loop for. Nothing is written down by it: no
document, no version, no reference number, no audit row. A preview is not an
artefact and must never be mistaken for one.

If previews are slow on a small VM, that is the renderer, not the database.

### Where signatures land on a generated memo

A typed memo prints a signature strip at its foot — one ruled line per
signatory, in signing order, starting with the preparer — and the renderer
records the position of each line on `document_versions.signature_slots`.
That column is what lets the signing screen open with each person's signature
already on their own line months later, when the branding may have changed and
the chain may have been reassigned. It is written once, with the version, and
never recomputed.

**The strip sits at the very foot of the last page**, with nothing under it
but the bottom margin, however short the memo is; a memo long enough to
reach it moves it to the foot of a new page. It used to sit under the last
sentence, pushed down fifty points at most, which left the rest of the page
blank beneath the signatures. Each signature now sits on its line; the
sixteen points once kept between the mark and the line, for the date, are
down to two.

**On a typed memo, no capacity and no date are printed under a
signature.** Each used to carry *Approver · 26 Sep 2026* or *Final Approver
· …* under the mark, and the preparer’s a bare date. On a memo whose strip
already names each signatory these read as the system’s tags on a signed
document, so the page shows the signature over the name and post, as a paper
memo does. Who signed, in what capacity and when is in the audit ledger and
the document’s history, as it always was. A delegate, who signs off the strip
because it prints somebody else’s name, still gets their name, post and
*Signed for …* under the mark, without the capacity or the date.

Uploaded memos have no strip, and the column stays null for them. **An
uploaded memo keeps the name, the post and the capacity** under each
signature — *Reviewer*, *Approver*, *Final Approver* — because on a file with no
printed strip that is the only thing saying in what capacity somebody signed.
**No signature on any document carries a date**: when each person signed is
in the audit ledger and the document’s history. Documents already signed, of
either kind, keep what they were stamped with: a signed file is never
redrawn.

**People are switched off, never deleted.** `actor_id` is part of the hashed
audit record AND its foreign key is `ON DELETE SET NULL`, so removing an
account silently rewrote the content of every audit row naming them and
`ledgerService.verify()` then reported the chain as tampered with. The API
used to allow that deletion for anybody with no memos, approvals or comments,
which still included anybody who had only signed in, set up two-step sign-in
or saved a signature. There is now no way to delete a person, neither on
**People & delegation** nor through the API (`DELETE /api/admin/users/:id`
answers 404). **Switch account off** is the removal: the person cannot sign
in, every session they held ends, and they drop out of every picker, while
everything they did still names them.

Do not delete a row in `users` by hand either, for the same reason. Old
`USER_DELETED` rows stay in the trail, from before this change.

### Every line of the printed header is the preparer's

To, From, Subject and Date are all typed by whoever writes the memo. The one
worth knowing about is **Date**, because it is not the date the memo was
submitted: a memo written on the 6th, agreed verbally and put through the
system on the 11th is dated the 6th, and the header prints that. It defaults
to today and stays editable, including on a revision — where it keeps the
date the memo already bears unless the preparer changes it.

`documents.memo_date` is a DATE, not a timestamp. `submitted_at` still records
when the memo actually entered the workflow, and the audit ledger is unchanged;
nothing about *when things happened* is taken from the printed date.

The date-only column also matters for a reason that is not about dates: the
PDF's own creation and modification timestamps are pinned to it, so two
renders of the same memo on the same day are byte-identical. That is what
makes the preview a preparer places their signature against the same drawing
that gets filed.

### A signature goes on the line the memo prints for it

A signature is placed on that person's ruled line, wherever on the page the
pen happened to travel or the box was dropped — the ink is the mark, the line
is the place. Somebody who has a line signs on it; there is nowhere else for
their signature to go.

**Nobody can sign on anybody else's line.** The strip is printed on the page,
so where every line sits is known to everyone entitled to read the memo — it
is not, and could never be, a secret. What is enforced is the *write*: a
request whose coordinates land inside another signatory's slot is refused
outright rather than quietly moved, because silently correcting it would file
a valid-looking document and leave nothing behind saying somebody tried. The
refusal lives in `approval.service` and `documents.service`, not on the
screen, so it holds for anything that talks to the API.

An uploaded PDF prints no strip. There are no lines on one, so nothing to land
on and nothing to protect: every signature is placed by hand exactly as before.

### The kinds of memo a preparer can write

Listed in `backend/src/lib/memoTypes.ts`, deliberately as data rather than as a
Prisma enum: adding one is a few lines of configuration, not a schema migration
applied by a deployment.

Two are delivered:

- **Approval Request** - a recommendation put to management for approval: an
  allowance, a purchase, a change in terms. It hands over the three-part shape
  the paper form has always had (`BACKGROUND:`, `Details:`, `Recommendation`)
  and states that its preparer signs, because whoever writes it recommends it
  in their own name. It replaced a Fuel Request type whose outline said
  `Employee Details:` - right for an allowance memo and wrong for every other
  recommendation on the same structure. Removing that type was safe only
  because no document had been filed against it.
- **Office Memorandum** - anything else. No outline, because its subject and
  department change with every memo written, and whether preparing one means
  signing it is left to the organisation's policy.

Choosing a type does four things: it seeds the body with that type's outline,
pre-fills the approval chain from its `defaultTemplateName`, decides whether
the preparer gets a column on the printed signature strip, and is stored on the
document as `documents.memo_type`.

Two rules worth knowing:

- **A key is permanent.** Documents are filed carrying it, so renaming one
  orphans every memo that used it. Add a type; never rename one.
- **An outline never overwrites prose.** It is offered only to a body holding
  no prose - judged by prose, not by characters, so changing your mind between
  types does not strand the first one's headings.

**Adding a type** means one entry in `DEFINITIONS`: a `key`, a `label`, a
one-line `description`, optionally `outlineHeadings` and a `defaultTemplateName`,
and `preparerSigns` only where the type should overrule the organisation's
policy either way. Leaving `preparerSigns` unset is the normal case.

With exactly one type the composer chooses it and hides the question, because
choosing is required and a question with one answer is only an obstacle. The
kind of memo still shows on the card header.

### The page a memo is drawn on

**Administration -> Page setup.** Choose A4 or US Letter, and set the four
margins in millimetres. Left and right are separate, so an organisation that
files memos in a punched binder can leave a wider gutter down one side.

The delivered default is A4 with 43.2pt (about 15mm) left and right and 57.6pt
(about 20mm) top and bottom - the proportions of the paper form the template
was drawn from. A deployment that never opens this screen draws documents
**byte-identical** to the ones it drew before the screen existed.

Two things to know before changing it:

- **It applies to the next memo drawn, and to nothing already filed.** Each
  version records the page it was drawn on in `document_versions.page_setup_json`,
  and the stored PDF is never re-rendered. That is deliberate: the artefact is
  immutable and hashed, its checksum is cited in the audit ledger, and a memo
  re-drawn on a page somebody changed afterwards would no longer match the
  document its approvers signed. A version drawn on the default records
  nothing, so an empty column reads as "the page it has always been".
- **It is refused rather than quietly adjusted.** A margin under 18pt or over
  216pt, or a pair that leaves less than 200pt to write on, is rejected with a
  message naming the edge to change. The renderer clamps as well, but only as
  a floor against a value that reached the database some other way - the
  screen never silently draws something other than what it was set to.

The setting lives on the branding row beside the organisation name and
letterhead, and every change is audited as `PAGE_SETUP_UPDATED` with the page
it changed **from** as well as to. Its capability is `documents.pageSetup`,
separate from the workflow policy: being able to set the approval deadline and
being able to change how every memo in the organisation is drawn are different
permissions.

The compose screen follows the setting - the sheet a preparer types on is the
width the memo will actually be filed at, because that is where a table's
columns are measured and where a line wrap is judged.

### Shaping a table in a memo

A details table in a memo can be shaped the way one is in a word processor.
With the caret inside a table a second toolbar appears, headed **Table**: add
and remove rows and columns, merge cells and split them again, and make a
column narrower or wider and a row shorter or taller. The same two boundaries
can be dragged directly — put the pointer on a cell's right or bottom edge and
the cursor changes.

Three measurements are stored with the table, and only when somebody sets one:

* **Column widths**, as fractions of the memo's text column. Fractions rather
  than points because the sheet on screen is a scaled A4 and the PDF is drawn
  in points; a fraction is the one number both agree on without either having
  to know how large the other is being shown.
* **A row height**, in points. It is a **minimum, never a maximum**. A row made
  roomier stays roomy; a row whose content outgrows it still grows, because a
  clipped cell would lose a figure off a document somebody has signed and
  nothing downstream could say it had happened.
* **Merged cells**, horizontally.

**A table nobody has shaped carries none of these and is drawn exactly as it
always was** — sized from its content, by the algorithm that gives a narrow
column of employee ids room before it gives a wide column of department names
more. That is most tables, and every table filed before any of this existed.

**There is no vertical merge, deliberately.** A cell merged down the page has
no honest drawing when the rows it spans fall either side of a page break, and
a memo's table repeats its header row precisely because it is expected to
cross pages. A merge that worked until the memo got long would be worse than
none.

**Two rules the server enforces**, and refuses a submission that breaks either.
Every row must cover the same number of columns, counting a merged cell as the
columns it covers — otherwise the figures stop lining up with the headings
above them. And the widths, where a table has any, must number exactly as many
as there are columns: a set left over from before a column was added no longer
describes the table, and there is no way to guess which column the missing
width belonged to. Both are refused while the memo can still be corrected,
rather than drawn on a guess onto something that is then hashed.

A row cannot be asked to be taller than 600 points; no page has room for one.
A column cannot be dragged below about 6% of the table, which is a little
above the width the renderer needs to print a word without breaking it.

**Every one of these can be undone.** The editor keeps its own history rather
than relying on the browser's, which never saw a row added or a boundary
dragged: Ctrl+Z (and Ctrl+Y or Ctrl+Shift+Z to redo) take back typing a word
at a time, formatting, a paste, and every table operation — a dragged boundary
comes back as one step, to where it was picked up. The Undo and Redo buttons
at the left of the toolbar do the same and are switched off when there is
nothing to do. The controls that would destroy more than they say (removing
the last row or the last column) are still offered switched off, and a table is
deleted the ordinary way, by selecting it.

**A table can be pasted in.** Copy the cells from Excel, Google Sheets or a
Word table and paste them into the memo: they arrive as a memo table, not as
lines of text. The first row is taken as the header, because no spreadsheet
marks one and the header is what repeats when the table crosses a page; a
table that marks its own header keeps it, and a single row is left as a row.
Pasted with the caret already inside a table, the cells fill it from that cell
rightwards and downwards, growing it to fit — as a spreadsheet does. None of
the clipboard's own markup enters the editor: it is read into the memo's node
set off to one side and drawn again from that, so fonts, colours, scripts and
anything else the source carried do not come with it. Tab-separated text — the
plain form of the same selection — is read as a table too. A table wider than
20 columns or longer than 400 rows is refused at the paste, with a message
under the editor, rather than at the moment of submitting.

**A colleague can be written in from the directory.** Type `@` and the first
letters of a name, anywhere in the memo, and the people who match appear under
the caret; up and down choose, Enter or a click inserts, Escape dismisses.
What is inserted is their line as the directory holds it — *Inayat Hussain,
Security Executive, Security & Loss Prevention* — as plain text, fixed at that
moment. It is not a link to the record: a memo must not change when somebody's
designation does. Only accounts still in use are offered, and an `@` inside
an email address is left alone.

**A column of figures can be totalled.** With the caret in the column, press
**Total column** on the table toolbar: a row labelled *Total* is added at the
foot (or the one already there is used) and the sum is written into it, bold,
in the style the column itself uses — `Rs. 1,63,500/-` stays in rupees, in
lakhs, with its `/-`; `(1,200)` is taken as a deduction; the decimals are the
most any figure has. It is written **as text, not as a formula**. The memo
stays a document the renderer, the diff and the signing all read the same way,
and the figures on the page are the figures in the file. The cost of that is
that a total can go stale, so the editor checks after every edit: a total the
column no longer adds up to is named under the editor — *The total under
“Proposed salary” no longer matches the figures above it* — until the column is
totalled again or the figure corrected. A warning, not a refusal: a rounded
total, or one agreed elsewhere, is still a memo somebody may mean to send.
Columns that are not figures are refused, and the refusal names the cell: an
employee code, a badge number or a date never adds up, and percentages are not
added either. Any figure typed into a totals row by hand is checked the same
way, whether or not the control wrote it.

**A word can be found, and replaced.** Ctrl+F with the caret in the memo (or
the **Find and replace** button at the end of the toolbar) opens a bar under
the toolbar; Ctrl+H opens it with the focus on the replacement. It opens on
whatever was selected. Every match is tinted and the current one is inverted,
with a count — *3 of 7* — that follows the text as it is typed; Enter and
Shift+Enter, or the arrows, walk the matches, and Escape closes the bar and
leaves the caret on the match it was showing. **Replace** writes over the
current match and moves to the next; **Replace all** does every one, says how
many, and is one step to undo. *Match case* and *Whole word* narrow the search,
and the query is taken as written, so `Rs.` means the dot. A phrase is found
across a bold word in the middle of it and never across the end of a paragraph
or the edge of a table cell. The matches are painted by the browser's highlight
registry rather than by anything written into the text, so a find leaves no
trace in the memo, the history or the draft; only a replacement is an edit,
and it keeps the formatting the match began in.

**A picture can be placed in the memo.** The **Picture** button on the
toolbar opens the file dialog; a screenshot or a photograph on the clipboard
pastes straight in, and one carried inside pasted markup comes with the text.
A picture is a block of its own between paragraphs, never inside a table cell,
and the caret steps over it as it does a page break. Click it and a **Picture**
toolbar appears: narrower or wider by a tenth of the column, a description
for a reader who cannot see it, and Remove. Backspace with it selected removes
it too, and all of it is one step to undo. On the page it is drawn at its own
size at 96 pixels to the inch, never wider than the text column, whole on the
next page if it does not fit, and never taller than a page; the screen shows
the same share of the column.

**A picture travels inside the memo.** It is carried in the body as a PNG or a
JPEG, the way a colleague's name is written in as text: a version is complete
in itself, and drawing it needs no store and no network. Because the body is
then the memo's weight, the editor makes a picture ready before it is offered
— scaled to 1,600 pixels on its longest side, and a photograph saved as a PNG
re-encoded as a JPEG — and the server bounds what it will hold: **400 KB a
picture, 8 pictures a memo, 1.5 MB of pictures together**, PNG or JPEG only,
each walked for a sane header before anything decodes it. Past any of those
the editor says so with the size and the advice every other limit gives:
attach it as a supporting document instead. A memo of a picture alone is
still an empty memo; it has to say something. A picture fetched from a web
page is not brought in by a paste, and neither is one inside a pasted table
or list; the text beside it still is. On the Changes tab a picture is either
the same picture or a different one, shown as the old taken out and the new
put in.

**Spelling is checked against the organisation’s own dictionary.** The
browser’s spell check cannot be told the organisation’s words, so every
colleague’s name, every department and every product came up underlined, on
every memo, for everybody — a warning wrong that often is a warning nobody
reads. The editor now carries its own check: the en-GB dictionary (SCOWL,
served from `public/dictionaries/`, loaded only when an editor opens) with the
organisation’s dictionary on top and, read from the directory, every word of
every colleague’s and department’s name. Once it has loaded the browser’s own
underlines are switched off and this one’s take over; a word still being typed
is not flagged until the typing pauses. With the caret at rest in a flagged
word the suggestions appear under it: the arrows and Enter take one, Escape
puts them away, **Ignore** silences the word for that memo, and an
administrator sees **Add to the dictionary** as well. **Next misspelling** on
the toolbar walks through them; **Check spelling** switches the whole thing
off, and the browser’s comes back. Under the editor: *3 words the dictionary
does not know*. Nothing is written into the memo by any of this, and nothing
stops a memo with a flagged word from being submitted — it is advice.

What is checked is deliberately narrow: a word of letters in the Latin script.
An acronym, a word against a figure (the *th* of 19th), anything in an email
address or a web address, and a word in Urdu are left alone — the dictionary
is English and has nothing to say about them. British spellings are the ones
it knows (*organisation*, *colour*); an American one is flagged, and the
British one suggested.

The dictionary itself is kept under **Dictionary** in the sidebar, one word at
a time, each addition and removal recorded. It needs the `memo_dictionary_words`
table from migration `20260926120000_memo_dictionary`; until `npx prisma migrate
deploy` has been run, that screen reports an error and the editor checks
against the English dictionary and the directory’s names alone.

**Every control has a key, and a few things convert as they are typed.**
Ctrl+Alt+0, 1 and 2 set body text, a heading and a sub-heading; Ctrl+Shift+8
and Ctrl+Shift+7 start a bulleted and a numbered list; Ctrl+Alt+T inserts a
table, Ctrl+Alt+P a picture, Ctrl+Enter a page break; Ctrl+Alt+O opens the
outline, Ctrl+Shift+F focus mode, F7 the next misspelling, and Ctrl+/ the
list of all of them (the **Keyboard shortcuts** button on the toolbar opens
the same list). Bold, italic, underline, undo, redo and find keep the keys
everybody presses. As text is typed: a dash or an asterisk and a space at the
start of a line begins a bulleted list, *1.* and a space a numbered one, *#*
and a space makes the line a heading and *##* a sub-heading; a straight quote
becomes the curly one the page is set in (a single quote inside a word is the
apostrophe); two hyphens become a dash. Each conversion is one Ctrl+Z away,
which puts back exactly what was typed and does not convert it again.

**The outline and focus mode.** **Outline** on the toolbar lists the memo’s
headings, a sub-heading in from its heading; the arrows and Enter, or a click,
put the caret at the start of the one chosen and scroll to it, and the list
follows the text as it is edited. **Focus mode** takes the editor and its
toolbars over the whole page, the text in a column the width of the sheet and
nothing else in view; Esc, or the same button, brings the page back. Nothing
about the memo changes in either — only what is around it.

**The face and the size are the memo’s to choose.** Two selects at the end of
the editor’s toolbar set the whole memo in **Plus Jakarta Sans** (the
letterhead’s own, and the default), **Liberation Serif** or **Liberation Sans**
— metrically the Times New Roman and Arial a memo has always been typed in —
at **9, 10, 11 or 12 points**. One face and one size for the whole document:
headings follow a point above the body, table text at 85% of it, in the
proportions the template always had, so a twelve-point memo is the same memo,
larger. The editor shows the memo in the face the page is drawn in (the
Liberation files are served from `frontend/public/fonts/`), the choice is
carried on the body, and a filed version re-renders in the face it was filed
in. A memo nobody has set carries nothing and is drawn exactly as before.
The characters a memo uses are checked against the face it is set in, so an
unprintable character is refused at submission whichever face was chosen.
A clause in the standard wording library takes the setting of the memo it is
inserted into, and offers none of its own.

An uploaded PDF has no table to shape. None of this applies to one.

### Standard wording a preparer can insert

An administrator keeps a library of standard wording under **Standard
wording** in the sidebar: the usual recommendation paragraph, an approval
condition, the sentence a memo of a given kind always opens with. Each entry
is a title and a memo body, written in the same editor a memo is, so anything
a memo can hold - a heading, a list, a table - a clause can hold too, and the
same limits apply.

A preparer inserts one from the **Insert wording…** control on the editor's
toolbar. What lands is a **copy**: the memo owns the words from that moment,
and editing or archiving the clause afterwards changes nothing already
written. Archiving takes a clause off the preparer's list without deleting
it, and it can be put back. Every change is recorded in the change history
(`MEMO_CLAUSE_CREATED`, `_UPDATED`, `_ARCHIVED`, `_RESTORED`).

**This needs the `memo_clauses` table** (migration `20260925120000_memo_clauses`).
Until `npx prisma migrate deploy` has been run against the database, the
library screen reports an error and the editor simply offers no wording;
nothing else is affected.

### A note is placed on the page, not typed into the memo

The body of a memo is a flow — paragraphs, headings, lists and tables, laid
out one after another and broken across pages by whatever fits. A **note** is
the other kind of thing: a box somebody put in a particular place, beside the
paragraph it is about.

So notes are kept apart from the body, in `document_versions.page_notes_json`,
with coordinates of their own. Nothing above a note moves it — which is the
point. A note placed beside the third paragraph is a note *about* the third
paragraph, and a flow that reflowed it somewhere else would silently change
what somebody wrote.

Coordinates are PDF points from the **top-left** of the page they name, the
same space `signature_slots` uses, so the screen that places a signature box
and the one that places a note agree without either converting.

What the server refuses, and why each bound exists: more than 40 notes, text
over 2,000 characters, a box under 12pt or over a page, a position off the
page, or any field it was not expecting. These are lengths and coordinates a
request supplies and the renderer then draws with, onto a document that is
filed, hashed and cannot be corrected.

An empty box is **dropped rather than refused** — it is one somebody placed
and thought better of, and an error message about it would be about a box they
have already forgotten placing. A note whose text outgrows its box is clipped
with an ellipsis rather than spilled: it was placed deliberately, and text
running out of the bottom would cross whatever it was put beside.

An uploaded PDF carries no notes. Nothing is drawn onto it here.

### Signing: confirm it's you, agree, and the certificate

Every signature needs the signer to confirm it is them first, with their password or a code from their authenticator app, made in the last five minutes. They must also tick "I confirm this is my signature…". Each signature writes a `DOCUMENT_SIGNED` entry to the audit ledger. Anyone who signs in only with Microsoft and has no password here needs an authenticator app set up before they can sign.

The final approval adds a **signature certificate** as the last page of the approved PDF. It lists each signer, when they signed, their IP address, whether the saved or a drawn signature was used, when they confirmed it was them, and the fingerprint of the memo as submitted. The certificate is added before the approved file is fingerprinted, so the fingerprint in the ledger is that of the file people download. Times are shown in `TIME_ZONE`, default `Asia/Karachi`, with UTC beside each one. Memos approved before this shipped have no certificate; nothing goes back and changes them.

### Signing lines on an attached PDF

When a memo is attached as a PDF, the server reads its text and looks for each signatory's printed name: the preparer and everyone in the approval chain. Where it finds one, it records a signing line just above it, exactly like the lines a memo typed in the portal draws. Each person's signature then goes on their own line, wherever they drop it. The memo shows them a "Sign here" mark there. A signature placed on somebody else's printed name is refused.

The matching is deliberately strict. A name counts only where it appears exactly as the person's name, on its own, the way a signature block prints it. A mention inside a sentence never counts. If a name appears more than once, the last occurrence wins, so a "From:" line at the top does not take the signature from the block at the foot. Two people with the same name get no line. A scanned PDF has no readable text and gets no lines. Anyone without a line places their signature by hand, as before. For the best results, print each signatory's name in the memo exactly as it is spelled on their account.

### The digital seal on approved memos

The final approval seals the approved PDF with the organisation's digital signature, covering the certificate page too. Any PDF reader checks the seal when the file opens: Adobe Reader shows who sealed it and whether the file has changed since, and a change to a single byte shows the seal as broken. The seal is applied before the file is fingerprinted, so the fingerprint in the audit ledger is that of the sealed file.

**Setting it up (self-made certificate, free, works today):**

```bash
cd backend
SEAL_P12_PASSWORD='<a long passphrase>' npm run seal:create-certificate -- /srv/daws/seal
```

This writes two files:

- `ideas-flow-seal.p12`: the certificate **and its private key**. It is secret. Keep it on the server only, readable just by the service account, and back it up with the database. Anyone holding it and its passphrase can seal a file as the organisation.
- `ideas-flow-seal.cer`: the public certificate. It is safe to share.

Then set `SEAL_P12_PATH` to the `.p12` path and `SEAL_P12_PASSWORD` to the passphrase, and restart. The start-up check refuses to start if the file is missing or the passphrase is wrong, rather than quietly approving memos unsealed. With neither setting, memos are approved exactly as before, unsealed, and the API logs `seal.not_configured` once.

**Switching it off.** An administrator can turn sealing off, and on again, under *Administration → Workflow policy → Digital seal on approved memos*, with no restart. Like the other workflow rules, it applies to memos submitted from then on; memos already in progress keep the rule they started with unless the administrator also ticks *Also apply these rules to the memos in progress*. Off, memos are still signed, certified and fingerprinted exactly as before; the approved PDF just carries no seal. The change is recorded in the audit ledger. Memos already approved keep whatever they were approved with. The certificate stays configured either way, so the start-up check above still applies. `SEAL_APPROVED_MEMOS=false` sets the same thing from the environment while no policy is stored on that screen.

**What Adobe shows.** A self-made certificate is as strong cryptographically as a bought one, but nobody vouches for it. Adobe therefore shows the signer as unknown ("validity unknown") until a PC trusts it. To make a PC show the seal as valid, open Adobe Reader → *Edit → Preferences → Signatures → Identities & Trusted Certificates → More… → Trusted Certificates → Import*, choose `ideas-flow-seal.cer`, and tick *Use this certificate as a trusted root*. IT can do the same for every PC through group policy.

**Upgrading later.** A certificate from a trusted authority (an AATL member such as GlobalSign or DigiCert, or a provider accredited under Pakistan's Electronic Transactions Ordinance) is a drop-in replacement. Point `SEAL_P12_PATH` and `SEAL_P12_PASSWORD` at it and restart; nothing else changes. Keep the old `.p12`'s public `.cer`, because memos sealed with it stay verifiable with it. Memos approved before sealing was set up are not sealed after the fact.

### Whether submitting a document also means signing it

On by default, and that is how it has always worked: the person submitting a
document signs it as they send it, and a memo drawn here prints their name
under the first ruled line.

An organisation whose submitters **forward** documents they did not write
turns it off under **Administration → Workflow policy**. Then a submission
goes to the first approver unsigned, the strip starts at the first approver's
column, and the first mark on the page is theirs. The submit screen drops its
signing step and the button reads "Submit for approval".

A **memo type** may overrule the policy either way, so a document somebody
authors and recommends in their own name keeps the author's signature whatever
the default is. `APPROVAL_REQUEST` says so explicitly for that reason.

The server refuses both mismatches — a document that must be signed arriving
without a signature, and one nobody signs at submission arriving with one. The
second matters: without it, a signature could be put on a page that prints no
line to account for it.

The environment variable `PREPARER_SIGNS_ON_SUBMIT` answers where no policy
row has been saved. Only the literal word `false` turns it off; an unset,
empty or misspelt value leaves submitters signing, which is the safe direction
for a setting that decides whether documents carry their author's mark.

### A revision to a typed memo is a new version, not an edit

A memo sent back for correction is rewritten in the portal and **drawn
again** into `v2`. `v1` keeps its own file, its own two checksums, the body it
was drawn from and the signature slots it printed — nothing about it is
rewritten, which is what makes "what did the four people who signed the first
round actually sign" a question with an answer.

That is also why the body lives on `document_versions.body_json` rather than
on the document: one row per drawing, and a revision cannot reach back.

A memo that arrived as an uploaded PDF is still revised by uploading a PDF —
there is no body to open — and the API refuses a typed revision to one with a
message saying so. The reverse is allowed: a memo that was typed may be
replaced by an upload, and the audit row for that submission records
`authoring: "UPLOADED"` against that version while the first says
`"GENERATED"`.

**What changed is shown, not left to be found.** A memo on its second version
or later has a **Changes** tab beside the preview, comparing the version in
flight with the one before it: the paragraph that changed with the words that
moved marked in it, a table's changed row and changed cell, an item added to a
list, a paragraph taken out — and everything else shown unchanged so the
reader can see where the change sits. Who sent the previous version back, and
what they said, is printed above it. The comparison is of the bodies each
version was drawn from; the PDFs are untouched, and a version uploaded as a
PDF has no text to compare, which the tab says. It is served at
`GET /api/documents/:id/changes` under the same access as opening the document.

### Signature images are checked before anything decodes them

pdf-lib decodes PNG and JPEG in JavaScript, on the one thread that serves
every request. Bytes that merely *claim* to be a PNG do not make it fail —
they make it work: a chunk header declaring four gigabytes, or an `IHDR`
claiming 60,000 × 60,000 pixels, is a decode any signed-in account could start
and nobody could interrupt.

Every image now goes through a structural walk first (`src/lib/imageBytes.ts`)
and is refused with a 400 if it does not add up. The limits, should anybody
ever hit them legitimately:

* **2 MB** per image. A drawn signature is a few tens of kilobytes.
* **4096 pixels** on a side. Decode cost is width × height, so this is the
  number that decides how long the thread is held.
* PNG or JPEG only, structurally valid, with the header matching the file.

It applies in three places: saving a signature to a profile, stamping one onto
a memo, and the organisation logo when a memo is drawn. A signature file that
fails is refused **at upload**, so nobody discovers it weeks later halfway
through approving something.

### Uploaded files are read, not just labelled

The type of an upload is whatever the browser — or anybody with curl — wrote
in the request. Every memo and attachment is now checked against its bytes
before anything is stored (`src/lib/fileContent.ts`), and refused with a 400
if they disagree:

* **The memo PDF** must start with a PDF header, open cleanly, have at least
  one page, and not be password-protected. Approvers' signatures are drawn
  onto it, so a file that cannot take them is refused while the preparer is
  still at the form, not at the first approval.
* **Attachments** must carry the signature of the type they claim (PDF, PNG,
  JPEG, Word, Excel; text and CSV must contain no binary), and their name
  must end in that type's extension — the name is what an approver downloads
  and opens.

That stops a file pretending to be another type. It cannot see a macro in a
real Word document; for that, point the API at a **ClamAV** daemon:

| Variable | |
| --- | --- |
| `CLAMAV_HOST` | where clamd listens. Unset: nothing is scanned. |
| `CLAMAV_PORT` | default `3310` |
| `CLAMAV_TIMEOUT_MS` | default `30000` |

Once `CLAMAV_HOST` is set **the scanner is required**. An upload it cannot
vouch for — unreachable, timed out, an answer it does not recognise — is
refused with a 503 (`VIRUS_SCAN_UNAVAILABLE`) and logged as
`upload.scan_failed`; a detection is refused with a 400 (`MALWARE_FOUND`) and
logged as `upload.malware_refused`, with what the scanner matched in
`detection`. A scanner skipped whenever it is down is one an attacker only has
to knock over, so keep clamd monitored alongside the API. clamd's `StreamMaxLength` must be at least the
20 MB upload limit (its default of 25 MB is fine), or large files will be
refused as a scanner error.

### The audit export cannot run formulas

The CSV export is built from titles, comments and names people typed. Any cell
starting with `=`, `+`, `-`, `@`, a tab or a carriage return is written with a
leading apostrophe, so a spreadsheet shows it as text instead of running it.
A tool that reads the CSV as plain text will see the apostrophe.

### Frontend

```bash
cd frontend
npm ci
npm run build
```

Host the contents of `frontend/dist` as the site root. The built page references `/assets/...` and `/favicon.png` absolutely, so it cannot be served from a subpath such as `https://intranet.example.com/daws/` without rebuilding with a Vite `base`.

`index.html` pulls two typefaces from Google Fonts at runtime. On a network with no route out, those two requests fail and the interface falls back to Segoe UI and the system monospace — every stack in the theme has real fallbacks, so nothing breaks, but it will not look like the screenshots. Self-host the two families and drop the `<link>` tags if that matters.

### The hostname

One name serves both halves. The UI calls `/api/...` with no base URL and the
API does not enable CORS, so **a separate `api.` host will not work** — the
proxy below splits `/api` from the static files behind a single origin.

Prefer a subdomain to a path. `dist` references `/assets/...` and
`/favicon.png` from the root, so serving the app under
`https://intranet.example.com/daws/` needs a rebuild with a Vite `base`; a
subdomain needs nothing.

```
flow.example.com.   A   <the server's address>
```

Intranet-only deployments put that record in internal DNS and skip the public
one; everything below is unchanged except how the certificate is obtained.

Changing the hostname later signs everybody out. Tokens live in
`localStorage`, which is scoped to the origin — an expected one-off, not a
fault, but worth doing before people have accounts rather than after.

### TLS

Signed PDFs, session tokens and every approval decision cross this connection.
Terminate TLS at the proxy; the API listens on loopback and is never exposed
directly.

Publicly reachable, certbot writes the certificate and the nginx configuration
below in one step, and renews on a timer:

```bash
sudo certbot --nginx -d flow.example.com
```

Not publicly reachable, the HTTP-01 challenge cannot complete — Let's Encrypt
has to reach port 80 from outside. Use a DNS-01 challenge against your DNS
provider's API, or issue from an internal CA and distribute the root to
managed machines.

Whichever you use, **set `APP_URL` to the `https://` address**. It is what
every link in every approval email points at.

### Reverse proxy

| Path | Target |
|------|--------|
| `/api` | `http://127.0.0.1:3000` |
| `/` | `frontend/dist` |

SPA fallback: unknown non-file paths must serve `index.html` (React Router).

Example nginx:

```nginx
# Plain HTTP exists only to send people to the encrypted one.
server {
  listen 80;
  server_name flow.example.com;
  return 301 https://$host$request_uri;
}

server {
  listen 443 ssl;
  http2 on;
  server_name flow.example.com;

  ssl_certificate     /etc/letsencrypt/live/flow.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/flow.example.com/privkey.pem;

  root /var/www/daws/frontend/dist;
  index index.html;

  location /api/ {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    # Signed PDFs and spreadsheet imports pass through here
    client_max_body_size 25m;
  }

  location / {
    try_files $uri $uri/ /index.html;
  }
}
```

The API does not enable CORS. Serving the UI and `/api` on different hosts will fail in the browser.

`client_max_body_size 25m` is deliberately **above** the API's own 20 MB
document limit, so that an oversized upload is refused by the application —
`{"error":{"message":"That file is too large for this upload."}}`, which the
interface can show — rather than by nginx, whose 413 is an HTML page the
single-page app cannot read. Keep it that way round; nginx is the backstop for
bodies far beyond anything legitimate, not the limit anybody should meet.

Set `TRUST_PROXY=1` on the API when you put this in front of it. The three
things that break without it are listed under Environment above.

## Single sign-on

Optional, and off until it is configured: without it people sign in with the
email address and password the import gave them. With it on, the sign-in
screen offers **Continue with Microsoft** as well.

### It is a SECOND app registration

Not the one on the Mail screen. That one is app-only — it holds `Mail.Send`,
never sees a browser and has no redirect URI at all. Pasting its client ID and
secret into the sign-on screen produces a failure that mentions neither of
those facts, and it is the most common way to lose an afternoon here.

1. **App registrations → New registration.**
2. Platform **Web**, with the redirect URI below — exactly.
3. **Certificates & secrets → New client secret.** Copy the value immediately;
   Entra shows it once and never again.
4. **No API permissions to add.** Sign-in asks for `openid profile email`, which
   every registration may request. There is no Graph permission here and
   nothing for the backend to read from the directory.
5. **Token configuration → Add optional claim → ID → `auth_time`.** People
   who sign in only with Microsoft confirm it is them (before signing, and
   before sensitive changes) with a fresh Microsoft sign-in, and a
   confirmation counts only if Microsoft says when the password was entered.
   The request asks for `auth_time` every time, but Microsoft leaves it out of
   ID tokens unless it is asked for, so adding it here as well is what makes
   it certain. Without it a Microsoft confirmation is refused with *"Microsoft
   did not say when you signed in…"* - safely, but nobody without a password
   or an authenticator app could then sign.

### The redirect URI

```
https://<the host the application is served from>/api/auth/sso/callback
```

`/api/auth/sso/callback` is the backend's route, reached through the same
reverse proxy as every other `/api` call — which is why the host is the UI's
host and not a separate one. The **Single sign-on** screen prints the exact
value for the deployment it is being served from, with a button that fills the
field in; use that rather than typing it.

Entra compares it character for character: the scheme, the host, the path, and
the absence of a trailing slash.

> A mismatch fails at Microsoft, on Microsoft's own page, before this
> application is reached at all — `AADSTS50011`. Nothing in the logs here will
> show it, because nothing here was asked.

### Where it goes in the application

**Administration → Single sign-on**: the directory (tenant) ID, the application
(client) ID, the secret, and the redirect URI. Then the switch.

The secret is write-only — stored encrypted, never sent back to the browser —
and an empty secret field means *keep the one you have*, so correcting a
redirect URI does not require knowing the secret to retype it.

### It signs people in; it does not create them

The address on the Microsoft account has to belong to a person who already
exists in IdeasFlow. There is no provisioning: somebody who signs in to
Microsoft successfully and has no account here is told
*&ldquo;That Microsoft account is not set up in IdeasFlow. Ask an administrator
to add you.&rdquo;* So the import comes first, and the addresses have to match
the directory.

A person with no local password can sign in this way, which is the point of
it: the directory is the credential.

### At go-live, change the redirect URI

This is the step that gets missed, because everything works in testing without
it. A URI recorded while the application was being tried out on a laptop
(`http://localhost:5173/api/auth/sso/callback`) keeps working on that laptop
and fails for everybody else the moment the real hostname exists.

Change it in **both** places, together:

| Where | What |
|---|---|
| Entra → the registration → **Authentication → Web** | replace, or add, the production URI |
| **Administration → Single sign-on** | the same string, character for character |

Leave the localhost entry in Entra only if somebody still needs it for local
work; it costs nothing but it is one more URI to keep true.

## The people

`npm run seed` creates the department list and one administrator. Everybody
else is added in the application, and for a whole organisation that means the
spreadsheet import rather than the form.

### Who can see what

There are two system roles, **Administrator** and **User**, set per person on
**Administration → People & delegation**. What each one may do is listed on the
**Access control** tab of that same screen, which recites the server's own rules
rather than a second description of them &mdash; the route tests fail if the two
disagree.

The thing to understand before assigning anybody anything: **Reviewer and
Approver are not system roles.** Somebody becomes one by being placed on a
particular memo's approval chain, which is what lets the same person review one
memo and give final approval on another without a second account. What that
placement buys is narrow and enforced on every request, not by hiding a link:

- they see the memo only once the workflow has **reached their step** &mdash; a
  later approver cannot read a memo still sitting with an earlier one;
- they can decide **their own step only**;
- everything else in the organisation stays invisible unless they prepared it.

So the Administrator role is the only privilege decision to make, and it is a
real one: an administrator sees every memo in flight, every account, the mail
credentials and everyone's sessions. Appoint a second one so a single lost
password cannot lock the organisation out, and no more than that.

### Who is signed in

**Administration → Login activity** lists open sessions across the
organisation, one row per person, with their department, the devices they are
signed in on and where from. Opening a row shows each session; the count beside
it is sessions, and the figure at the top of the screen is *people*, which are
not the same number once somebody has a laptop and a phone.

Signing somebody out ends **every** session that account holds, on every
device. That is deliberate rather than a shortcut: revoking a single session
leaves the access token in that tab working until it expires, and moving the
account's cutoff is the only thing that reaches a token the server has never
been shown &mdash; which is what somebody reporting a lost laptop means.

Sessions that have ended are kept for a week. An administrator cannot end their
own from this screen; that is on their account page, where it says what it
does.

### Two tiers of administrator

There are two kinds of administrator.

- **Super Administrator.** Every power, and there is **one at a time**. Only the Super Administrator can make somebody an administrator, take it away, choose an administrator's rights, or change, switch off, reset the second factor of, or sign out another administrator's account. Single sign-on and mail are theirs alone too, because each holds credentials that act for the whole organisation. They hand the role to somebody else with **Access control → Transfer…**: the new one gets every power, and the old one stays an administrator with every power that can be given.
- **Administrator.** Only the rights the Super Administrator chose for them under **People & delegation → Access control → Edit rights**. Each area is **No access**, **See only** (its screen opens; nothing on it can be changed) or **See and change**. A newly made administrator starts with two: seeing what is in flight (Control room) and seeing what is waiting on a person.

Safeguards: there is always exactly one active Super Administrator; nobody can change their own role or rights; every change of rights and every transfer asks to confirm it is them and is recorded (`ADMIN_POWERS_CHANGED`, `SUPER_ADMIN_TRANSFERRED`); rights are checked on every request, so a change takes effect at once; and two-step sign-in is required for every administrator. An administrator without a right is refused with "You do not have the power to …", and the screens hide what they cannot use.

When the two tiers were introduced, every existing administrator became a Super Administrator, so nobody lost access. Until somebody acts, Access control says how many there are; the Super Administrator makes the others limited with **Edit rights → Make limited**, or transfers the role.

### If the Super Administrator cannot act

Lost phone, forgotten password, or gone: nobody else can reset an administrator or hand the role on, by design. On the server, in `backend`, with the server's own environment:

```bash
npm run admin:recover -- --email new.owner@example.com
# and, when they are locked out of their own account as well:
npm run admin:recover -- --email new.owner@example.com --reset-two-step --temporary-password
```

It makes that active person the Super Administrator (any other becomes an administrator with every power that can be given). `--reset-two-step` switches their two-step sign-in off so they can set it up again; `--temporary-password` prints a new password once and ends their sessions - they change it at once under **Your account**. Each step is in the audit trail as done by the server recovery script. Whoever can run this already controls the server, its database and its backups, so keep access to the server itself as tight as the Super Administrator's account.

### When somebody leaves

Switch their account off from **Administration → People & delegation**; it is never deleted. The dialog shows what is waiting on them. If they still have approval steps on open memos, it asks **who takes over their approvals** and suggests whoever is covering for them now. Every one of those steps moves to that person in the same act: on memos in progress, the step the memo is on and every step still ahead of it (each with a note on the memo and a ledger entry, exactly as moving a step by hand); on memos back with their preparer, the step on the chain the memo will travel again. Their delegations end too, both cover they gave and cover they held. Approvals they already gave keep their name.

For time away rather than leaving, use a delegation with dates instead: their approvals go to the cover for exactly that period and come back afterwards.

### Prove the install first

Before anybody real is in it, check that the whole process works:

```bash
cd backend
npm run check:fresh-install
```

It signs in as the administrator, imports four fixture people on the very
template the application hands out, has one of them change the password the
import gave them, builds an approval route, submits a memo against it, takes
it through both approvers, and then reads back the signed file, the audit
trail, the ledger and the mail outbox. About thirty checks, each one printed.
It exits non-zero if any of them fail.

| Variable | Default | |
|---|---|---|
| `FRESH_CHECK_API` | `http://localhost:3000` | where the API is |
| `FRESH_CHECK_EMAIL` | `admin@example.com` | must match `SEED_ADMIN_EMAIL` if you set one |
| `FRESH_CHECK_PASSWORD` | `password` | must match `SEED_ADMIN_PASSWORD` if you set one |
| `FRESH_CHECK_STORAGE` | unset | set it to also confirm the file reached the disk |

Two things to know before you run it.

It **writes**: four accounts on `example.com` addresses and one memo, which is
why it belongs before your staff list rather than after. On an install that is
about to go live, run it, then drop the database and seed again — that is a
minute's work at this stage and impossible later.

And it **refuses** to run against a database holding more than the seed. A
fixture memo cannot be told from a real one once it is in the audit ledger, so
the check establishes the install is untouched before it writes anything, and
stops with exit code 2 if it is not. A mistyped `FRESH_CHECK_API` pointed at
something live is the accident it is guarding against.

The same check runs on every push, as the `fresh install (day one)` job.

### Departments first, people second

A person cannot exist without a department, and a department cannot be deleted
once anybody is in it — only switched off. So get the list right *before* the
import, not after: the **Departments** card on **Administration → People &
delegation**, where renaming carries everybody in it along.

The seed's list is what a fresh database starts with. It upserts on the name,
so it can add a department but never rename one — correcting a spelling in
`prisma/seed.ts` and re-running against a database that already has the old
name leaves you with both. Rename in the application instead.

### The import

**Administration → People & delegation → Import**, or
`POST /api/admin/users/bulk` with the file as `file`. CSV or `.xlsx`, up to
10,000 rows. That screen downloads a template with the headers already in it —
start from that rather than typing them:

| Column | Required | Notes |
|---|---|---|
| `firstName`, `lastName` | yes | printed under this person's signature on every memo they sign |
| `email` | yes | where their notices go; must be unique |
| `password` | yes | at least 6 characters; they change it at first sign-in |
| `department` | yes | must match an existing department, case-insensitively; printed under this person's designation on every memo they sign |
| `role` | yes | `USER` or `ADMINISTRATOR` |
| `designation` | no | job title, printed beneath the name, with the department beneath that |

Headers are matched loosely — case and spacing are ignored, and
`departmentName`, `loginRole` and `jobTitle` are accepted as alternatives.
Blank rows are skipped.

**The import is partial, not all-or-nothing.** Good rows are created and bad
ones are reported, each with its spreadsheet row number and the reason:

```
created: 3
failed:
  row 4 | test.gamma@ideas.com.pk | Department "Marketting" was not found. Names must match an existing department.
  row 5 | not-an-email            | Enter a valid email address
  row 6 | test.alpha@ideas.com.pk | A user with this email already exists in this file
  row 7 | test.zeta@ideas.com.pk  | Password must be at least 6 characters
  row 8 | test.eta@ideas.com.pk   | Role must be USER or ADMINISTRATOR
```

Fix those rows and import the corrected file again — the ones that already
succeeded will be refused as duplicate emails, which is the intended outcome
and safe to ignore.

A misspelt department is the failure to expect at organisation scale, and it
is a rejection rather than a wrong answer only because department names carry a
case-insensitive uniqueness rule in the database. Paste the names from the
Departments card rather than typing them.

### Give somebody else the administrator role

At least two people, and not because of the workload. An administrator is the
only account that can create users, manage departments and prove mail works,
and the application deliberately refuses to leave you with none — the last
administrator can be neither deleted nor demoted. That guard cannot help with
a forgotten password or somebody leaving, and there is no route back into
administration from outside the application.

### What people should do on their first sign-in

Change the password from whatever the import gave them, and set a signature
under their profile. A signature is not required — it can be drawn on the page
each time — but drawing one on a phone screen at the moment a memo needs
signing is how a memo waits a day.

Anyone who will be away should have a **delegation** recorded before they go,
not after: without one their steps simply sit, and the memo stops. They can do
it themselves, under the avatar at the top right → **Your account** → **Out
of office**; an administrator can also arrange it for somebody from **People &
delegation**.

Two limits apply to cover, and both exist so that a chain of three approvers
stays three people's judgement:

- **An administrator arranging cover for somebody else cannot name themselves
  as the cover.** That would let one person decide an approver is away and
  sign in their place. The approver can still choose an administrator as their
  own cover, from **Your account**.
- **Nobody decides two steps of one memo.** A delegate who already holds a
  step on the memo cannot also sign, reject or return it for the person they
  are covering, and somebody who has already decided one step cannot decide
  another under a delegation. Choose cover from outside the memo's chain. A
  memo returned for revision starts again, so the same people are asked again
  when it is resubmitted.

### When a memo has stopped and the person holding it cannot move it

They left, they are away with nothing recorded, or they should never have been
asked. An administrator opens the memo and presses **Reassign**: the step goes
to somebody else, with a written reason that lands on the memo's thread and in
the trail, and the new approver is asked for the signature. The approval is
still required — this is not the same as skipping, which drops it.

The person it was taken from is told, and so is the preparer. Three things it
deliberately will not do: hand a step to the preparer, who can never approve
their own memo; to somebody who already holds another step on the same chain;
or to the administrator doing the moving, who would otherwise be choosing to
sign it themselves. It is an administrator's, not the preparer's, so that a memo cannot be
routed away from an approver by the person who wants it signed; what the
preparer has for a memo that is merely slow is **Remind**.

### Two-step sign-in, on the administrators at least

Each person turns this on for themselves, under the avatar at the top right →
**Your account** → **Two-step sign-in**. Scan the square with any authenticator
app, type the six digits it shows, and keep the recovery codes somewhere that
is not the same laptop. **The codes are shown once**: the server stores them
hashed, so no screen can ever show them again.

Nobody can do this on somebody else's behalf — enrolment needs the phone in
their hand. What an administrator can do is see who has not: the **Two-step**
column on **People & delegation** says On or Off for every person, the header
line counts how many are signing in on a password alone, and Off is tinted on
an administrator's row, because that is the account where a stolen password
costs the most. One person's own row carries a **Turn on** link — theirs.

If somebody loses the phone and the codes, an administrator turns their
two-step off from the row menu on that same screen, and they enrol again.

Start with the administrator accounts. An administrator can read every memo in
the organisation, change anybody's role and reach every configuration screen,
so it is the one account where a password on its own is worth arguing about.

**For administrators it is required.** An administrator who has not set it up
can still sign in — however they sign in, password or Microsoft — but sees only
a **Set up two-step sign-in** screen, and the server refuses every other
request until it is done. Once the six digits are accepted and the recovery
codes saved, **Continue to Ideas Flow** opens the app on the
same session. Ordinary accounts are not affected.

The rule follows the account, not the sign-in, so two things to expect:

- **Making somebody an administrator** closes the rest of the application to
  them on their next request, until they set it up. Tell them first.
- **Turning off an administrator's two-step** (the lost-phone path) does the
  same, which is the point: they enrol again before doing anything else.

Check the **Two-step** column before switching this on for an existing
deployment. Every administrator marked Off will meet the setup screen on their
next request. `REQUIRE_ADMIN_TWO_FACTOR=false` in the environment turns the
requirement off. It exists for test and CI environments that drive the app
as a seeded administrator; a production deployment should leave it unset.

### "Confirm it's you" before a sensitive change

A few administrator actions ask for the password, or a code from the
authenticator app, just before they happen, even though the administrator is
already signed in:

- turning off somebody's two-step sign-in;
- changing somebody's role, email address or password (renaming them or moving
  their department does not ask);
- adding a person as an administrator;
- importing people from a spreadsheet;
- saving or clearing the **Mail** or **Single sign-on** settings.

Each of these is a way to take over an account, or to change how everybody signs
in, and a session only proves somebody typed a password up to two hours ago.
Once confirmed, the administrator is not asked again for **five minutes**, so a
run of edits is one prompt. Signing out, or **Sign out everywhere**, ends the
confirmation too.

An administrator who signs in with Microsoft has no password here, so they
choose **Use a code from my authenticator app instead**.

### Passwords

A new password must be **at least 12 characters**. It must not be one of the
passwords every guessing list starts with, and it must not be built from the
person's own name or the start of their email address. There are no "one
capital, one digit, one symbol" rules: length is what makes a password hard to
guess, and a short phrase of three or four words is easy to remember. The same
rule applies when an administrator adds or edits somebody, to each row of the
import (a row with a weak password is refused and the rest go in), to sign-up,
and to **Your account → Change your password**.

**Existing passwords keep working.** The rule is checked when a password is set,
never at sign-in, so nobody is locked out by this change. Ask people with short
passwords to change them, starting with the administrators.

The import template's example row now carries a 12-character password. A staff
list prepared against the old six-character minimum will have rows refused.

### What the trail records about signing in

Every sign-in that issues a session is in the audit ledger as
`SIGN_IN_SUCCEEDED`, with how it was done: `password`, `two-step` (with
`recovery-code` when one was used) or `microsoft`. A wrong password or two-step
code for a real account is `SIGN_IN_FAILED`, with the address that was tried
and never the password. A switched-off account typing the right password is a
failure too, with the reason `switched-off`. When the sign-in limit starts
refusing an account it is `SIGN_IN_THROTTLED`, once per account per 15 minutes.
An address with no account has nothing to point a row at, so those attempts
are in the log only.

These rows are sealed with everything else and are in the export. They are
deliberately **not** on **Change history**, which would otherwise be mostly
sign-ins.

**A stolen sign-in token ends every session.** A sign-in is renewed by
exchanging a token for a new one, and the old one stops working. The real
browser never sends a spent token again, so one that comes back more than a
minute after it was exchanged means somebody else has a copy. Every session on
that account is then ended, the person has to sign in again everywhere, and the
trail records `REFRESH_TOKEN_REUSED`. Within the minute it is simply refused,
because two tabs of one browser can renew at the same moment.

This release adds a migration (`20260929120000_sign_in_audit`): four audit
actions and a `rotated_at` column on `refresh_sessions`. It is additive.

## On a Windows server

The layout this section is for: one Windows machine running PostgreSQL in
Docker Desktop, the API and the web app under pm2, and people opening the
application at `http://<server>:5173`. The web app (`vite preview`) serves the
built frontend and passes `/api` to the API on port 3000.

### Production mode

In `backend/.env`:

```env
NODE_ENV=production
TRUST_PROXY=1
HOST=127.0.0.1
```

- `TRUST_PROXY=1` because the web app stands in front of the API. It passes
  the visitor's address on (`xfwd` in `vite.config.ts`), so the audit trail
  and the sign-in limit see the person, not the web app.
- `HOST=127.0.0.1` keeps the API off the network: only the web app on the same
  machine can reach it. Without it, anybody on the network could call the API
  directly and claim any address.
- `APP_URL` must be set too, either here or under **Administration → Mail**:
  the address people open, such as `http://ids-server:5173`. It is what every
  email link points at, and production refuses to start without it.

Check before restarting: `npm run check:env` in `backend` lists every problem
at once. Then `pm2 restart daws-api --update-env`.

The web app has to listen on the network for colleagues to reach it. In the
pm2 file that starts it, give `vite preview` `--host 0.0.0.0`:

```js
args: ["preview", "--port", "5173", "--strictPort", "--host", "0.0.0.0"],
```

To open it by the server's name rather than its IP address, list the name in
the same file's `env` - Vite refuses names it was not told about ("Blocked
request. This host is not allowed"):

```js
env: { PREVIEW_ALLOWED_HOSTS: "ids-it-shahzad" },
```

and allow port 5173 through Windows Firewall for the domain/private network:

```powershell
New-NetFirewallRule -DisplayName "Ideas Flow web" -Direction Inbound -Protocol TCP -LocalPort 5173 -Action Allow -Profile Domain,Private
```

### HTTPS, and with it Microsoft sign-in

Microsoft sends people back from signing in only to an `https://` address -
plain `http://` is allowed for `localhost` alone - so single sign-on cannot
work on `http://<server>:5173`. And without HTTPS every password and every
"confirm it's you" crosses the network readable.

The layout: a name in the company domain, such as `flow.ideas.com.pk`,
pointing at this server; a free, trusted certificate for it from Let's
Encrypt; and `vite preview` serving HTTPS with it on port 443, so the address
is simply `https://flow.ideas.com.pk`.

**1. A fixed address for the server.** Ask whoever runs the router to reserve
an IP address for this machine. A name that points at an address the router
later hands to somebody else stops working for everybody.

**2. The name.** In the DNS for `ideas.com.pk` (wherever the domain is
managed), add an `A` record: `flow` → the server's reserved IP. A private
address (192.168.x.x) in public DNS is fine for an office: only machines on
the office network can reach it.

**3. The certificate.** The server is not reachable from the internet, so
Let's Encrypt has to check a DNS record instead (`dns-01`). On Windows,
[win-acme](https://www.win-acme.com/) does this. Download it to
`D:\DAWS\win-acme`, then in PowerShell as Administrator run `wacs.exe` and
choose:

- **M** - Create certificate (full options)
- **Manual input**, host `flow.ideas.com.pk`
- Validation: **Create verification records manually** (`dns-01`) - it shows
  a `TXT` record to add to the domain's DNS and waits for it; or, if the DNS
  host is one win-acme supports (Cloudflare, Azure DNS and others), its plugin
  for that host, which makes renewals fully automatic
- Store: **PEM encoded files**, in `D:\DAWS\cert`
- Installation: **Start external script**, `pm2.cmd`, parameters
  `restart daws-web` - so a renewed certificate is picked up at once

win-acme registers its own scheduled task and renews about every 60 days.
With manual DNS validation each renewal asks for a new `TXT` record, so it
needs a person; with a DNS plugin it needs nobody.

**4. Serve it.** In the pm2 file that starts the web app
(`daws-web.pm2.config.cjs`), the port and three settings:

```js
args: ["preview", "--port", "443", "--strictPort", "--host", "0.0.0.0"],
env: {
  PREVIEW_ALLOWED_HOSTS: "flow.ideas.com.pk,ids-it-shahzad",
  PREVIEW_HTTPS_CERT: "D:/DAWS/cert/flow.ideas.com.pk-chain.pem",
  PREVIEW_HTTPS_KEY: "D:/DAWS/cert/flow.ideas.com.pk-key.pem",
},
```

(win-acme names the files after the host; use the names it wrote. A `.pfx`
works too: `PREVIEW_HTTPS_PFX`, with `PREVIEW_HTTPS_PASSPHRASE` if it has
one.) A certificate path that cannot be read stops the web app with the reason
in `pm2 logs daws-web`, rather than serving plain http on an address people
were told is secure. Then allow the port and restart:

```powershell
New-NetFirewallRule -DisplayName "Ideas Flow web (https)" -Direction Inbound -Protocol TCP -LocalPort 443 -Action Allow -Profile Domain,Private
pm2 restart "C:\path\to\daws-web.pm2.config.cjs" --update-env
pm2 save
```

**5. Tell the application its address.** `APP_URL=https://flow.ideas.com.pk`
(in `backend/.env` or under **Administration → Mail**), then
`pm2 restart daws-api --update-env`. Every email link uses it.

**6. Microsoft sign-in.** Now the steps under **Single sign-on** above apply:
the app registration with redirect URI
`https://flow.ideas.com.pk/api/auth/sso/callback`, the `auth_time` optional
claim, and the settings under **Administration → Single sign-on**.

### Starting after a restart

Docker Desktop and pm2 run inside the signed-in session of the account that
started them, so after the server restarts that account has to be signed in
again before anything comes back. Either sign it in by hand, or have Windows
sign it in automatically (Sysinternals Autologon stores the password
encrypted). Then:

```powershell
pm2 save          # record what is running now
```

and `ops/windows/daws-register-tasks.ps1` registers **DAWS - start
application**, which runs `pm2 resurrect` two minutes after sign-in, once
Docker Desktop has started the database. The database container already has
`restart: unless-stopped`.

### Backups, and a copy off the machine

`ops/windows/daws-backup.ps1` is the Windows counterpart of
`ops/daws-backup.sh`: database first (dumped inside the container, checked
readable with `pg_restore --list`), then `STORAGE_DIR`, then SHA-256 digests
of both. With `-OffsiteDir` it copies the backup to a network share, a second
disk or a OneDrive-synced folder and checks the copy against the digests. It
keeps 14 days locally and 60 off-site, removes only folders it made, logs to
`backup.log` beside them and exits non-zero on failure, so the scheduled task
shows the run as failed.

```powershell
# once, as Administrator, from ops\windows
.\daws-register-tasks.ps1 -StorageDir "C:\path\to\backend\storage" `
                          -BackupDir "D:\DAWS\backups" -OffsiteDir "\\fileserver\backups\daws"
```

A copy on the same disk survives a mistake but not a dead disk, a stolen
machine or ransomware; the off-site copy is the one that does. Restore is the
same as anywhere: see **Putting it back** below.

## Watching it

`GET /api/health` is unauthenticated and cheap, and now answers for the
background work as well as the database:

```json
{ "status": "ok", "database": "up",
  "jobs": { "mail": "ok", "ledger": "ok", "deadlines": "off" } }
```

Three sweeps run behind this API — the mail outbox, the audit seal and the
deadline chase — and before this the only sign that one had stopped was a line
on stdout nobody reads. A stalled mail queue looks exactly like a quiet week.

Each job is one word. `ok` is running and reporting; `stalled` means it has
missed several intervals in a row; `failing` means it ran and threw three
times running, which is a log to go and read; `off` means it was never started
— no mail server configured, for instance — **which is not a fault** and does
not make the endpoint unhealthy. Anything other than `ok` or `off` turns the
whole response into `503` with `"status": "degraded"`, so a monitor can watch
the status code alone and needs nothing else.

States, never counts. This endpoint has no token and never will: every caller
that needs it — a load balancer, a container healthcheck, CI — asks before
anybody has one, so it must give an outsider nothing about the memos inside.

### The logs

One JSON object per line on stdout — no agent, no collector, no network, and
every shipper ever written reads it. With systemd that is `journalctl -u daws`
already; in Docker it is `docker logs`. `LOG_LEVEL` sets the volume (`debug`,
`info`, `warn`, `error`, `silent`; unset means `info`).

```json
{"time":"2026-09-08T11:04:22.118Z","level":"error","event":"unhandled",
 "requestId":"6f8ee119-77f5-40da-ba35-0f74e6c63d40","method":"POST",
 "route":"/api/documents/:id/approve","actorId":"9c1a…","err":{"name":"TypeError",…}}
```

Every request writes one `http` line; a 500 writes an `unhandled` line beside
it with the same `requestId`. **That id also goes back to the caller** — as the
`X-Request-Id` header on every response, and inside the body of a 500 — so an
approver who says *"it failed and it said 6f8ee119"* has given you a search
rather than a puzzle. An inbound `X-Request-Id` from your proxy is carried
through, so one trace spans both, but only if it is short and free of the
characters that would let a caller forge a second log line.

**Identifiers only, never content.** A document id but never its title, an
actor id but never their email, the fact of a search but never what was typed —
the query string is dropped whole, because `?q=` on this application is usually
a colleague's name. Log files travel to laptops and support tickets, and the
memos here are increments, warnings and terminations. Healthy `/api/health`
polls are not logged at all; failing ones are.

**Alert on:** a non-200 from `/api/health`; a failed
`daws-verify-restore.service`; `GET /api/admin/mail` reporting rising
`FAILED`; and the ledger tip digest changing for any position you have already
recorded, which is the one thing that would indicate the audit ledger had been
rebuilt.

Two log events deserve their own alert regardless of rate:
`document.integrity.mismatch` says a signed file on disk no longer matches
what was signed, and `process.uncaught_exception` says the API died rather
than answered.

## Retention - a decision for the organisation

One thing is trimmed automatically today: when somebody signs in, their own
sessions that expired more than a week ago are deleted. Nothing else is, and
this section does not change that. Three tables grow with use and hold nothing
the audit ledger depends on, so they can be trimmed - but how long to keep
them is a policy decision for the organisation (HR and whoever owns data
protection), not a default for this software to choose. What follows is a
proposal to decide on.

| Table | What it holds | Proposed | Why |
| --- | --- | --- | --- |
| `notifications` | Inbox items | Delete read items **180 days** after they were read; keep unread ones | The memo and its ledger entries keep the history; an inbox item is only the nudge. Unread ones may still be somebody's only reminder. |
| `email_messages` | The outbox: every email's recipient, subject and body | Delete `SENT` rows **90 days** after sending; `FAILED` rows after **1 year** | Bodies repeat memo titles and names. Ninety days covers "did I get the email?"; a year of failures covers a slow investigation. |
| `refresh_sessions` | One row per sign-in (a hash, never the token) | Keep today's **7 days** after expiry, but apply it to everybody on a schedule, not only to whoever signs in | A dead session protects nothing, and today a leaver's sessions are never trimmed because they never sign in again. Sign-ins themselves are recorded in the audit ledger, which is kept. |

**Never trimmed:** `audit_logs`, `ledger_checkpoints`, documents and their
files, signatures, users. The ledger is a hash chain, and it names everybody
who acted.

Once decided, this becomes a scheduled job in the application with its periods
in the environment - ask for it, and say which periods were chosen.

## Backup and restore

**Two things have to be backed up together: the database and `STORAGE_DIR`.**
Neither is any use alone. The database holds the approvals and, for every
artefact, the SHA-256 of the bytes that were signed; `STORAGE_DIR` holds the
bytes. Restore them from different moments and the API will refuse to serve
the affected memos rather than serve the wrong ones — which is the behaviour
you want, and still an outage.

### On a schedule

`ops/` holds the two scripts and the units to run them:

| | |
|---|---|
| `daws-backup.sh` | database, then files, then the ledger tip. Rotates, keeping `BACKUP_KEEP_DAYS` (14). |
| `daws-verify-restore.sh` | restores a backup into a throwaway database and checks it. Touches nothing live. |
| `systemd/daws-backup.timer` | nightly at 02:17, `Persistent=true` so a missed night runs on the next boot |
| `systemd/daws-verify-restore.timer` | Sundays at 04:00, against the newest backup |

```bash
sudo install -d /opt/daws/ops /var/backups/daws /etc/daws
sudo cp ops/*.sh /opt/daws/ops/ && sudo chmod +x /opt/daws/ops/*.sh
sudo cp ops/systemd/* /etc/systemd/system/
sudo systemctl enable --now daws-backup.timer daws-verify-restore.timer
```

`/etc/daws/backup.env` holds `DATABASE_URL`, `STORAGE_DIR`, `BACKUP_DIR` and
optionally `APP_URL` with `BACKUP_ADMIN_TOKEN`. It names the database and may
hold a token, so `chmod 600` it and own it by root.

**The drill is the part worth having.** A backup nobody has restored is a
hope, so the weekly unit restores the newest one and fails loudly if it will
not come back — which is what your monitoring should watch, alongside
`/api/health`. Both scripts have been run: the backup against a real database
and storage directory, the drill against what it produced (15 files checked
against their recorded digests, audit ledger contiguous). Then two deliberate
failures, because a check that has never said no has not been tested — a
flipped byte in the archive, refused at the digest check; and a storage
archive missing one file the database references, which is exactly what a
database and a storage directory captured at different moments look like,
refused with *"1 file(s) referenced by the database are not in the backup"*.

**On Windows**, Task Scheduler with a `Daily` trigger running the same scripts
under Git Bash or WSL does the same job; the ordering and the checks are in
the scripts, not in the scheduler.

### Taking one

**Dump the database first, copy the files second.** In that order a document
created between the two ends up as a file nothing references, which is
harmless. In the other order it ends up as a row pointing at a file that is
not in the backup, which is a memo nobody can open. (The one case the order
does not cover: a document rolled back in the gap has its files deleted, so an
older database row can outlive them. Keep the gap short.)

```bash
# 1. the database
pg_dump -Fc -f /backup/daws-$(date +%F).dump "$DATABASE_URL"

# 2. then the files
tar -czf /backup/storage-$(date +%F).tgz -C /var/lib/daws storage

# 3. and write this down somewhere that is not the database
curl -s https://daws.example.com/api/audit/ledger -H "authorization: Bearer $TOKEN"
```

Step 3 is thirty seconds and it is the only one that survives an attacker with
write access. The audit ledger is a hash chain, so it catches a record edited or
deleted — but a chain rebuilt from scratch is consistent with itself. A tip
digest you recorded last month, outside this database, is what makes a rebuild
visible. Keep the answers.

### Putting it back

Restore into a **fresh, empty database** rather than over a live one:

```bash
createdb daws_restored
pg_restore -d daws_restored --no-owner /backup/daws-2026-09-07.dump
mkdir -p /var/lib/daws-restored && tar -xzf /backup/storage-2026-09-07.tgz -C /var/lib/daws-restored
```

Point `DATABASE_URL`, `DIRECT_URL` and `STORAGE_DIR` at the two, and start the
API. There is normally no migration step — the dump carries the schema as it
was when the dump was taken. The exception is restoring an older backup under
newer code: run `npx prisma migrate deploy` against the restored database
first, or the API will query columns that are not there yet.

### Checking that it worked

Three questions, in this order. Any of them failing means stop and find out
why, rather than telling people the system is back.

1. **Does it answer?** `GET /api/health` returns `{"status":"ok","database":"up"}`.
2. **Is it the same audit ledger?** `GET /api/audit/ledger` must report the same
   tip digest as the source did at the moment of the dump — the number you
   wrote down in step 3. Then `POST /api/audit/ledger/verify` (administrator)
   must come back `"intact": true` with `checked` equal to `sealed`.
3. **Are the documents the documents?** Download an approved memo — one
   submitted after digests existed, which is anything the current code wrote.
   A `200` is the whole answer: the API checks the file against the digest
   recorded when it was written, so a file that arrived truncated, or from a
   different snapshot than the database, comes back as a `500` reading *"This
   file no longer matches the copy that was signed"* and a log line naming the
   document and the path:

   ```
   Integrity check failed for document 057f3752-…-223e33a6dfb2 at
   documents/057f3752-…/v1/step-3-78f68601-….pdf: stored file does not
   match the recorded digest.
   ```

   That is a mismatched or incomplete restore, not a corrupt PDF, and the fix
   is to restore the pair from the same moment. A memo approved before digests
   existed has nothing recorded to check against and is served without
   comment — this check confirms a good restore, it does not survey the
   archive.

### This has been rehearsed

**Repeated at 19 migrations**, on a database holding 30 memos across every
outcome — approved, rejected, returned for revision, deleted and in flight.
`ops/daws-backup.sh` took the backup and `ops/daws-verify-restore.sh` checked
it, both unmodified except for the two defects the drill itself found (below).
Then the whole thing by hand: restore into a fresh database and directory,
start a second API against the pair on another port, and compare.

The restored copy reported the ledger tip recorded beside the backup —
`6c003299…7fc1` at position 507 — verified intact across all 507 records with
96 witnesses, and the same approved memo came back byte-for-byte identical
(SHA-256 `c999cf45…f672`, 8,767 bytes) from both the live and the restored
API. One byte was then flipped in a restored PDF: the API refused to serve it,
`document.integrity.mismatch` naming the document and the path.

Both deliberate failures were re-run, because a check that has never said no
has not been tested. A flipped byte in the dump was refused at the digest
check (`a file in the backup does not match its digest`). A storage archive
missing one file the database references — a database and a storage directory
captured at different moments, with the digests regenerated so the backup was
internally consistent — was refused with `1 file(s) referenced by the database
are not in the backup`.

**The drill found two defects in these scripts, both now fixed.** The verify
script demanded `DATABASE_URL` and then never used it: `createdb`, `pg_restore`
and `psql` do not read that variable, so every one of them fell back to a local
socket. Set up exactly as described above, the weekly timer would have failed
every Sunday on `connection to server on socket "/var/run/postgresql/.s.PGSQL.5432"
failed` — or worse, succeeded against a different server than the backup came
from. And the backup script reported `APP_URL or BACKUP_ADMIN_TOKEN unset` when
the real cause was `curl` not being installed, so an operator who had set both
would have gone hunting for a typo while the ledger witness silently never got
written.

**A restored copy will send mail if you let it.** Point it at your real SMTP
settings and the outbox sweep delivers to real people, about memos they have
already dealt with. There is no age cutoff: every `PENDING` row goes, however
old, and every `SENDING` row goes too, because the process that claimed it no
longer exists and the claim is therefore stale by definition. Restore with
`SMTP_HOST` unset — `/api/health` then reports `"mail":"off"`, which is what a
drill should show.

What follows is the record of the original pass, at 15 migrations. Every
command above was run,
in this order, against a clean PostgreSQL 16 database and a compiled `dist/`
with `NODE_ENV=production`: install, generate, `migrate deploy` on a virgin
schema (15 migrations), seed, start, fifteen documents with their PDFs, dump,
restore into a new database and directory, and start again. The restored copy reported the same ledger tip digest as the
source (`96aa1513…a2751` at position 37, verified intact), and the same
approved memo came back byte-for-byte identical. One byte was then flipped in
a restored PDF: the API refused to serve it and logged the line above.

The reverse proxy was rehearsed too, with the configuration above unchanged
except for the upstream address: the site at its root, a hashed asset, the
stylesheet, the favicon, two deep links falling back to `index.html`, sign-in,
a signed PDF that arrived byte-identical to the same file fetched directly,
a CSV export with its `Content-Disposition` intact, and an upload at each side
of both size limits. Two API processes were run against one database at the
same time to confirm what the audit seal claims about concurrency: both swept,
one sealed all thirty-six records, the other found nothing to do, and the
chain came out contiguous with a single witness.

That pass found the two defects fixed in the same commit — an API that
recorded the proxy's address instead of the approver's, and a delegation
endpoint that answered 500 to every request the interface sent.
