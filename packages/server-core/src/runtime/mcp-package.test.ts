import { expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';

test('the MCP entry points used by the server load with packaged dependencies', async () => {
  const entrypoints = await Promise.all([
    import('@modelcontextprotocol/sdk/client/index.js'),
    import('@modelcontextprotocol/sdk/client/stdio.js'),
    import('@modelcontextprotocol/sdk/client/streamableHttp.js'),
    import('@modelcontextprotocol/sdk/inMemory.js'),
    import('@modelcontextprotocol/sdk/server/index.js'),
    import('@modelcontextprotocol/sdk/server/mcp.js'),
    import('@modelcontextprotocol/sdk/server/stdio.js'),
    import('@modelcontextprotocol/sdk/server/streamableHttp.js'),
    import('@modelcontextprotocol/sdk/shared/transport.js'),
    import('@modelcontextprotocol/sdk/types.js'),
  ]);
  expect(entrypoints).toHaveLength(10);
});

test('packaged MCP client and server validate a real local tool exchange', async () => {
  const server = new McpServer({ name: 'package-validation', version: '1.0.0' });
  let calls = 0;
  server.registerTool('echo', {
    inputSchema: { message: z.string() },
  }, async ({ message }) => {
    calls += 1;
    return { content: [{ type: 'text' as const, text: message }] };
  });
  const client = new Client({ name: 'package-validation-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    await client.ping();
    const { tools } = await client.listTools();
    expect(tools[0]?.inputSchema.required).toEqual(['message']);
    const valid = await client.callTool({ name: 'echo', arguments: { message: 'local fixture' } });
    expect(valid.content).toEqual([{ type: 'text', text: 'local fixture' }]);
    expect(calls).toBe(1);
    const invalid = await client.callTool({ name: 'echo', arguments: { message: 123 } });
    expect(invalid.isError).toBe(true);
    expect(calls).toBe(1);
  } finally {
    await client.close();
    await server.close();
  }
});
