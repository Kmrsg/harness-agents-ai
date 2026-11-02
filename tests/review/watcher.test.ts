import { test } from 'node:test';
import assert from 'node:assert/strict';
import { watchOnce } from '../../src/review/watcher.ts';
import { fixture, thread, triages } from '../support/review-fixture.ts';

test('idle polls invoke no models; own and resolved threads are ignored; merge completes', async (t) => {
  const f = await fixture(t);
  f.snapshot.threads.push(
    { ...thread('Resolved'), resolved: true },
    {
      ...thread('Bot message'),
      id: 'T2',
      comments: [{ id: 'B1', author: 'Bot', body: 'Done', own: true }],
    },
  );
  await f.update();
  assert.equal((await watchOnce(f.directory)).status, 'WAITING_REVIEW');
  assert.equal((await watchOnce(f.directory)).status, 'WAITING_REVIEW');
  assert.equal((await triages(f.directory)).length, 0);
  f.snapshot.state = 'MERGED';
  await f.update();
  assert.equal((await watchOnce(f.directory)).status, 'COMPLETED');
  const count = (await f.readCalls()).length;
  await watchOnce(f.directory);
  assert.equal((await f.readCalls()).length, count);
});

test('closed PR is cancelled and does not invoke models or reply', async (t) => {
  const f = await fixture(t);
  f.snapshot.state = 'CLOSED';
  f.snapshot.threads.push(thread('[fix] Change'));
  await f.update();
  assert.equal((await watchOnce(f.directory)).status, 'CANCELLED');
  assert.equal((await triages(f.directory)).length, 0);
});
