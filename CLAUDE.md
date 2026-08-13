# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A blog-companion repo ("From Theory to Tested Code"): idempotency keys for
a payment API, built as a progression from a broken baseline up to a
tested three-state Redis lifecycle, plus an honest Postgres comparison
that shows what a single DB transaction does and does not fix. Runs on
[Bun](https://bun.sh) with zero runtime dependencies — Bun's built-in test
runner, Redis client, SQL (Postgres) client, and TS execution are used
directly.

## Commands

```
bun install
docker compose up -d          # starts Redis (6379) and Postgres (5432), both required for most tests
bun run typecheck             # tsc --noEmit
bun test tests/               # or: bun run test — the whole phase progression, one suite
bun run test:watch            # watch mode
bun run demo                  # demo HTTP server
bun run dev                   # demo server with --hot
bun run compare               # duplicate-charge audit + concurrency-sweep latency overhead + key growth
bun run bench                 # sequential ops/sec per strategy, one connection, no concurrency
```

Run a single test file: `bun test tests/phase2-set-nx-claim.test.ts`.
Run a single test by name: `bun test tests/phase2-set-nx-claim.test.ts -t "poisoned"`.

Redis defaults to `redis://localhost:6379` (`REDIS_URL` to override);
Postgres defaults to `postgres://idempotency:idempotency@localhost:5432/idempotency`
(`DATABASE_URL` to override) — see `.env.example`.

## Architecture

**Shared contract** (`src/types.ts`): every strategy implements
`IdempotencyStrategy.handle(key, request) -> Promise<PaymentResponse>`.
The comparison harness (`harness/compare.ts`) and demo server
(`demo/server.ts`) drive all strategies through this one method with no
strategy-specific branching — see the `?strategy=` switch in
`demo/server.ts` for the only place strategies are enumerated.

**One file per phase** (`src/strategies/<name>.ts`), each deliberately
demonstrating the failure mode that motivates the next phase:
- `no-idempotency.ts` — Phase 0: no protection, charges every time.
- `naive-check-then-set.ts` — Phase 1: `GET`-then-`SET`, still races.
  Do not "fix" this one; being broken under concurrency is its purpose.
- `set-nx-claim.ts` — Phase 2: atomic claim via `SET NX`, but no result
  storage and no TTL — fixes the double-charge race but introduces the
  in-flight-duplicate and poisoned-key problems. Also deliberately not
  "fixed"; that's Phase 3's job.
- `lifecycle.ts` — Phase 3: the actual fix. Three-state
  `NEW -> PENDING -> COMPLETED|FAILED` via Lua (`src/redis/lua/`), a
  leased `PENDING` that self-heals, request fingerprinting, verbatim
  response replay.
- `postgres-transactional.ts` — Phase 4: a unique-constraint-backed
  alternative using `Bun.sql`'s `sql.begin`, plus the injection that
  shows what it still doesn't solve.

**The one mock** (`src/gateway/payment-gateway.ts`): `PaymentGateway`
actually records every charge to an in-memory ledger. Every
duplicate-charge assertion in the test suite reads
`gateway.chargeCountFor(key)` / `gateway.ledger` directly — nothing is
inferred from a strategy's return value.

**Fencing detects, does not prevent** (`src/errors.ts`): both
`lifecycle.ts`'s `persistCompletion` and `postgres-transactional.ts`'s
`persist` check whether their claim token is still current before
writing a completed result, and throw `StaleClaimError` instead of
returning success when it isn't. A claim can be superseded this way
without ever crashing — a claimant that's merely slow enough to outlive
its own lease/staleness window gets reclaimed by someone else, and by
the time the slow claimant tries to persist, it's already charged the
gateway. Fencing stops that stale write from corrupting the newer
claim's state (and, in Postgres, stops a phantom row from landing in
`charges`), but it cannot undo the charge that already happened — see
`tests/phase3-lifecycle.test.ts`/`tests/phase4-postgres.test.ts`'s "slow
claimant" tests and README "What this repo does not solve."

**Redis atomicity** (`src/redis/`): `script-loader.ts`'s `LuaScript`
class SHA1s the script locally, lazily runs `SCRIPT LOAD`, then calls
`EVALSHA` via `.send()`, catching `NOSCRIPT` and reloading once.
`Bun.redis`'s `RedisClient` does not wrap `EVAL`/`EVALSHA` directly
(confirmed against `bun-types@1.3.14`), which
is why this fallback exists at all.

**Determinism**: nothing in this repo depends on winning a real timing
race. Concurrent scenarios are sequenced with an explicit in-process
hook (`onClaimed`, called synchronously right after a claim succeeds, so
a test can fire a second request at exactly that point); poisoning and
mid-flight-crash scenarios are an injected `throw` at a named point
(`injectAfterClaim`, `injectAfterCharge`), not a real process kill;
lease-expiry scenarios wait a fixed, short amount of time comfortably
past a fixed TTL. See each strategy's constructor options for the exact
hooks it accepts.

**Instrumentation** (`src/instrumentation.ts`): `InstrumentedStrategy`
wraps any `IdempotencyStrategy` and records call count, response-status
distribution, and per-call latency (`Bun.nanoseconds()`). Store
round-trips are counted separately via `createCountingProxy`, which wraps
a strategy's `RedisClient`/`SQL` instance in a `Proxy` that increments a
shared counter on every method call — instrumentation never has to know
which store or which commands a given strategy uses. The proxy needs
both a `get` trap (`redis.method(...)`) and an `apply` trap: `Bun.sql`'s
client is itself callable (`` sql`SELECT ...` `` is a tagged-template
call directly on the object, not a property access), so a `get`-only
proxy silently undercounts Postgres round trips — found by comparing
`harness/compare.ts`'s printed round-trip counts against the number of
queries each strategy actually issues.

**Postgres claim is one round trip, not two** (`postgres-transactional.ts`'s
`tryClaim`): a single CTE attempts the `INSERT ... ON CONFLICT` and falls
back to reading the existing row in one statement, rather than an INSERT
then a separate SELECT. An earlier two-round-trip version duplicate-charged
under real 50-concurrent load — connection-pool queueing delay on the
second round trip was enough for some requests' staleness check to see a
claim that was only milliseconds old and, by wall-clock time alone, look
abandoned. `src/db/client.ts` also sizes the connection pool (`max: 30`)
for this repo's own concurrency rather than Bun's default of 10.

## Conventions

- `tsconfig.json` is strict (`strict`, `noUncheckedIndexedAccess`,
  `noImplicitOverride`, `exactOptionalPropertyTypes`) — respect these
  rather than loosening them for convenience.
- Lua files are imported as text (`... with { type: "text" }`, see
  `types/lua.d.ts`) — no separate build step.
- All tests live in one `tests/` directory (`bun test tests/`), not
  split into a separate "naive" suite — this whole repo is a
  naive-to-fixed progression, so the deliberately-broken phases (0-2)
  are as central to the suite as the fixed one (3-4), not a side note
  run separately.
