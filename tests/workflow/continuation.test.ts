import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { execute } from '../../src/infrastructure/process.ts';
import { readState, saveState, acquireRunLock } from '../../src/workflow/state.ts';
import { continueRun } from '../../src/workflow/continuation.ts';
import { start } from '../../src/workflow/lifecycle.ts';
import { fixture } from '../support/workflow-fixture.ts';
import { interruptionFixture, cli, until } from '../support/interruption-fixture.ts';

async function invocations(file: string) {
  return (await readFile(file, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}

test('SIGINT preserves the Git worktree and continues only the interrupted role with restored context', async (t) => {
  const f = await interruptionFixture(t, "request.role==='frontend-implementer'");
  const run = await f.begin();
  const before = await readState(run.runDirectory);
  const active = await execute(cli('continue', run.id), f.directory);
  assert.equal(active.exitCode, 1);
  assert.match(active.stderr, /active process/);
  assert.deepEqual(await readState(run.runDirectory), before);
  run.child.kill('SIGINT');
  await run.finished;
  const stopped = await readState(run.runDirectory);
  assert.equal(stopped.status, 'BLOCKED');
  assert.equal(stopped.interrupted, true);
  assert.equal(stopped.checkpoint?.stage, 'implementation');
  const done = await execute(cli('continue', run.id), f.directory);
  assert.equal(done.exitCode, 0, done.stderr + done.stdout);
  const final = await readState(run.runDirectory);
  assert.equal(final.status, 'COMPLETED', final.summary);
  assert.equal(final.workdir, stopped.workdir);
  assert.equal(final.branch, stopped.branch);
  assert.equal(final.iteration, 1);
  assert.deepEqual(final.verification?.retries, { plan: 0, implementation: 0 });
  const calls = await invocations(f.calls);
  assert.equal(calls.filter((item) => item.role === 'analyst').length, 1);
  assert.equal(calls.filter((item) => item.role === 'backend-implementer').length, 1);
  assert.equal(calls.filter((item) => item.role === 'frontend-implementer').length, 2);
  assert.equal(
    await readFile(path.join(final.workdir, 'partial-change.txt'), 'utf8'),
    'Preserve interrupted work',
  );
  const request = JSON.parse(
    await readFile(
      path.join(run.runDirectory, '1-frontend-implementer-attempt-2.request.json'),
      'utf8',
    ),
  );
  assert.ok(request.context.some((item: { role: string }) => item.role === 'backend-implementer'));
  assert.ok(
    await readFile(path.join(run.runDirectory, '1-frontend-implementer.request.json'), 'utf8'),
  );
  assert.equal(final.checkpoint?.stage, 'done');
});

test('hard-killed owner is recovered but a surviving child group prevents concurrent writes', async (t) => {
  const f = await interruptionFixture(t, "request.role==='frontend-implementer'");
  const run = await f.begin();
  run.child.kill('SIGKILL');
  await run.finished;
  assert.equal((await readState(run.runDirectory)).status, 'RUNNING');
  const refused = await execute(cli('continue', run.id), f.directory);
  assert.equal(refused.exitCode, 1);
  assert.match(refused.stderr, /Child process group .*still active/);
  process.kill(-run.paused.pid, 'SIGKILL');
  await until(async () => {
    try {
      process.kill(-run.paused.pid, 0);
      return undefined;
    } catch {
      return true;
    }
  });
  const done = await execute(cli('continue', run.id), f.directory);
  assert.equal(done.exitCode, 0, done.stderr + done.stdout);
  assert.equal((await readState(run.runDirectory)).status, 'COMPLETED');
});

for (const mode of ['checks', 'setup'] as const) {
  test(`interrupted ${mode} repeats the incomplete command without restarting completed roles`, async (t) => {
    const f = await interruptionFixture(t, 'true', mode);
    const run = await f.begin();
    run.child.kill('SIGINT');
    await run.finished;
    const stopped = await readState(run.runDirectory);
    assert.equal(stopped.interrupted, true);
    assert.equal(stopped.status, 'BLOCKED');
    const roleCount = stopped.results.length;
    const done = await execute(cli('continue', run.id), f.directory);
    assert.equal(done.exitCode, 0, done.stderr + done.stdout);
    const state = await readState(run.runDirectory);
    assert.equal(state.status, 'COMPLETED', state.summary);
    assert.equal(state.results.filter((item) => item.role === 'analyst').length, 1);
    if (mode === 'checks') {
      assert.equal(state.results.length, roleCount + 1); // Only the final verifier remained.
      assert.equal(state.results.filter((item) => item.role === 'tester').length, 1);
    } else assert.equal(state.preparation?.attempts[0], 2);
    assert.equal((await invocations(f.calls)).length, 2);
  });
}

test('continuation preserves rework counters and does not rerun the planners', async (t) => {
  const f = await interruptionFixture(
    t,
    "request.role==='backend-implementer' && request.rework?.phase==='implementation'",
  );
  f.task.description += ' [rework-implementation-once]';
  await writeFile(path.join(f.directory, 'task.json'), JSON.stringify(f.task));
  const run = await f.begin();
  run.child.kill('SIGINT');
  await run.finished;
  assert.equal((await readState(run.runDirectory)).verification?.retries.implementation, 1);
  const final = await continueRun(run.runDirectory);
  assert.equal(final.status, 'COMPLETED', final.summary);
  assert.equal(final.verification?.retries.implementation, 1);
  const calls = await invocations(f.calls);
  assert.equal(calls.filter((item) => item.role === 'backend-planner').length, 1);
  assert.equal(calls.filter((item) => item.role === 'backend-implementer').length, 3);
});

test('changed approved plan is refused before another model invocation', async (t) => {
  const f = await interruptionFixture(t, "request.role==='frontend-implementer'");
  const run = await f.begin();
  run.child.kill('SIGINT');
  await run.finished;
  const state = await readState(run.runDirectory);
  const design = path.join(state.workdir, state.openspec!.directory, 'design.md');
  await writeFile(design, (await readFile(design, 'utf8')) + '\nUnreviewed contract change.\n');
  const before = (await invocations(f.calls)).length;
  await assert.rejects(continueRun(run.runDirectory), /Approved plan changed/);
  assert.equal((await invocations(f.calls)).length, before);
});

test('continue refuses questions, escalation, completed and legacy runs; unknown locks are not stolen', async (t) => {
  const f = await fixture(t);
  f.task.description += ' [clarify]';
  const run = await start(f.task, f.config);
  await assert.rejects(continueRun(run.directory), /Use resume with answers/);
  const state = await readState(run.directory);
  state.status = 'BLOCKED';
  state.escalation = {
    to: 'developer',
    phase: 'plan',
    reason: 'Budget exhausted',
    artifact: 'escalation.md',
  };
  await saveState(run.directory, state);
  await assert.rejects(continueRun(run.directory), /cannot be bypassed/);
  state.escalation = undefined;
  state.status = 'COMPLETED';
  await saveState(run.directory, state);
  await assert.rejects(continueRun(run.directory), /already COMPLETED/);
  state.status = 'RUNNING';
  delete state.checkpoint;
  delete state.preparation;
  await saveState(run.directory, state);
  await assert.rejects(continueRun(run.directory), /Legacy run/);
  await writeFile(path.join(run.directory, 'run.lock'), '');
  await assert.rejects(acquireRunLock(run.directory, true), /Unknown run.lock owner/);
});

test('list shows saved runs and damaged state files without changing them', async (t) => {
  const f = await fixture(t);
  const { git } = await import('../../src/infrastructure/git.ts');
  await git(f.directory, ['init']);
  const empty = await execute(cli('list'), f.directory);
  assert.deepEqual(JSON.parse(empty.stdout), []);
  f.task.description += ' [clarify]';
  const run = await start(f.task, f.config);
  const broken = path.join(f.directory, '.harness/runs/broken');
  await mkdir(broken);
  await writeFile(path.join(broken, 'state.json'), '{broken');
  const before = await readFile(path.join(run.directory, 'state.json'), 'utf8');
  const output = await execute(cli('list'), f.directory);
  assert.equal(output.exitCode, 0, output.stderr);
  const entries = JSON.parse(output.stdout);
  assert.equal(entries[0].id, run.state.id);
  assert.equal(entries[0].taskId, 'TEST-1');
  assert.equal(entries[0].status, 'NEEDS_CLARIFICATION');
  assert.match(entries[1].error, /SyntaxError/);
  assert.equal(await readFile(path.join(run.directory, 'state.json'), 'utf8'), before);
});

for (const changed of [false, true]) {
  test(`interrupted PR correction ${changed ? 'rejects a changed discussion' : 'continues in the same branch and replies once'}`, async (t) => {
    const { fixture: reviewFixture, thread } = await import('../support/review-fixture.ts');
    const { spawn } = await import('node:child_process');
    const { runtimeScript } = await import('../../src/infrastructure/package-paths.ts');
    const f = await reviewFixture(t);
    f.snapshot.threads.push(thread('[fix] Handle validation failure.'));
    await f.update();
    const marker = path.join(f.root, '.harness/pr-pause.json');
    const runner = path.join(f.root, '.harness/pr-runner.mjs');
    await writeFile(
      runner,
      `
      import fs from 'node:fs/promises';import {spawnSync} from 'node:child_process';
      let input='';for await(const c of process.stdin)input+=c;const request=JSON.parse(input);
      if(request.role==='frontend-implementer' && !(await fs.access(${JSON.stringify(marker)}).then(()=>true,()=>false))) {
        await fs.writeFile(${JSON.stringify(marker)},JSON.stringify({pid:process.pid}));
        await new Promise(()=>setInterval(()=>{},1000));
      }
      const result=spawnSync(process.execPath,[${JSON.stringify(runtimeScript('mock-agent'))}],{input,encoding:'utf8'});
      process.stdout.write(result.stdout);process.stderr.write(result.stderr);process.exitCode=result.status??1;
    `,
    );
    f.state.config.runner = { command: process.execPath, args: [runner] };
    await saveState(f.directory, f.state);
    const command = cli('watch', f.state.id);
    const child = spawn(command.command, command.args, { cwd: f.root, stdio: 'ignore' });
    const finished = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    });
    await until(async () => {
      try {
        return JSON.parse(await readFile(marker, 'utf8'));
      } catch {
        return undefined;
      }
    });
    child.kill('SIGINT');
    await finished;
    const stopped = await readState(f.directory);
    assert.equal(stopped.interrupted, true, stopped.summary);
    assert.equal(stopped.review?.records[0].stage, 'fixing');
    if (changed) {
      f.snapshot.threads[0].comments[0].body += ' New requirement.';
      await f.update();
      await assert.rejects(continueRun(f.directory), /discussion changed/);
    } else {
      const state = await continueRun(f.directory);
      assert.equal(state.status, 'WAITING_REVIEW', state.summary);
      assert.equal(state.branch, f.state.branch);
      assert.equal(state.review?.records[0].stage, 'done');
      assert.equal(state.review?.records[0].attempts, 1);
      assert.equal(state.results.filter((item) => item.role === 'analyst').length, 1);
      const calls = await f.readCalls();
      assert.equal(calls.filter((item) => item.operation === 'pull-request.create').length, 1);
      assert.equal(calls.filter((item) => item.operation === 'pull-request.reply').length, 1);
    }
  });
}

