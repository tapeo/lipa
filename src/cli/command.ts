import type { OutputOptions } from '@/cli/output.ts';
import type { FlagValue, ParsedArgs } from '@/cli/parser.ts';
import { LipaError } from '@/core/errors.ts';

export interface CommandContext {
  args: ParsedArgs;
  output: OutputOptions;
  path: string;
}

export interface CommandResult {
  data?: unknown;
  text?: string;
  exitCode?: number;
}

export interface FlagSpec {
  name: string;
  description: string;
  value?: string;
}

export type RunCommand = (context: CommandContext) => Promise<CommandResult> | CommandResult;

export interface ActionSpec {
  name: string;
  summary: string;
  usage: string;
  flags?: FlagSpec[];
  arguments?: number;
  examples?: string[];
  run: RunCommand;
}

export interface CommandSpec {
  name: string;
  summary: string;
  usage: string;
  flags?: FlagSpec[];
  arguments?: number;
  examples?: string[];
  actions?: ActionSpec[];
  run?: RunCommand;
}

export const GLOBAL_FLAGS: FlagSpec[] = [
  { name: 'json', description: 'JSON output, the default without a terminal' },
  { name: 'help', description: 'This help, also lipa help <command> [<action>]' },
  { name: 'version', description: 'Version of lipa' },
];

export function allSpecs(commands: CommandSpec[]): Array<CommandSpec | ActionSpec> {
  return commands.flatMap((command) => [command, ...(command.actions ?? [])]);
}

export function resolveAction(command: CommandSpec, rest: string[]): ActionSpec | undefined {
  return command.actions?.find((action) => action.name === rest[0]);
}

export function missingAction(command: CommandSpec, given: string | undefined): LipaError {
  const names = (command.actions ?? []).map((action) => action.name);
  const last = names.at(-1);
  const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} or ${last}` : (last ?? '');

  return new LipaError({
    code: 'usage',
    message:
      given === undefined
        ? `Missing action for lipa ${command.name}`
        : `Unknown action for lipa ${command.name}: ${given}`,
    fix: `Use lipa ${command.name} ${list}`,
  });
}

export function checkFlags(
  spec: CommandSpec | ActionSpec,
  values: Record<string, FlagValue>,
  path: string,
): void {
  for (const [key, value] of Object.entries(values)) {
    const flag = (spec.flags ?? []).find((item) => item.name === key);

    if (flag === undefined) {
      if (GLOBAL_FLAGS.some((global) => global.name === key)) {
        continue;
      }

      throw new LipaError({
        code: 'usage',
        message: `Unknown flag for lipa ${path}: ${key.length === 1 ? '-' : '--'}${key}`,
        fix: `Run lipa ${path} --help to see its flags`,
      });
    }

    if (flag.value !== undefined && typeof value === 'boolean') {
      throw new LipaError({
        code: 'usage',
        message: `Missing value for --${flag.name}`,
        fix: `Write --${flag.name} <${flag.value}>`,
      });
    }
  }
}

export function checkArguments(
  spec: CommandSpec | ActionSpec,
  positionals: string[],
  path: string,
): void {
  const extra = positionals.slice(spec.arguments ?? 0);

  if (extra.length === 0) {
    return;
  }

  throw new LipaError({
    code: 'usage',
    message: `Too many arguments for lipa ${path}: ${extra.join(' ')}`,
    fix: `Usage: ${spec.usage}`,
  });
}

function columns(rows: Array<[string, string]>): string[] {
  const width = Math.max(0, ...rows.map(([name]) => name.length));

  return rows.map(([name, summary]) => `  ${name.padEnd(width)}  ${summary}`);
}

function flagLines(flags: FlagSpec[]): string[] {
  return columns(flags.map((flag) => [flag.name, flag.description]));
}

export function usageFor(spec: CommandSpec | ActionSpec): string {
  const actions = 'actions' in spec ? (spec.actions ?? []) : [];
  const lines = [spec.summary, '', `Usage: ${spec.usage}`];

  if (actions.length > 0) {
    lines.push('', 'Actions:', ...columns(actions.map((action) => [action.name, action.summary])));
  }

  if ((spec.flags ?? []).length > 0) {
    lines.push('', 'Flags:', ...flagLines(spec.flags ?? []));
  }

  if ((spec.examples ?? []).length > 0) {
    lines.push('', 'Examples:', ...(spec.examples ?? []).map((example) => `  ${example}`));
  }

  lines.push('', 'Global flags:', ...flagLines(GLOBAL_FLAGS));

  return lines.join('\n');
}
