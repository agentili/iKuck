CREATE FUNCTION revoke_s2s_grants_on_admin_demotion()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE s2s_service_grants
  SET revoked_at = COALESCE(revoked_at, now())
  WHERE sponsor_membership_id = OLD.id AND revoked_at IS NULL;

  UPDATE s2s_service_credentials
  SET revoked_at = COALESCE(revoked_at, now())
  WHERE revoked_at IS NULL
    AND grant_id IN (SELECT id FROM s2s_service_grants WHERE sponsor_membership_id = OLD.id);

  RETURN NEW;
END;
$$;

CREATE TRIGGER house_memberships_revoke_s2s_on_admin_demotion
AFTER UPDATE OF role ON house_memberships
FOR EACH ROW
WHEN (OLD.role = 'admin' AND NEW.role <> 'admin')
EXECUTE FUNCTION revoke_s2s_grants_on_admin_demotion();
