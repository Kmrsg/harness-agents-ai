import { withRunProcesses } from '../infrastructure/process.ts';
import { recordEvent } from '../infrastructure/events.ts';
import { initializeChange, changeContext, reopenTasks } from '../openspec/documents.ts';
import { AgentSession } from './agent-step.ts';
import { collectChecks } from './checks.ts';
import { verifyAndDeliver } from './delivery.ts';
import { planFingerprint, requireReview } from './verification.ts';
import { workspaceFingerprint } from '../infrastructure/workspace.ts';
import { ProcessInterruptedError } from '../infrastructure/process.ts';
import { assertRunWorkspace, assertRunHead } from './preparation.ts';
import { advance, sealCheckpoint } from './checkpoint.ts';
import { acquireRunLock, readState, saveState } from './state.ts';
import { finishRun } from './reporting.ts';
import { WorkflowHalted, escalate } from './control.ts';
import type {
  AgentRequest,
  Finding,
  Role,
  RunState,
  Task,
  VerificationPhase,
} from '../domain/types.ts';

export interface ReviewRepair {
  phase: VerificationPhase;
  finding: Finding;
  prReview: NonNullable<AgentRequest['prReview']>;
}

export function pipeline(task: Task): Role[] {
  const roles: Role[] = ['analyst'];
  if (task.areas.includes('backend')) roles.push('backend-planner');
  if (task.areas.includes('frontend')) roles.push('frontend-planner');
  roles.push('verifier');
  if (task.areas.includes('backend')) roles.push('backend-implementer');
  if (task.areas.includes('frontend')) roles.push('frontend-implementer');
  return [...roles, 'tester', 'verifier'];
}

/** Controls stage order and review budgets; individual steps own their I/O and contracts. */
class Workflow {
  constructor(
    private readonly directory: string,
    private readonly state: RunState,
    private readonly agents: AgentSession,
  ) {}

  async run(): Promise<void> {
    while (true) {
      const checkpoint = this.state.checkpoint!;
      switch (checkpoint.stage) {
        case 'analysis':
          await this.agents.invoke('analyst');
          await this.move('planning');
          break;
        case 'planning':
        case 'implementation': {
          const planning = checkpoint.stage === 'planning';
          const roles = pipeline(this.state.task).filter((role) =>
            role.endsWith(planning ? '-planner' : '-implementer'),
          );
          const role = roles[checkpoint.index];
          if (role) {
            await this.agents.invoke(role, { allowBlocked: !planning });
            await this.move(checkpoint.stage, checkpoint.index + 1);
          } else await this.move(planning ? 'plan-checks' : 'testing');
          break;
        }
        case 'testing':
          await this.agents.invoke('tester', { allowBlocked: true });
          await this.move('implementation-checks');
          break;
        case 'plan-checks':
        case 'implementation-checks': {
          const phase = checkpoint.stage === 'plan-checks' ? 'plan' : 'implementation';
          checkpoint.checkStart = this.state.checks.length;
          await saveState(this.directory, this.state);
          this.agents.checks = await collectChecks(this.directory, this.state, phase);
          await advance(this.directory, this.state, `${phase}-review`, 0, true);
          break;
        }
        case 'plan-review':
        case 'implementation-review': {
          const phase = checkpoint.stage === 'plan-review' ? 'plan' : 'implementation';
          const decision = await this.review(phase);
          if (decision.verdict === 'APPROVED') {
            if (phase === 'plan') {
              await advance(this.directory, this.state, 'implementation', 0, false, {
                verification: {
                  ...this.state.verification!,
                  planApproval: planFingerprint(await this.planFiles()),
                },
              });
            } else {
              await this.approveImplementation();
            }
          } else {
            await this.scheduleRework(
              decision.verdict === 'REWORK_PLAN' ? 'plan' : 'implementation',
              decision.findings,
            );
          }
          break;
        }
        case 'rework':
          // Idempotent: retrying after a crash does not consume another rework attempt.
          await reopenTasks(this.state.workdir, this.state.openspec!);
          await this.move(this.state.rework!.phase === 'plan' ? 'planning' : 'implementation');
          break;
        case 'delivery':
          await verifyAndDeliver(this.directory, this.state);
          return;
        case 'done':
          this.state.status = this.state.pullRequestUrl ? 'WAITING_REVIEW' : 'COMPLETED';
          return;
      }
    }
  }

  private async move(stage: NonNullable<RunState['checkpoint']>['stage'], index = 0) {
    await advance(this.directory, this.state, stage, index);
  }

