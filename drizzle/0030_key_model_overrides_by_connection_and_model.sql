/* ---------- data migration: re-key rows to (connection_id, model_id) ---------- */
/* model_id used to be the client's id string, and Waku handed route params
   through percent-encoded, so catalog rows were stored mangled
   (`3%3Adeepseek%2Fdeepseek-flash`) and user-added ones carried a
   `custom:` prefix. Both forms collapse onto the pair the new key uses. */
/* 0. a mangled row may already have a plain twin saved after the decode fix;
   the old key (user_id, model_id) makes decoding it a collision, so keep the
   newer of the two first */
DELETE FROM "model_overrides" "m" USING "model_overrides" "twin"
WHERE position('%' IN "m"."model_id") > 0
  AND "twin"."user_id" = "m"."user_id"
  AND "twin"."model_id" = replace(replace("m"."model_id", '%3A', ':'), '%2F', '/')
  AND ("m"."updated_at" < "twin"."updated_at"
       OR ("m"."updated_at" = "twin"."updated_at" AND "m"."ctid" < "twin"."ctid"));--> statement-breakpoint
/* 1. percent-decode the two characters encodeURIComponent escapes in ids */
UPDATE "model_overrides" SET "model_id" = replace(replace("model_id", '%3A', ':'), '%2F', '/');--> statement-breakpoint
/* 2. rows whose connection is unrecorded carry it as the id's prefix; drop
   the ones that don't parse and the ones naming a connection that's gone */
DELETE FROM "model_overrides" WHERE "connection_id" IS NULL AND "model_id" !~ '^[0-9]+:.+';--> statement-breakpoint
DELETE FROM "model_overrides" "mo" WHERE "mo"."connection_id" IS NULL AND NOT EXISTS (
  SELECT 1 FROM "provider_connections" "pc"
  WHERE "pc"."id" = substring("mo"."model_id" FROM '^([0-9]+)')::int
);--> statement-breakpoint
UPDATE "model_overrides" SET
  "connection_id" = substring("model_id" FROM '^([0-9]+)')::int,
  "model_id" = substring("model_id" FROM '^[0-9]+:(.+)$')
WHERE "connection_id" IS NULL;--> statement-breakpoint
/* 3. user-added rows recorded the full `custom:<connection>:<id>` string;
   the pair is what remains after the prefix */
UPDATE "model_overrides" SET "model_id" = regexp_replace("model_id", '^custom:[0-9]+:', '')
WHERE "connection_id" IS NOT NULL;--> statement-breakpoint
DELETE FROM "model_overrides" WHERE "model_id" = '';--> statement-breakpoint
/* 4. the old primary key was (user_id, model_id), so one pair can exist twice
   after the rewrite (a mangled catalog row plus a user-added one); keep the
   newest save, ties broken by physical row order */
DELETE FROM "model_overrides" "mo" USING "model_overrides" "kept"
WHERE "mo"."user_id" = "kept"."user_id"
  AND "mo"."connection_id" = "kept"."connection_id"
  AND "mo"."model_id" = "kept"."model_id"
  AND ("mo"."updated_at" < "kept"."updated_at"
       OR ("mo"."updated_at" = "kept"."updated_at" AND "mo"."ctid" < "kept"."ctid"));--> statement-breakpoint
/* ---------- schema migration (generated) ---------- */
ALTER TABLE "model_overrides" DROP CONSTRAINT "model_overrides_user_id_model_id_pk";--> statement-breakpoint
ALTER TABLE "model_overrides" ALTER COLUMN "connection_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "model_overrides" ADD CONSTRAINT "model_overrides_user_id_connection_id_model_id_pk" PRIMARY KEY("user_id","connection_id","model_id");--> statement-breakpoint
ALTER TABLE "model_overrides" DROP COLUMN "remote_id";
