# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> *Note*: Some version numbers may be skipped to align feature set with the Java version.

---
## Version 4.3.3, 6/26/2025

### Added

1. Support file "append" mode in output data mapping
2. Dynamic fork-n-join feature for parallel processing of a list of elements by multiple instances of the same task

### Removed

N/A

### Changed

Improve CompileFlow error message. The new error message will tell where the error comes from.

---
## Version 4.3.1, 6/24/2025

### Added

Worked example and template to encapsulate worker thread as a composable function

### Removed

N/A

### Changed

N/A

---
## Version 4.3.0, 6/21/2025

### Added

N/A

### Removed

N/A

### Changed

Comprehensive refactoring applies to both JavaScript and TypeScript in the whole project
to comply with SonarQube's complexity recommendation of 15.

Complex code blocks are decomposed into multiple smaller methods to improve readability.

Singleton constructors are updated with the JavaScript's native double question mark
to check for null and undefined value.

Regression tests validated.

---
## Version 4.2.46, 6/2/2025

### Added

N/A

### Removed

The "npm run pull" command is no longer required

### Changed

Improved negate type mapping logic

---
## Version 4.2.45, 5/31/2025

### Added

1. "Empty array index" syntax in data mapping to append an element to an array in a dataset
2. Allow text constant in data mapping to contain any characters including the mapping signature "->"

### Removed

N/A

### Changed

Bugfix for certain edge cases in detecting a non-exist key in a MultiLevelMap

---
## Version 4.2.41, 5/17/2025

### Added

1. dynamic model variable as index to address an array element (support LHS and RHS mapping)
2. supports library resource file discovery in the configuration management system
3. updated documentation of configuration management in Appendix-I of developer guide

### Removed

N/A

### Changed

N/A

---
## Version 4.2.40, 5/10/2025

### Added

1. support of "flows" in the "modules.autostart" feature
2. "length" type matching feature
3. "dynamic model variables in for-loop" - model variable in comparator's left and/or right hand sides

### Removed

N/A

### Changed

Simplified configuration management system to support using the "test/resources" folder
to override the "src/resources" folder during unit tests.

---
## Version 4.2.39, 5/3/2025

### Added

Automatically start main composable modules and libaries:
When ComposableLoader initializes, it sends start commands to configured "main application"
or "library" modules.

### Removed

N/A

### Changed

N/A

---
## Version 4.2.38, 5/2/2025

### Added

N/A

### Removed

examples subproject

### Changed

update vitest.config.ts

---
## Version 4.2.37, 4/29/2025

### Added

vitest

### Removed

jest

### Changed

minor adjustment in unit tests for vitest syntax

---
## Version 4.2.36, 4/28/2025

### Added

Express static file handler

### Removed

1. REST automation static file handler
2. Custom MIME type configuration

### Changed

N/A

---
## Version 4.2.35, 4/25/2025

### Added

1. Support "matrix parameters" and "hash parameters" in HTTP request URI in platform-core
2. Exported the FlowExecutor class in index.ts

### Removed

N/A

### Changed

1. Bugfix for pipeline that contains only one task
2. Rename variable 'flow' to 'template' in FlowInstance
3. Apply path traversal avoidance using the Utility's getDecodedUri(path) method
   to each incoming HTTP request

---
## Version 4.2.28, 4/17/2025

### Added

Support 'Classpath' parameter in LHS of output data mapping

### Removed

HTML escape characters in URI path handling in AsyncHttpClient

### Changed

N/A

---
## Version 4.2.27, 3/31/2025

### Added

1. getError() method added in EventEnvelope to return encoded error message.
   This is required for distributed trace processing and proper error handling of subflows.

2. Generic resilience handler with alternative path and backoff features

### Removed

N/A

### Changed

Delete file when mapping a null value from the LHS to the RHS that is defined as a file,
thus allowing clearing of temporary data files in a flow.

---
## Version 4.2.23, 3/12/2025

### Added

N/A

### Removed

N/A

### Changed

For security, the parent state machine (namespace "model.parent") is a protected resource.
It can only be shared by the primary flow and all sub-flow instances that are instantiated from it.

---
## Version 4.2.22, 3/11/2025

### Added

N/A

### Removed

Dependency for "execa" is not required

### Changed

All sub-flows instantiated from a primary flow can access the same parent state machine
using the "model.parent" namespace

---
## Version 4.2.21, 3/9/2025

### Added

