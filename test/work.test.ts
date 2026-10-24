import { afterEach, describe, expect, test } from 'bun:test';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ensureSymlink, shortHash, writeIfChanged } from '@/core/work.ts';

const roots: string[] = [];

function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), 'lipa-work-'));

  roots.push(directory);

  return directory;
}

afterEach(() => {
  for (const directory of roots.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('shortHash', () => {
  test('is stable for the same values', () => {
    expect(shortHash(['/app', '27.0'])).toBe(shortHash(['/app', '27.0']));
  });

  test('separates values that would otherwise join the same way', () => {
    expect(shortHash(['/app', 'b'])).not.toBe(shortHash(['/a', 'ppb']));
  });
});

describe('writeIfChanged', () => {
  test('leaves an identical file untouched, so its time does not move', async () => {
    const path = join(scratch(), 'Package.swift');

    writeIfChanged(path, 'same');
    const before = statSync(path).mtimeMs;

    await Bun.sleep(20);
    writeIfChanged(path, 'same');

    expect(statSync(path).mtimeMs).toBe(before);
  });

  test('replaces a file whose content differs', () => {
    const path = join(scratch(), 'xtool.yml');

    writeIfChanged(path, 'one');
    writeIfChanged(path, 'two');

    expect(readFileSync(path, 'utf8')).toBe('two');
  });
});

describe('ensureSymlink', () => {
  test('creates the link', () => {
    const root = scratch();
    const target = join(root, 'checkout');

    mkdirSync(join(root, 'Sources'));
    mkdirSync(target);
    ensureSymlink(join(root, 'Sources', 'App'), target);

    expect(readlinkSync(join(root, 'Sources', 'App'))).toBe(target);
  });

  test('leaves a link alone when the target matches', async () => {
    const root = scratch();
    const link = join(root, 'link');
    const target = join(root, 'checkout');

    mkdirSync(target);
    ensureSymlink(link, target);
    const before = lstatSync(link).mtimeMs;

    await Bun.sleep(20);
    ensureSymlink(link, target);

    expect(lstatSync(link).mtimeMs).toBe(before);
  });

  test('repoints the link at another checkout', () => {
    const root = scratch();
    const link = join(root, 'link');

    mkdirSync(join(root, 'one'));
    mkdirSync(join(root, 'two'));
    ensureSymlink(link, join(root, 'one'));
    ensureSymlink(link, join(root, 'two'));

    expect(readlinkSync(link)).toBe(join(root, 'two'));
  });
});
