import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CommandSpec } from '@/cli/command.ts';
import { stringValue } from '@/cli/parser.ts';
import { LipaError } from '@/core/errors.ts';
import { requireCommand, run } from '@/core/exec.ts';
import { paths } from '@/core/paths.ts';
import { pullXcode, type RemoteSource, remoteSource } from '@/core/remote.ts';
import { readSdk } from '@/core/sdk.ts';
import { swiftToolchain, toolEnvironment } from '@/core/tools.ts';

function xtoolPath(): string {
  return Bun.which('xtool') ?? join(paths().bin, 'xtool');
}

async function install(path: string): Promise<{ version: string; path: string }> {
  const xtool = xtoolPath();
  const toolchain = swiftToolchain();
  requireCommand('tar');

  if (!existsSync(join(toolchain, 'usr', 'bin', 'swiftc'))) {
    throw new LipaError({
      code: 'capability_missing',
      message: 'The Swift toolchain is not installed',
      fix: 'Run lipa setup.',
    });
  }

  const result = await run([xtool, 'sdk', 'install', path], {
    stdout: 'inherit',
    stderr: 'inherit',
    env: toolEnvironment(),
  });

  if (result.exitCode !== 0) {
    throw new LipaError({
      code: 'generic',
      message: `xtool sdk install exited with ${result.exitCode}`,
      fix: `Check the Swift toolchain in ${join(toolchain, 'usr', 'bin')} and run lipa doctor.`,
    });
  }

  const sdk = readSdk();

  return { version: sdk.version, path: sdk.root };
}

async function installFromMac(
  source: RemoteSource,
  remoteXcode: string,
  keep: boolean,
): Promise<{ version: string; path: string }> {
  const work = join(tmpdir(), `lipa-xcode-${Date.now()}`);
  const archive = join(work, 'Xcode.tar');
  mkdirSync(work, { recursive: true });

  try {
    await pullXcode(source, remoteXcode, archive);

    const extracted = await run(['tar', '-xf', archive, '-C', work]);

    if (extracted.exitCode !== 0) {
      throw new LipaError({
        code: 'generic',
        message: `Cannot extract Xcode: ${extracted.stderr}`,
      });
    }

    return await install(join(work, 'Xcode.app'));
  } finally {
    if (keep) {
      process.stderr.write(`Xcode kept in ${work}\n`);
    } else {
      rmSync(work, { recursive: true, force: true });
    }
  }
}

export const sdkCommand: CommandSpec = {
  name: 'sdk',
  summary: 'Install the Darwin SDK used to link for iOS',
  usage: 'lipa sdk (--xcode <path> | --mac <host> | --via <command>) [--xcode <path>] [--keep]',
  flags: [
    {
      name: 'xcode',
      value: 'path',
      description: 'Xcode.app or Xcode.xip, on this machine or on the Mac with --mac',
    },
    { name: 'mac', value: 'host', description: 'Mac reachable with ssh, to copy Xcode from' },
    { name: 'via', value: 'command', description: 'Command that runs sh on the Mac' },
    { name: 'keep', description: 'Keep the copy of Xcode.app taken from the Mac' },
  ],
  examples: [
    'lipa sdk --xcode ~/Downloads/Xcode.xip',
    'lipa sdk --mac macbook',
    'lipa sdk --mac macbook --xcode /Applications/Xcode-beta.app',
  ],
  async run({ args }) {
    const xcode = stringValue(args.values, 'xcode');
    const source = remoteSource({
      mac: stringValue(args.values, 'mac'),
      via: stringValue(args.values, 'via'),
    });

    let installed: { version: string; path: string };

    if (source === undefined) {
      if (xcode === undefined) {
        throw new LipaError({
          code: 'usage',
          message: 'Missing --xcode <path> or --mac <host>',
          fix: 'lipa sdk --xcode ~/Downloads/Xcode.xip uses a copy on this machine. lipa sdk --mac macbook copies Xcode from the Mac.',
        });
      }

      installed = await install(xcode);
    } else {
      installed = await installFromMac(
        source,
        xcode ?? '/Applications/Xcode.app',
        args.values.keep === true,
      );
    }

    return { data: installed, text: `Darwin SDK ${installed.version} at ${installed.path}` };
  },
};
