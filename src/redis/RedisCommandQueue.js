class RedisCommandQueue {
	constructor(redisClient) {
		this._redisClient = redisClient;
	}

	unshift(name, command, options) {
		return this._redisClient.lPush(this.redisPrefix + 'commands:' + name, JSON.stringify({
			time: Date.now(),
			command,
			options,
		}));
	}

	push(name, command, options) {
		return this._redisClient.rPush(this.redisPrefix + 'commands:' + name, JSON.stringify({
			time: Date.now(),
			command,
			options,
		}));
	}

	async pending(name) {
		let keyName = this.redisPrefix + 'commands:' + name;
		const length = await this._redisClient.lLen(keyName);
		if (length < 1) {
			return [];
		}

		const result = await this._redisClient.lRange(keyName, 0, length - 1);
		await this._redisClient.lTrim(keyName, length, -1);

		return result
			.map((entry) => {
				try {
					return JSON.parse(entry);
				}
				catch (e) {
					return null;
				}
			})
			.filter((value) => value);
	}

	flush(name) {
		return this._redisClient.del(this.redisPrefix + 'commands:' + name);
	}

	get redisPrefix() {
		return global.tmiClusterConfig.redis.prefix || '';
	}
}

module.exports = RedisCommandQueue;