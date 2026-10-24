import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';

export function shortHash(values: readonly string[]): string {
  return createHash('sha256').update(values.join('\0')).digest('hex').slice(0, 12);
}

export function writeIfChanged(path: string, content: string): void {
  if (existsSync(path) && readFileSync(path, 'utf8') === content) {
    return;
  }

  writeFileSync(path, content);
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

export function ensureSymlink(link: string, target: string): void {
  if (isLink(link) && readlinkSync(link) === target) {
    return;
  }

  rmSync(link, { recursive: true, force: true });
  symlinkSync(target, link);
}
