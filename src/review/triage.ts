import { executeAgentStep } from '../agents/step.ts';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { instructions } from '../agents/instructions.ts';
import { changeContext } from '../openspec/documents.ts';
import type { AgentRequest, ReviewThread, RunState } from '../domain/types.ts';

export async function triage(
  directory: string,
  state: RunState,
  thread: ReviewThread,
  hash: string,
) {
  const artifactDirectory = path.join(
    state.workdir,
    '.harness',
    'artifacts',
    state.id,
    'review',
    hash,
  );
  await mkdir(artifactDirectory, { recursive: true });
  const relative = path.relative(state.workdir, artifactDirectory);
  if (!state.openspec) throw new Error('Missing OpenSpec change for PR review');
  const request: AgentRequest = {
    role: 'review-triager',
    task: state.task,
    specification: await readFile(path.join(directory, 'specification.md'), 'utf8'),
    instructions: await instructions('review-triager', state.config),
    context: [],
    clarificationHistory: state.clarificationHistory,
    artifactDirectory: relative,
    workdir: state.workdir,
    openspec: await changeContext(state.workdir, state.openspec, relative),
    prReview: { thread, sourceCommit: state.review!.expectedHead },
    checks: await Promise.all(
      state.checks.map(async (check) => ({
        ...check,
        output: (await readFile(path.join(directory, check.log), 'utf8')).slice(-64_000),
      })),
    ),
  };
  const prefix = path.join(directory, `review-${hash}`);
  const { result } = await executeAgentStep(directory, state, request, prefix);
  if (result.status !== 'COMPLETED')
    throw new Error(`Review triage ${result.status}: ${result.summary}`);
  return result.reviewDecision!;
}
