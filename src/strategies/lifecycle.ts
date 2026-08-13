import type { RedisClient } from "bun";
import type { PaymentGateway } from "../gateway/payment-gateway";
import type { IdempotencyStrategy, PaymentRequest, PaymentResponse } from "../types";
import { fingerprintRequest } from "../fingerprint";
import { StaleClaimError } from "../errors";
import { LuaScript } from "../redis/script-loader";
import claimLua from "../redis/lua/claim.lua" with { type: "text" };
import completeLua from "../redis/lua/complete.lua" with { type: "text" };

export interface LifecycleOptions {
  prefix?: string;
  /** How long a PENDING claim is honored before it self-heals. Default 30s. */
  leaseMs?: number;
  /** How long a COMPLETED/FAILED record is kept. Default 24h, matching Stripe's retention window. */
  retentionSec?: number;
  /**
   * Whether a FAILED key accepts a fresh claim and retry. Default true —
   * see README for the rationale (a transient decline shouldn't
   * permanently burn the customer's ability to pay).
   */
  failedIsRetryable?: boolean;
  /** Test-only: fires right after a successful claim, before the gateway is charged. */
  onClaimed?: (claimToken: string) => void | Promise<void>;
  /** Test-only: throws right after a successful claim, before charging — simulated crash. */
  injectAfterClaim?: boolean;
  /** Test-only: makes the gateway call fail deterministically (simulated decline), exercising the FAILED state. */
  injectChargeFailure?: boolean;
  /** Test-only: throws after the charge succeeds but before the completion write — simulated store failure. */
  injectAfterCharge?: boolean;
}

type ClaimReply =
  | ["CLAIMED", string]
  | ["PENDING", string]
  | ["COMPLETED", string, string]
  | ["FAILED", string, string]
  | ["MISMATCH"];

const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_RETENTION_SEC = 24 * 60 * 60;

const claimScript = new LuaScript(claimLua);
const completeScript = new LuaScript(completeLua);

/**
 * The fix: NEW -> PENDING -> COMPLETED|FAILED, atomic via Lua
 * (claim.lua / complete.lua, run through EVALSHA via LuaScript's
 * NOSCRIPT-reload pattern). PENDING carries a lease so
 * a crash self-heals instead of poisoning the key; a concurrent claim
 * against a live PENDING gets 409 + Retry-After; a claim against
 * COMPLETED replays the stored response verbatim; a fingerprint mismatch
 * on the same key gets 422, independent of state.
 */
export class LifecycleRedis implements IdempotencyStrategy {
  readonly name = "lifecycle";
  private readonly prefix: string;
  private readonly leaseMs: number;
  private readonly retentionSec: number;
  private readonly failedIsRetryable: boolean;
  private readonly onClaimed?: ((claimToken: string) => void | Promise<void>) | undefined;
  private readonly injectAfterClaim: boolean;
  private readonly injectChargeFailure: boolean;
  private readonly injectAfterCharge: boolean;

  constructor(
    private readonly redis: RedisClient,
    private readonly gateway: PaymentGateway,
    options: LifecycleOptions = {},
  ) {
    this.prefix = options.prefix ?? "lifecycle";
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this.retentionSec = options.retentionSec ?? DEFAULT_RETENTION_SEC;
    this.failedIsRetryable = options.failedIsRetryable ?? true;
    this.onClaimed = options.onClaimed;
    this.injectAfterClaim = options.injectAfterClaim ?? false;
    this.injectChargeFailure = options.injectChargeFailure ?? false;
    this.injectAfterCharge = options.injectAfterCharge ?? false;
  }

  async handle(key: string, request: PaymentRequest): Promise<PaymentResponse> {
    const redisKey = `${this.prefix}:${key}`;
    const fingerprint = fingerprintRequest(request);
    const claimToken = crypto.randomUUID();
    const now = Date.now();

    const reply = (await claimScript.run(
      this.redis,
      [redisKey],
      [fingerprint, this.leaseMs, now, claimToken, this.failedIsRetryable ? "1" : "0"],
    )) as ClaimReply;

    const [status] = reply;

    if (status === "MISMATCH") {
      return {
        httpStatus: 422,
        body: { status: "invalid", error: "idempotency key was reused with a different request body" },
      };
    }

    if (status === "PENDING") {
      const retryAfterMs = Number(reply[1]);
      return {
        httpStatus: 409,
        body: { status: "conflict", error: "a request with this idempotency key is already in progress" },
        retryAfterSec: Math.ceil(retryAfterMs / 1000),
      };
    }

    if (status === "COMPLETED" || status === "FAILED") {
      return { httpStatus: Number(reply[1]), body: JSON.parse(reply[2]) };
    }

    // status === "CLAIMED" — we own this key now, via claimToken.
    if (this.onClaimed) {
      await this.onClaimed(claimToken);
    }
    if (this.injectAfterClaim) {
      throw new Error("simulated crash after claim, before charge");
    }

    let response: PaymentResponse;
    if (this.injectChargeFailure) {
      response = { httpStatus: 402, body: { status: "failed", error: "simulated gateway decline" } };
      await this.persistCompletion(redisKey, key, claimToken, "FAILED", response);
      return response;
    }

    const charge = await this.gateway.charge(request, key);
    response = {
      httpStatus: 201,
      body: {
        status: "succeeded",
        chargeId: charge.chargeId,
        amount: charge.amount,
        currency: charge.currency,
      },
    };

    if (this.injectAfterCharge) {
      throw new Error("simulated failure between charge success and persisting the result");
    }

    await this.persistCompletion(redisKey, key, claimToken, "COMPLETED", response);
    return response;
  }

  /**
   * Runs complete.lua and checks its reply. A "STALE" reply means this
   * claim's lease expired and someone else reclaimed the key before we
   * got here — complete.lua correctly refused to overwrite their fresher
   * state, but by this point we've already charged the gateway (for the
   * COMPLETED case) or already told the caller their decline was final
   * (for FAILED). Silently returning success here would hide a real
   * double charge; throwing makes it visible instead. See StaleClaimError.
   */
  private async persistCompletion(
    redisKey: string,
    key: string,
    claimToken: string,
    newState: "COMPLETED" | "FAILED",
    response: PaymentResponse,
  ): Promise<void> {
    const [outcome] = (await completeScript.run(
      this.redis,
      [redisKey],
      [claimToken, newState, response.httpStatus, JSON.stringify(response.body), this.retentionSec],
    )) as ["OK"] | ["STALE"];

    if (outcome === "STALE") {
      throw new StaleClaimError(key);
    }
  }
}
