CREATE TABLE "meal_plan_migration_quarantines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"house_id" uuid NOT NULL,
	"source_account_id" uuid NOT NULL,
	"plan_date" date NOT NULL,
	"reason_code" text NOT NULL,
	"fingerprint" text NOT NULL,
	"raw_source_state" jsonb,
	"raw_source_projection" jsonb,
	"raw_target_state" jsonb,
	"raw_target_projection" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meal_plan_migration_quarantines_fingerprint_check" CHECK ("meal_plan_migration_quarantines"."fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "meal_plan_migration_quarantines_reason_check" CHECK (length("meal_plan_migration_quarantines"."reason_code") BETWEEN 1 AND 80)
);
--> statement-breakpoint
ALTER TABLE "meal_plan_migration_conflicts" ADD COLUMN "source_state" jsonb;--> statement-breakpoint
ALTER TABLE "meal_plan_migration_conflicts" ADD COLUMN "source_projection" jsonb;--> statement-breakpoint
ALTER TABLE "meal_plan_receipts" ADD COLUMN "command_json" jsonb;--> statement-breakpoint
ALTER TABLE "meal_plan_migration_quarantines" ADD CONSTRAINT "meal_plan_migration_quarantines_house_id_houses_id_fk" FOREIGN KEY ("house_id") REFERENCES "public"."houses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "meal_plan_migration_quarantines_source_fingerprint_unique" ON "meal_plan_migration_quarantines" USING btree ("house_id","source_account_id","plan_date","fingerprint");--> statement-breakpoint
CREATE INDEX "meal_plan_migration_quarantines_house_date_idx" ON "meal_plan_migration_quarantines" USING btree ("house_id","plan_date");