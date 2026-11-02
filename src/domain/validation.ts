import path from 'node:path';
import type { AgentResult, Command, Config, Task } from './types.ts';

function object(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected JSON object');
}
function nonempty(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Expected nonempty string');
}
function positive(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0)
    throw new Error('Expected positive integer');
}
function command(value: unknown): asserts value is Command {
  object(value);
  nonempty(value.command);
  if (!Array.isArray(value.args) || value.args.some((arg) => typeof arg !== 'string'))
    throw new Error('Command args must be a string array');
}
export function readTask(value: unknown): Task {
  object(value);
  nonempty(value.id);
  nonempty(value.title);
  nonempty(value.description);
  nonempty(value.specPath);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(value.id))
    throw new Error('Task id must be a safe identifier');
  if (
    !Array.isArray(value.areas) ||
    !value.areas.length ||
    value.areas.some((a) => !['frontend', 'backend'].includes(a))
  )
    throw new Error('Task areas must include frontend and/or backend');
  if (!Array.isArray(value.acceptanceCriteria) || !value.acceptanceCriteria.length)
    throw new Error('Acceptance criteria are required');
  const ids = new Set<string>();
  for (const criterion of value.acceptanceCriteria) {
    object(criterion);
    nonempty(criterion.id);
    nonempty(criterion.description);
    if (ids.has(criterion.id)) throw new Error('Duplicate acceptance criterion');
    ids.add(criterion.id);
  }
  return value as unknown as Task;
}
export function readConfig(value: unknown, configDir: string, projectRoot = process.cwd()): Config {
  object(value);
  if (value.projectRoot !== undefined)
    throw new Error(
      'Remove projectRoot from config: the repository is determined from the current directory',
    );
  command(value.runner);
  if (!['cli', 'protocol'].includes(String(value.runnerMode)))
    throw new Error('runnerMode must be cli or protocol');
  positive(value.timeoutMs);
  positive(value.maxOutputBytes);
  if (value.maxInputBytes !== undefined) positive(value.maxInputBytes);
  if (value.runnerInput !== undefined && !['stdin', 'argv'].includes(String(value.runnerInput)))
    throw new Error('runnerInput must be stdin or argv');
  positive(value.maxIterations);
  if (
    value.maxReworkRetries !== undefined &&
    (!Number.isSafeInteger(value.maxReworkRetries) ||
      (value.maxReworkRetries as number) < 0 ||
      (value.maxReworkRetries as number) > 10)
  )
    throw new Error('maxReworkRetries must be an integer from 0 to 10');
  nonempty(value.knowledgeRoot);
  object(value.git);
  nonempty(value.git.baseRef);
  if (typeof value.git.enabled !== 'boolean' || typeof value.git.publish !== 'boolean')
    throw new Error('Git switches must be boolean');
  if (value.git.publish && !value.git.enabled) throw new Error('Publishing requires Git isolation');
  if (!Array.isArray(value.checks) || !value.checks.length)
    throw new Error('At least one mandatory check is required');
  for (const check of value.checks) {
    command(check);
    nonempty((check as unknown as Record<string, unknown>).name);
  }
  if (value.setup !== undefined) {
    if (!Array.isArray(value.setup)) throw new Error('setup must be an array of commands');
    for (const entry of value.setup) command(entry);
  }
  if (value.openspec !== undefined) {
    object(value.openspec);
    command(value.openspec.validator);
  }
  object(value.integrations);
  for (const key of ['bitbucket', 'taskTracker'])
    if (value.integrations[key] !== undefined) command(value.integrations[key]);
  if (value.git.publish && !value.integrations.bitbucket)
    throw new Error('Publishing requires a Bitbucket adapter');
  const config = value as unknown as Config;
  return { ...config, projectRoot, knowledgeRoot: path.resolve(configDir, config.knowledgeRoot) };
}
export function readResult(value: unknown): AgentResult {
  object(value);
  nonempty(value.summary);
  if (!['COMPLETED', 'NEEDS_CLARIFICATION', 'BLOCKED'].includes(String(value.status)))
    throw new Error('Invalid agent status');
  if (!Array.isArray(value.artifacts) || value.artifacts.some((a) => typeof a !== 'string'))
    throw new Error('artifacts must be a string array');
  if (!Array.isArray(value.questions) || !Array.isArray(value.acceptance))
    throw new Error('questions and acceptance arrays are required');
  const questionIds = new Set<string>();
  for (const question of value.questions) {
    object(question);
    nonempty(question.id);
    nonempty(question.question);
    nonempty(question.context);
    nonempty(question.blocks);
    if (questionIds.has(question.id)) throw new Error('Duplicate question id');
    questionIds.add(question.id);
  }
  if (value.status === 'NEEDS_CLARIFICATION' && !value.questions.length)
    throw new Error('Clarification requires concrete questions');
  const ids = new Set<string>();
  for (const item of value.acceptance) {
    object(item);
    nonempty(item.id);
    nonempty(item.evidence);
    if (typeof item.passed !== 'boolean' || ids.has(item.id))
      throw new Error('Invalid or duplicate acceptance result');
    ids.add(item.id);
  }
  if (value.verification !== undefined) {
    object(value.verification);
    const review = value.verification;
    if (
      !['plan', 'implementation'].includes(String(review.phase)) ||
      !['APPROVED', 'REWORK_PLAN', 'REWORK_IMPLEMENTATION'].includes(String(review.verdict))
    )
      throw new Error('Invalid verification phase or verdict');
    if (!Array.isArray(review.findings)) throw new Error('Verification findings must be an array');
    const findingIds = new Set<string>();
    for (const finding of review.findings) {
      object(finding);
      nonempty(finding.id);
      nonempty(finding.description);
      nonempty(finding.evidence);
      for (const refs of [finding.criteria, finding.tasks])
        if (!Array.isArray(refs) || refs.some((ref) => typeof ref !== 'string' || !ref.trim()))
          throw new Error('Finding references must be string arrays');
      if (!(finding.criteria as unknown[]).length && !(finding.tasks as unknown[]).length)
        throw new Error('Finding must reference a criterion or task');
      if (findingIds.has(finding.id)) throw new Error('Duplicate verification finding');
      findingIds.add(finding.id);
    }
    if (review.verdict === 'APPROVED' ? review.findings.length !== 0 : review.findings.length === 0)
      throw new Error('Approval requires no findings; rework requires concrete findings');
    if (review.phase === 'plan' && review.verdict === 'REWORK_IMPLEMENTATION')
      throw new Error('Plan review cannot request implementation rework');
  }
  if (value.reviewDecision !== undefined) {
    object(value.reviewDecision);
    if (
      !['FIX_IMPLEMENTATION', 'FIX_PLAN', 'REPLY', 'CLARIFY'].includes(
        String(value.reviewDecision.action),
      )
    )
      throw new Error('Invalid review action');
    nonempty(value.reviewDecision.response);
    nonempty(value.reviewDecision.evidence);
    if (value.status !== 'COMPLETED')
      throw new Error('A review decision requires COMPLETED triage');
  }
  return value as unknown as AgentResult;
}
