#!/usr/bin/env node
/**
 * Developer runner: serve a polyglot function module with one command.
 *
 *   mercury-serve app.mjs --port 8087
 *   mercury-serve app.mjs --config application.yml
 *
 * The configuration is the resources folder next to app.mjs - never the working
 * directory - unless --config names a file.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

function parseArgs(argv: string[]): { app?: string; port?: number; host: string; config?: string } {
  const result: { app?: string; port?: number; host: string; config?: string } = {
    host: '127.0.0.1'
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--port') result.port = Number.parseInt(argv[++i], 10);
    else if (arg === '--host') result.host = argv[++i];
    else if (arg === '--config') result.config = argv[++i];
    else if (!arg.startsWith('-') && !result.app) result.app = arg;
  }
  return result;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.app) {
    process.stderr.write(
      'Usage: mercury-serve <app.mjs> [--port n] [--host addr] [--config file]\n');
    return 1;
  }
  const { loadConfig } = await import('./config.js');
  const appPath = path.resolve(args.app);
  if (!fs.existsSync(appPath)) {
    process.stderr.write(`Application file not found - ${appPath}\n`);
    return 1;
  }
  // the resources folder is the one next to the application file, wherever the command runs
  // from; --config names another file. Loaded before logging/server setup so their keys apply.
  loadConfig(args.config, path.dirname(appPath));
  // -Dkey=value runtime overrides are consumed by AppConfig from process.argv
  await import(pathToFileURL(appPath).href);
  const { defaultRegistry } = await import('./registry.js');
  const { platform } = await import('./server.js');
  if (defaultRegistry.routes().length === 0) {
    process.stderr.write('No functions registered - use preload(route, options, handler)\n');
    return 1;
  }
  await platform.run({ port: args.port, host: args.host });
  return 0;
}

try {
  const code = await main();
  if (code !== 0) process.exit(code);
} catch (e) {
  process.stderr.write(`${(e as Error).message}\n`);
  process.exit(1);
}
