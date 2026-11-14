/**
 * A small MCP server on the official SDK, for the MCP binding's tests.
 *
 *   node test/fixtures/mcp-test-server.mjs              # stdio (the default transport)
 *   node test/fixtures/mcp-test-server.mjs http 8765    # streamable HTTP on 127.0.0.1:8765/mcp
 *
 * Five tools cover the result shapes the binding maps: `echo` answers text, `add` answers
 * structured content, `fail` reports a tool error, `slow` answers after a delay (a timeout test),
 * and `env_present` says whether a variable reached the subprocess's environment - its presence
 * only, never its value.
 */
import { createServer } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

function build() {
  const server = new McpServer({ name: 'fixture', version: '1.0.0' });
  server.registerTool('echo', { description: 'Echo the text back.', inputSchema: { text: z.string() } },
    async ({ text }) => ({ content: [{ type: 'text', text }] }));
  server.registerTool('add', {
    description: 'Add two whole numbers.',
    inputSchema: { a: z.number().int(), b: z.number().int() },
    outputSchema: { sum: z.number().int() }
  }, async ({ a, b }) => ({ content: [{ type: 'text', text: JSON.stringify({ sum: a + b }) }], structuredContent: { sum: a + b } }));
  server.registerTool('fail', { description: 'Fail with the reason given.', inputSchema: { reason: z.string() } },
    async ({ reason }) => ({ content: [{ type: 'text', text: reason }], isError: true }));
  server.registerTool('slow', { description: 'Answer after a delay, in seconds.', inputSchema: { seconds: z.number() } },
    async ({ seconds }) => {
      await new Promise((r) => setTimeout(r, seconds * 1000));
      return { content: [{ type: 'text', text: 'done' }] };
    });
  server.registerTool('env_present', {
    description: 'Whether an environment variable reached this server.',
    inputSchema: { name: z.string() },
    outputSchema: { present: z.boolean() }
  }, async ({ name }) => {
    const present = name in process.env;
    return { content: [{ type: 'text', text: JSON.stringify({ present }) }], structuredContent: { present } };
  });
  return server;
}

if (process.argv[2] === 'http') {
  const port = Number(process.argv[3]);
  // stateless: one server and transport per request, closed with the response
  const httpServer = createServer(async (req, res) => {
    if (!req.url?.startsWith('/mcp')) {
      res.statusCode = 404;
      res.end();
      return;
    }
    const server = build();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  });
  httpServer.listen(port, '127.0.0.1');
} else {
  await build().connect(new StdioServerTransport());
}
