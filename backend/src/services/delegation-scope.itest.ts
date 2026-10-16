import { beforeEach, describe, expect, it } from "vitest";
import { LoginRole } from "../generated/prisma/client";
import { prisma } from "../prisma";
import {
  chainOf,
  makeCast,
  makeUser,
  signature,
  submitDocument,
  useCleanDatabase,
} from "../test/db";
import { approvalService } from "./approval.service";
import { delegationsService } from "./delegations.service";
import { documentsService } from "./documents.service";
import { memoTypeRoutesService } from "./memoTypeRoutes.service";

/**
 * Fit-gap decisions 6 and 7.
 *
 * A delegation covers every memo by default and can be limited to chosen
 * kinds; it runs for at most ninety days. Each kind of memo can name the
 * workflow the submit screen picks first.
 */

useCleanDatabase();

let cast: Awaited<ReturnType<typeof makeCast>>;

beforeEach(async () => {
  cast = await makeCast();
});

const DAY = 24 * 60 * 60 * 1000;
const self = (id: string) => ({ id, isAdministrator: false });

const approveAs = (documentId: string, actorId: string) => {
  const { useSavedSignature: _saved, ...placement } = signature();
  return approvalService.approve(documentId, actorId, {
    ...placement,
    useSavedSignature: false,
  });
};

/** An uploaded memo waiting on the reviewer. */
const uploaded = () =>
  submitDocument({
    preparerId: cast.preparer.id,
    approvalChain: chainOf(cast.reviewer, cast.finalApprover),
  });

describe("how long cover lasts", () => {
  it("runs ninety days when no end is given", async () => {
    const delegation = await delegationsService.create(
      { delegateId: cast.bystander.id },
      self(cast.reviewer.id)
    );

    const days = (delegation.endsAt!.getTime() - delegation.startsAt.getTime()) / DAY;
    expect(days).toBeGreaterThan(89);
    expect(days).toBeLessThanOrEqual(91);
  });

  it("refuses longer than ninety days", async () => {
    await expect(
      delegationsService.create(
        { delegateId: cast.bystander.id, endsAt: new Date(Date.now() + 120 * DAY) },
        self(cast.reviewer.id)
      )
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe("cover limited to some kinds of memo", () => {
  it("refuses a kind of memo that does not exist", async () => {
    await expect(
      delegationsService.create(
        { delegateId: cast.bystander.id, memoTypes: ["NO_SUCH_THING"] },
        self(cast.reviewer.id)
      )
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("lets the delegate sign the kinds it covers", async () => {
    await delegationsService.create(
      { delegateId: cast.bystander.id, memoTypes: ["UPLOADED"] },
      self(cast.reviewer.id)
    );
    const { id } = await uploaded();

    await expect(approveAs(id, cast.bystander.id)).resolves.toBeTruthy();
  });

  it("does not let them sign any other kind", async () => {
    await delegationsService.create(
      { delegateId: cast.bystander.id, memoTypes: ["APPROVAL_REQUEST"] },
      self(cast.reviewer.id)
    );
    const { id } = await uploaded();

    await expect(approveAs(id, cast.bystander.id)).rejects.toMatchObject({ statusCode: 403 });
  });

  it("does not put other kinds in their queue or tell them about them", async () => {
    await delegationsService.create(
      { delegateId: cast.bystander.id, memoTypes: ["APPROVAL_REQUEST"] },
      self(cast.reviewer.id)
    );
    const { id } = await uploaded();

    expect(await documentsService.getPendingApprovalCount(cast.bystander.id)).toEqual({ count: 0 });
    expect(
      await prisma.notification.count({ where: { documentId: id, recipientId: cast.bystander.id } })
    ).toBe(0);
  });

  it("covers everything when no kind is named, as before", async () => {
    await delegationsService.create({ delegateId: cast.bystander.id }, self(cast.reviewer.id));
    await uploaded();

    expect(await documentsService.getPendingApprovalCount(cast.bystander.id)).toEqual({ count: 1 });
  });
});

describe("the route each kind of memo starts from", () => {
  async function aTemplate(name = "Standard route") {
    return prisma.workflowTemplate.create({
      data: { name, graph: { nodes: [], edges: [] } },
    });
  }

  it("lists every kind of memo, uploaded PDFs included, with no route at first", async () => {
    const routes = await memoTypeRoutesService.list();

    expect(routes.map((route) => route.key)).toContain("UPLOADED");
    expect(routes.every((route) => route.templateId === null)).toBe(true);
  });

  it("is set, read back for the submit screen, and recorded", async () => {
    const admin = await makeUser({ loginRole: LoginRole.ADMINISTRATOR });
    const template = await aTemplate();

    await memoTypeRoutesService.set("UPLOADED", template.id, admin.id);

    expect(await memoTypeRoutesService.resolved()).toEqual({ UPLOADED: template.id });
    expect(await prisma.auditLog.count({ where: { action: "MEMO_TYPE_ROUTE_CHANGED" } })).toBe(1);
  });

  it("stops offering a route whose workflow was archived", async () => {
    const admin = await makeUser({ loginRole: LoginRole.ADMINISTRATOR });
    const template = await aTemplate();
    await memoTypeRoutesService.set("UPLOADED", template.id, admin.id);

    await prisma.workflowTemplate.update({
      where: { id: template.id },
      data: { isActive: false, archivedAt: new Date() },
    });

    expect(await memoTypeRoutesService.resolved()).toEqual({});
  });

  it("refuses an archived workflow and a kind of memo that does not exist", async () => {
    const admin = await makeUser({ loginRole: LoginRole.ADMINISTRATOR });
    const archived = await prisma.workflowTemplate.create({
      data: { name: "Old", graph: { nodes: [], edges: [] }, isActive: false, archivedAt: new Date() },
    });

    await expect(memoTypeRoutesService.set("UPLOADED", archived.id, admin.id)).rejects.toMatchObject({
      statusCode: 400,
    });
    await expect(memoTypeRoutesService.set("NOPE", null, admin.id)).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});
