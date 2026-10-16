import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { PDFDocument } from "pdf-lib";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import app from "../app";
import { ApprovalType } from "../generated/prisma/client";
import { sha256 } from "../lib/checksum";
import { verifySeal } from "../lib/pdfSealVerify";
import { createSelfSignedSeal } from "../lib/sealCertificate";
import { hashPassword } from "../lib/password";
import { SIGNING_CONSENT_STATEMENT } from "../lib/signingAttestation";
import { storageService } from "../lib/storage";
import { linesOf } from "../test/pdfText";
import { prisma } from "../prisma";
import { makeDepartment, makePdf, SIGNATURE_IMAGE, useCleanDatabase } from "../test/db";
import { usersService } from "../services/users.service";
import { useStoredWorkflowPolicy } from "../lib/workflowPolicy";

/**
 * Before a signature goes on a memo, the signer proves it is them and agrees
 * in words.
 *
 * A signed-in browser is not the person: a tab left open on a shared desk was
 * enough to put somebody's signature on a memo. Every route that applies a
 * signature now needs a "confirm it's you" made in the last five minutes - a
 * password or an authenticator code - and the tick box saying "this is my
 * signature". Each signature then writes a DOCUMENT_SIGNED entry to the
 * ledger carrying both, and how the mark was made.
 *
 * Over HTTP on purpose: both checks live in the routes, and a service-level
 * test would walk straight past them.
 */

useCleanDatabase();

let server: Server;
let base: string;

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

const PASSWORD = "correct horse battery staple";

type Person = { id: string; token: string };

async function makePerson(firstName: string, departmentId: string): Promise<Person> {
  const user = await prisma.user.create({
    data: {
      firstName,
      lastName: "Khan",
      email: `${firstName.toLowerCase()}@example.com`,
      passwordHash: await hashPassword(PASSWORD),
      departmentId,
    },
  });
  const response = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: user.email, password: PASSWORD }),
  });
  const { accessToken } = (await response.json()) as { accessToken: string };
  return { id: user.id, token: accessToken };
}

/** "Confirm it's you", through the real endpoint. */
async function confirm(person: Person, password = PASSWORD) {
  const response = await fetch(`${base}/api/auth/step-up`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${person.token}` },
    body: JSON.stringify({ password }),
  });
  return { status: response.status, ...((await response.json()) as { stepUpToken?: string }) };
}

const placement = (overrides: Record<string, unknown> = {}) => ({
  consent: true,
  useSavedSignature: false,
  signatureImage: SIGNATURE_IMAGE,
  signaturePage: 1,
  signatureX: 100,
  signatureY: 200,
  signatureWidth: 120,
  signatureHeight: 40,
  ...overrides,
});

async function approve(person: Person, documentId: string, stepUp: string | null, body = placement()) {
  const response = await fetch(`${base}/api/documents/${documentId}/approve`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${person.token}`,
      ...(stepUp ? { "x-step-up": stepUp } : {}),
    },
    body: JSON.stringify(body),
  });
  const json = (await response.json()) as { error?: { message?: string; code?: string } };
  return { status: response.status, code: json.error?.code, message: json.error?.message ?? "" };
}

async function submit(person: Person, stepUp: string | null, signature = placement()) {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(pdf)], { type: "application/pdf" }), "memo.pdf");
  form.append("title", "Annual leave policy");
  form.append(
    "approvalChain",
    JSON.stringify([
      { userId: reviewer.id, approvalType: ApprovalType.REVIEWER },
      { userId: finalApprover.id, approvalType: ApprovalType.FINAL_APPROVER },
    ])
  );
  form.append("signature", JSON.stringify(signature));
  const response = await fetch(`${base}/api/documents`, {
    method: "POST",
    headers: { authorization: `Bearer ${person.token}`, ...(stepUp ? { "x-step-up": stepUp } : {}) },
    body: form,
  });
  const json = (await response.json()) as {
    document?: { id: string };
    error?: { message?: string; code?: string };
  };
  return { status: response.status, id: json.document?.id, code: json.error?.code };
}

const signedEntries = (documentId: string) =>
  prisma.auditLog.findMany({
    where: { entityId: documentId, action: "DOCUMENT_SIGNED" },
    orderBy: { createdAt: "asc" },
  });

let hr: Person;
let reviewer: Person;
let finalApprover: Person;
let pdf: Buffer;
let documentId: string;

