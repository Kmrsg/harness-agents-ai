import { artifactInstructions, roleContracts } from './contracts.ts';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { packageRoot } from '../infrastructure/package-paths.ts';
import type { Config, Role } from '../domain/types.ts';

const agentDirectory = path.join(packageRoot, 'agents');
type AgentGroup = 'analysis' | 'backend' | 'frontend' | 'testing' | 'review';

const knowledgeByGroup: Record<AgentGroup, string[]> = {
  analysis: ['frontend', 'backend', 'testing'],
  backend: ['backend'],
  frontend: ['frontend'],
  testing: ['testing'],
  review: ['frontend', 'backend', 'testing'],
};

async function knowledgeFiles(
  root: string,
  directory = root,
): Promise<{ path: string; content: string }[]> {
  const result: { path: string; content: string }[] = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, item.name);
    if (item.isDirectory()) result.push(...(await knowledgeFiles(root, full)));
    else if (item.isFile() && item.name.endsWith('.md'))
      result.push({ path: path.relative(root, full), content: await readFile(full, 'utf8') });
  }
  return result.sort((a, b) => a.path.localeCompare(b.path));
}

export async function instructions(role: Role, config: Config): Promise<string> {
  const common = await readFile(path.join(agentDirectory, 'common.md'), 'utf8');
  const group = roleContracts[role].group;
  const specific = await readFile(path.join(agentDirectory, group, `${role}.md`), 'utf8');
  const skill = await readFile(
    path.join(packageRoot, 'skills/project-conventions/SKILL.md'),
    'utf8',
  );
  const index = await readFile(path.join(config.knowledgeRoot, 'index.md'), 'utf8');
  // Only the selected domain is loaded; knowledge remains outside task-controlled input.
  const domains = knowledgeByGroup[group];
  const knowledge = [];
  for (const domain of domains)
    knowledge.push(
      ...(await knowledgeFiles(config.knowledgeRoot, path.join(config.knowledgeRoot, domain))),
    );
  return [
    common,
    specific,
    await artifactInstructions(role),
    `Convention routing skill (knowledge root: ${config.knowledgeRoot}):\n${skill}`,
    'Knowledge index:\n' + index,
    ...knowledge.map((file) => `Convention ${file.path}:\n${file.content}`),
  ].join('\n\n');
}
