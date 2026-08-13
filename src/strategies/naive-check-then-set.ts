import type { RedisClient } from "bun";
import type { PaymentGateway } from "../gateway/payment-gateway";
import type { IdempotencyStrategy, PaymentRequest, PaymentResponse } from "../types";

export interface NaiveCheckThenSetOptions {
  prefix?: string;
  /**
   * Artificial delay between the GET check and the charge/SET, in ms.
   * Widens the check-then-set race window so it reproduces on every run
   * instead of depending on real Redis round-trip variance. Not a hack
   * specific to this repo — it's the same race a slow gateway call would
   * open in production, just made deterministic for a test.
   */
  raceWindowMs?: number;
}

/**
 * Every idempotency-key tutorial's first draft: read the key, and if
 * it's absent, charge and write the result back. This closes almost none
 * of the gap a naive read-then-write ever closes — every concurrent
 * caller's GET can observe "absent" before any of them has written back.
 * Deliberately not fixed here; that's what Phase 2 and Phase 3 are for.
 */
export class NaiveCheckThenSet implements IdempotencyStrategy {
  readonly name = "naive-check-then-set";
  private readonly prefix: string;
  private readonly raceWindowMs: number;

  constructor(
    private readonly redis: RedisClient,
    private readonly gateway: PaymentGateway,
    options: NaiveCheckThenSetOptions = {},
  ) {
    this.prefix = options.prefix ?? "naive";
    this.raceWindowMs = options.raceWindowMs ?? 0;
  }

  async handle(key: string, request: PaymentRequest): Promise<PaymentResponse> {
    const redisKey = `${this.prefix}:${key}`;

    const existing = await this.redis.get(redisKey);
    if (existing !== null) {
      return JSON.parse(existing) as PaymentResponse;
    }

    if (this.raceWindowMs > 0) {
      await Bun.sleep(this.raceWindowMs);
    }

    const charge = await this.gateway.charge(request, key);
    const response: PaymentResponse = {
      httpStatus: 201,
      body: {
        status: "succeeded",
        chargeId: charge.chargeId,
        amount: charge.amount,
        currency: charge.currency,
      },
    };

    await this.redis.set(redisKey, JSON.stringify(response));
    return response;
  }
}
