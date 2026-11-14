/**
 * The MCP binding - a polyglot function host that serves the tools of MCP servers as composable
 * routes, one route per allowlisted remote tool (RFC-0011 / ADR-0033, section 9 of the agent
 * loop's design spec). The engines stay MCP-free: a graph's agent loop (`llm.run`) names a route in
 * its tool catalog, the engine reaches it through declarative Event-over-HTTP like any other
 * function, and this app issues `tools/call` to the server behind it. A stdio server runs as a
 * subprocess of this process, never of an engine, and its credentials stay in this process's
 * environment.
 *
 * Run:  npm install --save-dev @modelcontextprotocol/sdk     (or: npm install @modelcontextprotocol/sdk)
 *       node dist/src/cli.js extensions/mcp-binding/mcp-binding.mjs
 *
 * Servers are named in resources/mcp-servers.yml (the mcp.servers key of application.yml names
 * the file): each has its transport (stdio with a command, or http with a URL), its credential
 * references (${ENV_VAR} placeholders, resolved from this process's environment at boot and never
 * logged), and its allowlist mapping each remote tool to a route with the SHA-256 digest of the
 * tool's input schema. Boot fails fast when an allowlisted tool is missing from tools/list or its
 * schema no longer matches the digest, so a server-side change stops a deploy instead of becoming
 * run-time errors a model improvises around.
 *
 *       node extensions/mcp-binding/mcp-binding.mjs describe [server ...]
 *
 * prints each server's tools with their digests and a catalog row to paste onto the graph, for the
 * developer to review: the model sees the graph's descriptions, never the server's.
 *
 * The Python twin (mercury-python extensions/mcp-binding) speaks the same contract, and both are
 * pinned by the shared vector file test/vectors/mcp-binding-vectors.json.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import YAML from 'yaml';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  AppException, appConfig, defaultRegistry, getLogger, loadConfig, platform, preload, validateRoute, VERSION
} from 'mercury-composable';

const defaultLog = getLogger('mcp-binding');

// --- the contract's defaults and limits ----------------------------------------------

export const DEFAULT_SERVERS_FILE = 'mcp-servers.yml';
export const DEFAULT_CALL_TIMEOUT_MS = 30000;
export const DEFAULT_INSTANCES = 10;
export const MIN_CALL_TIMEOUT_MS = 1000;
export const TRANSPORT_STDIO = 'stdio';
export const TRANSPORT_HTTP = 'http';
export const TRANSPORTS = [TRANSPORT_STDIO, TRANSPORT_HTTP];
export const SERVER_KEYS = ['transport', 'command', 'args', 'env', 'cwd', 'url', 'headers', 'timeout_ms',
  'instances', 'tools'];
export const TOOL_KEYS = ['route', 'schema_sha256'];
// the MCP specification's recommendation for a tool name
const TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/;
const DIGEST = /^[0-9a-f]{64}$/;
// the API-safe name a graph's catalog row may use for a route, derived for the describe output
const API_SAFE = /[^a-zA-Z0-9_-]/g;
// the SDK's request timeout error code
const REQUEST_TIMEOUT = -32001;

/** A configuration or boot failure: the application must not start. */
export class BindingError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BindingError';
  }
}

// --- the pure half: digests, verification and the result mapping (shared vectors) -----------

