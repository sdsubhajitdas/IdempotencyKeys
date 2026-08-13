/**
 * Thrown when a claim's completion write is rejected because the claim
 * was superseded (its lease/staleness window elapsed and someone else
 * reclaimed the key) before this attempt could persist its result. The
 * external charge has already happened by this point — fencing stops
 * the stale write from corrupting the newer claimant's state, but it
 * cannot undo the charge. Two claimants both believing they were "the"
 * owner of a key, both charging, is the actual failure; this error is
 * how it becomes visible instead of silently returning success. See
 * README "What this repo does not solve."
 */
export class StaleClaimError extends Error {
  constructor(key: string) {
    super(
      `claim for key "${key}" was superseded before its result could be persisted — ` +
        `the gateway charge already happened and this write was rejected to avoid ` +
        `corrupting the newer claim's state. A duplicate charge may have occurred; ` +
        `this requires reconciliation, not a retry.`,
    );
    this.name = "StaleClaimError";
  }
}
