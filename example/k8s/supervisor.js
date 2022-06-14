const mysql = require('mysql');
const { createClient } = require('redis');
const { RedisCommandQueue, Supervisor, RedisChannelDistributor } = require('../../src');

const db = mysql.createPool({
	host: process.env.DB_HOST,
	port: process.env.DB_PORT || 3306,
	user: process.env.DB_USERNAME || 'root',
	password: process.env.DB_PASSWORD || '',
	database: process.env.DB_DATABASE,
	multipleStatements: true,
	charset: 'utf8mb4_general_ci',
});

const redisClient = createClient({
	url: 'redis://' + process.env.REDIS_URL,
});

redisClient
	.connect()
	.then(() => {
		const manager = new Supervisor({
			database: db,
			channelDistributor: new RedisChannelDistributor(db, new RedisCommandQueue(redisClient)),
		}, {
			autoScale: {
				processes: {
					min: 1,
					max: 10,
				},
				thresholds: {
					channels: 30,
					scaleUp: 75,
					scaleDown: 50,
				},
			},
		});

		manager.on('process.create', (id) => {
			console.log('[supervisor] new process created, id:', id);
		});

		manager.on('tmi.join_error', (...args) => {
			console.log('[supervisor] can\'t join channel:', ...args);
		});

		manager.on('ping', () => {
			// console.log('[manager] supervisor running, last ping:', Date.now());
		});

		manager.spawn();
	})
	.catch((error) => {
		console.error('Can\'t connect to redis.', error)
	});