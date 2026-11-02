import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { callAdapter } from './adapter.ts';
import type { RunState } from '../domain/types.ts';

export async function notify(directory: string, state: RunState): Promise<void> {
  if (!state.config.integrations.taskTracker) return;
  try {
    await callAdapter(
      state.config.integrations.taskTracker,
      state.config.projectRoot,
      'task.report',
      {
        idempotencyKey: `${state.id}:${state.iteration}:${state.status}`,
        taskId: state.task.id,
        runId: state.id,
        status: state.status,
        summary: state.summary,
        returnToRole: state.nextRole,
        questions: state.results.at(-1)?.result.questions ?? [],
        report: await readFile(path.join(directory, 'report.md'), 'utf8'),
        pullRequestUrl: state.pullRequestUrl,
        openspec: state.openspec,
        escalation: state.escalation,
        verification: state.verification,
      },
    );
  } catch (error) {
    state.integrationErrors.push(String(error));
  }
}
