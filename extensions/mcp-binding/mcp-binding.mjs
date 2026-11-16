/**
 * The MCP binding - a library and a function host that serves the tools of MCP servers as composable
 * functions, one preload function per tool, bound in code to the remote tool through this module's
 * encapsulated MCP client (RFC-0011 / ADR-0033; the engines' draft-design-specs/agent-tool-use.md).
 * The engines stay MCP-free: a graph's agent loop (`llm.run`) names a route in its tool catalog, the
 * engine reaches it through declarative Event-over-HTTP like any other function, and the function
 * here issues `tools/call` to the server behind it. A stdio server runs as a subprocess of this
 * process, never of an engine, and its credentials stay in this process's environment.
 *
 * A tool is declared where every route is declared - in the code:
 *
 *     const render = bind('mermaid', 'validate_and_render_mermaid_diagram', { schemaSha256: '5ae6d75d...' });
 *     preload('mermaid.render', { instances: 10 }, async (_headers, body) => render(body));
 *
 * bind names the server (as the server file names it), the remote tool and the SHA-256 digest of
 * the tool's input schema, and returns the tool as an async function. Boot connects every server a
 * function binds a tool of, lists its tools and verifies every binding before the host listens: a
 * server that is not configured, a tool the server does not offer or an input schema whose digest
 * differs from the pinned one stops the application by name, so a server-side change stops a deploy
 * instead of becoming run-time errors a model improvises around. A route names the capability,
 * never the transport: a tool may start as an MCP tool and later be implemented another way, and
 * the graph must not know.
 *
 * Run:  npm install --save-dev @modelcontextprotocol/sdk     (or: npm install @modelcontextprotocol/sdk)
 *       node dist/src/cli.js extensions/mcp-binding/mcp-binding.mjs
 *
 * Servers are named in resources/mcp-servers.yml (the mcp.servers key of application.yml names
 * the file): each has its transport (stdio with a command, or http with a URL), its credential
 * references (${ENV_VAR} placeholders, resolved from this process's environment at boot and never
 * logged) and its call timeout - what is environment-specific. The tools are in the code.
 *
 *       node extensions/mcp-binding/mcp-binding.mjs describe [server ...]
 *
 * prints each server's tools with their digests, the bind line to paste and a catalog row for the
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
import { AppException, appConfig, getLogger, loadConfig, platform, preload, VERSION } from 'mercury-composable';

const defaultLog = getLogger('mcp-binding');

// --- the contract's defaults and limits ----------------------------------------------

export const DEFAULT_SERVERS_FILE = 'mcp-servers.yml';
export const DEFAULT_CALL_TIMEOUT_MS = 30000;
export const DEFAULT_INSTANCES = 10;
export const MIN_CALL_TIMEOUT_MS = 1000;
export const TRANSPORT_STDIO = 'stdio';
export const TRANSPORT_HTTP = 'http';
export const TRANSPORTS = [TRANSPORT_STDIO, TRANSPORT_HTTP];
export const SERVER_KEYS = ['transport', 'command', 'args', 'env', 'cwd', 'url', 'headers', 'timeout_ms'];
// the MCP specification's recommendation for a tool name
const TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/;
const DIGEST = /^[0-9a-f]{64}$/;
// the API-safe name a graph's catalog row may use, derived for the describe output
const API_SAFE = /[^a-zA-Z0-9_-]/g;
// the SDK's request timeout error code
const REQUEST_TIMEOUT = -32001;

/** A declaration, configuration or boot failure: the application must not start. */
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
 * Match the tools bound to a server ({ server, tool, schema_sha256 } in declaration order) against
 * the tools it offers (tools/list as plain maps with name, description and input_schema). Every
 * bound tool must be offered and its input schema must hash to the pinned digest; the first
 * failure, in declaration order, names the tool.
 */
export function verify(server, bindings, offered) {
  const byName = new Map(offered.map((tool) => [String(tool.name), tool]));
  const bound = [];
  for (const binding of bindings) {
    const tool = byName.get(binding.tool);
    if (!tool) {
      const names = [...byName.keys()].sort();
      throw new BindingError(`MCP server ${server} does not offer the tool ${binding.tool} - `
        + `it offers ${names.length ? names.join(', ') : 'no tools'}`);
    }
    const digest = schemaDigest(tool.input_schema);
    if (digest !== binding.schema_sha256) {
      throw new BindingError(`MCP server ${server} changed the input schema of ${binding.tool} - `
        + `its digest is now ${digest}, the binding pins ${binding.schema_sha256}`);
    }
    bound.push({ binding, tool });
  }
  return bound;
}

