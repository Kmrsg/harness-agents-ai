import { specFile } from './paths.ts';
import type { Document, Task } from '../domain/types.ts';

export function get(files: Document[], name: string): string {
  const file = files.find((item) => item.path === name);
  if (!file?.content.trim()) throw new Error(`Missing OpenSpec artifact: ${name}`);
  return file.content;
}
export function heading(text: string, name: string): void {
  if (!text.split('\n').some((line) => line.trim() === `## ${name}`))
    throw new Error(`Missing OpenSpec section: ${name}`);
}
function capabilities(proposal: string): { name: string; modified: boolean }[] {
  const result: { name: string; modified: boolean }[] = [];
  let mode: 'new' | 'modified' | undefined;
  for (const line of proposal.split('\n')) {
    if (line === '### New Capabilities') mode = 'new';
    else if (line === '### Modified Capabilities') mode = 'modified';
    else if (/^#{1,3} /.test(line)) mode = undefined;
    else if (mode) {
      const match = /^- `([a-zA-Z0-9][a-zA-Z0-9._/-]*)`: .+/.exec(line);
      if (match) result.push({ name: match[1], modified: mode === 'modified' });
    }
  }
  if (!result.length || new Set(result.map((c) => c.name)).size !== result.length)
    throw new Error(
      'Proposal must declare unique capability paths using - `capability`: description',
    );
  return result;
}

export function validateSpecs(files: Document[], task: Task, baseline: Document[]): void {
  const proposal = get(files, 'proposal.md');
  for (const name of ['Why', 'What Changes', 'Capabilities', 'Impact']) heading(proposal, name);
  const declared = capabilities(proposal);
  const specs = files.filter((file) => specFile.test(file.path));
  if (specs.length !== declared.length)
    throw new Error('Proposal capabilities must match delta spec files');
  for (const capability of declared) {
    const existing = baseline.some((file) => file.path === `${capability.name}/spec.md`);
    if (existing !== capability.modified)
      throw new Error(
        `Capability ${capability.name} must be declared as ${existing ? 'modified' : 'new'}`,
      );
    if (
      !capability.modified &&
      !capability.name.split('/').every((segment) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(segment))
    )
      throw new Error('New capability paths must use kebab-case');
    const spec = get(specs, `specs/${capability.name}/spec.md`);
    if (!capability.modified) heading(spec, 'Purpose');
    if (!/^## (ADDED|MODIFIED|REMOVED|RENAMED) Requirements\s*$/m.test(spec))
      throw new Error('Delta spec must declare requirement operations');
    // This is the Harness contract gate, not a replacement for the OpenSpec CLI validator.
    for (const section of spec.split(/^## /m).slice(1)) {
      if (!/^(ADDED|MODIFIED) Requirements\s*\n/.test(section)) continue;
      const requirements = section.split(/^### Requirement: /m).slice(1);
      if (!requirements.length) throw new Error('Delta section has no requirements');
      for (const requirement of requirements) {
        if (!/\b(SHALL|MUST)\b/.test(requirement.split(/^#### Scenario:/m)[0]))
          throw new Error('Requirement needs SHALL or MUST');
        const scenarios = requirement.split(/^#### Scenario: /m).slice(1);
        if (
          !scenarios.length ||
          scenarios.some(
            (scenario) => !scenario.includes('**WHEN**') || !scenario.includes('**THEN**'),
          )
        )
          throw new Error('Requirement needs WHEN/THEN scenarios');
      }
    }
  }
  const allSpecs = specs.map((file) => file.content).join('\n');
  for (const criterion of task.acceptanceCriteria)
    if (!allSpecs.includes(criterion.id))
      throw new Error(`OpenSpec specs missing criterion ${criterion.id}`);
}

export interface TrackedTask {
  id: string;
  owner: 'backend' | 'frontend' | 'testing';
  done: boolean;
  text: string;
}
export function trackedTasks(text: string): TrackedTask[] {
  const result: TrackedTask[] = [];
  for (const line of text.split('\n')) {
    if (!/^\s*[-*+]\s*\[/.test(line)) continue;
    const match = /^- \[([ xX])\] (\d+\.\d+(?:\.\d+)*) \[(backend|frontend|testing)\] (.+)$/.exec(
      line,
    );
    if (!match)
      throw new Error('Harness task format: - [ ] 1.1 [backend|frontend|testing] description');
    result.push({
      id: match[2],
      owner: match[3] as TrackedTask['owner'],
      done: match[1].toLowerCase() === 'x',
      text: line.replace(/^- \[[ xX]\]/, '- [ ]'),
    });
  }
  if (!result.length || new Set(result.map((task) => task.id)).size !== result.length)
    throw new Error('OpenSpec tasks must have unique numeric ids');
  return result;
}

export function validatePlan(files: Document[], task: Task, allDone = false): void {
  get(files, 'proposal.md');
  const design = get(files, 'design.md');
  for (const name of ['Context', 'Decisions', 'Risks / Trade-offs']) heading(design, name);
  const tasks = get(files, 'tasks.md');
  const tracked = trackedTasks(tasks);
  for (const area of task.areas) {
    heading(design, area === 'backend' ? 'Backend' : 'Frontend');
    if (!tracked.some((item) => item.owner === area)) throw new Error(`No ${area} tasks`);
  }
  if (!tracked.some((item) => item.owner === 'testing')) throw new Error('No testing tasks');
  for (const criterion of task.acceptanceCriteria)
    if (!tasks.includes(criterion.id))
      throw new Error(`OpenSpec tasks missing criterion ${criterion.id}`);
  if (allDone && tracked.some((item) => !item.done))
    throw new Error('OpenSpec tasks are incomplete');
}

export function section(text: string, name: string): string | undefined {
  const parts = text.split(/^## /m).slice(1);
  return parts.find((part) => part.split('\n')[0].trim() === name)?.trimEnd();
}
