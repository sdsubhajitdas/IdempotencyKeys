import { RedisClient } from "bun";
import { PaymentGateway } from "../src/gateway/payment-gateway";
import { NoIdempotency } from "../src/strategies/no-idempotency";
import { NaiveCheckThenSet } from "../src/strategies/naive-check-then-set";
import { SetNxClaim } from "../src/strategies/set-nx-claim";
import { LifecycleRedis } from "../src/strategies/lifecycle";
import { PostgresTransactional } from "../src/strategies/postgres-transactional";
import { createSql, ensureSchema } from "../src/db/client";
import { InstrumentedStrategy, createCountingProxy, percentile, type RoundTripCounter } from "../src/instrumentation";

const CONCURRENCY_LEVELS = [1, 10, 25, 50];
const COLLISION_CONCURRENCY = 50;

function withCounter<T extends object>(target: T): { proxy: T; counter: RoundTripCounter } {
  const counter: RoundTripCounter = { count: 0 };
  return { proxy: createCountingProxy(target, counter), counter };
}

interface Entry {
  name: string;
  gateway: PaymentGateway;
  instrumented: InstrumentedStrategy;
}

async function buildEntries(): Promise<Entry[]> {
  const redis = new RedisClient(process.env.REDIS_URL ?? "redis://localhost:6379");
  const sql = createSql();
  await ensureSchema(sql);

  const noneGateway = new PaymentGateway();
  const none: Entry = {
    name: "none",
    gateway: noneGateway,
    instrumented: new InstrumentedStrategy(new NoIdempotency(noneGateway)),
  };

  const naiveGateway = new PaymentGateway();
  const naiveRedis = withCounter(redis);
  const naive: Entry = {
    name: "naive-check-then-set",
    gateway: naiveGateway,
    instrumented: new InstrumentedStrategy(
      new NaiveCheckThenSet(naiveRedis.proxy, naiveGateway, { prefix: "compare:naive" }),
      naiveRedis.counter,
    ),
  };

  const setNxGateway = new PaymentGateway();
  const setNxRedis = withCounter(redis);
  const setNx: Entry = {
    name: "set-nx-claim",
    gateway: setNxGateway,
    instrumented: new InstrumentedStrategy(
      new SetNxClaim(setNxRedis.proxy, setNxGateway, { prefix: "compare:setnx" }),
      setNxRedis.counter,
    ),
  };

  const lifecycleGateway = new PaymentGateway();
  const lifecycleRedis = withCounter(redis);
  const lifecycle: Entry = {
    name: "lifecycle-redis",
    gateway: lifecycleGateway,
    instrumented: new InstrumentedStrategy(
      new LifecycleRedis(lifecycleRedis.proxy, lifecycleGateway, { prefix: "compare:lifecycle" }),
      lifecycleRedis.counter,
    ),
  };

  const postgresGateway = new PaymentGateway();
  const postgresSql = withCounter(sql);
  const postgres: Entry = {
    name: "postgres-transactional",
    gateway: postgresGateway,
    instrumented: new InstrumentedStrategy(
      new PostgresTransactional(postgresSql.proxy, postgresGateway),
      postgresSql.counter,
    ),
  };

  return [none, naive, setNx, lifecycle, postgres];
}

function padRight(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

function printTable(headers: string[], rows: string[][]): void {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: string[]) => cells.map((c, i) => padRight(c, widths[i] ?? 0)).join("  ");
  console.log(line(headers));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const row of rows) console.log(line(row));
}

async function runCollisionAudit(entries: Entry[]): Promise<void> {
  console.log(`\n=== Duplicate-charge audit: ${COLLISION_CONCURRENCY} concurrent identical requests, same key ===\n`);
  const rows: string[][] = [];
  for (const entry of entries) {
    entry.gateway.reset();
    const key = `audit:${entry.name}:${crypto.randomUUID()}`;
    const request = { amount: 1000, currency: "usd", customerId: "cus_audit" };
    await Promise.all(
      Array.from({ length: COLLISION_CONCURRENCY }, () => entry.instrumented.handle(key, request)),
    );
    rows.push([entry.name, String(entry.gateway.chargeCountFor(key))]);
  }
  printTable(["strategy", `charges (of ${COLLISION_CONCURRENCY} requests)`], rows);
}

