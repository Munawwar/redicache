
function getLockKey(cacheKey) {
  return `cachelock::${cacheKey}`;
}

module.exports = getLockKey;
