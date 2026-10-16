import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ApprovalType } from "../generated/prisma/browser";
import {
  createDocumentSchema,
  documentIdParamsSchema,
  DOCUMENTS_MAX_LIMIT,
  formatMemoReference,
  listDocumentsSchema,
  MEMO_REFERENCE_PATTERN,
  memoReferenceYearPrefix,
  supportingDocumentFileSchema,
  updateDocumentSchema,
} from "./documents.schema";

/**
 * The submit form is the widest input surface in the app: a title, a chain or
 * a template, and a signature placement the client computed from a canvas.
 * These are the refusals - what the API will not accept, and the message the
 * user is shown when it does not.
 */

const uuid = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;

const SIGNATURE = {
  consent: true,
  useSavedSignature: false,
  signatureImage: "aGVsbG8=",
  signaturePage: 1,
  signatureX: 100,
  signatureY: 200,
  signatureWidth: 120,
  signatureHeight: 40,
};

const CHAIN = [
  { userId: uuid(1), approvalType: ApprovalType.REVIEWER },
  { userId: uuid(2), approvalType: ApprovalType.FINAL_APPROVER },
];

const submit = (body: Record<string, unknown>) =>
  createDocumentSchema.safeParse({
    body: { title: "Q3 budget", signature: SIGNATURE, ...body },
    query: {},
    params: {},
  });

/** Every message the schema produced, flattened. */
const messages = (result: z.ZodSafeParseResult<unknown>) =>
  result.success ? [] : result.error.issues.map((issue) => issue.message);

describe("choosing a chain or a template", () => {
  it("accepts an inline approval chain", () => {
    expect(submit({ approvalChain: CHAIN }).success).toBe(true);
  });

  it("accepts a workflow template", () => {
    expect(submit({ templateId: uuid(9) }).success).toBe(true);
  });

  it("refuses a submission with neither", () => {
    expect(messages(submit({}))).toContain(
      "Either an approval chain or a workflow template is required"
    );
  });

  it("refuses a submission with both", () => {
    // The service would have to pick one, and picking silently is how a
    // document ends up routed somewhere nobody chose.
    expect(
      messages(submit({ approvalChain: CHAIN, templateId: uuid(9) }))
    ).toContain("Provide either an approval chain or a template, not both");
  });

  it("refuses an empty chain", () => {
    expect(messages(submit({ approvalChain: [] }))).toContain(
      "At least one approval step is required"
    );
  });

  it("refuses a step whose user id is not a uuid", () => {
    expect(
      messages(
        submit({
          approvalChain: [{ userId: "steve", approvalType: ApprovalType.FINAL_APPROVER }],
        })
      )
    ).toContain("Invalid user ID");
  });

  it("surfaces the chain rules from lib/approvalChain", () => {
    // The rules live there because a chain compiled from a template never
    // passes through this schema. This asserts the schema is wired to them,
    // not what they say - approvalChain.test.ts covers that.
    const result = submit({
      approvalChain: [
        { userId: uuid(1), approvalType: ApprovalType.REVIEWER },
        { userId: uuid(1), approvalType: ApprovalType.FINAL_APPROVER },
      ],
    });

    expect(result.success).toBe(false);
    expect(messages(result).length).toBeGreaterThan(0);
  });
});

describe("the title and description", () => {
  it("trims the title it stores", () => {
    const result = submit({ title: "  Q3 budget  ", approvalChain: CHAIN });

    expect(result.success && result.data.body.title).toBe("Q3 budget");
  });

  it("refuses a title that is only whitespace", () => {
    expect(messages(submit({ title: "   ", approvalChain: CHAIN }))).toContain(
      "Title is required"
    );
  });

  it("refuses a title over 500 characters", () => {
    expect(
      messages(submit({ title: "x".repeat(501), approvalChain: CHAIN }))
    ).toContain("Title cannot exceed 500 characters");
  });

  it("accepts a title of exactly 500 characters", () => {
    expect(submit({ title: "x".repeat(500), approvalChain: CHAIN }).success).toBe(
      true
    );
  });

  it("accepts an empty description", () => {
    expect(submit({ description: "", approvalChain: CHAIN }).success).toBe(true);
  });

  it("refuses a description over 5000 characters", () => {
    expect(
      messages(submit({ description: "x".repeat(5001), approvalChain: CHAIN }))
    ).toContain("Description cannot exceed 5000 characters");
  });
});

