-- CreateTable
CREATE TABLE "supporting_documents" (
    "id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "file_name" VARCHAR(500) NOT NULL,
    "content_type" VARCHAR(255) NOT NULL,
    "storage_path" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "uploaded_by_id" UUID NOT NULL,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "uploaded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supporting_documents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "supporting_documents_document_id_is_deleted_idx" ON "supporting_documents"("document_id", "is_deleted");

-- CreateIndex
CREATE INDEX "supporting_documents_uploaded_by_id_idx" ON "supporting_documents"("uploaded_by_id");

-- AddForeignKey
ALTER TABLE "supporting_documents" ADD CONSTRAINT "supporting_documents_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supporting_documents" ADD CONSTRAINT "supporting_documents_uploaded_by_id_fkey" FOREIGN KEY ("uploaded_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
