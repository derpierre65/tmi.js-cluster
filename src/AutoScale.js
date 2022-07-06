class AutoScale {
	constructor(supervisor) {
		this._counter = 8;
		this._supervisor = supervisor;
		this._scaling = false;
		this._releaseStales = false;
	}

	async scale() {
		if (this._scaling) {
			return;
		}

		this._counter++;
		this._scaling = true;

		const [serverCount, channelCount] = this.getCurrentChannels();
		const currentUsage = this.getCurrentAverageChannelUsage(serverCount, channelCount);
		const nextUsage = this.getNextAverageChannelUsage(serverCount, channelCount);

		if (currentUsage > global.tmiClusterConfig.autoScale.thresholds.scaleUp && nextUsage > global.tmiClusterConfig.autoScale.thresholds.scaleDown) {
			await this.scaleUp();
		}
		else if (currentUsage < global.tmiClusterConfig.autoScale.thresholds.scaleDown && nextUsage < global.tmiClusterConfig.autoScale.thresholds.scaleUp) {
			await this.scaleDown();
		}

		this._scaling = false;
	}
	async scaleUp() {
		await this._supervisor._processPool.scale(
			Math.min(global.tmiClusterConfig.autoScale.processes.max, this._supervisor._processPool.processes.length + 1),
		);
	}

	async scaleDown() {
		await this._supervisor._processPool.scale(
			Math.max(global.tmiClusterConfig.autoScale.processes.min, this._supervisor._processPool.processes.length - 1),
		);
	}

	getCurrentChannels() {
		const channelList = [];
		for (const process of this._supervisor._processPool.processes) {
			channelList.push(process._channels.length);
		}

		return [
			channelList.length,
			channelList.reduce((previousValue, currentValue) => previousValue + currentValue, 0),
		];
	}

	getCurrentAverageChannelUsage(serverCount, channelCount) {
		if (serverCount === 0) {
			return 0;
		}

		return channelCount / (serverCount * global.tmiClusterConfig.autoScale.thresholds.channels) * 100;
	}

	getNextAverageChannelUsage(serverCount, channelCount) {
		return channelCount / ((serverCount + 1) * global.tmiClusterConfig.autoScale.thresholds.channels) * 100;
	}

	async releaseStaleSupervisors() {
		if (this._counter % 10 !== 0 || this._releaseStales) {
			return;
		}
		this._releaseStales = true;

		// TODO LOCK redis
		await this.flushStale();
		// TODO UNLOCK REDIS

		this._releaseStales = false;
	}

	async flushStale() {
		if (!this._supervisor.database) {
			return Promise.resolve();
		}

		const [supervisors, supervisorProcesses] = await new Promise((resolve, reject) => this._supervisor.database.query('SELECT * FROM tmi_cluster_supervisors; SELECT * FROM tmi_cluster_supervisor_processes;', (error, rows) => {
			if (error) {
				return reject(error);
			}

			resolve(rows);
		}));

		const currentDate = new Date();
		const supervisorStaleAfter = this._supervisor._config.supervisor.stale * 1_000;
		const processStaleAfter = this._supervisor._config.process.stale * 1_000;
		const deleteSupervisorIds = [];
		const channels = [];
		const staleIds = [];
		for (const supervisor of supervisors) {
			if (currentDate - supervisor.last_ping_at >= supervisorStaleAfter) {
				deleteSupervisorIds.push(supervisor.id);
			}
		}

		for (const supervisorProcess of supervisorProcesses) {
			if (currentDate - supervisorProcess.last_ping_at <= processStaleAfter) {
				continue;
			}

			staleIds.push(supervisorProcess.id);
			channels.push(...JSON.parse(supervisorProcess.channels));
		}

		if (deleteSupervisorIds.length > 0) {
			this._supervisor.database.query('DELETE FROM tmi_cluster_supervisors WHERE id IN (?);', [deleteSupervisorIds], (error) => error && console.error('[tmi.js-cluster] Delete staled Supervisors failed.', error));
		}
		if (staleIds.length > 0) {
			this._supervisor.database.query('DELETE FROM tmi_cluster_supervisor_processes WHERE id IN (?);', [staleIds], (error) => error && console.error('[tmi.js-cluster] Delete staled supervisor_processes failed.', error));
		}

		await this._supervisor._channelDistributor.flushStale(channels, staleIds);
	}
}

module.exports = AutoScale;