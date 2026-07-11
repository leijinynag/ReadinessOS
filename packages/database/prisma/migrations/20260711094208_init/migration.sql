-- CreateEnum
CREATE TYPE "MemberRole" AS ENUM ('owner', 'admin', 'member', 'viewer');

-- CreateEnum
CREATE TYPE "ScenarioStatus" AS ENUM ('draft', 'published', 'archived');

-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('created', 'running', 'paused', 'completed', 'failed');

-- CreateEnum
CREATE TYPE "ParticipantController" AS ENUM ('human', 'agent', 'system');

-- CreateTable
CREATE TABLE "organizations" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "members" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "MemberRole" NOT NULL DEFAULT 'member',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scenarios" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "status" "ScenarioStatus" NOT NULL DEFAULT 'draft',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scenarios_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scenario_versions" (
    "id" UUID NOT NULL,
    "scenario_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "config" JSONB NOT NULL,
    "published_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scenario_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "simulation_runs" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "scenario_version_id" UUID NOT NULL,
    "parent_run_id" UUID,
    "branch_from_sequence" INTEGER,
    "status" "RunStatus" NOT NULL DEFAULT 'created',
    "version" INTEGER NOT NULL DEFAULT 0,
    "seed" INTEGER NOT NULL,
    "virtual_time" INTEGER NOT NULL DEFAULT 0,
    "latest_sequence" INTEGER NOT NULL DEFAULT 0,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "simulation_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "run_participants" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "controller" "ParticipantController" NOT NULL,
    "capabilities" JSONB NOT NULL DEFAULT '[]',
    "permissions" JSONB NOT NULL DEFAULT '[]',
    "objectives" JSONB NOT NULL DEFAULT '[]',
    "knowledge_scopes" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "run_participants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "organizations_slug_key" ON "organizations"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "members_user_id_organization_id_idx" ON "members"("user_id", "organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "members_organization_id_user_id_key" ON "members"("organization_id", "user_id");

-- CreateIndex
CREATE INDEX "scenarios_organization_id_status_idx" ON "scenarios"("organization_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "scenarios_organization_id_key_key" ON "scenarios"("organization_id", "key");

-- CreateIndex
CREATE UNIQUE INDEX "scenario_versions_scenario_id_version_key" ON "scenario_versions"("scenario_id", "version");

-- CreateIndex
CREATE INDEX "simulation_runs_organization_id_status_created_at_idx" ON "simulation_runs"("organization_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "simulation_runs_parent_run_id_branch_from_sequence_idx" ON "simulation_runs"("parent_run_id", "branch_from_sequence");

-- CreateIndex
CREATE INDEX "run_participants_run_id_controller_idx" ON "run_participants"("run_id", "controller");

-- CreateIndex
CREATE UNIQUE INDEX "run_participants_run_id_key_key" ON "run_participants"("run_id", "key");

-- AddForeignKey
ALTER TABLE "members" ADD CONSTRAINT "members_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "members" ADD CONSTRAINT "members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scenarios" ADD CONSTRAINT "scenarios_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scenario_versions" ADD CONSTRAINT "scenario_versions_scenario_id_fkey" FOREIGN KEY ("scenario_id") REFERENCES "scenarios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "simulation_runs" ADD CONSTRAINT "simulation_runs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "simulation_runs" ADD CONSTRAINT "simulation_runs_scenario_version_id_fkey" FOREIGN KEY ("scenario_version_id") REFERENCES "scenario_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "simulation_runs" ADD CONSTRAINT "simulation_runs_parent_run_id_fkey" FOREIGN KEY ("parent_run_id") REFERENCES "simulation_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "simulation_runs" ADD CONSTRAINT "simulation_runs_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run_participants" ADD CONSTRAINT "run_participants_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "simulation_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
