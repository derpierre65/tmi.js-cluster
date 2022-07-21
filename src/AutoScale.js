import ProcessPool, {ProcessPoolInstance} from './ProcessPool';

export default class AutoScale {
	constructor() {
		this._scaling = false;
	}

	async scale() {
		if (this._scaling) {
			return;
		}

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
		await ProcessPoolInstance.scale(Math.min(
			global.tmiClusterConfig.autoScale.processes.max,
			ProcessPoolInstance.processes.length + 1,
		));
	}

	async scaleDown() {
		await ProcessPoolInstance.scale(Math.max(
			global.tmiClusterConfig.autoScale.processes.min,
			ProcessPoolInstance.processes.length - 1,
		));
	}

	getCurrentChannels() {
		const channelList = [];
		for (const process of ProcessPoolInstance.processes) {
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
}