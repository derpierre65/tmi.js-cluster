import merge from 'deepmerge';
import EventEmitter from 'node:events';
import os from 'os';
import path from 'path';
import AutoScale from './AutoScale';
import * as str from './lib/string';
import ProcessPool from './ProcessPool';
import SignalListener from './SignalListener';

export default class Supervisor extends EventEmitter {
	constructor(options, config) {
		super();

		process.env.TMI_CLUSTER_ROLE = 'supervisor';

		const defaultConfig = {
			file: 'bot.js',
			redis: {
				prefix: 'tmi-cluster:',
			},
			supervisor: {
				updateInterval: 3_000,
				keyLength: 8,
				stale: 30,
			},
			process: {
				stale: 30,
				periodicTimer: 2_000,
				timeout: 60_000,
			},
			metrics: {
				enabled: true,
				memory: true,
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
		this._channelDistributor = new options.channelDistributor(options);
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
					const now = new Date();

					this.database.query('INSERT INTO tmi_cluster_supervisors (??) VALUES (?)', [
						['id', 'last_ping_at', 'metrics', 'options', 'created_at'],
						[this.id, now, '{}', '{}', now],
					], (error) => {
						if (error) {
							console.error('[tmi.js-cluster] The supervisor couldn\'t be created.', error);

							return reject(error);
						}

						resolve();
					});
				});
			})
			.then(() => {
				console.debug(`[tmi.js-cluster] Supervisor ${this.id} started successfully.`);

				this.emit('supervisor.ready', this.id);
				this._processPool.scale(this._config.autoScale.processes.min);

				this._working = true;
				this._interval = setInterval(() => {
					if (this._working) {
						this._autoScale.scale();
						this._autoScale.releaseStaleSupervisors();
						this._processPool.monitor();
					}

					this.database?.query('UPDATE tmi_cluster_supervisors SET last_ping_at = ? WHERE id = ?;', [
						new Date(),
						this.id,
					], (error) => {
						if (error) {
							console.error(`[tmi.js-cluster] Supervisor ${this.id} ping update failed.`, error);
						}
					});

					this.emit('supervisor.ping', this.id);
				}, this._config.supervisor.updateInterval);
			})
			.catch((error) => {
				console.error(`[tmi.js-cluster] Supervisor ${this.id} could not be started.`, error);

				this.emit('supervisor.error', this.id, error);

				process.exit(0);
			});
	}

	terminate() {
		this._working = false;
		this.emit('supervisor.terminate', this.id);

		console.debug(`[tmi.js-cluster] Terminating supervisor ${this.id}...`);

		return this
			.getPromise('terminate')
			.then(() => this._processPool.terminate())
			.then(() => this._channelDistributor.terminate())
			.then(() => {
				console.debug(`[tmi.js-cluster] Supervisor ${this.id} terminated.`);
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
		if (path.isAbsolute(this._config.file)) {
			return this._config.file;
		}

		return path.join(process.cwd(), this._config.file);
	}
}