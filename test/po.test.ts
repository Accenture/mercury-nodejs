import { PO } from '../src/system/post-office';
import { EventEnvelope } from '../src/models/event-envelope';
import { Platform } from '../src/system/platform';
import { Utility } from '../src/util/utility';
import { forwarder } from '../src/util/forwarder.js';
import { AsyncHttpRequest } from '../src/models/async-http-request';
import { AppException } from '../src/models/app-exception';

const platform = new Platform().getInstance();
const po = new PO().getInstance();
const HELLO_WORLD_SERVICE = 'hello.world';
const MY_CALLBACK = 'my.callback.function';
const HELLO_BFF_SERVICE = 'hello.bff';
const DISTRIBUTED_TRACE_PROCESSOR = 'distributed.trace.processor';
const UNIT_TEST = 'unit.test';
const LIFE_CYCLE_DISPATCHER = 'life.cycle.dispatcher';
const MY_LISTENER = "my.listener";
const TEST_MESSAGE = 'test message';
const DEMO_EXCEPTION = 'demo exception';
const NOT_HTTP_REQUEST = 'input is not a http request';
const TYPE = 'type';
const POLL = 'poll';
const POP = 'pop';
const ERROR = 'error';

const util = new Utility().getInstance();

describe('post office use cases', () => {

  beforeAll(async () => {
    // register a hello.world function to echo the incoming payload
    platform.register(HELLO_WORLD_SERVICE, (evt: EventEnvelope) => {
      if (ERROR == evt.getHeader(TYPE)) {
        throw new AppException(400, DEMO_EXCEPTION);
      } else {
        return evt.getBody();
      }        
    });
    // you can create a service as a Promise too
    platform.register(HELLO_BFF_SERVICE, (evt: EventEnvelope) => {
      return new Promise((resolve, reject) => {
        const req = new AsyncHttpRequest(evt.getBody());
        if (req.getMethod()) {
          resolve(req.toMap());
        } else {
          reject(new Error(NOT_HTTP_REQUEST));
        }
      });      
    });
  });

  afterAll(async () => {
    // give console.log a moment to finish when tests are done
    await util.sleep(500);
  });

    it('should get the same payload for RPC call', async () => {
        const req = new EventEnvelope().setTo(HELLO_WORLD_SERVICE).setBody(TEST_MESSAGE);
        const result = await po.request(req, 3000);      
        expect(result.getBody()).toBe(TEST_MESSAGE);       
    });

    it('can catch exception from a service', async () => {
        const req = new EventEnvelope().setTo(HELLO_WORLD_SERVICE).setHeader(TYPE, ERROR);
        // Send a call to trigger an exception
        await expect(po.request(req, 3000)).rejects.toEqual(new Error(DEMO_EXCEPTION));
        // Check the exact exception status and message with the try-await-catch pattern
        let ex = null;
        try {
          await po.request(req, 3000);
        } catch(e) {
          ex = e;
        }
        expect(ex).toBeInstanceOf(AppException);
        expect(String(ex)).toBe('AppException: (400) demo exception');        
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
        const result = await po.request(req, 3000);  
        expect(result.getBody()).toBeInstanceOf(Object);
        const echo = new AsyncHttpRequest(result.getBody());
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
        await expect(po.request(req, 3000)).rejects.toEqual(new Error(NOT_HTTP_REQUEST));     
    });

    it('should receive the same payload from a callback', async () => {
      let callbackResult: string;
        platform.register(MY_CALLBACK, (evt: EventEnvelope) => {
          if (POLL == evt.getHeader(TYPE)) {
            return callbackResult;
          } else {
            callbackResult = String(evt.getBody());
            return null;
          }
        });
        // send a request to hello.world and set the replyTo address as my.callback
        const request = new EventEnvelope().setTo(HELLO_WORLD_SERVICE).setBody(TEST_MESSAGE).setReplyTo(MY_CALLBACK);
        po.send(request);
        // Ask the callback if it has received the test message.
        // Since this is a unit test, we use RPC to get the result.
        const result = await po.request(new EventEnvelope().setTo(MY_CALLBACK).setHeader(TYPE, POLL), 3000);
        expect(result.getBody()).toBe(TEST_MESSAGE);
        // the call back function is used once
        platform.release(MY_CALLBACK);     
    });
    
    it('can catch all traces with a distributed trace processor', async () => {
      let traceStack: Array<object> = [];
      platform.register(DISTRIBUTED_TRACE_PROCESSOR, (evt: EventEnvelope) => {
          if (POP == evt.getHeader(TYPE)) {
            const trace = traceStack.pop();
            return trace? trace : null;
          } else {
            traceStack.push(evt.getHeaders());
            return null;
          }
        });
        const traceId = '12345';
        const tracePath = 'PUT /api/demo/test';
        const request = new EventEnvelope().setTo(HELLO_WORLD_SERVICE).setBody(TEST_MESSAGE)
                                           .setFrom(UNIT_TEST).setTraceId(traceId).setTracePath(tracePath);
        const result = await po.request(request, 3000);      
        expect(result.getBody()).toBe(TEST_MESSAGE);  
        
        let metrics: object = {};
        for (let i=0; i < 2; i++) {
          const traceReq = new EventEnvelope().setTo(DISTRIBUTED_TRACE_PROCESSOR)
                                              .setHeader(TYPE, POP).setBody(i);
          const dataset = await po.request(traceReq, 2000);
          if (dataset.getBody()) {
            metrics = dataset.getBody() as object;
          }
        }
        expect(Object.keys(metrics).length).toBeGreaterThan(0);
        expect(metrics['id']).toBe(traceId);
        expect(metrics['path']).toBe(tracePath);
        expect(metrics['from']).toBe(UNIT_TEST);
        expect(metrics['service']).toBe(HELLO_WORLD_SERVICE);
        expect(metrics['success']).toBe('true');
        // unload the trace processor after test
        platform.release(DISTRIBUTED_TRACE_PROCESSOR);
    });

    it('can multicast events with a forwarder', async () => {
        po.subscribe(LIFE_CYCLE_DISPATCHER, forwarder);
        let message: string;
        let carbonCopy = false;
        platform.register(MY_LISTENER, (evt: EventEnvelope) => {
          if (POLL == evt.getHeader(TYPE)) {
            return message;
          } else {
            const headers = evt.getHeaders();
            if (Object.keys(headers).length > 0) {
              message = headers[TYPE];
            }
            return null;
          }
        });
        const secondListener = MY_LISTENER + 1;
        platform.register(secondListener, (evt: EventEnvelope) => {
          if (POLL == evt.getHeader(TYPE)) {
            return carbonCopy;
          } else {
            carbonCopy = true;
            return null;
          }
        });
        po.send(new EventEnvelope().setTo(LIFE_CYCLE_DISPATCHER).setHeader(TYPE, 'subscribe')
                                    .setHeader('route', MY_LISTENER));
        po.send(new EventEnvelope().setTo(LIFE_CYCLE_DISPATCHER).setHeader(TYPE, 'subscribe')
                                    .setHeader('route', secondListener));
        // send a test message to the forwarder which will in turns relay it to my.listener service
        po.send(new EventEnvelope().setTo(LIFE_CYCLE_DISPATCHER).setHeader(TYPE, TEST_MESSAGE));
        // ask the first listener for the message
        const result1 = await po.request(new EventEnvelope().setTo(MY_LISTENER).setHeader(TYPE, POLL), 3000);
        expect(result1.getBody()).toBe(TEST_MESSAGE);
        // ask the second listener that it has received a carbon copy
        const result2 = await po.request(new EventEnvelope().setTo(secondListener).setHeader(TYPE, POLL), 3000);
        expect(result2.getBody()).toBeTruthy();
        // clean up resources
        po.send(new EventEnvelope().setTo(LIFE_CYCLE_DISPATCHER).setHeader(TYPE, 'unsubscribe')
                                    .setHeader('route', MY_LISTENER));
        platform.release(MY_LISTENER);
        po.unsubscribe(LIFE_CYCLE_DISPATCHER);
    });

  });