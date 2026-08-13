# Bench Results

Captured output of `bun run bench` (`bench/run.ts`), which times
`handle()` sequentially — one call at a time, one connection per store,
not pipelined or concurrent — for each strategy. Every call uses a fresh
idempotency key, so every call takes the "claim and complete a new
request" code path (the cost every real request actually pays), not a
replay-from-cache fast path.

## Environment

- Bun v1.3.14, macOS (Darwin arm64, Apple M1 Pro)
- Redis 7.4.9 in Docker (`redis:7-alpine`), reached over `localhost:6379`
- Postgres 16 in Docker (`postgres:16-alpine`), reached over `localhost:5432`
- 1,000 timed iterations per strategy, after a 100-iteration warmup

## Results

| strategy               | ops/sec   | avg latency (ms) | p99 latency (ms) |
| ----------------------- | --------- | ----------------- | ----------------- |
| none                     | 1,207,365 | 0.001              | 0.005              |
| naive-check-then-set     | 2,542     | 0.393              | 0.743              |
| set-nx-claim             | 2,732     | 0.366              | 0.651              |
| lifecycle (Redis)        | 2,367     | 0.422              | 0.731              |
| postgres-transactional   | 708       | 1.413              | 3.385              |

## Reading these numbers

- **`none` is off the chart, deliberately.** With no store round trip at
  all, it's ~440-1,700x faster than every other strategy here. That's
  not a real option — it's the baseline with zero correctness, included
  so the "cost of correctness" numbers below have a zero point to
  compare against.
- **The three Redis-backed strategies land within a fairly tight band**
  (2,367-2,732 ops/sec, 0.37-0.42ms avg latency), because each is
  fundamentally 1-2 Redis round trips per call and round-trip cost
  dominates over what happens inside each call. `lifecycle` is the
  slowest of the three despite being the most capable — the Lua
  EVALSHA round trips do more work server-side (a hash read-modify-write
  instead of a single `GET`/`SET`/`SET NX`), and that shows up here as a
  ~15% latency cost over `set-nx-claim`. That's the price of the fix,
  and it's small next to what it buys: correctness under concurrency
  that the other two don't have (see the duplicate-charge audit in
  `harness/compare.ts`'s output above this file's numbers, or run it
  yourself).
- **`postgres-transactional` is ~3.3x slower than the Redis strategies**
  (708 vs. ~2,400-2,700 ops/sec). Two real round trips per call here too
  (the CTE claim, then a `sql.begin` transaction to persist), but each
  one is more expensive: Postgres's transactional write path (WAL fsync
  semantics, `BEGIN`/`COMMIT` overhead) costs more per round trip than
  Redis's single-threaded in-memory command execution, even for
  logically equivalent work. See `harness/compare.ts`'s concurrency
  sweep for how this gap widens further under concurrent load (Postgres
  goes from ~2.8ms p50 at concurrency 1 to ~14-18ms p50 at concurrency
  50, versus Redis staying under 2ms throughout).
- **Conclusion for the blog post:** correctness has a real, measurable
  cost — roughly 0.4ms per request for the Redis lifecycle, ~1.4ms for
  the Postgres alternative, versus effectively free for doing nothing.
  Neither cost is what makes a naive implementation wrong; the naive
  versions are exactly as fast as the fixed one; the wrongness is
  entirely about behavior under concurrency (see the duplicate-charge
  audit), not latency. Pick Postgres over Redis when you need the
  charge record and the idempotency key to live in the same
  transactional store as the rest of your business data — not for
  speed, which Redis wins outright.

## Reproducing

```
docker compose up -d
bun run bench
bun run compare   # duplicate-charge audit, concurrency sweep, key growth
```
