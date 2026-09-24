CREATE TABLE IF NOT EXISTS "houses" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" text NOT NULL,
  "created_by_user_id" uuid NOT NULL REFERENCES "users" ("id") ON DELETE RESTRICT,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "house_memberships" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "house_id" uuid NOT NULL REFERENCES "houses" ("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
  "role" text NOT NULL,
  "joined_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "house_memberships_user_unique"
  ON "house_memberships" ("user_id");
CREATE UNIQUE INDEX IF NOT EXISTS "house_memberships_house_user_unique"
  ON "house_memberships" ("house_id", "user_id");
CREATE INDEX IF NOT EXISTS "house_memberships_house_index"
  ON "house_memberships" ("house_id");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'house_memberships_role_check'
  ) THEN
    ALTER TABLE "house_memberships"
      ADD CONSTRAINT "house_memberships_role_check" CHECK ("role" IN ('admin', 'member'));
  END IF;
END $$;

ALTER TABLE "sync_items"
  ADD COLUMN IF NOT EXISTS "scope_type" text NOT NULL DEFAULT 'user';
ALTER TABLE "sync_items"
  ADD COLUMN IF NOT EXISTS "scope_id" text;
UPDATE "sync_items"
SET "scope_id" = "user_id"::text
WHERE "scope_id" IS NULL;
ALTER TABLE "sync_items"
  ALTER COLUMN "scope_id" SET NOT NULL;

ALTER TABLE "processed_sync_mutations"
  ADD COLUMN IF NOT EXISTS "scope_type" text NOT NULL DEFAULT 'user';
ALTER TABLE "processed_sync_mutations"
  ADD COLUMN IF NOT EXISTS "scope_id" text;
UPDATE "processed_sync_mutations"
SET "scope_id" = "user_id"::text
WHERE "scope_id" IS NULL;
ALTER TABLE "processed_sync_mutations"
  ALTER COLUMN "scope_id" SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'sync_items_scope_type_check'
  ) THEN
    ALTER TABLE "sync_items"
      ADD CONSTRAINT "sync_items_scope_type_check" CHECK ("scope_type" IN ('user', 'house'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'processed_sync_mutations_scope_type_check'
  ) THEN
    ALTER TABLE "processed_sync_mutations"
      ADD CONSTRAINT "processed_sync_mutations_scope_type_check" CHECK ("scope_type" IN ('user', 'house'));
  END IF;
END $$;

DROP INDEX IF EXISTS "sync_items_entity_unique";
DROP INDEX IF EXISTS "sync_items_user_sequence_index";
DROP INDEX IF EXISTS "processed_sync_mutations_unique";

CREATE UNIQUE INDEX IF NOT EXISTS "sync_items_scope_entity_unique"
  ON "sync_items" ("scope_type", "scope_id", "entity_type", "entity_id");
CREATE INDEX IF NOT EXISTS "sync_items_scope_sequence_index"
  ON "sync_items" ("scope_type", "scope_id", "server_sequence");
CREATE UNIQUE INDEX IF NOT EXISTS "processed_sync_mutations_scope_unique"
  ON "processed_sync_mutations" ("scope_type", "scope_id", "mutation_id");
