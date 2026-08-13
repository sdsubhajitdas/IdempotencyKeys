export interface PaymentRequest {
  amount: number; // integer cents
  currency: string;
  customerId: string;
}

export interface PaymentResponse {
  httpStatus: number;
  body: {
    status: "succeeded" | "failed" | "conflict" | "invalid";
    chargeId?: string;
    amount?: number;
    currency?: string;
    error?: string;
  };
  /** Present alongside a 409, seconds until the caller should retry. */
  retryAfterSec?: number;
}

/**
 * Every strategy in this repo implements this and only this. The
 * comparison harness and demo server drive all of them identically —
 * strategy-specific behavior (races, poisoning, replay) lives inside
 * handle(), never in how it's called.
 */
export interface IdempotencyStrategy {
  readonly name: string;
  handle(key: string, request: PaymentRequest): Promise<PaymentResponse>;
}
