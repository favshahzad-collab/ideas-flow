import { describe, expect, it } from "vitest";
import { noticeBody, noticeSubject, renderNotice } from "./emailTemplates";

/**
 * The subject line of an approval request is the thing somebody decides
 * whether to open, and the body is what they act on from their phone. Both are
 * worth pinning without a mail server in the room.
 */

const notice = (overrides: Partial<Parameters<typeof noticeSubject>[0]> = {}) => ({
  type: "APPROVAL_NEEDED" as const,
  recipientFirstName: "Bilal",
  message: 'Document "Annual increment" requires your review and approval.',
  documentId: "3f2a9b1c-0d4e-4f5a-8b6c-7d8e9f0a1b2c",
  documentTitle: "Office Memorandum — annual increment, Mr Bilal Khan",
  documentReference: "MEMO-2026-0007",
  appUrl: "https://flow.example.com",
  ...overrides,
});

describe("the subject line", () => {
  it("leads with what is being asked, then names the memo", () => {
    // Read in a list of forty other subjects: the verb first is what makes it
    // sortable by eye.
    expect(noticeSubject(notice())).toBe(
      "Approval needed: MEMO-2026-0007 — Office Memorandum — annual increment, Mr Bilal Khan"
    );
  });

  it.each([
    ["APPROVED", "Approved"],
    ["REJECTED", "Rejected"],
    ["REVISION_REQUESTED", "Revision requested"],
    ["RESUBMITTED", "Resubmitted"],
    ["DOCUMENT_DELETED", "Withdrawn"],
  ] as const)("says %s as %s", (type, verb) => {
    expect(noticeSubject(notice({ type }))).toMatch(new RegExp(`^${verb}: `));
  });

  it("lets a caller name an event its type alone would name wrongly", () => {
    // `APPROVED` is both "a step was signed, the memo moved on" and "the memo
    // is finished". The type cannot tell them apart; the caller can.
    expect(
      noticeSubject(
        notice({ type: "APPROVED", subjectVerb: "Approval progress" })
      )
    ).toBe(
      "Approval progress: MEMO-2026-0007 — Office Memorandum — annual increment, Mr Bilal Khan"
    );
  });

  it.each([undefined, null, "   "])(
    "falls back to the type's own verb when the override is %p",
    (subjectVerb) => {
      expect(noticeSubject(notice({ type: "APPROVED", subjectVerb }))).toMatch(
        /^Approved: /
      );
    }
  );

  it("keeps the reference whole when it shortens a long title", () => {
    // The reference is the handle somebody quotes back. A subject that cut it
    // off would be unsearchable in the one place people search.
    const subject = noticeSubject(
      notice({ documentTitle: "A".repeat(300) })
    );

    expect(subject).toContain("MEMO-2026-0007");
    expect(subject.length).toBeLessThanOrEqual(90);
    expect(subject.endsWith("…")).toBe(true);
  });

  it("still says something for a memo with no reference yet", () => {
    expect(noticeSubject(notice({ documentReference: null }))).toBe(
      "Approval needed: Office Memorandum — annual increment, Mr Bilal Khan"
    );
  });

  it("falls back to the verb alone rather than a dangling colon", () => {
    expect(
      noticeSubject(notice({ documentReference: null, documentTitle: null }))
    ).toBe("Approval needed");
  });

  it("flattens a title somebody pasted with newlines in it", () => {
    expect(
      noticeSubject(
        notice({ documentReference: null, documentTitle: "Two\nlines  here" })
      )
    ).toBe("Approval needed: Two lines here");
  });
});

describe("the body", () => {
  it("opens with the reader's name and says what is wanted", () => {
    const body = noticeBody(notice());

    expect(body.startsWith("Bilal,")).toBe(true);
    expect(body).toContain("requires your review and approval");
  });

  it("carries the reference and the title as facts, not prose", () => {
    const body = noticeBody(notice());

    expect(body).toContain("Reference: MEMO-2026-0007");
    expect(body).toContain("Memo: Office Memorandum");
  });

  it("links straight to the memo", () => {
    // The alternative is "log in and find it", which is how an approval waits
    // three days.
    expect(noticeBody(notice())).toContain(
      "https://flow.example.com/documents/3f2a9b1c-0d4e-4f5a-8b6c-7d8e9f0a1b2c"
    );
  });

  it("omits the link rather than pointing at nothing", () => {
    const body = noticeBody(notice({ documentId: null }));

    expect(body).not.toContain("Open it here");
    expect(body).not.toContain("/documents/");
  });

  it("says replies are not read, and where to write instead", () => {
    // Somebody will reply to it. Being told once, in the mail, is the
    // difference between a comment on the memo and a lost sentence.
    const body = noticeBody(notice());

    expect(body).toContain("Replies to it are not read");
    expect(body).toContain("comment thread");
  });

  it("keeps the raise-it-now footer for a security alert, which has no memo", () => {
    const body = noticeBody(
      notice({ type: "SECURITY_ALERT", documentId: null })
    );

    expect(body).toContain("If you did not do this, tell your administrator now.");
  });

  it("does not put that footer on an ordinary notice that merely has no link", () => {
    /*
     * A step moved to another approver: the person it was taken from can no
     * longer open the memo, so the notice carries no link - and used to
     * inherit the security wording by that alone. "If you did not do this,
     * tell your administrator now", sent to somebody who did nothing and to
     * whom nothing has happened except that a job left their desk.
     */
    const body = noticeBody(
      notice({ type: "STEP_REASSIGNED", documentId: null })
    );

    expect(body).toContain("Replies to it are not read");
    expect(body).not.toContain("If you did not do this");
    expect(body).not.toContain("comment thread");
  });

  it("is plain text with no markup in it", () => {
    expect(noticeBody(notice())).not.toMatch(/<[a-z][\s\S]*>/i);
  });
});

describe("renderNotice", () => {
  it("gives back the same two pieces the queue stores", () => {
    const rendered = renderNotice(notice());

    expect(rendered).toEqual({
      subject: noticeSubject(notice()),
      body: noticeBody(notice()),
    });
  });
});
