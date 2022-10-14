import RedisLock from '../../channel-distributor/redis/RedisLock';
import * as Enum from '../../lib/enums';
import {getQueueName, getRedisKey} from '../../lib/util';
import ChannelDistributor from '../ChannelDistributor';
import {CommandQueueInstance} from '../CommandQueue';
import RedisCommandQueue from './RedisCommandQueue';
import RedisRateLimiter from './RedisRateLimiter';

let PubRedisInstance = null;
let SubRedisInstance = null;

class RedisChannelDistributor extends ChannelDistributor {
	constructor(options) {
		super(options);

		PubRedisInstance = options.redis.pub || options.redis.client;
		SubRedisInstance = options.redis.sub || null;

		if (!PubRedisInstance) {
			console.error('[tmi.js-cluster] No (pub) Redis client given.');
			process.exit(0);
		}

		this.lock = new RedisLock();

		new RedisCommandQueue();

		if (process.env.TMI_CLUSTER_ROLE === 'supervisor') {
			setInterval(
				() => this.releaseStaleSupervisors(true),
				Math.max(Math.floor(tmiClusterConfig.supervisor.stale), 5) * 1_000,
			);
		}
	}

	async getRateLimiterClass(name) {
		return RedisRateLimiter;
	}

	async isQueueLocked() {
		return !await this.lock.lock('handle-supervisor-queue', tmiClusterConfig.supervisor.updateInterval);
	}

	async unlockQueue() {
		return this.lock.release('handle-supervisor-queue');
	}

	async blockQueue(milliseconds) {
		await this.lock.block('handle-supervisor-queue', milliseconds);
	}

	async releaseStaleSupervisors(force = false) {
		if (!force && !await PubRedisInstance.GET(getRedisKey('process-staled'))) {
			return;
		}

		// check if a release supervisor call is in progress
		if (!await this.lock.lock('release-supervisors')) {
			return;
		}

		await PubRedisInstance.DEL(getRedisKey('process-staled'));

		try {
			await this._flushStale();
		}
		finally {
			await this.lock.release('release-supervisors');
		}
	}

	async _requestCommand(processId, command, options) {
		CommandQueueInstance.push(getQueueName(processId, Enum.CommandQueue.INPUT_QUEUE), command, options);

		return true;
	}
}

export {
	PubRedisInstance,
	SubRedisInstance,
	RedisChannelDistributor as default,
};