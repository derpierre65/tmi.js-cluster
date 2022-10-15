import * as Enum from '../../../lib/enums';
import {CommandQueue} from '../../../lib/enums';
import {getRedisKey} from '../../../lib/util';
import {SupervisorInstance} from '../../../Supervisor';
import {TmiClientInstance} from '../../../TmiClient';
import {CommandQueueInstance} from '../../CommandQueue';
import RedisChannelDistributor, {PubRedisInstance, SubRedisInstance} from '../RedisChannelDistributor';

class RedisPubSubChannelDistributor extends RedisChannelDistributor {
	constructor(options) {
		super(options);

		if (!SubRedisInstance) {
			console.error('[tmi.js-cluster] No (sub) Redis client given.');
			process.exit(0);
		}

		// subscribe events for tmi-client
		if (process.env.TMI_CLUSTER_ROLE === 'tmi-client') {
			this._subscribeEvent(CommandQueue.COMMAND_JOIN, this._onJoin);
			this._subscribeEvent(CommandQueue.COMMAND_PART, this._onPart);
			this._subscribeEvent(CommandQueue.CREATE_CLIENT, this._onClientCreate);
		}
		// subscribe events for supervsior
		else if (process.env.TMI_CLUSTER_ROLE === 'supervisor') {
			SubRedisInstance.subscribe(getRedisKey(`events:${CommandQueue.COMMAND_QUEUE}`), this._onQueueCommand.bind(this));
			SupervisorInstance.on(`rate-limit.tmi`, this._onQueueCommand.bind(this));
		}
	}

	_terminateSupervisor() {
		super._terminateSupervisor();

		SubRedisInstance.unsubscribe(getRedisKey(`events:${CommandQueue.COMMAND_QUEUE}`));
	}

	async _terminateClient() {
		super._terminateClient();

		await this._unsubscribeEvent(CommandQueue.COMMAND_JOIN);
		await this._unsubscribeEvent(CommandQueue.COMMAND_PART);
		await this._unsubscribeEvent(CommandQueue.CREATE_CLIENT);

		try {
			await PubRedisInstance.SET(getRedisKey('process-staled'), 'true');
		}
		catch (error) {
			// ignore error - it's not necessary, it will guarantee "only" a faster rejoin
		}
	}

	_subscribeEvent(eventName, callback) {
		return SubRedisInstance.subscribe(getRedisKey(`${process.env.PROCESS_ID}:${eventName}`), callback.bind(this));
	}

	_unsubscribeEvent(eventName) {
		return SubRedisInstance.unsubscribe(getRedisKey(`${process.env.PROCESS_ID}:${eventName}`));
	}

	_onJoin(message) {
		let { channel: channels } = JSON.parse(message);

		if (!Array.isArray(channels)) {
			channels = [channels];
		}

		for (const channel of channels) {
			TmiClientInstance.joinChannel(channel);
		}
	}

	_onPart(message) {
		let { channel: channels } = JSON.parse(message);

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

	_onQueueCommand() {
		if (this.queueThrottle) {
			return;
		}

		this.queueThrottle = setTimeout(() => {
			this.queueThrottle = null;
			this.executeQueue();
		}, 500);
	}

	async _requestCommand(processId, command, options) {
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