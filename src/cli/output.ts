import path from 'node:path';
import type { RunState } from '../domain/types.ts';

export function writeRunResult(directory: string, state: RunState): void {
  const clarification =
    state.status === 'NEEDS_CLARIFICATION'
      ? {
          questions: state.results.at(-1)?.result.questions ?? [],
          clarificationFile: path.join(directory, `clarification-${state.iteration}.md`),
        }
      : {};
  process.stdout.write(
    JSON.stringify(
      {
        runDirectory: directory,
        status: state.status,
        summary: state.summary,
        integrationErrors: state.integrationErrors,
        ...clarification,
      },
      null,
      2,
    ) + '\n',
  );
  process.exitCode = exitCode(state.status);
}

function exitCode(status: RunState['status']): number {
  switch (status) {
    case 'COMPLETED':
    case 'WAITING_REVIEW':
      return 0;
    case 'NEEDS_CLARIFICATION':
      return 2;
    case 'CANCELLED':
      return 4;
    default:
      return 3;
  }
}
