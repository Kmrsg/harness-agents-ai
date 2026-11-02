import { git } from '../infrastructure/git.ts';
import type { RunState } from '../domain/types.ts';

export async function assertCurrent(state: RunState): Promise<void> {
  if (!state.branch || !state.config.git.enabled || !state.config.git.publish)
    throw new Error('Review fixes require a published isolated Git branch');
  if ((await git(state.workdir, ['rev-parse', 'HEAD'])) !== state.review!.expectedHead)
    throw new Error('Local HEAD changed; developer intervention required');
  const changed = await git(state.workdir, [
    'status',
    '--porcelain',
    '--untracked-files=all',
    '--',
    '.',
    ':(exclude).harness',
  ]);
  if (changed) throw new Error('Worktree has changes; developer intervention required');
  const remote = await git(state.workdir, [
    'ls-remote',
    '--heads',
    'origin',
    `refs/heads/${state.branch}`,
  ]);
  if (remote.split(/\s+/)[0] !== state.review!.expectedHead)
    throw new Error('Remote branch changed; developer intervention required');
}
