import EventEmitter from 'node:events';

export default class SignalListener extends EventEmitter {
	constructor(signalProcess, executor) {
		super();

		this._executor = executor;
		this._pendingSignals = [];
		this._executingSignal = null;

		process.env.DEBUG_ENABLED && console.debug(`[tmi.js-cluster] [${process.env.TMI_CLUSTER_ROLE}] Signal listener initialized.`);

		// set signals
		signalProcess.on('SIGINT', () => this._queueSignal('terminate'));
		signalProcess.on('SIGTERM', () => this._queueSignal('terminate'));
		signalProcess.on('uncaughtException', (error) => {
			console.error('------------');
			console.error('Uncaught exception');
			console.error(error);
			console.error('------------');

			this._queueSignal('terminate');
		});
		signalProcess.on('message', (message) => {
			if (message === 'terminate') {
				this._queueSignal('terminate');
			}
		});
	}

	_queueSignal(signal) {
		if (this._pendingSignals.includes(signal)) {
			return;
		}

		process.env.DEBUG_ENABLED && console.debug(`[tmi.js-cluster] [${process.env.TMI_CLUSTER_ROLE}] Queued process signal ${signal}.`);

		this._pendingSignals.push(signal);

		// execute the first signal if something is in the queue.
		this._executeNextSignal();
	}

	_executeNextSignal() {
		const signal = this._pendingSignals[0];

		if (this._executingSignal || !signal) {
			return;
		}

		this._executingSignal = signal;

		const result = (typeof this._executor[signal] === 'function' ? this._executor[signal]() : Promise.resolve()) || Promise.resolve();

		result
			.then(() => {
				this._pendingSignals.splice(0, 1);
				this._executingSignal = null;

				this._executeNextSignal();
			})
			.catch((error) => {
				// TODO debug, i dont know what i can do here, if i re-call it can fail again again and again
				console.error(`[tmi.js-cluster] Fail to execute process signal ${signal}`, error);
				process.exit(0);
			});
	}
}