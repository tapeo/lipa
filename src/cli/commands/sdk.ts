import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CommandSpec } from '@/cli/command.ts';
import { stringValue } from '@/cli/parser.ts';
import { LipaError } from '@/core/errors.ts';
import { requireCommand, run } from '@/core/exec.ts';
import { paths } from '@/core/paths.ts';
import { pullXcode, transportFrom } from '@/core/remote.ts';
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

export const sdkCommand: CommandSpec = {
  name: 'sdk',
  summary: 'Install the Darwin SDK used to link for iOS',
  usage: 'lipa sdk <build|pull> ...',
  actions: [
    {
      name: 'build',
      summary: 'Build and install the SDK from a local Xcode.app or .xip',
      usage: 'lipa sdk build --xcode <path>',
      flags: [{ name: 'xcode', value: 'path', description: 'Xcode.app or Xcode.xip' }],
      examples: ['lipa sdk build --xcode ~/Downloads/Xcode.xip'],
      async run({ args }) {
        const xcode = stringValue(args.values, 'xcode');

        if (xcode === undefined) {
          throw new LipaError({ code: 'usage', message: 'Missing --xcode <path>' });
        }

        const sdk = await install(xcode);

        return { data: sdk, text: `Darwin SDK ${sdk.version} at ${sdk.path}` };
      },
    },
    {
      name: 'pull',
      summary: 'Copy Xcode.app from a Mac, install the SDK, delete the copy',
      usage: 'lipa sdk pull (--mac <host> | --via <command>) [--xcode <path>] [--keep]',
      flags: [
        { name: 'mac', value: 'host', description: 'Mac reachable with ssh' },
        { name: 'via', value: 'command', description: 'Command that runs sh on the Mac' },
        { name: 'xcode', value: 'path', description: 'Path of Xcode.app on the Mac' },
        { name: 'keep', description: 'Keep the downloaded Xcode.app' },
      ],
      examples: ['lipa sdk pull --mac macbook'],
      async run({ args }) {
        const transport = transportFrom({
          mac: stringValue(args.values, 'mac'),
          via: stringValue(args.values, 'via'),
        });
        const remote = stringValue(args.values, 'xcode') ?? '/Applications/Xcode.app';
        const work = join(tmpdir(), `lipa-xcode-${Date.now()}`);
        const archive = join(work, 'Xcode.tar');
        mkdirSync(work, { recursive: true });

        let installed = false;

        try {
          await pullXcode(transport, remote, archive);

          const extracted = await run(['tar', '-xf', archive, '-C', work]);

          if (extracted.exitCode !== 0) {
            throw new LipaError({
              code: 'generic',
              message: `Cannot extract Xcode: ${extracted.stderr}`,
            });
          }

          const sdk = await install(join(work, 'Xcode.app'));
          installed = true;

          return { data: sdk, text: `Darwin SDK ${sdk.version} at ${sdk.path}` };
        } finally {
          if (installed && args.values.keep !== true) {
            rmSync(work, { recursive: true, force: true });
          } else {
            process.stderr.write(`Xcode kept in ${work}\n`);
          }
        }
      },
    },
  ],
};
