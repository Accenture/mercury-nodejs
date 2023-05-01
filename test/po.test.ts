import { PO } from '../src/system/post-office';
import { EventEnvelope } from '../src/models/event-envelope';
import { Platform } from '../src/system/platform';
import { Utility } from '../src/util/utility';
import { AsyncHttpRequest } from '../src/models/async-http-request';
import { AppException } from '../src/models/app-exception';

const platform = new Platform().getInstance();
const HELLO_WORLD_SERVICE = 'hello.world';
const HELLO_BFF_SERVICE = 'hello.bff';
const DISTRIBUTED_TRACE_FORWARDER = 'distributed.trace.forwarder';
const UNIT_TEST = 'unit.test';
const TEST_MESSAGE = 'test message';
const DEMO_EXCEPTION = 'demo exception';
const NOT_HTTP_REQUEST = 'input is not a http request';
const TYPE = 'type';
const ERROR = 'error';
const TIMEOUT = 'timeout';
// TEST_CYCLES must be larger than HELLO_WORLD_INSTANCES to demonstrate non-blocking event delivery
const HELLO_WORLD_INSTANCES = 5;
const TEST_CYCLES = 8;

const util = new Utility().getInstance();

async function helloWorld(evt: EventEnvelope) {
  if (TIMEOUT == evt.getHeader(TYPE)) {
    // simulate artificial delay to keep the worker instance busy,
    // thus leaving remaining workers to serve additional requests.
    await util.sleep(500);
    return TIMEOUT;
  } else if (ERROR == evt.getHeader(TYPE)) {
    throw new AppException(400, DEMO_EXCEPTION);
  } else {
    if ('my_instance' in evt.getHeaders()) {
      evt.setHeader('hello_instance', evt.getHeader('my_instance'));
    }
    return new EventEnvelope().setBody(evt.getBody()).setHeaders(evt.getHeaders());
  }  
}

