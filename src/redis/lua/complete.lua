-- complete.lua: atomic PENDING -> COMPLETED|FAILED transition, fenced by
-- claim token so a write from a claim that's since been superseded (its
-- lease expired and someone else reclaimed the key) can never clobber
-- the newer attempt's result.
--
-- KEYS[1] = idempotency key's Redis hash
-- ARGV[1] = claimToken (must match the token this claim was made with)
-- ARGV[2] = newState ("COMPLETED" or "FAILED")
-- ARGV[3] = httpStatus
-- ARGV[4] = body (JSON string)
-- ARGV[5] = retentionSec (how long the completed record is kept)
--
-- Returns {"OK"} or {"STALE"} (write was fenced off, no-op).

local key = KEYS[1]
local claimToken = ARGV[1]
local newState = ARGV[2]
local httpStatus = ARGV[3]
local body = ARGV[4]
local retentionSec = tonumber(ARGV[5])

local storedToken = redis.call("HGET", key, "claimToken")
if storedToken ~= claimToken then
  return {"STALE"}
end

redis.call("HSET", key,
  "state", newState,
  "httpStatus", httpStatus,
  "body", body)
redis.call("EXPIRE", key, retentionSec)

return {"OK"}
