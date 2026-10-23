import { describe, expect, test } from 'bun:test';
import { ipaOutput } from '@/core/build.ts';

describe('ipa output', () => {
  test('resolves a relative --out against the project root', () => {
    expect(ipaOutput('/app', 'build/App.ipa', 'App')).toBe('/app/build/App.ipa');
  });

  test('keeps an absolute --out', () => {
    expect(ipaOutput('/app', '/tmp/App.ipa', 'App')).toBe('/tmp/App.ipa');
  });

  test('defaults to build/App.ipa in the project', () => {
    expect(ipaOutput('/app', undefined, 'App')).toBe('/app/build/App.ipa');
  });
});
