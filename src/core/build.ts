import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { LipaError } from '@/core/errors.ts';
import { requireCommand, requirePath, run } from '@/core/exec.ts';
import { inspectIpa } from '@/core/inspect.ts';
import { acquireBuildLock } from '@/core/lock.ts';
import { patchBuildVersion } from '@/core/macho.ts';
import { paths } from '@/core/paths.ts';
import { type PlistValue, readPlist, serializePlist } from '@/core/plist.ts';
import { MAC_KEYS, prebuiltFiles, prebuiltInfo, staleError } from '@/core/prebuilt.ts';
import {
  type BuildValues,
  entitlementsFor,
  type MacSource,
  type PreparedWorkspace,
  prepareWorkspace,
} from '@/core/prepare.ts';
import { readSdk } from '@/core/sdk.ts';
import {
  mergedEntitlements,
  type ProfileInfo,
  profileInfo,
  type SigningKind,
  type SigningStatus,
  signingPaths,
  signingStatus,
  writeEntitlements,
} from '@/core/signing.ts';
import { type BuildSpec, readSpec } from '@/core/spec.ts';
import { swiftToolchain } from '@/core/tools.ts';
import { resolveBuildNumber } from '@/core/version.ts';
import { writeIfChanged } from '@/core/work.ts';

export interface BuildOptions {
  root: string;
  build?: string | undefined;
  version?: string | undefined;
  out?: string | undefined;
  target?: string | undefined;
  clean?: boolean | undefined;
  update?: boolean | undefined;
  mac?: MacSource | undefined;
  stream?: boolean | undefined;
  signing?: SigningKind | undefined;
}

export interface BuildResult {
  ipa: string;
  app: string;
  binary: string;
  bytes: number;
  version: string;
  build: string;
  bundleId: string;
  signing: SigningKind;
  sdk: string;
  symbols: string;
  checks: Array<{ name: string; ok: boolean; detail: string }>;
}

interface RequiredSigning extends SigningStatus {
  cert: string;
  profile: string;
}

async function requireSigning(spec: BuildSpec, kind: SigningKind): Promise<RequiredSigning> {
  const signing = await signingStatus(spec.team, spec.bundleId, kind);

  if (!signing.ok || signing.profile === undefined || signing.cert === undefined) {
    throw new LipaError({
      code: 'signing_invalid',
      message: signing.reason ?? 'Signing is not ready',
      fix: signing.fix,
    });
  }

  return { ...signing, cert: signing.cert, profile: signing.profile };
}

function copyResourceInto(path: string, destination: string): void {
  if (!existsSync(path)) {
    throw new LipaError({ code: 'config_invalid', message: `Missing resource: ${path}` });
  }

  if (!statSync(path).isDirectory()) {
    cpSync(path, join(destination, basename(path)));
    return;
  }

  for (const entry of readdirSync(path, { withFileTypes: true })) {
    cpSync(join(path, entry.name), join(destination, entry.name), { recursive: true });
  }
}

function mergeInfo(appPlist: string, spec: BuildSpec, values: BuildValues): void {
  const info = readPlist(appPlist);
  const prebuilt = prebuiltInfo(spec.bundleId);

  for (const key of MAC_KEYS) {
    const value = prebuilt[key];

    if (value !== undefined) {
      info[key] = value;
    }
  }

  info.CFBundleVersion = values.build;
  info.CFBundleShortVersionString = values.version;

  writeIfChanged(appPlist, serializePlist(info));
}

export function ipaOutput(
  root: string,
  out: string | undefined,
  name: string,
  kind: SigningKind = 'app-store',
): string {
  const suffix = kind === 'development' ? '-development' : '';

  return resolve(root, out ?? join('build', `${name}${suffix}.ipa`));
}

export async function buildIos(options: BuildOptions): Promise<BuildResult> {
  const spec = readSpec(options.root, { target: options.target });
  const lock = acquireBuildLock(join(paths().work, spec.bundleId, 'build.lock'));

  try {
    return await buildPackage(options, spec);
  } finally {
    lock.release();
  }
}

