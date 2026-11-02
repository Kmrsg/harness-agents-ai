import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { start } from '../../src/workflow/lifecycle.ts';
import { pipeline } from '../../src/workflow/pipeline.ts';

import { trackedTasks } from '../../src/openspec/validation.ts';
import { fixture } from '../support/workflow-fixture.ts';

test('OpenSpec artifacts pass through shared change and task progress is owned by each role', async (t) => {
  const { directory, task, config } = await fixture(t);
  const result = await start(task, config);
  assert.equal(result.state.status, 'COMPLETED', result.state.summary);
  const change = result.state.openspec!;
  const frontend = JSON.parse(
    await readFile(path.join(result.directory, '1-frontend-planner.request.json'), 'utf8'),
  );
  assert.match(
    frontend.openspec.files.find((file: { path: string }) => file.path === 'design.md').content,
    /POST \/requests/,
  );
  const implementer = JSON.parse(
    await readFile(path.join(result.directory, '1-backend-implementer.request.json'), 'utf8'),
  );
  assert.ok(
    implementer.openspec.files.some((file: { path: string }) => file.path === 'proposal.md'),
  );
  assert.match(
    implementer.openspec.files.find((file: { path: string }) => file.path === 'design.md').content,
    /## Frontend/,
  );
  const afterBackend = trackedTasks(
    await readFile(path.join(result.directory, '1-backend-implementer.openspec/tasks.md'), 'utf8'),
  );
  assert.ok(afterBackend.filter((item) => item.owner === 'backend').every((item) => item.done));
  assert.ok(afterBackend.filter((item) => item.owner !== 'backend').every((item) => !item.done));
  const finalTasks = trackedTasks(
    await readFile(path.join(directory, change.directory, 'tasks.md'), 'utf8'),
  );
  assert.ok(finalTasks.every((item) => item.done));
  assert.equal(await readFile(path.join(directory, 'spec.md'), 'utf8'), '# Test specification\n');
});

for (const area of ['frontend', 'backend'] as const) {
  test(`${area}-only change has a complete design and testing tasks`, async (t) => {
    const { task, config } = await fixture(t);
    task.areas = [area];
    const { state } = await start(task, config);
    assert.equal(state.status, 'COMPLETED', state.summary);
    assert.deepEqual(
      state.results.map((item) => item.role),
      pipeline(task),
    );
    const tasks = trackedTasks(
      await readFile(path.join(state.workdir, state.openspec!.directory, 'tasks.md'), 'utf8'),
    );
    assert.deepEqual(new Set(tasks.map((item) => item.owner)), new Set([area, 'testing']));
  });
}

test('OpenSpec initialization recovers an empty change but never silently reuses published documents', async (t) => {
  const { initializeChange } = await import('../../src/openspec/documents.ts');
  const { writeFile } = await import('node:fs/promises');
  const f = await fixture(t);
  const first = await initializeChange(f.directory, 'recovery');
  const original = await readFile(
    path.join(f.directory, first.directory, '.openspec.yaml'),
    'utf8',
  );
  assert.deepEqual(await initializeChange(f.directory, 'recovery'), first);
  assert.equal(
    await readFile(path.join(f.directory, first.directory, '.openspec.yaml'), 'utf8'),
    original,
  );
  await writeFile(path.join(f.directory, first.directory, 'proposal.md'), '# Existing proposal');
  await assert.rejects(initializeChange(f.directory, 'recovery'), /no saved checkpoint/);
});

test('a preexisting change symlink cannot redirect initialization writes', async (t) => {
  const { initializeChange } = await import('../../src/openspec/documents.ts');
  const { mkdir, symlink, access } = await import('node:fs/promises');
  const f = await fixture(t);
  const outside = path.join(f.directory, 'outside');
  await mkdir(outside);
  await mkdir(path.join(f.directory, 'openspec/changes'), { recursive: true });
  await symlink(outside, path.join(f.directory, 'openspec/changes/task-escape'));
  await assert.rejects(initializeChange(f.directory, 'escape'), /must not be a symlink/);
  await assert.rejects(access(path.join(outside, '.openspec.yaml')));
});
