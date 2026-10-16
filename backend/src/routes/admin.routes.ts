import { Router } from "express";
import { authenticate } from "../middleware/auth";
import { requireAdmin } from "../middleware/role";
import {
  requireStepUp,
  requireStepUpWhen,
  stepUpConfirmed,
  stepUpRequired,
} from "../middleware/stepUp";
import { mailTestLimiter } from "../middleware/rateLimit";
import { validate } from "../middleware/validate";
import { asyncHandler } from "../utils/asyncHandler";
import { adminService } from "../services/admin.service";
import { emailService } from "../services/email.service";
import { mailSettingsService } from "../services/mailSettings.service";
import { workflowSettingsService } from "../services/workflowSettings.service";
import { ssoSettingsService } from "../services/ssoSettings.service";
import {
  PAGE_SETUP_AUDIT_ID,
  pageSetupService,
} from "../services/pageSetup.service";
import { updatePageSetupSchema } from "../schemas/pageSetup.schema";
import { memoClausesService } from "../services/memoClauses.service";
import { memoDictionaryService } from "../services/memoDictionary.service";
import {
  addDictionaryWordSchema,
  dictionaryWordIdSchema,
} from "../schemas/memoDictionary.schema";
import {
  createMemoClauseSchema,
  updateMemoClauseSchema,
} from "../schemas/memoClause.schema";
import {
  DEFAULT_PAGE_SETUP,
  MAX_MARGIN,
  MIN_MARGIN,
  PAPER,
} from "../lib/memoTemplate/geometry";
import { auditService } from "../services/audit.service";
import {
  brandingService,
  DEFAULT_ORGANISATION_NAME,
} from "../services/branding.service";
import { totpService } from "../services/totp.service";
import { documentsService } from "../services/documents.service";
import {
  updateAdminUserSchema,
  createAdminUserSchema,
  listAdminUsersSchema,
  listDepartmentsSchema,
  createDepartmentSchema,
  updateDepartmentSchema,
  deleteDepartmentSchema,
  getAdminUserSchema,
  setUserActiveSchema,
  setAdminPowersSchema,
  transferSuperAdminSchema,
  bulkImportUsersSchema,
  resetUserTwoFactorSchema,
  updateMailSettingsSchema,
  updateSsoSettingsSchema,
  updateWorkflowSettingsSchema,
  type CreateAdminUserInput,
  type UpdateAdminUserInput,
} from "../schemas/admin.schema";
import { uploadSpreadsheet } from "../middleware/upload";
import { errors } from "../lib/errors";
import { testMailConnection } from "../lib/mailer";
import { accessControlMatrix } from "../lib/capabilities";
import { sessionsService } from "../services/sessions.service";
import { calendarService } from "../services/calendar.service";
import { memoTypeRoutesService } from "../services/memoTypeRoutes.service";
import { memoTypeRouteSchema } from "../schemas/memoTypeRoutes.schema";
import {
  addPublicHolidaySchema,
  publicHolidayIdSchema,
  setOfficeTimeZoneSchema,
} from "../schemas/calendar.schema";
import { endUserSessionsSchema } from "../schemas/admin.schema";

const router = Router();

router.use(authenticate, requireAdmin);

/**
 * Departments, and managing them.
 *
 * Reading the list was the only department operation this product had. They
 * could be created by the seed script or a database prompt and by nothing
 * else - and since a person cannot exist without a department, onboarding
 * somebody into a new team was blocked on an engineer with server access.
 */
router.get(
  "/departments",
  requireAdmin,
  validate(listDepartmentsSchema),
  asyncHandler(async (req, res) => {
    const departments = await adminService.listDepartments({
      includeInactive: req.query.includeInactive === "true",
    });
    res.json(departments);
  })
);

router.post(
  "/departments",
  requireAdmin,
  validate(createDepartmentSchema),
  asyncHandler(async (req, res) => {
    const { name } = req.body as { name: string };
    const department = await adminService.createDepartment(
      { name },
      req.supabaseUserId
    );
    res.status(201).json(department);
  })
);

/** Rename, or switch off - which is what "delete" means for one with people in it. */
router.patch(
  "/departments/:id",
  requireAdmin,
  validate(updateDepartmentSchema),
  asyncHandler(async (req, res) => {
    const { name, isActive } = req.body as { name?: string; isActive?: boolean };
    const department = await adminService.updateDepartment(
      req.params.id as string,
      { name, isActive },
      req.supabaseUserId
    );
    res.json(department);
  })
);

