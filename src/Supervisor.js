const EventEmitter = require('node:events');
const os = require('os');
const path = require('path');
const merge = require('deepmerge');

// internal libraries
const str = require('./lib/string');
const ProcessPool = require('./ProcessPool');
const SignalListener = require('./SignalListener');
const AutoScale = require('./AutoScale');

class Supervisor extends EventEmitter {
	constructor(options, config) {
		super();

		const defaultConfig = {
			file: 'bot.js',
			redis: {
				prefix: 'tmi-cluster:',
			},
			supervisor: {
				keyLength: 8,
				stale: 120,
			},
			process: {
				stale: 90,
				periodicTimer: 2_000,
				timeout: 60_000,
			},
			autoScale: {
				processes: {
					min: 2,
					max: 20,
				},
				thresholds: {
					channels: 1_000,
					scaleUp: 75,
					scaleDown: 50,
				},
			},
			throttle: {
				join: {
					block: 0,
					allow: 2_000,
					every: 10,
					take: 20,
				},
			},
		};

		config = merge(defaultConfig, config || {});

		// force empty config object if no config given
		if (typeof options !== 'object' || options === null) {
			options = {};
		}

		// save configs
		this._config = config;

		// internal initialization
		this.id = null;
		this.database = options.database || null;

		this._promises = options.promises || {};
		this._channelDistributor = options.channelDistributor;
		this._processPool = new ProcessPool(this);
		this._signalListener = new SignalListener(process, this);
		this._autoScale = (options.autoScale && new options.autoScale(this)) || new AutoScale(this);
		this._working = false;

		global.tmiClusterConfig = config;
	}

	spawn(validate) {
		this.id = this.generateUniqueSupervisorId();

		if (!(validate instanceof Promise)) {
			validate = Promise.resolve();
		}

		validate
			.then(() => {
				if (!this.database) {
					return Promise.resolve();
				}

				return new Promise((resolve, reject) => {
					this.database.query(
						'INSERT INTO tmi_cluster_supervisors (id, last_ping_at, metrics, options) VALUES (?)',
						[[this.id, new Date(), '{}', '{}']],
						(error) => {
							if (error) {
								console.error('The supervisor couldn\'t be created.');
								return reject(error);
							}

							resolve();
						});
				});
			})
			.then(() => {
				console.log(`[tmi.js-cluster] Supervisor ${this.id} started successfully.`);
				this.emit('supervisor.ready', this.id);
				this._processPool.scale(this._config.autoScale.processes.min);

				this._working = true;
				this._interval = setInterval(() => {
					if (this._working) {
						this._autoScale.scale();
						this._autoScale.releaseStaleSupervisors();
						this._processPool.monitor();
					}

					this.database?.query('UPDATE tmi_cluster_supervisors SET last_ping_at = ? WHERE id = ?', [
						new Date(),
						this.id,
					], (error) => {
						if (error) {
							console.error(`[tmi.js-cluster] Supervisor ${this.id} ping update failed.`, error);
						}
					});

					this.emit('supervisor.ping');
				}, 1_000);
			})
			.catch((error) => {
				console.error(`[tmi.js-cluster] Supervisor ${this.id} could not be started.`);
				this.emit('supervisor.error', this.id, error);

				process.exit(0);
			});
	}

	terminate() {
		this._working = false;
		this.emit('supervisor.terminate', this.id);

		console.log(`[tmi.js-cluster] Terminating supervisor ${this.id}...`);

		return this
			.getPromise('terminate')
			.then(() => this._processPool.terminate())
			.then(() => {
				if (!this.database) {
					return Promise.resolve();
				}

				return new Promise((resolve) => {
					this.database.query('DELETE FROM tmi_cluster_supervisors WHERE id = ?;DELETE FROM tmi_cluster_supervisor_processes WHERE supervisor_id = ?;', [this.id, this.id], (error) => {
						if (error) {
							console.error('[tmi.js-cluster] Fail to delete supervsior from database:', error);
						}

						// we are resolving this promise on error too
						resolve();
					});
				});
			})
			.then(() => {
				console.log(`[tmi.js-cluster] Supervisor ${this.id} closed.`);
				process.exit(0);
			});
	}

	getPromise(name, ...args) {
		return (this._promises[name] ? this._promises[name](...args) : Promise.resolve()) || Promise.resolve();
	}

	generateUniqueSupervisorId() {
		return os.hostname() + '-' + str.random(this._config.supervisor.keyLength);
	}

	get modulePath() {
		return path.join(process.cwd(), this._config.file);
	}
}

module.exports = Supervisor;