import type { PaymentGateway } from "../src/gateway/payment-gateway";
import type { IdempotencyStrategy, PaymentRequest, PaymentResponse } from "../src/types";

export interface FireResult {
  responses: PaymentResponse[];
  chargeCount: number;
}

/**
 * Fires `concurrency` identical requests at a strategy simultaneously
 * (via Promise.all, so every call is dispatched before any of them
 * resolves) and reports how many charges the gateway's ledger actually
 * recorded for that key. This is the harness every phase's "N concurrent
 * requests" test drives.
 */
export async function fireConcurrent(
  strategy: IdempotencyStrategy,
  gateway: PaymentGateway,
  key: string,
  request: PaymentRequest,
  concurrency: number,
): Promise<FireResult> {
  const responses = await Promise.all(
    Array.from({ length: concurrency }, () => strategy.handle(key, request)),
  );

  return {
    responses,
    chargeCount: gateway.chargeCountFor(key),
  };
}
