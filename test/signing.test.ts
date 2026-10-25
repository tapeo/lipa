import { describe, expect, test } from 'bun:test';

import { ipaOutput } from '@/core/build.ts';
import { mergedEntitlements, profileInfo, signingKind } from '@/core/signing.ts';

const storeProfile = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>Name</key><string>Sample App Store Linux</string>
  <key>UUID</key><string>00000000-0000-0000-0000-000000000000</string>
  <key>TeamIdentifier</key><array><string>ABCDE12345</string></array>
  <key>ExpirationDate</key><date>2027-10-23T09:14:07Z</date>
  <key>Entitlements</key><dict>
    <key>application-identifier</key><string>ABCDE12345.com.example.sample</string>
    <key>com.apple.developer.team-identifier</key><string>ABCDE12345</string>
    <key>beta-reports-active</key><true/>
  </dict>
</dict></plist>`;

const developmentProfile = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>Name</key><string>Sample Development</string>
  <key>UUID</key><string>00000000-0000-0000-0000-000000000001</string>
  <key>TeamIdentifier</key><array><string>ABCDE12345</string></array>
  <key>ExpirationDate</key><date>2027-10-25T11:27:43Z</date>
  <key>ProvisionedDevices</key><array><string>00008150-0000000000000001</string></array>
  <key>Entitlements</key><dict>
    <key>application-identifier</key><string>ABCDE12345.com.example.sample</string>
    <key>com.apple.developer.team-identifier</key><string>ABCDE12345</string>
    <key>get-task-allow</key><true/>
  </dict>
</dict></plist>`;

const adhocProfile = developmentProfile
  .replace('<key>get-task-allow</key><true/>', '<key>get-task-allow</key><false/>')
  .replace('Sample Development', 'Sample Ad Hoc');

describe('profileInfo', () => {
  test('reads the plist inside the CMS envelope', () => {
    const bytes = Buffer.concat([Buffer.from('30 80 06', 'hex'), Buffer.from(storeProfile)]);

    const info = profileInfo(bytes, 'test.mobileprovision');

    expect(info.team).toBe('ABCDE12345');
    expect(info.bundleId).toBe('com.example.sample');
    expect(info.kind).toBe('app-store');
    expect(info.devices).toEqual([]);
    expect(info.expires.toISOString()).toBe('2027-10-23T09:14:07.000Z');
  });

  test('reads a development profile and its devices', () => {
    const info = profileInfo(Buffer.from(developmentProfile), 'development.mobileprovision');

    expect(info.kind).toBe('development');
    expect(info.devices).toEqual(['00008150-0000000000000001']);
  });

  test('refuses an ad hoc profile', () => {
    expect(() => profileInfo(Buffer.from(adhocProfile), 'adhoc.mobileprovision')).toThrow('ad hoc');
  });

  test('stops on a file without a plist', () => {
    expect(() => profileInfo(Buffer.from('nope'), 'test.mobileprovision')).toThrow('XML plist');
  });
});

describe('mergedEntitlements', () => {
  test('takes the identity from the profile and forces App Store values', () => {
    const info = profileInfo(Buffer.from(storeProfile), 'test.mobileprovision');
    const value = mergedEntitlements({ 'aps-environment': 'production' }, info);

    expect(value['application-identifier']).toBe('ABCDE12345.com.example.sample');
    expect(value['get-task-allow']).toBe(false);
    expect(value['beta-reports-active']).toBe(true);
    expect(value['keychain-access-groups']).toEqual(['ABCDE12345.*']);
    expect(value['aps-environment']).toBe('production');
  });

  test('marks a development build debuggable and leaves the push environment in development', () => {
    const info = profileInfo(Buffer.from(developmentProfile), 'development.mobileprovision');
    const value = mergedEntitlements(
      {
        'aps-environment': 'production',
        'com.apple.developer.icloud-services': ['CloudDocuments'],
      },
      info,
    );

    expect(value['get-task-allow']).toBe(true);
    expect(value['beta-reports-active']).toBeUndefined();
    expect(value['aps-environment']).toBe('development');
    expect(value['com.apple.developer.icloud-services']).toEqual(['CloudDocuments']);
  });
});

describe('ipaOutput', () => {
  test('puts a development IPA next to the App Store one', () => {
    expect(ipaOutput('/app', undefined, 'App', 'development')).toBe(
      '/app/build/App-development.ipa',
    );
    expect(ipaOutput('/app', undefined, 'App')).toBe('/app/build/App.ipa');
    expect(ipaOutput('/app', '/tmp/App.ipa', 'App', 'development')).toBe('/tmp/App.ipa');
  });
});

describe('signingKind', () => {
  test('accepts the two kinds and the absence of a flag', () => {
    expect(signingKind(undefined)).toBeUndefined();
    expect(signingKind('app-store')).toBe('app-store');
    expect(signingKind('development')).toBe('development');
  });

  test('refuses anything else', () => {
    expect(() => signingKind('adhoc')).toThrow('Unknown signing kind');
  });
});
