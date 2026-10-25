import type { CommandSpec } from '@/cli/command.ts';
import { installDevice } from '@/core/device.ts';
import { LipaError } from '@/core/errors.ts';
import { installTool } from '@/core/install.ts';
import { paths } from '@/core/paths.ts';
import { DEVICE_TOOLS, TOOLS } from '@/core/tools.ts';

export const setupCommand: CommandSpec = {
  name: 'setup',
  summary: 'Install the pinned tools lipa needs',
  usage: 'lipa setup [--force] [--only <tool>]',
  flags: [
    { name: 'force', description: 'Install again' },
    {
      name: 'only',
      value: 'tool',
      description: 'Install one tool or the device helper, repeatable',
    },
  ],
  examples: ['lipa setup', 'lipa setup --only device'],
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
    const selected = [...TOOLS, ...DEVICE_TOOLS].filter(
      (item) => wanted.size === 0 || wanted.has(item.name),
    );

    for (const tool of selected) {
      const line = await installTool(tool, args.values.force === true);
      lines.push(line);

      if (!output.json) {
        process.stdout.write(`${line}\n`);
      }
    }

    if (wanted.has('device')) {
      const device = await installDevice();

      for (const step of device.steps) {
        lines.push(step);

        if (!output.json) {
          process.stdout.write(`${step}\n`);
        }
      }
    }

    return {
      data: { tools: lines, home: paths().home },
      text: lines.join('\n'),
    };
  },
};
