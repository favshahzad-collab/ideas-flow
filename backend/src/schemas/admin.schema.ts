import { z } from "zod";
import { newPasswordField } from "../lib/passwordPolicy";

/**
 * The widths of the columns these fields land in (prisma/schema.prisma: both
 * names are VarChar(100), email is VarChar(255)). Postgres refuses anything
 * longer with an error the handler cannot recognise, so without these caps an
 * administrator who pastes a long name is told the server broke instead of
 * which field does not fit.
 */
export const USER_NAME_MAX_LENGTH = 100;
export const USER_EMAIL_MAX_LENGTH = 255;
/**
 * The job title printed under a signature (users.designation, VarChar(120)).
 * Same reasoning as the names: past the column Postgres refuses the write with
 * an error the handler cannot read, so an administrator who pastes a long
 * title is told the server broke rather than that the title does not fit.
 */
export const USER_DESIGNATION_MAX_LENGTH = 120;
/**
 * Nothing bounds the password column - it stores a fixed-length scrypt hash -
 * so this cap is about the work of hashing rather than about storage. It sits
 * far above anything a password manager generates, because a password refused
 * here is one somebody has already saved and can no longer use.
 */
export const USER_PASSWORD_MAX_LENGTH = 200;

/** Keeps one oversized directory from becoming one oversized response. */
export const ADMIN_USERS_DEFAULT_LIMIT = 50;
export const ADMIN_USERS_MAX_LIMIT = 200;

// A path id that reaches Prisma unchecked is not a 404: the driver rejects a
// malformed uuid with an error the handler cannot recognise, so a stale
// bookmark or a link that lost a character tells the administrator the system
// broke rather than that the account is gone.
const adminUserIdParams = z.object({
  id: z.uuid("That user link is not valid. Open the person from the People list."),
});

/**
 * The one field that reads the same on create as on edit, so it is written
 * once: a title nobody has recorded yet is not a mistake to refuse - the memo
 * simply prints the signature without a line under it - which is why an empty
 * string is accepted here and stored as "no title" rather than as a blank one.
 */
const designationField = z
  .string()
  .trim()
  .max(
    USER_DESIGNATION_MAX_LENGTH,
    `Designation must be ${USER_DESIGNATION_MAX_LENGTH} characters or fewer`
  )
  .optional();

export const listAdminUsersSchema = z.object({
  query: z.object({
    /** Free-text match on name, email or department. */
    q: z.string().trim().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(ADMIN_USERS_MAX_LIMIT).optional(),
    offset: z.coerce.number().int().min(0).optional(),
  }),
});

export const getAdminUserSchema = z.object({
  params: adminUserIdParams,
});

/**
 * Switching an account off, or back on.
 *
 * `active` rather than two routes with no body, because the two are one
 * decision with two settings and a screen that reads the current state should
 * send the state it wants - not a verb whose meaning depends on what the row
 * happened to say when it was drawn.
 */
export const setUserActiveSchema = z.object({
  params: adminUserIdParams,
  body: z.object({
    active: z.boolean(),
    /*
     * Who takes over the approvals of somebody being switched off. Required
     * by the service while they still have steps on open memos; ignored when
     * switching an account back on.
     */
    successorId: z.uuid("Choose who takes over their approvals").optional(),
  }),
});

/**
 * Departments.
 *
 * The name is the whole of a department, so the bounds matter more than they
 * would elsewhere: `VarChar(255)` in the column, trimmed here, and refused
 * when empty. A department called " " is one nobody can pick out of a list.
 */
export const DEPARTMENT_NAME_MAX_LENGTH = 255;

const departmentName = z
  .string()
  .trim()
  .min(1, "Department name is required")
  .max(
    DEPARTMENT_NAME_MAX_LENGTH,
    `Department name must be ${DEPARTMENT_NAME_MAX_LENGTH} characters or fewer`
  );

const departmentIdParams = z.object({
  id: z.string().uuid("Invalid department id"),
});

export const listDepartmentsSchema = z.object({
  query: z.object({
    /*
     * Off by default, and that default is load-bearing. Everything that asked
     * for this list before the management screen existed is asking "what may I
     * assign somebody to", and a department that has been switched off is
     * exactly the answer they must not be given.
     */
    includeInactive: z.enum(["true", "false"]).optional(),
  }),
});

export const createDepartmentSchema = z.object({
  body: z.strictObject({ name: departmentName }),
});

export const updateDepartmentSchema = z.object({
  params: departmentIdParams,
  body: z
    .strictObject({
      name: departmentName.optional(),
      isActive: z.boolean().optional(),
    })
    .refine((body) => body.name !== undefined || body.isActive !== undefined, {
      message: "Give a new name, or whether it is switched on.",
    }),
});

export const deleteDepartmentSchema = z.object({
  params: departmentIdParams,
});

/**
 * The import carries its people in the uploaded file, and multer puts any
 * other text part of the form on the body. Refusing an unknown one tells an
 * administrator who added a field expecting it to apply to the whole file that
 * nothing on the server reads it, rather than importing as though they never
 * typed it.
 */
