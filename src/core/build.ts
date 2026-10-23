import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { LipaError } from '@/core/errors.ts';
import { requireCommand, run } from '@/core/exec.ts';
import { inspectIpa } from '@/core/inspect.ts';
import { patchBuildVersion } from '@/core/macho.ts';
import { paths } from '@/core/paths.ts';
import { readPlist, serializePlist } from '@/core/plist.ts';
import {
  checkPrebuilt,
  MAC_KEYS,
  prebuiltFiles,
  prebuiltInfo,
  staleError,
} from '@/core/prebuilt.ts';
import { readSdk } from '@/core/sdk.ts';
import {
  mergedEntitlements,
  type ProfileInfo,
  profileInfo,
  signingPaths,
  signingStatus,
  writeEntitlements,
} from '@/core/signing.ts';
import { type BuildSpec, expandPlist, readSpec } from '@/core/spec.ts';
import { swiftToolchain } from '@/core/tools.ts';

export interface BuildOptions {
  root: string;
  build: string;
  version?: string | undefined;
  out?: string | undefined;
  target?: string | undefined;
}

export interface BuildResult {
  ipa: string;
  app: string;
  binary: string;
  bytes: number;
  version: string;
  build: string;
  bundleId: string;
  sdk: string;
  symbols: string;
  checks: Array<{ name: string; ok: boolean; detail: string }>;
}

function capability(path: string, what: string): void {
  if (!existsSync(path)) {
    throw new LipaError({
      code: 'capability_missing',
      message: `Missing ${what}: ${path}`,
      fix: 'Run lipa setup, or set LIPA_SWIFT_TOOLCHAIN to an installed Swift toolchain.',
    });
  }
}

function swiftMode(version: string): string {
  return version.startsWith('6') ? '.v6' : '.v5';
}

function packageIdentity(spec: BuildSpec, name: string): string {
  const dependency = spec.packages.find((item) => item.name === name);

  if (dependency?.url !== undefined) {
    return basename(dependency.url)
      .replace(/\.git$/, '')
      .toLowerCase();
  }

  if (dependency?.path !== undefined) {
    return basename(dependency.path).toLowerCase();
  }

  return name.toLowerCase();
}

