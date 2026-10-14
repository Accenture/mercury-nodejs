/** AppConfig tests: resources/ convention, -D overrides, ${ENV:default} substitution. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { AppConfig, mainScriptDir, parseDArgs } from '../src/config.js';

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

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mercury-resources-'));
}

function withResources(dir: string, yaml: string): string {
  fs.mkdirSync(path.join(dir, 'resources'), { recursive: true });
  const file = path.join(dir, 'resources', 'application.yml');
  fs.writeFileSync(file, yaml);
  return file;
}

test('resources next to the application file', () => {
  const appDir = tempDir();
  const file = withResources(appDir, "application:\n  name: 'demo-app'\nrest:\n  server:\n    port: 8086\n");
  const config = new AppConfig(undefined, [], appDir);
  assert.equal(config.source, file);
  assert.equal(config.resourcesDir, path.join(appDir, 'resources'));
  assert.equal(config.get('application.name'), 'demo-app');
  assert.equal(config.get('rest.server.port'), 8086);
});

test('the working directory is never searched', () => {
  // a decoy in the working directory, nothing next to the application file
  const cwd = tempDir();
  withResources(cwd, "application:\n  name: 'decoy'\n");
  const appDir = tempDir();
  const previous = process.cwd();
  process.chdir(cwd);
  try {
    const config = new AppConfig(undefined, [], appDir);
    assert.equal(config.source, 'none');
    assert.equal(config.get('application.name'), undefined);
    assert.equal(config.resourcesDir, path.join(appDir, 'resources')); // where a companion file would sit
  } finally {
    process.chdir(previous);
  }
});

test('a direct run anchors on the script node ran', () => {
  // the lazy default resolves next to process.argv[1]
  const appDir = tempDir();
  const file = withResources(appDir, "application:\n  name: 'from-script'\n");
  const argv1 = process.argv[1];
  process.argv[1] = path.join(appDir, 'app.mjs');
  try {
    assert.equal(mainScriptDir(), appDir);
    const config = new AppConfig(undefined, []);
    assert.equal(config.source, file);
    assert.equal(config.get('application.name'), 'from-script');
  } finally {
    process.argv[1] = argv1;
  }
});

test('an explicit file keeps its companions beside it', () => {
  const file = tempFile('application.yml', "application:\n  name: 'explicit'\n");
  const config = new AppConfig(file, []);
  assert.equal(config.source, file);
  assert.equal(config.resourcesDir, path.dirname(file));
});

/** An application file that reports its configuration and stops before any function registers. */
function appInADecoyCwd(): { app: string; cwd: string; out: string; expected: string; root: string } {
  const root = tempDir();
  const appDir = path.join(root, 'app');
  const expected = withResources(appDir, "application:\n  name: 'from-app'\n");
  const configModule = new URL('../src/config.js', import.meta.url).href;
  const app = path.join(appDir, 'app.mjs');
  fs.writeFileSync(app, [
    "import { writeFileSync } from 'node:fs';",
    `import { appConfig } from ${JSON.stringify(configModule)};`,
    "writeFileSync(process.env.MERCURY_TEST_OUT, appConfig().get('application.name') + ' ' + appConfig().source);",
    'process.exit(0); // before any function registers - the configuration is the point',
    ''
  ].join('\n'));
  const cwd = path.join(root, 'cwd');
  withResources(cwd, "application:\n  name: 'decoy'\n");
  return { app, cwd, out: path.join(root, 'out.txt'), expected, root };
}

function runFrom(cwd: string, out: string, args: string[]): string {
  const result = spawnSync(process.execPath, args,
    { cwd, env: { ...process.env, MERCURY_TEST_OUT: out }, encoding: 'utf-8', timeout: 120000 });
  assert.equal(result.status, 0, result.stderr);
  return fs.readFileSync(out, 'utf-8');
}

test('node app.mjs resolves next to the script', () => {
  // `node app.mjs` from a decoy working directory finds the resources folder next to app.mjs
  const { app, cwd, out, expected } = appInADecoyCwd();
  assert.equal(runFrom(cwd, out, [app]), `from-app ${expected}`);
});

test('mercury-serve resolves next to the application file', () => {
  // the CLI, run from a decoy working directory, loads the resources folder next to the app
  const { app, cwd, out, expected, root } = appInADecoyCwd();
  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  assert.equal(runFrom(cwd, out, [cli, app]), `from-app ${expected}`);
  // --config names another file
  const other = path.join(root, 'other.yml');
  fs.writeFileSync(other, "application:\n  name: 'other'\n");
  assert.equal(runFrom(cwd, out, [cli, app, '--config', other]), `other ${other}`);
});
