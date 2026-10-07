CREATE TABLE "bring_connections" (
  "user_id" uuid PRIMARY KEY NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "connection_id" uuid NOT NULL,
  "encrypted_session" text NOT NULL,
  "connected_at" timestamp with time zone DEFAULT now() NOT NULL
);
