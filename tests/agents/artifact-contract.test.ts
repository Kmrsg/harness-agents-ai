import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { reportContract } from '../../src/agents/contracts.ts';
import { validateResultContract } from '../../src/agents/result-contract.ts';
import { instructions } from '../../src/agents/instructions.ts';
import { roles } from '../../src/domain/types.ts';
import { readResult } from '../../src/domain/validation.ts';
import { start } from '../../src/workflow/lifecycle.ts';
import { fixture, mutateMock } from '../support/workflow-fixture.ts';
import type { AgentRequest, AgentResult, Role } from '../../src/domain/types.ts';

const artifactDirectory = '.harness/artifacts/contract/1/role';
const implementation =
  '# Implementation\n\n## Summary\nSave behavior implemented.\n\n## Changes\nUpdated src/save.ts for AC-1.\n\n## Checks\nnpm test: passed save-error scenario.\n\n## Limitations\nVisual behavior was not checked.\n\n## Handoff\nRetest AC-1 using the saved input.\n';
function request(role: Role = 'backend-implementer'): AgentRequest {
  return {
    role,
    task: {
      id: 'CONTRACT',
      title: 'Save',
      description: 'Save input',
      areas: ['backend'],
      specPath: 'spec.md',
      acceptanceCriteria: [{ id: 'AC-1', description: 'Input saved' }],
    },
    specification: 'Save input',
    instructions: '',
    context: [],
    clarificationHistory: [],
    artifactDirectory,
    workdir: '/unused',
    verification: role === 'verifier' ? { phase: 'plan', attempt: 1 } : undefined,
    openspec: {
      name: 'contract',
      directory: 'openspec/changes/contract',
      draftDirectory: artifactDirectory + '/openspec',
      files: [],
      baselineSpecs: [],
    },
  };
}
function result(status: AgentResult['status'] = 'COMPLETED'): AgentResult {
  return { status, summary: 'Evidence recorded', artifacts: [], questions: [], acceptance: [] };
}
function report(file: string, content: string) {
  return [{ path: path.join(artifactDirectory, file), content }];
}

test('implementation handoff requires the named report in its exact role directory', async () => {
  await validateResultContract(request(), result(), report('implementation.md', implementation));
  await assert.rejects(
    validateResultContract(request(), result(), report('anything.md', implementation)),
    /requires implementation.md/,
  );
  await assert.rejects(
    validateResultContract(request(), result(), report('nested/implementation.md', implementation)),
    /requires implementation.md/,
  );
});

test('frontend handoff requires UI rule evidence without changing the backend contract', async () => {
  await validateResultContract(request(), result(), report('implementation.md', implementation));
  await assert.rejects(
    validateResultContract(
      request('frontend-implementer'),
      result(),
      report('implementation.md', implementation),
    ),
    /missing report section UI Rules/,
  );
  await assert.rejects(
    validateResultContract(
      request('frontend-implementer'),
      result(),
      report('implementation.md', implementation + '\n## UI Rules\n<!-- fetch rules -->\n'),
    ),
    /empty report section UI Rules/,
  );
  await validateResultContract(
    request('frontend-implementer'),
    result(),
    report(
      'implementation.md',
      implementation +
        '\n## UI Rules\nUI MCP get_rule(form-error): retain input on errors; applied in SaveForm.tsx for 2.1. No conflicts with design/tasks.\n',
    ),
  );
});

test('missing sections, comment-only sections and placeholders are rejected', async () => {
  for (const body of [
    implementation.replace('## Checks', '### Checks'),
    implementation.replace('npm test: passed save-error scenario.', '<!-- fill checks -->'),
    implementation.replace('npm test: passed save-error scenario.', '{{command and result}}'),
  ]) {
    await assert.rejects(
      validateResultContract(request(), result(), report('implementation.md', body)),
      /(?:missing|empty) report section Checks/,
    );
  }
});

test('fenced headings and duplicate report sections do not satisfy the contract', async () => {
  const fenced = implementation.replace(
    '## Checks\nnpm test: passed save-error scenario.',
    '```markdown\n## Checks\nFake result.\n```',
  );
  await assert.rejects(
    validateResultContract(request(), result(), report('implementation.md', fenced)),
    /missing report section Checks/,
  );
  await assert.rejects(
    validateResultContract(
      request(),
      result(),
      report('implementation.md', implementation + '\n## Checks\nAnother result.'),
    ),
    /Duplicate report section/,
  );
});

