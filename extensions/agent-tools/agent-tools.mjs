/**
 * The essential built-in tools for agent loops - files inside one workspace, the web inside an
 * allowlist of sites, the agent's knowledge graph inside one database, and a clock - as composable
 * functions of a pack extension (RFC-0013; the engines' draft-design-specs/agent-essential-tools.md).
 * A graph's agent loop (`llm.run`) names a route of this application in its tool catalog, the engine
 * reaches the route through declarative Event-over-HTTP like any other function, and the model's
 * arguments arrive as the event body. The loop, the catalog and the graph see nothing special about a
 * built-in tool: a route names the capability (`file.read`, `web.fetch`), never the implementation.
 *
 * The sandbox is deployment configuration, never an argument of a call:
 *
 * - `tools.file.root` names the one directory tree the file tools may touch (`file.read`,
 *   `file.write`, `file.list`, `file.search`, and `file.extract` when mammoth and pdfjs-dist are
 *   installed). Every path is relative to it, resolved with symbolic links followed, and refused
 *   when the result is outside the root.
 * - `tools.web.allow` names the host patterns the two web tools may reach (`web.fetch`, `web.crawl`),
 *   over https unless a host is listed with `http://`; an address in a loopback, private, link-local
 *   or multicast range is refused unless `tools.web.allow.private=true`, and every redirect is
 *   checked again.
 * - `tools.graph.uri` names the one graph database the four knowledge-graph tools reach over the Bolt
 *   protocol (`graph.schema`, `graph.query` in a read transaction; `graph.write` and `graph.ingest`
 *   only when `tools.graph.write=true`, deletion only when `tools.graph.delete=true`); neo4j-driver
 *   is the driver, installed by the application that runs the tools.
 * - `time.now` reads nothing and registers unless `tools.time=false`.
 *
 * A tool whose sandbox is not configured does not register, so an unconfigured tool is a 404 to the
 * loop's pre-flight check, not an open door. Every tool refuses an argument outside its sandbox with
 * a 400 that names the rule - the loop returns it to the model as that call's error, and the node
 * never fails because of a tool. Results are text, capped by the tool's own limits, and data a model
 * reads, never an instruction the loop obeys.
 *
 * Run:  node dist/src/cli.js extensions/agent-tools/agent-tools.mjs -Dtools.file.root=/srv/workspace
 *
 * Each tool ships the catalog row an author copies onto the graph (the name the model sees, the
 * description, the input schema, the route and the write mark); `describe` prints them and says
 * which tools register under the current configuration:
 *
 *       node extensions/agent-tools/agent-tools.mjs describe [name ...]
 *
 * The same rows are kept as files under catalog/ next to this module, byte for byte the files the
 * Python twin (mercury-python extensions/agent-tools) carries.
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import { createReadStream } from 'node:fs';
import { mkdir, open, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AppException, appConfig, defaultRegistry, getLogger, isoUtc, loadConfig, platform, preload, VERSION } from 'mercury-composable';

const defaultLog = getLogger('agent-tools');

// --- the contract's defaults and limits -----------------------------------------------------

export const INSTANCES = 10;
export const USER_AGENT = `Mercury-Composable-AgentTools/${VERSION} (+https://github.com/Accenture/mercury-composable)`;
// the token robots.txt rules are matched against
export const ROBOTS_AGENT = 'MercuryComposable';

// files: the workspace and its limits
export const FILE_ROOT = 'tools.file.root';
export const FILE_MAX_BYTES = 'tools.file.max.bytes';
export const FILE_HIDDEN = 'tools.file.hidden';
export const FILE_WRITE_EXTENSIONS = 'tools.file.write.extensions';
export const FILE_LINE_MAX_CHARS = 'tools.file.line.max.chars';
export const FILE_EXTRACT_MAX_CHARS = 'tools.file.extract.max.chars';
export const DEFAULT_FILE_MAX_BYTES = 256 * 1024;
export const DEFAULT_LINE_MAX_CHARS = 500;
export const DEFAULT_EXTRACT_MAX_CHARS = 60000;
export const LIST_DEFAULT = 200;
export const LIST_CAP = 2000;
export const SEARCH_DEFAULT = 100;
export const SEARCH_CAP = 1000;
export const CONTEXT_CAP = 3;
// how many directory entries a list or a search walks before it gives up - the tool's own bound
export const SCAN_LIMIT = 20000;
export const WRITE_MODES = ['create', 'overwrite', 'append'];
export const DOCUMENTS_EXTRA = 'npm install --save-dev mammoth pdfjs-dist';

// the web: the allowlist and its limits
export const WEB_ALLOW = 'tools.web.allow';
export const WEB_ALLOW_PRIVATE = 'tools.web.allow.private';
export const WEB_MAX_BYTES = 'tools.web.max.bytes';
export const WEB_TIMEOUT_MS = 'tools.web.timeout.ms';
export const WEB_CRAWL_MAX_PAGES = 'tools.web.crawl.max.pages';
export const WEB_CRAWL_DELAY_MS = 'tools.web.crawl.delay.ms';
export const WEB_PAGE_MAX_CHARS = 'tools.web.page.max.chars';
export const DEFAULT_WEB_MAX_BYTES = 1024 * 1024;
export const DEFAULT_WEB_TIMEOUT_MS = 10000;
export const MIN_WEB_TIMEOUT_MS = 100;
export const CRAWL_PAGES_DEFAULT = 10;
export const CRAWL_PAGES_CAP = 50;
export const CRAWL_DEPTH_DEFAULT = 2;
export const CRAWL_DEPTH_CAP = 5;
export const DEFAULT_CRAWL_DELAY_MS = 500;
export const DEFAULT_PAGE_MAX_CHARS = 20000;
// a crawl's whole text budget, under the loop's default result limit (llm.run.result.limit, 65536)
export let CRAWL_RESULT_MAX_CHARS = 60000;
export const MAX_REDIRECTS = 5;
export const REDIRECT_STATUSES = [301, 302, 303, 307, 308];
export const FETCH_MODES = ['text', 'markdown', 'raw'];

// the knowledge graph: one database over Bolt
export const GRAPH_URI = 'tools.graph.uri';
export const GRAPH_DATABASE = 'tools.graph.database';
export const GRAPH_USERNAME = 'tools.graph.username';
export const GRAPH_PASSWORD = 'tools.graph.password';
export const GRAPH_WRITE = 'tools.graph.write';
export const GRAPH_DELETE = 'tools.graph.delete';
export const GRAPH_MAX_ROWS = 'tools.graph.max.rows';
export const GRAPH_TIMEOUT_MS = 'tools.graph.timeout.ms';
export const GRAPH_INGEST_MAX_NODES = 'tools.graph.ingest.max.nodes';
export const GRAPH_EXTRA = 'npm install --save-dev neo4j-driver';
export const ROWS_DEFAULT = 200;
export const ROWS_CAP = 2000;
export const DEFAULT_GRAPH_TIMEOUT_MS = 10000;
export const DEFAULT_INGEST_MAX_NODES = 500;
// a call may carry this many relationships per allowed node - the tool's own bound
export const INGEST_RELATIONSHIPS_PER_NODE = 4;
// every node graph.ingest writes carries this label beside its own, and one uniqueness constraint on
// its key gives the index that finds a node by key; a caller's label starts with a letter
// (IDENTIFIER), so it can never be this one
export const INGEST_LABEL = '_Ingested';
export const INGEST_CONSTRAINT = 'mercury_ingested_key';
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const PROPERTY_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
// the clauses a read-only query may not carry, and the ones the delete gate guards
const WRITE_CLAUSES = /\b(CREATE|MERGE|SET|DELETE|REMOVE|DROP|LOAD\s+CSV)\b/i;
const DELETE_CLAUSES = /\b(DELETE|DROP)\b/i;
// string literals, quoted identifiers and comments, blanked before a query is scanned for clauses
const CYPHER_LITERALS = /'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`[^`]*`|\/\/[^\n]*|\/\*[\s\S]*?\*\//g;
export const KEY_MAX_CHARS = 512;
export const COUNTER_NAMES = ['nodes_created', 'nodes_deleted', 'relationships_created', 'relationships_deleted',
  'properties_set', 'labels_added', 'labels_removed', 'indexes_added', 'constraints_added'];
// the driver's camel-cased counters, by the contract's names
const DRIVER_COUNTERS = {
  nodes_created: 'nodesCreated', nodes_deleted: 'nodesDeleted', relationships_created: 'relationshipsCreated',
  relationships_deleted: 'relationshipsDeleted', properties_set: 'propertiesSet', labels_added: 'labelsAdded',
  labels_removed: 'labelsRemoved', indexes_added: 'indexesAdded', constraints_added: 'constraintsAdded'
};

// the clock
export const TIME_ENABLED = 'tools.time';

/** A configuration failure: the application must not start. */
export class ToolsError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ToolsError';
  }
}

