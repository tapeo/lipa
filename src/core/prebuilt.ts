import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { LipaError } from '@/core/errors.ts';
import { treeHash } from '@/core/hash.ts';
import { paths } from '@/core/paths.ts';
import { type PlistValue, readPlist, serializePlist } from '@/core/plist.ts';
import { type BuildSpec, readSpec } from '@/core/spec.ts';

export const MAC_KEYS = [
  'BuildMachineOSBuild',
  'CFBundleIcons',
  'CFBundleIcons~ipad',
  'DTCompiler',
  'DTPlatformBuild',
  'DTPlatformName',
  'DTPlatformVersion',
  'DTSDKBuild',
  'DTSDKName',
  'DTXcode',
  'DTXcodeBuild',
  'NSAccentColorName',
] as const;

export interface PrebuiltManifest {
  bundleId: string;
  assetsHash: string;
  xcodeVersion: string;
  sdkVersion: string;
  createdAt: string;
  source: string;
}

export function cacheDir(bundleId: string): string {
  return join(paths().cache, bundleId);
}

export function manifestPath(bundleId: string): string {
  return join(cacheDir(bundleId), 'manifest.json');
}

export function readManifest(bundleId: string): PrebuiltManifest | undefined {
  const path = manifestPath(bundleId);

  if (!existsSync(path)) {
    return undefined;
  }

  return JSON.parse(readFileSync(path, 'utf8')) as PrebuiltManifest;
}

export function writeManifest(manifest: PrebuiltManifest): void {
  mkdirSync(cacheDir(manifest.bundleId), { recursive: true });
  writeFileSync(manifestPath(manifest.bundleId), `${JSON.stringify(manifest, null, 2)}\n`);
}

export function prebuiltInfo(bundleId: string): { [key: string]: PlistValue } {
  return JSON.parse(readFileSync(join(cacheDir(bundleId), 'Info.plist.json'), 'utf8')) as {
    [key: string]: PlistValue;
  };
}

export function writePrebuiltInfo(bundleId: string, values: { [key: string]: PlistValue }): void {
  mkdirSync(cacheDir(bundleId), { recursive: true });
  writeFileSync(
    join(cacheDir(bundleId), 'Info.plist.json'),
    `${JSON.stringify(values, null, 2)}\n`,
  );
  writeFileSync(join(cacheDir(bundleId), 'Info.plist'), serializePlist(values));
}

export function prebuiltFiles(bundleId: string): string[] {
  const directory = cacheDir(bundleId);

  if (!existsSync(directory)) {
    return [];
  }

  return readdirSync(directory).filter((name) => name.endsWith('.png') || name === 'Assets.car');
}

export interface PrebuiltStatus {
  ok: boolean;
  reason?: string;
  fix?: string;
  manifest?: PrebuiltManifest;
}

export function checkPrebuilt(spec: BuildSpec, sdkVersion: string | undefined): PrebuiltStatus {
  const directory = cacheDir(spec.bundleId);
  const manifest = readManifest(spec.bundleId);

  if (manifest === undefined) {
    return {
      ok: false,
      reason: `No prebuilt cache for ${spec.bundleId}`,
      fix: 'Run lipa prebuilt --mac <host> on a machine that can reach a Mac with Xcode.',
    };
  }

  if (spec.assets !== undefined) {
    const current = treeHash(spec.assets);

    if (current !== manifest.assetsHash) {
      return {
        ok: false,
        reason: `${spec.assets} changed since the last prebuilt run`,
        fix: 'Run lipa prebuilt --mac <host> again.',
        manifest,
      };
    }
  }

  for (const name of ['Assets.car', 'Info.plist.json']) {
    if (!existsSync(join(directory, name))) {
      return {
        ok: false,
        reason: `The cache for ${spec.bundleId} is missing ${name}`,
        fix: 'Run lipa prebuilt --mac <host> again.',
        manifest,
      };
    }
  }

  if (sdkVersion !== undefined && manifest.sdkVersion !== sdkVersion) {
    return {
      ok: false,
      reason: `The cache was built with the iOS ${manifest.sdkVersion} SDK, the local one is ${sdkVersion}`,
      fix: 'Run lipa prebuilt --mac <host> again, or rebuild the SDK with lipa sdk build.',
      manifest,
    };
  }

  return { ok: true, manifest };
}

export function staleError(status: PrebuiltStatus): LipaError {
  return new LipaError({
    code: 'prebuilt_stale',
    message: status.reason ?? 'The prebuilt cache is stale',
    fix: status.fix,
  });
}

export function importPrebuilt(
  root: string,
  directory: string,
  sdkVersion: string | undefined,
): PrebuiltResult {
  const spec = readSpec(root);
  const info = readPlist(join(directory, 'Info.plist'));
  const values: { [key: string]: PlistValue } = {};

  for (const key of MAC_KEYS) {
    const value = info[key];

    if (value === undefined) {
      throw new LipaError({
        code: 'prebuilt_stale',
        message: `${directory}/Info.plist has no ${key}`,
        fix: 'Import a directory produced by a Mac archive or by lipa prebuilt.',
      });
    }

    values[key] = value;
  }

  const target = cacheDir(spec.bundleId);
  mkdirSync(target, { recursive: true });

  for (const name of readdirSync(directory)) {
    if (name.endsWith('.png') || name === 'Assets.car') {
      copyFileSync(join(directory, name), join(target, name));
    }
  }

  writePrebuiltInfo(spec.bundleId, values);

  const manifest = {
    bundleId: spec.bundleId,
    assetsHash: spec.assets === undefined ? '' : treeHash(spec.assets),
    xcodeVersion: String(values.DTXcodeBuild),
    sdkVersion: sdkVersion ?? String(values.DTPlatformVersion),
    createdAt: new Date().toISOString(),
    source: `import:${directory}`,
  };
  writeManifest(manifest);

  return {
    bundleId: spec.bundleId,
    assetsHash: manifest.assetsHash,
    xcodeVersion: manifest.xcodeVersion,
    sdkVersion: manifest.sdkVersion,
    files: readdirSync(target),
  };
}

export interface PrebuiltResult {
  bundleId: string;
  assetsHash: string;
  xcodeVersion: string;
  sdkVersion: string;
  files: string[];
}
