import { resolve } from 'node:path';

import {
  bundleIdOf,
  invalid,
  listOf,
  type PackageDependency,
  parsePackages,
  parseSources,
  record,
  targetSettings,
  text,
  type Yaml,
} from '@/core/project-yml.ts';

export interface ExtensionSpec {
  target: string;
  name: string;
  bundleId: string;
  infoPlist: string;
  entitlements: string | undefined;
  resources: string[];
  sources: string[];
  packages: PackageDependency[];
  swiftVersion: string;
  deviceFamilies: string[];
  settings: Record<string, string>;
}

function embeddedTargets(target: Yaml): string[] {
  const dependencies = listOf(target.dependencies);
  const names: string[] = [];

  for (const value of dependencies) {
    const dependency = record(value);
    const name = text(dependency?.target);

    if (name !== undefined && dependency?.embed !== false) {
      names.push(name);
    }
  }

  return names;
}

function readExtension(
  root: string,
  project: Yaml,
  name: string,
  appBundleId: string,
): ExtensionSpec {
  const target = record(record(project.targets)?.[name]) ?? {};
  const settings = targetSettings(project, target);
  const bundleId = bundleIdOf(project, name, settings);

  if (bundleId === undefined) {
    throw invalid(root, `extension ${name} has no PRODUCT_BUNDLE_IDENTIFIER`);
  }

  if (!bundleId.startsWith(`${appBundleId}.`)) {
    throw invalid(
      root,
      `extension ${name} has bundle id ${bundleId}, outside ${appBundleId}`,
      `Use a bundle id that starts with ${appBundleId}.`,
    );
  }

  const infoPlist = settings.INFOPLIST_FILE;

  if (infoPlist === undefined) {
    throw invalid(root, `extension ${name} has no INFOPLIST_FILE`);
  }

  const files = parseSources(root, target);

  if (files.assets !== undefined) {
    throw invalid(
      root,
      `extension ${name} has an asset catalog, which lipa does not compile for extensions`,
      'Move the assets to the application target.',
    );
  }

  let entitlements: string | undefined;

  if (settings.CODE_SIGN_ENTITLEMENTS !== undefined) {
    entitlements = resolve(root, settings.CODE_SIGN_ENTITLEMENTS);
  }

  return {
    target: name,
    name: settings.PRODUCT_NAME ?? name,
    bundleId,
    infoPlist: resolve(root, infoPlist),
    entitlements,
    resources: files.resources,
    sources: files.sources,
    packages: parsePackages(root, project, target),
    swiftVersion: settings.SWIFT_VERSION ?? '5.0',
    deviceFamilies: (settings.TARGETED_DEVICE_FAMILY ?? '1').split(',').map((item) => item.trim()),
    settings,
  };
}

export function readExtensions(
  root: string,
  project: Yaml,
  application: Yaml,
  appBundleId: string,
): ExtensionSpec[] {
  const targets = record(project.targets) ?? {};

  return embeddedTargets(application)
    .filter((name) => record(targets[name])?.type === 'app-extension')
    .map((name) => readExtension(root, project, name, appBundleId));
}
