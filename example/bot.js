const tmi = require('tmi.js');
const mysql = require('mysql');
const dotenv = require('dotenv');
const { createClient } = require('redis');
const { RedisCommandQueue, TmiClient, RedisChannelDistributor } = require('../src');

dotenv.config();

const db = mysql.createPool({
	host: '127.0.0.1',
	port: 3306,
	user: 'root',
	password: '',
	database: process.env.DB_DATABASE,
	multipleStatements: true,
	charset: 'utf8mb4_general_ci',
});

const client = new tmi.Client({
	connection: {
		reconnect: true,
		reconnectDecay: 1,
		secure: true,
		reconnectInterval: 10000,
	},
	identity: {
		username: process.env.TMI_USERNAME,
		password: process.env.TMI_PASSWORD,
	},
});

client.on('chat', (channel, userstate, message, self) => {
	// console.log(channel);
});

const redisClient = createClient({
	url: 'redis://127.0.0.1:16379',
});

redisClient
	.connect()
	.then(async () => {
		console.log('[bot] ready');
		new TmiClient({
			tmiClient: client,
			channelDistributor: new RedisChannelDistributor(db, new RedisCommandQueue(redisClient)),
			database: db,
		});

		client.connect();
	});