import { existsSync, readFileSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';

import { LipaError } from '@/core/errors.ts';

export type Yaml = { [key: string]: unknown };

export interface BinaryDependency {
  name: string;
  path: string;
}

export interface PackageDependency {
  name: string;
  product: string;
  url: string | undefined;
  path: string | undefined;
  kind: 'path' | 'from' | 'exact' | 'branch' | 'revision';
  requirement: string | undefined;
}

export interface TargetSources {
  assets: string | undefined;
  resources: string[];
  sources: string[];
}

export function listOf(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }

  return [];
}

export function invalid(root: string, message: string, fix?: string): LipaError {
  return new LipaError({
    code: 'config_invalid',
    message: `${join(root, 'project.yml')}: ${message}`,
    fix,
  });
}

export function record(value: unknown): Yaml | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }

  return value as Yaml;
}

export function text(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'number') {
    return String(value);
  }

  return undefined;
}

export function stringMap(value: unknown): Record<string, string> {
  const source = record(value);
  const settings: Record<string, string> = {};

  for (const [key, item] of Object.entries(source ?? {})) {
    const scalar = text(item);

    if (scalar !== undefined) {
      settings[key] = scalar;
    }
  }

  return settings;
}

export function readConfigValue(
  root: string,
  configPath: string | undefined,
  key: string,
): string | undefined {
  if (configPath === undefined) {
    return undefined;
  }

  let path = join(root, configPath);

  if (isAbsolute(configPath)) {
    path = configPath;
  }

  if (!existsSync(path)) {
    return undefined;
  }

  const pattern = new RegExp(`^\\s*${key}\\s*=\\s*([^\\s;]+)\\s*;?\\s*$`, 'm');
  const match = readFileSync(path, 'utf8').match(pattern);

  return match?.[1];
}

export function targetSettings(project: Yaml, target: Yaml): Record<string, string> {
  return {
    ...stringMap(record(project.settings)?.base),
    ...stringMap(record(target.settings)?.base),
  };
}

export function bundleIdOf(
  project: Yaml,
  name: string,
  settings: Record<string, string>,
): string | undefined {
  const explicit = settings.PRODUCT_BUNDLE_IDENTIFIER;

  if (explicit !== undefined) {
    return explicit;
  }

  const prefix = text(record(project.options)?.bundleIdPrefix);

  if (prefix === undefined) {
    return undefined;
  }

  return `${prefix}.${name}`;
}

function dependencyKind(entry: Yaml): PackageDependency['kind'] {
  if (text(entry.path) !== undefined) {
    return 'path';
  }

  if (text(entry.exactVersion) !== undefined) {
    return 'exact';
  }

  if (text(entry.from) !== undefined) {
    return 'from';
  }

  if (text(entry.branch) !== undefined) {
    return 'branch';
  }

  return 'revision';
}

export function parsePackages(root: string, project: Yaml, target: Yaml): PackageDependency[] {
  const packages = record(project.packages) ?? {};
  const targetDependencies = listOf(target.dependencies);
  const dependencies: PackageDependency[] = [];

  for (const value of targetDependencies) {
    const dependency = record(value);
    const name = text(dependency?.package);

    if (dependency === undefined || name === undefined) {
      continue;
    }

    const entry = record(packages[name]);

    if (entry === undefined) {
      throw invalid(root, `dependency on ${name}, which is not in packages`);
    }

    const path = text(entry.path);
    let resolvedPath: string | undefined;

    if (path !== undefined) {
      resolvedPath = resolve(root, path);
    }

    dependencies.push({
      name,
      product: text(dependency.product) ?? name,
      url: text(entry.url),
      path: resolvedPath,
      kind: dependencyKind(entry),
      requirement:
        text(entry.exactVersion) ?? text(entry.from) ?? text(entry.branch) ?? text(entry.revision),
    });
  }

  return dependencies;
}

export function parseBinaries(root: string, target: Yaml): BinaryDependency[] {
  const binaries: BinaryDependency[] = [];

  for (const value of listOf(target.dependencies)) {
    const dependency = record(value);
    const framework = text(dependency?.framework);

    if (framework === undefined || !framework.endsWith('.xcframework')) {
      continue;
    }

    const path = resolve(root, framework);

    if (!existsSync(path)) {
      throw invalid(
        root,
        `dependency on ${framework}, which is not there`,
        'Build the framework first, or remove it from the target dependencies.',
      );
    }

    binaries.push({ name: basename(path, '.xcframework'), path });
  }

  return binaries;
}

interface SourceEntry {
  path: string;
  buildPhase: string | undefined;
}

function sourceEntries(root: string, target: Yaml): SourceEntry[] {
  const value = target.sources;

  if (!Array.isArray(value)) {
    return [{ path: root, buildPhase: undefined }];
  }

  return value.map((item) => {
    if (typeof item === 'string') {
      return { path: resolve(root, item), buildPhase: undefined };
    }

    const entry = record(item) ?? {};
    const path = text(entry.path);

    if (path === undefined) {
      throw invalid(root, 'a sources entry has no path');
    }

    return { path: resolve(root, path), buildPhase: text(entry.buildPhase) };
  });
}

function isAssetCatalog(path: string): boolean {
  return path.endsWith('.xcassets');
}

export function parseSources(root: string, target: Yaml): TargetSources {
  const entries = sourceEntries(root, target);

  return {
    assets: entries.find((entry) => isAssetCatalog(entry.path))?.path,
    resources: entries
      .filter((entry) => entry.buildPhase === 'resources' && !isAssetCatalog(entry.path))
      .map((entry) => entry.path),
    sources: entries
      .filter((entry) => entry.buildPhase === undefined && !isAssetCatalog(entry.path))
      .map((entry) => entry.path),
  };
}
