import { createHash } from 'node:crypto';
import { trackedTasks } from '../openspec/validation.ts';
import type {
  AgentResult,
  Document,
  Task,
  Verification,
  VerificationPhase,
} from '../domain/types.ts';

export function planFingerprint(files: Document[]): string {
  const normalized = files
    .map((file) => ({
      ...file,
      content:
        file.path === 'tasks.md' ? file.content.replace(/^- \[[ xX]\]/gm, '- [ ]') : file.content,
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

export function requireReview(
  result: AgentResult,
  phase: VerificationPhase,
  task: Task,
  files: Document[],
): Verification {
  const review = result.verification;
  if (!review || review.phase !== phase)
    throw new Error(`Verifier must return a structured ${phase} decision`);
  const tasks = trackedTasks(files.find((file) => file.path === 'tasks.md')?.content ?? '');
  for (const finding of review.findings) {
    if (finding.criteria.some((id) => !task.acceptanceCriteria.some((item) => item.id === id)))
      throw new Error('Verifier finding references an unknown criterion');
    if (finding.tasks.some((id) => !tasks.some((item) => item.id === id)))
      throw new Error('Verifier finding references an unknown task');
  }
  if (review.verdict === 'APPROVED') {
    for (const criterion of task.acceptanceCriteria)
      if (!result.acceptance.some((item) => item.id === criterion.id && item.passed))
        throw new Error(`Verifier approval lacks evidence for ${criterion.id}`);
  }
  return review;
}
