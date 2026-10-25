import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { LipaError } from '@/core/errors.ts';
import { requireCommand, run } from '@/core/exec.ts';
import { paths } from '@/core/paths.ts';
import { type PlistValue, parsePlist, serializePlist } from '@/core/plist.ts';
import { writeIfChanged } from '@/core/work.ts';

export type SigningKind = 'app-store' | 'development';

export interface ProfileInfo {
  name: string;
  uuid: string;
  team: string;
  bundleId: string;
  kind: SigningKind;
  devices: string[];
  expires: Date;
  entitlements: { [key: string]: PlistValue };
}

function profileKind(
  entitlements: { [key: string]: PlistValue },
  devices: string[],
  source: string,
): SigningKind {
  if (devices.length === 0) {
    return 'app-store';
  }

  if (entitlements['get-task-allow'] !== true) {
    throw signedError(
      `${source} lists devices without get-task-allow: that is an ad hoc profile`,
      'Use a development profile, or upload the build to TestFlight.',
    );
  }

  return 'development';
}

function signedError(message: string, fix?: string): LipaError {
  return new LipaError({ code: 'signing_invalid', message, fix });
}

export function profileInfo(bytes: Buffer, source: string): ProfileInfo {
  const text = bytes.toString('latin1');
  const start = text.indexOf('<?xml');
  const end = text.indexOf('</plist>');

  if (start < 0 || end < 0) {
    throw signedError(`${source} does not contain an XML plist`);
  }

  const value = parsePlist(text.slice(start, end + '</plist>'.length), source);

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw signedError(`${source} has an unexpected root`);
  }

  const profile = value as { [key: string]: PlistValue };
  const entitlements = profile.Entitlements;
  const teams = profile.TeamIdentifier;

  if (typeof entitlements !== 'object' || entitlements === null || Array.isArray(entitlements)) {
    throw signedError(`${source} has no Entitlements`);
  }

  if (!Array.isArray(teams) || typeof teams[0] !== 'string') {
    throw signedError(`${source} has no TeamIdentifier`);
  }

  const applicationId = (entitlements as { [key: string]: PlistValue })['application-identifier'];

  if (typeof applicationId !== 'string') {
    throw signedError(`${source} has no application-identifier`);
  }

  const expires = profile.ExpirationDate;

  if (!(expires instanceof Date)) {
    throw signedError(`${source} has no ExpirationDate`);
  }

  const listed = profile.ProvisionedDevices;
  const devices = Array.isArray(listed)
    ? listed.filter((item): item is string => typeof item === 'string')
    : [];
  const values = entitlements as { [key: string]: PlistValue };

  return {
    name: typeof profile.Name === 'string' ? profile.Name : source,
    uuid: typeof profile.UUID === 'string' ? profile.UUID : '',
    team: teams[0],
    bundleId: applicationId.slice(`${teams[0]}.`.length),
    kind: profileKind(values, devices, source),
    devices,
    expires,
    entitlements: values,
  };
}

export interface SigningPaths {
  directory: string;
  cert: string;
  key: string;
  profiles: string;
}

export function signingPaths(team: string, kind: SigningKind = 'app-store'): SigningPaths {
  const base = join(paths().signing, team);
  const directory = kind === 'development' ? join(base, 'development') : base;

  return {
    directory,
    cert: join(directory, 'cert.pem'),
    key: join(directory, 'key.pem'),
    profiles: join(directory, 'profiles'),
  };
}

export function profilePath(
  team: string,
  bundleId: string,
  kind: SigningKind = 'app-store',
): string {
  return join(signingPaths(team, kind).profiles, `${bundleId}.mobileprovision`);
}

function certificateKind(subject: string): SigningKind | undefined {
  if (subject.includes('Distribution')) {
    return 'app-store';
  }

  if (subject.includes('Developer')) {
    return 'development';
  }

  return undefined;
}

async function certificateSubject(cert: string): Promise<string> {
  const result = await run(['openssl', 'x509', '-in', cert, '-subject', '-noout']);

  if (result.exitCode !== 0) {
    throw signedError(`openssl failed: ${result.stderr.trim()}`);
  }

  return result.stdout.trim();
}

async function publicKeyOf(argv: string[]): Promise<string> {
  const result = await run(['openssl', ...argv]);

  if (result.exitCode !== 0) {
    throw signedError(`openssl failed: ${result.stderr.trim()}`);
  }

  return result.stdout.replace(/\s+/g, '');
}

export interface ImportOptions {
  cert: string;
  key: string;
  profile: string;
  team?: string | undefined;
}

export interface ImportResult {
  team: string;
  bundleId: string;
  kind: SigningKind;
  profile: string;
  cert: string;
  key: string;
  expires: string;
}

