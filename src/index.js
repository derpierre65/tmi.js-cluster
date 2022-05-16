const Supervisor = require('./Supervisor');
const TmiClient = require('./TmiClient');
const RedisChannelDistributor = require('./redis/RedisChannelDistributor');
const RedisCommandQueue = require('./redis/RedisCommandQueue');
const { Enum } = require('./lib/enums');

module.exports = Supervisor;
module.exports.Supervisor = Supervisor;
module.exports.TmiClient = TmiClient;
module.exports.RedisChannelDistributor = RedisChannelDistributor;
module.exports.RedisCommandQueue = RedisCommandQueue;
module.exports.Enum = Enum;