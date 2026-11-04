import { quote, type RemoteSource, remote } from '@/core/remote.ts';

const TOOLCHAIN_LIB = 'Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/lib';
const PLATFORMS = ['iPhoneOS', 'MacOSX', 'iPhoneSimulator'];
const PLATFORM_ENTRIES = [
  'Info.plist',
  'Developer/SDKs',
  'Developer/Library/Frameworks',
  'Developer/Library/PrivateFrameworks',
  'Developer/usr/lib',
];

export const XCODE_SDK_PATHS: string[] = [
  'Contents/Info.plist',
  'Contents/version.plist',
  ...['swift', 'swift_static', 'clang'].map((name) => `${TOOLCHAIN_LIB}/${name}`),
  ...PLATFORMS.flatMap((platform) =>
    PLATFORM_ENTRIES.map((entry) => `Contents/Developer/Platforms/${platform}.platform/${entry}`),
  ),
];

export const XCODE_SDK_EXCLUDE = `${TOOLCHAIN_LIB}/swift/*/prebuilt-modules`;

export function xcodeCopyScript(remoteXcode: string): string {
  return [
    'set -eu',
    `cd ${quote(remoteXcode)}`,
    `[ -d Contents/Developer ] || { echo ${quote(`${remoteXcode} is not an Xcode.app`)} >&2; exit 1; }`,
    'set --',
    `for entry in ${XCODE_SDK_PATHS.map(quote).join(' ')}; do`,
    '  if [ -e "$entry" ]; then set -- "$@" "$entry"; fi',
    'done',
    `COPYFILE_DISABLE=1 tar -czf - --no-mac-metadata --no-xattrs --exclude ${quote(XCODE_SDK_EXCLUDE)} "$@"`,
  ].join('\n');
}

export async function pullXcode(
  source: RemoteSource,
  remoteXcode: string,
  destination: string,
): Promise<void> {
  await remote(source, {
    command: xcodeCopyScript(remoteXcode),
    stdin: undefined,
    output: destination,
  });
}
