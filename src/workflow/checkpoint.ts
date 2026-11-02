import { git } from '../infrastructure/git.ts';
import { workspaceFingerprint } from '../infrastructure/workspace.ts';
import { saveState } from './state.ts';
import type { RunState, WorkflowCheckpoint } from '../domain/types.ts';

/** Compute evidence before changing the live state; errors must leave the last boundary intact. */
export async function sealCheckpoint(
  directory: string,
  state: RunState,
  updates: Partial<RunState> = {},
): Promise<void> {
  const workspace = await workspaceFingerprint(state.workdir, state.config.git.enabled);
  const head = state.config.git.enabled
    ? await git(state.workdir, ['rev-parse', 'HEAD'])
    : undefined;
  const next = {
    ...state,
    ...updates,
    checkpoint: { ...(updates.checkpoint ?? state.checkpoint!), workspace, head },
  };
  await saveState(directory, next);
  Object.assign(state, next);
}

export async function advance(
  directory: string,
  state: RunState,
  stage: WorkflowCheckpoint['stage'],
  index = 0,
  keepChecks = false,
  updates: Partial<RunState> = {},
): Promise<void> {
  await sealCheckpoint(directory, state, {
    ...updates,
    checkpoint: {
      ...state.checkpoint!,
      stage,
      index,
      resultIndex: undefined,
      active: undefined,
      checkStart: keepChecks ? state.checkpoint!.checkStart : undefined,
    },
  });
}
