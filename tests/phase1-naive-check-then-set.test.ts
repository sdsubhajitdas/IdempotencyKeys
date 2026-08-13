import { afterAll, describe, expect, it } from "bun:test";
import { PaymentGateway } from "../src/gateway/payment-gateway";
import { NaiveCheckThenSet } from "../src/strategies/naive-check-then-set";
import { fireConcurrent } from "../harness/fire";
import { createTestRedis, uniqueKey } from "./helpers/redis-test-client";

// Same shape as tests/phase0-baseline.test.ts's concurrency proof, but
// this time against a strategy that *does* check for an existing key
// first — and still double-charges, because every concurrent GET can
// observe "absent" before any writer's SET lands. raceWindowMs widens
// that window deliberately so this reproduces on every run.
const CONCURRENCY = 50;
const RACE_WINDOW_MS = 30;

describe("NaiveCheckThenSet: check-then-set double-charges under concurrent requests", () => {
  const redis = createTestRedis();
  afterAll(async () => {
    await redis.close();
  });

  it("double-charges when 50 identical requests race the same key", async () => {
    const gateway = new PaymentGateway();
    const strategy = new NaiveCheckThenSet(redis, gateway, { raceWindowMs: RACE_WINDOW_MS });
    const key = uniqueKey("phase1-race");
    const request = { amount: 1000, currency: "usd", customerId: "cus_1" };

    const { chargeCount } = await fireConcurrent(strategy, gateway, key, request, CONCURRENCY);

    // Every one of the 50 requests' GET fires before the first request's
    // SET (all issued concurrently, all delayed by raceWindowMs before
    // charging), so every one of them charges.
    expect(chargeCount).toBe(CONCURRENCY);
  });

  it("does not race a key that already has a stored result", async () => {
    const gateway = new PaymentGateway();
    const strategy = new NaiveCheckThenSet(redis, gateway, { raceWindowMs: RACE_WINDOW_MS });
    const key = uniqueKey("phase1-sequential");
    const request = { amount: 500, currency: "usd", customerId: "cus_2" };

    const first = await strategy.handle(key, request);
    const second = await strategy.handle(key, request);

    expect(gateway.chargeCountFor(key)).toBe(1);
    expect(second).toEqual(first);
  });
});