async function runLatencySweep(entries: Entry[]): Promise<void> {
  console.log("\n=== Latency + round-trips by concurrency level (independent keys) ===\n");

  const baselineP50: Record<number, number> = {};
  const rows: string[][] = [];

  for (const level of CONCURRENCY_LEVELS) {
    for (const entry of entries) {
      entry.gateway.reset();
      const request = { amount: 500, currency: "usd", customerId: "cus_sweep" };
      const before = entry.instrumented.metrics;
      const startingRoundTrips = before.storeRoundTrips;
      const startingCalls = before.calls;

      await Promise.all(
        Array.from({ length: level }, () =>
          entry.instrumented.handle(`sweep:${entry.name}:${crypto.randomUUID()}`, request),
        ),
      );

      const metrics = entry.instrumented.metrics;
      const latencies = metrics.latenciesMs.slice(startingCalls).sort((a, b) => a - b);
      const roundTrips = metrics.storeRoundTrips - startingRoundTrips;
      const p50 = percentile(latencies, 0.5);
      const p95 = percentile(latencies, 0.95);
      const p99 = percentile(latencies, 0.99);

      if (entry.name === "none") {
        baselineP50[level] = p50;
      }
      const overheadMs = p50 - (baselineP50[level] ?? p50);

      rows.push([
        entry.name,
        String(level),
        (roundTrips / level).toFixed(1),
        p50.toFixed(2),
        p95.toFixed(2),
        p99.toFixed(2),
        `+${overheadMs.toFixed(2)}`,
      ]);
    }
  }

  printTable(
    ["strategy", "concurrency", "round-trips/req", "p50 ms", "p95 ms", "p99 ms", "overhead vs baseline (p50)"],
    rows,
  );
}

async function runKeyGrowth(entries: Entry[]): Promise<void> {
  console.log("\n=== Key growth: 500 unique-key requests per store-backed strategy ===\n");
  const rows: string[][] = [];
  const N = 500;
  const runId = crypto.randomUUID(); // scopes counts to this run, not leftovers from previous ones

  for (const entry of entries) {
    if (entry.name === "none") continue;
    entry.gateway.reset();
    const request = { amount: 100, currency: "usd", customerId: "cus_growth" };
    for (let i = 0; i < N; i++) {
      await entry.instrumented.handle(`growth:${runId}:${entry.name}:${crypto.randomUUID()}`, request);
    }
  }

  const redis = new RedisClient(process.env.REDIS_URL ?? "redis://localhost:6379");
  for (const prefix of ["compare:naive", "compare:setnx", "compare:lifecycle"] as const) {
    let cursor = "0";
    let count = 0;
    let bytes = 0;
    do {
      const [next, keys] = await redis.scan(cursor, "MATCH", `${prefix}:growth:${runId}:*`, "COUNT", "1000");
      cursor = next;
      count += keys.length;
      for (const k of keys) {
        const len = await redis.send("MEMORY", ["USAGE", k]).catch(() => null);
        if (typeof len === "number") bytes += len;
      }
    } while (cursor !== "0");
    rows.push([prefix, String(count), bytes > 0 ? `${(bytes / 1024).toFixed(1)} KiB` : "n/a"]);
  }

  const sql = createSql();
  const [pgRow] = await sql<{ count: string; bytes: string }[]>`
    SELECT count(*)::text AS count, pg_total_relation_size('idempotency_keys')::text AS bytes
    FROM idempotency_keys WHERE key LIKE ${`growth:${runId}:postgres-transactional:%`}
  `;
  rows.push([
    "postgres idempotency_keys (this run's rows)",
    pgRow?.count ?? "0",
    `${(Number(pgRow?.bytes ?? 0) / 1024).toFixed(1)} KiB (whole table)`,
  ]);

  printTable(["redis prefix / pg table", "keys", "approx bytes"], rows);
  console.log(
    "\nTTL policy: PENDING leases/staleness windows self-heal in 30s by default; " +
      "COMPLETED/FAILED records retain for 24h (retentionSec), matching Stripe's default retention window. " +
      "Nothing in this repo currently caps total key volume beyond that TTL — see README 'what this repo does not solve.'",
  );
}

const entries = await buildEntries();
await runCollisionAudit(entries);
await runLatencySweep(entries);
await runKeyGrowth(entries);
process.exit(0);
