# Architecture

```
src/main.ts          parse, route, envelope
src/cli/…            commands, help, output
src/core/spec.ts     project.yml to BuildSpec
src/core/prepare.ts  plan, workspace, compile
src/core/build.ts    assemble, patch, sign, zip
src/core/plist.ts    XML plist read and write
src/core/macho.ts    LC_BUILD_VERSION, LC_UUID, dylibs
src/core/zip.ts      central directory, entry data
src/core/inspect.ts  checks on an IPA
src/core/signing.ts  profile parsing, identity, entitlements
src/core/prebuilt.ts cache and manifest
src/core/remote.ts   generic transport, actool script, failure mapping
src/core/mac.ts      probe of the Mac for doctor
src/core/doctor.ts   the report
src/core/sdk.ts      the installed Darwin SDK
src/core/tools.ts    pinned tools
src/core/release.ts  GitHub release lookup, checksum, binary replacement
```

## BuildSpec

`readSpec` reads an XcodeGen `project.yml` and returns what the build needs: target, product name, bundle id, team, iOS deployment target, marketing version from the Release xcconfig, Info.plist, entitlements, asset catalog, resources, sources and package dependencies. It stops with `config_invalid` and the missing key when something is absent.

`expandPlist` replaces `$(SETTING)` in the Info.plist with the settings from `project.yml` plus the five the build provides: `EXECUTABLE_NAME`, `PRODUCT_NAME`, `PRODUCT_BUNDLE_IDENTIFIER`, `MARKETING_VERSION`, `CURRENT_PROJECT_VERSION`. An unknown setting stops the build: xtool would otherwise write the literal string into the bundle.

## Prepare

`prepare` is the slow half of a build, and `build` calls it.

`preparePlan` is pure: it takes the prebuilt status, the Mac source, whether the workspace exists, `--clean` and `--update`, and returns the ordered steps. The rules are:

- `--clean` removes the workspace and hides `--update`.
- The prebuilt step runs when `--import` is given, or when the cache is stale and a Mac is available.
- The compile is always the last step.

```ts
preparePlan({ prebuiltStale, mac, workspaceExists, clean, update })
```

`prepareWorkspace` runs the steps, writes the wrapper package, the entitlements and the Info.plist, then calls `xtool dev build --configuration release`. It needs no signing identity: without one the entitlements come from the project alone, so a compile can run before the certificate exists. It returns the prebuilt status, and the caller decides whether a stale cache is fatal.

The package workspace is `~/.lipa/work/<bundle-id>/package-<hash>`, the hash covering the sources path, the SDK, the Swift toolchain and xtool. `writeIfChanged` and `ensureSymlink` leave unchanged files alone, so SwiftPM keeps its objects and `Package.resolved`.

## Build

1. `readSpec`, `readSdk`, the signing check and the tool checks. Each failure exits with its own code.
2. `prepareWorkspace` with the entitlements merged from the project and the profile.
3. Assemble: copy the app, drop `_CodeSignature`, add the cached `Assets.car` and icons, copy the resource folders flat, write `PkgInfo`, embed the profile, merge the Xcode plist keys.
4. Patch `LC_BUILD_VERSION` with the SDK version, copy the binary to `~/.lipa/symbols`, strip, `chmod 755`.
5. Sign with `rcodesign`, entitlements from the project merged with the profile.
6. Zip `Payload/`, then run `inspectIpa` and fail with `ipa_invalid` if a check fails.

One lock per bundle id covers both `prepare` and `build`, so they never write the same workspace.

## Prebuilt cache

`actool` is the only Mac-only step. The cache holds `Assets.car`, the PNG icons and the twelve `Info.plist` keys, with a manifest: hash of the asset catalog tree, Xcode build, SDK version, date, transport. The build refuses a cache whose hash or SDK differs.

The Mac side is a shell script generated from the spec and sent with a tar. It needs `xcrun`, `xcodebuild`, `sw_vers`, `PlistBuddy` and `tar`, all part of macOS or Xcode. It writes nothing to the Mac.

## Transport

`--mac <host>` runs `ssh -o BatchMode=yes -o ConnectTimeout=10 <host> <command>`. `--via <command>` runs `<command> '<command>'`, a single string, so the user decides how to reach the machine. Both send a tar on stdin and read a tar on stdout. No binary is installed on the Mac.

`remoteFailure` maps the exit to an error: 255 or a connection message is `remote_unreachable`, a message about `xcode-select`, the license or a missing utility is `capability_missing`. Both carry the next command in `fix`.

## Device

`lipa run` reaches the device through RemotePairing, the service Xcode uses over Wi-Fi, so an address on a VPN such as Tailscale is enough. The work is done by `device/lipa_device.py`, a process of its own: pair-verify with the record, a userspace tunnel with no root, RSD, installation proxy, the personalized developer image, process control and the log stream. It writes one JSON event per line and passes the log lines through as text, so lipa can stream them unchanged.

The helper imports pymobiledevice3 and is therefore GPL-3.0, with its own `device/LICENSE`. It is not compiled into the lipa binary, which stays MIT: the binary starts it, and `device/requirements.txt` pins every package by hash. `lipa setup --only device` installs it with uv and Python 3.13, which is the version whose TLS implementation carries the PSK ciphers the tunnel needs. `run` does the same when the helper is missing.

## Ladder

Every command runs the earlier steps itself when something is missing, and `doctor` names the missing step. `run` follows the same rule for the device: when the helper or its Python environment is absent it installs them, once, under `~/.lipa/tools/device`. `prepare` stays a compile step and installs nothing for a device, so a machine that only builds never downloads pymobiledevice3.

## Doctor

`doctor` collects checks for the tools, the SDK, the project, the workspace (warm when `.build` or the last app exists), the prebuilt cache and the signing. With `--mac` or `--via` it adds one call: `probeScript` prints five `key value` lines, `parseProbe` reads them without a Mac in the loop, and `probeChecks` turns them into checks for macOS, Xcode, `xcode-select`, `actool` and the SDK version. Without a transport the Mac check is marked skipped and does not fail the report.

## Signing

The profile is a CMS envelope with an XML plist inside: `profileInfo` finds the plist, reads the team, the bundle id, the expiry, the devices and the entitlements, and derives the kind. `importSigning` checks the subject of the certificate against that kind, checks the public key against the private key with `openssl`, checks the expiry, and stores the files mode 600 under `~/.lipa/signing/<team>`, with `development` as a subfolder for the development identity.

A development profile sets `get-task-allow`, which the merged entitlements carry as true, and drops `beta-reports-active`. `com.apple.developer.icloud-container-environment` stays as the project writes it, so a development build keeps using the production iCloud container when the project does not ask for the development one, and the data of a TestFlight build stays visible.

`rcodesign` signs with `--pem-file` for the certificate and the key, the merged entitlements, and Apple's timestamp server. There is no dSYM: the unstripped binary keeps the same UUID in `~/.lipa/symbols` and symbolication can use it.

## Why the SDK patch

`ld64.lld` writes the deployment target in the SDK field of `LC_BUILD_VERSION`. App Store Connect reads that field as the SDK the app was built with and rejects the upload with error 90725. `patchBuildVersion` writes the SDK version the build linked against. The patch happens before signing.

## Limits

One sources directory per target. No storyboards, Core Data models or string catalogs: they need `ibtool`, `momc` and `xcstringstool`, which follow `actool` in the prepare step when a project needs them. Flutter is out.