function isMap(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// the order Python's sorted() gives the same keys: an explicit comparator, so a locale never enters
function byCodeUnit(a, b) {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

// --- the catalog rows - what an author copies onto the graph ---------------------------------
//
// The description is what the model reads; the input schema is the closed subset the loop
// validates against (every row refuses an unknown argument). No row sets `strict`: the graph's
// author adds it when the model in use constrains optional properties by grammar. The rows are
// the files under catalog/, byte for byte, which the Python twin carries too.

export const FILE_READ_ROW = {
  "name": "file_read",
  "description": "Read a UTF-8 text file from the agent's workspace. path is relative to the workspace root (for example notes/plan.md); an absolute path or one that leaves the workspace is refused. Returns the text, the file's size in bytes and whether the text was cut at max_bytes. A binary file is an error naming its type.",
  "input_schema": {
    "type": "object",
    "properties": {
      "path": {
        "type": "string",
        "description": "The file, relative to the workspace root."
      },
      "max_bytes": {
        "type": "integer",
        "minimum": 1,
        "description": "Read at most this many bytes (default and cap: the workspace's limit)."
      }
    },
    "required": [
      "path"
    ],
    "additionalProperties": false
  },
  "route": "file.read"
};

export const FILE_WRITE_ROW = {
  "name": "file_write",
  "description": "Write a UTF-8 text file in the agent's workspace. path is relative to the workspace root; missing parent folders are created. mode is create (the default; it refuses a file that exists), overwrite (replace the file) or append (add to its end). Returns the path, the bytes written and the mode.",
  "input_schema": {
    "type": "object",
    "properties": {
      "path": {
        "type": "string",
        "description": "The file, relative to the workspace root."
      },
      "content": {
        "type": "string",
        "description": "The text to write."
      },
      "mode": {
        "type": "string",
        "enum": [
          "create",
          "overwrite",
          "append"
        ],
        "default": "create",
        "description": "create refuses an existing file; overwrite replaces it; append extends it."
      }
    },
    "required": [
      "path",
      "content"
    ],
    "additionalProperties": false
  },
  "route": "file.write",
  "write": true
};

export const FILE_LIST_ROW = {
  "name": "file_list",
  "description": "List the files and folders of a workspace directory. path is a folder relative to the workspace root (default: the root); glob filters by pattern, recursively with ** (for example **/*.md). Each entry has its path, type (file or directory), size in bytes and modification time. Hidden entries are not listed. The list is cut at max_entries.",
  "input_schema": {
    "type": "object",
    "properties": {
      "path": {
        "type": "string",
        "default": ".",
        "description": "The folder, relative to the workspace root."
      },
      "glob": {
        "type": "string",
        "description": "A pattern such as *.md or **/*.py; without it, the folder's direct entries."
      },
      "max_entries": {
        "type": "integer",
        "minimum": 1,
        "maximum": 2000,
        "default": 200,
        "description": "At most this many entries."
      }
    },
    "required": [],
    "additionalProperties": false
  },
  "route": "file.list"
};

export const FILE_SEARCH_ROW = {
  "name": "file_search",
  "description": "Search the text files of the workspace for a literal (the default) or a regular expression (regex: true), case-insensitive unless case_sensitive is true. path narrows the search to a folder, glob to matching files (for example **/*.py); context adds up to 3 lines before and after each match. Returns the matching lines with their file and line number, how many files were searched and whether the result was cut at max_results. Binary files are skipped.",
  "input_schema": {
    "type": "object",
    "properties": {
      "pattern": {
        "type": "string",
        "description": "The text to find, or a regular expression with regex: true."
      },
      "regex": {
        "type": "boolean",
        "default": false,
        "description": "Treat pattern as a regular expression."
      },
      "path": {
        "type": "string",
        "default": ".",
        "description": "The folder to search, relative to the root."
      },
      "glob": {
        "type": "string",
        "default": "**/*",
        "description": "The files to search, as a pattern."
      },
      "case_sensitive": {
        "type": "boolean",
        "default": false
      },
      "context": {
        "type": "integer",
        "minimum": 0,
        "maximum": 3,
        "default": 0,
        "description": "Lines of context before and after each match."
      },
      "max_results": {
        "type": "integer",
        "minimum": 1,
        "maximum": 1000,
        "default": 100,
        "description": "At most this many matches."
      }
    },
    "required": [
      "pattern"
    ],
    "additionalProperties": false
  },
  "route": "file.search"
};

export const FILE_EXTRACT_ROW = {
  "name": "file_extract",
  "description": "Extract the text of a PDF or Word document in the agent's workspace (an HTML or plain text file works too), with a marker before each page (--- page N ---). path is relative to the workspace root; pages selects a range such as 1-3,7 (default: all pages); the text is cut at max_chars. Returns the path, the document type, the number of pages the document has and the text. Use file_read for a plain text file.",
  "input_schema": {
    "type": "object",
    "properties": {
      "path": {
        "type": "string",
        "description": "The document, relative to the workspace root."
      },
      "pages": {
        "type": "string",
        "description": "The pages to extract, 1-based, such as 1-3,7; default: all."
      },
      "max_chars": {
        "type": "integer",
        "minimum": 100,
        "description": "Return at most this many characters (default and cap: the workspace's limit)."
      }
    },
    "required": [
      "path"
    ],
    "additionalProperties": false
  },
  "route": "file.extract"
};

export const WEB_FETCH_ROW = {
  "name": "web_fetch",
  "description": "Fetch one web page or text resource from a site this agent may reach and return its readable text. HTML is reduced to its text with scripts, styles and navigation dropped; as: markdown keeps headings, lists and links as Markdown; as: raw returns the body as received when it is text. A URL outside the allowed sites is an error naming the rule. Returns the final URL, the HTTP status, the content type, the title, the text, the size in bytes and whether the text was cut.",
  "input_schema": {
    "type": "object",
    "properties": {
      "url": {
        "type": "string",
        "description": "The https URL to fetch."
      },
      "as": {
        "type": "string",
        "enum": [
          "text",
          "markdown",
          "raw"
        ],
        "default": "text",
        "description": "text: readable text; markdown: text with headings, lists and links; raw: the body."
      }
    },
    "required": [
      "url"
    ],
    "additionalProperties": false
  },
  "route": "web.fetch"
};

export const WEB_CRAWL_ROW = {
  "name": "web_crawl",
  "description": "Read a documentation section or a small site: fetch the start page and follow its links on the same site, breadth-first, up to max_pages pages and max_depth links deep, honouring robots.txt. include keeps the crawl under a path prefix (for example /docs/guides/). Returns each page's URL, title and readable text, how many pages were fetched and whether the result was cut; when it was cut, ask again from a narrower start page or with include.",
  "input_schema": {
    "type": "object",
    "properties": {
      "url": {
        "type": "string",
        "description": "The start page."
      },
      "max_pages": {
        "type": "integer",
        "minimum": 1,
        "maximum": 50,
        "default": 10,
        "description": "At most this many pages."
      },
      "max_depth": {
        "type": "integer",
        "minimum": 0,
        "maximum": 5,
        "default": 2,
        "description": "How many links deep to follow from the start page."
      },
      "include": {
        "type": "string",
        "description": "A path prefix the followed links must start with."
      }
    },
    "required": [
      "url"
    ],
    "additionalProperties": false
  },
  "route": "web.crawl"
};

export const GRAPH_SCHEMA_ROW = {
  "name": "graph_schema",
  "description": "The schema of the agent's knowledge graph: every node label with its count and its property names and types, and every relationship type with its count and the labels it connects. Read it before writing a query or an ingest, so labels, types and property names match what the graph holds.",
  "input_schema": {
    "type": "object",
    "properties": {},
    "required": [],
    "additionalProperties": false
  },
  "route": "graph.schema"
};

export const GRAPH_QUERY_ROW = {
  "name": "graph_query",
  "description": "Run a read-only openCypher query against the agent's knowledge graph and return its rows. Pass values as parameters ($name in the query, the value under that name in parameters) instead of writing them into the query. A node comes back as {id, labels, properties}, a relationship as {id, type, start, end, properties}, a path as a list of them. Rows are capped: narrow the query with WHERE and LIMIT when the result was cut. A query that writes (CREATE, MERGE, SET, DELETE, REMOVE, DROP, LOAD CSV) is refused - use graph_write or graph_ingest. To find a node by its key, match it through the label every ingested node carries, which holds the index: MATCH (n:_Ingested {key: $key}).",
  "input_schema": {
    "type": "object",
    "properties": {
      "query": {
        "type": "string",
        "description": "The openCypher query, read-only, with $parameters."
      },
      "parameters": {
        "type": "object",
        "description": "The values the query's $parameters take."
      }
    },
    "required": [
      "query"
    ],
    "additionalProperties": false
  },
  "route": "graph.query"
};

export const GRAPH_WRITE_ROW = {
  "name": "graph_write",
  "description": "Run an openCypher statement that changes the agent's knowledge graph - an index or a constraint, a corrected property, a relationship between existing nodes - and return the counters of what changed. Pass every value as a parameter. DELETE and DROP are refused unless the deployment allows deletion. To load extracted entities and relations, prefer graph_ingest, which merges them idempotently.",
  "input_schema": {
    "type": "object",
    "properties": {
      "query": {
        "type": "string",
        "description": "The openCypher statement, with $parameters."
      },
      "parameters": {
        "type": "object",
        "description": "The values the statement's $parameters take."
      }
    },
    "required": [
      "query"
    ],
    "additionalProperties": false
  },
  "route": "graph.write",
  "write": true
};

export const GRAPH_INGEST_ROW = {
  "name": "graph_ingest",
  "description": "Load what you extracted from a document into the agent's knowledge graph, idempotently. Each node is merged on its key - unique across the graph, the label in lower case as its prefix (clause:12, party:supplier-a) - with its label and properties; each relationship is merged between two keys that exist (in this call or already in the graph) with its type and properties. Labels and types are identifiers (letters, digits and underscore, starting with a letter); property values are scalars or lists of scalars. Give source (the document's path or URL) so an answer can cite it. Running the same ingest twice changes nothing. A key names one node: the same key under another label is refused.",
  "input_schema": {
    "type": "object",
    "properties": {
      "nodes": {
        "type": "array",
        "description": "The entities: a key, a label and properties each.",
        "items": {
          "type": "object",
          "properties": {
            "key": {
              "type": "string",
              "description": "Unique across the graph, prefixed with the label."
            },
            "label": {
              "type": "string",
              "description": "The node's label, an identifier."
            },
            "properties": {
              "type": "object",
              "description": "Scalar or list-of-scalar values by name."
            }
          },
          "required": [
            "key",
            "label"
          ],
          "additionalProperties": false
        }
      },
      "relationships": {
        "type": "array",
        "description": "The relations: from a key to a key, with a type and properties.",
        "items": {
          "type": "object",
          "properties": {
            "from": {
              "type": "string",
              "description": "The key of the start node."
            },
            "to": {
              "type": "string",
              "description": "The key of the end node."
            },
            "type": {
              "type": "string",
              "description": "The relationship type, an identifier."
            },
            "properties": {
              "type": "object",
              "description": "Scalar or list-of-scalar values by name."
            }
          },
          "required": [
            "from",
            "to",
            "type"
          ],
          "additionalProperties": false
        }
      },
      "source": {
        "type": "string",
        "description": "The document the facts come from - its path or URL."
      }
    },
    "required": [],
    "additionalProperties": false
  },
  "route": "graph.ingest",
  "write": true
};

export const TIME_NOW_ROW = {
  "name": "time_now",
  "description": "The current date and time. timezone is an IANA name (for example Europe/Berlin; default UTC). Returns the UTC time, the local time in that zone, its offset, the weekday and the epoch in milliseconds. Use it before reasoning about today, deadlines or periods.",
  "input_schema": {
    "type": "object",
    "properties": {
      "timezone": {
        "type": "string",
        "default": "UTC",
        "description": "An IANA time zone name."
      }
    },
    "required": [],
    "additionalProperties": false
  },
  "route": "time.now"
};

export const ROWS = [FILE_READ_ROW, FILE_WRITE_ROW, FILE_LIST_ROW, FILE_SEARCH_ROW, FILE_EXTRACT_ROW, WEB_FETCH_ROW,
  WEB_CRAWL_ROW, GRAPH_SCHEMA_ROW, GRAPH_QUERY_ROW, GRAPH_WRITE_ROW, GRAPH_INGEST_ROW, TIME_NOW_ROW];
export const ROW_BY_ROUTE = new Map(ROWS.map((row) => [row.route, row]));
const HERE = dirname(fileURLToPath(import.meta.url));
export const CATALOG_DIR = join(HERE, 'catalog');

/** A row as its catalog file carries it: two-space indent, Unicode kept, one trailing newline. */
export function rowJson(row) {
  return JSON.stringify(row, null, 2) + '\n';
}

// --- configuration helpers ---------------------------------------------------------------------

function setting(key, defaultValue = undefined) {
  const value = appConfig().get(key, defaultValue);
  if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) {
    return defaultValue;
  }
  return value;
}

function intSetting(key, defaultValue, { floor = 1, cap = undefined, log = defaultLog } = {}) {
  const raw = setting(key, defaultValue);
  const value = Number(String(raw).trim());
  if (!Number.isInteger(value)) {
    throw new ToolsError(`${key} must be an integer, not ${JSON.stringify(raw)}`);
  }
  if (value < floor) {
    throw new ToolsError(`${key} must be at least ${floor}`);
  }
  if (cap !== undefined && value > cap) {
    log.warn(`${key}=${value} is over the tool's cap ${cap} - a deployment lowers a limit, never raises it; using ${cap}`);
    return cap;
  }
  return value;
}

function boolSetting(key, defaultValue) {
  const raw = setting(key, defaultValue);
  if (typeof raw === 'boolean') return raw;
  const text = String(raw).trim().toLowerCase();
  if (['true', 'yes', 'on', '1'].includes(text)) return true;
  if (['false', 'no', 'off', '0'].includes(text)) return false;
  throw new ToolsError(`${key} must be true or false, not ${JSON.stringify(raw)}`);
}

function listSetting(key) {
  const raw = setting(key);
  if (raw === undefined) return [];
  const items = Array.isArray(raw) ? raw : String(raw).split(',');
  return items.map((item) => String(item).trim()).filter((item) => item);
}

// --- argument helpers - a tool's body is a map of the row's properties ------------------------

function argumentsOf(body, row) {
  if (body === undefined || body === null) return {};
  if (!isMap(body)) {
    throw new AppException(400, `The arguments of ${row.name} must be a map`);
  }
  const known = Object.keys(row.input_schema.properties);
  const unknown = Object.keys(body).filter((key) => !known.includes(key)).sort(byCodeUnit);
  if (unknown.length) {
    throw new AppException(400, `${row.name} does not take ${unknown.join(', ')} - its arguments are ${known.join(', ')}`);
  }
  return body;
}

function stringArg(args, name, { defaultValue = undefined } = {}) {
  const value = args[name];
  if (value === undefined || value === null) {
    if (defaultValue === undefined) {
      throw new AppException(400, `${name} is required`);
    }
    return defaultValue;
  }
  if (typeof value !== 'string') {
    throw new AppException(400, `${name} must be a string`);
  }
  return value;
}

function integerArg(args, name, { defaultValue, floor, cap }) {
  const value = args[name];
  if (value === undefined || value === null) return Math.min(defaultValue, cap);
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new AppException(400, `${name} must be an integer`);
  }
  if (value < floor) {
    throw new AppException(400, `${name} must be at least ${floor}`);
  }
  return Math.min(value, cap);
}

function flagArg(args, name, { defaultValue }) {
  const value = args[name];
  if (value === undefined || value === null) return defaultValue;
  if (typeof value !== 'boolean') {
    throw new AppException(400, `${name} must be true or false`);
  }
  return value;
}

function choiceArg(args, name, choices, { defaultValue }) {
  const value = stringArg(args, name, { defaultValue });
  if (!choices.includes(value)) {
    throw new AppException(400, `${name} must be one of ${choices.join(', ')}`);
  }
  return value;
}

// --- files, inside one workspace ----------------------------------------------------------------

/**
 * The file tools' sandbox from the configuration - undefined when tools.file.root is not set, so
 * the file tools do not register; a root that is not a directory stops the boot.
 */
export async function loadFileSandbox({ log = defaultLog } = {}) {
  const rootSetting = setting(FILE_ROOT);
  if (rootSetting === undefined) return undefined;
  let root = String(rootSetting);
  if (root.startsWith('~/')) root = join(process.env.HOME ?? '', root.slice(2));
  let info;
  try {
    info = await stat(root);
  } catch {
    info = undefined;
  }
  if (!info || !info.isDirectory()) {
    throw new ToolsError(`${FILE_ROOT} is not a directory - ${root}`);
  }
  const extensions = listSetting(FILE_WRITE_EXTENSIONS).map((ext) => (ext.startsWith('.') ? ext.toLowerCase() : `.${ext.toLowerCase()}`));
  return {
    root: await realpath(root),
    maxBytes: intSetting(FILE_MAX_BYTES, DEFAULT_FILE_MAX_BYTES, { log }),
    hidden: boolSetting(FILE_HIDDEN, false),
    writeExtensions: extensions,
    lineMaxChars: intSetting(FILE_LINE_MAX_CHARS, DEFAULT_LINE_MAX_CHARS, { floor: 20, log }),
    extractMaxChars: intSetting(FILE_EXTRACT_MAX_CHARS, DEFAULT_EXTRACT_MAX_CHARS, { floor: 100, log })
  };
}

const DRIVE = /^[A-Za-z]:/;
const MAGIC = [
  ['%PDF', 'a PDF document'],
  ['\x89PNG', 'a PNG image'],
  ['\xff\xd8\xff', 'a JPEG image'],
  ['GIF8', 'a GIF image'],
  ['PK\x03\x04', 'a ZIP archive or an Office document'],
  ['\x1f\x8b', 'a gzip archive'],
  ['\x7fELF', 'an executable']
];

function isAbsolutePath(text) {
  return isAbsolute(text) || posix.isAbsolute(text) || text.startsWith('/') || text.startsWith('\\') || DRIVE.test(text);
}

function isHidden(relativePath) {
  return relativePath.split('/').some((part) => part.startsWith('.') && part !== '.' && part !== '..');
}

/**
 * What a file that is not text looks like, from its first bytes: a known format by its magic
 * number, else `binary` when it carries a NUL byte; undefined for text.
 */
export function binaryKind(head) {
  const latin = Buffer.from(head).toString('latin1');
  for (const [magic, kind] of MAGIC) {
    if (latin.startsWith(magic)) return kind;
  }
  return head.includes(0) ? 'binary' : undefined;
}

const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true });

/** The bytes as UTF-8, or undefined when they are not; a cut that split a character is forgiven at the tail. */
export function decodeUtf8(data, { truncated }) {
  try {
    return STRICT_UTF8.decode(data);
  } catch {
    if (!truncated) return undefined;
  }
  for (let trim = 1; trim <= 3; trim++) {
    try {
      return STRICT_UTF8.decode(data.subarray(0, data.length - trim));
    } catch {
      // try a shorter tail
    }
  }
  return undefined;
}

/** The real path of a file that may not exist yet: its deepest existing ancestor resolved, the rest appended. */
async function realpathLenient(path) {
  const missing = [];
  let current = path;
  for (;;) {
    try {
      const real = await realpath(current);
      return missing.length ? join(real, ...missing.reverse()) : real;
    } catch (e) {
      if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e;
      const parent = dirname(current);
      if (parent === current) throw e;
      missing.push(current.slice(parent.length).replace(/^[\\/]/, ''));
      current = parent;
    }
  }
}

