import { completeCorrection } from '../review/complete-correction.ts';
import { withRunProcesses } from '../infrastructure/process.ts';
import { recordEvent } from '../infrastructure/events.ts';
import { commitChanges, git } from '../infrastructure/git.ts';
import { execute } from '../infrastructure/process.ts';
import { callAdapter } from '../integrations/adapter.ts';
import { readPullRequest } from '../integrations/bitbucket.ts';
import { changeContext } from '../openspec/documents.ts';
import { validatePlan } from '../openspec/validation.ts';
import { planFingerprint } from './verification.ts';
import { workspaceFingerprint } from '../infrastructure/workspace.ts';
import { acquireRunLock, readState, saveState } from './state.ts';
import { finishRun } from './reporting.ts';
import { collectChecks } from './checks.ts';
import { assertRunWorkspace, assertRunHead } from './preparation.ts';
import type { RunState } from '../domain/types.ts';

async function assertApproval(state: RunState): Promise<void> {
  const proof = state.verification?.implementationApproval;
  if (
    state.escalation ||
    !proof ||
    !state.openspec ||
    state.verification?.planApproval !== proof.plan
  )
    throw new Error('Delivery requires verifier approval of both plan and implementation');
  const files = (await changeContext(state.workdir, state.openspec, '')).files;
  validatePlan(files, state.task, true);
  if (
    planFingerprint(files) !== proof.plan ||
    (await workspaceFingerprint(state.workdir, state.config.git.enabled)) !== proof.workspace
  )
    throw new Error('Files changed after verifier approval; a new verification is required');
}

export async function verifyAndDeliver(directory: string, state: RunState): Promise<void> {
  await assertRunWorkspace(state);
  await assertApproval(state);
  await assertRunHead(state, true);
  state.deliveryPending = true;
  await saveState(directory, state);
  if (state.pullRequestUrl) await assertOpenPullRequest(state);
  if (state.config.git.enabled) {
    state.commit =
      (await commitChanges(state.workdir, state.task.id, state.task.title)) ?? state.commit;
    // Commit hooks may format files or change only the index. Never push a changed tree under an old approval.
    await assertApproval(state);
    const committed = await execute(
      { command: 'git', args: ['diff', '--exit-code', 'HEAD', '--', '.', ':(exclude).harness'] },
      state.workdir,
    );
    if (committed.exitCode !== 0)
      throw new Error('Committed tree differs from reviewed product files');
  }
  if (state.config.git.publish) {
    if (!state.commit) throw new Error('No product changes to publish');
    await saveState(directory, state);
    if (state.pullRequestUrl) {
      await assertOpenPullRequest(state);
      await git(state.workdir, ['merge-base', '--is-ancestor', state.review!.expectedHead, 'HEAD']);
      await git(state.workdir, [
        'push',
        `--force-with-lease=refs/heads/${state.branch}:${state.review!.expectedHead}`,
        'origin',
        `HEAD:refs/heads/${state.branch}`,
      ]);
    } else {
      await git(state.workdir, ['push', '--set-upstream', 'origin', state.branch!]);
      const pr = await callAdapter(
        state.config.integrations.bitbucket!,
        state.config.projectRoot,
        'pull-request.create',
        {
          idempotencyKey: state.id,
          taskId: state.task.id,
          branch: state.branch,
          baseRef: state.config.git.baseRef,
          title: `${state.task.id}: ${state.task.title}`,
          description: state.results.map((r) => `${r.role}: ${r.result.summary}`).join('\n'),
          commit: state.commit,
        },
      );
      if (typeof pr.url !== 'string' || !/^https?:\/\//.test(pr.url))
        throw new Error('Bitbucket adapter must return PR url');
      state.pullRequestUrl = pr.url;
    }
    state.review ??= { expectedHead: state.commit, records: [] };
    state.review.expectedHead = state.commit;
  }
  state.status = state.pullRequestUrl ? 'WAITING_REVIEW' : 'COMPLETED';
  state.nextRole = undefined;
  state.interrupted = false;
  state.deliveryPending = false;
  state.summary = state.pullRequestUrl
    ? 'Changes published; waiting for PR review and merge.'
    : 'Verifier approved plan and implementation; tester acceptance and mandatory checks passed.';
  if (state.checkpoint) {
    state.checkpoint = {
      ...state.checkpoint,
      stage: 'done',
      index: 0,
      active: undefined,
      resultIndex: undefined,
      checkStart: undefined,
      workspace: state.verification!.implementationApproval!.workspace,
      head: state.commit ?? state.checkpoint.head,
    };
  }
  await saveState(directory, state);
  await recordEvent(directory, state, 'delivery.published', {
    commit: state.commit,
    pullRequestUrl: state.pullRequestUrl,
  });
}

/** Only delivery failures after approval can be retried; escalation cannot be bypassed. */
export async function retryDelivery(directory: string, locked = false): Promise<RunState> {
  return withRunProcesses(directory, async () => {
    const release = locked ? undefined : await acquireRunLock(directory);
    try {
      const state: RunState = await readState(directory);
      if (
        state.status !== 'BLOCKED' ||
        !state.deliveryPending ||
        state.escalation ||
        !state.verification?.implementationApproval
      )
        throw new Error('Delivery retry requires a publication failure after verifier approval');
      await assertRunWorkspace(state);
      state.integrationErrors = [];
      try {
        await assertApproval(state);
        await assertRunHead(state, true);
        const checks = await collectChecks(directory, state, 'implementation');
        if (checks.some((check) => check.exitCode !== 0))
          throw new Error('Mandatory checks failed during delivery retry');
        await verifyAndDeliver(directory, state);
        await completeCorrection(directory, state);
      } catch (error) {
        state.status = 'BLOCKED';
        state.summary = String(error);
      }
      await finishRun(directory, state);
      return state;
    } finally {
      await release?.();
    }
  });
}

async function assertOpenPullRequest(state: RunState): Promise<void> {
  const snapshot = await readPullRequest(state);
  if (snapshot.state !== 'OPEN')
    throw new Error('PR closed, merged or its source branch changed; publication stopped');
  if (snapshot.sourceCommit === state.review?.expectedHead) return;
  if (
    state.deliveryPending &&
    snapshot.sourceCommit === state.commit &&
    (await git(state.workdir, ['rev-parse', 'HEAD'])) === state.commit
  ) {
    await git(state.workdir, ['merge-base', '--is-ancestor', state.review!.expectedHead, 'HEAD']);
    state.review!.expectedHead = snapshot.sourceCommit;
    return;
  }
  throw new Error('PR closed, merged or its source branch changed; publication stopped');
}
