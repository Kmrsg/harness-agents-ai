import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { repositoryRoot, loadConfig } from '../../src/config/settings.ts';
import { execute } from '../../src/infrastructure/process.ts';
import { git } from '../../src/infrastructure/git.ts';
import { packageRoot, runtimeCommand } from '../../src/infrastructure/package-paths.ts';

async function repository(t: { after(fn: () => Promise<void>): void }) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'harness-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await git(directory, ['init']);
  const root = await realpath(directory);
  const nested = path.join(root, 'packages/ui');
  await mkdir(nested, { recursive: true });
  return { root, nested };
}
const cli = (...args: string[]) => ({
  command: process.execPath,
  args: [path.join(packageRoot, 'bin/agent-harness.mjs'), ...args],
});

test('repository is detected from cwd, including a nested monorepo directory', async (t) => {
  const { root, nested } = await repository(t);
  assert.equal(await repositoryRoot(nested), root);
  const config = await loadConfig(root);
  assert.equal(config.projectRoot, root);
  assert.equal(config.knowledgeRoot, path.join(packageRoot, 'knowledge'));
});

test('init from another repository creates settings without any target path', async (t) => {
  const { root, nested } = await repository(t);
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({
      packageManager: 'pnpm@9.0.0',
      scripts: { typecheck: 'tsc', test: 'vitest', build: 'vite build' },
    }),
  );
  const result = await execute(cli('init'), nested);
  assert.equal(result.exitCode, 0, result.stderr);
  const config = JSON.parse(await readFile(path.join(root, 'harness.config.json'), 'utf8'));
  assert.equal(config.projectRoot, undefined);
  assert.equal(config.knowledgeRoot, undefined);
  assert.deepEqual(
    config.checks.map((check: { name: string; command: string }) => [check.name, check.command]),
    [
      ['typecheck', 'pnpm'],
      ['test', 'pnpm'],
      ['build', 'pnpm'],
    ],
  );
  const mcp = JSON.parse(await readFile(path.join(root, 'harness.mcp.json'), 'utf8'));
  assert.ok(mcp.mcpServers['ui-stub'].args[0].endsWith('dist/scripts/mcp-stub.js'));
  const second = await execute(cli('init'), nested);
  assert.equal(second.exitCode, 1);
  assert.deepEqual(
    JSON.parse(await readFile(path.join(root, 'harness.config.json'), 'utf8')),
    config,
  );
});

test('one settings file can be reused across repositories without redirecting the target', async (t) => {
  const a = await repository(t),
    b = await repository(t);
  const file = path.join(a.root, 'shared.json');
  await writeFile(file, JSON.stringify({ git: { publish: false } }));
  const config = await loadConfig(b.root, file);
  assert.equal(config.projectRoot, b.root);
  assert.equal(config.git.enabled, true);
});

test('legacy projectRoot is rejected instead of silently running in another repo', async (t) => {
  const { root } = await repository(t);
  await writeFile(
    path.join(root, 'harness.config.json'),
    JSON.stringify({ projectRoot: '/some/other/project' }),
  );
  await assert.rejects(loadConfig(root), /Remove projectRoot/);
});

test('CLI runs the complete mock workflow in the current repo without a config argument', async (t) => {
  const { root, nested } = await repository(t);
  await writeFile(path.join(root, 'spec.md'), '# Input specification\n');
  await writeFile(
    path.join(root, 'task.json'),
    JSON.stringify({
      id: 'CLI-1',
      title: 'CLI fixture',
      description: 'Implement behavior',
      specPath: 'spec.md',
      areas: ['frontend'],
      acceptanceCriteria: [{ id: 'AC-1', description: 'Works' }],
    }),
  );
  await writeFile(
    path.join(root, 'harness.config.json'),
    JSON.stringify({
      runner: runtimeCommand('mock-agent'),
      runnerMode: 'protocol',
      git: { enabled: false },
      checks: [
        { name: 'Fixture', command: process.execPath, args: ['-e', 'console.log("checked")'] },
      ],
    }),
  );
  const result = await execute(cli('run', '../../task.json'), nested, '', 30_000);
  assert.equal(result.exitCode, 0, result.stdout + result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, 'COMPLETED');
  assert.ok(output.runDirectory.startsWith(path.join(root, '.harness/runs/')));
  const state = JSON.parse(await readFile(path.join(output.runDirectory, 'state.json'), 'utf8'));
  assert.equal(state.config.projectRoot, root);
  assert.ok(state.verification.implementationApproval);
  const status = await execute(cli('status', state.id), nested);
  assert.equal(status.exitCode, 0);
  assert.equal(JSON.parse(status.stdout).id, state.id);
});

