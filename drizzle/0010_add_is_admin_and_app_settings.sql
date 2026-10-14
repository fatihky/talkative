CREATE TABLE "app_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "is_admin" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "user" SET "is_admin" = true WHERE "id" = (SELECT "id" FROM "user" ORDER BY "created_at" ASC LIMIT 1);--> statement-breakpoint
INSERT INTO "app_settings" ("key", "value") SELECT 'site', '{"registrationEnabled": false}'::jsonb WHERE EXISTS (SELECT 1 FROM "user") ON CONFLICT ("key") DO NOTHING;