-- existing ids are 20-character generated strings, so renumber the rows from a
-- throwaway sequence instead of casting: every /a/<id> link changes once, and
-- afterwards the integer id *is* the url id.
CREATE SEQUENCE "artifacts_id_renumber";--> statement-breakpoint
ALTER TABLE "artifacts" ALTER COLUMN "id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "artifacts" ALTER COLUMN "id" SET DATA TYPE integer USING (nextval('"artifacts_id_renumber"')::integer);--> statement-breakpoint
DROP SEQUENCE "artifacts_id_renumber";--> statement-breakpoint
ALTER TABLE "artifacts" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (sequence name "artifacts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1);--> statement-breakpoint
SELECT setval('"artifacts_id_seq"', GREATEST((SELECT COALESCE(MAX("id"), 0) FROM "artifacts") + 1, 1), false);
