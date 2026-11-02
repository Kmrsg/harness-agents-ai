import { reportContract } from '../src/agents/contracts.ts';
/** Deterministic fixture runner, not an LLM. Used for offline workflow verification. */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AgentRequest, AgentResult } from '../src/domain/types.ts';

let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) input += chunk;
const request: AgentRequest = JSON.parse(input);
const clarify =
  request.task.description.includes('[clarify]') &&
  request.role === 'frontend-planner' &&
  !request.clarificationHistory.length;
const block =
  request.task.description.includes('[block]') && request.role === 'backend-implementer';
const result: AgentResult = {
  status: clarify ? 'NEEDS_CLARIFICATION' : block ? 'BLOCKED' : 'COMPLETED',
  summary: clarify
    ? 'Mock: clarify behavior after save error'
    : block
      ? 'Mock: backend dependency unavailable'
      : `Mock ${request.role} completed`,
  artifacts: [],
  questions: clarify
    ? [
        {
          id: 'Q1',
          question: 'Should the form retain input after save failure?',
          context: 'Only the happy path is specified.',
          blocks: 'Frontend error handling',
        },
      ]
    : [],
  acceptance: ['tester', 'verifier'].includes(request.role)
    ? request.task.acceptanceCriteria.map((c) => ({
        id: c.id,
        passed: true,
        evidence: 'MOCK evidence for workflow test only',
      }))
    : [],
};
if (request.role === 'review-triager') {
  const body = request
    .prReview!.thread.comments.filter((c) => !c.own)
    .map((c) => c.body)
    .join('\n');
  const action = body.includes('[fix-plan]')
    ? 'FIX_PLAN'
    : body.includes('[fix]')
      ? 'FIX_IMPLEMENTATION'
      : body.includes('[question]')
        ? 'CLARIFY'
        : 'REPLY';
  result.reviewDecision = {
    action,
    response:
      action === 'CLARIFY'
        ? 'MOCK: please clarify the expected behavior.'
        : 'MOCK: reviewed against the current specification.',
    evidence: 'MOCK evidence only: AC-1 and current implementation.',
  };
} else if (request.role === 'verifier') {
  const { phase, attempt } = request.verification!;
  const description = request.task.description;
  const failures = request.checks?.filter((check) => check.exitCode !== 0) ?? [];
  const rejectPlan =
    phase === 'plan' &&
    (description.includes('[rework-plan-always]') ||
      (description.includes('[rework-plan-once]') && attempt === 1));
  const rejectImplementation =
    phase === 'implementation' &&
    (description.includes('[rework-implementation-always]') ||
      (description.includes('[rework-implementation-once]') && attempt === 1));
  const changePlan =
    phase === 'implementation' &&
    description.includes('[implementation-to-plan-once]') &&
    attempt === 1;
  const verdict =
    changePlan || rejectPlan || (phase === 'plan' && failures.length)
      ? 'REWORK_PLAN'
      : rejectImplementation || failures.length
        ? 'REWORK_IMPLEMENTATION'
        : 'APPROVED';
  result.verification = {
    phase,
    verdict,
    findings:
      verdict === 'APPROVED'
        ? []
        : [
            {
              id: 'V1',
              description: failures.length
                ? `Mandatory check failed: ${failures.map((check) => check.name).join(', ')}`
                : 'MOCK discrepancy between requirement, plan and implementation',
              evidence: failures.length
                ? failures
                    .map(
                      (check) =>
                        `${check.name}: exit ${check.exitCode}; ${check.log}\n${check.output}`,
                    )
                    .join('\n')
                : 'MOCK evidence for review workflow only',
              criteria: [request.task.acceptanceCriteria[0].id],
              tasks: [],
            },
          ],
  };
  result.summary = `Mock ${phase} review: ${verdict}`;
  if (verdict !== 'APPROVED') result.acceptance = [];
} else if (result.status === 'COMPLETED') {
  const files = request.openspec.files;
  const existing = (name: string) => files.find((file) => file.path === name)?.content;
  const draft = async (name: string, content: string) => {
    const file = path.join(request.openspec.draftDirectory, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
    result.artifacts.push(file);
  };
  const criteria = request.task.acceptanceCriteria;
  const checks = criteria
    .map(
      (c, i) =>
        `- [ ] 3.${i + 1} [testing] Verify ${c.id} using the acceptance scenario and record observed output.`,
    )
    .join('\n');
  if (request.role === 'analyst') {
    const baseline = request.openspec.baselineSpecs[0];
    const capability = baseline ? baseline.path.replace(/\/spec\.md$/, '') : 'mock-feature';
    await draft(
      'proposal.md',
      `# MOCK Proposal\n\n## Why\nDemonstrate the workflow for ${request.task.id}.\n\n## What Changes\n- Implement the requested observable behavior.\n\n## Capabilities\n### New Capabilities\n${baseline ? '' : `- \`${capability}\`: Requested behavior.\n`}### Modified Capabilities\n${baseline ? `- \`${capability}\`: Updated behavior.\n` : ''}\n## Impact\nRequested application areas only.\n`,
    );
    await draft(
      `specs/${capability}/spec.md`,
      `# MOCK Delta\n\n${baseline ? '' : '## Purpose\n\nDescribes observable application behavior for the deterministic Harness workflow demonstration.\n\n'}## ${baseline ? 'MODIFIED' : 'ADDED'} Requirements\n\n` +
        criteria
          .map(
            (c) =>
              `### Requirement: ${c.id} behavior\nThe system SHALL satisfy the acceptance behavior: ${c.description}\n\n#### Scenario: ${c.id} accepted\n- **WHEN** the specified action is performed\n- **THEN** the specified observable result occurs\n`,
          )
          .join('\n') +
        (request.clarificationHistory.length
          ? `\nClarification answers: ${request.clarificationHistory.map((h) => h.answer).join('; ')}\n`
          : ''),
    );
  } else if (request.role.endsWith('-planner')) {
    if (request.rework?.phase === 'plan' && existing('design.md') && existing('tasks.md')) {
      await draft('design.md', existing('design.md')!);
      await draft('tasks.md', existing('tasks.md')!);
    } else {
      const backend = request.role === 'backend-planner';
      const owner = backend ? 'backend' : 'frontend';
      const design =
        (existing('design.md') ??
          '# MOCK Design\n\n## Context\nSee proposal and delta specs.\n\n## Decisions\nFollow the existing project architecture.\n\n## Risks / Trade-offs\nMock fixture does not implement product behavior.\n') +
        `\n## ${backend ? 'Backend' : 'Frontend'}\n${backend ? 'Mock API contract: POST /requests returns an id or a validation error.' : 'Mock form uses the agreed API contract and renders loading and error states.'}\n`;
      await draft('design.md', design);
      const group =
        `## ${backend ? '1. Backend' : '2. Frontend'}\n` +
        criteria
          .map(
            (c, i) =>
              `- [ ] ${backend ? 1 : 2}.${i + 1} [${owner}] Implement ${c.id} and verify the corresponding domain test passes.`,
          )
          .join('\n') +
        '\n';
      const oldTasks = existing('tasks.md');
      const tasks = oldTasks
        ? oldTasks.replace('## 3. Testing', `${group}\n## 3. Testing`)
        : `# Tasks\n\n${group}\n## 3. Testing\n${checks}\n`;
      await draft('tasks.md', tasks);
    }
  } else {
    if (
      request.role.endsWith('-implementer') &&
      request.rework?.findings.some((f) => f.id.startsWith('PR-'))
    )
      await writeFile('mock-review-fix.txt', JSON.stringify(request.rework.findings));
    const owner =
      request.role === 'tester'
        ? 'testing'
        : request.role.startsWith('backend')
          ? 'backend'
          : 'frontend';
    await draft(
      'tasks.md',
      existing('tasks.md')!
        .split('\n')
        .map((line) => (line.includes(`[${owner}]`) ? line.replace(/^- \[ \]/, '- [x]') : line))
        .join('\n'),
    );
  }
}
const contract = await reportContract(request.role, result.status);
const report = path.join(request.artifactDirectory, contract.file);
await mkdir(path.dirname(report), { recursive: true });
const evidence = JSON.stringify({
  summary: result.summary,
  taskId: request.task.id,
  acceptance: result.acceptance,
  verification: result.verification,
  reviewDecision: result.reviewDecision,
  questions: result.questions,
});
await writeFile(
  report,
  `# MOCK ${request.role}\n\n` +
    contract.sections
      .map((section) => `## ${section}\n\nMOCK fixture evidence only. ${evidence}\n`)
      .join('\n'),
);
result.artifacts.unshift(report);
process.stdout.write(JSON.stringify(result) + '\n');
