import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import type { CommandSpec } from '@/cli/command.ts';
import { LipaError } from '@/core/errors.ts';
import { run } from '@/core/exec.ts';
import { fileHash } from '@/core/hash.ts';
import { paths } from '@/core/paths.ts';
import { type PinnedTool, TOOLS } from '@/core/tools.ts';

async function download(url: string, path: string): Promise<void> {
  const response = await fetch(url);

  if (!response.ok) {
    throw new LipaError({
      code: 'capability_missing',
      message: `Cannot download ${url}: ${response.status}`,
    });
  }

  await Bun.write(path, response);
}

function installedMarker(tool: PinnedTool): string {
  return join(paths().tools, `.${tool.name}-${tool.version}`);
}

async function install(tool: PinnedTool, force: boolean): Promise<string> {
  const marker = installedMarker(tool);

  if (!force && existsSync(marker)) {
    return `${tool.name} ${tool.version} already installed`;
  }

  const directory = paths().tools;
  mkdirSync(directory, { recursive: true });

  const downloadPath = join(directory, `${tool.name}.download`);
  await download(tool.url, downloadPath);

  const mismatch = (actual: string): LipaError => {
    rmSync(downloadPath, { force: true });

    return new LipaError({
      code: 'capability_missing',
      message: `${tool.name}: sha256 ${actual}, expected ${tool.sha256}`,
      fix: 'Check the pinned version in src/core/tools.ts.',
    });
  };

  if (tool.hashOf === 'archive') {
    const hash = fileHash(downloadPath);

    if (hash !== tool.sha256) {
      throw mismatch(hash);
    }
  }

  if (tool.archive === 'binary') {
    const target = join(paths().bin, tool.binary);
    mkdirSync(paths().bin, { recursive: true });
    Bun.spawnSync(['cp', downloadPath, target]);
    chmodSync(target, 0o755);
  } else {
    const untar = await run(['tar', '-xzf', downloadPath, '-C', directory]);

    if (untar.exitCode !== 0) {
      throw new LipaError({
        code: 'capability_missing',
        message: `Cannot extract ${tool.name}: ${untar.stderr}`,
      });
    }

    const extracted = join(directory, tool.binary);

    if (!existsSync(extracted)) {
      throw new LipaError({
        code: 'capability_missing',
        message: `${tool.name}: the archive has no ${tool.binary}`,
        fix: 'Check the pinned version in src/core/tools.ts.',
      });
    }

    if (tool.hashOf === 'binary') {
      const hash = fileHash(extracted);

      if (hash !== tool.sha256) {
        throw mismatch(hash);
      }

      mkdirSync(paths().bin, { recursive: true });
      copyFileSync(extracted, join(paths().bin, basename(tool.binary)));
      chmodSync(join(paths().bin, basename(tool.binary)), 0o755);
    }
  }

  rmSync(downloadPath, { force: true });
  writeFileSync(marker, `${tool.version}\n`);

  return `${tool.name} ${tool.version} installed`;
}

export const setupCommand: CommandSpec = {
  name: 'setup',
  summary: 'Install the pinned tools lipa needs',
  usage: 'lipa setup [--force]',
  flags: [
    { name: 'force', description: 'Install again' },
    { name: 'only', value: 'tool', description: 'Install one tool, repeatable' },
  ],
  examples: ['lipa setup'],
  async run({ args, output }) {
    if (process.arch !== 'x64') {
      throw new LipaError({
        code: 'capability_missing',
        message: `setup pins the tools for x86_64, this machine is ${process.arch}`,
        fix: 'Add the arm64 checksums in src/core/tools.ts, or install Swift, xtool and rcodesign yourself.',
      });
    }

    const lines: string[] = [];

    const only = args.values.only;
    const wanted = new Set(Array.isArray(only) ? only : typeof only === 'string' ? [only] : []);

    for (const tool of TOOLS.filter((item) => wanted.size === 0 || wanted.has(item.name))) {
      const line = await install(tool, args.values.force === true);
      lines.push(line);

      if (!output.json) {
        process.stdout.write(`${line}\n`);
      }
    }

    return {
      data: { tools: lines, home: paths().home },
      text: lines.join('\n'),
    };
  },
};