function isMap(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Canonical JSON: keys sorted, no spaces, Unicode kept, an integral number written without a
 * fraction - the same bytes the Python twin hashes (its json module sorts keys the same way and
 * its floats that are whole are written as whole numbers).
 */
export function canonical(value) {
  if (Array.isArray(value)) {
    return '[' + value.map(canonical).join(',') + ']';
  }
  if (isMap(value)) {
    return '{' + Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  }
  return JSON.stringify(value === undefined ? null : value);
}

/** The SHA-256 of a tool's input schema in canonical JSON, as 64 hex characters. */
export function schemaDigest(schema) {
  return createHash('sha256').update(canonical(schema ?? null), 'utf8').digest('hex');
}

/**
 * Match the allowlist against the tools a server offers (tools/list as plain maps with name,
 * description and input_schema). Every allowlisted tool must be offered and its input schema must
 * hash to the pinned digest; the first failure names the tool.
 */
export function verify(spec, offered) {
  const byName = new Map(offered.map((tool) => [String(tool.name), tool]));
  const bound = [];
  for (const binding of spec.tools) {
    const tool = byName.get(binding.name);
    if (!tool) {
      const names = [...byName.keys()].sort();
      throw new BindingError(`MCP server ${spec.name} does not offer the tool ${binding.name} - `
        + `it offers ${names.length ? names.join(', ') : 'no tools'}`);
    }
    const digest = schemaDigest(tool.input_schema);
    if (digest !== binding.schema_sha256) {
      throw new BindingError(`MCP server ${spec.name} changed the input schema of ${binding.name} - `
        + `its digest is now ${digest}, the configuration pins ${binding.schema_sha256}`);
    }
    bound.push({ binding, tool });
  }
  return bound;
}

/**
 * The reply of a route from a CallToolResult as a plain map (content, structured_content,
 * is_error): the structured content when the server gives it, else the text of the content blocks
 * joined by newlines; a result marked is_error is a 400 carrying the server's text, which the agent
 * loop returns to the model as that call's error.
 */
export function toolResult(result) {
  const texts = [];
  for (const block of result.content ?? []) {
    const type = block.type;
    if (type === 'text') {
      texts.push(String(block.text ?? ''));
    } else if (type === 'resource_link' || type === 'resource') {
      const resource = block.resource ?? block;
      texts.push(`[${type}] ${resource.uri ?? ''}`.trimEnd());
    } else {
      texts.push(`[${type}]`);
    }
  }
  const text = texts.join('\n');
  if (result.is_error) {
    throw new AppException(400, text || 'The tool reported an error without a message');
  }
  if (result.structured_content !== undefined && result.structured_content !== null) {
    return result.structured_content;
  }
  return text;
}

/** The SDK's result as the plain map the shared contract speaks. */
export function asPlain(result) {
  return {
    content: result.content ?? [],
    structured_content: result.structuredContent ?? null,
    is_error: Boolean(result.isError)
  };
}

/** The SDK's tool as the plain map the shared contract speaks. */
export function toolAsPlain(tool) {
  return { name: tool.name, description: tool.description ?? '', input_schema: tool.inputSchema };
}

// --- configuration ----------------------------------------------------------------------

function resolveValue(value) {
  return typeof value === 'string' ? appConfig().resolveText(value) : value;
}

function stringMap(server, key, value) {
  if (value === undefined || value === null) return {};
  if (!isMap(value)) {
    throw new BindingError(`MCP server ${server}: ${key} must be a map of names to values`);
  }
  const resolved = {};
  for (const [name, item] of Object.entries(value)) {
    const text = resolveValue(item);
    if (text === undefined || text === null || text === '') {
      throw new BindingError(`MCP server ${server}: ${key}.${name} resolves to nothing - set the variable it names`);
    }
    resolved[name] = String(text);
  }
  return resolved;
}

function toolsOf(server, value) {
  if (!isMap(value) || Object.keys(value).length === 0) {
    throw new BindingError(`MCP server ${server}: tools must map at least one remote tool name to its route and digest`);
  }
  const bindings = [];
  const routes = new Set();
  for (const [name, item] of Object.entries(value)) {
    if (!TOOL_NAME.test(name)) {
      throw new BindingError(`MCP server ${server}: '${name}' is not a tool name (letters, digits, '_', '.' and '-', up to 128)`);
    }
    if (!isMap(item)) {
      throw new BindingError(`MCP server ${server}: tool ${name} must be a map with route and schema_sha256`);
    }
    const unknown = Object.keys(item).filter((k) => !TOOL_KEYS.includes(k)).sort();
    if (unknown.length) {
      throw new BindingError(`MCP server ${server}: tool ${name} has unknown keys ${unknown.join(', ')} - the keys are route and schema_sha256`);
    }
    let route;
    try {
      route = validateRoute(String(item.route ?? ''));
    } catch (e) {
      throw new BindingError(`MCP server ${server}: tool ${name}: ${e.message}`);
    }
    if (routes.has(route)) {
      throw new BindingError(`MCP server ${server}: the route ${route} is bound twice`);
    }
    routes.add(route);
    const digest = String(item.schema_sha256 ?? '').toLowerCase();
    if (!DIGEST.test(digest)) {
      throw new BindingError(`MCP server ${server}: tool ${name} needs schema_sha256, the 64-hex digest of its input schema `
        + `- run 'node mcp-binding.mjs describe ${server}' to print it`);
    }
    bindings.push({ name, route, schema_sha256: digest });
  }
  return bindings;
}

function serverOf(name, value, defaultTimeoutMs) {
  if (!isMap(value)) {
    throw new BindingError(`MCP server ${name} must be a map`);
  }
  const unknown = Object.keys(value).filter((k) => !SERVER_KEYS.includes(k)).sort();
  if (unknown.length) {
    throw new BindingError(`MCP server ${name} has unknown keys ${unknown.join(', ')} - the keys are ${SERVER_KEYS.join(', ')}`);
  }
  const transport = String(value.transport ?? '');
  if (!TRANSPORTS.includes(transport)) {
    throw new BindingError(`MCP server ${name}: transport must be stdio or http`);
  }
  const timeoutMs = Number(value.timeout_ms ?? defaultTimeoutMs);
  if (!Number.isFinite(timeoutMs) || timeoutMs < MIN_CALL_TIMEOUT_MS) {
    throw new BindingError(`MCP server ${name}: timeout_ms must be at least ${MIN_CALL_TIMEOUT_MS}`);
  }
  const instances = Number(value.instances ?? DEFAULT_INSTANCES);
  const tools = toolsOf(name, value.tools);
  if (transport === TRANSPORT_STDIO) {
    const command = resolveValue(value.command);
    if (!command) {
      throw new BindingError(`MCP server ${name}: a stdio server needs a command`);
    }
    const rawArgs = value.args ?? [];
    if (!Array.isArray(rawArgs)) {
      throw new BindingError(`MCP server ${name}: args must be a list`);
    }
    if (value.url || value.headers) {
      throw new BindingError(`MCP server ${name}: url and headers belong to an http server`);
    }
    const cwd = resolveValue(value.cwd);
    return {
      name, transport, tools, command: String(command), args: rawArgs.map((a) => String(resolveValue(a))),
      env: stringMap(name, 'env', value.env), cwd: cwd === undefined || cwd === null ? undefined : String(cwd),
      url: undefined, headers: {}, timeout_ms: timeoutMs, instances
    };
  }
  const url = resolveValue(value.url);
  if (!url) {
    throw new BindingError(`MCP server ${name}: an http server needs a url`);
  }
  if (value.command || value.args || value.env || value.cwd) {
    throw new BindingError(`MCP server ${name}: command, args, env and cwd belong to a stdio server`);
  }
  return {
    name, transport, tools, command: undefined, args: [], env: {}, cwd: undefined, url: String(url),
    headers: stringMap(name, 'headers', value.headers), timeout_ms: timeoutMs, instances
  };
}

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The server file: mcp.servers names it (default mcp-servers.yml in the resources folder next to
 * this file, or an absolute path).
 */
export function loadServers(path, log = defaultLog) {
  const config = appConfig();
  const defaultTimeout = Number(config.get('mcp.call.timeout.ms', DEFAULT_CALL_TIMEOUT_MS));
  let file = path ?? String(config.get('mcp.servers', DEFAULT_SERVERS_FILE));
  if (!isAbsolute(file)) {
    const base = config.resourcesDir ?? join(HERE, 'resources');
    file = join(base, file);
  }
  if (!existsSync(file) || !statSync(file).isFile()) {
    throw new BindingError(`MCP server file not found - ${file} (mcp.servers names it)`);
  }
  const data = YAML.parse(readFileSync(file, 'utf8')) ?? {};
  let servers = isMap(data) ? data.servers : undefined;
  if (servers === undefined || servers === null) servers = {};
  if (!isMap(servers)) {
    throw new BindingError(`${file} must hold a 'servers' map`);
  }
  if (Object.keys(servers).length === 0) {
    log.warn(`No MCP server configured in ${file} - the binding serves no tool route`);
  }
  const specs = Object.entries(servers).map(([name, value]) => serverOf(String(name), value, defaultTimeout));
  const routes = new Map();
  for (const spec of specs) {
    for (const binding of spec.tools) {
      const owner = routes.get(binding.route);
      if (owner) {
        throw new BindingError(`The route ${binding.route} is bound by both ${owner} and ${spec.name}`);
      }
      routes.set(binding.route, spec.name);
    }
  }
  return specs;
}

// --- one connection per server -----------------------------------------------------------

/** Every page of tools/list as plain maps. */
async function listTools(client) {
  const offered = [];
  let cursor;
  for (;;) {
    const page = await client.listTools(cursor ? { cursor } : undefined);
    offered.push(...page.tools.map(toolAsPlain));
    cursor = page.nextCursor;
    if (!cursor) return offered;
  }
}

/** The SDK client of a server: the transport its spec names, connected. */
export async function connectClient(spec) {
  const client = new Client({ name: 'mercury-mcp-binding', version: VERSION });
  let transport;
  if (spec.transport === TRANSPORT_STDIO) {
    transport = new StdioClientTransport({
      command: spec.command, args: spec.args, env: { ...getDefaultEnvironment(), ...spec.env }, cwd: spec.cwd,
      // the subprocess writes its own logs to this process's stderr
      stderr: 'inherit'
    });
  } else {
    transport = new StreamableHTTPClientTransport(new URL(spec.url), { requestInit: { headers: spec.headers } });
  }
  await client.connect(transport);
  return client;
}

/** One MCP server: its client, shared by every route of the server. */
export class Server {
  constructor(spec, connect = connectClient, log = defaultLog) {
    this.spec = spec;
    this.connect = connect;
    this.log = log;
    this.client = undefined;
    this.bound = [];
  }

  get connected() {
    return this.client !== undefined;
  }

  async start() {
    const client = await this.connect(this.spec);
    try {
      const offered = await listTools(client);
      this.bound = verify(this.spec, offered);
    } catch (e) {
      await client.close().catch(() => undefined);
      throw e;
    }
    this.client = client;
    client.onclose = () => {
      if (this.client === client) {
        this.log.warn(`MCP server ${this.spec.name} disconnected`);
        this.client = undefined;
      }
    };
  }

  async close() {
    const client = this.client;
    this.client = undefined;
    if (client) {
      try {
        await client.close();
      } catch (e) {
        this.log.warn(`MCP server ${this.spec.name} closed with an error - ${e.message}`);
      }
    }
  }

  async call(name, args) {
    const client = this.client;
    if (!client) {
      throw new AppException(503, `MCP server ${this.spec.name} is not connected`);
    }
    let result;
    try {
      result = await client.callTool({ name, arguments: args }, undefined, { timeout: this.spec.timeout_ms });
    } catch (e) {
      if (e?.code === REQUEST_TIMEOUT) {
        throw new AppException(408, `MCP server ${this.spec.name} did not answer ${name} within ${this.spec.timeout_ms} ms`);
      }
      throw new AppException(502, `MCP server ${this.spec.name} failed ${name}: ${e.message}`);
    }
    if (!isMap(result) || !Array.isArray(result.content)) {
      throw new AppException(502, `MCP server ${this.spec.name} answered ${name} outside the tool contract`);
    }
    return toolResult(asPlain(result));
  }
}

// --- the application: boot, the routes, the health check and describe ------------------------

/**
 * The binding, wired to its dependencies: connect(spec) opens a server's client, registry holds
 * the routes, log the logger and out(line) prints describe's output. Tests inject fakes.
 */
export function createBinding({
  connect = connectClient,
  registry = defaultRegistry,
  log = defaultLog,
  out = (line) => console.log(line)
} = {}) {
  const servers = new Map();

  function handler(server, binding) {
    return async (_headers, body) => {
      if (!isMap(body)) {
        throw new AppException(400, `The arguments of ${binding.name} must be a map`);
      }
      return server.call(binding.name, body);
    };
  }

  async function shutdown() {
    for (const server of servers.values()) {
      await server.close();
    }
    servers.clear();
  }

  /**
   * Connect every configured server, verify its allowlist and register the routes - before the
   * first request; a failure stops the application with its reason.
   */
  async function boot() {
    try {
      const specs = loadServers(undefined, log);
      for (const spec of specs) {
        const server = new Server(spec, connect, log);
        await server.start();
        servers.set(spec.name, server);
        for (const { binding } of server.bound) {
          registry.register(binding.route, handler(server, binding), { instances: spec.instances });
          log.info(`MCP server ${spec.name}: tool ${binding.name} served as ${binding.route}`);
        }
      }
      const routes = [...servers.values()].reduce((n, s) => n + s.bound.length, 0);
      log.info(`MCP binding ready - ${servers.size} server(s), ${routes} route(s)`);
    } catch (e) {
      log.error(`MCP binding cannot start - ${e.message}`);
      await shutdown();
      throw new BindingError(`MCP binding cannot start - ${e.message}`);
    }
  }

  /**
   * Health check speaking the engines' interface contract (type=info / type=health): which
   * servers are configured, how many tools each serves, and whether each is connected.
   */
  async function health(headers) {
    if (headers.type === 'info') {
      return {
        service: 'mcp.binding',
        href: 'http://127.0.0.1',
        servers: [...servers.values()].map((s) => ({
          name: s.spec.name, transport: s.spec.transport, tools: s.bound.length, connected: s.connected
        }))
      };
    }
    const disconnected = [...servers.values()].filter((s) => !s.connected).map((s) => s.spec.name);
    if (disconnected.length) {
      throw new AppException(503, `MCP server(s) not connected: ${disconnected.join(', ')}`);
    }
    return 'mcp.binding is running fine';
  }

  /** Print each server's tools, their input-schema digests and a catalog row for the graph. */
  async function describe(names, err = (line) => console.error(line)) {
    let specs;
    try {
      specs = loadServers(undefined, log);
    } catch (e) {
      err(`Cannot describe - ${e.message}`);
      return 1;
    }
    const wanted = specs.filter((s) => names.length === 0 || names.includes(s.name));
    const missing = names.filter((n) => !specs.some((s) => s.name === n)).sort();
    if (missing.length) {
      err(`Unknown server(s): ${missing.join(', ')} - configured: ${specs.map((s) => s.name).join(', ')}`);
      return 1;
    }
    for (const spec of wanted) {
      const client = await connect(spec);
      let offered;
      try {
        offered = await listTools(client);
      } finally {
        await client.close().catch(() => undefined);
      }
      const configured = new Map(spec.tools.map((b) => [b.name, b]));
      out(`# MCP server ${spec.name} (${spec.transport}) offers ${offered.length} tool(s)`);
      for (const tool of offered) {
        const digest = schemaDigest(tool.input_schema);
        const bound = configured.get(tool.name);
        const state = bound
          ? `bound as ${bound.route} ${bound.schema_sha256 === digest ? '(digest ok)' : '(DIGEST CHANGED)'}`
          : 'not allowlisted';
        out(`\n## ${tool.name} - ${state}\nschema_sha256: ${digest}`);
        const row = {
          name: tool.name.replace(API_SAFE, '_').slice(0, 128) || 'tool',
          route: bound ? bound.route : '<route>',
          description: tool.description,
          input_schema: tool.input_schema
        };
        out('catalog row (review the description before the graph carries it):');
        out(JSON.stringify(row, null, 2));
      }
    }
    return 0;
  }

  return { boot, shutdown, health, describe, servers };
}

const binding = createBinding();
preload('mcp.health', { instances: 5, isPrivate: true }, binding.health);

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  // -Dkey=value arguments belong to the configuration, which reads them from process.argv itself
  const words = process.argv.slice(2).filter((a) => !a.startsWith('-D'));
  loadConfig(undefined, HERE);
  if (words[0] === 'describe') {
    process.exitCode = await binding.describe(words.slice(1));
  } else {
    platform.onStartup(binding.boot);
    platform.onCleanup(binding.shutdown);
    await platform.run();
  }
} else {
  // loaded by mercury-serve: the servers connect inside the serving loop, before the first request
  platform.onStartup(binding.boot);
  platform.onCleanup(binding.shutdown);
}
