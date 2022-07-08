import EventEmitter from 'node:events';
import SignalListener from './SignalListener';
import { getQueueName } from'./lib/util';
import * as Enum from'./lib/enums';

export default class TmiClient extends EventEmitter {
	constructor(options) {
		super();

		process.env.TMI_CLUSTER_ROLE = 'tmi-client';

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

		this.database = options.database || null;

		this._terminating = false;
		this._disconnectedSince = 0;
		this._client = options.tmiClient;
		this._channelDistributor = new options.channelDistributor(options);
		this._commandQueue = this._channelDistributor.commandQueue;
		this._signalListener = new SignalListener(process, this);

		global.tmiClusterConfig = JSON.parse(process.env.TMI_CLUSTER);

		this._interval = setInterval(async () => {
			if (this._terminating) {
				return;
			}

			const currentState = this._client.readyState();
			let currentChannels = this._client.getChannels();

			// unique the channels (tmi.js can return an array with duplicated channels)
			currentChannels = currentChannels.filter((value, index) => currentChannels.indexOf(value) === index);

			await this._checkDisconnect(currentState);

			if (currentState !== 'OPEN') {
				return;
			}

			await this._processPendingCommands();

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
		}, global.tmiClusterConfig.process.periodicTimer);

		if (global.tmiClusterConfig.metrics.enabled) {
			this._client.on('message', () => {
				this._metrics.messages++;
			});
			this._client.on('raw_message', () => {
				this._metrics.rawMessages++;
			});
		}

		this._client.on('disconnected', () => {
			this.terminate();
		});
	}

	async _processPendingCommands() {
		const commands = await this._commandQueue.pending(this.getQueueName(Enum.CommandQueue.INPUT_QUEUE));
		commands.push(...await this._commandQueue.pending('*'));

		for (const command of commands) {
			this._metrics.queueCommands++;

			const channel = command.options.channel;
			if (command.command === Enum.CommandQueue.COMMAND_JOIN) {
				this._client
				    .join(channel)
				    .then(() => {
					    this._sendJoinEvent(channel);
				    })
				    .catch((error) => {
					    setTimeout(() => {
						    if (this._sendJoinEvent(channel)) {
							    return;
						    }

							this.emit('tmi.join_error', channel, error);
						    process.send({
							    event: 'tmi.join_error',
							    channel,
							    error,
						    });
					    }, 1_000);
				    });
			}
			else if (command.command === Enum.CommandQueue.COMMAND_PART) {
				this._client
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
		}
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
			catch (e) {
				process.exit(0);
			}
		}
	}

	getQueueName(name) {
		return getQueueName(process.env.PROCESS_ID, name);
	}

	async terminate() {
		if (this._terminating) {
			return;
		}

		this._terminating = true;

		await this._channelDistributor.terminate();
		// await this._channelDistributor.joinNow(this._client.getChannels());

		process.exit(0);
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