function modifiedOf(info) {
  return new Date(info.mtimeMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * A glob pattern as Python's Path.glob reads it - `*` within a segment, `?` one character, `[...]` a class,
 * `**` any number of segments - compiled to a matcher over slash-separated relative paths, with the depth the
 * walk needs (undefined for a recursive pattern). Node 20 has no fs.glob, so the walk is in-house.
 */
export function compileGlob(pattern) {
  if (pattern.startsWith('/') || pattern.startsWith('\\') || DRIVE.test(pattern) || !pattern.trim()) {
    throw new AppException(400, 'glob is not a valid pattern (a pattern is relative to path)');
  }
  const segments = pattern.split('/').filter((part) => part && part !== '.');
  if (segments.some((part) => part === '..')) {
    throw new AppException(400, 'glob is not a valid pattern (no .. in a pattern)');
  }
  const recursive = segments.includes('**');
  const parts = segments.map((segment) => {
    if (segment === '**') return '(?:[^/]+/)*';
    let out = '';
    for (let i = 0; i < segment.length; i++) {
      const ch = segment[i];
      if (ch === '*') {
        out += '[^/]*';
      } else if (ch === '?') {
        out += '[^/]';
      } else if (ch === '[') {
        const close = segment.indexOf(']', i + 1);
        if (close < 0) {
          out += '\\[';
          continue;
        }
        let body = segment.slice(i + 1, close);
        if (body.startsWith('!')) body = '^' + body.slice(1);
        out += '[' + body.replace(/\\/g, '\\\\') + ']';
        i = close;
      } else {
        out += ch.replace(/[.+^$(){}|\\]/g, (c) => '\\' + c);
      }
    }
    return out + '/';
  });
  const source = '^' + parts.join('').replace(/\/$/, '') + '$';
  let regex;
  try {
    regex = new RegExp(source);
  } catch (e) {
    throw new AppException(400, `glob is not a valid pattern (${e.message})`);
  }
  return { test: (relativePath) => regex.test(relativePath), depth: recursive ? undefined : segments.length };
}

/** Every entry under a directory that matches a compiled glob, as absolute paths, bounded by the scan limit; a symbolic link is an entry, never descended into. */
async function globWalk(base, matcher) {
  const found = [];
  const queue = [{ dir: base, relativeDir: '', level: 1 }];
  while (queue.length && found.length <= SCAN_LIMIT) {
    const { dir, relativeDir, level } = queue.shift();
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      if (matcher.test(relativePath)) found.push(join(dir, entry.name));
      if (found.length > SCAN_LIMIT) break;
      if (entry.isDirectory() && !entry.isSymbolicLink() && (matcher.depth === undefined || level < matcher.depth)) {
        queue.push({ dir: join(dir, entry.name), relativeDir: relativePath, level: level + 1 });
      }
    }
  }
  return found;
}

/** The four file tools (five with the documents libraries) over one workspace; every path goes through resolvePath first. */
export function createFileTools(sandbox, { log = defaultLog, documents = undefined } = {}) {
  const root = sandbox.root;

  function insideRoot(resolved) {
    return resolved === root || resolved.startsWith(root + sep);
  }

  /**
   * A path argument to the file it names inside the workspace, with symbolic links followed, and
   * its workspace-relative form; outside the root, hidden when hidden entries are off, or absolute,
   * it is refused by rule.
   */
  async function resolvePath(text, { what = 'path' } = {}) {
    const value = text.trim() || '.';
    if (isAbsolutePath(value)) {
      throw new AppException(400, `${what} must be relative to the workspace, not absolute`);
    }
    let resolved;
    try {
      resolved = await realpathLenient(resolve(root, value));
    } catch (e) {
      throw new AppException(400, `${what} cannot be resolved (${e.code ?? e.name})`);
    }
    if (!insideRoot(resolved)) {
      throw new AppException(400, `${what} is outside the workspace`);
    }
    const relativePath = resolved === root ? '.' : relative(root, resolved).split(sep).join('/');
    if (!sandbox.hidden && isHidden(relativePath)) {
      throw new AppException(400, `${what} names a hidden entry, which the workspace does not expose (${FILE_HIDDEN})`);
    }
    return { resolved, relativePath };
  }

  async function statOrUndefined(path) {
    try {
      return await stat(path);
    } catch {
      return undefined;
    }
  }

  /**
   * The entries under a directory, sorted by their workspace-relative path; hidden entries and
   * entries that escape the workspace are left out. `bounded` says the walk hit the scan bound.
   */
  async function walk(base, pattern, { filesOnly }) {
    const found = [];
    let bounded = false;
    let candidates;
    if (pattern) {
      candidates = await globWalk(base, compileGlob(pattern));
    } else {
      candidates = (await readdir(base)).map((entry) => join(base, entry));
    }
    for (const entry of candidates) {
      if (found.length >= SCAN_LIMIT) {
        bounded = true;
        break;
      }
      const shown = relative(root, entry).split(sep).join('/');
      if (!shown || shown.startsWith('..')) continue;
      if (!sandbox.hidden && isHidden(shown)) continue;
      let resolved;
      try {
        resolved = await realpath(entry);
      } catch {
        continue;
      }
      if (!insideRoot(resolved)) continue;
      const info = await statOrUndefined(resolved);
      if (!info || (filesOnly && !info.isFile())) continue;
      found.push({ shown, resolved, info });
    }
    found.sort((a, b) => byCodeUnit(a.shown, b.shown));
    return { found, bounded };
  }

  async function read(_headers, body) {
    const args = argumentsOf(body, FILE_READ_ROW);
    const path = stringArg(args, 'path');
    const maxBytes = integerArg(args, 'max_bytes', { defaultValue: sandbox.maxBytes, floor: 1, cap: sandbox.maxBytes });
    const { resolved, relativePath } = await resolvePath(path);
    const info = await statOrUndefined(resolved);
    if (info?.isDirectory()) {
      throw new AppException(400, `${relativePath} is a directory - file_list lists it`);
    }
    if (!info?.isFile()) {
      throw new AppException(404, `file not found: ${relativePath}`);
    }
    const handle = await open(resolved, 'r');
    let data;
    try {
      const buffer = Buffer.alloc(maxBytes + 1);
      const { bytesRead } = await handle.read(buffer, 0, maxBytes + 1, 0);
      data = buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
    const truncated = data.length > maxBytes;
    data = data.subarray(0, maxBytes);
    const kind = binaryKind(data.subarray(0, 8192));
    if (kind !== undefined) {
      throw new AppException(400, `${relativePath} is not a text file (${kind})`);
    }
    const text = decodeUtf8(data, { truncated });
    if (text === undefined) {
      throw new AppException(400, `${relativePath} is not UTF-8 text`);
    }
    log.info(`file.read 200 ${data.length} bytes${truncated ? ' (cut)' : ''}`);
    return { path: relativePath, bytes: info.size, text, truncated };
  }

  async function write(_headers, body) {
    const args = argumentsOf(body, FILE_WRITE_ROW);
    const path = stringArg(args, 'path');
    const content = stringArg(args, 'content');
    const mode = choiceArg(args, 'mode', WRITE_MODES, { defaultValue: 'create' });
    const { resolved, relativePath } = await resolvePath(path);
    const info = await statOrUndefined(resolved);
    if (relativePath === '.' || info?.isDirectory()) {
      throw new AppException(400, `${relativePath} is a directory - name a file`);
    }
    const allowed = sandbox.writeExtensions;
    if (allowed.length) {
      const suffix = posix.extname(relativePath).toLowerCase();
      if (!allowed.includes(suffix)) {
        throw new AppException(400, `${relativePath} does not end in ${allowed.join(', ')} (${FILE_WRITE_EXTENSIONS})`);
      }
    }
    const data = Buffer.from(content, 'utf8');
    if (data.length > sandbox.maxBytes) {
      throw new AppException(400, `content is ${data.length} bytes, over the workspace's limit of ${sandbox.maxBytes} (${FILE_MAX_BYTES})`);
    }
    if (mode === 'create' && info) {
      throw new AppException(409, `${relativePath} exists - mode overwrite replaces it, append extends it`);
    }
    await mkdir(dirname(resolved), { recursive: true });
    try {
      await writeFile(resolved, data, { flag: { create: 'wx', overwrite: 'w', append: 'a' }[mode] });
    } catch (e) {
      if (e.code === 'EEXIST') {
        throw new AppException(409, `${relativePath} exists - mode overwrite replaces it, append extends it`);
      }
      throw e;
    }
    log.info(`file.write 200 ${data.length} bytes (${mode})`);
    return { path: relativePath, bytes: data.length, mode };
  }

  async function directoryOf(args, row) {
    const path = stringArg(args, 'path', { defaultValue: '.' });
    const { resolved, relativePath } = await resolvePath(path);
    const info = await statOrUndefined(resolved);
    if (!info?.isDirectory()) {
      throw new AppException(info ? 400 : 404, info ? `${relativePath} is not a directory` : `directory not found: ${relativePath}`);
    }
    return { base: resolved, relativePath, row };
  }

  async function list(_headers, body) {
    const args = argumentsOf(body, FILE_LIST_ROW);
    const pattern = args.glob;
    if (pattern !== undefined && pattern !== null && typeof pattern !== 'string') {
      throw new AppException(400, 'glob must be a string');
    }
    const maxEntries = integerArg(args, 'max_entries', { defaultValue: LIST_DEFAULT, floor: 1, cap: LIST_CAP });
    const { base } = await directoryOf(args, FILE_LIST_ROW);
    const { found, bounded } = await walk(base, pattern || undefined, { filesOnly: false });
    const entries = found.slice(0, maxEntries).map(({ shown, info }) => {
      const type = info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other';
      return { path: shown, type, bytes: type === 'file' ? info.size : 0, modified: modifiedOf(info) };
    });
    const truncated = bounded || found.length > maxEntries;
    log.info(`file.list 200 ${entries.length} entries${truncated ? ' (cut)' : ''}`);
    return { entries, truncated };
  }

  async function search(_headers, body) {
    const args = argumentsOf(body, FILE_SEARCH_ROW);
    const pattern = stringArg(args, 'pattern');
    const regex = flagArg(args, 'regex', { defaultValue: false });
    const fileGlob = stringArg(args, 'glob', { defaultValue: '**/*' });
    const caseSensitive = flagArg(args, 'case_sensitive', { defaultValue: false });
    const context = integerArg(args, 'context', { defaultValue: 0, floor: 0, cap: CONTEXT_CAP });
    const maxResults = integerArg(args, 'max_results', { defaultValue: SEARCH_DEFAULT, floor: 1, cap: SEARCH_CAP });
    if (!pattern) {
      throw new AppException(400, 'pattern must not be empty');
    }
    let matcher;
    try {
      matcher = new RegExp(regex ? pattern : pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), caseSensitive ? '' : 'i');
    } catch (e) {
      throw new AppException(400, `pattern is not a valid regular expression (${e.message})`);
    }
    const { base } = await directoryOf(args, FILE_SEARCH_ROW);
    const { found, bounded } = await walk(base, fileGlob, { filesOnly: true });
    const width = sandbox.lineMaxChars;
    const matches = [];
    let searched = 0;
    let truncated = bounded;
    for (const { shown, resolved } of found) {
      if (truncated && matches.length >= maxResults) break;
      let data;
      try {
        data = await readFile(resolved);
      } catch {
        continue;
      }
      if (binaryKind(data.subarray(0, 8192)) !== undefined) continue;
      searched += 1;
      const lines = new TextDecoder('utf-8').decode(data).split(/\r?\n/);
      if (lines.length && lines[lines.length - 1] === '') lines.pop();
      for (let index = 0; index < lines.length; index++) {
        if (!matcher.test(lines[index])) continue;
        if (matches.length >= maxResults) {
          truncated = true;
          break;
        }
        matches.push({
          path: shown,
          line: index + 1,
          text: lines[index].slice(0, width),
          before: lines.slice(Math.max(0, index - context), index).map((t) => t.slice(0, width)),
          after: lines.slice(index + 1, index + 1 + context).map((t) => t.slice(0, width))
        });
      }
      if (truncated && matches.length >= maxResults) break;
    }
    log.info(`file.search 200 ${matches.length} matches in ${searched} files${truncated ? ' (cut)' : ''}`);
    return { matches, files_searched: searched, truncated };
  }

  // -- file.extract: documents to text, behind the documents libraries

  async function extract(_headers, body) {
    const args = argumentsOf(body, FILE_EXTRACT_ROW);
    const path = stringArg(args, 'path');
    const pagesSpec = args.pages;
    if (pagesSpec !== undefined && pagesSpec !== null && typeof pagesSpec !== 'string') {
      throw new AppException(400, 'pages must be a string such as 1-3,7');
    }
    const limit = integerArg(args, 'max_chars', { defaultValue: sandbox.extractMaxChars, floor: 100, cap: sandbox.extractMaxChars });
    const { resolved, relativePath } = await resolvePath(path);
    const info = await statOrUndefined(resolved);
    if (info?.isDirectory()) {
      throw new AppException(400, `${relativePath} is a directory - name a document`);
    }
    if (!info?.isFile()) {
      throw new AppException(404, `file not found: ${relativePath}`);
    }
    const data = await readFile(resolved);
    const kind = documentKind(data, posix.extname(relativePath));
    if (kind === undefined) {
      throw new AppException(400, `${relativePath} is not a PDF, Word, HTML or text document (${binaryKind(data.subarray(0, 8192)) ?? 'unknown format'})`);
    }
    let pages;
    if (kind === 'pdf') {
      pages = await pdfPages(documents, data, relativePath);
    } else if (kind === 'docx') {
      pages = [await docxText(documents, data, relativePath)];
    } else if (kind === 'html') {
      pages = [htmlToText(new TextDecoder('utf-8').decode(data)).text];
    } else {
      const text = decodeUtf8(data, { truncated: false });
      if (text === undefined) {
        throw new AppException(400, `${relativePath} is not UTF-8 text`);
      }
      pages = [text];
    }
    const wanted = pageRange(pagesSpec, pages.length);
    const text = wanted.map((number) => `--- page ${number} ---\n${pages[number - 1].trim()}`).join('\n\n');
    const truncated = text.length > limit;
    log.info(`file.extract 200 ${kind}, ${wanted.length} of ${pages.length} pages, ${Math.min(text.length, limit)} chars${truncated ? ' (cut)' : ''}`);
    return { path: relativePath, type: kind, pages: pages.length, text: text.slice(0, limit), truncated };
  }

  return { sandbox, root, resolvePath, read, write, list, search, extract };
}

// --- documents to text ----------------------------------------------------------------------------

/** The documents libraries, when installed: { pdfjs, mammoth }, else undefined. */
export async function loadDocuments() {
  try {
    const [pdfjs, mammoth] = await Promise.all([import('pdfjs-dist/legacy/build/pdf.mjs'), import('mammoth')]);
    return { pdfjs, mammoth: mammoth.default ?? mammoth };
  } catch {
    return undefined;
  }
}

/** `pdf`, `docx`, `html` or `text` from the first bytes and the suffix; undefined for a format the tool does not read. */
export function documentKind(data, suffix) {
  const head = Buffer.from(data.subarray(0, 8192));
  if (head.subarray(0, 4).toString('latin1') === '%PDF') return 'pdf';
  if (head.subarray(0, 4).toString('latin1') === 'PK\x03\x04') {
    // a Word document is a ZIP whose central directory names word/document.xml
    return Buffer.from(data).includes('word/document.xml') ? 'docx' : undefined;
  }
  if (binaryKind(head) !== undefined) return undefined;
  const text = head.subarray(0, 2048).toString('utf8').trimStart().toLowerCase();
  if (['.html', '.htm', '.xhtml'].includes(suffix.toLowerCase()) || text.startsWith('<!doctype html') || text.startsWith('<html')) {
    return 'html';
  }
  return 'text';
}

/** `1-3,7` to the 1-based page numbers inside the document, in order and without repeats; an empty selection means every page. */
export function pageRange(spec, total) {
  if (total <= 0) return [];
  if (spec === undefined || spec === null || !spec.trim()) {
    return Array.from({ length: total }, (_, i) => i + 1);
  }
  const wanted = [];
  for (const token of spec.split(',')) {
    const part = token.trim();
    if (!part) continue;
    const match = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!match) {
      throw new AppException(400, 'pages must be page numbers and ranges such as 1-3,7');
    }
    const start = Number(match[1]);
    const end = match[2] === undefined ? start : Number(match[2]);
    if (start < 1 || end < start) {
      throw new AppException(400, 'pages must be page numbers and ranges such as 1-3,7, counted from 1');
    }
    for (let number = start; number <= Math.min(end, total); number++) {
      if (!wanted.includes(number)) wanted.push(number);
    }
  }
  return wanted;
}

