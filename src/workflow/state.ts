import { readFile, rename, writeFile, open, unlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';
import type { RunState } from '../domain/types.ts';

export async function saveState(directory: string, state: RunState): Promise<void> {
  const temporary = path.join(directory, 'state.tmp.json');
  await writeFile(temporary, JSON.stringify(state, null, 2) + '\n');
  await rename(temporary, path.join(directory, 'state.json'));
}

export async function readState(directory: string): Promise<RunState> {
  return JSON.parse(await readFile(path.join(directory, 'state.json'), 'utf8'));
}

/** Recover only a known dead local owner. A separate guard serializes stale-lock recovery. */
export async function acquireRunLock(
  directory: string,
  recoverStale = false,
): Promise<() => Promise<void>> {
  const file = path.join(directory, 'run.lock');
  const create = async () => {
    const handle = await open(file, 'wx');
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, host: hostname() }));
    } catch (error) {
      await handle.close();
      await unlink(file);
      throw error;
    }
    return async () => {
      await handle.close();
      await unlink(file);
    };
  };
  try {
    return await create();
  } catch (error) {
    if (!recoverStale || (error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const guardPath = path.join(directory, 'run.lock.recovery');
  const guard = await open(guardPath, 'wx');
  try {
    let owner: { pid: number; host: string };
    try {
      owner = JSON.parse(await readFile(file, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return await create();
      throw new Error('Unknown run.lock owner; inspect running processes before removing the lock');
    }
    if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0 || owner.host !== hostname())
      throw new Error('Cannot recover a run.lock without a known local owner');
    try {
      process.kill(owner.pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      await unlink(file);
      return await create();
    }
    throw new Error(`Run is locked by active process ${owner.pid}; stop it before continuing`);
  } finally {
    await guard.close();
    await unlink(guardPath);
  }
}
