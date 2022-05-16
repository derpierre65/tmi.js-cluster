function channelSanitize(channel) {
	if (channel[0] !== '#') {
		channel = '#' + channel;
	}

	return channel.toLowerCase();
}

function getQueueName(processId, name) {
	return [processId, name].join('-');
}

module.exports = {
	channelSanitize,
	getQueueName,
};