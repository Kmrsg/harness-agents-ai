import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { packageRoot } from '../../src/infrastructure/package-paths.ts';
import { fixture } from '../support/review-fixture.ts';

test('watch CLI returns a waiting status and processes merge from the current repository', async (t) => {
  const f = await fixture(t);
  const { execute } = await import('../../src/infrastructure/process.ts');
  const command = {
    command: process.execPath,
    args: [path.join(packageRoot, 'bin/agent-harness.mjs'), 'watch', f.state.id],
  };
  const waiting = await execute(command, f.root);
  assert.equal(waiting.exitCode, 0, waiting.stderr);
  assert.equal(JSON.parse(waiting.stdout).status, 'WAITING_REVIEW');
  f.snapshot.state = 'MERGED';
  await f.update();
  const merged = await execute(command, f.root);
  assert.equal(merged.exitCode, 0, merged.stderr);
  assert.equal(JSON.parse(merged.stdout).status, 'COMPLETED');
});

test('run --watch starts monitoring immediately after PR publication', async (t) => {
  const f = await fixture(t);
  f.snapshot.state = 'MERGED';
  await f.update();
  const { projectRoot: _root, ...settings } = f.state.config;
  await writeFile(path.join(f.root, 'harness.config.json'), JSON.stringify(settings));
  await writeFile(path.join(f.root, 'task.json'), JSON.stringify(f.state.task));
  const { execute } = await import('../../src/infrastructure/process.ts');
  const result = await execute(
    {
      command: process.execPath,
      args: [path.join(packageRoot, 'bin/agent-harness.mjs'), 'run', 'task.json', '--watch'],
    },
    f.root,
  );
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, 'COMPLETED');
  assert.match(result.stderr, /PR published/);
});
