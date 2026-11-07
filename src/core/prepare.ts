import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { LipaError } from '@/core/errors.ts';
import { requirePath, run } from '@/core/exec.ts';
import { acquireBuildLock } from '@/core/lock.ts';
import { type BuildValues, writePackage } from '@/core/package.ts';
import { paths } from '@/core/paths.ts';
import { checkPrebuilt, importPrebuilt, type PrebuiltStatus, staleError } from '@/core/prebuilt.ts';
import { fetchPrebuilt, type RemoteSource, remoteSource } from '@/core/remote.ts';
import { readSdk, type SdkInfo } from '@/core/sdk.ts';
import { signingStatus } from '@/core/signing.ts';
import { type BuildSpec, readSpec } from '@/core/spec.ts';
import { SWIFT, swiftToolchain, toolEnvironment, XTOOL } from '@/core/tools.ts';
import { resolveBuildNumber } from '@/core/version.ts';
import { shortHash } from '@/core/work.ts';

export type { BuildValues } from '@/core/package.ts';

export type MacSource = RemoteSource | { kind: 'import'; directory: string };

export function macSource(values: {
  mac?: string | undefined;
  via?: string | undefined;
  import?: string | undefined;
}): MacSource | undefined {
  const source = remoteSource({ mac: values.mac, via: values.via });

  if (source !== undefined && values.import !== undefined) {
    throw new LipaError({
      code: 'usage',
      message: 'Give either --mac <host>, --via <command> or --import <dir>',
      fix: '--import caches actool output produced elsewhere. --mac runs actool on the Mac.',
    });
  }

  if (values.import !== undefined) {
    return { kind: 'import', directory: values.import };
  }

  return source;
}

export type PrepareStep = 'clean' | 'update' | 'prebuilt' | 'compile';
export type PrebuiltAction = 'import' | 'refresh' | 'skip';

export interface PrepareState {
  prebuiltStale: boolean;
  mac: MacSource | undefined;
  workspaceExists: boolean;
  clean: boolean;
  update: boolean;
}

export interface PrepareDecision {
  steps: PrepareStep[];
  prebuilt: PrebuiltAction;
  cold: boolean;
}

export function preparePlan(state: PrepareState): PrepareDecision {
  let prebuilt: PrebuiltAction = 'skip';

  if (state.mac?.kind === 'import') {
    prebuilt = 'import';
  } else if (state.mac !== undefined && state.prebuiltStale) {
    prebuilt = 'refresh';
  }

  const steps: PrepareStep[] = [];

  if (state.clean) {
    steps.push('clean');
  }

  if (state.update && !state.clean) {
    steps.push('update');
  }

  if (prebuilt !== 'skip') {
    steps.push('prebuilt');
  }

  steps.push('compile');

  return { steps, prebuilt, cold: !state.workspaceExists || state.clean };
}

export function packageDirectory(spec: BuildSpec, sdkVersion: string): string {
  const toolchain = swiftToolchain();

  return join(
    paths().work,
    spec.bundleId,
    `package-${shortHash([...spec.sources, sdkVersion, toolchain, SWIFT.version, XTOOL.version])}`,
  );
}

export function workspaceWarm(directory: string, target: string): boolean {
  return (
    existsSync(join(directory, '.build')) || existsSync(join(directory, 'xtool', `${target}.app`))
  );
}

export interface PrepareInput {
  spec: BuildSpec;
  sdk: SdkInfo;
  values: BuildValues;
  mac?: MacSource | undefined;
  clean?: boolean | undefined;
  update?: boolean | undefined;
  stream?: boolean | undefined;
  configuration?: BuildConfiguration | undefined;
}

export interface PreparedWorkspace {
  steps: PrepareStep[];
  directory: string;
  xtoolApp: string;
  prebuilt: PrebuiltStatus;
  cold: boolean;
}

function tail(output: string): string {
  return output.trim().split('\n').slice(-15).join('\n');
}

export type BuildConfiguration = 'debug' | 'release';

export function buildConfiguration(
  value: string | undefined,
  fallback: BuildConfiguration,
): BuildConfiguration {
  if (value === undefined) {
    return fallback;
  }

  if (value === 'debug' || value === 'release') {
    return value;
  }

  throw new LipaError({
    code: 'usage',
    message: `Unknown configuration: ${value}`,
    fix: 'Use --configuration debug or --configuration release.',
  });
}

