import type { SQL } from "bun";
import type { ChargeResult, PaymentGateway } from "../gateway/payment-gateway";
import type { IdempotencyStrategy, PaymentRequest, PaymentResponse } from "../types";
import { fingerprintRequest } from "../fingerprint";

export interface PostgresTransactionalOptions {
  /** How long a pending claim is considered abandoned and reclaimable. Default 30s, mirroring the Redis lease. */
  staleAfterMs?: number;
  /**
   * Whether a failed key accepts a fresh claim and retry. Default true,
   * matching the Redis lifecycle's policy — see README for the
   * rationale.
   */
  failedIsRetryable?: boolean;
  /** Test-only: fires right after a successful claim, before the gateway is charged. */
  onClaimed?: (key: string) => void | Promise<void>;
  /** Test-only: throws right after a successful claim, before charging — simulated crash. */
  injectAfterClaim?: boolean;
  /** Test-only: makes the gateway call fail deterministically, exercising the 'failed' status. */
  injectChargeFailure?: boolean;
  /**
   * Test-only: throws after the gateway charge succeeds but before the
   * completion transaction commits — the injection this phase exists to
   * run, comparable to the Redis lifecycle's injectAfterCharge.
   */
  injectAfterCharge?: boolean;
}

interface IdempotencyRow {
  key: string;
  fingerprint: string;
  status: "pending" | "completed" | "failed";
  claim_token: string;
  response_status: number | null;
  response_body: string | null;
  created_at: string;
}

interface ClaimAttemptRow extends IdempotencyRow {
  won: boolean;
}

type ClaimOutcome = { claimed: true } | { claimed: false; response: PaymentResponse };

const DEFAULT_STALE_AFTER_MS = 30_000;

/**
 * The Postgres alternative: a unique constraint on the idempotency key,
 * completed in the same transaction as the charge record via sql.begin.
 * Structured to mirror the Redis lifecycle as closely as SQL allows —
 * same claim/charge/persist shape, same fencing-token idea (claim_token
 * here instead of Redis's claimToken), same staleness-window self-heal
 * for an abandoned pending claim — so the two are actually comparable
 * under Phase 4's failure injection instead of measuring two unrelated
 * designs. See README for what this strategy does and does not fix.
 */
export class PostgresTransactional implements IdempotencyStrategy {
  readonly name = "postgres-transactional";
  private readonly staleAfterMs: number;
  private readonly failedIsRetryable: boolean;
  private readonly onClaimed?: ((key: string) => void | Promise<void>) | undefined;
  private readonly injectAfterClaim: boolean;
  private readonly injectChargeFailure: boolean;
  private readonly injectAfterCharge: boolean;

  constructor(
    private readonly sql: SQL,
    private readonly gateway: PaymentGateway,
    options: PostgresTransactionalOptions = {},
  ) {
    this.staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    this.failedIsRetryable = options.failedIsRetryable ?? true;
    this.onClaimed = options.onClaimed;
    this.injectAfterClaim = options.injectAfterClaim ?? false;
    this.injectChargeFailure = options.injectChargeFailure ?? false;
    this.injectAfterCharge = options.injectAfterCharge ?? false;
  }

