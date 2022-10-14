import * as Enum from '../../../lib/enums';
import {CommandQueue} from '../../../lib/enums';
import {getRedisKey} from '../../../lib/util';
import {TmiClientInstance} from '../../../TmiClient';
import {CommandQueueInstance} from '../../CommandQueue';
import RedisChannelDistributor, {PubRedisInstance, SubRedisInstance} from '../RedisChannelDistributor';

class RedisPubSubChannelDistributor extends RedisChannelDistributor {
	constructor(options) {
		super(options);

		if (!SubRedisInstance) {
			console.error('[tmi.js-cluster] No (sub) Redis client given.');
		}

		// subscribe with redis if a sub redis is available
		if (process.env.TMI_CLUSTER_ROLE === 'tmi-client' && TmiClientInstance && SubRedisInstance) {
			this.subscribeEvent(CommandQueue.COMMAND_JOIN, this._onJoin);
			this.subscribeEvent(CommandQueue.COMMAND_JOIN, this._onPart);
			this.subscribeEvent(CommandQueue.COMMAND_JOIN, this._onClientCreate);
		}
	}

	subscribeEvent(eventName, callback) {
		return SubRedisInstance.subscribe(getRedisKey(`${process.env.PROCESS_ID}:${eventName}`), callback.bind(this));
	}

	unsubscribeEvent(eventName) {
		return SubRedisInstance.unsubscribe(getRedisKey(`${process.env.PROCESS_ID}:${eventName}`));
	}

	async _terminateClient() {
		super._terminateClient();

		await this.unsubscribeEvent(CommandQueue.COMMAND_JOIN);
		await this.unsubscribeEvent(CommandQueue.COMMAND_PART);
		await this.unsubscribeEvent(CommandQueue.CREATE_CLIENT);

		try {
			await PubRedisInstance.SET(getRedisKey('process-staled'), 'true');
		}
		catch (error) {
			// ignore error - it's not necessary, it will guarantee "only" a faster rejoin
		}
	}

	_onJoin(message) {
		let { channels } = JSON.parse(message);

		if (!Array.isArray(channels)) {
			channels = [channels];
		}

		for (const channel of channels) {
			TmiClientInstance.joinChannel(channel);
		}
	}

	_onPart(message) {
		let { channels } = JSON.parse(message);

		if (!Array.isArray(channels)) {
			channels = [channels];
		}

		for (const channel of channels) {
			TmiClientInstance.partChannel(channel);
		}
	}

	_onClientCreate(message) {
		TmiClientInstance.createClient(JSON.parse(message));
	}

	async _requestCommand(processId, command, options): Promise<boolean> {
		const recipients = await PubRedisInstance.publish(getRedisKey(`${processId}:${command}`), JSON.stringify(options));

		// fallback if no recipients are available, push it back into the queue
		if (recipients === 0) {
			CommandQueueInstance.unshift(Enum.CommandQueue.COMMAND_QUEUE, command, options);
			return false;
		}

		return true;
	}
}

export {
	RedisPubSubChannelDistributor as default,
};