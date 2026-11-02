import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { start } from '../../src/workflow/lifecycle.ts';
import { parseAgentOutput } from '../../src/agents/runner.ts';
import { fixture, mutateMock } from '../support/workflow-fixture.ts';

test('mandatory check failure blocks completion even when agents claim success', async (t) => {
  const { task, config } = await fixture(t);
  config.checks[0].args = ['-e', 'console.error("bad");process.exit(7)'];
  const result = await start(task, config);
  assert.equal(result.state.status, 'BLOCKED');
  assert.match(result.state.summary, /Mandatory check failed/);
  assert.equal(result.state.checks[0].exitCode, 7);
});

test('missing tester acceptance evidence cannot pass the completion gate', async (t) => {
  const { task, config } = await fixture(t);
  await mutateMock(config, `if(request.role==='tester')result.acceptance=[];`);
  const { state } = await start(task, config);
  assert.equal(state.status, 'BLOCKED');
  assert.match(state.summary, /Tester acceptance/);
  assert.equal(state.nextRole, 'developer');
  const failed = state.checks.find((check) => check.name === 'Tester acceptance')!;
  assert.match(
    await readFile(path.join(config.projectRoot, '.harness/runs', state.id, failed.log), 'utf8'),
    /AC-1/,
  );
});

test('read-only verifier cannot modify product code', async (t) => {
  const { task, config } = await fixture(t);
  await mutateMock(
    config,
    `if(request.role==='verifier')await fs.writeFile('unapproved.txt','mutation');`,
  );
  const { state } = await start(task, config);
  assert.equal(state.status, 'BLOCKED');
  assert.match(state.summary, /Verifier modified product files/);
  assert.equal(state.commit, undefined);
  assert.equal(state.pullRequestUrl, undefined);
});

test('plain COMPLETED from verifier does not authorize delivery', async (t) => {
  const { task, config } = await fixture(t);
  await mutateMock(config, `if(request.role==='verifier')delete result.verification;`);
  const { state } = await start(task, config);
  assert.equal(state.status, 'BLOCKED');
  assert.match(state.summary, /structured plan decision/);
  assert.ok(!state.results.some((item) => item.role.endsWith('-implementer')));
});

test('approval cannot override failed mandatory checks', async (t) => {
  const { task, config } = await fixture(t);
  config.checks[0].args = ['-e', 'console.error("failing check");process.exit(1)'];
  await mutateMock(
    config,
    `if(request.role==='verifier' && request.verification.phase==='implementation'){
    result.verification={phase:'implementation',verdict:'APPROVED',findings:[]};
    result.acceptance=request.task.acceptanceCriteria.map(item=>({id:item.id,passed:true,evidence:'Claimed success'}));
  }`,
  );
  const { state } = await start(task, config);
  assert.equal(state.status, 'BLOCKED');
  assert.equal(state.nextRole, 'developer');
  assert.match(state.summary, /approved despite failed/);
  assert.equal(state.verification?.implementationApproval, undefined);
});

test('verifier findings require a valid phase, verdict and actionable references', () => {
  const base = {
    status: 'COMPLETED',
    summary: 'Review',
    artifacts: [],
    questions: [],
    acceptance: [],
  };
  const finding = {
    id: 'V1',
    description: 'Fix validation',
    evidence: 'file.ts:12',
    criteria: ['AC-1'],
    tasks: [],
  };
  assert.throws(() =>
    parseAgentOutput(
      JSON.stringify({
        ...base,
        verification: { phase: 'plan', verdict: 'REWORK_IMPLEMENTATION', findings: [finding] },
      }),
      'protocol',
    ),
  );
  assert.throws(() =>
    parseAgentOutput(
      JSON.stringify({
        ...base,
        verification: { phase: 'plan', verdict: 'APPROVED', findings: [finding] },
      }),
      'protocol',
    ),
  );
  assert.throws(() =>
    parseAgentOutput(
      JSON.stringify({
        ...base,
        verification: {
          phase: 'plan',
          verdict: 'REWORK_PLAN',
          findings: [{ ...finding, criteria: [] }],
        },
      }),
      'protocol',
    ),
  );
});
