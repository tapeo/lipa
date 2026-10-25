import { join } from 'node:path';

import { paths } from '@/core/paths.ts';

export interface PinnedTool {
  name: string;
  version: string;
  url: string;
  sha256: string;
  archive: 'tar.gz' | 'binary';
  hashOf: 'archive' | 'binary';
  binary: string;
  extractedTree: string | undefined;
}

const SWIFT_TREE = 'swift-6.4.1-RELEASE-ubuntu24.04';

export const SWIFT: PinnedTool = {
  name: 'swift',
  version: '6.4.1',
  url: `https://download.swift.org/swift-6.4.1-release/ubuntu2404/swift-6.4.1-RELEASE/${SWIFT_TREE}.tar.gz`,
  sha256: '7d246c7114077ad01dba4ad897628446ada4c489d6c7dbcf39ae3f25cbe17e8b',
  archive: 'tar.gz',
  hashOf: 'archive',
  binary: `${SWIFT_TREE}/usr/bin/swift`,
  extractedTree: SWIFT_TREE,
};

export const XTOOL: PinnedTool = {
  name: 'xtool',
  version: '1.23.0',
  url: 'https://github.com/xtool-org/xtool/releases/download/1.23.0/xtool-x86_64.AppImage',
  sha256: '270fb6630baeede2cc7c516bfada2de81f99e11c00b5927f59c0cb5129bd56f7',
  archive: 'binary',
  hashOf: 'archive',
  binary: 'xtool',
  extractedTree: undefined,
};

export const RCODESIGN: PinnedTool = {
  name: 'rcodesign',
  version: '0.29.0',
  url: 'https://github.com/indygreg/apple-platform-rs/releases/download/apple-codesign%2F0.29.0/apple-codesign-0.29.0-x86_64-unknown-linux-musl.tar.gz',
  sha256: 'dab9a7465f96aba3c81e793775510f745b91a46b6418e89f7317b5d8fc7bcea2',
  archive: 'tar.gz',
  hashOf: 'binary',
  binary: 'apple-codesign-0.29.0-x86_64-unknown-linux-musl/rcodesign',
  extractedTree: 'apple-codesign-0.29.0-x86_64-unknown-linux-musl',
};

export const UV: PinnedTool = {
  name: 'uv',
  version: '0.13.5',
  url: 'https://github.com/astral-sh/uv/releases/download/0.13.5/uv-x86_64-unknown-linux-gnu.tar.gz',
  sha256: 'f68d291c75783122dad58ab77def0e13f3233f358731db5d6d7e8715603b928f',
  archive: 'tar.gz',
  hashOf: 'archive',
  binary: 'uv-x86_64-unknown-linux-gnu/uv',
  extractedTree: 'uv-x86_64-unknown-linux-gnu',
};

export const DEVICE_TOOLS = [UV];

export const TOOLS = [SWIFT, XTOOL, RCODESIGN];

export function swiftToolchain(): string {
  return process.env.LIPA_SWIFT_TOOLCHAIN ?? `${paths().tools}/${SWIFT.extractedTree ?? 'swift'}`;
}

export function toolEnvironment(): { PATH: string } {
  return {
    PATH: `${join(swiftToolchain(), 'usr', 'bin')}:${paths().bin}:${process.env.PATH ?? ''}`,
  };
}
