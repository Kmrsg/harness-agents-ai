import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { start } from '../../src/workflow/lifecycle.ts';
import { fixture } from '../support/workflow-fixture.ts';

test('configured OpenSpec validator failure stops implementation', async (t) => {
  const { directory, task, config } = await fixture(t);
  const validator = path.join(directory, 'validator.mjs');
  await writeFile(validator, 'console.error("Invalid change");process.exit(9);');
  config.openspec = { validator: { command: process.execPath, args: [validator] } };
  const { state } = await start(task, config);
  assert.equal(state.status, 'BLOCKED');
  assert.match(state.summary, /OpenSpec plan/);
  assert.equal(state.checks.at(-1)?.exitCode, 9);
  assert.ok(!state.results.some((item) => item.role.endsWith('-implementer')));
});

test('existing main specs are supplied to analyst and remain unchanged', async (t) => {
  const { directory, task, config } = await fixture(t);
  const main = path.join(directory, 'openspec/specs/mock-feature');
  await mkdir(main, { recursive: true });
  const content = '# Main spec\n\n## Purpose\nAn existing behavior contract.\n';
  await writeFile(path.join(main, 'spec.md'), content);
  const result = await start(task, config);
  assert.equal(result.state.status, 'COMPLETED', result.state.summary);
  assert.equal(await readFile(path.join(main, 'spec.md'), 'utf8'), content);
  const delta = await readFile(
    path.join(directory, result.state.openspec!.directory, 'specs/mock-feature/spec.md'),
    'utf8',
  );
  assert.match(delta, /## MODIFIED Requirements/);
});

test(
  'real OpenSpec CLI validates the change before implementation and before delivery',
  { skip: !process.env.OPENSPEC_TEST_CLI },
  async (t) => {
    const { task, config } = await fixture(t);
    config.openspec = { validator: { command: process.env.OPENSPEC_TEST_CLI!, args: [] } };
    const result = await start(task, config);
    assert.equal(result.state.status, 'COMPLETED', result.state.summary);
    const checks = result.state.checks.filter((check) => check.name.startsWith('OpenSpec '));
    assert.deepEqual(
      checks.map((check) => check.name),
      ['OpenSpec plan', 'OpenSpec final'],
    );
    for (const check of checks) {
      assert.equal(check.exitCode, 0);
      assert.match(await readFile(path.join(result.directory, check.log), 'utf8'), /valid/);
    }
  },
);
