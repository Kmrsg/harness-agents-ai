import { readFile, realpath, lstat } from 'node:fs/promises';
import path from 'node:path';
import { isUtf8 } from 'node:buffer';

export async function artifactContents(
  workdir: string,
  artifacts: string[],
  allowedDirectory: string,
): Promise<{ path: string; content: string }[]> {
  const root = await realpath(allowedDirectory);
  const workRoot = await realpath(workdir);
  const assigned = path.relative(path.resolve(workdir), path.resolve(allowedDirectory));
  if (
    assigned === '..' ||
    assigned.startsWith(`..${path.sep}`) ||
    path.isAbsolute(assigned) ||
    root !== path.resolve(workRoot, assigned)
  )
    throw new Error('Assigned artifact directory escapes workdir or contains a symlink');
  const result = [];
  if (new Set(artifacts).size !== artifacts.length) throw new Error('Duplicate artifact path');
  for (const artifact of artifacts) {
    if (path.isAbsolute(artifact)) throw new Error('Artifact path must be relative to workdir');
    const full = await realpath(path.resolve(workdir, artifact));
    const relative = path.relative(root, full);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
      throw new Error(`Artifact escapes assigned directory: ${artifact}`);
    if (full !== path.resolve(workRoot, artifact))
      throw new Error(`Artifact path contains a symlink: ${artifact}`);
    const stat = await lstat(path.resolve(workdir, artifact));
    if (!stat.isFile()) throw new Error(`Artifact must be a regular file: ${artifact}`);
    if (stat.size > 256_000) throw new Error(`Artifact too large: ${artifact}`);
    const bytes = await readFile(full);
    if (!isUtf8(bytes)) throw new Error(`Artifact must contain valid UTF-8: ${artifact}`);
    const content = bytes.toString('utf8');
    if (Buffer.byteLength(content) > 256_000) throw new Error(`Artifact too large: ${artifact}`);
    result.push({ path: artifact, content });
  }
  return result;
}
