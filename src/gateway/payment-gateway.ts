import type { PaymentRequest } from "../types";

export interface ChargeLedgerEntry {
  chargeId: string;
  idempotencyKey?: string;
  request: PaymentRequest;
  at: number;
}

export interface ChargeResult {
  chargeId: string;
  amount: number;
  currency: string;
}

export interface PaymentGatewayOptions {
  /** Simulated network latency for every charge() call, in ms. */
  latencyMs?: number;
}

/**
 * The one mock in this repo: a payment processor that actually records
 * every charge it's asked to make. Every "did we double-charge the
 * customer" assertion in the test suite reads this ledger directly —
 * nothing here is inferred from strategy return values.
 */
export class PaymentGateway {
  private readonly latencyMs: number;
  private readonly entries: ChargeLedgerEntry[] = [];

  constructor(options: PaymentGatewayOptions = {}) {
    this.latencyMs = options.latencyMs ?? 0;
  }

  async charge(request: PaymentRequest, idempotencyKey?: string): Promise<ChargeResult> {
    if (this.latencyMs > 0) {
      await Bun.sleep(this.latencyMs);
    }

    const result: ChargeResult = {
      chargeId: crypto.randomUUID(),
      amount: request.amount,
      currency: request.currency,
    };

    this.entries.push({
      chargeId: result.chargeId,
      ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
      request,
      at: Date.now(),
    });

    return result;
  }

  get ledger(): readonly ChargeLedgerEntry[] {
    return this.entries;
  }

  chargeCountFor(idempotencyKey: string): number {
    return this.entries.filter((e) => e.idempotencyKey === idempotencyKey).length;
  }

  reset(): void {
    this.entries.length = 0;
  }
}
