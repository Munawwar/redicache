# redicache
Work in progress - Two level caching strategy - Redis + Local (in process memory) - for node.js

Caching works across any number of node.js processes regardless of architecture as long as they can connect to a common redis cluster (library uses redis pubsub and redlock).

(Why "redicache"? It sounds like "ready cache".. doesn't it? 🤷‍♂️)

Note: If you are using redis 2.x, then switch to version 2.8+, as there are issues with TTL command in lower versions.

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

  // note that if you return nothing (undefined), then library will not
  // cache it. you need to send back a non-undefined value for caching.
};

const cacheKey = 'cms::homepage'; // good practice to namespace it, since redis is global
const cacheExpiryTimeInSeconds = Infinity; // never expire
// alternatively you can set expiry to any number of seconds
const valueOrError = await redicache.getOrInitCache(
  cacheKey,
  fetchHomePage,
  cacheExpiryTimeInSeconds,
);
// you can differentiate error from value using an instanceof check.
// if (valueOrError instanceof Error) { /* ... */ }

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

## Limitations

1. Redis (and redlock) doesn't have fencing tokens. So potentially an older values can overwrite remote cache if write-lock expires while computing the new value to be saved. If that is a problem for your use-case then don't use this lib (and redis for locks). The approach isn't bullet-proof, but is of best effort. In many cases, this is an acceptable trade-off.

2. Currently if redis is detected to be down, then library will fetch latest value and save in local cache. Which means multiple processes could potentially request for fresh values parallelly. If this is too expensive to deal with, then currently there is no config to change this behavior.

3. Library makes some sane assumptions like, assuming system clock always moves forward. So if your host system clock is reset back by time, then expect the most unexpected things to happen.