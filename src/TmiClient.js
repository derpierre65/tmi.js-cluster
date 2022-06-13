const SignalListener = require('./SignalListener');
const { getQueueName } = require('./lib/util');
const { Enum } = require('./lib/enums');

class TmiClient {
	constructor(options) {
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

		this._terminating = false;
		this._disconnectedSince = 0;
		this._client = options.tmiClient;
		this._database = options.database;
		this._channelDistributor = options.channelDistributor;
		this._commandQueue = this._channelDistributor.commandQueue;
		this._signalListener = new SignalListener(process, this);

		global.tmiClusterConfig = JSON.parse(process.env.TMI_CLUSTER);

		this._interval = setInterval(async () => {
			if (this._terminating) {
				return;
			}

			const currentState = this._client.readyState();
			const currentChannels = this._client.getChannels();

			await this._checkDisconnect(currentState);

			if (currentState !== 'OPEN') {
				return;
			}

			await this._processPendingCommands();

			process.send({
				event: 'channels',
				channels: currentChannels,
			});

			if (this._database) {
				this._database.query('UPDATE tmi_cluster_supervisor_processes SET state = ?, channels = ?, last_ping_at = ?, metrics = ? WHERE id = ?', [
					currentState,
					JSON.stringify(currentChannels),
					new Date(),
					JSON.stringify(this._metrics),
					process.env.PROCESS_ID,
				], (error) => {
					if (error) {
						console.error('[tmi.js-cluster] Fail to update supervisor process.', error);
					}
				});
			}
		}, global.tmiClusterConfig.process.periodicTimer);

		this._client.on('message', () => {
			this._metrics.messages++;
		});
		this._client.on('raw_message', () => {
			this._metrics.rawMessages++;
		});
		this._client.on('disconnected', () => {
			this.terminate();
		});
	}

	async _processPendingCommands() {
		const commands = await this._commandQueue.pending(this.getQueueName(Enum.CommandQueue.INPUT_QUEUE));
		commands.push(...await this._commandQueue.pending('*'));

		for (const command of commands) {
			this._metrics.queueCommands++;

			if (command.command === Enum.CommandQueue.COMMAND_JOIN) {
				this._client.join(command.options.channel).catch((error) => {
					setTimeout(() => {
						if (this._client.getChannels().includes(command.options.channel)) {
							return;
						}

						process.send({
							event: 'tmi.join_error',
							channel: command.options.channel,
							error,
						});
					}, 1_000);
				});
			}
			else if (command.command === Enum.CommandQueue.COMMAND_PART) {
				this._client.part(command.options.channel).catch((error) => {
					process.send({
						event: 'tmi.part_error',
						channel: command.options.channel,
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
		await this._channelDistributor.joinNow(this._client.getChannels());

		process.exit(0);
	}
}

module.exports = TmiClient;