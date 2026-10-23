import type { CommandSpec } from '@/cli/command.ts';
import { renderTable } from '@/cli/output.ts';
import { stringValue } from '@/cli/parser.ts';
import { buildIos } from '@/core/build.ts';

function defaultBuildNumber(): string {
  const now = new Date();

  return [
    now.getUTCFullYear(),
    String(now.getUTCMonth() + 1).padStart(2, '0'),
    String(now.getUTCDate()).padStart(2, '0'),
    String(now.getUTCHours()).padStart(2, '0'),
    String(now.getUTCMinutes()).padStart(2, '0'),
    String(now.getUTCSeconds()).padStart(2, '0'),
  ].join('');
}

export const buildCommand: CommandSpec = {
  name: 'build',
  summary: 'Build, sign and package an iOS app on Linux',
  usage:
    'lipa build [<dir>] [--build <number>] [--version <version>] [--out <ipa>] [--target <name>]',
  arguments: 1,
  flags: [
    { name: 'build', value: 'number', description: 'CFBundleVersion, default a UTC timestamp' },
    {
      name: 'version',
      value: 'version',
      description: 'Marketing version, default from the xcconfig',
    },
    { name: 'out', value: 'ipa', description: 'IPA path, default build/<app>.ipa in the project' },
    { name: 'target', value: 'name', description: 'iOS application target of project.yml' },
  ],
  examples: ['lipa build', 'lipa build --build 42 --out /tmp/App.ipa'],
  async run({ args, output }) {
    const root = args.positionals[0] ?? process.cwd();
    const build = stringValue(args.values, 'build') ?? defaultBuildNumber();
    const result = await buildIos({
      root,
      build,
      version: stringValue(args.values, 'version'),
      out: stringValue(args.values, 'out'),
      target: stringValue(args.values, 'target'),
    });

    const rows = [
      { name: 'IPA', value: result.ipa },
      { name: 'Size', value: `${(result.bytes / 1_000_000).toFixed(1)} MB` },
      { name: 'Version', value: `${result.version} (${result.build})` },
      { name: 'Bundle id', value: result.bundleId },
      { name: 'SDK', value: `iOS ${result.sdk}` },
      { name: 'Symbols', value: result.symbols },
    ];

    if (output.json) {
      return { data: result };
    }

    return {
      data: result,
      text: renderTable(rows, [
        { header: 'Item', value: (row) => row.name },
        { header: 'Value', value: (row) => row.value },
      ]),
    };
  },
};