  async handle(key: string, request: PaymentRequest): Promise<PaymentResponse> {
    const fingerprint = fingerprintRequest(request);
    const claimToken = crypto.randomUUID();

    const outcome = await this.tryClaim(key, fingerprint, claimToken);
    if (!outcome.claimed) {
      return outcome.response;
    }

    if (this.onClaimed) {
      await this.onClaimed(key);
    }
    if (this.injectAfterClaim) {
      throw new Error("simulated crash after claim, before charge");
    }

    if (this.injectChargeFailure) {
      const response: PaymentResponse = { httpStatus: 402, body: { status: "failed", error: "simulated gateway decline" } };
      await this.persist(key, claimToken, "failed", response);
      return response;
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

    if (this.injectAfterCharge) {
      // The external call already happened — this simulates the DB
      // connection dying (or the process crashing) between "charge
      // succeeded" and "transaction commits." The gateway call can't
      // live inside the transaction (you can't roll back a real HTTP
      // charge by throwing in Postgres), so this gap exists regardless
      // of DB choice — see README "what this repo does not solve."
      throw new Error("simulated failure between charge success and transaction commit");
    }

    await this.persist(key, claimToken, "completed", response, charge);
    return response;
  }

  private async tryClaim(key: string, fingerprint: string, claimToken: string): Promise<ClaimOutcome> {
    // One round trip instead of an INSERT-then-SELECT: attempt the claim
    // and, if it loses, fall back to reading the existing row, all in a
    // single statement. Under real concurrency (see tests/phase4-postgres
    // .test.ts's 50-concurrent-request case) a second round trip per
    // losing request is enough extra connection-pool queueing delay for
    // some requests' staleness check to fire against a claim that's only
    // milliseconds old, not actually abandoned — a false-positive reclaim
    // that duplicate-charges. Cutting straight to a "did I win, and if
    // not, what's there" read removes that window entirely rather than
    // widening the staleness threshold to paper over it.
    const [row] = await this.sql<ClaimAttemptRow[]>`
      WITH ins AS (
        INSERT INTO idempotency_keys (key, fingerprint, status, claim_token)
        VALUES (${key}, ${fingerprint}, 'pending', ${claimToken})
        ON CONFLICT (key) DO NOTHING
        RETURNING *
      )
      SELECT *, true AS won FROM ins
      UNION ALL
      SELECT *, false AS won FROM idempotency_keys WHERE key = ${key} AND NOT EXISTS (SELECT 1 FROM ins)
    `;

    if (!row) {
      // Existed a moment ago (the INSERT conflicted), gone now — e.g. a
      // concurrent attempt's transaction rolled back between our INSERT
      // and the fallback SELECT. Retry the claim once against the now-clear key.
      return this.tryClaim(key, fingerprint, claimToken);
    }
    if (row.won) {
      return { claimed: true };
    }

    if (row.fingerprint !== fingerprint) {
      return {
        claimed: false,
        response: {
          httpStatus: 422,
          body: { status: "invalid", error: "idempotency key was reused with a different request body" },
        },
      };
    }

    if (row.status === "completed") {
      return {
        claimed: false,
        response: { httpStatus: row.response_status ?? 500, body: JSON.parse(row.response_body ?? "{}") },
      };
    }

    if (row.status === "failed") {
      if (!this.failedIsRetryable) {
        return {
          claimed: false,
          response: { httpStatus: row.response_status ?? 500, body: JSON.parse(row.response_body ?? "{}") },
        };
      }
      return this.reclaim(key, fingerprint, claimToken, row);
    }

    // status === "pending"
    const ageMs = Date.now() - new Date(row.created_at).getTime();
    if (ageMs < this.staleAfterMs) {
      return {
        claimed: false,
        response: {
          httpStatus: 409,
          body: { status: "conflict", error: "a request with this idempotency key is already in progress" },
          retryAfterSec: Math.ceil((this.staleAfterMs - ageMs) / 1000),
        },
      };
    }

    // Stale pending claim: abandoned, self-heal by reclaiming it.
    return this.reclaim(key, fingerprint, claimToken, row);
  }

  /**
   * Reclaims a FAILED or stale-PENDING row, fenced on the claim_token we
   * just read still being current — if it isn't, someone else reclaimed
   * this key between our SELECT and this UPDATE, so we re-check from
   * scratch instead of overwriting their claim.
   */
  private async reclaim(
    key: string,
    fingerprint: string,
    claimToken: string,
    row: IdempotencyRow,
  ): Promise<ClaimOutcome> {
    const reclaimed = await this.sql<IdempotencyRow[]>`
      UPDATE idempotency_keys
      SET fingerprint = ${fingerprint},
          status = 'pending',
          claim_token = ${claimToken},
          created_at = now(),
          response_status = NULL,
          response_body = NULL,
          completed_at = NULL
      WHERE key = ${key} AND claim_token = ${row.claim_token}
      RETURNING *
    `;
    if (reclaimed.length === 0) {
      return this.tryClaim(key, fingerprint, claimToken);
    }
    return { claimed: true };
  }

  private async persist(
    key: string,
    claimToken: string,
    status: "completed" | "failed",
    response: PaymentResponse,
    charge?: ChargeResult,
  ): Promise<void> {
    await this.sql.begin(async (tx) => {
      if (charge) {
        await tx`
          INSERT INTO charges (id, idempotency_key, amount, currency)
          VALUES (${charge.chargeId}, ${key}, ${charge.amount}, ${charge.currency})
        `;
      }
      await tx`
        UPDATE idempotency_keys
        SET status = ${status}, response_status = ${response.httpStatus}, response_body = ${JSON.stringify(response.body)}, completed_at = now()
        WHERE key = ${key} AND claim_token = ${claimToken}
      `;
    });
  }
}
