import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const main = join(import.meta.dir, '..', 'src', 'main.ts');
const homes: string[] = [];

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'lipa-sdk-'));
  homes.push(home);

  return home;
}

function sdkBuild(home: string, sdk: string | undefined): { stdout: string; exitCode: number } {
  const env: Record<string, string> = {
    ...process.env,
    PATH: `${join(home, 'bin')}:${process.env.PATH ?? ''}`,
    LIPA_HOME: home,
    LIPA_TEST_PATH: join(home, 'path.txt'),
  } as Record<string, string>;

  if (sdk !== undefined) {
    env.LIPA_SDK = sdk;
  }

  const result = Bun.spawnSync(['bun', main, '--json', 'sdk', '--xcode', join(home, 'Xcode.app')], {
    env,
  });

  return { stdout: result.stdout.toString(), exitCode: result.exitCode };
}

afterAll(() => {
  for (const home of homes) {
    rmSync(home, { recursive: true, force: true });
  }
});

describe('sdk install', () => {
  test('puts the pinned toolchain on PATH for xtool', () => {
    const home = tempHome();
    const toolchain = join(home, 'tools', 'swift-6.4.1-RELEASE-ubuntu24.04');
    mkdirSync(join(toolchain, 'usr', 'bin'), { recursive: true });
    writeFileSync(join(toolchain, 'usr', 'bin', 'swiftc'), '');

    mkdirSync(join(home, 'bin'), { recursive: true });
    writeFileSync(
      join(home, 'bin', 'xtool'),
      '#!/bin/sh\nprintf \'%s\' "$PATH" > "$LIPA_TEST_PATH"\n',
    );
    chmodSync(join(home, 'bin', 'xtool'), 0o755);

    const sdk = join(home, 'sdk');
    const settings = join(
      sdk,
      'Developer',
      'Platforms',
      'iPhoneOS.platform',
      'Developer',
      'SDKs',
      'iPhoneOS27.0.sdk',
    );
    mkdirSync(settings, { recursive: true });
    writeFileSync(join(settings, 'SDKSettings.json'), JSON.stringify({ Version: '27.0' }));

    const result = sdkBuild(home, sdk);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).data.version).toBe('27.0');

    const entries = readFileSync(join(home, 'path.txt'), 'utf8').split(':');
    expect(entries[0]).toBe(join(toolchain, 'usr', 'bin'));
    expect(entries[1]).toBe(join(home, 'bin'));
  });

  test('fails before xtool when the toolchain is missing', () => {
    const home = tempHome();
    const result = sdkBuild(home, undefined);

    expect(result.exitCode).toBe(3);

    const envelope = JSON.parse(result.stdout);
    expect(envelope.error.code).toBe('capability_missing');
    expect(envelope.error.fix).toBe('Run lipa setup.');
  });
});
