import { afterAll, describe, expect, it } from "bun:test";
import type { PaymentResponse } from "../src/types";
import { PaymentGateway } from "../src/gateway/payment-gateway";
import { SetNxClaim } from "../src/strategies/set-nx-claim";
import { fireConcurrent } from "../harness/fire";
import { createTestRedis, uniqueKey } from "./helpers/redis-test-client";

const CONCURRENCY = 50;

describe("SetNxClaim: atomic claim fixes the double-charge race", () => {
  const redis = createTestRedis();
  afterAll(async () => {
    await redis.close();
  });

  it("charges exactly once under 50 concurrent identical requests", async () => {
    const gateway = new PaymentGateway();
    const strategy = new SetNxClaim(redis, gateway);
    const key = uniqueKey("phase2-concurrency");
    const request = { amount: 1000, currency: "usd", customerId: "cus_1" };

    const { chargeCount } = await fireConcurrent(strategy, gateway, key, request, CONCURRENCY);

    expect(chargeCount).toBe(1);
  });
});

describe("SetNxClaim: in-flight duplicate returns an unresolved response", () => {
  const redis = createTestRedis();
  afterAll(async () => {
    await redis.close();
  });

  it("a second request against a claimed-but-not-yet-charged key gets a bare 200 with no charge details", async () => {
    const gateway = new PaymentGateway();
    const key = uniqueKey("phase2-inflight");
    const request = { amount: 750, currency: "usd", customerId: "cus_2" };

    let requestB: Promise<PaymentResponse> | undefined;
    const strategy = new SetNxClaim(redis, gateway, {
      onClaimed: async () => {
        // Fire and fully resolve the second request while the first is
        // provably mid-flight: it has claimed the key but hasn't
        // charged yet, because we're still inside its onClaimed hook.
        requestB = strategy.handle(key, request);
        await requestB;
      },
    });

    const responseA = await strategy.handle(key, request);
    const responseB = await requestB!;

    expect(gateway.chargeCountFor(key)).toBe(1);
    expect(responseA.httpStatus).toBe(201);
    expect(responseA.body.chargeId).toBeDefined();

    // The naive failure: request B gets an ambiguous "succeeded" with no
    // way to reconcile it against an actual charge.
    expect(responseB.httpStatus).toBe(200);
    expect(responseB.body.chargeId).toBeUndefined();
  });
});

describe("SetNxClaim: poisoned key blocks every future retry, forever", () => {
  const redis = createTestRedis();
  afterAll(async () => {
    await redis.close();
  });

  it("a crash right after the claim leaves the key claimed with no way to recover", async () => {
    const gateway = new PaymentGateway();
    const strategy = new SetNxClaim(redis, gateway, { injectAfterClaim: true });
    const key = uniqueKey("phase2-poisoned");
    const request = { amount: 2000, currency: "usd", customerId: "cus_3" };

    await expect(strategy.handle(key, request)).rejects.toThrow("simulated crash");
    expect(gateway.chargeCountFor(key)).toBe(0);

    // A legitimate retry — same key, same customer, genuinely trying
    // again — never gets to charge. The key is claimed forever.
    const retryStrategy = new SetNxClaim(redis, gateway);
    for (let i = 0; i < 3; i++) {
      const retry = await retryStrategy.handle(key, request);
      expect(retry.httpStatus).toBe(200);
      expect(retry.body.chargeId).toBeUndefined();
    }
    expect(gateway.chargeCountFor(key)).toBe(0);
  });
});
