import { LoginRole } from "../generated/prisma/client";

/**
 * What each role may do, written down once.
 *
 * This is a description of the rules, not the rules themselves. Enforcement
 * stays exactly where it was - `requireAdmin` on the routes, and
 * `documentAccess` for who may see which memo - because a second thing that
 * decides access is a second thing that can disagree with the first, and the
 * one people would notice disagreeing is the one that lets somebody in.
 *
 * So why write it down at all? Because until now the answer to "what can a
 * reviewer see?" existed only as guards spread across fourteen route files,
 * which meant nobody could be shown it. An administrator assigning a role was
 * choosing between two words with no way to find out what either bought. This
 * turns that into something a screen can render and a person can read before
 * they decide.
 *
 * The honesty of it rests on `routes`, and on the test that walks them: every
 * capability here names the routes that implement it, and the route test
 * refuses to pass if a capability claims a route that is not guarded the way
 * this file says it is. A description that can drift from the thing it
 * describes is worse than no description, because it will be believed.
 */

export type CapabilityGroup =
  | "Memos"
  | "Approvals"
  | "Oversight"
  | "Administration";

export type CapabilityId =
  | "memos.prepare"
  | "memos.view.own"
  | "memos.view.assigned"
  | "memos.view.all"
  | "memos.comment"
  | "approvals.act"
  | "approvals.delegate"
  | "audit.view"
  | "audit.verify"
  | "audit.export"
  | "approvals.oversee"
  | "approvals.reassign"
  | "approvals.holders"
  | "memos.cancel"
  | "audit.administration"
  | "users.manage"
  | "departments.manage"
  | "workflows.manage"
  | "workflows.policy"
  | "documents.pageSetup"
  | "documents.clauses"
  | "documents.dictionary"
  | "mail.configure"
  | "sso.configure"
  | "admins.manage"
  | "sessions.view";

export type CapabilityDescriptor = {
  id: CapabilityId;
  group: CapabilityGroup;
  /** What it is, in the words somebody would use asking for it. */
  title: string;
  /** What it actually buys, including the limits. */
  detail: string;
  roles: readonly LoginRole[];
  /**
   * The routes that implement it, as `METHOD /path`.
   *
   * `:id` stands for any identifier. Empty only where a capability is a
   * property of a route's *contents* rather than of the route itself - the
   * scoping capabilities below, which every document route applies.
   */
  routes: readonly string[];
};

const EVERYONE: readonly LoginRole[] = [LoginRole.ADMINISTRATOR, LoginRole.USER];
const ADMIN_ONLY: readonly LoginRole[] = [LoginRole.ADMINISTRATOR];

