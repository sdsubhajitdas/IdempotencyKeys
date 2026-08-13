import { afterAll, describe, expect, it } from "bun:test";
import type { PaymentResponse } from "../src/types";
import { PaymentGateway } from "../src/gateway/payment-gateway";
import { PostgresTransactional } from "../src/strategies/postgres-transactional";
import { LifecycleRedis } from "../src/strategies/lifecycle";
import { StaleClaimError } from "../src/errors";
import { fireConcurrent } from "../harness/fire";
import { createTestSql, uniqueKey as uniquePgKey } from "./helpers/pg-test-client";
import { createTestRedis, uniqueKey as uniqueRedisKey } from "./helpers/redis-test-client";

const CONCURRENCY = 50;

describe("PostgresTransactional: correctness, mirroring the Redis lifecycle's guarantees", () => {
  const sqlPromise = createTestSql();
  afterAll(async () => {
    await (await sqlPromise).close();
  });

  it("charges exactly once under 50 concurrent identical requests", async () => {
    const sql = await sqlPromise;
    const gateway = new PaymentGateway();
    const strategy = new PostgresTransactional(sql, gateway);
    const key = uniquePgKey("phase4-concurrency");
    const request = { amount: 1100, currency: "usd", customerId: "cus_1" };

    const { chargeCount } = await fireConcurrent(strategy, gateway, key, request, CONCURRENCY);

    expect(chargeCount).toBe(1);
  });

  it("a sequential retry after success replays the stored response verbatim, no new charge", async () => {
    const sql = await sqlPromise;
    const gateway = new PaymentGateway();
    const strategy = new PostgresTransactional(sql, gateway);
    const key = uniquePgKey("phase4-replay");
    const request = { amount: 850, currency: "usd", customerId: "cus_2" };

    const first = await strategy.handle(key, request);
    const second = await strategy.handle(key, request);

    expect(gateway.chargeCountFor(key)).toBe(1);
    expect(second).toEqual(first);
  });

  it("a concurrent request against a live pending claim gets 409 with Retry-After", async () => {
    const sql = await sqlPromise;
    const gateway = new PaymentGateway();
    const key = uniquePgKey("phase4-pending-409");
    const request = { amount: 275, currency: "usd", customerId: "cus_3" };

    let requestB: Promise<PaymentResponse> | undefined;
    const strategy = new PostgresTransactional(sql, gateway, {
      staleAfterMs: 5000,
      onClaimed: async () => {
        requestB = strategy.handle(key, request);
        await requestB;
      },
    });

    const responseA = await strategy.handle(key, request);
    const responseB = await requestB!;

    expect(gateway.chargeCountFor(key)).toBe(1);
    expect(responseA.httpStatus).toBe(201);
    expect(responseB.httpStatus).toBe(409);
    expect(responseB.retryAfterSec).toBeGreaterThan(0);
  });

  it("the same key with a different request body gets 422, independent of status", async () => {
    const sql = await sqlPromise;
    const gateway = new PaymentGateway();
    const strategy = new PostgresTransactional(sql, gateway);
    const key = uniquePgKey("phase4-fingerprint");
    const original = { amount: 1000, currency: "usd", customerId: "cus_4" };
    const different = { amount: 1000, currency: "usd", customerId: "cus_5" };

    await strategy.handle(key, original);
    const mismatched = await strategy.handle(key, different);

    expect(mismatched.httpStatus).toBe(422);
    expect(gateway.chargeCountFor(key)).toBe(1);
  });

  it("a decline (failed status) is retryable, matching the Redis lifecycle's policy", async () => {
    const sql = await sqlPromise;
    const gateway = new PaymentGateway();
    const key = uniquePgKey("phase4-failed-retryable");
    const request = { amount: 425, currency: "usd", customerId: "cus_6" };

    const declining = new PostgresTransactional(sql, gateway, { injectChargeFailure: true });
    const declined = await declining.handle(key, request);
    expect(declined.httpStatus).toBe(402);
    expect(gateway.chargeCountFor(key)).toBe(0);

    const retry = new PostgresTransactional(sql, gateway);
    const recovered = await retry.handle(key, request);
    expect(recovered.httpStatus).toBe(201);
    expect(gateway.chargeCountFor(key)).toBe(1);
  });

  it("a slow (not crashed) claimant that outlives its own staleness window is fenced out and this is surfaced, not swallowed", async () => {
    const sql = await sqlPromise;
    const gateway = new PaymentGateway();
    const key = uniquePgKey("phase4-slow-claimant");
    const request = { amount: 725, currency: "usd", customerId: "cus_slow" };
    const staleAfterMs = 100;

    let requestB: Promise<PaymentResponse> | undefined;
    const strategyA = new PostgresTransactional(sql, gateway, {
      staleAfterMs,
      onClaimed: async () => {
        // A is slow enough to outlive its own staleness window before it
        // even starts charging — not crashed, just slow. By the time A
        // resumes, B has already reclaimed and completed against the
        // (now-abandoned-looking) key.
        await Bun.sleep(staleAfterMs + 100);
        const strategyB = new PostgresTransactional(sql, gateway, { staleAfterMs });
        requestB = strategyB.handle(key, request);
        await requestB;
      },
    });

    await expect(strategyA.handle(key, request)).rejects.toThrow(StaleClaimError);
    const responseB = await requestB!;

    expect(responseB.httpStatus).toBe(201);
    // Both A and B charged the gateway — the same unpreventable-in-general
    // double charge as the Redis lifecycle's equivalent test. What the
    // fencing fix *does* guarantee here: A's fenced-out attempt never
    // left a phantom row in Postgres's own ledger table — exactly one
    // charges row exists, matching B's charge, not two.
    expect(gateway.chargeCountFor(key)).toBe(2);
    const chargesRows = await sql`SELECT * FROM charges WHERE idempotency_key = ${key}`;
    expect(chargesRows.length).toBe(1);
  });
});

