import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

const main = join(import.meta.dir, '..', 'src', 'main.ts');

function lipa(args: string[]): { stdout: string; exitCode: number } {
  const result = Bun.spawnSync(['bun', main, ...args], { env: { ...process.env, NO_COLOR: '1' } });

  return { stdout: result.stdout.toString(), exitCode: result.exitCode };
}

describe('cli', () => {
  test('answers --version as JSON', () => {
    const result = lipa(['--json', '--version']);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ ok: true, data: { version: 'dev' } });
  });

  test('prints an overview without a command', () => {
    const result = lipa([]);

    expect(result.stdout).toContain('Build a signed iOS app on Linux.');
    expect(result.stdout).toContain('prepare');
  });

  test('exits with 2 on an unknown command', () => {
    const result = lipa(['--json', 'nope']);

    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stdout).error.code).toBe('usage');
  });

  test('documents the actions of a command', () => {
    const result = lipa(['signing', '--help']);

    expect(result.stdout).toContain('Import a signing certificate');
  });

  test('documents the transport flags of prepare', () => {
    const result = lipa(['prepare', '--help']);

    expect(result.stdout).toContain('--mac');
    expect(result.stdout).toContain('--import');
  });

  test('rejects --mac together with --via', () => {
    const result = lipa(['--json', 'prepare', '--mac', 'macbook', '--via', 'ssh macbook']);

    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stdout).error.code).toBe('usage');
  });

  test('rejects --import together with --mac', () => {
    const result = lipa(['--json', 'prepare', '--mac', 'macbook', '--import', '/tmp/assets']);

    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stdout).error.code).toBe('usage');
  });

  test('asks for a transport in sdk', () => {
    const result = lipa(['--json', 'sdk']);

    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stdout).error.fix).toContain('lipa sdk --xcode');
  });

  test('documents the flags of update', () => {
    const result = lipa(['update', '--help']);

    expect(result.stdout).toContain('--check');
    expect(result.stdout).toContain('--version');
    expect(result.stdout).toContain('--force');
  });

  test('refuses to replace a run from the source tree', () => {
    const result = lipa(['--json', 'update']);

    expect(result.exitCode).toBe(3);
    expect(JSON.parse(result.stdout).error.code).toBe('capability_missing');
  });

  test('documents the signing kind of build', () => {
    const result = lipa(['build', '--help']);

    expect(result.stdout).toContain('--signing');
  });

  test('asks for a device in run', () => {
    const result = lipa(['--json', 'run']);

    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stdout).error.fix).toContain('lipa run --device');
  });

  test('documents the flags of run', () => {
    const result = lipa(['run', '--help']);

    expect(result.stdout).toContain('--device');
    expect(result.stdout).toContain('--logs');
  });

  test('reads the version flag of update, not the global one', () => {
    const result = lipa(['--json', 'update', '--version', '0.2.1']);

    expect(result.exitCode).toBe(3);
    expect(JSON.parse(result.stdout).error.message).toContain('source tree');
  });
});
