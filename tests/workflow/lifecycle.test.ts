import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { start, resume } from '../../src/workflow/lifecycle.ts';
import { pipeline } from '../../src/workflow/pipeline.ts';
import { fixture } from '../support/workflow-fixture.ts';

test('all roles hand artifacts forward and mandatory checks gate completion', async (t) => {
  const { task, config } = await fixture(t);
  const result = await start(task, config);
  assert.equal(result.state.status, 'COMPLETED', result.state.summary);
  assert.deepEqual(
    result.state.results.map((r) => r.role),
    pipeline(task),
  );
  const request = JSON.parse(
    await readFile(path.join(result.directory, '1-frontend-implementer.request.json'), 'utf8'),
  );
  assert.ok(
    request.context
      .find((c: { role: string }) => c.role === 'backend-implementer')
      .contents[0].content.includes('MOCK'),
  );
  assert.equal(result.state.checks[0].exitCode, 0);
});

test('planner clarification stops implementers and resumes through analyst with answers', async (t) => {
  const { task, config } = await fixture(t);
  task.description += ' [clarify]';
  const first = await start(task, config);
  assert.equal(first.state.status, 'NEEDS_CLARIFICATION');
  assert.equal(first.state.nextRole, 'analyst');
  assert.deepEqual(
    first.state.results.map((r) => r.role),
    ['analyst', 'backend-planner', 'frontend-planner'],
  );
  assert.match(await readFile(path.join(first.directory, 'clarification-1.md'), 'utf8'), /Q1/);
  const final = await resume(first.directory, 'Retain input and show an error.');
  assert.equal(final.status, 'COMPLETED', final.summary);
  const analyst = JSON.parse(
    await readFile(path.join(first.directory, '2-analyst.request.json'), 'utf8'),
  );
  assert.equal(analyst.clarificationHistory[0].answer, 'Retain input and show an error.');
  assert.ok((await readdir(first.directory)).includes('1-frontend-planner.result.json'));
  assert.match(
    analyst.openspec.files.find((file: { path: string }) => file.path === 'design.md').content,
    /Backend/,
  );
  const refreshed = await readFile(
    path.join(first.directory, '2-analyst.openspec/specs/mock-feature/spec.md'),
    'utf8',
  );
  assert.match(refreshed, /Retain input and show an error/);
  assert.ok(
    !(await readdir(path.join(first.directory, '2-analyst.openspec'))).includes('design.md'),
  );
  assert.match(
    await readFile(path.join(first.directory, '1-backend-planner.openspec/tasks.md'), 'utf8'),
    /- \[ \] 1.1 \[backend\]/,
  );
  await assert.rejects(resume(first.directory, 'Again'), /Only NEEDS_CLARIFICATION/);
});

test('clarification retry budget is enforced', async (t) => {
  const { task, config } = await fixture(t);
  task.description += ' [clarify]';
  config.maxIterations = 1;
  const { directory } = await start(task, config);
  await assert.rejects(resume(directory, 'Answer'), /iteration limit/);
});

test('failed runner leaves logs and blocks downstream stages', async (t) => {
  const { task, config } = await fixture(t);
  config.runner.args = [
    '-e',
    'console.log("partial response");console.error("budget limit");process.exit(53)',
  ];
  const result = await start(task, config);
  assert.equal(result.state.status, 'BLOCKED');
  assert.match(result.state.summary, /turn limit exhausted/);
  assert.match(
    await readFile(path.join(result.directory, '1-analyst.stderr.log'), 'utf8'),
    /budget limit/,
  );
  assert.equal(result.state.results.length, 0);
});

test('concurrent clarification resumes cannot overwrite the completed run', async (t) => {
  const { task, config } = await fixture(t);
  task.description += ' [clarify]';
  const first = await start(task, config);
  const results = await Promise.allSettled([
    resume(first.directory, 'Preserve form input.'),
    resume(first.directory, 'Preserve form input.'),
  ]);
  assert.equal(results.filter((item) => item.status === 'fulfilled').length, 1);
  assert.equal(results.filter((item) => item.status === 'rejected').length, 1);
  const state = JSON.parse(await readFile(path.join(first.directory, 'state.json'), 'utf8'));
  assert.equal(state.status, 'COMPLETED');
  assert.equal(state.iteration, 2);
});