test('continue reuses a completed role saved before the workflow cursor advanced', async (t) => {
  const f = await fixture(t);
  const run = await start(f.task, f.config);
  const state = run.state;
  state.status = 'RUNNING';
  state.checkpoint!.stage = 'implementation-review';
  state.checkpoint!.resultIndex = state.results.length - 1;
  state.checkpoint!.checkStart = 0;
  state.checkpoint!.active = undefined;
  state.deliveryPending = false;
  const before = state.results.length;
  await saveState(run.directory, state);
  const done = await continueRun(run.directory);
  assert.equal(done.status, 'COMPLETED', done.summary);
  assert.equal(done.results.length, before);
});

test('interrupted read-only reviewer cannot bless modified product files on continuation', async (t) => {
  const f = await fixture(t);
  const run = await start(f.task, f.config);
  const state = run.state;
  state.status = 'RUNNING';
  state.checkpoint!.stage = 'implementation-review';
  state.checkpoint!.active = {
    role: 'verifier',
    phase: 'implementation',
    readOnlyFingerprint: state.checkpoint!.workspace,
  };
  await writeFile(path.join(state.workdir, 'unauthorized.txt'), 'Reviewer changed product code');
  await saveState(run.directory, state);
  await assert.rejects(continueRun(run.directory), /Read-only role modified/);
});

