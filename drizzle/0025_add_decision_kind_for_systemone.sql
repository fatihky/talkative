CREATE TYPE "public"."decision_kind" AS ENUM('decision', 'systemone');--> statement-breakpoint
ALTER TABLE "decisions" ADD COLUMN "kind" "decision_kind" DEFAULT 'decision' NOT NULL;