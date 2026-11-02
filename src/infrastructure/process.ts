import { spawn } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';
import type { Command } from '../domain/types.ts';

export class ProcessExecutionError extends Error {
  stdout = '';
  stderr = '';
}
export class ProcessInterruptedError extends ProcessExecutionError {}

const runProcesses = new AsyncLocalStorage<string>();
export function withRunProcesses<T>(directory: string, operation: () => Promise<T>): Promise<T> {
  return runProcesses.run(path.join(directory, 'processes'), operation);
}

export async function execute(
  command: Command,
  cwd: string,
  input = '',
  timeoutMs = 600_000,
  maxBytes = 8_000_000,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const registry = runProcesses.getStore();
    if (registry) mkdirSync(registry, { recursive: true });
    const child = spawn(command.command, command.args, {
      cwd,
      shell: false,
      detached: process.platform !== 'win32',
      stdio: 'pipe',
    });
    const processFile =
      registry && child.pid ? path.join(registry, `${child.pid}.json`) : undefined;
    if (processFile) {
      try {
        writeFileSync(processFile, JSON.stringify({ pid: child.pid, host: hostname() }));
      } catch (error) {
        if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
        reject(error);
        return;
      }
    }
    let stdout = '',
      stderr = '',
      bytes = 0,
      failure: ProcessExecutionError | undefined;
    const stop = (reason: string, interrupted = false) => {
      failure ??= interrupted
        ? new ProcessInterruptedError(reason)
        : new ProcessExecutionError(reason);
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        /* Process already exited. */
      }
    };
    const timer = setTimeout(() => stop(`Process timed out after ${timeoutMs}ms`), timeoutMs);
    const interrupt = () => stop('Process interrupted by SIGINT', true);
    const terminate = () => stop('Process interrupted by SIGTERM', true);
    process.once('SIGINT', interrupt);
    process.once('SIGTERM', terminate);
    const cleanup = () => {
      if (processFile) rmSync(processFile, { force: true });
      clearTimeout(timer);
      process.removeListener('SIGINT', interrupt);
      process.removeListener('SIGTERM', terminate);
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    const collect = (stream: 'stdout' | 'stderr', chunk: string) => {
      const available = Math.max(0, maxBytes - bytes);
      const retained = Buffer.from(chunk).subarray(0, available).toString('utf8');
      if (stream === 'stdout') stdout += retained;
      else stderr += retained;
      bytes += Buffer.byteLength(chunk);
      if (bytes > maxBytes) {
        stop(`Process exceeded output limit (${maxBytes} bytes)`);
        return;
      }
    };
    child.stdout.on('data', (chunk) => collect('stdout', chunk));
    child.stderr.on('data', (chunk) => collect('stderr', chunk));
    child.stdin.on('error', () => {
      /* Early exit may close stdin. Exit status is handled below. */
    });
    child.on('error', (error) => {
      cleanup();
      reject(error);
    });
    child.on('close', (code) => {
      cleanup();
      if (failure) {
        failure.stdout = stdout;
        failure.stderr = stderr;
        reject(failure);
      } else resolve({ exitCode: code ?? -1, stdout, stderr });
    });
    child.stdin.end(input);
  });
}
