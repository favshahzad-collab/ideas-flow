-- The date a memo bears, as its author typed it.
--
-- Not the same thing as `submitted_at`: a memo written on the 6th, agreed
-- verbally, and put through the system on the 11th is dated the 6th, and the
-- printed header has to say so. DATE rather than TIMESTAMP because nobody
-- dates a memo to the minute.
--
-- Null everywhere it is added, which is correct: every memo that already
-- exists was drawn with its submission date and must keep printing that.
ALTER TABLE "documents" ADD COLUMN "memo_date" DATE;
ALTER TABLE "memo_drafts" ADD COLUMN "memo_date" DATE;