describe("the preparer's signature", () => {
  const withSignature = (signature: Record<string, unknown>) =>
    submit({ approvalChain: CHAIN, signature: { ...SIGNATURE, ...signature } });

  it("needs no image when the saved signature is used", () => {
    expect(
      withSignature({ useSavedSignature: true, signatureImage: undefined })
        .success
    ).toBe(true);
  });

  it("refuses a drawn signature with no image", () => {
    expect(
      messages(withSignature({ signatureImage: undefined }))
    ).toContain("Signature drawing is required");
  });

  it("refuses a blank drawn signature", () => {
    expect(messages(withSignature({ signatureImage: "   " }))).toContain(
      "Signature drawing is required"
    );
  });

  it("refuses an image that is not base64", () => {
    expect(
      messages(withSignature({ signatureImage: "<script>alert(1)</script>" }))
    ).toContain("Signature must be a valid base64-encoded image");
  });

  it("accepts a data url", () => {
    expect(
      withSignature({ signatureImage: "data:image/png;base64,aGVsbG8=" })
        .success
    ).toBe(true);
  });

  it("refuses a page number below one", () => {
    expect(messages(withSignature({ signaturePage: 0 }))).toContain(
      "Page number must be at least 1"
    );
  });

  it("refuses a signature with no width or no height", () => {
    expect(messages(withSignature({ signatureWidth: 0 }))).toContain(
      "Signature width must be positive"
    );
    expect(messages(withSignature({ signatureHeight: -5 }))).toContain(
      "Signature height must be positive"
    );
  });

  it("allows a negative offset", () => {
    // The client places the signature over a rendered preview and can drag it
    // partly off the page edge; clamping is the renderer's job, not the
    // schema's, and rejecting here would fail a submission that draws fine.
    expect(withSignature({ signatureX: -10 }).success).toBe(true);
  });
});

describe("updating a document", () => {
  const update = (body: Record<string, unknown>, id = uuid(1)) =>
    updateDocumentSchema.safeParse({
      body: { signature: SIGNATURE, ...body },
      params: { id },
      query: {},
    });

  it("accepts a resubmission that changes nothing but the file", () => {
    expect(update({}).success).toBe(true);
  });

  it("refuses a document id that is not a uuid", () => {
    expect(update({}, "not-an-id").success).toBe(false);
  });

  it("leaves whether a signature is required to the service", () => {
    // A revision goes back into the chain, and for most memos it carries the
    // preparer's mark for the same reason the first submission did. But
    // whether it does depends on the memo type and on the organisation's
    // policy, and this schema can see neither - so it accepts a request with
    // or without one, and `updateDocument` refuses the wrong one with a
    // sentence that can say why.
    expect(update({ signature: undefined }).success).toBe(true);
  });

  it("still refuses a signature that is malformed when one is sent", () => {
    // Optional is not unchecked. A box with no width is nonsense whoever the
    // policy says signs.
    expect(
      update({
        signature: { ...SIGNATURE, signatureWidth: 0 },
      }).success
    ).toBe(false);
  });

  it("applies the chain rules when a chain is supplied", () => {
    expect(update({ approvalChain: [] }).success).toBe(false);
  });
});

describe("opening a document by id", () => {
  const open = (id: string) =>
    documentIdParamsSchema.safeParse({ body: {}, query: {}, params: { id } });

  it("accepts a uuid", () => {
    expect(open(uuid(1)).success).toBe(true);
  });

  it("refuses an id that is not a uuid, and says what to do", () => {
    // Unchecked, this id reaches a uuid column and comes back as a 500, which
    // tells someone following a stale link that the system is broken rather
    // than that their link is.
    expect(messages(open("not-an-id"))).toContain(
      "That document link is not valid. Open the document from your list."
    );
  });

  it("checks the attachment id as well as the document id", () => {
    const result = supportingDocumentFileSchema.safeParse({
      body: {},
      query: {},
      params: { id: uuid(1), attachmentId: "42" },
    });

    expect(messages(result)).toContain(
      "That attachment link is not valid. Open the document and pick the attachment again."
    );
  });
});

