CREATE TABLE IF NOT EXISTS idempotency_keys (
  key TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  -- Fencing token, mirroring the Redis lifecycle's claimToken: identifies
  -- *which* claim attempt owns this row, so a stale write from a claim
  -- that's since been reclaimed (its staleness window elapsed) can be
  -- rejected instead of clobbering a fresher attempt's result.
  claim_token TEXT NOT NULL,
  response_status INT,
  response_body JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS charges (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL REFERENCES idempotency_keys(key),
  amount BIGINT NOT NULL,
  currency TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
