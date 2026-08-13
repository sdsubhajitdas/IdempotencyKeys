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

- `?strategy=` selects among the registered strategies (`none` for now;
  more are added as later phases land) or set `IDEMPOTENCY_STRATEGY`.
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
