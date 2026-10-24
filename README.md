# lipa

Build a signed iOS app on Linux. The Mac is needed only to compile the asset catalog.

`lipa` compiles Swift sources with the open-source Swift toolchain against a Darwin SDK built from your own copy of Xcode, signs the bundle with `rcodesign`, and packages an IPA that App Store Connect accepts. Upload stays with your publishing tool.

The one Mac-only tool is `actool`, which compiles the asset catalog. `lipa prepare --mac <host>` runs it over any shell transport you already have and caches the result on the Linux machine.

## Requirements

- Linux x86_64, Bun 1.4 or the release binary. `lipa setup` pins the tools for x86_64 only.
- A Mac with Xcode, reachable with `ssh` without a password, or with any command that opens a shell on it. `docs/mac.md` covers the Mac side.
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

Each command assumes the one before it. `prepare` and `build` run the earlier steps themselves when something is missing.

```bash
# once per machine: Swift, xtool and rcodesign at pinned versions
lipa setup

# once per Xcode, from a local download
lipa sdk --xcode ~/Downloads/Xcode.xip
# or from the Mac itself
lipa sdk --mac macbook

# once per signing identity
lipa signing import --cert cert.pem --key key.pem --profile App.mobileprovision

# after the assets, the SDK or the toolchain changed: compile ahead of the build
lipa prepare --mac macbook

# every build
lipa build --build 42 --out build/App.ipa

# before uploading
lipa inspect build/App.ipa
```

`lipa build` reads `project.yml` from an XcodeGen project: target, bundle id, team, deployment target, sources, resources, packages, Info.plist and entitlements. It writes nothing into the project except `build/`.

`lipa doctor` says which step is missing and which command to run.

## Connect to the Mac

`--mac <host>` runs `ssh <host>`, so user, port, key and jump host belong in `~/.ssh/config`:

```
Host macbook
  HostName 192.168.1.10
  User me
  IdentityFile ~/.ssh/id_ed25519
```

```bash
lipa doctor --mac macbook
```

`doctor` checks the connection, macOS, the selected Xcode, the Xcode license, `actool` and the iOS SDK on the Mac against the one on Linux, and prints the command that fixes whatever is missing. `docs/mac.md` has the Mac side: Remote Login, `xcode-select` and the license.

ssh runs without a password prompt. When the key is missing the command fails at once with `remote_unreachable` instead of waiting.

`--via <command>` replaces ssh for a machine reachable another way, for example through a wrapper of your own. It runs `<command> '<script>'` and passes stdin and stdout unchanged.

## How it works

```
project.yml ──► wrapper SwiftPM package ──► xtool + Swift for Linux
                     │                            │
Support/Prebuilt ◄── actool on a Mac             ▼
~/.lipa/cache   ────────────────► assemble App.app: plist keys, resources, strip
                                              │
                                              ▼
                          patch LC_BUILD_VERSION, sign with rcodesign, zip
```

- The wrapper package lives in `~/.lipa/work/<bundle-id>/package-<hash>` and points at the project sources with a symlink. The project stays an XcodeGen project.
- `LC_BUILD_VERSION` carries the deployment target in its SDK field, and App Store Connect rejects that as an old SDK. lipa patches it to the SDK version it linked against, before signing.
- Signing needs `cert.pem`, `key.pem` and a profile whose `application-identifier` matches the project. `lipa doctor` checks the three against each other.
- `prepare` compiles into that package and does not sign. `build` calls it, then assembles, signs and zips, so a warm build takes seconds.
- `actool` output is cached per bundle id with a hash of the asset catalog, the Xcode build and the SDK version. A stale cache stops the build with `prebuilt_stale`, it does not build something different from what the Mac would.

## State

Everything lipa owns is under `~/.lipa`: `tools/`, `signing/`, `cache/`, `work/`, `symbols/`. Keys are mode 600, directories mode 700. The IPA goes where `--out` says, `build/<app>.ipa` by default.

## Commands

| Command | What it does |
|---|---|
| `lipa setup` | Installs Swift, xtool and rcodesign at pinned versions, sha256 checked |
| `lipa sdk --xcode <path>` | Builds and installs the Darwin SDK from Xcode.app or Xcode.xip |
| `lipa sdk --mac <host>` | Copies Xcode.app from a Mac, installs the SDK, deletes the copy |
| `lipa signing import` | Stores the certificate, the key and the profile for a bundle id |
| `lipa prepare` | Compiles the app and refreshes the prebuilt cache, without signing |
| `lipa build` | Prepare, assemble, patch, strip, sign, zip, inspect |
| `lipa inspect <ipa>` | Executable mode, plist keys, SDK, signature, profile |
| `lipa doctor` | Tools, SDK, workspace, cache, signing and the Mac in one report |

`prepare` and `build` take `--mac <host>`, `--via <command>`, `--update` for the dependencies and `--clean` for a full recompile. `prepare` also takes `--import <dir>` for an `actool` output produced elsewhere.

Every command answers JSON without a terminal or with `--json`, and exit codes are stable: `2` usage, `3` missing tool or Xcode, `4` stale prebuilt cache, `5` SDK mismatch, `6` signing, `7` bad IPA, `8` Mac unreachable.

## Limits

- XcodeGen only. Projects without `project.yml` are not read.
- Flutter is out: `flutter build ios` refuses to run on Linux.
- No dSYM: the Linux toolchain has no `dsymutil`. lipa keeps the unstripped binary, with the same UUID, in `~/.lipa/symbols`.
- One sources directory per target, no storyboards, Core Data models or `.xcstrings`.
- `swift package` dependencies compile on Linux as they are. A package that needs `actool`, `ibtool` or `momc` for its own resources does not build.
- The Mac is needed for `actool` only. `lipa sdk --xcode` builds the SDK from a local copy of Xcode, `lipa sdk --mac` takes it from the Mac.

## License

MIT.
