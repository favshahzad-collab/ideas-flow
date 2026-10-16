/**
 * Memos being written.
 *
 * A draft is not a document and not an artefact: nothing is written to
 * STORAGE_DIR, no digest is taken, no audit row is written, and every field
 * can be changed as often as the preparer types. It becomes a document at
 * submission, and is deleted in the same transaction that creates one.
 *
 * It is also private. A draft is somebody's unfinished argument for a pay
 * revision or a dismissal; it is visible to its author and to nobody else,
 * administrators included. Every method here therefore scopes by preparer in
 * the WHERE clause rather than reading a row and then checking it - the two
 * differ the day somebody forgets the second half.
 */
import { Prisma } from "../generated/prisma/client";
import { errors } from "../lib/errors";
import { findMemoType } from "../lib/memoTypes";
import { prisma } from "../prisma";
import {
  memoDateToString,
  memoDateToUtc,
} from "../schemas/memoBody.schema";
import type {
  CreateMemoDraftInput,
  UpdateMemoDraftInput,
} from "../schemas/memoDrafts.schema";

/**
 * One person cannot have an unbounded number of drafts. Without a cap an
 * autosave bug on the client is an unbounded write loop against this table.
 */
const MAX_DRAFTS_PER_PERSON = 25;

const DRAFT_SHAPE = {
  id: true,
  memoType: true,
  title: true,
  memoTo: true,
  memoFrom: true,
  memoDate: true,
  bodyJson: true,
  chainJson: true,
  templateId: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.MemoDraftSelect;

function present(draft: Prisma.MemoDraftGetPayload<{ select: typeof DRAFT_SHAPE }>) {
  return {
    id: draft.id,
    memoType: draft.memoType,
    memoTypeLabel: draft.memoType ? (findMemoType(draft.memoType)?.label ?? null) : null,
    title: draft.title,
    memoTo: draft.memoTo,
    memoFrom: draft.memoFrom,
    // As the client wrote it. A Date on the wire would be read back through
    // a timezone and could come out a day earlier.
    memoDate: draft.memoDate ? memoDateToString(draft.memoDate) : null,
    body: draft.bodyJson,
    chain: draft.chainJson,
    templateId: draft.templateId,
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt,
  };
}

/**
 * Only the keys the caller actually sent.
 *
 * An autosave sends what changed. Mapping absent to null would let a
 * client that posts only the body silently erase the subject and the chain
 * the preparer had already chosen.
 */
type DraftWritableFields = {
  memoType?: string;
  title?: string;
  memoTo?: string;
  memoFrom?: string;
  memoDate?: Date;
  templateId?: string | null;
  bodyJson?: Prisma.InputJsonValue;
  chainJson?: Prisma.InputJsonValue;
};

function writableFields(input: UpdateMemoDraftInput): DraftWritableFields {
  const data: DraftWritableFields = {};

  if (input.memoType !== undefined) data.memoType = input.memoType;
  if (input.title !== undefined) data.title = input.title;
  if (input.memoTo !== undefined) data.memoTo = input.memoTo;
  if (input.memoFrom !== undefined) data.memoFrom = input.memoFrom;
  if (input.memoDate !== undefined) data.memoDate = memoDateToUtc(input.memoDate);
  if (input.templateId !== undefined) data.templateId = input.templateId;

  if (input.body !== undefined) {
    data.bodyJson = input.body;
  }
  if (input.chain !== undefined) {
    data.chainJson = input.chain;
  }

  return data;
}

export const memoDraftsService = {
  async listDrafts(userId: string) {
    const drafts = await prisma.memoDraft.findMany({
      where: { preparerId: userId },
      orderBy: { updatedAt: "desc" },
      select: DRAFT_SHAPE,
    });

    return drafts.map(present);
  },

  async getDraft(draftId: string, userId: string) {
    const draft = await prisma.memoDraft.findFirst({
      // Scoped, not checked afterwards: a draft belonging to somebody else
      // is indistinguishable from one that does not exist, which is also the
      // honest answer to give.
      where: { id: draftId, preparerId: userId },
      select: DRAFT_SHAPE,
    });

    if (!draft) throw errors.notFound("That draft could not be found.");

    return present(draft);
  },

  async createDraft(userId: string, input: CreateMemoDraftInput) {
    const existing = await prisma.memoDraft.count({
      where: { preparerId: userId },
    });

    if (existing >= MAX_DRAFTS_PER_PERSON) {
      throw errors.badRequest(
        `You already have ${MAX_DRAFTS_PER_PERSON} drafts. Submit or delete one before starting another.`
      );
    }

    const draft = await prisma.memoDraft.create({
      data: {
        preparerId: userId,
        ...writableFields(input),
      },
      select: DRAFT_SHAPE,
    });

    return present(draft);
  },

  async updateDraft(
    draftId: string,
    userId: string,
    input: UpdateMemoDraftInput
  ) {
    // `updateMany` with the owner in the WHERE clause, so somebody else's
    // draft matches nothing and is reported as missing rather than edited.
    const touched = await prisma.memoDraft.updateMany({
      where: { id: draftId, preparerId: userId },
      data: writableFields(input),
    });

    if (touched.count === 0) {
      throw errors.notFound("That draft could not be found.");
    }

    return this.getDraft(draftId, userId);
  },

  async deleteDraft(draftId: string, userId: string) {
    const removed = await prisma.memoDraft.deleteMany({
      where: { id: draftId, preparerId: userId },
    });

    if (removed.count === 0) {
      throw errors.notFound("That draft could not be found.");
    }
  },
};
