import { readFileSync } from 'node:fs';

import { LipaError } from '@/core/errors.ts';
import { parseMachO } from '@/core/macho.ts';
import { type PlistValue, parsePlist } from '@/core/plist.ts';
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

interface Archive {
  ipa: string;
  buffer: Buffer;
  entries: ZipEntry[];
}

type Info = { [key: string]: PlistValue };

const APP_INFO = /^Payload\/[^/]+\.app\/Info\.plist$/;
const APPEX_INFO = /^Payload\/[^/]+\.app\/PlugIns\/[^/]+\.appex\/Info\.plist$/;

function find(entries: ZipEntry[], suffix: string): ZipEntry | undefined {
  return entries.find((entry) => entry.name.endsWith(suffix));
}

function entryAt(archive: Archive, name: string): ZipEntry | undefined {
  return archive.entries.find((entry) => entry.name === name);
}

function openArchive(ipa: string): Archive {
  const buffer = readFileSync(ipa);

  return { ipa, buffer, entries: readZip(buffer, ipa) };
}

function readInfo(archive: Archive, entry: ZipEntry): Info {
  const value = parsePlist(
    readZipEntry(archive.buffer, entry, archive.ipa).toString('utf8'),
    entry.name,
  );

  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    value instanceof Date
  ) {
    throw new LipaError({ code: 'ipa_invalid', message: `${entry.name} is not a dict` });
  }

  return value as Info;
}

function profileAt(archive: Archive, root: string): ProfileInfo | undefined {
  const entry = entryAt(archive, `${root}embedded.mobileprovision`);

  if (entry === undefined) {
    return undefined;
  }

  return profileInfo(readZipEntry(archive.buffer, entry, archive.ipa), entry.name);
}

function appRoot(archive: Archive): string {
  const entry = archive.entries.find((item) => APP_INFO.test(item.name));

  if (entry === undefined) {
    throw new LipaError({
      code: 'ipa_invalid',
      message: `${archive.ipa} has no Payload/<name>.app/Info.plist`,
    });
  }

  return entry.name.slice(0, -'Info.plist'.length);
}

function mainProfile(archive: Archive): ProfileInfo {
  const profile = profileAt(archive, appRoot(archive));

  if (profile === undefined) {
    throw new LipaError({
      code: 'ipa_invalid',
      message: `${archive.ipa} has no embedded.mobileprovision`,
    });
  }

  return profile;
}

export function ipaProfile(ipa: string): ProfileInfo {
  return mainProfile(openArchive(ipa));
}

export function ipaProfiles(ipa: string): ProfileInfo[] {
  const archive = openArchive(ipa);
  const extensions = archive.entries
    .filter((entry) => APPEX_INFO.test(entry.name))
    .map((entry) => profileAt(archive, entry.name.slice(0, -'Info.plist'.length)))
    .filter((profile): profile is ProfileInfo => profile !== undefined);

  return [mainProfile(archive), ...extensions];
}

function executableOf(info: Info): string {
  if (typeof info.CFBundleExecutable === 'string') {
    return info.CFBundleExecutable;
  }

  return '';
}

function profileMatches(profile: ProfileInfo | undefined, info: Info): boolean {
  if (profile === undefined) {
    return false;
  }

  return profile.bundleId === info.CFBundleIdentifier && profile.expires.getTime() > Date.now();
}

function extensionProblems(archive: Archive, root: string, app: Info): string[] {
  const infoEntry = entryAt(archive, `${root}Info.plist`) as ZipEntry;
  const info = readInfo(archive, infoEntry);
  const executable = entryAt(archive, `${root}${executableOf(info)}`);
  const problems: string[] = [];

  if (executable === undefined) {
    return [`missing ${root}${executableOf(info)}`];
  }

  const macho = parseMachO(readZipEntry(archive.buffer, executable, archive.ipa), executable.name);

  if ((executable.mode & 0o111) === 0) {
    problems.push(`executable mode ${(executable.mode & 0o777).toString(8)}`);
  }

  if (macho.buildVersion === undefined) {
    problems.push('no LC_BUILD_VERSION');
  }

  if (
    !macho.codeSignature ||
    entryAt(archive, `${root}_CodeSignature/CodeResources`) === undefined
  ) {
    problems.push('not signed');
  }

  if (!profileMatches(profileAt(archive, root), info)) {
    problems.push(`no valid profile for ${String(info.CFBundleIdentifier)}`);
  }

  if (info.CFBundleVersion !== app.CFBundleVersion) {
    problems.push(
      `version ${String(info.CFBundleVersion)}, the app has ${String(app.CFBundleVersion)}`,
    );
  }

  return problems;
}

