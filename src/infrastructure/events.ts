import { appendFile, open, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Role, RunState, Status, VerificationPhase } from '../domain/types.ts';

interface EventPayloads {
  'run.started': { taskId: string };
  'run.continued': { stage: string };
  'run.status': { status: RunState['status']; nextRole?: RunState['nextRole']; summary: string };
  'workflow.started': { reason: 'initial' | 'clarification' | 'review' | 'continuation' };
  'workflow.rework': { phase: VerificationPhase; attempt: number; limit: number };
  'agent.started': { role: Role; phase?: VerificationPhase; attempt?: number; requestFile: string };
  'agent.finished': { role: Role; status: Status; phase?: VerificationPhase; artifacts: number };
  'agent.failed': { role: Role; phase?: VerificationPhase; error: string };
  'checks.finished': { phase: VerificationPhase; checks: { name: string; exitCode: number }[] };
  'verification.decided': { phase: VerificationPhase; verdict: string; findings: number };
  'delivery.published': { commit?: string; pullRequestUrl?: string };
  'review.triaged': { threadId: string; fingerprint: string; action: string };
  'review.reply.sent': { threadId: string; idempotencyKey: string };
  'review.reply.failed': { threadId: string; idempotencyKey: string };
  'review.reply.superseded': { threadId: string; fingerprint: string };
}
export type RunEvent = {
  [K in keyof EventPayloads]: {
    version: 1;
    id: string;
    timestamp: string;
    runId: string;
    iteration: number;
    type: K;
    data: EventPayloads[K];
  };
}[keyof EventPayloads];

/** Audit only. Callers serialize mutations with run.lock; state.json remains the checkpoint. */
export async function recordEvent<K extends keyof EventPayloads>(
  directory: string,
  state: RunState,
  type: K,
  data: EventPayloads[K],
): Promise<void> {
  try {
    const file = path.join(directory, 'events.jsonl');
    // Discard only an uncommitted trailing fragment left by a killed writer.
    await discardPartialTail(file);
    await appendFile(
      file,
      JSON.stringify({
        version: 1,
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        runId: state.id,
        iteration: state.iteration,
        type,
        data,
      }) + '\n',
    );
  } catch (error) {
    // A failed audit sink must not repeat a successful push or change a delivery verdict.
    const message = `Event journal unavailable: ${error instanceof Error ? error.message : String(error)}`;
    if (!state.integrationErrors.includes(message)) state.integrationErrors.push(message);
  }
}

async function discardPartialTail(file: string): Promise<void> {
  const handle = await open(file, 'a+');
  try {
    let end = (await handle.stat()).size;
    const last = Buffer.alloc(1);
    if (!end) return;
    await handle.read(last, 0, 1, end - 1);
    if (last[0] === 10) return;
    while (end > 0) {
      const start = Math.max(0, end - 4096);
      const chunk = Buffer.alloc(end - start);
      await handle.read(chunk, 0, chunk.length, start);
      const newline = chunk.lastIndexOf(10);
      if (newline >= 0) {
        await handle.truncate(start + newline + 1);
        return;
      }
      end = start;
    }
    await handle.truncate(0);
  } finally {
    await handle.close();
  }
}

export async function readEvents(directory: string): Promise<RunEvent[]> {
  let text: string;
  try {
    text = await readFile(path.join(directory, 'events.jsonl'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  // A concurrent reader can see an unfinished last append; only complete records are committed.
  return text
    .slice(0, text.lastIndexOf('\n') + 1)
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