export const CAPABILITIES: readonly CapabilityDescriptor[] = [
  {
    id: "memos.prepare",
    group: "Memos",
    title: "Prepare and submit memos",
    detail:
      "Create a memo, attach supporting files, choose its approval chain and submit it. Editing stops the moment it is submitted.",
    roles: EVERYONE,
    routes: ["POST /api/documents/", "PATCH /api/documents/:id", "POST /api/documents/:id/withdraw"],
  },
  {
    id: "memos.view.own",
    group: "Memos",
    title: "See their own memos",
    detail: "Everything they prepared, at every stage, including drafts nobody else can see.",
    roles: EVERYONE,
    routes: [],
  },
  {
    id: "memos.view.assigned",
    group: "Memos",
    title: "See memos assigned to them",
    detail:
      "A memo where they sit on the approval chain - and only once the workflow has reached their step. A later approver cannot read a memo that is still with an earlier one.",
    roles: EVERYONE,
    routes: [],
  },
  {
    id: "memos.view.all",
    group: "Oversight",
    title: "See every memo, at any stage",
    detail:
      "Including memos they took no part in, and memos that are finished. The two rules above scope everybody else to what they wrote or were asked to approve; this is the exception, and it is reading only - an administrator has no step on somebody else's chain and cannot approve, sign or edit in their place.",
    roles: ADMIN_ONLY,
    /*
     * No routes, like the two scoping rules above it. This describes how every
     * document route filters its contents rather than a door that opens or
     * does not, so there is no endpoint to name.
     */
    routes: [],
  },
  {
    id: "memos.comment",
    group: "Memos",
    title: "Comment on a memo they can see",
    detail: "On the memos above, and no others.",
    roles: EVERYONE,
    routes: ["POST /api/documents/:id/comments"],
  },
  {
    id: "approvals.act",
    group: "Approvals",
    title: "Approve, reject or return their own steps",
    detail:
      "Only the step currently assigned to them. Being on a chain twice does not let somebody decide a step that is not theirs, and no role lets anybody decide a step assigned to another person.",
    roles: EVERYONE,
    routes: [
      "POST /api/documents/:id/approve",
      "POST /api/documents/:id/reject",
      "POST /api/documents/:id/request-revision",
    ],
  },
  {
    id: "approvals.delegate",
    group: "Approvals",
    title: "Delegate their approvals",
    detail:
      "Hand their own steps to a colleague for a period. A delegate covers approvals only - never the delegator's drafts.",
    roles: EVERYONE,
    routes: ["GET /api/delegations/", "POST /api/delegations/", "DELETE /api/delegations/:id"],
  },
  {
    id: "audit.view",
    group: "Oversight",
    title: "Read the audit ledger",
    detail:
      "Scoped the same way memos are: the trail shows the history of the memos they can see, and the integrity summary, which is deliberately open to everybody signed in.",
    roles: EVERYONE,
    routes: ["GET /api/audit/documents", "GET /api/audit/ledger"],
  },
  {
    id: "audit.verify",
    group: "Oversight",
    title: "Re-verify the whole audit chain",
    detail:
      "Seal what is outstanding and recompute every record. Administrators only - not because the answer is sensitive, but because the work is minutes long on a large trail.",
    roles: ADMIN_ONLY,
    routes: ["POST /api/audit/ledger/verify"],
  },
  {
    id: "audit.export",
    group: "Oversight",
    title: "Export the audit ledger for an auditor",
    detail:
      "The whole sealed chain as a file an auditor checks with a standalone script, without this application. It carries every record's content, IP addresses included, so it asks the administrator to confirm it is them, and taking it is recorded.",
    roles: ADMIN_ONLY,
    routes: ["GET /api/audit/ledger/export"],
  },
  {
    id: "approvals.oversee",
    group: "Oversight",
    title: "See every memo in flight",
    detail:
      "The oversight queue: every workflow in the organisation, including memos the viewer is not party to. The one capability that crosses the scoping rules above.",
    roles: ADMIN_ONLY,
    routes: ["GET /api/documents/oversight"],
  },
  {
    id: "approvals.reassign",
    group: "Oversight",
    title: "Move a step to a different approver",
    detail:
      "Where a memo has stopped because the person holding it cannot act - they have left, they are away with no cover, they should never have been asked - the step can be handed to somebody else, with a reason that goes on the memo's thread and into the trail. It is the only way to change who signs a memo after it was submitted. It does not confer the approval itself: the new approver signs it, and an administrator with no step on the chain still cannot.",
    roles: ADMIN_ONLY,
    routes: ["POST /api/documents/:id/reassign-step"],
  },
  {
    id: "memos.cancel",
    group: "Oversight",
    title: "Cancel an abandoned memo",
    detail:
      "Where a memo's preparer has left or stopped answering and it sits in approvers' queues, it can be cancelled with a reason. It stays on record, marked cancelled, and the preparer and the chain are told. An approved or rejected memo cannot be cancelled.",
    roles: ADMIN_ONLY,
    routes: ["POST /api/documents/:id/cancel"],
  },
  {
    id: "approvals.holders",
    group: "Oversight",
    title: "See what one person is holding up",
    detail:
      "Every memo in the organisation that stops at one named person: the ones sitting with them now, the ones whose chains reach them further down, and the ones sent back to them for revision. The question asked when somebody resigns or goes on long leave - what breaks on Friday - which the product could otherwise only answer by opening every memo in flight and reading its chain. Reading only: it moves nothing.",
    roles: ADMIN_ONLY,
    routes: ["GET /api/admin/users/:id/holds"],
  },
  {
    id: "audit.administration",
    group: "Oversight",
    title: "Read the administration trail",
    detail:
      "Every change to the system rather than to a memo: accounts made and edited, roles changed, a second factor reset, departments, delegations, the approval routes, the workflow policy, mail and sign-on. Who did it, when, and from where. Every one of these was already recorded and sealed into the ledger; none of it could be read anywhere until this existed. Not scoped to the reader, because it is the record of what administrators do.",
    roles: ADMIN_ONLY,
    routes: ["GET /api/audit/administration"],
  },
  {
    id: "sessions.view",
    group: "Oversight",
    title: "See who is signed in",
    detail:
      "Open sessions across the organisation, with the person, their department and where they signed in from - and the power to end any of them.",
    roles: ADMIN_ONLY,
    routes: ["GET /api/admin/sessions", "POST /api/admin/users/:id/sessions/end"],
  },
  {
    id: "users.manage",
    group: "Administration",
    title: "Manage people",
    detail:
      "Create accounts, edit them, set someone's system role, reset a password, turn off someone's two-step sign-in, and switch an account off when somebody leaves. Switching an account off stops that person signing in at all and ends every session they hold; it changes nothing they have already signed. Accounts are never deleted, because the audit ledger names everybody who acted. Resetting a password ends every session that account holds.",
    roles: ADMIN_ONLY,
    routes: [
      "GET /api/admin/users",
      "GET /api/admin/users/:id",
      "POST /api/admin/users/:id/active",
      "POST /api/admin/users",
      "PATCH /api/admin/users/:id",
      "POST /api/admin/users/bulk",
      // Lifting a second factor: the lost-phone path, and also exactly what
      // somebody with a stolen administrator session would reach for.
      "DELETE /api/admin/users/:id/two-factor",
      "POST /api/auth/sign-up",
      // Reading this description is itself an administrator's privilege, and
      // the screen is reached from the same place people are managed.
      "GET /api/admin/access-control",
    ],
  },
  {
    id: "departments.manage",
    group: "Administration",
    title: "Manage departments",
    detail: "Create, rename and retire departments. One with people in it cannot be removed.",
    roles: ADMIN_ONLY,
    routes: [
      "GET /api/admin/departments",
      "POST /api/admin/departments",
      "PATCH /api/admin/departments/:id",
      "DELETE /api/admin/departments/:id",
    ],
  },
  {
    id: "workflows.manage",
    group: "Administration",
    title: "Design approval workflows",
    detail: "Build and edit the reusable chains that memos are submitted against, and choose the one each kind of memo starts from.",
    roles: ADMIN_ONLY,
    routes: [
      "GET /api/admin/workflow-templates/",
      "POST /api/admin/workflow-templates/",
      "PATCH /api/admin/workflow-templates/:id",
      "POST /api/admin/workflow-templates/:id/archive",
      "POST /api/admin/workflow-templates/:id/restore",
      "GET /api/admin/memo-type-routes",
      "PUT /api/admin/memo-type-routes/:id",
    ],
  },
  {
    id: "workflows.policy",
    group: "Administration",
    title: "Set the workflow policy",
    detail:
      "The deadline an approver is given before being chased, whether a preparer may pass over one, and the office calendar - time zone and public holidays - deadlines are counted on. Setting any of it is recorded.",
    roles: ADMIN_ONLY,
    routes: [
      "GET /api/admin/workflow/settings",
      "PUT /api/admin/workflow/settings",
      "DELETE /api/admin/workflow/settings",
      "GET /api/admin/calendar",
      "PUT /api/admin/calendar",
      "POST /api/admin/calendar/holidays",
      "DELETE /api/admin/calendar/holidays/:id",
    ],
  },
  {
    id: "documents.pageSetup",
    group: "Administration",
    title: "Set the memo page",
    detail:
      "The paper and margins every generated memo is drawn on. Changing it affects the next memo drawn and nothing already filed - each version records the page it was drawn on, because the audit trail cites its checksum. Changes are recorded.",
    roles: ADMIN_ONLY,
    routes: ["GET /api/admin/page-setup", "PUT /api/admin/page-setup"],
  },
  {
    id: "documents.clauses",
    group: "Administration",
    title: "Keep the standard wording",
    detail:
      "The blocks of wording a preparer can insert into a memo - a recommendation paragraph, an approval condition. A memo takes a copy, so editing or archiving a clause changes nothing already written. Changes are recorded.",
    roles: ADMIN_ONLY,
    routes: [
      "GET /api/admin/memo-clauses",
      "POST /api/admin/memo-clauses",
      "PUT /api/admin/memo-clauses/:id",
    ],
  },
  {
    id: "documents.dictionary",
    group: "Administration",
    title: "Keep the organisation's dictionary",
    detail:
      "The words the memo editor's spell check should not flag: products, terms of trade, the words the organisation writes its own way. Colleagues' names and department names are read from the directory and need no adding. Every word added or removed is recorded.",
    roles: ADMIN_ONLY,
    routes: [
      "GET /api/admin/memo-dictionary",
      "POST /api/admin/memo-dictionary",
      "DELETE /api/admin/memo-dictionary/:id",
    ],
  },
  {
    id: "sso.configure",
    group: "Administration",
    title: "Configure single sign-on",
    detail:
      "The Microsoft app registration people sign in through - a different one from the registration that sends mail. The secret is never shown back.",
    roles: ADMIN_ONLY,
    routes: [
      "GET /api/admin/sso/settings",
      "PUT /api/admin/sso/settings",
      "DELETE /api/admin/sso/settings",
    ],
  },
  {
    id: "mail.configure",
    group: "Administration",
    title: "Configure mail",
    detail:
      "Choose the provider, hold the credentials and send a test. Stored secrets are never shown back, to anybody.",
    roles: ADMIN_ONLY,
    routes: [
      "GET /api/admin/mail",
      "PUT /api/admin/mail/settings",
      "DELETE /api/admin/mail/settings",
      "POST /api/admin/mail/test",
      "POST /api/admin/mail/test-connection",
    ],
  },
  {
    id: "admins.manage",
    group: "Administration",
    title: "Manage administrators and their powers",
    detail:
      "Make somebody an administrator or a Super Administrator, take it away, and choose which powers each administrator holds. Super Administrators only, and never given to anybody else: an administrator who could raise their own powers would hold all of them. Every change asks to confirm it is them and is recorded.",
    roles: ADMIN_ONLY,
    routes: ["PUT /api/admin/users/:id/powers", "POST /api/admin/super-admin/transfer"],
  },
];

