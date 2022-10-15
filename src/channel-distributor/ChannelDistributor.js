import * as Enum from '../lib/enums';
import {channelSanitize, channelUsername, getQueueName, unique} from '../lib/util';
import {SupervisorInstance} from '../Supervisor';
import {CommandQueueInstance} from './CommandQueue';

class ChannelDistributor {
	constructor(options) {
		this._executingQueue = false;
		this._terminated = false;

		this._rateLimiter = {
			tmi: null,
			clients: null,
		};

		let RateLimiterClass = this.getRateLimiterClass();
		if (!RateLimiterClass) {
			return;
		}

		if (!(RateLimiterClass instanceof Promise)) {
			RateLimiterClass = Promise.resolve(RateLimiterClass);
		}

		RateLimiterClass
			.then((RateLimiterClass) => {
				this._rateLimiter.tmi = new RateLimiterClass(
					'tmi',
					tmiClusterConfig.throttle.join.allow,
					tmiClusterConfig.throttle.join.every,
				);
				this._rateLimiter.clients = new RateLimiterClass(
					'clients',
					tmiClusterConfig.throttle.clients.allow,
					tmiClusterConfig.throttle.clients.every,
				);
			});
	}

	getRateLimiterClass() {
		return null;
	}

	async isQueueLocked() {
		return false;
	}

	async unlockQueue() {
		this._executingQueue = false;
	}

	async blockQueue(milliseconds) {
	}

	async releaseStaleSupervisors(force = false) {
		return this._flushStale();
	}

	async _flushStale() {
		if (!SupervisorInstance.database) {
			return Promise.resolve();
		}

		const [supervisors, supervisorProcesses] = await new Promise((resolve, reject) => SupervisorInstance.database.query('SELECT * FROM tmi_cluster_supervisors; SELECT * FROM tmi_cluster_supervisor_processes;', (error, rows) => {
			if (error) {
				return reject(error);
			}

			resolve(rows);
		}));

		const currentDate = new Date();
		const supervisorStaleAfter = SupervisorInstance._config.supervisor.stale * 1_000;
		const processStaleAfter = SupervisorInstance._config.process.stale * 1_000;
		const deleteSupervisorIds = [];
		const staleIds = [];
		let channels = [];

		for (const supervisor of supervisors) {
			if (currentDate - supervisor.last_ping_at >= supervisorStaleAfter) {
				deleteSupervisorIds.push(supervisor.id);
			}
		}

		for (const supervisorProcess of supervisorProcesses) {
			if (supervisorProcess.state !== 'TERMINATED' && currentDate - supervisorProcess.last_ping_at <= processStaleAfter) {
				continue;
			}

			staleIds.push(supervisorProcess.id);
			channels.push(...JSON.parse(supervisorProcess.channels));
		}

		if (deleteSupervisorIds.length > 0) {
			SupervisorInstance.database.query('DELETE FROM tmi_cluster_supervisors WHERE id IN (?);', [deleteSupervisorIds], (error) => error && console.error('[tmi.js-cluster] Delete staled Supervisors failed.', error));
		}
		if (staleIds.length > 0) {
			SupervisorInstance.database.query('DELETE FROM tmi_cluster_supervisor_processes WHERE id IN (?);', [staleIds], (error) => error && console.error('[tmi.js-cluster] Delete staled supervisor processes failed.', error));
		}

		channels.push(...await this._restoreStaleQueues(staleIds));
		channels = unique(channels.map(channelSanitize));

		await this.join(channels, true);
	}

	join(channels, now = false) {
		return this._channelAction(channels, now ? 'unshift' : 'push', Enum.CommandQueue.COMMAND_JOIN);
	}

