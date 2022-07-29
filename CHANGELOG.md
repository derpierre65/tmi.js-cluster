# Changelog
All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]
### Added
- Support custom clients for specific channels.

### Changed
- **Breaking Change**: Flipped the `tmi.join` and `tmi.part` arguments (first is the error (`null` if no error occurred), second the channel name).

### Fixed
- The order of queue commands was wrong if a client will be terminated and have an active queue in progress.

### Removed
- Dropped `tmi.join_error` and `tmi.part_error`.

### Deprecated
- `joinNow` and `partNow` in ChannelDistributor is now deprecated. Can be replaced with the new second argument in `join` and `part`.

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