import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execute } from '../infrastructure/process.ts';
import { packageRoot, runtimeScript } from '../infrastructure/package-paths.ts';
import { readConfig } from '../domain/validation.ts';
import type { Config } from '../domain/types.ts';

export async function repositoryRoot(cwd = process.cwd()): Promise<string> {
  const result = await execute(
    { command: 'git', args: ['rev-parse', '--show-toplevel'] },
    cwd,
    '',
    10_000,
  );
  if (result.exitCode !== 0 || !result.stdout.trim())
    throw new Error('Run agent-harness from a Git repository or one of its subdirectories');
  return path.resolve(result.stdout.trim());
}

type Settings = Omit<Config, 'projectRoot'>;
export async function defaultSettings(root: string): Promise<Settings> {
  let scripts: Record<string, unknown> = {},
    manager = 'npm';
  try {
    const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
    if (pkg.scripts && typeof pkg.scripts === 'object') scripts = pkg.scripts;
    if (typeof pkg.packageManager === 'string' && /^(pnpm|yarn)@/.test(pkg.packageManager))
      manager = pkg.packageManager.split('@')[0];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      throw new Error('Cannot read project package.json');
  }
  const checks = ['typecheck', 'lint', 'test', 'build']
    .filter((name) => typeof scripts[name] === 'string' && (scripts[name] as string).trim())
    .map((name) => ({ name, command: manager, args: ['run', name] }));
  return {
    runner: { command: 'llm-cli', args: [] },
    runnerMode: 'cli',
    timeoutMs: 600_000,
    maxOutputBytes: 8_000_000,
    maxInputBytes: 4_000_000,
    runnerInput: 'stdin',
    maxIterations: 3,
    maxReworkRetries: 2,
    knowledgeRoot: path.join(packageRoot, 'knowledge'),
    git: { enabled: true, baseRef: 'HEAD', publish: false },
    checks: checks.length
      ? checks
      : [
          {
            name: 'Configure project checks',
            command: process.execPath,
            args: [
              '-e',
              'console.error("No project checks detected. Run agent-harness init and configure checks in harness.config.json");process.exit(1)',
            ],
          },
        ],
    integrations: {},
  };
}

function section(base: unknown, override: unknown): unknown {
  return override === undefined
    ? base
    : override && typeof override === 'object' && !Array.isArray(override)
      ? { ...(base as object), ...override }
      : override;
}

export async function loadConfig(root: string, explicitPath?: string): Promise<Config> {
  const file = explicitPath ? path.resolve(explicitPath) : path.join(root, 'harness.config.json');
  const defaults = await defaultSettings(root);
  let overrides: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error('Config must be a JSON object');
    overrides = parsed as Record<string, unknown>;
  } catch (error) {
    if (explicitPath || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return readConfig(
    {
      ...defaults,
      ...overrides,
      runner: section(defaults.runner, overrides.runner),
      git: section(defaults.git, overrides.git),
      integrations: section(defaults.integrations, overrides.integrations),
    },
    path.dirname(file),
    root,
  );
}

export async function initializeSettings(
  cwd = process.cwd(),
): Promise<{ root: string; configPath: string; mcpPath: string }> {
  const root = await repositoryRoot(cwd);
  const configPath = path.join(root, 'harness.config.json');
  const mcpPath = path.join(root, 'harness.mcp.json');
  const { knowledgeRoot: _bundledKnowledge, ...portable } = await defaultSettings(root);
  await writeFile(configPath, JSON.stringify(portable, null, 2) + '\n', { flag: 'wx' });
  await writeFile(
    mcpPath,
    JSON.stringify(
      {
        mcpServers: {
          'codebase-stub': {
            command: process.execPath,
            args: [runtimeScript('mcp-stub'), 'codebase'],
          },
          'ui-stub': { command: process.execPath, args: [runtimeScript('mcp-stub'), 'ui'] },
        },
      },
      null,
      2,
    ) + '\n',
    { flag: 'wx' },
  );
  return { root, configPath, mcpPath };
}