/**
 * Powers held only by a Super Administrator and never given to anybody else.
 *
 * Managing administrators, because an administrator able to change powers
 * could give themselves every one. Single sign-on and mail, because each
 * holds credentials that act for the whole organisation: whoever controls
 * sign-on controls who gets in, and whoever controls mail can impersonate
 * the system to every colleague.
 */
export const SUPER_ADMIN_ONLY: readonly CapabilityId[] = [
  "admins.manage",
  "sso.configure",
  "mail.configure",
];

/** Powers a Super Administrator can give to an administrator, one by one. */
export const GRANTABLE_POWERS: readonly CapabilityId[] = CAPABILITIES.filter(
  (capability) =>
    !capability.roles.includes(LoginRole.USER) &&
    !SUPER_ADMIN_ONLY.includes(capability.id)
).map((capability) => capability.id);

/**
 * What a newly made administrator starts with: seeing where work is, and no
 * power to change anything. Least privilege - a Super Administrator adds what
 * the job needs.
 */
export const DEFAULT_ADMIN_POWERS: readonly CapabilityId[] = [
  "approvals.oversee",
  "approvals.holders",
];

/*
 * Seeing an area without being able to change it.
 *
 * Most powers are a screen and the changes made on it - "Manage people" is
 * both reading the list and editing it. A Super Administrator can give the
 * reading half alone, as `<power>:view`: the screen's GET routes open, and
 * every route that changes something stays shut. Only powers that have both
 * halves can be given this way; one that is only reading (the oversight
 * queue) or only an action (re-verifying the chain) is already one or the
 * other. Exporting the ledger is a GET that hands over everything, so it is
 * never a "view".
 */
