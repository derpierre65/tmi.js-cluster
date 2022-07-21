function channelSanitize(channel) {
	if (channel[0] !== '#') {
		channel = '#' + channel;
	}

	return channel.toLowerCase();
}

function getQueueName(processId, name) {
	return [processId, name].join('-');
}

function unique(array) {
	return array.filter((value, index) => array.indexOf(value) === index);
}

export {
	channelSanitize,
	getQueueName,
	unique,
};