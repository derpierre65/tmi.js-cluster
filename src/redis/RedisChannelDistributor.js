const { channelSanitize, getQueueName } = require('../lib/util');
const { Enum } = require('../lib/enums');

class RedisChannelDistributor {
	constructor(database, commandQueue) {
		this._commandQueue = commandQueue;
		this._database = database;
		this._executingQueue = false;
		this._terminated = false;
	}

	_join(channels, staleIds, queueAction, command) {
		if (!Array.isArray(channels)) {
			channels = [channels];
		}

		channels = channels.filter((channel) => channel).map(channelSanitize);

		if (channels.length === 0) {
			return;
		}

		return this._commandQueue[queueAction](Enum.CommandQueue.JOIN_HANDLER, command || Enum.CommandQueue.COMMAND_JOIN, {
			channels,
			staleIds,
		});
	}

	join(channels, staleIds) {
		return this._join(channels, staleIds, 'push');
	}

	joinNow(channels, staleIds) {
		return this._join(channels, staleIds, 'unshift');
	}

	part(channels, staleIds) {
		return this._join(channels, staleIds, 'push', Enum.CommandQueue.COMMAND_PART);
	}

	partNow(channels, staleIds) {
		return this._join(channels, staleIds, 'unshift', Enum.CommandQueue.COMMAND_PART);
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

		console.debug('[tmi.js-cluster] Executing Channel join queue...');
		this._executingQueue = true;

		do {
			const processes = await this.getProcesses(staleIds);
			if (processes.length === 0 || this._terminated) {
				const join = [];
				const part = [];
				for (const action of channelQueue) {
					if (action.action === Enum.CommandQueue.COMMAND_PART) {
						part.push(action.channel);
					}
					else if (Enum.CommandQueue.COMMAND_JOIN) {
						join.push(action.channel);
					}
				}

				this.joinNow(join, staleIds);
				this.partNow(part, staleIds);

				console.debug(`[tmi.js-cluster] Queue canceled, re-queued ${join.length} joins and ${part.length} parts.`);

				break;
			}

			const step = channelQueue.splice(0, take);
			this.resolve(processes, step);

			if (channelQueue.length) {
				await new Promise((resolve) => {
					setTimeout(resolve, global.tmiClusterConfig.throttle.join.every * 1_000);
				});
			}
		} while (channelQueue.length);

		this._executingQueue = false;
		console.debug('[tmi.js-cluster] Channel join queue finished...');
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

				this._commandQueue.push(
					getQueueName(nextProcess.id, Enum.CommandQueue.INPUT_QUEUE),
					Enum.CommandQueue.COMMAND_JOIN,
					{ channel },
				);
			}
			else if (action === Enum.CommandQueue.COMMAND_PART) {
				if (!channelProcess) {
					continue;
				}

				channelProcess.channelSum--;
				const index = channelProcess.channels.indexOf(channel);
				if (index >= 0) {
					channelProcess.channels.splice(index, 1);

					this._commandQueue.push(
						getQueueName(channelProcess.id, Enum.CommandQueue.INPUT_QUEUE),
						Enum.CommandQueue.COMMAND_PART,
						{ channel },
					);
				}
			}
		}
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
		else if (process.env.TMI_CLUSTER_ROLE === 'tmi-client') {
			await new Promise((resolve) => {
				this._database?.query(`UPDATE tmi_cluster_supervisor_processes SET state = ? WHERE id = ?;`, [
					'TERMINATED',
					process.env.PROCESS_ID,
				], (error) => {
					if (error) {
						console.error('[tmi.js-cluster] Fail to update process state.', error);
						resolve(error);

						return;
					}

					resolve(null);
				});
			});
		}
	}

	get commandQueue() {
		return this._commandQueue;
	}
}

module.exports = RedisChannelDistributor;