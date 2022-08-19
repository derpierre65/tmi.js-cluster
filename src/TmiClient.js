import EventEmitter from 'node:events';
import * as Enum from './lib/enums';
import {channelSanitize, getQueueName, unique, wait} from './lib/util';
import SignalListener from './SignalListener';

/**
 * @type TmiClient
 */
let TmiClientInstance = null;

export {TmiClientInstance};

export default class TmiClient extends EventEmitter {
	constructor(options, callbacks) {
		super();

		process.env.TMI_CLUSTER_ROLE = 'tmi-client';
		global.tmiClusterConfig = JSON.parse(process.env.TMI_CLUSTER);
		TmiClientInstance = this;

		options = Object.assign({
			commandQueue: null,
			database: null,
			tmiClient: null,
		}, options);

		this.id = process.env.PROCESS_ID;
		this.database = options.database || null;
		this.clients = {};
		this.callbacks = callbacks || {
			createClient: null,
		};

		this._metrics = {
			messages: 0,
			rawMessages: 0,
			queueCommands: 0,
		};
		this._clientChannels = {};
		this._client = options.tmiClient;
		this._terminating = false;
		this._disconnectedSince = 0;
		this._channelDistributor = new options.channelDistributor(options);
		this._commandQueue = this._channelDistributor.commandQueue;
		this._signalListener = new SignalListener(process, this);

		this._interval = setInterval(async () => {
			if (this._terminating) {
				return;
			}

			const currentState = this._client.readyState();
			const currentChannels = this.getChannels();

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
			this.emit('tmi.channels', currentChannels);

			if (this.database) {
				const currentClients = Object.keys(this.clients);
				let metrics = '{}';

				if (tmiClusterConfig.metrics.enabled) {
					if (tmiClusterConfig.metrics.memory) {
						this._metrics.memory = process.memoryUsage().heapUsed / 1024 / 1024;
					}

					this._metrics.channels = currentChannels.length;
					this._metrics.clients = currentClients.length;

					metrics = JSON.stringify(this._metrics);
				}

				const now = new Date();
				this.database.query('UPDATE tmi_cluster_supervisor_processes SET state = ?, channels = ?, clients = ?, last_ping_at = ?, updated_at = ?, metrics = ? WHERE id = ?', [
					currentState,
					JSON.stringify(currentChannels),
					JSON.stringify(currentClients),
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
			process.env.DEBUG_ENABLED && console.debug(`[tmi.js-cluster] [${process.env.PROCESS_ID}] Main Client disconnected. Terminate Process.`);

			this.terminate();
		});

		// tmi.js hook for metrics
		this._addMetricEvents(this._client);
	}

	async joinChannel(channel, client) {
		if (!channel) {
			console.error(`[tmi.js-cluster] [${process.env.PROCESS_ID}] channel argument is an invalid channel name:`, channel);
			return;
		}

		if (this._terminating) {
			this._channelDistributor.join(channel, true);

			return;
		}

		client = client || this._client;

		return client
			.join(channel)
			.then(() => {
				return client.getChannels().includes(channel) && null;
			})
			.catch((error) => {
				return new Promise((resolve) => {
					setTimeout(() => {
						if (client.getChannels().includes(channel)) {
							return resolve(null);
						}

						resolve(error);
					}, 1_000);
				});
			})
			.then((error) => {
				this.emit('tmi.join', error, channel);
				process.send({
					event: 'tmi.join',
					error,
					channel,
				});
			});
	}

	async partChannel(channel) {
		if (this._terminating) {
			this._channelDistributor.part(channel, true);

			return;
		}

		// if multi clients are disabled we use directly the main client
		if (!tmiClusterConfig.multiClients.enabled) {
			return this._partChannel(this._client, channel);
		}

		// search channel in main client
		if (this._client.getChannels().includes(channel)) {
			return this._partChannel(this._client, channel);
		}

		// search channel in client
		for (const username of Object.keys(this.clients)) {
			const client = this.clients[username];
			if (client.getChannels().includes(channel)) {
				return this
					._partChannel(client, channel)
					.then(() => {
						const index = this._clientChannels[username].indexOf(channel);
						if (index >= 0) {
							this._clientChannels[username].splice(index, 1);
						}

						// no more channels in this client, we close it
						if (client.getChannels().length === 0) {
							this.deleteClient(username);
						}
					});
			}
		}
	}

	_partChannel(client, channel) {
		return client
			.part(channel)
			.then(() => {
				return null;
			})
			.catch((error) => {
				return error;
			})
			.then((error) => {
				this.emit('tmi.part', error, channel);
				process.send({
					event: 'tmi.part',
					error,
					channel,
				});
			});
	}

	async terminate() {
		if (this._terminating) {
			return;
		}

		this._terminating = true;

		// we wait for 1.5s to save current channels.
		await wait(1_500);

		// we are saving the current channels and set state to TERMINATED
		// it can happen that the process will terminate after the tmi client joined a channel but before the database channel update
		// this would cause that channels will be dropped and not rejoined.
		const currentChannels = this.getChannels();
		await new Promise((resolve) => {
			const currentClients = Object.keys(this.clients);

			TmiClientInstance.database?.query(`UPDATE tmi_cluster_supervisor_processes SET state = ?, channels = ?, clients = ? WHERE id = ?;`, [
				'TERMINATED',
				JSON.stringify(currentChannels),
				JSON.stringify(currentClients),
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

	async _processPendingCommands() {
		const commands = await this._commandQueue.pending(getQueueName(process.env.PROCESS_ID, Enum.CommandQueue.INPUT_QUEUE));
		commands.push(...await this._commandQueue.pending('*'));

		for (const command of commands) {
			this._metrics.queueCommands++;

			// safety check, ignore queue command without options or where channels key is not an array
			if (!command.options || !Array.isArray(command.options.channels)) {
				continue;
			}

			// we can use channels[0], we know that channels has only ONE channel otherwise the developer pushed the command queue and this would be stupid
			const channel = command.options.channels[0];
			if (command.command === Enum.CommandQueue.COMMAND_JOIN) {
				this.joinChannel(channel);
			}
			else if (command.command === Enum.CommandQueue.COMMAND_PART) {
				this.partChannel(channel);
			}
			else if (command.command === Enum.CommandQueue.CREATE_CLIENT) {
				this.createClient(command.options);
			}
		}
	}

	async createClient(data) {
		if (!tmiClusterConfig.multiClients.enabled) {
			console.error(`[tmi.js-cluster] [${process.env.PROCESS_ID}] Multi clients are disabled.`);
			return;
		}

		if (typeof this.callbacks.createClient !== 'function') {
			console.warn(`[tmi.js-cluster] [${process.env.PROCESS_ID}] createClient is not a function, multi clients are disabled.`);
			return;
		}

		const clientUsername = data.username;

		if (this.clients.hasOwnProperty(clientUsername)) {
			const client = this.clients[clientUsername];
			const clientIsConnected = client && client.readyState() === 'OPEN';
			const currentChannels = client.getChannels();

			console.log('check', data.channels);

			for (const channel of data.channels) {
				if (clientIsConnected && !currentChannels.includes(channel)) {
					this.joinChannel(channel, client);
				}

				if (!this._clientChannels[clientUsername].includes(channel)) {
					this._clientChannels[clientUsername].push(channel);
				}
			}

			return;
		}

		this.clients[clientUsername] = null;
		this._clientChannels[clientUsername] = data.channels;

		// create client
		let response = this.callbacks.createClient(data);

		if (!(response instanceof Promise)) {
			response = Promise.resolve(response);
		}

		response
			.then((newClient) => {
				if (!newClient) {
					this.emit('tmi.client.created', new Error('Client could not be created. No response from createClient callback.'));
					return;
				}

				this.clients[clientUsername] = newClient;
				this._addMetricEvents(newClient);

				newClient.on('connected', () => {
					for (const channel of this._clientChannels[clientUsername]) {
						this.joinChannel(channel, newClient);
					}
				});

				newClient.on('disconnected', (...args) => {
					if (newClient.readyState() !== 'CLOSED') {
						newClient.disconnect();
					}

					if (this.clients[clientUsername]) {
						process.env.DEBUG_ENABLED && console.error(`[tmi.js-cluster] [${process.env.PROCESS_ID}] Custom client disconnected.`, args);
						this.deleteClient(clientUsername);
					}
				});

				this.emit('tmi.client.created', null, clientUsername, newClient);
			});
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
				process.env.DEBUG_ENABLED && console.error(`[tmi.js-cluster] [${process.env.PROCESS_ID}] Main Client disconnected since 15s, terminating...`);

				await this.terminate();
			}
			catch (error) {
				console.error(`[tmi.js-cluster] [${process.env.PROCESS_ID}] terminate failed, force exit`);
				process.exit(0);
			}
		}
	}

	start() {
		this.emit('tmi.client.created', null, null, this._client);
	}

	getClient(channel, defaultValue) {
		channel = channelSanitize(channel);
		for (const client of [this._client, ...Object.values(this.clients)]) {
			if (client.getChannels().includes(channel)) {
				return client;
			}
		}

		return typeof defaultValue === 'undefined' ? this._client : defaultValue;
	}

	getChannels() {
		const channels = [];
		for (const client of [this._client, ...Object.values(this.clients)]) {
			channels.push(...client.getChannels());
		}

		return unique(channels);
	}

	deleteClient(clientName) {
		if (!tmiClusterConfig.multiClients.enabled) {
			console.error(`[tmi.js-cluster] [${process.env.PROCESS_ID}] Custom clients are disabled.`);
			return;
		}

		const client = this.clients[clientName];
		const channels = client.getChannels();

		// re-join, the queue manager will create a new client if required.
		if (channels.length) {
			this._channelDistributor.join(channels);
		}

		this.emit('tmi.client.deleted', clientName, client);

		delete this.clients[clientName];
		delete this._clientChannels[clientName];

		if (client.readyState() !== 'CLOSED') {
			client.disconnect();
		}
	}

	_addMetricEvents(client) {
		if (!tmiClusterConfig.metrics.enabled) {
			return;
		}

		client.on('message', () => {
			this._metrics.messages++;
		});
		client.on('raw_message', () => {
			this._metrics.rawMessages++;
		});
	}
}