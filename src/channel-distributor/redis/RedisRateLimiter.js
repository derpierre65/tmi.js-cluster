import {getRedisKey} from '../../lib/util';
import RateLimiter from '../RateLimiter';
import {PubRedisInstance} from './RedisChannelDistributor';

class RedisRateLimiter extends RateLimiter {
	init() {
		super.init();

		this._interval = null;
	}

	async getRemaining(): number {
		this.remaining = parseInt(await this._currentValue);

		if (isNaN(this.remaining)) {
			if (await PubRedisInstance.set(this._redisKey, this.limit.toString(), {
				PX: this.fullResetInterval,
				NX: true,
			}) === 'OK') {
				this.remaining = this.limit;
				this._createInterval();
			}
			else {
				this.remaining = parseInt(await this._currentValue);
			}
		}

		return this.remaining;
	}

	async increment(value = 1): Promise<number> {
		this.remaining += value;

		await PubRedisInstance.set(this._redisKey, this.remaining.toString(), {
			PX: this.fullResetInterval - (this.remaining / this.limit) * this.fullResetInterval,
		});

		return this.remaining;
	}

	async decrement(value = 1): Promise<number> {
		return await this.increment(-value);
	}

	async get _currentValue() {
		return await PubRedisInstance.get(this._redisKey);
	}

	_createInterval() {
		this._clearInterval();
		this._interval = setInterval(async () => {
			this.remaining = parseInt(await this._currentValue);
			if (isNaN(this.remaining)) {
				console.log('cancel update point interval, pool reset');
				this._clearInterval();
				return;
			}

			if (this.remaining >= this.limit) {
				this.remaining = this.limit;

				console.log('cancel update point interval, max points reached');
				this._clearInterval();
				return;
			}

			this.remaining = await this.increment(this.incrementValue);
			console.log(Date.now() / 1000, 'increease points', this.remaining);
		}, this.incrementInterval);
	}

	_clearInterval() {
		if (this._interval) {
			clearInterval(this._interval);
			this._interval = null;
		}
	}

	get _redisKey() {
		return getRedisKey(`rate-limiter:${this.name}`);
	}
}

export {
	RedisRateLimiter as default,
};