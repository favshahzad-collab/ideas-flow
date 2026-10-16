/**
 * Submit a typed memo, take it through its whole chain, and write out what
 * each approver's signature landed on.
 *
 *   TEST_DATABASE_URL=... npx tsx scripts/typed-memo-walkthrough.ts <outdir>
 *
 * Tests assert that the artefacts exist and that their digests match. They
 * cannot tell you that the first signature was stamped straight through the
 * printed signature strip - the page would still be a valid PDF with a
 * correct digest. Only looking can, and the template's footer and the
 * stamping path are the two things in this feature that share a piece of the
 * page.
 *
 * Runs against the TEST database. It creates people and memos, so it must
 * never be pointed at a real one - and `assertTestDatabase` below is what
 * makes that true, because this comment on its own did not.
 */
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";

import { FUEL_REQUEST_BODY } from "../src/lib/memoTemplate/fuelRequest.fixture";
import { prisma } from "../src/prisma";
import { approvalService } from "../src/services/approval.service";
import { memoPreviewService } from "../src/services/memoPreview.service";
import { documentsService } from "../src/services/documents.service";
import { storageService } from "../src/lib/storage";
import { assertTestDatabase } from "./assertTestDatabase";

const OUT = process.argv[2] ?? ".";

/**
 * A real PNG, built here rather than pasted as a hex literal.
 *
 * The first version of this script carried a hand-written blob that looked
 * like a PNG and was not one, and `embedPng` did not reject it - it never
 * returned at all, blocking the event loop with no error and no timeout. A
 * generated image is correct by construction.
 */
function solidPng(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body) >>> 0);
    return Buffer.concat([length, body, crc]);
  };

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolour

  const rows = Buffer.concat(
    Array.from({ length: height }, () =>
      // Leading 0 is the per-row filter byte a PNG scanline starts with.
      Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x22)])
    )
  );

  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// 3:1, the shape of the default signature box and about the shape of a name.
const SIGNATURE_PNG =
  "data:image/png;base64," + solidPng(360, 120).toString("base64");

/** A signature placed on somebody's own printed line. */
const placementOn = (slot: {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}) => ({
  useSavedSignature: false,
  signatureImage: SIGNATURE_PNG,
  signaturePage: slot.page,
  signatureX: slot.x,
  signatureY: slot.y,
  signatureWidth: slot.width,
  signatureHeight: slot.height,
});

/**
 * The preparer's own slot, which they cannot be given before the memo is
 * drawn - so the walkthrough asks the preview for it, exactly as the form
 * does.
 */
async function preparerSlotFor(
  preparerId: string,
  chain: { userId: string }[]
): Promise<{ page: number; x: number; y: number; width: number; height: number }> {
  const preview = await memoPreviewService.renderPreview(preparerId, {
    title:
      "Approval for Revision of Fuel & Motorcycle Maintenance Allowance \u2013 Mr. Inayat Hussain (AX-1644)",
    memoTo: "Sir BMD",
    memoFrom: "Human Resource Department",
    body: FUEL_REQUEST_BODY,
    chain,
  });

  const mine = preview.slots.find((slot) => slot.key === preparerId);
  if (!mine) throw new Error("the preview drew no line for the preparer");
  return mine;
}

async function person(firstName: string, designation: string, departmentId: string) {
  return prisma.user.create({
    data: {
      firstName,
      lastName: "Walkthrough",
      email: `${firstName.toLowerCase()}-${Date.now()}@example.com`,
      departmentId,
      designation,
    },
  });
}

async function save(label: string, storagePath: string): Promise<void> {
  const bytes = await storageService.downloadDocument(storagePath);
  const file = path.join(OUT, `${label}.pdf`);
  fs.writeFileSync(file, bytes);
  console.log(`  ${label.padEnd(22)} ${bytes.length.toLocaleString().padStart(8)} bytes  ${file}`);
}

async function main(): Promise<void> {
  assertTestDatabase("scripts/typed-memo-walkthrough.ts");

  const department = await prisma.department.create({
    data: { name: `Walkthrough ${Date.now()}` },
  });

  const preparer = await person("Preparer", "HR Officer", department.id);
  const first = await person("Rizwan", "Director - Human Resources", department.id);
  const second = await person("Maryam", "Director - Audit", department.id);

  const chain = [
    { userId: first.id, approvalType: "APPROVER" as const },
    { userId: second.id, approvalType: "FINAL_APPROVER" as const },
  ];

  console.log("previewing, to find the preparer's line...");
  const preparerSlot = await preparerSlotFor(preparer.id, chain);
  console.log(
    `  line at x=${preparerSlot.x.toFixed(1)} y=${preparerSlot.y.toFixed(1)}\n`
  );

  console.log("submitting a typed memo...");

  const { document } = await documentsService.createDocument(
    {
      title:
        "Approval for Revision of Fuel & Motorcycle Maintenance Allowance – Mr. Inayat Hussain (AX-1644)",
      memoType: "FUEL_REQUEST",
      memoTo: "Sir BMD",
      memoFrom: "Human Resource Department",
      body: FUEL_REQUEST_BODY,
      approvalChain: chain,
      signature: placementOn(preparerSlot),
    },
    null,
    preparer.id
  );

  console.log(`  ${document.referenceNumber}\n`);

  const version = await prisma.documentVersion.findFirstOrThrow({
    where: { documentId: document.id },
  });

  console.log("artefacts:");
  await save("1-as-generated", version.originalStoragePath!);
  await save("2-preparer-signed", version.storagePath);

  /*
   * Each approver signs on their own printed line, which is what the form
   * offers them - the slots the renderer recorded against this version.
   */
  const slots = (version.signatureSlots ?? []) as unknown as {
    key: string;
    page: number;
    x: number;
    y: number;
    width: number;
    height: number;
  }[];

  console.log("\nlines on the page:");
  for (const slot of slots) {
    console.log(
      `  ${slot.key.slice(0, 8)}  x=${slot.x.toFixed(1).padStart(6)}  y=${slot.y.toFixed(1)}  w=${slot.width.toFixed(1)}`
    );
  }
  console.log("");

  const lineFor = (userId: string) => {
    const slot = slots.find((entry) => entry.key === userId);
    if (!slot) throw new Error(`no printed line for ${userId}`);
    return placementOn(slot);
  };

  await approvalService.approve(document.id, first.id, lineFor(first.id));
  await approvalService.approve(
    document.id,
    second.id,
    lineFor(second.id)
  );

  const finished = await prisma.document.findUniqueOrThrow({
    where: { id: document.id },
  });

  const actions = await prisma.approvalAction.findMany({
    where: { workflowRun: { documentId: document.id } },
    orderBy: { createdAt: "asc" },
    select: { signedPdfStoragePath: true },
  });

  for (const [index, action] of actions.entries()) {
    if (action.signedPdfStoragePath) {
      await save(`3-step-${index + 1}-signed`, action.signedPdfStoragePath);
    }
  }

  await save("4-final", finished.finalSignedStoragePath!);

  console.log(`\nstatus: ${finished.status}`);
  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error(error instanceof Error ? error.message : error);
  await prisma.$disconnect();
  process.exit(1);
});
