import type { CommandSpec } from '@/cli/command.ts';
import { renderNextSteps, renderTable } from '@/cli/output.ts';
import { stringValue } from '@/cli/parser.ts';
import { doctor } from '@/core/doctor.ts';

export const doctorCommand: CommandSpec = {
  name: 'doctor',
  summary: 'Report tools, SDK, workspace, prebuilt cache, signing and the Mac',
  usage: 'lipa doctor [<dir>] [--mac <host>]',
  arguments: 1,
  flags: [
    {
      name: 'mac',
      value: 'host',
      description: 'Mac reachable with ssh, to check Xcode, actool and the SDK there',
    },
  ],
  examples: ['lipa doctor', 'lipa doctor --mac macbook', 'lipa doctor ~/projects/App'],
  async run({ args, output }) {
    const result = await doctor(args.positionals[0] ?? process.cwd(), {
      mac: stringValue(args.values, 'mac'),
    });
    const table = renderTable(result.checks, [
      { header: 'Check', value: (row) => row.name },
      { header: 'Result', value: (row) => resultOf(row) },
      { header: 'Detail', value: (row) => row.detail },
    ]);
    const fixes = result.checks.flatMap((check) =>
      check.ok || check.fix === undefined ? [] : [check.fix],
    );

    if (output.json) {
      return { data: result, exitCode: result.ok ? 0 : 1 };
    }

    return {
      data: result,
      text: [table, ...renderNextSteps(fixes)].join('\n'),
      exitCode: result.ok ? 0 : 1,
    };
  },
};

function resultOf(check: { ok: boolean; skipped?: boolean | undefined }): string {
  if (check.skipped === true) {
    return 'skipped';
  }

  if (check.ok) {
    return 'ok';
  }

  return 'missing';
}
