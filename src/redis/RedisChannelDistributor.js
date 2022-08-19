import * as Enum from '../lib/enums';
import {channelSanitize, channelUsername, getQueueName, getRedisKey, unique, wait} from '../lib/util';
import {SupervisorInstance} from '../Supervisor';
import {TmiClientInstance} from '../TmiClient';
import RedisCommandQueue from './RedisCommandQueue';
import RedisLock from './RedisLock';

export default class RedisChannelDistributor {
	constructor(options) {
		this._executingQueue = false;
		this._terminated = false;

		this.pubRedis = options.redis.pub;
		this.subRedis = options.redis.sub;
		this.commandQueue = new RedisCommandQueue(options.redis.pub);
		this.lock = new RedisLock(options.redis.pub);

		// subscribe with redis if a sub redis is available
		if (process.env.TMI_CLUSTER_ROLE === 'tmi-client' && TmiClientInstance && this.subRedis) {
			this.subRedis.subscribe(getRedisKey(`${process.env.PROCESS_ID}:join`), this._onJoin.bind(this));
			this.subRedis.subscribe(getRedisKey(`${process.env.PROCESS_ID}:part`), this._onPart.bind(this));
			this.subRedis.subscribe(getRedisKey(`${process.env.PROCESS_ID}:client-create`), this._onClientCreate.bind(this));
		}
		else if (process.env.TMI_CLUSTER_ROLE === 'supervisor') {
			setInterval(() => {
				this.releaseStaleSupervisors(true);
			}, Math.max(Math.floor(tmiClusterConfig.supervisor.stale), 10) * 1_000);
		}
	}

	async releaseStaleSupervisors(force = false) {
		if (!force && !await this.pubRedis.GET(getRedisKey('process-staled'))) {
			return;
		}

		// check if release is in progress
		if (!await this.lock.lock('release-supervisors')) {
			return;
		}

		await this.pubRedis.DEL(getRedisKey('process-staled'));

		try {
			await this.flushStale();
		}
		finally {
			await this.lock.release('release-supervisors');
		}
	}

	async flushStale() {
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

		channels.push(...await this.restoreStaleQueues(staleIds));
		channels = unique(channels.map(channelSanitize));

		await this.join(channels, true);
	}

