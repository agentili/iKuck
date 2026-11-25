DROP TRIGGER IF EXISTS sync_recipe_image ON sync_items;
--> statement-breakpoint
DROP FUNCTION IF EXISTS queue_recipe_image();
--> statement-breakpoint
DROP TRIGGER IF EXISTS sync_image_consent ON sync_items;
--> statement-breakpoint
DROP FUNCTION IF EXISTS resume_recipe_images_on_consent();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.set_recipe_image_policy_v3() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 PERFORM pg_catalog.set_config('ikuck.recipe_image_policy', 'recipe-images-v3', true);
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.set_recipe_image_request_v3() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 PERFORM pg_catalog.set_config('ikuck.recipe_image_request', 'recipe-images-v3-single', true);
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.guard_recipe_image_claim() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.state = 'processing' AND OLD.state IS DISTINCT FROM 'processing'
    AND pg_catalog.current_setting('ikuck.recipe_image_policy', true) IS DISTINCT FROM 'recipe-images-v3' THEN
   RAISE EXCEPTION 'recipe image worker policy mismatch' USING ERRCODE = '55000';
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.guard_recipe_image_dispatch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.dispatched_at IS NOT NULL
    AND (TG_OP = 'INSERT' OR OLD.dispatched_at IS NULL)
    AND pg_catalog.current_setting('ikuck.recipe_image_policy', true) IS DISTINCT FROM 'recipe-images-v3' THEN
   RAISE EXCEPTION 'recipe image dispatch policy mismatch' USING ERRCODE = '55000';
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS recipe_image_dispatch_guard ON recipe_image_jobs;
CREATE TRIGGER recipe_image_dispatch_guard BEFORE INSERT OR UPDATE OF dispatched_at ON recipe_image_jobs
 FOR EACH ROW EXECUTE FUNCTION public.guard_recipe_image_dispatch();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.guard_recipe_image_admission() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ((TG_OP = 'INSERT') OR (NEW.state = 'pending' AND OLD.state IS DISTINCT FROM 'pending'))
    AND pg_catalog.current_setting('ikuck.recipe_image_request', true) IS DISTINCT FROM 'recipe-images-v3-single' THEN
   RAISE EXCEPTION 'recipe image request policy mismatch' USING ERRCODE = '55000';
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS recipe_image_admission_guard ON recipe_image_jobs;
CREATE TRIGGER recipe_image_admission_guard BEFORE INSERT OR UPDATE OF state ON recipe_image_jobs
 FOR EACH ROW EXECUTE FUNCTION public.guard_recipe_image_admission();
--> statement-breakpoint
-- Preserve job IDs, attempts, dispatch markers, quotas, and all stored asset bytes/credit.
-- Only pending/ambiguous/old-consent work is quarantined for fresh explicit action.
UPDATE recipe_image_jobs SET state='failed',updated_at=clock_timestamp()
 WHERE state IN ('pending','processing','quota_exceeded','consent_required');