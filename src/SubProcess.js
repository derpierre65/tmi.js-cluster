const childProcess = require('child_process');

class SubProcess {
	constructor(id, supervisor, pool) {
		this.id = id;
		this._supervisor = supervisor;
		this._processPool = pool;
		this._process = null;
		this._channels = [];
	}

	start() {
		if (this._process) {
			return;
		}

		this._process = childProcess.fork(this._supervisor.modulePath, {
			env: {
				PROCESS_ID: this.id,
				TMI_CLUSTER: JSON.stringify(global.tmiClusterConfig),
			},
		});

		this._process.on('message', (data) => {
			if (typeof data !== 'object' || data === null) {
				return;
			}

			if (data.event === 'tmi.join_error') {
				this._supervisor.emit('tmi.join_error', data.channel, data.error);
			}
			else if (data.event === 'channels') {
				this._channels = data.channels;
			}
		});
		this._process.on('error', (error) => {
			console.log('[tmi.js-cluster] Process error appeared:', error);
		});
		this._process.on('close', () => {
			console.log(`[tmi.js-cluster] Process ${this.id} closed.`);
			this._processPool.removeProcess(this);
		});

		this._supervisor.emit('process.create', this.id);

		if (!this._supervisor.database) {
			return Promise.resolve();
		}

		return new Promise((resolve, reject) => {
			this._supervisor.database.query('INSERT INTO tmi_cluster_supervisor_processes (??) VALUES (?);', [
				['id', 'supervisor_id', 'state', 'channels', 'metrics', 'last_ping_at', 'created_at', 'updated_at'],
				[this.id, this._supervisor.id, 'starting', '[]', '{}', new Date(), new Date(), new Date()],
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
		this._processPool.markTermination(this);
		this._process.send('terminate');
	}
}

module.exports = SubProcess;
