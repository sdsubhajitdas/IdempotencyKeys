import type { PaymentRequest } from "./types";

/**
 * A stable hash of the parts of a request that must match for a retry
 * with the same idempotency key to be considered "the same request."
 * Explicitly listing fields (rather than JSON.stringify-ing the request
 * as-is) keeps the hash stable regardless of incoming key order.
 */
export function fingerprintRequest(request: PaymentRequest): string {
  const canonical = JSON.stringify({
    amount: request.amount,
    currency: request.currency,
    customerId: request.customerId,
  });
  return new Bun.CryptoHasher("sha256").update(canonical).digest("hex");
}