/**
 * Remove one outright. Only ever possible while it is empty: `departmentId` is
 * required on a user, so deleting a department with people in it would mean
 * orphaning or deleting them, and the service refuses in words rather than
 * letting the foreign key refuse in Latin.
 */
router.delete(
  "/departments/:id",
  requireAdmin,
  validate(deleteDepartmentSchema),
  asyncHandler(async (req, res) => {
    const result = await adminService.deleteDepartment(
      req.params.id as string,
      req.supabaseUserId
    );
    res.json(result);
  })
);

router.get(
  "/users",
  requireAdmin,
  validate(listAdminUsersSchema),
  asyncHandler(async (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q : undefined;
    const limit =
      typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;
    const offset =
      typeof req.query.offset === "string" ? Number(req.query.offset) : undefined;

    const result = await adminService.listUsers({ q, limit, offset });
    res.json(result);
  })
);

router.post(
  "/users/bulk",
  requireStepUp,
  requireAdmin,
  // After multer, not before: the form's fields only exist on the body once
  // the multipart body has been read, so a schema in front of it would judge
  // every upload against an empty object.
  uploadSpreadsheet.single("file"),
  validate(bulkImportUsersSchema),
  asyncHandler(async (req, res) => {
    if (!req.file) {
      throw errors.badRequest("A CSV or Excel file is required");
    }

    const result = await adminService.bulkCreateUsers(req.file, req.supabaseUserId);
    res.status(201).json(result);
  })
);

router.get(
  "/users/:id",
  requireAdmin,
  validate(getAdminUserSchema),
  asyncHandler(async (req, res) => {
    const user = await adminService.getUser(req.params.id as string);
    res.json(user);
  })
);

/**
 * What stops if this person does.
 *
 * On the admin router rather than beside the other document reads, because it
 * is reached from a person: the People screen, and the confirmation shown
 * before an account is switched off. It crosses every memo in the
 * organisation by construction, which is why it is an administrator's alone.
 */
router.get(
  "/users/:id/holds",
  requireAdmin,
  validate(getAdminUserSchema),
  asyncHandler(async (req, res) => {
    res.json(await documentsService.getMemosHeldBy(req.params.id as string));
  })
);

/**
 * Switch an account off, or back on.
 *
 * Its own route rather than a field on the edit form. It is not an edit: it
 * ends every session the account holds, it is the only thing in the product
 * that stops somebody signing in, and the trail has to say plainly that it
 * happened - a "user updated" row is not an answer to "who can still get in".
 */
router.post(
  "/users/:id/active",
  requireAdmin,
  /*
   * Switching somebody off hands every approval step and delegation they
   * hold to a successor in one go - more than moving a single step, which
   * already asks. So it asks too. Switching an account back on moves nothing.
   */
  requireStepUpWhen((req) => (req.body as { active?: unknown } | undefined)?.active === false),
  validate(setUserActiveSchema),
  asyncHandler(async (req, res) => {
    const { active, successorId } = req.body as { active: boolean; successorId?: string };

    res.json(
      await adminService.setUserActive(
        req.params.id as string,
        active,
        req.supabaseUserId as string,
        req.ip,
        successorId
      )
    );
  })
);

router.patch(
  "/users/:id",
  requireAdmin,
  validate(updateAdminUserSchema),
  asyncHandler(async (req, res) => {
    // Renaming somebody or moving their department is routine. Setting their
    // password, changing the address it resets to, or changing what they are
    // allowed to do is how one account is taken over through another, so
    // those ask the administrator to confirm it is them.
    if (
      (await adminService.isSensitiveEdit(
        req.params.id as string,
        req.body as UpdateAdminUserInput
      )) &&
      !(await stepUpConfirmed(req))
    ) {
      throw stepUpRequired();
    }

    const user = await adminService.updateUser(
      req.params.id as string,
      req.body,
      req.supabaseUserId
    );
    res.json(user);
  })
);

router.post(
  "/users",
  requireAdmin,
  validate(createAdminUserSchema),
  asyncHandler(async (req, res) => {
    // Making another administrator is handing over everything this account
    // can do.
    if (
      (req.body as CreateAdminUserInput).loginRole === "ADMINISTRATOR" &&
      !(await stepUpConfirmed(req))
    ) {
      throw stepUpRequired();
    }

    const user = await adminService.createUser(req.body, req.supabaseUserId);
    res.status(201).json(user);
  })
);

