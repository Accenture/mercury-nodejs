# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---
## Version 4.0.1, 12/16/2024

Support parsing of multiple environment variables and base system properties for
a single key-value in Config Reader.

### Added

N/A

### Removed

N/A

### Changed

1. Improved environment variable parsing logic and detection of config loops.
2. Compatibility with Unix, Mac and Windows OS

---
## Version 4.0.0, 12/9/2024

Upgraded to sync with Mercury-Composable for the foundation event-driven and Event-over-HTTP
design. Tested with Node.js version 22.12.0 (LTS). Backward compatible to version 20.18.1 (LTS).

Event-over-HTTP compatibility tests conducted with Mercury-Composable version 4.0.32.

### Added

N/A

### Removed

N/A

### Changed

1. Refactored Event-over-HTTP to use standardized HTTP headers X-Stream-Id and X-Ttl
2. Updated OSS dependencies to latest version
3. Configured for EsLint version 9.16.0

---
## Version 3.0.0, 6/10/2023

Ported composable core features from Mercury 3.0 Java version

### Added

1. Unit and end-to-end tests for Mercury 3.0 Node.js and for the example app project.
2. For backward compatibility, added optional "setupMiddleware" method in the rest-automation module.

### Removed

Threshold feature in REST automation

### Changed

N/A

---
## Version 1.0.0, 5/30/2022

### Added

Minimal viable product

### Removed

N/A

### Changed

N/A
