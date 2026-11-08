import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

import { LipaError } from '@/core/errors.ts';
import { serializePlist } from '@/core/plist.ts';
import {
  type BinaryDependency,
  type BuildSpec,
  expandPlist,
  type PackageDependency,
} from '@/core/spec.ts';
import { ensureDirectory, ensureSymlink, writeIfChanged } from '@/core/work.ts';

export interface BuildValues {
  version: string;
  build: string;
}

interface PackageTarget {
  target: string;
  sources: string[];
  packages: PackageDependency[];
  binaries?: BinaryDependency[] | undefined;
  swiftVersion: string;
}

function packageTargets(spec: BuildSpec): PackageTarget[] {
  return [spec, ...spec.extensions];
}

function swiftMode(version: string): string {
  if (version.startsWith('6')) {
    return '.v6';
  }

  return '.v5';
}

export function allBinaries(spec: BuildSpec): BinaryDependency[] {
  const seen = new Map<string, BinaryDependency>();

  for (const target of packageTargets(spec)) {
    for (const binary of target.binaries ?? []) {
      if (!seen.has(binary.name)) {
        seen.set(binary.name, binary);
      }
    }
  }

  return [...seen.values()];
}

export function allPackages(spec: BuildSpec): PackageDependency[] {
  const seen = new Map<string, PackageDependency>();

  for (const target of packageTargets(spec)) {
    for (const dependency of target.packages) {
      if (!seen.has(dependency.name)) {
        seen.set(dependency.name, dependency);
      }
    }
  }

  return [...seen.values()];
}

function packageIdentity(dependency: PackageDependency): string {
  if (dependency.url !== undefined) {
    return basename(dependency.url)
      .replace(/\.git$/, '')
      .toLowerCase();
  }

  if (dependency.path !== undefined) {
    return basename(dependency.path).toLowerCase();
  }

  return dependency.name.toLowerCase();
}

function requirementOf(dependency: PackageDependency): string {
  if (dependency.kind === 'exact') {
    return `exact: "${dependency.requirement}"`;
  }

  if (dependency.kind === 'branch') {
    return `branch: "${dependency.requirement}"`;
  }

  if (dependency.kind === 'revision') {
    return `revision: "${dependency.requirement}"`;
  }

  return `from: "${dependency.requirement}"`;
}

function dependencyLine(dependency: PackageDependency): string {
  if (dependency.kind === 'path' && dependency.path !== undefined) {
    return `        .package(path: "${dependency.path}"),`;
  }

  return `        .package(url: "${dependency.url}", ${requirementOf(dependency)}),`;
}

function targetBlock(target: PackageTarget): string {
  const lines = [
    '        .target(',
    `            name: "${target.target}",`,
    '            dependencies: [',
  ];

  for (const binary of target.binaries ?? []) {
    lines.push(`                "${binary.name}",`);
  }

  for (const dependency of target.packages) {
    lines.push(
      `                .product(name: "${dependency.product}", package: "${packageIdentity(dependency)}"),`,
    );
  }

  lines.push(
    '            ],',
    `            path: "Sources/${target.target}",`,
    `            swiftSettings: [.swiftLanguageMode(${swiftMode(target.swiftVersion)})]`,
    '        )',
  );

  return lines.join('\n');
}

function binaryBlock(binary: BinaryDependency): string {
  return [
    '        .binaryTarget(',
    `            name: "${binary.name}",`,
    `            path: "Frameworks/${binary.name}.xcframework"`,
    '        )',
  ].join('\n');
}

export function packageManifest(spec: BuildSpec): string {
  const targets = packageTargets(spec);
  const products = targets.map(
    (target) => `        .library(name: "${target.target}", targets: ["${target.target}"])`,
  );
  const blocks = [...targets.map(targetBlock), ...allBinaries(spec).map(binaryBlock)];

  return [
    '// swift-tools-version: 6.0',
    'import PackageDescription',
    '',
    'let package = Package(',
    `    name: "${spec.target}App",`,
    `    platforms: [.iOS("${spec.minimumIOS}")],`,
    '    products: [',
    products.join(',\n'),
    '    ],',
    '    dependencies: [',
    ...allPackages(spec).map(dependencyLine),
    '    ],',
    '    targets: [',
    blocks.join(',\n'),
    '    ]',
    ')',
    '',
  ].join('\n');
}

