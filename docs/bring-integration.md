# Bring! external shopping lists

## Opt-in deployment configuration

Bring! is disabled unless the API receives `BRING_ENABLED=true`. Both Compose API services pass these settings to the backend only; the default is disabled, and no `VITE_BRING_*` build variable is used:

```dotenv
BRING_ENABLED=false
BRING_TOKEN_ENCRYPTION_KEY=
BRING_TEST_LIST_ID=
```

To enable it, set `BRING_ENABLED=true`, provide `BRING_TOKEN_ENCRYPTION_KEY` in the API's server-side environment, and set `BRING_TEST_LIST_ID` to the id of the dedicated test list used for the opt-in pilot. The key must be 32 cryptographically random bytes encoded as 64 hexadecimal characters. Keep it out of source control, frontend build arguments, browser storage, logs, and chat. Do not copy it into database backups: retain it in an appropriately protected secret store, separately from those backups. An enabled backend fails its startup/configuration validation when the key is missing or invalid, or when the test list id is missing.

The checked-in `backend/.env.example`, `deploy/.env.example`, and `deploy/.env.standalone.example` are templates only. They contain an empty key and test list id and leave the integration disabled; do not copy secrets into these tracked files.

### Dedicated test-list gate

While the integration is enabled, only the designated test list participates in remote operations. Connecting, listing the account's Bring! lists and disconnecting remain available, but reading a list snapshot and every item operation (add, update, complete, restore, remove) for any other list id is refused with `403 bring_list_not_allowed` before any request reaches Bring!. The refused list is never read, written, copied into iKuck or redirected to the local shopping list; the ordinary iKuck list stays available as its own explicit choice. To configure the pilot, read the id of the desired test list from the `GET /v1/integrations/bring/lists` response after connecting the account that can see it, then set `BRING_TEST_LIST_ID` and restart the API. Widening the integration beyond the single test list requires an explicit later code change; omitting the setting while Bring! is enabled is rejected instead of granting every list.

## What is sent and stored

Connecting is an explicit user action from the List page and requires a verified iKuck account and a separate confirmation. That confirmation authorizes iKuck to send the Bring! email and password for authentication and to access or change lists only when the user requests those operations. The Bring! email and password are sent to the same-origin iKuck backend, which uses them to authenticate with Bring!. iKuck does not persist, export, queue, synchronize, or log the password. The browser does not call Bring! directly.

The backend keeps the returned Bring! session encrypted with AES-256-GCM in a personal connection associated with that iKuck account. It is not shared with other members of a household. The encryption key is not stored in the database. The active connection remains until the user disconnects Bring! in iKuck or deletes the iKuck account; account deletion removes the local connection record. Database backups created before deletion may retain the encrypted record until their configured retention period expires.

When the user reads or changes a connected Bring! list, the backend exchanges list requests and item data with Bring!. Requested item operations can send item names and specifications to Bring!. This external list is not copied into the iKuck shopping list or offline storage, is not synchronized as iKuck data, and receives no ingredients automatically from recipes or dinner records. The ordinary iKuck list remains separate and available offline.

Disconnecting deletes the saved encrypted session from iKuck and leaves the remote Bring! lists untouched. It does not call a Bring! session-revocation endpoint, so it cannot guarantee revocation of a session or data held by Bring!; users should manage remote access with Bring! as needed.

## Provider and compatibility limits

The integration uses the MIT-licensed `@micsob/bring-api-client` version `3.0.1`. It communicates with Bring!'s unofficial API; this is not an official Bring! integration, and upstream behavior or availability may change.

The selected client does not store a refresh token and has no automatic session refresh. If a session expires, iKuck asks the user to reconnect with Bring! credentials; it does not silently fall back to the local shopping list for Bring! writes.

The client exposes name-based item operations rather than UUID-targeted writes. Duplicate raw item names therefore cannot be safely distinguished and are read-only in iKuck. The UI does not claim support for independently mutating such duplicates.

## Key rotation and recovery

Encrypted sessions can only be opened with the key that encrypted them. Plan key rotation together with reconnection: replacing or losing the key without first re-encrypting every stored session makes those connections unusable, and affected users must reconnect. Keep any protected recovery copy of the key separate from database backups and limit access to the API operator.
