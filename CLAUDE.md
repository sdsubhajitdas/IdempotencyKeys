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
bun run compare               # runs every strategy through identical workloads, prints a table
bun run bench                 # latency-overhead benchmark harness
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
  Do not "fix" this one; being broken is its purpose (mirrors
  `RateLimiter/src/limiters/naive/fixed-window-naive-redis.ts`'s role in
  the prior repo).
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

**Redis atomicity** (`src/redis/`): `script-loader.ts`'s `LuaScript`
class is ported from `RateLimiter/src/limiters/redis/script-loader.ts` —
SHA1 the script locally, lazy `SCRIPT LOAD`, `EVALSHA` via `.send()`,
catch `NOSCRIPT` and reload. `Bun.redis`'s `RedisClient` does not wrap
`EVAL`/`EVALSHA` directly (confirmed against `bun-types@1.3.14`), which
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
which store or which commands a given strategy uses.

## Conventions

- `tsconfig.json` is strict (`strict`, `noUncheckedIndexedAccess`,
  `noImplicitOverride`, `exactOptionalPropertyTypes`) — respect these
  rather than loosening them for convenience.
- Lua files are imported as text (`... with { type: "text" }`, see
  `types/lua.d.ts`), same as the prior repo — no separate build step.
- All tests live in one `tests/` directory (`bun test tests/`), not split
  into a separate "naive" suite the way `RateLimiter` did — this whole
  repo is a naive-to-fixed progression, so the deliberately-broken phases
  (0-2) are as central to the suite as the fixed one (3-4), not a side
  note run separately.
