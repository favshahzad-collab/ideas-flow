-- The organisation's dictionary: words the memo editor's spell check should
-- not flag.
--
-- The editor checks spelling against an English dictionary it carries, and an
-- English dictionary does not know the organisation - its products, its terms
-- of trade, the Urdu-derived words its memos use in English. Those are kept
-- here, one word a row, by an administrator. People's names and department
-- names are NOT kept here: the directory already holds them, and the words
-- offered to the editor are read from it at the same time.
--
-- `key` is the lowercase form the uniqueness is on, so "Somrow" and "somrow"
-- are one word; `word` is how it was written, which is what the list shows.
--
-- Additive: a new table, and two new audit actions.

CREATE TABLE "memo_dictionary_words" (
  "id"          UUID NOT NULL DEFAULT gen_random_uuid(),
  "word"        VARCHAR(80) NOT NULL,
  "key"         VARCHAR(80) NOT NULL,
  "added_by_id" UUID,
  "created_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "memo_dictionary_words_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "memo_dictionary_words_key_key" ON "memo_dictionary_words"("key");

ALTER TABLE "memo_dictionary_words"
  ADD CONSTRAINT "memo_dictionary_words_added_by_id_fkey"
  FOREIGN KEY ("added_by_id") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'MEMO_DICTIONARY_WORD_ADDED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'MEMO_DICTIONARY_WORD_REMOVED';
