import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { LipaError } from '@/core/errors.ts';
import { requirePath, run } from '@/core/exec.ts';
import { fileHash } from '@/core/hash.ts';
import { installTool, toolBinary, toolInstalled } from '@/core/install.ts';
import { paths } from '@/core/paths.ts';
import {
  downloadUrl,
  fetchAsset,
  fetchChecksums,
  latestRelease,
  type ReleaseInfo,
  releaseByTag,
} from '@/core/release.ts';
import { UV } from '@/core/tools.ts';
import { VERSION } from '@/version.ts';

export const DEVICE_ASSETS = ['lipa_device.py', 'requirements.txt'] as const;

export interface DevicePaths {
  directory: string;
  helper: string;
  requirements: string;
  python: string;
}

export function devicePaths(): DevicePaths {
  const directory = join(paths().tools, 'device');

  return {
    directory,
    helper: join(directory, 'lipa_device.py'),
    requirements: join(directory, 'requirements.txt'),
    python: join(directory, 'venv', 'bin', 'python3'),
  };
}

function checkoutDirectory(): string | undefined {
  const candidates = [
    process.env.LIPA_DEVICE_DIR,
    join(import.meta.dir, '..', '..', 'device'),
    join(import.meta.dir, '..', 'device'),
    join(process.cwd(), 'device'),
  ];

  for (const candidate of candidates) {
    if (candidate !== undefined && existsSync(join(candidate, 'lipa_device.py'))) {
      return candidate;
    }
  }

  return undefined;
}

async function releaseWithDeviceAssets(): Promise<ReleaseInfo> {
  if (VERSION === 'dev') {
    const latest = await latestRelease();
    const release = latest.release;

    if (release === undefined) {
      throw new LipaError({
        code: 'capability_missing',
        message: 'No release publishes the device helper, and no device folder is reachable',
        fix: 'Point LIPA_DEVICE_DIR at the device folder of a checkout, then run lipa setup --only device.',
      });
    }

    return release;
  }

  const found = await releaseByTag(`v${VERSION}`);

  if (found.release === undefined) {
    throw new LipaError({
      code: 'capability_missing',
      message: `The release v${VERSION} is missing or unreachable`,
      fix: 'Set LIPA_DEVICE_DIR to the device folder of a checkout, or install a released lipa.',
    });
  }

  return found.release;
}

async function installFromCheckout(directory: string, target: DevicePaths): Promise<string> {
  for (const name of DEVICE_ASSETS) {
    const source = join(directory, name);
    requirePath(source, name);
    writeFileSync(join(target.directory, name), readFileSync(source));
  }

  return `device helper from ${directory}`;
}

async function installFromRelease(target: DevicePaths): Promise<string> {
  const release = await releaseWithDeviceAssets();
  const checksums = await fetchChecksums(release);

  for (const name of DEVICE_ASSETS) {
    const asset = release.assets.find((entry) => entry.name === name);

    if (asset === undefined) {
      throw new LipaError({
        code: 'capability_missing',
        message: `The release ${release.tag} has no ${name}`,
        fix: 'Reinstall lipa from a release that publishes the device helper.',
      });
    }

    const response = await fetchAsset(downloadUrl(asset), 60_000);

    if (response?.ok !== true) {
      throw new LipaError({ code: 'capability_missing', message: `Cannot download ${name}` });
    }

    const body = new Uint8Array(await response.arrayBuffer());
    const path = join(target.directory, name);
    await Bun.write(path, body);
    const expected = checksums.get(name);
    const actual = fileHash(path);

    if (expected === undefined || expected !== actual) {
      throw new LipaError({
        code: 'capability_missing',
        message: `Checksum mismatch for ${name}`,
        details: { expected, actual },
      });
    }
  }

  return `device helper from ${release.tag}`;
}

export interface DeviceInstallResult {
  helper: string;
  python: string;
  steps: string[];
}

