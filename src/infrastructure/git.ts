import { execute } from './process.ts';

export async function git(cwd: string, args: string[]): Promise<string> {
  const response = await execute({ command: 'git', args }, cwd, '', 60_000);
  if (response.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${response.stderr.trim()}`);
  return response.stdout.trim();
}
export async function prepareWorktree(
  root: string,
  workdir: string,
  branch: string,
  baseRef: string,
): Promise<void> {
  if (baseRef.startsWith('-')) throw new Error('Invalid base ref');
  await git(root, ['rev-parse', '--verify', `${baseRef}^{commit}`]);
  await git(root, ['check-ref-format', '--branch', branch]);
  await git(root, ['worktree', 'add', '-b', branch, workdir, baseRef]);
}
export async function commitChanges(
  workdir: string,
  taskId: string,
  title: string,
): Promise<string | undefined> {
  // Runtime artifacts never enter a product commit, even when the target repo lacks our .gitignore.
  // Also completes delivery interrupted after staging, before git commit.
  await git(workdir, ['add', '-A', '--', '.', ':(exclude).harness']);
  const cached = await execute(
    { command: 'git', args: ['diff', '--cached', '--name-only', '-z'] },
    workdir,
  );
  if (cached.exitCode !== 0) throw new Error('Cannot inspect staged delivery files');
  const staged = cached.stdout.split('\0').filter(Boolean);
  if (staged.some((file) => file === '.harness' || file.startsWith('.harness/')))
    throw new Error('Runtime .harness artifacts must not be staged for delivery');
  if (!staged.length) return undefined;
  await git(workdir, ['diff', '--cached', '--check']);
  await git(workdir, ['commit', '-m', `${taskId}: ${title}`]);
  return git(workdir, ['rev-parse', 'HEAD']);
}
