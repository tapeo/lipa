# lipa

Build a signed iOS app on Linux. No Mac in the loop.

`lipa` compiles Swift sources with the open-source Swift toolchain against a Darwin SDK built from your own copy of Xcode, signs the bundle with `rcodesign`, and packages an IPA that App Store Connect accepts. Upload stays with your publishing tool.

macOS needs one thing from a Mac: `actool`, which compiles the asset catalog. `lipa prebuilt` runs it over any shell transport you already have and caches the result on the server.

## Requirements

- Linux x86_64, Bun 1.4 or the release binary. `lipa setup` pins the tools for x86_64 only.
- A Mac with Xcode, reachable with `ssh` or with any command that opens a shell on it.
- A distribution certificate, its private key and an App Store provisioning profile for the bundle id.

The Xcode SDK license covers Apple hardware only. lipa never ships the SDK and never uploads it anywhere: it builds one from the copy of Xcode you already have, and the license question stays with you.

## Install

```bash
curl -fsSL https://github.com/tapeo/lipa/releases/latest/download/install.sh | sh
lipa setup
```

From a checkout:

```bash
bun install
bun run bin
```

`install.sh` puts the CLI in `~/.lipa/bin`, so add that directory to `PATH`. The pinned tools live under `~/.lipa/tools`; lipa adds the Swift toolchain to `PATH` for `xtool` itself, so it does not have to be exported in your shell.

## Quick start

```bash
# once per machine: Swift, xtool and rcodesign at pinned versions
lipa setup

# once per Xcode: build the Darwin SDK from a local Xcode.app or .xip
lipa sdk build --xcode ~/Downloads/Xcode.xip

# once per signing identity
lipa signing import --cert cert.pem --key key.pem --profile App.mobileprovision

# after any asset catalog change: run actool on the Mac
lipa prebuilt --mac macbook

# every build
lipa build --build 42 --out build/App.ipa

# before uploading
lipa inspect build/App.ipa
```

`lipa build` reads `project.yml` from an XcodeGen project: target, bundle id, team, deployment target, sources, resources, packages, Info.plist and entitlements. It writes nothing into the project except `build/`.

## How it works

```
project.yml ──► wrapper SwiftPM package ──► xtool + Swift for Linux
                     │                            │
Support/Prebuilt ◄── actool on a Mac             ▼
~/.lipa/cache   ────────────────► assemble Sample.app: plist keys, resources, strip
                                              │
                                              ▼
                          patch LC_BUILD_VERSION, sign with rcodesign, zip
```

- The wrapper package lives in `~/.lipa/work/<bundle-id>` and points at the project sources with a symlink. The project stays an XcodeGen project.
- `LC_BUILD_VERSION` carries the deployment target in its SDK field, and App Store Connect rejects that as an old SDK. lipa patches it to the SDK version it linked against, before signing.
- Signing needs `cert.pem`, `key.pem` and a profile whose `application-identifier` matches the project. `lipa signing status` checks the three against each other.
- `actool` output is cached per bundle id with a hash of the asset catalog, the Xcode build and the SDK version. A stale cache stops the build with `prebuilt_stale`, it does not build something different from what the Mac would.

## State

Everything lipa owns is under `~/.lipa`: `tools/`, `signing/`, `cache/`, `work/`, `symbols/`. Keys are mode 600, directories mode 700. The IPA goes where `--out` says, `build/<app>.ipa` by default.

## Commands

| Command | What it does |
|---|---|
| `lipa setup` | Installs Swift, xtool and rcodesign at pinned versions, sha256 checked |
| `lipa sdk build --xcode <path>` | Builds and installs the Darwin SDK from Xcode.app or Xcode.xip |
| `lipa sdk pull --mac <host>` | Copies Xcode.app from a Mac, installs the SDK, deletes the copy |
| `lipa prebuilt --mac <host>` | Runs actool on the Mac, caches Assets.car, icons and the Xcode plist keys |
| `lipa prebuilt --import <dir>` | Caches actool output produced elsewhere |
| `lipa signing import` | Stores the certificate, the key and the profile for a bundle id |
| `lipa signing status` | Checks certificate, key and profile of the project |
| `lipa build` | Compiles, assembles, patches, strips, signs, zips, inspects |
| `lipa inspect <ipa>` | Executable mode, plist keys, SDK, signature, profile |
| `lipa doctor [<dir>]` | Tools, SDK, cache and signing in one report |

Every command answers JSON without a terminal or with `--json`, and exit codes are stable: `2` usage, `3` missing tool, `4` stale prebuilt cache, `5` SDK mismatch, `6` signing, `7` bad IPA, `8` Mac unreachable.

## Limits

- XcodeGen only. Projects without `project.yml` are not read.
- Flutter is out: `flutter build ios` refuses to run on Linux.
- No dSYM: the Linux toolchain has no `dsymutil`. lipa keeps the unstripped binary, with the same UUID, in `~/.lipa/symbols`.
- One sources directory per target, no storyboards, Core Data models or `.xcstrings`.
- The Mac is needed only for `actool` and `sdk build`.

## License

MIT.