	async getProcesses() {
		// fetch all possible processes
		let processes = await new Promise((resolve, reject) => {
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

		processes = processes.map((supervisorProcess) => {
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

		return processes;
	}

	async restoreStaleQueues(staleIds) {
		const channels = [];
		for (const staleId of staleIds) {
			const commands = await this.commandQueue.pending(getQueueName(staleId, Enum.CommandQueue.INPUT_QUEUE));

			for (let index = commands.length - 1; index >= 0; index--) {
				const command = commands[index];

				if (command.command === Enum.CommandQueue.COMMAND_JOIN) {
					channels.push(command.options.channel);
				}
				else {
					await this.commandQueue.unshift(Enum.CommandQueue.JOIN_HANDLER, command.command, command.options);
				}
			}
		}

		return channels;
	}

	async executeQueue() {
		if (this._terminated || !await this.lock.lock('handle-queue', tmiClusterConfig.supervisor.updateInterval)) {
			return;
		}

		this._executingQueue = true;

		const commands = await this.commandQueue.pending(Enum.CommandQueue.JOIN_HANDLER);
		if (commands.length === 0) {
			this._executingQueue = false;
			return;
		}

		const { channelQueue, clientQueue } = this.getQueues(commands);

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
					channelList.push(command.options.channels[0]); // we know that only one channel is in this command
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
							const index = channelQueue.findIndex((command) => command.command === Enum.CommandQueue.COMMAND_JOIN && command.options.channels[0] === channel);
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
				this._executeQueue(
					'channel',
					channelQueue,
					Math.max(tmiClusterConfig.throttle.join.every, 1),
					Math.min(tmiClusterConfig.throttle.join.take, tmiClusterConfig.throttle.join.allow),
				),
				this._executeQueue(
					'client',
					clientQueue,
					Math.max(tmiClusterConfig.throttle.clients.every, 1),
					Math.min(tmiClusterConfig.throttle.clients.take, tmiClusterConfig.throttle.clients.allow),
				),
			])
			.then(() => {
				this._executingQueue = false;
				process.env.DEBUG_ENABLED && console.debug(`[tmi.js-cluster] [supervisor:${SupervisorInstance.id}] Channel and client queue finished...`);
			});
	}

	async resolve(processes, commands) {
		let executed = 0;
		for (const command of commands) {
			if (command.command === Enum.CommandQueue.COMMAND_JOIN) {
				const channel = command.options.channels[0];
				const channelProcess = this.isJoined(processes, channel, true);

				// this channel will be ignored, because it's already joined.
				if (channelProcess) {
					continue;
				}

				executed++;

				processes.sort((processA, processB) => processA.channelSum > processB.channelSum ? 1 : -1);

				const targetProcess = processes[0];
				if (await this._sendPubSub(`${targetProcess.id}:join`, targetProcess.id, command.command, command.options)) {
					targetProcess.channelSum++;
					targetProcess.channels.push(channel);
				}
			}
			else if (command.command === Enum.CommandQueue.COMMAND_PART) {
				const channel = command.options.channels[0];
				const channelProcess = this.isJoined(processes, channel);

				if (await this._resolveChannelPart(channelProcess, command)) {
					executed++;
				}
			}
			else if (command.command === Enum.CommandQueue.CREATE_CLIENT) {
				let targetProcess = this.hasClient(processes, command.options.username);

				executed++;

				// if no client exists with this username we create a new one on a process with the lowest client count.
				if (!targetProcess) {
					processes.sort((processA, processB) => processA.clientSum > processB.clientSum ? 1 : -1);

					targetProcess = processes[0];
					targetProcess.clientSum++;
					targetProcess.clients.push(command.options.username);
				}

				// send command to process
				await this._sendPubSub(`${targetProcess.id}:client-create`, targetProcess.id, command.command, command.options);
			}
		}

		return executed;
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
			await this.subRedis.unsubscribe(getRedisKey(`${process.env.PROCESS_ID}:join`), this._onJoin);
			await this.subRedis.unsubscribe(getRedisKey(`${process.env.PROCESS_ID}:part`), this._onPart);

			try {
				await this.pubRedis.SET(getRedisKey('process-staled'), 'true');
			}
			catch (error) {
				// ignore error - it's not necessary, it will guarantee "only" a faster rejoin
			}
		}
	}

	join(channels, now = false) {
		return this._channelAction(channels, now ? 'unshift' : 'push');
	}

	part(channels, now = false) {
		return this._channelAction(channels, now ? 'unshift' : 'push', Enum.CommandQueue.COMMAND_PART);
	}

	getQueues(commands) {
		const channelQueue = [];
		const clientQueue = [];

		for (const command of commands) {
			// join and part events
			if (command.command === Enum.CommandQueue.COMMAND_JOIN || command.command === Enum.CommandQueue.COMMAND_PART) {
				const commandChannels = command.options.channels || [];

				for (let channel of commandChannels) {
					channel = channelSanitize(channel);

					const joinIndex = channelQueue.findIndex((entry) => entry.options.channels[0] === channel && entry.command === Enum.CommandQueue.COMMAND_JOIN);
					const partIndex = channelQueue.findIndex((entry) => entry.options.channels[0] === channel && entry.command === Enum.CommandQueue.COMMAND_PART);

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
							channels: [channel],
						},
					});
				}
			}
		}

		return { channelQueue, clientQueue };
	}

	hasClient(processes, channel) {
		return processes.find((process) => {
			return process.clients.includes(channel);
		});
	}

	isJoined(processes, channel, includeClients) {
		return processes.find((process) => {
			return process.channels.includes(channel) || includeClients && process.clients.includes(channel);
		});
	}

	async _executeQueue(name, queue, every, take) {
		if (queue.length === 0) {
			return;
		}

		process.env.DEBUG_ENABLED && console.debug(`[tmi.js-cluster] [supervisor:${SupervisorInstance.id}] Executing queue ${name} (size: ${queue.length})...`);

		try {
			do {
				const processes = await this.getProcesses();

				// if no processes found or the executor has been terminated then we re-queue the commands
				if (processes.length === 0 || this._terminated) {
					for (let index = queue.length - 1; index >= 0; index--) {
						const action = queue[index];
						this.commandQueue.unshift(Enum.CommandQueue.JOIN_HANDLER, action.command, action.options);
					}

					process.env.DEBUG_ENABLED && console.debug(`[tmi.js-cluster] [supervisor:${SupervisorInstance.id}] Queue ${name} canceled and all commands are pushed back into the queue.`);

					break;
				}

				// block the queue for every + 1 seconds
				await this.lock.block('handle-queue', (every + 1) * 1_000);

				// execute queue
				const commands = queue.splice(0, take);
				const start = Date.now();
				const executed = await this.resolve(processes, commands);

				// if more channels are available then wait for "every" seconds otherwise we finish the queue and let expire the redis lock.
				if (queue.length && executed) {
					// we need to add some time, it's not important if you have a verified bot because the limit would be high enough to join/part enough channels.
					// the command execution can take some time and could be result with a "no response from twitch" for unverified users
					await wait(every * 1_000 + (Date.now() - start) * 2);
				}
			} while (queue.length);
		}
		catch (error) {
			console.error(`[tmi.js-cluster] [supervisor:${SupervisorInstance.id}] Failed to execute queue ${name}:`);
			console.error(error);
		}
	}

	async _resolveChannelPart(channelProcess, command) {
		// this channel will be ignored, because it's not joined.
		if (!channelProcess) {
			return false;
		}

		let index = channelProcess.channels.indexOf(command.options.channels[0]);
		if (index === -1) {
			return false;
		}

		if (await this._sendPubSub(`${channelProcess.id}:part`, channelProcess.id, command.command, command.options)) {
			channelProcess.channelSum--;
			channelProcess.channels.splice(index, 1);

			return true;
		}

		return false;
	}

	_onClientCreate(message) {
		TmiClientInstance.createClient(JSON.parse(message));
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

	_channelAction(channels, queueAction, command) {
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

	async _sendPubSub(target, queueName, command, options) {
		if (this.subRedis) {
			const recipients = await this.pubRedis.publish(getRedisKey(target), JSON.stringify(options));
			if (recipients === 0) {
				this.commandQueue.unshift(Enum.CommandQueue.JOIN_HANDLER, command, options);
				return false;
			}
		}
		else {
			this.commandQueue.push(getQueueName(queueName, Enum.CommandQueue.INPUT_QUEUE), command, options);
		}

		return true;
	}
}