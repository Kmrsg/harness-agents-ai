import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { runAgent } from '../../src/agents/runner.ts';
import { fixture } from '../support/workflow-fixture.ts';
import { interruptionFixture } from '../support/interruption-fixture.ts';
import type { AgentRequest } from '../../src/domain/types.ts';

function request(workdir: string, specification = ''): AgentRequest {
  return { workdir, specification } as AgentRequest;
}

test('cli mode carries a 2 MB request over stdin without putting it in argv', async (t) => {
  const f = await fixture(t);
  const runner = path.join(f.directory, 'cli-fixture.mjs');
  const capture = path.join(f.directory, 'capture.json');
  await writeFile(
    runner,
    `
    import fs from 'node:fs/promises';
    process.stdin.setEncoding('utf8');let input='';for await(const c of process.stdin)input+=c;
    await fs.writeFile(${JSON.stringify(capture)},JSON.stringify({args:process.argv.slice(2),bytes:Buffer.byteLength(input),request:JSON.parse(input)}));
    console.log(JSON.stringify([{type:'result',subtype:'success',is_error:false,result:JSON.stringify({status:'COMPLETED',summary:'Fixture',artifacts:[],questions:[],acceptance:[]})}]));
  `,
  );
  f.config.runnerMode = 'cli';
  f.config.runner = { command: process.execPath, args: [runner] };
  const input = request(f.directory, 'я'.repeat(1_000_000));
  const response = await runAgent(input, f.config);
  assert.equal(response.result.status, 'COMPLETED');
  const actual = JSON.parse(await readFile(capture, 'utf8'));
  assert.deepEqual(actual.args, ['--output-format', 'json']);
  assert.equal(
    createHash('sha256').update(JSON.stringify(actual.request)).digest('hex'),
    createHash('sha256').update(JSON.stringify(input)).digest('hex'),
  );
  assert.ok(actual.bytes > 2_000_000);
  f.config.maxInputBytes = 1000;
  await assert.rejects(runAgent(input, f.config), /exceeds maxInputBytes/);
  f.config.maxInputBytes = 4_000_000;
  f.config.runnerInput = 'argv';
  await assert.rejects(runAgent(input, f.config), /argv input exceeds safe limit/);
});

test('argv compatibility sends a small prompt only when explicitly selected', async (t) => {
  const f = await fixture(t);
  const runner = path.join(f.directory, 'argv-fixture.mjs');
  await writeFile(
    runner,
    `
    import assert from 'node:assert/strict';
    assert.equal(process.argv[2],'-p');assert.equal(JSON.parse(process.argv[3]).specification,'small');
    let input='';for await(const c of process.stdin)input+=c;assert.equal(input,'');
    console.log(JSON.stringify([{type:'result',subtype:'success',result:JSON.stringify({status:'COMPLETED',summary:'Fixture',artifacts:[],questions:[],acceptance:[]})}]));
  `,
  );
  f.config.runner = { command: process.execPath, args: [runner] };
  f.config.runnerMode = 'cli';
  f.config.runnerInput = 'argv';
  assert.equal(
    (await runAgent(request(f.directory, 'small'), f.config)).result.status,
    'COMPLETED',
  );
});

test('timeout and output overflow retain bounded stdout and stderr diagnostics', async (t) => {
  const f = await fixture(t);
  for (const overflow of [false, true]) {
    f.config.runner = {
      command: process.execPath,
      args: [
        '-e',
        `console.log('partial stdout');console.error('diagnostic stderr');${overflow ? "setTimeout(()=>console.log('x'.repeat(100000)),50);" : ''}setInterval(()=>{},1000);`,
      ],
    };
    f.config.timeoutMs = 2000;
    f.config.maxOutputBytes = overflow ? 1000 : 10_000;
    let saved: { stdout: string; stderr: string } | undefined;
    await assert.rejects(
      runAgent(request(f.directory), f.config, async (stdout, stderr) => {
        saved = { stdout, stderr };
      }),
      overflow ? /output limit/ : /timed out/,
    );
    assert.match(saved!.stdout, /partial stdout/);
    if (!overflow) assert.match(saved!.stderr, /diagnostic stderr/);
    assert.ok(Buffer.byteLength(saved!.stdout + saved!.stderr) <= f.config.maxOutputBytes);
  }
});

test('SIGINT persists partial role logs as well as the interruption state', async (t) => {
  const f = await interruptionFixture(t, "request.role==='frontend-implementer'");
  // The paused fixture writes diagnostics before waiting, as a real CLI would.
  const runner = path.join(f.directory, '.harness/pausing-runner.mjs');
  const source = await readFile(runner, 'utf8');
  await writeFile(
    runner,
    source.replace(
      'await new Promise(()=>setInterval',
      "console.log('partial role output');console.error('role diagnostics');await new Promise(()=>setInterval",
    ),
  );
  const run = await f.begin();
  run.child.kill('SIGINT');
  await run.finished;
  assert.match(
    await readFile(path.join(run.runDirectory, '1-frontend-implementer.stdout.log'), 'utf8'),
    /partial role output/,
  );
  assert.match(
    await readFile(path.join(run.runDirectory, '1-frontend-implementer.stderr.log'), 'utf8'),
    /role diagnostics/,
  );
});