describe("the document list query", () => {
  const list = (query: Record<string, unknown>) =>
    listDocumentsSchema.safeParse({ body: {}, query, params: {} });

  const parsed = (query: Record<string, unknown>) => {
    const result = list(query);
    if (!result.success) {
      throw new Error(messages(result).join(". "));
    }
    return result.data.query;
  };

  it("accepts a request with no parameters at all", () => {
    // This is what every screen sends today. A parameter that became
    // required here would empty the documents list, the approval queue and
    // the command palette in the same deploy.
    expect(parsed({})).toEqual({});
  });

  it("trims the search term", () => {
    expect(parsed({ q: "  q3 budget  " }).q).toBe("q3 budget");
  });

  it("refuses a search term longer than 200 characters", () => {
    expect(messages(list({ q: "x".repeat(201) }))).toContain(
      "Shorten the search to 200 characters or fewer."
    );
  });

  it("reads status as a comma-separated list", () => {
    expect(parsed({ status: "APPROVED,REJECTED" }).status).toEqual([
      "APPROVED",
      "REJECTED",
    ]);
  });

  it("accepts a status in the case the browser URL happens to carry", () => {
    // The screen keeps its filters lower-cased in the query string; refusing
    // that would make a shareable URL unshareable for no reason.
    expect(parsed({ status: "approved" }).status).toEqual(["APPROVED"]);
  });

  it("treats an empty status parameter as no status filter", () => {
    // A URL builder that writes "status=" is asking for everything, not for
    // documents whose status is the empty string.
    expect(parsed({ status: "" }).status).toEqual([]);
  });

  it("refuses a status the screen invented, naming the ones that exist", () => {
    // pending_approval is derived in the browser from the current step and is
    // not a stored value. Accepting it would silently answer with the whole
    // pending pile, which is a different set of documents.
    expect(messages(list({ status: "pending_approval" }))).toContain(
      "Filter by status using one or more of DRAFT, PENDING_REVIEW, " +
        "REVISION_REQUESTED, REJECTED, APPROVED, DELETED, separated by commas."
    );
  });

  it("accepts the four sort orders", () => {
    for (const sort of [
      "newest",
      "oldest",
      "recently_updated",
      "least_recently_updated",
    ]) {
      expect(parsed({ sort }).sort).toBe(sort);
    }
  });

  it("refuses a sort order it does not have", () => {
    expect(messages(list({ sort: "alphabetical" })).join()).toContain(
      "Sort by one of"
    );
  });

  it("reads limit and offset as numbers, not strings", () => {
    // They arrive from a query string, so anything that forgets to coerce
    // them ends up slicing an array with "12" and getting nothing.
    expect(parsed({ limit: "12", offset: "24" })).toMatchObject({
      limit: 12,
      offset: 24,
    });
  });

  it("refuses a page larger than the maximum", () => {
    expect(messages(list({ limit: String(DOCUMENTS_MAX_LIMIT + 1) }))).toContain(
      `Ask for at most ${DOCUMENTS_MAX_LIMIT} documents at a time.`
    );
  });

  it("refuses a limit that is not a whole number above zero", () => {
    expect(messages(list({ limit: "0" }))).toContain(
      "Ask for at least one document."
    );
    expect(messages(list({ limit: "1.5" }))).toContain(
      "Ask for a whole number of documents."
    );
    expect(messages(list({ limit: "lots" }))).toContain(
      "Ask for a whole number of documents."
    );
  });

  it("refuses a negative offset", () => {
    expect(messages(list({ offset: "-1" }))).toContain(
      "A page cannot start before the first document."
    );
  });
});

describe("the memo reference a person quotes", () => {
  it("writes the forty-third memo of 2026 as MEMO-2026-0043", () => {
    expect(formatMemoReference(2026, 43)).toBe("MEMO-2026-0043");
  });

  it("opens a year at 0001", () => {
    expect(formatMemoReference(2026, 1)).toBe("MEMO-2026-0001");
  });

  it("carries the year, because the sequence restarts every January", () => {
    // Without the year, the first memo of 2027 is the first memo of 2026:
    // two files, one reference, and no way to tell which one a reply that
    // quotes it is about.
    expect(formatMemoReference(2027, 1)).not.toBe(formatMemoReference(2026, 1));
  });

  it("grows a digit past the ten-thousandth memo rather than wrapping", () => {
    // The column is unique, so wrapping back to 0001 would refuse a real
    // submission - and if it did not, it would put a reference already
    // written on somebody's file cover onto a second memo.
    expect(formatMemoReference(2026, 10000)).toBe("MEMO-2026-10000");
  });

  it("recognises the references it writes", () => {
    for (const sequence of [1, 43, 9999, 10000]) {
      const reference = formatMemoReference(2026, sequence);
      expect(MEMO_REFERENCE_PATTERN.test(reference), reference).toBe(true);
    }
  });

  it("refuses to recognise a half-typed reference or a uuid", () => {
    // Anything that matches is treated as a reference somebody can be sent
    // back to. A uuid is not a reference, and "MEMO-2026-43" is what a person
    // types from memory - neither one identifies a memo on paper.
    for (const value of [
      "MEMO-2026-43",
      "2026-0043",
      "MEMO-26-0043",
      "memo-2026-0043",
      "MEMO-2026-0043-A",
      "00000000-0000-4000-8000-000000000001",
    ]) {
      expect(MEMO_REFERENCE_PATTERN.test(value), value).toBe(false);
    }
  });

  it("prefixes every reference of a year with that year's prefix", () => {
    // The service numbers a year by matching this prefix in SQL. A prefix
    // that did not line up with what the formatter writes would restart the
    // sequence at 1 on every submission, straight into the unique index.
    expect(memoReferenceYearPrefix(2026)).toBe("MEMO-2026-");
    expect(formatMemoReference(2026, 43).startsWith(memoReferenceYearPrefix(2026))).toBe(
      true
    );
  });
});

describe("the preparer agreeing to sign", () => {
  it("refuses a signature without the tick box, in words", () => {
    const { consent: _consent, ...unticked } = SIGNATURE;
    const result = createDocumentSchema.safeParse({
      body: { title: "Leave policy", approvalChain: CHAIN, signature: unticked },
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain(
      "Tick the box to confirm this is your signature."
    );
  });
});
