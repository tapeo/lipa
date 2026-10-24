# CLI reference

Every command answers JSON when stdout is not a terminal or with `--json`. Without JSON, the answer is the text described here.

## Envelope

```json
{ "ok": true, "data": {} }
```

```json
{
  "ok": false,
  "error": {
    "code": "prebuilt_stale",
    "message": "/home/me/app/Support/Assets.xcassets changed since the last prepare",
    "fix": "Run lipa prepare --mac macbook again."
  }
}
```

## Exit codes

| Code | Meaning |
|---|---|
| 0 | ok |
| 1 | generic error, including `doctor` with a missing piece and `build_in_progress` |
| 2 | wrong usage |
| 3 | missing tool or SDK, `capability_missing` |
| 4 | stale prebuilt cache, `prebuilt_stale` |
| 5 | SDK mismatch, `sdk_mismatch` |
| 6 | signing problem, `signing_invalid` |
| 7 | IPA that fails `inspect`, `ipa_invalid` |
| 8 | the Mac command failed, `remote_unreachable` |

## The ladder

Each command assumes the one before it, and the project commands run the earlier step themselves when something is missing. `doctor` reports the step that is missing and the command that fixes it.

| Step | Command |
|---|---|
| tools | `lipa setup` |
| SDK | `lipa sdk` |
| signing | `lipa signing import` |
| compile | `lipa prepare` |
| IPA | `lipa build` |
| check | `lipa inspect` |

## setup

| Form | Flags |
|---|---|
| `lipa setup` | `--force` installs again, `--only <tool>` installs one |

Installs Swift 6.4.1 for Ubuntu 24.04, xtool 1.23.0 and rcodesign 0.29.0 under `~/.lipa`, each checked against a sha256 pinned in `src/core/tools.ts`.

## sdk

| Form | Flags |
|---|---|
| `lipa sdk --xcode <path>` | `--xcode`, Xcode.app or Xcode.xip on this machine |
| `lipa sdk --mac <host>` | `--mac`, `--via`, `--xcode` for a path on the Mac, `--keep` |

The first form runs `xtool sdk install`, which writes to `~/.swiftpm/swift-sdks/darwin.artifactbundle`. The second copies `Xcode.app` from the Mac with the generic transport and installs the same way, then deletes the copy unless `--keep` is given. `--xcode` with `--mac` names the Xcode on the Mac, `/Applications/Xcode.app` by default. Both put the pinned Swift toolchain on the `PATH` of `xtool`, so the shell `PATH` does not matter. When the install fails, the copy of Xcode is kept and its directory printed.

## signing

| Form | Flags |
|---|---|
| `lipa signing import` | `--cert`, `--key`, `--profile`, `--team` |

`import` checks that the certificate and the key match, that the certificate is valid, and that the profile is for the bundle id of the profile. It stores the three files in `~/.lipa/signing/<team>`, mode 600. `lipa doctor` reports the state of the identity.

## prepare

| Flag | Default |
|---|---|
| `--mac <host>` | no Mac: the assets come from the cache |
| `--via <command>` | no Mac: the assets come from the cache |
| `--import <dir>` | nothing: cache a directory built elsewhere |
| `--update` | off: `Package.resolved` is kept |
| `--clean` | off: the package workspace is reused |
| `--target <name>` | the first iOS application target |

`prepare` does the slow part of a build and stops before signing:

1. `actool` on the Mac, when the asset catalog, the Xcode build or the SDK changed, or `--import` was given.
2. The package dependencies, resolving them again with `--update`.
3. `xtool dev build --configuration release` in the package workspace.

It exits with 4 when the cache is stale and no Mac was given. The compile has already run at that point, so the next `prepare` or `build` with `--mac` only waits for `actool`.

A stale cache with `--mac` refreshes automatically: the flag is enough, no separate command.

### Workspace

The wrapper package lives in `~/.lipa/work/<bundle-id>/package-<hash>`, where the hash covers the sources directory and the versions of the SDK, Swift and xtool. lipa keeps that directory between runs and rewrites `Package.swift`, `xtool.yml` and the plists only when their content changes, so SwiftPM and xtool reuse what they compiled. A run after an edit to the app compiles the app module again, not the dependencies; only the first run in a directory compiles everything. `Package.resolved` survives too, so a dependency declared with `from:` stays at the version it resolved to until `--update` or `--clean`.

One run at a time per bundle id. A second `prepare` or `build` fails with `build_in_progress` and names the pid that holds the lock; a lock whose process is gone is taken over.

`--clean` deletes the package workspace and compiles everything again. `--update` deletes only `Package.resolved`, so the dependencies resolve again without losing the other objects.

## build

| Flag | Default |
|---|---|
| `--mac <host>`, `--via <command>` | no Mac: the assets come from the cache |
| `--build <number>` | `CURRENT_PROJECT_VERSION` of the Release xcconfig, then a UTC timestamp |
| `--version <version>` | `MARKETING_VERSION` of the Release xcconfig |
| `--out <ipa>` | `build/<app>.ipa` in the project |
| `--target <name>` | the first iOS application target |
| `--update`, `--clean` | as in `prepare` |

A relative `--out` is resolved against the project root, not the directory lipa runs from.

`CURRENT_PROJECT_VERSION` is read from the target settings of `project.yml` first and from the Release xcconfig after that, the order Xcode uses. App Store Connect refuses a build number lower than one already uploaded for the same marketing version, so after a change of default from the timestamp to a small number, either bump the marketing version or pass `--build` above the last upload.

Steps: read the spec, check the signing, take the build lock, run `prepare`, assemble, patch `LC_BUILD_VERSION`, keep the unstripped binary, strip, sign with `rcodesign`, zip, then run the same checks as `inspect`. A stale cache without `--mac` compiles first and then exits with 4.

## inspect

```
lipa inspect build/App.ipa
```

Checks the mode of the main executable, `PkgInfo`, `Assets.car` and `CFBundleIcons`, the twelve Xcode keys, the version keys, `LC_BUILD_VERSION`, the code signature, and the profile against the bundle id and its expiry.

## doctor

```
lipa doctor [<dir>] [--mac <host>]
```

Without a directory it uses the current one. Reports the Swift toolchain, xtool, rcodesign, tar, zip, openssl, ssh, the SDK version, and, when a `project.yml` is there, the spec, the workspace, the prebuilt cache and the signing identity. Every failed check carries the command that fixes it.

With `--mac` it adds one ssh call that reports macOS, the selected Xcode, the Xcode license, `actool` and the iOS SDK of the Mac against the one on Linux. Without `--mac` the Mac line says skipped; it does not make the report fail.

The Mac check is read-only: it runs `sw_vers`, `xcode-select -p`, `xcodebuild -version`, `xcrun -f actool` and `xcrun --show-sdk-version`, and writes nothing on the Mac.

## Transport

`--mac <host>` runs `ssh -o BatchMode=yes -o ConnectTimeout=10 <host> <script>`. `--via <command>` runs `<command> '<script>'`, a single string, so the user decides how to reach the machine. Both send a tar on stdin and read a tar on stdout. No binary is installed on the Mac.

A failed connection, exit 255 or a timeout, is `remote_unreachable` (8) with the fix `lipa doctor --mac <host>`. A Mac whose Xcode is missing, not selected or not licensed is `capability_missing` (3) with the command to run on the Mac.