async function pdfPages(documents, data, relativePath) {
  if (!documents?.pdfjs) {
    throw new AppException(400, `${relativePath} is a PDF - ${DOCUMENTS_EXTRA}`);
  }
  let task;
  let document;
  try {
    task = documents.pdfjs.getDocument({
      data: new Uint8Array(data), useSystemFonts: true, disableFontFace: true, verbosity: 0, isEvalSupported: false
    });
    document = await task.promise;
  } catch (e) {
    if (e?.name === 'PasswordException') {
      throw new AppException(400, `${relativePath} is an encrypted PDF`);
    }
    throw new AppException(400, `${relativePath} could not be read as a PDF (${e?.name ?? 'error'})`);
  }
  try {
    const pages = [];
    for (let number = 1; number <= document.numPages; number++) {
      const page = await document.getPage(number);
      const content = await page.getTextContent();
      pages.push(content.items.map((item) => (item.str ?? '') + (item.hasEOL ? '\n' : '')).join(''));
    }
    return pages;
  } catch (e) {
    throw new AppException(400, `${relativePath} could not be read as a PDF (${e?.name ?? 'error'})`);
  } finally {
    await task.destroy().catch(() => undefined);
  }
}

async function docxText(documents, data, relativePath) {
  if (!documents?.mammoth) {
    throw new AppException(400, `${relativePath} is a Word document - ${DOCUMENTS_EXTRA}`);
  }
  try {
    const converted = await documents.mammoth.convertToHtml({ buffer: Buffer.from(data) });
    return htmlToText(converted.value).text;
  } catch (e) {
    throw new AppException(400, `${relativePath} could not be read as a Word document (${e?.name ?? 'error'})`);
  }
}

// --- HTML to text, in-house ----------------------------------------------------------------------

const DROP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'svg', 'nav', 'header', 'footer']);
// an element marked as page chrome by its ARIA role is dropped like the tags above, and so is one
// hidden from assistive technology - a documentation site's sidebar is a div with role="navigation"
// as often as a nav
const DROP_ROLES = new Set(['navigation', 'banner', 'contentinfo']);
const BLOCK_TAGS = new Set(['p', 'div', 'section', 'article', 'main', 'aside', 'blockquote', 'pre', 'ul', 'ol', 'li', 'table',
  'tr', 'dl', 'dt', 'dd', 'figure', 'figcaption', 'form', 'fieldset', 'hr', 'address', 'details', 'summary']);
const HEADINGS = { h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6 };
const VOID_TAGS = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'area', 'base', 'col', 'embed', 'source', 'track', 'wbr', 'param']);
// elements whose content is raw text until their closing tag
const RAW_TEXT_TAGS = new Set(['script', 'style', 'textarea', 'title']);
const SPACES = /[ \t\r\n\f\v]+/g;
const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', copy: '\u00a9', reg: '\u00ae', trade: '\u2122',
  mdash: '\u2014', ndash: '\u2013', hellip: '\u2026', laquo: '\u00ab', raquo: '\u00bb', lsquo: '\u2018', rsquo: '\u2019',
  ldquo: '\u201c', rdquo: '\u201d', bull: '\u2022', middot: '\u00b7', deg: '\u00b0', times: '\u00d7', euro: '\u20ac',
  pound: '\u00a3', yen: '\u00a5', cent: '\u00a2', sect: '\u00a7', para: '\u00b6', plusmn: '\u00b1', frac12: '\u00bd',
  eacute: '\u00e9', egrave: '\u00e8', ecirc: '\u00ea', agrave: '\u00e0', aacute: '\u00e1', acirc: '\u00e2', auml: '\u00e4',
  ouml: '\u00f6', uuml: '\u00fc', oacute: '\u00f3', iacute: '\u00ed', uacute: '\u00fa', ccedil: '\u00e7', ntilde: '\u00f1',
  szlig: '\u00df', Eacute: '\u00c9', Auml: '\u00c4', Ouml: '\u00d6', Uuml: '\u00dc', larr: '\u2190', rarr: '\u2192'
};

/** HTML character references decoded: the named ones a page commonly carries, and every numeric one. */
export function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[A-Za-z][A-Za-z0-9]*);/g, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (Number.isNaN(code) || code <= 0 || code > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    return ENTITIES[body] ?? whole;
  });
}

