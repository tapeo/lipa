import { cpSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { LipaError } from '@/core/errors.ts';
import type { ExtensionSpec } from '@/core/extensions.ts';
import type { BuildValues } from '@/core/package.ts';
import { type PlistValue, readPlist, serializePlist } from '@/core/plist.ts';
import { MAC_KEYS } from '@/core/prebuilt.ts';
import {
  mergedEntitlements,
  profileInfo,
  type SigningKind,
  type SigningStatus,
  signingStatus,
  writeEntitlements,
} from '@/core/signing.ts';
import { writeIfChanged } from '@/core/work.ts';

const APP_ONLY_KEYS: readonly string[] = [
  'CFBundleIcons',
  'CFBundleIcons~ipad',
  'NSAccentColorName',
];

export interface RequiredSigning extends SigningStatus {
  cert: string;
  profile: string;
}

export interface SignedExtension {
  spec: ExtensionSpec;
  profile: string;
  bundle: string;
  entitlements: { [key: string]: PlistValue };
}

export async function requireSigning(
  team: string,
  bundleId: string,
  kind: SigningKind,
): Promise<RequiredSigning> {
  const signing = await signingStatus(team, bundleId, kind);

  if (!signing.ok || signing.profile === undefined || signing.cert === undefined) {
    throw new LipaError({
      code: 'signing_invalid',
      message: signing.reason ?? 'Signing is not ready',
      fix: signing.fix,
    });
  }

  return { ...signing, cert: signing.cert, profile: signing.profile };
}

function projectEntitlements(extension: ExtensionSpec): { [key: string]: PlistValue } {
  if (extension.entitlements === undefined) {
    return {};
  }

  return readPlist(extension.entitlements);
}

export async function signedExtensions(
  team: string,
  extensions: ExtensionSpec[],
  kind: SigningKind,
): Promise<SignedExtension[]> {
  const signed: SignedExtension[] = [];

  for (const extension of extensions) {
    const signing = await requireSigning(team, extension.bundleId, kind);
    const profile = profileInfo(readFileSync(signing.profile), signing.profile);

    signed.push({
      spec: extension,
      profile: signing.profile,
      bundle: join('PlugIns', `${extension.target}.appex`),
      entitlements: mergedEntitlements(projectEntitlements(extension), profile),
    });
  }

  return signed;
}

function mergeExtensionInfo(
  path: string,
  extension: ExtensionSpec,
  values: BuildValues,
  prebuilt: { [key: string]: PlistValue },
): void {
  const info = readPlist(path);

  for (const key of MAC_KEYS) {
    const value = prebuilt[key];

    if (value !== undefined && !APP_ONLY_KEYS.includes(key)) {
      info[key] = value;
    }
  }

  info.CFBundleVersion = values.build;
  info.CFBundleShortVersionString = values.version;
  info.CFBundleSupportedPlatforms = ['iPhoneOS'];
  info.UIDeviceFamily = extension.deviceFamilies.map(Number);

  writeIfChanged(path, serializePlist(info));
}

export function assembleExtensions(
  app: string,
  extensions: SignedExtension[],
  values: BuildValues,
  prebuilt: { [key: string]: PlistValue },
  copyResource: (path: string, destination: string) => void,
): void {
  for (const extension of extensions) {
    const bundle = join(app, extension.bundle);

    if (!existsSync(join(bundle, extension.spec.target))) {
      throw new LipaError({
        code: 'generic',
        message: `xtool did not produce ${join(bundle, extension.spec.target)}`,
      });
    }

    rmSync(join(bundle, '_CodeSignature'), { recursive: true, force: true });

    for (const resource of extension.spec.resources) {
      copyResource(resource, bundle);
    }

    cpSync(extension.profile, join(bundle, 'embedded.mobileprovision'));
    mergeExtensionInfo(join(bundle, 'Info.plist'), extension.spec, values, prebuilt);
  }
}

export function extensionBinaries(app: string, extensions: SignedExtension[]): string[] {
  return extensions.map((extension) => join(app, extension.bundle, extension.spec.target));
}

export function extensionSigningArguments(work: string, extensions: SignedExtension[]): string[] {
  const argv: string[] = [];

  for (const extension of extensions) {
    const file = join(work, `entitlements-${extension.spec.target}.plist`);
    writeEntitlements(extension.entitlements, file);
    argv.push('--entitlements-xml-file', `${extension.bundle}:${file}`);
  }

  return argv;
}
