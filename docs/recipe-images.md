# Recipe images

Images are asynchronous and optional. Recipes remain usable while images are pending or providers are unavailable. PostgreSQL stores normalized WebP binaries separately from sync documents. Existing local catalog artwork is retained.

## Configuration

Set `RECIPE_IMAGES_ENABLED=true`, `RECIPE_IMAGE_MODEL`, and `OPENAI_API_KEY`. Images use OpenAI's Images API (`/v1/images/generations`) with one `1024x1024`, `medium` request per explicit recipe action. The model is configurable; no vision model or multimodal provider is used. Image configuration is independent of `RECIPE_PROVIDER`, which continues to control text-recipe generation. The feature defaults to disabled; credentials are required only when enabling images. `RECIPE_IMAGE_DAILY_LIMIT` defaults to 5 and applies separately to each user and the catalog principal. Keys remain server-side.

The frontend reads image availability from the API at runtime; `VITE_RECIPE_IMAGES_ENABLED` is no longer used. Production and standalone Compose start `image-worker` with the normal stack, without an extra profile. When disabled, the worker stays idle and makes no database or provider calls. The API migrates before serving. Migration `0021_openai_recipe_images` fences both job claims and paid-dispatch reservations behind transaction-local v3 markers; it also removes automatic sync enqueueing and quarantines pre-cutover work. The server feature defaults to disabled.

## Activating an existing deployment

Use the actual Compose project, Docker host/context, env file and database for the deployed instance. Take a verified PostgreSQL backup before an upgrade. The cutover must start the new stack with `RECIPE_IMAGES_ENABLED=false`, even if the server’s env file says `true`. Do not use a plain `compose up` for this transition.

**Before any process applies `0021_openai_recipe_images`, stop and quiesce every old image API and worker connected to that database**, including replicas, manually started processes and old Compose projects/profiles on any host. Pause concurrent deploys and restarts and keep them paused through cutover. The selected-project gate inventories and stops both `api` and `image-worker`, then verifies clean exits. The v3 database fences reject old API enqueueing and old worker dispatch even if an old process is accidentally restarted, but quiescence is still required to avoid stale API caches and in-flight operations. Abort if any client did not stop cleanly or its state cannot be verified; investigate forced termination and possible provider charges. Keep stopped containers for inspection (do not run `down` first).

For the approved Deploy workflow, enter the verified `compose_project`, select `cutover_target=upgrade`, and positively confirm `all_db_image_clients_quiesced` only after completing the checks above. Compose can only check the selected project on the selected Docker engine; it cannot discover other clients of the database. The operator attestation covers that gap. The gate checks API/worker inventory before and after stop and verifies every selected-project client stopped cleanly. Empty or unverifiable inventory blocks an upgrade. If containers were removed or project/DB ownership is unclear, stop and resolve the inventory; never select `fresh` to work around an upgrade refusal. Select `fresh` only when the target database is independently verified fresh and no existing image APIs or workers are attached, and still attest quiescence. The fresh route requires an empty, readable inventory.

For an approved manual cutover (including standalone), use the same gate from the verified v3-compatible checkout on the target Docker host. Example for an existing production project:

```sh
sh deploy/image-cutover.sh all-db-image-clients-quiesced upgrade "$VERIFIED_PROJECT" deploy/.env deploy/docker-compose.production.yml
docker compose -p "$VERIFIED_PROJECT" --env-file deploy/.env -f deploy/docker-compose.production.yml ps api image-worker
```

For standalone substitute `deploy/.env.standalone` and `deploy/docker-compose.standalone.yml` (see the [standalone guide](standalone-mini-pc.md)). The gate overrides only the Compose launch command; it does not edit the env file. Keep the effective flag false on any later recreation until you have verified migrations, matching v3 API/worker builds, disabled image metadata and an idle worker. Check logs without printing the environment. Never configure `ikuck.recipe_image_policy` as a role, session or database default. Migration quarantines pending/processing/quota-wait/old-consent jobs without resetting dispatch timestamps or quotas; it preserves stored asset bytes, metadata, attribution and existing ready associations. Quarantined jobs require a fresh, explicit single-recipe request; do not bulk-replay them.

Enable separately after verification and approval, not by rerunning the disabled-first workflow. Configure a supported OpenAI image model and server-side `OPENAI_API_KEY`, then apply `RECIPE_IMAGES_ENABLED=true` through the actual environment and recreate the verified v3 `api` and `image-worker` in the same Compose project. No vision model or change to the text provider is required. Staging must use a dedicated OpenAI project and staging-only API key; never copy or reuse the production key. Keep the key in the staging secret store and configure its usage alerts before enabling. Do not paste keys into Git, terminal output or issue comments. Subsequent recreations use the effective Compose flag again; the one-time cutover override does not persist in the env file.

## Initial population

