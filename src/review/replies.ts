import { callAdapter } from '../integrations/adapter.ts';
import { readPullRequest } from '../integrations/bitbucket.ts';
import { recordEvent } from '../infrastructure/events.ts';
import { saveState } from '../workflow/state.ts';
import { threadFingerprint } from './identity.ts';
import type { ReviewRecord, RunState } from '../domain/types.ts';

/** Send exactly the persisted response, but only while its thread and code context are current. */
export async function reply(
  directory: string,
  state: RunState,
  record: ReviewRecord,
): Promise<void> {
  const snapshot = await readPullRequest(state);
  const thread = snapshot.threads.find((thread) => thread.id === record.threadId);
  const obsolete =
    snapshot.state !== 'OPEN' ||
    !thread ||
    thread.resolved ||
    threadFingerprint(thread) !== record.fingerprint;
  if (obsolete) {
    record.stage = 'superseded';
    if (snapshot.state !== 'OPEN') {
      state.status = snapshot.state === 'MERGED' ? 'COMPLETED' : 'CANCELLED';
      state.summary =
        snapshot.state === 'MERGED'
          ? 'PR merged; task completed.'
          : 'PR closed without merge; automation stopped.';
      state.nextRole = undefined;
      state.deliveryPending = false;
    }
    await recordEvent(directory, state, 'review.reply.superseded', {
      threadId: record.threadId,
      fingerprint: record.fingerprint,
    });
    await saveState(directory, state);
    return;
  }
  if (
    snapshot.sourceCommit !== state.review!.expectedHead ||
    snapshot.sourceCommit !== (record.sourceCommit ?? state.review!.expectedHead)
  ) {
    throw new Error('PR changed before reply; reply stopped');
  }
  if (!record.replyKey || !record.response) throw new Error('Saved reply is incomplete');
  try {
    await callAdapter(
      state.config.integrations.bitbucket!,
      state.config.projectRoot,
      'pull-request.reply',
      {
        url: state.pullRequestUrl,
        runId: state.id,
        branch: state.branch,
        threadId: record.threadId,
        idempotencyKey: record.replyKey,
        body: record.response,
        expectedSourceCommit: snapshot.sourceCommit,
        expectedThreadFingerprint: record.fingerprint,
      },
    );
    record.stage = 'done';
    await recordEvent(directory, state, 'review.reply.sent', {
      threadId: record.threadId,
      idempotencyKey: record.replyKey,
    });
    await saveState(directory, state);
  } catch (error) {
    await recordEvent(directory, state, 'review.reply.failed', {
      threadId: record.threadId,
      idempotencyKey: record.replyKey,
    });
    throw error;
  }
}
