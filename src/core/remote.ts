import { randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LipaError } from '@/core/errors.ts';
import { requireCommand } from '@/core/exec.ts';
import { treeHash } from '@/core/hash.ts';
import { type PlistValue, readPlist } from '@/core/plist.ts';
import { cacheDir, MAC_KEYS, writeManifest, writePrebuiltInfo } from '@/core/prebuilt.ts';
import type { BuildSpec } from '@/core/spec.ts';

export type RemoteSource = { kind: 'ssh'; host: string } | { kind: 'via'; command: string };

export function remoteSource(values: {
  mac?: string | undefined;
  via?: string | undefined;
}): RemoteSource | undefined {
  const { mac, via } = values;

  if (mac !== undefined && via !== undefined) {
    throw new LipaError({
      code: 'usage',
      message: 'Give either --mac <host> or --via <command>, not both',
      fix: 'Use --mac for a host reachable with ssh. --via replaces the ssh command.',
    });
  }

  if (mac !== undefined) {
    return { kind: 'ssh', host: mac };
  }

  if (via !== undefined) {
    return { kind: 'via', command: via };
  }

  return undefined;
}

export function remoteName(source: RemoteSource): string {
  if (source.kind === 'ssh') {
    return source.host;
  }

  return source.command;
}

function diagnose(source: RemoteSource): string {
  if (source.kind === 'ssh') {
    return `lipa doctor --mac ${source.host}`;
  }

  return `${source.command} sh -c true`;
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

const SSH_OPTIONS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10'];

function transportArgv(source: RemoteSource, command: string): string[] {
  if (source.kind === 'ssh') {
    return ['ssh', ...SSH_OPTIONS, source.host, command];
  }

  return ['sh', '-c', `${source.command} ${quote(command)}`];
}

const UNPACK_SCRIPT = [
  'set -eu',
  'root=$(mktemp -d)',
  'trap \'rm -rf "$root"\' EXIT',
  'tar -xf - -C "$root"',
  'sh "$root/run.sh"',
].join('\n');

function makeArchive(directory: string, archive: string): void {
  requireCommand('tar');
  const result = Bun.spawnSync(['tar', '-cf', archive, '-C', directory, '.']);

  if (result.exitCode !== 0) {
    throw new LipaError({
      code: 'generic',
      message: `tar failed: ${result.stderr.toString()}`,
    });
  }
}

function extractArchive(archive: string, directory: string): void {
  mkdirSync(directory, { recursive: true });
  const result = Bun.spawnSync(['tar', '-xf', archive, '-C', directory]);

  if (result.exitCode !== 0) {
    throw new LipaError({
      code: 'generic',
      message: `tar failed: ${result.stderr.toString()}`,
    });
  }
}

const UNREACHABLE =
  /permission denied|connection refused|connection timed out|operation timed out|host key verification|could not resolve hostname|no route to host|connection closed|broken pipe/i;
const BROKEN_XCODE =
  /xcode-select: error|requires xcode|not agreed to the xcode license|unable to find utility/i;

export function remoteFailure(source: RemoteSource, exitCode: number, stderr: string): LipaError {
  const name = remoteName(source);
  const detail = stderr.trim() || `exit ${exitCode}`;

  if (exitCode === 255 || UNREACHABLE.test(detail)) {
    return new LipaError({
      code: 'remote_unreachable',
      message: `Cannot reach ${name}: ${detail}`,
      fix: `Check that the Mac is awake and that ssh ${name} works without a password. Then run lipa doctor --mac ${name}.`,
    });
  }

  if (BROKEN_XCODE.test(detail)) {
    return new LipaError({
      code: 'capability_missing',
      message: `The Mac cannot run the Xcode tools: ${detail}`,
      fix: 'On the Mac run sudo xcode-select -s /Applications/Xcode.app and sudo xcodebuild -license accept, then run lipa doctor --mac <host>.',
    });
  }

  return new LipaError({
    code: 'remote_unreachable',
    message: `The command on ${name} failed: ${detail}`,
    fix: `Check the Mac with ${diagnose(source)}.`,
  });
}

export interface RemoteRun {
  command: string;
  stdin: string | undefined;
  output: string;
}

async function remote(source: RemoteSource, options: RemoteRun): Promise<void> {
  const child = Bun.spawn({
    cmd: transportArgv(source, options.command),
    stdin: options.stdin === undefined ? 'ignore' : Bun.file(options.stdin),
    stdout: Bun.file(options.output),
    stderr: 'pipe',
    env: process.env,
  });

  const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited]);

  if (exitCode !== 0) {
    throw remoteFailure(source, exitCode, stderr);
  }
}

export async function remoteCapture(source: RemoteSource, command: string): Promise<string> {
  const output = join(tmpdir(), `lipa-remote-${randomUUID()}`);

  try {
    await remote(source, { command, stdin: undefined, output });
    return readFileSync(output, 'utf8');
  } finally {
    rmSync(output, { force: true });
  }
}

function deviceFlags(families: string[]): string {
  const flags = ['--target-device iphone'];

  if (families.includes('2')) {
    flags.push('--target-device ipad');
  }

  return flags.join(' ');
}

