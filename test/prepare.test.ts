import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { treeHash } from '@/core/hash.ts';
import { writeManifest, writePrebuiltInfo } from '@/core/prebuilt.ts';
import { macSource, packageDirectory, preparePlan, prepareProject } from '@/core/prepare.ts';
import { readSpec } from '@/core/spec.ts';

const fixtures = join(import.meta.dir, '..', 'fixtures');

function restoreVariable(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}
const assets = join(fixtures, 'Support', 'Assets.xcassets');

beforeAll(() => {
  mkdirSync(assets, { recursive: true });
  writeFileSync(join(assets, 'Contents.json'), '{}');
});

afterAll(() => {
  rmSync(assets, { recursive: true, force: true });
});

describe('preparePlan', () => {
  test('compiles when everything else is ready', () => {
    const decision = preparePlan({
      prebuiltStale: false,
      mac: undefined,
      workspaceExists: true,
      clean: false,
      update: false,
    });

    expect(decision).toEqual({ steps: ['compile'], prebuilt: 'skip', cold: false });
  });

  test('refreshes the prebuilt cache when the Mac is given', () => {
    const decision = preparePlan({
      prebuiltStale: true,
      mac: { kind: 'ssh', host: 'macbook' },
      workspaceExists: true,
      clean: false,
      update: false,
    });

    expect(decision.steps).toEqual(['prebuilt', 'compile']);
    expect(decision.prebuilt).toBe('refresh');
  });

  test('compiles anyway when the cache is stale and no Mac is given', () => {
    const decision = preparePlan({
      prebuiltStale: true,
      mac: undefined,
      workspaceExists: true,
      clean: false,
      update: false,
    });

    expect(decision.steps).toEqual(['compile']);
    expect(decision.prebuilt).toBe('skip');
  });

  test('imports every time an import directory is given', () => {
    const decision = preparePlan({
      prebuiltStale: false,
      mac: { kind: 'import', directory: '/tmp/assets' },
      workspaceExists: true,
      clean: false,
      update: false,
    });

    expect(decision.steps).toEqual(['prebuilt', 'compile']);
    expect(decision.prebuilt).toBe('import');
  });

  test('cleans before compiling and skips the update', () => {
    const decision = preparePlan({
      prebuiltStale: false,
      mac: undefined,
      workspaceExists: true,
      clean: true,
      update: true,
    });

    expect(decision.steps).toEqual(['clean', 'compile']);
    expect(decision.cold).toBe(true);
  });

  test('updates the dependencies without a clean', () => {
    const decision = preparePlan({
      prebuiltStale: false,
      mac: undefined,
      workspaceExists: true,
      clean: false,
      update: true,
    });

    expect(decision.steps).toEqual(['update', 'compile']);
  });

  test('reports a cold workspace', () => {
    const decision = preparePlan({
      prebuiltStale: false,
      mac: undefined,
      workspaceExists: false,
      clean: false,
      update: false,
    });

    expect(decision.cold).toBe(true);
  });
});

describe('macSource', () => {
  test('keeps the transport apart', () => {
    expect(macSource({ mac: 'macbook' })).toEqual({ kind: 'ssh', host: 'macbook' });
    expect(macSource({ via: 'ssh -p 2222 me@192.168.1.10' })).toEqual({
      kind: 'via',
      command: 'ssh -p 2222 me@192.168.1.10',
    });
    expect(macSource({ import: '/tmp/assets' })).toEqual({
      kind: 'import',
      directory: '/tmp/assets',
    });
    expect(macSource({})).toBeUndefined();
  });

  test('refuses two sources at once', () => {
    expect(() => macSource({ mac: 'macbook', via: 'ssh macbook' })).toThrow();
    expect(() => macSource({ mac: 'macbook', import: '/tmp/assets' })).toThrow();
  });
});

describe('prepareProject', () => {
  test('writes the workspace and compiles when the prebuilt cache is fresh', async () => {
    const home = mkdtempSync(join(tmpdir(), 'lipa-prepare-'));
    const sdk = join(home, 'sdk');
    const platforms = join(sdk, 'Developer', 'Platforms', 'iPhoneOS.platform', 'Developer', 'SDKs');
    const bin = join(home, 'bin');

    mkdirSync(join(platforms, 'iPhoneOS27.0.sdk'), { recursive: true });
    writeFileSync(join(platforms, 'iPhoneOS27.0.sdk', 'SDKSettings.json'), '{"Version":"27.0"}');
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      join(bin, 'xtool'),
      '#!/bin/sh\ntarget=$(ls Sources | head -1)\nmkdir -p "xtool/$target.app"\nprintf fake > "xtool/$target.app/$target"\n',
    );
    chmodSync(join(bin, 'xtool'), 0o755);

    const restore = {
      home: process.env.LIPA_HOME,
      sdk: process.env.LIPA_SDK,
      toolchain: process.env.LIPA_SWIFT_TOOLCHAIN,
    };

    process.env.LIPA_HOME = home;
    process.env.LIPA_SDK = sdk;
    process.env.LIPA_SWIFT_TOOLCHAIN = join(home, 'swift');

    try {
      const spec = readSpec(fixtures);
      const directory = join(home, 'cache', spec.bundleId);

      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, 'Assets.car'), 'car');
      writePrebuiltInfo(spec.bundleId, { DTPlatformVersion: '27.0' });
      writeManifest({
        bundleId: spec.bundleId,
        assetsHash: treeHash(spec.assets ?? ''),
        xcodeVersion: '27A123',
        sdkVersion: '27.0',
        createdAt: new Date().toISOString(),
        source: 'test',
      });

      const result = await prepareProject({ root: fixtures });
      const packagePath = packageDirectory(spec, '27.0');

      expect(result.steps).toEqual(['compile']);
      expect(result.prebuilt.ok).toBe(true);
      expect(result.signing.ok).toBe(false);
      expect(existsSync(join(packagePath, 'xtool', 'Sample.app', 'Sample'))).toBe(true);
      expect(existsSync(join(packagePath, 'Support', 'entitlements.plist'))).toBe(true);
    } finally {
      restoreVariable('LIPA_HOME', restore.home);
      restoreVariable('LIPA_SDK', restore.sdk);
      restoreVariable('LIPA_SWIFT_TOOLCHAIN', restore.toolchain);
      rmSync(home, { recursive: true, force: true });
    }
  });
});