// There is no DELETE /users/:id. People are switched off through
// POST /users/:id/active and never deleted: a deleted row rewrote the actor
// on sealed audit records and broke the ledger. See adminService.

/**
 * How the outbox is doing.
 *
 * "Why was I never told?" is a support question in every deployment that
 * sends mail, and without this the only answer is a database prompt. Counts
 * by state, plus the last few that were refused and the reason each was given.
 */
router.get(
  "/mail",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    res.json(await emailService.queueSummary());
  })
);

/**
 * Ask Microsoft whether this configuration is real, without sending anything.
 *
 * Separate from the test message because the two fail for unrelated reasons
 * and are fixed in different places: this says whether the directory, the
 * application and the secret agree and whether the mailbox exists, and the
 * test message says whether a message actually arrives. Told only that "mail
 * does not work", an administrator has no way to tell a wrong client secret
 * from a mailbox that was never licensed.
 *
 * Rate-limited with the test sender, because it also talks to Microsoft.
 */
router.post(
  "/mail/test-connection",
  requireAdmin,
  mailTestLimiter,
  asyncHandler(async (_req, res) => {
    try {
      res.json(await testMailConnection());
    } catch (error) {
      // The message is already written for an administrator - `graphMailer`
      // turns Microsoft's codes into something actionable - so it is passed
      // through rather than replaced with a generic failure.
      throw errors.badRequest(
        error instanceof Error ? error.message : "Could not reach the mail provider."
      );
    }
  })
);

/**
 * Prove the mail path works, before a memo depends on it.
 *
 * `configured` only ever meant two environment variables were set. Whether the
 * host answers, whether the credentials are accepted, whether the relay allows
 * this sender - none of that was knowable without assigning a real memo to a
 * real approver and waiting to see if they complained.
 *
 * It sends to the administrator's own address, looked up from the database.
 * There is no recipient in the request body and there must never be one: an
 * endpoint that mails chosen text to a chosen address is an open relay.
 */
router.post(
  "/mail/test",
  requireAdmin,
  mailTestLimiter,
  asyncHandler(async (req, res) => {
    const result = await emailService.sendTestNotice(req.supabaseUserId!);
    res.json(result);
  })
);

/**
 * Set the mail server from the administration screens.
 *
 * The environment variables still work and still take over when nothing is
 * stored here, which is what keeps existing deployments and CI unchanged. What
 * this adds is a way through for the administrator who discovers on the morning
 * of go-live that the relay is on a different port, and has no shell on the
 * box.
 *
 * A note on the password, since this is the endpoint that moved it: it is
 * written encrypted (`lib/secretBox`), it is never read back to any client, and
 * an empty field means "leave the stored one alone" so that changing a port
 * does not require knowing it.
 */
router.put(
  "/mail/settings",
  requireStepUp,
  requireAdmin,
  validate(updateMailSettingsSchema),
  asyncHandler(async (req, res) => {
    await mailSettingsService.save(
      req.body,
      req.supabaseUserId!,
      req.ip
    );

    // The queue summary, so the screen re-renders from what is now live rather
    // than from what it hoped it had saved.
    res.json(await emailService.queueSummary());
  })
);

/**
 * Hand mail back to the server's environment.
 *
 * The way out of a configuration that cannot reach a relay, for somebody who
 * cannot get a shell either. With nothing in the environment this simply turns
 * delivery off, which is a state the application is built to run in.
 */
router.delete(
  "/mail/settings",
  requireStepUp,
  requireAdmin,
  asyncHandler(async (req, res) => {
    await mailSettingsService.clear(req.supabaseUserId!, req.ip);
    res.json(await emailService.queueSummary());
  })
);

/**
 * The app registration people sign in through.
 *
 * A SECOND registration, with nothing in common with the one above that sends
 * mail: that one is app-only, holds Mail.Send, never sees a browser and has no
 * redirect URI. This one is a delegated sign-in that redirects back here and
 * asks only who somebody is. Pasting one into the other is the obvious mistake
 * to make, which is why they are separate screens and separate rows.
 *
 * The secret is write-only, like the mail one: stored encrypted, never read
 * back to any client, and an empty field means "keep the one you have".
 */
router.get(
  "/sso/settings",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    res.json(await ssoSettingsService.get());
  })
);

router.put(
  "/sso/settings",
  requireStepUp,
  requireAdmin,
  validate(updateSsoSettingsSchema),
  asyncHandler(async (req, res) => {
    await ssoSettingsService.save(req.body, req.supabaseUserId!, req.ip);
    res.json(await ssoSettingsService.get());
  })
);

