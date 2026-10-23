import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { LipaError } from '@/core/errors.ts';

export function sdkRoot(): string {
  return process.env.LIPA_SDK ?? join(homedir(), '.swiftpm', 'swift-sdks', 'darwin.artifactbundle');
}

export interface SdkInfo {
  root: string;
  version: string;
  settingsPath: string;
}

export function readSdk(): SdkInfo {
  const root = sdkRoot();
  const platforms = join(root, 'Developer', 'Platforms', 'iPhoneOS.platform', 'Developer', 'SDKs');

  if (!existsSync(platforms)) {
    throw new LipaError({
      code: 'capability_missing',
      message: `No Darwin SDK in ${root}`,
      fix: 'Run lipa sdk build --xcode <path>, or lipa sdk pull --mac <host>.',
    });
  }

  const directory = readdirSync(platforms)
    .filter((name) => name.startsWith('iPhoneOS') && name.endsWith('.sdk'))
    .sort()
    .at(-1);

  if (directory === undefined) {
    throw new LipaError({
      code: 'capability_missing',
      message: `No iPhoneOS SDK in ${platforms}`,
      fix: 'Run lipa sdk build --xcode <path>.',
    });
  }

  const settingsPath = join(platforms, directory, 'SDKSettings.json');
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as { Version?: string };

  if (settings.Version === undefined) {
    throw new LipaError({
      code: 'capability_missing',
      message: `${settingsPath} has no Version`,
      fix: 'Rebuild the SDK with lipa sdk build.',
    });
  }

  return { root, version: settings.Version, settingsPath };
}
