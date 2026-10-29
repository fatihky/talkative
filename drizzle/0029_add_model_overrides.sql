CREATE TABLE "model_overrides" (
	"user_id" text NOT NULL,
	"model_id" text NOT NULL,
	"short_name" text,
	"kind" text,
	"context_window" integer,
	"max_output" integer,
	"thinking_levels" jsonb,
	"default_thinking_level" text,
	"capabilities" jsonb,
	"pricing" jsonb,
	"params" text,
	"hidden" boolean DEFAULT false NOT NULL,
	"connection_id" integer,
	"remote_id" text,
	"base_url" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "model_overrides_user_id_model_id_pk" PRIMARY KEY("user_id","model_id")
);
--> statement-breakpoint
ALTER TABLE "model_overrides" ADD CONSTRAINT "model_overrides_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_overrides" ADD CONSTRAINT "model_overrides_connection_id_provider_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."provider_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "model_overrides_connection_id_idx" ON "model_overrides" USING btree ("connection_id");