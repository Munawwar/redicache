function unlock(lock, lockKey) {
  return lock.unlock()
    .catch((err) => console.warn('Could not release redis cache lock', lockKey, ':', err.message));
}

module.exports = unlock;
