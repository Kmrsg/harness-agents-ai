import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, open, unlink } from 'node:fs/promises';
import path from 'node:path';
import { saveState } from '../../src/workflow/state.ts';
import { watchOnce } from '../../src/review/watcher.ts';
import { runtimeScript } from '../../src/infrastructure/package-paths.ts';
import { fixture, thread, triages } from '../support/review-fixture.ts';

test('stale source head and dirty worktree block automation before invoking models', async (t) => {
  for (const condition of ['head', 'dirty']) {
    const f = await fixture(t);
    f.snapshot.threads.push(thread('[fix] Change'));
    if (condition === 'head') f.snapshot.sourceCommit = '0'.repeat(40);
    else await writeFile(path.join(f.state.workdir, 'developer.txt'), 'In progress');
    await f.update();
    const state = await watchOnce(f.directory);
    assert.equal(state.status, 'BLOCKED');
    assert.equal(state.nextRole, 'developer');
    assert.equal((await triages(f.directory)).length, 0);
    assert.equal(
      (await f.readCalls()).filter((c) => c.operation === 'pull-request.reply').length,
      0,
    );
  }
});

test('interrupted repair never silently reruns and concurrent watch cannot acquire the run', async (t) => {
  const f = await fixture(t);
  f.state.review!.records.push({
    threadId: 'T1',
    fingerprint: 'previous',
    attempts: 1,
    stage: 'fixing',
  });
  await saveState(f.directory, f.state);
  const lock = await open(path.join(f.directory, 'run.lock'), 'wx');
  await assert.rejects(watchOnce(f.directory), { code: 'EEXIST' });
  await lock.close();
  await unlink(path.join(f.directory, 'run.lock'));
  const state = await watchOnce(f.directory);
  assert.equal(state.status, 'BLOCKED');
  assert.match(state.summary, /Interrupted fix/);
});

test('read-only triage enforcement and transient API errors are distinct', async (t) => {
  const f = await fixture(t);
  f.snapshot.threads.push(thread('Question'));
  await f.update();
  const runner = path.join(f.root, 'bad-triager.mjs');
  await writeFile(
    runner,
    `import fs from 'node:fs/promises';import {spawnSync} from 'node:child_process';let input='';for await(const c of process.stdin)input+=c;
    const r=spawnSync(process.execPath,[${JSON.stringify(runtimeScript('mock-agent'))}],{input,encoding:'utf8'});await fs.writeFile('product.txt','tampered');process.stdout.write(r.stdout);`,
  );
  f.state.config.runner.args = [runner];
  await saveState(f.directory, f.state);
  const blocked = await watchOnce(f.directory);
  assert.equal(blocked.status, 'BLOCKED');
  assert.match(blocked.summary, /read-only/);
  assert.equal((await f.readCalls()).filter((c) => c.operation === 'pull-request.reply').length, 0);
  const other = await fixture(t);
  await writeFile(path.join(other.root, 'pr.json'), 'invalid json');
  const failed = await watchOnce(other.directory);
  assert.equal(failed.status, 'WAITING_REVIEW');
  assert.ok(failed.integrationErrors.length);
});

test('merge during triage prevents correction and publication; next poll records completion', async (t) => {
  const f = await fixture(t);
  f.snapshot.threads.push(thread('[fix] Change'));
  await f.update();
  const runner = path.join(f.root, 'merging-triager.mjs');
  await writeFile(
    runner,
    `import fs from 'node:fs/promises';import {spawnSync} from 'node:child_process';let input='';for await(const c of process.stdin)input+=c;
    const r=spawnSync(process.execPath,[${JSON.stringify(runtimeScript('mock-agent'))}],{input,encoding:'utf8'});
    const file=${JSON.stringify(path.join(f.root, 'pr.json'))};const data=JSON.parse(await fs.readFile(file,'utf8'));data.state='MERGED';await fs.writeFile(file,JSON.stringify(data));process.stdout.write(r.stdout);`,
  );
  f.state.config.runner.args = [runner];
  await saveState(f.directory, f.state);
  const stopped = await watchOnce(f.directory);
  assert.equal(stopped.status, 'BLOCKED');
  assert.match(stopped.summary, /PR changed during triage/);
  assert.equal(stopped.commit, f.state.commit);
  assert.equal(stopped.review!.records.length, 0);
  assert.equal((await f.readCalls()).filter((c) => c.operation === 'pull-request.reply').length, 0);
  assert.equal((await watchOnce(f.directory)).status, 'COMPLETED');
});

test('accepted reply with a lost HTTP response is delivered once by the real mock adapter', async (t) => {
  const f = await fixture(t);
  f.snapshot.threads.push(thread('Question'));
  await f.update();
  const wrapper = path.join(f.root, 'lost-response.mjs');
  const lostFlag = path.join(f.root, 'reply-response-lost');
  await writeFile(
    wrapper,
    `import fs from 'node:fs';import {spawnSync} from 'node:child_process';let input='';for await(const c of process.stdin)input+=c;
    const request=JSON.parse(input);
    const result=spawnSync(process.execPath,[${JSON.stringify(runtimeScript('mock-integration'))}],{input,encoding:'utf8',env:{...process.env,HARNESS_BITBUCKET_FIXTURE:${JSON.stringify(path.join(f.root, 'pr.json'))}}});
    if(result.status!==0)throw Error(result.stderr);
    if(request.operation==='pull-request.reply'&&!fs.existsSync(${JSON.stringify(lostFlag)})){fs.writeFileSync(${JSON.stringify(lostFlag)},'lost');process.exit(9);}
    process.stdout.write(result.stdout);`,
  );
  f.state.config.integrations.bitbucket!.args = [wrapper];
  await saveState(f.directory, f.state);
  assert.equal((await watchOnce(f.directory)).review!.records[0].stage, 'reply');
  assert.equal((await watchOnce(f.directory)).review!.records[0].stage, 'done');
  const { readFile } = await import('node:fs/promises');
  const accepted = (await readFile(path.join(f.root, 'pr.json.replies.jsonl'), 'utf8'))
    .trim()
    .split('\n');
  assert.equal(accepted.length, 1);
  assert.ok(JSON.parse(accepted[0]).expectedThreadFingerprint);
  assert.equal((await triages(f.directory)).length, 1);
});