beforeEach(async () => {
  const department = await makeDepartment("Human Resources");
  [hr, reviewer, finalApprover] = await Promise.all([
    makePerson("Ayesha", department.id),
    makePerson("Bilal", department.id),
    makePerson("Danish", department.id),
  ]);
  pdf = await makePdf();
  const submitted = await submit(hr, (await confirm(hr)).stepUpToken!);
  documentId = submitted.id!;
});

describe("approving needs the signer to confirm it is them", () => {
  it("refuses a signature with no confirmation, and says it is for signing", async () => {
    const result = await approve(reviewer, documentId, null);

    expect(result.status).toBe(403);
    expect(result.code).toBe("STEP_UP_REQUIRED_TO_SIGN");
    expect(result.message).toMatch(/Confirm it is you to sign/);
    // Nothing moved: still with the reviewer, no signature on file.
    expect(await prisma.approvalAction.count()).toBe(0);
  });

  it("refuses a wrong password at the confirmation itself", async () => {
    expect((await confirm(reviewer, "not my password")).status).toBe(403);
  });

  it("refuses somebody else's confirmation", async () => {
    const theirs = (await confirm(finalApprover)).stepUpToken!;
    const result = await approve(reviewer, documentId, theirs);

    expect(result.status).toBe(403);
    expect(result.code).toBe("STEP_UP_REQUIRED_TO_SIGN");
  });

  it("refuses a confirmation made before 'sign out everywhere'", async () => {
    const stepUp = (await confirm(reviewer)).stepUpToken!;
    await prisma.user.update({
      where: { id: reviewer.id },
      data: { sessionsValidFrom: new Date(Date.now() + 1000) },
    });

    const response = await fetch(`${base}/api/documents/${documentId}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${reviewer.token}`, "x-step-up": stepUp },
      body: JSON.stringify(placement()),
    });
    // The session itself has ended, which is a 401 before the confirmation is read.
    expect([401, 403]).toContain(response.status);
    expect(await prisma.approvalAction.count()).toBe(0);
  });

  it("refuses a signature without the tick box, even when confirmed", async () => {
    const stepUp = (await confirm(reviewer)).stepUpToken!;
    const { consent: _consent, ...unticked } = placement();
    const result = await approve(reviewer, documentId, stepUp, unticked as never);

    expect(result.status).toBe(400);
    expect(result.message).toBe("Tick the box to confirm this is your signature.");
    expect(await prisma.approvalAction.count()).toBe(0);
  });

  it("signs once both are given", async () => {
    const stepUp = (await confirm(reviewer)).stepUpToken!;
    expect((await approve(reviewer, documentId, stepUp)).status).toBe(200);
  });

  it("lets one confirmation cover several signatures in a row", async () => {
    // Five minutes, the same as an administration change: somebody clearing
    // a queue types their password once.
    const stepUp = (await confirm(reviewer)).stepUpToken!;
    expect((await approve(reviewer, documentId, stepUp)).status).toBe(200);

    const second = await submit(hr, (await confirm(hr)).stepUpToken!);
    expect((await approve(reviewer, second.id!, stepUp)).status).toBe(200);
  });
});

describe("the preparer's signature at submission", () => {
  it("is refused without a confirmation", async () => {
    const result = await submit(hr, null);
    expect(result.status).toBe(403);
    expect(result.code).toBe("STEP_UP_REQUIRED_TO_SIGN");
  });

  it("is refused without the tick box", async () => {
    const { consent: _consent, ...unticked } = placement();
    const result = await submit(hr, (await confirm(hr)).stepUpToken!, unticked as never);
    expect(result.status).toBe(400);
  });
});

