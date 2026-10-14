ALTER TABLE "messages" ADD COLUMN "refusal" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "annotations" jsonb DEFAULT '[]'::jsonb NOT NULL;