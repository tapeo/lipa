import { describe, expect, test } from 'bun:test';

import { parseMachO, patchBuildVersion } from '@/core/macho.ts';

function version(major: number, minor: number): number {
  return (major << 16) | (minor << 8);
}

function binary(): Buffer {
  const buffer = Buffer.alloc(32 + 24 + 16);
  buffer.writeUInt32LE(0xfeedfacf, 0);
  buffer.writeUInt32LE(0x0100000c, 4);
  buffer.writeUInt32LE(2, 16);
  buffer.writeUInt32LE(0x32, 32);
  buffer.writeUInt32LE(24, 36);
  buffer.writeUInt32LE(2, 40);
  buffer.writeUInt32LE(version(18, 0), 44);
  buffer.writeUInt32LE(version(18, 0), 48);
  buffer.writeUInt32LE(0x1d, 56);
  buffer.writeUInt32LE(16, 60);

  return buffer;
}

describe('macho', () => {
  test('reads the SDK and the minimum version', () => {
    const info = parseMachO(binary());

    expect(info.buildVersion).toEqual({ platform: 2, minimum: '18.0', sdk: '18.0' });
    expect(info.codeSignature).toBe(true);
  });

  test('patches the SDK field App Store Connect rejects', () => {
    const buffer = binary();

    expect(patchBuildVersion(buffer, { sdk: '27.0', minimum: '18.0' })).toBe(1);
    expect(parseMachO(buffer).buildVersion).toEqual({
      platform: 2,
      minimum: '18.0',
      sdk: '27.0',
    });
  });

  test('refuses a Mach-O without LC_BUILD_VERSION', () => {
    const buffer = binary();
    buffer.writeUInt32LE(0x1d, 32);

    expect(() => patchBuildVersion(buffer, { sdk: '27.0', minimum: '18.0' })).toThrow(
      'LC_BUILD_VERSION',
    );
  });
});
