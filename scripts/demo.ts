import os from 'node:os';
import { packageRoot, runtimeCommand } from '../src/infrastructure/package-paths.ts';
import { readFile, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { start, resume } from '../src/workflow/lifecycle.ts';
import { readTask } from '../src/domain/validation.ts';
import type { Config } from '../src/domain/types.ts';

const root = packageRoot;
const task = readTask(JSON.parse(await readFile(path.join(root, 'examples/task.json'), 'utf8')));
task.description += ' [clarify]';
const demoProject = await mkdtemp(path.join(os.tmpdir(), 'agent-harness-demo-'));
await writeFile(
  path.join(demoProject, 'spec.md'),
  await readFile(path.join(root, 'examples/spec.md'), 'utf8'),
);
task.specPath = 'spec.md';
const config: Config = {
  projectRoot: demoProject,
  runner: runtimeCommand('mock-agent'),
  runnerMode: 'protocol',
  timeoutMs: 10_000,
  maxOutputBytes: 1_000_000,
  maxIterations: 3,
  knowledgeRoot: path.join(root, 'knowledge'),
  git: { enabled: false, baseRef: 'HEAD', publish: false },
  checks: [
    {
      name: 'Demo runtime check (not product validation)',
      command: process.execPath,
      args: ['-e', 'console.log("MOCK checks passed")'],
    },
  ],
  integrations: { taskTracker: runtimeCommand('mock-integration') },
};
const first = await start(task, config);
if (first.state.status !== 'NEEDS_CLARIFICATION')
  throw new Error(`Expected clarification: ${first.state.summary}`);
process.stdout.write(`MOCK clarification artifact: ${first.directory}/clarification-1.md\n`);
const final = await resume(
  first.directory,
  'Retain the form inputs after a failed save and allow retry.',
);
if (final.status !== 'COMPLETED') throw new Error(`Demo failed: ${final.summary}`);
process.stdout.write(
  `MOCK workflow completed. Report: ${first.directory}/report.md\nOpenSpec change: ${demoProject}/${final.openspec!.directory}\nNo product code was implemented and nothing was published.\n`,
);