/** Turn it off and forget the registration entirely. */
router.delete(
  "/sso/settings",
  requireStepUp,
  requireAdmin,
  asyncHandler(async (req, res) => {
    await ssoSettingsService.clear(req.supabaseUserId!, req.ip);
    res.json(await ssoSettingsService.get());
  })
);

/**
 * The two workflow policies, and where each answer is coming from.
 *
 * The deadline is the one worth a screen. With none set the sweep runs every
 * cycle and finds nothing, so no approver is ever chased and the first anyone
 * hears of it is a memo three weeks late - a state a deployment should not
 * have to learn about by reading `.env.example`. What the environment alone
 * says travels with the answer, so somebody about to hand the policy back can
 * see what they would be left with.
 */
router.get(
  "/workflow/settings",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    res.json(await workflowSettingsService.get());
  })
);

/**
 * Set them from the administration screens.
 *
 * `slaDefaultDays: null` stores "no deadline" - a policy, not an absence. The
 * environment variables still work and still answer when nothing is stored,
 * which is what leaves existing deployments and CI untouched.
 */
router.put(
  "/workflow/settings",
  requireStepUp,
  requireAdmin,
  validate(updateWorkflowSettingsSchema),
  asyncHandler(async (req, res) => {
    await workflowSettingsService.save(req.body, req.supabaseUserId!, req.ip);

    // What is now live, so the screen re-renders from that rather than from
    // what it hoped it had saved.
    res.json(await workflowSettingsService.get());
  })
);

/**
 * Hand the policy back to the server's environment.
 *
 * Not the same as clearing the deadline field, which stores "no deadline".
 * This removes the row, so whatever the environment says answers again.
 */
router.delete(
  "/workflow/settings",
  requireStepUp,
  requireAdmin,
  asyncHandler(async (req, res) => {
    await workflowSettingsService.clear(req.supabaseUserId!, req.ip);
    res.json(await workflowSettingsService.get());
  })
);

/**
 * The paper a generated memo is drawn on.
 *
 * Served with the sheet sizes and the bounds rather than leaving the screen to
 * hold its own copy: a slider that stops somewhere different from where the
 * validator refuses is a form that rejects what it just let somebody set.
 *
 * `default` travels too, so "put it back how it was" is a button rather than
 * four numbers the administrator has to be told over the phone.
 */
router.get(
  "/page-setup",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    res.json({
      setup: await pageSetupService.getPageSetup(),
      default: DEFAULT_PAGE_SETUP,
      papers: Object.entries(PAPER).map(([name, size]) => ({ name, ...size })),
      bounds: { minMargin: MIN_MARGIN, maxMargin: MAX_MARGIN },
    });
  })
);

/**
 * Change it.
 *
 * Takes effect on the next memo drawn, and on nothing already filed: each
 * version records the page it was drawn on, and the stored artefact is never
 * re-rendered. Audited, because "why does this memo look different from that
 * one" is a question with an answer.
 */
router.put(
  "/page-setup",
  requireAdmin,
  validate(updatePageSetupSchema),
  asyncHandler(async (req, res) => {
    const before = await pageSetupService.getPageSetup();

    const setup = await pageSetupService.update(
      req.body,
      req.supabaseUserId!,
      (await brandingService.getBranding()).organisationName ||
        DEFAULT_ORGANISATION_NAME
    );

    await auditService.createAuditLog({
      actorId: req.supabaseUserId!,
      action: "PAGE_SETUP_UPDATED",
      entityType: "BrandingSetting",
      entityId: PAGE_SETUP_AUDIT_ID,
      oldValue: before,
      newValue: setup,
      ipAddress: req.ip,
    });

    res.json({
      setup,
      default: DEFAULT_PAGE_SETUP,
      papers: Object.entries(PAPER).map(([name, size]) => ({ name, ...size })),
      bounds: { minMargin: MIN_MARGIN, maxMargin: MAX_MARGIN },
    });
  })
);

/*
 * Standard wording.
 *
 * Every clause, archived ones included, so that "put it back" is possible.
 * What preparers see is served from the memo-drafts router, which is theirs.
 */
router.get(
  "/memo-clauses",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    res.json({ clauses: await memoClausesService.list({ includeArchived: true }) });
  })
);