// The honest finding this phase exists to produce: the gateway call is
// external to both stores, so a failure injected between "charge
// succeeded" and "result persisted" is not a Redis-specific problem — it
// happens to any design where the external call can't be rolled back by
// throwing inside a DB transaction. Both strategies get a *comparable*
// injection (same staleness-window shape) so the measured numbers mean
// the same thing for each. This isn't tuned for a tidy result; it
// reports whatever the harness actually measures.
describe("Phase 4: the gateway call outside the transaction — comparable failure injection", () => {
  const redis = createTestRedis();
  const sqlPromise = createTestSql();
  const WINDOW_MS = 150;
  const TRIALS = 10;

  afterAll(async () => {
    await redis.close();
    await (await sqlPromise).close();
  });

  it("Redis lifecycle: charge-succeeds-then-persist-fails duplicates on retry, every trial", async () => {
    const gateway = new PaymentGateway();
    let duplicated = 0;

    for (let i = 0; i < TRIALS; i++) {
      const key = uniqueRedisKey("phase4-redis-injection");
      const request = { amount: 600, currency: "usd", customerId: `cus_redis_${i}` };

      const crashing = new LifecycleRedis(redis, gateway, { leaseMs: WINDOW_MS, injectAfterCharge: true });
      await expect(crashing.handle(key, request)).rejects.toThrow("simulated failure");
      expect(gateway.chargeCountFor(key)).toBe(1); // the charge happened — the write-back is what failed

      await Bun.sleep(WINDOW_MS + 50);

      const retrying = new LifecycleRedis(redis, gateway, { leaseMs: WINDOW_MS });
      await retrying.handle(key, request);

      if (gateway.chargeCountFor(key) > 1) duplicated++;
    }

    console.log(`Redis lifecycle: ${duplicated}/${TRIALS} trials duplicate-charged after the injection`);
    expect(duplicated).toBe(TRIALS);
  });

  it("Postgres transactional: charge-succeeds-then-commit-fails duplicates on retry too — the transaction doesn't help here", async () => {
    const sql = await sqlPromise;
    const gateway = new PaymentGateway();
    let duplicated = 0;

    for (let i = 0; i < TRIALS; i++) {
      const key = uniquePgKey("phase4-pg-injection");
      const request = { amount: 600, currency: "usd", customerId: `cus_pg_${i}` };

      const crashing = new PostgresTransactional(sql, gateway, { staleAfterMs: WINDOW_MS, injectAfterCharge: true });
      await expect(crashing.handle(key, request)).rejects.toThrow("simulated failure");
      expect(gateway.chargeCountFor(key)).toBe(1); // charge happened; the transaction that would record it never committed

      await Bun.sleep(WINDOW_MS + 50);

      const retrying = new PostgresTransactional(sql, gateway, { staleAfterMs: WINDOW_MS });
      await retrying.handle(key, request);

      if (gateway.chargeCountFor(key) > 1) duplicated++;
    }

    console.log(`Postgres transactional: ${duplicated}/${TRIALS} trials duplicate-charged after the injection`);
    // The single-transaction design still duplicates here, at the same
    // rate as Redis — because the gateway call sits outside the
    // transaction's atomic boundary in both strategies. A DB transaction
    // makes the *DB write* atomic; it can't make an external HTTP call
    // atomic with anything.
    expect(duplicated).toBe(TRIALS);
  });
});
