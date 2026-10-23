# Architecture

```
src/main.ts          parse, route, envelope
src/cli/…            commands, help, output
src/core/spec.ts     project.yml to BuildSpec
src/core/build.ts    the pipeline
src/core/plist.ts    XML plist read and write
src/core/macho.ts    LC_BUILD_VERSION, LC_UUID, dylibs
src/core/zip.ts      central directory, entry data
src/core/inspect.ts  checks on an IPA
src/core/signing.ts  profile parsing, identity, entitlements
src/core/prebuilt.ts cache and manifest
src/core/remote.ts   generic transport and the Mac script
src/core/sdk.ts      the installed Darwin SDK
src/core/tools.ts    pinned tools
```

## BuildSpec

`readSpec` reads an XcodeGen `project.yml` and returns what the build needs: target, product name, bundle id, team, iOS deployment target, marketing version from the Release xcconfig, Info.plist, entitlements, asset catalog, resources, sources and package dependencies. It stops with `config_invalid` and the missing key when something is absent.

`expandPlist` replaces `$(SETTING)` in the Info.plist with the settings from `project.yml` plus the five the build provides: `EXECUTABLE_NAME`, `PRODUCT_NAME`, `PRODUCT_BUNDLE_IDENTIFIER`, `MARKETING_VERSION`, `CURRENT_PROJECT_VERSION`. An unknown setting stops the build: xtool would otherwise write the literal string into the bundle.

## Pipeline

1. `readSpec`, `readSdk`, `checkPrebuilt`, `signingStatus`. Each failure exits with its own code.
2. Wrapper package in `~/.lipa/work/<bundle-id>/package`: a `Package.swift` with the project packages, one target pointing at the sources through a symlink, `xtool.yml`, the expanded Info.plist and the entitlements.
3. `xtool dev build --configuration release`, with the Swift toolchain first on `PATH`.
4. Assemble: copy the app, drop `_CodeSignature`, add the cached `Assets.car` and icons, copy the resource folders flat, write `PkgInfo`, embed the profile, merge the Xcode plist keys.
5. Patch `LC_BUILD_VERSION` with the SDK version, copy the binary to `~/.lipa/symbols`, strip, `chmod 755`.
6. Sign with `rcodesign`, entitlements from the project merged with the profile.
7. Zip `Payload/`, then run `inspectIpa` and fail with `ipa_invalid` if a check fails.

## Prebuilt cache

`actool` is the only Mac-only step of a normal build. The cache holds `Assets.car`, the PNG icons and the twelve `Info.plist` keys, with a manifest: hash of the asset catalog tree, Xcode build, SDK version, date, transport. The build refuses a cache whose hash or SDK differs.

The Mac side is a shell script generated from the spec and sent with a tar. It needs `xcrun`, `xcodebuild`, `sw_vers`, `PlistBuddy` and `tar`, all part of macOS or Xcode. It writes nothing to the Mac.

## Transport

`--mac <host>` runs `ssh <host> <command>`. `--via <command>` runs `<command> <command>`, a single string, so the user decides how to reach the machine. Both send a tar on stdin and read a tar on stdout. No binary is installed on the Mac.

## Signing

The profile is a CMS envelope with an XML plist inside: `profileInfo` finds the plist, reads the team, the bundle id, the expiry and the entitlements. `importSigning` checks the public key of the certificate against the private key with `openssl`, checks the expiry, and stores the files mode 600 under `~/.lipa/signing/<team>`.

`rcodesign` signs with `--pem-file` for the certificate and the key, the merged entitlements, and Apple's timestamp server. There is no dSYM, because the Linux toolchain has no `dsymutil`; the unstripped binary keeps the same UUID and symbolication can use it.

## Why the SDK patch

`ld64.lld` writes the deployment target in the SDK field of `LC_BUILD_VERSION`. App Store Connect reads that field as the SDK the app was built with and rejects the upload with error 90725. `patchBuildVersion` writes the SDK version the build linked against. The patch happens before signing.

## Limits

One sources directory per target. No storyboards, Core Data models or string catalogs: they need `ibtool`, `momc` and `xcstringstool`, which follow `actool` in the prebuilt step when a project needs them. Flutter is out.
