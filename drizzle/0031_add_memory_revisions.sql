CREATE TABLE "memory_revisions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"memory_id" text,
	"key" text NOT NULL,
	"action" text NOT NULL,
	"old_value" text,
	"new_value" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memory_revisions" ADD CONSTRAINT "memory_revisions_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;