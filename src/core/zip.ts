import { inflateRawSync } from 'node:zlib';

import { LipaError } from '@/core/errors.ts';

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_DIRECTORY_ENTRY = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;

export interface ZipEntry {
  name: string;
  mode: number;
  method: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

export function readZip(buffer: Buffer, source = 'archive'): ZipEntry[] {
  let end = -1;

  for (
    let offset = buffer.length - 22;
    offset >= 0 && offset > buffer.length - 65_557;
    offset -= 1
  ) {
    if (buffer.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY) {
      end = offset;
      break;
    }
  }

  if (end < 0) {
    throw new LipaError({ code: 'ipa_invalid', message: `${source} is not a zip archive` });
  }

  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  const entries: ZipEntry[] = [];

  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(offset) !== CENTRAL_DIRECTORY_ENTRY) {
      throw new LipaError({ code: 'ipa_invalid', message: `${source}: broken central directory` });
    }

    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const external = buffer.readUInt32LE(offset + 38);

    entries.push({
      name: buffer.toString('utf8', offset + 46, offset + 46 + nameLength),
      mode: (external >>> 16) & 0xffff,
      method: buffer.readUInt16LE(offset + 10),
      compressedSize: buffer.readUInt32LE(offset + 20),
      size: buffer.readUInt32LE(offset + 24),
      localOffset: buffer.readUInt32LE(offset + 42),
    });

    offset += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

export function readZipEntry(buffer: Buffer, entry: ZipEntry, source = 'archive'): Buffer {
  if (buffer.readUInt32LE(entry.localOffset) !== LOCAL_FILE_HEADER) {
    throw new LipaError({ code: 'ipa_invalid', message: `${source}: broken local header` });
  }

  const nameLength = buffer.readUInt16LE(entry.localOffset + 26);
  const extraLength = buffer.readUInt16LE(entry.localOffset + 28);
  const start = entry.localOffset + 30 + nameLength + extraLength;
  const data = buffer.subarray(start, start + entry.compressedSize);

  if (entry.method === 0) {
    return Buffer.from(data);
  }

  if (entry.method === 8) {
    return inflateRawSync(data);
  }

  throw new LipaError({
    code: 'ipa_invalid',
    message: `${source}: unsupported compression method ${entry.method} for ${entry.name}`,
  });
}
