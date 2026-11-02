import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runtimeScript } from '../../src/infrastructure/package-paths.ts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

for (const kind of ['codebase', 'ui']) {
  test(`${kind} MCP stub supports initialization, discovery and a real tool call`, async () => {
    const client = new Client({ name: 'harness-test', version: '1.0.0' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [runtimeScript('mcp-stub'), kind],
    });
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      assert.ok(tools.tools.length >= 2);
      const result = await client.callTool({
        name: kind === 'codebase' ? 'search_knowledge' : 'get_kb',
        arguments: kind === 'codebase' ? { query: 'forms' } : {},
      });
      const content = result.content as { type: string; text: string }[];
      const payload = JSON.parse(content[0].text);
      assert.equal(payload.mock, true);
      assert.equal(payload.source, `${kind}-stub`);
    } finally {
      await client.close();
    }
  });
}
