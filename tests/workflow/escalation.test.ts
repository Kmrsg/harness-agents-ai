import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { start } from '../../src/workflow/lifecycle.ts';
import { retryDelivery } from '../../src/workflow/delivery.ts';
import { fixture } from '../support/workflow-fixture.ts';

test('blocked implementation is reviewed and escalated after two unsuccessful repairs', async (t) => {
  const { task, config } = await fixture(t);
  task.description += ' [block]';
  const { state } = await start(task, config);
  assert.equal(state.status, 'BLOCKED');
  assert.equal(state.nextRole, 'developer');
  assert.equal(state.verification?.retries.implementation, 2);
  assert.equal(state.results.filter((r) => r.role === 'backend-implementer').length, 3);
  assert.equal(state.results.filter((r) => r.phase === 'implementation').length, 3);
});

test('delivery retry cannot bypass developer escalation after failed checks', async (t) => {
  const { task, config } = await fixture(t);
  const flag = path.join(config.projectRoot, 'allow-check');
  config.checks[0].args = [
    '-e',
    `process.exit(require('node:fs').existsSync(${JSON.stringify(flag)}) ? 0 : 1)`,
  ];
  const first = await start(task, config);
  assert.equal(first.state.status, 'BLOCKED');
  const before = (await readdir(first.directory)).filter((f) => f.endsWith('.request.json'));
  await writeFile(flag, 'yes');
  assert.equal(first.state.nextRole, 'developer');
  await assert.rejects(retryDelivery(first.directory), /after verifier approval/);
  assert.deepEqual(
    (await readdir(first.directory)).filter((f) => f.endsWith('.request.json')),
    before,
  );
});

test('Task tracker adapter failure is preserved separately from implementation status', async (t) => {
  const { task, config } = await fixture(t);
  config.integrations.taskTracker = { command: process.execPath, args: ['-e', 'process.exit(9)'] };
  const result = await start(task, config);
  assert.equal(result.state.status, 'COMPLETED');
  assert.match(result.state.integrationErrors[0], /task.report/);
  assert.match(
    await readFile(path.join(result.directory, 'report.md'), 'utf8'),
    /Adapter task.report failed/,
  );
});

test('developer escalation is routed through the configured Task tracker script', async (t) => {
  const { directory, task, config } = await fixture(t);
  task.description += ' [rework-plan-always]';
  const adapter = path.join(directory, 'tracker.mjs');
  await writeFile(
    adapter,
    `import fs from 'node:fs/promises';
    let input='';for await(const chunk of process.stdin)input+=chunk;
    await fs.writeFile('.harness/tracker-request.json',input);console.log(JSON.stringify({ok:true}));`,
  );
  config.integrations.taskTracker = { command: process.execPath, args: [adapter] };
  const { state } = await start(task, config);
  assert.equal(state.status, 'BLOCKED');
  const message = JSON.parse(
    await readFile(path.join(directory, '.harness/tracker-request.json'), 'utf8'),
  );
  assert.equal(message.operation, 'task.report');
  assert.equal(message.payload.returnToRole, 'developer');
  assert.equal(message.payload.escalation.to, 'developer');
  assert.equal(message.payload.verification.retries.plan, 2);
  assert.match(message.payload.report, /V1/);
});

test('a repair succeeding on the second retry completes despite historical failed checks', async (t) => {
  const { directory, task, config } = await fixture(t);
  const check = path.join(directory, 'recovering-check.mjs');
  await writeFile(
    check,
    `import fs from 'node:fs';
    const file='.harness/check-count';const n=(fs.existsSync(file)?Number(fs.readFileSync(file,'utf8')):0)+1;
    fs.writeFileSync(file,String(n));console.log('Attempt '+n);process.exit(n<3?1:0);`,
  );
  config.checks = [{ name: 'Recovering check', command: process.execPath, args: [check] }];
  const { state } = await start(task, config);
  assert.equal(state.status, 'COMPLETED', state.summary);
  assert.equal(state.verification?.retries.implementation, 2);
  assert.deepEqual(
    state.checks
      .filter((check) => check.name === 'Recovering check')
      .map((check) => check.exitCode),
    [1, 1, 0],
  );
  assert.equal(state.escalation, undefined);
});

for (const phase of ['plan', 'implementation'] as const) {
  test(`persistent ${phase} mismatch gets exactly two repairs then developer escalation`, async (t) => {
    const { directory, task, config } = await fixture(t);
    task.description += ` [rework-${phase}-always]`;
    const result = await start(task, config);
    const state = result.state;
    assert.equal(state.status, 'BLOCKED');
    assert.equal(state.nextRole, 'developer');
    assert.equal(state.escalation?.phase, phase);
    assert.equal(state.verification?.retries[phase], 2);
    assert.equal(state.results.filter((item) => item.phase === phase).length, 3);
    assert.equal(
      state.results.filter(
        (item) => item.role === (phase === 'plan' ? 'backend-planner' : 'backend-implementer'),
      ).length,
      3,
    );
    assert.equal(state.commit, undefined);
    assert.equal(state.pullRequestUrl, undefined);
    assert.match(await readFile(path.join(result.directory, 'escalation.md'), 'utf8'), /V1/);
    const stored = JSON.parse(
      await readFile(path.join(directory, '.harness/runs', state.id, 'state.json'), 'utf8'),
    );
    assert.equal(stored.nextRole, 'developer');
    await assert.rejects(retryDelivery(result.directory), /after verifier approval/);
    if (phase === 'plan')
      assert.ok(!state.results.some((item) => item.role.endsWith('-implementer')));
  });
}
