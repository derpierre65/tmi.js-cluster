const EventEmitter = require('node:events');

class SignalListener extends EventEmitter {
	constructor(signalProcess, executor) {
		super();

		this._executor = executor;
		this._pendingSignals = [];
		this._executingSignal = null;

		// set signals
		signalProcess.on('SIGINT', () => this._queueSignal('terminate'));
		signalProcess.on('SIGTERM', () => this._queueSignal('terminate'));
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

		this._pendingSignals.push(signal);

		// execute the first signal if something is in the queue.
		if (this._executingSignal === null) {
			this._executeSignal(this._pendingSignals[0]);
		}
	}

	_executeSignal(nextSignal) {
		if (!nextSignal || this._executingSignal) {
			return;
		}

		let signal = this._pendingSignals[0];
		this._executingSignal = signal;

		const result = (this._executor[signal] ? this._executor[signal]() : Promise.resolve()) || Promise.resolve();

		result
			.then(() => {
				this._pendingSignals.splice(0, 1);
				this._executingSignal = null;

				// execute the next signal
				this._executeSignal(this._pendingSignals[0] || null);
			})
			.catch((error) => {
				// TODO debug, i dont know what i can do here, if i re-call it can fail again again and again
				console.error(`[tmi.js-cluster] Fail to execute process signal ${signal}`, error);
				process.exit(0);
			});
	}
}

module.exports = SignalListener;