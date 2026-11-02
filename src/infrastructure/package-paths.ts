import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Command } from '../domain/types.ts';

// Runtime modules live in dist/src/infrastructure; assets live at the installed package root.
export const packageRoot = fileURLToPath(new URL('../../../', import.meta.url));
export const runtimeScript = (name: string) => path.join(packageRoot, 'dist/scripts', `${name}.js`);
export const runtimeCommand = (name: string): Command => ({
  command: process.execPath,
  args: [runtimeScript(name)],
});
