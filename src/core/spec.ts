import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

import { LipaError } from '@/core/errors.ts';
import { type PlistValue, readPlist } from '@/core/plist.ts';

export interface PackageDependency {
  name: string;
  product: string;
  url: string | undefined;
  path: string | undefined;
  kind: 'path' | 'from' | 'exact' | 'branch' | 'revision';
  requirement: string | undefined;
}

export interface BuildSpec {
  root: string;
  target: string;
  name: string;
  bundleId: string;
  team: string;
  minimumIOS: string;
  marketingVersion: string;
  swiftVersion: string;
  infoPlist: string;
  entitlements: string;
  assets: string | undefined;
  resources: string[];
  sources: string[];
  packages: PackageDependency[];
  appIcon: string | undefined;
  accentColor: string | undefined;
  deviceFamilies: string[];
  settings: Record<string, string>;
}

type Yaml = { [key: string]: unknown };

function invalid(root: string, message: string, fix?: string): LipaError {
  return new LipaError({
    code: 'config_invalid',
    message: `${join(root, 'project.yml')}: ${message}`,
    fix,
  });
}

function record(value: unknown): Yaml | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }

  return value as Yaml;
}

function text(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'number') {
    return String(value);
  }

  return undefined;
}

function stringMap(value: unknown): Record<string, string> {
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

function readMarketingVersion(root: string, configPath: string | undefined): string | undefined {
  if (configPath === undefined) {
    return undefined;
  }

  const path = isAbsolute(configPath) ? configPath : join(root, configPath);

  if (!existsSync(path)) {
    return undefined;
  }

  const match = readFileSync(path, 'utf8').match(/^\s*MARKETING_VERSION\s*=\s*([^\s;]+)\s*;?\s*$/m);

  return match?.[1];
}

function isIosApplication(target: Yaml): boolean {
  if (target.type !== 'application') {
    return false;
  }

  if (target.platform !== undefined) {
    return target.platform === 'iOS';
  }

  return true;
}

function findTargets(root: string, project: Yaml): Yaml[] {
  const targets = record(project.targets);

  if (targets === undefined) {
    throw invalid(root, 'missing targets');
  }

  const applications = Object.values(targets)
    .map((value) => record(value))
    .filter((value): value is Yaml => value !== undefined)
    .filter(isIosApplication);

  if (applications.length === 0) {
    throw invalid(root, 'no iOS application target');
  }

  return applications;
}

function targetName(project: Yaml, wanted: Yaml): string {
  const targets = record(project.targets) ?? {};

  for (const [name, value] of Object.entries(targets)) {
    if (value === wanted) {
      return name;
    }
  }

  throw new LipaError({ code: 'config_invalid', message: 'Target not found in project.yml' });
}

function parsePackages(root: string, project: Yaml, target: Yaml): PackageDependency[] {
  const packages = record(project.packages) ?? {};
  const targetDependencies = Array.isArray(target.dependencies) ? target.dependencies : [];
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
    const url = text(entry.url);
    const exact = text(entry.exactVersion);
    const from = text(entry.from);
    const branch = text(entry.branch);
    const revision = text(entry.revision);
    const requirement = exact ?? from ?? branch ?? revision;

    dependencies.push({
      name,
      product: text(dependency.product) ?? name,
      url,
      path: path === undefined ? undefined : resolve(root, path),
      kind:
        path !== undefined
          ? 'path'
          : exact !== undefined
            ? 'exact'
            : from !== undefined
              ? 'from'
              : branch !== undefined
                ? 'branch'
                : 'revision',
      requirement,
    });
  }

  return dependencies;
}

interface SourceEntry {
  path: string;
  buildPhase: string | undefined;
}