router.post(
  "/memo-clauses",
  requireAdmin,
  validate(createMemoClauseSchema),
  asyncHandler(async (req, res) => {
    const clause = await memoClausesService.create(req.body, req.supabaseUserId!);

    await auditService.createAuditLog({
      actorId: req.supabaseUserId!,
      action: "MEMO_CLAUSE_CREATED",
      entityType: "MemoClause",
      entityId: clause.id,
      newValue: { title: clause.title },
      ipAddress: req.ip,
    });

    res.status(201).json({ clause });
  })
);

/**
 * Change the words, rename, archive or restore. One route, because the
 * screen offers them on one row; the audit row still says which happened.
 */
router.put(
  "/memo-clauses/:id",
  requireAdmin,
  validate(updateMemoClauseSchema),
  asyncHandler(async (req, res) => {
    const { before, after } = await memoClausesService.update(
      req.params.id as string,
      req.body,
      req.supabaseUserId!
    );

    const wasArchived = before.archivedAt !== null;
    const isArchived = after.archivedAt !== null;
    const action =
      !wasArchived && isArchived
        ? "MEMO_CLAUSE_ARCHIVED"
        : wasArchived && !isArchived
          ? "MEMO_CLAUSE_RESTORED"
          : "MEMO_CLAUSE_UPDATED";

    await auditService.createAuditLog({
      actorId: req.supabaseUserId!,
      action,
      entityType: "MemoClause",
      entityId: after.id,
      oldValue: { title: before.title, archived: wasArchived },
      newValue: { title: after.title, archived: isArchived },
      ipAddress: req.ip,
    });

    res.json({ clause: after });
  })
);

/**
 * The organisation's dictionary: the words the memo editor's spell check
 * should not flag. Kept by an administrator, one word at a time, each
 * addition and removal recorded.
 */
router.get(
  "/memo-dictionary",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    res.json({ words: await memoDictionaryService.list() });
  })
);

router.post(
  "/memo-dictionary",
  requireAdmin,
  validate(addDictionaryWordSchema),
  asyncHandler(async (req, res) => {
    const word = await memoDictionaryService.add(req.body.word, req.supabaseUserId!);

    await auditService.createAuditLog({
      actorId: req.supabaseUserId!,
      action: "MEMO_DICTIONARY_WORD_ADDED",
      entityType: "MemoDictionaryWord",
      entityId: word.id,
      newValue: { word: word.word },
      ipAddress: req.ip,
    });

    res.status(201).json({ word });
  })
);

router.delete(
  "/memo-dictionary/:id",
  requireAdmin,
  validate(dictionaryWordIdSchema),
  asyncHandler(async (req, res) => {
    const word = await memoDictionaryService.remove(req.params.id as string);

    await auditService.createAuditLog({
      actorId: req.supabaseUserId!,
      action: "MEMO_DICTIONARY_WORD_REMOVED",
      entityType: "MemoDictionaryWord",
      entityId: word.id,
      oldValue: { word: word.word },
      ipAddress: req.ip,
    });

    res.json({ word });
  })
);

/**
 * What each role may do.
 *
 * Static, and deliberately served rather than kept in the frontend: a screen
 * that says "an administrator can configure mail" should be reciting the
 * server's own description, not a second copy of it written in TypeScript that
 * nothing checks. If the two ever disagree, this is the one that is right.
 */
router.get(
  "/access-control",
  requireAdmin,
  // No asyncHandler: there is nothing to await, and wrapping a synchronous
  // read in a promise only to satisfy a signature is a lie about the work.
  (_req, res) => {
    res.json(accessControlMatrix());
  }
);

/**
 * Who is signed in, and who just signed out.
 *
 * The question an administrator cannot currently answer at all: sessions were
 * only ever listable for the account asking. Names and departments come with
 * the rows because "3 sessions from 10.2.4.7" is not an answer anybody can act
 * on - "Ayesha Khan, Finance, since 09:12" is.
 */
router.get(
  "/sessions",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    res.json(await sessionsService.listAll());
  })
);

/**
 * Take two-step sign-in off somebody's account.
 *
 * The lost-phone-and-lost-envelope path, and the reason a second factor is
 * shippable at all here: this deployment has five accounts, and a person
 * locked out of their own approvals with no way back is a worse outcome than
 * the one the factor prevents.
 *
 * It does not switch anything on, set anything up, or touch the password. The
 * person is back to signing in the way they did before, and can enrol again
 * from their own account page whenever they have a phone to do it with.
 */
