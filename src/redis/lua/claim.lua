-- claim.lua: atomic read-modify-write for the NEW -> PENDING transition,
-- with fingerprint checking and self-healing lease expiry baked in.
--
-- KEYS[1] = idempotency key's Redis hash
-- ARGV[1] = fingerprint (hash of the request body)
-- ARGV[2] = leaseMs (how long a PENDING claim is honored before it's
--           considered abandoned and reclaimable)
-- ARGV[3] = nowMs
-- ARGV[4] = claimToken (caller-generated fencing token for this attempt)
-- ARGV[5] = "1" or "0" -- whether a FAILED key may be reclaimed and retried
--
-- Returns one of:
--   {"CLAIMED", claimToken}
--   {"PENDING", retryAfterMs}
--   {"COMPLETED", httpStatus, body}
--   {"FAILED", httpStatus, body}
--   {"MISMATCH"}

local key = KEYS[1]
local fingerprint = ARGV[1]
local leaseMs = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local claimToken = ARGV[4]
local failedRetryable = ARGV[5] == "1"

local function claimFresh()
  redis.call("HSET", key,
    "state", "PENDING",
    "fingerprint", fingerprint,
    "claimToken", claimToken,
    "claimedAtMs", now)
  redis.call("HDEL", key, "httpStatus", "body")
  return {"CLAIMED", claimToken}
end

local state = redis.call("HGET", key, "state")

if not state then
  return claimFresh()
end

local storedFingerprint = redis.call("HGET", key, "fingerprint")
if storedFingerprint ~= fingerprint then
  return {"MISMATCH"}
end

if state == "PENDING" then
  local claimedAt = tonumber(redis.call("HGET", key, "claimedAtMs"))
  if now - claimedAt >= leaseMs then
    -- Lease expired: whoever held it crashed or never finished. Reclaim
    -- with a fresh fencing token so a late write from the old claim
    -- can't clobber this attempt's result.
    return claimFresh()
  end
  local retryAfterMs = leaseMs - (now - claimedAt)
  return {"PENDING", tostring(retryAfterMs)}
end

if state == "COMPLETED" then
  local httpStatus = redis.call("HGET", key, "httpStatus")
  local body = redis.call("HGET", key, "body")
  return {"COMPLETED", httpStatus, body}
end

if state == "FAILED" then
  if failedRetryable then
    return claimFresh()
  end
  local httpStatus = redis.call("HGET", key, "httpStatus")
  local body = redis.call("HGET", key, "body")
  return {"FAILED", httpStatus, body}
end

return redis.error_reply("claim.lua: unknown state '" .. tostring(state) .. "'")
