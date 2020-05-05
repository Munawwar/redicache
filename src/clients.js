
const Redlock = require('redlock');
const bluebird = require('bluebird');

const processId = require('./processId');
const remoteCache = require('./cache/remoteCache');
const refreshLocalCacheForKey = require('./cache/refreshLocalCacheForKey');

let redisClient;
let subscriberRedisClient;
let retryForeverLock;
let tryOnceLock;

function init(_redisClient, _subscriberRedisClient) {
  if (redisClient) {
    return new Error('Cannot initialize twice.');
  }
  if (!_redisClient || !_subscriberRedisClient) {
    return new Error('redicache needs two redis clients for initialization. One for cache+publish, and the other for subscribe. This is a limitation of redis');
  }
  redisClient = _redisClient;
  subscriberRedisClient = _subscriberRedisClient;
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
  subscriberRedisClient.on('message', (channel, rawMessage) => {
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
      // if message was sent by the same process, then it can safetly be ignored.
      && processId !== message.processId
    ) {
      refreshLocalCacheForKey(message.cacheKey);
    }
  });
  subscriberRedisClient.subscribe('cacheChannel');
  return true;
}

module.exports = {
  getAll() {
    return {
      redisClient,
      subscriberRedisClient,
      retryForeverLock,
      tryOnceLock,
    };
  },
  init,
};
