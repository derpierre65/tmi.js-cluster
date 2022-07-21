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

function getRedisKey(name) {
	return (global.tmiClusterConfig.redis.prefix || '') + name;
}

export {
	channelSanitize,
	getQueueName,
	getRedisKey,
	unique,
};