test('saved PR repair intent survives a crash before its workflow starts', async (t) => {
  const { fixture: reviewFixture, thread } = await import('../support/review-fixture.ts');
  const { threadFingerprint } = await import('../../src/review/identity.ts');
  const f = await reviewFixture(t);
  const discussion = thread('[fix] Handle errors.');
  f.snapshot.threads.push(discussion);
  await f.update();
  f.state.review!.records.push({
    threadId: discussion.id,
    fingerprint: threadFingerprint(discussion),
    attempts: 1,
    stage: 'fixing',
    response: 'Error handling does not meet AC-1.',
    repair: {
      iteration: f.state.iteration + 1,
      phase: 'implementation',
      finding: {
        id: 'PR-INTENT',
        description: 'Fix errors',
        evidence: 'AC-1',
        criteria: ['AC-1'],
        tasks: [],
      },
      prReview: { thread: discussion, sourceCommit: f.state.review!.expectedHead },
    },
  });
  await saveState(f.directory, f.state);
  const done = await continueRun(f.directory);
  assert.equal(done.status, 'WAITING_REVIEW', done.summary);
  assert.equal(done.iteration, 2);
  assert.equal(done.review?.records[0].stage, 'done');
  assert.equal(done.review?.records[0].attempts, 1);
  assert.equal(done.results.filter((item) => item.role === 'analyst').length, 1);
});