function packageManifest(spec: BuildSpec): string {
  const lines = [
    '// swift-tools-version: 6.0',
    'import PackageDescription',
    '',
    'let package = Package(',
    `    name: "${spec.target}App",`,
    `    platforms: [.iOS(.v${spec.minimumIOS.split('.')[0]})],`,
    '    products: [',
    `        .library(name: "${spec.target}", targets: ["${spec.target}"])`,
    '    ],',
    '    dependencies: [',
  ];

  for (const dependency of spec.packages) {
    if (dependency.kind === 'path' && dependency.path !== undefined) {
      lines.push(`        .package(path: "${dependency.path}"),`);
      continue;
    }

    const requirement =
      dependency.kind === 'exact'
        ? `exact: "${dependency.requirement}"`
        : dependency.kind === 'branch'
          ? `branch: "${dependency.requirement}"`
          : dependency.kind === 'revision'
            ? `revision: "${dependency.requirement}"`
            : `from: "${dependency.requirement}"`;

    lines.push(`        .package(url: "${dependency.url}", ${requirement}),`);
  }

  lines.push(
    '    ],',
    '    targets: [',
    '        .target(',
    `            name: "${spec.target}",`,
    '            dependencies: [',
  );

  for (const dependency of spec.packages) {
    lines.push(
      `                .product(name: "${dependency.product}", package: "${packageIdentity(spec, dependency.name)}"),`,
    );
  }

  lines.push(
    '            ],',
    `            path: "Sources/${spec.target}",`,
    `            swiftSettings: [.swiftLanguageMode(${swiftMode(spec.swiftVersion)})]`,
    '        )',
    '    ]',
    ')',
    '',
  );

  return lines.join('\n');
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

function mergeInfo(appPlist: string, spec: BuildSpec, options: BuildOptions): void {
  const info = readPlist(appPlist);
  const prebuilt = prebuiltInfo(spec.bundleId);

  for (const key of MAC_KEYS) {
    const value = prebuilt[key];

    if (value !== undefined) {
      info[key] = value;
    }
  }

  info.CFBundleVersion = options.build;
  info.CFBundleShortVersionString = options.version ?? spec.marketingVersion;

  writeFileSync(appPlist, serializePlist(info));
}

export async function buildIos(options: BuildOptions): Promise<BuildResult> {
  const spec = readSpec(options.root, { target: options.target });
  const sdk = readSdk();
  const prebuilt = checkPrebuilt(spec, sdk.version);

  if (!prebuilt.ok) {
    throw staleError(prebuilt);
  }

  const signing = await signingStatus(spec.team, spec.bundleId);

  if (!signing.ok || signing.profile === undefined || signing.cert === undefined) {
    throw new LipaError({
      code: 'signing_invalid',
      message: signing.reason ?? 'Signing is not ready',
      fix: signing.fix,
    });
  }

  const toolchain = swiftToolchain();
  const swift = join(toolchain, 'usr', 'bin', 'swift');
  const objcopy = join(toolchain, 'usr', 'bin', 'llvm-objcopy');
  const xtool = Bun.which('xtool') ?? join(paths().bin, 'xtool');
  const rcodesign = Bun.which('rcodesign') ?? join(paths().bin, 'rcodesign');

  capability(swift, 'the Swift toolchain');
  capability(objcopy, 'llvm-objcopy');
  capability(xtool, 'xtool');
  capability(rcodesign, 'rcodesign');
  requireCommand('zip');

  const work = join(paths().work, spec.bundleId);
  const packageDirectory = join(work, 'package');
  const app = join(work, `${spec.target}.app`);
  const version = options.version ?? spec.marketingVersion;
  const sourceDirectory = spec.sources[0];

  if (sourceDirectory === undefined) {
    throw new LipaError({
      code: 'config_invalid',
      message: `${spec.root}/project.yml lists no sources directory`,
    });
  }

  if (spec.sources.length > 1) {
    throw new LipaError({
      code: 'config_invalid',
      message: 'lipa expects one sources directory per target',
      fix: 'Point the target at a single folder.',
    });
  }

  rmSync(packageDirectory, { recursive: true, force: true });
  mkdirSync(join(packageDirectory, 'Support'), { recursive: true });
  mkdirSync(join(packageDirectory, 'Sources'), { recursive: true });
  symlinkSync(sourceDirectory, join(packageDirectory, 'Sources', spec.target));

  writeFileSync(join(packageDirectory, 'Package.swift'), packageManifest(spec));
  writeFileSync(
    join(packageDirectory, 'xtool.yml'),
    [
      'version: 1',
      `bundleID: ${spec.bundleId}`,
      'infoPath: Support/Info.plist',
      'entitlementsPath: Support/entitlements.plist',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(packageDirectory, 'Support', 'Info.plist'),
    serializePlist(expandPlist(spec, { version, build: options.build })),
  );

  const profileBytes = readFileSync(signing.profile);
  const profile: ProfileInfo = profileInfo(profileBytes, signing.profile);
  writeEntitlements(
    mergedEntitlements(readPlist(spec.entitlements), profile),
    join(packageDirectory, 'Support', 'entitlements.plist'),
  );

  const environment = {
    PATH: `${join(toolchain, 'usr', 'bin')}:${paths().bin}:${process.env.PATH ?? ''}`,
  };

  const compiled = await run([xtool, 'dev', 'build', '--configuration', 'release'], {
    cwd: packageDirectory,
    stdout: 'inherit',
    stderr: 'inherit',
    env: environment,
  });

  if (compiled.exitCode !== 0) {
    throw new LipaError({
      code: 'generic',
      message: `xtool exited with ${compiled.exitCode}`,
    });
  }

  const xtoolApp = join(packageDirectory, 'xtool', `${spec.target}.app`);

  if (!existsSync(xtoolApp)) {
    throw new LipaError({
      code: 'generic',
      message: `xtool did not produce ${xtoolApp}`,
    });
  }

  rmSync(app, { recursive: true, force: true });
  cpSync(xtoolApp, app, { recursive: true });
  rmSync(join(app, '_CodeSignature'), { recursive: true, force: true });

  for (const file of prebuiltFiles(spec.bundleId)) {
    cpSync(join(paths().cache, spec.bundleId, file), join(app, file), { recursive: true });
  }

  for (const resource of spec.resources) {
    copyResourceInto(resource, app);
  }

  writeFileSync(join(app, 'PkgInfo'), 'APPL????');
  cpSync(signing.profile, join(app, 'embedded.mobileprovision'));
  mergeInfo(join(app, 'Info.plist'), spec, { ...options, version });

  const binary = join(app, spec.target);
  const buffer = readFileSync(binary);
  patchBuildVersion(buffer, { sdk: sdk.version, minimum: spec.minimumIOS }, binary);
  writeFileSync(binary, buffer);

  const symbols = join(paths().symbols, spec.bundleId, `${version}-${options.build}`);
  mkdirSync(symbols, { recursive: true });
  cpSync(binary, join(symbols, spec.target));

  const stripped = await run([objcopy, '--strip-all', binary]);

  if (stripped.exitCode !== 0) {
    throw new LipaError({ code: 'generic', message: `llvm-objcopy failed: ${stripped.stderr}` });
  }

  chmodSync(binary, 0o755);

  const entitlements = join(work, 'entitlements.plist');
  writeEntitlements(mergedEntitlements(readPlist(spec.entitlements), profile), entitlements);

  const signed = await run([
    rcodesign,
    'sign',
    '--pem-file',
    signing.cert,
    '--pem-file',
    signingPaths(spec.team).key,
    '--entitlements-xml-file',
    entitlements,
    '--timestamp-url',
    'http://timestamp.apple.com/ts01',
    app,
  ]);

  if (signed.exitCode !== 0) {
    throw new LipaError({
      code: 'signing_invalid',
      message: `rcodesign exited with ${signed.exitCode}: ${signed.stderr.trim()}`,
      fix: 'Check the certificate, the key and the profile with lipa signing status.',
    });
  }

  const ipa = options.out ?? join(spec.root, 'build', `${spec.name}.ipa`);
  const payloadRoot = join(work, 'ipa');
  rmSync(payloadRoot, { recursive: true, force: true });
  mkdirSync(join(payloadRoot, 'Payload'), { recursive: true });
  cpSync(app, join(payloadRoot, 'Payload', basename(app)), { recursive: true });
  rmSync(ipa, { force: true });
  mkdirSync(join(ipa, '..'), { recursive: true });
  const zipped = Bun.spawnSync(['zip', '-qry', ipa, 'Payload'], { cwd: payloadRoot });

  if (zipped.exitCode !== 0) {
    throw new LipaError({ code: 'generic', message: `zip failed: ${zipped.stderr.toString()}` });
  }

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
    version,
    build: options.build,
    bundleId: spec.bundleId,
    sdk: sdk.version,
    symbols: join(symbols, spec.target),
    checks: inspection.checks,
  };
}
