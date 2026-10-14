CREATE TABLE IF NOT EXISTS "dinner_consumption_receipts" (
  "operation_id" text PRIMARY KEY,
  "entry_id" text NOT NULL,
  "scope_type" text NOT NULL,
  "scope_id" text NOT NULL,
  "request_digest" text NOT NULL,
  "committed_at" timestamptz NOT NULL,
  "created_by_user_id" uuid REFERENCES "users" ("id") ON DELETE SET NULL,
  "plan" jsonb NOT NULL,
  CONSTRAINT "dinner_consumption_operation_id_check" CHECK (length("operation_id") BETWEEN 1 AND 128),
  CONSTRAINT "dinner_consumption_entry_id_check" CHECK (length("entry_id") BETWEEN 1 AND 128),
  CONSTRAINT "dinner_consumption_scope_type_check" CHECK ("scope_type" IN ('user', 'house')),
  CONSTRAINT "dinner_consumption_request_digest_check" CHECK ("request_digest" ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS "dinner_consumption_receipts_scope_entry_unique"
  ON "dinner_consumption_receipts" ("scope_type", "scope_id", "entry_id");

CREATE INDEX IF NOT EXISTS "dinner_consumption_receipts_scope_index"
  ON "dinner_consumption_receipts" ("scope_type", "scope_id");
