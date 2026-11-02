import { threadFingerprint } from './identity.ts';
import { recordEvent } from '../infrastructure/events.ts';
import { readPullRequest } from '../integrations/bitbucket.ts';
import { saveState } from '../workflow/state.ts';
import { assertCurrent } from './workspace.ts';
import { triage } from './triage.ts';
import { reply } from './replies.ts';
import { correctThread } from './corrections.ts';
import type { PullRequestSnapshot, ReviewRecord, ReviewThread, RunState } from '../domain/types.ts';

function wasProcessed(state: RunState, thread: ReviewThread): boolean {
  return state.review!.records.some(
    (record) =>
      record.stage !== 'superseded' &&
      record.threadId === thread.id &&
      record.fingerprint === threadFingerprint(thread),
  );
}

function hasHumanDiscussion(thread: ReviewThread): boolean {
  return !thread.resolved && thread.comments.some((comment) => !comment.own);
}

export async function processThreads(
  directory: string,
  state: RunState,
  snapshot: PullRequestSnapshot,
): Promise<void> {
  const candidates = snapshot.threads
    .filter((thread) => hasHumanDiscussion(thread) && !wasProcessed(state, thread))
    .slice(0, 20);
  for (const candidate of candidates) {
    const refreshed = await readPullRequest(state);
    if (refreshed.state !== 'OPEN' || refreshed.sourceCommit !== state.review!.expectedHead) {
      throw new Error('PR changed before triage; processing stopped');
    }
    const thread = refreshed.threads.find((thread) => thread.id === candidate.id);
    if (!thread || !hasHumanDiscussion(thread) || wasProcessed(state, thread)) continue;

    const hash = threadFingerprint(thread);
    await assertCurrent(state);
    const decision = await triage(directory, state, thread, hash);
    await recordEvent(directory, state, 'review.triaged', {
      threadId: thread.id,
      fingerprint: hash,
      action: decision.action,
    });
    const afterTriage = await readPullRequest(state);
    if (afterTriage.state !== 'OPEN' || afterTriage.sourceCommit !== state.review!.expectedHead) {
      throw new Error('PR changed during triage; processing stopped');
    }
    const latestThread = afterTriage.threads.find((thread) => thread.id === candidate.id);
    if (!latestThread || latestThread.resolved || threadFingerprint(latestThread) !== hash)
      continue;

    const record: ReviewRecord = {
      threadId: thread.id,
      fingerprint: hash,
      attempts: 0,
      stage: 'reply',
    };
    if (decision.action === 'FIX_IMPLEMENTATION' || decision.action === 'FIX_PLAN') {
      if (!(await correctThread(directory, state, thread, record, decision))) break;
    } else {
      state.review!.records.push(record);
      record.response = `${decision.response}\n\nОбоснование: ${decision.evidence}`;
      state.summary =
        decision.action === 'CLARIFY'
          ? 'Clarification requested in PR; waiting for reviewer response.'
          : 'Review response prepared; waiting for PR review and merge.';
    }
    record.sourceCommit = state.review!.expectedHead;
    record.replyKey = `${state.id}:review:${hash}:${record.sourceCommit}`;
    await saveState(directory, state);
    try {
      await reply(directory, state, record);
      if (state.status !== 'WAITING_REVIEW') break;
    } catch (error) {
      state.integrationErrors.push(String(error));
      break;
    }
  }
}
