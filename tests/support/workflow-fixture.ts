import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  packageRoot,
  runtimeCommand,
  runtimeScript,
} from '../../src/infrastructure/package-paths.ts';

import type { Config, Task } from '../../src/domain/types.ts';

const root = packageRoot;
export async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-harness-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, 'spec.md'), '# Test specification\n');
  const task: Task = {
    id: 'TEST-1',
    title: 'Test',
    description: 'Implement feature',
    specPath: 'spec.md',
    areas: ['frontend', 'backend'],
    acceptanceCriteria: [{ id: 'AC-1', description: 'Works' }],
  };
  const config: Config = {
    projectRoot: directory,
    runner: runtimeCommand('mock-agent'),
    runnerMode: 'protocol',
    timeoutMs: 10_000,
    maxOutputBytes: 1_000_000,
    maxIterations: 3,
    knowledgeRoot: path.join(root, 'knowledge'),
    git: { enabled: false, baseRef: 'HEAD', publish: false },
    checks: [
      { name: 'Fixture check', command: process.execPath, args: ['-e', 'console.log("checked")'] },
    ],
    integrations: {},
  };
  return { directory, task, config };
}
export async function mutateMock(config: Config, mutation: string) {
  const wrapper = path.join(config.projectRoot, 'fixture-runner.mjs');
  await writeFile(
    wrapper,
    `import fs from 'node:fs/promises';import path from 'node:path';import {spawnSync} from 'node:child_process';
    let input='';for await(const chunk of process.stdin)input+=chunk;
    const request=JSON.parse(input);
    const response=spawnSync(process.execPath,[${JSON.stringify(runtimeScript('mock-agent'))}],{input,encoding:'utf8'});
    if(response.status!==0)throw new Error(response.stderr);
    const result=JSON.parse(response.stdout);
    ${mutation}
    console.log(JSON.stringify(result));`,
  );
  config.runner.args = [wrapper];
}
