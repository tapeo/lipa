import type { CommandSpec } from '@/cli/command.ts';
import { renderTable } from '@/cli/output.ts';
import { stringValue } from '@/cli/parser.ts';
import { importPrebuilt } from '@/core/prebuilt.ts';
import { fetchPrebuilt, transportFrom } from '@/core/remote.ts';

export const prebuiltCommand: CommandSpec = {
  name: 'prebuilt',
  summary: 'Run actool on a Mac and cache the result for this bundle id',
  usage: 'lipa prebuilt (--mac <host> | --via <command> | --import <dir>) [<dir>]',
  arguments: 1,
  flags: [
    { name: 'mac', value: 'host', description: 'Mac reachable with ssh' },
    { name: 'via', value: 'command', description: 'Command that runs sh on the Mac' },
    { name: 'import', value: 'dir', description: 'Cache a directory produced by actool elsewhere' },
  ],
  examples: ['lipa prebuilt --mac macbook', "lipa prebuilt --via 'ssh -p 2222 user@192.168.1.10'"],
  async run({ args }) {
    const root = args.positionals[0] ?? process.cwd();
    const imported = stringValue(args.values, 'import');
    let result: Awaited<ReturnType<typeof fetchPrebuilt>>;

    if (imported !== undefined) {
      result = importPrebuilt(root, imported, undefined);
    } else {
      const transport = transportFrom({
        mac: stringValue(args.values, 'mac'),
        via: stringValue(args.values, 'via'),
      });
      result = await fetchPrebuilt(root, transport);
    }

    return {
      data: result,
      text: [
        `Cached ${result.bundleId}`,
        renderTable(
          [
            { name: 'Xcode', value: result.xcodeVersion },
            { name: 'SDK', value: result.sdkVersion },
            { name: 'Assets', value: result.assetsHash.slice(0, 12) },
            { name: 'Files', value: result.files.join(', ') },
          ],
          [
            { header: 'Item', value: (row) => row.name },
            { header: 'Value', value: (row) => row.value },
          ],
        ),
      ].join('\n'),
    };
  },
};
