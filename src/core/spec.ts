import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { LipaError } from '@/core/errors.ts';
import { type ExtensionSpec, readExtensions } from '@/core/extensions.ts';
import { type PlistValue, readPlist } from '@/core/plist.ts';
import {
  bundleIdOf,
  invalid,
  type PackageDependency,
  parsePackages,
  parseSources,
  readConfigValue,
  record,
  targetSettings,
  text,
  type Yaml,
} from '@/core/project-yml.ts';

export type { PackageDependency } from '@/core/project-yml.ts';

export interface BuildSpec {
  root: string;
  target: string;
  name: string;
  bundleId: string;
  team: string;
  minimumIOS: string;
  marketingVersion: string;
  currentProjectVersion: string | undefined;
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
  extensions: ExtensionSpec[];
}

export type PlistTarget = Pick<
  BuildSpec,
  'target' | 'name' | 'bundleId' | 'infoPlist' | 'settings'
>;

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

function readProject(root: string): Yaml {
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

  return project;
}

function selectTarget(root: string, project: Yaml, wanted: string | undefined): Yaml {
  const applications = findTargets(root, project);
  let target = applications[0];

  if (wanted !== undefined) {
    target = applications.find((item) => targetName(project, item) === wanted);
  }

  if (target === undefined) {
    throw invalid(root, `no iOS application target named ${wanted}`);
  }

  return target;
}

function requiredSetting(
  root: string,
  name: string,
  settings: Record<string, string>,
  key: string,
): string {
  const value = settings[key];

  if (value === undefined) {
    throw invalid(root, `target ${name} has no ${key}`);
  }

  return value;
}

export interface ReadSpecOptions {
  target?: string | undefined;
}

export function readSpec(root: string, options: ReadSpecOptions = {}): BuildSpec {
  const project = readProject(root);
  const target = selectTarget(root, project, options.target);
  const name = targetName(project, target);
  const settings = targetSettings(project, target);
  const bundleId = bundleIdOf(project, name, settings);

  if (bundleId === undefined) {
    throw invalid(root, `target ${name} has no PRODUCT_BUNDLE_IDENTIFIER`);
  }

  const team = requiredSetting(root, name, settings, 'DEVELOPMENT_TEAM');
  const minimumIOS = text(record(record(project.options)?.deploymentTarget)?.iOS);

  if (minimumIOS === undefined) {
    throw invalid(root, 'missing options.deploymentTarget.iOS');
  }

  const releaseConfig = text(record(target.configFiles)?.Release);
  const marketingVersion = readConfigValue(root, releaseConfig, 'MARKETING_VERSION');

  if (marketingVersion === undefined) {
    throw invalid(
      root,
      'missing MARKETING_VERSION in the Release config file',
      'Set configFiles.Release in project.yml to an xcconfig with MARKETING_VERSION.',
    );
  }

  const infoPlist = requiredSetting(root, name, settings, 'INFOPLIST_FILE');
  const entitlements = requiredSetting(root, name, settings, 'CODE_SIGN_ENTITLEMENTS');
  const files = parseSources(root, target);

  return {
    root,
    target: name,
    name: settings.PRODUCT_NAME ?? name,
    bundleId,
    team,
    minimumIOS,
    marketingVersion,
    currentProjectVersion:
      settings.CURRENT_PROJECT_VERSION ??
      readConfigValue(root, releaseConfig, 'CURRENT_PROJECT_VERSION'),
    swiftVersion: settings.SWIFT_VERSION ?? '5.0',
    infoPlist: resolve(root, infoPlist),
    entitlements: resolve(root, entitlements),
    assets: files.assets,
    resources: files.resources,
    sources: files.sources,
    packages: parsePackages(root, project, target),
    appIcon: settings.ASSETCATALOG_COMPILER_APPICON_NAME,
    accentColor: settings.ASSETCATALOG_COMPILER_GLOBAL_ACCENT_COLOR_NAME,
    deviceFamilies: (settings.TARGETED_DEVICE_FAMILY ?? '1').split(',').map((item) => item.trim()),
    settings,
    extensions: readExtensions(root, project, target, bundleId),
  };
}

export interface ExpandedPlist {
  [key: string]: PlistValue;
}

function expandValue(value: PlistValue, replace: (text: string) => string): PlistValue {
  if (typeof value === 'string') {
    return replace(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => expandValue(item, replace));
  }

  if (value === null || typeof value !== 'object' || value instanceof Date) {
    return value;
  }

  if (value instanceof Uint8Array) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, expandValue(item as PlistValue, replace)]),
  );
}

export function expandPlist(
  spec: PlistTarget,
  values: { version: string; build: string },
): ExpandedPlist {
  const settings: Record<string, string> = {
    ...spec.settings,
    EXECUTABLE_NAME: spec.target,
    PRODUCT_NAME: spec.name,
    PRODUCT_MODULE_NAME: spec.target,
    PRODUCT_BUNDLE_IDENTIFIER: spec.bundleId,
    MARKETING_VERSION: values.version,
    CURRENT_PROJECT_VERSION: values.build,
  };

  const replace = (text: string): string =>
    text.replace(/\$\(([A-Za-z0-9_]+)\)/g, (_match, key: string) => {
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

  return expandValue(readPlist(spec.infoPlist), replace) as ExpandedPlist;
}