const VIEW_SUFFIX = ":view";

export const VIEWABLE_POWERS: readonly CapabilityId[] = CAPABILITIES.filter((capability) => {
  if (!GRANTABLE_POWERS.includes(capability.id)) return false;
  const methods = capability.routes.map((route) => route.split(" ")[0]);
  return methods.includes("GET") && methods.some((method) => method !== "GET");
}).map((capability) => capability.id);

/** The stored form of "may see this area, may not change it". */
export function viewPower(id: CapabilityId): string {
  return `${id}${VIEW_SUFFIX}`;
}

/** Whether a stored power is one a Super Administrator may give. */
export function isGrantablePower(power: string): boolean {
  if (power.endsWith(VIEW_SUFFIX)) {
    return VIEWABLE_POWERS.includes(power.slice(0, -VIEW_SUFFIX.length) as CapabilityId);
  }
  return GRANTABLE_POWERS.includes(power as CapabilityId);
}

/** The parts of an account that decide what it may do. */
export type AccessHolder = {
  loginRole: LoginRole;
  isSuperAdmin: boolean;
  adminPowers: readonly string[];
};

/**
 * What this person holds.
 *
 * Everybody holds what every signed-in user holds. A Super Administrator holds
 * everything. Any other administrator holds, beyond that, exactly the powers
 * given to them - and never a Super-Administrator-only one, even if the column
 * somehow says so.
 */
