let CommandQueueInstance = null;

class CommandQueue {
	constructor() {
		CommandQueueInstance = this;
	}

	async getPendingCommands() {
		return [];
	}

	async pending(name) {
	}

	get enabled() {
		return false;
	}
}

export {
	CommandQueueInstance,
	CommandQueue as default,
};