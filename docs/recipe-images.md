# Recipe images

Images are asynchronous and optional. Recipes remain usable while images are pending or providers are unavailable. PostgreSQL stores normalized WebP binaries separately from sync documents. Existing local catalog artwork is retained.

## Configuration

Set `RECIPE_IMAGES_ENABLED=true`, `PEXELS_API_KEY`, `RECIPE_IMAGE_MODEL`, and `RECIPE_IMAGE_VISION_MODEL`. Set the appropriate `OPENAI_API_KEY` or `GEMINI_API_KEY`. `RECIPE_IMAGE_PROVIDER` overrides `RECIPE_PROVIDER`; otherwise image generation follows the text provider. Models must support image generation and multimodal evaluation respectively. No provider fallback occurs. `RECIPE_IMAGE_DAILY_LIMIT` defaults to 5 and applies to each user and separately to the catalog principal. Keys remain server-side.

The frontend reads image availability from the API at runtime; `VITE_RECIPE_IMAGES_ENABLED` is no longer used. Production and standalone Compose start `image-worker` with the normal stack, without an extra profile. When disabled, the worker stays idle and makes no database or provider calls. Apply database migrations before starting API or worker. The server feature defaults to disabled; set `RECIPE_IMAGES_ENABLED=true` only after configuring all credentials and compatible model IDs. The deployment env examples include the full image configuration block.

## Activating an existing deployment

Updating the code does not change the server’s env file. Use the actual Compose project and env file for the deployed instance. In that file, set `RECIPE_IMAGES_ENABLED=true`, `PEXELS_API_KEY`, `RECIPE_IMAGE_MODEL`, `RECIPE_IMAGE_VISION_MODEL`, and the key for the selected provider (`OPENAI_API_KEY` or `GEMINI_API_KEY`). Model IDs must be chosen from the models available to that provider account; text-only model IDs cannot generate images. Do not paste API keys into Git, terminal output or issue comments.

After a database backup, recreate the API and image worker using that same env file and Compose project. For example, from the checkout with production Compose:

```sh
docker compose --env-file deploy/.env -f deploy/docker-compose.production.yml up -d --build
# For standalone, use deploy/.env.standalone and deploy/docker-compose.standalone.yml instead.
docker compose --env-file deploy/.env -f deploy/docker-compose.production.yml ps api image-worker
```

The updated Compose files include the worker by default. On older releases with the `images` profile, add `--profile images` before `up`. A false or absent server flag means processing remains disabled; changing only a frontend flag cannot enable it. Check API and worker logs without printing their environment. A worker that exits with a configuration error needs its missing credentials or model IDs corrected before retrying.

## Initial population

From the repository checkout, run `npm --prefix backend run images:backfill` for a count-only preview. Run again with `-- --apply --max=100` to enqueue at most 100 missing associations. The command is resumable and never overwrites existing assets. No external calls run during the CLI or migrations; the worker observes its daily cap. Existing private recipes wait for updated consent. Catalog processing can also be requested by a verified user through the generation buttons. The server uses the authoritative catalog from `shared/src/recipeCatalog.ts`; clients cannot submit arbitrary catalog prompts.

Users confirm the updated AI consent before any private image lookup or generation. Existing text consent continues to work. Disabling consent prevents new private dispatches; already stored images remain until recipe/account deletion. Private images are served only to authorized users and cached locally by scope, cleared on scope changes. Public catalog images have a bounded separate cache.

## User controls

Only the signed-in user’s Profile page offers **Genera tutte le immagini**. The Recipes collection page has no bulk image button. A single request queues missing catalog images and the current user's saved/generated recipes still accessible in their personal scope or a house they belong to. It does not import guest data or generate images for another author's private recipes. Ready images and pending/processing jobs are preserved. A repeated explicit request can retry failed jobs; it never resets a running or quota-limited job.

Recipe detail pages and modals offer **Genera immagine** when the image is missing. Public catalog images require a verified session and CSRF but no private-data consent. Personal images require provider-specific image consent; the UI displays the recipients and asks for explicit confirmation when it is missing. Save a proposed recipe before requesting its image. The UI polls queued image metadata and reports disabled service, quota, consent, or request failures.

`POST /v1/recipe-images/generate` queues a collection; `POST /v1/recipe-images/:recipeId/generate?kind=catalog|private` queues one recipe. The existing `/retry` path remains an alias for private retry. Both enforce same-origin, CSRF and verified-session checks. A missing association is returned as `state: missing` rather than indefinitely appearing pending.

## Recovery and costs

The worker retries search/network failures at most three times, with increasing delay. Failed private jobs can be retried by their author through the generation button. Quota-limited jobs resume on the next database day, subject to a fresh consent check. Paid dispatch is recorded and quota reserved before sending a generation request. Ambiguous failures and interrupted processing are quarantined, not automatically regenerated. Manual retry is a new paid attempt subject to quota. No arbitrary external URLs are accepted from users; candidate downloads are restricted to Pexels HTTPS and bounded before decoding.

PostgreSQL backups include image binaries, jobs and quotas. Monitor `recipe_image_jobs` state counts and timestamps, `recipe_image_quota` daily usage, database growth and worker `recipe_image_tick_failed` events. Logs do not include recipes, prompts or credentials. Disable the flag and stop the worker to roll back functionality; leave tables intact to preserve saved images.

## Verification

CI runs the offline browser suite with disabled image API fixtures by default. `npm run test:e2e -- e2e/recipe-images.spec.ts` uses enabled runtime API fixtures to verify image delivery, profile-only bulk generation, single-recipe generation, attribution and offline caching. These tests need no frontend build flag. Provider tests use mocked HTTP, including both generation response formats; they do not incur API costs. Disposable PostgreSQL tests cover queue insertion, consent resume, concurrent workers, binary storage/deletion, quota and access isolation. Real-provider smoke tests require operator-supplied credentials and are not implied by a green mocked suite.

Catalog and private jobs that reach the daily generation cap resume automatically on the next database day; failed dispatches still require an explicit retry. The backfill `--max` is an enqueue bound, while `RECIPE_IMAGE_DAILY_LIMIT` is the paid generation bound. Database sessions should use UTC, matching the default PostgreSQL container.
