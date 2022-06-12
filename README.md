# Mercury node.js language pack

This is the home for the Mercury node.js language pack.

The node.js language pack is an extension of the Mercury event-driven microservices development toolkit.

Like the python language pack for Mercury, the node.js language pack can be used in standalone mode to power node.js application for high performance event-driven programming.

When used with the Mercury language-connector, it connects your node.js application to the cloud, allowing you to expose your services as service APIs to the rest of the system.

## Getting Started

We are in alpha stage at this moment for code review, unit test, documentation and 'npm' library package preparation.

To setup the language-connector as a sidecar, clone the Mercury repository at https://github.com/Accenture/mercury and do a `mvn clean install` at the project root.
Follow the README to get the language-connector up and running.

Build this node.js language pack with `npm clean build` and run the main.js and stream-demo.js to test the initial functionality.
We will create an example folder to hold the various example code and templates.

## Worked examples

We encourage you trying our worked examples. Please refer to the [Worked Examples](EXAMPLES.md) for details.


# TypeScript project structure

This project borrowed the minimalist structure from https://github.com/jsynowiec/node-typescript-boilerplate and https://github.com/microsoft/TypeScript-Node-Starter
