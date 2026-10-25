import { readFileSync } from 'node:fs';

import type { CommandSpec } from '@/cli/command.ts';
import { booleanValue, stringValue } from '@/cli/parser.ts';
import { buildIos } from '@/core/build.ts';
import { runOnDevice } from '@/core/device.ts';
import { LipaError } from '@/core/errors.ts';
import { ipaProfile } from '@/core/inspect.ts';
import { macSource } from '@/core/prepare.ts';
import { profileInfo, profilePath, signingStatus } from '@/core/signing.ts';
import { type BuildSpec, readSpec } from '@/core/spec.ts';

function deviceInProfile(spec: BuildSpec, udid: string | undefined): string {
  const file = profilePath(spec.team, spec.bundleId, 'development');
  const profile = profileInfo(readFileSync(file), file);

  if (udid === undefined && profile.devices.length === 1) {
    const only = profile.devices[0];

    if (only !== undefined) {
      return only;
    }
  }

  if (udid === undefined) {
    throw new LipaError({
      code: 'usage',
      message: 'Missing --udid, and the development profile lists more than one device',
      fix: 'Pass --udid <udid>, or import a profile with one device.',
    });
  }

  if (!profile.devices.includes(udid)) {
    throw new LipaError({
      code: 'signing_invalid',
      message: `${udid} is not in the development profile of ${spec.bundleId}`,
      fix: 'Add the device in the Apple Developer portal and import the profile again.',
    });
  }

  return udid;
}

export const runCommand: CommandSpec = {
  name: 'run',
  summary: 'Build for development, install, launch and follow the logs',
  usage:
    'lipa run [<dir>] --device <host> [--port <n>] [--udid <udid>] [--ipa <path>] [--logs app|all|none] [--mac <host> | --via <command>] [--update] [--clean]',
  arguments: 1,
  flags: [
    {
      name: 'device',
      value: 'host',
      description: 'Address of the device, for example its tailnet name',
    },
    { name: 'port', value: 'n', description: 'RemotePairing port, searched when missing' },
    {
      name: 'udid',
      value: 'udid',
      description: 'Device UDID, default the only device of the profile',
    },
    { name: 'ipa', value: 'path', description: 'Install this IPA instead of building one' },
    {
      name: 'logs',
      value: 'scope',
      description:
        'app for the bundle id only, all for every process, none to stop after the launch',
    },
    {
      name: 'mac',
      value: 'host',
      description: 'Mac reachable with ssh, used when the assets or the SDK changed',
    },
    { name: 'via', value: 'command', description: 'Command that runs sh on the Mac' },
    {
      name: 'update',
      description: 'Resolve the package dependencies again without compiling everything',
    },
    { name: 'clean', description: 'Throw away the package workspace and compile everything again' },
  ],
  examples: [
    'lipa run --device iphone',
    'lipa run --device 100.64.0.2 --udid 00008150-0000000000000001',
    'lipa run --ipa build/App-development.ipa --device iphone',
  ],
  async run({ args, output }) {
    const root = args.positionals[0] ?? process.cwd();
    const host = stringValue(args.values, 'device');

    if (host === undefined) {
      throw new LipaError({
        code: 'usage',
        message: 'Missing --device',
        fix: 'lipa run --device <host>, where host is the address or the name of the device',
      });
    }

    const scope = stringValue(args.values, 'logs') ?? (output.json ? 'none' : 'app');

    if (scope !== 'app' && scope !== 'all' && scope !== 'none') {
      throw new LipaError({ code: 'usage', message: `Unknown --logs ${scope}` });
    }

    const given = stringValue(args.values, 'ipa');
    let ipa = given;

    if (ipa === undefined) {
      const built = await buildIos({
        root,
        signing: 'development',
        clean: booleanValue(args.values, 'clean'),
        update: booleanValue(args.values, 'update'),
        mac: macSource({
          mac: stringValue(args.values, 'mac'),
          via: stringValue(args.values, 'via'),
        }),
        stream: !output.json,
      });
      ipa = built.ipa;
    }

    const spec = readSpec(root);
    const udid = deviceInProfile(spec, stringValue(args.values, 'udid'));
    const signing = await signingStatus(spec.team, spec.bundleId, 'development');

    if (!signing.ok) {
      throw new LipaError({
        code: 'signing_invalid',
        message: signing.reason ?? 'No development signing identity',
        fix: signing.fix,
      });
    }

    const installed = ipaProfile(ipa);

    if (installed.kind !== 'development') {
      throw new LipaError({
        code: 'signing_invalid',
        message: `${ipa} carries a ${installed.kind} profile, the device needs a development one`,
        fix: 'Run lipa build --signing development, or pass that IPA to --ipa.',
      });
    }

    if (!installed.devices.includes(udid)) {
      throw new LipaError({
        code: 'signing_invalid',
        message: `${ipa} was signed for ${installed.devices.join(', ') || 'no device'}, not ${udid}`,
        fix: 'Import a development profile that lists this device and build again.',
      });
    }

    const code = await runOnDevice({
      host,
      port: stringValue(args.values, 'port'),
      udid,
      bundleId: spec.bundleId,
      ipa,
      logs: scope,
      stream: !output.json,
    });

    return {
      data: { ipa, host, udid, bundleId: spec.bundleId, logs: scope },
      text: [
        `Installed on ${host} (${udid})`,
        scope === 'none' ? 'The app is running.' : 'Following the logs, stop with Ctrl-C.',
      ].join('\n'),
      exitCode: code === 130 ? 0 : code,
    };
  },
};
