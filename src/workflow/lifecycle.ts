import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ProcessInterruptedError, withRunProcesses } from '../infrastructure/process.ts';
import { prepareRun } from './preparation.ts';
import { acquireRunLock, readState, saveState } from './state.ts';
import { recordEvent } from '../infrastructure/events.ts';
import { executeWorkflow } from './pipeline.ts';
import type {
  AgentRequest,
  Config,
  Finding,
  RunState,
  Task,
  VerificationPhase,
} from '../domain/types.ts';

export async function start(
  task: Task,
  config: Config,
): Promise<{ directory: string; state: RunState }> {
  const id = `${task.id}-${randomUUID()}`;
  const directory = path.join(config.projectRoot, '.harness', 'runs', id);
  await mkdir(directory, { recursive: true });
  // Snapshot the specification before creating an isolated checkout (it may be untracked).
  const specPath = path.resolve(config.projectRoot, task.specPath);
  const specification = await readFile(specPath, 'utf8');
  if (!specification.trim()) throw new Error('Specification is empty');
  await writeFile(path.join(directory, 'specification.md'), specification);
  const state: RunState = {
    version: 1,
    id,
    task,
    config,
    status: 'RUNNING',
    iteration: 1,
    workdir: config.projectRoot,
    results: [],
    clarificationHistory: [],
    checks: [],
    summary: 'Created',
    integrationErrors: [],
    preparation: { ready: false, nextSetup: 0, attempts: {} },
  };
  await saveState(directory, state);
  await recordEvent(directory, state, 'run.started', { taskId: task.id });
  return withRunProcesses(directory, async () => {
    const release = await acquireRunLock(directory);
    try {
      try {
        await prepareRun(directory, state);
      } catch (error) {
        state.status = 'BLOCKED';
        state.interrupted = error instanceof ProcessInterruptedError;
        state.summary = String(error);
        await recordEvent(directory, state, 'run.status', {
          status: state.status,
          summary: state.summary,
        });
        await saveState(directory, state);
        return { directory, state };
      }
      await executeWorkflow(directory, state, { locked: true });
      return { directory, state };
    } finally {
      await release();
    }
  });
}

export async function resume(directory: string, answer: string): Promise<RunState> {
  const state: RunState = await readState(directory);
  if (state.status !== 'NEEDS_CLARIFICATION')
    throw new Error('Only NEEDS_CLARIFICATION runs can be resumed');
  if (!answer.trim()) throw new Error('Answers must not be empty');
  if (state.iteration >= state.config.maxIterations)
    throw new Error('Clarification iteration limit exhausted');
  const questions = state.results.at(-1)!.result.questions;
  state.clarificationHistory.push({ questions, answer });
  state.iteration += 1;
  await executeWorkflow(directory, state, { resuming: true });
  return state;
}

/** Called only by the watcher while holding run.lock. Existing spec and approval remain authoritative. */
export async function repairFromReview(
  directory: string,
  state: RunState,
  phase: VerificationPhase,
  finding: Finding,
  prReview: NonNullable<AgentRequest['prReview']>,
): Promise<void> {
  state.iteration += 1;
  await executeWorkflow(directory, state, { repair: { phase, finding, prReview } });
}
