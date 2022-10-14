class RateLimiter {
	/**
	 * @param name - name/identifier of the rate limiter
	 * @param limit - maximum rate limit points
	 * @param incrementInterval - increment {incrementValue} points every {incrementInterval}ms
	 * @param incrementValue - see {incrementInterval}
	 * @param fullResetInterval - after this time the rate limit is .
	 */
	constructor(name, limit, incrementInterval, incrementValue, fullResetInterval) {
		this.name = name;
		this.limit = limit;
		this.remaining = limit;
		this.incrementValue = incrementValue;
		this.incrementInterval = incrementInterval;
		this.fullResetInterval = fullResetInterval;

		this.init();
	}

	init() {
	}

	async getRemaining() {
		return this.remaining;
	}

	async increment(value = 1) {
		return this.remaining += value;
	}

	async decrement(value = 1) {
		return this.remaining -= value;
	}
}

export {
	RateLimiter as default,
};