import { z } from 'zod';
import { callAdapter } from './adapter.ts';
import type { PullRequestSnapshot, RunState } from '../domain/types.ts';

const snapshotSchema = z.object({
  state: z.enum(['OPEN', 'MERGED', 'CLOSED']),
  sourceCommit: z.string().regex(/^[a-f0-9]{40,64}$/),
  threads: z
    .array(
      z.object({
        id: z.string().min(1).max(200),
        resolved: z.boolean(),
        path: z.string().max(2000).optional(),
        line: z.number().int().positive().optional(),
        comments: z
          .array(
            z.object({
              id: z.string().min(1).max(200),
              author: z.string().min(1).max(500),
              body: z.string().max(64_000),
              own: z.boolean(),
            }),
          )
          .max(500),
      }),
    )
    .max(1000),
});

export async function readPullRequest(state: RunState): Promise<PullRequestSnapshot> {
  if (!state.config.integrations.bitbucket || !state.pullRequestUrl)
    throw new Error('PR monitoring requires a Bitbucket adapter and a PR URL');
  const result = await callAdapter(
    state.config.integrations.bitbucket,
    state.config.projectRoot,
    'pull-request.get',
    {
      url: state.pullRequestUrl,
      runId: state.id,
      branch: state.branch,
    },
  );
  const snapshot = snapshotSchema.parse(result);
  if (new Set(snapshot.threads.map((t) => t.id)).size !== snapshot.threads.length)
    throw new Error('Duplicate PR thread id');
  for (const thread of snapshot.threads)
    if (new Set(thread.comments.map((c) => c.id)).size !== thread.comments.length)
      throw new Error('Duplicate PR comment id');
  return snapshot;
}