const ATTRIBUTE = /([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function parseAttributes(text) {
  const attrs = [];
  for (const match of text.matchAll(ATTRIBUTE)) {
    const value = match[2] ?? match[3] ?? match[4];
    attrs.push([match[1].toLowerCase(), value === undefined ? undefined : decodeEntities(value)]);
  }
  return attrs;
}

function isChrome(attrs) {
  for (const [name, value] of attrs) {
    if (name === 'role' && DROP_ROLES.has(String(value ?? '').trim().toLowerCase())) return true;
    if (name === 'aria-hidden' && String(value ?? '').trim().toLowerCase() === 'true') return true;
  }
  return false;
}

/**
 * A small reader of HTML for a model: script, style, nav, header and footer dropped, the text of
 * the rest kept, with headings, list items, paragraphs, code and links rendered as readable text or
 * as Markdown. Enough for documentation and articles.
 */
class HtmlText {
  constructor(baseUrl = '', { markdown = false } = {}) {
    this.baseUrl = baseUrl;
    this.markdown = markdown;
    this.title = '';
    this.links = [];
    this.blocks = [];
    this.current = [];
    this.drop = 0;
    this.pre = 0;
    this.inTitle = false;
    this.heading = undefined;
    this.listDepth = 0;
    this.itemPrefix = undefined;
    this.href = undefined;
    this.linkText = [];
  }

  flush() {
    const text = this.current.join('');
    this.current = [];
    if (this.pre) {
      const body = text.replace(/^\n+|\n+$/g, '');
      if (body.trim()) {
        this.blocks.push(this.markdown ? '```\n' + body + '\n```' : body);
      }
      return;
    }
    const body = text.replace(SPACES, ' ').trim();
    if (!body) return;
    if (this.heading !== undefined) {
      this.blocks.push(this.markdown ? `${'#'.repeat(this.heading)} ${body}` : body);
    } else if (this.itemPrefix !== undefined) {
      this.blocks.push(`${this.itemPrefix}${body}`);
    } else {
      this.blocks.push(body);
    }
  }

  openBlock() {
    this.endLink();
    this.flush();
  }

  /** Close the open link, if any: its target is collected and, in Markdown, written after its text. */
  endLink() {
    if (this.href === undefined) return;
    this.links.push(this.href.split('#', 1)[0]);
    const label = this.linkText.join('').replace(SPACES, ' ').trim();
    if (this.markdown && label) {
      this.current.push(`](${this.href})`);
    }
    this.href = undefined;
    this.linkText = [];
  }

  startTag(tag, attrs) {
    if (this.drop) {
      if (!VOID_TAGS.has(tag)) this.drop += 1;
      return;
    }
    if (DROP_TAGS.has(tag) || (!VOID_TAGS.has(tag) && isChrome(attrs))) {
      this.openBlock();
      this.drop = 1;
      return;
    }
    if (tag === 'title') {
      this.inTitle = true;
      return;
    }
    if (tag in HEADINGS) {
      this.openBlock();
      this.heading = HEADINGS[tag];
      return;
    }
    if (tag === 'ul' || tag === 'ol') {
      this.openBlock();
      this.listDepth += 1;
      return;
    }
    if (tag === 'li') {
      this.openBlock();
      this.itemPrefix = '  '.repeat(Math.max(0, this.listDepth - 1)) + '- ';
      return;
    }
    if (tag === 'pre') {
      this.openBlock();
      this.pre += 1;
      return;
    }
    if (tag === 'br') {
      this.current.push(this.pre ? '\n' : ' ');
      return;
    }
    if (tag === 'a') {
      const href = attrs.find(([name]) => name === 'href')?.[1];
      if (href && !/^(#|javascript:|mailto:|tel:)/i.test(href)) {
        this.endLink();
        this.href = this.baseUrl ? safeJoin(this.baseUrl, href) : href;
        this.linkText = [];
      }
      return;
    }
    if (tag === 'code' && !this.pre) {
      if (this.markdown) this.current.push('`');
      return;
    }
    if (tag === 'td' || tag === 'th') {
      this.current.push(' ');
      return;
    }
    if (BLOCK_TAGS.has(tag)) this.openBlock();
  }

  endTag(tag) {
    if (this.drop) {
      if (!VOID_TAGS.has(tag)) this.drop -= 1;
      return;
    }
    if (tag === 'title') {
      this.inTitle = false;
      return;
    }
    if (tag in HEADINGS) {
      this.flush();
      this.heading = undefined;
      return;
    }
    if (tag === 'ul' || tag === 'ol') {
      this.flush();
      this.listDepth = Math.max(0, this.listDepth - 1);
      this.itemPrefix = undefined;
      return;
    }
    if (tag === 'li') {
      this.flush();
      this.itemPrefix = undefined;
      return;
    }
    if (tag === 'pre') {
      this.flush();
      this.pre = Math.max(0, this.pre - 1);
      return;
    }
    if (tag === 'a') {
      this.endLink();
      return;
    }
    if (tag === 'code' && !this.pre) {
      if (this.markdown) this.current.push('`');
      return;
    }
    if (BLOCK_TAGS.has(tag)) {
      this.endLink();
      this.flush();
    }
  }

  text(data) {
    if (this.drop) return;
    if (this.inTitle) {
      this.title += data;
      return;
    }
    if (this.href !== undefined) {
      if (this.markdown && !this.linkText.length && data.trim()) this.current.push('[');
      this.linkText.push(data);
    }
    this.current.push(data);
  }

  close() {
    this.endLink();
    this.flush();
  }

  get rendered() {
    return this.blocks.join('\n\n');
  }
}

function safeJoin(base, href) {
  try {
    return new URL(href, base).href;
  } catch {
    return href;
  }
}

/** Feed an HTML document to a reader: comments and doctype skipped, raw-text elements kept whole, tags with their attributes. */
export function tokenizeHtml(html, reader) {
  let i = 0;
  const n = html.length;
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt < 0) {
      reader.text(decodeEntities(html.slice(i)));
      break;
    }
    if (lt > i) reader.text(decodeEntities(html.slice(i, lt)));
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (html.startsWith('<!', lt) || html.startsWith('<?', lt)) {
      const end = html.indexOf('>', lt);
      i = end < 0 ? n : end + 1;
      continue;
    }
    const match = /^<(\/?)([A-Za-z][A-Za-z0-9:-]*)([^>]*?)(\/?)>/.exec(html.slice(lt, lt + 4096));
    if (!match) {
      reader.text('<');
      i = lt + 1;
      continue;
    }
    const [whole, closing, rawName, attrText, selfClosing] = match;
    const tag = rawName.toLowerCase();
    i = lt + whole.length;
    if (closing) {
      reader.endTag(tag);
      continue;
    }
    const attrs = parseAttributes(attrText);
    reader.startTag(tag, attrs);
    if (selfClosing && !VOID_TAGS.has(tag)) {
      reader.endTag(tag);
      continue;
    }
    if (RAW_TEXT_TAGS.has(tag) && !selfClosing) {
      const close = new RegExp(`</${tag}\\s*>`, 'i');
      const rest = html.slice(i);
      const found = close.exec(rest);
      const raw = found ? rest.slice(0, found.index) : rest;
      reader.text(tag === 'title' || tag === 'textarea' ? decodeEntities(raw) : raw);
      i = found ? i + found.index + found[0].length : n;
      reader.endTag(tag);
    }
  }
  reader.close();
}

/**
 * A page's title, its readable text (Markdown when asked) and the absolute links it carries, in
 * document order and without fragments.
 */
export function htmlToText(html, baseUrl = '', { markdown = false } = {}) {
  const reader = new HtmlText(baseUrl, { markdown });
  tokenizeHtml(html, reader);
  const links = [];
  for (const link of reader.links) {
    if (!links.includes(link)) links.push(link);
  }
  return { title: reader.title.replace(SPACES, ' ').trim(), text: reader.rendered, links };
}

// --- the web, inside an allowlist -------------------------------------------------------------

/**
 * docs.example.com, *.example.com, http://127.0.0.1, docs.example.com:8443: a host pattern with an
 * optional scheme and port; a path, a query or credentials are refused.
 */
export function parseHostRules(entries) {
  const rules = [];
  for (const entry of entries) {
    let text = entry.trim();
    let scheme = 'https';
    if (text.includes('://')) {
      [scheme, text] = [text.slice(0, text.indexOf('://')).toLowerCase(), text.slice(text.indexOf('://') + 3)];
      if (scheme !== 'http' && scheme !== 'https') {
        throw new ToolsError(`${WEB_ALLOW}: ${entry} - the scheme must be http or https`);
      }
    }
    if (text.includes('/') || text.includes('?') || text.includes('@') || !text) {
      throw new ToolsError(`${WEB_ALLOW}: ${entry} is not a host pattern (a host, a *.pattern, optionally with http:// or a :port)`);
    }
    let port;
    let host = text;
    if (text.startsWith('[')) {
      const close = text.indexOf(']');
      host = text.slice(1, close < 0 ? undefined : close);
      const rest = close < 0 ? '' : text.slice(close + 1);
      if (rest.startsWith(':')) port = portOf(entry, rest.slice(1));
    } else if ((text.match(/:/g) ?? []).length === 1) {
      [host, port] = [text.slice(0, text.indexOf(':')), portOf(entry, text.slice(text.indexOf(':') + 1))];
    }
    rules.push({ pattern: host.toLowerCase().replace(/\.+$/, ''), scheme, port });
  }
  return rules;
}

function portOf(entry, text) {
  const port = /^\d+$/.test(text) ? Number(text) : NaN;
  if (Number.isNaN(port)) {
    throw new ToolsError(`${WEB_ALLOW}: ${entry} - the port must be a number`);
  }
  if (port < 1 || port > 65535) {
    throw new ToolsError(`${WEB_ALLOW}: ${entry} - the port must be between 1 and 65535`);
  }
  return port;
}

/** A host rule as a log or a health report shows it. */
export function ruleText(rule) {
  const port = rule.port !== undefined ? `:${rule.port}` : '';
  return rule.scheme === 'http' || port ? `${rule.scheme}://${rule.pattern}${port}` : rule.pattern;
}

/** fnmatch's `*`, `?` and `[seq]` over a host name, case-sensitively on the lower-cased host. */
function hostMatches(host, pattern) {
  const source = pattern.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${source}$`).test(host);
}

/** Why an address is refused by default - loopback, private, link-local, multicast, reserved or unspecified - or undefined for a public address. */
export function addressKind(address) {
  let text = address.split('%', 1)[0].toLowerCase();
  if (isIP(text) === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(text);
    if (mapped) text = mapped[1];
  }
  if (isIP(text) === 4) {
    const [a, b] = text.split('.').map(Number);
    if (a === 127) return 'loopback';
    if (a === 169 && b === 254) return 'link-local';
    if (a >= 224 && a <= 239) return 'multicast';
    if (a === 0) return 'unspecified';
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return 'private';
    if (a === 100 && b >= 64 && b <= 127) return 'private';
    if (a >= 240) return 'reserved';
    return undefined;
  }
  if (isIP(text) === 6) {
    const groups = expandIpv6(text);
    if (groups === undefined) return 'reserved';
    const first = groups[0];
    if (groups.every((g) => g === 0)) return 'unspecified';
    if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return 'loopback';
    if ((first & 0xffc0) === 0xfe80) return 'link-local';
    if ((first & 0xff00) === 0xff00) return 'multicast';
    if ((first & 0xfe00) === 0xfc00) return 'private';
    if (first === 0x2001 && groups[1] === 0x0db8) return 'reserved';
    return undefined;
  }
  return 'reserved';
}

function expandIpv6(text) {
  const halves = text.split('::');
  if (halves.length > 2) return undefined;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return undefined;
  const groups = [...head, ...Array(missing).fill('0'), ...tail].map((g) => parseInt(g || '0', 16));
  return groups.some((g) => Number.isNaN(g)) ? undefined : groups;
}

/** The allowlist and the limits of the web tools. */
export class WebSandbox {
  constructor({ rules, allowPrivate = false, maxBytes = DEFAULT_WEB_MAX_BYTES, timeoutMs = DEFAULT_WEB_TIMEOUT_MS,
    crawlMaxPages = CRAWL_PAGES_CAP, crawlDelayMs = DEFAULT_CRAWL_DELAY_MS, pageMaxChars = DEFAULT_PAGE_MAX_CHARS,
    lookup = dnsLookup }) {
    this.rules = rules;
    this.allowPrivate = allowPrivate;
    this.maxBytes = maxBytes;
    this.timeoutMs = timeoutMs;
    this.crawlMaxPages = crawlMaxPages;
    this.crawlDelayMs = crawlDelayMs;
    this.pageMaxChars = pageMaxChars;
    this.lookup = lookup;
  }

  /** Whether a host is listed at all, and whether it is allowed over this scheme and port. */
  matches(host, scheme, port) {
    let listed = false;
    for (const rule of this.rules) {
      if (!hostMatches(host, rule.pattern)) continue;
      listed = true;
      if ((scheme === 'https' || rule.scheme === 'http') && (rule.port === undefined || rule.port === port)) {
        return { listed: true, allowed: true };
      }
    }
    return { listed, allowed: false };
  }

  /**
   * The URL a tool may fetch, by the allowlist alone (no network): an http(s) URL without
   * credentials, whose host is listed for its scheme and port. Anything else is a 400 that names
   * the rule; the fragment is dropped.
   */
  checkUrl(url) {
    let parsed;
    try {
      parsed = new URL(url.trim());
    } catch {
      throw new AppException(400, 'url must start with https:// (or http:// for a host listed with it)');
    }
    const scheme = parsed.protocol.replace(/:$/, '').toLowerCase();
    if (scheme !== 'http' && scheme !== 'https') {
      throw new AppException(400, 'url must start with https:// (or http:// for a host listed with it)');
    }
    if (parsed.username || parsed.password) {
      throw new AppException(400, 'url must not carry credentials');
    }
    const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.+$/, '');
    if (!host) {
      throw new AppException(400, 'url has no host');
    }
    const port = parsed.port ? Number(parsed.port) : scheme === 'https' ? 443 : 80;
    const { listed, allowed } = this.matches(host, scheme, port);
    if (!allowed) {
      if (listed && scheme === 'http') {
        throw new AppException(400, `${host} is allowed over https only - list it as http://${host} to allow http`);
      }
      if (listed) {
        throw new AppException(400, `${host} is not allowed on port ${port} (${WEB_ALLOW})`);
      }
      throw new AppException(400, `${host} is not one of the sites this agent may reach (${WEB_ALLOW})`);
    }
    parsed.hash = '';
    parsed.username = '';
    parsed.password = '';
    return { url: parsed.href, scheme, host, port, hostname: parsed.hostname, pathname: parsed.pathname, search: parsed.search };
  }

  /**
   * The address a host resolves to, checked against the private ranges, so the request is made to
   * the address that was checked and a second resolution cannot point elsewhere.
   */
  async pin(host) {
    let addresses;
    if (isIP(host)) {
      addresses = [{ address: host, family: isIP(host) }];
    } else {
      try {
        addresses = await this.lookup(host, { all: true });
      } catch {
        throw new AppException(502, `${host} cannot be resolved`);
      }
      if (!addresses?.length) {
        throw new AppException(502, `${host} cannot be resolved`);
      }
    }
    if (!this.allowPrivate) {
      for (const { address } of addresses) {
        const kind = addressKind(address);
        if (kind !== undefined) {
          throw new AppException(400, `${host} resolves to a ${kind} address, which is refused (${WEB_ALLOW_PRIVATE})`);
        }
      }
    }
    const preferred = addresses.find((a) => a.family === 4) ?? addresses[0];
    return { address: preferred.address, family: preferred.family };
  }
}

/** The web tools' sandbox from the configuration - undefined when tools.web.allow is empty, so the web tools do not register. */
export function loadWebSandbox({ log = defaultLog } = {}) {
  const entries = listSetting(WEB_ALLOW);
  if (!entries.length) return undefined;
  return new WebSandbox({
    rules: parseHostRules(entries),
    allowPrivate: boolSetting(WEB_ALLOW_PRIVATE, false),
    maxBytes: intSetting(WEB_MAX_BYTES, DEFAULT_WEB_MAX_BYTES, { floor: 1024, log }),
    timeoutMs: intSetting(WEB_TIMEOUT_MS, DEFAULT_WEB_TIMEOUT_MS, { floor: MIN_WEB_TIMEOUT_MS, log }),
    crawlMaxPages: intSetting(WEB_CRAWL_MAX_PAGES, CRAWL_PAGES_CAP, { cap: CRAWL_PAGES_CAP, log }),
    crawlDelayMs: intSetting(WEB_CRAWL_DELAY_MS, DEFAULT_CRAWL_DELAY_MS, { floor: 0, log }),
    pageMaxChars: intSetting(WEB_PAGE_MAX_CHARS, DEFAULT_PAGE_MAX_CHARS, { floor: 100, log })
  });
}

const TEXT_TYPES = new Set(['application/json', 'application/xml', 'application/javascript', 'application/x-yaml', 'application/yaml']);

function isHtmlType(type) {
  return type === 'text/html' || type === 'application/xhtml+xml';
}

function isTextType(type) {
  return type.startsWith('text/') || TEXT_TYPES.has(type) || type.endsWith('+json') || type.endsWith('+xml');
}

const META_CHARSET = /<meta[^>]+charset=["']?\s*([A-Za-z0-9_.:-]+)/i;

/** The body as text: the charset of the content type, else the one a meta tag names, else UTF-8; undecodable bytes are replaced, never an error. */
export function decodeBody(fetched) {
  let charset = fetched.charset;
  if (!charset && isHtmlType(fetched.contentType)) {
    const match = META_CHARSET.exec(fetched.data.subarray(0, 4096).toString('latin1'));
    if (match) charset = match[1];
  }
  for (const name of [charset, 'utf-8']) {
    if (!name) continue;
    try {
      return new TextDecoder(name).decode(fetched.data);
    } catch {
      // an unknown charset: fall back
    }
  }
  return new TextDecoder('utf-8').decode(fetched.data);
}

function hostHeader(target) {
  const defaultPort = target.scheme === 'https' ? 443 : 80;
  const host = target.hostname.includes(':') && !target.hostname.startsWith('[') ? `[${target.hostname}]` : target.hostname;
  return target.port === defaultPort ? host : `${host}:${target.port}`;
}

/** One HTTP request to a checked address, the body read up to a byte limit; resolves { status, headers, data, truncated }. */
function requestOnce(target, pinned, { timeoutMs, maxBytes }) {
  return new Promise((resolvePromise, reject) => {
    const client = target.scheme === 'https' ? https : http;
    const lookup = (hostname, options, callback) => {
      const entry = { address: pinned.address, family: pinned.family };
      if (typeof options === 'function') return options(null, entry.address, entry.family);
      return options?.all ? callback(null, [entry]) : callback(null, entry.address, entry.family);
    };
    const request = client.request({
      protocol: `${target.scheme}:`,
      hostname: target.hostname.replace(/^\[|\]$/g, ''),
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: 'GET',
      lookup,
      servername: target.scheme === 'https' && !isIP(target.host) ? target.host : undefined,
      headers: {
        Host: hostHeader(target),
        'User-Agent': USER_AGENT,
        Accept: 'text/html, application/xhtml+xml, text/*;q=0.9, application/json;q=0.8, */*;q=0.1',
        'Accept-Encoding': 'identity'
      },
      timeout: timeoutMs
    }, (response) => {
      const chunks = [];
      let size = 0;
      let truncated = false;
      response.on('data', (chunk) => {
        const room = maxBytes - size;
        if (chunk.length >= room) {
          chunks.push(chunk.subarray(0, room));
          size += room;
          truncated = chunk.length > room || !response.complete;
          response.destroy();
          finish();
          return;
        }
        chunks.push(chunk);
        size += chunk.length;
      });
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(deadline);
        resolvePromise({ status: response.statusCode ?? 0, headers: response.headers, data: Buffer.concat(chunks), truncated });
      };
      response.on('end', finish);
      response.on('close', finish);
      response.on('error', (e) => {
        if (!finished) {
          finished = true;
          clearTimeout(deadline);
          reject(e);
        }
      });
    });
    const deadline = setTimeout(() => request.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })), timeoutMs);
    request.on('timeout', () => request.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    request.on('error', (e) => {
      clearTimeout(deadline);
      reject(e);
    });
    request.end();
  });
}

/** A minimal robots.txt: the rules of the group for our token, else the `*` group; the longest matching rule wins, Allow over Disallow on a tie. */
export function parseRobots(text) {
  const groups = [];
  let current;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (field === 'user-agent') {
      if (!current || current.rules.length) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
    } else if ((field === 'allow' || field === 'disallow') && current) {
      current.rules.push({ allow: field === 'allow', path: value });
    }
  }
  const token = ROBOTS_AGENT.toLowerCase();
  const group = groups.find((g) => g.agents.some((a) => a !== '*' && token.includes(a))) ?? groups.find((g) => g.agents.includes('*'));
  return {
    canFetch(path) {
      if (!group) return true;
      let best;
      for (const rule of group.rules) {
        if (!rule.path) continue;
        const pattern = '^' + rule.path.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*').replace(/\\\$$/, '$');
        if (!new RegExp(pattern).test(path)) continue;
        if (!best || rule.path.length > best.path.length || (rule.path.length === best.path.length && rule.allow && !best.allow)) {
          best = rule;
        }
      }
      return best ? best.allow : true;
    }
  };
}

/** Whether a link's path is inside the crawl's include: a prefix when the include starts with a slash, else anywhere in the path - a model names a section as `guides/` as often as `/guides/`. */
function under(path, include) {
  return include.startsWith('/') ? path.startsWith(include) : path.includes(include);
}

