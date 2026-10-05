CREATE TABLE s2s_service_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id text NOT NULL CONSTRAINT s2s_service_grants_service_id_check CHECK (service_id = 'hermes-family-pantry-reader'),
  house_id uuid NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
  sponsor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sponsor_membership_id uuid NOT NULL REFERENCES house_memberships(id) ON DELETE CASCADE,
  scope text NOT NULL CONSTRAINT s2s_service_grants_scope_check CHECK (scope = 'dinner-context:read'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CONSTRAINT s2s_service_grants_expires_at_check CHECK (expires_at > created_at)
);
CREATE INDEX s2s_service_grants_house_idx ON s2s_service_grants(house_id);
CREATE INDEX s2s_service_grants_sponsor_idx ON s2s_service_grants(sponsor_user_id);
CREATE TABLE s2s_service_credentials (
  key_id text PRIMARY KEY CONSTRAINT s2s_service_credentials_key_id_check CHECK (key_id ~ '^[A-Za-z0-9_-]{16,64}$'),
  grant_id uuid NOT NULL REFERENCES s2s_service_grants(id) ON DELETE CASCADE,
  secret_digest text NOT NULL CONSTRAINT s2s_service_credentials_secret_digest_check CHECK (secret_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CONSTRAINT s2s_service_credentials_expires_at_check CHECK (expires_at > created_at)
);
CREATE INDEX s2s_service_credentials_grant_idx ON s2s_service_credentials(grant_id);
