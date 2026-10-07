-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('user', 'teacher', 'bdm', 'admin');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('active', 'checked', 'completed', 'blocked');

-- CreateEnum
CREATE TYPE "BookingStatus" AS ENUM ('Present', 'Absent', 'pending', 'completed', 'missed');

-- CreateEnum
CREATE TYPE "TestType" AS ENUM ('Computer-Based', 'Paper-Based');

-- CreateEnum
CREATE TYPE "BookingLocation" AS ENUM ('Home', 'Test Center');

-- CreateEnum
CREATE TYPE "ScheduleStatus" AS ENUM ('Scheduled', 'Cancelled');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "email_verified" BOOLEAN NOT NULL DEFAULT false,
    "image" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "password" TEXT NOT NULL,
    "role" "UserRole" NOT NULL,
    "status" "UserStatus",
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "date_of_birth" TEXT,
    "contact_no" TEXT,
    "passport_number" TEXT,
    "sex" TEXT,
    "result" JSONB,
    "mock" INTEGER NOT NULL DEFAULT 0,
    "total_mock" INTEGER NOT NULL DEFAULT 0,
    "mock_type" TEXT,
    "test_system" TEXT,
    "test_type" TEXT,
    "profile_change_request_status" TEXT,
    "profile_edit_note" TEXT,
    "need_password_change" BOOLEAN,
    "password_changed_at" TIMESTAMPTZ(3),
    "transaction_id" TEXT,
    "teacher_l_email" TEXT,
    "teacher_r_email" TEXT,
    "teacher_w_email" TEXT,
    "teacher_s_email" TEXT,
    "last_trf_email_at" TIMESTAMPTZ(3),
    "budget" JSONB,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "token" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "user_id" TEXT NOT NULL,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accounts" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "access_token" TEXT,
    "refresh_token" TEXT,
    "id_token" TEXT,
    "access_token_expires_at" TIMESTAMPTZ(3),
    "refresh_token_expires_at" TIMESTAMPTZ(3),
    "scope" TEXT,
    "password" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verifications" (
    "id" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "verifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bookings" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "schedule_id" TEXT,
    "slot_id" TEXT,
    "name" TEXT NOT NULL,
    "location" "BookingLocation" NOT NULL,
    "booking_date" DATE NOT NULL,
    "status" "BookingStatus" NOT NULL,
    "attendance" TEXT,
    "test_type" "TestType" NOT NULL,
    "test_system" TEXT,
    "test_time" TEXT,
    "start_time" TEXT,
    "end_time" TEXT,
    "teacher_l" TEXT,
    "teacher_l_email" TEXT,
    "teacher_r" TEXT,
    "teacher_r_email" TEXT,
    "teacher_w" TEXT,
    "teacher_w_email" TEXT,
    "teacher_s" TEXT,
    "teacher_s_email" TEXT,
    "trf_emailed" BOOLEAN,
    "trf_email_at" TIMESTAMPTZ(3),

    CONSTRAINT "bookings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "teacher_assignments" (
    "id" UUID NOT NULL,
    "user_id" TEXT NOT NULL,
    "legacy_key" TEXT NOT NULL,
    "booking_id" TEXT,
    "schedule_id" TEXT,
    "teacher_l" TEXT,
    "teacher_l_email" TEXT,
    "teacher_r" TEXT,
    "teacher_r_email" TEXT,
    "teacher_w" TEXT,
    "teacher_w_email" TEXT,
    "teacher_s" TEXT,
    "teacher_s_email" TEXT,

    CONSTRAINT "teacher_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "courses" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "image" TEXT NOT NULL,
    "home_based_systems" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMPTZ(3),
    "updated_at" TIMESTAMPTZ(3),

    CONSTRAINT "courses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feedback_entries" (
    "id" UUID NOT NULL,
    "user_id" TEXT NOT NULL,
    "legacy_key" TEXT NOT NULL,
    "segment" TEXT NOT NULL,
    "feedback" JSONB,
    "marks" JSONB,
    "admin" TEXT,
    "recorded_at" TIMESTAMPTZ(3),

    CONSTRAINT "feedback_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feedback_status" (
    "id" UUID NOT NULL,
    "user_id" TEXT NOT NULL,
    "legacy_key" TEXT NOT NULL,
    "segment" TEXT NOT NULL,
    "complete" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "feedback_status_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "schedules" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "course_id" TEXT NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,
    "test_type" "TestType" NOT NULL,
    "test_system" TEXT,
    "status" "ScheduleStatus" NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "schedule_slots" (
    "id" UUID NOT NULL,
    "schedule_id" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "slot_id" TEXT NOT NULL,
    "seats_left" INTEGER NOT NULL,
    "capacity_total" INTEGER NOT NULL,
    "start_time" TEXT NOT NULL,
    "end_time" TEXT NOT NULL,

    CONSTRAINT "schedule_slots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "slot_counters" (
    "schedule_id" TEXT NOT NULL,
    "next_n" INTEGER NOT NULL,

    CONSTRAINT "slot_counters_pkey" PRIMARY KEY ("schedule_id")
);

-- CreateTable
CREATE TABLE "admin_sections" (
    "id" UUID NOT NULL,
    "user_id" TEXT NOT NULL,
    "legacy_key" TEXT NOT NULL,
    "overall_score" TEXT,
    "proficiency_level" TEXT,
    "result_date" TEXT,
    "scheme_code" TEXT,
    "admin_comments" TEXT,
    "admin_signature" TEXT,
    "centre_name" TEXT,
    "test_date" TEXT,
    "updated_at" TIMESTAMPTZ(3),

    CONSTRAINT "admin_sections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trf_emails" (
    "id" UUID NOT NULL,
    "user_id" TEXT NOT NULL,
    "legacy_key" TEXT NOT NULL,
    "last_sent_at" TIMESTAMPTZ(3),
    "last_subject" TEXT,
    "last_filename" TEXT,
    "to_address" TEXT,

    CONSTRAINT "trf_emails_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trf_email_history" (
    "id" UUID NOT NULL,
    "user_id" TEXT NOT NULL,
    "legacy_key" TEXT NOT NULL,
    "sent_at" TIMESTAMPTZ(3),
    "subject" TEXT,
    "filename" TEXT,
    "to_address" TEXT,

    CONSTRAINT "trf_email_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mock_allocations" (
    "id" UUID NOT NULL,
    "user_id" TEXT NOT NULL,
    "transaction_id" TEXT,
    "mock" INTEGER,
    "mock_type" TEXT,
    "mr_validation" TEXT,
    "mr_validation_expiry" TIMESTAMPTZ(3),
    "test_system" TEXT,
    "test_type" TEXT,
    "email_reminder_sent" BOOLEAN,
    "created_at" TIMESTAMPTZ(3),
    "updated_at" TIMESTAMPTZ(3),

    CONSTRAINT "mock_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ix_users_email" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_key" ON "sessions"("token");

-- CreateIndex
CREATE INDEX "ix_sessions_user_id" ON "sessions"("user_id");

-- CreateIndex
CREATE INDEX "ix_accounts_user_id" ON "accounts"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_accounts_provider_id_account_id" ON "accounts"("provider_id", "account_id");

-- CreateIndex
CREATE INDEX "ix_verifications_identifier" ON "verifications"("identifier");

-- CreateIndex
CREATE INDEX "ix_bookings_user_id" ON "bookings"("user_id");

-- CreateIndex
CREATE INDEX "ix_bookings_schedule_id" ON "bookings"("schedule_id");

-- CreateIndex
CREATE INDEX "ix_teacher_assignments_user_id_legacy_key" ON "teacher_assignments"("user_id", "legacy_key");

-- CreateIndex
CREATE INDEX "ix_teacher_assignments_booking_id" ON "teacher_assignments"("booking_id");

-- CreateIndex
CREATE INDEX "ix_feedback_entries_user_id_legacy_key" ON "feedback_entries"("user_id", "legacy_key");

-- CreateIndex
CREATE UNIQUE INDEX "uq_feedback_status_user_id_legacy_key_segment" ON "feedback_status"("user_id", "legacy_key", "segment");

-- CreateIndex
CREATE INDEX "ix_schedules_course_id" ON "schedules"("course_id");

-- CreateIndex
CREATE INDEX "ix_schedule_slots_schedule_id" ON "schedule_slots"("schedule_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_schedule_slots_schedule_id_slot_id" ON "schedule_slots"("schedule_id", "slot_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_admin_sections_user_id_legacy_key" ON "admin_sections"("user_id", "legacy_key");

-- CreateIndex
CREATE UNIQUE INDEX "uq_trf_emails_user_id_legacy_key" ON "trf_emails"("user_id", "legacy_key");

-- CreateIndex
CREATE INDEX "ix_trf_email_history_user_id_legacy_key" ON "trf_email_history"("user_id", "legacy_key");

-- CreateIndex
CREATE INDEX "ix_mock_allocations_user_id" ON "mock_allocations"("user_id");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

