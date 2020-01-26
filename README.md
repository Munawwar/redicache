# redicache
Work in progress - Two level caching strategy - Redis + Local (in process memory) - for node.js

Caching works across any number of node.js processes regardless of architecture as long as they can connect to a common redis cluster (library uses redis pubsub and redlock).

(Why "redicache"? It sounds like "ready cache".. doesn't it? 🤷‍♂️)

Note: If you are using redis 2.x use version 2.8+, as there are issues with TTL command in lower versions.

## Usage

```js
const redicache = require('redicache');

// create redis client. please read 'redis' npm package's documentation for this.
const redis = require('redis');
const redisClient = redis.createClient({
  // ...
});

redicache.init(redisClient);
// redicache is a singleton. you can't initialize again

const fetchHomePage = async () => {
  // code to fetch CMS home page if it is not in cache already
  // and then return it.
};

const cacheKey = 'cms::homepage'; // good practice to namespace it, since redis is global
const cacheExpiryTimeInSeconds = Infinity; // never expire
// alternatively you can set expiry to any number of seconds
const valueOrError = await redicache.getOrInitCache(
  cacheKey,
  fetchHomePage,
  cacheExpiryTimeInSeconds,
);

// if you cache for unlimited duration of time, you need a way to refresh
// it by API (without causing home page downtime)
const newValueOrError = await redicache.attemptCacheRegeneration(
  cacheKey,
  fetchHomePage,
  cacheExpiryTimeInSeconds,
);

// name of attemptCacheRegeneration() is funny right? reason is, if another process is
// running getOrInitCache() and has locked cache key for write purpose, then
// attemptCacheRegeneration will fail (why? because, the process is already refreshing
// the cache so why do it again?)
```