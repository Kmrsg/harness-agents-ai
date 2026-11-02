import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, lstat, readlink } from 'node:fs/promises';
import path from 'node:path';
import { execute } from './process.ts';

/** Read-only reviewer and delivery approval bind to the same product files, including untracked ones. */
export async function workspaceFingerprint(workdir: string, useGit: boolean): Promise<string> {
  let files: string[];
  if (useGit) {
    const response = await execute(
      { command: 'git', args: ['ls-files', '-z', '--cached', '--others', '--exclude-standard'] },
      workdir,
    );
    if (response.exitCode !== 0) throw new Error('Cannot fingerprint Git worktree');
    files = response.stdout
      .split('\0')
      .filter((file) => file && file !== '.harness' && !file.startsWith('.harness/'));
  } else {
    files = [];
    const scan = async (directory: string) => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (['.git', '.harness', 'node_modules', '.idea', '.gradle'].includes(entry.name)) continue;
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) await scan(full);
        else files.push(path.relative(workdir, full));
      }
    };
    await scan(workdir);
  }
  const hash = createHash('sha256');
  for (const file of [...new Set(files)].sort()) {
    const full = path.join(workdir, file);
    let stat;
    try {
      stat = await lstat(full);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        continue;
      }
      throw error;
    }
    hash.update(JSON.stringify(file));
    hash.update(String(stat.mode));
    if (stat.isSymbolicLink()) hash.update(await readlink(full));
    else if (stat.isFile()) {
      const content = createHash('sha256');
      for await (const chunk of createReadStream(full)) content.update(chunk);
      hash.update(content.digest());
    } else hash.update('non-file');
  }
  return hash.digest('hex');
}
