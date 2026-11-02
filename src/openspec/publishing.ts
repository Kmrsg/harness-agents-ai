import { mkdir, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { changeContext } from './documents.ts';
import { slash, managedFile } from './paths.ts';
import { applyRoleDrafts } from './ownership.ts';
import type { Document, OpenSpecContext, Role, Task } from '../domain/types.ts';

/** Validate staged copies before publishing; agents never own the shared files directly. */
export async function assertSharedUnchanged(
  workdir: string,
  before: OpenSpecContext,
): Promise<void> {
  const current = await changeContext(workdir, before, before.draftDirectory);
  if (
    JSON.stringify(current.files) !== JSON.stringify(before.files) ||
    JSON.stringify(current.baselineSpecs) !== JSON.stringify(before.baselineSpecs)
  )
    throw new Error('Agent changed shared OpenSpec files directly; write drafts only');
}

export async function publishDrafts(
  workdir: string,
  role: Role,
  task: Task,
  before: OpenSpecContext,
  artifacts: Document[],
  snapshotDirectory: string,
  planningRevision = false,
): Promise<void> {
  await assertSharedUnchanged(workdir, before);
  const draftRoot = path.resolve(workdir, before.draftDirectory);
  const drafts: Document[] = [];
  for (const artifact of artifacts) {
    const relative = slash(path.relative(draftRoot, path.resolve(workdir, artifact.path)));
    if (relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) continue;
    if (!managedFile(relative) || relative === '.openspec.yaml')
      throw new Error(`Unsupported OpenSpec draft: ${relative}`);
    if (drafts.some((file) => file.path === relative)) throw new Error('Duplicate OpenSpec draft');
    drafts.push({ path: relative, content: artifact.content });
  }
  const next = applyRoleDrafts(role, task, before, drafts, planningRevision);
  // Archive the validated version for every completed stage, including earlier iterations.
  for (const file of next) {
    if (!managedFile(file.path)) throw new Error(`Unknown shared OpenSpec artifact: ${file.path}`);
    const destination = path.join(snapshotDirectory, file.path);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, file.content);
  }
  const root = path.join(workdir, before.directory);
  for (const old of before.files)
    if (!next.some((file) => file.path === old.path)) await unlink(path.join(root, old.path));
  for (const file of next) {
    await mkdir(path.dirname(path.join(root, file.path)), { recursive: true });
    await writeFile(path.join(root, file.path), file.content);
  }
}
