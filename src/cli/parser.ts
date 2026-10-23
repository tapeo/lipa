export type FlagValue = string | boolean | string[];

export interface ParsedArgs {
  values: Record<string, FlagValue>;
  positionals: string[];
  rest: string[];
}

export interface ParseOptions {
  valueFlags?: readonly string[];
}

const SHORT_ALIASES: Record<string, string> = {
  h: 'help',
  v: 'version',
  j: 'json',
  f: 'force',
};

function appendValue(values: Record<string, FlagValue>, key: string, value: string): void {
  const current = values[key];

  if (typeof current === 'string') {
    values[key] = [current, value];
    return;
  }

  if (Array.isArray(current)) {
    current.push(value);
    return;
  }

  values[key] = value;
}

export function parseArgs(argv: string[], options: ParseOptions = {}): ParsedArgs {
  const valueFlags = new Set(options.valueFlags ?? []);
  const values: Record<string, FlagValue> = {};
  const positionals: string[] = [];
  let rest: string[] = [];
  let index = 0;

  while (index < argv.length) {
    const token = argv[index] ?? '';

    if (token === '--') {
      rest = argv.slice(index + 1);
      break;
    }

    if (token.startsWith('--')) {
      const body = token.slice(2);
      const equals = body.indexOf('=');

      if (equals > 0) {
        appendValue(values, body.slice(0, equals), body.slice(equals + 1));
        index += 1;
        continue;
      }

      if (body.startsWith('no-')) {
        values[body.slice(3)] = false;
        index += 1;
        continue;
      }

      const next = argv[index + 1];

      if (valueFlags.has(body) && next !== undefined && !next.startsWith('-')) {
        appendValue(values, body, next);
        index += 2;
        continue;
      }

      values[body] = true;
      index += 1;
      continue;
    }

    if (token.startsWith('-') && token.length > 1) {
      const letters = token.slice(1);
      const last = letters.at(-1) ?? '';
      const next = argv[index + 1];

      for (const letter of letters.slice(0, -1)) {
        values[SHORT_ALIASES[letter] ?? letter] = true;
      }

      const name = SHORT_ALIASES[last] ?? last;

      if (valueFlags.has(name) && next !== undefined && !next.startsWith('-')) {
        appendValue(values, name, next);
        index += 2;
        continue;
      }

      values[name] = true;
      index += 1;
      continue;
    }

    positionals.push(token);
    index += 1;
  }

  return { values, positionals, rest };
}

export function stringValue(values: Record<string, FlagValue>, name: string): string | undefined {
  const value = values[name];

  if (typeof value === 'string') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.at(-1);
  }

  return undefined;
}

export function booleanValue(values: Record<string, FlagValue>, name: string): boolean {
  return values[name] === true;
}
