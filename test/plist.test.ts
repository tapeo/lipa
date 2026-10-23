import { describe, expect, test } from 'bun:test';

import { type PlistValue, parsePlist, serializePlist } from '@/core/plist.ts';

describe('plist', () => {
  const value = {
    Name: 'Sample & friends <beta>',
    Build: 42,
    Ratio: 1.5,
    Enabled: true,
    Off: false,
    Icons: { Primary: ['AppIcon60x60'] },
    Data: Uint8Array.from([1, 2, 3]),
  };

  test('round-trips a dict', () => {
    const parsed = parsePlist(serializePlist(value));

    expect(parsed).toEqual(value);
  });

  test('reads a plist written by Xcode', () => {
    const source = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIcons</key>
  <dict>
    <key>CFBundlePrimaryIcon</key>
    <dict>
      <key>CFBundleIconFiles</key>
      <array><string>AppIcon60x60</string></array>
    </dict>
  </dict>
  <key>MinimumOSVersion</key><string>18.0</string>
</dict>
</plist>`;

    const parsed = parsePlist(source) as { [key: string]: PlistValue };

    expect(parsed.MinimumOSVersion).toBe('18.0');
  });

  test('rejects a binary plist with a clear error', () => {
    expect(() => parsePlist('bplist00...')).toThrow('binary plist');
  });
});