/**
 * The mail configuration, as an administrator types it.
 *
 * Two providers in one form, because they answer the same question and an
 * administrator switching between them is answering it again rather than
 * doing something else. What each one needs is checked in the service, where
 * the stored secrets are also in scope - a client secret that is already
 * saved makes the field optional, and a schema cannot see that.
 *
 * Every message here is written for somebody configuring mail while a go-live
 * waits on them, so each says what to do rather than what is wrong.
 */
export const updateMailSettingsSchema = z.object({
  body: z.object({
    provider: z.enum(["SMTP", "MICROSOFT_GRAPH"]),

    /** The sender, in two parts, because Graph will not take them as one. */
    fromName: z
      .string()
      .trim()
      .max(255, "That name is too long.")
      .optional()
      .or(z.literal("")),
    fromAddress: z
      .string()
      .trim()
      .min(1, "Enter the address notices should come from.")
      .max(320, "That address is too long.")
      .refine(
        (value) => /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(value),
        "Enter just the address, like no-reply@example.com. The display name goes in the field above."
      ),

    // ---------------------------------------------------------------- SMTP
    host: z
      .string()
      .trim()
      .max(255, "That hostname is too long to be one.")
      .optional()
      .or(z.literal("")),
    port: z.coerce
      .number()
      .int("A port is a whole number.")
      .min(1, "Ports start at 1.")
      .max(65535, "Ports stop at 65535.")
      .optional(),
    /*
     * Not derived from the port. `lib/mailer` already treats 465 as implicit
     * TLS, and an administrator who unticks this for a relay that disagrees
     * needs the box to win. Turning it on for 587 is what produces
     * "wrong version number", which is why the screen explains the pairing.
     */
    secure: z.boolean().optional().default(false),
    username: z
      .string()
      .trim()
      .max(255, "That username is too long.")
      .optional()
      .or(z.literal("")),
    /** Blank means "keep whatever is stored". See `clearPassword`. */
    password: z
      .string()
      .max(500, "That password is too long.")
      .optional()
      .or(z.literal("")),
    clearPassword: z.boolean().optional(),

    // ------------------------------------------------------ Microsoft Graph
    tenantId: z
      .string()
      .trim()
      .max(100, "That tenant ID is too long.")
      .optional()
      .or(z.literal("")),
    clientId: z
      .string()
      .trim()
      .max(100, "That client ID is too long.")
      .optional()
      .or(z.literal("")),
    /** Blank means "keep whatever is stored", exactly like the password. */
    clientSecret: z
      .string()
      .max(1000, "That client secret is too long.")
      .optional()
      .or(z.literal("")),
    clearClientSecret: z.boolean().optional(),
    /**
     * The mailbox Graph sends as. Defaults to the sending address, which is
     * what it is unless somebody has deliberately made them differ.
     */
    mailbox: z
      .string()
      .trim()
      .max(320, "That address is too long.")
      .optional()
      .or(z.literal("")),
    saveToSentItems: z.boolean().optional(),

    appUrl: z
      .string()
      .trim()
      .max(2048, "That address is too long.")
      .optional()
      .or(z.literal(""))
      .refine(
        (value) => !value || /^https?:\/\/\S+$/.test(value),
        "Start it with http:// or https:// - this is the address people will click in an email."
      ),
  }),
});

export type UpdateMailSettingsInput = z.infer<
  typeof updateMailSettingsSchema
>["body"];

/**
 * The two workflow policies.
 *
 * `slaDefaultDays` is nullable on purpose, and null is an answer rather than
 * an omission: it means no deadline, nobody chased, no due date invented on a
 * queue. Handing the policy back to the environment is a different act with
 * its own route, so nothing here needs to mean "unset".
 *
 * The ceiling is a year. There is no deadline a memo can sensibly have that is
 * longer, and the field is a number box somebody can fat-finger.
 */
export const updateWorkflowSettingsSchema = z.object({
  body: z.object({
    slaDefaultDays: z
      .number("Enter a whole number of working days, or leave it empty.")
      .int("A deadline is counted in whole working days.")
      .min(1, "A deadline has to be at least one working day.")
      .max(365, "A deadline longer than a year is almost certainly a mistake.")
      .nullable(),
    allowStepSkip: z.boolean(),
    /*
     * Whether submitting a document also means signing it.
     *
     * Required rather than optional, like the skip flag beside it: a save
     * that left it out would be read as `undefined` and written as false,
     * silently taking the author's signature off every document an
     * organisation files from then on.
     */
    preparerSignsOnSubmit: z.boolean(),
    /*
     * Whether the final approval seals the approved PDF. Required for the
     * same reason: left out, it would be written as false and quietly stop
     * sealing every memo approved from then on.
     */
    sealApprovedMemos: z.boolean(),
    /*
     * Also move memos already in progress onto this policy. Off unless asked:
     * a memo keeps the rules its approval cycle started with, and changing
     * them for memos in flight is a deliberate act, recorded as such.
     */
    applyToInProgress: z.boolean().optional(),
  }),
});

export type UpdateWorkflowSettingsInput = z.infer<
  typeof updateWorkflowSettingsSchema