function parseSources(root: string, target: Yaml): SourceEntry[] {
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

export interface ReadSpecOptions {
  target?: string | undefined;
}

export function readSpec(root: string, options: ReadSpecOptions = {}): BuildSpec {
  const path = join(root, 'project.yml');

  if (!existsSync(path)) {
    throw new LipaError({
      code: 'config_invalid',
      message: `No project.yml in ${root}`,
      fix: 'lipa reads an XcodeGen project.yml. Add one, or run lipa build from the folder that has it.',
    });
  }

  const project = record(Bun.YAML.parse(readFileSync(path, 'utf8')) ?? {});

  if (project === undefined) {
    throw invalid(root, 'the file is not a mapping');
  }

  const projectSettings = stringMap(record(project.settings)?.base);
  const applications = findTargets(root, project);
  const wanted = options.target;

  const target =
    wanted === undefined
      ? applications[0]
      : applications.find((item) => targetName(project, item) === wanted);

  if (target === undefined) {
    throw invalid(root, `no iOS application target named ${wanted}`);
  }

  const name = targetName(project, target);
  const settings = { ...projectSettings, ...stringMap(record(target.settings)?.base) };
  const bundleId =
    settings.PRODUCT_BUNDLE_IDENTIFIER ??
    (() => {
      const prefix = text(record(project.options)?.bundleIdPrefix);

      return prefix === undefined ? undefined : `${prefix}.${name}`;
    })();

  if (bundleId === undefined) {
    throw invalid(root, `target ${name} has no PRODUCT_BUNDLE_IDENTIFIER`);
  }

  if (settings.DEVELOPMENT_TEAM === undefined) {
    throw invalid(root, `target ${name} has no DEVELOPMENT_TEAM`);
  }

  const deployment = record(record(project.options)?.deploymentTarget)?.iOS;
  const minimumIOS = text(deployment);

  if (minimumIOS === undefined) {
    throw invalid(root, 'missing options.deploymentTarget.iOS');
  }

  const configFiles = record(target.configFiles) ?? {};
  const releaseConfig = text(configFiles.Release);
  const marketingVersion = readMarketingVersion(root, releaseConfig);

  if (marketingVersion === undefined) {
    throw invalid(
      root,
      'missing MARKETING_VERSION in the Release config file',
      'Set configFiles.Release in project.yml to an xcconfig with MARKETING_VERSION.',
    );
  }

  const infoPlistPath = settings.INFOPLIST_FILE;

  if (infoPlistPath === undefined) {
    throw invalid(root, `target ${name} has no INFOPLIST_FILE`);
  }

  const entitlementsPath = settings.CODE_SIGN_ENTITLEMENTS;

  if (entitlementsPath === undefined) {
    throw invalid(root, `target ${name} has no CODE_SIGN_ENTITLEMENTS`);
  }

  const sourceEntries = parseSources(root, target);
  const assets = sourceEntries.find((entry) => isAssetCatalog(entry.path))?.path;
  const resources = sourceEntries
    .filter((entry) => entry.buildPhase === 'resources' && !isAssetCatalog(entry.path))
    .map((entry) => entry.path);
  const sources = sourceEntries
    .filter((entry) => entry.buildPhase === undefined && !isAssetCatalog(entry.path))
    .map((entry) => entry.path);

  const infoPlist = resolve(root, infoPlistPath);

  return {
    root,
    target: name,
    name: settings.PRODUCT_NAME ?? name,
    bundleId,
    team: settings.DEVELOPMENT_TEAM,
    minimumIOS,
    marketingVersion,
    swiftVersion: settings.SWIFT_VERSION ?? '5.0',
    infoPlist,
    entitlements: resolve(root, entitlementsPath),
    assets,
    resources,
    sources,
    packages: parsePackages(root, project, target),
    appIcon: settings.ASSETCATALOG_COMPILER_APPICON_NAME,
    accentColor: settings.ASSETCATALOG_COMPILER_GLOBAL_ACCENT_COLOR_NAME,
    deviceFamilies: (settings.TARGETED_DEVICE_FAMILY ?? '1').split(',').map((item) => item.trim()),
    settings,
  };
}

export interface ExpandedPlist {
  [key: string]: PlistValue;
}

export function expandPlist(
  spec: BuildSpec,
  values: { version: string; build: string },
): ExpandedPlist {
  const base = readPlist(spec.infoPlist);
  const settings: Record<string, string> = {
    ...spec.settings,
    EXECUTABLE_NAME: spec.name,
    PRODUCT_NAME: spec.name,
    PRODUCT_BUNDLE_IDENTIFIER: spec.bundleId,
    MARKETING_VERSION: values.version,
    CURRENT_PROJECT_VERSION: values.build,
  };

  const expand = (value: PlistValue): PlistValue => {
    if (typeof value === 'string') {
      return value.replace(/\$\(([A-Za-z0-9_]+)\)/g, (_match, key: string) => {
        const replacement = settings[key];

        if (replacement === undefined) {
          throw new LipaError({
            code: 'config_invalid',
            message: `${spec.infoPlist} uses $(${key}), which lipa does not set`,
            fix: 'Add the setting to project.yml, or replace the placeholder with a literal value.',
          });
        }

        return replacement;
      });
    }

    if (Array.isArray(value)) {
      return value.map(expand);
    }

    if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
      if (value instanceof Uint8Array) {
        return value;
      }

      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, expand(item as PlistValue)]),
      );
    }

    return value;
  };

  return expand(base) as ExpandedPlist;
}
