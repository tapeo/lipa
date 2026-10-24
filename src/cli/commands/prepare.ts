import type { CommandSpec } from '@/cli/command.ts';
import { renderTable } from '@/cli/output.ts';
import { booleanValue, stringValue } from '@/cli/parser.ts';
import { macSource, prepareProject } from '@/core/prepare.ts';

export const prepareCommand: CommandSpec = {
  name: 'prepare',
  summary: 'Compile the app and refresh what needs a Mac, before lipa build',
  usage:
    'lipa prepare [<dir>] [--mac <host> | --via <command> | --import <dir>] [--update] [--clean] [--target <name>]',
  arguments: 1,
  flags: [
    {
      name: 'mac',
      value: 'host',
      description: 'Mac reachable with ssh, used when the assets or the SDK changed',
    },
    { name: 'via', value: 'command', description: 'Command that runs sh on the Mac' },
    { name: 'import', value: 'dir', description: 'Cache actool output produced elsewhere' },
    {
      name: 'update',
      description: 'Resolve the package dependencies again without compiling everything',
    },
    {
      name: 'clean',
      description: 'Throw away the package workspace and compile everything again',
    },
    { name: 'target', value: 'name', description: 'iOS application target of project.yml' },
  ],
  examples: ['lipa prepare', 'lipa prepare --mac macbook', 'lipa prepare --update'],
  async run({ args, output }) {
    const result = await prepareProject({
      root: args.positionals[0] ?? process.cwd(),
      target: stringValue(args.values, 'target'),
      clean: booleanValue(args.values, 'clean'),
      update: booleanValue(args.values, 'update'),
      mac: macSource({
        mac: stringValue(args.values, 'mac'),
        via: stringValue(args.values, 'via'),
        import: stringValue(args.values, 'import'),
      }),
      stream: !output.json,
    });

    if (output.json) {
      return { data: result };
    }

    const state = result.cold ? 'cold' : 'warm';
    const signing = result.signing.ok
      ? `ok, expires ${result.signing.expires?.slice(0, 10) ?? 'unknown'}`
      : `missing, ${result.signing.reason ?? 'run lipa signing import'}`;

    return {
      data: result,
      text: renderTable(
        [
          { name: 'Workspace', value: `${state}, ${result.workspace}` },
          { name: 'Steps', value: result.steps.join(', ') },
          { name: 'SDK', value: `iOS ${result.sdk}` },
          {
            name: 'Prebuilt',
            value: `Xcode ${result.prebuilt.xcodeVersion}, SDK ${result.prebuilt.sdkVersion}`,
          },
          { name: 'Signing', value: signing },
          { name: 'Time', value: `${result.seconds}s` },
        ],
        [
          { header: 'Item', value: (row) => row.name },
          { header: 'Value', value: (row) => row.value },
        ],
      ),
    };
  },
};
