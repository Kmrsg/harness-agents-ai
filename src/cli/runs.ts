import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { readState } from '../workflow/state.ts';

/** Local inventory only: an unreadable run is listed as an error, never silently omitted. */
export async function listRuns(root: string) {
  const directory = path.join(root, '.harness', 'runs');
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const runs = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const runDirectory = path.join(directory, entry.name);
        try {
          const state = await readState(runDirectory);
          const modified = await stat(path.join(runDirectory, 'state.json'));
          return {
            id: state.id,
            taskId: state.task.id,
            title: state.task.title,
            status: state.status,
            nextRole: state.nextRole,
            stage:
              state.checkpoint?.stage ??
              (state.preparation && !state.preparation.ready ? 'preparation' : undefined),
            interrupted: state.interrupted ?? false,
            updatedAt: modified.mtime.toISOString(),
            pullRequestUrl: state.pullRequestUrl,
            runDirectory,
          };
        } catch (error) {
          return { id: entry.name, runDirectory, error: String(error), updatedAt: '' };
        }
      }),
  );
  return runs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
}