/**
 * The reply of a function from a CallToolResult as a plain map (content, structured_content,
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

// --- configuration: the servers ----------------------------------------------------------

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

function serverOf(name, value, defaultTimeoutMs) {
  if (!isMap(value)) {
    throw new BindingError(`MCP server ${name} must be a map`);
  }
  const unknown = Object.keys(value).filter((k) => !SERVER_KEYS.includes(k)).sort();
  if (unknown.length) {
    const hint = unknown.includes('tools') ? ' - the tools are bound in the code, not in this file' : '';
    throw new BindingError(`MCP server ${name} has unknown keys ${unknown.join(', ')} - the keys are ${SERVER_KEYS.join(', ')}${hint}`);
  }
  const transport = String(value.transport ?? '');
  if (!TRANSPORTS.includes(transport)) {
    throw new BindingError(`MCP server ${name}: transport must be stdio or http`);
  }
  const timeoutMs = Number(value.timeout_ms ?? defaultTimeoutMs);
  if (!Number.isFinite(timeoutMs) || timeoutMs < MIN_CALL_TIMEOUT_MS) {
    throw new BindingError(`MCP server ${name}: timeout_ms must be at least ${MIN_CALL_TIMEOUT_MS}`);
  }
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
      name, transport, command: String(command), args: rawArgs.map((a) => String(resolveValue(a))),
      env: stringMap(name, 'env', value.env), cwd: cwd === undefined || cwd === null ? undefined : String(cwd),
      url: undefined, headers: {}, timeout_ms: timeoutMs
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
    name, transport, command: undefined, args: [], env: {}, cwd: undefined, url: String(url),
    headers: stringMap(name, 'headers', value.headers), timeout_ms: timeoutMs
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
    log.warn(`No MCP server configured in ${file} - a function that binds a tool cannot start`);
  }
  return Object.entries(servers).map(([name, value]) => serverOf(String(name), value, defaultTimeout));
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

/** One MCP server: its client, shared by every function bound to the server. */
export class Server {
  constructor(spec, bindings = [], connect = connectClient, log = defaultLog) {
    this.spec = spec;
    this.bindings = [...bindings];
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
      this.bound = verify(this.spec.name, this.bindings, offered);
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

// --- the client: bind a tool, boot the servers, report the health, describe ---------------------

/**
 * The encapsulated MCP client of an application, wired to its dependencies: connect(spec) opens a
 * server's client, log the logger and out(line) prints describe's output. Tests inject fakes.
 */
export function createBinding({
  connect = connectClient,
  log = defaultLog,
  out = (line) => console.log(line)
} = {}) {
  const servers = new Map();
  // every tool a function of the application binds, in declaration order
  const declared = [];

  /**
   * Declare that a function of the application serves a tool of a server: the server as the server
   * file names it, the remote tool's name and the digest of its input schema (describe prints it).
   * Returns the tool as an async function - the arguments in (a map, else a 400), the result out as
   * toolResult shapes it; a server that is not connected is a 503. Boot verifies the declaration
   * against the live server before the host listens.
   */
  function bind(server, tool, { schemaSha256 } = {}) {
    const name = String(server ?? '').trim();
    if (!name) {
      throw new BindingError(`bind() needs the server's name for the tool ${tool} - the one the server file uses`);
    }
    if (!TOOL_NAME.test(String(tool ?? ''))) {
      throw new BindingError(`'${tool}' is not a tool name (letters, digits, '_', '.' and '-', up to 128)`);
    }
    const digest = String(schemaSha256 ?? '').toLowerCase();
    if (!DIGEST.test(digest)) {
      throw new BindingError(`The tool ${tool} of ${name} needs schemaSha256, the 64-hex digest of its input schema `
        + `- run 'node mcp-binding.mjs describe ${name}' to print it`);
    }
    const binding = { server: name, tool: String(tool), schema_sha256: digest };
    declared.push(binding);
    const call = async (args) => {
      if (!isMap(args)) {
        throw new AppException(400, `The arguments of ${binding.tool} must be a map`);
      }
      const live = servers.get(binding.server);
      if (!live) {
        throw new AppException(503, `MCP server ${binding.server} is not connected`);
      }
      return live.call(binding.tool, args);
    };
    return Object.assign(call, { server: binding.server, tool: binding.tool, declared: binding });
  }

  function declaredFor(server) {
    return declared.filter((d) => d.server === server);
  }

  async function shutdown() {
    for (const server of servers.values()) {
      await server.close();
    }
    servers.clear();
  }

  /**
   * Connect every server a function binds a tool of and verify every binding - before the host
   * listens; a failure stops the application with its reason.
   */
  async function boot() {
    try {
      const specs = loadServers(undefined, log);
      const configured = new Set(specs.map((s) => s.name));
      for (const d of declared) {
        if (!configured.has(d.server)) {
          throw new BindingError(`No MCP server named ${d.server} is configured - a function binds its tool ${d.tool}`);
        }
      }
      for (const spec of specs) {
        const bindings = declaredFor(spec.name);
        if (!bindings.length) {
          log.warn(`MCP server ${spec.name}: no function binds a tool of it - not connected`);
          continue;
        }
        const server = new Server(spec, bindings, connect, log);
        await server.start();
        servers.set(spec.name, server);
        for (const { binding } of server.bound) {
          log.info(`MCP server ${spec.name}: tool ${binding.tool} bound`);
        }
      }
      const bound = [...servers.values()].reduce((n, s) => n + s.bound.length, 0);
      log.info(`MCP binding ready - ${servers.size} server(s), ${bound} bound tool(s)`);
    } catch (e) {
      log.error(`MCP binding cannot start - ${e.message}`);
      await shutdown();
      throw new BindingError(`MCP binding cannot start - ${e.message}`);
    }
  }

  /**
   * Health check speaking the engines' interface contract (type=info / type=health): which
   * servers are connected and how many tools the functions of the application bind on each.
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

  /**
   * Print each server's tools, their input-schema digests, the bind line that declares each and a
   * catalog row for the graph.
   */
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
      const bindings = new Map(declaredFor(spec.name).map((d) => [d.tool, d]));
      out(`# MCP server ${spec.name} (${spec.transport}) offers ${offered.length} tool(s)`);
      for (const tool of offered) {
        const digest = schemaDigest(tool.input_schema);
        const bound = bindings.get(tool.name);
        const state = bound
          ? `bound ${bound.schema_sha256 === digest ? '(digest ok)' : '(DIGEST CHANGED)'}`
          : 'not bound';
        out(`\n## ${tool.name} - ${state}\nschema_sha256: ${digest}`);
        out(`bind('${spec.name}', '${tool.name}', { schemaSha256: '${digest}' })`);
        const row = {
          name: tool.name.replace(API_SAFE, '_').slice(0, 128) || 'tool',
          route: '<the route of the function that binds it>',
          description: tool.description,
          input_schema: tool.input_schema
        };
        out("catalog row (name your function's route; review the description before the graph carries it):");
        out(JSON.stringify(row, null, 2));
      }
    }
    return 0;
  }