export interface DeviceReadiness {
  ok: boolean;
  reason?: string;
}

export function deviceReady(): DeviceReadiness {
  const target = devicePaths();

  if (!existsSync(target.helper) || !existsSync(target.requirements)) {
    return { ok: false, reason: 'the device helper is not installed' };
  }

  if (!existsSync(target.python)) {
    return { ok: false, reason: 'the device Python environment is not installed' };
  }

  return { ok: true };
}

export async function installDevice(): Promise<DeviceInstallResult> {
  const target = devicePaths();
  const steps: string[] = [];
  mkdirSync(target.directory, { recursive: true, mode: 0o700 });

  const checkout = checkoutDirectory();
  steps.push(
    checkout === undefined
      ? await installFromRelease(target)
      : await installFromCheckout(checkout, target),
  );

  if (!toolInstalled(UV)) {
    steps.push(await installTool(UV, false));
  }

  const uv = toolBinary(UV);

  if (!existsSync(target.python)) {
    const created = await run([uv, 'venv', '--python', '3.13', join(target.directory, 'venv')]);

    if (created.exitCode !== 0) {
      throw new LipaError({
        code: 'capability_missing',
        message: `uv venv failed: ${created.stderr.trim() || created.stdout.trim()}`,
        fix: 'Check the connection, uv downloads Python 3.13 on the first run.',
      });
    }

    steps.push('created the Python 3.13 environment');
  }

  const installed = await run([
    uv,
    'pip',
    'install',
    '--python',
    target.python,
    '--require-hashes',
    '--quiet',
    '-r',
    target.requirements,
  ]);

  if (installed.exitCode !== 0) {
    throw new LipaError({
      code: 'capability_missing',
      message: `Cannot install the device packages: ${installed.stderr.trim()}`,
      fix: 'Check the connection and run lipa setup --only device again.',
    });
  }

  chmodSync(target.helper, 0o755);
  steps.push('installed the device packages');

  return { helper: target.helper, python: target.python, steps };
}

export interface DeviceRunOptions {
  host: string;
  port?: string | undefined;
  udid: string;
  bundleId: string;
  ipa?: string | undefined;
  logs?: 'app' | 'all' | 'none' | undefined;
  stream?: boolean | undefined;
}

async function ensureDevice(stream: boolean): Promise<void> {
  if (deviceReady().ok) {
    return;
  }

  if (stream) {
    process.stdout.write('Installing the device helper\n');
  }

  await installDevice();
}

export async function runOnDevice(options: DeviceRunOptions): Promise<number> {
  await ensureDevice(options.stream === true);

  const target = devicePaths();

  const argv = [target.python, target.helper, '--host', options.host, '--udid', options.udid];

  if (options.port !== undefined) {
    argv.push('--port', options.port);
  }

  argv.push('--bundle-id', options.bundleId);

  if (options.ipa !== undefined) {
    argv.push('--ipa', options.ipa);
  }

  if (options.logs === 'none') {
    argv.push('--no-logs');
  } else if (options.logs === 'all') {
    argv.push('--logs', 'all');
  }

  if (options.stream !== true) {
    const result = await run(argv);
    const events = result.stdout
      .split('\n')
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    if (result.exitCode !== 0) {
      throw new LipaError({
        code: 'device_unreachable',
        message: `The device helper exited with ${result.exitCode}`,
        details: { events, stderr: result.stderr.trim() },
        fix: `Check that ${options.host} answers, that the device trusts this host, and that its VPN is up.`,
      });
    }

    return result.exitCode;
  }

  const child = Bun.spawn(argv, { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' });
  const code = await child.exited;

  if (code !== 0 && code !== 130) {
    throw new LipaError({
      code: 'device_unreachable',
      message: `The device helper exited with ${code}`,
      fix: `Check that ${options.host} answers, that the device trusts this host, and that its VPN is up.`,
    });
  }

  return code;
}
