import { validateResultContract } from './result-contract.ts';
import { roleContracts } from './contracts.ts';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runAgent } from './runner.ts';
import { artifactContents } from './artifacts.ts';
import { workspaceFingerprint } from '../infrastructure/workspace.ts';
import { recordEvent } from '../infrastructure/events.ts';
import { assertSharedUnchanged, publishDrafts } from '../openspec/publishing.ts';
import type { AgentRequest, RunState } from '../domain/types.ts';

/** One role execution: durable evidence, role permissions, artifacts and an auditable outcome. */
export async function executeAgentStep(
  directory: string,
  state: RunState,
  request: AgentRequest,
  prefix: string,
) {
  const artifactDirectory = path.resolve(state.workdir, request.artifactDirectory);
  await mkdir(artifactDirectory, { recursive: true });
  const readOnly = roleContracts[request.role].readOnly;
  const fingerprint = readOnly
    ? await workspaceFingerprint(state.workdir, state.config.git.enabled)
    : undefined;
  await writeFile(`${prefix}.request.json`, JSON.stringify(request, null, 2));
  await recordEvent(directory, state, 'agent.started', {
    role: request.role,
    ...request.verification,
    requestFile: path.basename(`${prefix}.request.json`),
  });
  try {
    const { result } = await runAgent(request, state.config, async (stdout, stderr) => {
      await writeFile(`${prefix}.stdout.log`, stdout);
      await writeFile(`${prefix}.stderr.log`, stderr);
    });
    await writeFile(`${prefix}.result.json`, JSON.stringify(result, null, 2));
    if (
      readOnly &&
      fingerprint !== (await workspaceFingerprint(state.workdir, state.config.git.enabled))
    ) {
      throw new Error(
        request.role === 'verifier'
          ? 'Verifier modified product files; review must be read-only'
          : 'Review triager modified product files; triage must be read-only',
      );
    }
    const contents = await artifactContents(state.workdir, result.artifacts, artifactDirectory);
    if (!contents.length) throw new Error(`${request.role} must produce at least one artifact`);
    await validateResultContract(request, result, contents);
    if (readOnly || result.status !== 'COMPLETED') {
      await assertSharedUnchanged(state.workdir, request.openspec);
    } else {
      await publishDrafts(
        state.workdir,
        request.role,
        state.task,
        request.openspec,
        contents,
        `${prefix}.openspec`,
        request.rework?.phase === 'plan',
      );
    }
    await recordEvent(directory, state, 'agent.finished', {
      role: request.role,
      status: result.status,
      phase: request.verification?.phase,
      artifacts: contents.length,
    });
    return { result, contents };
  } catch (error) {
    if (
      readOnly &&
      fingerprint !== (await workspaceFingerprint(state.workdir, state.config.git.enabled))
    ) {
      error = new Error(
        request.role === 'verifier'
          ? 'Verifier modified product files; review must be read-only'
          : 'Review triager modified product files; triage must be read-only',
        { cause: error },
      );
    }
    await recordEvent(directory, state, 'agent.failed', {
      role: request.role,
      phase: request.verification?.phase,
      error: (error instanceof Error ? error.message : String(error)).slice(0, 2000),
    });
    throw error;
  }
}
