-- Rebuild unsent reminders with UTC scheduling; preserve terminal rows for deduplication.
DELETE FROM "push_deliveries" WHERE "status" = 'pending';--> statement-breakpoint
UPDATE "houses"
SET "time_zone" = 'UTC', "time_zone_revision" = gen_random_uuid(), "updated_at" = now()
WHERE "time_zone" IS DISTINCT FROM 'UTC' OR "time_zone_revision" IS NULL;--> statement-breakpoint
UPDATE "push_preferences" SET "time_zone" = 'UTC' WHERE "time_zone" IS DISTINCT FROM 'UTC';--> statement-breakpoint
ALTER TABLE "houses" ALTER COLUMN "time_zone" SET DEFAULT 'UTC';--> statement-breakpoint
ALTER TABLE "houses" ALTER COLUMN "time_zone" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "houses" ALTER COLUMN "time_zone_revision" SET DEFAULT gen_random_uuid();--> statement-breakpoint
ALTER TABLE "houses" ALTER COLUMN "time_zone_revision" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "push_preferences" ALTER COLUMN "time_zone" SET DEFAULT 'UTC';--> statement-breakpoint
ALTER TABLE "houses" ADD CONSTRAINT "houses_time_zone_utc_check" CHECK ("houses"."time_zone" = 'UTC');--> statement-breakpoint
ALTER TABLE "push_preferences" ADD CONSTRAINT "push_preferences_time_zone_utc_check" CHECK ("push_preferences"."time_zone" = 'UTC');