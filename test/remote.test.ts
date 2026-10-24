import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { checkMac } from '@/core/mac.ts';
import { prebuiltScript, remoteFailure } from '@/core/remote.ts';
import { readSpec } from '@/core/spec.ts';

const fixtures = join(import.meta.dir, '..', 'fixtures');

const home = mkdtempSync(join(tmpdir(), 'lipa-remote-'));
const originalPath = process.env.PATH ?? '';

afterAll(() => {
  process.env.PATH = originalPath;
  rmSync(home, { recursive: true, force: true });
});

function fakeSsh(script: string): string {
  const bin = mkdtempSync(join(home, 'bin-'));
  const path = join(bin, 'ssh');

  writeFileSync(path, `#!/bin/sh\n${script}\n`);
  chmodSync(path, 0o755);

  return bin;
}

describe('remoteFailure', () => {
  test('reports a Mac that ssh cannot reach', () => {
    const error = remoteFailure(
      { kind: 'ssh', host: 'macbook' },
      255,
      'ssh: connect to host macbook port 22: Connection refused',
    );

    expect(error.code).toBe('remote_unreachable');
    expect(error.message).toContain('macbook');
    expect(error.fix).toContain('lipa doctor --mac macbook');
  });

  test('reports Xcode that is not selected', () => {
    const error = remoteFailure(
      { kind: 'ssh', host: 'macbook' },
      1,
      "xcode-select: error: tool 'xcodebuild' requires Xcode, but active developer directory is a command line tools instance",
    );

    expect(error.code).toBe('capability_missing');
    expect(error.fix).toContain('xcode-select -s');
  });

  test('keeps a failing actool as a failed Mac command', () => {
    const error = remoteFailure(
      { kind: 'ssh', host: 'macbook' },
      65,
      'error: The app icon set named "AppIcon" did not have any applicable content.',
    );

    expect(error.code).toBe('remote_unreachable');
    expect(error.message).toContain('AppIcon');
  });

  test('points at the command itself for --via', () => {
    const error = remoteFailure({ kind: 'via', command: 'tunnel mac' }, 255, 'timed out');

    expect(error.fix).toContain('tunnel mac');
  });
});

describe('checkMac', () => {
  test('runs one non-interactive ssh and reads the probe', async () => {
    const bin = fakeSsh(
      [
        'printf "%s\\n" "$@" > "$LIPA_TEST_ARGS"',
        'printf "os 26.1\\n"',
        'printf "developer /Applications/Xcode.app/Contents/Developer\\n"',
        'printf "xcode Xcode 27.0|Build version 27A123\\n"',
        'printf "actool /usr/bin/actool\\n"',
        'printf "sdk 27.0\\n"',
      ].join('\n'),
    );
    const argsFile = join(home, 'args.txt');

    process.env.LIPA_TEST_ARGS = argsFile;
    process.env.PATH = `${bin}:${originalPath}`;

    const checks = await checkMac({ kind: 'ssh', host: 'macbook' }, '27.0');
    const argv = readFileSync(argsFile, 'utf8');

    expect(checks.every((check) => check.ok)).toBe(true);
    expect(argv).toContain('BatchMode=yes');
    expect(argv).toContain('ConnectTimeout=10');
    expect(argv).toContain('macbook');
  });

  test('turns an unreachable Mac into a failed check, not a throw', async () => {
    const bin = fakeSsh('echo "ssh: Could not resolve hostname macbook" >&2\nexit 255');

    process.env.PATH = `${bin}:${originalPath}`;

    const checks = await checkMac({ kind: 'ssh', host: 'macbook' }, '27.0');

    expect(checks).toHaveLength(1);
    expect(checks[0]?.name).toBe('mac');
    expect(checks[0]?.ok).toBe(false);
    expect(checks[0]?.detail).toContain('Cannot reach macbook');
  });
});

describe('prebuiltScript', () => {
  const spec = readSpec(fixtures);
  const script = prebuiltScript(spec);

  test('reads the catalog next to run.sh, not from a new temp dir', () => {
    expect(script).toContain('payload=$(cd "$(dirname "$0")" && pwd)');
    expect(script).toContain('"$payload/Assets.xcassets"');
    expect(script).not.toContain('$work/Assets.xcassets');
  });

  test('prints the actool log instead of dropping it', () => {
    expect(script).toContain('cat "$log" >&2');
    expect(script).not.toContain('>/dev/null\n');
  });
});
