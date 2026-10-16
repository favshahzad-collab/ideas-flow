-- CreateTable
CREATE TABLE "document_comments" (
    "id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "author_id" UUID NOT NULL,
    "comment" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_comments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "document_comments_document_id_idx" ON "document_comments"("document_id");

-- CreateIndex
CREATE INDEX "document_comments_author_id_idx" ON "document_comments"("author_id");

-- CreateIndex
CREATE INDEX "document_comments_document_id_created_at_idx" ON "document_comments"("document_id", "created_at");

-- AddForeignKey
ALTER TABLE "document_comments" ADD CONSTRAINT "document_comments_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_comments" ADD CONSTRAINT "document_comments_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
