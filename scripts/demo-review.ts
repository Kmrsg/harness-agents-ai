/** Local-only review lifecycle; no corporate credentials or network access required. */
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { packageRoot, runtimeCommand } from '../src/infrastructure/package-paths.ts';
import { git } from '../src/infrastructure/git.ts';
import { start } from '../src/workflow/lifecycle.ts';
import { watchOnce } from '../src/review/watcher.ts';
import type { Config, Task } from '../src/domain/types.ts';

const root = await mkdtemp(path.join(os.tmpdir(), 'harness-review-demo-'));
await git(root, ['init']);
await git(root, ['config', 'user.name', 'Harness demo']);
await git(root, ['config', 'user.email', 'demo@example.invalid']);
await writeFile(path.join(root, 'spec.md'), '# MOCK task specification\n');
await git(root, ['add', 'spec.md']);
await git(root, ['commit', '-m', 'Demo initial commit']);
await git(root, ['init', '--bare', path.join(root, 'remote.git')]);
await git(root, ['remote', 'add', 'origin', path.join(root, 'remote.git')]);
const fixturePath = path.join(root, 'pr.json');
const fixture = JSON.parse(
  await readFile(path.join(packageRoot, 'examples/pr-review.mock.json'), 'utf8'),
);
await writeFile(fixturePath, JSON.stringify(fixture, null, 2));
process.env.HARNESS_BITBUCKET_FIXTURE = fixturePath;
const config: Config = {
  projectRoot: root,
  runner: runtimeCommand('mock-agent'),
  runnerMode: 'protocol',
  timeoutMs: 10_000,
  maxOutputBytes: 1_000_000,
  maxIterations: 3,
  knowledgeRoot: path.join(packageRoot, 'knowledge'),
  git: { enabled: true, publish: true, baseRef: 'HEAD' },
  checks: [
    {
      name: 'MOCK runtime check',
      command: process.execPath,
      args: ['-e', 'console.log("MOCK pass")'],
    },
  ],
  integrations: { bitbucket: runtimeCommand('mock-integration') },
};
const task: Task = {
  id: 'DEMO-REVIEW',
  title: 'Mock PR review',
  description: 'Demonstrate review lifecycle',
  specPath: 'spec.md',
  areas: ['frontend', 'backend'],
  acceptanceCriteria: [{ id: 'AC-1', description: 'Mock behavior' }],
};
const { directory, state } = await start(task, config);
if (state.status !== 'WAITING_REVIEW') throw new Error(state.summary);
process.stdout.write('MOCK PR created: WAITING_REVIEW\n');
const corrected = await watchOnce(directory);
if (corrected.status !== 'WAITING_REVIEW' || corrected.commit === state.commit)
  throw new Error(corrected.summary);
process.stdout.write(`MOCK finding fixed, verified and pushed: ${corrected.commit}\n`);
await watchOnce(directory);
fixture.state = 'MERGED';
await writeFile(fixturePath, JSON.stringify(fixture, null, 2));
const completed = await watchOnce(directory);
if (completed.status !== 'COMPLETED') throw new Error(completed.summary);
process.stdout.write(
  `MOCK merge: COMPLETED\nProject: ${root}\nReport: ${directory}/report.md\nReplies: ${fixturePath}.replies.jsonl\nOnly a temporary local Git remote was used; no real PR or API calls.\n`,
);