async function buildPackage(options: BuildOptions, spec: BuildSpec): Promise<BuildResult> {
  const sdk = readSdk();
  const kind: SigningKind = options.signing ?? 'app-store';
  const signing = await requireSigning(spec, kind);
  const toolchain = swiftToolchain();
  const objcopy = join(toolchain, 'usr', 'bin', 'llvm-objcopy');
  const rcodesign = Bun.which('rcodesign') ?? join(paths().bin, 'rcodesign');

  requirePath(objcopy, 'llvm-objcopy');
  requirePath(rcodesign, 'rcodesign');
  requireCommand('zip');

  const values: BuildValues = {
    version: options.version ?? spec.marketingVersion,
    build: resolveBuildNumber(options.build, spec, new Date()),
  };
  const profile: ProfileInfo = profileInfo(readFileSync(signing.profile), signing.profile);
  const entitlements: { [key: string]: PlistValue } = mergedEntitlements(
    readPlist(spec.entitlements),
    profile,
  );
  const prepared = await prepareWorkspace({
    spec,
    sdk,
    values,
    entitlements,
    mac: options.mac,
    clean: options.clean,
    update: options.update,
    stream: options.stream,
  });

  if (!prepared.prebuilt.ok) {
    throw staleError(prepared.prebuilt, 'Run lipa build --mac <host> to refresh the cache.');
  }

  const work = join(paths().work, spec.bundleId);
  const app = join(work, `${spec.target}.app`);

  assemble(prepared, app, spec, values, signing.profile);
  patchBinary(app, spec, sdk.version);

  const symbols = join(paths().symbols, spec.bundleId, `${values.version}-${values.build}`);
  const binary = join(app, spec.target);
  mkdirSync(symbols, { recursive: true });
  cpSync(binary, join(symbols, spec.target));

  const stripped = await run([objcopy, '--strip-all', binary]);

  if (stripped.exitCode !== 0) {
    throw new LipaError({ code: 'generic', message: `llvm-objcopy failed: ${stripped.stderr}` });
  }

  chmodSync(binary, 0o755);

  const entitlementsFile = join(work, 'entitlements.plist');
  writeEntitlements(entitlements, entitlementsFile);

  const signed = await run([
    rcodesign,
    'sign',
    '--pem-file',
    signing.cert,
    '--pem-file',
    signingPaths(spec.team, kind).key,
    '--entitlements-xml-file',
    entitlementsFile,
    '--timestamp-url',
    'http://timestamp.apple.com/ts01',
    app,
  ]);

  if (signed.exitCode !== 0) {
    throw new LipaError({
      code: 'signing_invalid',
      message: `rcodesign exited with ${signed.exitCode}: ${signed.stderr.trim()}`,
      fix: 'Check the certificate, the key and the profile with lipa doctor.',
    });
  }

  const ipa = ipaOutput(spec.root, options.out, spec.name, kind);
  packageIpa(app, ipa, work);

  const inspection = inspectIpa(ipa);

  if (!inspection.ok) {
    throw new LipaError({
      code: 'ipa_invalid',
      message: `The IPA has ${inspection.checks.filter((check) => !check.ok).length} failed checks`,
      details: { checks: inspection.checks },
      fix: 'Run lipa inspect <ipa> to see them.',
    });
  }

  return {
    ipa,
    app,
    binary,
    bytes: Bun.file(ipa).size,
    version: values.version,
    build: values.build,
    bundleId: spec.bundleId,
    signing: kind,
    sdk: sdk.version,
    symbols: join(symbols, spec.target),
    checks: inspection.checks,
  };
}

function assemble(
  prepared: PreparedWorkspace,
  app: string,
  spec: BuildSpec,
  values: BuildValues,
  profile: string,
): void {
  rmSync(app, { recursive: true, force: true });
  cpSync(prepared.xtoolApp, app, { recursive: true });
  rmSync(join(app, '_CodeSignature'), { recursive: true, force: true });

  for (const file of prebuiltFiles(spec.bundleId)) {
    cpSync(join(paths().cache, spec.bundleId, file), join(app, file), { recursive: true });
  }

  for (const resource of spec.resources) {
    copyResourceInto(resource, app);
  }

  writeIfChanged(join(app, 'PkgInfo'), 'APPL????');
  cpSync(profile, join(app, 'embedded.mobileprovision'));
  mergeInfo(join(app, 'Info.plist'), spec, values);
}

function patchBinary(app: string, spec: BuildSpec, sdkVersion: string): void {
  const binary = join(app, spec.target);
  const buffer = readFileSync(binary);
  patchBuildVersion(buffer, { sdk: sdkVersion, minimum: spec.minimumIOS }, binary);
  writeFileSync(binary, buffer);
}

function packageIpa(app: string, ipa: string, work: string): void {
  const payloadRoot = join(work, 'ipa');
  rmSync(payloadRoot, { recursive: true, force: true });
  mkdirSync(join(payloadRoot, 'Payload'), { recursive: true });
  cpSync(app, join(payloadRoot, 'Payload', basename(app)), { recursive: true });
  rmSync(ipa, { force: true });
  mkdirSync(join(ipa, '..'), { recursive: true });

  const zipped = Bun.spawnSync(['zip', '-qry', ipa, 'Payload'], { cwd: payloadRoot });

  if (zipped.exitCode !== 0) {
    const detail = zipped.stderr.toString().trim() || zipped.stdout.toString().trim();

    throw new LipaError({
      code: 'generic',
      message: `zip failed with ${zipped.exitCode}: ${detail}`,
    });
  }
}