describe("what the ledger keeps about each signature", () => {
  it("records the preparer's signature at submission", async () => {
    const [entry] = await signedEntries(documentId);

    expect(entry?.actorId).toBe(hr.id);
    expect(entry?.newValue).toMatchObject({
      status: "SIGNED",
      capacity: "PREPARER",
      versionNumber: 1,
      method: "DRAWN",
      consentStatement: SIGNING_CONSENT_STATEMENT,
    });
    expect((entry?.newValue as { identityConfirmedAt?: string }).identityConfirmedAt).toEqual(
      expect.any(String)
    );
  });

  it("records who signed, when they confirmed, what they agreed to, and the file they produced", async () => {
    const before = Date.now();
    const stepUp = (await confirm(reviewer)).stepUpToken!;
    await approve(reviewer, documentId, stepUp);

    const entries = await signedEntries(documentId);
    const mine = entries.find((entry) => entry.actorId === reviewer.id)!;
    const action = await prisma.approvalAction.findFirstOrThrow({ where: { actorId: reviewer.id } });
    const recorded = mine.newValue as Record<string, unknown>;

    expect(recorded).toMatchObject({
      status: "SIGNED",
      capacity: "REVIEWER",
      stepOrder: 1,
      versionNumber: 1,
      method: "DRAWN",
      signaturePage: 1,
      onBehalfOfId: null,
      consentStatement: SIGNING_CONSENT_STATEMENT,
      // The same digest the approval row holds, so the ledger names the file.
      signedPdfChecksum: action.signedPdfChecksum,
    });
    // When they proved it was them: just now, not some earlier session.
    const confirmedAt = new Date(recorded.identityConfirmedAt as string).getTime();
    expect(confirmedAt).toBeGreaterThanOrEqual(before - 1000);
    expect(confirmedAt).toBeLessThanOrEqual(Date.now());
  });

  it("says when the saved signature was used rather than a drawn one", async () => {
    await usersService.uploadSignature(reviewer.id, {
      buffer: Buffer.from(SIGNATURE_IMAGE.replace(/^data:image\/png;base64,/, ""), "base64"),
      mimetype: "image/png",
      originalname: "signature.png",
      size: 100,
    } as Express.Multer.File);

    const stepUp = (await confirm(reviewer)).stepUpToken!;
    const result = await approve(
      reviewer,
      documentId,
      stepUp,
      placement({ useSavedSignature: true, signatureImage: undefined })
    );
    expect(result.status).toBe(200);

    const mine = (await signedEntries(documentId)).find((entry) => entry.actorId === reviewer.id)!;
    expect((mine.newValue as { method: string }).method).toBe("SAVED_SIGNATURE");
  });

  it("writes one entry per signature, the final one included", async () => {
    await approve(reviewer, documentId, (await confirm(reviewer)).stepUpToken!);
    await approve(finalApprover, documentId, (await confirm(finalApprover)).stepUpToken!);

    const entries = await signedEntries(documentId);
    expect(entries.map((entry) => (entry.newValue as { capacity: string }).capacity)).toEqual([
      "PREPARER",
      "REVIEWER",
      "FINAL_APPROVER",
    ]);
    const final = await prisma.document.findUniqueOrThrow({ where: { id: documentId } });
    expect(final.status).toBe("APPROVED");
    // The last entry names the approved file itself.
    const last = entries.at(-1)!.newValue as { signedPdfChecksum: string };
    expect(last.signedPdfChecksum).toBe(final.finalSignedChecksum);
    expect(last.signedPdfChecksum).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256(Buffer.from("x"))).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("the approved file's signature certificate", () => {
  const download = (storagePath: string) => storageService.downloadDocument(storagePath);
  const pages = async (pdf: Buffer) => (await PDFDocument.load(pdf)).getPageCount();

  it("ends the approved memo, naming every signer and how each proved it was them", async () => {
    await approve(reviewer, documentId, (await confirm(reviewer)).stepUpToken!);
    await approve(finalApprover, documentId, (await confirm(finalApprover)).stepUpToken!);

    const document = await prisma.document.findUniqueOrThrow({ where: { id: documentId } });
    const approved = await download(document.finalSignedStoragePath!);
    const lines = linesOf(approved).join("\n");

    // One page more than the memo as submitted: the certificate, last.
    expect(await pages(approved)).toBe((await pages(pdf)) + 1);
    expect(lines).toContain("Signature certificate");
    expect(lines).toContain("1. Ayesha Khan");
    expect(lines).toContain("2. Bilal Khan");
    expect(lines).toContain("3. Danish Khan");
    expect(lines).toContain("Final Approver");
    // All three confirmed with a password through the route, so it says so.
    // Each confirmed with a password here, and the page says exactly that.
    expect(lines.match(/Identity confirmed: Password, /g)).toHaveLength(3);
    expect(lines.match(/Agreed that this is their signature: Yes/g)).toHaveLength(3);
  });

  it("is part of the file the ledger fingerprints", async () => {
    await approve(reviewer, documentId, (await confirm(reviewer)).stepUpToken!);
    await approve(finalApprover, documentId, (await confirm(finalApprover)).stepUpToken!);

    const document = await prisma.document.findUniqueOrThrow({ where: { id: documentId } });
    const approved = await download(document.finalSignedStoragePath!);
    expect(sha256(approved)).toBe(document.finalSignedChecksum);
  });

  it("is not added to an approval part-way along the chain", async () => {
    await approve(reviewer, documentId, (await confirm(reviewer)).stepUpToken!);

    const action = await prisma.approvalAction.findFirstOrThrow({ where: { actorId: reviewer.id } });
    const reviewed = await download(action.signedPdfStoragePath!);
    expect(await pages(reviewed)).toBe(await pages(pdf));
  });
});

describe("the organisation's seal on the approved file", () => {
  const sealFolder = mkdtempSync(path.join(tmpdir(), "daws-seal-"));
  const passphrase = "a passphrase only this suite knows";

  beforeAll(() => {
    const seal = createSelfSignedSeal({
      commonName: "Ideas Flow document seal",
      organization: "IDEAS (Pvt.) Ltd.",
      passphrase,
      bits: 2048,
    });
    writeFileSync(path.join(sealFolder, "seal.p12"), seal.p12);
  }, 60_000);

  afterEach(() => {
    delete process.env.SEAL_P12_PATH;
    delete process.env.SEAL_P12_PASSWORD;
  });

  const approveAll = async () => {
    await approve(reviewer, documentId, (await confirm(reviewer)).stepUpToken!);
    await approve(finalApprover, documentId, (await confirm(finalApprover)).stepUpToken!);
    const document = await prisma.document.findUniqueOrThrow({ where: { id: documentId } });
    return { document, file: await storageService.downloadDocument(document.finalSignedStoragePath!) };
  };

  it("seals the approved memo, certificate page and all, so a reader can check it", async () => {
    process.env.SEAL_P12_PATH = path.join(sealFolder, "seal.p12");
    process.env.SEAL_P12_PASSWORD = passphrase;

    const { document, file } = await approveAll();

    expect(verifySeal(file)).toMatchObject({
      sealed: true,
      intact: true,
      signerName: "Ideas Flow document seal",
      coversWholeFile: true,
    });
    // The seal is over the certificate page too.
    expect(linesOf(file)).toContain("Signature certificate");
    // And the ledger fingerprints the sealed file, which is the one served.
    expect(sha256(file)).toBe(document.finalSignedChecksum);
  });

  it("does not seal an approval part-way along the chain", async () => {
    process.env.SEAL_P12_PATH = path.join(sealFolder, "seal.p12");
    process.env.SEAL_P12_PASSWORD = passphrase;

    await approve(reviewer, documentId, (await confirm(reviewer)).stepUpToken!);
    const action = await prisma.approvalAction.findFirstOrThrow({ where: { actorId: reviewer.id } });
    expect(verifySeal(await storageService.downloadDocument(action.signedPdfStoragePath!))).toEqual({ sealed: false });
  });

  it("still approves, unsealed, where no seal is configured", async () => {
    const { document, file } = await approveAll();
    expect(document.status).toBe("APPROVED");
    expect(verifySeal(file)).toEqual({ sealed: false });
  });

  describe("the administrator's switch", () => {
    afterEach(() => useStoredWorkflowPolicy(null));

    /*
     * The memo here was submitted before the test runs, and a memo keeps the
     * sealing rule its approval cycle started with (lib/runPolicy). So the
     * switch is set and the memo's cycle is given it, as though it had been
     * submitted with the switch in that position.
     */
    const switchSeal = async (sealApprovedMemos: boolean) => {
      useStoredWorkflowPolicy({
        slaDefaultDays: null,
        allowStepSkip: false,
        preparerSignsOnSubmit: true,
        sealApprovedMemos,
      });
      await prisma.workflowRun.updateMany({
        where: { documentId, status: "IN_PROGRESS" },
        data: { policyFrozenAt: new Date(), policySealApprovedMemos: sealApprovedMemos },
      });
    };

    it("approves, certified but unsealed, when switched off with a certificate in place", async () => {
      process.env.SEAL_P12_PATH = path.join(sealFolder, "seal.p12");
      process.env.SEAL_P12_PASSWORD = passphrase;
      await switchSeal(false);

      const { document, file } = await approveAll();

      expect(document.status).toBe("APPROVED");
      expect(verifySeal(file)).toEqual({ sealed: false });
      // Everything else about the approved file is unchanged.
      expect(linesOf(file)).toContain("Signature certificate");
      expect(sha256(file)).toBe(document.finalSignedChecksum);
    });

    it("seals again once switched back on", async () => {
      process.env.SEAL_P12_PATH = path.join(sealFolder, "seal.p12");
      process.env.SEAL_P12_PASSWORD = passphrase;
      await switchSeal(true);

      const { file } = await approveAll();

      expect(verifySeal(file)).toMatchObject({ sealed: true, intact: true });
    });
  });
});
