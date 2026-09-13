ALTER TABLE "users" ALTER COLUMN "password_hash" DROP NOT NULL;

CREATE TABLE IF NOT EXISTS "account_identities" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
  "provider" text NOT NULL,
  "provider_subject" text NOT NULL,
  "provider_email" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "account_identities_provider_subject_unique"
  ON "account_identities" ("provider", "provider_subject");
CREATE UNIQUE INDEX IF NOT EXISTS "account_identities_user_provider_unique"
  ON "account_identities" ("user_id", "provider");
CREATE INDEX IF NOT EXISTS "account_identities_user_id_index"
  ON "account_identities" ("user_id");
