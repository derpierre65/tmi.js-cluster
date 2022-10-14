import {v4 as uuid} from 'uuid';
import SubProcess from './SubProcess';
import {SupervisorInstance} from './Supervisor';

/**
 * @type ProcessPool
 */
let ProcessPoolInstance = null;

class ProcessPool {
	/**
	 * @type ProcessPool
	 */
	static instance;

	constructor() {
		this.processes = [];
		this._terminatingProcesses = [];
		this._requestedProcessCount = 0;
		this._scalingInProcess = false;

		ProcessPoolInstance = this;
	}

	async scale(count) {
		this._requestedProcessCount = count;
		const newProcessCount = Math.max(0, count);

		// we do nothing, because we reached the scaling count.
		if (newProcessCount === this.processes.length) {
			return;
		}

		if (newProcessCount > this.processes.length) {
			await this.scaleUp(newProcessCount - this.processes.length);
		}
		else {
			await this.scaleDown(this.processes.length - newProcessCount);
		}
	}

	async scaleUp(difference) {
		process.env.DEBUG_ENABLED && console.debug(`[tmi.js-cluster] [supervisor:${SupervisorInstance.id}] Scale Up.`);

		for (let i = 0; i < difference; i++) {
			await this.createProcess();
		}
	}

	async scaleDown(difference) {
		process.env.DEBUG_ENABLED && console.debug(`[tmi.js-cluster] [supervisor:${SupervisorInstance.id}] Scale Down.`);

		const processes = this.processes.slice(0, difference);

		for (const process of processes) {
			process.kill();
		}

		return new Promise((resolve) => {
			const tempInterval = setInterval(() => {
				const removed = processes.filter((process) => !this.processes.includes(process)).length;
				if (removed === difference) {
					clearInterval(tempInterval);

					resolve();
				}
			}, 997);
		});
	}

	createProcess() {
		const subProcess = new SubProcess(uuid());

		this.processes.push(subProcess);

		return SupervisorInstance
			.getPromise('createProcess', subProcess.id)
			.then(() => subProcess.start());
	}

	removeProcess(subProcess) {
		const index = this.processes.indexOf(subProcess);
		if (index !== -1) {
			this.processes.splice(index, 1);

			SupervisorInstance.emit('process.remove', subProcess.id);
		}
	}

	async monitor() {
		this.stopHangingProcesses();

		if (this._scalingInProcess) {
			return;
		}

		try {
			this._scalingInProcess = true;
			await this.scale(this._requestedProcessCount);
			this._scalingInProcess = false;
		}
		catch (error) {
			console.error(`[tmi.js-cluster] [supervisor:${SupervisorInstance.id}] Scaling failed.`, error);
			process.exit(0);
		}
	}

	stopHangingProcesses() {
		for (const terminatingProcess of this._terminatingProcesses) {
			if (Date.now() - terminatingProcess.terminatedAt > tmiClusterConfig.process.timeout) {
				terminatingProcess.process.terminate();
			}

			// remove process from terminating process list if the process are unavailable.
			if (!this.processes.includes(terminatingProcess.process)) {
				const index = this._terminatingProcesses.indexOf(terminatingProcess);
				if (index >= 0) {
					this._terminatingProcesses.splice(index, 1);
				}
			}
		}
	}

	markTermination(subProcess) {
		this._terminatingProcesses.push({
			process: subProcess,
			terminatedAt: Date.now(),
		});
	}

	async terminate() {
		return new Promise((_resolve) => {
			const resolve = () => {
				clearInterval(terminateInterval);
				_resolve();
			};

			const terminateInterval = setInterval(() => {
				// wait until all processes are gone
				if (this.processes.length === 0) {
					return resolve();
				}
			}, 500);

			for (const process of this.processes) {
				process.kill();
			}
		});
	}
}

export {
	ProcessPoolInstance,
	ProcessPool as default,
};