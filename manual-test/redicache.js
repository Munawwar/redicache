/* eslint-disable no-underscore-dangle */

const redis = require('redis');
const bb = require('bluebird');
const redicache = require('../src/');

const redisClient = redis.createClient({});
const subscriberRedisClient = redis.createClient({});

redicache.init(redisClient, subscriberRedisClient);

const fetchHomePage = async () => { console.log('fetching...'); await bb.delay(5000); return { life: 42 }; };
const cacheKey = 'cms::homepage'; // good practice to namespace it, since redis is global
const cacheExpiryTimeInSeconds = 10;
(async () => {
  const results = await Promise.all([
    redicache._getOrInitCache(
      cacheKey,
      fetchHomePage,
      cacheExpiryTimeInSeconds,
    ),
    redicache._getOrInitCache(
      cacheKey,
      fetchHomePage,
      cacheExpiryTimeInSeconds,
    ),
  ]);
  console.log(results);
})();

// output expected
// fetching...
// [{ life: 42 }, { life 42 }]


// (async () => {
//   const results = await Promise.all([
//     redicache.attemptCacheRegeneration(
//       cacheKey,
//       fetchHomePage,
//       cacheExpiryTimeInSeconds,
//     ),
//     redicache.attemptCacheRegeneration(
//       cacheKey,
//       fetchHomePage,
//       cacheExpiryTimeInSeconds,
//     ),
//   ]);
//   console.log(results);
// })();

// output expected
// [{ life: 42 }, Error: another process has acquired lock or redis is down]
