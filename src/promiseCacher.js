const cloneDeep = require('clone-deep');

const promiseCache = {};

module.exports = (promiseReturningFunc) => (cacheKey, ...args) => {
  if (!cacheKey) {
    return new Error('cacheKey cannot be undefined, null or empty string. It has to be a string with at least one character');
  }
  if (!promiseCache[cacheKey]) {
    promiseCache[cacheKey] = {
      promise: (async () => {
        let val;
        try {
          val = await promiseReturningFunc(cacheKey, ...args);
          delete promiseCache[cacheKey];
        } catch (err) {
          delete promiseCache[cacheKey];
          throw err;
        }
        return val;
      })(),
      secondCall: false,
    };
  // if every promise gets the same object back, then there is a chance the object get mutated
  // by one of the requesters and causes bad side effects to others. So ensure we clone object
  // if more than one request with same cache key is done.
  } else if (!promiseCache[cacheKey].secondCall) {
    promiseCache[cacheKey] = {
      promise: (async (originalPromise) => {
        const val = await originalPromise;
        if (val && typeof val === 'object' && !(val instanceof Error)) {
          return cloneDeep(val);
        }
        return val;
      })(promiseCache[cacheKey].promise),
      secondCall: true,
    };
  }
  return promiseCache[cacheKey].promise;
};