1. Support flow and function for external state machine
2. Parent state machine for sub-flow
3. Validation rules to reject access to the whole model or parent namespace

### Removed

N/A

### Changed

N/A

---
## Version 4.2.18, 2/21/2025

### Added

1. simple type matching feature is extended with a new string 'concat' method
2. default REST endpoints for /api/event and actuator services

### Removed

N/A

### Changed

1. Sort REST endpoints for orderly loading
2. Drop "async.http.request" RPC traces to reduce observability noise

---
## Version 4.2.17, 2/20/2025

### Added

Support scanning of TypeScript source file and compiled JavaScript files
with class scanners (TypeScriptClassScanner and JavaScriptClassScanner)

### Removed

N/A

### Changed

preloader.js and developer guide updated

---
## Version 4.2.16, 2/18/2025

### Added

N/A

### Removed

N/A

### Changed

1. Improved class scanner and loader
2. Filter out event metadata to propagate as HTTP response headers

---
## Version 4.2.15, 2/15/2025

### Added

1. Extract version from package.json to override info.app.version in application.yml
2. Fork-n-Join parallel RPC request API in PostOffice

### Removed

N/A

### Changed

Updated Developer Guide's Chapter 5 to describe publishing mercury-composable core
library to enterprise npm artifactory

---
## Version 4.2.14, 2/14/2025

### Added

1. Log application initialization time
2. Two additional actuator endpoints (/info/routes and /env)

### Removed

N/A

### Changed

1. use different route names for various actuator services to avoid hardcode of URLs
2. bugfix for Singleton pattern 

---
## Version 4.2.13, 2/13/2025

### Added

Actuator REST endpoints are now configurable in rest.yaml

### Removed

N/A

### Changed

Update actuator services to serve REST requests directly

---
## Version 4.2.10, 2/11/2025

### Added

N/A

### Removed

N/A

### Changed

Update Actuator function and REST automation's static HTML file handler
to address 2 security vulnerabilities reported by a Snyk scan.

---
## Version 4.2.9, 2/9/2025

### Added

1. uuid v4 generator in the "simple type matching" feature
2. event annotation feature
3. tagging feature in the EventEnvelope

### Removed

The "extra" field has been retired from EventEnvelope

### Changed

Filter out protected metadata from RPC response to user functions
(my_route, my_instance, my_trace_id, my_trace_path)

---
## Version 4.2.7, 2/4/2025

### Added

N/A

### Removed

N/A

### Changed

endFlow method of TaskExecutor sends event to distributed trace instead of logging

---
## Version 4.2.6, 2/3/2025

### Added

Added log.always feature in logger

### Removed

N/A

### Changed

Update distributed trace function to log in "always" mode

---
## Version 4.2.5, 2/2/2025

### Added

Add 3-part syntax for Event Script's data mapping processing.

Supports the following data mapping syntax:

1. LHS -> RHS
2. LHS -> model.variable -> RHS

### Removed

N/A

### Changed

1. Make input event immutable to PostOffice's send and request API
2. Consistent temporary stream folder name for Java and Node.js under /tmp/composable

---
## Version 4.2.3, 1/28/2025

### Added

Support of negate operator of a model value in event script added to the "simple type matching" feature

### Removed

N/A

### Changed

N/A

---
## Version 4.2.2, 1/22/2025

### Added

N/A

### Removed

N/A

### Changed

For consistency with the Composable Java version, do not use pretty JSON print when log.format=text

---
## Version 4.2.1, 1/21/2025

### Added

N/A

### Removed

N/A

### Changed

reconfigure logger to json or compact format early when app starts

---
## Version 4.2.0, 1/20/2025

This is a milestone release for consistent features and behaviors between
Java and Node.js versions

### Added

1. Composable methodology in developer guide
2. Event Script engine for event choreography
3. Composable example application

### Removed

N/A

### Changed

N/A

---
## Version 4.1.1, 12/22/2024

### Added

1. Composable class scanner for the source folder
2. Added "web.component.scan" parameter to support scanning of dependency libaries

### Removed

N/A

### Changed

N/A

---
## Version 4.1.0, 12/20/2024

### Added

AppConfig will resolve key-values from system properties and environment variables at startup

### Removed

Eliminate preload.yaml configuration file

### Changed

1. Streamlined configuration management
2. Updated preload annotation for developer to define concurrency

---
## Version 4.0.1, 12/16/2024

### Added

Support parsing of multiple environment variables and base system properties for
a single key-value in Config Reader.

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
