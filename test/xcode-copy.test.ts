import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { XTOOL } from '@/core/tools.ts';
import {
  pullXcode,
  XCODE_SDK_EXCLUDE,
  XCODE_SDK_PATHS,
  xcodeCopyScript,
} from '@/core/xcode-copy.ts';

const home = mkdtempSync(join(tmpdir(), 'lipa-xcode-copy-'));
const originalPath = process.env.PATH ?? '';

afterAll(() => {
  process.env.PATH = originalPath;
  rmSync(home, { recursive: true, force: true });
});

describe('XCODE_SDK_PATHS', () => {
  test('follows the inputs of the pinned xtool', () => {
    expect(XTOOL.version).toBe('1.23.0');
    expect(XCODE_SDK_PATHS).toContain('Contents/Info.plist');
    expect(XCODE_SDK_PATHS).toContain('Contents/version.plist');
    expect(XCODE_SDK_PATHS).toContain(
      'Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/lib/swift',
    );
    expect(XCODE_SDK_PATHS).toContain(
      'Contents/Developer/Platforms/iPhoneOS.platform/Developer/SDKs',
    );
    expect(XCODE_SDK_PATHS).toContain(
      'Contents/Developer/Platforms/iPhoneSimulator.platform/Developer/usr/lib',
    );
    expect(XCODE_SDK_PATHS).toHaveLength(20);
  });

  test('leaves out the prebuilt modules of the toolchain', () => {
    expect(XCODE_SDK_EXCLUDE).toBe(
      'Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/lib/swift/*/prebuilt-modules',
    );
  });
});

describe('xcodeCopyScript', () => {
  const script = xcodeCopyScript('/Applications/Xcode Beta.app');

  test('archives the SDK paths from inside the given Xcode', () => {
    expect(script).toContain("cd '/Applications/Xcode Beta.app'");
    expect(script).toContain("'Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs'");
    expect(script).not.toContain('Xcode.app\n');
  });

  test('compresses and drops the macOS metadata', () => {
    expect(script).toContain('COPYFILE_DISABLE=1 tar -czf - --no-mac-metadata --no-xattrs');
    expect(script).toContain(`--exclude '${XCODE_SDK_EXCLUDE}'`);
  });

  test('does not shadow the zsh path variable', () => {
    expect(script).not.toMatch(/for path\b/);
  });
});

describe('pullXcode', () => {
  test('writes what the Mac prints to the destination', async () => {
    const bin = mkdtempSync(join(home, 'bin-'));
    const ssh = join(bin, 'ssh');
    const argsFile = join(home, 'args.txt');
    const destination = join(home, 'Xcode.tar.gz');

    writeFileSync(ssh, `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsFile}'\nprintf archive\n`);
    chmodSync(ssh, 0o755);
    process.env.PATH = `${bin}:${originalPath}`;

    await pullXcode({ kind: 'ssh', host: 'macbook' }, '/Applications/Xcode.app', destination);

    expect(readFileSync(destination, 'utf8')).toBe('archive');
    expect(readFileSync(argsFile, 'utf8')).toContain("cd '/Applications/Xcode.app'");
  });
});
