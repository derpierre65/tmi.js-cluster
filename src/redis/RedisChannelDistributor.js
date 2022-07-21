import * as Enum from '../lib/enums';
import {channelSanitize, getQueueName, unique} from '../lib/util';
import RedisCommandQueue from './RedisCommandQueue';
import RedisLock from './RedisLock';

export default class RedisChannelDistributor {
	constructor(options) {
		this._database = options.database;
		this._executingQueue = false;
		this._terminated = false;

		this.commandQueue = new RedisCommandQueue(options.redisClient);
		this.lock = new RedisLock(options.redisClient);
	}

	_join(channels, queueAction, command) {
		if (!Array.isArray(channels)) {
			channels = [channels];
		}

		channels = channels.filter((channel) => channel).map(channelSanitize);

		if (channels.length === 0) {
			return;
		}

		return this.commandQueue[queueAction](Enum.CommandQueue.JOIN_HANDLER, command || Enum.CommandQueue.COMMAND_JOIN, {
			channels,
		});
	}

	join(channels) {
		return this._join(channels, 'push');
	}

	joinNow(channels) {
		return this._join(channels, 'unshift');
	}

	part(channels) {
		return this._join(channels, 'push', Enum.CommandQueue.COMMAND_PART);
	}

	partNow(channels) {
		return this._join(channels, 'unshift', Enum.CommandQueue.COMMAND_PART);
	}

	async flushStale(channels, staleIds) {
		channels.push(...await this.restoreQueuedChannelsFromStaleQueues(staleIds));
		channels = channels.map(channelSanitize);

		await this.join(channels);
	}

	async executeQueue() {
		if (!await this.lock.lock('handle-queue', 3_000)) {
			return;
		}

		this._executingQueue = true;

		const priorityChannels = {};
		const commands = await this.commandQueue.pending(Enum.CommandQueue.JOIN_HANDLER);
		const joinChannels = this.searchChannels(commands, Enum.CommandQueue.COMMAND_JOIN, priorityChannels);
		const partChannels = this.searchChannels(commands, Enum.CommandQueue.COMMAND_PART, priorityChannels);
		const every = Math.max(global.tmiClusterConfig.throttle.join.every, 1);
		const take = Math.min(global.tmiClusterConfig.throttle.join.take, global.tmiClusterConfig.throttle.join.allow);

		let channelQueue = [];
		for (const channel of joinChannels) {
			channelQueue.push({
				action: Enum.CommandQueue.COMMAND_JOIN,
				channel,
			});
		}

		for (const channel of partChannels) {
			channelQueue.push({
				action: Enum.CommandQueue.COMMAND_PART,
				channel,
			});
		}

		channelQueue = channelQueue.sort((a, b) => {
			return priorityChannels[a.channel] > priorityChannels[b.channel] ? 1 : -1;
		});

		process.env.DEBUG_ENABLED && console.debug('[tmi.js-cluster] [supervisor] Executing Channel join queue...');

		do {
			const processes = await this.getProcesses();

			if (processes.length === 0 || this._terminated) {
				const join = [];
				const part = [];
				for (const action of channelQueue) {
					if (action.action === Enum.CommandQueue.COMMAND_PART) {
						part.push(action.channel);
					}
					else if (action.action === Enum.CommandQueue.COMMAND_JOIN) {
						join.push(action.channel);
					}
				}

				this.joinNow(join);
				this.partNow(part);

				process.env.DEBUG_ENABLED && console.debug(`[tmi.js-cluster] [supervisor] Queue canceled, re-queued ${join.length} joins and ${part.length} parts.`);

				break;
			}

			const step = channelQueue.splice(0, take);
			this.resolve(processes, step);

			await this.lock.block('handle-queue', every * 1_000);

			if (channelQueue.length) {
				await new Promise((resolve) => {
					setTimeout(resolve, every * 1_000 + 10);
				});
			}
		} while (channelQueue.length);

		this._executingQueue = false;
		process.env.DEBUG_ENABLED && console.debug('[tmi.js-cluster] Channel join queue finished...');
	}

