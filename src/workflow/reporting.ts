import { recordEvent } from '../infrastructure/events.ts';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { notify } from '../integrations/task-tracker.ts';
import { saveState } from './state.ts';
import type { RunState } from '../domain/types.ts';

export async function report(directory: string, state: RunState): Promise<void> {
  const last = state.results.at(-1);
  const text =
    [
      `# ${state.task.id}: ${state.task.title}`,
      '',
      `Status: ${state.status}`,
      '',
      state.summary,
      '',
      `Iteration: ${state.iteration}`,
      `Next role: ${state.nextRole ?? '—'}`,
      `Workdir: ${state.workdir}`,
      ...(state.openspec ? [`OpenSpec change: ${state.openspec.directory}`] : []),
      '',
      ...state.results.map(
        (item) =>
          `- ${item.role}${item.phase ? ` (${item.phase}, review ${item.attempt})` : ''}: ${item.result.status}${item.result.verification ? ` / ${item.result.verification.verdict}` : ''} — ${item.result.summary}`,
      ),
      '',
      `Rework retries: plan=${state.verification?.retries.plan ?? 0}, implementation=${state.verification?.retries.implementation ?? 0}; limit per phase=${state.config.maxReworkRetries ?? 2}`,
      '',
      '## Verification findings',
      ...state.results.flatMap((item) =>
        (item.result.verification?.findings ?? []).map(
          (finding) =>
            `\n### ${item.phase} review ${item.attempt}: ${finding.id}\n${finding.description}\n\nEvidence: ${finding.evidence}\n\nCriteria: ${finding.criteria.join(', ')}; tasks: ${finding.tasks.join(', ')}`,
        ),
      ),
      ...(state.escalation
        ? [
            '',
            '## Developer escalation',
            state.escalation.reason,
            `Artifact: ${state.escalation.artifact}`,
          ]
        : []),
      '',
      '## Questions',
      ...(last?.result.questions.map(
        (q) => `\n### ${q.id}: ${q.question}\n\nContext: ${q.context}\n\nBlocks: ${q.blocks}`,
      ) ?? []),
      '',
      '## Checks',
      ...state.checks.map((check) => `- ${check.name}: exit ${check.exitCode} (${check.log})`),
      '',
      ...(state.pullRequestUrl ? [`PR: ${state.pullRequestUrl}`] : []),
      ...(state.review
        ? [
            '',
            '## PR review',
            `Last checked: ${state.review.lastCheckedAt ?? '—'}`,
            ...state.review.records.map(
              (record) =>
                `- Thread ${record.threadId}: ${record.stage}, corrections=${record.attempts}, fingerprint=${record.fingerprint}`,
            ),
          ]
        : []),
      '',
      '## Integration errors',
      ...state.integrationErrors.map((error) => `- ${error}`),
    ].join('\n') + '\n';
  await writeFile(path.join(directory, 'report.md'), text);
  if (state.status === 'NEEDS_CLARIFICATION')
    await writeFile(path.join(directory, `clarification-${state.iteration}.md`), text);
  if (state.escalation) await writeFile(path.join(directory, state.escalation.artifact), text);
}

export async function finishRun(directory: string, state: RunState): Promise<void> {
  await report(directory, state);
  await notify(directory, state);
  await report(directory, state);
  await recordEvent(directory, state, 'run.status', {
    status: state.status,
    nextRole: state.nextRole,
    summary: state.summary,
  });
  await saveState(directory, state);
}
