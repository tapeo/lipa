import { LipaError } from '@/core/errors.ts';

const MH_MAGIC_64 = 0xfeedfacf;
const LC_BUILD_VERSION = 0x32;
const LC_UUID = 0x1b;
const LC_CODE_SIGNATURE = 0x1d;
const LC_LOAD_DYLIB = 0x0c;
const LC_LOAD_WEAK_DYLIB = 0x80000018;
const HEADER_SIZE = 32;

export interface BuildVersion {
  platform: number;
  minimum: string;
  sdk: string;
}

export interface MachOInfo {
  buildVersion: BuildVersion | undefined;
  uuid: string | undefined;
  dylibs: string[];
  codeSignature: boolean;
}

function formatVersion(value: number): string {
  const major = value >>> 16;
  const minor = (value >>> 8) & 0xff;
  const patch = value & 0xff;

  if (patch === 0) {
    return `${major}.${minor}`;
  }

  return `${major}.${minor}.${patch}`;
}

function parseVersion(text: string): number {
  const parts = text.split('.').map((part) => Number.parseInt(part, 10));

  if (parts.length === 0 || parts.some((part) => Number.isNaN(part))) {
    throw new LipaError({ code: 'usage', message: `Invalid version: ${text}` });
  }

  const [major = 0, minor = 0, patch = 0] = parts;

  return (major << 16) | (minor << 8) | patch;
}

function readString(buffer: Buffer, offset: number, limit: number): string {
  const end = buffer.indexOf(0, offset);
  const stop = end < 0 || end > limit ? limit : end;

  return buffer.toString('utf8', offset, stop);
}

export function parseMachO(buffer: Buffer, source = 'binary'): MachOInfo {
  if (buffer.readUInt32LE(0) !== MH_MAGIC_64) {
    throw new LipaError({
      code: 'ipa_invalid',
      message: `${source} is not a 64-bit little-endian Mach-O`,
      fix: 'Build the app for arm64 iOS, not for the simulator or a host architecture.',
    });
  }

  const commandCount = buffer.readUInt32LE(16);
  let offset = HEADER_SIZE;
  let buildVersion: BuildVersion | undefined;
  let uuid: string | undefined;
  let codeSignature = false;
  const dylibs: string[] = [];

  for (let index = 0; index < commandCount; index += 1) {
    const command = buffer.readUInt32LE(offset);
    const size = buffer.readUInt32LE(offset + 4);

    if (size < 8 || offset + size > buffer.length) {
      throw new LipaError({ code: 'ipa_invalid', message: `${source}: broken load command` });
    }

    if (command === LC_BUILD_VERSION) {
      buildVersion = {
        platform: buffer.readUInt32LE(offset + 8),
        minimum: formatVersion(buffer.readUInt32LE(offset + 12)),
        sdk: formatVersion(buffer.readUInt32LE(offset + 16)),
      };
    }

    if (command === LC_UUID) {
      const hex = buffer
        .subarray(offset + 8, offset + 24)
        .toString('hex')
        .toUpperCase();
      uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }

    if (command === LC_CODE_SIGNATURE) {
      codeSignature = true;
    }

    if (command === LC_LOAD_DYLIB || command === LC_LOAD_WEAK_DYLIB) {
      const nameOffset = buffer.readUInt32LE(offset + 8);
      dylibs.push(readString(buffer, offset + nameOffset, offset + size));
    }

    offset += size;
  }

  return { buildVersion, uuid, dylibs, codeSignature };
}

export function patchBuildVersion(
  buffer: Buffer,
  values: { sdk: string; minimum: string },
  source = 'binary',
): number {
  const commandCount = buffer.readUInt32LE(16);
  let offset = HEADER_SIZE;
  let patched = 0;

  for (let index = 0; index < commandCount; index += 1) {
    const command = buffer.readUInt32LE(offset);
    const size = buffer.readUInt32LE(offset + 4);

    if (command === LC_BUILD_VERSION) {
      buffer.writeUInt32LE(parseVersion(values.minimum), offset + 12);
      buffer.writeUInt32LE(parseVersion(values.sdk), offset + 16);
      patched += 1;
    }

    offset += size;
  }

  if (patched !== 1) {
    throw new LipaError({
      code: 'ipa_invalid',
      message: `${source} has ${patched} LC_BUILD_VERSION commands, expected 1`,
    });
  }

  return patched;
}