/** The two web tools over one allowlist. */
export function createWebTools(sandbox, { log = defaultLog } = {}) {
  /**
   * One URL through the allowlist and the address check, every redirect checked again, the body
   * read up to the byte limit; a timeout is a 408, a transport failure a 502.
   */
  async function fetch(url) {
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const target = sandbox.checkUrl(current);
      const pinned = await sandbox.pin(target.host);
      let response;
      try {
        response = await requestOnce(target, pinned, { timeoutMs: sandbox.timeoutMs, maxBytes: sandbox.maxBytes });
      } catch (e) {
        if (e?.code === 'ETIMEDOUT' || e?.name === 'AbortError') {
          throw new AppException(408, `${target.host} did not answer within ${sandbox.timeoutMs} ms`);
        }
        throw new AppException(502, `${target.host} could not be fetched (${e?.code ?? e?.name ?? 'error'})`);
      }
      const location = response.headers.location;
      if (REDIRECT_STATUSES.includes(response.status) && location) {
        current = new URL(location, target.url).href;
        continue;
      }
      const [type, ...params] = String(response.headers['content-type'] ?? '').split(';');
      const charsetParam = params.map((p) => p.trim()).find((p) => p.toLowerCase().startsWith('charset='));
      return {
        url: target.url, status: response.status, contentType: type.trim().toLowerCase(),
        charset: charsetParam ? charsetParam.slice(8).replace(/^"|"$/g, '') : undefined, data: response.data,
        truncated: response.truncated
      };
    }
    throw new AppException(400, `too many redirects (more than ${MAX_REDIRECTS})`);
  }

  async function webFetch(_headers, body) {
    const args = argumentsOf(body, WEB_FETCH_ROW);
    const url = stringArg(args, 'url');
    const mode = choiceArg(args, 'as', FETCH_MODES, { defaultValue: 'text' });
    const fetched = await fetch(url);
    const host = new URL(fetched.url).hostname;
    if (!isHtmlType(fetched.contentType) && !isTextType(fetched.contentType)) {
      log.info(`web.fetch ${host} ${fetched.status} ${fetched.data.length} bytes - not text`);
      throw new AppException(400, `the response is ${fetched.contentType || 'of an unknown type'}, not text`);
    }
    const page = decodeBody(fetched);
    let title = '';
    let text = page;
    if (isHtmlType(fetched.contentType) && mode !== 'raw') {
      ({ title, text } = htmlToText(page, fetched.url, { markdown: mode === 'markdown' }));
    }
    const limit = sandbox.pageMaxChars;
    const cut = text.length > limit;
    log.info(`web.fetch ${host} ${fetched.status} ${fetched.data.length} bytes${fetched.truncated || cut ? ' (cut)' : ''}`);
    return {
      url: fetched.url, status: fetched.status, content_type: fetched.contentType, title, text: text.slice(0, limit),
      bytes: fetched.data.length, truncated: fetched.truncated || cut
    };
  }

  /** The site's robots.txt, read through the same checks; a site without one allows all. */
  async function robots(start) {
    const robotsUrl = `${start.scheme}://${hostHeader(start)}/robots.txt`;
    let fetched;
    try {
      fetched = await fetch(robotsUrl);
    } catch (e) {
      log.info(`web.crawl robots.txt of ${start.host} not read (${e?.status ?? 'error'})`);
      return undefined;
    }
    if (fetched.status !== 200 || !(isTextType(fetched.contentType) || isHtmlType(fetched.contentType))) return undefined;
    return parseRobots(decodeBody(fetched));
  }

  async function webCrawl(_headers, body) {
    const args = argumentsOf(body, WEB_CRAWL_ROW);
    const url = stringArg(args, 'url');
    const maxPages = integerArg(args, 'max_pages', { defaultValue: CRAWL_PAGES_DEFAULT, floor: 1, cap: sandbox.crawlMaxPages });
    const maxDepth = integerArg(args, 'max_depth', { defaultValue: CRAWL_DEPTH_DEFAULT, floor: 0, cap: CRAWL_DEPTH_CAP });
    let include = args.include;
    if (include !== undefined && include !== null && typeof include !== 'string') {
      throw new AppException(400, 'include must be a string');
    }
    const start = sandbox.checkUrl(url);
    const site = `${start.scheme}://${start.host}:${start.port}`;
    const rules = await robots(start);
    const queue = [[start.url, 0]];
    const seen = new Set([start.url]);
    const pages = [];
    let visited = 0;
    let truncated = false;
    let budget = CRAWL_RESULT_MAX_CHARS;
    while (queue.length && pages.length < maxPages) {
      const [current, depth] = queue.shift();
      if (rules && !rules.canFetch(new URL(current).pathname)) continue;
      if (visited && sandbox.crawlDelayMs) await new Promise((r) => setTimeout(r, sandbox.crawlDelayMs));
      let fetched;
      try {
        fetched = await fetch(current);
      } catch (e) {
        log.info(`web.crawl ${start.host} skipped a page (${e?.status ?? 'error'})`);
        continue;
      }
      visited += 1;
      if (fetched.status !== 200 || !(isHtmlType(fetched.contentType) || isTextType(fetched.contentType))) continue;
      const page = decodeBody(fetched);
      let title = '';
      let text = page;
      let links = [];
      if (isHtmlType(fetched.contentType)) ({ title, text, links } = htmlToText(page, fetched.url));
      if (text.length > sandbox.pageMaxChars) {
        text = text.slice(0, sandbox.pageMaxChars);
        truncated = true;
      }
      if (text.length > budget) {
        text = text.slice(0, budget);
        truncated = true;
      }
      budget -= text.length;
      pages.push({ url: fetched.url, title, text, bytes: fetched.data.length });
      if (budget <= 0) {
        truncated = true;
        break;
      }
      if (depth >= maxDepth) continue;
      for (const link of links) {
        let candidate;
        try {
          candidate = new URL(link);
        } catch {
          continue;
        }
        const scheme = candidate.protocol.replace(/:$/, '').toLowerCase();
        const port = candidate.port ? Number(candidate.port) : scheme === 'https' ? 443 : 80;
        if (`${scheme}://${candidate.hostname.toLowerCase()}:${port}` !== site) continue;
        if (include && !under(candidate.pathname, include)) continue;
        candidate.hash = '';
        const normalized = candidate.href;
        if (!seen.has(normalized)) {
          seen.add(normalized);
          queue.push([normalized, depth + 1]);
        }
      }
    }
    if (queue.length && pages.length >= maxPages) truncated = true;
    log.info(`web.crawl ${start.host} 200 ${pages.length} pages, ${visited} fetched${truncated ? ' (cut)' : ''}`);
    return { pages, visited, truncated };
  }

  return { sandbox, fetch, webFetch, webCrawl, close: async () => undefined };
}

// --- the knowledge graph, inside one database -------------------------------------------------------

/** The Bolt driver module, when installed, else undefined. */
export async function loadDriver() {
  try {
    const module = await import('neo4j-driver');
    return module.default ?? module;
  } catch {
    return undefined;
  }
}

/** The URI without its credential - what a log or a health report may show. */
export function graphAddress(uri) {
  try {
    const parsed = new URL(uri);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return String(uri).replace(/\/\/[^@/]*@/, '//');
  }
}

/**
 * The graph tools' sandbox from the configuration - undefined when tools.graph.uri is not set, so
 * the graph tools do not register; a URI without the driver stops the boot by name.
 */
export async function loadGraphSandbox({ log = defaultLog, driver = undefined } = {}) {
  const uri = setting(GRAPH_URI);
  if (uri === undefined) return undefined;
  const neo4j = driver ?? (await loadDriver());
  if (!neo4j) {
    throw new ToolsError(`${GRAPH_URI} is set but the Bolt driver is not installed - ${GRAPH_EXTRA}`);
  }
  const scheme = String(uri).split(':', 1)[0].toLowerCase();
  if (!scheme.startsWith('bolt') && !scheme.startsWith('neo4j')) {
    throw new ToolsError(`${GRAPH_URI} must be a Bolt URI (bolt://, bolt+s://, neo4j://, neo4j+s://), not ${uri}`);
  }
  const username = setting(GRAPH_USERNAME);
  const password = setting(GRAPH_PASSWORD);
  const database = setting(GRAPH_DATABASE);
  return {
    uri: String(uri),
    address: graphAddress(String(uri)),
    database: database === undefined ? undefined : String(database),
    username: username === undefined ? undefined : String(username),
    password: password === undefined ? undefined : String(password),
    write: boolSetting(GRAPH_WRITE, false),
    delete: boolSetting(GRAPH_DELETE, false),
    maxRows: intSetting(GRAPH_MAX_ROWS, ROWS_DEFAULT, { cap: ROWS_CAP, log }),
    timeoutMs: intSetting(GRAPH_TIMEOUT_MS, DEFAULT_GRAPH_TIMEOUT_MS, { floor: MIN_WEB_TIMEOUT_MS, log }),
    ingestMaxNodes: intSetting(GRAPH_INGEST_MAX_NODES, DEFAULT_INGEST_MAX_NODES, { log }),
    neo4j
  };
}

/**
 * The real backend: the official driver, one connection pool for the process, every statement
 * inside a managed transaction with the configured timeout set server-side. A transaction's run
 * returns { columns, values, truncated, counters }.
 */
export function createBolt(sandbox) {
  const neo4j = sandbox.neo4j;
  const auth = sandbox.username ? neo4j.auth.basic(sandbox.username, sandbox.password ?? '') : undefined;
  const driver = neo4j.driver(sandbox.uri, auth, { connectionTimeout: sandbox.timeoutMs, disableLosslessIntegers: true });

  function wrap(tx) {
    return {
      async run(query, parameters = {}, { limit = undefined } = {}) {
        const result = tx.run(query, parameters);
        const columns = await result.keys();
        const { records, summary } = await result;
        const kept = limit === undefined ? records : records.slice(0, limit);
        const updates = summary.counters.updates();
        const counters = Object.fromEntries(COUNTER_NAMES.map((name) => [name, Number(updates[DRIVER_COUNTERS[name]] ?? 0)]));
        return { columns, values: kept.map((record) => columns.map((key) => record.get(key))), truncated: records.length > kept.length, counters };
      }
    };
  }

  return {
    sandbox,
    verify: () => driver.verifyConnectivity(),
    close: () => driver.close(),
    async execute(work, { write }) {
      const options = { defaultAccessMode: write ? neo4j.session.WRITE : neo4j.session.READ };
      if (sandbox.database) options.database = sandbox.database;
      const session = driver.session(options);
      try {
        const run = (tx) => work(wrap(tx));
        return write ? await session.executeWrite(run, { timeout: sandbox.timeoutMs }) : await session.executeRead(run, { timeout: sandbox.timeoutMs });
      } finally {
        await session.close();
      }
    }
  };
}

/**
 * The driver's failure as the tool's status: a client error (syntax, type, constraint, a write in a
 * read transaction) is a 400 carrying the database's code and message for the model; a transaction
 * that timed out a 408; an unreachable database or a refused credential a 503; the rest a 502 by type.
 */
export function graphError(error, { timeoutMs }) {
  if (error instanceof AppException) return error;
  const code = String(error?.code ?? '');
  const name = String(error?.name ?? 'Error');
  if (error?.name === 'AbortError' || code === 'ETIMEDOUT') {
    return new AppException(408, `the graph database did not answer within ${timeoutMs} ms`);
  }
  if (name === 'Neo4jError' || code.startsWith('Neo.')) {
    const message = String(error?.message ?? error);
    if (code.includes('TimedOut') || code.includes('Timeout')) {
      return new AppException(408, `the graph database did not answer within ${timeoutMs} ms (${code})`);
    }
    if (code.startsWith('Neo.ClientError.Security.')) {
      return new AppException(503, "the graph database refused this process's credential");
    }
    if (code.startsWith('Neo.TransientError.') || code === 'ServiceUnavailable' || code === 'SessionExpired'
      || code.startsWith('Neo.ClientError.Cluster.') || code.startsWith('Neo.ClientError.Database.DatabaseUnavailable')) {
      return new AppException(503, `the graph database is not available (${code})`);
    }
    if (code.startsWith('Neo.ClientError.')) {
      return new AppException(400, `${code}: ${message}`);
    }
    return new AppException(502, `the graph database failed (${code || name})`);
  }
  return new AppException(502, `the graph database failed (${name})`);
}

const TEMPORAL_TYPES = new Set(['Date', 'DateTime', 'LocalDateTime', 'Time', 'LocalTime', 'Duration']);

/**
 * A driver value as JSON for the model: a node {id, labels, properties}, a relationship
 * {id, type, start, end, properties}, a path as the list of its nodes and relationships in order,
 * temporal and spatial values as text and {srid, coordinates}, bytes as base64, integers as numbers.
 */
export function renderValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString();
  if (typeof value !== 'object') return value;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return Buffer.from(value).toString('base64');
  if (Array.isArray(value)) return value.map(renderValue);
  if (typeof value.toNumber === 'function' && 'low' in value && 'high' in value) {
    return typeof value.inSafeRange === 'function' && !value.inSafeRange() ? value.toString() : value.toNumber();
  }
  if (Array.isArray(value.segments) && 'start' in value && 'end' in value) {
    const rendered = [];
    value.segments.forEach((segment, index) => {
      if (index === 0) rendered.push(renderValue(segment.start));
      rendered.push(renderValue(segment.relationship));
      rendered.push(renderValue(segment.end));
    });
    return rendered.length ? rendered : [renderValue(value.start)];
  }
  if ('type' in value && 'startNodeElementId' in value && 'elementId' in value) {
    return {
      id: String(value.elementId), type: String(value.type), start: String(value.startNodeElementId), end: String(value.endNodeElementId),
      properties: renderProperties(value.properties)
    };
  }
  if (Array.isArray(value.labels) && 'elementId' in value) {
    return { id: String(value.elementId), labels: [...value.labels].map(String).sort(byCodeUnit), properties: renderProperties(value.properties) };
  }
  if ('srid' in value && 'x' in value && 'y' in value) {
    const coordinates = [Number(value.x), Number(value.y)];
    if (value.z !== undefined && value.z !== null) coordinates.push(Number(value.z));
    return { srid: renderValue(value.srid), coordinates };
  }
  if (TEMPORAL_TYPES.has(value.constructor?.name)) return value.toString();
  if (value instanceof Date) return value.toISOString();
  return renderProperties(value);
}

function renderProperties(properties) {
  return Object.fromEntries(Object.entries(properties ?? {}).map(([key, item]) => [String(key), renderValue(item)]));
}