	searchChannels(commands, type, priorityChannels) {
		const channels = [];
		let priority = 0;

		for (const command of commands) {
			if (command.command !== type) {
				continue;
			}

			const commandChannels = command.options.channels || [];
			channels.push(...commandChannels);

			for (const channel of commandChannels) {
				if (typeof priorityChannels[channel] === 'undefined') {
					priorityChannels[channel] = priority;
				}
			}

			priority++;
		}

		return unique(channels.map(channelSanitize));
	}

	resolve(processes, channels) {
		for (const { action, channel } of channels) {
			// this channel will be ignored, because it's already joined.
			let channelProcess = this.isJoined(processes, channel);

			if (action === Enum.CommandQueue.COMMAND_JOIN) {
				if (channelProcess) {
					continue;
				}

				processes.sort((processA, processB) => processA.channelSum > processB.channelSum ? 1 : -1);

				const nextProcess = processes[0];
				nextProcess.channelSum++;
				nextProcess.channels.push(channel);

				this.commandQueue.push(getQueueName(nextProcess.id, Enum.CommandQueue.INPUT_QUEUE), Enum.CommandQueue.COMMAND_JOIN, { channel });
			}
			else if (action === Enum.CommandQueue.COMMAND_PART) {
				if (!channelProcess) {
					continue;
				}

				channelProcess.channelSum--;
				const index = channelProcess.channels.indexOf(channel);
				if (index >= 0) {
					channelProcess.channels.splice(index, 1);

					this.commandQueue.push(getQueueName(channelProcess.id, Enum.CommandQueue.INPUT_QUEUE), Enum.CommandQueue.COMMAND_PART, { channel });
				}
			}
		}
	}

	isJoined(processes, channel) {
		return processes.find((process) => {
			return process.channels.includes(channel);
		});
	}

	async getProcesses() {
		// fetch all possible processes
		let processes = await new Promise((resolve, reject) => {
			this._database.query(`SELECT * FROM tmi_cluster_supervisor_processes WHERE last_ping_at > ? AND state IN (?);`, [
				new Date(Date.now() - global.tmiClusterConfig.process.stale * 1_000),
				['OPEN'],
			], (error, rows) => {
				if (error) {
					return reject(error);
				}

				resolve(rows);
			});
		});

		processes = processes.map((supervisorProcess) => {
			let channels = JSON.parse(supervisorProcess.channels);

			return {
				id: supervisorProcess.id, channelSum: channels.length, channels,
			};
		});

		return processes;
	}

	async restoreQueuedChannelsFromStaleQueues(staleIds) {
		const channels = [];
		for (const staleId of staleIds) {
			const queueName = getQueueName(staleId, Enum.CommandQueue.INPUT_QUEUE);
			const commands = await this.commandQueue.pending(queueName);
			for (const command of commands) {
				if (command.command !== Enum.CommandQueue.COMMAND_JOIN) {
					// TODO maybe need to push it again into the queue?
					continue;
				}

				// TODO add a redis lock for single channel?
				channels.push(command.options.channel);
			}
		}

		return channels;
	}

	async terminate() {
		this._terminated = true;

		// the supervisor should wait for the queue
		if (process.env.TMI_CLUSTER_ROLE === 'supervisor') {
			await new Promise((resolve) => {
				if (!this._executingQueue) {
					return resolve();
				}

				const interval = setInterval(() => {
					if (!this._executingQueue) {
						clearInterval(interval);
						resolve();
					}
				}, 500);
			});
		}
		// update supervisor process state
		else if (process.env.TMI_CLUSTER_ROLE === 'tmi-client') {
			await new Promise((resolve) => {
				this._database?.query(`UPDATE tmi_cluster_supervisor_processes SET state = ? WHERE id = ?;`, [
					'TERMINATED',
					process.env.PROCESS_ID,
				], (error) => {
					if (error) {
						console.error(`[tmi.js-cluster] [${process.env.PROCESS_ID}] Fail to update process state.`, error);
						resolve(error);

						return;
					}

					resolve(null);
				});
			});
		}
	}
}