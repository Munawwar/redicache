/* eslint-disable no-console */
let redisClient;

async function fetchFromRemoteCache(cacheKey) {
  let val;
  try {
    val = redisClient.getAsync(cacheKey);
  } catch (err) {
    console.warn('Error while fetching value from remote cache, for key', cacheKey, ':', err.message);
  }
  if (typeof val === 'string') {
    try {
      return JSON.parse(val);
    } catch (err) {
      console.warn('Could not JSON parse the remote cached value for key', cacheKey, ':', err.message);
    }
  }
  return undefined;
}

async function fetchTTLFromRemoteCache(cacheKey) {
  let val;
  try {
    val = redisClient.ttlAsync(cacheKey);
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

async function saveToRemoteCache(cacheKey, value, expiryTimeInSec) {
  if (value === undefined) {
    console.warn('Cannot save undefined value to remote cache for key', cacheKey);
    return false;
  }
  if (expiryTimeInSec === undefined) {
    console.warn('Cannot save undefined expiry time to remote cache for key', cacheKey);
    return false;
  }
  if (expiryTimeInSec < 0) {
    console.warn('Expiry time cannot be negative for local cache key', cacheKey);
    return false;
  }
  try {
    let ttlParams = [];
    if (expiryTimeInSec !== Infinity) {
      ttlParams = ['EX', expiryTimeInSec];
    }
    return redisClient.setAsync(
      cacheKey,
      JSON.stringify(value),
      ...ttlParams,
    );
  } catch (err) {
    console.warn('Could not save to remote cache for key', cacheKey, ':', err.message);
    return false;
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
