# idempotency-keys-from-scratch

Idempotency keys for a payment API, built from a broken baseline up to a
tested, working implementation — for the blog series **"From Theory to
Tested Code."** The thesis: almost every idempotency-key tutorial shows
`SET NX` and calls it done. Almost none show the check-then-set race, the
poisoned-key problem when a request crashes mid-flight, or the fact that
a Redis-based idempotency key is not atomic with your database write —
which is the entire point of the mechanism. This repo shows all three,
with a real test proving each one, before showing the fix.

Runs on [Bun](https://bun.sh) with zero runtime dependencies — the test
runner, Redis client, Postgres client, TypeScript execution, and demo
HTTP server are all Bun built-ins. Built and verified against Bun 1.3.14
(as of 2026-08).

This README is the progression itself: the baseline failure, why each
fix is necessary given the specific failure of the stage before it, and
what each fix costs. See `CLAUDE.md` for the architecture snapshot.

## Phase 0 — the baseline failure

`src/strategies/no-idempotency.ts` implements `IdempotencyStrategy` with
no protection at all: every call to `handle()` charges the payment
gateway, regardless of what idempotency key the caller sends. This isn't
a race that only shows up under load — it's deterministic. Fifty
concurrent requests with the same key produce fifty charges, every run:

```
bun test tests/phase0-baseline.test.ts
```

`src/gateway/payment-gateway.ts` is the one mock in this repo: a payment
processor that actually records every charge it's asked to make, with a
`ledger` every later test reads directly to answer "did we double-charge
the customer?" — never inferred from a strategy's return value.

## Phase 1 — naive check-then-set still races

`src/strategies/naive-check-then-set.ts` adds the fix everyone writes
first: `GET` the key, and if it's absent, charge and `SET` the result
back. It still double-charges under concurrency — every caller's `GET`
can observe "absent" before any writer's `SET` lands, because there's no
atomicity between the read and the write. `raceWindowMs` widens that gap
deliberately (an artificial delay between the `GET` and the charge) so
the race reproduces on every run instead of depending on real Redis
round-trip variance:

```
bun test tests/phase1-naive-check-then-set.test.ts
```

Fifty concurrent requests with the same key still produce fifty charges
— the check doesn't help under contention, only against a *sequential*
retry after the first request has already finished.

## Phase 2 — atomic claim fixes the race, opens two new ones

`src/strategies/set-nx-claim.ts` claims the key atomically with
`SET key "" NX` *before* charging, closing Phase 1's race — fifty
concurrent requests now produce exactly one charge. But this phase
deliberately stores nothing else, which opens two new, real failure
modes:

- **In-flight duplicate**: a second request against a key that's
  claimed but not yet resolved has no way to tell "still charging" from
  "crashed and never will" — it gets back a bare `200` with no charge
  details to reconcile against. Demonstrated deterministically with an
  `onClaimed` hook that fires the second request from inside the first
  request's claim-to-charge window, no timing guesswork required.
- **Poisoned key**: an injected in-process throw right after the claim
  (standing in for a crash — not an OS-level kill) leaves the key
  claimed forever, with no TTL to recover it. Every legitimate retry
  after that — same key, same customer, genuinely trying again — gets
  the same ambiguous `200` and never actually charges. The customer can
  never complete the payment.

```
bun test tests/phase2-set-nx-claim.test.ts
```

Both flaws come from the same root cause: claiming and completing are
two separate writes with nothing connecting them. Phase 3 fixes this
with a leased, three-state lifecycle instead of a single claim marker.

## Phase 3 — the fix: a leased, three-state lifecycle

`src/strategies/lifecycle.ts` replaces the single claim marker with a
proper state machine — `NEW -> PENDING -> COMPLETED | FAILED` — backed
by two Lua scripts run atomically via `EVALSHA`
(`src/redis/lua/claim.lua`, `src/redis/lua/complete.lua`,
`src/redis/script-loader.ts`'s `LuaScript`, ported unchanged from
`RateLimiter/src/limiters/redis/script-loader.ts`):

- **`PENDING` carries a lease** (`leaseMs`, default 30s). A claim past
  its lease is treated as abandoned and reclaimed automatically —
  Phase 2's poisoned key self-heals instead of blocking every future
  retry forever.
- **A concurrent claim against a live `PENDING`** gets `409 Conflict`
  with `Retry-After` set from the remaining lease — no more ambiguous
  `200`.
- **A claim against `COMPLETED`** replays the stored response verbatim,
  including the original HTTP status code — a real retry looks
  identical to the original response.
- **Request fingerprinting** (`src/fingerprint.ts`, a stable hash of
  `amount`/`currency`/`customerId`) rejects a key reused with a
  different body as `422`, independent of what state the key is in —
  this is what stops a client bug from silently replaying the wrong
  charge.
- **A fencing token** per claim attempt (checked by `complete.lua`)
  closes an ABA hazard the lease alone doesn't: request A claims,
  crashes, its lease expires, request B reclaims and completes — if A's
  original attempt somehow resumes and tries to write its own (stale)
  result afterward, the token no longer matches and the write is a
  silent no-op instead of clobbering B's fresh `COMPLETED` state.
- **`FAILED` is retryable, not terminal** — a fresh claim with the same
  key and matching fingerprint can reclaim and try again. This matches
  how Stripe actually behaves (a declined charge doesn't permanently
  burn the idempotency key) and avoids trading the poisoned-key problem
  for a new one: a terminal `FAILED` would mean a single transient
  gateway decline locks a customer out of ever completing that payment.

```
bun test tests/phase3-lifecycle.test.ts
```

## Phase 4 — the Postgres alternative, and the honest finding

`src/strategies/postgres-transactional.ts` swaps Redis for a unique
constraint on the idempotency key (`src/db/schema.sql`), completing the
charge record and the key's completion in one transaction via
`sql.begin`. Structured to mirror the Redis lifecycle as closely as SQL
allows — a `claim_token` fencing column standing in for Redis's
`claimToken`, a staleness window standing in for the lease — so the two
are actually comparable under the same experiment, not measuring two
unrelated designs.

**The finding this phase exists to produce:** a failure injected between
"the gateway charge succeeds" and "the result is persisted" duplicate-
charges on retry for **both** strategies, at the same rate (10/10 trials
against each, in `tests/phase4-postgres.test.ts`). A single Postgres
transaction does not close this gap, because the gateway call can't live
inside it — you cannot roll back a real HTTP charge by throwing inside a
database transaction. The transaction makes the *database write* atomic
(the charge row and the key's completion commit together, or not at
all); it says nothing about the external call that happened before that
transaction started. Whatever guarantee a reader might expect
"single-transaction Postgres" to add over Redis here, this repo doesn't
find it — see **What this repo does not solve** below for what actually
closes this gap (it isn't either store).

```
bun test tests/phase4-postgres.test.ts
```

Along the way, building the comparable injection surfaced two real bugs
worth naming rather than quietly fixing:

- **A schema-setup race**: two concurrent `CREATE TABLE IF NOT EXISTS`
  calls can still collide on Postgres's internal `pg_type` catalog
  insert, even though the table creation itself is guarded. Fixed in
  `src/db/client.ts` by retrying once on that specific error.
- **A false-positive reclaim under load**: the first version of the
  Postgres claim took two round trips (an `INSERT ... ON CONFLICT` then
  a separate `SELECT` on conflict). Under 50 concurrent requests against
  a small connection pool, enough of those second round trips queued
  long enough that some requests' staleness check saw a claim that was
  only milliseconds old and, by wall-clock time alone, looked abandoned
  — reclaiming it and charging again. Fixed by cutting the claim to one
  round trip (a CTE that attempts the insert and falls back to reading
  the existing row in a single statement) and sizing the connection
  pool for this repo's own concurrency (`src/db/client.ts`). Left in as
  a real example of how a staleness/lease window can be gamed by load
  itself, not just by a genuine crash — worth knowing about in
  production, not just in a demo.

## Phase 5 — comparison harness + benchmarks

Two commands run every strategy through identical workloads:

```
bun run compare   # correctness + latency + round-trips + key growth, across all five
bun run bench     # sequential ops/sec per strategy (bench/RESULTS.md has a captured run)
```

**Duplicate-charge audit** (50 concurrent identical requests, one shared
key, per strategy) — the whole series in one table:

| strategy               | charges (of 50) |
| ----------------------- | ---------------- |
| none                     | 50                |
| naive-check-then-set     | 50                |
| set-nx-claim             | 1                 |
| lifecycle (Redis)        | 1                 |
| postgres-transactional   | 1                 |

**Latency overhead vs. baseline**, independent keys (no collisions,
steady-state cost), swept across concurrency levels:

| strategy               | concurrency | round-trips/req | p50 ms | p95 ms | p99 ms | overhead vs. `none` (p50) |
| ----------------------- | ----------- | ---------------- | ------ | ------ | ------ | -------------------------- |
| none                     | 50          | 0.0               | 0.03   | 0.04   | 0.05   | +0.00                       |
| naive-check-then-set     | 50          | 2.0               | 0.87   | 0.96   | 0.96   | +0.84                       |
| set-nx-claim             | 50          | 2.0               | 1.20   | 1.21   | 1.21   | +1.17                       |
| lifecycle (Redis)        | 50          | 2.0               | 1.65   | 1.78   | 1.78   | +1.62                       |
| postgres-transactional   | 50          | 2.0               | 14.44  | 18.58  | 18.95  | +14.41                      |

Postgres's gap widens with concurrency — its p50 goes from ~2.8ms at
concurrency 1 to ~14ms at concurrency 50 (transaction/WAL overhead per
round trip, not more round trips: it stays at 2 round trips/request
throughout). Redis-backed strategies stay under 2ms even at concurrency
50. Full sweep (concurrency 1/10/25/50) and the key-growth measurement
in `bun run compare`'s own output; a captured `bun run bench` snapshot
(sequential, single-connection ops/sec) is in
[`bench/RESULTS.md`](bench/RESULTS.md).

**Key growth**: with default settings, a completed/failed key retains
for `retentionSec` (24h, matching Stripe's default retention window); a
pending claim self-heals after `leaseMs` (Redis, 30s default) or
`staleAfterMs` (Postgres, 30s default) regardless of whether it ever
completes. Nothing here currently caps total key volume within that
window under sustained load — see **What this repo does not solve**.

## Comparing against Stripe's idempotency keys

The `lifecycle` (Redis) strategy is deliberately shaped to match how
Stripe's real idempotency keys behave, so the mapping onto a system most
readers already know is direct:

| behavior                          | Stripe                          | this repo (`lifecycle`)         |
| ---------------------------------- | -------------------------------- | --------------------------------- |
| Concurrent request, same key       | `409` while the original is in flight | `409` + `Retry-After` (`claim.lua`'s `PENDING` branch) |
| Retry after success                | Replays the original response, same status code | Replays verbatim (`COMPLETED` branch) |
| Same key, different request body   | Rejected (`400`-class error)     | `422` (`MISMATCH` branch, fingerprint check) |
| Retention window                   | 24 hours                         | `retentionSec`, default 24h        |
| Failed request retry               | Key is retryable                 | `FAILED` is retryable by default (documented policy, see Phase 3) |

The gap Stripe closes that this repo can't, by construction: Stripe
*is* the payment gateway, so its idempotency key check and the actual
charge happen inside the same system, not across a demo's mock boundary.
That's exactly why Phase 4 exists — to show what's still true even when
you don't get to make that assumption.

## What this repo does not solve

Honest gaps, not papered over — each a candidate for a future post:

- **The gateway call is outside the transaction, for both strategies.**
  Phase 4 is the demonstration: neither Redis nor Postgres can make an
  external HTTP call to a payment gateway atomic with a local write,
  because "atomic with a local write" means "can be rolled back by
  throwing," and you cannot un-charge a card that way. The only way to
  close this gap for a genuinely external side effect is to decouple the
  call from the request/response cycle entirely — write an intent
  transactionally first, then have a separate worker actually make the
  call, retrying against the gateway's *own* idempotency key until it
  either confirms success or exhausts retries. That's an outbox pattern,
  and it's a materially bigger system than either strategy here: a
  worker, a delivery guarantee for the worker itself, and reconciliation
  for the case where the worker's own crash-after-charge, before-marking-
  delivered gap needs handling too — turtles most of the way down. Out
  of scope for this repo; worth its own post.
- **Clock and lease-expiry edge cases.** The Redis lease and the
  Postgres staleness window both compare wall-clock timestamps. Phase 4
  found one concrete way this bites (queueing delay masquerading as
  abandonment) and fixed the specific cause, but the general problem —
  any lease scheme is only as trustworthy as the clock it's measured
  against — isn't eliminated, just narrowed. A GC pause, a slow
  container, or genuine clock skew between nodes sharing the same store
  can still cause a live claim to look stale.
- **Unbounded key growth.** COMPLETED/FAILED keys expire after
  `retentionSec` (24h default, matching Stripe), and PENDING claims
  expire after their lease/staleness window — but this repo doesn't
  measure or cap total key volume under sustained load. See "Key growth
  over the retention window" in the benchmarks below for what's
  actually measured, and its limits.

## Getting started

```
bun install
docker compose up -d      # starts Redis (6379) and Postgres (5432)
bun run typecheck
bun test                  # the whole phase progression
```

The Postgres schema (`src/db/schema.sql`) is created automatically on
first use by `ensureSchema()` — no separate migration step.

## Demo server

```
bun run demo
curl -X POST localhost:3000/payments \
  -H "Idempotency-Key: demo-key-1" \
  -H "Content-Type: application/json" \
  -d '{"amount": 1000, "currency": "usd", "customerId": "cus_1"}'
```

- `?strategy=` selects among the registered strategies (`none`, `naive`,
  `set-nx`, `lifecycle`, `postgres` — `lifecycle` is the default, since
  it's the fixed Redis version) or set `IDEMPOTENCY_STRATEGY`.
- `GET /strategies` lists what's available.

## Project layout

```
src/strategies/     one file per phase's strategy, each implementing IdempotencyStrategy
src/gateway/        the one mock — PaymentGateway and its ledger
src/redis/          Lua scripts + the EVALSHA-based script loader (Phase 3)
src/db/             Postgres schema + client (Phase 4)
src/fingerprint.ts   request-body hashing for the same-key-different-body check
src/instrumentation.ts   round-trip/status/latency instrumentation wrapper
demo/                the demo HTTP server (Bun.serve)
harness/fire.ts       fires N concurrent identical requests, reports the resulting charge count
harness/compare.ts    runs every strategy through identical workloads, prints the tables above
bench/               sequential ops/sec benchmark harness + captured results (RESULTS.md)
tests/               the full phase progression, one suite (bun test tests/)
```

## Requirements

[Bun](https://bun.sh) >=1.3, Docker (for Redis + Postgres via
`docker compose up -d`).
