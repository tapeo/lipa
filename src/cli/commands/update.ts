import type { CommandSpec } from '@/cli/command.ts';
import { stringValue } from '@/cli/parser.ts';
import { LipaError } from '@/core/errors.ts';
import {
  downloadReleaseBinary,
  isNewer,
  latestRelease,
  REPO,
  type ReleaseInfo,
  releaseByTag,
  replaceBinary,
  resolveBinary,
} from '@/core/release.ts';
import { VERSION } from '@/version.ts';

async function wantedRelease(requested: string | undefined): Promise<ReleaseInfo> {
  if (requested !== undefined) {
    const tag = requested.startsWith('v') ? requested : `v${requested}`;
    const outcome = await releaseByTag(tag);

    if (outcome.release === undefined) {
      const notFound = outcome.reason === 'not_found';

      throw new LipaError({
        code: 'generic',
        message: notFound ? `${REPO} has no release tagged ${tag}` : `Cannot reach ${REPO}`,
        fix: notFound
          ? 'lipa update --check reports the latest version.'
          : 'Check the connection, or the repository name in LIPA_REPO.',
      });
    }

    return outcome.release;
  }

  const outcome = await latestRelease();

  if (outcome.release === undefined) {
    const missing = outcome.reason === 'no_releases';

    throw new LipaError({
      code: 'generic',
      message: missing ? `${REPO} has no published release yet` : `Cannot reach ${REPO}`,
      fix: missing
        ? 'Install the binary with install.sh, or from a checkout with bun run bin.'
        : 'Check the connection, or the repository name in LIPA_REPO.',
    });
  }

  return outcome.release;
}

export const updateCommand: CommandSpec = {
  name: 'update',
  summary: 'Replace the installed binary with a GitHub release',
  usage: 'lipa update [--check] [--version <version>] [--force]',
  flags: [
    { name: 'check', description: 'Only says whether a newer version exists' },
    { name: 'version', value: 'version', description: 'Install one exact version' },
    { name: 'force', description: 'Install again even the same version' },
  ],
  examples: ['lipa update --check', 'lipa update', 'lipa update --version 0.2.1'],
  async run({ args, output }) {
    const requested = stringValue(args.values, 'version');
    const check = args.values.check === true;

    if (!check && !Bun.isStandaloneExecutable) {
      throw new LipaError({
        code: 'capability_missing',
        message:
          'lipa update replaces the binary it runs from, this run comes from the source tree',
        fix: 'Run lipa update from the installed binary, or use --check to compare versions.',
      });
    }

    const release = await wantedRelease(requested);
    const newer = isNewer(release.version, VERSION);

    if (check) {
      if (output.json) {
        return { data: { current: VERSION, latest: release.version, update_available: newer } };
      }

      return {
        text: newer
          ? `Update available: ${release.version} (this version is ${VERSION})`
          : `Up to date: ${VERSION}`,
      };
    }

    if (requested === undefined && !newer && args.values.force !== true) {
      if (output.json) {
        return { data: { current: VERSION, latest: release.version, updated: false } };
      }

      return { text: `Already on ${VERSION}.` };
    }

    const binary = resolveBinary();
    const downloaded = await downloadReleaseBinary({
      release,
      platform: process.platform,
      arch: process.arch,
      currentBinary: binary,
    });

    replaceBinary(binary, downloaded.path);

    if (output.json) {
      return { data: { from: VERSION, to: downloaded.version, binary } };
    }

    return { text: `Updated from ${VERSION} to ${downloaded.version}.\nBinary: ${binary}` };
  },
};
