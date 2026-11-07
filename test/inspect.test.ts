import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { inspectIpa, ipaProfile, ipaProfiles } from '@/core/inspect.ts';
import { serializePlist } from '@/core/plist.ts';
import { MAC_KEYS } from '@/core/prebuilt.ts';

const work = mkdtempSync(join(tmpdir(), 'lipa-ipa-'));
const app = join(work, 'Payload', 'Sample.app');

function macho(): Buffer {
  const buffer = Buffer.alloc(32 + 24 + 16);
  buffer.writeUInt32LE(0xfeedfacf, 0);
  buffer.writeUInt32LE(0x0100000c, 4);
  buffer.writeUInt32LE(2, 16);
  buffer.writeUInt32LE(0x32, 32);
  buffer.writeUInt32LE(24, 36);
  buffer.writeUInt32LE(2, 40);
  buffer.writeUInt32LE((18 << 16) | (0 << 8), 44);
  buffer.writeUInt32LE((27 << 16) | (0 << 8), 48);
  buffer.writeUInt32LE(0x1d, 56);
  buffer.writeUInt32LE(16, 60);

  return buffer;
}

function profile(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>Name</key><string>Sample App Store</string>
  <key>UUID</key><string>00000000-0000-0000-0000-000000000000</string>
  <key>TeamIdentifier</key><array><string>ABCDE12345</string></array>
  <key>ExpirationDate</key><date>2030-01-01T00:00:00Z</date>
  <key>Entitlements</key><dict>
    <key>application-identifier</key><string>ABCDE12345.com.example.sample</string>
  </dict>
</dict></plist>`;
}

function makeIpa(mode: number, contents = profile()): string {
  rmSync(join(work, 'Payload'), { recursive: true, force: true });
  mkdirSync(join(app, '_CodeSignature'), { recursive: true });
  const keys = Object.fromEntries(MAC_KEYS.map((key) => [key, 'x']));

  writeFileSync(
    join(app, 'Info.plist'),
    serializePlist({
      ...keys,
      CFBundleIdentifier: 'com.example.sample',
      CFBundleExecutable: 'Sample',
      CFBundleShortVersionString: '1.0.0',
      CFBundleVersion: '1',
    }),
  );
  writeFileSync(join(app, 'Sample'), macho());
  chmodSync(join(app, 'Sample'), mode);
  writeFileSync(join(app, 'Assets.car'), 'car');
  writeFileSync(join(app, 'PkgInfo'), 'APPL????');
  writeFileSync(join(app, 'embedded.mobileprovision'), contents);
  writeFileSync(join(app, '_CodeSignature', 'CodeResources'), 'plist');

  const ipa = join(work, `Sample-${mode}-${contents.length}.ipa`);
  Bun.spawnSync(['zip', '-qry', ipa, 'Payload'], { cwd: work });

  return ipa;
}

afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

describe('inspectIpa', () => {
  test('catches a main executable without the execute bit', () => {
    const result = inspectIpa(makeIpa(0o644));
    const check = result.checks.find((item) => item.name === 'executable_mode');

    expect(result.ok).toBe(false);
    expect(check?.ok).toBe(false);
  });

  test('passes a complete IPA', () => {
    const result = inspectIpa(makeIpa(0o755));

    expect(result.checks.find((item) => item.name === 'build_version')?.detail).toContain(
      'sdk 27.0',
    );
    expect(result.ok).toBe(true);
  });
});

function rezip(name: string): string {
  const ipa = join(work, `${name}.ipa`);
  rmSync(ipa, { force: true });
  Bun.spawnSync(['zip', '-qry', ipa, 'Payload'], { cwd: work });

  return ipa;
}

function addExtension(version: string, contents = profile()): void {
  const appex = join(app, 'PlugIns', 'Share.appex');
  mkdirSync(join(appex, '_CodeSignature'), { recursive: true });
  writeFileSync(
    join(appex, 'Info.plist'),
    serializePlist({
      CFBundleIdentifier: 'com.example.sample.share',
      CFBundleExecutable: 'Share',
      CFBundleVersion: version,
    }),
  );
  writeFileSync(join(appex, 'Share'), macho());
  chmodSync(join(appex, 'Share'), 0o755);
  writeFileSync(join(appex, '_CodeSignature', 'CodeResources'), 'plist');
  writeFileSync(
    join(appex, 'embedded.mobileprovision'),
    contents.replace('com.example.sample<', 'com.example.sample.share<'),
  );
}

describe('inspectIpa on extensions and string catalogs', () => {
  test('passes an extension signed with its own profile and the app version', () => {
    makeIpa(0o755);
    addExtension('1');
    const result = inspectIpa(rezip('extension-ok'));
    const check = result.checks.find((item) => item.name === 'extension Share.appex');

    expect(check?.ok).toBe(true);
    expect(result.ok).toBe(true);
  });

  test('catches an extension whose build number differs from the app', () => {
    makeIpa(0o755);
    addExtension('2');
    const check = inspectIpa(rezip('extension-version')).checks.find(
      (item) => item.name === 'extension Share.appex',
    );

    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain('version 2');
  });

  test('reads the profile of the app, not the one of an extension', () => {
    makeIpa(0o755);
    addExtension('1');
    const ipa = rezip('extension-profile');

    expect(ipaProfile(ipa).bundleId).toBe('com.example.sample');
    expect(ipaProfiles(ipa).map((item) => item.bundleId)).toEqual([
      'com.example.sample',
      'com.example.sample.share',
    ]);
  });

  test('fails when a string catalog is left in the bundle', () => {
    makeIpa(0o755);
    writeFileSync(join(app, 'Localizable.xcstrings'), '{}');
    const result = inspectIpa(rezip('catalog'));

    expect(result.checks.find((item) => item.name === 'string_catalogs')?.ok).toBe(false);
    expect(result.ok).toBe(false);
  });
});

describe('ipaProfile', () => {
  const development = profile()
    .replace(
      '<key>ExpirationDate</key>',
      '<key>ProvisionedDevices</key><array><string>00008150-0000000000000001</string></array><key>ExpirationDate</key>',
    )
    .replace(
      '<key>application-identifier</key><string>ABCDE12345.com.example.sample</string>',
      '<key>application-identifier</key><string>ABCDE12345.com.example.sample</string><key>get-task-allow</key><true/>',
    )
    .replace('Sample App Store', 'Sample Development');

  test('reports the kind and the devices of the embedded profile', () => {
    const info = ipaProfile(makeIpa(0o755, development));

    expect(info.kind).toBe('development');
    expect(info.devices).toEqual(['00008150-0000000000000001']);
  });

  test('reports an App Store profile as such', () => {
    expect(ipaProfile(makeIpa(0o755)).kind).toBe('app-store');
  });
});
