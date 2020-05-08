const redis = require('redis');
const bluebird = require('bluebird');

const redisClient = redis.createClient({});
bluebird.promisifyAll(Object.getPrototypeOf(redisClient));

const luaScript = `
local newPayload = ARGV[1]
local newVersionStr, newData = ARGV[1]:match("^([0-9]+)|(.+)$")
local prevVal = redis.call("get", KEYS[1]) or nil

if newVersionStr == nil then
  return nil
end

if prevVal == nil then
  return redis.call("set", KEYS[1], newVersionStr .. "|" .. newData)
end

local oldVersionStr, oldData = prevVal:match("^([0-9]+)|(.+)$")
local newVersion = tonumber(newVersionStr)
local oldVersion = tonumber(oldVersionStr)

-- check if version matches before writing
if oldVersion < newVersion then
  return redis.call('set', KEYS[1], newPayload)
else
  return nil
end
`;

(async () => {
  const results = await Promise.all([
    redisClient.evalAsync(luaScript, 1, 'cc', '1|{v: 1}'),
    redisClient.evalAsync(luaScript, 1, 'cc', '3|{v: 3}'),
    redisClient.evalAsync(luaScript, 1, 'cc', '2|{v: 2}'),
  ]);
  console.log(results);
  console.log(await redisClient.getAsync('cc'));
  console.log(await redisClient.delAsync('cc'));
})();
