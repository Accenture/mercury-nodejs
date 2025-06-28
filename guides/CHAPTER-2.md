# Function Execution Strategies

## Define a function

In a composable application, each function is self-contained with zero dependencies with other user functions.

Only flow adapter, data adapter, notification function or gateway has a single external dependency such as
a network event system, a database or an external REST resource.

A "task" or "function" is a class that implements the Composable interface. Within each function boundary, 
it may have private methods that are fully contained within the class.

As discussed in Chapter-1, a function may look like this:

```shell
export class MyFirstFunction implements Composable {

    @preload(my.first.function', 10)
    initialize(): Composable {
        return this;
    }

    async handleEvent(evt: EventEnvelope) {
        // your business logic here
        return result;
    }
}
```

A function is an event listener with the "handleEvent" method. The data structures of input and output are defined
by API interface contract in an event flow configuration.

In the above example, the input is an event envelope and the output is a set of key-values as a JSON object.
You can access event body (i.e. `payload`), headers and metadata from the event envelope.

For event choreography, input body is represented as a JSON object of key-values so that you can use the dot-bracket
convention to map a subset from one function to another if needed.

In addition to the event body, you may pass additional parameters to the user function as event headers.
We will discuss this in [Chapter 4 - Event Script Syntax](CHAPTER-4.md).

## Non-blocking design

By design, Javascript libraries are usually asynchronous. With functional isolation, each composable function is
executed through an event loop.

Inside your composable function, you can apply sequential, object-oriented or reactive programming styles.
Just make sure your code is not blocked. The composable interface enforces a function to be implemented using
either the "Promise" or the "async" pattern. Both of these patterns are non-blocking. The `async` pattern turns
a "Promise" function into sequential execution style to improve code readability. You should use the async/await
pattern as much as possible unless you have reason to use the `Promise` reactive coding style.

## Object serialization consideration

The system is designed to deliver primitive and JSON object of key-values through an event stream. If you pass
JSON object or primitive such as string or Buffer, you do not need to do any serialization.

> *Note*: You should not pass data `class` object as event body. Instead, please convert them using the JSON parser
  API and pass a JSON object of key-values. The standard JSON library can handle serialization and deserialization
  efficiently.

## Extensible authentication function

You can add authentication function using the optional `authentication` tag in a service. In "rest.yaml", a service
for a REST endpoint refers to a function in your application.

An authentication function can be written using a Composable function that takes the input body as an
"AsyncHttpRequest" like this:

```shell
const request = new AsyncHttpRequest(evt.getBody());
```

Your authentication function can return a boolean value to indicate if the request
should be accepted or rejected.

A typical authentication function may validate an HTTP header or cookie. e.g. forward the "Bearer token" from the
"Authorization" header to your organization's OAuth 2.0 Identity Provider for validation.

To approve an incoming request, your custom authentication function can return `true`.

Optionally, you can add "session" key-values by returning an EventEnvelope like this:

```shell
return new EventEnvelope().setHeader("user_id", "A12345").setBody(true);
```

The above example approves the incoming request and returns a "session" variable ("user_id": "A12345") to the
next task.

If your authentication function returns `false`, the user will receive a "HTTP-401 Unauthorized" error response.

You can also control the status code and error message by throwing an `AppException` like this:

```shell
throw new AppException(401, "Invalid credentials");
```

Alternatively, you may implement authentication as a user function in the first step of an event flow. In this case,
the input to the function is defined by the "input data mapping" rules in the event flow configuration.

The advantage of this approach is that authentication is shown as part of an event flow so that the application design
intention is clear.

A composable application is assembled from a collection of self-contained functions that are highly reusable.

## Number of workers for a function

In the following annotation, the execution concurrency is the second parameter in the `preload` annotation.
It tells the system to reserve a number of workers for the function. Workers are running on-demand to handle
concurrent user requests.

```shell
@preload(my.first.function', 10)
initialize(): Composable {
    return this;
}
```

Note that you can use smaller number of workers to handle many concurrent users if your function finishes
processing very quickly. If not, you should reserve more workers to handle the work load.

Concurrency requires careful planning for optimal performance and throughput.

## Functional isolation of legacy code

Node.js supports "functional isolation" using "worker-threads" technology. Each worker will run in a separate
Chromium `V8` engine with isolated memory space.

For some open source or legacy libraries that you have no control to convert into Composable functions, you can
encapsulate them into a separate worker thread and expose their capabilities as Composable functions.

For more details, please refer to :

1. [Chapter-4](CHAPTER-4.md#using-worker-threads)
2. [Mozilla] (https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Using_web_workers)
3. [Node.js] (https://nodejs.org/api/worker_threads.html)

A worked example is available in [Composable-example](https://github.com/Accenture/mercury-composable-examples)

The composable-worker.ts class may be used as a template:

https://github.com/Accenture/mercury-composable-examples/blob/main/node/composable-example/src/workers/composable-worker.ts

<br/>

|          Chapter-1           |                   Home                    |            Chapter-3            |
|:----------------------------:|:-----------------------------------------:|:-------------------------------:|
| [Introduction](CHAPTER-1.md) | [Table of Contents](TABLE-OF-CONTENTS.md) | [REST Automation](CHAPTER-3.md) |
