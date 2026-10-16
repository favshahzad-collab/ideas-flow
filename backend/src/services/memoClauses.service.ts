/**
 * Standard wording, kept by an administrator and inserted by preparers.
 *
 * A clause is a memo body under a title. It is inserted into a memo as a
 * copy - the memo then owns the words - so nothing here is referenced by a
 * document and nothing a document says depends on what is in this table.
 * That is what lets a clause be edited or archived freely: a memo that
 * carried the old wording still says exactly what it was signed saying.
 */
import type { Prisma } from "../generated/prisma/client";
import { errors } from "../lib/errors";
import { prisma } from "../prisma";
import type {
  CreateMemoClauseInput,
  UpdateMemoClauseInput,
} from "../schemas/memoClause.schema";

const SELECT = {
  id: true,
  title: true,
  bodyJson: true,
  archivedAt: true,
  createdAt: true,
  updatedAt: true,
  updatedBy: { select: { firstName: true, lastName: true } },
} as const;

type Row = Prisma.MemoClauseGetPayload<{ select: typeof SELECT }>;

/** The shape both screens read: the body under its own name, not the column's. */
export type MemoClauseView = {
  id: string;
  title: string;
  body: Prisma.JsonValue;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  updatedBy: { firstName: string; lastName: string } | null;
};

const view = (row: Row): MemoClauseView => ({
  id: row.id,
  title: row.title,
  body: row.bodyJson,
  archivedAt: row.archivedAt,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  updatedBy: row.updatedBy,
});

export const memoClausesService = {
  /**
   * The wording on offer. Preparers see what is current; an administrator
   * asks for the archived ones too, so that "put it back" is possible.
   * Current first, then by title, so the list reads the same way twice.
   */
  async list(options: { includeArchived?: boolean } = {}): Promise<MemoClauseView[]> {
    const rows = await prisma.memoClause.findMany({
      where: options.includeArchived ? {} : { archivedAt: null },
      orderBy: [{ archivedAt: { sort: "asc", nulls: "first" } }, { title: "asc" }],
      select: SELECT,
    });
    return rows.map(view);
  },

  async create(input: CreateMemoClauseInput, userId: string): Promise<MemoClauseView> {
    const row = await prisma.memoClause.create({
      data: {
        title: input.title,
        bodyJson: input.body,
        createdById: userId,
        updatedById: userId,
      },
      select: SELECT,
    });
    return view(row);
  },

  /**
   * Change the title or the words, or take the clause off the list and put
   * it back. Answers with both states, because the audit row that follows
   * says what changed, and which of three things happened is decided from
   * the pair.
   */
  async update(
    id: string,
    input: UpdateMemoClauseInput,
    userId: string
  ): Promise<{ before: MemoClauseView; after: MemoClauseView }> {
    const existing = await prisma.memoClause.findUnique({ where: { id }, select: SELECT });
    if (!existing) {
      throw errors.notFound("That wording no longer exists.");
    }

    const row = await prisma.memoClause.update({
      where: { id },
      data: {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.body !== undefined
          ? { bodyJson: input.body }
          : {}),
        ...(input.archived === undefined
          ? {}
          : // Archiving twice keeps the first date; that is when it went.
            { archivedAt: input.archived ? (existing.archivedAt ?? new Date()) : null }),
        updatedById: userId,
      },
      select: SELECT,
    });

    return { before: view(existing), after: view(row) };
  },
};