There is no automatic, bulk, sync-triggered or CLI enqueue path. Catalog processing can be requested only for one authoritative catalog recipe per verified request; private recipes require the current OpenAI-only v3 consent and a fresh single-recipe action. The server uses the authoritative catalog from `shared/src/recipeCatalog.ts`; clients cannot submit arbitrary catalog prompts.

Users must grant `recipe-images-v3` specifically for OpenAI images before a private image request. Old v1/v2 grants and text-recipe consent do not authorize image generation. Only a recipe title and ingredient names are sent to OpenAI; quantities, steps, descriptions, profile and pantry data are excluded. Existing text consent and all stored image bytes/credits are preserved. Revoking image consent prevents subsequent private dispatches; already stored images remain until recipe/account deletion. Private images are served only to authorized users with `private, no-store`; app-managed offline images are cached locally by scope and cleared on scope changes. Public catalog images use a bounded separate cache.

## User controls

The API accepts only one recipe per generation request. There is no collection/bulk route. A request queues a missing authoritative catalog image or the current user's saved/generated recipe in the authorized scope; it cannot import guest data or generate images for another author's private recipe. Ready images and pending/processing jobs are preserved. An explicit per-recipe request can retry quarantined failed work; it never resets a running, already dispatched, ready or quota-limited job.

Recipe detail pages and modals offer **Genera immagine** when the image is missing; Profile and collection pages do not offer a bulk action. Public catalog images require a verified session and CSRF but no private-data consent. Private images require a separate, explicit OpenAI-only v3 grant from Profile. A v1/v2 grant, text-recipe consent or synced consent record must never pre-authorize them. The private-generation disclosure names OpenAI and says that only the recipe title and ingredient names are sent; the Profile grant is unchecked until the user explicitly saves it. If the runtime image provider is missing or is not OpenAI, the UI shows the service as unavailable and offers no approval control. Save a proposed recipe before requesting its image. The UI polls queued image metadata and reports disabled service, quota, consent, or request failures. Revoking global AI consent also revokes image authorization and is clearly labelled as global.

`POST /v1/recipe-images/:recipeId/generate?kind=catalog|private` requests exactly one recipe; `POST /v1/recipe-images/:recipeId/retry?kind=private` is a per-recipe explicit retry. Both enforce same-origin, CSRF and verified-session checks. The old collection endpoint is unavailable. A missing association is returned as `state: missing` rather than indefinitely appearing pending. Private metadata and binary reads additionally enforce owner/scope authorization.

Both metadata and binary GETs retain the existing `metadataVersion=2` attribution contract for stored Wikimedia assets; invalid or duplicate versions return 400. Without the version, Wikimedia metadata is missing and the binary is not found. V2 metadata echoes the version and includes it in the asset URL. Legacy Pexels/AI assets and their stored attribution remain available without the version.

## Recovery and costs

Each generation job makes at most one OpenAI Images API request. The prompt contains only the recipe title and ingredient names. Provider errors or ambiguous outcomes are quarantined with the paid-dispatch marker and quota preserved; no automatic paid retry occurs. The single request normalizes the returned image to bounded WebP, and errors are handled without silently switching providers.

Quota-limited jobs resume on the next database day, subject to fresh consent and no prior dispatch marker. The worker records paid dispatch and reserves quota in one commit before sending the request. Ambiguous failures and interrupted processing are quarantined, not automatically replayed. Generation response streams and decoded/normalized images are bounded.

PostgreSQL backups include image binaries, jobs and quotas. Monitor `recipe_image_jobs` state counts and timestamps, `recipe_image_quota` daily usage, database growth and worker `recipe_image_tick_failed` events. Logs do not include recipes, prompts or credentials. Roll back the feature by stopping and quiescing all image APIs and workers, setting `RECIPE_IMAGES_ENABLED=false` in the actual deployment env, and recreating the **v3-aware API/worker** with that flag. Confirm disabled metadata, unavailable asset GETs, and no running enabled worker. Do not downgrade the schema, API or worker, or reset dispatch markers or quotas. Already-downloaded compliant images may remain in offline client caches until those clients reconnect or clear local data.

## Verification

CI runs the offline browser suite with disabled image API fixtures by default. Provider tests use stub HTTP only and do not incur API costs. Disposable PostgreSQL/Redis tests cover the v3 consent, single request, concurrent worker claims, one quota reservation, ambiguous outcomes, preserved stored assets and the 0020 → 0021 upgrade fixture. `sh deploy/image-cutover.test.sh` tests the rollout decisions with fake Docker, not real Compose or cross-host discovery. Real-provider smoke tests are not part of this gate.

Jobs blocked by the daily generation cap can resume on the next database day only while they remain undispatched and consent remains current. Failed/ambiguous dispatches require a fresh explicit per-recipe action. `RECIPE_IMAGE_DAILY_LIMIT` is the paid generation bound. Database sessions should use UTC, matching the default PostgreSQL container.
