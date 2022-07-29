import childProcess from 'child_process';
import {ProcessPoolInstance} from './ProcessPool';
import {SupervisorInstance} from './Supervisor';

export default class SubProcess {
	constructor(id) {
		this.id = id;
		this._process = null;
		this._channels = [];
	}

	start() {
		if (this._process) {
			return;
		}

		this._process = childProcess.fork(SupervisorInstance.modulePath, {
			env: Object.assign({}, process.env, {
				PROCESS_ID: this.id,
				TMI_CLUSTER: JSON.stringify(global.tmiClusterConfig),
			}),
		});

		this._process.on('message', (data) => {
			if (typeof data !== 'object' || data === null) {
				return;
			}

			if (data.event === 'tmi.join') {
				SupervisorInstance.emit('tmi.join', data.error, data.channel);
			}
			else if (data.event === 'channels') {
				this._channels = data.channels;
			}
		});
		this._process.on('error', (error) => {
			console.error('[tmi.js-cluster] Process error appeared:', error);
		});
		this._process.on('close', () => {
			process.env.DEBUG_ENABLED && console.debug(`[tmi.js-cluster] [supervisor:${SupervisorInstance.id}] Process ${this.id} closed.`);
			ProcessPoolInstance.removeProcess(this);
		});

		SupervisorInstance.emit('process.create', this.id);

		if (!SupervisorInstance.database) {
			return Promise.resolve();
		}

		return new Promise((resolve, reject) => {
			SupervisorInstance.database.query('INSERT INTO tmi_cluster_supervisor_processes (??) VALUES (?);', [
				['id', 'supervisor_id', 'state', 'channels', 'clients', 'metrics', 'last_ping_at', 'created_at', 'updated_at'],
				[this.id, SupervisorInstance.id, 'STARTING', '[]', '[]', '{}', new Date(), new Date(), new Date()],
			], (error) => {
				if (error) {
					console.error('[tmi.js-cluster] Fail to insert the process into database.', error);

					return reject();
				}

				resolve();
			});
		});
	}

	async kill() {
		ProcessPoolInstance.markTermination(this);

		this._process.send('terminate');
	}
}