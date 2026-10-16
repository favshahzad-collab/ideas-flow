# Phase 0 — in-app memo authoring and generated PDF

Findings and proposed plan. **No code has been written.** Written against
commit `c5edee6`, 22 September 2026.

Everything below was read out of this repository or proved by running it. Where
I tested something rather than assumed it, I say so.

---

## 1. The PDF pipeline

**`pdf-lib` ^1.17.1, and nothing else.** No Puppeteer, no Playwright, no
PDFKit, no headless browser anywhere in the backend's dependencies. The one
place it is used is `backend/src/lib/pdfSignature.ts` (521 lines).

Today that module only ever **loads and stamps**:

```ts
const pdfDoc = await PDFDocument.load(pdfBuffer);   // always an existing file
page.drawImage(...); page.drawText(...); page.drawLine(...);
```

It never calls `PDFDocument.create()`.

**Can it compose from scratch? Yes — I tested it.** A blank A4 page
(595.28 × 841.89 pt) built from nothing, with text and a bordered rectangle,
came out at 917 bytes.

**What it does not have is a layout engine.** Available:

| Facility | Present |
|---|---|
| `layoutMultilineText` (word wrap) | yes |
| `font.widthOfTextAtSize`, `font.heightAtSize` | yes (measurement only) |
| `drawText` / `drawRectangle` / `drawLine` / `drawImage` / `drawSvgPath` | yes |
| table layout, pagination, repeating header rows | **none — must be written** |

So the template is buildable on pdf-lib, but the box model underneath it is
ours to write. That is the main body of work in this feature, and it is the
part worth being honest about up front.

Reusable from the existing module: the sign-off block geometry
(`RULE_OFFSET 5`, `RULE_THICKNESS 0.75`, `NAME_SIZE 9`, `DETAIL_SIZE 7.5`,
`LINE_GAP 3.5`), `signoffBlockHeight()`, `CAPACITY_LABEL`, and
`formatSignoffDate()`.

## 2. The artefact model

`DocumentVersion` carries the contract, and its own schema comment states it:
*"Immutable version record. Never update file content — new upload = new row."*

| Column | Meaning |
|---|---|
| `storagePath` | the memo as submitted, preparer's signature burned in — what approvers sign |
| `originalStoragePath` | exactly what was uploaded, before that signature. Never written again |
| `storageChecksum` | SHA-256 of `storagePath`, `VarChar(64)` |
| `originalChecksum` | SHA-256 of `originalStoragePath` |

`Document.finalSignedStoragePath` / `finalSignedChecksum` are fixed at final
approval — the copy HR prints.

Paths, confirmed against files on disk:

```
documents/<documentId>/v1.pdf
documents/<documentId>/v1-original.pdf
documents/<documentId>/v1/step-<k>-<uuid>-<uuid>.pdf
documents/<documentId>/supporting/<uuid>-<filename>
```

Digests are computed **from the buffers just written**, never re-read from
disk — a deliberate choice the code comments defend, because a re-read would
digest whatever is on disk by then rather than what this request produced.

I verified the live system honours this: all 8 document files match their
recorded checksums.

## 3. The approval chain

Already complete, and **Requirement 2 needs no new model**.

- `ApprovalChain` — exactly one per document (`documentId` is unique), reused across revision cycles.
- `ApprovalChainStep` — `stepOrder`, `approvalType`, `assignedUserId`, `slaDays`; unique on `(chainId, stepOrder)`.
- `ApprovalType` is `REVIEWER | APPROVER | FINAL_APPROVER` — the brief's reviewer-vs-approver distinction exists already.
- `WorkflowTemplate.graph` holds a React Flow node graph; `workflowTemplatesService.compileGraphToSteps()` turns it into steps.

Validation helpers that already exist and must be reused rather than
reimplemented:

- `findApprovalChainIssues(chain)` — ordering, at least one approver, final step is an approver, duplicates.
- `preparerIsInChain(chain, userId)` + `PREPARER_IN_CHAIN_MESSAGE` — the no-self-approval rule.
- A deactivated-account check that names the people, so a six-step chain does not send the preparer hunting.

## 4. The submit path

`POST /api/documents` → `documentsService.createDocument()` (line 268).

Middleware: `authenticate` → `uploadDocumentWithSupporting` (multer,
`fileSize: 20 * 1024 * 1024`) → `parseMultipartJsonFields` →
`validate(createDocumentSchema)`.

The order matters and the code defends it in a comment: **everything that can
reject the submission runs before a single byte is written**, because a
template that failed to compile used to throw after the PDF had been uploaded
and leave an orphaned file.

1. Resolve chain — compile template *or* take inline; validate; confirm every user exists and is active.
2. `stampPreparerSignature()` → signed buffer. **The preparer's signature is mandatory** (saved or drawn).
3. Write `v1-original.pdf`, then `v1.pdf`.
4. `sha256()` both buffers.
5. One transaction: mint the reference (`nextMemoReference`, advisory lock, `MAX(...)+1`), create `Document` (`PENDING_REVIEW`, `submittedAt`), `DocumentVersion`, `ApprovalChain`, steps, `WorkflowRun` at `currentStepOrder: 1`, link `currentWorkflowRunId`, then `auditService.createAuditLog({ ..., tx })`.
6. Supporting files after the transaction.

`createAuditLog` accepts a `tx` — which is the hook the brief requires us to
reuse so the sealing sweep keeps the chain contiguous.

## 5. Fonts — the finding that shapes the plan

**There are zero font files in this repository.** A search for `*.ttf`,
`*.otf`, `*.woff*` outside `node_modules` returns nothing.

