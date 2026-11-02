/** Local stdio MCP fixtures. Never claim to contain corporate rules or APIs. */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const kind = process.argv[2];
if (kind !== 'codebase' && kind !== 'ui')
  throw new Error('Usage: node dist/scripts/mcp-stub.js <codebase|ui>');
const server = new McpServer({ name: `${kind}-stub`, version: '0.1.0' });
const content = (tool: string, data: unknown) => ({
  content: [
    {
      type: 'text' as const,
      text: JSON.stringify({
        mock: true,
        source: `${kind}-stub`,
        tool,
        data,
        warning:
          'Fixture only. Replace with your work MCP server; this is not authoritative project knowledge.',
      }),
    },
  ],
});
if (kind === 'codebase') {
  server.registerTool(
    'search_knowledge',
    {
      description: 'MOCK search of project conventions and APIs',
      inputSchema: { query: z.string() },
    },
    async ({ query }) =>
      content('search_knowledge', {
        query,
        matches: [],
        hint: 'No corporate knowledge loaded. Read local project sources or connect real Codebase MCP.',
      }),
  );
  server.registerTool(
    'find_usage_example',
    { description: 'MOCK usage examples', inputSchema: { query: z.string() } },
    async ({ query }) => content('find_usage_example', { query, examples: [] }),
  );
} else {
  server.registerTool('get_kb', { description: 'MOCK UI rules index', inputSchema: {} }, async () =>
    content('get_kb', { rules: [{ id: 'stub-ui', title: 'Demonstration UI rules' }] }),
  );
  server.registerTool(
    'get_rule',
    { description: 'MOCK rule lookup', inputSchema: { id: z.string() } },
    async ({ id }) =>
      content('get_rule', {
        id,
        text: 'Use existing project components and handle loading and error states. This is a sample, not a corporate rule.',
      }),
  );
  server.registerTool(
    'get_ui_quality_checklist',
    { description: 'MOCK UI checklist', inputSchema: {} },
    async () =>
      content('get_ui_quality_checklist', {
        checks: ['Loading state', 'Error state', 'Keyboard access'],
        note: 'No browser execution or visual verification performed.',
      }),
  );
}
await server.connect(new StdioServerTransport());
