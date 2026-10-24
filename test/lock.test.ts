import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { LipaError } from '@/core/errors.ts';
import { acquireBuildLock } from '@/core/lock.ts';

const roots: string[] = [];

function lockPath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'lipa-lock-'));

  roots.push(directory);

  return join(directory, 'build.lock');
}

function deadPid(): number {
  const child = Bun.spawnSync(['true']);

  return child.pid;
}

afterEach(() => {
  for (const directory of roots.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('acquireBuildLock', () => {
  test('takes the lock and removes it on release', () => {
    const path = lockPath();
    const lock = acquireBuildLock(path);

    expect(Bun.file(join(path, 'owner.json')).size).toBeGreaterThan(0);

    lock.release();

    expect(Bun.file(path).size).toBe(0);
  });

  test('refuses a second build on the same directory and names the holder', () => {
    const path = lockPath();
    const lock = acquireBuildLock(path);

    let thrown: LipaError | undefined;

    try {
      acquireBuildLock(path);
    } catch (error) {
      thrown = error as LipaError;
    }

    expect(thrown?.code).toBe('build_in_progress');
    expect(thrown?.message).toContain(String(process.pid));

    lock.release();
  });

  test('takes over a lock whose process is gone', () => {
    const path = lockPath();
    const pid = deadPid();

    mkdirSync(path);
    writeFileSync(join(path, 'owner.json'), JSON.stringify({ pid, started: 'earlier' }));

    const lock = acquireBuildLock(path);

    expect(Bun.file(join(path, 'owner.json')).size).toBeGreaterThan(0);

    lock.release();
  });
});
