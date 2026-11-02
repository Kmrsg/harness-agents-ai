import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fixture, mutateMock } from '../support/workflow-fixture.ts';
import { git, commitChanges } from '../../src/infrastructure/git.ts';
import { workspaceFingerprint } from '../../src/infrastructure/workspace.ts';
import { start, resume } from '../../src/workflow/lifecycle.ts';
import { continueRun } from '../../src/workflow/continuation.ts';
import { retryDelivery } from '../../src/workflow/delivery.ts';
import { saveState } from '../../src/workflow/state.ts';

async function gitFixture(t: { after(fn: () => Promise<void>): void }) {
  const f = await fixture(t);
  await git(f.directory, ['init']);
  await git(f.directory, ['config', 'user.name', 'Fixture']);
  await git(f.directory, ['config', 'user.email', 'fixture@example.invalid']);
  await git(f.directory, ['add', 'spec.md']);
  await git(f.directory, ['commit', '-m', 'Initial']);
  f.config.git.enabled = true;
  return f;
}

test('approved deletion and rename retain the same fingerprint through delivery', async (t) => {
  const f = await gitFixture(t);
  await writeFile(path.join(f.directory, 'obsolete.txt'), 'Remove me');
  await writeFile(path.join(f.directory, 'old.txt'), 'Rename me');
  await git(f.directory, ['add', 'obsolete.txt', 'old.txt']);
  await git(f.directory, ['commit', '-m', 'Product baseline']);
  await mutateMock(
    f.config,
    `if(request.role==='backend-implementer'){
    await fs.unlink('obsolete.txt');await fs.rename('old.txt','new.txt');
  }`,
  );
  const run = await start(f.task, f.config);
  assert.equal(run.state.status, 'COMPLETED', run.state.summary);
  assert.equal(await readFile(path.join(run.state.workdir, 'new.txt'), 'utf8'), 'Rename me');
  const files = (await git(run.state.workdir, ['ls-tree', '-r', '--name-only', 'HEAD'])).split(
    '\n',
  );
  assert.ok(!files.includes('obsolete.txt') && !files.includes('old.txt'));
  assert.equal(
    await workspaceFingerprint(run.state.workdir, true),
    run.state.verification?.implementationApproval?.workspace,
  );
});

test('retry completes an already-staged approved tree without rerunning agents', async (t) => {
  const f = await gitFixture(t);
  const run = await start(f.task, f.config);
  assert.equal(run.state.status, 'COMPLETED', run.state.summary);
  const requests = (await readdir(run.directory)).filter((file) => file.endsWith('.request.json'));
  await git(run.state.workdir, ['reset', '--soft', 'HEAD^']);
  run.state.status = 'BLOCKED';
  run.state.deliveryPending = true;
  run.state.commit = undefined;
  run.state.checkpoint!.stage = 'delivery';
  run.state.checkpoint!.head = await git(run.state.workdir, ['rev-parse', 'HEAD']);
  await saveState(run.directory, run.state);
  const done = await retryDelivery(run.directory);
  assert.equal(done.status, 'COMPLETED', done.summary);
  assert.equal(await git(done.workdir, ['rev-list', '--count', 'HEAD']), '2');
  assert.equal(await git(done.workdir, ['diff', '--cached', '--name-only']), '');
  assert.deepEqual(
    (await readdir(run.directory)).filter((file) => file.endsWith('.request.json')),
    requests,
  );
});

test('delivery refuses runtime artifacts already staged before recovery', async (t) => {
  const f = await gitFixture(t);
  await mkdir(path.join(f.directory, '.harness'), { recursive: true });
  await writeFile(path.join(f.directory, '.harness/private.log'), 'runtime');
  await git(f.directory, ['add', '-f', '.harness/private.log']);
  await assert.rejects(commitChanges(f.directory, 'TEST-1', 'Fixture'), /must not be staged/);
  assert.equal(await git(f.directory, ['rev-list', '--count', 'HEAD']), '1');
});

