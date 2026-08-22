/** AppConfig tests: resources/ convention, -D overrides, ${ENV:default} substitution. */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { AppConfig, parseDArgs } from '../src/config.js';

function tempFile(name: string, text: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mercury-config-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, text);
  return file;
}

test('yaml file with dotted access', () => {
  const file = tempFile('application.yml',
    "application:\n  name: 'demo-app'\nrest:\n  server:\n    port: 8086\n");
  const config = new AppConfig(file, []);
  assert.equal(config.get('application.name'), 'demo-app');
  assert.equal(config.get('rest.server.port'), 8086);
});

test('properties format', () => {
  const file = tempFile('application.properties',
    '# comment\nrest.server.port=8087\napplication.name=props-app\n');
  const config = new AppConfig(file, []);
  assert.equal(config.get('rest.server.port'), '8087');
  assert.equal(config.get('application.name'), 'props-app');
});

test('-D argument overrides win (Java/Rust engine syntax)', () => {
  const file = tempFile('application.yml', 'rest:\n  server:\n    port: 8086\n');
  const config = new AppConfig(file, ['-Drest.server.port=9999', '-Dnew.key=live']);
  assert.equal(config.get('rest.server.port'), '9999');
  assert.equal(config.get('new.key'), 'live');
  assert.equal(parseDArgs(['--port', '8080']).size, 0);
});

test('set() is a runtime override (f:setConfig analog)', () => {
  const file = tempFile('application.yml', "some:\n  key: 'original'\n");
  const config = new AppConfig(file, []);
  assert.equal(config.get('some.key'), 'original');
  config.set('some.key', 'changed');
  assert.equal(config.get('some.key'), 'changed');
});

test('${ENV:default} substitution', () => {
  const file = tempFile('application.yml',
    "peer:\n  url: 'http://127.0.0.1:${MERCURY_TEST_PEER_PORT:8085}/api/event'\n" +
    "missing: '${NOT_SET_ANYWHERE}'\n");
  const config = new AppConfig(file, []);
  assert.equal(config.get('peer.url'), 'http://127.0.0.1:8085/api/event');
  process.env.MERCURY_TEST_PEER_PORT = '9090';
  try {
    assert.equal(config.get('peer.url'), 'http://127.0.0.1:9090/api/event');
  } finally {
    delete process.env.MERCURY_TEST_PEER_PORT;
  }
  assert.equal(config.get('missing'), undefined); // unresolved whole-value ref
});

test('resources location convention', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mercury-resources-'));
  fs.mkdirSync(path.join(dir, 'resources'));
  fs.writeFileSync(path.join(dir, 'resources', 'application.yml'),
    "application:\n  name: 'from-resources'\n");
  const previous = process.cwd();
  process.chdir(dir);
  try {
    const config = new AppConfig(undefined, []);
    assert.equal(config.source, 'resources/application.yml');
    assert.equal(config.get('application.name'), 'from-resources');
  } finally {
    process.chdir(previous);
  }
});