test('clarification and blocked statuses use their own reports without requiring completed outputs', async () => {
  const clarification =
    '# Clarification\n\n## Summary\nAmbiguous save behavior.\n\n## Questions\nQ1: Retain input after failure?\n\n## Investigated\nRead save.ts and spec.md.\n\n## Blocked Work\nError-state implementation needs an answer.\n';
  const asking = result('NEEDS_CLARIFICATION');
  asking.questions = [
    { id: 'Q1', question: 'Retain input?', context: 'Error unspecified', blocks: 'Save behavior' },
  ];
  await validateResultContract(request(), asking, report('clarification.md', clarification));
  await assert.rejects(
    validateResultContract(
      request(),
      asking,
      report('clarification.md', clarification.replace('Q1:', 'Q10:')),
    ),
    /missing question Q1/,
  );
  await validateResultContract(
    request(),
    result('BLOCKED'),
    report(
      'blocked.md',
      '# Blocked\n\n## Summary\nCould not check API.\n\n## Cause\nDependency is unavailable.\n\n## Evidence\nConnection refused by local server.\n\n## Recovery\nRestore the API and retry.\n',
    ),
  );
});

test('all shipped templates reject an unfilled copy, for every role and status', async () => {
  for (const role of roles) {
    for (const status of ['COMPLETED', 'NEEDS_CLARIFICATION', 'BLOCKED'] as const) {
      const contract = await reportContract(role, status);
      await assert.rejects(
        validateResultContract(
          request(role),
          result(status),
          report(contract.file, contract.template),
        ),
        /empty report section/,
      );
    }
  }
});

test('a completed verifier or triager cannot hand off a report without its structured decision', async () => {
  for (const [role, name, body] of [
    [
      'verifier',
      'verification-report.md',
      '# Review\n\n## Summary\nReviewed plan.\n\n## Scope\nAC-1 plan.\n\n## Findings\nNo mismatch found in the plan.\n\n## Evidence\nRead design.md and specs.\n\n## Decision\nPlan conforms to AC-1.\n',
    ],
    [
      'review-triager',
      'review-report.md',
      '# Triage\n\n## Summary\nQuestion reviewed.\n\n## Thread\nT1 at current HEAD.\n\n## Analysis\nCurrent code follows AC-1.\n\n## Evidence\nSave handler and test pass.\n\n## Decision\nExplain existing behavior.\n',
    ],
  ] as const) {
    await assert.rejects(
      validateResultContract(request(role), result(), report(name, body)),
      /structured/,
    );
  }
});

test('instructions contain the same status templates that the runtime validates', async (t) => {
  const { config } = await fixture(t);
  for (const role of roles) {
    const text = await instructions(role, config);
    for (const status of ['COMPLETED', 'NEEDS_CLARIFICATION', 'BLOCKED'] as const) {
      const contract = await reportContract(role, status);
      assert.ok(text.includes(contract.template));
      assert.ok(text.includes(`${status} → ${contract.file}`));
    }
  }
});

test('an invalid report blocks the workflow before tester, delivery or downstream context', async (t) => {
  const { task, config } = await fixture(t);
  await mutateMock(
    config,
    `if(request.role==='backend-implementer') { const file=result.artifacts.find(file=>file.endsWith('/implementation.md'));const renamed=file.replace('/implementation.md','/arbitrary.md');await fs.rename(file,renamed);result.artifacts=result.artifacts.map(item=>item===file?renamed:item); }`,
  );
  const run = await start(task, config);
  assert.equal(run.state.status, 'BLOCKED');
  assert.match(run.state.summary, /requires implementation.md/);
  assert.ok(!run.state.results.some((item) => item.role === 'tester'));
  assert.ok(!run.state.results.some((item) => item.role === 'backend-implementer'));
  assert.equal(run.state.commit, undefined);
});

test('structured clarification rejects duplicate question identifiers', () => {
  const asking = result('NEEDS_CLARIFICATION');
  const question = {
    id: 'Q1',
    question: 'Which behavior?',
    context: 'Spec is ambiguous',
    blocks: 'Implementation',
  };
  asking.questions = [question, question];
  assert.throws(() => readResult(asking), /Duplicate question id/);
});
