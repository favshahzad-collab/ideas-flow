/**
 * The kinds of memo that can be typed in the portal.
 *
 * A second type is an entry in this table plus, optionally, the name of a
 * workflow template to pre-fill its chain. It is deliberately not a Prisma
 * enum: an enum would make "add a memo type" a schema migration, applied by
 * a deployment, rather than a line of configuration.
 *
 * Everything here renders through the one template in `lib/memoTemplate`.
 * A type that genuinely needs a different layout is the point at which this
 * grows a renderer key; nothing needs that yet, and inventing it now would
 * be a shape guessed rather than observed.
 */

export type MemoTypeDefinition = {
  /** Stored in `documents.memo_type`. Never renamed once memos carry it. */
  key: string;
  /** What the preparer picks from a list. */
  label: string;
  /** One line under that label. */
  description: string;
  /**
   * The workflow template whose chain this type starts from, by name. The
   * preparer may still adjust it within whatever the policy allows, and a
   * name that matches nothing simply means no pre-fill - a memo type is not
   * worth refusing over a template somebody renamed.
   */
  defaultTemplateName?: string;
  /**
   * Starting point for the body, so the preparer types into a memo rather
   * than into a blank page. Headings only: the prose is theirs.
   */
  outlineHeadings: string[];
  /**
   * Does writing this kind of memo mean signing it?
   *
   * Left unset, the organisation's policy answers. Set, it wins either way:
   * a memo somebody authors in their own name is signed by them whatever the
   * default is, and a form they merely lodge is not.
   *
   * When this comes out false the preparer takes no column on the printed
   * strip, because a ruled line nobody will ever sign is a decoration that
   * makes the document look unfinished forever.
   */
  preparerSigns?: boolean;
};

const DEFINITIONS: MemoTypeDefinition[] = [
  {
    key: "APPROVAL_REQUEST",
    label: "Approval Request",
    description:
      "A recommendation put to management for approval - an allowance, a purchase, a change in terms.",
    defaultTemplateName: "Office Memorandum — standard",
    /*
     * The shape of the paper form, with the fuel taken out of it.
     *
     * This replaced a FUEL_REQUEST type whose outline said "Employee
     * Details:" - useful for an allowance memo and wrong for every other
     * recommendation written on the same three-part structure. "Details:"
     * carries the same section without deciding what it is about.
     */
    outlineHeadings: ["BACKGROUND:", "Details:", "Recommendation"],
    /*
     * Whoever writes this recommends it in their own name, so they sign it -
     * which is what the paper form has always shown. Stated rather than
     * inherited: an organisation turning the default off must not silently
     * take the author's signature off a document that recommends something.
     */
    preparerSigns: true,
  },
  {
    key: "OFFICE_MEMORANDUM",
    label: "Office Memorandum",
    description:
      "Any other memo. The subject, the department and the wording are yours.",
    defaultTemplateName: "Office Memorandum — standard",
    /*
     * No outline, deliberately.
     *
     * An Approval Request has a shape the paper form has always had, so handing
     * the preparer its headings saves them retyping it. A general memo does
     * not: its subject and its department change with every one written,
     * which is exactly why this type exists. Dropping BACKGROUND / Employee
     * Details / Recommendation into it would be inventing a structure nobody
     * asked for, and the preparer would have to delete it before writing.
     */
    outlineHeadings: [],
    /*
     * Left unset on purpose: the organisation's policy answers.
     *
     * An Approval Request states `true` because whoever writes it authors and
     * recommends it in their own name. A general memo is whatever somebody
     * writes, so whether preparing one means signing it is the deployment's
     * decision - the one on Administration -> Workflow policy - rather than
     * something this registry should decide on their behalf.
     */
  },
];

const BY_KEY = new Map(DEFINITIONS.map((type) => [type.key, type]));

export function listMemoTypes(): MemoTypeDefinition[] {
  return [...DEFINITIONS];
}

export function isMemoType(value: unknown): value is string {
  return typeof value === "string" && BY_KEY.has(value);
}

export function findMemoType(key: string): MemoTypeDefinition | null {
  return BY_KEY.get(key) ?? null;
}

/**
 * Every key that exists, for a zod enum and for error messages.
 *
 * Returned as a list rather than a union type because the registry is data:
 * a caller that wants to know what is valid should ask, not hardcode it.
 */
export function memoTypeKeys(): string[] {
  return DEFINITIONS.map((type) => type.key);
}
