/**
 * The organisation's dictionary, for the memo editor's spell check.
 *
 * Two lists come out of here. The one an administrator keeps - words the
 * English dictionary does not know and this organisation writes every day -
 * and the one the editor is given, which is that list plus every word in a
 * colleague's name or a department's name, read from the directory. A name
 * flagged as a misspelling is the most common false alarm a spell check
 * raises in an office, and the directory already knows every one of them.
 */
import type { Prisma } from "../generated/prisma/client";
import { errors } from "../lib/errors";
import { prisma } from "../prisma";

const SELECT = {
  id: true,
  word: true,
  createdAt: true,
  addedBy: { select: { firstName: true, lastName: true } },
} as const;

type Row = Prisma.MemoDictionaryWordGetPayload<{ select: typeof SELECT }>;

export type DictionaryWordView = {
  id: string;
  word: string;
  createdAt: Date;
  addedBy: { firstName: string; lastName: string } | null;
};

const view = (row: Row): DictionaryWordView => ({
  id: row.id,
  word: row.word,
  createdAt: row.createdAt,
  addedBy: row.addedBy,
});

/** How words are compared: one case, one form of apostrophe. */
export const dictionaryKey = (word: string): string =>
  word.trim().replace(/’/g, "'").toLowerCase();

/** The words in a name: "Security & Loss Prevention" gives three. */
const WORD = /[\p{L}\p{M}][\p{L}\p{M}'’]*/gu;

export function wordsInName(name: string): string[] {
  return (name.match(WORD) ?? []).filter((word) => word.length > 1);
}

export const memoDictionaryService = {
  /** The administrator's list, alphabetical. */
  async list(): Promise<DictionaryWordView[]> {
    const rows = await prisma.memoDictionaryWord.findMany({
      orderBy: { key: "asc" },
      select: SELECT,
    });
    return rows.map(view);
  },

  async add(word: string, userId: string): Promise<DictionaryWordView> {
    const key = dictionaryKey(word);
    const existing = await prisma.memoDictionaryWord.findUnique({ where: { key } });
    if (existing) {
      throw errors.conflict(`“${existing.word}” is already in the dictionary.`);
    }

    const row = await prisma.memoDictionaryWord.create({
      data: { word: word.trim(), key, addedById: userId },
      select: SELECT,
    });
    return view(row);
  },

  async remove(id: string): Promise<DictionaryWordView> {
    const existing = await prisma.memoDictionaryWord.findUnique({ where: { id }, select: SELECT });
    if (!existing) {
      throw errors.notFound("That word is not in the dictionary.");
    }
    await prisma.memoDictionaryWord.delete({ where: { id } });
    return view(existing);
  },

  /**
   * Everything the editor should not flag: the kept words, and every word
   * of every colleague's name and every department's name. Former colleagues
   * included - their names are still in memos.
   */
  async wordsForChecking(): Promise<string[]> {
    const [kept, people, departments] = await Promise.all([
      prisma.memoDictionaryWord.findMany({ select: { word: true } }),
      prisma.user.findMany({ select: { firstName: true, lastName: true } }),
      prisma.department.findMany({ select: { name: true } }),
    ]);

    const words = new Map<string, string>();
    const take = (word: string) => {
      const key = dictionaryKey(word);
      if (key && !words.has(key)) words.set(key, word.trim());
    };

    for (const row of kept) take(row.word);
    for (const person of people) {
      for (const word of wordsInName(`${person.firstName} ${person.lastName}`)) take(word);
    }
    for (const department of departments) {
      for (const word of wordsInName(department.name)) take(word);
    }

    return [...words.values()].sort((one, other) => one.localeCompare(other, "en"));
  },
};