export async function compileWorkspace(
  directory: string,
  spec: BuildSpec,
  stream: boolean,
  configuration: BuildConfiguration = 'release',
): Promise<void> {
  const xtool = Bun.which('xtool') ?? join(paths().bin, 'xtool');
  requirePath(xtool, 'xtool', 'Run lipa setup.');

  const compiled = await run([xtool, 'dev', 'build', '--configuration', configuration], {
    cwd: directory,
    stdout: stream ? 'inherit' : 'pipe',
    stderr: stream ? 'inherit' : 'pipe',
    env: toolEnvironment(),
  });

  if (compiled.exitCode !== 0) {
    const detail = tail(compiled.stderr) || tail(compiled.stdout);

    throw new LipaError({
      code: 'generic',
      message: `xtool exited with ${compiled.exitCode}${detail === '' ? '' : `: ${detail}`}`,
    });
  }

  const app = join(directory, 'xtool', `${spec.target}.app`);

  if (!existsSync(app)) {
    throw new LipaError({ code: 'generic', message: `xtool did not produce ${app}` });
  }
}

export async function prepareWorkspace(input: PrepareInput): Promise<PreparedWorkspace> {
  const directory = packageDirectory(input.spec, input.sdk.version);
  let prebuilt = checkPrebuilt(input.spec, input.sdk.version);
  const decision = preparePlan({
    prebuiltStale: !prebuilt.ok,
    mac: input.mac,
    workspaceExists: workspaceWarm(directory, input.spec.target),
    clean: input.clean === true,
    update: input.update === true,
  });

  for (const step of decision.steps) {
    if (step === 'clean') {
      rmSync(directory, { recursive: true, force: true });
    }

    if (step === 'update') {
      rmSync(join(directory, 'Package.resolved'), { force: true });
    }

    if (step === 'prebuilt') {
      if (input.mac?.kind === 'import') {
        importPrebuilt(input.spec, input.mac.directory, input.sdk.version);
      } else if (input.mac !== undefined) {
        await fetchPrebuilt(input.spec, input.mac);
      }

      prebuilt = checkPrebuilt(input.spec, input.sdk.version);
    }
  }

  writePackage(directory, input.spec, input.values);
  await compileWorkspace(directory, input.spec, input.stream === true, input.configuration);

  return {
    steps: decision.steps,
    directory,
    xtoolApp: join(directory, 'xtool', `${input.spec.target}.app`),
    prebuilt,
    cold: decision.cold,
  };
}

export interface PrepareOptions {
  root: string;
  target?: string | undefined;
  clean?: boolean | undefined;
  update?: boolean | undefined;
  mac?: MacSource | undefined;
  stream?: boolean | undefined;
}

export interface PrepareResult {
  root: string;
  bundleId: string;
  target: string;
  sdk: string;
  workspace: string;
  steps: PrepareStep[];
  cold: boolean;
  prebuilt: {
    ok: boolean;
    xcodeVersion: string | undefined;
    sdkVersion: string | undefined;
    reason: string | undefined;
  };
  signing: { ok: boolean; reason: string | undefined; expires: string | undefined };
  seconds: number;
}

export async function prepareProject(options: PrepareOptions): Promise<PrepareResult> {
  const started = Date.now();
  const spec = readSpec(options.root, { target: options.target });
  const lock = acquireBuildLock(join(paths().work, spec.bundleId, 'build.lock'));

  try {
    const sdk = readSdk();
    const signing = await signingStatus(spec.team, spec.bundleId);
    const values: BuildValues = {
      version: spec.marketingVersion,
      build: resolveBuildNumber(undefined, spec, new Date()),
    };
    const prepared = await prepareWorkspace({
      spec,
      sdk,
      values,
      mac: options.mac,
      clean: options.clean,
      update: options.update,
      stream: options.stream,
    });

    if (!prepared.prebuilt.ok) {
      throw staleError(prepared.prebuilt, 'Run lipa prepare --mac <host> to refresh the cache.');
    }

    return {
      root: spec.root,
      bundleId: spec.bundleId,
      target: spec.target,
      sdk: sdk.version,
      workspace: prepared.directory,
      steps: prepared.steps,
      cold: prepared.cold,
      prebuilt: {
        ok: true,
        xcodeVersion: prepared.prebuilt.manifest?.xcodeVersion,
        sdkVersion: prepared.prebuilt.manifest?.sdkVersion,
        reason: undefined,
      },
      signing: { ok: signing.ok, reason: signing.reason, expires: signing.expires },
      seconds: Math.round((Date.now() - started) / 100) / 10,
    };
  } finally {
    lock.release();
  }
}
