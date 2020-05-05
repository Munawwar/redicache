// monotonic clock. i.e it always increases regardless of system time.
function getTime() {
  const [seconds, nanos] = process.hrtime();
  return seconds * 1000 + Math.trunc(nanos / 1000000); // convert to milliseconds
}

module.exports = getTime;
