import { describe, expect, test } from 'bun:test';

import { resolveBuildNumber, utcBuildNumber } from '@/core/version.ts';

const now = new Date('2026-10-24T07:00:26Z');

describe('utcBuildNumber', () => {
  test('writes the UTC time as one number', () => {
    expect(utcBuildNumber(now)).toBe('20261024070026');
  });

  test('pads every field to two digits', () => {
    expect(utcBuildNumber(new Date('2027-01-02T03:04:05Z'))).toBe('20270102030405');
  });
});

describe('resolveBuildNumber', () => {
  test('lets --build win over the project', () => {
    expect(resolveBuildNumber('42', { currentProjectVersion: '5' }, now)).toBe('42');
  });

  test('uses CURRENT_PROJECT_VERSION when --build is absent', () => {
    expect(resolveBuildNumber(undefined, { currentProjectVersion: '5' }, now)).toBe('5');
  });

  test('falls back to a timestamp when the project has no build number', () => {
    expect(resolveBuildNumber(undefined, { currentProjectVersion: undefined }, now)).toBe(
      '20261024070026',
    );
  });
});