The frontend pulls Plus Jakarta Sans and IBM Plex Mono **from Google Fonts at
runtime**, which is exactly the dependency the brief forbids at render time.
The backend embeds nothing — it uses `StandardFonts.Helvetica` and
`HelveticaBold`, two of the PDF base-14 fonts, which are WinAnsi-encoded.

I tested the base-14 fonts against the actual sample text:

| Character | Result |
|---|---|
| en dash `–` (U+2013) | ok |
| right single quote `’` (U+2019) | ok |
| `PKR 1,500/Month` | ok |
| **rupee sign `₨` (U+20A8)** | **fails** — `WinAnsi cannot encode` |
| **Urdu `ا` (U+0627)** | **fails** |

So the base-14 fonts would render *this* sample, and throw the moment somebody
types a rupee sign — in a free-text memo body, on a Pakistani allowance memo.
That is not a hypothetical.

Embedding a real TTF requires `@pdf-lib/fontkit`, which is **not** currently a
dependency.

## 6. Determinism — a trap, and a correction

The brief requires "same input, same bytes" because digests are compared.

My first probe reported pdf-lib as deterministic. **That was wrong** — both
renders had landed in the same millisecond. Re-run with a 1.5-second gap:

```
dates default: DIFFERS across 1.5s
dates pinned : IDENTICAL across 1.5s
```

pdf-lib stamps `CreationDate` / `ModDate` from the clock unless you set them.
So the renderer **must** call `setCreationDate()` and `setModificationDate()`
with the memo's own date. Without it every render has a different digest and
nothing about the artefact is reproducible.

## 7. Drafts

`frontend/src/hooks/useSubmitDraft.ts` exists, but it is **`localStorage`
only** — browser-local, one device, gone when site data is cleared, and
invisible to the server. The brief's server-side draft is a real gap and needs
a new table.

## 8. Assets

`frontend/public/ideas-logo.png` — **936 × 192**, the Ideas wordmark, already
in the repo. (The brief's attachment is 990 × 219; same mark, different crop.)

It lives in the *frontend* public directory. The backend has no asset
directory at all, so one has to be introduced and included in the deployment
package — an operational note for `DEPLOY.md`.

## 9. Frontend editor

No rich-text dependency exists (`@tiptap`, ProseMirror, Slate, Quill, Lexical
— none). TipTap would be new. The existing stepper is
**Details → File → Routing → Sign**.

---

## Recommendation

**Render with pdf-lib plus a small layout engine. Not Puppeteer.**

pdf-lib is already here, already the thing that stamps signatures, pure JS, and
adds nothing to a Windows Service deployment. The cost is writing wrap, table
and pagination on top of `layoutMultilineText` and the measurement primitives —
real work, but bounded, pure, and unit-testable without a browser. Per the
brief, Puppeteer is only justified if no pure-JS option can produce the
template, and one can.

**Add `@pdf-lib/fontkit` and embed one font family from disk.** Plus Jakarta
Sans is already the application's typeface and is SIL OFL, so it is
redistributable. This makes the PDF match the UI and removes the `₨`/Urdu
cliff.

### Dynamic header and footer — your addition

Both come from data, never hardcoded:

- **Header band** — logo, organisation name and the To / From / Subject / Date block all render from an org-branding record plus the memo's own header columns. Swapping the logo or the org name is configuration, not a code change.
- **Footer signatory strip** — driven entirely by the chain. N signatories laid out across the page width, each with a rule, printed name and designation, N coming from the approval chain rather than a fixed four.

This footer strip is a **new** thing, and worth separating clearly from what
exists: `pdfSignature.ts` stamps *one* signature *after* a decision. The
template footer is the printed strip that exists on the document *before*
anyone signs — the blank ruled lines with names beneath. They interact, and
Phase 3 has to prove the stamping path still lands correctly on top of it.

### One question the sample cannot answer

The sample's text layer lists **four** signatories —
`SBK / Chief Operating Officer`, `Rizwan Mushtaq / Director - Human Resources`,
`Maryam Ali / Director - Audit`, `BMD / Chairman` — but the rendered page shows
only **three** ruled lines (SBK is absent). Before building the dynamic footer
I need to know which is intended: does the strip show every approver on the
chain, or only those below a certain level? It changes the layout arithmetic,
because four columns across a ~7.3-inch text width is tight.

---

## Proposed plan — stop for review after each phase

**Phase 1 — renderer, offline and standalone.**
`memo-template` module: `{ header, bodyJson, memoType, branding, signatories }`
→ PDF buffer. The layout engine, embedded fonts, embedded logo, table with
repeating header row, page breaks, page numbers, pinned dates. No routes, no
database. Proved by rendering the sample memo and comparing it side by side
with the attached PDF.

**Phase 2 — data model and drafts.**
Additive migration: memo body JSON, header fields, `memoType`, org branding,
server-side drafts. Draft CRUD with preparer-only visibility. Zod schema
validating the body against the allowed node set, rejecting unknown nodes
rather than dropping them.

**Phase 3 — submit path.**
Extend `createDocument` so a generated buffer enters at exactly the point the
uploaded buffer does today — `v1-original.pdf` is the generated PDF,
`v1.pdf` is it with the preparer's signature. Everything downstream is
unchanged, which is what keeps `step-<k>-<uuid>.pdf` artefacts identical in
shape. Render failure rolls the submission back.

**Phase 4 — authoring screen.**
TipTap with the restricted node set, header fields, chain picker reusing the
existing routing step, live preview. The upload path stays as an alternative
mode.

**Phase 5 — revisions, tests, docs.**
`v2` on resubmit without touching `v1`; extend `check:fresh-install` with a
typed-memo case; route tests for node rejection, chain validation, draft
visibility and render-failure rollback; `DEPLOY.md` note for the new asset
directory.

**Nothing starts until you approve this note.**
