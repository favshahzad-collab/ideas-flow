-- A digest for every file this system calls the record.
--
-- The files were already immutable: nothing overwrites a signed artefact and
-- nothing rewrites the upload. Immutable is a promise about what the code
-- does; a digest is a fact about the bytes, and it is what lets anybody -
-- including a court, a year later - tell the two apart.
ALTER TABLE "approval_actions" ADD COLUMN "signed_pdf_checksum" VARCHAR(64);

ALTER TABLE "document_versions" ADD COLUMN "original_checksum" VARCHAR(64),
ADD COLUMN "storage_checksum" VARCHAR(64);

ALTER TABLE "documents" ADD COLUMN "final_signed_checksum" VARCHAR(64);

-- Give every memo submitted before references existed the reference it would
-- have been given.
--
-- A memo without one is quoted in a reply by title, which two memos can share,
-- and cannot be typed back into search. Numbering continues after whatever the
-- year already holds rather than restarting, so nothing collides with a
-- reference already minted, and the next submission - which takes MAX + 1 -
-- lands after these.
--
-- Ordered by when each memo was submitted, so the numbers run in the order the
-- memos actually went out. The year comes from the submission date read in the
-- database's timezone, which is how the service reads it too.
WITH taken AS (
  SELECT
    substring(reference_number FROM 6 FOR 4) AS yr,
    MAX(substring(reference_number FROM '[0-9]+$')::int) AS max_seq
  FROM documents
  WHERE reference_number ~ '^MEMO-[0-9]{4}-[0-9]+$'
  GROUP BY 1
),
missing AS (
  SELECT
    id,
    to_char(COALESCE(submitted_at, created_at), 'YYYY') AS yr,
    row_number() OVER (
      PARTITION BY to_char(COALESCE(submitted_at, created_at), 'YYYY')
      ORDER BY COALESCE(submitted_at, created_at) ASC, id ASC
    ) AS n
  FROM documents
  -- Drafts are left alone on purpose: the reference is minted at submission,
  -- so a draft that never goes out never holds a number out of the sequence.
  WHERE reference_number IS NULL
    AND status <> 'DRAFT'
)
UPDATE documents d
SET reference_number =
  'MEMO-' || m.yr || '-' || lpad((COALESCE(t.max_seq, 0) + m.n)::text, 4, '0')
FROM missing m
LEFT JOIN taken t ON t.yr = m.yr
WHERE d.id = m.id;
