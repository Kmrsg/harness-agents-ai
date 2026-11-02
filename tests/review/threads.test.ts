import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { watchOnce } from '../../src/review/watcher.ts';
import { fixture, thread, triages } from '../support/review-fixture.ts';

test('reply is deduplicated, own replies do not trigger triage, edited human comments do', async (t) => {
  const f = await fixture(t);
  f.snapshot.threads.push(thread('Explain the current behavior'));
  await f.update();
  assert.equal((await watchOnce(f.directory)).status, 'WAITING_REVIEW');
  await watchOnce(f.directory);
  f.snapshot.threads[0].comments.push({ id: 'B1', author: 'Harness', body: 'Response', own: true });
  await f.update();
  await watchOnce(f.directory);
  assert.equal((await f.readCalls()).filter((c) => c.operation === 'pull-request.reply').length, 1);
  assert.equal((await triages(f.directory)).length, 1);
  f.snapshot.threads[0].comments[0].body = 'Edited question';
  await f.update();
  await watchOnce(f.directory);
  assert.equal((await f.readCalls()).filter((c) => c.operation === 'pull-request.reply').length, 2);
});

test('lost reply response is retried with the same idempotency key without rerunning models', async (t) => {
  const f = await fixture(t);
  f.snapshot.threads.push(thread('Question'));
  await f.update();
  await writeFile(path.join(f.root, 'fail-reply'), 'yes');
  const first = await watchOnce(f.directory);
  assert.equal(first.status, 'WAITING_REVIEW');
  assert.equal(first.review!.records[0].stage, 'reply');
  await unlink(path.join(f.root, 'fail-reply'));
  await watchOnce(f.directory);
  const replies = (await f.readCalls()).filter((c) => c.operation === 'pull-request.reply');
  assert.equal(replies.length, 2);
  assert.deepEqual(replies[0].payload, replies[1].payload);
  assert.equal((await triages(f.directory)).length, 1);
});

test('clarification replies ask the reviewer and new human answers are triaged', async (t) => {
  const f = await fixture(t);
  f.snapshot.threads.push(thread('[question] Change product behavior'));
  await f.update();
  const first = await watchOnce(f.directory);
  assert.equal(first.status, 'WAITING_REVIEW');
  assert.match(first.summary, /Clarification/);
  assert.equal(first.review!.records[0].attempts, 0);
  f.snapshot.threads[0].comments.push({
    id: 'C2',
    author: 'Reviewer',
    body: 'Keep existing behavior',
    own: false,
  });
  await f.update();
  await watchOnce(f.directory);
  assert.equal((await triages(f.directory)).length, 2);
});

test('several threads are handled in one poll without another PR', async (t) => {
  const f = await fixture(t);
  f.snapshot.threads.push(thread('[fix] First change'), {
    ...thread('Explain behavior'),
    id: 'T2',
  });
  await f.update();
  const result = await watchOnce(f.directory);
  assert.equal(result.status, 'WAITING_REVIEW', result.summary);
  assert.equal(result.review!.records.length, 2);
  assert.equal((await f.readCalls()).filter((c) => c.operation === 'pull-request.reply').length, 2);
  assert.equal(
    (await f.readCalls()).filter((c) => c.operation === 'pull-request.create').length,
    1,
  );
});

test('an edited pending discussion supersedes its old reply and is triaged again', async (t) => {
  const f = await fixture(t);
  f.snapshot.threads.push(thread('Original question'));
  await f.update();
  await writeFile(path.join(f.root, 'fail-reply'), 'yes');
  await watchOnce(f.directory);
  await unlink(path.join(f.root, 'fail-reply'));
  f.snapshot.threads[0].comments[0].body = 'Different question';
  await f.update();
  const superseded = await watchOnce(f.directory);
  assert.equal(superseded.review!.records[0].stage, 'superseded');
  assert.equal((await f.readCalls()).filter((c) => c.operation === 'pull-request.reply').length, 1);
  await watchOnce(f.directory);
  assert.equal((await triages(f.directory)).length, 2);
  assert.equal((await f.readCalls()).filter((c) => c.operation === 'pull-request.reply').length, 2);
});

test('resolved and deleted discussions never receive a pending reply', async (t) => {
  for (const change of ['resolved', 'deleted']) {
    const f = await fixture(t);
    f.snapshot.threads.push(thread('Question'));
    await f.update();
    await writeFile(path.join(f.root, 'fail-reply'), 'yes');
    await watchOnce(f.directory);
    await unlink(path.join(f.root, 'fail-reply'));
    if (change === 'resolved') f.snapshot.threads[0].resolved = true;
    else f.snapshot.threads = [];
    await f.update();
    const state = await watchOnce(f.directory);
    assert.equal(state.review!.records[0].stage, 'superseded');
    assert.equal(
      (await f.readCalls()).filter((c) => c.operation === 'pull-request.reply').length,
      1,
    );
  }
});
