import { readFileSync } from 'node:fs';

import { LipaError } from '@/core/errors.ts';

export type PlistValue =
  | string
  | number
  | boolean
  | Date
  | Uint8Array
  | PlistValue[]
  | { [key: string]: PlistValue };

function invalid(path: string, reason: string): LipaError {
  return new LipaError({
    code: 'config_invalid',
    message: `${path}: ${reason}`,
    fix: 'Write the plist in XML format (not binary) and check that it is well formed.',
  });
}

function unescapeXml(text: string): string {
  return text
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
}

function escapeXml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

interface Token {
  kind: 'open' | 'close' | 'empty' | 'text';
  name: string;
  text: string;
}

function tokenize(source: string, path: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;

  while (index < source.length) {
    if (source.startsWith('<?', index) || source.startsWith('<!--', index)) {
      const marker = source.startsWith('<?', index) ? '?>' : '-->';
      const end = source.indexOf(marker, index);

      if (end < 0) {
        throw invalid(path, `unterminated ${marker}`);
      }

      index = end + marker.length;
      continue;
    }

    if (source.startsWith('<!DOCTYPE', index)) {
      const end = source.indexOf('>', index);
      index = end < 0 ? source.length : end + 1;
      continue;
    }

    if (source[index] === '<') {
      const end = source.indexOf('>', index);

      if (end < 0) {
        throw invalid(path, 'unterminated tag');
      }

      const body = source.slice(index + 1, end).trim();
      index = end + 1;

      if (body.startsWith('/')) {
        tokens.push({ kind: 'close', name: body.slice(1).trim(), text: '' });
        continue;
      }

      const selfClosing = body.endsWith('/');
      const name = (selfClosing ? body.slice(0, -1) : body).trim().split(/\s/)[0] ?? '';

      if (selfClosing) {
        tokens.push({ kind: 'empty', name, text: '' });
        continue;
      }

      tokens.push({ kind: 'open', name, text: '' });
      continue;
    }

    const next = source.indexOf('<', index);
    const end = next < 0 ? source.length : next;

    tokens.push({ kind: 'text', name: '', text: unescapeXml(source.slice(index, end).trim()) });
    index = end;
  }

  return tokens;
}

class Parser {
  private index = 0;

  constructor(
    private readonly tokens: Token[],
    private readonly path: string,
  ) {}

  next(): Token | undefined {
    const token = this.tokens[this.index];
    this.index += 1;
    return token;
  }

  peek(): Token | undefined {
    return this.tokens[this.index];
  }

  value(token: Token): PlistValue {
    if (token.kind === 'text') {
      if (token.text === '') {
        const next = this.next();

        if (next === undefined) {
          throw invalid(this.path, 'unexpected end of file');
        }

        return this.value(next);
      }

      throw invalid(this.path, `unexpected text: ${token.text}`);
    }

    if (token.kind === 'close') {
      throw invalid(this.path, `unexpected </${token.name}>`);
    }

    if (token.kind === 'empty') {
      return this.emptyValue(token.name);
    }

    if (token.name === 'dict' || token.name === 'array') {
      return this.container(token.name);
    }

    if (token.name === 'key') {
      throw invalid(this.path, 'unexpected <key>');
    }

    const text = this.textUntilClose(token.name);
    return this.scalar(token.name, text);
  }

  private scalar(name: string, text: string): PlistValue {
    if (name === 'string') {
      return text;
    }

    if (name === 'true' || name === 'false') {
      return name === 'true';
    }

    if (name === 'integer') {
      const value = Number.parseInt(text, 10);

      if (Number.isNaN(value)) {
        throw invalid(this.path, 'invalid <integer>');
      }

      return value;
    }

    if (name === 'real') {
      const value = Number.parseFloat(text);

      if (Number.isNaN(value)) {
        throw invalid(this.path, 'invalid <real>');
      }

      return value;
    }

    if (name === 'date') {
      return new Date(text);
    }

    if (name === 'data') {
      return Uint8Array.from(Buffer.from(text, 'base64'));
    }

    throw invalid(this.path, `unexpected <${name}>`);
  }

  private emptyValue(name: string): PlistValue {
    if (name === 'true' || name === 'false') {
      return name === 'true';
    }

    if (name === 'string') {
      return '';
    }

    if (name === 'dict') {
      return {};
    }

    if (name === 'array') {
      return [];
    }

    throw invalid(this.path, `unexpected <${name}/>`);
  }