function xtoolConfig(spec: BuildSpec): string {
  const lines = ['version: 1', `bundleID: ${spec.bundleId}`];

  if (spec.extensions.length > 0) {
    lines.push(`product: ${spec.target}`);
  }

  lines.push('infoPath: Support/Info.plist', 'skipLSP: true');

  if (spec.extensions.length > 0) {
    lines.push('extensions:');
  }

  for (const extension of spec.extensions) {
    lines.push(
      `  - product: ${extension.target}`,
      `    bundleID: ${extension.bundleId}`,
      `    infoPath: Support/${extension.target}/Info.plist`,
    );
  }

  lines.push('');

  return lines.join('\n');
}

function missingSources(target: string): LipaError {
  return new LipaError({
    code: 'config_invalid',
    message: `project.yml lists no sources for ${target}`,
    fix: 'Add a sources entry without a buildPhase to the target.',
  });
}

function isSingleSource(sources: string[]): boolean {
  const [only] = sources;

  if (sources.length !== 1 || only === undefined) {
    return false;
  }

  if (!existsSync(only)) {
    return true;
  }

  return statSync(only).isDirectory();
}

export function linkSources(directory: string, target: string, sources: string[]): void {
  const link = join(directory, 'Sources', target);
  const [only] = sources;

  if (only === undefined) {
    throw missingSources(target);
  }

  if (isSingleSource(sources)) {
    ensureSymlink(link, only);
    return;
  }

  ensureDirectory(link);
  const names = new Set<string>();

  for (const source of sources) {
    const name = basename(source);

    if (names.has(name)) {
      throw new LipaError({
        code: 'config_invalid',
        message: `${target} lists two sources named ${name}`,
        fix: 'Rename one of them, lipa links every sources entry by its name.',
      });
    }

    names.add(name);
    ensureSymlink(join(link, name), source);
  }

  for (const entry of readdirSync(link)) {
    if (!names.has(entry)) {
      rmSync(join(link, entry), { recursive: true, force: true });
    }
  }
}

export function linkBinaries(directory: string, spec: BuildSpec): void {
  const folder = join(directory, 'Frameworks');
  const names = new Set(allBinaries(spec).map((binary) => `${binary.name}.xcframework`));

  mkdirSync(folder, { recursive: true });

  for (const binary of allBinaries(spec)) {
    ensureSymlink(join(folder, `${binary.name}.xcframework`), binary.path);
  }

  for (const entry of readdirSync(folder)) {
    if (!names.has(entry)) {
      rmSync(join(folder, entry), { recursive: true, force: true });
    }
  }
}

export function writePackage(directory: string, spec: BuildSpec, values: BuildValues): void {
  mkdirSync(join(directory, 'Support'), { recursive: true });
  mkdirSync(join(directory, 'Sources'), { recursive: true });

  for (const target of packageTargets(spec)) {
    linkSources(directory, target.target, target.sources);
  }

  linkBinaries(directory, spec);

  writeIfChanged(join(directory, 'Package.swift'), packageManifest(spec));
  writeIfChanged(join(directory, 'xtool.yml'), xtoolConfig(spec));
  writeIfChanged(
    join(directory, 'Support', 'Info.plist'),
    serializePlist(expandPlist(spec, values)),
  );

  for (const extension of spec.extensions) {
    mkdirSync(join(directory, 'Support', extension.target), { recursive: true });
    writeIfChanged(
      join(directory, 'Support', extension.target, 'Info.plist'),
      serializePlist(expandPlist(extension, values)),
    );
  }
}
