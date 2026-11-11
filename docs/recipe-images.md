# Recipe images

Images are asynchronous and optional. Recipes remain usable while images are pending or providers are unavailable. PostgreSQL stores normalized WebP binaries separately from sync documents. Existing local catalog artwork is retained.

## Configuration

Set `RECIPE_IMAGES_ENABLED=true`, `PEXELS_API_KEY`, `RECIPE_IMAGE_MODEL`, and `RECIPE_IMAGE_VISION_MODEL`. Set the appropriate `OPENAI_API_KEY` or `GEMINI_API_KEY`. `RECIPE_IMAGE_PROVIDER` overrides `RECIPE_PROVIDER`; otherwise image generation follows the text provider. Models must support image generation and multimodal evaluation respectively. No provider fallback occurs. `RECIPE_IMAGE_DAILY_LIMIT` defaults to 5 and applies to each user and separately to the catalog principal. Keys remain server-side.

Build the frontend with `VITE_RECIPE_IMAGES_ENABLED=true`. Production and standalone Compose propagate the server flag to this build argument. Start the `images` Compose profile to run `image-worker`, or run `npm --prefix backend run images:worker` after building. Apply database migrations before starting API or worker. The feature defaults to disabled; do not enable without all credentials and model IDs configured.

## Initial population

From the repository checkout, run `npm --prefix backend run images:backfill` for a count-only preview. Run again with `-- --apply --max=100` to enqueue at most 100 missing associations. The command is resumable and never overwrites existing assets. No external calls run during the CLI or migrations; the worker observes its daily cap. Existing private recipes wait for updated consent. Catalog processing is explicitly authorized by the operator running this command.

Users confirm the updated AI consent before any private image lookup or generation. Existing text consent continues to work. Disabling consent prevents new private dispatches; already stored images remain until recipe/account deletion. Private images are served only to authorized users and cached locally by scope, cleared on scope changes. Public catalog images have a bounded separate cache.

## Recovery and costs

The worker retries search/network failures at most three times, with increasing delay. Failed or quota-limited private jobs can be retried by their author through the UI. Paid dispatch is recorded and quota reserved before sending a generation request. Ambiguous failures and interrupted processing are quarantined, not automatically regenerated. Manual retry is a new paid attempt subject to quota. No arbitrary external URLs are accepted from users; candidate downloads are restricted to Pexels HTTPS and bounded before decoding.

PostgreSQL backups include image binaries, jobs and quotas. Monitor `recipe_image_jobs` state counts and timestamps, `recipe_image_quota` daily usage, database growth and worker `recipe_image_tick_failed` events. Logs do not include recipes, prompts or credentials. Disable the flag and stop the worker to roll back functionality; leave tables intact to preserve saved images.

## Verification

CI runs the usual offline browser suite with the feature disabled and a dedicated `VITE_RECIPE_IMAGES_ENABLED=true npm run test:e2e -- e2e/recipe-images.spec.ts` pass for image delivery, attribution and offline caching. Provider tests use mocked HTTP, including both generation response formats; they do not incur API costs. Disposable PostgreSQL tests cover queue insertion, consent resume, concurrent workers, binary storage/deletion, quota and access isolation. Real-provider smoke tests require operator-supplied credentials and are not implied by a green mocked suite.

Catalog jobs that reach the daily generation cap resume automatically on the next database day; private jobs remain explicitly retryable. The backfill `--max` is an enqueue bound, while `RECIPE_IMAGE_DAILY_LIMIT` is the paid generation bound. Database sessions should use UTC, matching the default PostgreSQL container.
