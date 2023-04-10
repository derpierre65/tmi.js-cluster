# Changelog
All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0-alpha.3] - 2023-04-10
### Added
- **Breaking Change**: Split ChannelDistributor into ChannelDistributor (base class), RedisChannelDistributor and RedisPubSubChannelDistributor.
- `SUPERVISOR_ID` env variable for the current supervisor id.

### Changed
- **Breaking Change**: `throttle.join.every` and `throttle.clients.every` are now milliseconds instead of seconds.
- **Breaking Change**: Renamed queue redis key from `join-handler` to `command-queue`.
- Changed the way to rate limit the channel joins/parts. First join/part will start a `every`ms time window, within this window `allow` channels can be joined/parted.
- Faster unlock queue if the command queue is empty.

### Fixed
- Incorrect datetime value fixed ([#4](https://github.com/derpierre65/tmi.js-cluster/issues/4)).

### Removed
- Removed setting `throttle.join.take` and `throttle.clients.take`.

## [1.0.0-alpha.2] - 2022-09-27
### Added
- Support for multi clients.
- Option `process.terminateUncaughtException` to disable terminate on `uncaughtException`.

### Changed
- **Breaking Change**: Flipped the `tmi.join` and `tmi.part` arguments (first is the error (`null` if no error occurred), second the channel name).

### Fixed
- The order of queue commands was wrong if a client will be terminated and have an active queue in progress.

### Removed
- **Breaking Change**: Removed `joinNow` and `partNow` in ChannelDistributor. Can be replaced with the new second argument in `join` and `part`.
- Dropped `tmi.join_error` and `tmi.part_error`.

## [1.0.0-alpha.1] - 2022-07-29
### Added
- Support redis pub/sub for faster joining/parting channels.
- Priority for channel join/part order.
- Safe termination on `uncaughtException`.
- Mark a process as stale if the state is `TERMINATED` and will not waiting if the last ping is in stale range.
- Drop `PART` and `JOIN` event if a `PART` command has been found after the `JOIN` command for the given channel.
- Events (`tmi.join`, `tmi.join_error`, `tmi.part`, `tmi.part_error`) for TmiClient instance.
- Event `tmi.channels` added to TmiClient instance.

### Changed
- Updated release stale supervisors for a faster rejoin.

### Fixed
- Save current process channels if the process has been terminated to prevent loosing channels.

### Removed
- The dashboard vue.js code has been removed and moved to the laravel repository.
- Unused code.
- StaleIds from `join`, `joinNow`, `part` and `partNow`.

## [1.0.0-alpha.0] - 2022-07-08
### Added
- Initial Release