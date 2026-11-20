CREATE OR REPLACE FUNCTION resume_recipe_images_on_consent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.entity_type='ai_consent' AND NOT NEW.deleted AND NEW.payload->>'enabled'='true' AND NEW.payload->>'imagePolicyVersion'='recipe-images-v2' AND NEW.payload->>'imageProvider' IN ('openai','gemini') THEN
 UPDATE recipe_image_jobs SET state='pending',available_at=now() WHERE user_id=NEW.user_id AND state='consent_required';
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
-- This marker is a rollout fence, not an SQL privilege boundary. It must never
-- be set at session, role or database scope.
CREATE FUNCTION public.set_recipe_image_policy_v2() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 PERFORM pg_catalog.set_config('ikuck.recipe_image_policy', 'recipe-images-v2', true);
END $$;
--> statement-breakpoint
CREATE FUNCTION public.guard_recipe_image_claim() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.state = 'processing' AND OLD.state IS DISTINCT FROM 'processing'
    AND pg_catalog.current_setting('ikuck.recipe_image_policy', true) IS DISTINCT FROM 'recipe-images-v2' THEN
   RAISE EXCEPTION 'recipe image worker policy mismatch' USING ERRCODE = '55000';
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER recipe_image_claim_policy BEFORE UPDATE OF state ON recipe_image_jobs
 FOR EACH ROW EXECUTE FUNCTION public.guard_recipe_image_claim();
--> statement-breakpoint
-- Stop and quiesce old workers before migration. Interrupted paid calls must
-- not be replayed, and no pre-fix Commons attribution can be trusted.
UPDATE recipe_image_jobs j SET state='failed', updated_at=now() WHERE j.state='processing'
 OR EXISTS (SELECT 1 FROM recipe_image_assets a WHERE a.job_id=j.id AND a.source='wikimedia');
--> statement-breakpoint
DELETE FROM recipe_image_assets WHERE source='wikimedia';