describe('post office use cases', () => {

  beforeAll(async () => {
    // register a hello.world function to echo the incoming payload
    platform.register(HELLO_WORLD_SERVICE, helloWorld, true, HELLO_WORLD_INSTANCES);
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
    await util.sleep(1500);
  });

    it('should get response from RPC', async () => {
        const po = new PO().getInstance({'my_route': 'unit.test', 'my_trace_id': '100', 'my_trace_path': 'TEST /demo/exception'});
        const req = new EventEnvelope().setTo(HELLO_WORLD_SERVICE).setBody(TEST_MESSAGE);
        const result = await po.request(req, 3000);
        expect(result.getBody()).toBe(TEST_MESSAGE);       
    });

    it('can catch exception from RPC', async () => {
        const req = new EventEnvelope().setTo(HELLO_WORLD_SERVICE).setHeader(TYPE, ERROR);
        // Send a call to trigger an exception
        const po = new PO().getInstance({'my_route': 'unit.test', 'my_trace_id': '200', 'my_trace_path': 'TEST /demo/exception'});
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

    it('can catch timeout from RPC', async () => {
        const req = new EventEnvelope().setTo(HELLO_WORLD_SERVICE).setHeader(TYPE, TIMEOUT);
        // Send a call to trigger an exception
        const po = new PO().getInstance({'my_route': 'unit.test', 'my_trace_id': '300', 'my_trace_path': 'TEST /demo/timeout'});
        await expect(po.request(req, 100)).rejects.toEqual(new Error("Route hello.world timeout for 100 ms"));
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
        const po = new PO().getInstance({});
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
        const po = new PO().getInstance({});
        await expect(po.request(req, 3000)).rejects.toEqual(new Error(NOT_HTTP_REQUEST));     
    });

    it('can reply to a callback', async () => {
      const MY_CALLBACK = "my.callback.1";
      let callbackResult: string = '';
        platform.register(MY_CALLBACK, (evt: EventEnvelope) => {
          callbackResult = String(evt.getBody());
          return null;
        });
        // send a request to hello.world and set the replyTo address as my.callback
        const request = new EventEnvelope().setTo(HELLO_WORLD_SERVICE).setBody(TEST_MESSAGE).setReplyTo(MY_CALLBACK);
        const po = new PO().getInstance({});
        po.send(request);
        // since it is asynchronous, we will wait up to 5 seconds for the callback result
        for (let i=0; i < 100; i++) {
          await util.sleep(50);
          if (callbackResult.length > 0) {
            break;
          }
        }
        expect(callbackResult).toBe(TEST_MESSAGE);
        // the call back function is used once
        platform.release(MY_CALLBACK);     
    });
    
    it('can catch all traces with a distributed trace forwarder', async () => {
      const traceId = util.getUuid();
      const tracePath = 'PUT /api/demo/test';
      let traceStack: Array<object> = [];
      platform.register(DISTRIBUTED_TRACE_FORWARDER, (evt: EventEnvelope) => {
          const payload = evt.getBody() as object;
          if ('trace' in payload) {
            const metrics = payload['trace'] as object;
            // ignore trace metrics from other unit tests
            if (traceId == metrics['id']) {
              traceStack.push(metrics);
            }
          }
          return null;
        });
        const po = new PO().getInstance({'my_route': 'unit.test', 'my_trace_id': traceId, 'my_trace_path': tracePath});
        const request = new EventEnvelope().setTo(HELLO_WORLD_SERVICE).setBody(TEST_MESSAGE);
        const result = await po.request(request, 3000);      
        expect(result.getBody()).toBe(TEST_MESSAGE);
        // since it is asynchronous, we will wait up to 5 seconds for the callback result
        for (let i=0; i < 100; i++) {
          await util.sleep(50);
          if (traceStack.length > 0) {
            break;
          }
        }        
        expect(traceStack.length).toBe(1);
        const metrics: object = traceStack[0];
        expect(metrics['id']).toBe(traceId);
        expect(metrics['path']).toBe(tracePath);
        expect(metrics['from']).toBe(UNIT_TEST);
        expect(metrics['service']).toBe(HELLO_WORLD_SERVICE);
        expect(metrics['success']).toBe(true);
        // unload the trace processor after test
        platform.release(DISTRIBUTED_TRACE_FORWARDER);
    });

    it('can deliver events orderly', async () => {
      const MY_CALLBACK = "my.callback.2";
      let count = 0;
      let callbackResult = new Map<number, EventEnvelope>();
      platform.register(MY_CALLBACK, (evt: EventEnvelope) => {
        expect(evt.getTo()).toBe(MY_CALLBACK);
        // system provided metadata. "my_instance" must be "1" with default parameter (instances=1)
        expect(evt.getHeader('my_route')).toBe(MY_CALLBACK);
        expect(evt.getHeader('my_instance')).toBe('1');
        callbackResult.set(++count, evt);
        return null;
      });
      const po = new PO().getInstance({'my_route': 'unit.test', 'my_trace_id': 123, 'my_trace_path': '/test/queuing'});
      // send a request to hello.world and set the replyTo address as my.callback
      
      for (let i=1; i <= TEST_CYCLES; i++) {
        const request = new EventEnvelope().setTo(HELLO_WORLD_SERVICE).setBody(TEST_MESSAGE+' '+i).setReplyTo(MY_CALLBACK);
        po.send(request);
      }
      // since it is asynchronous, we will wait up to 5 seconds for all callback results
      for (let i=0; i < 100; i++) {
        await util.sleep(50);
        if (count == TEST_CYCLES) {
          break;
        }
      }
      expect(count).toBe(TEST_CYCLES);
      // verify that the events are delivered orderly
      for (let i=1; i <= count; i++) {
        const event = callbackResult.get(i);
        // There are a total of 5 workers of "hello.world".
        // Two workers are engaged for the "timeout" unit test earlier.
        // Therefore, the events will be distributed among the remaining 3 workers.
        // This demonstrates that the workers are working in a non-blocking fashion.
        console.log("Received "+JSON.stringify(event?.getHeaders())+", body="+event?.getBody());
        expect(event?.getBody()).toBe(TEST_MESSAGE+' '+i);
      }
      // the call back function is used once
      platform.release(MY_CALLBACK);     
    });

  });