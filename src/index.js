/* eslint-disable no-console */

// 2 level cacher
// Level 1 - in process memory
// Level 2 - redis

const processId = require('./processId');
const localCache = require('./cache/localCache');
const remoteCache = require('./cache/remoteCache');
const promiseCacher = require('./utils/promiseCacher');
const refreshLocalCacheForKey = require('./cache/refreshLocalCacheForKey');
const clients = require('./clients');

const unlock = require('./utils/unlock');
const getLockKey = require('./utils/getLockKey');
const getTimeNow = require('./utils/getTimeNow');

// the default expiry time if expiry is not specified.
const defaultExpiryInSec = Infinity; // forever

// lockTime has to be greater than the worst-case blocking duration..
// like a super long GC pause or CPU intensive tight loop. 10 mins?
const CACHE_LOCK_TTL = 10 * 60 * 1000; // 10 mins
const CACHE_LOCK_EXTENSION_TTL = 30 * 1000; // 30 secs

function signalOthersProcessesToRefreshLocalCache(cacheKey) {
  const { redisClient } = clients.getAll();
  // tell other processes to that their L1 cache could be stale
  // why could be? because redis pub-sub doesn't guarentee receiver
  // to receive messages exactly as order of messages sent.
  // However it doesn't matter if command is respected always
  redisClient.publish(
    'cacheChannel',
    JSON.stringify({
      command: 'refreshYourLocalCacheForKey',
      cacheKey,
      processId,
    }),
  );
}


/*
FIXME:
if reds is down:
several way to handle behavior on data:
1. maybe not saving anything and returning/throwing Error (or undefined) is
   better (for short lived states)
2. maybe fetching fresh value all the time is ok
3. maybe returning old cache value is better or returning some placeholder data is
   fine (using data stored in a 3rd data store.. like filesystem)

there is also case for/againt to retry when connection comes back up:
1. refetch latest values once connection is back up and save that in redis
2. don’t do anything (and wait for it to expire or something to trigger refresh)
*/
async function redisDownCase(cacheKey, fetchLatestValue, expiryTimeInSec) {
  let latestValue;
  try {
    latestValue = await fetchLatestValue({ remoteCacheDown: true });
  } catch (err) {
    console.warn('getOrInitCache: could not compute latest cache value for', cacheKey, ':', err.message);
  }
  if (latestValue !== undefined && !(latestValue instanceof Error)) {
    localCache.save(cacheKey, latestValue, expiryTimeInSec);
  }
  // TODO: schedule a retry & save to remote cache job.
  return latestValue;
}

// export functions

// FIXME: Errors need code values, rather than purely free text.

async function getOrInitCache(
  cacheKey,
  fetchLatestValue,
  expiryTimeInSec = defaultExpiryInSec,
) {
  const {
    redisClient,
    retryForeverLock,
  } = clients.getAll();
  if (!redisClient) {
    return new Error('cache library not initialized. you need to first call init() method with redisClient as parameter');
  }
  // first check in local cache
  let val = localCache.fetch(cacheKey);
  if (val !== undefined) {
    return val;
  }

  // if not found, check in remote cache
  val = await refreshLocalCacheForKey(cacheKey);
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
  let lastExendedTime = getTimeNow();
  const lockExtensionTimer = setInterval(async () => {
    const now = getTimeNow();
    const timeElapsed = now - lastExendedTime;
    try {
      lock = await lock.extend(timeElapsed);
      lastExendedTime = now;
    } catch (err) {
      console.warn('getOrInitCache: Lock couldn\'t be extended for key', cacheKey, ':', err.message);
    }
  }, CACHE_LOCK_EXTENSION_TTL);

  // it is possible that this one process has been waiting very long to acquire
  // lock... by which time another process already updated remote cache.
  // so to avoid refetching latest value, we can first check for cache value again.
  val = await refreshLocalCacheForKey(cacheKey);
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
    const result = await remoteCache.save(cacheKey, latestValue, expiryTimeInSec);
    // if lock potentially expired before the write, the save could fail.
    if (!result.success && result.currentValue !== undefined) {
      latestValue = result.currentValue;
    }
    localCache.save(cacheKey, latestValue, expiryTimeInSec);
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
  const { redisClient, tryOnceLock } = clients.getAll();
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
  let lastExendedTime = getTimeNow();
  const lockExtensionTimer = setInterval(async () => {
    const now = getTimeNow();
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
      const res = await remoteCache.save(cacheKey, latestValue, expiryTimeInSec, true);
      if (res.success) {
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

function quit(callback) {
  clients.quit(callback);
  localCache.quit();
}

module.exports = {
  // why two methods?
  // one will wait till cache is initialized in the case where
  // multiple processes try to init cache simultaneously
  getOrInitCache: promiseCacher(getOrInitCache),
  // other one will only attempt once before giving up in the case
  // where multiple processes try to regenerate cache simultaneously
  attemptCacheRegeneration,
  init: clients.init,

  // used internally for tests
  _getOrInitCache: getOrInitCache,
  quit,
};
