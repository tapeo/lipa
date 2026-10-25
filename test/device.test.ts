import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { devicePaths, deviceReady } from '@/core/device.ts';

const homes: string[] = [];

function scratchHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'lipa-device-'));
  homes.push(home);
  process.env.LIPA_HOME = home;

  return home;
}

afterEach(() => {
  delete process.env.LIPA_HOME;

  for (const home of homes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

describe('devicePaths', () => {
  test('keeps the helper in the lipa home', () => {
    const home = scratchHome();
    const target = devicePaths();

    expect(target.directory).toBe(join(home, 'tools', 'device'));
    expect(target.python).toBe(join(home, 'tools', 'device', 'venv', 'bin', 'python3'));
  });
});

describe('deviceReady', () => {
  test('reports a missing helper', () => {
    scratchHome();
    const readiness = deviceReady();

    expect(readiness.ok).toBe(false);
    expect(readiness.reason).toContain('helper');
  });

  test('reports a missing Python environment', () => {
    scratchHome();
    const target = devicePaths();
    mkdirSync(target.directory, { recursive: true });
    writeFileSync(target.helper, '#!/usr/bin/env python3\n');
    writeFileSync(target.requirements, 'pymobiledevice3==11.44.0\n');

    const readiness = deviceReady();

    expect(readiness.ok).toBe(false);
    expect(readiness.reason).toContain('Python');
  });

  test('is ready with the helper and the environment', () => {
    scratchHome();
    const target = devicePaths();
    mkdirSync(join(target.directory, 'venv', 'bin'), { recursive: true });
    writeFileSync(target.helper, '#!/usr/bin/env python3\n');
    writeFileSync(target.requirements, 'pymobiledevice3==11.44.0\n');
    writeFileSync(target.python, '');

    expect(deviceReady().ok).toBe(true);
  });
});
