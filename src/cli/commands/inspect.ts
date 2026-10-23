import type { CommandSpec } from '@/cli/command.ts';
import { renderTable } from '@/cli/output.ts';
import { LipaError } from '@/core/errors.ts';
import { inspectIpa } from '@/core/inspect.ts';

export const inspectCommand: CommandSpec = {
  name: 'inspect',
  summary: 'Check an IPA before uploading it',
  usage: 'lipa inspect <ipa>',
  arguments: 1,
  examples: ['lipa inspect build/App.ipa'],
  run({ args, output }) {
    const ipa = args.positionals[0];

    if (ipa === undefined) {
      throw new LipaError({ code: 'usage', message: 'Missing <ipa>' });
    }

    const result = inspectIpa(ipa);
    const table = renderTable(result.checks, [
      { header: 'Check', value: (row) => row.name },
      { header: 'Result', value: (row) => (row.ok ? 'ok' : 'failed') },
      { header: 'Detail', value: (row) => row.detail },
    ]);

    if (output.json) {
      return { data: result, exitCode: result.ok ? 0 : 7 };
    }

    return { data: result, text: table, exitCode: result.ok ? 0 : 7 };
  },
};
