import { test } from 'node:test';
import assert from 'node:assert/strict';

import { start } from '../../src/workflow/lifecycle.ts';
import { fixture, mutateMock } from '../support/workflow-fixture.ts';

test('missing analyst delta specs stop planning', async (t) => {
  const { task, config } = await fixture(t);
  await mutateMock(
    config,
    `if(request.role==='analyst')result.artifacts=result.artifacts.filter(file=>!file.endsWith('/spec.md'));`,
  );
  const { state } = await start(task, config);
  assert.equal(state.status, 'BLOCKED');
  assert.match(state.summary, /delta spec/);
  assert.equal(state.results.length, 0);
});

test('frontend planner cannot discard backend tasks', async (t) => {
  const { task, config } = await fixture(t);
  await mutateMock(
    config,
    `if(request.role==='frontend-planner'){
    const file=path.join(request.openspec.draftDirectory,'tasks.md');
    const text=await fs.readFile(file,'utf8');await fs.writeFile(file,text.split('\\n').filter(line=>!line.includes('[backend]')).join('\\n'));
  }`,
  );
  const { state } = await start(task, config);
  assert.equal(state.status, 'BLOCKED');
  assert.match(state.summary, /existing task/);
  assert.ok(!state.results.some((item) => item.role.endsWith('-implementer')));
});

test('backend implementer cannot complete frontend tasks', async (t) => {
  const { task, config } = await fixture(t);
  await mutateMock(
    config,
    `if(request.role==='backend-implementer'){
    const file=path.join(request.openspec.draftDirectory,'tasks.md');
    await fs.writeFile(file,(await fs.readFile(file,'utf8')).replaceAll('- [ ]','- [x]'));
  }`,
  );
  const { state } = await start(task, config);
  assert.equal(state.status, 'BLOCKED');
  assert.match(state.summary, /another role/);
});

test('tester cannot claim completion with pending testing tasks', async (t) => {
  const { task, config } = await fixture(t);
  await mutateMock(
    config,
    `if(request.role==='tester'){
    const file=path.join(request.openspec.draftDirectory,'tasks.md');
    await fs.writeFile(file,request.openspec.files.find(file=>file.path==='tasks.md').content);
  }`,
  );
  const { state } = await start(task, config);
  assert.equal(state.status, 'BLOCKED');
  assert.match(state.summary, /unfinished/);
});

test('direct writes to shared documents are detected before advancing', async (t) => {
  const { task, config } = await fixture(t);
  await mutateMock(
    config,
    `if(request.role==='backend-planner')await fs.writeFile(path.join(request.openspec.directory,'proposal.md'),'tampered');`,
  );
  const { state } = await start(task, config);
  assert.equal(state.status, 'BLOCKED');
  assert.match(state.summary, /shared OpenSpec files directly/);
});

test('a planner cannot publish a design missing the common decision sections', async (t) => {
  const { task, config } = await fixture(t);
  await mutateMock(
    config,
    `if(request.role==='backend-planner') { const file=path.join(request.openspec.draftDirectory,'design.md');const text=await fs.readFile(file,'utf8');await fs.writeFile(file,text.replace('## Decisions','### Decisions')); }`,
  );
  const run = await start(task, config);
  assert.equal(run.state.status, 'BLOCKED');
  assert.match(run.state.summary, /Missing OpenSpec section: Decisions/);
  assert.ok(!run.state.results.some((item) => item.role === 'frontend-planner'));
});
