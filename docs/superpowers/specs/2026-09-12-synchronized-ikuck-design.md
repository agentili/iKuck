# iKuck synchronized platform design

## Product direction

iKuck remains immediately usable offline by a guest. Guest data stays only on the device. A verified account can explicitly import local data and synchronize it with the remote service.

The remote stack runs on an EU VPS through Docker Compose: a TypeScript Fastify API, PostgreSQL, Redis and Caddy. The PWA is served as static assets by Caddy and calls the versioned `/v1` API on the same origin.

## Platform decisions

- Node.js 24, TypeScript, Fastify, Zod, Pino, Drizzle ORM and `postgres` form the API runtime.
- PostgreSQL stores durable account and product data. Redis stores only rate-limit counters, revocations, caches and distributed coordination; it is never the only copy of user data.
- Caddy terminates HTTPS, serves the PWA and proxies `/v1/*` to the API. Postgres and Redis are private Compose services.
- Runtime configuration is fail-fast and comes exclusively from environment variables. `.env.example` files document names and safe development defaults; secrets are not committed.
- Provider ports are defined in the platform layer. Resend, USDA and OpenAI adapters are implemented in their owning feature plans and are replaced by fakes in normal tests.
- `/healthz` reports `200` only after PostgreSQL and Redis are both reachable. It returns `503` with no infrastructure detail when either dependency is unavailable.

## Future feature constraints

- Account operations require verified email. Passwords use Argon2id; browser sessions use secure HttpOnly cookies and CSRF protection.
- The client migrates the existing `ikuck-pantry-v1` data to IndexedDB before it begins synchronization. Each remote mutation carries an item version and uses server-side last-write-wins resolution.
- Pantry data is represented as separate lots. Quantities are advisory for recipe matching; expiry is displayed in the PWA only. Cooking history never reduces stock automatically.
- One synchronized shopping list supports manual items and missing recipe ingredients.
- Recipe preferences and history are private. Ratings range from one to five with an optional private note.
- Diet profiles include omnivore, vegetarian, vegan and pescetarian. All 14 EU allergens are exclusion constraints, never ranking hints.
- USDA-derived nutrition values are estimates. Partial mappings are labelled incomplete.
- AI generation requires separate, revocable consent. Only pantry ingredients and dietary constraints are sent to OpenAI. Requests use structured JSON output, `store: false`, a pseudonymous safety identifier and a Redis-enforced daily quota of five. Generated recipes are private snapshots.
- Suggestions refresh after pantry or profile changes. Ranking prefers favorites and well-rated categories while avoiding recent repeats.

## Execution order

1. Remote platform.
2. Verified accounts and synchronization.
3. Pantry lots, quantities and expiry.
4. Shopping list.
5. History, favorites and ratings.
6. Diet, allergens and nutrition.
7. AI recipes.
8. Automatic personalized suggestions.

Each stage has a committed plan, test-first implementation, unit/integration/browser verification and a dedicated implementation commit before the next stage begins.
