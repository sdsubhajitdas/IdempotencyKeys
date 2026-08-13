import type { PaymentGateway } from "../gateway/payment-gateway";
import type { IdempotencyStrategy, PaymentRequest, PaymentResponse } from "../types";

/**
 * The opening failure of the post: no idempotency check at all. Every
 * call charges, every time, regardless of what key the caller sends.
 * This is the baseline every later phase is measured against.
 */
export class NoIdempotency implements IdempotencyStrategy {
  readonly name = "none";

  constructor(private readonly gateway: PaymentGateway) {}

  async handle(key: string, request: PaymentRequest): Promise<PaymentResponse> {
    const charge = await this.gateway.charge(request, key);
    return {
      httpStatus: 201,
      body: {
        status: "succeeded",
        chargeId: charge.chargeId,
        amount: charge.amount,
        currency: charge.currency,
      },
    };
  }
}
