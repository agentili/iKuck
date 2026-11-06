# Chef chat quota integration contract

This module is not wired to a route or enabled by a migration. The authoritative
ledger and gate are PostgreSQL; Redis is a mandatory, complementary conservative
mirror, never a reason to reopen a PostgreSQL gate. The two sorted-set keys are
`ikuck:chef-chat:{userId}:day` and `ikuck:chef-chat:{userId}:minute`; the daily
set is filtered at each UTC day boundary rather than encoding the date in the
key. The Lua script uses Redis server time, checks and mutates both keys as one
isolated operation, and expires the day key at the next UTC midnight plus 60s
and the minute key after 60s. A Redis reset can undercount its mirror but cannot
remove PostgreSQL records. Redis errors can cause conservative overcounting.

## Integration obligations

- The singleton `chef_chat_control` is not initialized by the migration. An
  absent or disabled row prevents admission and dispatch. Activation must be a
  deliberate operational decision, never an application startup default.
- Create a node-redis client with `disableOfflineQueue: true`, error handling,
  bounded connection/reconnection and readiness checks. Compose its validated
  `ping()` and `createChefChatRedisMirror(client)` into `createChefChatQuota`.
  Do not call the lower-level store `reserve` or `dispatch` as an authorization
  bypass. The wrapper bounds one outstanding operation per instance until the
  underlying work actually settles; dependency timeouts return unavailable.
- `reserve(userId)` yields an operation ID and secret ownership token. Never log
  the token or user ID. Cancel with `quota.cancel(userId, id, token)` only when
  the provider definitely was not started. A missing/uncertain commit result is
  not permission to send. Cancellation may leave conservative Redis entries on
  failure. No retry or provider fallback is authorized by this module.
- Under the existing per-user consent/revocation ordering, recheck the specific
  grant, selected provider and policy immediately before sending. Then call
  `quota.dispatch(id, token)` and send only if it returns true after the
  committed transition. A false/timeout result must never trigger dispatch.
  Reusing a dispatch token does not authorize a second provider call.
- The caller owns transport integration: handle `startChat().response` promptly,
  and keep both gates occupied until `settled` and a positively completed
  response establish locally observable success. Only then call
  `store.settle(id, token)`. On timeout, abort, fetch/body error, cancellation
  uncertainty, crash, or unknown outcome, never refund; retain the dispatched
  row or call `store.quarantine(id, token)`. `settled`/abort alone does not prove
  that the remote provider has stopped work. This module does not enforce those
  caller-side facts or impose the provider's 30-second timeout.
- `store.cleanup()` removes only settled/cancelled records outside both the UTC
  daily and 60-second windows, under the same global lock. It is not scheduled
  here. Reserved, dispatched and quarantined records have no automatic expiry;
  lack of proof may therefore cause indefinite unavailability. No automatic
  recovery or operator reconciliation interface is implemented in this tranche.
  Operation rows contain only random IDs, user UUID, ownership token, state and
  time, not conversation contents; the UUID remains personal metadata. Account
  deletion and retention handling for outstanding gates require review.

## Operational limitations / release gate

Limits are enforced across processes against the current PostgreSQL primary and
Redis. This does **not** establish RPO=0 or detect an unobserved PostgreSQL
restore, PITR, rollback or promotion with lost writes: such an event can lose
accounting or gates. A known restore or potentially lossy promotion requires
explicit global disablement before serving traffic and a reviewed reconciliation
and reactivation process. That process is not implemented here; releasing this
feature requires an operational decision and evidence. There is likewise no
proof of a strict remote-provider concurrency bound without provider-side
attestation. Do not claim either guarantee based on Redis TTL, abort or local
promise settlement. Isolated disposable test services are not evidence of the
production configuration or of provider behavior.
