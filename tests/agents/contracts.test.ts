import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, symlink } from 'node:fs/promises';
import path from 'node:path';
import { parseAgentOutput } from '../../src/agents/runner.ts';
import { artifactContents } from '../../src/agents/artifacts.ts';
import { execute } from '../../src/infrastructure/process.ts';
import type { AgentResult } from '../../src/domain/types.ts';
import { fixture } from '../support/workflow-fixture.ts';

test('CLI result parser rejects technical failure and invalid model status', () => {
  assert.throws(() =>
    parseAgentOutput(JSON.stringify([{ type: 'result', subtype: 'error', is_error: true }]), 'cli'),
  );
  assert.throws(() => parseAgentOutput('{"status":"SUCCESS"}', 'protocol'));
  const result: AgentResult = {
    status: 'COMPLETED',
    summary: 'Done',
    artifacts: [],
    questions: [],
    acceptance: [],
  };
  assert.equal(
    parseAgentOutput(
      JSON.stringify([
        { type: 'result', subtype: 'success', is_error: false, result: JSON.stringify(result) },
      ]),
      'cli',
    ).status,
    'COMPLETED',
  );
});

test('artifact paths cannot escape assigned directory via traversal or symlink', async (t) => {
  const { directory } = await fixture(t);
  const artifacts = path.join(directory, 'artifacts');
  await mkdir(artifacts);
  await symlink(path.join(directory, 'spec.md'), path.join(artifacts, 'escape.md'));
  await assert.rejects(artifactContents(directory, ['spec.md'], artifacts), /escapes/);
  await assert.rejects(artifactContents(directory, ['artifacts/escape.md'], artifacts), /escapes/);
});

test('process timeout terminates stalled runner', async (t) => {
  const { directory } = await fixture(t);
  await assert.rejects(
    execute(
      { command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'] },
      directory,
      '',
      50,
    ),
    /timed out/,
  );
});
