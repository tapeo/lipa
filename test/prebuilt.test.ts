import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { treeHash } from '@/core/hash.ts';
import { checkPrebuilt, writeManifest, writePrebuiltInfo } from '@/core/prebuilt.ts';
import { readSpec } from '@/core/spec.ts';

const fixtures = join(import.meta.dir, '..', 'fixtures');
const home = mkdtempSync(join(tmpdir(), 'lipa-test-'));

beforeAll(() => {
  process.env.LIPA_HOME = home;
  mkdirSync(join(fixtures, 'Support', 'Assets.xcassets'), { recursive: true });
  writeFileSync(join(fixtures, 'Support', 'Assets.xcassets', 'Contents.json'), '{}');
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(join(fixtures, 'Support', 'Assets.xcassets'), { recursive: true, force: true });
});

function seed(assetsHash: string, sdkVersion: string): void {
  const spec = readSpec(fixtures);
  mkdirSync(join(home, 'cache', spec.bundleId), { recursive: true });
  writeFileSync(join(home, 'cache', spec.bundleId, 'Assets.car'), 'car');
  writePrebuiltInfo(spec.bundleId, {
    BuildMachineOSBuild: '25F80',
    CFBundleIcons: { CFBundlePrimaryIcon: { CFBundleIconFiles: ['AppIcon60x60'] } },
  });
  writeManifest({
    bundleId: spec.bundleId,
    assetsHash,
    xcodeVersion: '27A266a',
    sdkVersion,
    createdAt: new Date().toISOString(),
    source: 'test',
  });
}

describe('checkPrebuilt', () => {
  test('stops when the cache is missing', () => {
    const status = checkPrebuilt(readSpec(fixtures), '27.0');

    expect(status.ok).toBe(false);
    expect(status.fix).toContain('lipa prepare');
  });

  test('accepts a cache built from the same assets and SDK', () => {
    const spec = readSpec(fixtures);
    seed(treeHash(spec.assets ?? ''), '27.0');

    expect(checkPrebuilt(spec, '27.0').ok).toBe(true);
  });

  test('reports changed assets', () => {
    const spec = readSpec(fixtures);
    writeFileSync(join(fixtures, 'Support', 'Assets.xcassets', 'Contents.json'), '{"x":1}');

    const status = checkPrebuilt(spec, '27.0');

    expect(status.ok).toBe(false);
    expect(status.reason).toContain('changed');
  });

  test('reports a different SDK version', () => {
    const spec = readSpec(fixtures);
    seed(treeHash(spec.assets ?? ''), '26.0');

    const status = checkPrebuilt(spec, '27.0');

    expect(status.ok).toBe(false);
    expect(status.reason).toContain('26.0');
  });
});
