import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readdir, chmod } from 'node:fs/promises';
import path from 'node:path';
import { start } from '../../src/workflow/lifecycle.ts';
import { retryDelivery } from '../../src/workflow/delivery.ts';
import { git } from '../../src/infrastructure/git.ts';
import { fixture } from '../support/workflow-fixture.ts';

test('git run creates isolated branch and never commits runtime artifacts', async (t) => {
  const { directory, task, config } = await fixture(t);
  await git(directory, ['init']);
  await git(directory, ['config', 'user.email', 'fixture@example.invalid']);
  await git(directory, ['config', 'user.name', 'Fixture']);
  await git(directory, ['add', 'spec.md']);
  await git(directory, ['commit', '-m', 'Initial']);
  const originalHead = await git(directory, ['rev-parse', 'HEAD']);
  // The mandatory check generates a fixture product file in the isolated checkout.
  config.git.enabled = true;
  config.checks[0].args = ['-e', 'require("node:fs").writeFileSync("product.txt","fixture")'];
  const result = await start(task, config);
  assert.equal(result.state.status, 'COMPLETED', result.state.summary);
  assert.equal(await git(directory, ['rev-parse', 'HEAD']), originalHead);
  assert.ok(result.state.commit);
  const committedFiles = await git(result.state.workdir, [
    'show',
    '--pretty=format:',
    '--name-only',
    'HEAD',
  ]);
  assert.ok(committedFiles.split('\n').includes('product.txt'));
  assert.ok(committedFiles.split('\n').includes(`${result.state.openspec!.directory}/proposal.md`));
  assert.ok(committedFiles.split('\n').includes(`${result.state.openspec!.directory}/tasks.md`));
  assert.ok(!committedFiles.includes('.harness/'));
});

test('Bitbucket failure preserves pushed commit and delivery retry does not rerun LLM', async (t) => {
  const { directory, task, config } = await fixture(t);
  await git(directory, ['init']);
  await git(directory, ['config', 'user.email', 'fixture@example.invalid']);
  await git(directory, ['config', 'user.name', 'Fixture']);
  await git(directory, ['add', 'spec.md']);
  await git(directory, ['commit', '-m', 'Initial']);
  const remote = path.join(directory, 'remote.git');
  await git(directory, ['init', '--bare', remote]);
  await git(directory, ['remote', 'add', 'origin', remote]);
  const flag = path.join(directory, 'allow-pr');
  const adapter = path.join(directory, 'bitbucket.mjs');
  await writeFile(
    adapter,
    `import fs from 'node:fs';
    let input='';for await(const chunk of process.stdin)input+=chunk;
    const request=JSON.parse(input);if(request.operation!=='pull-request.create')process.exit(8);
    if(!fs.existsSync(${JSON.stringify(flag)}))process.exit(9);
    console.log(JSON.stringify({ok:true,url:'https://bitbucket.example.invalid/pr/1'}));`,
  );
  config.git.enabled = true;
  config.git.publish = true;
  config.integrations.bitbucket = { command: process.execPath, args: [adapter] };
  config.checks[0].args = ['-e', 'require("node:fs").writeFileSync("product.txt","fixture")'];
  const first = await start(task, config);
  assert.equal(first.state.status, 'BLOCKED');
  assert.ok(first.state.commit);
  assert.ok(first.state.verification?.implementationApproval);
  const originalCommit = first.state.commit;
  const requestFiles = (await readdir(first.directory)).filter((f) => f.endsWith('.request.json'));
  await writeFile(flag, 'yes');
  await writeFile(path.join(first.state.workdir, 'product.txt'), 'tampered after approval');
  const denied = await retryDelivery(first.directory);
  assert.equal(denied.status, 'BLOCKED');
  assert.match(denied.summary, /Files changed after verifier approval/);
  await writeFile(path.join(first.state.workdir, 'product.txt'), 'fixture');
  const final = await retryDelivery(first.directory);
  assert.equal(final.status, 'WAITING_REVIEW', final.summary);
  assert.equal(final.commit, originalCommit);
  assert.equal(final.pullRequestUrl, 'https://bitbucket.example.invalid/pr/1');
  assert.deepEqual(
    (await readdir(first.directory)).filter((f) => f.endsWith('.request.json')),
    requestFiles,
  );
});

test('commit hook cannot publish code changed after verifier approval', async (t) => {
  const { directory, task, config } = await fixture(t);
  await git(directory, ['init']);
  await git(directory, ['config', 'user.email', 'fixture@example.invalid']);
  await git(directory, ['config', 'user.name', 'Fixture']);
  await git(directory, ['add', 'spec.md']);
  await git(directory, ['commit', '-m', 'Initial']);
  const hook = path.join(directory, '.git/hooks/pre-commit');
  await writeFile(
    hook,
    '#!/bin/sh\nprintf "changed by hook" > product.txt\ngit add -- product.txt\n',
  );
  await chmod(hook, 0o755);
  config.git.enabled = true;
  config.checks[0].args = [
    '-e',
    'require("node:fs").writeFileSync("product.txt","reviewed content")',
  ];
  const { state } = await start(task, config);
  assert.equal(state.status, 'BLOCKED');
  assert.match(state.summary, /Files changed after verifier approval/);
  assert.equal(state.pullRequestUrl, undefined);
});
