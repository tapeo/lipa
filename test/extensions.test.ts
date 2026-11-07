import { afterAll, describe, expect, test } from 'bun:test';
import {
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LipaError } from '@/core/errors.ts';
import { linkSources, packageManifest, writePackage } from '@/core/package.ts';
import { readPlist } from '@/core/plist.ts';
import { buildConfiguration } from '@/core/prepare.ts';
import { readSpec } from '@/core/spec.ts';

const fixtures = join(import.meta.dir, '..', 'fixtures');
const root = mkdtempSync(join(tmpdir(), 'lipa-extension-'));
const scratch = mkdtempSync(join(tmpdir(), 'lipa-extension-package-'));

const EXTENSION_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>$(EXECUTABLE_NAME)</string>
  <key>CFBundleIdentifier</key><string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>
  <key>CFBundleVersion</key><string>$(CURRENT_PROJECT_VERSION)</string>
  <key>NSExtension</key><dict>
    <key>NSExtensionPointIdentifier</key><string>com.apple.share-services</string>
    <key>NSExtensionPrincipalClass</key><string>$(PRODUCT_MODULE_NAME).ShareViewController</string>
  </dict>
</dict></plist>`;

const EXTENSION_TARGETS = `
  SampleShare:
    type: app-extension
    platform: iOS
    sources:
      - path: Sources/SampleShare
      - path: Sources/Sample/Shared.swift
      - path: Resources/Localizable.xcstrings
        buildPhase: resources
    dependencies:
      - package: SampleCore
        product: SampleCore
    settings:
      base:
        PRODUCT_BUNDLE_IDENTIFIER: com.example.sample.share
        INFOPLIST_FILE: Support/SampleShare/Info.plist
        CODE_SIGN_ENTITLEMENTS: Support/SampleShare/SampleShare.entitlements
  SampleWidget:
    type: app-extension
    platform: iOS
    sources:
      - path: Sources/SampleWidget
    settings:
      base:
        PRODUCT_BUNDLE_IDENTIFIER: com.example.sample.widget
        INFOPLIST_FILE: Support/SampleWidget/Info.plist
`;

function writeProject(): void {
  cpSync(fixtures, root, { recursive: true });
  const project = readFileSync(join(fixtures, 'project.yml'), 'utf8')
    .replace(
      '      - package: Algorithms\n        product: Algorithms\n',
      '      - package: Algorithms\n        product: Algorithms\n      - target: SampleShare\n      - target: SampleWidget\n        embed: false\n',
    )
    .replace('\nschemes:', `${EXTENSION_TARGETS}\nschemes:`);

  writeFileSync(join(root, 'project.yml'), project);

  for (const folder of ['Sources/Sample', 'Sources/SampleShare', 'Sources/SampleWidget']) {
    mkdirSync(join(root, folder), { recursive: true });
  }

  writeFileSync(join(root, 'Sources/Sample/Shared.swift'), 'struct Shared {}\n');

  for (const name of ['SampleShare', 'SampleWidget']) {
    mkdirSync(join(root, 'Support', name), { recursive: true });
    writeFileSync(join(root, 'Support', name, 'Info.plist'), EXTENSION_PLIST);
  }
}

writeProject();

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
});

describe('extensions in project.yml', () => {
  const spec = readSpec(root);
  const [share] = spec.extensions;

  test('reads the embedded app extensions of the application', () => {
    expect(spec.extensions.map((item) => item.target)).toEqual(['SampleShare']);
    expect(share?.bundleId).toBe('com.example.sample.share');
    expect(share?.entitlements).toBe(join(root, 'Support/SampleShare/SampleShare.entitlements'));
  });

  test('keeps every sources entry and the resources of the extension', () => {
    expect(share?.sources).toEqual([
      join(root, 'Sources/SampleShare'),
      join(root, 'Sources/Sample/Shared.swift'),
    ]);
    expect(share?.resources).toEqual([join(root, 'Resources/Localizable.xcstrings')]);
    expect(share?.packages.map((item) => item.name)).toEqual(['SampleCore']);
  });

  test('refuses an extension outside the bundle id of the app', () => {
    const project = readFileSync(join(root, 'project.yml'), 'utf8');
    const outside = mkdtempSync(join(tmpdir(), 'lipa-extension-outside-'));
    cpSync(root, outside, { recursive: true });
    writeFileSync(
      join(outside, 'project.yml'),
      project.replace('com.example.sample.share', 'com.other.share'),
    );

    expect(() => readSpec(outside)).toThrow(LipaError);
    rmSync(outside, { recursive: true, force: true });
  });
});

describe('the wrapper package with extensions', () => {
  const spec = readSpec(root);
  const values = { version: '1.0.0', build: '7' };

  test('declares one library per target and each package once', () => {
    const manifest = packageManifest(spec);

    expect(manifest).toContain('.library(name: "SampleShare", targets: ["SampleShare"])');
    expect(manifest).toContain('path: "Sources/SampleShare"');
    expect(manifest.match(/\.package\(path:/g)).toHaveLength(1);
  });

  test('lists the extensions in xtool.yml with their own Info.plist', () => {
    writePackage(scratch, spec, values);
    const config = readFileSync(join(scratch, 'xtool.yml'), 'utf8');
    const info = readPlist(join(scratch, 'Support', 'SampleShare', 'Info.plist'));
    const extension = info.NSExtension as Record<string, string>;

    expect(config).toContain('product: Sample\n');
    expect(config).toContain('  - product: SampleShare\n    bundleID: com.example.sample.share');
    expect(info.CFBundleExecutable).toBe('SampleShare');
    expect(info.CFBundleVersion).toBe('7');
    expect(extension.NSExtensionPrincipalClass).toBe('SampleShare.ShareViewController');
  });

  test('links several sources entries one by one', () => {
    const folder = join(scratch, 'Sources', 'SampleShare');

    expect(lstatSync(folder).isDirectory()).toBe(true);
    expect(readlinkSync(join(folder, 'Shared.swift'))).toBe(
      join(root, 'Sources/Sample/Shared.swift'),
    );
  });

  test('drops a link whose entry left project.yml', () => {
    linkSources(scratch, 'SampleShare', [
      join(root, 'Sources/Sample/Shared.swift'),
      join(root, 'Sources/Sample'),
    ]);
    linkSources(scratch, 'SampleShare', [
      join(root, 'Sources/Sample/Shared.swift'),
      join(root, 'Sources/SampleShare'),
    ]);

    expect(readdirSync(join(scratch, 'Sources', 'SampleShare')).sort()).toEqual([
      'SampleShare',
      'Shared.swift',
    ]);
  });

  test('refuses two entries with the same name', () => {
    expect(() =>
      linkSources(scratch, 'Twice', [join(root, 'Sources/Sample'), join(root, 'Other/Sample')]),
    ).toThrow(LipaError);
  });
});

describe('buildConfiguration', () => {
  test('uses the default of the command when the flag is missing', () => {
    expect(buildConfiguration(undefined, 'debug')).toBe('debug');
    expect(buildConfiguration('release', 'debug')).toBe('release');
  });

  test('refuses an unknown name', () => {
    expect(() => buildConfiguration('profile', 'release')).toThrow(LipaError);
  });
});
