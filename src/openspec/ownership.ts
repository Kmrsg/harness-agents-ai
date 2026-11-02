import { get, heading, section, trackedTasks, validateSpecs } from './validation.ts';
import { specFile } from './paths.ts';
import type { Document, OpenSpecContext, Role, Task } from '../domain/types.ts';

export function applyRoleDrafts(
  role: Role,
  task: Task,
  before: OpenSpecContext,
  drafts: Document[],
  planningRevision: boolean,
): Document[] {
  let next: Document[];
  if (role === 'analyst') {
    if (drafts.some((file) => file.path !== 'proposal.md' && !specFile.test(file.path)))
      throw new Error('Analyst owns proposal and delta specs only');
    validateSpecs(drafts, task, before.baselineSpecs);
    next = [...before.files.filter((file) => file.path === '.openspec.yaml'), ...drafts];
  } else if (role.endsWith('-planner')) {
    if (drafts.some((file) => !['design.md', 'tasks.md'].includes(file.path)))
      throw new Error('Planners own design and tasks only');
    const design = get(drafts, 'design.md');
    for (const name of ['Context', 'Decisions', 'Risks / Trade-offs']) heading(design, name);
    const tasks = trackedTasks(get(drafts, 'tasks.md'));
    const owner = role.startsWith('backend') ? 'backend' : 'frontend';
    heading(design, owner === 'backend' ? 'Backend' : 'Frontend');
    const previousTasks = before.files.find((file) => file.path === 'tasks.md');
    const previous = previousTasks ? trackedTasks(previousTasks.content) : [];
    for (const old of previous) {
      if (planningRevision && [owner, 'testing'].includes(old.owner)) continue;
      if (
        !tasks.some(
          (item) => item.id === old.id && item.text === old.text && item.done === old.done,
        )
      )
        throw new Error('Planner removed or changed an existing task');
    }
    for (const added of tasks.filter(
      (item) =>
        !previous.some(
          (old) => old.id === item.id && (!planningRevision || old.text === item.text),
        ),
    )) {
      if (added.done || ![owner, 'testing'].includes(added.owner))
        throw new Error('Planner may add pending tasks for its domain and testing only');
    }
    const previousDesign = before.files.find((file) => file.path === 'design.md');
    if (previousDesign) {
      const other = owner === 'backend' ? 'Frontend' : 'Backend';
      const protectedSection = section(previousDesign.content, other);
      if (protectedSection && section(design, other) !== protectedSection)
        throw new Error('Planner changed another domain design section');
    }
    next = [
      ...before.files.filter((file) => !['design.md', 'tasks.md'].includes(file.path)),
      ...drafts,
    ];
  } else {
    if (drafts.some((file) => file.path !== 'tasks.md'))
      throw new Error('Implementers and tester may update task checkboxes only');
    const oldText = get(before.files, 'tasks.md');
    const newText = get(drafts, 'tasks.md');
    const normalize = (text: string) => text.replace(/^- \[[ xX]\]/gm, '- [ ]');
    if (normalize(oldText) !== normalize(newText))
      throw new Error('Implementation cannot change task definitions');
    const oldTasks = trackedTasks(oldText);
    const newTasks = trackedTasks(newText);
    const owner =
      role === 'tester' ? 'testing' : role.startsWith('backend') ? 'backend' : 'frontend';
    for (const item of newTasks) {
      const old = oldTasks.find((t) => t.id === item.id)!;
      if (item.owner !== owner && old.done !== item.done)
        throw new Error('Agent changed another role task checkbox');
      if (item.owner === owner && !item.done)
        throw new Error(`Completed ${role} left task ${item.id} unfinished`);
    }
    next = [...before.files.filter((file) => file.path !== 'tasks.md'), ...drafts];
  }
  return next;
}
