import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, unlink, symlink, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fixture } from '../support/workflow-fixture.ts';
import { start } from '../../src/workflow/lifecycle.ts';
import { continueRun } from '../../src/workflow/continuation.ts';
import { saveState } from '../../src/workflow/state.ts';

for (const change of ['text', 'symlink', 'oversize', 'manifest', 'invalid-utf8'] as const) {
  test(`continue refuses ${change} changes to accepted reports before another agent runs`, async (t) => {
    const f = await fixture(t);
    const run = await start(f.task, f.config);
    assert.equal(run.state.status, 'COMPLETED', run.state.summary);
    const saved = run.state.results[0];
    const file = path.join(run.state.workdir, saved.result.artifacts[0]);
    if (change === 'text')
      await writeFile(file, (await readFile(file, 'utf8')).replace('MOCK', 'Changed'));
    else if (change === 'symlink') {
      await unlink(file);
      await symlink(path.join(f.directory, 'spec.md'), file);
    } else if (change === 'oversize') await writeFile(file, 'x'.repeat(256_001));
    else if (change === 'invalid-utf8') await writeFile(file, Buffer.from([0xff, 0xfe]));
    else saved.artifactManifest = undefined;
    run.state.status = 'RUNNING';
    run.state.checkpoint!.stage = 'implementation-review';
    run.state.checkpoint!.resultIndex = run.state.results.length - 1;
    run.state.checkpoint!.checkStart = 0;
    await saveState(run.directory, run.state);
    const requests = (await readdir(run.directory)).filter((name) =>
      name.endsWith('.request.json'),
    );
    const done = await continueRun(run.directory);
    assert.equal(done.status, 'BLOCKED');
    assert.match(
      done.summary,
      /artifacts changed|escapes|symlink|too large|integrity manifest|UTF-8/,
    );
    assert.deepEqual(
      (await readdir(run.directory)).filter((name) => name.endsWith('.request.json')),
      requests,
    );
  });
}
