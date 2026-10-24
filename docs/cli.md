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
    "message": "/home/me/app/Support/Assets.xcassets changed since the last prebuilt run",
    "fix": "Run lipa prebuilt --mac macbook again."
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

## setup

| Form | Flags |
|---|---|
| `lipa setup` | `--force` installs again, `--only <tool>` installs one |

Installs Swift 6.4.1 for Ubuntu 24.04, xtool 1.23.0 and rcodesign 0.29.0 under `~/.lipa`, each checked against a sha256 pinned in `src/core/tools.ts`.

## sdk

| Form | Flags |
|---|---|
| `lipa sdk build --xcode <path>` | `--xcode`, Xcode.app or Xcode.xip |
| `lipa sdk pull --mac <host>` | `--mac`, `--via`, `--xcode`, `--keep` |

`build` runs `xtool sdk install`, which writes to `~/.swiftpm/swift-sdks/darwin.artifactbundle`. `pull` copies Xcode.app from the Mac with the generic transport, installs the SDK and deletes the copy unless `--keep` is given. Both put the pinned Swift toolchain on the `PATH` of `xtool`, so the shell `PATH` does not matter. When the install fails, `pull` keeps the downloaded Xcode and prints its directory instead of deleting it.

## prebuilt

| Form | Flags |
|---|---|
| `lipa prebuilt --mac <host> [<dir>]` | `--mac` |
| `lipa prebuilt --via <command> [<dir>]` | `--via` |
| `lipa prebuilt --import <dir> [<dir>]` | `--import` |

The Mac command receives a tar with the asset catalog and a `run.sh`, runs `xcrun actool` and `/usr/libexec/PlistBuddy`, and returns a tar with `Assets.car`, the icons and an `Info.plist` holding the twelve Xcode keys. lipa stores it in `~/.lipa/cache/<bundle-id>` with a manifest.

`--via` replaces `ssh <host>` with any command that opens `sh` on the Mac and passes stdin and stdout unchanged. For example `--via 'ssh -p 2222 me@192.168.1.10'`.

`--import` caches a directory produced somewhere else, with the same `Info.plist` keys and files.

## signing

| Form | Flags |
|---|---|
| `lipa signing import` | `--cert`, `--key`, `--profile`, `--team` |
| `lipa signing status [<dir>]` | |

`import` checks that the certificate and the key match, that the certificate is valid, and that the profile is for the bundle id of the profile. It stores the three files in `~/.lipa/signing/<team>`, mode 600.

## build

| Flag | Default |
|---|---|
| `--build <number>` | `CURRENT_PROJECT_VERSION` of the Release xcconfig, then a UTC timestamp |
| `--version <version>` | `MARKETING_VERSION` of the Release xcconfig |
| `--out <ipa>` | `build/<app>.ipa` in the project |
| `--target <name>` | the first iOS application target |
| `--clean` | off: the package workspace is reused |

A relative `--out` is resolved against the project root, not the directory lipa runs from.

`CURRENT_PROJECT_VERSION` is read from the target settings of `project.yml` first and from the Release xcconfig after that, the order Xcode uses. App Store Connect refuses a build number lower than one already uploaded for the same marketing version, so after a change of default from the timestamp to a small number, either bump the marketing version or pass `--build` above the last upload.

Steps: read the spec, check the prebuilt cache and the signing, take the build lock, write the wrapper package, run `xtool dev build --configuration release`, assemble, patch `LC_BUILD_VERSION`, keep the unstripped binary, strip, sign with `rcodesign`, zip, then run the same checks as `inspect`.

### Workspace

The wrapper package lives in `~/.lipa/work/<bundle-id>/package-<hash>`, where the hash covers the sources directory and the versions of the SDK, Swift and xtool. lipa keeps that directory between builds and rewrites `Package.swift`, `xtool.yml` and the plists only when their content changes, so SwiftPM and xtool reuse what they compiled. A build after an edit to the app compiles the app module again, not the dependencies; only the first build in a directory compiles everything. `Package.resolved` survives too, so a dependency declared with `from:` stays at the version it resolved to until `--clean`.

One build at a time per bundle id. A second `lipa build` fails with `build_in_progress` and names the pid that holds the lock; a lock whose process is gone is taken over. `--clean` deletes the package workspace and compiles everything again.

## inspect

```
lipa inspect build/App.ipa
```

Checks the mode of the main executable, `PkgInfo`, `Assets.car` and `CFBundleIcons`, the twelve Xcode keys, the version keys, `LC_BUILD_VERSION`, the code signature, and the profile against the bundle id and its expiry.

## doctor

```
lipa doctor [<dir>]
```

Reports the Swift toolchain, xtool, rcodesign, tar, zip, openssl, ssh, the SDK version, and, when a project is given, the spec, the prebuilt cache and the signing identity.
