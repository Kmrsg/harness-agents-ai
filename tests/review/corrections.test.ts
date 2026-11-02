import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { saveState } from '../../src/workflow/state.ts';
import { watchOnce } from '../../src/review/watcher.ts';
import { git } from '../../src/infrastructure/git.ts';
import { fixture, thread, triages } from '../support/review-fixture.ts';

test('valid implementation finding reruns implementers, tester and verifier, pushes to the same PR', async (t) => {
  const f = await fixture(t);
  f.snapshot.threads.push(thread('[fix] Invalid save error handling'));
  await f.update();
  const state = await watchOnce(f.directory);
  assert.equal(state.status, 'WAITING_REVIEW', state.summary);
  assert.notEqual(state.commit, f.state.commit);
  assert.equal(state.review!.expectedHead, state.commit);
  assert.match(
    await readFile(path.join(state.workdir, 'mock-review-fix.txt'), 'utf8'),
    /Invalid save/,
  );
  const requests = await readdir(f.directory);
  assert.ok(requests.includes('2-frontend-implementer.request.json'));
  assert.ok(requests.includes('2-tester.request.json'));
  assert.ok(requests.includes('2-verifier-implementation.request.json'));
  assert.ok(!requests.includes('2-analyst.request.json'));
  assert.ok(!requests.includes('2-frontend-planner.request.json'));
  const calls = await f.readCalls();
  assert.equal(calls.filter((c) => c.operation === 'pull-request.create').length, 1);
  const response = calls.find((c) => c.operation === 'pull-request.reply');
  assert.match(response.payload.body, new RegExp(state.commit!));
  assert.equal(await git(state.workdir, ['rev-parse', 'HEAD']), state.commit);
  await watchOnce(f.directory);
  assert.equal((await triages(f.directory)).length, 1);
});

test('plan finding reruns both planners and verifier before implementing', async (t) => {
  const f = await fixture(t);
  f.snapshot.threads.push(thread('[fix-plan] Correct the API contract'));
  await f.update();
  const state = await watchOnce(f.directory);
  assert.equal(state.status, 'WAITING_REVIEW', state.summary);
  const requests = await readdir(f.directory);
  assert.ok(requests.includes('2-backend-planner.request.json'));
  assert.ok(requests.includes('2-frontend-planner.request.json'));
  assert.ok(requests.includes('2-verifier-plan.request.json'));
  assert.ok(requests.includes('2-verifier-implementation.request.json'));
});

test('two attempts per thread persist across polls and edited comments', async (t) => {
  const f = await fixture(t);
  f.snapshot.threads.push(thread('[fix] First'));
  await f.update();
  assert.equal((await watchOnce(f.directory)).status, 'WAITING_REVIEW');
  f.snapshot.threads[0].comments[0].body = '[fix] Second';
  await f.update();
  assert.equal((await watchOnce(f.directory)).status, 'WAITING_REVIEW');
  f.snapshot.threads[0].comments[0].body = '[fix] Third';
  await f.update();
  const final = await watchOnce(f.directory);
  assert.equal(final.status, 'BLOCKED');
  assert.match(final.summary, /two correction attempts exhausted/);
  assert.equal(
    final.review!.records.reduce((n, r) => n + r.attempts, 0),
    2,
  );
});

test('failed checks during PR repair never publish a success reply or push a new commit', async (t) => {
  const f = await fixture(t);
  f.snapshot.threads.push(thread('[fix] Change'));
  await f.update();
  f.state.config.checks[0].args = ['-e', 'process.exit(7)'];
  await saveState(f.directory, f.state);
  const state = await watchOnce(f.directory);
  assert.equal(state.status, 'BLOCKED', state.summary);
  assert.equal(state.commit, f.state.commit);
  assert.equal((await f.readCalls()).filter((c) => c.operation === 'pull-request.reply').length, 0);
});