for (const change of ['branch', 'head'] as const) {
  test(`resume rejects a changed ${change} under its lock before running another agent`, async (t) => {
    const f = await gitFixture(t);
    f.task.description += ' [clarify]';
    const run = await start(f.task, f.config);
    assert.equal(run.state.status, 'NEEDS_CLARIFICATION');
    const before = await readFile(path.join(run.directory, 'state.json'), 'utf8');
    const requests = (await readdir(run.directory)).filter((file) =>
      file.endsWith('.request.json'),
    );
    if (change === 'branch') await git(run.state.workdir, ['switch', '-c', 'unexpected-branch']);
    else await git(run.state.workdir, ['commit', '--allow-empty', '-m', 'External commit']);
    await assert.rejects(
      resume(run.directory, 'Keep input on failure'),
      /Run (branch|HEAD) changed/,
    );
    assert.equal(await readFile(path.join(run.directory, 'state.json'), 'utf8'), before);
    assert.deepEqual(
      (await readdir(run.directory)).filter((file) => file.endsWith('.request.json')),
      requests,
    );
  });
}

test('SIGINT while sealing a completed role leaves a recoverable, consistent checkpoint', async (t) => {
  const f = await gitFixture(t);
  const shim = path.join(f.directory, '.harness/git-shim');
  await mkdir(shim, { recursive: true });
  await writeFile(path.join(shim, 'package.json'), '{"type":"module"}');
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  await writeFile(
    path.join(shim, 'git'),
    `#!${process.execPath}
    import fs from 'node:fs';import path from 'node:path';import {spawnSync} from 'node:child_process';
    const root=${JSON.stringify(f.directory)},marker=path.join(root,'.harness/seal-interrupted');
    if(process.argv.includes('ls-files')&&!fs.existsSync(marker)){
      let interrupt=false;
      try{for(const id of fs.readdirSync(path.join(root,'.harness/runs'))){
        const lines=fs.readFileSync(path.join(root,'.harness/runs',id,'events.jsonl'),'utf8').trim().split('\\n');
        const last=JSON.parse(lines.at(-1));if(last.type==='agent.finished'&&last.data.role==='frontend-implementer')interrupt=true;
      }}catch{}
      if(interrupt){fs.writeFileSync(marker,'once');process.kill(process.ppid,'SIGINT');}
    }
    const result=spawnSync(${JSON.stringify(realGit)},process.argv.slice(2),{encoding:'utf8'});
    process.stdout.write(result.stdout??'');process.stderr.write(result.stderr??'');process.exitCode=result.status??1;
  `,
    { mode: 0o755 },
  );
  const originalPath = process.env.PATH;
  let run;
  try {
    process.env.PATH = shim + path.delimiter + originalPath;
    run = await start(f.task, f.config);
  } finally {
    process.env.PATH = originalPath;
  }
  assert.equal(run.state.status, 'BLOCKED', run.state.summary);
  assert.equal(run.state.interrupted, true);
  assert.equal(run.state.checkpoint?.active?.role, 'frontend-implementer');
  assert.equal(run.state.results.filter((item) => item.role === 'frontend-implementer').length, 0);
  const done = await continueRun(run.directory);
  assert.equal(done.status, 'COMPLETED', done.summary);
  assert.equal(done.results.filter((item) => item.role === 'analyst').length, 1);
  assert.equal(done.results.filter((item) => item.role === 'backend-implementer').length, 1);
  assert.ok(
    await readFile(
      path.join(run.directory, '1-frontend-implementer-attempt-2.request.json'),
      'utf8',
    ),
  );
});

test('retry-delivery rejects a switched worktree before checks or state writes', async (t) => {
  const f = await gitFixture(t);
  const run = await start(f.task, f.config);
  run.state.status = 'BLOCKED';
  run.state.deliveryPending = true;
  await saveState(run.directory, run.state);
  const before = await readFile(path.join(run.directory, 'state.json'), 'utf8');
  await git(run.state.workdir, ['switch', '-c', 'wrong-delivery-branch']);
  await assert.rejects(retryDelivery(run.directory), /Run branch changed/);
  assert.equal(await readFile(path.join(run.directory, 'state.json'), 'utf8'), before);
});
