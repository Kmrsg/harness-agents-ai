import { mkdir, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { git, prepareWorktree } from '../infrastructure/git.ts';
import { workspaceFingerprint } from '../infrastructure/workspace.ts';
import { execute, ProcessExecutionError } from '../infrastructure/process.ts';
import { saveState } from './state.ts';
import type { RunState } from '../domain/types.ts';

/** Setup commands must be idempotent: the command interrupted before its checkpoint is repeated. */
export async function prepareRun(directory: string, state: RunState): Promise<void> {
  state.preparation ??= { ready: false, nextSetup: 0, attempts: {} };
  if (state.preparation.ready) return;
  if (state.config.git.enabled) {
    state.branch ??= `codex/${state.id}`;
    state.workdir = path.join(state.config.projectRoot, '.harness', 'worktrees', state.id);
    await saveState(directory, state);
    await mkdir(path.dirname(state.workdir), { recursive: true });
    try {
      await stat(state.workdir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await prepareWorktree(
        state.config.projectRoot,
        state.workdir,
        state.branch,
        state.config.git.baseRef,
      );
    }
    await assertRunWorkspace(state);
  }
  for (
    let index = state.preparation.nextSetup;
    index < (state.config.setup?.length ?? 0);
    index++
  ) {
    const attempt = (state.preparation.attempts[index] ?? 0) + 1;
    state.preparation.attempts[index] = attempt;
    await saveState(directory, state);
    const log = path.join(
      directory,
      `setup-${index}${attempt > 1 ? `-attempt-${attempt}` : ''}.log`,
    );
    let response;
    try {
      response = await execute(
        state.config.setup![index],
        state.workdir,
        '',
        state.config.timeoutMs,
        state.config.maxOutputBytes,
      );
    } catch (error) {
      await writeFile(
        log,
        (error instanceof ProcessExecutionError ? error.stdout + '\n' + error.stderr + '\n' : '') +
          String(error),
      );
      throw error;
    }
    await writeFile(log, response.stdout + '\n' + response.stderr);
    if (response.exitCode !== 0)
      throw new Error(`Setup command ${index} failed (exit ${response.exitCode})`);
    state.preparation.nextSetup = index + 1;
    await saveState(directory, state);
  }
  state.preparation.ready = true;
  await saveState(directory, state);
}

export async function assertRunWorkspace(state: RunState): Promise<void> {
  if (!(await stat(state.workdir)).isDirectory()) throw new Error('Run workdir is missing');
  if (!state.config.git.enabled) return;
  const root = await git(state.workdir, ['rev-parse', '--show-toplevel']);
  if ((await realpath(root)) !== (await realpath(state.workdir)))
    throw new Error('Saved workdir is not the original Git worktree');
  const branch = await git(state.workdir, ['symbolic-ref', '--short', 'HEAD']);
  if (!state.branch || branch !== state.branch)
    throw new Error('Run branch changed; continuation stopped');
  const common = await git(state.workdir, [
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
  ]);
  const expected = await git(state.config.projectRoot, [
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
  ]);
  if ((await realpath(common)) !== (await realpath(expected)))
    throw new Error('Run worktree belongs to another repository');
}

/** An accepted delivery commit is the only allowed HEAD transition outside a new workflow step. */
export async function assertRunHead(state: RunState, reconcileDelivery = false): Promise<void> {
  const checkpoint = state.checkpoint;
  if (!state.config.git.enabled || !checkpoint?.head) return;
  const head = await git(state.workdir, ['rev-parse', 'HEAD']);
  if (head === checkpoint.head) return;
  if (reconcileDelivery && (checkpoint.stage === 'delivery' || state.deliveryPending)) {
    const parent = await git(state.workdir, ['rev-parse', 'HEAD^']);
    const subject = await git(state.workdir, ['show', '-s', '--format=%s', 'HEAD']);
    if (
      parent === checkpoint.head &&
      subject === `${state.task.id}: ${state.task.title}` &&
      (await workspaceFingerprint(state.workdir, true)) ===
        state.verification?.implementationApproval?.workspace
    ) {
      state.commit = head;
      return;
    }
  }
  throw new Error('Run HEAD changed; continuation stopped');
}
