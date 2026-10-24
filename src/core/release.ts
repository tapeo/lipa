import { chmodSync, realpathSync, renameSync, rmSync } from 'node:fs';

import { LipaError } from '@/core/errors.ts';
import { fileHash } from '@/core/hash.ts';

export const REPO = process.env.LIPA_REPO ?? 'tapeo/lipa';

export function releasesApi(repo = REPO): string {
  return `https://api.github.com/repos/${repo}/releases`;
}

export function authHeaders(): Record<string, string> {
  const token = process.env.GITHUB_TOKEN;

  if (token === undefined || token === '') {
    return {};
  }

  return { authorization: `Bearer ${token}` };
}

export interface ReleaseAsset {
  name: string;
  url: string;
  api_url?: string | undefined;
}

export interface ReleaseInfo {
  tag: string;
  version: string;
  assets: ReleaseAsset[];
}

export function downloadUrl(asset: ReleaseAsset): string {
  const token = process.env.GITHUB_TOKEN;

  if (token !== undefined && token !== '' && asset.api_url !== undefined) {
    return asset.api_url;
  }

  return asset.url;
}

export function assetNameFor(platform: NodeJS.Platform, arch: string): string {
  if (platform !== 'linux') {
    throw new LipaError({
      code: 'capability_missing',
      message: `lipa publishes Linux binaries only, this machine is ${platform}`,
      fix: 'Build lipa from a checkout with bun run bin.',
    });
  }

  if (arch !== 'x64' && arch !== 'arm64') {
    throw new LipaError({
      code: 'capability_missing',
      message: `lipa publishes x64 and arm64 binaries only, this machine is ${arch}`,
      fix: 'Build lipa from a checkout with bun run bin.',
    });
  }

  return `lipa-linux-${arch}`;
}

export function parseVersion(value: string): string {
  return value.replace(/^v/, '');
}

export interface Semver {
  numbers: [number, number, number];
  prerelease: string | undefined;
}

export function parseSemver(value: string): Semver {
  const [core = '', ...rest] = parseVersion(value).trim().split('-');
  const parts = core.split('.');
  const numberAt = (index: number): number => {
    const parsed = Number(parts[index] ?? '0');
    return Number.isFinite(parsed) ? parsed : 0;
  };

  return {
    numbers: [numberAt(0), numberAt(1), numberAt(2)],
    prerelease: rest.length === 0 ? undefined : rest.join('-'),
  };
}

export function isNewer(candidate: string, current: string): boolean {
  const left = parseSemver(candidate);
  const right = parseSemver(current);

  for (let index = 0; index < 3; index += 1) {
    const leftNumber = left.numbers[index] ?? 0;
    const rightNumber = right.numbers[index] ?? 0;

    if (leftNumber > rightNumber) {
      return true;
    }

    if (leftNumber < rightNumber) {
      return false;
    }
  }

  if (right.prerelease !== undefined && left.prerelease === undefined) {
    return true;
  }

  if (left.prerelease !== undefined && right.prerelease !== undefined) {
    return left.prerelease > right.prerelease;
  }

  return false;
}

interface ReleaseBody {
  tag_name?: string;
  assets?: Array<{ name?: string; browser_download_url?: string; url?: string }>;
}

function releaseFromBody(body: ReleaseBody): ReleaseInfo | undefined {
  if (typeof body.tag_name !== 'string') {
    return undefined;
  }

  return {
    tag: body.tag_name,
    version: parseVersion(body.tag_name),
    assets: (body.assets ?? [])
      .filter(
        (asset) => typeof asset.name === 'string' && typeof asset.browser_download_url === 'string',
      )
      .map((asset) => ({
        name: String(asset.name),
        url: String(asset.browser_download_url),
        api_url: typeof asset.url === 'string' ? asset.url : undefined,
      })),
  };
}

async function releasesFetch(url: string): Promise<Response | undefined> {
  return fetch(url, {
    headers: { accept: 'application/vnd.github+json', ...authHeaders() },
    signal: AbortSignal.timeout(20_000),
  }).catch(() => undefined);
}

export interface LatestRelease {
  release?: ReleaseInfo | undefined;
  reason?: 'no_releases' | 'unreachable';
}

export interface TaggedRelease {
  release?: ReleaseInfo | undefined;
  reason?: 'not_found' | 'unreachable';
}

export async function latestRelease(repo = REPO): Promise<LatestRelease> {
  const response = await releasesFetch(`${releasesApi(repo)}/latest`);

  if (response === undefined) {
    return { reason: 'unreachable' };
  }

  if (response.status === 404) {
    return { reason: 'no_releases' };
  }

  if (!response.ok) {
    return { reason: 'unreachable' };
  }

  const release = releaseFromBody((await response.json()) as ReleaseBody);

  return release === undefined ? { reason: 'no_releases' } : { release };
}