export async function importSigning(options: ImportOptions): Promise<ImportResult> {
  requireCommand('openssl');

  for (const path of [options.cert, options.key, options.profile]) {
    if (!existsSync(path)) {
      throw signedError(`Missing ${path}`);
    }
  }

  const profile = profileInfo(readFileSync(options.profile), options.profile);

  if (options.team !== undefined && options.team !== profile.team) {
    throw signedError(`The profile belongs to team ${profile.team}, not ${options.team}`);
  }

  const subject = await certificateSubject(options.cert);
  const certKind = certificateKind(subject);

  if (certKind === undefined) {
    throw signedError(
      `The certificate is neither a development nor a distribution certificate: ${subject}`,
    );
  }

  if (certKind !== profile.kind) {
    throw signedError(
      `The profile is for ${profile.kind}, the certificate is a ${certKind} certificate`,
      'Import the certificate that matches the profile.',
    );
  }

  const certKey = await publicKeyOf(['x509', '-in', options.cert, '-pubkey', '-noout']);
  const privateKey = await publicKeyOf(['pkey', '-in', options.key, '-pubout']);

  if (certKey !== privateKey) {
    throw signedError('The certificate and the key do not match');
  }

  const enddate = await run(['openssl', 'x509', '-in', options.cert, '-enddate', '-noout']);
  const expires = Date.parse(enddate.stdout.trim().replace('notAfter=', ''));

  if (Number.isNaN(expires) || expires < Date.now()) {
    throw signedError('The certificate has expired');
  }

  const target = signingPaths(profile.team, profile.kind);
  mkdirSync(target.profiles, { recursive: true, mode: 0o700 });
  copyFileSync(options.cert, target.cert);
  copyFileSync(options.key, target.key);
  const profileFile = profilePath(profile.team, profile.bundleId, profile.kind);
  copyFileSync(options.profile, profileFile);

  for (const path of [target.cert, target.key, profileFile]) {
    chmodSync(path, 0o600);
  }

  return {
    team: profile.team,
    bundleId: profile.bundleId,
    kind: profile.kind,
    profile: profileFile,
    cert: target.cert,
    key: target.key,
    expires: profile.expires.toISOString(),
  };
}

export interface SigningStatus {
  ok: boolean;
  reason?: string;
  fix?: string;
  team: string;
  kind?: SigningKind;
  cert?: string;
  profile?: string;
  expires?: string;
}

export async function signingStatus(
  team: string,
  bundleId: string,
  kind: SigningKind = 'app-store',
): Promise<SigningStatus> {
  const target = signingPaths(team, kind);

  if (!existsSync(target.cert) || !existsSync(target.key)) {
    const hint =
      kind === 'development'
        ? 'Import a development certificate, its key and a development profile.'
        : 'Import a distribution certificate, its key and an App Store profile.';

    return {
      ok: false,
      team,
      kind,
      reason: `No ${kind} signing identity for team ${team}`,
      fix: `Run lipa signing import --cert <pem> --key <pem> --profile <.mobileprovision>. ${hint}`,
    };
  }

  requireCommand('openssl');
  const certKey = await publicKeyOf(['x509', '-in', target.cert, '-pubkey', '-noout']);
  const privateKey = await publicKeyOf(['pkey', '-in', target.key, '-pubout']);

  if (certKey !== privateKey) {
    return {
      ok: false,
      team,
      kind,
      reason: 'The certificate and the key in the lipa home do not match',
      fix: 'Import the pair again.',
    };
  }

  const enddate = await run(['openssl', 'x509', '-in', target.cert, '-enddate', '-noout']);
  const certificateExpiry = Date.parse(enddate.stdout.trim().replace('notAfter=', ''));

  if (Number.isNaN(certificateExpiry) || certificateExpiry < Date.now()) {
    return {
      ok: false,
      team,
      kind,
      reason: 'The certificate has expired',
      fix: 'Import a new certificate.',
    };
  }

  const file = profilePath(team, bundleId, kind);

  if (!existsSync(file)) {
    return {
      ok: false,
      team,
      kind,
      cert: target.cert,
      reason: `No ${kind} provisioning profile for ${bundleId}`,
      fix: `Run lipa signing import with the ${kind} profile of this bundle id.`,
    };
  }

  const profile = profileInfo(readFileSync(file), file);

  if (profile.team !== team || profile.bundleId !== bundleId) {
    return {
      ok: false,
      team,
      kind,
      profile: file,
      reason: `The profile is for ${profile.team}.${profile.bundleId}`,
      fix: 'Import the profile of this bundle id.',
    };
  }

  if (profile.kind !== kind) {
    return {
      ok: false,
      team,
      kind,
      profile: file,
      reason: `The profile in the ${kind} folder is a ${profile.kind} profile`,
      fix: 'Import a profile of the kind lipa expects in that folder.',
    };
  }

  if (profile.expires.getTime() < Date.now()) {
    return {
      ok: false,
      team,
      kind,
      profile: file,
      reason: 'The provisioning profile has expired',
      fix: 'Import a new profile.',
    };
  }

  return {
    ok: true,
    team,
    kind,
    cert: target.cert,
    profile: file,
    expires: new Date(Math.min(certificateExpiry, profile.expires.getTime())).toISOString(),
  };
}

export function mergedEntitlements(
  project: { [key: string]: PlistValue },
  profile: ProfileInfo,
): { [key: string]: PlistValue } {
  const value: { [key: string]: PlistValue } = { ...project };

  for (const [key, item] of Object.entries(profile.entitlements)) {
    if (key === 'application-identifier' || key === 'com.apple.developer.team-identifier') {
      value[key] = item;
    }
  }

  if (profile.kind === 'development') {
    value['get-task-allow'] = true;
    delete value['beta-reports-active'];

    if (value['aps-environment'] !== undefined) {
      value['aps-environment'] = 'development';
    }
  } else {
    value['get-task-allow'] = false;
    value['beta-reports-active'] = true;
  }

  if (value['keychain-access-groups'] === undefined) {
    value['keychain-access-groups'] = [`${profile.team}.*`];
  }

  return value;
}

export function writeEntitlements(value: { [key: string]: PlistValue }, path: string): void {
  writeIfChanged(path, serializePlist(value));
}

export function signingKind(value: string | undefined): SigningKind | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === 'app-store' || value === 'development') {
    return value;
  }

  throw signedError(
    `Unknown signing kind: ${value}`,
    'Use --signing app-store or --signing development.',
  );
}
