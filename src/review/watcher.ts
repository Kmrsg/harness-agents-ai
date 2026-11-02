import { withRunProcesses, ProcessInterruptedError } from '../infrastructure/process.ts';
import { recordEvent } from '../infrastructure/events.ts';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readPullRequest } from '../integrations/bitbucket.ts';
import { AdapterCallError } from '../integrations/adapter.ts';
import { notify } from '../integrations/task-tracker.ts';
import { acquireRunLock, readState, saveState } from '../workflow/state.ts';
import { report } from '../workflow/reporting.ts';
import { processThreads } from './threads.ts';
import { assertCurrent } from './workspace.ts';
import { reply } from './replies.ts';
import type { PullRequestSnapshot, RunState } from '../domain/types.ts';

function closeRun(state: RunState, snapshot: PullRequestSnapshot): void {
  state.status = snapshot.state === 'MERGED' ? 'COMPLETED' : 'CANCELLED';
  state.summary =
    snapshot.state === 'MERGED'
      ? 'PR merged; task completed.'
      : 'PR closed without merge; automation stopped.';
  state.nextRole = undefined;
  state.deliveryPending = false;
}

async function processOpenPullRequest(
  directory: string,
  state: RunState,
  snapshot: PullRequestSnapshot,
): Promise<void> {
  const interrupted = state.review!.records.find((record) => record.stage === 'fixing');
  if (state.status === 'RUNNING' && interrupted) {
    throw new Error('Interrupted PR correction; inspect saved artifacts before continuing');
  }
  const canProcess =
    state.status === 'WAITING_REVIEW' ||
    (state.status === 'COMPLETED' && !state.review!.records.length);
  if (!canProcess) return;

  state.status = 'WAITING_REVIEW';
  if (snapshot.sourceCommit !== state.review!.expectedHead) {
    throw new Error('PR source branch changed; developer intervention required');
  }
  await assertCurrent(state);
  if (interrupted) {
    throw new Error(
      `Interrupted fix for thread ${interrupted.threadId}; inspect saved artifacts before continuing`,
    );
  }
  const pending = state.review!.records.find((record) => record.stage === 'reply');
  if (pending) {
    try {
      await reply(directory, state, pending);
    } catch (error) {
      state.integrationErrors.push(String(error));
    }
    return;
  }
  await processThreads(directory, state, snapshot);
}

/** One bounded poll: idle PRs do not call a model; one run lock covers all mutations. */
export async function watchOnce(directory: string, locked = false): Promise<RunState> {
  return withRunProcesses(directory, async () => {
    const release = locked ? undefined : await acquireRunLock(directory);
    try {
      const state = await readState(directory);
      if (!state.pullRequestUrl) throw new Error('No published PR to watch');
      if (state.status === 'CANCELLED' || (state.status === 'COMPLETED' && state.review))
        return state;
      const previousStatus = state.status;
      let snapshot: PullRequestSnapshot;
      try {
        snapshot = await readPullRequest(state);
      } catch (error) {
        state.integrationErrors.push(String(error));
        await saveState(directory, state);
        return state;
      }
      state.review ??= { expectedHead: state.commit!, records: [] };
      state.review.lastCheckedAt = new Date().toISOString();
      try {
        if (snapshot.state !== 'OPEN') closeRun(state, snapshot);
        else await processOpenPullRequest(directory, state, snapshot);
      } catch (error) {
        if (error instanceof AdapterCallError && error.operation === 'pull-request.get') {
          state.integrationErrors.push(String(error));
          await saveState(directory, state);
          return state;
        }
        state.status = 'BLOCKED';
        state.interrupted ||= error instanceof ProcessInterruptedError;
        state.nextRole = 'developer';
        state.deliveryPending = false;
        state.summary = `PR review escalation: ${error instanceof Error ? error.message : String(error)}`;
        await writeFile(path.join(directory, 'review-escalation.md'), state.summary + '\n');
      }
      await report(directory, state);
      if (state.status !== previousStatus) {
        await recordEvent(directory, state, 'run.status', {
          status: state.status,
          nextRole: state.nextRole,
          summary: state.summary,
        });
        await notify(directory, state);
      }
      await saveState(directory, state);
      return state;
    } finally {
      await release?.();
    }
  });
}
