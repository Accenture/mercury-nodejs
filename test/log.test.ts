/** Log presentation pins: the JSON line's fields, labelled as the Java engine labels them. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appConfig } from '../src/config.js';
import { getLogger, resetLogForTest } from '../src/log.js';

/** One line written with the given log.format, captured from stdout. */
function captured(format: string, emit: () => void): string {
  appConfig().set('log.format', format);
  resetLogForTest();
  const chunks: string[] = [];
  const original = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    emit();
  } finally {
    process.stdout.write = original;
  }
  return chunks.join('');
}

test('the JSON presentations label the emitting logger "source", as the Java engine does', () => {
  const record = { trace: { path: 'POST /api/event', service: 'http.request', status: 200 } };
  const pretty = captured('json', () => getLogger('distributed.tracing').info(record));
  const compact = captured('compact', () => getLogger('distributed.tracing').info(record));
  assert.ok(pretty.trim().includes('\n'));     // json: pretty-printed
  assert.ok(!compact.trim().includes('\n'));   // compact: one line (JSONL)
  for (const line of [pretty, compact]) {
    const entry = JSON.parse(line) as Record<string, unknown>;
    assert.equal(entry.level, 'INFO');
    assert.equal(entry.source, 'distributed.tracing');
    assert.ok(!('logger' in entry));
    assert.deepEqual(entry.message, record);
    assert.match(String(entry.time), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/);
  }
});

test('an unnamed logger reports its call site as source (name:line)', () => {
  const line = captured('compact', () => getLogger().info('hello'));
  const entry = JSON.parse(line) as Record<string, unknown>;
  assert.match(String(entry.source), /^[\w.-]+:\d+$/);
  assert.notEqual(entry.source, 'unknown:0');
});

test('the text presentation is untouched', () => {
  const line = captured('text', () => getLogger('unit.test').info('hello', 'world'));
  assert.match(line, / INFO  unit\.test - hello world\n$/);
});
