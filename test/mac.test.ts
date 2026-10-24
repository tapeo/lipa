import { describe, expect, test } from 'bun:test';

import { type MacProbe, parseProbe, probeChecks } from '@/core/mac.ts';

const source = { kind: 'ssh', host: 'macbook' } as const;

const probe: MacProbe = {
  os: '26.1',
  developer: '/Applications/Xcode.app/Contents/Developer',
  xcode: 'Xcode 27.0\nBuild version 27A123',
  actool: '/Applications/Xcode.app/Contents/Developer/usr/bin/actool',
  sdk: '27.0',
};

function names(checks: ReturnType<typeof probeChecks>): string[] {
  return checks.map((check) => check.name);
}

describe('parseProbe', () => {
  test('reads the five fields, including the two lines of xcodebuild', () => {
    const output = [
      'os 26.1',
      'developer /Applications/Xcode.app/Contents/Developer',
      'xcode Xcode 27.0|Build version 27A123',
      'actool /usr/bin/actool',
      'sdk 27.0',
      '',
    ].join('\n');

    expect(parseProbe(output)).toEqual({
      os: '26.1',
      developer: '/Applications/Xcode.app/Contents/Developer',
      xcode: 'Xcode 27.0\nBuild version 27A123',
      actool: '/usr/bin/actool',
      sdk: '27.0',
    });
  });

  test('copes with a silent Mac', () => {
    expect(parseProbe('')).toEqual({ os: '', developer: '', xcode: '', actool: '', sdk: '' });
  });
});

describe('probeChecks', () => {
  test('passes a Mac that has Xcode and the same SDK', () => {
    const checks = probeChecks(source, probe, '27.0');

    expect(names(checks)).toEqual(['mac', 'xcode', 'xcode-select', 'actool', 'mac-sdk']);
    expect(checks.every((check) => check.ok)).toBe(true);
  });

  test('reports a license that is not accepted', () => {
    const checks = probeChecks(
      source,
      {
        ...probe,
        xcode:
          'You have not agreed to the Xcode license agreements. Please run sudo xcodebuild -license.',
      },
      '27.0',
    );
    const xcode = checks.find((check) => check.name === 'xcode');

    expect(xcode?.ok).toBe(false);
    expect(xcode?.detail).toContain('license');
    expect(xcode?.fix).toContain('xcodebuild -license accept');
  });

  test('reports the Command Line Tools as the selected developer directory', () => {
    const checks = probeChecks(
      source,
      { ...probe, developer: '/Library/Developer/CommandLineTools' },
      '27.0',
    );
    const selected = checks.find((check) => check.name === 'xcode-select');

    expect(selected?.ok).toBe(false);
    expect(selected?.fix).toContain('xcode-select -s');
  });

  test('reports an SDK that differs from the one lipa links against', () => {
    const checks = probeChecks(source, { ...probe, sdk: '26.0' }, '27.0');
    const sdk = checks.find((check) => check.name === 'mac-sdk');

    expect(sdk?.ok).toBe(false);
    expect(sdk?.detail).toContain('27.0');
    expect(sdk?.fix).toContain('lipa sdk --mac macbook');
  });

  test('reports actool when the iOS platform is missing', () => {
    const checks = probeChecks(
      source,
      { ...probe, actool: 'xcrun: error: unable to find utility "actool"' },
      '27.0',
    );
    const actool = checks.find((check) => check.name === 'actool');

    expect(actool?.ok).toBe(false);
    expect(actool?.fix).toContain('xcodebuild -runFirstLaunch');
  });
});
