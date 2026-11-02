import { createHash } from 'node:crypto';
import type { ReviewThread } from '../domain/types.ts';

/** Same normalized human discussion is used for scheduling and validating a saved reply. */
export function threadFingerprint(thread: ReviewThread): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        id: thread.id,
        resolved: thread.resolved,
        path: thread.path,
        line: thread.line,
        comments: thread.comments
          .filter((comment) => !comment.own)
          .map((comment) => ({
            id: comment.id,
            author: comment.author,
            body: comment.body,
            own: false,
          })),
      }),
    )
    .digest('hex');
}
