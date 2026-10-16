import { z } from "zod";
import { newPasswordField } from "../lib/passwordPolicy";

// Deliberately no maximum on the password here, unlike sign-up: whatever is
// already stored has to keep working, and a cap added at the door would lock
// out anyone whose password manager generated a longer one.
export const loginSchema = z.object({
  body: z.object({
    email: z.string().email("Invalid email address"),
    // Any length: the rule for new passwords must not lock out a stored one.
    password: z.string().min(1, "Enter your password"),
  }),
});

/*
 * Sign-up writes the same `users` row the admin screen writes, so it is held
 * to the same rules as createAdminUserSchema.
 *
 * Untrimmed, `firstName: " "` passed the minimum and was stored as a blank
 * name: the person then appears as an empty cell in the approver picker, in
 * the audit export beside a real approval, and in every notification that
 * names them - and nothing in the product can repair it except an admin edit.
 * The lengths match the columns (VarChar(100)/VarChar(255)), so a long paste
 * is refused with a message instead of arriving as a Prisma 500.
 */
export const signUpSchema = z.object({
  body: z.object({
    email: z
      .string()
      .trim()
      .min(1, "Email is required")
      .max(255, "Email cannot exceed 255 characters")
      .email("Invalid email address"),
    password: newPasswordField(),
    firstName: z
      .string()
      .trim()
      .min(1, "First name is required")
      .max(100, "First name cannot exceed 100 characters"),
    lastName: z
      .string()
      .trim()
      .min(1, "Last name is required")
      .max(100, "Last name cannot exceed 100 characters"),
    departmentId: z.uuid("Invalid department ID"),
  }),
});

export const refreshTokenSchema = z.object({
  body: z.object({
    refreshToken: z.string().min(1, "Refresh token is required"),
  }),
});

export type LoginInput = z.infer<typeof loginSchema>["body"];
/**
 * Signing out.
 *
 * Both fields optional, and the absence of each means something. No
 * `refreshToken` means the caller cannot name the session it is in, so every
 * session ends rather than none. `everywhere` is the deliberate version of
 * the same thing, and is the only one that reaches an access token already
 * issued.
 */
export const signOutSchema = z.object({
  body: z.object({
    refreshToken: z.string().trim().min(1).optional(),
    everywhere: z.coerce.boolean().optional(),
  }),
});

export type SignOutInput = z.infer<typeof signOutSchema>["body"];
export type SignUpInput = z.infer<typeof signUpSchema>["body"];
export type RefreshTokenInput = z.infer<typeof refreshTokenSchema>["body"];

/**
 * The one-time code the sign-in redirect hands to the application.
 *
 * Bounded because it is the one guessable thing in the flow: 32 random bytes
 * as base64url is 43 characters, and anything else is refused before it
 * reaches a database lookup.
 */
export const ssoExchangeSchema = z.object({
  body: z.object({
    code: z
      .string()
      .trim()
      .min(20, "That sign-in link is not valid. Start again from the sign-in screen.")
      .max(200, "That sign-in link is not valid. Start again from the sign-in screen."),
  }),
});

/**
 * Six digits, or one recovery code, into the same field.
 *
 * Loose on purpose: an authenticator app shows the code in two groups of
 * three, a recovery code is transcribed off paper in groups of four, and
 * people paste both with whatever spacing they were shown. The service
 * strips separators and decides which kind it is - a schema that insisted on
 * exactly six digits here would refuse every recovery code before it arrived.
 */
export const twoFactorSchema = z.object({
  body: z.object({
    challenge: z
      .string()
      .trim()
      .min(20, "That sign-in has expired. Start again from the sign-in screen.")
      .max(200, "That sign-in has expired. Start again from the sign-in screen."),
    code: z
      .string()
      .trim()
      .min(1, "Enter the code from your authenticator app")
      .max(64, "That code is too long to be one of ours"),
  }),
});

/** Confirming enrolment, and trading a live code for a new set of recovery codes. */
/**
 * Confirming it is you before a sensitive change: the password, or a code
 * from the authenticator app. Exactly one, so the server never has to guess
 * which a six-digit password was meant to be.
 */
export const stepUpSchema = z.object({
  body: z
    .object({
      password: z.string().min(1).max(500).optional(),
      code: z.string().trim().min(6).max(20).optional(),
    })
    .strict()
    .refine((body) => Boolean(body.password) !== Boolean(body.code), {
      message: "Enter your password or a code from your authenticator app.",
    }),
});

export const totpCodeSchema = z.object({
  body: z.object({
    code: z
      .string()
      .trim()
      .min(6, "Enter the six-digit code from your authenticator app")
      .max(20, "Enter the six-digit code from your authenticator app"),
  }),
});

/**
 * Turning the factor off needs the password, not a code: the threat is an
 * unlocked laptop, and a phone in a pocket across the room is no obstacle to
 * whoever sat down at it.
 */
export const totpDisableSchema = z.object({
  body: z.object({
    password: z.string().min(1, "Enter your password to confirm"),
  }),
});

export type TwoFactorInput = z.infer<typeof twoFactorSchema>["body"];
export type TotpCodeInput = z.infer<typeof totpCodeSchema>["body"];
export type TotpDisableInput = z.infer<typeof totpDisableSchema>["body"];
