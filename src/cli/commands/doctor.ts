import type { CommandSpec } from '@/cli/command.ts';
import { renderTable } from '@/cli/output.ts';
import { doctor } from '@/core/doctor.ts';

export const doctorCommand: CommandSpec = {
  name: 'doctor',
  summary: 'Report tools, SDK, prebuilt cache and signing',
  usage: 'lipa doctor [<dir>]',
  arguments: 1,
  examples: ['lipa doctor', 'lipa doctor ~/projects/app'],
  async run({ args, output }) {
    const result = await doctor(args.positionals[0] ?? process.cwd());
    const table = renderTable(result.checks, [
      { header: 'Check', value: (row) => row.name },
      { header: 'Result', value: (row) => (row.ok ? 'ok' : 'missing') },
      { header: 'Detail', value: (row) => row.detail },
    ]);

    if (output.json) {
      return { data: result, exitCode: result.ok ? 0 : 1 };
    }

    return { data: result, text: table, exitCode: result.ok ? 0 : 1 };
  },
};
