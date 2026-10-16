/**
 * What a word in the organisation's dictionary may be.
 *
 * One word: letters in any script, with the apostrophes, hyphens and dots
 * a name or an abbreviation carries. Not a phrase - the checker looks at
 * words one at a time, so a phrase here would never match anything.
 */
import { z } from "zod";

export const DICTIONARY_WORD_MAX = 80;

const word = z
  .string()
  .trim()
  .min(1, "Type the word to add.")
  .max(DICTIONARY_WORD_MAX, `A word cannot exceed ${DICTIONARY_WORD_MAX} characters.`)
  .regex(
    /^[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N}'’.-]*$/u,
    "One word at a time: letters, with an apostrophe, a hyphen or a dot inside it. No spaces."
  );

export const addDictionaryWordSchema = z.object({
  body: z.object({ word }).strict(),
});

export const dictionaryWordIdSchema = z.object({
  params: z.object({
    id: z.uuid("That word is not in the dictionary."),
  }),
});

export type AddDictionaryWordInput = z.infer<typeof addDictionaryWordSchema>["body"];
