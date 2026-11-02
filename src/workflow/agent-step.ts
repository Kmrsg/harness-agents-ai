import { executeAgentStep } from '../agents/step.ts';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { instructions } from '../agents/instructions.ts';
import { changeContext } from '../openspec/documents.ts';
import { saveState } from './state.ts';
import { sealCheckpoint } from './checkpoint.ts';
import { roleContracts } from '../agents/contracts.ts';
import { workspaceFingerprint } from '../infrastructure/workspace.ts';
import { suspendForResult } from './control.ts';
import { artifactManifest, restoreArtifacts } from '../agents/saved-artifacts.ts';
import type {
  AgentRequest,
  AgentResult,
  Role,
  RunState,
  VerificationPhase,
} from '../domain/types.ts';

interface StepOptions {
  phase?: VerificationPhase;
  allowBlocked?: boolean;
}

/** One workflow iteration: role context, invocation numbers and the latest check evidence. */
export class AgentSession {
  checks: RunState['checks'] = [];
  private readonly counts = new Map<string, number>();

  private constructor(
    private readonly directory: string,
    private readonly state: RunState,
    private readonly specification: string,
    private readonly context: AgentRequest['context'],
    private readonly prReview?: AgentRequest['prReview'],
  ) {}

  static async create(
    directory: string,
    state: RunState,
    prReview?: AgentRequest['prReview'],
    continuing = false,
  ): Promise<AgentSession> {
    const specification = await readFile(path.join(directory, 'specification.md'), 'utf8');
    const context: AgentRequest['context'] = [];
    if (prReview || continuing) {
      for (const item of state.results) {
        const contents = await restoreArtifacts(state.workdir, item);
        context.push({ role: item.role, result: item.result, contents });
      }
    }
    const session = new AgentSession(directory, state, specification, context, prReview);
    if (continuing) {
      for (const [key, count] of Object.entries(state.checkpoint!.attempts))
        session.counts.set(key, count);
      if (state.checkpoint?.checkStart !== undefined)
        session.checks = state.checks.slice(state.checkpoint.checkStart);
    }
    return session;
  }

  async invoke(
    role: Role,
    { phase, allowBlocked = false }: StepOptions = {},
  ): Promise<AgentResult> {
    const { state, directory } = this;
    const checkpoint = state.checkpoint!;
    if (checkpoint.resultIndex !== undefined) {
      const completed = state.results[checkpoint.resultIndex];
      if (!completed || completed.role !== role || completed.phase !== phase)
        throw new Error('Checkpoint result does not match the pending role');
      suspendForResult(state, completed.result, allowBlocked);
      return completed.result;
    }
    state.nextRole = role;
    await saveState(directory, state);

    const key = phase ? `${role}-${phase}` : role;
    const attempt = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, attempt);
    checkpoint.attempts[key] = attempt;
    checkpoint.active = {
      role,
      phase,
      readOnlyFingerprint: roleContracts[role].readOnly
        ? await workspaceFingerprint(state.workdir, state.config.git.enabled)
        : undefined,
    };
    await saveState(directory, state);
    const label = `${key}${attempt > 1 ? `-attempt-${attempt}` : ''}`;
    process.stderr.write(`[${state.task.id}] ${label}\n`);

    const artifactDirectory = path.join(
      state.workdir,
      '.harness',
      'artifacts',
      state.id,
      String(state.iteration),
      label,
    );
    await mkdir(artifactDirectory, { recursive: true });
    const openspec = await changeContext(
      state.workdir,
      state.openspec!,
      path.relative(state.workdir, artifactDirectory),
    );
    const request: AgentRequest = {
      role,
      task: state.task,
      specification: this.specification,
      instructions: await instructions(role, state.config),
      context: this.latestContext(),
      clarificationHistory: state.clarificationHistory,
      artifactDirectory: path.relative(state.workdir, artifactDirectory),
      workdir: state.workdir,
      openspec,
      verification: phase ? { phase, attempt } : undefined,
      rework: state.rework,
      prReview: this.prReview,
      checks: await Promise.all(
        this.checks.map(async (check) => ({
          ...check,
          output: (await readFile(path.join(directory, check.log), 'utf8')).slice(-64_000),
        })),
      ),
    };
    const prefix = path.join(directory, `${state.iteration}-${label}`);
    const { result, contents } = await executeAgentStep(directory, state, request, prefix);

    await sealCheckpoint(directory, state, {
      results: [
        ...state.results,
        {
          role,
          result,
          phase,
          attempt,
          artifactDirectory: request.artifactDirectory,
          artifactManifest: artifactManifest(contents),
        },
      ],
      checkpoint: { ...checkpoint, resultIndex: state.results.length, active: undefined },
    });
    this.context.push({ role, result, contents });
    suspendForResult(state, result, allowBlocked);
    return result;
  }

  private latestContext(): AgentRequest['context'] {
    return this.context.filter(
      (item, index) =>
        this.context.findLastIndex(
          (candidate) =>
            candidate.role === item.role &&
            candidate.result.verification?.phase === item.result.verification?.phase,
        ) === index,
    );
  }
}
