import { withRunProcesses } from '../infrastructure/process.ts';
import { readdir, readFile, unlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';
import { ProcessInterruptedError } from '../infrastructure/process.ts';
import { workspaceFingerprint } from '../infrastructure/workspace.ts';
import { recordEvent } from '../infrastructure/events.ts';
import { changeContext } from '../openspec/documents.ts';
import { readPullRequest } from '../integrations/bitbucket.ts';
import { threadFingerprint } from '../review/identity.ts';
import { completeCorrection } from '../review/complete-correction.ts';
import { watchOnce } from '../review/watcher.ts';
import { executeWorkflow } from './pipeline.ts';
import { prepareRun, assertRunWorkspace, assertRunHead } from './preparation.ts';
import { retryDelivery } from './delivery.ts';
import { finishRun } from './reporting.ts';
import { acquireRunLock, readState, saveState } from './state.ts';
import { planFingerprint } from './verification.ts';
import type { RunState } from '../domain/types.ts';

/** Continue one saved run. The lock and validation precede any workspace or state mutation. */
export async function continueRun(directory: string): Promise<RunState> {
  return withRunProcesses(directory, async () => {
    const release = await acquireRunLock(directory, true);
    try {
      await assertNoActiveProcesses(directory);
      let state = await readState(directory);
      if (state.status === 'NEEDS_CLARIFICATION')
        throw new Error('Use resume with answers for NEEDS_CLARIFICATION');
      if (state.status === 'COMPLETED' || state.status === 'CANCELLED')
        throw new Error(`Run is already ${state.status}`);
      if (state.escalation) throw new Error('Developer escalation cannot be bypassed by continue');
      const fixing = state.review?.records.find((record) => record.stage === 'fixing');
      const pendingRepair =
        fixing?.repair && state.iteration < fixing.repair.iteration ? fixing.repair : undefined;
      if (state.status === 'WAITING_REVIEW' && !fixing) return await watchOnce(directory, true);
      if (!state.checkpoint && !state.preparation)
        throw new Error(
          'Legacy run has no continuation checkpoint; automatic recovery is unavailable',
        );
      if (
        state.status !== 'RUNNING' &&
        !state.interrupted &&
        !state.deliveryPending &&
        !(state.status === 'WAITING_REVIEW' && fixing)
      )
        throw new Error('Continue requires an interrupted run; inspect the BLOCKED cause');
      if (fixing && !state.checkpoint?.prReview && !pendingRepair)
        throw new Error('Interrupted PR correction has no saved review context');

      if (state.preparation?.ready) await assertRunWorkspace(state);
      if (state.checkpoint) await validateCheckpoint(state);
      if (fixing) {
        const snapshot = await readPullRequest(state);
        if (snapshot.state !== 'OPEN') return await watchOnce(directory, true);
        const thread = snapshot.threads.find((item) => item.id === fixing.threadId);
        if (!thread || thread.resolved || threadFingerprint(thread) !== fixing.fingerprint)
          throw new Error(
            'PR discussion changed during interruption; developer review is required',
          );
        if (snapshot.sourceCommit !== state.review!.expectedHead) {
          if (!state.deliveryPending || snapshot.sourceCommit !== state.commit)
            throw new Error('PR source branch changed during interruption');
          // The exact approved commit was pushed before its expected-head checkpoint was saved.
          state.review!.expectedHead = snapshot.sourceCommit;
        }
      }
      await recordEvent(directory, state, 'run.continued', {
        stage: state.checkpoint?.stage ?? 'preparation',
      });
      if (state.deliveryPending) {
        // Keep the existing delivery contract: recheck files and commands before publishing.
        state.status = 'BLOCKED';
        await saveState(directory, state);
        return await retryDelivery(directory, true);
      } else {
        try {
          state.status = 'RUNNING';
          state.interrupted = false;
          await saveState(directory, state);
          await prepareRun(directory, state);
          if (pendingRepair) state.iteration = pendingRepair.iteration;
          await executeWorkflow(directory, state, {
            continuing: !!state.checkpoint && !pendingRepair,
            repair: pendingRepair,
            locked: true,
          });
        } catch (error) {
          state.status = 'BLOCKED';
          state.interrupted = error instanceof ProcessInterruptedError;
          state.summary = String(error);
          await finishRun(directory, state);
        }
      }
      await completeCorrection(directory, state);
      await finishRun(directory, state);
      return state;
    } finally {
      await release();
    }
  });
}

async function assertNoActiveProcesses(directory: string): Promise<void> {
  const root = path.join(directory, 'processes');
  let files: string[];
  try {
    files = await readdir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  for (const file of files) {
    const owner = JSON.parse(await readFile(path.join(root, file), 'utf8'));
    if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0 || owner.host !== hostname())
      throw new Error('Unknown child process owner; inspect processes before continuing');
    try {
      process.kill(process.platform === 'win32' ? owner.pid : -owner.pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      await unlink(path.join(root, file));
      continue;
    }
    throw new Error(`Child process group ${owner.pid} is still active; stop it before continuing`);
  }
}

async function validateCheckpoint(state: RunState): Promise<void> {
  const checkpoint = state.checkpoint!;
  const current = await workspaceFingerprint(state.workdir, state.config.git.enabled);
  if (checkpoint.active?.readOnlyFingerprint && current !== checkpoint.active.readOnlyFingerprint)
    throw new Error(
      'Read-only role modified the workspace before interruption; continuation stopped',
    );
  const canHavePartialWrites =
    (checkpoint.active && !checkpoint.active.readOnlyFingerprint) ||
    checkpoint.stage.endsWith('-checks') ||
    checkpoint.stage === 'rework';
  if (!canHavePartialWrites && checkpoint.workspace && current !== checkpoint.workspace)
    throw new Error('Workspace changed outside the interrupted step; continuation stopped');
  if (state.verification?.planApproval && state.openspec) {
    const files = (await changeContext(state.workdir, state.openspec, '')).files;
    if (planFingerprint(files) !== state.verification.planApproval)
      throw new Error('Approved plan changed during interruption; a new plan review is required');
  }
  await assertRunHead(state, true);
}
