-- CreateEnum
CREATE TYPE "LoginRole" AS ENUM ('ADMINISTRATOR', 'USER');

-- CreateEnum
CREATE TYPE "ApprovalType" AS ENUM ('REVIEWER', 'APPROVER', 'FINAL_APPROVER');

-- CreateEnum
CREATE TYPE "DocumentStatus" AS ENUM ('DRAFT', 'PENDING_REVIEW', 'REVISION_REQUESTED', 'REJECTED', 'APPROVED');

-- CreateEnum
CREATE TYPE "WorkflowRunStatus" AS ENUM ('IN_PROGRESS', 'APPROVED', 'REJECTED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "ApprovalActionType" AS ENUM ('APPROVE', 'REQUEST_REVISION', 'REJECT');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('APPROVAL_NEEDED', 'REVISION_REQUESTED', 'REJECTED', 'APPROVED', 'RESUBMITTED');

-- CreateEnum
CREATE TYPE "AuditAction" AS ENUM ('USER_CREATED', 'USER_UPDATED', 'PASSWORD_RESET', 'DEPARTMENT_CREATED', 'DEPARTMENT_UPDATED', 'SIGNATURE_UPLOADED', 'SIGNATURE_DEACTIVATED', 'DOCUMENT_CREATED', 'DOCUMENT_UPDATED', 'DOCUMENT_SUBMITTED', 'DOCUMENT_VERSION_UPLOADED', 'APPROVAL_CHAIN_CREATED', 'WORKFLOW_APPROVED', 'WORKFLOW_REVISION_REQUESTED', 'WORKFLOW_REJECTED', 'WORKFLOW_COMPLETED', 'NOTIFICATION_CREATED', 'EMAIL_SENT');

-- CreateTable
CREATE TABLE "departments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" VARCHAR(255) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

    CONSTRAINT "departments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "first_name" VARCHAR(100) NOT NULL,
    "last_name" VARCHAR(100) NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "department_id" UUID NOT NULL,
    "login_role" "LoginRole" NOT NULL DEFAULT 'USER',
    "signature_storage_path" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "documents" (
    "id" UUID NOT NULL,
    "title" VARCHAR(500) NOT NULL,
    "description" TEXT,
    "status" "DocumentStatus" NOT NULL DEFAULT 'DRAFT',
    "preparer_id" UUID NOT NULL,
    "current_version_number" INTEGER NOT NULL DEFAULT 0,
    "current_workflow_run_id" UUID,
    "revision_requested_by_action_id" UUID,
    "submitted_at" TIMESTAMPTZ(6),
    "approved_at" TIMESTAMPTZ(6),
    "rejected_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_versions" (
    "id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "version_number" INTEGER NOT NULL,
    "storage_path" TEXT NOT NULL,
    "uploaded_by_id" UUID NOT NULL,
    "uploaded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,

    CONSTRAINT "document_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_chains" (
    "id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approval_chains_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_chain_steps" (
    "id" UUID NOT NULL,
    "chain_id" UUID NOT NULL,
    "step_order" INTEGER NOT NULL,
    "approval_type" "ApprovalType" NOT NULL,
    "assigned_user_id" UUID NOT NULL,

    CONSTRAINT "approval_chain_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_runs" (
    "id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "document_version_id" UUID NOT NULL,
    "chain_id" UUID NOT NULL,
    "status" "WorkflowRunStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "current_step_order" INTEGER NOT NULL DEFAULT 1,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMPTZ(6),

    CONSTRAINT "workflow_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_actions" (
    "id" UUID NOT NULL,
    "workflow_run_id" UUID NOT NULL,
    "chain_step_id" UUID NOT NULL,
    "document_version_id" UUID NOT NULL,
    "actor_id" UUID NOT NULL,
    "approval_type" "ApprovalType" NOT NULL,
    "action" "ApprovalActionType" NOT NULL,
    "comment" TEXT,
    "signature_page" INTEGER,
    "signature_x" DOUBLE PRECISION,
    "signature_y" DOUBLE PRECISION,
    "signature_width" DOUBLE PRECISION,
    "signature_height" DOUBLE PRECISION,
    "signed_pdf_storage_path" VARCHAR(1024),
    "ip_address" VARCHAR(45),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approval_actions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "recipient_id" UUID NOT NULL,
    "type" "NotificationType" NOT NULL,
    "title" VARCHAR(500) NOT NULL,
    "message" TEXT NOT NULL,
    "document_id" UUID,
    "workflow_run_id" UUID,
    "is_read" BOOLEAN NOT NULL DEFAULT false,
    "read_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "actor_id" UUID,
    "action" "AuditAction" NOT NULL,
    "entity_type" VARCHAR(100) NOT NULL,
    "entity_id" UUID NOT NULL,
    "old_value" JSONB,
    "new_value" JSONB,
    "ip_address" VARCHAR(45),
    "user_agent" VARCHAR(500),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "departments_name_key" ON "departments"("name");

-- CreateIndex
CREATE INDEX "departments_is_active_idx" ON "departments"("is_active");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_department_id_idx" ON "users"("department_id");

-- CreateIndex
CREATE INDEX "users_login_role_idx" ON "users"("login_role");

-- CreateIndex
CREATE INDEX "users_email_idx" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "documents_current_workflow_run_id_key" ON "documents"("current_workflow_run_id");

-- CreateIndex
CREATE UNIQUE INDEX "documents_revision_requested_by_action_id_key" ON "documents"("revision_requested_by_action_id");

-- CreateIndex
CREATE INDEX "documents_preparer_id_idx" ON "documents"("preparer_id");

-- CreateIndex
CREATE INDEX "documents_status_idx" ON "documents"("status");

-- CreateIndex
CREATE INDEX "documents_created_at_idx" ON "documents"("created_at");

-- CreateIndex
CREATE INDEX "document_versions_document_id_idx" ON "document_versions"("document_id");

-- CreateIndex
CREATE INDEX "document_versions_uploaded_by_id_idx" ON "document_versions"("uploaded_by_id");

-- CreateIndex
CREATE UNIQUE INDEX "document_versions_document_id_version_number_key" ON "document_versions"("document_id", "version_number");

-- CreateIndex
CREATE UNIQUE INDEX "approval_chains_document_id_key" ON "approval_chains"("document_id");

-- CreateIndex
CREATE INDEX "approval_chain_steps_chain_id_idx" ON "approval_chain_steps"("chain_id");

-- CreateIndex
CREATE INDEX "approval_chain_steps_assigned_user_id_idx" ON "approval_chain_steps"("assigned_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "approval_chain_steps_chain_id_step_order_key" ON "approval_chain_steps"("chain_id", "step_order");

-- CreateIndex
CREATE INDEX "workflow_runs_document_id_idx" ON "workflow_runs"("document_id");

-- CreateIndex
CREATE INDEX "workflow_runs_document_version_id_idx" ON "workflow_runs"("document_version_id");

-- CreateIndex
CREATE INDEX "workflow_runs_chain_id_idx" ON "workflow_runs"("chain_id");

-- CreateIndex
CREATE INDEX "workflow_runs_status_idx" ON "workflow_runs"("status");

-- CreateIndex
CREATE INDEX "workflow_runs_document_id_status_idx" ON "workflow_runs"("document_id", "status");

-- CreateIndex
CREATE INDEX "approval_actions_workflow_run_id_idx" ON "approval_actions"("workflow_run_id");

-- CreateIndex
CREATE INDEX "approval_actions_chain_step_id_idx" ON "approval_actions"("chain_step_id");

-- CreateIndex
CREATE INDEX "approval_actions_document_version_id_idx" ON "approval_actions"("document_version_id");

-- CreateIndex
CREATE INDEX "approval_actions_actor_id_idx" ON "approval_actions"("actor_id");

-- CreateIndex
CREATE INDEX "approval_actions_action_idx" ON "approval_actions"("action");

-- CreateIndex
CREATE INDEX "approval_actions_created_at_idx" ON "approval_actions"("created_at");

-- CreateIndex
CREATE INDEX "notifications_recipient_id_idx" ON "notifications"("recipient_id");

-- CreateIndex
CREATE INDEX "notifications_recipient_id_is_read_idx" ON "notifications"("recipient_id", "is_read");

-- CreateIndex
CREATE INDEX "notifications_document_id_idx" ON "notifications"("document_id");

-- CreateIndex
CREATE INDEX "notifications_created_at_idx" ON "notifications"("created_at");

-- CreateIndex
CREATE INDEX "audit_logs_actor_id_idx" ON "audit_logs"("actor_id");

-- CreateIndex
CREATE INDEX "audit_logs_action_idx" ON "audit_logs"("action");

-- CreateIndex
CREATE INDEX "audit_logs_entity_type_entity_id_idx" ON "audit_logs"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs"("created_at");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_preparer_id_fkey" FOREIGN KEY ("preparer_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_current_workflow_run_id_fkey" FOREIGN KEY ("current_workflow_run_id") REFERENCES "workflow_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_revision_requested_by_action_id_fkey" FOREIGN KEY ("revision_requested_by_action_id") REFERENCES "approval_actions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_uploaded_by_id_fkey" FOREIGN KEY ("uploaded_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_chains" ADD CONSTRAINT "approval_chains_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_chains" ADD CONSTRAINT "approval_chains_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_chain_steps" ADD CONSTRAINT "approval_chain_steps_chain_id_fkey" FOREIGN KEY ("chain_id") REFERENCES "approval_chains"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_chain_steps" ADD CONSTRAINT "approval_chain_steps_assigned_user_id_fkey" FOREIGN KEY ("assigned_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_document_version_id_fkey" FOREIGN KEY ("document_version_id") REFERENCES "document_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_chain_id_fkey" FOREIGN KEY ("chain_id") REFERENCES "approval_chains"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_actions" ADD CONSTRAINT "approval_actions_workflow_run_id_fkey" FOREIGN KEY ("workflow_run_id") REFERENCES "workflow_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_actions" ADD CONSTRAINT "approval_actions_chain_step_id_fkey" FOREIGN KEY ("chain_step_id") REFERENCES "approval_chain_steps"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_actions" ADD CONSTRAINT "approval_actions_document_version_id_fkey" FOREIGN KEY ("document_version_id") REFERENCES "document_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_actions" ADD CONSTRAINT "approval_actions_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_recipient_id_fkey" FOREIGN KEY ("recipient_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_workflow_run_id_fkey" FOREIGN KEY ("workflow_run_id") REFERENCES "workflow_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
