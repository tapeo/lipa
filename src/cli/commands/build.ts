import type { CommandSpec } from '@/cli/command.ts';
import { renderTable } from '@/cli/output.ts';
import { booleanValue, stringValue } from '@/cli/parser.ts';
import { buildIos } from '@/core/build.ts';
import { macSource } from '@/core/prepare.ts';
import { signingKind } from '@/core/signing.ts';

export const buildCommand: CommandSpec = {
  name: 'build',
  summary: 'Build, sign and package an iOS app on Linux',
  usage:
    'lipa build [<dir>] [--mac <host> | --via <command>] [--signing app-store|development] [--build <number>] [--version <version>] [--out <ipa>] [--target <name>] [--update] [--clean]',
  arguments: 1,
  flags: [
    {
      name: 'mac',
      value: 'host',
      description: 'Mac reachable with ssh, used when the assets or the SDK changed',
    },
    { name: 'via', value: 'command', description: 'Command that runs sh on the Mac' },
    {
      name: 'build',
      value: 'number',
      description: 'CFBundleVersion, default CURRENT_PROJECT_VERSION, then a UTC timestamp',
    },
    {
      name: 'version',
      value: 'version',
      description: 'Marketing version, default from the xcconfig',
    },
    { name: 'out', value: 'ipa', description: 'IPA path, default build/<app>.ipa in the project' },
    { name: 'target', value: 'name', description: 'iOS application target of project.yml' },
    {
      name: 'signing',
      value: 'kind',
      description: 'Signing identity: app-store or development, default app-store',
    },
    {
      name: 'update',
      description: 'Resolve the package dependencies again without compiling everything',
    },
    {
      name: 'clean',
      description: 'Throw away the package workspace and compile everything again',
    },
  ],
  examples: [
    'lipa build',
    'lipa build --mac macbook',
    'lipa build --signing development',
    'lipa build --build 42 --out /tmp/App.ipa',
  ],
  async run({ args, output }) {
    const root = args.positionals[0] ?? process.cwd();
    const result = await buildIos({
      signing: signingKind(stringValue(args.values, 'signing')),
      root,
      build: stringValue(args.values, 'build'),
      version: stringValue(args.values, 'version'),
      out: stringValue(args.values, 'out'),
      target: stringValue(args.values, 'target'),
      clean: booleanValue(args.values, 'clean'),
      update: booleanValue(args.values, 'update'),
      mac: macSource({
        mac: stringValue(args.values, 'mac'),
        via: stringValue(args.values, 'via'),
      }),
      stream: !output.json,
    });

    const rows = [
      { name: 'IPA', value: result.ipa },
      { name: 'Size', value: `${(result.bytes / 1_000_000).toFixed(1)} MB` },
      { name: 'Version', value: `${result.version} (${result.build})` },
      { name: 'Bundle id', value: result.bundleId },
      { name: 'Signing', value: result.signing },
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
