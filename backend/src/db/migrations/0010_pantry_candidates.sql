ALTER TABLE "bring_connections"
  ADD COLUMN IF NOT EXISTS "recently_watermark_at" timestamptz;
ALTER TABLE "bring_connections"
  ADD COLUMN IF NOT EXISTS "recently_snapshot" jsonb;

CREATE TABLE IF NOT EXISTS "pantry_candidates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "house_id" uuid NOT NULL REFERENCES "houses" ("id") ON DELETE CASCADE,
  "raw_label" text NOT NULL,
  "label" text NOT NULL,
  "normalized_label" text NOT NULL,
  "specification" text NOT NULL,
  "list_name" text NOT NULL,
  "checked_off_at" timestamptz,
  "detected_at" timestamptz NOT NULL DEFAULT now(),
  "expires_at" timestamptz NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "resolved_at" timestamptz,
  CONSTRAINT "pantry_candidates_status_check" CHECK ("status" IN ('pending', 'accepted', 'ignored'))
);

CREATE UNIQUE INDEX IF NOT EXISTS "pantry_candidates_house_normalized_label_unique"
  ON "pantry_candidates" ("house_id", "normalized_label");
CREATE INDEX IF NOT EXISTS "pantry_candidates_house_status_expiry_idx"
  ON "pantry_candidates" ("house_id", "status", "expires_at");