	part(channels, now = false) {
		return this._channelAction(channels, now ? 'unshift' : 'push', Enum.CommandQueue.COMMAND_PART);
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

			this._terminateSupervisor();
		}
		// update supervisor process state
		else if (process.env.TMI_CLUSTER_ROLE === 'tmi-client') {
			this._terminateClient();
		}
	}

	_terminateSupervisor() {
		// do something here for supervisor (after queue is finished)
	}

	_terminateClient() {
		// do something here for client
	}

	async executeQueue() {
		if (this._terminated || await this.isQueueLocked()) {
			return;
		}

		this._executingQueue = true;

		const commands = await CommandQueueInstance.pending(Enum.CommandQueue.COMMAND_QUEUE);
		if (commands.length === 0) {
			return this.unlockQueue();
		}

		const { channelQueue, clientQueue } = this._getQueues(commands);

		// we check if any channel should join a custom client if multi clients is enabled.
		if (tmiClusterConfig.multiClients.enabled) {
			const commandGroups = {};
			for (const command of channelQueue) {
				if (typeof commandGroups[command.command] === 'undefined') {
					commandGroups[command.command] = [];
				}
				commandGroups[command.command].push(command);
			}

			if (commandGroups[Enum.CommandQueue.COMMAND_JOIN] && commandGroups[Enum.CommandQueue.COMMAND_JOIN].length) {
				let channelList = [];
				for (const command of commandGroups[Enum.CommandQueue.COMMAND_JOIN]) {
					channelList.push(command.options.channel);
				}

				channelList = unique(channelList);

				try {
					const clients = {};
					const channelClients = await new Promise((resolve, reject) => SupervisorInstance.database.query('SELECT * FROM tmi_cluster_supervisor_channel_clients WHERE channel IN (?);', [channelList.map(channelUsername)], (error, rows) => {
						if (error) {
							return reject(error);
						}

						resolve(rows);
					}));

					for (const client of channelClients) {
						let username = channelUsername(client.username);
						if (typeof clients[username] === 'undefined') {
							clients[username] = {
								channels: [],
								password: client.password,
								username,
							};
						}

						clients[username].channels.push(channelSanitize(client.channel));
					}

					for (const client of Object.values(clients)) {
						for (const channel of client.channels) {
							const index = channelQueue.findIndex((command) => command.command === Enum.CommandQueue.COMMAND_JOIN && command.options.channel === channel);
							if (index >= 0) {
								channelQueue.splice(index, 1);
							}
						}

						clientQueue.push({
							command: Enum.CommandQueue.CREATE_CLIENT,
							options: client,
						});
					}
				}
				catch (error) {
					console.error(`[tmi.js-cluster] [supervisor:${SupervisorInstance.id}] Fail to fetch custom clients, channels will joined with the main client.`);
					console.error(error);
				}
			}
		}

		// running client and channel queue parallel.
		// maybe we split the execution of channel and client queue, because we don't want to waste the low limit for unverified bots and waiting for the client creation.
		Promise
			.all([
				this._executeQueue('tmi', channelQueue),
				this._executeQueue('client', clientQueue),
			])
			.then(() => {
				this.unlockQueue();

				process.env.DEBUG_ENABLED && console.debug(`[tmi.js-cluster] [supervisor:${SupervisorInstance.id}] Channel and client queue finished...`);
			});
	}

	async _restoreStaleQueues(staleIds) {
		const channels = [];
		for (const staleId of staleIds) {
			const commands = await CommandQueueInstance.pending(getQueueName(staleId, Enum.CommandQueue.INPUT_QUEUE));

			for (let index = commands.length - 1; index >= 0; index--) {
				const command = commands[index];

				if (command.command === Enum.CommandQueue.COMMAND_JOIN) {
					channels.push(command.options.channel);
				}
				else {
					await CommandQueueInstance.unshift(Enum.CommandQueue.COMMAND_QUEUE, command.command, command.options);
				}
			}
		}

		return channels;
	}

	async _getProcesses() {
		// fetch all possible processes
		const processes = await new Promise((resolve, reject) => {
			SupervisorInstance.database.query(`SELECT * FROM tmi_cluster_supervisor_processes WHERE last_ping_at > ? AND state = ?;`, [
				new Date() - tmiClusterConfig.process.stale * 1_000,
				'OPEN',
			], (error, rows) => {
				if (error) {
					return reject(error);
				}

				resolve(rows);
			});
		});

		return processes.map((supervisorProcess) => {
			const channels = JSON.parse(supervisorProcess.channels);
			const clients = JSON.parse(supervisorProcess.clients);

			return {
				id: supervisorProcess.id,
				channelSum: channels.length,
				clientSum: clients.length,
				channels,
				clients,
			};
		});
	}

	_getQueues(commands) {
		const channelQueue = [];
		const clientQueue = [];

		for (const command of commands) {
			// join and part events
			if (command.command === Enum.CommandQueue.COMMAND_JOIN || command.command === Enum.CommandQueue.COMMAND_PART) {
				const channel = channelSanitize(command.options.channel || '');
				if (!channel) {
					continue;
				}

				const joinIndex = channelQueue.findIndex((entry) => entry.options.channel === channel && entry.command === Enum.CommandQueue.COMMAND_JOIN);
				const partIndex = channelQueue.findIndex((entry) => entry.options.channel === channel && entry.command === Enum.CommandQueue.COMMAND_PART);

				if (command.command === Enum.CommandQueue.COMMAND_JOIN) {
					// we drop the part because a join should be executed after the join.
					if (partIndex >= 0) {
						channelQueue.splice(partIndex);
					}
					// skip join command a join command is already in the queue.
					if (joinIndex >= 0) {
						continue;
					}
				}
				else if (command.command === Enum.CommandQueue.COMMAND_PART) {
					// we drop the join because a part should be executed after the join.
					if (joinIndex >= 0) {
						channelQueue.splice(joinIndex, 1);
					}
					// skip part command a join command is already in the queue.
					if (partIndex >= 0) {
						continue;
					}
				}

				channelQueue.push({
					command: command.command,
					options: {
						...command.options,
						channel,
					},
				});
			}
			else if (command.command === Enum.CommandQueue.CREATE_CLIENT) {
				clientQueue.push(command);
			}
			else {
				console.error('[tmi.js-cluster] Unknown queued command:', command);
			}
		}

		return { channelQueue, clientQueue };
	}

	async _executeQueue(name, queue) {
		if (queue.length === 0) {
			return;
		}

		process.env.DEBUG_ENABLED && console.debug(`[tmi.js-cluster] [supervisor:${SupervisorInstance.id}] Executing queue ${name} (size: ${queue.length})...`);

		try {
			let processes;
			// if no processes found or the executor has been terminated then re-queue all commands
			if (this._terminated || (processes = await this._getProcesses()).length === 0) {
				await this._unshiftQueue(queue);

				process.env.DEBUG_ENABLED && console.debug(`[tmi.js-cluster] [supervisor:${SupervisorInstance.id}] Queue ${name} canceled and all commands are pushed back into the queue.`);

				return;
			}

			// block the queue for every + 1 seconds
			await this.blockQueue(5_000);

			// execute queue until the rate limit reach 0
			// we use a while because some join or part commands will not be executed, e.g. if the channel is already be joined
			let take = 0;
			while (take = await this._rateLimiter[name].getRemaining() > 0 && queue.length) {
				const commands = queue.splice(0, take);

				await this._resolveQueueCommand(processes, commands);
			}

			await this._unshiftQueue(queue);
		}
		catch (error) {
			console.error(`[tmi.js-cluster] [supervisor:${SupervisorInstance.id}] Failed to execute queue ${name}:`);
			console.error(error);
		}
	}

	async _unshiftQueue(queue) {
		for (let index = queue.length - 1; index >= 0; index--) {
			const action = queue[index];
			CommandQueueInstance.unshift(Enum.CommandQueue.COMMAND_QUEUE, action.command, action.options);
		}
	}

	async _resolveQueueCommand(processes, commands) {
		for (const command of commands) {
			// join the channel
			if (command.command === Enum.CommandQueue.COMMAND_JOIN) {
				const channel = command.options.channel;
				const channelProcess = this._isJoined(processes, channel, true);

				// this channel will be ignored, because it's already joined.
				if (channelProcess) {
					continue;
				}

				await this._rateLimiter.tmi.decrement(1);

				processes.sort((processA, processB) => processA.channelSum > processB.channelSum ? 1 : -1);

				const targetProcess = processes[0];
				if (await this._requestCommand(targetProcess.id, command.command, command.options)) {
					targetProcess.channelSum++;
					targetProcess.channels.push(channel);
				}
			}
			// part the channel
			else if (command.command === Enum.CommandQueue.COMMAND_PART) {
				const channel = command.options.channel;
				const channelProcess = this._isJoined(processes, channel);

				// ignore channel, not found in cluster.
				if (!channelProcess) {
					continue;
				}

				// ignore again, not found
				let index = channelProcess.channels.indexOf(command.options.channel);
				if (index === -1) {
					continue;
				}

				await this._rateLimiter.tmi.decrement(1);

				if (await this._requestCommand(channelProcess.id, command.command, command.options)) {
					channelProcess.channelSum--;
					channelProcess.channels.splice(index, 1);
				}
			}
			// Create a client with the given user and join the channel
			else if (command.command === Enum.CommandQueue.CREATE_CLIENT) {
				let targetProcess = this._hasClient(processes, command.options.username);

				// if no client exists with this username we create a new one on a process with the lowest client count.
				if (!targetProcess) {
					processes.sort((processA, processB) => processA.clientSum > processB.clientSum ? 1 : -1);

					targetProcess = processes[0];
					targetProcess.clientSum++;
					targetProcess.clients.push(command.options.username);
				}

				// send command to process
				await this._requestCommand(targetProcess.id, command.command, command.options);
			}
		}
	}

	_hasClient(processes, channel) {
		return processes.find((process) => {
			return process.clients.includes(channel);
		});
	}

	_isJoined(processes, channel, includeClients) {
		return processes.find((process) => {
			return process.channels.includes(channel) || includeClients && process.clients.includes(channel);
		});
	}

	_channelAction(channels, queueAction, command) {
		if (!command) {
			return Promise.reject('Invalid Command');
		}

		if (!Array.isArray(channels)) {
			channels = [channels];
		}

		channels = channels.filter((channel) => channel).map(channelSanitize);

		if (channels.length === 0) {
			return Promise.resolve();
		}

		for (const channel of channels) {
			CommandQueueInstance[queueAction](Enum.CommandQueue.COMMAND_QUEUE, command, {
				channel,
			});
		}

		return Promise.resolve();
	}

	async _requestCommand(processId, command, options) {
		console.error('[tmi.js-cluster] _requestCommand is not implemented.');

		return false;
	}
}

export {
	ChannelDistributor as default,
};