  return { bind, boot, shutdown, health, describe, servers, declared, declaredFor };
}

const binding = createBinding();
/** Declare a tool a function of this application serves - see createBinding().bind. */
export const bind = binding.bind;

preload('mcp.health', { instances: 5, isPrivate: true }, binding.health);

// --- the functions: a tool of an MCP server is a composable function of this application -------
//
// Declare each tool with bind(server, tool, { schemaSha256 }) - the server as the server file names
// it, the remote tool's name and the digest `describe` prints - and call it from an ordinary
// preload function, which may pass the arguments through, shape them or add behaviour around the
// call. Name the route after the capability, never the transport.

/**
 * Validate a Mermaid diagram and render it as SVG - the tool of the public Mermaid Chart MCP server
 * the default server file names. The body is the tool's arguments (diagramCode); the reply is the
 * server's structured result.
 */
export const renderMermaid = bind('mermaid', 'validate_and_render_mermaid_diagram',
  { schemaSha256: '5ae6d75d4ecfab919d9ef934bd679605bdbfc8b90b4d46f4d9dbd54d19c275ad' });
preload('mermaid.render', { instances: DEFAULT_INSTANCES }, async (_headers, body) => renderMermaid(body));

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
  // loaded by mercury-serve: the servers connect inside the serving loop, before the host listens
  platform.onStartup(binding.boot);
  platform.onCleanup(binding.shutdown);
}
