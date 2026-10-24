import { afterEach, describe, expect, test } from 'bun:test';
import { lstatSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ipaOutput } from '@/core/build.ts';
import { writePackage } from '@/core/prepare.ts';
import { readSpec } from '@/core/spec.ts';

const fixtures = join(import.meta.dir, '..', 'fixtures');
const roots: string[] = [];

function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), 'lipa-package-'));

  roots.push(directory);

  return directory;
}

afterEach(() => {
  for (const directory of roots.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('ipa output', () => {
  test('resolves a relative --out against the project root', () => {
    expect(ipaOutput('/app', 'build/App.ipa', 'App')).toBe('/app/build/App.ipa');
  });

  test('keeps an absolute --out', () => {
    expect(ipaOutput('/app', '/tmp/App.ipa', 'App')).toBe('/tmp/App.ipa');
  });

  test('defaults to build/App.ipa in the project', () => {
    expect(ipaOutput('/app', undefined, 'App')).toBe('/app/build/App.ipa');
  });
});

describe('writePackage', () => {
  const spec = readSpec(fixtures);
  const values = { version: '1.0.0', build: '1' };
  const source = join(fixtures, 'Sources', 'Sample');

  test('writes the wrapper and links the sources', () => {
    const directory = scratch();

    writePackage(directory, spec, values, source);

    expect(readlinkSync(join(directory, 'Sources', 'Sample'))).toBe(source);
    expect(readFileSync(join(directory, 'xtool.yml'), 'utf8')).toContain('skipLSP: true');
    expect(readFileSync(join(directory, 'Package.swift'), 'utf8')).toContain('.v18');
  });

  test('leaves the files alone when nothing changed, so xtool keeps its build', async () => {
    const directory = scratch();

    writePackage(directory, spec, values, source);
    const manifest = statSync(join(directory, 'Package.swift')).mtimeMs;
    const config = statSync(join(directory, 'xtool.yml')).mtimeMs;
    const link = lstatSync(join(directory, 'Sources', 'Sample')).mtimeMs;

    await Bun.sleep(20);
    writePackage(directory, spec, values, source);

    expect(statSync(join(directory, 'Package.swift')).mtimeMs).toBe(manifest);
    expect(statSync(join(directory, 'xtool.yml')).mtimeMs).toBe(config);
    expect(lstatSync(join(directory, 'Sources', 'Sample')).mtimeMs).toBe(link);
  });

  test('rewrites the manifest when the packages change', () => {
    const directory = scratch();
    const changed = { ...spec, swiftVersion: '6.0' };

    writePackage(directory, spec, values, source);
    writePackage(directory, changed, values, source);

    expect(readFileSync(join(directory, 'Package.swift'), 'utf8')).toContain(
      '.swiftLanguageMode(.v6)',
    );
  });
});
