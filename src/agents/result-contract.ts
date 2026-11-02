import path from 'node:path';
import { reportContract } from './contracts.ts';
import { hasReportContent, reportSections } from './report-sections.ts';
import type { AgentRequest, AgentResult, Document } from '../domain/types.ts';

/** Validate handoff structure before OpenSpec publication or adding a result to role context. */
export async function validateResultContract(
  request: AgentRequest,
  result: AgentResult,
  artifacts: Document[],
): Promise<void> {
  const contract = await reportContract(request.role, result.status);
  const expected = path.normalize(path.join(request.artifactDirectory, contract.file));
  const report = artifacts.find((file) => path.normalize(file.path) === expected);
  if (!report)
    throw new Error(
      `${request.role} (${result.status}) requires ${contract.file} in artifactDirectory`,
    );
  const sections = reportSections(report.content);
  for (const name of contract.sections) {
    const body = sections.get(name);
    if (body === undefined) throw new Error(`${contract.file}: missing report section ${name}`);
    if (!hasReportContent(body)) throw new Error(`${contract.file}: empty report section ${name}`);
  }
  if (result.status === 'NEEDS_CLARIFICATION') {
    for (const question of result.questions) {
      const escaped = question.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const reference = new RegExp(`(^|[^\\p{L}\\p{N}_-])${escaped}($|[^\\p{L}\\p{N}_-])`, 'u');
      if (!reference.test(sections.get('Questions') ?? ''))
        throw new Error(`clarification.md: missing question ${question.id}`);
    }
  }
  if (result.reviewDecision && request.role !== 'review-triager')
    throw new Error('Only review-triager may return a review decision');
  if (result.verification && request.role !== 'verifier')
    throw new Error('Only verifier may return verification decisions');
  if (result.status !== 'COMPLETED') return;
  if (request.role === 'verifier' && !result.verification)
    throw new Error(`Verifier must return a structured ${request.verification?.phase} decision`);
  if (request.role === 'review-triager' && !result.reviewDecision)
    throw new Error('Review triage requires a structured completed decision');
}
