import {getRedisKey} from '../lib/util';

export default class RedisLock {
	constructor(redisClient) {
		this._redisClient = redisClient;
	}

	async lock(name, ttl = 60_000) {
		return await this._redisClient.set(getRedisKey(`lock:${name}`), '1', {
			NX: 1,
			PX: ttl + 20, // drift for small TTLs
		}) !== null;
	}

	async block(name, ttl = 60_000) {
		return await this._redisClient.set(getRedisKey(`lock:${name}`), '1', {
			PX: ttl + 20, // drift for small TTLs
		}) !== null;
	}

	async exists(name) {
		return this._redisClient.get(getRedisKey(`lock:${name}`));
	}

	async release(name) {
		return this._redisClient.del(getRedisKey(`lock:${name}`));
	}
}