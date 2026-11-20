# Recipe images

Images are asynchronous and optional. Recipes remain usable while images are pending or providers are unavailable. PostgreSQL stores normalized WebP binaries separately from sync documents. Existing local catalog artwork is retained.

## Configuration

Set `RECIPE_IMAGES_ENABLED=true`, `RECIPE_IMAGE_MODEL`, and `RECIPE_IMAGE_VISION_MODEL`. Wikimedia Commons search does not require an API key. Set the appropriate `OPENAI_API_KEY` or `GEMINI_API_KEY`. Set the same `RECIPE_IMAGE_PROVIDER` on the API and worker; if unset, each process falls back to its own `RECIPE_PROVIDER`. Models must support image generation and multimodal evaluation respectively. No AI-provider fallback occurs. `RECIPE_IMAGE_DAILY_LIMIT` defaults to 5 and applies to each user and separately to the catalog principal. Keys remain server-side.

The frontend reads image availability from the API at runtime; `VITE_RECIPE_IMAGES_ENABLED` is no longer used. Production and standalone Compose start `image-worker` with the normal stack, without an extra profile. When disabled, the worker stays idle and makes no database or provider calls. The API migrates before serving; the v2 worker refuses to claim without the migration's transaction-local helper. The server feature defaults to disabled. The deployment env examples include the full image configuration block.

## Activating an existing deployment

Use the actual Compose project, Docker host/context, env file and database for the deployed instance. Take a verified PostgreSQL backup before an upgrade. The cutover must start the new stack with `RECIPE_IMAGES_ENABLED=false`, even if the server’s env file says `true`. Do not use a plain `compose up` for this transition.

**Before any process applies `0020_wikimedia_image_consent`, stop and quiesce every old image worker connected to that database**, including replicas, manually started workers and old Compose projects/profiles on any host. Pause concurrent deploys and worker restarts and keep them paused through cutover. The database fence blocks old workers from claiming new rows, but cannot stop one that already claimed a job or dispatched a request. Allow the in-flight tick to finish after SIGTERM. Abort if any worker did not stop cleanly or its state cannot be verified; investigate forced termination and possible provider charges. Keep stopped containers for inspection (do not run `down` first).

For the approved Deploy workflow, enter the verified `compose_project`, select `cutover_target=upgrade`, and positively confirm `all_db_workers_quiesced` only after completing the checks above. Compose can only check the selected project on the selected Docker engine; it cannot discover other clients of the database. The operator attestation covers that gap. The gate checks the inventory before and after stop and verifies every selected-project worker stopped cleanly. Empty or unverifiable inventory blocks an upgrade. If containers were removed or project/DB ownership is unclear, stop and resolve the inventory; never select `fresh` to work around an upgrade refusal. Select `fresh` only when the target database is independently verified fresh and no existing image workers are attached, and still attest quiescence. The fresh route requires an empty, readable inventory.

For an approved manual cutover (including standalone), use the same gate from the verified v2-compatible checkout on the target Docker host. Example for an existing production project:

```sh
sh deploy/image-cutover.sh all-db-workers-quiesced upgrade "$VERIFIED_PROJECT" deploy/.env deploy/docker-compose.production.yml
docker compose -p "$VERIFIED_PROJECT" --env-file deploy/.env -f deploy/docker-compose.production.yml ps api image-worker
```

For standalone substitute `deploy/.env.standalone` and `deploy/docker-compose.standalone.yml` (see the [standalone guide](standalone-mini-pc.md)). The gate overrides only the Compose launch command; it does not edit the env file. Keep the effective flag false on any later recreation until you have verified migrations, matching v2 API/worker builds, disabled image metadata and an idle worker. Check logs without printing the environment. Never configure `ikuck.recipe_image_policy` as a role, session or database default. Migration quarantines leftover processing jobs without resetting dispatch timestamps or quotas and removes pre-fix Commons assets; do not bulk-replay quarantined jobs.

Enable separately after verification and approval, not by rerunning the disabled-first workflow. Confirm the provider, compatible vision/generation models and server-side key, then apply `RECIPE_IMAGES_ENABLED=true` through the actual environment configuration and recreate the verified v2 `api` and `image-worker` in the same Compose project. Do not paste keys into Git, terminal output or issue comments. Subsequent recreations use the effective Compose flag again; the one-time cutover override does not persist in the env file.

## Initial population

From the repository checkout, run `npm --prefix backend run images:backfill` for a count-only preview. Run again with `-- --apply --max=100` to enqueue at most 100 missing associations. The command is resumable and never overwrites existing assets. No external calls run during the CLI or migrations; the worker observes its daily cap. Existing private recipes wait for updated consent. Catalog processing can also be requested by a verified user through the generation buttons. The server uses the authoritative catalog from `shared/src/recipeCatalog.ts`; clients cannot submit arbitrary catalog prompts.

Users must confirm `recipe-images-v2` before any private image lookup or generation; the prior Pexels consent does not authorize Wikimedia. Existing text consent and stored Pexels/AI images are preserved. Disabling consent prevents new private dispatches; already stored compliant images remain until recipe/account deletion. Private images are served only to authorized users with `private, no-store`; app-managed offline images are cached locally by scope and cleared on scope changes. Public catalog images use a bounded separate cache. The new client reads only the new cache namespaces.

