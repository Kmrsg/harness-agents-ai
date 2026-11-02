import { spawn, type ChildProcess } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import path from 'node:path';
import { fixture } from './workflow-fixture.ts';
import { git } from '../../src/infrastructure/git.ts';
import { packageRoot, runtimeScript } from '../../src/infrastructure/package-paths.ts';
import { execute } from '../../src/infrastructure/process.ts';

export async function until<T>(read: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await setTimeout(25);
  }
  throw new Error('Timed out waiting for the interruption fixture');
}

export const cli = (...args: string[]) => ({
  command: process.execPath,
  args: [path.join(packageRoot, 'bin/agent-harness.mjs'), ...args],
});

export async function interruptionFixture(
  t: { after(fn: () => Promise<void>): void },
  condition: string,
  mode: 'agent' | 'checks' | 'setup' = 'agent',
) {
  const f = await fixture(t);
  await git(f.directory, ['init']);
  await git(f.directory, ['config', 'user.name', 'Fixture']);
  await git(f.directory, ['config', 'user.email', 'fixture@example.invalid']);
  await git(f.directory, ['add', 'spec.md']);
  await git(f.directory, ['commit', '-m', 'Initial']);
  const local = path.join(f.directory, '.harness');
  await mkdir(local, { recursive: true });
  const marker = path.join(local, 'pause.json');
  const calls = path.join(local, 'calls.jsonl');
  const runner = path.join(local, 'pausing-runner.mjs');
  await writeFile(
    runner,
    `
    import fs from 'node:fs/promises';import {spawnSync} from 'node:child_process';
    let input='';for await(const chunk of process.stdin)input+=chunk;
    const request=${mode === 'agent' ? 'JSON.parse(input)' : '{}'};
    await fs.appendFile(${JSON.stringify(calls)},JSON.stringify({role:request.role,phase:request.verification?.phase,rework:request.rework})+'\\n');
    if (${condition} && !(await fs.access(${JSON.stringify(marker)}).then(()=>true,()=>false))) {
      ${mode === 'agent' ? "if(request.role.endsWith('-implementer'))await fs.writeFile('partial-change.txt','Preserve interrupted work');" : ''}
      await fs.writeFile(${JSON.stringify(marker)},JSON.stringify({pid:process.pid,workdir:process.cwd()}));
      await new Promise(()=>setInterval(()=>{},1000));
    }
    ${mode === 'agent' ? `const result=spawnSync(process.execPath,[${JSON.stringify(runtimeScript('mock-agent'))}],{input,encoding:'utf8'});process.stdout.write(result.stdout);process.stderr.write(result.stderr);process.exitCode=result.status??1;` : "console.log('check/setup completed');"}
  `,
  );
  if (mode === 'agent') f.config.runner = { command: process.execPath, args: [runner] };
  else if (mode === 'checks')
    f.config.checks = [{ name: 'Paused check', command: process.execPath, args: [runner] }];
  else f.config.setup = [{ command: process.execPath, args: [runner] }];
  f.config.git.enabled = true;
  const { projectRoot: _root, ...settings } = f.config;
  await writeFile(path.join(f.directory, 'harness.config.json'), JSON.stringify(settings));
  await writeFile(path.join(f.directory, 'task.json'), JSON.stringify(f.task));
  let child: ChildProcess | undefined;
  let paused: { pid: number; workdir: string } | undefined;
  t.after(async () => {
    if (child?.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    if (paused)
      try {
        process.kill(-paused.pid, 'SIGKILL');
      } catch {
        /* Already stopped. */
      }
  });
  const begin = async () => {
    const command = cli('run', 'task.json');
    child = spawn(command.command, command.args, { cwd: f.directory, stdio: 'ignore' });
    const finished = new Promise<void>((resolve, reject) => {
      child!.once('error', reject);
      child!.once('exit', () => resolve());
    });
    paused = await until(async () => {
      try {
        return JSON.parse(await readFile(marker, 'utf8'));
      } catch {
        return undefined;
      }
    });
    const runs = JSON.parse((await execute(cli('list'), f.directory)).stdout);
    return {
      child: child!,
      paused: paused!,
      finished,
      runDirectory: runs[0].runDirectory as string,
      id: runs[0].id as string,
    };
  };
  return { ...f, begin, calls, marker };
}