test('outside Git a run fails clearly, while help still works', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'harness-no-git-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const run = await execute(cli('run', 'task.json'), directory);
  assert.equal(run.exitCode, 1);
  assert.match(run.stderr, /from a Git repository/);
  const help = await execute(cli('--help'), directory);
  assert.equal(help.exitCode, 0);
  assert.match(help.stdout, /Node.js >=22/);
});

test('unresolved questions are reported to Task tracker and a terminal answer resumes the analyst', async (t) => {
  const { root } = await repository(t);
  await writeFile(path.join(root, 'spec.md'), '# Complete task specification\n');
  await writeFile(
    path.join(root, 'task.json'),
    JSON.stringify({
      id: 'CLI-ASK',
      title: 'Unresolved question',
      description: 'Implement feature [clarify]',
      specPath: 'spec.md',
      areas: ['frontend'],
      acceptanceCriteria: [{ id: 'AC-1', description: 'Works' }],
    }),
  );
  const adapter = path.join(root, 'tracker.mjs');
  await writeFile(
    adapter,
    `import fs from 'node:fs/promises';let input='';for await(const chunk of process.stdin)input+=chunk;
    await fs.writeFile('.harness/tracker-call.json',input);console.log(JSON.stringify({ok:true}));`,
  );
  await writeFile(
    path.join(root, 'harness.config.json'),
    JSON.stringify({
      runner: runtimeCommand('mock-agent'),
      runnerMode: 'protocol',
      git: { enabled: false },
      checks: [
        { name: 'Fixture', command: process.execPath, args: ['-e', 'console.log("checked")'] },
      ],
      integrations: { taskTracker: { command: process.execPath, args: [adapter] } },
    }),
  );
  const first = await execute(cli('run', 'task.json'), root);
  assert.equal(first.exitCode, 2, first.stderr);
  const question = JSON.parse(first.stdout);
  assert.equal(question.status, 'NEEDS_CLARIFICATION');
  assert.equal(question.questions[0].id, 'Q1');
  assert.match(await readFile(question.clarificationFile, 'utf8'), /Q1/);
  const clarification = JSON.parse(
    await readFile(path.join(root, '.harness/tracker-call.json'), 'utf8'),
  );
  assert.equal(clarification.operation, 'task.report');
  assert.equal(clarification.payload.status, 'NEEDS_CLARIFICATION');
  assert.equal(clarification.payload.returnToRole, 'analyst');
  assert.deepEqual(clarification.payload.questions, question.questions);
  assert.match(clarification.payload.report, /Q1/);
  const state = JSON.parse(await readFile(path.join(question.runDirectory, 'state.json'), 'utf8'));
  const next = await execute(
    cli('resume', state.id, '--answer', 'Retain the input and show an error.'),
    root,
  );
  assert.equal(next.exitCode, 0, next.stderr + next.stdout);
  const message = JSON.parse(await readFile(path.join(root, '.harness/tracker-call.json'), 'utf8'));
  assert.equal(message.payload.status, 'COMPLETED');
  assert.deepEqual(message.payload.questions, []);
  const analyst = JSON.parse(
    await readFile(path.join(question.runDirectory, '2-analyst.request.json'), 'utf8'),
  );
  assert.equal(analyst.clarificationHistory[0].answer, 'Retain the input and show an error.');
});

test('events command reads existing history and tolerates older runs without a journal', async (t) => {
  const { root } = await repository(t);
  const runDirectory = path.join(root, '.harness/runs/legacy-run');
  await mkdir(runDirectory, { recursive: true });
  const legacy = await execute(cli('events', 'legacy-run'), root);
  assert.equal(legacy.exitCode, 0);
  assert.deepEqual(JSON.parse(legacy.stdout), []);
  const event = {
    version: 1,
    id: 'event-1',
    timestamp: '2026-10-30T00:00:00.000Z',
    runId: 'legacy-run',
    iteration: 1,
    type: 'run.started',
    data: { taskId: 'LEGACY' },
  };
  await writeFile(path.join(runDirectory, 'events.jsonl'), JSON.stringify(event) + '\n');
  const result = await execute(cli('events', 'legacy-run'), root);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(result.stdout), [event]);
});
