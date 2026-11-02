import { setTimeout } from 'node:timers/promises';
import { watchOnce } from '../review/watcher.ts';
import type { RunState } from '../domain/types.ts';

export async function watchRun(directory: string, loop: boolean): Promise<RunState> {
  let state: RunState;
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    do {
      state = await watchOnce(directory);
      if (loop)
        process.stderr.write(
          `[watch ${new Date().toISOString()}] ${state.status}: ${state.summary}\n`,
        );
      if (!loop || state.status !== 'WAITING_REVIEW' || controller.signal.aborted) break;
      await setTimeout(3_600_000, undefined, { signal: controller.signal }).catch((error) => {
        if (error.name !== 'AbortError') throw error;
      });
    } while (!controller.signal.aborted);
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
  return state!;
}
