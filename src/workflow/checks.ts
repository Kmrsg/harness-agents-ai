import { recordEvent } from '../infrastructure/events.ts';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  execute,
  ProcessInterruptedError,
  ProcessExecutionError,
} from '../infrastructure/process.ts';
import { randomUUID } from 'node:crypto';
import { changeContext } from '../openspec/documents.ts';
import { validatePlan } from '../openspec/validation.ts';
import { saveState } from './state.ts';
import type { RunState, VerificationPhase } from '../domain/types.ts';

/** Objective checks are evidence for the reviewer; failed checks can never be approved away. */
export async function collectChecks(
  directory: string,
  state: RunState,
  phase: VerificationPhase,
): Promise<RunState['checks']> {
  const start = state.checks.length;
  const attempt = state.verification?.retries[phase] ?? 0;
  const record = async (
    name: string,
    operation: () => Promise<{ exitCode: number; stdout: string; stderr: string }>,
    successLog = true,
  ) => {
    let response;
    try {
      response = await operation();
    } catch (error) {
      if (error instanceof ProcessInterruptedError) {
        const log = `${state.iteration}-${phase}-interrupted-${randomUUID()}.log`;
        await writeFile(
          path.join(directory, log),
          error.stdout + '\n' + error.stderr + '\n' + error.message,
        );
        throw error;
      }
      response = {
        exitCode: -1,
        stdout: error instanceof ProcessExecutionError ? error.stdout : '',
        stderr:
          (error instanceof ProcessExecutionError ? error.stderr + '\n' : '') +
          (error instanceof Error ? error.message : String(error)),
      };
    }
    if (!successLog && response.exitCode === 0) return;
    const log = `${state.iteration}-${phase}-rework-${attempt}-check-${state.checks.length}.log`;
    await writeFile(path.join(directory, log), response.stdout + '\n' + response.stderr);
    state.checks.push({ name, exitCode: response.exitCode, log });
    await saveState(directory, state);
  };
  const localCheck = async (operation: () => Promise<void>) => {
    await operation();
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  await record(
    `OpenSpec ${phase} contract`,
    () =>
      localCheck(async () => {
        if (!state.openspec) throw new Error('Missing OpenSpec change');
        validatePlan(
          (await changeContext(state.workdir, state.openspec, '')).files,
          state.task,
          phase === 'implementation',
        );
      }),
    false,
  );
  if (phase === 'implementation') {
    await record(
      'Tester acceptance',
      () =>
        localCheck(async () => {
          const tester = state.results.findLast((item) => item.role === 'tester')?.result;
          for (const criterion of state.task.acceptanceCriteria)
            if (!tester?.acceptance.some((item) => item.id === criterion.id && item.passed))
              throw new Error(`Tester has not confirmed acceptance criterion ${criterion.id}`);
          if (tester?.status !== 'COMPLETED')
            throw new Error('Tester has not completed validation');
          const latest = new Map(state.results.map((item) => [item.role, item.result]));
          for (const [role, result] of latest)
            if (role.endsWith('-implementer') && result.status !== 'COMPLETED')
              throw new Error(`${role} is not completed`);
        }),
      false,
    );
    if (state.config.git.enabled)
      await record(
        'Git diff check',
        () => execute({ command: 'git', args: ['diff', '--check'] }, state.workdir),
        false,
      );
    for (const check of state.config.checks)
      await record(check.name, () =>
        execute(check, state.workdir, '', state.config.timeoutMs, state.config.maxOutputBytes),
      );
  }
  if (state.config.openspec && state.openspec) {
    const validator = state.config.openspec.validator;
    await record(`OpenSpec ${phase === 'plan' ? 'plan' : 'final'}`, () =>
      execute(
        {
          command: validator.command,
          args: [
            ...validator.args,
            'validate',
            state.openspec!.name,
            '--type',
            'change',
            '--strict',
            '--no-interactive',
          ],
        },
        state.workdir,
        '',
        state.config.timeoutMs,
        state.config.maxOutputBytes,
      ),
    );
  }
  const checks = state.checks.slice(start);
  await recordEvent(directory, state, 'checks.finished', {
    phase,
    checks: checks.map(({ name, exitCode }) => ({ name, exitCode })),
  });
  return checks;
}
