import { describe, expect, it } from "bun:test";
import { PaymentGateway } from "../src/gateway/payment-gateway";
import { NoIdempotency } from "../src/strategies/no-idempotency";
import { fireConcurrent } from "../harness/fire";

// The opening failure of the post: an endpoint with no idempotency
// mechanism at all. This isn't a race that only shows up under
// contention — it's deterministic. Every request charges, so N
// concurrent requests produce N charges, every single run.
const CONCURRENCY = 50;

describe("NoIdempotency: baseline has no protection against duplicate charges", () => {
  it("charges once per request, even when every request carries the same key", async () => {
    const gateway = new PaymentGateway();
    const strategy = new NoIdempotency(gateway);
    const key = "baseline-key";
    const request = { amount: 1000, currency: "usd", customerId: "cus_1" };

    const { chargeCount, responses } = await fireConcurrent(strategy, gateway, key, request, CONCURRENCY);

    expect(chargeCount).toBe(CONCURRENCY);
    expect(responses.every((r) => r.httpStatus === 201)).toBe(true);
  });

  it("a plain sequential retry with the same key charges again", async () => {
    const gateway = new PaymentGateway();
    const strategy = new NoIdempotency(gateway);
    const key = "sequential-retry-key";
    const request = { amount: 500, currency: "usd", customerId: "cus_2" };

    await strategy.handle(key, request);
    await strategy.handle(key, request);

    expect(gateway.chargeCountFor(key)).toBe(2);
  });
});
