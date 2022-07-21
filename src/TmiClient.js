import EventEmitter from 'node:events';
import * as Enum from './lib/enums';
import {getQueueName, unique} from './lib/util';
import SignalListener from './SignalListener';

/**
 * @type TmiClient
 */
let TmiClientInstance = null;

export {TmiClientInstance};

export default class TmiClient extends EventEmitter {
	constructor(options) {
		super();

		process.env.TMI_CLUSTER_ROLE = 'tmi-client';
		global.tmiClusterConfig = JSON.parse(process.env.TMI_CLUSTER);
		TmiClientInstance = this;

		options = Object.assign({
			commandQueue: null,
			database: null,
			tmiClient: null,
		}, options);

		this._metrics = {
			messages: 0,
			rawMessages: 0,
			queueCommands: 0,
		};

		this.id = process.env.PROCESS_ID;
		this.database = options.database || null;

		this._terminating = false;
		this._disconnectedSince = 0;
		this._client = options.tmiClient;
		this._channelDistributor = new options.channelDistributor(options);
		this._commandQueue = this._channelDistributor.commandQueue;
		this._signalListener = new SignalListener(process, this);
		this._interval = setInterval(async () => {
			if (this._terminating) {
				return;
			}

			const currentState = this._client.readyState();
			const currentChannels = unique(this._client.getChannels());

			await this._checkDisconnect(currentState);

			if (currentState !== 'OPEN') {
				return;
			}

			// use process pending commands if no redis subscriber defined.
			if (!options.redis.sub) {
				await this._processPendingCommands();
			}

			// send my channels to the supervisor
			process.send({
				event: 'channels',
				channels: currentChannels,
			});

			if (this.database) {
				let metrics = '{}';
				if (global.tmiClusterConfig.metrics.enabled) {
					if (global.tmiClusterConfig.metrics.memory) {
						this._metrics.memory = process.memoryUsage().heapUsed / 1024 / 1024;
					}

					this._metrics.channels = currentChannels.length;

					metrics = JSON.stringify(this._metrics);
				}

				const now = new Date();
				this.database.query('UPDATE tmi_cluster_supervisor_processes SET state = ?, channels = ?, last_ping_at = ?, updated_at = ?, metrics = ? WHERE id = ?', [
					currentState,
					JSON.stringify(currentChannels),
					now,
					now,
					metrics,
					process.env.PROCESS_ID,
				], (error) => {
					if (error) {
						console.error('[tmi.js-cluster] Fail to update supervisor process.', error);
					}
				});
			}
		}, tmiClusterConfig.process.periodicTimer);

		// tmi js disconnected hook
		this._client.on('disconnected', () => {
			this.terminate();
		});

		// tmi.js hook for metrics
		if (global.tmiClusterConfig.metrics.enabled) {
			this._client.on('message', () => {
				this._metrics.messages++;
			});
			this._client.on('raw_message', () => {
				this._metrics.rawMessages++;
			});
		}
	}

	async joinChannel(channel) {
		if (this._terminating) {
			this._channelDistributor.joinNow(channel);

			return;
		}

		return this
			._client
			.join(channel)
			.then(() => {
				return this._sendJoinEvent(channel);
			})
			.catch((error) => {
				return new Promise((resolve) => {
					setTimeout(() => {
						if (this._sendJoinEvent(channel)) {
							return resolve(true);
						}

						this.emit('tmi.join_error', channel, error);
						process.send({
							event: 'tmi.join_error',
							channel,
							error,
						});

						resolve({ channel, error });
					}, 1_000);
				});
			});
	}

	async partChannel(channel) {
		if (this._terminating) {
			this._channelDistributor.partNow(channel);

			return;
		}

		return this
			._client
			.part(channel)
			.then(() => {
				this.emit('tmi.part', channel);
				process.send({
					event: 'tmi.part',
					channel,
				});
			})
			.catch((error) => {
				this.emit('tmi.part_error', channel, error);
				process.send({
					event: 'tmi.part_error',
					channel,
					error,
				});
			});
	}

	async _processPendingCommands() {
		const commands = await this._commandQueue.pending(getQueueName(process.env.PROCESS_ID, Enum.CommandQueue.INPUT_QUEUE));
		commands.push(...await this._commandQueue.pending('*'));

		for (const command of commands) {
			this._metrics.queueCommands++;

			const channel = command.options.channel;
			if (command.command === Enum.CommandQueue.COMMAND_JOIN) {
				this.joinChannel(channel);
			}
			else if (command.command === Enum.CommandQueue.COMMAND_PART) {
				this.partChannel(channel);
			}
		}
	}

	async terminate() {
		if (this._terminating) {
			return;
		}

		this._terminating = true;

		// we are saving the current channels and set state to TERMINATED
		// it can happen that the process will terminate after the tmi client joined a channel but before the database channel update
		// this would cause that channels will be dropped and not rejoined.
		const currentChannels = unique(this._client.getChannels());
		await new Promise((resolve) => {
			TmiClientInstance.database?.query(`UPDATE tmi_cluster_supervisor_processes SET state = ?, channels = ? WHERE id = ?;`, [
				'TERMINATED',
				JSON.stringify(currentChannels),
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

		// terminate the channel distributor
		await this._channelDistributor.terminate();

		process.exit(0);
	}

	async _checkDisconnect(currentState) {
		if (currentState === 'OPEN') {
			this._disconnectedSince = 0;

			return;
		}

		if (currentState !== 'CLOSED') {
			return;
		}

		let currentDate = Date.now();
		if (this._disconnectedSince === 0) {
			this._disconnectedSince = currentDate;
		}

		if (currentDate - this._disconnectedSince > 15_000) {
			clearInterval(this._interval);

			try {
				await this.terminate();
			}
			catch (error) {
				console.error(`[tmi.js-cluster] [${process.env.PROCESS_ID}] terminate failed, force exit`);
				process.exit(0);
			}
		}
	}

	_sendJoinEvent(channel) {
		if (this._client.getChannels().includes(channel)) {
			this.emit('tmi.join', channel);
			process.send({
				event: 'tmi.join',
				channel: channel,
			});

			return true;
		}

		return false;
	}
}