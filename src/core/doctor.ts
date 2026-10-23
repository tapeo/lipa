import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { LipaError } from '@/core/errors.ts';
import { commandVersion } from '@/core/exec.ts';
import { paths } from '@/core/paths.ts';
import { checkPrebuilt } from '@/core/prebuilt.ts';
import { readSdk } from '@/core/sdk.ts';
import { signingStatus } from '@/core/signing.ts';
import { readSpec } from '@/core/spec.ts';
import { swiftToolchain } from '@/core/tools.ts';

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface DoctorResult {
  ok: boolean;
  checks: DoctorCheck[];
}

function toolCheck(name: string, path: string, version: string | undefined): DoctorCheck {
  return {
    name,
    ok: existsSync(path),
    detail: version ?? path,
  };
}

export async function doctor(root: string | undefined): Promise<DoctorResult> {
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
    checks.push({
      name: 'sdk',
      ok: false,
      detail: error instanceof LipaError ? error.message : String(error),
    });
  }

  if (root !== undefined && existsSync(join(root, 'project.yml')) && sdkVersion !== undefined) {
    try {
      const spec = readSpec(root);
      checks.push({
        name: 'project',
        ok: true,
        detail: `${spec.target} ${spec.marketingVersion}, ${spec.bundleId}, team ${spec.team}`,
      });

      const prebuilt = checkPrebuilt(spec, sdkVersion);
      checks.push({
        name: 'prebuilt',
        ok: prebuilt.ok,
        detail: prebuilt.ok
          ? `Xcode ${prebuilt.manifest?.xcodeVersion}, SDK ${prebuilt.manifest?.sdkVersion}`
          : (prebuilt.reason ?? 'stale'),
      });

      const signing = await signingStatus(spec.team, spec.bundleId);
      checks.push({
        name: 'signing',
        ok: signing.ok,
        detail: signing.ok ? `expires ${signing.expires?.slice(0, 10)}` : (signing.reason ?? ''),
      });
    } catch (error) {
      checks.push({
        name: 'project',
        ok: false,
        detail: error instanceof LipaError ? error.message : String(error),
      });
    }
  }

  return { ok: checks.every((check) => check.ok), checks };
}
