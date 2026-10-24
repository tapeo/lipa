import type { Check } from '@/core/checks.ts';
import { LipaError, toLipaError } from '@/core/errors.ts';
import { type RemoteSource, remoteCapture } from '@/core/remote.ts';

export interface MacProbe {
  os: string;
  developer: string;
  xcode: string;
  actool: string;
  sdk: string;
}

const EMPTY: MacProbe = { os: '', developer: '', xcode: '', actool: '', sdk: '' };

export function probeScript(): string {
  return [
    'set -u',
    'printf \'os %s\\n\' "$(sw_vers -productVersion 2>/dev/null || true)"',
    'printf \'developer %s\\n\' "$(xcode-select -p 2>/dev/null || true)"',
    "printf 'xcode %s\\n' \"$(xcodebuild -version 2>&1 | head -4 | tr '\\n' '|')\"",
    'printf \'actool %s\\n\' "$(xcrun --sdk iphoneos -f actool 2>&1 | head -1)"',
    'printf \'sdk %s\\n\' "$(xcrun --sdk iphoneos --show-sdk-version 2>&1 | head -1)"',
  ].join('\n');
}

export function parseProbe(output: string): MacProbe {
  const probe: MacProbe = { ...EMPTY };

  for (const line of output.split('\n')) {
    const space = line.indexOf(' ');

    if (space < 0) {
      continue;
    }

    const key = line.slice(0, space);
    const value = line.slice(space + 1).trim();

    if (key === 'os') {
      probe.os = value;
    }

    if (key === 'developer') {
      probe.developer = value;
    }

    if (key === 'xcode') {
      probe.xcode = value.split('|').join('\n').trim();
    }

    if (key === 'actool') {
      probe.actool = value;
    }

    if (key === 'sdk') {
      probe.sdk = value;
    }
  }

  return probe;
}

function xcodeVersion(xcode: string): string {
  const line = xcode.split('\n').find((item) => item.startsWith('Xcode '));

  return line?.slice('Xcode '.length).trim() ?? '';
}

function licenseMissing(xcode: string): boolean {
  return /license/i.test(xcode);
}

function sdkFix(source: RemoteSource): string {
  if (source.kind === 'ssh') {
    return `Install the same SDK with lipa sdk --mac ${source.host}.`;
  }

  return 'Install the same SDK with lipa sdk, with the same transport.';
}

export function probeChecks(
  source: RemoteSource,
  probe: MacProbe,
  localSdk: string | undefined,
): Check[] {
  const checks: Check[] = [{ name: 'mac', ok: true, detail: `macOS ${probe.os || 'unknown'}` }];
  const version = xcodeVersion(probe.xcode);

  if (version === '') {
    const detail = licenseMissing(probe.xcode)
      ? 'the Xcode license is not accepted'
      : 'xcodebuild -version did not answer';

    checks.push({
      name: 'xcode',
      ok: false,
      detail,
      fix: 'On the Mac run sudo xcodebuild -license accept, then xcodebuild -runFirstLaunch.',
    });
  } else {
    checks.push({ name: 'xcode', ok: true, detail: `Xcode ${version}` });
  }

  const developerSelected =
    probe.developer.startsWith('/') && !probe.developer.includes('CommandLineTools');

  checks.push({
    name: 'xcode-select',
    ok: developerSelected,
    detail: probe.developer === '' ? 'xcode-select -p printed nothing' : probe.developer,
    fix: developerSelected
      ? undefined
      : 'On the Mac run sudo xcode-select -s /Applications/Xcode.app.',
  });

  const actoolReady = probe.actool.includes('actool') && !/error|not found/i.test(probe.actool);

  checks.push({
    name: 'actool',
    ok: actoolReady,
    detail: probe.actool === '' ? 'not found' : probe.actool,
    fix: actoolReady
      ? undefined
      : 'Install the iOS platform in Xcode Settings, Platforms, then run xcodebuild -runFirstLaunch.',
  });

  if (localSdk !== undefined) {
    const same = probe.sdk === localSdk;

    checks.push({
      name: 'mac-sdk',
      ok: same,
      detail: same
        ? `iOS ${probe.sdk}`
        : `the Mac has iOS ${probe.sdk || 'unknown'}, lipa has ${localSdk}`,
      fix: same ? undefined : sdkFix(source),
    });
  }

  return checks;
}

export async function checkMac(
  source: RemoteSource,
  localSdk: string | undefined,
): Promise<Check[]> {
  try {
    const output = await remoteCapture(source, probeScript());

    return probeChecks(source, parseProbe(output), localSdk);
  } catch (error) {
    const failure = error instanceof LipaError ? error : toLipaError(error);

    return [{ name: 'mac', ok: false, detail: failure.message, fix: failure.fix }];
  }
}
