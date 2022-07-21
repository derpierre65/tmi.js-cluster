# Cluster System for [tmi.js](https://github.com/tmijs/tmi.js) Twitch Bots

![License](https://img.shields.io/github/license/derpierre65/tmi.js-cluster)
[![Downloads](https://img.shields.io/npm/dt/tmi.js-cluster)](https://www.npmjs.com/package/tmi.js-cluster)
[![NPM Version](https://img.shields.io/npm/v/tmi.js-cluster)](https://www.npmjs.com/package/tmi.js-cluster)
[![Node Version](https://img.shields.io/node/v/tmi.js-cluster.svg?style=flat)](https://www.npmjs.com/package/tmi.js-cluster)
[![Issues](https://img.shields.io/github/issues/derpierre65/tmi.js-cluster)](https://github.com/derpierre65/tmi.js-cluster/issues)
[![Pull Requests](https://img.shields.io/github/issues-pr/derpierre65/tmi.js-cluster)](https://github.com/derpierre65/tmi.js-cluster/pulls)
[![Discord](https://discordapp.com/api/guilds/933758189491613707/embed.png?style=shield)](https://discord.gg/Zg4VQXZ7MG)

## Introduction

tmi.js-cluster is a scalable cluster for [tmi.js](https://github.com/tmijs/tmi.js). This cluster can have multiple supervisors that can be deployed on multiple servers.  
The cluster store its data into a database and use a redis connection for the IRC command queue to join/part channels.  

## Features

- Supervisor can deployed on multiple servers.
- Use the up-to-date [tmi.js](https://github.com/tmijs/tmi.js) client.
- Monitoring dashboard.
- Optimized for unverified and verified bots.

## Supervisor Events

| Event                | Description                                      | Parameters           |
|----------------------|--------------------------------------------------|----------------------|
| supervisor.ready     | Supervisor is now ready.                         | supervisor id        |
| supervisor.error     | Supervisor couldn't spawned.                     | supervisor id, error |
| supervisor.terminate | Supervisor terminate started.                    | supervisor id        |
| supervisor.ping      | Health ping for the supervisor.                  | supervisor id        |
| process.create       | Process created.                                 | process id           |
| process.remove       | Process destroyed.                               | process id           |
| tmi.join             | Will emitted when the client join a channel.     | channel              |
| tmi.part             | Will emitted when the client part a channel.     | channel              |
| tmi.join_error       | Will emitted if the client can't join a channel. | channel, error       |
| tmi.part_error       | Will emitted if the client can't part a channel. | channel, error       |

## Configuration

Each and every option listed below is optional.

`file`: String - The bot file that should be executed if a new process will be created.

`redis`:
- `prefix`: String - Prefix for every redis key (Default: `tmi-cluster:`)

`supervisor`:
- `keyLength`: Number - Set the key length for the supervisor id. The supervisor id will be generated from hostname and a random generated string. (Default: `8`)
- `stale`: Number - The supervisor will be marked to terminate if the last ping was more than `stale` seconds ago. (Default: `15`)
- `updateInterval`: TODO

`metrics`:
- `enabled`: Boolean - If `true`, then metrics for every process will be generated and saved into the database. (Default: `true`) 
- `memory`: Boolean - If `true`, then the current memory (MB) will be saved into the metrics object. (Default: `true`)

`process`:
- `stale`: Number - The process will be marked to terminate if the last ping was more than `stale` seconds ago. (Default: `15`)
- `periodicTimer`: Number - After `periodicTimer` milliseconds the metrics will be saved into the database and queued channels will be joined or parted. (Default: `2_000`)
- `timeout`: Number - If the process was marked to terminate, after `timeout` milliseconds the process will be killed. (Default: `60_000`)

`autoScale`:
  - `processes`:
    - `min`: Number - The minimum of prcoesses. (Default: `2`)
    - `max`: Number - The maximum of processes. (Default: `20`)
  - `thresholds`:
    - `channels`: Number - The maximum target of channels per process. (Default: `1000`)
    - `scaleUp`: Number - If a supervisor reach more than `scaleUp`% channels then a new process will be created. (Default: `75`)
    - `scaleDown`: Number - If a supervisor reach less than `scaleUp`% channels then one process will be terminated. (Default: `50`)

`throttle`:
- `join`:
  - `allow`: Number - The maximum allowed `take` value. (Default: `2000`)
  - `every`: Number - The time to wait before the next channels are joined. (Default: `10`)
  - `take`: Number - The number of channels there should be joined every `every` seconds. Twitch allows 20/10s for normal users and 2000/10s for verified bots. (Default: `20`)


### Default Object

```json
{
    "file": "bot.js",
    "redis": {
        "prefix": "tmi-cluster:"
    },
    "supervisor": {
        "keyLength": 8,
        "stale": 15
    },
    "process": {
        "stale": 15,
        "periodicTimer": 2000,
        "timeout": 60000
    },
    "metrics": {
        "enabled": true,
        "memory": true
    },
    "autoScale": {
        "processes": {
            "min": 2,
            "max": 20
        },
        "thresholds": {
            "channels": 2000,
            "scaleUp": 75,
            "scaleDown": 50
        }
    },
    "throttle": {
        "join": {
            "allow": 2000,
            "every": 10,
            "take": 20
        }
    }
}
```