/** The query with its string literals, quoted identifiers and comments blanked, so a clause scan never fires on a word inside a string. */
export function stripCypherLiterals(query) {
  return query.replace(CYPHER_LITERALS, ' ');
}

/** The first write clause a query carries, upper-cased, or undefined for a read. */
export function writeClause(query) {
  const match = WRITE_CLAUSES.exec(stripCypherLiterals(query));
  return match ? match[1].toUpperCase().replace(/\s+/g, ' ') : undefined;
}

export function deleteClause(query) {
  const match = DELETE_CLAUSES.exec(stripCypherLiterals(query));
  return match ? match[1].toUpperCase() : undefined;
}

function isScalar(value) {
  return value === null || value === undefined || ['boolean', 'number', 'string'].includes(typeof value);
}

/** The properties of a node or a relationship to ingest: names that are identifiers, values that are scalars or lists of scalars; key and source are the tool's. */
function propertiesOf(value, where) {
  if (value === undefined || value === null) return {};
  if (!isMap(value)) {
    throw new AppException(400, `${where}.properties must be a map`);
  }
  const checked = {};
  for (const [name, item] of Object.entries(value)) {
    if (!PROPERTY_NAME.test(name)) {
      throw new AppException(400, `${where}.properties has a name that is not an identifier: ${JSON.stringify(name)}`);
    }
    if (name === 'key' || name === 'source') {
      throw new AppException(400, `${where}.properties must not set ${name} - the tool writes it`);
    }
    if (Array.isArray(item)) {
      if (!item.every((element) => isScalar(element) && element !== null && element !== undefined)) {
        throw new AppException(400, `${where}.properties.${name} must be a list of scalars`);
      }
    } else if (!isScalar(item)) {
      throw new AppException(400, `${where}.properties.${name} must be a scalar or a list of scalars`);
    }
    if (item !== null && item !== undefined) checked[name] = item;
  }
  return checked;
}

function keyOf(value, where) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AppException(400, `${where} must be a non-empty string`);
  }
  if (value.length > KEY_MAX_CHARS) {
    throw new AppException(400, `${where} is longer than ${KEY_MAX_CHARS} characters`);
  }
  return value;
}

function identifierOf(value, where) {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) {
    throw new AppException(400, `${where} must be an identifier - letters, digits and underscore, starting with a letter`);
  }
  return value;
}

/**
 * Validate an ingest and group it: labels and types must be identifiers, keys non-empty strings,
 * properties scalars or lists of scalars, the counts inside the caps. Returns { nodes (by label),
 * relationships (by type), source, nodeCount, relationshipCount, endpointKeys }.
 */
export function planIngest(args, { maxNodes }) {
  const nodes = args.nodes ?? [];
  const relationships = args.relationships ?? [];
  const source = args.source ?? undefined;
  if (!Array.isArray(nodes) || !Array.isArray(relationships)) {
    throw new AppException(400, 'nodes and relationships must be arrays');
  }
  if (source !== undefined && source !== null && typeof source !== 'string') {
    throw new AppException(400, 'source must be a string');
  }
  if (!nodes.length && !relationships.length) {
    throw new AppException(400, 'nothing to ingest - give nodes, relationships or both');
  }
  if (nodes.length > maxNodes) {
    throw new AppException(400, `${nodes.length} nodes is over the limit of ${maxNodes} per call (${GRAPH_INGEST_MAX_NODES}) - ingest in batches`);
  }
  if (relationships.length > maxNodes * INGEST_RELATIONSHIPS_PER_NODE) {
    throw new AppException(400, `${relationships.length} relationships is over the limit of ${maxNodes * INGEST_RELATIONSHIPS_PER_NODE} per call - ingest in batches`);
  }
  const byLabel = new Map();
  const seen = new Set();
  nodes.forEach((node, index) => {
    const where = `nodes[${index}]`;
    if (!isMap(node)) {
      throw new AppException(400, `${where} must be a map`);
    }
    const unknown = Object.keys(node).filter((k) => !['key', 'label', 'properties'].includes(k)).sort(byCodeUnit);
    if (unknown.length) {
      throw new AppException(400, `${where} does not take ${unknown.join(', ')} - a node has key, label and properties`);
    }
    const key = keyOf(node.key, `${where}.key`);
    const label = identifierOf(node.label, `${where}.label`);
    if (seen.has(key)) {
      throw new AppException(400, `${where}.key ${JSON.stringify(key)} appears twice in this call`);
    }
    seen.add(key);
    if (!byLabel.has(label)) byLabel.set(label, []);
    byLabel.get(label).push({ key, properties: propertiesOf(node.properties, where) });
  });
  const byType = new Map();
  relationships.forEach((relationship, index) => {
    const where = `relationships[${index}]`;
    if (!isMap(relationship)) {
      throw new AppException(400, `${where} must be a map`);
    }
    const unknown = Object.keys(relationship).filter((k) => !['from', 'to', 'type', 'properties'].includes(k)).sort(byCodeUnit);
    if (unknown.length) {
      throw new AppException(400, `${where} does not take ${unknown.join(', ')} - a relationship has from, to, type and properties`);
    }
    const row = {
      from: keyOf(relationship.from, `${where}.from`),
      to: keyOf(relationship.to, `${where}.to`),
      properties: propertiesOf(relationship.properties, where)
    };
    const type = identifierOf(relationship.type, `${where}.type`);
    if (!byType.has(type)) byType.set(type, []);
    byType.get(type).push(row);
  });
  const endpointKeys = [];
  for (const rows of byType.values()) {
    for (const row of rows) {
      for (const key of [row.from, row.to]) {
        if (!endpointKeys.includes(key)) endpointKeys.push(key);
      }
    }
  }
  return { nodes: byLabel, relationships: byType, source: source ?? undefined, nodeCount: nodes.length, relationshipCount: relationships.length, endpointKeys };
}

/**
 * The parameterized statements of an ingest, nodes first, then the relationships - one UNWIND ... MERGE
 * per label and per type, every value a parameter, source stamped. Every node is matched through the
 * ingest label, so the database finds it by the index on its key: a match on key without a label reads
 * every node of the database.
 */
export function ingestStatements(plan) {
  const statements = [];
  let stamp = plan.source !== undefined ? ', n.source = $source' : '';
  for (const [label, rows] of plan.nodes) {
    statements.push([
      `UNWIND $rows AS row MERGE (n:\`${INGEST_LABEL}\`:\`${label}\` {key: row.key}) SET n += row.properties${stamp}`,
      { rows, source: plan.source ?? null }
    ]);
  }
  stamp = plan.source !== undefined ? ', r.source = $source' : '';
  for (const [type, rows] of plan.relationships) {
    statements.push([
      `UNWIND $rows AS row MATCH (a:\`${INGEST_LABEL}\` {key: row.from}) MATCH (b:\`${INGEST_LABEL}\` {key: row.to}) `
        + `MERGE (a)-[r:\`${type}\`]->(b) SET r += row.properties${stamp}`,
      { rows, source: plan.source ?? null }
    ]);
  }
  return statements;
}

export const ENDPOINTS_QUERY = `UNWIND $keys AS key OPTIONAL MATCH (n:\`${INGEST_LABEL}\` {key: key}) WITH key, n WHERE n IS NULL RETURN key`;

// what prepares a graph for the ingest, once: is the constraint there; if not, the nodes written
// before the label existed take it, then the constraint is made. Neo4j's commands; a database that
// does not take them is matched by the label and left to its own index.
export const INGEST_CONSTRAINT_QUERY = `SHOW CONSTRAINTS YIELD name WHERE name = '${INGEST_CONSTRAINT}' RETURN name`;
export const INGEST_LABEL_STATEMENT = `MATCH (n) WHERE n.key IS NOT NULL AND NOT n:\`${INGEST_LABEL}\` SET n:\`${INGEST_LABEL}\``;
export const INGEST_CONSTRAINT_STATEMENT = `CREATE CONSTRAINT \`${INGEST_CONSTRAINT}\` IF NOT EXISTS FOR (n:\`${INGEST_LABEL}\`) REQUIRE n.key IS UNIQUE`;
export const INGEST_DUPLICATES_QUERY = `MATCH (n:\`${INGEST_LABEL}\`) WITH n.key AS key, count(*) AS nodes WHERE nodes > 1 RETURN key, nodes`;

/** A database that speaks Bolt and refuses a Neo4j command as unknown: its error code is not one of Neo4j's, or it is Neo4j's syntax error (an older server). */
function otherDialect(error) {
  const code = String(error?.code ?? '');
  return code.includes('.ClientError.') && (!code.startsWith('Neo.') || code.includes('SyntaxError'));
}

// the schema procedures: Neo4j's, then Memgraph's under the same column names
export const NODE_PROPERTIES_QUERIES = [
  'CALL db.schema.nodeTypeProperties() YIELD nodeLabels, propertyName, propertyTypes RETURN nodeLabels, propertyName, propertyTypes',
  'CALL schema.node_type_properties() YIELD nodeLabels, propertyName, propertyTypes RETURN nodeLabels, propertyName, propertyTypes'
];
export const RELATIONSHIP_PROPERTIES_QUERIES = [
  'CALL db.schema.relTypeProperties() YIELD relType, propertyName, propertyTypes RETURN relType, propertyName, propertyTypes',
  'CALL schema.rel_type_properties() YIELD relType, propertyName, propertyTypes RETURN relType, propertyName, propertyTypes'
];
export const LABEL_COUNTS_QUERY = 'MATCH (n) UNWIND labels(n) AS label RETURN label, count(*) AS count';
export const RELATIONSHIP_COUNTS_QUERY = 'MATCH (a)-[r]->(b) RETURN type(r) AS type, labels(a) AS from, labels(b) AS to, count(*) AS count';

function relationshipTypeName(value) {
  return String(value).replace(/^:+/, '').replace(/^`|`$/g, '');
}

/** The rows of the first procedure the database knows; a procedure the database lacks is tried as the next one, any other failure is raised. */
async function firstAvailable(tx, queries) {
  let failure;
  for (const query of queries) {
    try {
      return await tx.run(query);
    } catch (e) {
      const text = String(e?.message ?? e).toLowerCase();
      const code = String(e?.code ?? '');
      const missing = code.includes('ProcedureNotFound') || (text.includes('procedure')
        && ['no procedure', 'not found', 'no such', 'unknown', 'exist', 'not registered'].some((hint) => text.includes(hint)));
      if (missing) {
        failure = e;
        continue;
      }
      throw e;
    }
  }
  throw failure;
}

