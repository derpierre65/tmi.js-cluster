class RedisLock {
	constructor(redisClient) {
		this._redisClient = redisClient;
	}

	async lock(name, ttl = 60) {
		return await this._redisClient.set(this._getRedisKey(`lock:${name}`), '1', {
			NX: 1,
			PX: ttl * 1_000 + 10, // drift for small TTLs
		}) !== null;
	}

	async block(name, ttl = 60) {
		return await this._redisClient.set(this._getRedisKey(`lock:${name}`), '1', {
			PX: ttl * 1_000 + 10, // drift for small TTLs
		}) !== null;
	}

	async exists(name) {
		return this._redisClient.get(this._getRedisKey(`lock:${name}`));
	}

	async release(name) {
		return this._redisClient.del(this._getRedisKey(`lock:${name}`));
	}

	_getRedisKey(name) {
		return (global.tmiClusterConfig.redis.prefix || '') + name;
	}
}

module.exports = RedisLock;