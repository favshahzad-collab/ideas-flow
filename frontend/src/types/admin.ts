export type User = {
  id: string
  email: string
  firstName: string
  lastName: string
  loginRole: string
  /** For an administrator: the top tier, holding every power. */
  isSuperAdmin?: boolean
  /** For a limited administrator: the powers a Super Administrator gave them. */
  adminPowers?: string[]
  /** Job title as printed under this person's signature. Null until recorded. */
  designation: string | null
  /**
   * Not nullable: `departmentId` is a required column and `listUsers` always
   * selects the relation. Typing it `| null` was what forced the edit modal to
   * read `user.department.id` through an `any`, hiding the mismatch.
   */
  department: { id: string; name: string }
  /**
   * Who this person reports to. Told when a memo has sat with this person
   * well past its deadline. Null until an administrator records one.
   */
  lineManagerId?: string | null
  /**
   * Memos waiting on this person right now: the step a live run is sitting
   * on, unactioned, for a document still out for review. Counted by the
   * server over every document - this screen is administrators only.
   */
  openApprovals: number
  /**
   * When this account was switched off, or null while it is in use.
   *
   * On the row rather than filtered out of the list: a people screen that
   * quietly hid switched-off accounts would answer "is Kazim still set up
   * here?" with silence, and silence reads as "no such person" - which is the
   * answer that gets an account created a second time.
   */
  deactivatedAt: string | null
  /**
   * Whether this person signs in with a code as well as a password.
   *
   * Optional on the wire so a client left open across a deploy of the older
   * server does not show the reset action on every row - absent reads as off,
   * and the server refuses the call anyway.
   */
  twoFactorEnabled?: boolean
  /**
   * The colleague signing in their place right now, if somebody is. Null for
   * almost everybody; `endsAt` is null for an arrangement that runs until it
   * is ended by hand.
   */
  coveredBy: {
    id: string
    firstName: string
    lastName: string
    endsAt: string | null
  } | null
  createdAt: string
  updatedAt: string
}

export type UpdateUserPayload = {
  /** Null clears it. */
  lineManagerId?: string | null
  firstName?: string
  lastName?: string
  email?: string
  password?: string
  departmentId?: string
  loginRole?: string
  /** Sent trimmed; an empty string clears the title. Never null on the wire. */
  designation?: string
}

export type BulkUserImportFailure = {
  row: number
  email?: string
  error: string
}

export type BulkUserImportResult = {
  created: number
  failed: BulkUserImportFailure[]
}