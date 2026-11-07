import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LipaError } from '@/core/errors.ts';
import { readPlist } from '@/core/plist.ts';
import { compileCatalog, compileCatalogsIn } from '@/core/strings.ts';

const roots: string[] = [];

afterEach(() => {
  for (const directory of roots.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function unit(value: string): { stringUnit: { state: string; value: string } } {
  return { stringUnit: { state: 'translated', value } };
}

const catalog = {
  sourceLanguage: 'en',
  version: '1.0',
  strings: {
    Hello: { localizations: { it: unit('Ciao'), de: unit('Hallo') } },
    'Only English': { localizations: { en: unit('Only English text') } },
    '%lld files': {
      localizations: {
        it: {
          variations: {
            plural: { one: unit('%lld file'), other: unit('%lld file') },
          },
        },
      },
    },
    Tap: {
      localizations: {
        en: {
          variations: {
            device: { iphone: unit('Tap'), mac: unit('Click'), other: unit('Tap') },
          },
        },
      },
    },
    'Found %lld items in %@': {
      localizations: {
        en: {
          stringUnit: { state: 'translated', value: 'Found %#@items@ in %2$@' },
          substitutions: {
            items: {
              argNum: 1,
              formatSpecifier: 'lld',
              variations: { plural: { one: unit('%arg item'), other: unit('%arg items') } },
            },
          },
        },
      },
    },
  },
};

function table(language: string) {
  return compileCatalog(catalog, 'Localizable.xcstrings').find(
    (item) => item.language === language,
  );
}

describe('compileCatalog', () => {
  test('makes one table per language, the source language included', () => {
    const languages = compileCatalog(catalog, 'Localizable.xcstrings').map((item) => item.language);

    expect(languages).toEqual(['de', 'en', 'it']);
  });

  test('writes the translated strings of each language', () => {
    expect(table('it')?.strings.Hello).toBe('Ciao');
    expect(table('de')?.strings.Hello).toBe('Hallo');
  });

  test('falls back to the source language when a translation is missing', () => {
    expect(table('it')?.strings['Only English']).toBe('Only English text');
  });

  test('leaves out a key with no value in the language or the source', () => {
    expect(table('en')?.strings.Hello).toBeUndefined();
  });

  test('turns a plural variation into a stringsdict rule', () => {
    const entry = table('it')?.plurals['%lld files'] as {
      NSStringLocalizedFormatKey: string;
      value: Record<string, string>;
    };

    expect(entry.NSStringLocalizedFormatKey).toBe('%#@value@');
    expect(entry.value.NSStringFormatSpecTypeKey).toBe('NSStringPluralRuleType');
    expect(entry.value.NSStringFormatValueTypeKey).toBe('lld');
    expect(entry.value.one).toBe('%lld file');
  });

  test('turns a device variation into a device rule', () => {
    const entry = table('en')?.plurals.Tap as Record<string, Record<string, string>>;

    expect(entry.NSStringDeviceSpecificRuleType?.mac).toBe('Click');
  });

  test('numbers the argument of a substitution', () => {
    const entry = table('en')?.plurals['Found %lld items in %@'] as {
      NSStringLocalizedFormatKey: string;
      items: Record<string, string>;
    };

    expect(entry.NSStringLocalizedFormatKey).toBe('Found %1$#@items@ in %2$@');
    expect(entry.items.other).toBe('%1$lld items');
  });

  test('refuses a variation it cannot compile', () => {
    const nested = {
      sourceLanguage: 'en',
      strings: {
        Key: {
          localizations: {
            en: { variations: { device: { iphone: { variations: { plural: {} } } } } },
          },
        },
      },
    };

    expect(() => compileCatalog(nested, 'Nested.xcstrings')).toThrow(LipaError);
  });

  test('refuses a file that is not a catalog', () => {
    expect(() => compileCatalog({ strings: {} }, 'Broken.xcstrings')).toThrow(LipaError);
  });
});

describe('compileCatalogsIn', () => {
  test('replaces every catalog of a bundle with lproj tables', () => {
    const bundle = mkdtempSync(join(tmpdir(), 'lipa-strings-'));
    const nested = join(bundle, 'PlugIns', 'Share.appex');
    roots.push(bundle);
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(bundle, 'Localizable.xcstrings'), JSON.stringify(catalog));
    writeFileSync(join(nested, 'InfoPlist.xcstrings'), JSON.stringify(catalog));

    const compiled = compileCatalogsIn(bundle);

    expect(compiled).toHaveLength(2);
    expect(existsSync(join(bundle, 'Localizable.xcstrings'))).toBe(false);
    expect(readPlist(join(bundle, 'it.lproj', 'Localizable.strings')).Hello).toBe('Ciao');
    expect(existsSync(join(bundle, 'it.lproj', 'Localizable.stringsdict'))).toBe(true);
    expect(existsSync(join(bundle, 'en.lproj', 'Localizable.strings'))).toBe(true);
    expect(readPlist(join(nested, 'de.lproj', 'InfoPlist.strings')).Hello).toBe('Hallo');
  });
});
