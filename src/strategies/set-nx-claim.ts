import type { RedisClient } from "bun";
import type { PaymentGateway } from "../gateway/payment-gateway";
import type { IdempotencyStrategy, PaymentRequest, PaymentResponse } from "../types";

export interface SetNxClaimOptions {
  prefix?: string;
  /**
   * Called synchronously right after SET NX claims the key, before the
   * gateway is charged. Test-only hook: lets a test fire a second
   * request while the first is provably mid-flight, without guessing at
   * timing.
   */
  onClaimed?: () => void | Promise<void>;
  /**
   * Throws immediately after SET NX claims the key, before charging or
   * writing a result — an in-process stand-in for "the request crashed
   * right here," deterministic on every run.
   */
  injectAfterClaim?: boolean;
}

const UNRESOLVED = ""; // the claim marker: "someone owns this key, no result yet"

/**
 * Fixes Phase 1's race by claiming the key atomically with SET NX before
 * charging — no two callers can both believe they're first. But this
 * phase deliberately stores nothing else: a claimed-but-not-yet-resolved
 * key has no way to tell a concurrent caller "wait" from "you're the
 * first," and a crash after the claim leaves the key claimed forever,
 * with no TTL to recover it. Both flaws are fixed in Phase 3, not here.
 */
export class SetNxClaim implements IdempotencyStrategy {
  readonly name = "set-nx-claim";
  private readonly prefix: string;
  private readonly onClaimed?: (() => void | Promise<void>) | undefined;
  private readonly injectAfterClaim: boolean;

  constructor(
    private readonly redis: RedisClient,
    private readonly gateway: PaymentGateway,
    options: SetNxClaimOptions = {},
  ) {
    this.prefix = options.prefix ?? "setnx";
    this.onClaimed = options.onClaimed;
    this.injectAfterClaim = options.injectAfterClaim ?? false;
  }

  async handle(key: string, request: PaymentRequest): Promise<PaymentResponse> {
    const redisKey = `${this.prefix}:${key}`;
    const claimed = await this.redis.set(redisKey, UNRESOLVED, "NX");

    if (claimed === null) {
      const existing = await this.redis.get(redisKey);
      if (existing === null || existing === UNRESOLVED) {
        // Someone else claimed this key and hasn't (or never will)
        // finish. This is the in-flight-duplicate / poisoned-key flaw:
        // there's no way to distinguish "still charging" from "crashed
        // and never will" from here, so the caller gets a bare
        // "succeeded" with no charge details to reconcile against.
        return { httpStatus: 200, body: { status: "succeeded" } };
      }
      return JSON.parse(existing) as PaymentResponse;
    }

    if (this.onClaimed) {
      await this.onClaimed();
    }
    if (this.injectAfterClaim) {
      throw new Error("simulated crash after SET NX claim, before charge/completion");
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
