import { RedisClient } from "bun";
import { PaymentGateway } from "../src/gateway/payment-gateway";
import { NoIdempotency } from "../src/strategies/no-idempotency";
import { NaiveCheckThenSet } from "../src/strategies/naive-check-then-set";
import { SetNxClaim } from "../src/strategies/set-nx-claim";
import { LifecycleRedis } from "../src/strategies/lifecycle";
import { PostgresTransactional } from "../src/strategies/postgres-transactional";
import { createSql, ensureSchema } from "../src/db/client";
import type { IdempotencyStrategy } from "../src/types";

// Sequential (not concurrent) round trips, one connection per store:
// this measures per-call latency and single-connection throughput, not
// maximum achievable throughput under pipelining/multiple connections.
// Mirrors RateLimiter/bench/run.ts's methodology — the point is a
// same-shape comparison across strategies, not an absolute ceiling.
const ITERATIONS = 1000;
const WARMUP = 100;

interface BenchResult {
  strategy: string;
  opsPerSec: number;
  avgLatencyMs: number;
  p99LatencyMs: number;
}

async function bench(name: string, strategy: IdempotencyStrategy, gateway: PaymentGateway): Promise<BenchResult> {
  const request = { amount: 1000, currency: "usd", customerId: "cus_bench" };

  for (let i = 0; i < WARMUP; i++) {
    await strategy.handle(`bench-warmup:${crypto.randomUUID()}`, request);
  }
  gateway.reset();

  const latencies: number[] = [];
  const start = performance.now();
  for (let i = 0; i < ITERATIONS; i++) {
    const t0 = performance.now();
    // A fresh key per call: this benchmarks the steady-state "claim and
    // complete a new request" cost, the path every real request takes,
    // not a replay-from-cache fast path.
    await strategy.handle(`bench:${crypto.randomUUID()}`, request);
    latencies.push(performance.now() - t0);
  }
  const totalMs = performance.now() - start;

  latencies.sort((a, b) => a - b);
  const avgLatencyMs = latencies.reduce((a, b) => a + b, 0) / latencies.length;
  const p99Index = Math.floor(latencies.length * 0.99);

  return {
    strategy: name,
    opsPerSec: Math.round((ITERATIONS / totalMs) * 1000),
    avgLatencyMs: Number(avgLatencyMs.toFixed(3)),
    p99LatencyMs: Number((latencies[p99Index] ?? 0).toFixed(3)),
  };
}

function printResults(results: BenchResult[]): void {
  const header = ["strategy", "ops/sec", "avg latency (ms)", "p99 latency (ms)"];
  const rows = results.map((r) => [r.strategy, String(r.opsPerSec), String(r.avgLatencyMs), String(r.p99LatencyMs)]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join("  ");
  console.log(line(header));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const row of rows) console.log(line(row));
}

const redis = new RedisClient(process.env.REDIS_URL ?? "redis://localhost:6379");
const sql = createSql();
await ensureSchema(sql);

const results: BenchResult[] = [];

const noneGateway = new PaymentGateway();
results.push(await bench("none", new NoIdempotency(noneGateway), noneGateway));

const naiveGateway = new PaymentGateway();
results.push(
  await bench("naive-check-then-set", new NaiveCheckThenSet(redis, naiveGateway, { prefix: "bench:naive" }), naiveGateway),
);

const setNxGateway = new PaymentGateway();
results.push(await bench("set-nx-claim", new SetNxClaim(redis, setNxGateway, { prefix: "bench:setnx" }), setNxGateway));

const lifecycleGateway = new PaymentGateway();
results.push(
  await bench("lifecycle (Redis)", new LifecycleRedis(redis, lifecycleGateway, { prefix: "bench:lifecycle" }), lifecycleGateway),
);

const postgresGateway = new PaymentGateway();
results.push(await bench("postgres-transactional", new PostgresTransactional(sql, postgresGateway), postgresGateway));

printResults(results);
process.exit(0);