function extensionChecks(archive: Archive, app: Info): Check[] {
  return archive.entries
    .filter((entry) => APPEX_INFO.test(entry.name))
    .map((entry) => {
      const root = entry.name.slice(0, -'Info.plist'.length);
      const name = root.split('/').at(-2) ?? root;
      const problems = extensionProblems(archive, root, app);
      let detail = 'signed, profile and version match the app';

      if (problems.length > 0) {
        detail = problems.join(', ');
      }

      return { name: `extension ${name}`, ok: problems.length === 0, detail };
    });
}

function catalogCheck(archive: Archive): Check {
  const left = archive.entries.filter((entry) => entry.name.endsWith('.xcstrings'));
  let detail = 'none left in the bundle';

  if (left.length > 0) {
    detail = `${left.length} not compiled: ${left.map((entry) => entry.name).join(', ')}`;
  }

  return { name: 'string_catalogs', ok: left.length === 0, detail };
}

function profileCheck(archive: Archive, root: string, info: Info): Check {
  const profile = profileAt(archive, root);

  if (profile === undefined) {
    return { name: 'profile', ok: false, detail: 'missing embedded.mobileprovision' };
  }

  let devices = `${profile.devices.length} devices`;

  if (profile.devices.length === 0) {
    devices = 'no devices';
  }

  return {
    name: 'profile',
    ok: profileMatches(profile, info),
    detail: `${profile.team}.${profile.bundleId}, ${profile.kind}, ${devices}, expires ${profile.expires.toISOString().slice(0, 10)}`,
  };
}

export function inspectIpa(ipa: string): Inspection {
  const archive = openArchive(ipa);
  const { buffer, entries } = archive;
  const root = appRoot(archive);
  const info = readInfo(archive, entryAt(archive, `${root}Info.plist`) as ZipEntry);
  const checks: Check[] = [];
  const executable = executableOf(info);
  const executableEntry = entryAt(archive, `${root}${executable}`);

  if (executableEntry === undefined) {
    checks.push({ name: 'executable', ok: false, detail: `missing ${root}${executable}` });
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
  let keysDetail = 'all present';

  if (missingKeys.length > 0) {
    keysDetail = `missing ${missingKeys.join(', ')}`;
  }

  checks.push({ name: 'xcode_keys', ok: missingKeys.length === 0, detail: keysDetail });

  checks.push({
    name: 'version',
    ok:
      typeof info.CFBundleShortVersionString === 'string' &&
      typeof info.CFBundleVersion === 'string',
    detail: `${String(info.CFBundleShortVersionString)} (${String(info.CFBundleVersion)})`,
  });

  const macho = parseMachO(readZipEntry(buffer, executableEntry, ipa), executable);
  let buildDetail = 'no LC_BUILD_VERSION';

  if (macho.buildVersion !== undefined) {
    buildDetail = `sdk ${macho.buildVersion.sdk}, minos ${macho.buildVersion.minimum}`;
  }

  checks.push({
    name: 'build_version',
    ok: macho.buildVersion !== undefined,
    detail: buildDetail,
  });

  checks.push({
    name: 'signature',
    ok:
      macho.codeSignature && entryAt(archive, `${root}_CodeSignature/CodeResources`) !== undefined,
    detail: 'LC_CODE_SIGNATURE and CodeResources',
  });

  checks.push(profileCheck(archive, root, info));
  checks.push(catalogCheck(archive));
  checks.push(...extensionChecks(archive, info));

  return { ok: checks.every((check) => check.ok), checks };
}