export function capabilitiesOf(holder: AccessHolder): CapabilityId[] {
  return CAPABILITIES.filter((capability) => {
    if (capability.roles.includes(LoginRole.USER)) return true;
    if (holder.loginRole !== LoginRole.ADMINISTRATOR) return false;
    if (holder.isSuperAdmin) return true;
    return (
      GRANTABLE_POWERS.includes(capability.id) &&
      holder.adminPowers.includes(capability.id)
    );
  }).map((capability) => capability.id);
}

/**
 * The areas this person may see but not change: given as `<power>:view`, and
 * not also held in full. Empty for a Super Administrator, who holds them all.
 */
export function viewOnlyOf(holder: AccessHolder): CapabilityId[] {
  if (holder.loginRole !== LoginRole.ADMINISTRATOR || holder.isSuperAdmin) return [];
  const full = capabilitiesOf(holder);
  return VIEWABLE_POWERS.filter(
    (id) => !full.includes(id) && holder.adminPowers.includes(viewPower(id))
  );
}

/** The select that reads an `AccessHolder` from a user row. */
export const ACCESS_SELECT = {
  loginRole: true,
  isSuperAdmin: true,
  adminPowers: true,
} as const;

/*
 * Every administrator route as a pattern, for finding which power a request
 * needs. Routes without parameters first, so "/users/bulk" is matched as
 * itself before "/users/:id" could claim it.
 */
const ROUTE_PATTERNS: { method: string; pattern: RegExp; capability: CapabilityId; params: number }[] =
  CAPABILITIES.flatMap((capability) =>
    capability.routes.map((route) => {
      const [method, path] = route.split(" ") as [string, string];
      const trimmed = path.replace(/\/$/, "");
      const params = (trimmed.match(/:[A-Za-z]+/g) ?? []).length;
      const source = trimmed
        .split("/")
        .map((segment) =>
          segment.startsWith(":") ? "[^/]+" : segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        )
        .join("/");
      return { method, pattern: new RegExp(`^${source}/?$`), capability: capability.id, params };
    })
  ).sort((a, b) => a.params - b.params);

/**
 * The power a request needs, from its method and path, or null when no power
 * names the route. Null is refused for a limited administrator: a route nobody
 * described is not one anybody was given.
 */
export function capabilityForRequest(method: string, path: string): CapabilityId | null {
  const bare = path.split("?")[0] ?? path;
  const found = ROUTE_PATTERNS.find(
    (entry) => entry.method === method.toUpperCase() && entry.pattern.test(bare)
  );
  return found?.capability ?? null;
}

/**
 * What a role holds at most: what an ADMINISTRATOR who is a Super
 * Administrator holds. For a real person use `capabilitiesOf`, which knows
 * which tier of administrator they are.
 */
export function capabilitiesFor(role: LoginRole): CapabilityId[] {
  return CAPABILITIES.filter((capability) => capability.roles.includes(role)).map(
    (capability) => capability.id
  );
}

/**
 * The matrix, for a screen to render.
 *
 * The roles come from the enum rather than a list here, so a role added to the
 * schema shows up as a column with nothing in it - visibly incomplete, rather
 * than silently absent.
 */
export function accessControlMatrix() {
  return {
    roles: Object.values(LoginRole),
    capabilities: CAPABILITIES.map((capability) => ({
      id: capability.id,
      group: capability.group,
      title: capability.title,
      detail: capability.detail,
      roles: [...capability.roles],
      /** A Super Administrator's alone, never given to anybody else. */
      superAdminOnly: SUPER_ADMIN_ONLY.includes(capability.id),
      /** A power a Super Administrator can give a limited administrator. */
      grantable: GRANTABLE_POWERS.includes(capability.id),
      /** What a newly made administrator starts with. */
      byDefault: DEFAULT_ADMIN_POWERS.includes(capability.id),
      /** Can be given as "see, not change" (`<id>:view`). */
      viewable: VIEWABLE_POWERS.includes(capability.id),
    })),
  };
}
