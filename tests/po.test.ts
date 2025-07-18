import { Logger } from '../src/util/logger';
import { Composable } from '../src/models/composable';
import { FunctionRegistry } from '../src/system/function-registry';
import { PostOffice, Sender } from '../src/system/post-office';
import { Platform } from '../src/system/platform';
import { LocalPubSub } from '../src/system/local-pubsub';
import { RestAutomation } from '../src/system/rest-automation';
import { AppConfig, ConfigReader } from '../src/util/config-reader';
import { Utility } from '../src/util/utility';
import { MultiLevelMap } from '../src/util/multi-level-map';
import { EventEnvelope } from '../src/models/event-envelope';
import { AsyncHttpRequest } from '../src/models/async-http-request';
import { AppException } from '../src/models/app-exception';
import { ObjectStreamIO, ObjectStreamReader, ObjectStreamWriter } from '../src/system/object-stream';
import { HelloWorld } from './services/helloworld';
import { NextFunction, Request, Response } from 'express';
import fs from 'fs';
import { fileURLToPath } from "url";

const ASYNC_HTTP_CLIENT = 'async.http.request';
const API_AUTH_SERVICE = 'event.api.auth';
const HELLO_WORLD_SERVICE = 'hello.world';
const HELLO_PRIVATE_SERVICE = 'hello.private';
const HELLO_BFF_SERVICE = 'hello.bff';
const HELLO_DOWNLOAD = 'hello.download';
const HELLO_CUSTOM_CONTENT_TYPE = "hello.custom.content.type";
const DEMO_HEALTH_SERVICE = 'demo.health';
const HELLO_INTERCEPTOR_SERVICE = 'hello.interceptor';
const DEMO_LIBRARY_FUNCTION = "demo.library.function";
const DISTRIBUTED_TRACE_FORWARDER = 'distributed.trace.forwarder';
const UNIT_TEST = 'unit.test';
const TEST_MESSAGE = 'test message';
const DEMO_EXCEPTION = 'demo exception';
const NOT_HTTP_REQUEST = 'input is not a http request';
const TYPE = 'type';
const ERROR = 'error';
const TIMEOUT = 'timeout';
const HELLO_INSTANCE = 'x-hello-instance';
const HTML_PREFIX = '<html><body><pre>';
const HTML_SUFFIX = '</pre></body></html>';
const STREAM_CONTENT = 'x-stream-id';
// TEST_CYCLES must be larger than HELLO_WORLD_INSTANCES to demonstrate non-blocking event delivery
const HELLO_WORLD_INSTANCES = 5;
const TEST_CYCLES = 8;

const log = Logger.getInstance();
const registry = FunctionRegistry.getInstance();
const util = new Utility();
let platform: Platform;
let server: RestAutomation;
let endApiUrl: string;
let baseUrl: string;
let resourcePath: string;
let apiCount = 0;

function getRootFolder() {
  const folder = fileURLToPath(new URL("..", import.meta.url));
  // for windows OS, convert backslash to regular slash and drop drive letter from path
  const path = folder.includes('\\')? folder.replaceAll('\\', '/') : folder;
  const colon = path.indexOf(':');
  return colon == 1? path.substring(colon+1) : path;
}

class HelloDownload implements Composable {
  initialize(): Composable {
    return this;
  }
  async handleEvent(evt: EventEnvelope) {
    const request = new AsyncHttpRequest(evt.getBody() as object);
    if ('GET' != request.getMethod()) {
      throw new AppException(400, 'Download must be GET method');
    }
    const stream = new ObjectStreamIO();
    const out = new ObjectStreamWriter(stream.getOutputStreamId());
    out.write('hello world\n');
    out.write('end');
    await out.close();
    return new EventEnvelope().setHeader(STREAM_CONTENT, stream.getInputStreamId())
                .setHeader('content-type', 'application/octet-stream');
  }
}

class CustomContentTypeSender implements Composable {
  initialize(): Composable {
    return this;
  }
  async handleEvent(evt: EventEnvelope) {
    return new EventEnvelope().setHeader('content-type', 'application/vnd.my.org-v2.0+json; charset=utf-8').setBody(evt.getBody());
  }
}

class DemoHealth implements Composable {
  initialize(): Composable {
    return this;
  }
  async handleEvent(evt: EventEnvelope) {
    const command = evt.getHeader('type');
    if (command == 'info') {
      return {'service': 'demo.service', 'href': 'http://127.0.0.1'};
    }
    if (command == 'health') {
      // this is a dummy health check
      return {'status': 'demo.service is running fine'};
    }
    throw new AppException(400, 'Request type must be info or health');
  }
}

class DemoInterceptor implements Composable {
  initialize(): Composable {
    return this;
  }

  async handleEvent(evt: EventEnvelope) {
    const myRoute = evt.getHeader('my_route');
    //
    // Service interceptor does not need to have a "return" value.
    //
    // Usually, an interceptor will validate and forward the incoming event to another function.
    // For this unit test, this function will use the po.send method to return result to the caller.
    //
    const replyTo = evt.getReplyTo();
    if (replyTo) {
      log.info(`Interceptor ${myRoute} finds reply_to address as ${replyTo}`);
      const po = new PostOffice(evt);
      const response = new EventEnvelope().setBody(evt.getBody()).setTo(replyTo).setCorrelationId(evt.getCorrelationId());
      const cid = evt.getCorrelationId();
      if (cid) {
        log.info(`Interceptor ${myRoute} finds corelation_id as ${cid}`);
        response.setCorrelationId(cid);
      }
      await po.send(response);
    } else {
      log.info(`Interceptor ${myRoute} does not respond because there is no reply_to address`);
    }
    return null;
  }
}

class SimpleAuth implements Composable {
  initialize(): Composable {
    return this;
  }
  async handleEvent(evt: EventEnvelope) {
    const req = new AsyncHttpRequest(evt.getBody() as object);
    const authorized = "demo" == req.getHeader("authorization");
    const method = req.getMethod();
    const url = req.getUrl();
    log.info(`Perform API authentication for ${method} ${url}`);
    //
    // This is a test. When authorization=demo, it will approve the request.
    // When function returns false, the system will send "HTTP-401 Unauthorized" to the caller.
    //
    return new EventEnvelope().setBody(authorized).setHeader('user', 'demo');
  }
}

class HelloBff implements Composable {
  initialize(): Composable {
    return this;
  }

  handleEvent(evt: EventEnvelope): Promise<object> {
    // you can create a service as a Promise too
    return new Promise((resolve, reject) => {
      const req = new AsyncHttpRequest(evt.getBody() as object);
      if (req.getMethod()) {
        resolve(req.toMap());
      } else {
        reject(new Error(NOT_HTTP_REQUEST));
      }
    });
  }
}

class MyCallBackOne implements Composable {
  static name = 'my.callback.1';
  static result: string = '';

  initialize(): Composable {
    return this;
  }

  async handleEvent(evt: EventEnvelope) {
    MyCallBackOne.result = String(evt.getBody());
    return null;
  }
}

class MyCallBackTwo implements Composable {
  static name = 'my.callback.2';
  static result = new Map<number, EventEnvelope>();
  static count = 0;

  initialize(): Composable {
    return this;
  }

  async handleEvent(evt: EventEnvelope) {
    MyCallBackTwo.result.set(++MyCallBackTwo.count, evt);
    return null;
  }
}

class TraceForwarder implements Composable {
  static readonly traceId = util.getUuid();
  static readonly tracePath = 'PUT /api/demo/test';
  static readonly traceStack: Array<object> = [];

  initialize(): Composable {
    return this;
  }

