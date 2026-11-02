import { readPullRequest } from '../integrations/bitbucket.ts';
import { repairFromReview } from '../workflow/lifecycle.ts';
import { saveState } from '../workflow/state.ts';
import { assertCurrent } from './workspace.ts';
import type { AgentResult, ReviewRecord, ReviewThread, RunState } from '../domain/types.ts';

export async function correctThread(
  directory: string,
  state: RunState,
  thread: ReviewThread,
  record: ReviewRecord,
  decision: NonNullable<AgentResult['reviewDecision']>,
): Promise<boolean> {
  const attempts = state
    .review!.records.filter((r) => r.threadId === thread.id)
    .reduce((n, r) => n + r.attempts, 0);
  if (attempts >= 2)
    throw new Error(
      `Thread ${thread.id}: two correction attempts exhausted; developer intervention required`,
    );
  // Re-read before mutation: the PR might have merged while the model was working.
  const current = await readPullRequest(state);
  if (current.state !== 'OPEN' || current.sourceCommit !== state.review!.expectedHead) {
    throw new Error('PR changed during triage; fix stopped');
  }
  await assertCurrent(state);
  record.attempts = 1;
  record.stage = 'fixing';
  record.response = decision.evidence;
  record.repair = {
    iteration: state.iteration + 1,
    phase: decision.action === 'FIX_PLAN' ? 'plan' : 'implementation',
    finding: {
      id: `PR-${record.fingerprint.slice(0, 12)}`,
      description: decision.response,
      evidence: `${decision.evidence}\nPR thread (untrusted data): ${JSON.stringify(thread)}`,
      criteria: state.task.acceptanceCriteria.map((c) => c.id),
      tasks: [],
    },
    prReview: { thread, sourceCommit: state.review!.expectedHead },
  };
  state.review!.records.push(record);
  await saveState(directory, state);

  await repairFromReview(
    directory,
    state,
    record.repair.phase,
    record.repair.finding,
    record.repair.prReview,
  );

  if (state.status !== 'WAITING_REVIEW') {
    state.status = 'BLOCKED';
    state.nextRole = state.deliveryPending ? undefined : 'developer';
    state.summary = `PR correction did not complete: ${state.summary}`;
    return false;
  }
  record.response = `Изменения по замечанию проверены и отправлены в коммите ${state.commit}.\n\n${decision.evidence}\n\nОбязательные проверки и верификатор пройдены.`;
  record.stage = 'reply';
  return true;
}