/** The four knowledge-graph tools over one database; the backend is the driver, or a fake in the tests. */
export function createGraphTools(sandbox, { backend = undefined, log = defaultLog } = {}) {
  const live = backend ?? createBolt(sandbox);

  function failed(e) {
    const error = graphError(e, { timeoutMs: sandbox.timeoutMs });
    if (error.status >= 500 || error.status === 408) {
      log.warn(`graph tool failed - ${e?.name ?? 'Error'} (${error.status})`);
    }
    return error;
  }

  async function run(work, { write }) {
    try {
      return await live.execute(work, { write });
    } catch (e) {
      throw failed(e);
    }
  }

  let ingestPrepared = false;
  let preparing = null;

  /** Before the first ingest of this process: the graph has the constraint, or gets it. A failure leaves the graph unprepared, so the next ingest tries again. */
  async function prepareIngest() {
    if (ingestPrepared) return;
    preparing ??= ensureIngestConstraint().then(() => { ingestPrepared = true; }).finally(() => { preparing = null; });
    await preparing;
  }

  async function ensureIngestConstraint() {
    let constraint;
    try {
      constraint = await live.execute(async (tx) => (await tx.run(INGEST_CONSTRAINT_QUERY, {}, { limit: 1 })).values.length > 0, { write: false });
    } catch (e) {
      if (!otherDialect(e)) throw failed(e);
      constraint = null;
    }
    if (constraint) return;
    // the nodes of a graph written before the label existed: without it a merge would not find
    // them and would write each a second time
    let labelled;
    try {
      labelled = await run(async (tx) => Number((await tx.run(INGEST_LABEL_STATEMENT)).counters?.labels_added ?? 0), { write: true });
    } catch (e) {
      if (e.status !== 408) throw e;
      throw new AppException(408, `labelling the nodes written before the label ${INGEST_LABEL} existed did not finish within ${sandbox.timeoutMs} ms and nothing was ingested - `
        + `an administrator runs it once, in batches on a large graph: ${INGEST_LABEL_STATEMENT}`);
    }
    if (constraint === null) {
      log.warn(`graph.ingest - this database does not take Neo4j's constraint commands: nodes are matched by the label ${INGEST_LABEL}, and the index on its key is the installation's to create`);
      return;
    }
    try {
      await live.execute(async (tx) => { await tx.run(INGEST_CONSTRAINT_STATEMENT); }, { write: true });
    } catch (e) {
      const code = String(e?.code ?? '');
      if (code.includes('ConstraintCreationFailed')) {
        throw new AppException(409, `the graph holds a key on more than one node, so the uniqueness constraint on (:${INGEST_LABEL} {key}) cannot be created and nothing was ingested - `
          + `list them with: ${INGEST_DUPLICATES_QUERY}`);
      }
      if (code.includes('.Security.')) {
        throw new AppException(503, `this process may not create the constraint the ingest needs - an administrator runs it once: ${INGEST_CONSTRAINT_STATEMENT}`);
      }
      throw failed(e);
    }
    log.info(`graph.ingest prepared the graph - ${labelled} node(s) took the label ${INGEST_LABEL}, constraint ${INGEST_CONSTRAINT} created`);
  }

  function parametersOf(args) {
    const parameters = args.parameters;
    if (parameters === undefined || parameters === null) return {};
    if (!isMap(parameters)) {
      throw new AppException(400, 'parameters must be a map of names to values');
    }
    return { ...parameters };
  }

  const renderRows = (rows) => rows.values.map((row) => row.map(renderValue));

  async function schema(_headers, body) {
    argumentsOf(body, GRAPH_SCHEMA_ROW);
    const result = await run(async (tx) => {
      const labels = new Map();
      // the schema is the domain's: the ingest label is on every node and says nothing about it
      for (const [label, count] of (await tx.run(LABEL_COUNTS_QUERY)).values) {
        if (label === INGEST_LABEL) continue;
        labels.set(String(label), { label: String(label), count: Number(renderValue(count)), properties: [] });
      }
      for (const [nodeLabels, name, types] of (await firstAvailable(tx, NODE_PROPERTIES_QUERIES)).values) {
        for (const label of nodeLabels ?? []) {
          if (label === INGEST_LABEL) continue;
          if (!labels.has(String(label))) labels.set(String(label), { label: String(label), count: 0, properties: [] });
          if (name !== null && name !== undefined) {
            labels.get(String(label)).properties.push({ name: String(name), types: (types ?? []).map(String) });
          }
        }
      }
      const kinds = new Map();
      const kindOf = (type) => {
        if (!kinds.has(type)) kinds.set(type, { type, count: 0, from: [], to: [], properties: [] });
        return kinds.get(type);
      };
      for (const [type, fromLabels, toLabels, count] of (await tx.run(RELATIONSHIP_COUNTS_QUERY)).values) {
        const entry = kindOf(String(type));
        entry.count += Number(renderValue(count));
        for (const label of fromLabels ?? []) if (label !== INGEST_LABEL && !entry.from.includes(String(label))) entry.from.push(String(label));
        for (const label of toLabels ?? []) if (label !== INGEST_LABEL && !entry.to.includes(String(label))) entry.to.push(String(label));
      }
      for (const [type, name, types] of (await firstAvailable(tx, RELATIONSHIP_PROPERTIES_QUERIES)).values) {
        const entry = kindOf(relationshipTypeName(type));
        if (name !== null && name !== undefined) {
          entry.properties.push({ name: String(name), types: (types ?? []).map(String) });
        }
      }
      for (const entry of labels.values()) entry.properties.sort((a, b) => byCodeUnit(a.name, b.name));
      for (const entry of kinds.values()) {
        entry.properties.sort((a, b) => byCodeUnit(a.name, b.name));
        entry.from.sort(byCodeUnit);
        entry.to.sort(byCodeUnit);
      }
      return {
        labels: [...labels.keys()].sort(byCodeUnit).map((name) => labels.get(name)),
        relationship_types: [...kinds.keys()].sort(byCodeUnit).map((name) => kinds.get(name))
      };
    }, { write: false });
    log.info(`graph.schema 200 ${result.labels.length} labels, ${result.relationship_types.length} relationship types`);
    return result;
  }

  async function query(_headers, body) {
    const args = argumentsOf(body, GRAPH_QUERY_ROW);
    const text = stringArg(args, 'query').trim();
    if (!text) {
      throw new AppException(400, 'query must not be empty');
    }
    const parameters = parametersOf(args);
    const clause = writeClause(text);
    if (clause !== undefined) {
      throw new AppException(400, `query carries ${clause}, a write clause - graph_query is read-only; graph_write or graph_ingest writes`);
    }
    const rows = await run((tx) => tx.run(text, parameters, { limit: sandbox.maxRows }), { write: false });
    log.info(`graph.query 200 ${rows.values.length} rows${rows.truncated ? ' (cut)' : ''}`);
    return { columns: rows.columns, rows: renderRows(rows), truncated: rows.truncated };
  }

  async function write(_headers, body) {
    const args = argumentsOf(body, GRAPH_WRITE_ROW);
    const text = stringArg(args, 'query').trim();
    if (!text) {
      throw new AppException(400, 'query must not be empty');
    }
    const parameters = parametersOf(args);
    if (!sandbox.delete) {
      const clause = deleteClause(text);
      if (clause !== undefined) {
        throw new AppException(400, `query carries ${clause} - deletion is not allowed on this graph (${GRAPH_DELETE})`);
      }
    }
    const rows = await run((tx) => tx.run(text, parameters, { limit: sandbox.maxRows }), { write: true });
    const counters = Object.fromEntries(COUNTER_NAMES.map((name) => [name, Number(rows.counters?.[name] ?? 0)]));
    const changed = Object.entries(counters).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join(', ');
    log.info(`graph.write 200 ${changed || 'no change'}`);
    return { counters, columns: rows.columns, rows: renderRows(rows), truncated: rows.truncated };
  }

  async function ingest(_headers, body) {
    const args = argumentsOf(body, GRAPH_INGEST_ROW);
    const plan = planIngest(args, { maxNodes: sandbox.ingestMaxNodes });
    const statements = ingestStatements(plan);
    const nodeStatements = plan.nodes.size;
    await prepareIngest();
    const result = await run(async (tx) => {
      for (const [statement, parameters] of statements.slice(0, nodeStatements)) await tx.run(statement, parameters);
      if (plan.endpointKeys.length) {
        const missing = await tx.run(ENDPOINTS_QUERY, { keys: plan.endpointKeys }, { limit: 20 });
        if (missing.values.length) {
          throw new AppException(400, `relationship endpoints not found in the graph or in this call: ${missing.values.map((row) => String(row[0])).join(', ')}`);
        }
      }
      for (const [statement, parameters] of statements.slice(nodeStatements)) await tx.run(statement, parameters);
      return { nodes: plan.nodeCount, relationships: plan.relationshipCount };
    }, { write: true });
    log.info(`graph.ingest 200 ${result.nodes} nodes, ${result.relationships} relationships`);
    return result;
  }

  return { sandbox, backend: live, schema, query, write, ingest, close: () => live.close?.() };
}

// --- the clock ----------------------------------------------------------------------------------

export async function timeNow(_headers, body) {
  const args = argumentsOf(body, TIME_NOW_ROW);
  let name = stringArg(args, 'timezone', { defaultValue: 'UTC' }).trim() || 'UTC';
  const now = new Date();
  if (name.toUpperCase() === 'UTC') name = 'UTC';
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: name, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
      second: '2-digit', weekday: 'long', timeZoneName: 'longOffset'
    }).formatToParts(now);
  } catch {
    throw new AppException(400, `${name} is not a time zone - an IANA name such as Europe/Berlin`);
  }
  const part = (type) => parts.find((p) => p.type === type)?.value ?? '';
  const offsetText = part('timeZoneName');
  const offset = offsetText === 'GMT' ? '+00:00' : offsetText.replace(/^GMT/, '').replace(/^([+-]\d{2})$/, '$1:00');
  return {
    utc: isoUtc(now),
    local: `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}:${part('second')}${offset}`,
    timezone: name,
    offset,
    weekday: part('weekday'),
    epoch_ms: now.getTime()
  };
}

// --- the application: register what is configured, before the host listens -------------------

/**
 * The built-in tools of a process, wired to their dependencies: registry the function registry the
 * tools register with, log the logger, out(line) prints describe's output, and the libraries and
 * backends a test injects. Tests create fresh instances.
 */
export function createAgentTools({
  registry = defaultRegistry,
  log = defaultLog,
  out = (line) => console.log(line),
  documents = undefined,
  driver = undefined,
  graphBackend = undefined
} = {}) {
  const state = { files: undefined, web: undefined, graph: undefined, registered: [] };

  function register(route, handler) {
    registry.register(route, handler, { instances: INSTANCES });
    state.registered.push(route);
  }

  async function shutdown() {
    if (state.web) await state.web.close();
    if (state.graph) await state.graph.close();
  }

  /** Read the sandboxes and register the tools - before the host listens; a configuration failure stops the application by name. */
  async function boot() {
    try {
      const fileSandbox = await loadFileSandbox({ log });
      if (!fileSandbox) {
        log.info(`File tools not registered - ${FILE_ROOT} is not set`);
      } else {
        const libraries = documents ?? (await loadDocuments());
        state.files = createFileTools(fileSandbox, { log, documents: libraries });
        for (const [route, handler] of [['file.read', state.files.read], ['file.write', state.files.write],
          ['file.list', state.files.list], ['file.search', state.files.search]]) {
          register(route, handler);
        }
        if (libraries) {
          register('file.extract', state.files.extract);
        } else {
          log.info(`file.extract not registered - ${DOCUMENTS_EXTRA}`);
        }
        log.info(`File tools registered - workspace ${fileSandbox.root}`);
      }
      const webSandbox = loadWebSandbox({ log });
      if (!webSandbox) {
        log.info(`Web tools not registered - ${WEB_ALLOW} is empty`);
      } else {
        state.web = createWebTools(webSandbox, { log });
        register('web.fetch', state.web.webFetch);
        register('web.crawl', state.web.webCrawl);
        log.info(`Web tools registered - ${webSandbox.rules.length} allowed site pattern(s)${webSandbox.allowPrivate ? ', private addresses allowed' : ''}`);
      }
      const graphSandbox = await loadGraphSandbox({ log, driver });
      if (!graphSandbox) {
        log.info(`Graph tools not registered - ${GRAPH_URI} is not set`);
      } else {
        state.graph = createGraphTools(graphSandbox, { log, backend: graphBackend ? graphBackend(graphSandbox) : undefined });
        register('graph.schema', state.graph.schema);
        register('graph.query', state.graph.query);
        if (graphSandbox.write) {
          register('graph.write', state.graph.write);
          register('graph.ingest', state.graph.ingest);
        } else {
          log.info(`graph.write and graph.ingest not registered - ${GRAPH_WRITE} is false`);
        }
        try {
          await state.graph.backend.verify();
          log.info(`Graph tools registered - ${graphSandbox.address}${graphSandbox.write ? ', writes allowed' : ''}${graphSandbox.delete ? ', deletion allowed' : ''}`);
        } catch (e) {
          log.warn(`Graph tools registered - ${graphSandbox.address} does not answer yet (${e?.name ?? 'Error'}); calls fail until it does`);
        }
      }
      if (boolSetting(TIME_ENABLED, true)) {
        register('time.now', timeNow);
      } else {
        log.info(`time.now not registered - ${TIME_ENABLED} is false`);
      }
      log.info(`Built-in tools ready - ${state.registered.join(', ') || 'none registered'}`);
    } catch (e) {
      if (e instanceof ToolsError) {
        log.error(`Built-in tools cannot start - ${e.message}`);
        await shutdown();
        throw new ToolsError(`Built-in tools cannot start - ${e.message}`);
      }
      throw e;
    }
  }

  /** Health check speaking the engines' interface contract (type=info / type=health): which tools are registered and the sandboxes they run in. */
  async function health(headers) {
    if (headers?.type === 'info') {
      return {
        service: 'agent.tools',
        href: 'http://127.0.0.1',
        tools: [...state.registered],
        workspace: state.files ? state.files.root : null,
        allowed_sites: state.web ? state.web.sandbox.rules.map(ruleText) : [],
        graph: state.graph ? state.graph.sandbox.address : null
      };
    }
    return 'agent.tools is running fine';
  }

  /** For each route, whether it registers under the current configuration, and why not. */
  async function states() {
    let fileState;
    try {
      const files = await loadFileSandbox({ log });
      fileState = files ? `registers (workspace ${files.root})` : `NOT registered (${FILE_ROOT} is not set)`;
    } catch (e) {
      fileState = `NOT registered (${e.message})`;
    }
    let webState;
    try {
      const web = loadWebSandbox({ log });
      webState = web ? `registers (${web.rules.length} allowed site pattern(s))` : `NOT registered (${WEB_ALLOW} is empty)`;
    } catch (e) {
      webState = `NOT registered (${e.message})`;
    }
    let readState;
    let writeState;
    try {
      const graph = await loadGraphSandbox({ log, driver });
      if (!graph) {
        readState = writeState = `NOT registered (${GRAPH_URI} is not set)`;
      } else {
        readState = `registers (${graph.address})`;
        writeState = graph.write ? readState : `NOT registered (${GRAPH_WRITE} is false)`;
      }
    } catch (e) {
      readState = writeState = `NOT registered (${e.message})`;
    }
    let timeState;
    try {
      timeState = boolSetting(TIME_ENABLED, true) ? 'registers' : `NOT registered (${TIME_ENABLED} is false)`;
    } catch (e) {
      timeState = `NOT registered (${e.message})`;
    }
    let extractState = fileState;
    if (fileState.startsWith('registers') && !(documents ?? (await loadDocuments()))) {
      extractState = `NOT registered (${DOCUMENTS_EXTRA})`;
    }
    const result = new Map();
    for (const route of ROW_BY_ROUTE.keys()) {
      const group = route.split('.', 1)[0];
      if (route === 'file.extract') result.set(route, extractState);
      else if (route === 'graph.write' || route === 'graph.ingest') result.set(route, writeState);
      else if (group === 'graph') result.set(route, readState);
      else result.set(route, { file: fileState, web: webState, time: timeState }[group]);
    }
    return result;
  }

  /** Print every catalog row (or the ones named, by name or route) as the JSON a catalog node takes, each with whether it registers under the current configuration. */
  async function describe(names, err = (line) => console.error(line)) {
    const wanted = ROWS.filter((row) => !names.length || names.includes(row.name) || names.includes(row.route));
    const known = new Set([...ROWS.map((r) => r.name), ...ROW_BY_ROUTE.keys()]);
    const missing = names.filter((n) => !known.has(n)).sort(byCodeUnit);
    if (missing.length) {
      err(`Unknown tool(s): ${missing.join(', ')} - the tools are ${ROWS.map((r) => r.name).join(', ')}`);
      return 1;
    }
    const current = await states();
    out(`# ${wanted.length} built-in tool(s) - the catalog rows a graph copies, and what registers here`);
    for (const row of wanted) {
      out(`\n## ${row.route} (${row.name}) - ${current.get(row.route)}`);
      out(rowJson(row).trimEnd());
    }
    return 0;
  }

  return { boot, shutdown, health, describe, states, state, get registered() { return state.registered; } };
}

const agentTools = createAgentTools();
preload('tools.health', { instances: 5, isPrivate: true }, agentTools.health);

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  // -Dkey=value arguments belong to the configuration, which reads them from process.argv itself
  const words = process.argv.slice(2).filter((a) => !a.startsWith('-D'));
  loadConfig(undefined, HERE);
  if (words[0] === 'describe') {
    process.exitCode = await agentTools.describe(words.slice(1));
  } else {
    platform.onStartup(agentTools.boot);
    platform.onCleanup(agentTools.shutdown);
    await platform.run();
  }
} else {
  // loaded by mercury-serve: the tools register inside the serving loop, before the host listens
  platform.onStartup(agentTools.boot);
  platform.onCleanup(agentTools.shutdown);
}

/** A test hook: the crawl's text budget (the module constant) may be lowered to prove the cut. */
export function setCrawlResultMaxChars(value) {
  CRAWL_RESULT_MAX_CHARS = value;
}
