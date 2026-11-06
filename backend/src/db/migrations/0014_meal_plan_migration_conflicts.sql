CREATE TABLE "meal_plan_migration_conflicts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"house_id" uuid NOT NULL,
	"source_account_id" uuid NOT NULL,
	"plan_date" date NOT NULL,
	"source_revision" uuid NOT NULL,
	"source_projection_mutation_id" text NOT NULL,
	"source_device_id" text NOT NULL,
	"source_client_updated_at" timestamp with time zone NOT NULL,
	"source_server_updated_at" timestamp with time zone NOT NULL,
	"target_revision" uuid NOT NULL,
	"target_state" jsonb NOT NULL,
	"original_command" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"resolution_digest" text,
	"resolution_command" jsonb,
	"resolution_result" jsonb,
	"resolved_by_user_id" uuid,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meal_plan_migration_conflicts_status_check" CHECK ("meal_plan_migration_conflicts"."status" IN ('pending', 'resolved')),
	CONSTRAINT "meal_plan_migration_conflicts_resolution_check" CHECK (
    ("meal_plan_migration_conflicts"."status" = 'pending' AND "meal_plan_migration_conflicts"."resolution_digest" IS NULL AND "meal_plan_migration_conflicts"."resolution_command" IS NULL
      AND "meal_plan_migration_conflicts"."resolution_result" IS NULL AND "meal_plan_migration_conflicts"."resolved_by_user_id" IS NULL AND "meal_plan_migration_conflicts"."resolved_at" IS NULL)
    OR ("meal_plan_migration_conflicts"."status" = 'resolved' AND "meal_plan_migration_conflicts"."resolution_digest" ~ '^[0-9a-f]{64}$'
      AND "meal_plan_migration_conflicts"."resolution_command" IS NOT NULL AND "meal_plan_migration_conflicts"."resolution_result" IS NOT NULL
      AND "meal_plan_migration_conflicts"."resolved_by_user_id" IS NOT NULL AND "meal_plan_migration_conflicts"."resolved_at" IS NOT NULL)
  )
);
--> statement-breakpoint
ALTER TABLE "meal_plan_migration_conflicts" ADD CONSTRAINT "meal_plan_migration_conflicts_house_id_houses_id_fk" FOREIGN KEY ("house_id") REFERENCES "public"."houses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "meal_plan_migration_conflicts_source_unique" ON "meal_plan_migration_conflicts" USING btree ("house_id","source_account_id","plan_date","source_revision");--> statement-breakpoint
CREATE INDEX "meal_plan_migration_conflicts_house_status_created_idx" ON "meal_plan_migration_conflicts" USING btree ("house_id","status","created_at");