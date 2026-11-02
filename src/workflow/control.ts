import type { AgentResult, RunState, VerificationPhase } from '../domain/types.ts';

/** Expected suspension of a workflow, distinct from a failed subprocess or contract. */
export class WorkflowHalted extends Error {}

export function suspendForResult(
  state: RunState,
  result: AgentResult,
  allowBlocked: boolean,
): void {
  if (result.status === 'NEEDS_CLARIFICATION') {
    state.status = 'NEEDS_CLARIFICATION';
    state.summary = result.summary;
    state.nextRole = 'analyst';
    throw new WorkflowHalted();
  }
  if (result.status === 'BLOCKED' && !allowBlocked) {
    state.status = 'BLOCKED';
    state.summary = result.summary;
    throw new WorkflowHalted();
  }
}

export function escalate(state: RunState, phase: VerificationPhase, reason: string): never {
  state.status = 'BLOCKED';
  state.nextRole = 'developer';
  state.summary = reason;
  state.verification!.implementationApproval = undefined;
  state.deliveryPending = false;
  state.escalation = { to: 'developer', phase, reason, artifact: 'escalation.md' };
  throw new WorkflowHalted();
}
