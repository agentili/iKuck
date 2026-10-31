CREATE TABLE "meal_plan_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope_type" text NOT NULL,
	"scope_id" text NOT NULL,
	"user_scope_id" uuid,
	"house_scope_id" uuid,
	"actor_id" uuid,
	"operation_id" text NOT NULL,
	"request_hash" text NOT NULL,
	"result_json" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meal_plan_receipts_scope_check" CHECK (("meal_plan_receipts"."scope_type" = 'user' AND "meal_plan_receipts"."user_scope_id" IS NOT NULL AND "meal_plan_receipts"."house_scope_id" IS NULL AND "meal_plan_receipts"."scope_id" = "meal_plan_receipts"."user_scope_id"::text) OR ("meal_plan_receipts"."scope_type" = 'house' AND "meal_plan_receipts"."user_scope_id" IS NULL AND "meal_plan_receipts"."house_scope_id" IS NOT NULL AND "meal_plan_receipts"."scope_id" = "meal_plan_receipts"."house_scope_id"::text)),
	CONSTRAINT "meal_plan_receipts_operation_id_check" CHECK (length("meal_plan_receipts"."operation_id") BETWEEN 1 AND 128),
	CONSTRAINT "meal_plan_receipts_request_hash_check" CHECK ("meal_plan_receipts"."request_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "meal_plan_states" (
	"scope_type" text NOT NULL,
	"scope_id" text NOT NULL,
	"user_scope_id" uuid,
	"house_scope_id" uuid,
	"plan_date" date NOT NULL,
	"revision" uuid NOT NULL,
	"kind" text NOT NULL,
	"recipe_id" text,
	"manual_client_at" timestamp with time zone,
	"manual_server_at" timestamp with time zone,
	"manual_device_id" text,
	"manual_operation_id" text,
	CONSTRAINT "meal_plan_states_pk" PRIMARY KEY("scope_type","scope_id","plan_date"),
	CONSTRAINT "meal_plan_states_scope_check" CHECK (("meal_plan_states"."scope_type" = 'user' AND "meal_plan_states"."user_scope_id" IS NOT NULL AND "meal_plan_states"."house_scope_id" IS NULL AND "meal_plan_states"."scope_id" = "meal_plan_states"."user_scope_id"::text) OR ("meal_plan_states"."scope_type" = 'house' AND "meal_plan_states"."user_scope_id" IS NULL AND "meal_plan_states"."house_scope_id" IS NOT NULL AND "meal_plan_states"."scope_id" = "meal_plan_states"."house_scope_id"::text)),
	CONSTRAINT "meal_plan_states_kind_check" CHECK ("meal_plan_states"."kind" IN ('automatic', 'manual', 'deleted')),
	CONSTRAINT "meal_plan_states_recipe_check" CHECK (("meal_plan_states"."kind" = 'deleted' AND "meal_plan_states"."recipe_id" IS NULL) OR ("meal_plan_states"."kind" IN ('automatic', 'manual') AND "meal_plan_states"."recipe_id" IS NOT NULL)),
	CONSTRAINT "meal_plan_states_manual_tuple_check" CHECK (("meal_plan_states"."manual_client_at" IS NULL AND "meal_plan_states"."manual_server_at" IS NULL AND "meal_plan_states"."manual_device_id" IS NULL AND "meal_plan_states"."manual_operation_id" IS NULL) OR ("meal_plan_states"."manual_client_at" IS NOT NULL AND "meal_plan_states"."manual_server_at" IS NOT NULL AND "meal_plan_states"."manual_device_id" IS NOT NULL AND "meal_plan_states"."manual_operation_id" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "houses" ADD COLUMN "time_zone" text;--> statement-breakpoint
ALTER TABLE "houses" ADD COLUMN "time_zone_revision" uuid;--> statement-breakpoint
ALTER TABLE "meal_plan_receipts" ADD CONSTRAINT "meal_plan_receipts_user_scope_id_users_id_fk" FOREIGN KEY ("user_scope_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meal_plan_receipts" ADD CONSTRAINT "meal_plan_receipts_house_scope_id_houses_id_fk" FOREIGN KEY ("house_scope_id") REFERENCES "public"."houses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meal_plan_receipts" ADD CONSTRAINT "meal_plan_receipts_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meal_plan_states" ADD CONSTRAINT "meal_plan_states_user_scope_id_users_id_fk" FOREIGN KEY ("user_scope_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meal_plan_states" ADD CONSTRAINT "meal_plan_states_house_scope_id_houses_id_fk" FOREIGN KEY ("house_scope_id") REFERENCES "public"."houses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "meal_plan_receipts_scope_actor_operation_unique" ON "meal_plan_receipts" USING btree ("scope_type","scope_id","actor_id","operation_id");--> statement-breakpoint
CREATE INDEX "meal_plan_receipts_scope_index" ON "meal_plan_receipts" USING btree ("scope_type","scope_id");--> statement-breakpoint
ALTER TABLE "houses" ADD CONSTRAINT "houses_time_zone_revision_pair_check" CHECK (("houses"."time_zone" IS NULL AND "houses"."time_zone_revision" IS NULL) OR "houses"."time_zone_revision" IS NOT NULL);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION maintain_sync_items_commit_order() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  reserved_sequence text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('ikuck:sync-server-sequence-commit-order', 0));
  reserved_sequence := NULLIF(current_setting('ikuck.sync_server_sequence', true), '');
  IF reserved_sequence IS NULL THEN
    NEW.server_sequence := nextval('sync_server_sequence');
  ELSE
    NEW.server_sequence := reserved_sequence::bigint;
    PERFORM set_config('ikuck.sync_server_sequence', '', true);
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER sync_items_commit_order
BEFORE INSERT OR UPDATE ON sync_items
FOR EACH ROW EXECUTE FUNCTION maintain_sync_items_commit_order();