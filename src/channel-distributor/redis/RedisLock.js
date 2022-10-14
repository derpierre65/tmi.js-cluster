import {getRedisKey} from '../../lib/util';
import {PubRedisInstance} from './RedisChannelDistributor';

export default class RedisLock {
	constructor() {
	}

	async lock(name, ttl = 60_000) {
		return await PubRedisInstance.set(getRedisKey(`lock:${name}`), '1', {
			NX: 1,
			PX: ttl + 50, // drift for small TTLs
		}) !== null;
	}

	async block(name, ttl = 60_000) {
		return await PubRedisInstance.set(getRedisKey(`lock:${name}`), '1', {
			PX: ttl + 50, // drift for small TTLs
		}) !== null;
	}

	async exists(name) {
		return PubRedisInstance.get(getRedisKey(`lock:${name}`));
	}

	async release(name) {
		return PubRedisInstance.del(getRedisKey(`lock:${name}`));
	}
}