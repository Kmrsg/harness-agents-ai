import { mkdir, readdir, readFile, writeFile, realpath, lstat } from 'node:fs/promises';
import path from 'node:path';
import { slash } from './paths.ts';
import type { Document, OpenSpecChange, OpenSpecContext } from '../domain/types.ts';

/** Only regular, bounded documents: symlinks must not redirect shared artifacts. */
async function documents(root: string, directory = root): Promise<Document[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const result: Document[] = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink())
      throw new Error(`OpenSpec document tree contains a symlink: ${entry.name}`);
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await documents(root, full)));
    else if (entry.isFile() && (entry.name.endsWith('.md') || entry.name === '.openspec.yaml')) {
      const content = await readFile(full, 'utf8');
      if (Buffer.byteLength(content) > 256_000)
        throw new Error(`OpenSpec document too large: ${full}`);
      result.push({ path: slash(path.relative(root, full)), content });
    }
  }
  if (result.reduce((size, file) => size + Buffer.byteLength(file.content), 0) > 2_000_000)
    throw new Error('OpenSpec context exceeds 2MB');
  return result.sort((a, b) => a.path.localeCompare(b.path));
}

export async function initializeChange(workdir: string, runId: string): Promise<OpenSpecChange> {
  const name = `task-${runId.toLowerCase().replace(/_/g, '-')}`;
  const directory = `openspec/changes/${name}`;
  const parent = path.join(workdir, 'openspec/changes');
  await mkdir(parent, { recursive: true });
  const relative = path.relative(await realpath(workdir), await realpath(parent));
  if (relative.startsWith('..') || path.isAbsolute(relative))
    throw new Error('OpenSpec root escapes workdir');
  await mkdir(path.join(workdir, directory), { recursive: true });
  if ((await lstat(path.join(workdir, directory))).isSymbolicLink())
    throw new Error('OpenSpec change directory must not be a symlink');
  // A crash may occur between directory creation and saving the change in state.json.
  try {
    await writeFile(
      path.join(workdir, directory, '.openspec.yaml'),
      `schema: spec-driven\ncreated: ${new Date().toISOString().slice(0, 10)}\n`,
      { flag: 'wx' },
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const files = await documents(path.join(workdir, directory));
    if (
      files.length !== 1 ||
      files[0].path !== '.openspec.yaml' ||
      !files[0].content.startsWith('schema: spec-driven\n')
    )
      throw new Error(
        'Existing OpenSpec change has no saved checkpoint; inspect it before continuing',
      );
  }
  return { name, directory };
}

export async function changeContext(
  workdir: string,
  change: OpenSpecChange,
  artifactDirectory: string,
): Promise<OpenSpecContext> {
  return {
    ...change,
    draftDirectory: slash(path.join(artifactDirectory, 'openspec')),
    files: await documents(path.join(workdir, change.directory)),
    baselineSpecs: await documents(path.join(workdir, 'openspec/specs')),
  };
}

/** Code invalidates completion after review feedback; old versions remain in role snapshots. */
export async function reopenTasks(workdir: string, change: OpenSpecChange): Promise<void> {
  const file = path.join(workdir, change.directory, 'tasks.md');
  const content = await readFile(file, 'utf8');
  await writeFile(file, content.replace(/^- \[[xX]\]/gm, '- [ ]'));
}
