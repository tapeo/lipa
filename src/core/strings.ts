import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { LipaError } from '@/core/errors.ts';
import { type PlistValue, serializePlist } from '@/core/plist.ts';

type Json = { [key: string]: unknown };
type PlistDict = { [key: string]: PlistValue };

export interface CompiledTable {
  language: string;
  strings: { [key: string]: string };
  plurals: PlistDict;
}

const FORMAT_SPECIFIER =
  /%(?:\d+\$)?[-+ #0]*\d*(?:\.\d+)?(hh|h|ll|l|q|z|t|j)?([dDiuUxXoOfFeEgGcCsSpaA@])/;

function object(value: unknown): Json | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }

  return value as Json;
}

function unsupported(source: string, key: string, what: string): LipaError {
  return new LipaError({
    code: 'config_invalid',
    message: `${source}: "${key}" uses ${what}, which lipa does not compile`,
    fix: 'Use plain strings, plural variations, device variations or plural substitutions.',
  });
}

function unitValue(localization: Json | undefined): string | undefined {
  const value = object(localization?.stringUnit)?.value;

  if (typeof value === 'string') {
    return value;
  }

  return undefined;
}

function formatType(forms: string[]): string {
  for (const form of forms) {
    const match = form.match(FORMAT_SPECIFIER);

    if (match !== null) {
      return `${match[1] ?? ''}${match[2]}`;
    }
  }

  return 'lld';
}

function pluralForms(
  plural: Json,
  source: string,
  key: string,
  rewrite: (form: string) => string,
): { [category: string]: string } {
  const forms: { [category: string]: string } = {};

  for (const [category, value] of Object.entries(plural)) {
    const form = unitValue(object(value));

    if (form === undefined) {
      throw unsupported(source, key, `a nested variation under plural ${category}`);
    }

    forms[category] = rewrite(form);
  }

  return forms;
}

function pluralRule(valueType: string, forms: { [category: string]: string }): PlistDict {
  return {
    NSStringFormatSpecTypeKey: 'NSStringPluralRuleType',
    NSStringFormatValueTypeKey: valueType,
    ...forms,
  };
}

function pluralEntry(plural: Json, source: string, key: string): PlistDict {
  const forms = pluralForms(plural, source, key, (form) => form);

  return {
    NSStringLocalizedFormatKey: '%#@value@',
    value: pluralRule(formatType(Object.values(forms)), forms),
  };
}

function deviceEntry(device: Json, source: string, key: string): PlistDict {
  const values: PlistDict = {};

  for (const [name, value] of Object.entries(device)) {
    const form = unitValue(object(value));

    if (form === undefined) {
      throw unsupported(source, key, `a nested variation under device ${name}`);
    }

    values[name] = form;
  }

  return { NSStringDeviceSpecificRuleType: values };
}

function substitutionEntry(
  format: string,
  substitutions: Json,
  source: string,
  key: string,
): PlistDict {
  let localizedFormat = format;
  const entry: PlistDict = {};

  for (const [name, value] of Object.entries(substitutions)) {
    const substitution = object(value) ?? {};
    const plural = object(object(substitution.variations)?.plural);

    if (plural === undefined) {
      throw unsupported(source, key, `the substitution ${name} without a plural variation`);
    }

    let specifier = 'lld';

    if (typeof substitution.formatSpecifier === 'string') {
      specifier = substitution.formatSpecifier;
    }

    let argument = `%${specifier}`;

    if (typeof substitution.argNum === 'number') {
      argument = `%${substitution.argNum}$${specifier}`;
      localizedFormat = localizedFormat
        .split(`%#@${name}@`)
        .join(`%${substitution.argNum}$#@${name}@`);
    }

    const forms = pluralForms(plural, source, key, (form) => form.split('%arg').join(argument));
    entry[name] = pluralRule(specifier, forms);
  }

  return { NSStringLocalizedFormatKey: localizedFormat, ...entry };
}

function compileEntry(table: CompiledTable, key: string, localization: Json, source: string): void {
  const variations = object(localization.variations);
  const substitutions = object(localization.substitutions);
  const value = unitValue(localization);

  if (variations !== undefined) {
    const plural = object(variations.plural);
    const device = object(variations.device);

    if (plural !== undefined) {
      table.plurals[key] = pluralEntry(plural, source, key);
      return;
    }

    if (device !== undefined) {
      table.plurals[key] = deviceEntry(device, source, key);
      return;
    }

    throw unsupported(source, key, `the variations ${Object.keys(variations).join(', ')}`);
  }

  if (value === undefined) {
    return;
  }

  if (substitutions !== undefined) {
    table.plurals[key] = substitutionEntry(value, substitutions, source, key);
    return;
  }

  table.strings[key] = value;
}

function catalogLanguages(strings: Json, sourceLanguage: string): string[] {
  const languages = new Set<string>([sourceLanguage]);

  for (const entry of Object.values(strings)) {
    for (const language of Object.keys(object(object(entry)?.localizations) ?? {})) {
      languages.add(language);
    }
  }

  return [...languages].sort();
}

export function compileCatalog(catalog: unknown, source: string): CompiledTable[] {
  const root = object(catalog);
  const strings = object(root?.strings);
  const sourceLanguage = root?.sourceLanguage;

  if (strings === undefined || typeof sourceLanguage !== 'string') {
    throw new LipaError({
      code: 'config_invalid',
      message: `${source} is not a string catalog: it needs sourceLanguage and strings`,
    });
  }

  return catalogLanguages(strings, sourceLanguage).map((language) => {
    const table: CompiledTable = { language, strings: {}, plurals: {} };

    for (const [key, value] of Object.entries(strings)) {
      const localizations = object(object(value)?.localizations) ?? {};
      const localization = object(localizations[language]) ?? object(localizations[sourceLanguage]);

      if (localization !== undefined) {
        compileEntry(table, key, localization, source);
      }
    }

    return table;
  });
}

function writeTables(directory: string, name: string, tables: CompiledTable[]): void {
  for (const table of tables) {
    const folder = join(directory, `${table.language}.lproj`);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, `${name}.strings`), serializePlist(table.strings));

    if (Object.keys(table.plurals).length > 0) {
      writeFileSync(join(folder, `${name}.stringsdict`), serializePlist(table.plurals));
    }
  }
}

function catalogsIn(directory: string): string[] {
  const found: string[] = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) {
      found.push(...catalogsIn(path));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith('.xcstrings')) {
      found.push(path);
    }
  }

  return found;
}

export function compileCatalogsIn(bundle: string): string[] {
  if (!existsSync(bundle)) {
    return [];
  }

  const catalogs = catalogsIn(bundle);

  for (const path of catalogs) {
    const tables = compileCatalog(JSON.parse(readFileSync(path, 'utf8')), path);
    writeTables(join(path, '..'), basename(path, '.xcstrings'), tables);
    rmSync(path, { force: true });
  }

  return catalogs;
}
