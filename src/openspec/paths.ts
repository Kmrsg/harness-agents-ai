import path from 'node:path';

export const slash = (value: string) => value.split(path.sep).join('/');
export const specFile = /^specs\/(?:[a-zA-Z0-9][a-zA-Z0-9._-]*\/)+spec\.md$/;
export const managedFile = (name: string) =>
  ['.openspec.yaml', 'proposal.md', 'design.md', 'tasks.md'].includes(name) || specFile.test(name);
