import { afterAll, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';

import { LipaError } from '@/core/errors.ts';
import { expandPlist, readSpec } from '@/core/spec.ts';

const fixtures = join(import.meta.dir, '..', 'fixtures');
const unknown = join(import.meta.dir, 'unknown.plist');

afterAll(() => {
  rmSync(unknown, { force: true });
});

describe('readSpec', () => {
  const spec = readSpec(fixtures);

  test('reads the application target of an XcodeGen project', () => {
    expect(spec.target).toBe('Sample');
    expect(spec.name).toBe('Sample');
    expect(spec.bundleId).toBe('com.example.sample');
    expect(spec.team).toBe('ABCDE12345');
    expect(spec.minimumIOS).toBe('18.0');
  });

  test('takes the marketing version from the Release xcconfig', () => {
    expect(spec.marketingVersion).toBe('1.0.0');
  });

  test('reads the project build number from the same xcconfig', () => {
    expect(spec.currentProjectVersion).toBe('1');
  });

  test('separates sources, resources and the asset catalog', () => {
    expect(spec.sources).toEqual([join(fixtures, 'Sources/Sample')]);
    expect(spec.resources).toContain(join(fixtures, 'Resources/JS'));
    expect(spec.resources).toContain(join(fixtures, 'Support/LaunchScreen'));
    expect(spec.assets).toBe(join(fixtures, 'Support/Assets.xcassets'));
  });

  test('maps package dependencies to their products', () => {
    const names = spec.packages.map((item) => `${item.name}:${item.product}:${item.kind}`);

    expect(names).toEqual([
      'SampleCore:SampleCore:path',
      'Collections:Collections:from',
      'Algorithms:Algorithms:exact',
    ]);
  });
});

describe('expandPlist', () => {
  const spec = readSpec(fixtures);

  test('replaces the build settings the app bundle needs', () => {
    const plist = expandPlist(spec, { version: '1.2.3', build: '42' });

    expect(plist.CFBundleExecutable).toBe('Sample');
    expect(plist.CFBundleIdentifier).toBe('com.example.sample');
    expect(plist.CFBundleShortVersionString).toBe('1.2.3');
    expect(plist.CFBundleVersion).toBe('42');
  });

  test('stops on a setting it does not know', () => {
    const broken = { ...spec, infoPlist: unknown };
    Bun.write(
      broken.infoPlist,
      '<plist version="1.0"><dict><key>A</key><string>$(NOPE)</string></dict></plist>',
    );

    expect(() => expandPlist(broken, { version: '1', build: '1' })).toThrow(LipaError);
  });
});
