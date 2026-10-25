import { readFileSync, rmSync, writeFileSync } from 'node:fs';

import { LipaError } from '@/core/errors.ts';
import { parseMachO } from '@/core/macho.ts';
import { readPlist } from '@/core/plist.ts';
import { MAC_KEYS } from '@/core/prebuilt.ts';
import { type ProfileInfo, profileInfo } from '@/core/signing.ts';
import type { ZipEntry } from '@/core/zip.ts';
import { readZip, readZipEntry } from '@/core/zip.ts';

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

export interface Inspection {
  ok: boolean;
  checks: Check[];
}

function find(entries: ZipEntry[], suffix: string): ZipEntry | undefined {
  return entries.find((entry) => entry.name.endsWith(suffix));
}

export function ipaProfile(ipa: string): ProfileInfo {
  const buffer = readFileSync(ipa);
  const entries = readZip(buffer, ipa);
  const entry = entries.find((item) => item.name.endsWith('embedded.mobileprovision'));

  if (entry === undefined) {
    throw new LipaError({
      code: 'ipa_invalid',
      message: `${ipa} has no embedded.mobileprovision`,
    });
  }

  return profileInfo(readZipEntry(buffer, entry, ipa), 'embedded.mobileprovision');
}

export function inspectIpa(ipa: string): Inspection {
  const buffer = readFileSync(ipa);
  const entries = readZip(buffer, ipa);
  const checks: Check[] = [];
  const infoEntry = entries.find(
    (entry) => entry.name.startsWith('Payload/') && entry.name.endsWith('.app/Info.plist'),
  );

  if (infoEntry === undefined) {
    throw new LipaError({
      code: 'ipa_invalid',
      message: `${ipa} has no Payload/<name>.app/Info.plist`,
    });
  }

  const appRoot = infoEntry.name.slice(0, -'Info.plist'.length);
  const temporary = `${ipa}.Info.plist`;
  writeFileSync(temporary, readZipEntry(buffer, infoEntry, ipa));

  let info: { [key: string]: unknown };

  try {
    info = readPlist(temporary);
  } finally {
    rmSync(temporary, { force: true });
  }

  const executable = typeof info.CFBundleExecutable === 'string' ? info.CFBundleExecutable : '';
  const executableEntry = entries.find((entry) => entry.name === `${appRoot}${executable}`);

  if (executableEntry === undefined) {
    checks.push({ name: 'executable', ok: false, detail: `missing ${appRoot}${executable}` });
    return { ok: false, checks };
  }

  checks.push({
    name: 'executable_mode',
    ok: (executableEntry.mode & 0o111) !== 0,
    detail: `mode ${(executableEntry.mode & 0o777).toString(8)}`,
  });

  checks.push({
    name: 'pkg_info',
    ok: find(entries, 'PkgInfo') !== undefined,
    detail: 'APPL????',
  });

  checks.push({
    name: 'assets',
    ok: find(entries, 'Assets.car') !== undefined && info.CFBundleIcons !== undefined,
    detail: 'Assets.car and CFBundleIcons',
  });

  const missingKeys = MAC_KEYS.filter((key) => info[key] === undefined);

  checks.push({
    name: 'xcode_keys',
    ok: missingKeys.length === 0,
    detail: missingKeys.length === 0 ? 'all present' : `missing ${missingKeys.join(', ')}`,
  });

  checks.push({
    name: 'version',
    ok:
      typeof info.CFBundleShortVersionString === 'string' &&
      typeof info.CFBundleVersion === 'string',
    detail: `${String(info.CFBundleShortVersionString)} (${String(info.CFBundleVersion)})`,
  });

  const binary = readZipEntry(buffer, executableEntry, ipa);
  const macho = parseMachO(binary, executable);

  checks.push({
    name: 'build_version',
    ok: macho.buildVersion !== undefined,
    detail:
      macho.buildVersion === undefined
        ? 'no LC_BUILD_VERSION'
        : `sdk ${macho.buildVersion.sdk}, minos ${macho.buildVersion.minimum}`,
  });

  checks.push({
    name: 'signature',
    ok: macho.codeSignature && find(entries, '_CodeSignature/CodeResources') !== undefined,
    detail: 'LC_CODE_SIGNATURE and CodeResources',
  });

  const profileEntry = find(entries, 'embedded.mobileprovision');

  if (profileEntry === undefined) {
    checks.push({ name: 'profile', ok: false, detail: 'missing embedded.mobileprovision' });
  } else {
    const profile = profileInfo(
      readZipEntry(buffer, profileEntry, ipa),
      'embedded.mobileprovision',
    );
    const expected = `${profile.team}.${profile.bundleId}`;
    const actual = typeof info.CFBundleIdentifier === 'string' ? info.CFBundleIdentifier : '';

    const devices =
      profile.devices.length === 0 ? 'no devices' : `${profile.devices.length} devices`;

    checks.push({
      name: 'profile',
      ok: profile.bundleId === actual && profile.expires.getTime() > Date.now(),
      detail: `${expected}, ${profile.kind}, ${devices}, expires ${profile.expires.toISOString().slice(0, 10)}`,
    });
  }

  return { ok: checks.every((check) => check.ok), checks };
}
