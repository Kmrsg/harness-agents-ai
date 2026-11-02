import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { start, resume } from '../../src/workflow/lifecycle.ts';
import { readEvents, recordEvent } from '../../src/infrastructure/events.ts';
import { fixture } from '../support/workflow-fixture.ts';

test('event history retains completed roles and checkpoints across clarification resume', async (t) => {
  const { task, config } = await fixture(t);
  task.description += ' [clarify]';
  const first = await start(task, config);
  const before = await readFile(path.join(first.directory, 'events.jsonl'), 'utf8');
  const beforeEvents = await readEvents(first.directory);
  assert.equal(beforeEvents[0].type, 'run.started');
  assert.ok(
    beforeEvents.some((e) => e.type === 'run.status' && e.data.status === 'NEEDS_CLARIFICATION'),
  );
  assert.deepEqual(
    beforeEvents.filter((e) => e.type === 'agent.finished').map((e) => e.data.role),
    first.state.results.map((r) => r.role),
  );
  await resume(first.directory, 'Retain form input and show an error.');
  const text = await readFile(path.join(first.directory, 'events.jsonl'), 'utf8');
  assert.ok(text.startsWith(before));
  const events = await readEvents(first.directory);
  assert.equal(new Set(events.map((e) => e.id)).size, events.length);
  assert.ok(events.every((e) => e.runId === first.state.id && e.timestamp && e.version === 1));
  assert.ok(
    events.some(
      (e) =>
        e.type === 'workflow.started' && e.data.reason === 'clarification' && e.iteration === 2,
    ),
  );
  assert.ok(events.some((e) => e.type === 'checks.finished'));
  assert.ok(
    events.some((e) => e.type === 'verification.decided' && e.data.phase === 'implementation'),
  );
  assert.equal(events.at(-1)?.type, 'run.status');
});

test('failed agent records failure and preserves its raw stdout and stderr', async (t) => {
  const { task, config } = await fixture(t);
  config.runner.args = ['-e', 'console.log("partial");console.error("failed");process.exit(53)'];
  const result = await start(task, config);
  assert.equal(result.state.status, 'BLOCKED');
  const events = await readEvents(result.directory);
  assert.deepEqual(
    events.filter((e) => e.type.startsWith('agent.')).map((e) => e.type),
    ['agent.started', 'agent.failed'],
  );
  const failure = events.find((e) => e.type === 'agent.failed');
  assert.ok(failure?.type === 'agent.failed');
  assert.match(failure.data.error, /turn limit/);
  assert.match(
    await readFile(path.join(result.directory, '1-analyst.stdout.log'), 'utf8'),
    /partial/,
  );
  assert.match(
    await readFile(path.join(result.directory, '1-analyst.stderr.log'), 'utf8'),
    /failed/,
  );
});

test('missing history is compatible with older runs and torn trailing writes are repaired', async (t) => {
  const { directory, task, config } = await fixture(t);
  assert.deepEqual(await readEvents(directory), []);
  const run = await start(task, config);
  const before = await readEvents(run.directory);
  await appendFile(path.join(run.directory, 'events.jsonl'), '{"incomplete":');
  assert.deepEqual(await readEvents(run.directory), before);
  await recordEvent(run.directory, run.state, 'workflow.started', { reason: 'review' });
  const after = await readEvents(run.directory);
  assert.deepEqual(after.slice(0, -1), before);
  assert.equal(after.at(-1)?.type, 'workflow.started');
});

test('an unavailable journal does not rerun agents or change a successful result', async (t) => {
  const { task, config } = await fixture(t);
  const run = await start(task, config);
  const blockedSink = path.join(run.directory, 'unavailable');
  await mkdir(blockedSink);
  await writeFile(path.join(blockedSink, 'events.jsonl'), '');
  // Using a regular file as the directory forces an audit I/O error without platform permissions tricks.
  const previous = run.state.status;
  await recordEvent(path.join(blockedSink, 'events.jsonl'), run.state, 'run.started', {
    taskId: task.id,
  });
  assert.equal(run.state.status, previous);
  assert.match(run.state.integrationErrors.at(-1)!, /Event journal unavailable/);
});

test('read-only violations are detected even when the model returns invalid JSON', async (t) => {
  const { task, config } = await fixture(t);
  const { mutateMock } = await import('../support/workflow-fixture.ts');
  await mutateMock(
    config,
    `if(request.role==='verifier') { await fs.writeFile('unexpected-product-change.txt','changed');console.log('invalid JSON');process.exit(0); }`,
  );
  const run = await start(task, config);
  assert.equal(run.state.status, 'BLOCKED');
  assert.match(run.state.summary, /read-only/);
  const events = await readEvents(run.directory);
  const failure = events.find((e) => e.type === 'agent.failed' && e.data.role === 'verifier');
  assert.ok(failure?.type === 'agent.failed');
  assert.match(failure.data.error, /read-only/);
});
