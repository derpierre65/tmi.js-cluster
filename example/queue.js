const { createClient } = require('redis');

// `queue.js join channel,channel,channel` to join channels
// `queue.js part channel,channel,channel` to part channels

const redisClient = createClient({
	url: 'redis://127.0.0.1:16379',
});

redisClient
	.connect()
	.then(async () => {
		await redisClient.rPush('tmi-cluster:commands:join-handler', JSON.stringify({
			time: Date.now(),
			command: process.argv[2],
			options: {
				channels: process.argv[3].split(','),
			},
		}));

		process.exit(0);
	});