export async function releaseByTag(tag: string, repo = REPO): Promise<TaggedRelease> {
  const response = await releasesFetch(`${releasesApi(repo)}/tags/${encodeURIComponent(tag)}`);

  if (response === undefined) {
    return { reason: 'unreachable' };
  }

  if (response.status === 404) {
    return { reason: 'not_found' };
  }

  if (!response.ok) {
    return { reason: 'unreachable' };
  }

  const release = releaseFromBody((await response.json()) as ReleaseBody);

  return release === undefined ? { reason: 'not_found' } : { release };
}

export async function fetchChecksums(release: ReleaseInfo): Promise<Map<string, string>> {
  const asset = release.assets.find((entry) => entry.name === 'checksums.txt');

  if (asset === undefined) {
    throw new LipaError({
      code: 'generic',
      message: `The release ${release.tag} has no checksums.txt`,
      fix: `The release is incomplete: report it at https://github.com/${REPO}/issues`,
    });
  }

  const response = await fetchAsset(downloadUrl(asset), 20_000);

  if (response?.ok !== true) {
    throw new LipaError({
      code: 'generic',
      message: `Cannot download the checksums of ${release.tag}`,
      fix: 'Check the connection and the token, then run lipa update again.',
    });
  }

  return parseChecksums(await response.text());
}

export function parseChecksums(text: string): Map<string, string> {
  const checksums = new Map<string, string>();

  for (const line of text.split('\n')) {
    const parts = line.trim().split(/\s+/);
    const hash = parts[0];
    const name = parts.at(-1)?.replace(/^\*/, '');

    if (hash === undefined || hash === '' || name === undefined || name === '') {
      continue;
    }

    checksums.set(name, hash);
  }

  return checksums;
}

export async function fetchAsset(url: string, timeoutMs: number): Promise<Response | undefined> {
  const headers = { ...authHeaders(), accept: 'application/octet-stream' };
  const first = await fetch(url, {
    headers,
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs),
  }).catch(() => undefined);

  if (first === undefined) {
    return undefined;
  }

  if (first.status >= 300 && first.status < 400) {
    const location = first.headers.get('location');

    if (location === null) {
      return undefined;
    }

    return fetch(location, { signal: AbortSignal.timeout(timeoutMs) }).catch(() => undefined);
  }

  return first;
}

export interface DownloadResult {
  path: string;
  version: string;
}

export async function downloadReleaseBinary(options: {
  release: ReleaseInfo;
  platform: NodeJS.Platform;
  arch: string;
  currentBinary: string;
}): Promise<DownloadResult> {
  const assetName = assetNameFor(options.platform, options.arch);
  const asset = options.release.assets.find((entry) => entry.name === assetName);

  if (asset === undefined) {
    throw new LipaError({
      code: 'generic',
      message: `The release ${options.release.tag} has no asset for this machine (${assetName})`,
      fix: 'Download it by hand from the releases page.',
    });
  }

  const response = await fetchAsset(downloadUrl(asset), 120_000);

  if (response?.ok !== true) {
    throw new LipaError({
      code: 'generic',
      message: `Cannot download ${assetName}`,
      fix: 'Check the connection and the token, then run lipa update again.',
    });
  }

  const content = new Uint8Array(await response.arrayBuffer());
  const checksums = await fetchChecksums(options.release);
  const expected = checksums.get(assetName);

  if (expected === undefined) {
    throw new LipaError({
      code: 'generic',
      message: `The checksums of ${options.release.tag} do not cover ${assetName}`,
      fix: `The release is incomplete: report it at https://github.com/${REPO}/issues`,
    });
  }

  const temporary = `${options.currentBinary}.new`;

  try {
    await Bun.write(temporary, content);
  } catch (error) {
    throw new LipaError({
      code: 'capability_missing',
      message: `Cannot write ${temporary}: ${error instanceof Error ? error.message : String(error)}`,
      fix: 'Move the binary to a directory your user can write, or install it again with install.sh.',
    });
  }

  const actual = fileHash(temporary);

  if (actual !== expected) {
    rmSync(temporary, { force: true });

    throw new LipaError({
      code: 'generic',
      message: `Checksum mismatch for ${assetName}`,
      fix: 'Download it again; if it keeps failing, report it.',
      details: { expected, actual },
    });
  }

  chmodSync(temporary, 0o755);

  return { path: temporary, version: options.release.version };
}

export function replaceBinary(currentBinary: string, downloaded: string): void {
  const backup = `${currentBinary}.old`;
  let moved = false;

  try {
    rmSync(backup, { force: true });
    renameSync(currentBinary, backup);
    moved = true;
  } catch {}

  try {
    renameSync(downloaded, currentBinary);
  } catch (error) {
    if (moved) {
      try {
        renameSync(backup, currentBinary);
      } catch {
        throw new LipaError({
          code: 'generic',
          message: `Cannot replace ${currentBinary}, and the previous binary is at ${backup}`,
          fix: 'Put it back by hand, then run lipa update again.',
        });
      }
    }

    throw new LipaError({
      code: 'generic',
      message: `Cannot replace ${currentBinary}`,
      fix: error instanceof Error ? error.message : String(error),
    });
  }

  rmSync(backup, { force: true });
}

export function resolveBinary(): string {
  try {
    return realpathSync(process.execPath);
  } catch {
    return process.execPath;
  }
}
