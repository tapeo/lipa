import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { Check } from '@/core/checks.ts';
import { LipaError } from '@/core/errors.ts';
import { commandVersion } from '@/core/exec.ts';
import { checkMac } from '@/core/mac.ts';
import { paths } from '@/core/paths.ts';
import { checkPrebuilt } from '@/core/prebuilt.ts';
import { packageDirectory, workspaceWarm } from '@/core/prepare.ts';
import { readSdk } from '@/core/sdk.ts';
import { signingStatus } from '@/core/signing.ts';
import { readSpec } from '@/core/spec.ts';
import { swiftToolchain } from '@/core/tools.ts';

export type DoctorCheck = Check;

export interface DoctorResult {
  ok: boolean;
  checks: DoctorCheck[];
}

export interface DoctorOptions {
  mac?: string | undefined;
}

function toolCheck(name: string, path: string, version: string | undefined): DoctorCheck {
  return {
    name,
    ok: existsSync(path),
    detail: version ?? path,
  };
}

function detailOf(error: unknown): string {
  if (error instanceof LipaError) {
    return error.message;
  }

  return String(error);
}

function fixOf(error: unknown): string | undefined {
  if (error instanceof LipaError) {
    return error.fix;
  }

  return undefined;
}

async function projectChecks(root: string, sdkVersion: string): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const spec = readSpec(root);

  checks.push({
    name: 'project',
    ok: true,
    detail: `${spec.target} ${spec.marketingVersion}, ${spec.bundleId}, team ${spec.team}`,
  });

  const directory = packageDirectory(spec, sdkVersion);
  const warm = workspaceWarm(directory, spec.target);

  checks.push({
    name: 'workspace',
    ok: true,
    detail: warm ? `warm, ${directory}` : 'cold, run lipa prepare to compile before the next build',
  });

  const prebuilt = checkPrebuilt(spec, sdkVersion);

  checks.push({
    name: 'prebuilt',
    ok: prebuilt.ok,
    detail: prebuilt.ok
      ? `Xcode ${prebuilt.manifest?.xcodeVersion}, SDK ${prebuilt.manifest?.sdkVersion}`
      : (prebuilt.reason ?? 'stale'),
    fix: prebuilt.ok ? undefined : prebuilt.fix,
  });

  const signing = await signingStatus(spec.team, spec.bundleId);

  checks.push({
    name: 'signing',
    ok: signing.ok,
    detail: signing.ok ? `expires ${signing.expires?.slice(0, 10)}` : (signing.reason ?? ''),
    fix: signing.ok ? undefined : signing.fix,
  });

  return checks;
}

export async function doctor(
  root: string | undefined,
  options: DoctorOptions = {},
): Promise<DoctorResult> {
  const checks: DoctorCheck[] = [];
  const toolchain = swiftToolchain();

  checks.push(
    toolCheck(
      'swift',
      join(toolchain, 'usr', 'bin', 'swift'),
      await commandVersion([join(toolchain, 'usr', 'bin', 'swift'), '--version']),
    ),
  );

  const xtool = Bun.which('xtool') ?? join(paths().bin, 'xtool');
  checks.push(toolCheck('xtool', xtool, await commandVersion([xtool, '--version'])));

  const rcodesign = Bun.which('rcodesign') ?? join(paths().bin, 'rcodesign');
  checks.push(toolCheck('rcodesign', rcodesign, await commandVersion([rcodesign, '--version'])));

  for (const [name, hint] of [
    ['tar', 'apt install tar'],
    ['zip', 'apt install zip'],
    ['openssl', 'apt install openssl'],
    ['ssh', 'apt install openssh-client'],
  ] as const) {
    checks.push({ name, ok: Bun.which(name) !== null, detail: Bun.which(name) ?? hint });
  }

  let sdkVersion: string | undefined;

  try {
    const sdk = readSdk();
    sdkVersion = sdk.version;
    checks.push({ name: 'sdk', ok: true, detail: `iOS ${sdk.version}` });
  } catch (error) {
    checks.push({ name: 'sdk', ok: false, detail: detailOf(error), fix: fixOf(error) });
  }

  if (root !== undefined && existsSync(join(root, 'project.yml')) && sdkVersion !== undefined) {
    try {
      checks.push(...(await projectChecks(root, sdkVersion)));
    } catch (error) {
      checks.push({ name: 'project', ok: false, detail: detailOf(error), fix: fixOf(error) });
    }
  }

  if (options.mac !== undefined) {
    checks.push(...(await checkMac({ kind: 'ssh', host: options.mac }, sdkVersion)));
  } else {
    checks.push({
      name: 'mac',
      ok: true,
      skipped: true,
      detail: 'not checked, run lipa doctor --mac <host> to check the Mac',
    });
  }

  return { ok: checks.every((check) => check.ok), checks };
}
