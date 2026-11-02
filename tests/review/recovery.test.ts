import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, unlink, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fixture, thread } from '../support/review-fixture.ts';
import { watchOnce } from '../../src/review/watcher.ts';
import { retryDelivery } from '../../src/workflow/delivery.ts';
import { continueRun } from '../../src/workflow/continuation.ts';
import { saveState } from '../../src/workflow/state.ts';
import { git } from '../../src/infrastructure/git.ts';

for (const command of ['retry', 'continue'] as const) {
  test(`${command} recovers a temporary push failure after an approved PR correction`, async (t) => {
    const f = await fixture(t);
    const hook = path.join(f.root, 'remote.git/hooks/pre-receive');
    await writeFile(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    f.snapshot.threads.push(thread('[fix] Fix validation.'));
    await f.update();
    const blocked = await watchOnce(f.directory);
    assert.equal(blocked.status, 'BLOCKED');
    assert.equal(blocked.deliveryPending, true);
    assert.ok(blocked.verification?.implementationApproval);
    const requests = (await readdir(f.directory)).filter((file) => file.endsWith('.request.json'));
    await unlink(hook);
    const done =
      command === 'retry' ? await retryDelivery(f.directory) : await continueRun(f.directory);
    assert.equal(done.status, 'WAITING_REVIEW', done.summary);
    assert.equal(done.commit, blocked.commit);
    assert.equal(done.review?.records[0].stage, 'done');
    assert.equal(done.review?.records[0].attempts, 1);
    const remote = await git(done.workdir, [
      'ls-remote',
      '--heads',
      'origin',
      `refs/heads/${done.branch}`,
    ]);
    assert.equal(remote.split(/\s+/)[0], done.commit);
    const calls = await f.readCalls();
    assert.equal(calls.filter((item) => item.operation === 'pull-request.create').length, 1);
    assert.equal(calls.filter((item) => item.operation === 'pull-request.reply').length, 1);
    assert.deepEqual(
      (await readdir(f.directory)).filter((file) => file.endsWith('.request.json')),
      requests,
    );
  });
}

for (const failAt of [2, 3, 4]) {
  test(`a transient PR GET failure at read ${failAt} retries without escalation or consuming a correction`, async (t) => {
    const f = await fixture(t);
    const original = f.state.config.integrations.bitbucket!;
    const wrapper = path.join(f.root, '.harness/flaky-adapter.mjs');
    const counter = path.join(f.root, '.harness/get-count');
    await writeFile(
      wrapper,
      `
      import fs from 'node:fs/promises';import {spawnSync} from 'node:child_process';
      let input='';for await(const c of process.stdin)input+=c;const request=JSON.parse(input);
      if(request.operation==='pull-request.get'){
        const count=Number(await fs.readFile(${JSON.stringify(counter)},'utf8').catch(()=>0))+1;
        await fs.writeFile(${JSON.stringify(counter)},String(count));
        if(count===${failAt}){console.error('Transient connection reset');process.exit(9);}
      }
      const out=spawnSync(${JSON.stringify(original.command)},${JSON.stringify(original.args)},{input,encoding:'utf8'});
      process.stdout.write(out.stdout);process.stderr.write(out.stderr);process.exitCode=out.status??1;
    `,
    );
    f.state.config.integrations.bitbucket = { command: process.execPath, args: [wrapper] };
    await saveState(f.directory, f.state);
    f.snapshot.threads.push(thread('[fix] Fix validation.'));
    await f.update();
    const pending = await watchOnce(f.directory);
    assert.equal(pending.status, 'WAITING_REVIEW', pending.summary);
    assert.ok(
      pending.integrationErrors.some((error) => error.includes('Transient connection reset')),
    );
    assert.equal(pending.review?.records.length, 0);
    const done = await watchOnce(f.directory);
    assert.equal(done.status, 'WAITING_REVIEW', done.summary);
    assert.equal(done.review?.records.length, 1);
    assert.equal(done.review?.records[0].stage, 'done');
    assert.equal(done.review?.records[0].attempts, 1);
    const calls = await f.readCalls();
    assert.equal(calls.filter((item) => item.operation === 'pull-request.reply').length, 1);
  });
}

test('retry-delivery recognizes an approved PR push whose expectedHead update was lost', async (t) => {
  const f = await fixture(t);
  const originalHead = f.state.review!.expectedHead;
  f.snapshot.threads.push(thread('[fix] Fix validation.'));
  await f.update();
  const state = await watchOnce(f.directory);
  assert.equal(state.status, 'WAITING_REVIEW', state.summary);
  state.status = 'BLOCKED';
  state.deliveryPending = true;
  state.checkpoint!.stage = 'delivery';
  state.checkpoint!.head = originalHead;
  state.review!.expectedHead = originalHead;
  state.review!.records[0].stage = 'fixing';
  state.review!.records[0].response = 'Reviewed AC-1.';
  await saveState(f.directory, state);
  const count = state.results.length;
  const published = state.commit;
  const done = await retryDelivery(f.directory);
  assert.equal(done.status, 'WAITING_REVIEW', done.summary);
  assert.equal(done.commit, published);
  assert.equal(done.review!.expectedHead, published);
  assert.equal(done.review!.records[0].stage, 'done');
  assert.equal(done.results.length, count);
});
