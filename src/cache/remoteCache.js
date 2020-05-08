/* eslint-disable no-console */
let redisClient;

function parseValue(val, cacheKey) {
  if (typeof val === 'string') {
    try {
      return JSON.parse(val);
    } catch (err) {
      console.warn('Could not JSON parse the remote cached value for key', cacheKey, ':', err.message);
    }
  }
  return undefined;
}

/**
 * @param {String} cacheKey
 */
async function fetchFromRemoteCache(cacheKey) {
  let val;
  try {
    val = await redisClient.getAsync(cacheKey);
  } catch (err) {
    console.warn('Error while fetching value from remote cache, for key', cacheKey, ':', err.message);
  }
  return parseValue(val, cacheKey);
}

async function fetchTTLFromRemoteCache(cacheKey) {
  let val;
  try {
    val = await redisClient.ttlAsync(cacheKey);
  } catch (err) {
    console.warn('Error while fetching value from remote cache, for key', cacheKey, ':', err.message);
  }
  if (val === -1) {
    return Infinity;
  }
  if (val > 0) {
    return val;
  }
  // if val -2, then key doesn't exists
  return undefined;
}

// set a key,ttl if key does not exists.
// if it does exist return then existing value
// redis scripts work like excusive atomic operations/transactions
// result is in form "<success>|<current value>" string
const setIfNotExistsOrGetKeyLuaScript = `
local newValue = ARGV[1]
local ttl = ARGV[2]
local result
if ttl == nil then
  result = redis.call("set", KEYS[1], newValue, "NX")
else
  result = redis.call("set", KEYS[1], newValue, "NX", "EX", ttl)
end

if result == false then
  local currentValue = redis.call("get", KEYS[1])
  return "false|" .. currentValue
else
  return "true|"
end
`;

async function saveToRemoteCache(cacheKey, value, expiryTimeInSec, overwrite = false) {
  if (value === undefined) {
    console.warn('Cannot save undefined value to remote cache for key', cacheKey);
    return { success: false };
  }
  if (typeof expiryTimeInSec !== 'number') {
    console.warn('Cannot use non-numeric expiry time on remote cache for key', cacheKey);
    return { success: false };
  }
  if (expiryTimeInSec < 0) {
    console.warn('Expiry time cannot be negative for local cache key', cacheKey);
    return { success: false };
  }
  try {
    if (!overwrite) {
      const result = await redisClient.evalAsync(
        setIfNotExistsOrGetKeyLuaScript,
        1,
        cacheKey,
        JSON.stringify(value),
        ...(expiryTimeInSec !== Infinity ? [expiryTimeInSec] : []),
      );
      // split "bool|json" string
      const [, success, currentValueStr] = result.match(/^([^|]+)\|(.*)$/);
      if (success === 'false') {
        return {
          success: false,
          currentValue: parseValue(currentValueStr, cacheKey),
        };
      }
      return { success: true };
    }
    // if overwrite = true then
    const result = redisClient.setAsync(
      cacheKey,
      JSON.stringify(value),
      ...(expiryTimeInSec !== Infinity ? ['EX', expiryTimeInSec] : []),
    );
    return { success: (result === 'OK') };
  } catch (err) {
    console.warn('Could not save to remote cache for key', cacheKey, ':', err.message);
    return { success: false };
  }
}

module.exports = {
  init: (_redisClient) => {
    redisClient = _redisClient;
  },
  fetch: fetchFromRemoteCache,
  fetchTTL: fetchTTLFromRemoteCache,
  save: saveToRemoteCache,
};
