import * as Enum from '../lib/enums';
import {channelSanitize, getQueueName, getRedisKey} from '../lib/util';
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

	async resolve(processes, channels) {
		let executed = 0;
		for (const command of channels) {
			if (command.command === Enum.CommandQueue.COMMAND_JOIN) {
				const channel = command.options.channels[0];
				const channelProcess = this.isJoined(processes, channel);

				// this channel will be ignored, because it's already joined.
				if (channelProcess) {
					continue;
				}

				executed++;

				processes.sort((processA, processB) => processA.channelSum > processB.channelSum ? 1 : -1);

				const targetProcess = processes[0];
				targetProcess.channelSum++;
				targetProcess.channels.push(channel);

				if (this.subRedis) {
					const recipients = await this.pubRedis.publish(getRedisKey(`${targetProcess.id}:join`), channel);
					if (recipients === 0) {
						this.joinNow(channel); // re-queue join
					}
				}
				else {
					this.commandQueue.push(getQueueName(targetProcess.id, Enum.CommandQueue.INPUT_QUEUE), Enum.CommandQueue.COMMAND_JOIN, { channel });
				}
			}
			else if (command.command === Enum.CommandQueue.COMMAND_PART) {
				const channel = command.options.channels[0];
				const channelProcess = this.isJoined(processes, channel);

				// this channel will be ignored, because it's not joined.
				if (!channelProcess) {
					continue;
				}

				const index = channelProcess.channels.indexOf(channel);
				if (index === -1) {
					continue;
				}

				executed++;
				channelProcess.channelSum--;
				channelProcess.channels.splice(index, 1);

				if (this.subRedis) {
					const recipients = await this.pubRedis.publish(getRedisKey(`${channelProcess.id}:part`), channel);
					if (recipients === 0) {
						this.partNow(channel); // re-queue part
					}
				}
				else {
					this.commandQueue.push(getQueueName(channelProcess.id, Enum.CommandQueue.INPUT_QUEUE), Enum.CommandQueue.COMMAND_PART, { channel });
				}
			}
			else if (command.command === Enum.CommandQueue.CREATE_CLIENT) {
				console.debug('TODO: create client event.');
			}
			else if (command.command === Enum.CommandQueue.DELETE_CLIENT) {
				console.debug('TODO: delete client event.');
			}
		}

		return executed;
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

		channels.push(...await this.restoreQueuedChannelsFromStaleQueues(staleIds));
		channels = channels.map(channelSanitize);

		await this.joinNow(channels);
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
				process.env.DEBUG_ENABLED && console.debug('[tmi.js-cluster] Channel and client queue finished...');
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
				const step = queue.splice(0, take);
				const start = Date.now();
				const executed = await this.resolve(processes, step);

				// if more channels are available then wait for "every" seconds otherwise we finish the queue and let expire the redis lock.
				if (queue.length && executed) {
					await new Promise((resolve) => {
						// we need to add some time, it's not important if you have a verified bot because the limit would be high enough to join/part enough channels.
						// the command execution can take some time and could be result with a "no response from twitch" for unverified users
						setTimeout(resolve, every * 1_000 + (Date.now() - start) * 2);
					});
				}
			} while (queue.length);
		}
		catch (error) {
			console.error(`[tmi.js-cluster] [supervisor:${SupervisorInstance.id}] Failed to execute queue ${name}:`);
			console.error(error);
		}
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

	getQueues(commands) {
		const channelQueue = [];
		const clientQueue = [];

		for (const command of commands) {
			// create and delete client event
			if (command.command === Enum.CommandQueue.CREATE_CLIENT || command.command === Enum.CommandQueue.DELETE_CLIENT) {
				const channel = channelSanitize(command.options.channel);
				const createIndex = clientQueue.findIndex((entry) => entry.channel === channel && entry.action === Enum.CommandQueue.CREATE_CLIENT);
				const deleteIndex = clientQueue.findIndex((entry) => entry.channel === channel && entry.action === Enum.CommandQueue.DELETE_CLIENT);

				if (command.command === Enum.CommandQueue.CREATE_CLIENT) {
					// we drop the deletion because a creation should be executed after the deletion.
					if (deleteIndex >= 0) {
						clientQueue.splice(deleteIndex);
					}

					// skip create command a create command is already in the queue.
					if (createIndex >= 0) {
						continue;
					}
				}
				else if (command.command === Enum.CommandQueue.DELETE_CLIENT) {
					// we drop the creation because a deletion should be executed after the creation.
					if (createIndex >= 0) {
						clientQueue.splice(createIndex);
					}

					// skip deletion command a deletion command is already in the queue.
					if (deleteIndex >= 0) {
						continue;
					}
				}

				clientQueue.push(command);
			}
			// join and part events
			else if (command.command === Enum.CommandQueue.COMMAND_JOIN || command.command === Enum.CommandQueue.COMMAND_PART) {
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

	isJoined(processes, channel) {
		return processes.find((process) => {
			return process.channels.includes(channel);
		});
	}

	_onJoin(channels) {
		if (!Array.isArray(channels)) {
			channels = [channels];
		}

		for (const channel of channels) {
			TmiClientInstance.joinChannel(channel);
		}
	}

	_onPart(channels) {
		if (!Array.isArray(channels)) {
			channels = [channels];
		}

		for (const channel of channels) {
			TmiClientInstance.partChannel(channel);
		}
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
}