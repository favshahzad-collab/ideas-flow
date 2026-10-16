import { beforeEach, describe, expect, it } from "vitest";

import { PDFDocument } from "pdf-lib";

import { storageService } from "../lib/storage";
import { DEFAULT_PAGE_SETUP, PAPER, type PageSetup } from "../lib/memoTemplate/geometry";
import { prisma } from "../prisma";
import { chainOf, makeCast, signature, useCleanDatabase } from "../test/db";
import { brandingService } from "./branding.service";
import { documentsService } from "./documents.service";
import { memoPreviewService } from "./memoPreview.service";
import { pageSetupService } from "./pageSetup.service";

/**
 * The page setting, carried from the settings screen onto a filed memo.
 *
 * Two claims, and the second is the one the audit trail depends on:
 *
 *  1. Changing the setting changes the memo that gets filed, and the version
 *     row records the page it was drawn on.
 *  2. Changing it again AFTERWARDS does not change the memo already filed.
 *     A memo is write-once and its checksum is cited; a renderer that read
 *     the live setting would re-draw an old document into one that no longer
 *     matches the hash people signed against.
 */

useCleanDatabase();

let cast: Awaited<ReturnType<typeof makeCast>>;

beforeEach(async () => {
  cast = await makeCast();
  brandingService.forget();
  pageSetupService.forget();
});

const paragraph = (text: string) => ({
  type: "paragraph" as const,
  content: [{ type: "text" as const, text }],
});

const BODY = {
  type: "doc" as const,
  content: [
    paragraph(
      "It is submitted for kind consideration that the allowance below be revised."
    ),
  ],
};

async function setPage(setup: Partial<PageSetup>) {
  await pageSetupService.update(
    { ...DEFAULT_PAGE_SETUP, ...setup },
    cast.preparer.id,
    "Ideas Pvt Ltd"
  );
}

const file = async () => {
  const { document } = await documentsService.createDocument(
    {
      title: "Approval for Revision of Fuel Allowance",
      memoType: "APPROVAL_REQUEST",
      memoTo: "Sir BMD",
      memoFrom: "Human Resource Department",
      body: BODY,
      approvalChain: chainOf(cast.approver, cast.finalApprover),
      signature: signature(),
    },
    null,
    cast.preparer.id
  );

  const version = await prisma.documentVersion.findFirstOrThrow({
    where: { documentId: document.id },
  });

  return {
    document,
    version,
    bytes: await storageService.downloadDocument(version.originalStoragePath!),
  };
};

const firstPageOf = async (bytes: Buffer) =>
  (await PDFDocument.load(bytes)).getPage(0);

describe("filing a memo on the organisation's page", () => {
  it("records nothing while the organisation is on the default", async () => {
    const { version } = await file();

    // An empty column means "the page it has always been". Writing a copy of
    // the constant onto every version would make that meaning unreadable.
    expect(version.pageSetupJson).toBeNull();
  });

  it("still draws A4 by default", async () => {
    const page = await firstPageOf((await file()).bytes);

    expect(page.getWidth()).toBeCloseTo(PAPER.A4.width, 1);
    expect(page.getHeight()).toBeCloseTo(PAPER.A4.height, 1);
  });

  it("files onto Letter once an administrator chooses it", async () => {
    await setPage({ paper: "LETTER" });

    const filed = await file();
    const page = await firstPageOf(filed.bytes);

    expect(page.getWidth()).toBeCloseTo(PAPER.LETTER.width, 1);
    expect(page.getHeight()).toBeCloseTo(PAPER.LETTER.height, 1);
    expect(filed.version.pageSetupJson).toMatchObject({ paper: "LETTER" });
  });

  it("records the margins, not just the paper", async () => {
    await setPage({ marginLeft: 90, marginRight: 36 });

    const { version } = await file();

    expect(version.pageSetupJson).toMatchObject({
      paper: "A4",
      marginLeft: 90,
      marginRight: 36,
    });
  });

  it("draws a different document for a different page", async () => {
    const onDefault = await file();
    await setPage({ marginLeft: 90, marginRight: 90 });
    const onWide = await file();

    expect(onWide.bytes.equals(onDefault.bytes)).toBe(false);
  });

  it("leaves a memo already filed exactly as it was filed", async () => {
    /*
     * The claim that matters.
     *
     * File one, change the setting, and read the stored bytes back. They are
     * the artefact the checksum was taken from and the approvers signed on;
     * nothing about a later settings change may reach them.
     */
    const filed = await file();
    const checksumBefore = filed.version.originalChecksum;

    await setPage({ paper: "LETTER", marginLeft: 90 });

    const reread = await storageService.downloadDocument(
      filed.version.originalStoragePath!
    );
    const row = await prisma.documentVersion.findUniqueOrThrow({
      where: { id: filed.version.id },
    });

    expect(reread.equals(filed.bytes)).toBe(true);
    expect(row.originalChecksum).toBe(checksumBefore);
    expect(row.pageSetupJson).toBeNull();

    const page = await firstPageOf(reread);
    expect(page.getWidth()).toBeCloseTo(PAPER.A4.width, 1);
  });

  it("shows the preparer the page the submission will file on", async () => {
    /*
     * The preparer places their signature against the preview, so a preview
     * drawn on a different page from the filed copy puts every ruled line
     * somewhere else. Both must read the same setting the same way.
     */
    await setPage({ paper: "LETTER", marginLeft: 72, marginRight: 72 });

    const preview = await memoPreviewService.renderPreview(cast.preparer.id, {
      title: "Approval for Revision of Fuel Allowance",
      memoType: "APPROVAL_REQUEST",
      memoTo: "Sir BMD",
      memoFrom: "Human Resource Department",
      body: BODY,
      chain: chainOf(cast.approver, cast.finalApprover).map((step) => ({
        userId: step.userId,
      })),
    });

    const filed = await file();

    expect(
      Buffer.from(preview.pdfBase64, "base64").equals(filed.bytes)
    ).toBe(true);
  });
});
