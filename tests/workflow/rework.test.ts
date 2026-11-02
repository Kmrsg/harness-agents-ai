import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { start, resume } from '../../src/workflow/lifecycle.ts';
import { trackedTasks } from '../../src/openspec/validation.ts';
import { fixture, mutateMock } from '../support/workflow-fixture.ts';

test('verifier returns plan to planners with feedback and implementation starts only after approval', async (t) => {
  const { task, config } = await fixture(t);
  task.description += ' [rework-plan-once]';
  await mutateMock(
    config,
    `if(request.role==='backend-planner' && request.rework?.phase==='plan'){
    const file=path.join(request.openspec.draftDirectory,'tasks.md');
    await fs.writeFile(file,(await fs.readFile(file,'utf8')).replace('Implement AC-1','Implement AC-1 with corrected validation'));
  }`,
  );
  const { directory, state } = await start(task, config);
  assert.equal(state.status, 'COMPLETED', state.summary);
  assert.deepEqual(state.verification?.retries, { plan: 1, implementation: 0 });
  assert.equal(state.results.filter((item) => item.role === 'analyst').length, 1);
  const reviews = state.results.filter((item) => item.phase === 'plan');
  assert.deepEqual(
    reviews.map((item) => item.result.verification?.verdict),
    ['REWORK_PLAN', 'APPROVED'],
  );
  const firstImplementer = state.results.findIndex((item) => item.role.endsWith('-implementer'));
  assert.ok(
    state.results
      .slice(0, firstImplementer)
      .some((item) => item.result.verification?.verdict === 'APPROVED'),
  );
  const request = JSON.parse(
    await readFile(path.join(directory, '1-backend-planner-attempt-2.request.json'), 'utf8'),
  );
  assert.equal(request.rework.findings[0].id, 'V1');
  assert.match(
    await readFile(path.join(state.workdir, state.openspec!.directory, 'tasks.md'), 'utf8'),
    /corrected validation/,
  );
});

test('implementation rework reruns implementers and tester, preserving approved plan', async (t) => {
  const { task, config } = await fixture(t);
  task.description += ' [rework-implementation-once]';
  await mutateMock(
    config,
    `if(request.role==='backend-implementer' && request.rework?.phase==='implementation')await fs.writeFile('fixed.txt','corrected implementation');`,
  );
  const { directory, state } = await start(task, config);
  assert.equal(state.status, 'COMPLETED', state.summary);
  assert.deepEqual(state.verification?.retries, { plan: 0, implementation: 1 });
  assert.equal(state.results.filter((item) => item.role === 'backend-planner').length, 1);
  assert.equal(state.results.filter((item) => item.role === 'tester').length, 2);
  assert.equal(
    await readFile(path.join(state.workdir, 'fixed.txt'), 'utf8'),
    'corrected implementation',
  );
  const request = JSON.parse(
    await readFile(path.join(directory, '1-backend-implementer-attempt-2.request.json'), 'utf8'),
  );
  assert.equal(request.rework.phase, 'implementation');
  const tasks = request.openspec.files.find(
    (file: { path: string }) => file.path === 'tasks.md',
  ).content;
  assert.ok(trackedTasks(tasks).every((item) => !item.done));
});

test('implementation verifier can return an incorrect design to planning', async (t) => {
  const { task, config } = await fixture(t);
  task.description += ' [implementation-to-plan-once]';
  const { state } = await start(task, config);
  assert.equal(state.status, 'COMPLETED', state.summary);
  assert.deepEqual(state.verification?.retries, { plan: 1, implementation: 0 });
  assert.equal(state.results.filter((item) => item.role === 'backend-planner').length, 2);
  assert.equal(state.results.filter((item) => item.role === 'backend-implementer').length, 2);
  const reviews = state.results.filter((item) => item.role === 'verifier');
  assert.deepEqual(
    reviews.map((item) => [item.phase, item.result.verification?.verdict]),
    [
      ['plan', 'APPROVED'],
      ['implementation', 'REWORK_PLAN'],
      ['plan', 'APPROVED'],
      ['implementation', 'APPROVED'],
    ],
  );
});

test('repair budgets survive clarification and do not reset on resume', async (t) => {
  const { task, config } = await fixture(t);
  task.description += ' [rework-plan-once]';
  await mutateMock(
    config,
    `if(request.role==='frontend-planner' && request.rework?.phase==='plan' && !request.clarificationHistory.length){
    result.status='NEEDS_CLARIFICATION';result.questions=[{id:'Q1',question:'Which error state?',context:'Error behavior is ambiguous',blocks:'UI design'}];
    const report=path.join(request.artifactDirectory,'clarification.md');
    await fs.writeFile(report,'# Clarification\\n\\n## Summary\\nNeed product clarification.\\n\\n## Questions\\nQ1: Which error state?\\n\\n## Investigated\\nRead the current spec and code.\\n\\n## Blocked Work\\nUI design awaits an answer.\\n');
    result.artifacts.push(report);
  }`,
  );
  const first = await start(task, config);
  assert.equal(first.state.status, 'NEEDS_CLARIFICATION');
  assert.equal(first.state.verification?.retries.plan, 1);
  const final = await resume(first.directory, 'Show an error and preserve input.');
  assert.equal(final.status, 'COMPLETED', final.summary);
  assert.equal(final.verification?.retries.plan, 2);
});
