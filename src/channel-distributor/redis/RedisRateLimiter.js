import {getRedisKey} from '../../lib/util';
import {SupervisorInstance} from '../../Supervisor';
import RateLimiter from '../RateLimiter';
import {PubRedisInstance} from './RedisChannelDistributor';

class RedisRateLimiter extends RateLimiter {
	init() {
		super.init();
	}

	async getRemaining() {
		this.remaining = await this._currentValue();

		if (isNaN(this.remaining)) {
			if (await PubRedisInstance.set(this._redisKey, this.allow.toString(), {
				PX: this.every,
				NX: true,
			}) === 'OK') {
				this.remaining = this.allow;
				this.timeout = setTimeout(() => {
					SupervisorInstance.emit(`rate-limit.${this.name}`)
				}, this.every + 100);
			}
			else {
				this.remaining = await this._currentValue();
			}
		}

		return this.remaining;
	}

	async decrement(value = 1) {
		this.remaining = await this.getRemaining();
		this.remaining = await PubRedisInstance.decrBy(this._redisKey, value);

		return this.remaining;
	}

	async _currentValue() {
		return parseInt(await PubRedisInstance.get(this._redisKey));
	}

	get _redisKey() {
		return getRedisKey(`rate-limiter:${this.name}`);
	}
}

export {
	RedisRateLimiter as default,
};