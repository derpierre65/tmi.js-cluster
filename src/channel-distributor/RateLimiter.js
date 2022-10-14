class RateLimiter {
	/**
	 * @param name - name/identifier of the rate limiter
	 * @param allow - maximum rate limit points
	 * @param every - reset after {every}ms
	 */
	constructor(name, allow, every) {
		this.name = name;
		this.allow = this.remaining = allow;
		this.every = every;

		this.init();
	}

	init() {
	}

	async getRemaining() {
		return this.remaining;
	}

	async decrement(value = 1) {
		return this.remaining -= value;
	}
}

export {
	RateLimiter as default,
};