export function prebuiltScript(spec: BuildSpec): string {
  const lines = [
    'set -eu',
    'out=$(mktemp -d)',
    'log=$(mktemp)',
    'trap \'rm -rf "$out" "$log"\' EXIT',
    'payload=$(cd "$(dirname "$0")" && pwd)',
    'xcrun actool --compile "$out" --platform iphoneos \\',
    `  --minimum-deployment-target ${quote(spec.minimumIOS)} \\`,
  ];

  if (spec.appIcon !== undefined) {
    lines.push(`  --app-icon ${quote(spec.appIcon)} \\`);
  }

  if (spec.accentColor !== undefined) {
    lines.push(`  --accent-color ${quote(spec.accentColor)} \\`);
  }

  lines.push(
    `  ${deviceFlags(spec.deviceFamilies)} \\`,
    '  --output-partial-info-plist "$out/Info.plist" --output-format human-readable-text \\',
    '  "$payload/Assets.xcassets" >"$log" 2>&1 || {',
    '  cat "$log" >&2',
    '  exit 1',
    '}',
    'plist="$out/Info.plist"',
    '[ -f "$plist" ] || printf \'<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict/></plist>\' >"$plist"',
    "xcode_version=$(xcodebuild -version | sed -n 1p | sed 's/^Xcode //')",
    "xcode_build=$(xcodebuild -version | sed -n 's/^Build version //p')",
    'xcode_number=$(printf \'%d%02d\' "$(printf \'%s\' "$xcode_version" | cut -d. -f1)" "$(printf \'%s\' "$xcode_version" | cut -d. -f2)")',
    'sdk_version=$(xcrun --sdk iphoneos --show-sdk-version)',
    'sdk_build=$(xcrun --sdk iphoneos --show-sdk-build-version)',
    'os_build=$(sw_vers -buildVersion)',
    'set_key() { /usr/libexec/PlistBuddy -c "Delete :$1" "$plist" >/dev/null 2>&1 || true; /usr/libexec/PlistBuddy -c "Add :$1 string $2" "$plist"; }',
    'set_key DTCompiler com.apple.compilers.llvm.clang.1_0',
    'set_key DTPlatformBuild "$sdk_build"',
    'set_key DTSDKBuild "$sdk_build"',
    'set_key DTPlatformName iphoneos',
    'set_key DTPlatformVersion "$sdk_version"',
    'set_key DTSDKName "iphoneos$sdk_version"',
    'set_key DTXcode "$xcode_number"',
    'set_key DTXcodeBuild "$xcode_build"',
    'set_key BuildMachineOSBuild "$os_build"',
    'tar -cf - -C "$out" .',
  );

  return lines.join('\n');
}

export interface PrebuiltResult {
  bundleId: string;
  assetsHash: string;
  xcodeVersion: string;
  sdkVersion: string;
  files: string[];
}

export async function fetchPrebuilt(
  spec: BuildSpec,
  source: RemoteSource,
): Promise<PrebuiltResult> {
  if (spec.assets === undefined) {
    throw new LipaError({
      code: 'config_invalid',
      message: `${spec.root}/project.yml has no .xcassets in the target sources`,
      fix: 'Add the asset catalog to sources.',
    });
  }

  requireCommand('tar');
  const work = join(tmpdir(), `lipa-prebuilt-${Date.now()}`);
  const payloadDirectory = join(work, 'payload');

  try {
    mkdirSync(payloadDirectory, { recursive: true });
    cpSync(spec.assets, join(payloadDirectory, 'Assets.xcassets'), { recursive: true });
    writeFileSync(join(payloadDirectory, 'run.sh'), prebuiltScript(spec));

    const payload = join(work, 'payload.tar');
    const archive = join(work, 'result.tar');
    makeArchive(payloadDirectory, payload);
    await remote(source, { command: UNPACK_SCRIPT, stdin: payload, output: archive });

    const extracted = join(work, 'result');
    extractArchive(archive, extracted);

    const info = readPlist(join(extracted, 'Info.plist'));
    const values: { [key: string]: PlistValue } = {};

    for (const key of MAC_KEYS) {
      const value = info[key];

      if (value === undefined) {
        throw new LipaError({
          code: 'capability_missing',
          message: `The Mac did not report ${key}`,
          fix: 'Check that xcode-select points at Xcode and that actool succeeds.',
        });
      }

      values[key] = value;
    }

    const directory = cacheDir(spec.bundleId);
    rmSync(directory, { recursive: true, force: true });
    mkdirSync(directory, { recursive: true });
    cpSync(extracted, directory, { recursive: true });
    writePrebuiltInfo(spec.bundleId, values);

    const manifest = {
      bundleId: spec.bundleId,
      assetsHash: treeHash(spec.assets),
      xcodeVersion: String(values.DTXcodeBuild),
      sdkVersion: String(values.DTPlatformVersion),
      createdAt: new Date().toISOString(),
      source: remoteName(source),
    };
    writeManifest(manifest);

    return {
      bundleId: spec.bundleId,
      assetsHash: manifest.assetsHash,
      xcodeVersion: manifest.xcodeVersion,
      sdkVersion: manifest.sdkVersion,
      files: readdirSync(directory),
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export async function pullXcode(
  source: RemoteSource,
  remoteXcode: string,
  destination: string,
): Promise<void> {
  requireCommand('tar');
  const parent = join(remoteXcode, '..');
  const name = remoteXcode.split('/').filter(Boolean).at(-1) ?? 'Xcode.app';
  const script = ['set -eu', `tar -cf - -C ${quote(parent)} ${quote(name)}`].join('\n');

  await remote(source, { command: script, stdin: undefined, output: destination });
}