  private async review(phase: VerificationPhase) {
    const result = await this.agents.invoke('verifier', { phase, allowBlocked: true });
    if (result.status === 'BLOCKED')
      escalate(this.state, phase, `Verifier blocked: ${result.summary}`);
    const decision = requireReview(result, phase, this.state.task, await this.planFiles());
    if (
      decision.verdict === 'APPROVED' &&
      this.agents.checks.some((check) => check.exitCode !== 0)
    ) {
      escalate(
        this.state,
        phase,
        'Verifier approved despite failed mandatory checks; approval rejected by Harness.',
      );
    }
    await recordEvent(this.directory, this.state, 'verification.decided', {
      phase,
      verdict: decision.verdict,
      findings: decision.findings.length,
    });
    return decision;
  }

  private async scheduleRework(phase: VerificationPhase, findings: Finding[]): Promise<void> {
    const { state, directory } = this;
    const retries = state.verification!.retries;
    const limit = state.config.maxReworkRetries ?? 2;
    if (retries[phase] >= limit) {
      escalate(
        state,
        phase,
        `Developer escalation: ${phase} failed after ${limit} rework retries. ${findings.map((f) => f.description).join('; ')}`,
      );
    }
    const attempt = retries[phase] + 1;
    await advance(directory, state, 'rework', 0, false, {
      rework: { phase, attempt, findings },
      verification: {
        ...state.verification!,
        retries: { ...retries, [phase]: attempt },
        implementationApproval: undefined,
        planApproval: phase === 'plan' ? undefined : state.verification!.planApproval,
      },
      deliveryPending: false,
    });
    await recordEvent(directory, state, 'workflow.rework', {
      phase,
      attempt,
      limit,
    });
  }

  private async approveImplementation(): Promise<void> {
    const plan = planFingerprint(await this.planFiles());
    if (this.state.verification!.planApproval !== plan) {
      escalate(
        this.state,
        'plan',
        'Approved plan changed during implementation; publication blocked.',
      );
    }
    const workspace = await workspaceFingerprint(this.state.workdir, this.state.config.git.enabled);
    await advance(this.directory, this.state, 'delivery', 0, false, {
      verification: { ...this.state.verification!, implementationApproval: { plan, workspace } },
      rework: undefined,
    });
  }

  private async planFiles() {
    return (await changeContext(this.state.workdir, this.state.openspec!, '')).files;
  }
}

/** Repair is invoked under the review watcher's lock; ordinary runs acquire their own. */
export async function executeWorkflow(
  directory: string,
  state: RunState,
  {
    resuming = false,
    repair,
    continuing = false,
    locked = false,
  }: {
    resuming?: boolean;
    repair?: ReviewRepair;
    continuing?: boolean;
    locked?: boolean;
  } = {},
): Promise<void> {
  return withRunProcesses(directory, async () => {
    const release = repair || locked ? undefined : await acquireRunLock(directory);
    let ownsState = !resuming;
    try {
      if (resuming) {
        const current = await readState(directory);
        if (current.status !== 'NEEDS_CLARIFICATION' || current.iteration !== state.iteration - 1) {
          throw new Error('Run changed while resuming; reload its current status');
        }
        await assertRunWorkspace(current);
        await assertRunHead(current);
        ownsState = true;
      }
      if (!continuing) {
        state.openspec ??= await initializeChange(state.workdir, state.id);
        state.verification ??= { retries: { plan: 0, implementation: 0 } };
        if (!repair || repair.phase === 'plan') state.verification.planApproval = undefined;
        state.verification.implementationApproval = undefined;
        state.rework = repair
          ? { phase: repair.phase, attempt: 1, findings: [repair.finding] }
          : undefined;
        state.escalation = undefined;
        state.deliveryPending = false;
        if (!repair) state.results = [];
        state.checks = [];
        state.checkpoint = {
          stage: repair ? 'rework' : 'analysis',
          index: 0,
          attempts: {},
          prReview: repair?.prReview,
        };
        await sealCheckpoint(directory, state);
      }
      const agents = await AgentSession.create(
        directory,
        state,
        state.checkpoint?.prReview,
        continuing,
      );
      state.nextRole = undefined;
      state.status = 'RUNNING';
      state.interrupted = false;
      await saveState(directory, state);
      await recordEvent(directory, state, 'workflow.started', {
        reason: continuing
          ? 'continuation'
          : repair
            ? 'review'
            : resuming
              ? 'clarification'
              : 'initial',
      });
      await new Workflow(directory, state, agents).run();
    } catch (error) {
      if (!ownsState) throw error;
      if (!(error instanceof WorkflowHalted)) {
        state.interrupted = error instanceof ProcessInterruptedError;
        state.status = 'BLOCKED';
        state.summary = error instanceof Error ? error.message : String(error);
      }
    } finally {
      try {
        if (ownsState) await finishRun(directory, state);
      } finally {
        await release?.();
      }
    }
  });
}
