import { RedisClient } from "bun";
import { PaymentGateway } from "../src/gateway/payment-gateway";
import { NoIdempotency } from "../src/strategies/no-idempotency";
import { NaiveCheckThenSet } from "../src/strategies/naive-check-then-set";
import { SetNxClaim } from "../src/strategies/set-nx-claim";
import { LifecycleRedis } from "../src/strategies/lifecycle";
import { PostgresTransactional } from "../src/strategies/postgres-transactional";
import { createSql, ensureSchema } from "../src/db/client";
import type { IdempotencyStrategy, PaymentRequest } from "../src/types";

const PORT = Number(process.env.PORT ?? 3000);
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const DEFAULT_STRATEGY = process.env.IDEMPOTENCY_STRATEGY ?? "lifecycle";

const gateway = new PaymentGateway();
const redis = new RedisClient(REDIS_URL);
const sql = createSql();
await ensureSchema(sql);

// More strategies are registered here as later phases land — the demo
// server only ever grows this map, never branches on strategy identity.
const strategies: Record<string, IdempotencyStrategy> = {
  none: new NoIdempotency(gateway),
  naive: new NaiveCheckThenSet(redis, gateway, { prefix: "demo:naive" }),
  "set-nx": new SetNxClaim(redis, gateway, { prefix: "demo:setnx" }),
  lifecycle: new LifecycleRedis(redis, gateway, { prefix: "demo:lifecycle" }),
  postgres: new PostgresTransactional(sql, gateway),
};

function isPaymentRequest(value: unknown): value is PaymentRequest {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.amount === "number" && typeof v.currency === "string" && typeof v.customerId === "string";
}

Bun.serve({
  port: PORT,
  routes: {
    "/strategies": () => Response.json({ available: Object.keys(strategies), default: DEFAULT_STRATEGY }),

    "/payments": {
      POST: async (req) => {
        const strategyName = new URL(req.url).searchParams.get("strategy") ?? DEFAULT_STRATEGY;
        const strategy = strategies[strategyName];
        if (!strategy) {
          return Response.json({ error: `unknown strategy: ${strategyName}` }, { status: 400 });
        }

        const idempotencyKey = req.headers.get("Idempotency-Key");
        if (!idempotencyKey) {
          return Response.json({ error: "Idempotency-Key header is required" }, { status: 400 });
        }

        const body = await req.json().catch(() => null);
        if (!isPaymentRequest(body)) {
          return Response.json({ error: "body must be { amount, currency, customerId }" }, { status: 400 });
        }

        const result = await strategy.handle(idempotencyKey, body);
        const init: ResponseInit =
          result.retryAfterSec !== undefined
            ? { status: result.httpStatus, headers: { "Retry-After": String(result.retryAfterSec) } }
            : { status: result.httpStatus };
        return Response.json(result.body, init);
      },
    },
  },
});

console.log(`idempotency-keys demo listening on http://localhost:${PORT}`);
console.log(`default strategy: ${DEFAULT_STRATEGY} (?strategy= to override)`);
