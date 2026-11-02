import { test } from 'node:test';
import assert from 'node:assert/strict';
import { packageRoot } from '../../src/infrastructure/package-paths.ts';
import { readConfig, readTask } from '../../src/domain/validation.ts';

test('invalid config and task are rejected before starting', () => {
  assert.throws(() => readTask({ id: '../escape' }));
  assert.throws(() => readConfig({ projectRoot: '.' }, packageRoot));
});
