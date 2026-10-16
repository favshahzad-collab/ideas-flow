# Ideas Flow — enterprise roadmap

What stands between Ideas Flow (DAWS) as it is today and a system IDEAS PVT LTD
can run across several sites, with an auditor, a helpdesk and more than one
server. Each item is a recommendation, not work that has been done. Every
"today" statement was checked against the code on `main` on 2026-09-30.

Effort is **S** (days), **M** (one to three weeks) or **L** (a month or more)
for one developer familiar with the codebase. Risk is the chance the change
breaks something people rely on.

## Where it stands

**Before** is `main` at `7b8143e` (2026-09-28), when the hardening review
started. **After** is `main` once the open pull requests #29, #30 and #31 are
merged, and #31's migration is applied to live.

| Area | Before | After | What decides it |
|---|---|---|---|
| Authentication | PARTIAL | MEETS | Passwords follow NIST SP 800-63B, administrators must use two-step sign-in, sensitive changes ask "confirm it's you", sign-ins are audited, and a reused refresh token ends every session. Tokens still live in `localStorage` (22). |
| Authorisation and separation of duties | PARTIAL | MEETS | Nobody can approve their own memo or reassign a step to themselves; the last active administrator cannot be removed; a delegate's queue matches their badge. Only two roles (1-4). |
| Audit | PARTIAL | MEETS | A hash-chained, sealed ledger with checkpoints, which the database now refuses to edit (#31). The table owner can still switch that off (5). |
| Data protection | PARTIAL | PARTIAL | Stored mail and SSO secrets are encrypted, and the audit export cannot run formulas. Backups are not encrypted or off-site (11), nothing is ever trimmed except expired sessions (13), and there is no subject access export (14). |
| Uploads | MISSING | MEETS | Every file is checked by its content, not its label, and a virus scanner can be attached (#26). |
| Operability | PARTIAL | PARTIAL | It stops cleanly, refuses a bad environment and checks its backups (#30). Nothing alerts anybody (12). |
| Scalability | MISSING | MISSING | One server only: local file storage, in-memory rate limits, per-process settings and jobs, and drawing on the main thread (6-10). |
| Security headers | PARTIAL | PARTIAL | The API sends them; the UI served by nginx does not (21). |
| Accessibility | MEETS | MEETS | Contrast, motion and dead-code gates plus a real-browser accessibility audit in CI. Badge names now say what they count. |
| Code hygiene | PARTIAL | MEETS | Duplicate screens and dialogs removed, one name per screen, no dead exports. 73 lint warnings are tolerated and none are new. |
| Tests and CI | PARTIAL | PARTIAL | 5,372 tests (937 backend unit, 1,474 integration, 2,961 frontend) plus a real-browser accessibility audit, a day-one install run, a real stop signal and a dependency gate. No code scanning, secret scanning or coverage floor (18). |
| Documentation | MEETS | MEETS | DEPLOY.md covers every setting, including what changed in this review. |

**Verdict.** For one organisation on one server, Ideas Flow now meets the
standard expected of an internal HR approval system. Who can do what is
enforced and audited, the audit ledger cannot be quietly edited, uploads are
checked, and the system starts and stops safely. What stands between it and a
multi-site rollout is mostly not in the code that exists but in what does not
exist yet:

- running on more than one server (6-10);
- roles finer than "administrator or not" (1-4);
- encrypted off-site backups and alerting (11, 12);
- headers and token storage on the browser side (21, 22).

None of these is large on its own; the first group of the suggested order
below is a few weeks' work.

## At a glance

| # | Item | Effort | Risk | Depends on |
|---|---|---|---|---|
| 1 | Enforce permissions from `capabilities.ts` | M | Medium | — |
| 2 | Read-only Auditor role | S | Low | 1 |
| 3 | Helpdesk role, split from Configuration | M | Medium | 1 |
| 4 | Department-scoped administrators | L | High | 1 |
| 5 | Run the API as a role that does not own the tables | S | Low | #31 merged |
| 6 | Shared object storage | M | Medium | — |
| 7 | Shared rate-limit store | S | Low | — |
| 8 | Settings changes seen by every instance | S | Low | — |
| 9 | Background jobs safe on several instances | M | Medium | — |
| 10 | Draw memos off the main thread | M | Medium | — |
| 11 | Encrypted, off-site backups, on Windows too | M | Low | — |
| 12 | Monitoring and alerting | M | Low | — |
| 13 | Retention job | S | Medium | A retention decision |
| 14 | Subject access and export | M | Low | — |
| 15 | Incident response plan | S | Low | 12 |
| 16 | Administrators can end sessions | S | Low | — |
| 17 | Delegation policy | S | Low | — |
| 18 | Code scanning, secret scanning and coverage in CI | S | Low | — |
| 19 | Archive workflow templates instead of deleting them | S | Low | — |
| 20 | The two remaining paths named after their screens | S | Low | — |
| 21 | Security headers and a CSP on the UI | S | Medium | — |
| 22 | Keep sign-in tokens out of reach of page scripts | M | Medium | 21 |

The order to do them in is at the end.

---

## Roles and permissions

### 1. Enforce permissions from `capabilities.ts`

**Problem.** `backend/src/lib/capabilities.ts` describes what each role may do,
and a route test keeps the description honest. But it is a description:
enforcement is `requireAdmin` on routes and `documentAccess` for memos. There
are only two roles, `ADMINISTRATOR` and `USER`, so every administrator can do
everything - read every memo, change roles, configure mail and SSO. Adding a
third role today means adding a third set of scattered checks.

**Recommendation.** Make the capability list the thing that decides. Replace
`requireAdmin` with `requireCapability("users.manage")` and similar, driven by
a role → capabilities table, and keep the existing route test as the guard that
no route is left unprotected. A few services already ask `capabilitiesFor` (for
example reassigning a step and sending reminders); this finishes that move.

**Effort** M. **Risk** Medium: every admin route changes. The route test and
the integration suite make a missed route visible, not silent.
**Depends on** nothing.

### 2. A read-only Auditor role

**Problem.** An internal or external auditor needs the audit ledger, the
ledger verification, and every memo, and must be able to change nothing. Today
that means making them an administrator.

**Recommendation.** A role with `memos.view.all`, `audit.view`, `audit.verify`
and `audit.administration` (change history), and nothing else. Its screens
already exist.

**Effort** S. **Risk** Low. **Depends on** 1.

### 3. A Helpdesk role, split from Configuration

**Problem.** The person who resets a password or switches off a leaver can also
change the mail server, SSO settings and workflow policy.

**Recommendation.** Split administration into Helpdesk (people, sessions,
two-step resets) and Configuration (mail, SSO, workflow policy, page setup,
standard wording). Keep step-up confirmation ("confirm it's you") on both.

**Effort** M. **Risk** Medium: people who hold both today need both roles
assigned deliberately. **Depends on** 1.

### 4. Department-scoped administrators

**Problem.** For a multi-site rollout each site will want its own
administrator. Today an administrator sees and manages the whole organisation;
nothing in access checks looks at department.

**Recommendation.** Scope Helpdesk and oversight capabilities to a set of
departments, with an organisation-wide administrator above them. Memo access
for ordinary people does not change - it already follows the approval chain.

**Effort** L. **Risk** High: it touches every admin query and the control
room, and a scoping bug either hides work or leaks it. **Depends on** 1 and 3.

### 5. Run the API as a database role that does not own the tables

**Problem.** Once #31 is merged the database refuses edits to the audit ledger -
unless the table owner switches the trigger off. The API connects as the owner,
so anyone with the API's database password can.

**Recommendation.** Two roles: the owner, used only by `prisma migrate deploy`
(`DIRECT_URL`); and an application role with `SELECT, INSERT, UPDATE, DELETE`
on the application's tables and no ownership (`DATABASE_URL`). The triggers
then bind the application completely.

**Effort** S. **Risk** Low, if tried on a copy first: a missing grant shows up
as a clear permission error. **Depends on** #31 being merged.

---

## Running on more than one server

Today the API runs as one process, and several things rely on that. None of
them is wrong for one server; each is wrong for two.

### 6. Shared object storage

**Problem.** Signed PDFs and signature images are written to a local folder
(`STORAGE_DIR`, `backend/src/lib/storage.ts` using `fs`). A second server
cannot see the first one's files.

**Recommendation.** An S3-compatible or Azure Blob backend behind the existing
`StorageService` - its callers already go through it, and every file is written
once and checked against a SHA-256 on read, which carries over unchanged. Keep
the local folder as the default for one server.

**Effort** M. **Risk** Medium: needs a one-time copy of existing files, proved
by the existing restore check. **Depends on** nothing.

### 7. A shared rate-limit store

**Problem.** Sign-in limits (`middleware/rateLimit.ts`, eight attempts per
account and forty per address in fifteen minutes) use express-rate-limit's
default in-memory store. With two servers each counts separately, so an
attacker gets twice the attempts, and a restart forgets all of them.

**Recommendation.** A shared store: PostgreSQL, which is already there, or
Redis. express-rate-limit supports pluggable stores.

**Effort** S. **Risk** Low. **Depends on** nothing.

### 8. Settings changes seen by every instance

**Problem.** Mail settings and workflow policy are loaded into module
variables at startup (`lib/mailer.ts`, `lib/workflowPolicy.ts`) and refreshed
when an administrator saves - on the server that handled the save. Branding and
page setup are cached for a few seconds. A second server keeps the old values.

**Recommendation.** Re-read on a short interval, or announce changes with
PostgreSQL `LISTEN/NOTIFY` so every instance reloads.

**Effort** S. **Risk** Low. **Depends on** nothing.

### 9. Background jobs safe on several instances

**Problem.** Every API process starts the mail, ledger and deadline sweeps. The
ledger sealer takes an advisory lock and mail rows are claimed before sending,
so those two were designed for it; the deadline sweep and reminders have not
been checked for it.

**Recommendation.** Prove each sweep safe with two instances running (a test
that runs two sweeps at once, like the existing ledger one), or run the sweeps
in one dedicated worker process.

**Effort** M. **Risk** Medium: a double reminder is an annoyance; a double
escalation is worse. **Depends on** nothing.

### 10. Draw memos off the main thread

**Problem.** Drawing a typed memo and decoding signature images run in
JavaScript on the thread that serves every request (DEPLOY.md, "Drawing a memo
costs CPU"). One large memo pauses everybody's requests while it draws.

**Recommendation.** A small pool of worker threads for rendering, with a queue
and a time limit per job, so a heavy memo slows only itself.

**Effort** M. **Risk** Medium: the renderer has to be moved without changing a
single drawn pixel - the existing render tests and sample memos are the check.
**Depends on** nothing.

---

## Operations

### 11. Encrypted, off-site backups, on Windows too

**Problem.** `ops/daws-backup.sh` and its systemd timers take a nightly backup
and `ops/daws-verify-restore.sh` restores it weekly to prove it. That is good.
But the backups are not encrypted, stay on the same machine, and there is
nothing for a Windows server, which DEPLOY.md lists as supported.

**Recommendation.** Encrypt each backup (for example with `age` or `gpg`) with
a key kept off the server, copy it off-site, and ship a PowerShell equivalent
with a Task Scheduler definition. Keep the monthly restore test, and write down
who checks its result.

**Effort** M. **Risk** Low. **Depends on** nothing.

### 12. Monitoring and alerting

**Problem.** `/api/health` reports the database and each background job's
heartbeat, and the logs are structured JSON. Nothing watches them: a mail
server that starts refusing, a ledger that stops sealing, or a memo overdue by
a week is found by a person noticing.

**Recommendation.** Alerts on `/api/health` not OK, on mail failures
(`email_messages` in `FAILED`), on the ledger tip not moving, on the monthly
ledger verification failing, and on approvals overdue past a threshold. Ship
the logs to whatever the organisation already uses.

**Effort** M. **Risk** Low. **Depends on** nothing.

### 13. A retention job

**Problem.** Notifications and the email outbox grow without end. Sessions do
not quite: a person's sessions that expired more than a week ago are deleted
when that person next signs in (`sessionsService.pruneExpired`), so somebody
who has left keeps theirs for good. DEPLOY.md proposes periods for the first
two (180 days for read notifications; 90 for sent email and a year for failed)
as a decision for the organisation.

**Recommendation.** Once the periods are agreed, a daily job that removes rows
past them, with the periods in the environment and the audit ledger, documents
and users never touched. The same job can run the existing session pruning for
everybody, not only for whoever signs in.

**Effort** S. **Risk** Medium: deleting is the one thing that cannot be undone,
so it needs a dry-run mode and a test for every table it touches.
**Depends on** the organisation's retention decision.

---

## Compliance

### 14. Subject access and export

**Problem.** If a member of staff asks for everything the system holds about
them, there is no way to produce it short of database queries.

**Recommendation.** An administrator action that exports one person's
profile, the memos they prepared or acted on, their audit ledger entries and
their sign-in history, as a zip.

**Effort** M. **Risk** Low: read-only. **Depends on** nothing.

### 15. A written incident response plan

**Problem.** There is no written answer to "the ledger verification failed",
"an administrator account was compromised" or "the server is lost".

**Recommendation.** A short runbook for each: who is told, how to contain it
(end sessions, rotate `JWT_SECRET`, disable an account), how to restore, and
how to read the ledger to see what happened.

**Effort** S. **Risk** Low. **Depends on** 12, so there is something that
raises the alarm.

---

## Sessions and delegation

### 16. Administrators can end sessions

**Problem.** People can sign out of one session or all of their own, and
changing a password or role ends that person's sessions. An administrator can
see everyone's sessions on Login activity, but cannot end one without resetting
a password, and there is no "sign everybody out" for an incident.

**Recommendation.** "End this session" and "end all of this person's sessions"
on Login activity, and "sign everybody out" behind step-up confirmation.
Everything they need already exists in `sessions.service`.

**Effort** S. **Risk** Low. **Depends on** nothing.

### 17. A delegation policy

**Problem.** A delegation can be open-ended (no end date), and anyone can be a
delegate for anyone. That is flexible, and it is also how approval authority
ends up with somebody junior for a year.

**Recommendation.** An organisation setting for the longest delegation allowed
and, optionally, a rule on who may be a delegate (the same department, or at
least the same grade). Existing delegations stay as they are and show a warning
if they break the new rule.

**Effort** S. **Risk** Low. **Depends on** nothing.

### 21. Security headers and a Content-Security-Policy on the UI

**Problem.** The API sends security headers (`helmet()` in `app.ts`), but
those cover only the API's own responses. The UI is static files served by
nginx, and the configuration in DEPLOY.md adds no headers to them: no
`Content-Security-Policy`, no `Strict-Transport-Security`, no
`X-Content-Type-Options`, no `frame-ancestors`. A CSP is the main thing that
limits what an injected script could do - and item 22 is about what it could
read.

**Recommendation.** Add them to the nginx `server` block: a CSP of
`default-src 'self'` with `connect-src 'self'` and the Microsoft sign-in
origins, `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'self'`;
HSTS; `nosniff`; `Referrer-Policy: same-origin`. Start with
`Content-Security-Policy-Report-Only` for a week to find what it would block.

**Effort** S. **Risk** Medium: a CSP that is too strict breaks the page, which
is what report-only mode is for. **Depends on** nothing.

### 22. Keep sign-in tokens out of reach of page scripts

**Problem.** The access and refresh tokens are kept in the browser's
`localStorage` (`frontend/src/services/authTokens.ts`), where any script on the
page can read them. A single script injection - a compromised dependency, or a
bug that renders somebody's text as HTML - could take a refresh token away and
keep using it elsewhere. Refresh tokens rotate, and presenting a spent one ends
every session that person has and is recorded in the audit ledger (PR #23).
That limits how long a stolen one lasts; it does not stop it being stolen.

**Recommendation.** Keep the **refresh token** in a cookie the page cannot
read - `HttpOnly; Secure; SameSite=Strict; Path=/api/auth` - and the
**access token** in memory only, fetched again from the refresh cookie when
the page loads. Every other API call keeps sending the access token in the
`Authorization` header, as today.

**What it means for CSRF.** Today there is no CSRF exposure, because nothing
is sent automatically: every request carries a header the page adds itself. A
cookie is sent automatically, so the endpoints that read it - refresh and
sign-out - become the ones to protect:

- `SameSite=Strict` stops the browser sending the cookie with a request that
  starts on another site. It works here because the UI and API share one
  origin behind nginx (DEPLOY.md, "Reverse proxy").
- Those two endpoints should also require a header a cross-site form cannot
  set (`X-Requested-With`, or a check that `Origin` is the application's own).
- Everything else is unaffected, because it still authenticates by header,
  not by cookie.
- Microsoft sign-in lands on the application's own callback page and then
  calls the API from the page, so `Strict` does not break it. This needs
  proving, not assuming.

**Effort** M. **Risk** Medium: it changes sign-in, sign-out, refresh, the SSO
callback and how several open tabs share one session. **Depends on** 21, which
is worth having whether or not this is done.

---

## Engineering

### 18. Code scanning, secret scanning and coverage in CI

**Problem.** CI runs every test suite, the accessibility audit, a
fresh-install run and a dependency advisory gate, and Dependabot keeps
packages current. There is no static analysis, no secret scanning and no
coverage threshold.

**Recommendation.** GitHub CodeQL for TypeScript, GitHub secret scanning with
push protection, and a coverage floor set at today's figure so it can only go
up.

**Effort** S. **Risk** Low. **Depends on** nothing.

### 19. Archive workflow templates instead of deleting them

**Problem.** A template that no memo uses can still be deleted outright. It is
audited, and a template in use is refused, but the design it held is gone.

**Recommendation.** An `archived_at` column: archived templates are hidden from
choosing and kept for history. Needs a migration.

**Effort** S. **Risk** Low. **Depends on** nothing.

### 20. The two remaining paths named after their screens

**Problem.** Every screen's path now says its name except Documents
(`/dashboard`) and My queue (`/pending-approvals`).

**Recommendation.** `/documents` and `/my-queue`, with redirects from the old
paths, the same way the other six were moved.

**Effort** S. **Risk** Low. **Depends on** nothing.

---

## Suggested order

1. **Before a second site:** 5, 7, 11, 12, 16, 18, 21. All small, and they
   close the gaps an incident would find first. Then 22.
2. **For an auditor and a helpdesk:** 1, then 2 and 3.
3. **Before a second server:** 6, 8, 9, then 10.
4. **When the organisation decides:** 13 (retention), 17 (delegation policy),
   4 (department-scoped administrators).
5. **Any time:** 14, 15, 19, 20.
