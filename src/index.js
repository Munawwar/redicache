/* eslint-disable no-console */

// 2 level cacher
// Level 1 - in process memory
// Level 2 - redis

const Redlock = require('redlock');
const bluebird = require('bluebird');

const localCache = require('./localCache');
const remoteCache = require('./remoteCache');

// the default expiry time if expiry is not specified.
const defaultExpiryInSec = 60 * 60; // 1 hour

// lockTime has to be greater than the worst-case blocking duration..
// like a super long GC pause or CPU intensive tight loop. 10 mins?
const CACHE_LOCK_TTL = 10 * 60 * 1000; // 10 mins
const CACHE_LOCK_EXTENSION_TTL = 30 * 1000; // 30 secs

let redisClient;
let retryForeverLock;
let tryOnceLock;

async function refreshLocalCacheFromRemoteCache(cacheKey) {
  // if not found, check in remote cache
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

function signalOthersProcessesToRefreshLocalCache(cacheKey) {
  // tell other processes to that their L1 cache could be stale
  // why could be? because redis pub-sub doesn't guarentee receiver
  // to receive messages exactly as order of messages sent.
  // However it doesn't matter if command is respected always
  redisClient.publish(
    'cacheChannel',
    JSON.stringify({
      command: 'refreshYourLocalCacheFromRemoteCache',
      cacheKey,
    }),
  );
}

const getLockKey = (cacheKey) => `cachelock::${cacheKey}`;

function unlock(lock, lockKey) {
  return lock.unlock()
    .catch((err) => console.warn('Could not release redis cache lock', lockKey, ':', err.message));
}

// FIXME: currently if redis is down, each process will call fetchLatestValue()
// independently and parellely and could be prohibitively expensive.
// In those cases, maybe returning the old cache value and serving potentially stale
// value is better.
// Or alternatively use a 3rd data store to mock the data or fetch stale data
// - like a filesystem with stored mock/stale data. hmmmm....
async function redisDownCase(cacheKey, fetchLatestValue, expiryTimeInSec) {
  let latestValue;
  try {
    latestValue = await fetchLatestValue();
  } catch (err) {
    console.warn('getOrInitCache: could not compute latest cache value for', cacheKey, ':', err.message);
  }
  if (latestValue !== undefined) {
    localCache.save(cacheKey, latestValue, expiryTimeInSec);
  }
  return latestValue;
}

// export functions

// FIXME: Errors need code values, rather than purely free text.

async function getOrInitCache(
  cacheKey,
  fetchLatestValue,
  expiryTimeInSec = defaultExpiryInSec,
) {
  if (!redisClient) {
    return new Error('cache library not initialized. you need to first call init() method with redisClient as parameter');
  }
  // first check in local cache
  let val = localCache.fetch(cacheKey);
  if (val !== undefined) {
    return val;
  }

  // if not found, check in remote cache
  val = await refreshLocalCacheFromRemoteCache(cacheKey);
  if (val !== undefined) {
    return val;
  }

  // if not, then get acquire lock preparing for case where
  // cache value needs to be saved remotely
  // this is to prevent multiple processes from trying to
  // re-compute potentially expensive fetch func.
  const lockKey = getLockKey(cacheKey);
  let lock;
  try {
    lock = await retryForeverLock.lock(lockKey, CACHE_LOCK_TTL);
  } catch (err) {
    console.warn('getOrInitCache: Could not acquire cache lock for key', `${cacheKey}. Is redis down? :`, err.message);
    // redis is down.. so fall back to local cache only
    return redisDownCase(cacheKey, fetchLatestValue, expiryTimeInSec);
  }

  // run a lock extension timer in case any code within
  // lock and unlock code block takes too long.
  // keep track of lastExtendedTime, since JS setInterval may not run
  // exactly at the set time due to other blocking scripts or GC pause etc.
  //
  // Inspite of this lock extension strategy, lock extension itself can fail.
  // what happens if lock extension fails? I overwrite the cache anyway,
  // since the point of the lock was to avoid multiple calls to fetchLatestValue()
  // (which could be very expensive)
  let lastExendedTime = Date.now();
  let estimatedLockExpiryTime = lastExendedTime + CACHE_LOCK_TTL;
  const lockExtensionTimer = setInterval(async () => {
    const now = Date.now();
    const timeElapsed = now - lastExendedTime;
    try {
      estimatedLockExpiryTime += timeElapsed; // lock extension might take time, so increment first
      lock = await lock.extend(timeElapsed);
      lastExendedTime = now;
    } catch (err) {
      estimatedLockExpiryTime -= timeElapsed;
      console.warn('getOrInitCache: Lock couldn\'t be extended for key', cacheKey, ':', err.message);
    }
  }, CACHE_LOCK_EXTENSION_TTL);

  // it is possible that this one process has been waiting very long to acquire
  // lock... by which time another process already updated remote cache.
  // so to avoid refetching latest value, we can first check for cache value again.
  val = await refreshLocalCacheFromRemoteCache(cacheKey);
  if (val !== undefined) {
    clearInterval(lockExtensionTimer);
    // async unlock. don't await
    unlock(lock, lockKey);
    return val;
  }

  let latestValue;
  let error = false;
  try {
    latestValue = await fetchLatestValue();
  } catch (err) {
    error = true;
    console.warn('getOrInitCache: could not compute latest cache value for key', cacheKey, ':', err.message);
  }

  if (latestValue !== undefined) {
    localCache.save(cacheKey, latestValue, expiryTimeInSec);
    // asyncly save to remote cache and release lock in normal cases. don't await
    (async () => {
      const result = await remoteCache.save(cacheKey, latestValue, expiryTimeInSec);
      // if lock potentially expired before the write..
      if (result !== false && estimatedLockExpiryTime <= Date.now()) {
        // .. well I have potentially overwritten the remote cache anyway,
        // so ask others to refetch and refresh their local caches
        // the potential overwrite can't be avoided as redis doesn't have fenced locks
        signalOthersProcessesToRefreshLocalCache(cacheKey);
      }
    })();
  } else if (!error) {
    console.warn('getOrInitCache: Cannot cache undefined value for key', cacheKey);
  }


  clearInterval(lockExtensionTimer);
  // async unlock. don't await
  unlock(lock, lockKey);

  return latestValue;
}

async function attemptCacheRegeneration(
  cacheKey,
  fetchLatestValue,
  expiryTimeInSec = defaultExpiryInSec,
) {
  if (!redisClient) {
    return new Error('cache library not initialized. you need to first call init() method with redisClient as parameter');
  }
  const lockKey = getLockKey(cacheKey);
  let lock;

  // for regeneration purpose, don't allow multiple parallel regeneration requests.
  // reject requests if already regenerating.
  try {
    lock = await tryOnceLock.lock(lockKey, CACHE_LOCK_TTL);
  } catch (err) {
    // either cache key is already locked or redis is down
    // in either case, attemptCacheRegeneration() doesn't promise a retry..
    // only promises a single attempt.
    return new Error(
      `Could not acquire cache lock for regeneration for lock key ${lockKey}. `
      + `Maybe another process has acquired lock or redis is down? : ${err.message}`,
    );
  }

  // run a lock extension timer in case external
  // function fetchLatestValue() takes too long.
  // keep track of lastExtendedTime, since JS setInterval may not run
  // exactly at the set time due to other blocking scripts or GC pause etc.
  let lastExendedTime = Date.now();
  const lockExtensionTimer = setInterval(async () => {
    const now = Date.now();
    const timeElapsed = now - lastExendedTime;
    try {
      lock = await lock.extend(timeElapsed);
      lastExendedTime = now;
    } catch (err) {
      console.warn('attemptCacheRegeneration: Lock couldn\'t be extended for key', cacheKey, ':', err.message);
    }
    lastExendedTime = now;
  }, CACHE_LOCK_EXTENSION_TTL);

  let latestValue;
  let error;
  try {
    latestValue = await fetchLatestValue();
  } catch (err) {
    error = new Error(`attemptCacheRegeneration: could not compute latest cache value for key ${cacheKey}`);
  }

  if (!error) {
    if (latestValue !== undefined) {
      // when forcing regeneration, wait for save and unlock and then return.
      const res = await remoteCache.save(cacheKey, latestValue, expiryTimeInSec);
      if (res !== false) {
        localCache.save(cacheKey, latestValue, expiryTimeInSec);
        signalOthersProcessesToRefreshLocalCache(cacheKey);
      } else {
        error = new Error('Could not save value to remote cache. So not going to save to local cache either');
      }
    } else {
      error = new Error(`Cannot cache undefined value for key ${cacheKey}`);
    }
  }

  clearInterval(lockExtensionTimer);
  // wait for unlock
  await unlock(lock, lockKey);

  if (error) {
    return error;
  }
  return latestValue;
}

const exportObject = {
  // why two methods?
  // one will wait till cache is initialized in the case where
  // multiple processes try to init cache simultaneously
  getOrInitCache,
  // other one will only attempt once before giving up in the case
  // where multiple processes try to regenerate cache simultaneously
  attemptCacheRegeneration,
};

exportObject.init = function init(_redisClient) {
  if (redisClient) {
    return new Error('Cannot initialize twice.');
  }
  redisClient = _redisClient;
  remoteCache.init(redisClient);
  bluebird.promisifyAll(Object.getPrototypeOf(redisClient));

  retryForeverLock = new Redlock(
    // you should have one client for each independent redis node
    // or cluster
    [redisClient],
    {
      driftFactor: 0.01, // time in ms
      // the max number of times Redlock will attempt
      // to lock a resource before erroring
      retryCount: -1, // retry forever
      retryDelay: 400, // time in ms
      retryJitter: 400, // time in ms
    },
  );

  tryOnceLock = new Redlock(
    // you should have one client for each independent redis node
    // or cluster
    [redisClient],
    {
      driftFactor: 0.01, // time in ms
      // the max number of times Redlock will attempt
      // to lock a resource before erroring
      retryCount: 0, // retry forever
      retryDelay: 400, // time in ms
      retryJitter: 400, // time in ms
    },
  );

  // listen to commands from other processes like moments when L1 cache is signalled to be stale
  redisClient.on('message', (channel, rawMessage) => {
    let message;
    try {
      message = JSON.parse(rawMessage);
    } catch (err) {
      // do nothing
    }
    if (!message) {
      return;
    }

    if (
      channel === 'cacheChannel'
      && message.command === 'refreshYourLocalCacheFromRemoteCache'
      && message.cacheKey
    ) {
      refreshLocalCacheFromRemoteCache(message.cacheKey);
    }
  });
  redisClient.subscribe('cacheChannel');
  return exportObject;
};

module.exports = exportObject;