router.delete(
  "/users/:id/two-factor",
  requireStepUp,
  requireAdmin,
  validate(resetUserTwoFactorSchema),
  asyncHandler(async (req, res) => {
    await adminService.assertMayActOnAccount(req.supabaseUserId!, req.params.id as string);
    const result = await totpService.resetFor(
      req.params.id as string,
      req.supabaseUserId,
      req.ip
    );
    res.json(result);
  })
);

/**
 * End everything one account holds.
 *
 * `endAll` rather than ending a single row, and that is the point rather than
 * a shortcut: revoking one session leaves the access token in that tab working
 * until it expires. Moving the account's cutoff is the only thing that reaches
 * a token the server has never been shown, which is what somebody reporting a
 * lost laptop actually means.
 */
router.post(
  "/users/:id/sessions/end",
  requireAdmin,
  validate(endUserSessionsSchema),
  asyncHandler(async (req, res) => {
    const userId = req.params.id as string;

    // Refused here rather than letting it half-work: an administrator ending
    // their own sessions from this screen would be signed out by their own
    // click, with no warning that the button meant that. Their own devices are
    // on their account page, where it says so.
    if (userId === req.supabaseUserId) {
      throw errors.badRequest(
        "This would sign you out. End your own sessions from your account page."
      );
    }

    await adminService.assertMayActOnAccount(req.supabaseUserId!, userId);

    const result = await sessionsService.endAll(userId, {
      actorId: req.supabaseUserId,
      ipAddress: req.ip,
    });

    res.json(result);
  })
);

/**
 * Set an administrator's tier and powers.
 *
 * Super Administrators only: `admins.manage` is never given to anybody else,
 * so the router-wide guard refuses every other administrator. Confirmed like
 * every change made in somebody's name, and recorded.
 */
router.put(
  "/users/:id/powers",
  requireStepUp,
  validate(setAdminPowersSchema),
  asyncHandler(async (req, res) => {
    res.json(
      await adminService.setAdminPowers(
        req.params.id as string,
        req.body as { isSuperAdmin: boolean; powers: string[] },
        req.supabaseUserId!,
        req.ip
      )
    );
  })
);

/**
 * Hand the Super Administrator role to somebody else - there is one at a
 * time. The current one only (`admins.manage`), confirmed, and recorded.
 */
router.post(
  "/super-admin/transfer",
  requireStepUp,
  validate(transferSuperAdminSchema),
  asyncHandler(async (req, res) => {
    res.json(
      await adminService.transferSuperAdmin(
        (req.body as { userId: string }).userId,
        req.supabaseUserId,
        req.ip
      )
    );
  })
);

/**
 * The office calendar deadlines are counted on - its time zone and public
 * holidays. The workflow-policy power, and the same confirmation the policy
 * itself asks for, because moving either moves every deadline.
 */
router.get(
  "/calendar",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    res.json(await calendarService.get());
  })
);

router.put(
  "/calendar",
  requireStepUp,
  requireAdmin,
  validate(setOfficeTimeZoneSchema),
  asyncHandler(async (req, res) => {
    res.json(
      await calendarService.setTimeZone(
        (req.body as { timeZone: string }).timeZone,
        req.supabaseUserId!,
        req.ip
      )
    );
  })
);

router.post(
  "/calendar/holidays",
  requireStepUp,
  requireAdmin,
  validate(addPublicHolidaySchema),
  asyncHandler(async (req, res) => {
    res
      .status(201)
      .json(
        await calendarService.addHoliday(
          req.body as { date: string; name: string },
          req.supabaseUserId!,
          req.ip
        )
      );
  })
);

router.delete(
  "/calendar/holidays/:id",
  requireStepUp,
  requireAdmin,
  validate(publicHolidayIdSchema),
  asyncHandler(async (req, res) => {
    res.json(
      await calendarService.removeHoliday(req.params.id as string, req.supabaseUserId!, req.ip)
    );
  })
);

/**
 * The route each kind of memo starts from (fit-gap decision 7). The
 * workflow-design power; changing one asks the confirmation every other
 * change to who signs asks for.
 */
router.get(
  "/memo-type-routes",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    res.json({ routes: await memoTypeRoutesService.list() });
  })
);

router.put(
  "/memo-type-routes/:key",
  requireStepUp,
  requireAdmin,
  validate(memoTypeRouteSchema),
  asyncHandler(async (req, res) => {
    res.json({
      routes: await memoTypeRoutesService.set(
        req.params.key as string,
        (req.body as { templateId: string | null }).templateId,
        req.supabaseUserId!,
        req.ip
      ),
    });
  })
);

export default router;
