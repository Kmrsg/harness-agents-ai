import { execute, ProcessExecutionError } from '../infrastructure/process.ts';
import { readResult } from '../domain/validation.ts';
import type { AgentRequest, AgentResult, Config } from '../domain/types.ts';

const exitCauses: Readonly<Record<number, string>> = {
  53: 'turn limit exhausted',
  55: 'run budget exhausted',
  130: 'interrupted',
};

export function parseAgentOutput(output: string, mode: Config['runnerMode']): AgentResult {
  let payload: unknown = JSON.parse(output);
  if (mode === 'cli') {
    if (!Array.isArray(payload) || !payload.length)
      throw new Error('Expected LLM CLI JSON message array');
    const final = payload.at(-1) as Record<string, unknown>;
    if (final.type !== 'result' || final.is_error === true || final.subtype !== 'success')
      throw new Error('LLM CLI did not return a successful result');
    if (typeof final.result !== 'string') throw new Error('LLM CLI result must contain JSON text');
    const text = final.result.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/, '$1');
    payload = JSON.parse(text);
  }
  return readResult(payload);
}

export async function runAgent(
  request: AgentRequest,
  config: Config,
  log?: (stdout: string, stderr: string) => Promise<void>,
): Promise<{ result: AgentResult; stdout: string; stderr: string }> {
  const prompt = JSON.stringify(request);
  const bytes = Buffer.byteLength(prompt);
  const limit = config.maxInputBytes ?? 4_000_000;
  if (bytes > limit) throw new Error(`Agent input exceeds maxInputBytes: ${bytes} > ${limit}`);
  const argvInput = config.runnerMode === 'cli' && config.runnerInput === 'argv';
  if (argvInput && bytes > 64_000)
    throw new Error(`Agent argv input exceeds safe limit: ${bytes} > 64000; use runnerInput=stdin`);
  const command =
    config.runnerMode === 'cli'
      ? {
          command: config.runner.command,
          args: [
            ...config.runner.args,
            ...(argvInput ? ['-p', prompt] : []),
            '--output-format',
            'json',
          ],
        }
      : config.runner;
  let response;
  try {
    response = await execute(
      command,
      request.workdir,
      argvInput ? '' : prompt,
      config.timeoutMs,
      config.maxOutputBytes,
    );
  } catch (error) {
    if (error instanceof ProcessExecutionError) await log?.(error.stdout, error.stderr);
    throw error;
  }
  await log?.(response.stdout, response.stderr);
  if (response.exitCode !== 0) {
    const cause = exitCauses[response.exitCode] ?? 'process failed';
    throw new Error(
      `Agent ${request.role}: ${cause}, exit ${response.exitCode}. ${response.stderr.slice(-2000)}`,
    );
  }
  return {
    result: parseAgentOutput(response.stdout, config.runnerMode),
    stdout: response.stdout,
    stderr: response.stderr,
  };
}
