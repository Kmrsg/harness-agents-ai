import { createHash } from 'node:crypto';
import path from 'node:path';
import { artifactContents } from './artifacts.ts';
import type { Document, SavedRoleResult } from '../domain/types.ts';

export function artifactManifest(contents: Document[]) {
  return contents.map(({ path, content }) => ({
    path,
    sha256: createHash('sha256').update(content).digest('hex'),
  }));
}

/** Reuse exactly the accepted text, with the same containment/type/size rules as initial loading. */
export async function restoreArtifacts(
  workdir: string,
  saved: SavedRoleResult,
): Promise<Document[]> {
  if (!saved.artifactDirectory || !saved.artifactManifest)
    throw new Error(
      `Saved ${saved.role} has no artifact integrity manifest; automatic reuse is unavailable`,
    );
  const contents = await artifactContents(
    workdir,
    saved.result.artifacts,
    path.resolve(workdir, saved.artifactDirectory),
  );
  if (JSON.stringify(artifactManifest(contents)) !== JSON.stringify(saved.artifactManifest))
    throw new Error(`Saved ${saved.role} artifacts changed after acceptance`);
  return contents;
}