  async handleEvent(evt: EventEnvelope) {
    const payload = evt.getBody() as object;    
    if ('trace' in payload) {
      const metrics = payload['trace'] as object;
      // ignore trace metrics from other unit tests
      if (TraceForwarder.traceId == metrics['id']) {
        TraceForwarder.traceStack.push(metrics);
      }
    }
    return null;
  }
}

describe('post office use cases', () => {

    beforeAll(async () => {
      resourcePath = getRootFolder() + 'tests/resources';
      // AppConfig should be initialized with base configuration parameter before everything else
      const appConfig = AppConfig.getInstance(resourcePath);
      platform = Platform.getInstance();
      await platform.getReady();
      // save the helloWorld as DEMO_LIBRARY_FUNCTION so that it can be retrieved by name
      const helloWorld = new HelloWorld();
      // when a composable class is registered, it is available in the registry
      platform.register(DEMO_LIBRARY_FUNCTION, helloWorld);
      // register a hello.world function to echo the incoming payload
      platform.register(HELLO_WORLD_SERVICE, helloWorld, HELLO_WORLD_INSTANCES, false);
      // register the same function as another route name and declare it as private
      platform.register(HELLO_PRIVATE_SERVICE, helloWorld);
      // you can create a service as a Promise too
      platform.register(HELLO_BFF_SERVICE, new HelloBff());
      platform.register(HELLO_DOWNLOAD, new HelloDownload());
      platform.register(HELLO_CUSTOM_CONTENT_TYPE, new CustomContentTypeSender());
      // register a demo health check
      platform.register(DEMO_HEALTH_SERVICE, new DemoHealth());
      // register the demo interceptor function
      platform.register(HELLO_INTERCEPTOR_SERVICE, new DemoInterceptor(), 1, true, true);
      appConfig.set('health.dependencies', 'demo.health');
      // this tests that we can create a user defined config reader that resolves references from the base configuration
      const configMap = {'event.api.url': 'http://127.0.0.1:${server.port:8080}/api/event', 'base.url': 'http://127.0.0.1:${server.port:8080}'}
      const reader = new ConfigReader(configMap);
      endApiUrl = reader.getProperty('event.api.url');
      baseUrl = reader.getProperty('base.url');
      log.info(`PostOffice tests will use ${baseUrl}`);
      platform.register(API_AUTH_SERVICE, new SimpleAuth());
      // test streaming I/O
      const stream = new ObjectStreamIO();
      const outputId = stream.getOutputStreamId();
      const streamOut = new ObjectStreamWriter(outputId);
      streamOut.write('hello world');
      // start the Event API HTTP server
      server = RestAutomation.getInstance();
      // demonstrate that we can install user defined express middleware
      server.setupMiddleWare(async function(_req: Request, _res: Response, next: NextFunction) {
          apiCount++;
          next();
      });
      server.start();
      platform.runForever();
    });

    afterAll(async () => {
      if (server) {
        // This is redundant because the server will be automatically stopped by the platform
        await server.stop();
      } 
      // This will release all outstanding streams, stop REST automation and then stop the platform
      await platform.stop();
      log.info(`Total ${apiCount} REST API processed`);
      // Give console.log a moment to finish
      await util.sleep(1000);
    });

    it('can make a RPC request', async () => {
      const po = new PostOffice(new Sender('unit.test', '100', 'TEST /demo/rpc'));
      const req = new EventEnvelope().setTo(HELLO_WORLD_SERVICE).setBody(TEST_MESSAGE);
      const result = await po.request(req, 3000);
      expect(result.getBody()).toBe(TEST_MESSAGE);       
    });

    it('can retrieve metadata from Composable function', async () => {
      const po = new PostOffice(new Sender('unit.test', '101', 'TEST /demo/metadata'));
      const req = new EventEnvelope().setTo(HELLO_WORLD_SERVICE).setHeader('type', 'metadata');
      const result = await po.request(req, 3000);
      expect(result.getBody()).toBeInstanceOf(Object);
      const body = result.getBody() as object;
      expect('route' in body).toBe(true); 
      expect('trace_id' in body).toBe(true); 
      expect('trace_path' in body).toBe(true); 
      expect(body['route']).toBe(HELLO_WORLD_SERVICE);
      expect(body['trace_id']).toBe('101');
      expect(body['trace_path']).toBe(`TEST /demo/metadata`);   
    });

    it('can send to an interceptor and expect a result', async () => {
      const cid = 'abc001';
      const po = new PostOffice(new Sender('unit.test', '120', 'TEST /demo/interceptor'));
      const req = new EventEnvelope().setTo(HELLO_INTERCEPTOR_SERVICE).setBody(TEST_MESSAGE).setCorrelationId(cid);
      const result = await po.request(req, 3000);
      expect(result.getBody()).toBe(TEST_MESSAGE);
      expect(result.getCorrelationId()).toBe(cid);
    });

    it('can catch exception from RPC', async () => {
        const req = new EventEnvelope().setTo(HELLO_WORLD_SERVICE).setHeader(TYPE, ERROR);
        // Send a call to trigger an exception
        const po = new PostOffice(new Sender('unit.test', '200', 'TEST /demo/exception'));
        await expect(po.request(req, 3000)).rejects.toMatchObject({
          message: DEMO_EXCEPTION,
          status: 400, // Include this if you want to check the status
      })
        // Check the exact exception status and message with the try-await-catch pattern
        let ex = null;
        try {
          await po.request(req, 3000);
        } catch(e) {
          ex = e;
        }
        expect(ex).toBeInstanceOf(AppException);
        expect(String(ex)).toBe('Error: demo exception');        
    });

    it('can catch timeout from RPC', async () => {
        const req = new EventEnvelope().setTo(HELLO_WORLD_SERVICE).setHeader(TYPE, TIMEOUT);
        // Send a call to trigger an exception
        const po = new PostOffice(new Sender('unit.test', '300', 'TEST /demo/timeout'));
        await expect(po.request(req, 100)).rejects.toEqual(new AppException(408, "Route hello.world timeout for 100 ms"));
        // Check the exact exception status and message with the try-await-catch pattern
        let normal = false;
        try {
          await po.request(req, 100);
          normal = true;
        } catch(e) {
          expect(e).toBeInstanceOf(AppException);
          let ex = e as AppException;
          expect(ex.getStatus()).toBe(408);
          expect(ex.getMessage()).toBe("Route hello.world timeout for 100 ms");
        }
        expect(normal).toBe(false);  
    });

    it('can handle async HTTP request', async () => {
        // we will emulate REST automation by sending a http request event
        const method = 'PUT';
        const url = '/api/hello/world';
        const host = 'http://127.0.0.1';
        const key = 'key';
        const value = 'value';
        const user = 'user';
        const name = 'someone';
        const contentType = 'content-type';
        const textPlain = 'text/plain';
        const httpRequest = new AsyncHttpRequest();
        httpRequest.setMethod(method).setUrl(url).setTargetHost(host)
                    .setBody(TEST_MESSAGE).setHeader(contentType, textPlain)
                    .setContentLength(TEST_MESSAGE.length)
                    .setSessionInfo(key, value).setSecure(true)
                    .setTrustAllCert(true)
                    .setCookie(key, value)
                    .setQueryParameter(key, value).setPathParameter(user, name);
        const req = new EventEnvelope().setTo(HELLO_BFF_SERVICE).setBody(httpRequest.toMap());
        const po = new PostOffice();
        const result = await po.request(req, 3000);  
        expect(result.getBody()).toBeInstanceOf(Object);
        const echo = new AsyncHttpRequest(result.getBody() as object);
        expect(echo.getBody()).toBe(TEST_MESSAGE);
        expect(echo.getMethod()).toBe(method);
        expect(echo.getUrl()).toBe(url);
        expect(echo.getQueryParameter(key)).toBe(value);
        expect(echo.getPathParameter(user)).toBe(name);
        expect(echo.getSessionInfo(key)).toBe(value);
        expect(echo.getHeader(contentType)).toBe(textPlain);
        expect(echo.isSecure()).toBeTruthy();
        expect(echo.isTrustAllCert()).toBeTruthy();
        expect(echo.getContentLength()).toBe(TEST_MESSAGE.length);
        expect(echo.getCookie(key)).toBe(value);
        expect(echo.getQueryParameters()).toBeInstanceOf(Object);
        expect(echo.getCookies()).toBeInstanceOf(Object);
        expect(echo.getPathParameters()).toBeInstanceOf(Object);
        expect(echo.getSession()).toBeInstanceOf(Object);
    });
    
    it('can catch exception from a HTTP service', async () => {
        const req = new EventEnvelope().setTo(HELLO_BFF_SERVICE).setBody(ERROR);
        const po = new PostOffice();
        await expect(po.request(req, 3000)).rejects.toEqual(new AppException(500, NOT_HTTP_REQUEST));     
    });

    it('can reply to a callback', async () => {
        const callback = new MyCallBackOne();
        platform.register(MyCallBackOne.name, callback);
        const po = new PostOffice(new Sender('unit.test', '333', 'TEST /demo/callback'));
        // send a request to hello.world and set the replyTo address as my.callback
        const request = new EventEnvelope().setTo(HELLO_WORLD_SERVICE).setBody(TEST_MESSAGE).setReplyTo(MyCallBackOne.name);
        po.send(request);
        // since it is asynchronous, we will wait up to 5 seconds for the callback result
        for (let i=0; i < 100; i++) {
          await util.sleep(50);
          if (MyCallBackOne.result.length > 0) {
            break;
          }
        }
        expect(MyCallBackOne.result).toBe(TEST_MESSAGE);
        // the call back function is used once
        platform.release(MyCallBackOne.name);     
    });
    
    it('can catch all traces with a distributed trace forwarder', async () => {
        const forwarder = new TraceForwarder();
        platform.register(DISTRIBUTED_TRACE_FORWARDER, forwarder);
        const po = new PostOffice(new Sender('unit.test', TraceForwarder.traceId, TraceForwarder.tracePath));
        const request = new EventEnvelope().setTo(HELLO_WORLD_SERVICE).setBody(TEST_MESSAGE);
        const result = await po.request(request, 3000);      
        expect(result.getBody()).toBe(TEST_MESSAGE);
        // since it is asynchronous, we will wait up to 5 seconds for the callback result
        for (let i=0; i < 100; i++) {
          await util.sleep(50);
          if (TraceForwarder.traceStack.length > 0) {
            break;
          }
        }        
        expect(TraceForwarder.traceStack.length).toBe(1);
        const metrics: object = TraceForwarder.traceStack[0];
        expect(metrics['id']).toBe(TraceForwarder.traceId);
        expect(metrics['path']).toBe(TraceForwarder.tracePath);
        expect(metrics['from']).toBe(UNIT_TEST);
        expect(metrics['service']).toBe(HELLO_WORLD_SERVICE);
        expect(metrics['success']).toBe(true);
        // unload the trace processor after test
        platform.release(DISTRIBUTED_TRACE_FORWARDER);
    });

    it('can deliver events orderly', async () => {
        const callback = new MyCallBackTwo();
        platform.register(MyCallBackTwo.name, callback);
        const po = new PostOffice(new Sender('unit.test', '123', '/test/queuing'));
        // send a request to hello.world and set the replyTo address as my.callback        
        for (let i=1; i <= TEST_CYCLES; i++) {
          const request = new EventEnvelope().setTo(HELLO_WORLD_SERVICE).setBody(TEST_MESSAGE+' '+i).setReplyTo(MyCallBackTwo.name);
          po.send(request);
        }
        // since it is asynchronous, we will wait up to 5 seconds for all callback results
        for (let i=0; i < 100; i++) {
          await util.sleep(50);
          if (MyCallBackTwo.count == TEST_CYCLES) {
            break;
          }
        }
        expect(MyCallBackTwo.count).toBe(TEST_CYCLES);
        // verify that the events are delivered orderly
        for (let i=1; i <= MyCallBackTwo.count; i++) {
          const event = MyCallBackTwo.result.get(i);
          expect(event?.getTo()).toBe(MyCallBackTwo.name);
          expect(event?.getHeader('my_route')).toBe(MyCallBackTwo.name);
          expect(event?.getHeader('my_instance')).toBe('1');
          // There are a total of 5 workers of "hello.world".
          // Two workers are engaged for the "timeout" unit test earlier.
          // Therefore, the events will be distributed among the remaining 3 workers.
          // This demonstrates that the workers are working in a non-blocking fashion.
          log.info({'received': {'header': event?.getHeaders(), 'body': event?.getBody()}});
          expect(event?.getBody()).toBe(TEST_MESSAGE+' '+i);
        }
        // the call back function is used once
        platform.release(MyCallBackTwo.name);
    });

    it('can handle custom content type mapping', async () => {
      const po = new PostOffice(new Sender('unit.test', '80000', 'POST /api/hello/custom/content/type'));
      const req = new AsyncHttpRequest().setMethod('POST').setTargetHost(baseUrl).setUrl('/api/hello/custom/content/type')
                      .setHeader('content-type', 'application/json').setHeader('accept', 'application/json')
                      .setBody({'hello': 'world'});
      const reqEvent = new EventEnvelope().setTo(ASYNC_HTTP_CLIENT).setBody(req.toMap());
      const result = await po.request(reqEvent);
      // custom content-type will be rendered as per configuration
      // 'application/vnd.my.org-v2.0+json -> application/json'
      expect(result.getHeader('content-type')).toBe('application/vnd.my.org-v2.0+json; charset=utf-8');
      expect(result.getBody() instanceof Object).toBe(true);
      const map = new MultiLevelMap(result.getBody() as object);
      expect(map.getElement('headers.user-agent')).toBe('async-http-client');
      expect(map.getElement('body')).toEqual({'hello': 'world'});
    });

    it('can make a RPC call using Event API', async () => {
      const po = new PostOffice(new Sender('unit.test', 'A10000', 'TEST /api/event/test'));
      const event = new EventEnvelope().setTo(HELLO_WORLD_SERVICE).setBody("test").setHeader("x", "y");
      const result = await po.remoteRequest(event, endApiUrl, {'authorization': 'demo'});
      expect(result).toBeTruthy();
      expect(result.getBody()).toBe("test");
      expect(result.getFrom()).toBe(HELLO_WORLD_SERVICE);
      expect(result.getHeader("x")).toBe("y");
      // validate that session information is added by API authentication module
      expect(result.getHeader("user")).toBe("demo");
      log.info(result.toMap());
    });

    it('can reject a RPC call with HTTP-401 using Event-over-HTTP API', async () => {
      const po = new PostOffice(new Sender('unit.test', 'B10000', 'TEST /api/event/test'));
      const event = new EventEnvelope().setTo(HELLO_WORLD_SERVICE).setBody("test").setHeader("x", "y");
      const result = await po.remoteRequest(event, endApiUrl, {'authorization': 'anyone'});
      expect(result).toBeTruthy();
      expect(result.getStatus()).toBe(401);
      expect(result.getBody()).toBe("Unauthorized");
    });    

    it('can make a drop-n-forget call using Event-over-HTTP API', async () => {
      const po1 = new PostOffice(new Sender('unit.test', '10001a', 'TEST /api/event/test'));
      const event = new EventEnvelope().setTo(HELLO_WORLD_SERVICE).setBody("test").setHeader("x", "y");
      // send a drop-n-forget call
      await po1.send(event);
      // send a drop-n-forget call using Event-over-HTTP
      const po = new PostOffice(new Sender('unit.test', '10001b', 'TEST /api/event/test'));
      const result = await po.remoteRequest(event, endApiUrl, {'authorization': 'demo'}, false);
      expect(result).toBeTruthy();
      expect(result.getBody()).toBeInstanceOf(Object);
      const data = result.getBody() as object;
      expect(data['delivered']).toBe(true);
      expect(data['type']).toBe('async');
      log.info(result.toMap());    
    });

    it('will throw exception when the remote service is private', async () => {
      const po = new PostOffice(new Sender('unit.test', '10003', 'TEST /api/event/test'));
      const event = new EventEnvelope().setTo(HELLO_PRIVATE_SERVICE).setBody("test");
      const result = await po.remoteRequest(event, endApiUrl, {'authorization': 'demo'});
      expect(result).toBeTruthy();
      expect(result.getStatus()).toBe(403);
      expect(result.getBody()).toBe("Route hello.private is private");      
    });    

    it('will throw exception when the remote service does not exist', async () => {
      const po = new PostOffice(new Sender('unit.test', '10004', 'TEST /api/event/test'));
      const event = new EventEnvelope().setTo("no.such.service").setBody("test");
      const result = await po.remoteRequest(event, endApiUrl, {'authorization': 'demo'});
      expect(result).toBeTruthy();
      expect(result.getStatus()).toBe(400);
      expect(result.getBody()).toBe("Route no.such.service not found"); 
    });

    it('can validate the class instance in a registry', async () => {
      const exists = registry.exists(DEMO_LIBRARY_FUNCTION);
      expect(exists).toBe(true);
      const f = registry.get(DEMO_LIBRARY_FUNCTION);
      expect(f).toBeInstanceOf(Function);
      const cls = registry.getClass(DEMO_LIBRARY_FUNCTION);
      expect(cls).toBeInstanceOf(HelloWorld);
    });

    it('will reject platform registration of invalid route name', async () => {
      const exists = registry.exists(DEMO_LIBRARY_FUNCTION);
      expect(exists).toBe(true);
      const helloWorld = registry.getClass(DEMO_LIBRARY_FUNCTION);
      const route = 'Invalid route';
      let normal = false;
      try {
        platform.register(route, helloWorld);
        normal = true;
      } catch (e) {
        expect(e.message).toBe('Check route name - use 0-9, a-z, period, hyphen or underscore characters');
      }    
      expect(normal).toBe(false);  
    }); 
    
    it('can subscribe to a pub/sub topic', async () => {
      const topic = 'test.topic';
      const member1 = 'test.member.1';
      const member2 = 'test.member.2';
      const ps = new LocalPubSub();
      ps.createTopic(topic);
      // you can subscribe a member before the member is created
      ps.subscribe(topic, member1);
      ps.subscribe(topic, member2);
      // register the member services
      platform.register(member1, new DemoInterceptor(), 1, true, true);
      platform.register(member2, new DemoInterceptor(), 1, true, true);
      const cid = 'x201';
      const po = new PostOffice(new Sender('unit.test', '222', 'TEST /demo/pubsub'));
      const req = new EventEnvelope().setTo(topic).setBody(TEST_MESSAGE).setCorrelationId(cid);
      // Pub/sub will broadcast to all members of a topic
      po.send(req);
      //
      // Pub/sub is designed to broadcast events
      // 
      // For unit test purpose, we send the event again using RPC.
      // After the first member returns a result, the temporary inbox is closed
      // and thus you will see a delivery error for the second response.
      // This is an expected behavior.
      //
      const result = await po.request(new EventEnvelope(req), 3000);
      expect(result.getBody()).toBe(TEST_MESSAGE);
      expect(result.getCorrelationId()).toBe(cid);
      // check if the topic has the member subscribed
      const members = ps.getSubscribers(topic);
      expect(members.includes(member1));
      expect(members.includes(member2));
      // check if the topic is available
      const topics = ps.getTopics();
      expect(topics.includes(topic)).toBe(true);
      // unsubscribe member and delete topic
      ps.unsubscribe(topic, member1);
      ps.deleteTopic(topic);
      // topic should disappear when checking topic list again
      const topicsAgain = ps.getTopics();
      expect(topicsAgain.includes(topic)).toBe(false);
    });    
    
    it('can get response from /info endpoint', async () => {
      const po = new PostOffice();
      const req = new AsyncHttpRequest().setMethod('GET').setTargetHost(baseUrl).setUrl('/info');
      const reqEvent = new EventEnvelope().setTo(ASYNC_HTTP_CLIENT).setBody(req.toMap());
      const result = await po.request(reqEvent);
      expect(result.getHeader('content-type')).toBe('application/json');
      expect(result.getBody() instanceof Object).toBe(true);
      const map = new MultiLevelMap(result.getBody() as object);
      expect(map.getElement('app.name')).toBe('platform-core');
      expect(map.getElement('origin')).toBe(platform.getOriginId());
      expect(map.getElement('app.version')).toBe('4.2.37');
    });

    it('can get response from /info/routes endpoint', async () => {
      const po = new PostOffice();
      const req = new AsyncHttpRequest().setMethod('GET').setTargetHost(baseUrl).setUrl('/info/routes');
      const reqEvent = new EventEnvelope().setTo(ASYNC_HTTP_CLIENT).setBody(req.toMap());
      const result = await po.request(reqEvent);
      expect(result.getHeader('content-type')).toBe('application/json');
      expect(result.getBody() instanceof Object).toBe(true);
      const map = new MultiLevelMap(result.getBody() as object);
      expect(map.getElement('app.name')).toBe('platform-core');
      expect(map.getElement('origin')).toBe(platform.getOriginId());
      expect(map.getElement('app.version')).toBe('4.2.37');
      const publicRoutes = map.getElement('routing.public');
      expect(publicRoutes instanceof Object).toBe(true);
      const r1 = publicRoutes as object;
      expect(r1['hello.world']).toBe(5);
      const privateRoutes = map.getElement('routing.private');
      expect(privateRoutes instanceof Object).toBe(true);
      const r2 = privateRoutes as object;
      expect(r2['demo.health']).toBe(1);
    });
    
    it('can get response from /env endpoint', async () => {
      const po = new PostOffice();
      const req = new AsyncHttpRequest().setMethod('GET').setTargetHost(baseUrl).setUrl('/env');
      const reqEvent = new EventEnvelope().setTo(ASYNC_HTTP_CLIENT).setBody(req.toMap());
      const result = await po.request(reqEvent);
      expect(result.getHeader('content-type')).toBe('application/json');
      expect(result.getBody() instanceof Object).toBe(true);
      const map = new MultiLevelMap(result.getBody() as object);
      expect(map.getElement('app.name')).toBe('platform-core');
      expect(map.getElement('origin')).toBe(platform.getOriginId());
      expect(map.getElement('app.version')).toBe('4.2.37');
      const envKv = map.getElement('env.environment');
      expect(envKv instanceof Object).toBe(true);
      const r1 = envKv as object;
      expect(r1['PATH']).toBe(process.env['PATH']);
      const propKv = map.getElement('env.properties');
      expect(propKv instanceof Object).toBe(true);
      const r2 = propKv as object;
      expect(r2['log.format']).toBe('text');
    });      
    
    it('can get response from /health endpoint', async () => {
      const po = new PostOffice();
      const req = new AsyncHttpRequest().setMethod('GET').setTargetHost(baseUrl).setUrl('/health');
      const reqEvent = new EventEnvelope().setTo(ASYNC_HTTP_CLIENT).setBody(req.toMap());
      const result = await po.request(reqEvent);
      expect(result.getHeader('content-type')).toBe('application/json');
      expect(result.getBody() instanceof Object).toBe(true);
      const map = new MultiLevelMap(result.getBody() as object);
      expect(map.getElement('name')).toBe('platform-core');
      expect(map.getElement('up')).toBe(true);
      expect(map.getElement('origin')).toBe(platform.getOriginId());
      expect(map.getElement('dependency[0].route')).toBe('demo.health');
      expect(map.getElement('dependency[0].service')).toBe('demo.service');
      expect(map.getElement('dependency[0].status_code')).toBe(200);
      expect(map.getElement('dependency[0].message')).toEqual({'status': 'demo.service is running fine'});
      expect(map.getElement('dependency[0].href')).toBe('http://127.0.0.1');
    });

    it('can get response from /livenessprobe endpoint', async () => {
      const po = new PostOffice();
      const req = new AsyncHttpRequest().setMethod('GET').setTargetHost(baseUrl).setUrl('/livenessprobe');
      const reqEvent = new EventEnvelope().setTo(ASYNC_HTTP_CLIENT).setBody(req.toMap());
      const result = await po.request(reqEvent);
      expect(result.getHeader('content-type')).toBe('text/plain');
      expect(typeof result.getBody()).toBe('string');
      expect(result.getBody()).toBe('OK');
    }); 

    it('can do HTTP-GET to /api/hello/world service', async () => {
      const po = new PostOffice();
      const req = new AsyncHttpRequest().setMethod('GET').setTargetHost(baseUrl).setUrl('/api/hello/world?a=b&c=d');
      req.setHeader('authorization', 'demo');
      const reqEvent = new EventEnvelope().setTo(ASYNC_HTTP_CLIENT).setBody(req.toMap());
      const result = await po.request(reqEvent);
      expect(result.getBody() instanceof Object).toBe(true);
      const map = new MultiLevelMap(result.getBody() as object);
      expect(map.getElement('url')).toBe('/api/hello/world');
      expect(map.getElement('ip')).toBe('127.0.0.1');
      expect(map.getElement('method')).toBe('GET');
      expect(map.getElement('headers.x-ttl')).toBe('10');
      expect(map.getElement('query')).toBe('a=b&c=d');
      expect(map.getElement('parameters.query.a')).toBe('b');
      expect(map.getElement('parameters.query.c')).toBe('d');
      expect(map.getElement('headers.x-flow-id')).toBe('hello-world');
    }); 

    it('can do HTTP-POST to /api/hello/world service', async () => {
      const text = 'hello world';
      const po = new PostOffice();
      const req = new AsyncHttpRequest().setMethod('POST').setTargetHost(baseUrl).setUrl('/api/hello/world?a=b&c=d');
      req.setHeader('authorization', 'demo');
      req.setBody(text).setHeader('Content-Type', 'text/plain');
      const reqEvent = new EventEnvelope().setTo(ASYNC_HTTP_CLIENT).setBody(req.toMap());
      const result = await po.request(reqEvent);
      expect(result.getBody() instanceof Object).toBe(true);
      const map = new MultiLevelMap(result.getBody() as object);
      expect(map.getElement('url')).toBe('/api/hello/world');
      expect(map.getElement('ip')).toBe('127.0.0.1');
      expect(map.getElement('method')).toBe('POST');
      expect(map.getElement('headers.x-ttl')).toBe('10');
      expect(map.getElement('query')).toBe('a=b&c=d');
      expect(map.getElement('parameters.query.a')).toBe('b');
      expect(map.getElement('parameters.query.c')).toBe('d');
      expect(map.getElement('headers.x-flow-id')).toBe('hello-world');
      expect(map.getElement('body')).toBe(text);
    });   
    
    it('can do HTTP-PUT to send text to /api/hello/world service', async () => {
      const text = 'hello world';
      const po = new PostOffice();
      const req = new AsyncHttpRequest().setMethod('PUT').setTargetHost(baseUrl).setUrl('/api/hello/world?a=b&c=d');
      req.setHeader('authorization', 'demo');
      req.setBody(text).setHeader('Content-Type', 'text/plain').setHeader('Accept', 'text/html');
      const reqEvent = new EventEnvelope().setTo(ASYNC_HTTP_CLIENT).setBody(req.toMap());
      const result = await po.request(reqEvent);
      expect(typeof result.getBody()).toBe('string');      
      const html = result.getBody() as string;
      expect(html.startsWith(HTML_PREFIX)).toBe(true);
      expect(html.endsWith(HTML_SUFFIX)).toBe(true);
      let jsonString = html.substring(HTML_PREFIX.length);
      jsonString = jsonString.substring(0, jsonString.length - HTML_SUFFIX.length);
      const json = JSON.parse(jsonString);
      const map = new MultiLevelMap(json);
      expect(map.getElement('url')).toBe('/api/hello/world');
      expect(map.getElement('ip')).toBe('127.0.0.1');
      expect(map.getElement('method')).toBe('PUT');
      expect(map.getElement('headers.x-ttl')).toBe('10');
      expect(map.getElement('query')).toBe('a=b&c=d');
      expect(map.getElement('parameters.query.a')).toBe('b');
      expect(map.getElement('parameters.query.c')).toBe('d');
      expect(map.getElement('headers.x-flow-id')).toBe('hello-world');
      expect(map.getElement('body')).toBe(text);
      expect(result.getHeader('content-type')).toBe('text/html');
      expect(result.getHeader('access-control-allow-origin')).toBe('*');
      expect(result.getHeader('access-control-allow-methods')).toBe('GET, DELETE, PUT, POST, PATCH, OPTIONS');
      expect(result.getHeader(HELLO_INSTANCE)).toBeDefined();
    }); 

    it('can do HTTP-PUT to send binary data to /api/hello/world service', async () => {
      const text = 'hello world';
      const po = new PostOffice();
      const req = new AsyncHttpRequest().setMethod('PUT').setTargetHost(baseUrl).setUrl('/api/hello/world?a=b&c=d');
      req.setHeader('authorization', 'demo');
      // input will be rendered as byte array
      req.setBody(text).setHeader('Content-Type', 'application/octet-stream').setHeader('Accept', 'application/json');
      const reqEvent = new EventEnvelope().setTo(ASYNC_HTTP_CLIENT).setBody(req.toMap());
      const result = await po.request(reqEvent);
      expect(typeof result.getBody()).toBe('object');      
      const map = new MultiLevelMap(result.getBody() as object);
      expect(map.getElement('url')).toBe('/api/hello/world');
      expect(map.getElement('ip')).toBe('127.0.0.1');
      expect(map.getElement('method')).toBe('PUT');
      expect(map.getElement('headers.x-ttl')).toBe('10');
      expect(map.getElement('query')).toBe('a=b&c=d');
      expect(map.getElement('parameters.query.a')).toBe('b');
      expect(map.getElement('parameters.query.c')).toBe('d');
      expect(map.getElement('headers.x-flow-id')).toBe('hello-world');
      // byte array will be converted to base64 by the "hello.world" service for easy comparison
      expect(map.getElement('body')).toBe(Buffer.from(text).toString('base64'));
      expect(result.getHeader('content-type')).toBe('application/json');
      expect(result.getHeader('access-control-allow-origin')).toBe('*');
      expect(result.getHeader('access-control-allow-methods')).toBe('GET, DELETE, PUT, POST, PATCH, OPTIONS');
      expect(result.getHeader(HELLO_INSTANCE)).toBeDefined();
    });  
    
    it('can do HTTP-PUT to send JSON object to /api/hello/world service', async () => {
      const json = {'hello': 'world'};
      const po = new PostOffice();
      const req = new AsyncHttpRequest().setMethod('PUT').setTargetHost(baseUrl).setUrl('/api/hello/world?a=b&c=d');
      req.setHeader('authorization', 'demo');
      req.setBody(json).setHeader('Content-Type', 'application/json').setHeader('Accept', 'application/json');
      const reqEvent = new EventEnvelope().setTo(ASYNC_HTTP_CLIENT).setBody(req.toMap());
      const result = await po.request(reqEvent);
      expect(typeof result.getBody()).toBe('object');      
      const map = new MultiLevelMap(result.getBody() as object);
      expect(map.getElement('url')).toBe('/api/hello/world');
      expect(map.getElement('ip')).toBe('127.0.0.1');
      expect(map.getElement('method')).toBe('PUT');
      expect(map.getElement('headers.x-ttl')).toBe('10');
      expect(map.getElement('query')).toBe('a=b&c=d');
      expect(map.getElement('parameters.query.a')).toBe('b');
      expect(map.getElement('parameters.query.c')).toBe('d');
      expect(map.getElement('headers.x-flow-id')).toBe('hello-world');
      expect(map.getElement('body')).toStrictEqual(json);
      expect(result.getHeader('content-type')).toBe('application/json');
      expect(result.getHeader('access-control-allow-origin')).toBe('*');
      expect(result.getHeader('access-control-allow-methods')).toBe('GET, DELETE, PUT, POST, PATCH, OPTIONS');
      expect(result.getHeader(HELLO_INSTANCE)).toBeDefined();
    });     

    it('can do HTTP-OPTIONS to /api/hello/world service', async () => {
      const po = new PostOffice();
      const req = new AsyncHttpRequest().setMethod('OPTIONS').setTargetHost(baseUrl).setUrl('/api/hello/world?a=b&c=d');
      req.setHeader('authorization', 'demo');
      const reqEvent = new EventEnvelope().setTo(ASYNC_HTTP_CLIENT).setBody(req.toMap());
      const result = await po.request(reqEvent);
      expect(result.getStatus()).toBe(204);
      expect(result.getBody()).toBe(null);
      expect(result.getHeader('access-control-allow-origin')).toBe('*');
      expect(result.getHeader('access-control-allow-methods')).toBe('GET, DELETE, PUT, POST, PATCH, OPTIONS');
    });

    it('can retrieve a function from the registry and use it', async () => {
      const exists = registry.exists(DEMO_LIBRARY_FUNCTION);
      expect(exists).toBe(true);
      const functionList = registry.getFunctionList();
      expect(functionList.includes(DEMO_LIBRARY_FUNCTION)).toBe(true);
      const demoClass = registry.getClass(DEMO_LIBRARY_FUNCTION);
      expect(demoClass).toBeInstanceOf(HelloWorld);
      const po = new PostOffice(new Sender('unit.test', '400', 'TEST /library/rpc'));
      const req = new EventEnvelope().setTo(DEMO_LIBRARY_FUNCTION).setBody(TEST_MESSAGE);
      const result = await po.request(req, 3000);
      expect(result.getBody()).toBe(TEST_MESSAGE);
    });  
    
    it('can re-register a service', async () => {
      const exists = registry.exists(DEMO_LIBRARY_FUNCTION);
      expect(exists).toBe(true);
      const helloWorld = registry.getClass(DEMO_LIBRARY_FUNCTION);
      const count1 = 10;
      const count2 = 5;
      const po = new PostOffice();
      const serviceName = 'my.new.service'; 
      const helloInstance = HELLO_INSTANCE;     
      platform.register(serviceName, helloWorld, count1);
      let result = await po.request(new EventEnvelope().setTo(serviceName).setBody(TEST_MESSAGE));        
      expect(result.getBody()).toBe(TEST_MESSAGE); 
      // register it again - the platform will reload service automatically
      platform.register(serviceName, helloWorld, count2);
      const map = new Map<string, boolean>();
      for (let i=0; i < 10; i++) {
          result = await po.request(new EventEnvelope().setTo(serviceName).setBody(TEST_MESSAGE+i));
          const headers = result.getHeaders();
          if (helloInstance in headers) {
            map.set(result.getHeader(helloInstance), true);
          }
          expect(result.getBody()).toBe(TEST_MESSAGE+i);
      }
      expect(map.size).toBe(count2);
    });  
    
    it('can handle HTTP-404', async () => {
      const po = new PostOffice();
      const req = new AsyncHttpRequest().setMethod('GET').setTargetHost(baseUrl).setUrl('/notfound');
      const reqEvent = new EventEnvelope().setTo(ASYNC_HTTP_CLIENT).setBody(req.toMap());
      const result = await po.request(reqEvent);
      expect(result).toBeTruthy();
      expect(result.getStatus()).toBe(404);
      expect(result.getBody()).toBeInstanceOf(Object);
      expect(Array.isArray(result.getBody())).toBe(false);
      expect(result.getBody()['type']).toBe('error');
      expect(result.getBody()['message']).toBe('Resource not found');
    }); 

    it('can load home page', async () => {
      const po = new PostOffice();
      const req = new AsyncHttpRequest().setMethod('GET').setTargetHost(baseUrl).setUrl('/');
      const reqEvent = new EventEnvelope().setTo(ASYNC_HTTP_CLIENT).setBody(req.toMap());
      const result = await po.request(reqEvent);
      expect(typeof result.getBody()).toBe('string');
      const filePath = resourcePath + "/public/index.html";
      const content = await fs.promises.readFile(filePath);
      expect(Buffer.from(result.getBody() as string)).toStrictEqual(content);
      expect(typeof result.getHeader('content-type')).toBe('string');
      const ct = String(result.getHeader('content-type'));
      expect(ct.startsWith('text/html')).toBe(true);
    }); 

    it('can load index.html', async () => {
      const po = new PostOffice();
      const req = new AsyncHttpRequest().setMethod('GET').setTargetHost(baseUrl).setUrl('/index.html');
      const reqEvent = new EventEnvelope().setTo(ASYNC_HTTP_CLIENT).setBody(req.toMap());
      const result = await po.request(reqEvent);
      expect(typeof result.getBody()).toBe('string');
      const filePath = resourcePath + "/public/index.html";
      const content = await fs.promises.readFile(filePath);
      expect(Buffer.from(result.getBody() as string)).toStrictEqual(content);
      expect(typeof result.getHeader('content-type')).toBe('string');
      const ct = String(result.getHeader('content-type'));
      expect(ct.startsWith('text/html')).toBe(true);
    }); 

    it('can load CSS page', async () => {
      const po = new PostOffice();
      const req = new AsyncHttpRequest().setMethod('GET').setTargetHost(baseUrl).setUrl('/css/sample.css');
      const reqEvent = new EventEnvelope().setTo(ASYNC_HTTP_CLIENT).setBody(req.toMap());
      const result = await po.request(reqEvent);
      expect(typeof result.getBody()).toBe('string');
      const filePath = resourcePath + "/public/css/sample.css";
      const content = await fs.promises.readFile(filePath);
      expect(Buffer.from(result.getBody() as string)).toStrictEqual(content);
      expect(typeof result.getHeader('content-type')).toBe('string');
      const ct = String(result.getHeader('content-type'));
      expect(ct.startsWith('text/css')).toBe(true);
    }); 

    it('can load JS page', async () => {
      const po = new PostOffice();
      const req = new AsyncHttpRequest().setMethod('GET').setTargetHost(baseUrl).setUrl('/js/sample.js');
      const reqEvent = new EventEnvelope().setTo(ASYNC_HTTP_CLIENT).setBody(req.toMap());
      const result = await po.request(reqEvent);
      expect(typeof result.getBody()).toBe('string');
      const filePath = resourcePath + "/public/js/sample.js";
      const content = await fs.promises.readFile(filePath);
      expect(Buffer.from(result.getBody() as string)).toStrictEqual(content);
      expect(typeof result.getHeader('content-type')).toBe('string');
      const ct = String(result.getHeader('content-type'));
      expect(ct.startsWith('application/javascript')).toBe(true);
    }); 

    it('can load text page', async () => {
      const po = new PostOffice();
      const req = new AsyncHttpRequest().setMethod('GET').setTargetHost(baseUrl).setUrl('/sample.txt');
      const reqEvent = new EventEnvelope().setTo(ASYNC_HTTP_CLIENT).setBody(req.toMap());
      const result = await po.request(reqEvent);
      expect(typeof result.getBody()).toBe('string');
      const filePath = resourcePath + "/public/sample.txt";
      const content = await fs.promises.readFile(filePath);
      expect(Buffer.from(result.getBody() as string)).toStrictEqual(content);
      expect(typeof result.getHeader('content-type')).toBe('string');
      const ct = String(result.getHeader('content-type'));
      expect(ct.startsWith('text/plain')).toBe(true);
    });   

    it('can load XML page', async () => {
      const po = new PostOffice();
      const req = new AsyncHttpRequest().setMethod('GET').setTargetHost(baseUrl).setUrl('/sample.xml');
      const reqEvent = new EventEnvelope().setTo(ASYNC_HTTP_CLIENT).setBody(req.toMap());
      const result = await po.request(reqEvent);
      expect(typeof result.getBody()).toBe('string');
      const filePath = resourcePath + "/public/sample.xml";
      const content = await fs.promises.readFile(filePath);
      expect(Buffer.from(result.getBody() as string)).toStrictEqual(content);
      expect(typeof result.getHeader('content-type')).toBe('string');
      const ct = String(result.getHeader('content-type'));
      expect(ct.startsWith('application/xml')).toBe(true);
    });  

    it('can download file with unknown mime type', async () => {
      const po = new PostOffice();
      const req = new AsyncHttpRequest().setMethod('GET').setTargetHost(baseUrl).setUrl('/sample.xdoc');
      const reqEvent = new EventEnvelope().setTo(ASYNC_HTTP_CLIENT).setBody(req.toMap());
      const result = await po.request(reqEvent);
      expect(result.getBody() instanceof Buffer).toBeTruthy();
      const filePath = resourcePath + "/public/sample.xdoc";
      const content = await fs.promises.readFile(filePath);
      expect(result.getBody()).toStrictEqual(content);
      // express return application/octet-stream for unknown mime type
      expect(result.getHeader('content-type')).toBe('application/octet-stream');
    });

    it('can do HTTP-GET with JSON to /api/hello/world service', async () => {
      const request = new AsyncHttpRequest().setMethod('GET')
                            .setTargetHost(baseUrl)
                            .setUrl('/api/hello/world?x=y')
                            .setHeader('accept', 'application/json')
                            .setHeader('authorization', 'demo')
                            .setQueryParameter('a', 'b')
                            .setQueryParameter('c', 'd');
      const reqEvent = new EventEnvelope().setTo(ASYNC_HTTP_CLIENT).setBody(request.toMap());
      const po = new PostOffice();
      const result = await po.request(reqEvent, 3000);
      expect(result.getBody()).toBeInstanceOf(Object);
      const map = new MultiLevelMap(result.getBody() as object);
      expect(map.getElement('url')).toBe('/api/hello/world');
      expect(map.getElement('ip')).toBe('127.0.0.1');
      expect(map.getElement('method')).toBe('GET');
      expect(map.getElement('headers.x-ttl')).toBe('10');
      expect(map.getElement('query')).toBe('x=y&a=b&c=d');
      expect(map.getElement('parameters.query.a')).toBe('b');
      expect(map.getElement('parameters.query.c')).toBe('d');
      expect(map.getElement('parameters.query.x')).toBe('y');
      expect(map.getElement('headers.x-flow-id')).toBe('hello-world');
      expect(map.getElement('body')).toBe(null);
      // check for CORS header insertion
      expect(result.getHeader('Access-Control-Allow-Origin')).toBe('*');
      // check for custom header insertion
      expect(result.getHeader('strict-transport-security')).toBe('max-age=31536000');
      expect(result.getHeader('expires')).toBe('Thu, 01 Jan 1970 00:00:00 GMT');
      // confirm that the system has inserted a Trace ID
      expect(result.getHeader('x-trace-id')).toBeTruthy();
    }); 
    
    it('can do HTTP-GET result with octet-stream to /api/hello/world service', async () => {
      const request = new AsyncHttpRequest().setMethod('GET')
                            .setTargetHost(baseUrl)
                            .setUrl('/api/hello/world')
                            .setHeader('accept', 'application/octet-stream')
                            .setHeader('authorization', 'demo')
                            .setQueryParameter('a', 'b')
                            .setQueryParameter('c', 'd');
      const reqEvent = new EventEnvelope().setTo(ASYNC_HTTP_CLIENT).setBody(request.toMap());
      const po = new PostOffice();
      const result = await po.request(reqEvent, 3000);
      expect(result.getBody()).toBeInstanceOf(Buffer);
      const json = JSON.parse(result.getBody().toString());
      const map = new MultiLevelMap(json);
      expect(map.getElement('url')).toBe('/api/hello/world');
      expect(map.getElement('ip')).toBe('127.0.0.1');
      expect(map.getElement('method')).toBe('GET');
      expect(map.getElement('headers.x-ttl')).toBe('10');
      expect(map.getElement('query')).toBe('a=b&c=d');
      expect(map.getElement('parameters.query.a')).toBe('b');
      expect(map.getElement('parameters.query.c')).toBe('d');
      expect(map.getElement('headers.x-flow-id')).toBe('hello-world');
      expect(map.getElement('body')).toBe(null);
      // check for CORS header insertion
      expect(result.getHeader('Access-Control-Allow-Origin')).toBe('*');
      // check for custom header insertion
      expect(result.getHeader('strict-transport-security')).toBe('max-age=31536000');
      expect(result.getHeader('expires')).toBe('Thu, 01 Jan 1970 00:00:00 GMT');
      // confirm that the system has inserted a Trace ID
      expect(result.getHeader('x-trace-id')).toBeTruthy();
    });     

    it('can do HTTP-POST to /api/hello/world service', async () => {
      const text = 'hello world';
      const request = new AsyncHttpRequest().setMethod('POST').setBody(text)
                            .setTargetHost(baseUrl)
                            .setUrl('/api/hello/world')
                            .setHeader('content-type', 'text/plain')
                            .setHeader('authorization', 'demo')
                            .setQueryParameter('a', 'b')
                            .setQueryParameter('c', 'd');
      const reqEvent = new EventEnvelope().setTo(ASYNC_HTTP_CLIENT).setBody(request.toMap());
      const po = new PostOffice();
      const result = await po.request(reqEvent, 3000);
      expect(result.getBody()).toBeInstanceOf(Object);
      const map = new MultiLevelMap(result.getBody() as object);
      expect(map.getElement('url')).toBe('/api/hello/world');
      expect(map.getElement('ip')).toBe('127.0.0.1');
      expect(map.getElement('method')).toBe('POST');
      expect(map.getElement('headers.x-ttl')).toBe('10');
      expect(map.getElement('query')).toBe('a=b&c=d');
      expect(map.getElement('parameters.query.a')).toBe('b');
      expect(map.getElement('parameters.query.c')).toBe('d');
      expect(map.getElement('headers.x-flow-id')).toBe('hello-world');
      expect(map.getElement('body')).toBe(text);
      // check for CORS header insertion
      expect(result.getHeader('Access-Control-Allow-Origin')).toBe('*');
      // check for custom header insertion
      expect(result.getHeader('strict-transport-security')).toBe('max-age=31536000');
      expect(result.getHeader('expires')).toBe('Thu, 01 Jan 1970 00:00:00 GMT');
      // confirm that the system has inserted a Trace ID
      expect(result.getHeader('x-trace-id')).toBeTruthy();
    }); 

    it('can do HTTP-POST multipart upload to /api/hello/upload service', async () => {
      const text = 'hello world #';
      const stream = new ObjectStreamIO(20);
      const outStream = new ObjectStreamWriter(stream.getOutputStreamId());
      for (let i=1; i <= 5; i++) {
        outStream.write(text+i+'\n');
      }
      outStream.write('end');
      await outStream.close();
      const request = new AsyncHttpRequest().setMethod('POST').setBody(text)
                            .setTargetHost(baseUrl)
                            .setUrl('/api/hello/upload')
                            .setHeader('content-type', 'multipart/form-data')
                            .setHeader('authorization', 'demo')                        
                            .setFileName('hello.txt')
                            .setTimeoutSeconds(5)
                            .setStreamRoute(stream.getInputStreamId());
      const reqEvent = new EventEnvelope().setTo(ASYNC_HTTP_CLIENT).setBody(request.toMap());
      const po = new PostOffice();
      const result = await po.request(reqEvent, 3000);
      expect(result.getBody()).toBeInstanceOf(Object);
      const map = new MultiLevelMap(result.getBody() as object);
      expect(map.getElement('url')).toBe('/api/hello/upload');
      expect(map.getElement('ip')).toBe('127.0.0.1');
      expect(map.getElement('method')).toBe('POST');
      expect(map.getElement('headers.content-type').startsWith('multipart/form-data; boundary=')).toBe(true);
      expect(map.getElement('filename')).toBe('hello.txt');
      expect(map.getElement('headers.'+STREAM_CONTENT).startsWith('stream.')).toBe(true);
      expect(map.getElement('upload')).toBe('file');
    }); 
    
    it('can detect HTTP connection exception from AsyncHttpClient', async () => {
      const request = new AsyncHttpRequest().setMethod('GET')
                          .setTargetHost(baseUrl)
                          .setUrl('/api/invalid/hello/world')
                          .setTimeoutSeconds(10);
      const reqEvent = new EventEnvelope().setTo(ASYNC_HTTP_CLIENT).setBody(request.toMap());
      const po = new PostOffice(new Sender('unit.test', '1200', 'TEST /not/reachable'));
      const result = await po.request(reqEvent, 3000);
      expect(result.getHeader('content-type')).toBe('application/json');
      expect(result.getStatus()).toBe(500);
      expect(result.getBody() instanceof Object).toBeTruthy();
      const map = new MultiLevelMap(result.getBody() as object);
      expect(map.getElement('type')).toBe('error');
      expect(map.getElement('status')).toBe(500);
      expect(map.getElement('message')).toBe('Connection refused - 127.0.0.1:60800');
    });  

    it('can download data from /api/hello/download', async () => {
      const request = new AsyncHttpRequest().setMethod('GET')
                          .setTargetHost(baseUrl)
                          .setUrl('/api/hello/download')
                          .setTimeoutSeconds(10);
      const reqEvent = new EventEnvelope().setTo(ASYNC_HTTP_CLIENT).setBody(request.toMap());
      const po = new PostOffice(new Sender('unit.test', '2500', 'TEST /download/stream'));
      const result = await po.request(reqEvent, 3000);
      expect(result.getStatus()).toBe(200);
      expect(result.getBody()).toBe(null);
      expect(result.getHeader(STREAM_CONTENT)).toBeTruthy();
      const streamId = result.getHeader(STREAM_CONTENT);
      const stream = new ObjectStreamReader(streamId, 5000);
      const blocks = new Array<string>();
      let len = 0;
      for (let i=0; i < 10; i++) {
        const b = await stream.read();
        if (b instanceof Buffer) {
          len += b.length;
          blocks.push(String(b));
        } else {
          break;
        }
      }
      expect(blocks.length).toBe(2);
      expect(blocks[0]).toBe('hello world\n');
      expect(blocks[1]).toBe('end');
      expect(result.getHeader('x-content-length')).toBe(String(len));
      expect(result.getHeader('content-length')).toBe(null);
      expect(result.getHeader('transfer-encoding')).toBe('chunked');
    }); 

    it('can do fork-n-join to /api/hello/world service', async () => {
      const request = new AsyncHttpRequest().setMethod('GET')
                            .setTargetHost(baseUrl)
                            .setUrl('/api/hello/world?x=y')
                            .setHeader('accept', 'application/json')
                            .setHeader('authorization', 'demo');
      const reqEvent = new EventEnvelope().setTo(ASYNC_HTTP_CLIENT).setBody(request.toMap());
      // create a list of 3 parallel events
      const requests = new Array<EventEnvelope>();
      requests.push(reqEvent);
      requests.push(reqEvent);
      requests.push(reqEvent);
      const po = new PostOffice();
      const result = await po.parallelRequest(requests, 3000);
      expect(result.length).toBe(3);
      for (const response of result) {
        expect(response.getBody()).toBeInstanceOf(Object);
        const map = new MultiLevelMap(response.getBody() as object);
        expect(map.getElement('url')).toBe('/api/hello/world');
        expect(map.getElement('ip')).toBe('127.0.0.1');
        expect(map.getElement('method')).toBe('GET');
        expect(map.getElement('headers.x-ttl')).toBe('10');
        expect(map.getElement('headers.x-flow-id')).toBe('hello-world');
        expect(map.getElement('body')).toBe(null);
        // check for CORS header insertion
        expect(response.getHeader('Access-Control-Allow-Origin')).toBe('*');
        // check for custom header insertion
        expect(response.getHeader('strict-transport-security')).toBe('max-age=31536000');
        expect(response.getHeader('expires')).toBe('Thu, 01 Jan 1970 00:00:00 GMT');
        // confirm that the system has inserted a Trace ID
        expect(response.getHeader('x-trace-id')).toBeTruthy();
      }
    });
    
    it('can do json and compact logging', async () => {
      const success1 = log.setLogFormat('json');
      expect(success1).toBe(true);
      log.setLevel('debug');
      log.info({'test1a': 'logging in JSON format'});
      log.info('test1b', new Error('Test printing stack trace'));
      log.debug('test1c', new Error('Test printing DEBUG log'));
      const success2 = log.setLogFormat('compact');
      expect(success2).toBe(true);
      log.info({'test2': 'logging in COMPACT format'});
      const success3 = log.setLogFormat('text');
      expect(success3).toBe(true);
      log.info({'test3': 'restore logging in TEXT format'});
      const success4 = log.setLogFormat('unknown');
      expect(success4).toBe(false);
      log.setLevel('info');      
    });

  });
