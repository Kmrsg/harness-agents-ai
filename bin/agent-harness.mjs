#!/usr/bin/env node
if (Number(process.versions.node.split('.')[0]) < 22) {
  console.error('agent-harness requires Node.js 22 or newer');
  process.exit(1);
}
await import('../dist/src/cli/main.js');
