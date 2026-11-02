import { execute, ProcessInterruptedError } from '../infrastructure/process.ts';
import type { Command } from '../domain/types.ts';

export class AdapterCallError extends Error {
  constructor(
    readonly operation: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

/** One request on stdin, one JSON response on stdout; diagnostics belong on stderr. */
export async function callAdapter(
  adapter: Command,
  cwd: string,
  operation: string,
  payload: unknown,
): Promise<Record<string, unknown>> {
  let response;
  try {
    response = await execute(
      adapter,
      cwd,
      JSON.stringify({ version: 1, operation, payload }),
      60_000,
    );
  } catch (error) {
    if (error instanceof ProcessInterruptedError) throw error;
    throw new AdapterCallError(operation, `Adapter ${operation} failed: ${String(error)}`, {
      cause: error,
    });
  }
  if (response.exitCode !== 0)
    throw new AdapterCallError(
      operation,
      `Adapter ${operation} failed (${response.exitCode}): ${response.stderr.slice(-2000)}`,
    );
  let result: unknown;
  try {
    result = JSON.parse(response.stdout);
  } catch (error) {
    throw new AdapterCallError(operation, `Adapter ${operation} returned invalid JSON`, {
      cause: error,
    });
  }
  if (
    !result ||
    typeof result !== 'object' ||
    Array.isArray(result) ||
    (result as Record<string, unknown>).ok !== true
  )
    throw new AdapterCallError(operation, `Adapter ${operation} did not confirm success`);
  return result as Record<string, unknown>;
}
