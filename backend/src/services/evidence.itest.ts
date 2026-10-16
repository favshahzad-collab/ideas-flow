import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { sha256 } from "../lib/checksum";
import { prisma } from "../prisma";
import {
  chainOf,
  makeCast,
  signature,
  SIGNATURE_IMAGE,
  submitDocument,
  useCleanDatabase,
} from "../test/db";
import { approvalService } from "./approval.service";
import { ledgerService } from "./ledger.service";
import { usersService } from "./users.service";

/**
 * The evidence a signature and an approved memo carry, for whoever checks
 * them later - an auditor, a court, or the organisation itself in two years.
 *
 * Three gaps from the fit-gap review: a saved signature could be replaced
 * with nothing recorded, an approved memo did not say whether it was sealed,
 * and nobody outside the application could check the ledger.
 */

useCleanDatabase();

let cast: Awaited<ReturnType<typeof makeCast>>;

beforeEach(async () => {
  cast = await makeCast();
});

const png = Buffer.from(SIGNATURE_IMAGE.split(",")[1], "base64");
const imageFile = (buffer = png) =>
  ({
    fieldname: "file",
    originalname: "signature.png",
    encoding: "7bit",
    mimetype: "image/png",
    size: buffer.length,
    buffer,
  }) as Express.Multer.File;

const auditOf = (action: string) =>
  prisma.auditLog.findMany({ where: { action: action as never }, orderBy: { createdAt: "asc" } });

describe("a saved signature", () => {
  it("is recorded when it is saved and when it is replaced, with the image's fingerprint", async () => {
    await usersService.uploadSignature(cast.reviewer.id, imageFile());
    const second = Buffer.concat([png, Buffer.alloc(0)]);
    await usersService.uploadSignature(cast.reviewer.id, imageFile(second));

    const rows = await auditOf("SIGNATURE_SAVED");
    expect(rows).toHaveLength(2);
    expect(rows[0].newValue).toMatchObject({ signatureChecksum: sha256(png), replaced: false });
    expect(rows[1].newValue).toMatchObject({ replaced: true });
    expect(rows[1].oldValue).toMatchObject({ signatureChecksum: sha256(png) });
  });

  it("is recorded when it is removed", async () => {
    await usersService.uploadSignature(cast.reviewer.id, imageFile());
    await usersService.deleteSignature(cast.reviewer.id);

    const [removed] = await auditOf("SIGNATURE_REMOVED");
    expect(removed.oldValue).toMatchObject({ signatureChecksum: sha256(png) });
    const user = await prisma.user.findUniqueOrThrow({ where: { id: cast.reviewer.id } });
    expect(user.signatureChecksum).toBeNull();
  });

  it("names, on each signature made with it, exactly which image went on the page", async () => {
    await usersService.uploadSignature(cast.reviewer.id, imageFile());
    const document = await submitDocument({
      preparerId: cast.preparer.id,
      approvalChain: chainOf(cast.reviewer, cast.finalApprover),
    });

    await approvalService.approve(
      document.id,
      cast.reviewer.id,
      signature({ useSavedSignature: true, signatureImage: undefined })
    );

    const signed = (await auditOf("DOCUMENT_SIGNED")).find(
      (row) => row.actorId === cast.reviewer.id
    );
    expect(signed!.newValue).toMatchObject({ signatureImageChecksum: sha256(png) });
  });
});

describe("an approved memo", () => {
  it("records, on the memo and on its final signature, that it was not sealed", async () => {
    // No certificate configured in this suite.
    const document = await submitDocument({
      preparerId: cast.preparer.id,
      approvalChain: chainOf(cast.finalApprover),
    });
    await approvalService.approve(document.id, cast.finalApprover.id, signature());

    const approved = await prisma.document.findUniqueOrThrow({ where: { id: document.id } });
    expect(approved.status).toBe("APPROVED");
    expect(approved.sealedBy).toBeNull();

    const final = (await auditOf("DOCUMENT_SIGNED")).find(
      (row) => row.actorId === cast.finalApprover.id
    );
    expect(final!.newValue).toMatchObject({ sealedBy: null });
  });
});

describe("the ledger export, checked outside the application", () => {
  const verifier = path.resolve(__dirname, "../../scripts/verify-ledger-export.mjs");
  const folder = mkdtempSync(path.join(tmpdir(), "daws-ledger-"));

  const exportTo = async (name: string) => {
    await ledgerService.seal();
    const lines: string[] = [];
    await ledgerService.exportChain((line) => lines.push(line));
    const file = path.join(folder, name);
    writeFileSync(file, `${lines.join("\n")}\n`);
    return file;
  };

  /** Exit status and output of the verifier, run as an auditor would run it. */
  const verify = (file: string) => {
    try {
      const out = execFileSync(process.execPath, [verifier, file], { encoding: "utf8" });
      return { status: 0, out };
    } catch (error) {
      const failed = error as { status: number; stderr: string };
      return { status: failed.status, out: failed.stderr };
    }
  };

  const someHistory = async () => {
    const document = await submitDocument({
      preparerId: cast.preparer.id,
      approvalChain: chainOf(cast.reviewer, cast.finalApprover),
    });
    await approvalService.approve(document.id, cast.reviewer.id, signature());
    await approvalService.reject(document.id, cast.finalApprover.id, { comment: "Over budget." });
  };

  it("verifies an untouched export, every record and every checkpoint", async () => {
    await someHistory();
    const file = await exportTo("clean.jsonl");

    const result = verify(file);
    expect(result.status).toBe(0);
    expect(result.out).toMatch(/^VERIFIED: \d+ records/);
  });

  it("catches a record changed after it was sealed", async () => {
    await someHistory();
    const file = await exportTo("edited.jsonl");
    const lines = readFileSync(file, "utf8").trim().split("\n");
    const target = JSON.parse(lines[2]) as { record: { newValue: unknown } };
    target.record.newValue = { comment: "Approved after all." };
    lines[2] = JSON.stringify(target);
    writeFileSync(file, `${lines.join("\n")}\n`);

    const result = verify(file);
    expect(result.status).toBe(1);
    expect(result.out).toMatch(/has been changed since it was sealed/);
  });

  it("catches a chain cut short, from the checkpoints", async () => {
    await someHistory();
    const file = await exportTo("cut.jsonl");
    const lines = readFileSync(file, "utf8").trim().split("\n");
    writeFileSync(file, `${lines.slice(0, -1).join("\n")}\n`);

    const result = verify(file);
    expect(result.status).toBe(1);
    expect(result.out).toMatch(/cut short/);
  });
});