## User controls

Only the signed-in user’s Profile page offers **Genera tutte le immagini**. The Recipes collection page has no bulk image button. A single request queues missing catalog images and the current user's saved/generated recipes still accessible in their personal scope or a house they belong to. It does not import guest data or generate images for another author's private recipes. Ready images and pending/processing jobs are preserved. A repeated explicit request can retry failed jobs; it never resets a running or quota-limited job.

Recipe detail pages and modals offer **Genera immagine** when the image is missing. Public catalog images require a verified session and CSRF but no private-data consent. Personal images require provider-specific image consent; the UI displays the recipients and asks for explicit confirmation when it is missing. Save a proposed recipe before requesting its image. The UI polls queued image metadata and reports disabled service, quota, consent, or request failures.

`POST /v1/recipe-images/generate` queues a collection; `POST /v1/recipe-images/:recipeId/generate?kind=catalog|private` queues one recipe. The existing `/retry` path remains an alias for private retry. Both enforce same-origin, CSRF and verified-session checks. A missing association is returned as `state: missing` rather than indefinitely appearing pending.

Both metadata and binary GETs require exactly one `metadataVersion=2` to expose Commons; invalid or duplicate versions return 400. Without the version, Commons metadata is missing and the binary is not found. V2 metadata echoes the version and includes it in the asset URL. Legacy Pexels/AI remain available without the version; the new client also accepts their legacy contract from an old API.

## Recovery and costs

Only the recipe title is sent to Commons. A valid search examines one complete batch of at most five ranked file records, even if more search results exist. Commons returns only `{"batchcomplete":true}` for a zero-result query. Malformed or partial batches (including a malformed later record) back off without downloading, invoking vision or authorizing paid fallback. Valid zero results, policy-ineligible or unusable candidates and exact vision `NO` can lead to paid AI generation subject to quota. Provider errors (including maxlag and failed vision) back off instead, with at most three attempts before explicit retry.

The worker requires machine-readable `License=cc0`, a matching CC0 1.0 URI (base or the observed `deed.en`), exact plaintext author credit, and no contradictory terms. BY and BY-SA are deferred. It binds the File title and canonical Commons file page to the original upload basename, and the thumbnail to the same basename and Wikimedia storage path. Accepted paths are direct JPEG/PNG Commons renditions on `thumb.wikimedia.org` or `upload.wikimedia.org` and an unscaled original on `upload.wikimedia.org`. Paths may have the known `imageinfo` tracking query or none; unsafe escapes, specialty renditions and other URL formats are skipped. The UI links the file and named license and discloses orientation normalization, resizing, first-frame extraction (if animated), and WebP conversion. Thumbnails are HTTPS only and redirects are not followed.

Quota-limited jobs resume on the next database day, subject to fresh consent. The worker records paid dispatch and reserves quota in one commit before sending the request. Ambiguous failures and interrupted processing are quarantined, not automatically replayed. Response streams are capped at 512 KiB (Commons JSON), 64 KiB (vision JSON), 16 MiB (generation JSON) and 10 MiB (thumbnail/decoded input).

PostgreSQL backups include image binaries, jobs and quotas. Monitor `recipe_image_jobs` state counts and timestamps, `recipe_image_quota` daily usage, database growth and worker `recipe_image_tick_failed` events. Logs do not include recipes, prompts or credentials. Roll back the feature by stopping and quiescing the worker, setting `RECIPE_IMAGES_ENABLED=false` in the actual deployment env, and recreating the **v2-aware API** with that flag. Confirm disabled metadata, unavailable asset GETs, and no running enabled worker. Do not downgrade the schema, API or worker, or reset dispatch markers or quotas. Already-downloaded compliant images may remain in offline client caches until those clients reconnect or clear local data.

## Verification

CI runs the offline browser suite with disabled image API fixtures by default. `npm run test:e2e -- e2e/recipe-images.spec.ts` uses enabled runtime API fixtures to verify version negotiation, legacy compatibility, image delivery, attribution and offline caching. These tests need no frontend build flag. Provider tests use mocked HTTP; they do not incur API costs. Disposable PostgreSQL tests cover consent, concurrent workers, reservations, stored assets, quota and access isolation. CI creates a separate database for the 0019 → 0020 upgrade case. To run it locally, set `INTEGRATION_RECIPE_IMAGE_UPGRADE_DATABASE_URL` to a separate, empty, disposable database; the upgrade case is skipped otherwise. `sh deploy/image-cutover.test.sh` tests the rollout decisions with fake Docker, not real Compose or cross-host discovery. Real-provider smoke tests require operator-supplied credentials and are not implied by a green mocked suite.

Catalog and private jobs that reach the daily generation cap resume automatically on the next database day; failed dispatches still require an explicit retry. The backfill `--max` is an enqueue bound, while `RECIPE_IMAGE_DAILY_LIMIT` is the paid generation bound. Database sessions should use UTC, matching the default PostgreSQL container.
