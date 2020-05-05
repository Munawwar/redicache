const localCache = require('./localCache');
const remoteCache = require('./remoteCache');

async function refreshLocalCacheForKey(cacheKey) {
  const [val, ttlInSec] = await Promise.all([
    remoteCache.fetch(cacheKey),
    remoteCache.fetchTTL(cacheKey),
  ]);
  if (val !== undefined && ttlInSec) {
    localCache.save(cacheKey, val, ttlInSec);
    return val;
  }
  return undefined;
}

module.exports = refreshLocalCacheForKey;
