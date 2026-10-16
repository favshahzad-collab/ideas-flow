/**
 * Drafts of memos being typed in the portal, and the list of memo types.
 *
 * Every route is scoped to the signed-in preparer inside the service; there
 * is no administrator view of somebody's unfinished memo, deliberately.
 */
import { Router } from "express";

import { asyncHandler } from "../utils/asyncHandler";
import { authenticate } from "../middleware/auth";
import { memoPreviewLimiter } from "../middleware/rateLimit";
import { validate } from "../middleware/validate";
import { listMemoTypes } from "../lib/memoTypes";
import { memoTypeRoutesService } from "../services/memoTypeRoutes.service";
import { preparerMustSign } from "../lib/preparerSigning";
import {
  createMemoDraftSchema,
  memoDraftIdSchema,
  previewMemoSchema,
  updateMemoDraftSchema,
} from "../schemas/memoDrafts.schema";
import { memoDraftsService } from "../services/memoDrafts.service";
import { memoClausesService } from "../services/memoClauses.service";
import { memoDictionaryService } from "../services/memoDictionary.service";
import { pageSetupService } from "../services/pageSetup.service";
import { resolveGeometry } from "../lib/memoTemplate/geometry";
import { memoPreviewService } from "../services/memoPreview.service";

const router = Router();

/**
 * The standard wording on offer to whoever is writing a memo.
 *
 * Current clauses only, with their bodies: the editor inserts a copy at the
 * caret. Keeping and changing them is an administrator's route.
 */
router.get(
  "/memo-clauses",
  authenticate,
  asyncHandler(async (_req, res) => {
    res.json({
      clauses: (await memoClausesService.list()).map((clause) => ({
        id: clause.id,
        title: clause.title,
        body: clause.body,
      })),
    });
  })
);

/**
 * The words the spell check should not flag: the organisation's own, and
 * every word of every colleague's and department's name. For anybody signed
 * in - it is read by the editor, not kept by it.
 */
router.get(
  "/memo-dictionary",
  authenticate,
  asyncHandler(async (_req, res) => {
    res.json({ words: await memoDictionaryService.wordsForChecking() });
  })
);

/** What a preparer can choose to write, and the page it will be drawn on. */
router.get(
  "/memo-types",
  authenticate,
  asyncHandler(async (_req, res) => {
    res.json({
      /*
       * The page, resolved, on a call the composer already makes.
       *
       * The editor draws a text column the preparer types into, and that
       * column has to be the width the memo will actually be filed at - it is
       * where a table's columns are measured and where a wrap is judged. The
       * settings endpoint that SETS this is administrator-only; knowing the
       * shape of the page you are writing on is not, so it rides here rather
       * than forcing every preparer through an admin route.
       */
      page: resolveGeometry(await pageSetupService.getPageSetup()),
      memoTypes: listMemoTypes().map((type) => ({
        ...type,
        /*
         * Resolved here, not left for the client to work out.
         *
         * `preparerSigns` on the definition is optional and means "this type
         * has no opinion, ask the policy". A screen handed that would have to
         * reimplement the fallback, and the moment the two disagree the
         * submit flow either asks for a signature the server refuses or omits
         * one the server requires. So the wire carries the answer.
         */
        preparerSigns: preparerMustSign(type.key),
      })),
    });
  })
);

/**
 * The route each kind of memo starts from, for the submit screen to pick
 * first: memo type key (or "UPLOADED") to workflow template id.
 */
router.get(
  "/memo-type-routes",
  authenticate,
  asyncHandler(async (_req, res) => {
    res.json({ routes: await memoTypeRoutesService.resolved() });
  })
);

router.get(
  "/memo-drafts",
  authenticate,
  asyncHandler(async (req, res) => {
    const drafts = await memoDraftsService.listDrafts(req.supabaseUserId!);
    res.json({ drafts });
  })
);

router.post(
  "/memo-drafts",
  authenticate,
  validate(createMemoDraftSchema),
  asyncHandler(async (req, res) => {
    const draft = await memoDraftsService.createDraft(
      req.supabaseUserId!,
      req.body
    );
    res.status(201).json(draft);
  })
);

/**
 * The memo as it will look, drawn now and kept nowhere.
 *
 * A POST because it carries the whole body, and because it is not a fetch of
 * anything that exists - there is no memo yet. It is declared above
 * `/memo-drafts/:id` only for readability; the two never collide, since that
 * one is a GET.
 *
 * Rate limited, alone among the read-ish routes in this app: it is the one
 * endpoint that does a measurable amount of CPU work per call, on the thread
 * that serves everybody else.
 */
router.post(
  "/memo-drafts/preview",
  authenticate,
  memoPreviewLimiter,
  validate(previewMemoSchema),
  asyncHandler(async (req, res) => {
    const preview = await memoPreviewService.renderPreview(
      req.supabaseUserId!,
      req.body
    );

    res.json(preview);
  })
);

router.get(
  "/memo-drafts/:id",
  authenticate,
  validate(memoDraftIdSchema),
  asyncHandler(async (req, res) => {
    const draft = await memoDraftsService.getDraft(
      req.params.id as string,
      req.supabaseUserId!
    );
    res.json(draft);
  })
);

/**
 * The autosave. PATCH rather than PUT: the client sends what changed, and a
 * body that omits the chain must not be read as "the preparer cleared it".
 */
router.patch(
  "/memo-drafts/:id",
  authenticate,
  validate(updateMemoDraftSchema),
  asyncHandler(async (req, res) => {
    const draft = await memoDraftsService.updateDraft(
      req.params.id as string,
      req.supabaseUserId!,
      req.body
    );
    res.json(draft);
  })
);

router.delete(
  "/memo-drafts/:id",
  authenticate,
  validate(memoDraftIdSchema),
  asyncHandler(async (req, res) => {
    await memoDraftsService.deleteDraft(
      req.params.id as string,
      req.supabaseUserId!
    );
    res.status(204).end();
  })
);

export default router;
