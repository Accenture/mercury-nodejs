/**
 * Application log context tests - the engines' app-log-context twin: default
 * template rendering, the updateContext developer API and feature gating.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appConfig } from '../src/config.js';
import {
  LogContextConfig,
  logContextConfig,
  resetLogContextForTest
} from '../src/log-context.js';
import { runWithTrace, TraceInfo, updateContext } from '../src/trace.js';

// mirror of the engines' built-in default-log-context.yaml
const DEFAULT_TEMPLATE: Record<string, string> = {
  cid: '$cid', traceId: '$traceId', tracePath: '$tracePath', spanId: '$spanId',
  parentSpanId: '$parentSpanId', service: '$service', timestamp: '$utc'
};

function infoUnderTest(): TraceInfo {
  return {
    route: 'llm.chat',
    traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
    tracePath: 'POST /api/agent/run',
    myCorrelationId: 'biz-7788',
    spanId: '82d8a6ccd03638fe',
    parentSpanId: '00f067aa0ba902b7',
    annotations: {}
  };
}

test('the default template renders the standard trace context', () => {
  const context = new LogContextConfig(DEFAULT_TEMPLATE).render(infoUnderTest());
  assert.equal(context.cid, 'biz-7788');
  assert.equal(context.traceId, '4bf92f3577b34da6a3ce929d0e0e4736');
  assert.equal(context.tracePath, 'POST /api/agent/run');
  assert.equal(context.spanId, '82d8a6ccd03638fe');
  assert.equal(context.parentSpanId, '00f067aa0ba902b7');
  assert.equal(context.service, 'llm.chat');
  assert.ok(typeof context.timestamp === 'string');
  // absent values are omitted, never rendered as "null" - and cid is the
  // BUSINESS correlation-id only
  const bare = new LogContextConfig(DEFAULT_TEMPLATE).render(
    { route: 'llm.chat', traceId: 't-1', cid: 'internal-routing-id', annotations: {} });
  assert.ok(!('cid' in bare));
  assert.ok(!('spanId' in bare));
});

test('custom templates carry tokens and constants, and validate tokens', () => {
  const config = new LogContextConfig({ trace: '$traceId', deployment: 'blue' });
  const context = config.render(infoUnderTest());
  assert.deepEqual(context, {
    trace: '4bf92f3577b34da6a3ce929d0e0e4736', deployment: 'blue'
  });
  assert.throws(() => new LogContextConfig({ x: '$bogus' }),
    /Invalid log context token/);
});

test('updateContext merges custom keys and guards reserved keys', () => {
  const config = new LogContextConfig(DEFAULT_TEMPLATE);
  const info: TraceInfo = { ...infoUnderTest() };
  runWithTrace(info, () => {
    updateContext('tenant', 'acme');
    assert.equal(config.render(info).tenant, 'acme');
    updateContext('tenant', null);
    assert.ok(!('tenant' in config.render(info)));
    assert.throws(() => updateContext('cid', 'nope'), /reserved/);
  });
  // outside a hosted request: a silent no-op, the engines' semantics
  updateContext('tenant', 'ignored');
});

test('the app.log.context flag disables the feature', () => {
  try {
    appConfig().set('app.log.context', 'false');
    resetLogContextForTest();
    assert.equal(logContextConfig().enabled, false);
  } finally {
    appConfig().set('app.log.context', 'true');
    resetLogContextForTest();
  }
  assert.equal(logContextConfig().enabled, true);
  // and the packaged default-log-context.yaml is what loaded - the engines'
  // resource-file twin, not a code constant
  const rendered = logContextConfig().render(infoUnderTest());
  assert.equal(rendered.service, 'llm.chat');
  assert.equal(rendered.cid, 'biz-7788');
});
