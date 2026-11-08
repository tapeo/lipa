import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LipaError } from '@/core/errors.ts';
import { linkBinaries, packageManifest } from '@/core/package.ts';
import { parseBinaries } from '@/core/project-yml.ts';
import { readSpec } from '@/core/spec.ts';

const fixtures = join(import.meta.dir, '..', 'fixtures');
const scratch = mkdtempSync(join(tmpdir(), 'lipa-binaries-'));
const wrapper = mkdtempSync(join(tmpdir(), 'lipa-binaries-package-'));
const framework = join(scratch, 'Frameworks', 'llama.xcframework');

mkdirSync(framework, { recursive: true });

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
  rmSync(wrapper, { recursive: true, force: true });
});

describe('parseBinaries', () => {
  test('reads an xcframework dependency by its path', () => {
    const binaries = parseBinaries(scratch, {
      dependencies: [{ framework: 'Frameworks/llama.xcframework', embed: true, codeSign: true }],
    });

    expect(binaries).toEqual([{ name: 'llama', path: framework }]);
  });

  test('leaves a system framework alone', () => {
    const binaries = parseBinaries(scratch, {
      dependencies: ['UIKit', { framework: 'QuickLook' }],
    });

    expect(binaries).toEqual([]);
  });

  test('stops on an xcframework that is not there', () => {
    expect(() =>
      parseBinaries(scratch, { dependencies: [{ framework: 'Frameworks/nope.xcframework' }] }),
    ).toThrow(LipaError);
  });
});

describe('the wrapper package with a binary framework', () => {
  const spec = { ...readSpec(fixtures), binaries: [{ name: 'llama', path: framework }] };

  test('declares the binary target and depends on it', () => {
    const manifest = packageManifest(spec);

    expect(manifest).toContain(
      '        .binaryTarget(\n            name: "llama",\n            path: "Frameworks/llama.xcframework"\n        )',
    );
    expect(manifest).toContain('                "llama",');
  });

  test('links the framework into the wrapper package', () => {
    linkBinaries(wrapper, spec);

    expect(readlinkSync(join(wrapper, 'Frameworks', 'llama.xcframework'))).toBe(framework);
  });

  test('writes no binary target without one', () => {
    expect(packageManifest(readSpec(fixtures))).not.toContain('.binaryTarget(');
  });
});
