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

> This README is written phase-by-phase as the repo is built. Sections
> below fill in as each phase lands; see `CLAUDE.md` for the current
> architecture snapshot.

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

## Getting started

```
bun install
docker compose up -d      # starts Redis (6379) and Postgres (5432)
bun run typecheck
bun test                  # the whole phase progression
```

## Demo server

```
bun run demo
curl -X POST localhost:3000/payments \
  -H "Idempotency-Key: demo-key-1" \
  -H "Content-Type: application/json" \
  -d '{"amount": 1000, "currency": "usd", "customerId": "cus_1"}'
```

- `?strategy=` selects among the registered strategies (`none`, `naive`,
  `set-nx`, `lifecycle` so far — `lifecycle` is the default, since it's
  the fixed version) or set `IDEMPOTENCY_STRATEGY`.
- `GET /strategies` lists what's available.

## Project layout

```
src/strategies/     one file per phase's strategy, each implementing IdempotencyStrategy
src/gateway/        the one mock — PaymentGateway and its ledger
src/redis/          Lua scripts + the EVALSHA-based script loader (added in Phase 3)
src/db/             Postgres schema + client (added in Phase 4)
src/instrumentation.ts   round-trip/status/latency instrumentation wrapper
demo/                the demo HTTP server (Bun.serve)
harness/             concurrent-request firing + cross-strategy comparison
bench/               benchmark harness + captured results
tests/               the full phase progression, one suite
```

## Requirements

[Bun](https://bun.sh) >=1.3, Docker (for Redis + Postgres via
`docker compose up -d`).
