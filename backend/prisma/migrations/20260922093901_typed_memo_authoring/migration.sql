-- AlterTable
ALTER TABLE "document_versions" ADD COLUMN     "body_json" JSONB;

-- AlterTable
ALTER TABLE "documents" ADD COLUMN     "memo_from" VARCHAR(200),
ADD COLUMN     "memo_to" VARCHAR(200),
ADD COLUMN     "memo_type" VARCHAR(64);

-- CreateTable
CREATE TABLE "memo_drafts" (
    "id" UUID NOT NULL,
    "preparer_id" UUID NOT NULL,
    "memo_type" VARCHAR(64),
    "title" VARCHAR(500),
    "memo_to" VARCHAR(200),
    "memo_from" VARCHAR(200),
    "body_json" JSONB,
    "chain_json" JSONB,
    "template_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "memo_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "branding_settings" (
    "id" VARCHAR(16) NOT NULL,
    "organisation_name" VARCHAR(200) NOT NULL,
    "logo_storage_path" VARCHAR(1024),
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by_id" UUID,

    CONSTRAINT "branding_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "memo_drafts_preparer_id_updated_at_idx" ON "memo_drafts"("preparer_id", "updated_at");

-- AddForeignKey
ALTER TABLE "memo_drafts" ADD CONSTRAINT "memo_drafts_preparer_id_fkey" FOREIGN KEY ("preparer_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branding_settings" ADD CONSTRAINT "branding_settings_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
