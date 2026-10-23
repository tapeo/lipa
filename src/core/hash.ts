import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

function filesIn(directory: string): string[] {
  const files: string[] = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === '.DS_Store') {
      continue;
    }

    const path = join(directory, entry.name);

    if (entry.isDirectory()) {
      files.push(...filesIn(path));
      continue;
    }

    if (entry.isFile()) {
      files.push(path);
    }
  }

  return files;
}

export function treeHash(directory: string): string {
  const digest = createHash('sha256');
  const files = filesIn(directory).sort((left, right) =>
    relative(directory, left).localeCompare(relative(directory, right)),
  );

  for (const path of files) {
    digest.update(`${relative(directory, path).split('\\').join('/')}\0`);
    digest.update(readFileSync(path));
  }

  return digest.digest('hex');
}

export function fileHash(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}
