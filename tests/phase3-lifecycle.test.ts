import { afterAll, describe, expect, it } from "bun:test";
import type { PaymentResponse } from "../src/types";
import { PaymentGateway } from "../src/gateway/payment-gateway";
import { LifecycleRedis } from "../src/strategies/lifecycle";
import { StaleClaimError } from "../src/errors";
import { fireConcurrent } from "../harness/fire";
import { createTestRedis, uniqueKey } from "./helpers/redis-test-client";

const CONCURRENCY = 50;

describe("LifecycleRedis: the fix", () => {
  const redis = createTestRedis();
  afterAll(async () => {
    await redis.close();
  });

  it("charges exactly once under 50 concurrent identical requests", async () => {
    const gateway = new PaymentGateway();
    const strategy = new LifecycleRedis(redis, gateway);
    const key = uniqueKey("phase3-concurrency");
    const request = { amount: 1200, currency: "usd", customerId: "cus_1" };

    const { chargeCount } = await fireConcurrent(strategy, gateway, key, request, CONCURRENCY);

    expect(chargeCount).toBe(1);
  });

  it("a sequential retry after success replays the stored response verbatim, no new charge", async () => {
    const gateway = new PaymentGateway();
    const strategy = new LifecycleRedis(redis, gateway);
    const key = uniqueKey("phase3-replay");
    const request = { amount: 900, currency: "usd", customerId: "cus_2" };

    const first = await strategy.handle(key, request);
    const second = await strategy.handle(key, request);

    expect(gateway.chargeCountFor(key)).toBe(1);
    expect(second).toEqual(first);
    expect(second.httpStatus).toBe(first.httpStatus);
  });

  it("a concurrent request against a live PENDING claim gets 409 with Retry-After", async () => {
    const gateway = new PaymentGateway();
    const key = uniqueKey("phase3-pending-409");
    const request = { amount: 300, currency: "usd", customerId: "cus_3" };

    let requestB: Promise<PaymentResponse> | undefined;
    const strategy = new LifecycleRedis(redis, gateway, {
      leaseMs: 5000,
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

  it("a crash right after claim self-heals once the lease expires — no double charge, no poisoning", async () => {
    const gateway = new PaymentGateway();
    const key = uniqueKey("phase3-self-heal");
    const request = { amount: 1500, currency: "usd", customerId: "cus_4" };
    const leaseMs = 200;

    const crashing = new LifecycleRedis(redis, gateway, { leaseMs, injectAfterClaim: true });
    await expect(crashing.handle(key, request)).rejects.toThrow("simulated crash");
    expect(gateway.chargeCountFor(key)).toBe(0);

    // Immediately retrying while the lease is still live gets 409, not a charge.
    const stillLeased = new LifecycleRedis(redis, gateway, { leaseMs });
    const tooSoon = await stillLeased.handle(key, request);
    expect(tooSoon.httpStatus).toBe(409);
    expect(gateway.chargeCountFor(key)).toBe(0);

    // Past the lease window, the key self-heals: a legitimate retry succeeds.
    await Bun.sleep(leaseMs + 100);
    const healed = new LifecycleRedis(redis, gateway, { leaseMs });
    const recovered = await healed.handle(key, request);
    expect(recovered.httpStatus).toBe(201);
    expect(gateway.chargeCountFor(key)).toBe(1);
  });

  it("a slow (not crashed) claimant that outlives its own lease is fenced out and this is surfaced, not swallowed", async () => {
    const gateway = new PaymentGateway();
    const key = uniqueKey("phase3-slow-claimant");
    const request = { amount: 700, currency: "usd", customerId: "cus_slow" };
    const leaseMs = 100;

    let requestB: Promise<PaymentResponse> | undefined;
    const strategyA = new LifecycleRedis(redis, gateway, {
      leaseMs,
      onClaimed: async () => {
        // A is slow enough to outlive its own lease before it even
        // starts charging — not crashed, just slow. By the time A
        // resumes, B has already reclaimed the (now-abandoned-looking)
        // key and completed against it.
        await Bun.sleep(leaseMs + 100);
        const strategyB = new LifecycleRedis(redis, gateway, { leaseMs });
        requestB = strategyB.handle(key, request);
        await requestB;
      },
    });

    await expect(strategyA.handle(key, request)).rejects.toThrow(StaleClaimError);
    const responseB = await requestB!;

    expect(responseB.httpStatus).toBe(201);
    // Both A and B charged the gateway — a real double charge that a
    // lease/fencing scheme can detect but cannot prevent, because by
    // the time fencing rejects A's write, A's charge has already
    // happened. See README "What this repo does not solve."
    expect(gateway.chargeCountFor(key)).toBe(2);
  });

  it("the same key with a different request body gets 422, independent of state", async () => {
    const gateway = new PaymentGateway();
    const strategy = new LifecycleRedis(redis, gateway);
    const key = uniqueKey("phase3-fingerprint");
    const original = { amount: 1000, currency: "usd", customerId: "cus_5" };
    const different = { amount: 1000, currency: "usd", customerId: "cus_6" };

    await strategy.handle(key, original);
    const mismatched = await strategy.handle(key, different);

    expect(mismatched.httpStatus).toBe(422);
    expect(gateway.chargeCountFor(key)).toBe(1);
  });

  it("FAILED is retryable: a decline doesn't permanently burn the key", async () => {
    const gateway = new PaymentGateway();
    const key = uniqueKey("phase3-failed-retryable");
    const request = { amount: 400, currency: "usd", customerId: "cus_7" };

    const declining = new LifecycleRedis(redis, gateway, { injectChargeFailure: true });
    const declined = await declining.handle(key, request);
    expect(declined.httpStatus).toBe(402);
    expect(gateway.chargeCountFor(key)).toBe(0);

    const retry = new LifecycleRedis(redis, gateway);
    const recovered = await retry.handle(key, request);
    expect(recovered.httpStatus).toBe(201);
    expect(gateway.chargeCountFor(key)).toBe(1);
  });
});
