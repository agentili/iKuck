CREATE TABLE "recipe_image_assets" (
	"job_id" uuid PRIMARY KEY NOT NULL,
	"content" "bytea" NOT NULL,
	"hash" text NOT NULL,
	"width" bigint NOT NULL,
	"height" bigint NOT NULL,
	"source" text NOT NULL,
	"author" text NOT NULL,
	"source_url" text NOT NULL,
	"license" text NOT NULL,
	"model" text
);
--> statement-breakpoint
CREATE TABLE "recipe_image_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sync_item_id" uuid,
	"catalog_id" text,
	"user_id" uuid,
	"recipe" jsonb NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" bigint DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dispatched_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recipe_image_jobs_sync_item_id_unique" UNIQUE("sync_item_id"),
	CONSTRAINT "recipe_image_jobs_catalog_id_unique" UNIQUE("catalog_id"),
	CONSTRAINT "recipe_image_one_source" CHECK (("recipe_image_jobs"."sync_item_id" IS NULL) <> ("recipe_image_jobs"."catalog_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "recipe_image_quota" (
	"principal" text NOT NULL,
	"day" date NOT NULL,
	"used" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "recipe_image_quota_principal_day_pk" PRIMARY KEY("principal","day")
);
--> statement-breakpoint
ALTER TABLE "recipe_image_assets" ADD CONSTRAINT "recipe_image_assets_job_id_recipe_image_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."recipe_image_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_image_jobs" ADD CONSTRAINT "recipe_image_jobs_sync_item_id_sync_items_id_fk" FOREIGN KEY ("sync_item_id") REFERENCES "public"."sync_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_image_jobs" ADD CONSTRAINT "recipe_image_jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX recipe_image_pending_idx ON recipe_image_jobs (available_at) WHERE state = 'pending';
--> statement-breakpoint
CREATE FUNCTION queue_recipe_image() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.entity_type NOT IN ('generated_recipe', 'saved_recipe') THEN RETURN NEW; END IF;
 IF NEW.deleted THEN DELETE FROM recipe_image_jobs WHERE sync_item_id = NEW.id; RETURN NEW; END IF;
 IF TG_OP = 'UPDATE' AND OLD.payload->'title' = NEW.payload->'title' AND OLD.payload->'ingredients' = NEW.payload->'ingredients' AND NOT OLD.deleted THEN RETURN NEW; END IF;
 DELETE FROM recipe_image_jobs WHERE sync_item_id = NEW.id;
 INSERT INTO recipe_image_jobs(sync_item_id, user_id, recipe) VALUES (NEW.id, NEW.user_id, jsonb_build_object('title', NEW.payload->'title', 'ingredients', NEW.payload->'ingredients'));
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER sync_recipe_image AFTER INSERT OR UPDATE ON sync_items FOR EACH ROW EXECUTE FUNCTION queue_recipe_image();
--> statement-breakpoint
CREATE FUNCTION resume_recipe_images_on_consent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.entity_type='ai_consent' AND NOT NEW.deleted AND NEW.payload->>'enabled'='true' AND NEW.payload->>'imagePolicyVersion'='recipe-images-v1' THEN
 UPDATE recipe_image_jobs SET state='pending',available_at=now() WHERE user_id=NEW.user_id AND state='consent_required';
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER sync_image_consent AFTER INSERT OR UPDATE ON sync_items FOR EACH ROW EXECUTE FUNCTION resume_recipe_images_on_consent();
