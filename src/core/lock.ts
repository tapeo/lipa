import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { LipaError } from '@/core/errors.ts';

export interface BuildLock {
  release: () => void;
}

interface LockOwner {
  pid: number;
  started: string;
}

function ownerOf(directory: string): LockOwner | undefined {
  try {
    const value = JSON.parse(
      readFileSync(join(directory, 'owner.json'), 'utf8'),
    ) as Partial<LockOwner>;

    if (typeof value.pid !== 'number') {
      return undefined;
    }

    return { pid: value.pid, started: value.started ?? '' };
  } catch {
    return undefined;
  }
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function takeLock(path: string, owner: LockOwner): boolean {
  const staging = `${path}.${owner.pid}.${Date.now()}`;

  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging);
  writeFileSync(join(staging, 'owner.json'), `${JSON.stringify(owner, null, 2)}\n`);

  try {
    renameSync(staging, path);

    return true;
  } catch {
    rmSync(staging, { recursive: true, force: true });

    return false;
  }
}

function dropStale(path: string): void {
  const aside = `${path}.stale.${process.pid}.${Date.now()}`;

  try {
    renameSync(path, aside);
  } catch {
    return;
  }

  rmSync(aside, { recursive: true, force: true });
}

export function acquireBuildLock(path: string): BuildLock {
  const owner: LockOwner = { pid: process.pid, started: new Date().toISOString() };

  mkdirSync(join(path, '..'), { recursive: true });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (takeLock(path, owner)) {
      return {
        release: () => {
          const current = ownerOf(path);

          if (current?.pid === owner.pid) {
            rmSync(path, { recursive: true, force: true });
          }
        },
      };
    }

    const holder = ownerOf(path);

    if (holder !== undefined && isRunning(holder.pid)) {
      throw new LipaError({
        code: 'build_in_progress',
        message: `Another lipa build holds ${path}, pid ${holder.pid} since ${holder.started}`,
        fix: 'Wait for it to finish. If no build is running, delete that directory.',
      });
    }

    if (!existsSync(path)) {
      continue;
    }

    dropStale(path);
  }

  throw new LipaError({
    code: 'build_in_progress',
    message: `Cannot take the build lock at ${path}`,
    fix: 'Run lipa again, or delete that directory if no build is running.',
  });
}
