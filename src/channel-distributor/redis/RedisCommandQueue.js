import * as Enum from '../../lib/enums';
import {getQueueName, getRedisKey} from '../../lib/util';
import CommandQueue from '../CommandQueue';
import {PubRedisInstance, SubRedisInstance} from './RedisChannelDistributor';

export default class RedisCommandQueue extends CommandQueue {
	async getPendingCommands() {
		const commands = await this.pending(getQueueName(process.env.PROCESS_ID, Enum.CommandQueue.INPUT_QUEUE));
		commands.push(...await this.pending('*'));

		return commands;
	}

	get enabled() {
		return !SubRedisInstance;
	}

	unshift(name, command, options) {
		return PubRedisInstance.lPush(this.getRedisKey(name), JSON.stringify({
			time: Date.now(),
			command,
			options,
		}));
	}

	push(name, command, options) {
		return PubRedisInstance.rPush(this.getRedisKey(name), JSON.stringify({
			time: Date.now(),
			command,
			options,
		}));
	}

	async pending(name) {
		let keyName = this.getRedisKey(name);
		const length = await PubRedisInstance.lLen(keyName);
		if (length < 1) {
			return [];
		}

		const result = await PubRedisInstance.lRange(keyName, 0, length - 1);
		await PubRedisInstance.lTrim(keyName, length, -1);

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
		return PubRedisInstance.del(this.getRedisKey(name));
	}

	getRedisKey(name) {
		return getRedisKey(`commands:${name}`);
	}
}