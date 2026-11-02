import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { start } from '../../src/workflow/lifecycle.ts';
import { git } from '../../src/infrastructure/git.ts';
import { packageRoot, runtimeCommand } from '../../src/infrastructure/package-paths.ts';
import type { Config, ReviewThread, Task } from '../../src/domain/types.ts';

export async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'harness-review-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, ['init']);
  await git(root, ['config', 'user.name', 'Fixture']);
  await git(root, ['config', 'user.email', 'fixture@example.invalid']);
  await writeFile(path.join(root, 'spec.md'), '# Complete specification\n');
  await git(root, ['add', 'spec.md']);
  await git(root, ['commit', '-m', 'Initial']);
  await git(root, ['init', '--bare', path.join(root, 'remote.git')]);
  await git(root, ['remote', 'add', 'origin', path.join(root, 'remote.git')]);
  const snapshotFile = path.join(root, 'pr.json');
  const calls = path.join(root, 'calls.jsonl');
  const adapter = path.join(root, 'adapter.mjs');
  await writeFile(
    adapter,
    `import fs from 'node:fs/promises';import {execFileSync} from 'node:child_process';
    let input='';for await(const c of process.stdin)input+=c;const r=JSON.parse(input);
    await fs.appendFile(${JSON.stringify(calls)},input+'\\n');
    if(r.operation==='pull-request.create'){console.log(JSON.stringify({ok:true,url:'https://bitbucket.example.invalid/pr/1'}));}
    else if(r.operation==='pull-request.get'){
      const s=JSON.parse(await fs.readFile(${JSON.stringify(snapshotFile)},'utf8'));
      if(s.sourceCommit==='REMOTE')s.sourceCommit=execFileSync('git',['ls-remote','--heads','origin','refs/heads/'+r.payload.branch],{encoding:'utf8'}).split(/\\s+/)[0];
      console.log(JSON.stringify({ok:true,...s}));
    }else if(r.operation==='pull-request.reply'){
      if(await fs.access(${JSON.stringify(path.join(root, 'fail-reply'))}).then(()=>true,()=>false))process.exit(9);
      console.log(JSON.stringify({ok:true}));
    }else throw Error('Unknown operation');`,
  );
  const config: Config = {
    projectRoot: root,
    runner: runtimeCommand('mock-agent'),
    runnerMode: 'protocol',
    timeoutMs: 10_000,
    maxOutputBytes: 1_000_000,
    maxIterations: 3,
    knowledgeRoot: path.join(packageRoot, 'knowledge'),
    git: { enabled: true, publish: true, baseRef: 'HEAD' },
    checks: [{ name: 'Check', command: process.execPath, args: ['-e', 'console.log("checked")'] }],
    integrations: { bitbucket: { command: process.execPath, args: [adapter] } },
  };
  const task: Task = {
    id: 'REVIEW-1',
    title: 'Fixture',
    description: 'Implement feature',
    specPath: 'spec.md',
    areas: ['frontend', 'backend'],
    acceptanceCriteria: [{ id: 'AC-1', description: 'Works' }],
  };
  const { directory, state } = await start(task, config);
  assert.equal(state.status, 'WAITING_REVIEW', state.summary);
  const threads: ReviewThread[] = [];
  const snapshot = { state: 'OPEN', sourceCommit: 'REMOTE', threads };
  const update = () => writeFile(snapshotFile, JSON.stringify(snapshot));
  await update();
  const readCalls = async () =>
    (await readFile(calls, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
  return { root, directory, state, snapshot, update, readCalls };
}
export function thread(body: string): ReviewThread {
  return {
    id: 'T1',
    resolved: false,
    comments: [{ id: 'C1', author: 'Reviewer', body, own: false }],
  };
}
export const triages = async (directory: string) =>
  (await readdir(directory)).filter((p) => /^review-.*\.request\.json$/.test(p));
