function channelSanitize(channel) {
	if (channel[0] !== '#') {
		channel = '#' + channel;
	}

	return channel.toLowerCase();
}

function channelUsername(channel) {
	return channel.replace(/#/g, '').toLowerCase();
}

function getQueueName(processId, name) {
	return [processId, name].join('-');
}

function unique(array) {
	return array.filter((value, index) => array.indexOf(value) === index);
}

function getRedisKey(name) {
	return (tmiClusterConfig.redis.prefix || '') + name;
}

async function wait(seconds) {
	return new Promise((resolve) => {
		setTimeout(resolve, seconds);
	});
}

export {
	channelSanitize,
	getQueueName,
	getRedisKey,
	unique,
	channelUsername,
	wait,
};