>["body"];

/**
 * The sign-in app registration.
 *
 * Every identifier is optional because none is ever sent back to the screen in
 * full, so an untouched form arrives blank and must not be read as "delete
 * it". The service keeps whatever is stored when a field is empty, and refuses
 * to switch sign-in ON while anything it needs is still missing.
 */
export const updateSsoSettingsSchema = z.object({
  body: z.object({
    enabled: z.boolean(),
    tenantId: z
      .string()
      .trim()
      .max(100, "That directory ID is too long.")
      .optional(),
    clientId: z
      .string()
      .trim()
      .max(100, "That application ID is too long.")
      .optional(),
    clientSecret: z
      .string()
      .max(500, "That client secret is too long.")
      .optional(),
    redirectUri: z
      .string()
      .trim()
      .max(2048, "That redirect URI is too long.")
      .refine(
        (value) => value === "" || /^https?:\/\//.test(value),
        "Start it with https:// - or http:// for localhost while developing - exactly as registered in Entra."
      )
      .optional(),
  }),
});

export type UpdateSsoSettingsInput = z.infer<
  typeof updateSsoSettingsSchema
>["body"];

export const bulkImportUsersSchema = z.object({
  body: z.strictObject({}),
});

export const updateAdminUserSchema = z.object({
  params: adminUserIdParams,
  body: z
    .object({
      email: z
        .string()
        .trim()
        .min(1, "Email is required")
        .max(
          USER_EMAIL_MAX_LENGTH,
          `Email must be ${USER_EMAIL_MAX_LENGTH} characters or fewer`
        )
        .email("Enter a valid email address")
        .optional(),
      password: newPasswordField().optional(),
      firstName: z
        .string()
        .trim()
        .min(1, "First name is required")
        .max(
          USER_NAME_MAX_LENGTH,
          `First name must be ${USER_NAME_MAX_LENGTH} characters or fewer`
        )
        .optional(),
      lastName: z
        .string()
        .trim()
        .min(1, "Last name is required")
        .max(
          USER_NAME_MAX_LENGTH,
          `Last name must be ${USER_NAME_MAX_LENGTH} characters or fewer`
        )
        .optional(),
      designation: designationField,
      /** Who this person reports to; null clears it. */
      lineManagerId: z
        .uuid("Choose the line manager from the list.")
        .nullable()
        .optional(),
      departmentId: z
        .string()
        .trim()
        .min(1, "Department is required")
        .uuid("Please select a valid department")
        .optional(),
      loginRole: z.enum(["ADMINISTRATOR", "USER"], {
        message: "Role must be User or Administrator",
      }).optional(),
    })
    .refine((data) => Object.keys(data).length > 0, {
      message: "At least one field is required",
    }),
});

export const createAdminUserSchema = z.object({
  body: z.object({
    email: z
      .string()
      .trim()
      .min(1, "Email is required")
      .max(
        USER_EMAIL_MAX_LENGTH,
        `Email must be ${USER_EMAIL_MAX_LENGTH} characters or fewer`
      )
      .email("Enter a valid email address"),
    password: newPasswordField(),
    firstName: z
      .string()
      .trim()
      .min(1, "First name is required")
      .max(
        USER_NAME_MAX_LENGTH,
        `First name must be ${USER_NAME_MAX_LENGTH} characters or fewer`
      ),
    lastName: z
      .string()
      .trim()
      .min(1, "Last name is required")
      .max(
        USER_NAME_MAX_LENGTH,
        `Last name must be ${USER_NAME_MAX_LENGTH} characters or fewer`
      ),
    designation: designationField,
    /** Who this person reports to; null clears it. */
    lineManagerId: z
      .uuid("Choose the line manager from the list.")
      .nullable()
      .optional(),
    departmentId: z
      .string()
      .trim()
      .min(1, "Department is required")
      .uuid("Please select a valid department"),
    loginRole: z.enum(["ADMINISTRATOR", "USER"], {
      message: "Role must be User or Administrator",
    }),
  }),
});

export type CreateAdminUserInput = z.infer<typeof createAdminUserSchema>["body"];
export type UpdateAdminUserInput = z.infer<typeof updateAdminUserSchema>["body"];
export type ListAdminUsersQuery = z.infer<typeof listAdminUsersSchema>["query"];

/** Ending one account's sessions. The id is the whole request. */
export const endUserSessionsSchema = z.object({
  params: adminUserIdParams,
});

/** Lifting somebody's second factor. The id is the whole of the request. */
export const resetUserTwoFactorSchema = z.object({
  params: adminUserIdParams,
});

/**
 * An administrator's tier and powers, as a Super Administrator sets them.
 * `powers` is ignored for a Super Administrator, who holds every one.
 */
export const transferSuperAdminSchema = z.object({
  body: z.object({ userId: z.string().uuid() }),
});

export const setAdminPowersSchema = z.object({
  params: adminUserIdParams,
  body: z.object({
    isSuperAdmin: z.boolean(),
    powers: z.array(z.string().min(1).max(64)).max(64),
  }),
});
