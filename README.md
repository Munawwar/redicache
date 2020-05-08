# redicache
Two level caching strategy - Redis + Local (in process memory) - for storing important boot-time meta-data/dynamic configs - for node.js

Caching works across any number of node.js processes regardless of architecture as long as they can connect to a common redis cluster (library uses redis pubsub and redlock).

(Why "redicache"? It sounds like "ready cache".. doesn't it? 🤷‍♂️)

Note: If you are using redis 2.x, then switch to version 2.8+, as there are issues with TTL command in lower versions.

## Usage

```js
const redicache = require('redicache');

// create redis client. please read 'redis' npm package's documentation for this.
const redis = require('redis');
const redisClient = redis.createClient({ /* ... */ });
const subscriberRedisClient = redis.createClient({ /* ... */ });

redicache.init(redisClient, subscriberRedisClient);
// redicache is a singleton. you can't initialize again

const fetchHomePage = async () => {
  // code to fetch CMS home page..

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

1. There is no memory cap/max limit for local cache. If you store too much in the cache (which is in-process memory), your process/node.js could crash. This is not exactly a limitation, but something to be aware of.
redicache's primary design intention is for storing boot time configs/meta data which I assume is small (yet critical to run your app), and not built to cache high volumes of user data or the like.

2. Currently if redis is detected to be down, then library will fetch latest value and save it in local cache. Which means multiple processes could potentially request for fresh values parallelly. If this is too expensive to deal with, then currently there is no config to change this behavior. In future, I might add a way to configure to return stale value instead of fetching fresh.

Also once redis comes back up, processes could have ended up with different values in their local cache.

3. Before requesting for fresh value for caching, redicache acquires a write-lock for the cache key on redis. If your fetch function never completes (or doesn't resolve promise) and runs indefinately then write-lock will never get released (Turing halting problem.. which has no solution).

## Design Considerations

redicache is built with certain assumptions in mind:

1. that it is super expensive operation to request for fresh value to be cached. So redicache tries to minmize requests for fresh value, across all processes in the system. Hence you see the usage of distributed locks to prevent two processes/requests from requesting for fresh value (unless redis lock service is down).

2. the cached values are important for the functioning of your server. Therefore at no point should redicache delete a remote cache entry first and then request for fresh value.. this could bring down your server. Redicache requests fresh data, and then overwrites the exisitng cached value. This is a more resilient/robust approach.

