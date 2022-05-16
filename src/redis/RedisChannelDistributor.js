const { channelSanitize, getQueueName } = require('../lib/util');
const { Enum } = require('../lib/enums');

class RedisChannelDistributor {
	constructor(database, commandQueue) {
		this._commandQueue = commandQueue;
		this._database = database;
	}

	join(channels, staleIds) {
		if (!Array.isArray(channels)) {
			channels = [channels];
		}

		channels = channels.filter((channel) => channel).map(channelSanitize);

		if (channels.length === 0) {
			return;
		}

		return this._commandQueue.push(Enum.CommandQueue.JOIN_HANDLER, Enum.CommandQueue.COMMAND_JOIN, {
			channels,
			staleIds,
		});
	}

	async flushStale(channels, staleIds) {
		channels = channels.map(channelSanitize);
		channels.push(...await this.restoreQueuedChannelsFromStaleQueues(staleIds));

		return this.executeQueue(channels, staleIds);
	}

	async executeQueue(channels, staleIds) {
		const commands = await this._commandQueue.pending(Enum.CommandQueue.JOIN_HANDLER);
		let partChannels = [];

		if (!Array.isArray(channels)) {
			channels = [channels];
		}

		[channels, staleIds] = this.searchChannels(commands, channels, staleIds, Enum.CommandQueue.COMMAND_JOIN);
		[partChannels, staleIds] = this.searchChannels(commands, partChannels, staleIds, Enum.CommandQueue.COMMAND_PART);

		let processes = await this.getProcesses(staleIds);
		if (processes.length === 0) {
			return this.reject(channels, staleIds);
		}

		const take = Math.min(
			global.tmiClusterConfig.throttle.join.take,
			global.tmiClusterConfig.throttle.join.allow,
		);

		const channelQueue = [];
		for (const channel of channels) {
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

		for (let i = 0, max = Math.ceil(channelQueue.length / take); i < max; i++) {
			const step = channelQueue.slice(i * take, (i + 1) * take);

			await new Promise((resolve) => {
				setTimeout(async () => {
					if (i > 0) {
						processes = await this.getProcesses(staleIds);
					}

					this.resolve(processes, step);

					resolve();
				}, i === 0 ? 0 : global.tmiClusterConfig.throttle.join.every * 1_000);
			});
		}
	}

	searchChannels(commands, channels, staleIds, type) {
		for (const command of commands) {
			if (command.command !== type) {
				continue;
			}

			staleIds.push(...(command.options.staleIds || []));
			channels.push(...(command.options.channels || []));
		}

		channels = channels.map(channelSanitize);
		channels = channels.filter((value, key) => channels.indexOf(value) === key);
		staleIds = staleIds.filter((value, key) => staleIds.indexOf(value) === key);

		return [channels, staleIds];
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

				this._commandQueue.push(getQueueName(nextProcess.id, Enum.CommandQueue.INPUT_QUEUE), Enum.CommandQueue.COMMAND_JOIN, { channel });
			}
			else if (action === Enum.CommandQueue.COMMAND_PART) {
				if (!channelProcess) {
					continue;
				}

				channelProcess.channelSum--;
				const index = channelProcess.channels.indexOf(channel);
				if (index >= 0) {
					channelProcess.channels.splice(index, 1);

					this._commandQueue.push(getQueueName(channelProcess.id, Enum.CommandQueue.INPUT_QUEUE), Enum.CommandQueue.COMMAND_PART, { channel });
				}
			}
		}
	}

	reject(channels, staleIds) {
		return this.join(channels, staleIds);
	}

	isJoined(processes, channel) {
		return processes.find((process) => {
			return process.channels.includes(channel);
		});
	}

	async getProcesses(staleIds) {
		// fetch all possible processes
		let processes = await new Promise((resolve, reject) => {
			this._database.query(`SELECT *
			                      FROM tmi_cluster_supervisor_processes
			                      WHERE last_ping_at > ? AND state IN (?) ${staleIds.length ? 'AND id NOT IN(?)' : ''};`, [
				new Date(Date.now() - 3_000),
				['OPEN'],
				staleIds,
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
				id: supervisorProcess.id,
				channelSum: channels.length,
				channels,
			};
		});

		return processes;
	}

	async restoreQueuedChannelsFromStaleQueues(staleIds) {
		const channels = [];
		for (const staleId of staleIds) {
			const queueName = getQueueName(staleId, Enum.CommandQueue.INPUT_QUEUE);
			const commands = await this._commandQueue.pending(queueName);
			for (const command of commands) {
				if (command.command !== Enum.CommandQueue.COMMAND_JOIN) {
					// TODO need to push it again into the queue?
					continue;
				}

				// TODO redis lock for single channel?
				channels.push(command.options.channel);
			}
		}

		return channels;
	}

	async terminate() {
		// TODO remove locks
	}

	get commandQueue() {
		return this._commandQueue;
	}
}

module.exports = RedisChannelDistributor;