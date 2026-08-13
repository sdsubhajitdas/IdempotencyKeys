import type { IdempotencyStrategy, PaymentRequest, PaymentResponse } from "./types";

export interface RoundTripCounter {
  count: number;
}

/**
 * Wraps a store client (RedisClient, SQL, ...) so every method call
 * increments a shared counter, without either the client or the strategy
 * that uses it knowing instrumentation exists. One generic proxy instead
 * of manual bookkeeping scattered through every strategy, since a round
 * trip is a round trip regardless of which command caused it.
 */
export function createCountingProxy<T extends object>(target: T, counter: RoundTripCounter): T {
  return new Proxy(target, {
    get(obj, prop, receiver) {
      const value = Reflect.get(obj, prop, receiver);
      if (typeof value !== "function") {
        return value;
      }
      return function (this: unknown, ...args: unknown[]) {
        counter.count++;
        return value.apply(obj, args);
      };
    },
  });
}

export interface StrategyMetrics {
  calls: number;
  statusDistribution: Record<number, number>;
  latenciesMs: number[];
  storeRoundTrips: number;
}

/**
 * Wraps any IdempotencyStrategy to record round-trips (via a counter
 * populated by createCountingProxy on the strategy's own store client),
 * response status distribution, and per-call latency. Never touches
 * store logic itself — that's the strategy's job, not this wrapper's.
 */
export class InstrumentedStrategy implements IdempotencyStrategy {
  readonly name: string;
  private calls = 0;
  private readonly statusDistribution: Record<number, number> = {};
  private readonly latenciesMs: number[] = [];

  constructor(
    private readonly inner: IdempotencyStrategy,
    private readonly roundTripCounter: RoundTripCounter = { count: 0 },
  ) {
    this.name = inner.name;
  }

  async handle(key: string, request: PaymentRequest): Promise<PaymentResponse> {
    const start = Bun.nanoseconds();
    const response = await this.inner.handle(key, request);
    const elapsedMs = (Bun.nanoseconds() - start) / 1e6;

    this.calls++;
    this.latenciesMs.push(elapsedMs);
    this.statusDistribution[response.httpStatus] = (this.statusDistribution[response.httpStatus] ?? 0) + 1;

    return response;
  }

  get metrics(): StrategyMetrics {
    return {
      calls: this.calls,
      statusDistribution: { ...this.statusDistribution },
      latenciesMs: [...this.latenciesMs],
      storeRoundTrips: this.roundTripCounter.count,
    };
  }

  reset(): void {
    this.calls = 0;
    this.roundTripCounter.count = 0;
    this.latenciesMs.length = 0;
    for (const key of Object.keys(this.statusDistribution)) {
      delete this.statusDistribution[Number(key)];
    }
  }
}

export function percentile(sortedMs: readonly number[], p: number): number {
  if (sortedMs.length === 0) return 0;
  const index = Math.min(sortedMs.length - 1, Math.floor(sortedMs.length * p));
  return sortedMs[index] ?? 0;
}
