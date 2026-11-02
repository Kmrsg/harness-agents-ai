import { threadFingerprint } from '../src/review/identity.ts';
/** Editable offline fixture: no network requests, no Bitbucket or Task tracker changes. */
import { readFile, appendFile } from 'node:fs/promises';
import { git } from '../src/infrastructure/git.ts';
let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
if (request.version !== 1) throw new Error('Unsupported integration version');
const payload = request.payload;
async function snapshot() {
  const file = process.env.HARNESS_BITBUCKET_FIXTURE;
  if (!file)
    throw new Error(
      'Set HARNESS_BITBUCKET_FIXTURE to an absolute JSON fixture path, or implement your Bitbucket API calls here',
    );
  const data = JSON.parse(await readFile(file, 'utf8'));
  if (data.sourceCommit === 'REMOTE') {
    const head = await git(process.cwd(), [
      'ls-remote',
      '--heads',
      'origin',
      `refs/heads/${payload.branch}`,
    ]);
    data.sourceCommit = head.split(/\s+/)[0];
  }
  return data;
}
let result: Record<string, unknown> = { ok: true, mock: true };
switch (request.operation) {
  case 'task.report':
    break;
  case 'pull-request.create':
    result.url = 'https://bitbucket.example.invalid/projects/DEMO/repos/demo/pull-requests/1';
    break;
  case 'pull-request.get':
    result = { ...result, ...(await snapshot()) };
    break;
  case 'pull-request.reply': {
    // Fixture only: implement this precondition and idempotency in your real adapter.
    const current = await snapshot();
    if (current.state !== 'OPEN' || current.sourceCommit !== payload.expectedSourceCommit)
      throw new Error('PR closed or source head changed');
    if (!process.env.HARNESS_BITBUCKET_FIXTURE) throw new Error('Set HARNESS_BITBUCKET_FIXTURE');
    const thread = current.threads.find(
      (thread: import('../src/domain/types.ts').ReviewThread) => thread.id === payload.threadId,
    );
    if (
      !thread ||
      thread.resolved ||
      (payload.expectedThreadFingerprint &&
        threadFingerprint(thread) !== payload.expectedThreadFingerprint)
    )
      throw new Error('PR thread changed');
    const file = process.env.HARNESS_BITBUCKET_FIXTURE + '.replies.jsonl';
    let existing = '';
    try {
      existing = await readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (
      !existing
        .split('\n')
        .filter(Boolean)
        .some((line) => JSON.parse(line).idempotencyKey === payload.idempotencyKey)
    )
      await appendFile(file, JSON.stringify(payload) + '\n');
    break;
  }
  default:
    throw new Error('Unsupported integration request');
}
process.stderr.write(`[MOCK] ${request.operation}\n`);
process.stdout.write(JSON.stringify(result) + '\n');
