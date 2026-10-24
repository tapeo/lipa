import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LipaError } from '@/core/errors.ts';
import {
  assetNameFor,
  isNewer,
  parseChecksums,
  parseSemver,
  parseVersion,
  replaceBinary,
} from '@/core/release.ts';

describe('versions', () => {
  test('reads the tag without its v', () => {
    expect(parseVersion('v0.2.1')).toBe('0.2.1');
    expect(parseVersion('0.2.1')).toBe('0.2.1');
  });

  test('orders releases', () => {
    expect(isNewer('0.2.1', '0.2.0')).toBe(true);
    expect(isNewer('0.3.0', '0.2.9')).toBe(true);
    expect(isNewer('1.0.0', '0.99.99')).toBe(true);
    expect(isNewer('0.2.0', '0.2.0')).toBe(false);
    expect(isNewer('0.1.9', '0.2.0')).toBe(false);
  });

  test('a build of the source tree is older than any release', () => {
    expect(isNewer('0.2.1', 'dev')).toBe(true);
    expect(isNewer('dev', '0.2.1')).toBe(false);
    expect(isNewer('dev', 'dev')).toBe(false);
  });

  test('a release comes after its prereleases', () => {
    expect(isNewer('1.0.0', '1.0.0-rc1')).toBe(true);
    expect(isNewer('1.0.0-rc1', '1.0.0')).toBe(false);
    expect(isNewer('1.0.0-rc2', '1.0.0-rc1')).toBe(true);
  });

  test('parts that are not numbers count as zero', () => {
    expect(parseSemver('dev')).toEqual({ numbers: [0, 0, 0], prerelease: undefined });
    expect(parseSemver('0.2.1-rc1')).toEqual({ numbers: [0, 2, 1], prerelease: 'rc1' });
  });
});

describe('assets', () => {
  test('names the asset of both Linux architectures', () => {
    expect(assetNameFor('linux', 'x64')).toBe('lipa-linux-x64');
    expect(assetNameFor('linux', 'arm64')).toBe('lipa-linux-arm64');
  });

  test('refuses a platform lipa does not publish', () => {
    expect(() => assetNameFor('darwin', 'arm64')).toThrow(LipaError);
  });

  test('refuses an architecture lipa does not publish', () => {
    expect(() => assetNameFor('linux', 'ia32')).toThrow(LipaError);
  });
});

describe('checksums', () => {
  test('reads the sha256sum format of the release', () => {
    const text = ['aaaa  lipa-linux-x64', 'bbbb *lipa-linux-arm64', '', 'cccc  install.sh'].join(
      '\n',
    );

    expect([...parseChecksums(text)]).toEqual([
      ['lipa-linux-x64', 'aaaa'],
      ['lipa-linux-arm64', 'bbbb'],
      ['install.sh', 'cccc'],
    ]);
  });
});

describe('replacing the binary', () => {
  test('puts the new binary in place and removes the backup', () => {
    const root = mkdtempSync(join(tmpdir(), 'lipa-replace-'));
    const current = join(root, 'lipa');
    const downloaded = join(root, 'lipa.new');
    writeFileSync(current, 'old');
    writeFileSync(downloaded, 'new');

    replaceBinary(current, downloaded);

    expect(readFileSync(current, 'utf8')).toBe('new');
    expect(() => readFileSync(`${current}.old`, 'utf8')).toThrow();
  });

  test('keeps the one it replaces when the new one is gone', () => {
    const root = mkdtempSync(join(tmpdir(), 'lipa-replace-'));
    const current = join(root, 'lipa');
    const downloaded = join(root, 'lipa.new');
    writeFileSync(current, 'old');

    expect(() => replaceBinary(current, downloaded)).toThrow();
    expect(readFileSync(current, 'utf8')).toBe('old');
  });
});
