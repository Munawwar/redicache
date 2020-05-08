/* eslint-disable no-console */
const cloneDeep = require('clone-deep');

const inMemCache = {};

function fetchFromLocalCache(cacheKey) {
  const val = (inMemCache[cacheKey] || {}).value;
  if (val && typeof val === 'object') {
    return cloneDeep(val);
  }
  return val;
}

function saveToLocalCache(cacheKey, value, expiryTimeInSec) {
  if (value === undefined) {
    console.warn('Cannot save undefined value to local cache for key', cacheKey);
    return { success: false };
  }
  if (expiryTimeInSec === undefined) {
    console.warn('Cannot save undefined expiry time to local cache for key', cacheKey);
    return { success: false };
  }
  if (expiryTimeInSec < 0) {
    console.warn('Expiry time cannot be negative for local cache key', cacheKey);
    return { success: false };
  }
  clearTimeout((inMemCache[cacheKey] || {}).timer);
  inMemCache[cacheKey] = {
    value,
    timer: expiryTimeInSec !== Infinity
      ? setTimeout(() => {
        delete inMemCache[cacheKey];
      }, expiryTimeInSec * 1000)
      : null,
  };
  return { success: true };
}

module.exports = {
  fetch: fetchFromLocalCache,
  save: saveToLocalCache,
};
