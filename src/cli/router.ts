import {
  type ActionSpec,
  type CommandSpec,
  checkArguments,
  checkFlags,
  missingAction,
  resolveAction,
  usageFor,
} from '@/cli/command.ts';
import { emit, type OutputOptions, renderTable } from '@/cli/output.ts';
import type { ParsedArgs } from '@/cli/parser.ts';
import { VERSION } from '@/version.ts';

export interface RouterOptions {
  args: ParsedArgs;
  commands: CommandSpec[];
  output: OutputOptions;
}

function overview(commands: CommandSpec[]): string {
  return [
    `lipa ${VERSION}`,
    'Build a signed iOS app on Linux.',
    '',
    'Commands:',
    ...renderTable(commands, [
      { header: 'Command', value: (row) => row.name },
      { header: 'Summary', value: (row) => row.summary },
    ])
      .split('\n')
      .map((line) => `  ${line}`),
    '',
    'Usage: lipa <command> [<action>] [flags]',
  ].join('\n');
}

function helpFor(spec: CommandSpec | ActionSpec): string {
  return usageFor(spec);
}

export async function runRouter(options: RouterOptions): Promise<number> {
  const { args, commands, output } = options;
  const [name, ...rest] = args.positionals;

  if (name === 'version' || args.values.version === true) {
    emit({ ok: true, data: { version: VERSION } }, output);
    return 0;
  }

  if (name === undefined || name === 'help') {
    const target = name === 'help' ? rest[0] : undefined;
    const command = commands.find((item) => item.name === target);

    if (target === undefined) {
      emit({ ok: true, data: overview(commands) }, output);
      return 0;
    }

    if (command === undefined) {
      emit(
        {
          ok: false,
          error: { code: 'usage', message: `Unknown command: ${target}` },
        },
        output,
      );
      return 2;
    }

    const action = resolveAction(command, rest.slice(1));

    emit(
      {
        ok: true,
        data: helpFor(action ?? command),
      },
      output,
    );
    return 0;
  }

  const command = commands.find((item) => item.name === name);

  if (command === undefined) {
    emit({ ok: false, error: { code: 'usage', message: `Unknown command: ${name}` } }, output);
    return 2;
  }

  const action = command.actions === undefined ? undefined : resolveAction(command, rest);

  if (command.actions !== undefined && action === undefined && args.values.help !== true) {
    throw missingAction(command, rest[0]);
  }

  const spec = action ?? command;
  const path = action ? `${command.name} ${action.name}` : command.name;
  const positionals = action ? rest.slice(1) : rest;

  if (args.values.help === true) {
    emit({ ok: true, data: helpFor(spec) }, output);
    return 0;
  }

  checkFlags(spec, args.values, path);
  checkArguments(spec, positionals, path);

  if (spec.run === undefined) {
    throw missingAction(command, rest[0]);
  }

  const result = await spec.run({
    args: { ...args, positionals, rest: action ? rest.slice(1) : rest },
    output,
    path,
  });

  if (result.text !== undefined && !output.json) {
    emit({ ok: true, data: result.text }, output);
  } else if (!output.json) {
    emit({ ok: true, data: result.data }, output);
  } else {
    emit({ ok: true, data: result.data ?? null }, output);
  }

  return result.exitCode ?? 0;
}