  private textUntilClose(name: string): string {
    const token = this.next();

    if (token === undefined || token.kind !== 'text') {
      throw invalid(this.path, `missing text in <${name}>`);
    }

    const close = this.next();

    if (close === undefined || close.kind !== 'close' || close.name !== name) {
      throw invalid(this.path, `missing </${name}>`);
    }

    return token.text;
  }

  private container(name: 'dict' | 'array'): PlistValue {
    if (name === 'array') {
      const items: PlistValue[] = [];

      for (;;) {
        const token = this.next();

        if (token === undefined) {
          throw invalid(this.path, 'unterminated <array>');
        }

        if (token.kind === 'close' && token.name === 'array') {
          return items;
        }

        if (token.kind === 'text' && token.text === '') {
          continue;
        }

        items.push(this.value(token));
      }
    }

    const value: { [key: string]: PlistValue } = {};

    for (;;) {
      const token = this.next();

      if (token === undefined) {
        throw invalid(this.path, 'unterminated <dict>');
      }

      if (token.kind === 'close' && token.name === 'dict') {
        return value;
      }

      if (token.kind === 'text' && token.text === '') {
        continue;
      }

      if (token.kind !== 'open' || token.name !== 'key') {
        throw invalid(this.path, 'expected <key> in <dict>');
      }

      const key = this.textUntilClose('key');
      const next = this.next();

      if (next === undefined) {
        throw invalid(this.path, `missing value for ${key}`);
      }

      value[key] = this.value(next);
    }
  }
}

export function parsePlist(source: string, path = 'plist'): PlistValue {
  if (source.startsWith('bplist')) {
    throw invalid(path, 'binary plist is not supported');
  }

  const tokens = tokenize(source, path);
  const parser = new Parser(tokens, path);
  let first = parser.peek();

  while (first !== undefined && first.kind === 'text' && first.text === '') {
    parser.next();
    first = parser.peek();
  }

  if (first === undefined || first.kind !== 'open' || first.name !== 'plist') {
    throw invalid(path, 'missing <plist>');
  }

  parser.next();

  const token = parser.next();

  if (token === undefined) {
    throw invalid(path, 'empty <plist>');
  }

  const value = parser.value(token);
  let close = parser.next();

  while (close !== undefined && close.kind === 'text' && close.text === '') {
    close = parser.next();
  }

  if (close === undefined || close.kind !== 'close' || close.name !== 'plist') {
    throw invalid(path, 'missing </plist>');
  }

  return value;
}

export function readPlist(path: string): { [key: string]: PlistValue } {
  const value = parsePlist(readFileSync(path, 'utf8'), path);

  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    value instanceof Date
  ) {
    throw invalid(path, 'the root of a plist must be a dict');
  }

  return value as { [key: string]: PlistValue };
}

function writeValue(value: PlistValue, indent: string): string {
  if (typeof value === 'boolean') {
    return `${indent}<${value ? 'true' : 'false'}/>`;
  }

  if (typeof value === 'number') {
    const body = Number.isInteger(value) ? `<integer>${value}</integer>` : `<real>${value}</real>`;
    return `${indent}${body}`;
  }

  if (typeof value === 'string') {
    return `${indent}<string>${escapeXml(value)}</string>`;
  }

  if (value instanceof Date) {
    return `${indent}<date>${value.toISOString().replace('.000Z', 'Z')}</date>`;
  }

  if (value instanceof Uint8Array) {
    return `${indent}<data>${Buffer.from(value).toString('base64')}</data>`;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return `${indent}<array/>`;
    }

    return [
      `${indent}<array>`,
      ...value.map((item) => writeValue(item, `${indent}  `)),
      `${indent}</array>`,
    ].join('\n');
  }

  const entries = Object.entries(value);

  if (entries.length === 0) {
    return `${indent}<dict/>`;
  }

  return [
    `${indent}<dict>`,
    ...entries.flatMap(([key, item]) => [
      `${indent}  <key>${escapeXml(key)}</key>`,
      writeValue(item, `${indent}  `),
    ]),
    `${indent}</dict>`,
  ].join('\n');
}

export function serializePlist(value: { [key: string]: PlistValue }): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    writeValue(value, ''),
    '</plist>',
    '',
  ].join('\n');
}
