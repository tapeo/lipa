import { describe, expect, test } from 'bun:test';

import { mergedEntitlements, profileInfo } from '@/core/signing.ts';

const profile = `<?xml version="1.0" encoding="UTF-8"?>
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

describe('profileInfo', () => {
  test('reads the plist inside the CMS envelope', () => {
    const bytes = Buffer.concat([Buffer.from('30 80 06', 'hex'), Buffer.from(profile)]);

    const info = profileInfo(bytes, 'test.mobileprovision');

    expect(info.team).toBe('ABCDE12345');
    expect(info.bundleId).toBe('com.example.sample');
    expect(info.expires.toISOString()).toBe('2027-10-23T09:14:07.000Z');
  });

  test('stops on a file without a plist', () => {
    expect(() => profileInfo(Buffer.from('nope'), 'test.mobileprovision')).toThrow('XML plist');
  });
});

describe('mergedEntitlements', () => {
  test('takes the identity from the profile and forces App Store values', () => {
    const info = profileInfo(Buffer.from(profile), 'test.mobileprovision');
    const value = mergedEntitlements({ 'aps-environment': 'production' }, info);

    expect(value['application-identifier']).toBe('ABCDE12345.com.example.sample');
    expect(value['get-task-allow']).toBe(false);
    expect(value['beta-reports-active']).toBe(true);
    expect(value['keychain-access-groups']).toEqual(['ABCDE12345.*']);
    expect(value['aps-environment']).toBe('production');
  });
});
