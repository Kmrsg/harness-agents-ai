import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { packageRoot } from '../infrastructure/package-paths.ts';
import { reportSections } from './report-sections.ts';
import type { Role, Status } from '../domain/types.ts';

type Group = 'analysis' | 'backend' | 'frontend' | 'testing' | 'review';
export const roleContracts: Record<
  Role,
  { group: Group; report: string; template?: string; readOnly: boolean }
> = {
  analyst: { group: 'analysis', report: 'analysis-report.md', readOnly: false },
  'backend-planner': { group: 'backend', report: 'planning-report.md', readOnly: false },
  'frontend-planner': { group: 'frontend', report: 'planning-report.md', readOnly: false },
  'backend-implementer': { group: 'backend', report: 'implementation.md', readOnly: false },
  'frontend-implementer': {
    group: 'frontend',
    report: 'implementation.md',
    template: 'frontend-implementation.md',
    readOnly: false,
  },
  tester: { group: 'testing', report: 'test-report.md', readOnly: false },
  verifier: { group: 'review', report: 'verification-report.md', readOnly: true },
  'review-triager': { group: 'review', report: 'review-report.md', readOnly: true },
};

/** Template headings are the single source of required report sections. */
export async function reportContract(role: Role, status: Status) {
  const file =
    status === 'NEEDS_CLARIFICATION'
      ? 'clarification.md'
      : status === 'BLOCKED'
        ? 'blocked.md'
        : roleContracts[role].report;
  const templateFile = status === 'COMPLETED' ? (roleContracts[role].template ?? file) : file;
  const template = await readFile(path.join(packageRoot, 'agents/templates', templateFile), 'utf8');
  const sections = [...reportSections(template).keys()];
  if (!sections.length) throw new Error(`Report template has no required sections: ${file}`);
  return { file, sections, template };
}

export async function artifactInstructions(role: Role): Promise<string> {
  const statuses = ['COMPLETED', 'NEEDS_CLARIFICATION', 'BLOCKED'] as const;
  const contracts = await Promise.all(statuses.map((status) => reportContract(role, status)));
  return [
    '# Обязательный контракт артефактов',
    'Создай отчёт с точным именем непосредственно в artifactDirectory и включи его в artifacts.',
    'Выбери шаблон по фактическому status. Сохрани все заголовки ## и заполни каждый раздел.',
    'Комментарии шаблона — подсказки: они не считаются содержимым. Не оставляй TODO, TBD или {{...}}.',
    'Для неприменимого раздела напиши «Не применимо» с причиной. Не выдумывай доказательства.',
    'Дополнительные доказательства разрешены внутри artifactDirectory. OpenSpec-черновики пиши отдельно в openspec.draftDirectory по правилам роли.',
    'При NEEDS_CLARIFICATION вопросы с их id должны быть и в JSON questions, и в разделе Questions.',
    'При BLOCKED создай blocked.md с причиной, доказательствами и способом продолжения.',
    ...contracts.map(
      (contract, index) => `## ${statuses[index]} → ${contract.file}\n\n${contract.template}`,
    ),
  ].join('\n\n');
}
