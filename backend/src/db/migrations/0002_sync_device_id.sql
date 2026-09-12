ALTER TABLE "sync_items"
  ADD COLUMN IF NOT EXISTS "device_id" text NOT NULL DEFAULT 'legacy-device';

ALTER TABLE "sync_items"
  ALTER COLUMN "device_id" DROP DEFAULT;
