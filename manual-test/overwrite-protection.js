const redis = require('redis');
const bluebird = require('bluebird');

const redisClient = redis.createClient({});
bluebird.promisifyAll(Object.getPrototypeOf(redisClient));

const luaScript = `
local newValue = ARGV[1]
local ttl = ARGV[2]
local result
if ttl == nil then
  result = redis.call("set", KEYS[1], newValue, "NX")
else
  result = redis.call("set", KEYS[1], newValue, "NX", "EX", ttl)
end

if result == false then
  local currentValue = redis.call("get", KEYS[1])
  return "false|" .. currentValue
else
  return "true|"
end
`;

(async () => {
  const results = await Promise.all([
    redisClient.evalAsync(luaScript, 1, 'cc', '{a: 1}', 5),
    redisClient.evalAsync(luaScript, 1, 'cc', '{b: 2}'),
    redisClient.evalAsync(luaScript, 1, 'cc', '{b: 2}'),
  ]);
  console.log(results);
  console.log('final value saved =', await redisClient.getAsync('cc'));
  console.log('ttl =', await redisClient.ttlAsync('cc'));
  await redisClient.delAsync('cc');
  console.log('(clean up) deleted key');
})();