test('interrupted PR creation continues delivery without calling the roles again', async (t) => {
  const { fixture: reviewFixture } = await import('../support/review-fixture.ts');
  const { spawn } = await import('node:child_process');
  const f = await reviewFixture(t);
  const marker = path.join(f.root, '.harness/delivery-pause.json');
  const adapter = path.join(f.root, '.harness/delivery-adapter.mjs');
  const original = f.state.config.integrations.bitbucket!;
  await writeFile(
    adapter,
    `
    import fs from 'node:fs/promises';import {spawnSync} from 'node:child_process';
    let input='';for await(const c of process.stdin)input+=c;const request=JSON.parse(input);
    if(request.operation==='pull-request.create' && !(await fs.access(${JSON.stringify(marker)}).then(()=>true,()=>false))) {
      await fs.writeFile(${JSON.stringify(marker)},'paused');await new Promise(()=>setInterval(()=>{},1000));
    }
    const result=spawnSync(${JSON.stringify(original.command)},${JSON.stringify(original.args)},{input,encoding:'utf8'});
    process.stdout.write(result.stdout);process.stderr.write(result.stderr);process.exitCode=result.status??1;
  `,
  );
  const { projectRoot: _root, ...settings } = f.state.config;
  settings.integrations = { bitbucket: { command: process.execPath, args: [adapter] } };
  await writeFile(path.join(f.root, 'harness.config.json'), JSON.stringify(settings));
  await writeFile(path.join(f.root, 'task.json'), JSON.stringify(f.state.task));
  const command = cli('run', 'task.json');
  const child = spawn(command.command, command.args, { cwd: f.root, stdio: 'ignore' });
  const finished = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });
  await until(async () => {
    try {
      await readFile(marker);
      return true;
    } catch {
      return undefined;
    }
  });
  child.kill('SIGINT');
  await finished;
  const listed = JSON.parse((await execute(cli('list'), f.root)).stdout);
  const directory = listed.find((item: { id: string }) => item.id !== f.state.id).runDirectory;
  const stopped = await readState(directory);
  assert.equal(stopped.interrupted, true, stopped.summary);
  assert.equal(stopped.deliveryPending, true);
  const done = await continueRun(directory);
  assert.equal(done.status, 'WAITING_REVIEW', done.summary);
  assert.equal(done.commit, stopped.commit);
  assert.equal(done.results.length, stopped.results.length);
  assert.equal(done.checkpoint?.stage, 'done');
});

test('a delivery commit made before its state update is reconciled without a duplicate commit', async (t) => {
  const f = await interruptionFixture(t, 'false');
  const { git } = await import('../../src/infrastructure/git.ts');
  const run = await start(f.task, f.config);
  assert.equal(run.state.status, 'COMPLETED', run.state.summary);
  const state = run.state;
  const committed = state.commit;
  state.status = 'RUNNING';
  state.deliveryPending = true;
  state.commit = undefined;
  state.checkpoint!.stage = 'delivery';
  state.checkpoint!.head = await git(state.workdir, ['rev-parse', 'HEAD^']);
  await saveState(run.directory, state);
  const done = await continueRun(run.directory);
  assert.equal(done.status, 'COMPLETED', done.summary);
  assert.equal(done.commit, committed);
  assert.equal(await git(done.workdir, ['rev-list', '--count', 'HEAD']), '2');
});

test('continue reconciles an approved PR push accepted before expectedHead was saved', async (t) => {
  const { fixture: reviewFixture, thread } = await import('../support/review-fixture.ts');
  const { watchOnce } = await import('../../src/review/watcher.ts');
  const f = await reviewFixture(t);
  const oldHead = f.state.review!.expectedHead;
  f.snapshot.threads.push(thread('[fix] Validate input.'));
  await f.update();
  const state = await watchOnce(f.directory);
  assert.equal(state.status, 'WAITING_REVIEW', state.summary);
  const published = state.commit;
  state.status = 'RUNNING';
  state.deliveryPending = true;
  state.checkpoint!.stage = 'delivery';
  state.checkpoint!.head = oldHead;
  state.review!.expectedHead = oldHead;
  state.review!.records[0].stage = 'fixing';
  state.review!.records[0].response = 'AC-1 validated.';
  await saveState(f.directory, state);
  const count = state.results.length;
  const done = await continueRun(f.directory);
  assert.equal(done.status, 'WAITING_REVIEW', done.summary);
  assert.equal(done.commit, published);
  assert.equal(done.review!.expectedHead, published);
  assert.equal(done.results.length, count);
  assert.equal(done.review!.records[0].stage, 'done');
});
