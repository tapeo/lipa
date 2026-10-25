# Plan: development signing and `lipa run`

Goal: from Linux, build an app signed for development, install it on a device, launch it and stream its logs, with the device reachable over USB or over a network such as Tailscale.

## What was verified by hand

- A device on iOS 27 answers the RemotePairing service over its Tailscale address (port 49152 in the test). Plain lockdown on 62078 over the same address accepts the connection and then drops it, even with a valid pair record, so lockdown over the network is not a path.
- pymobiledevice3 11.44.0 reaches the device over RemotePairing with an in-process userspace tunnel, no root: RSD with 85 services, installed apps, DDI state, launch with `ProcessControl`, and `os_trace` filtered by subsystem.
- The TCP tunnel needs TLS-PSK. On Python 3.12 pymobiledevice3 goes through `sslpsk_pmd3`, which fails with `NO_CIPHERS_AVAILABLE` on Ubuntu OpenSSL 3.0. Python 3.13 uses the PSK support of the standard library and works.
- A RemotePairing record made on another host works only with `host_identifier` set to that host's id, because pair-verify presents the identifier of the host that paired.
- xtool goes through usbmuxd, which on Linux does not see network devices. go-ios builds its iOS 17+ tunnel on the USB interface or usbmux, not on a network address.
- An App Store profile cannot be installed directly; a development profile with the device UDID and `get-task-allow` can.

## Phase 1: development signing

1. `ProfileInfo` gains `kind` (`app-store` or `development`) and `devices`, read from `ProvisionedDevices` and `get-task-allow`. A profile with devices and `get-task-allow` false (ad hoc) fails with `signing_invalid`; ad hoc is out of scope.
2. Storage: the App Store identity stays in `~/.lipa/signing/<team>/`, unchanged. The development identity goes to `~/.lipa/signing/<team>/development/` with the same layout. `signingPaths(team, kind)`.
3. `lipa signing import` reads the kind from the profile, checks that the certificate subject matches it (Development or Developer against Distribution), and stores the files in the folder of that kind, mode 600.
4. `signingStatus(team, bundleId, kind)`, with a fix that names the kind.
5. `mergedEntitlements` by kind. Development: `get-task-allow` true, no `beta-reports-active`, `aps-environment` set to `development` when the project has it.
6. `lipa build --signing app-store|development`, default `app-store`. A development IPA defaults to `build/<app>-development.ipa`, so it never overwrites the App Store one.
7. `inspect` reports the profile kind and the number of devices.
8. `doctor` adds `signing_development`, skipped when there is no development identity.

Tests: kind detection, development entitlements, the certificate check on a subject string, storage paths, the `--signing` flag. Verification: `bun run verify`, a development build of a real project, `lipa inspect` all ok.

## Phase 2: device tools

1. Pin `uv` in `src/core/tools.ts`, version and sha256, like the other tools.
2. A `device/` folder, outside the compiled binary, licensed GPL-3.0 because it imports pymobiledevice3: `lipa_device.py`, `requirements.txt` with every dependency hashed (`uv pip compile --generate-hashes --python-version 3.13`), and `LICENSE`.
3. `lipa setup --only device` creates `~/.lipa/tools/device` with a Python 3.13 managed by uv and installs with `--require-hashes`. Plain `lipa setup` does not install it, so a build-only machine stays as it is.
4. The release workflow publishes `lipa_device.py` and `requirements.txt` as assets listed in `checksums.txt`. From a checkout, setup takes them from the repository.

## Phase 3: the helper

One process, one tunnel, JSON lines on stdout.

- Connection: `--host`, `--port` (default 49152), `--udid`, which defaults to the only RemotePairing record. When the port refuses, the helper scans 49152 to 49407 and keeps the first port that completes pair-verify.
- `probe`: iOS version, Developer Mode, DDI mounted.
- `run`: install the IPA, mount the personalized DDI when missing, launch the bundle id, then stream `os_trace` entries whose subsystem is the bundle id until it is stopped. `--no-logs` stops after the launch.

## Phase 4: `lipa run`

```
lipa run [<dir>] --device <host> [--port <n>] [--udid <udid>] [--ipa <path>] [--no-logs]
         [--mac <host> | --via <command>] [--update] [--clean]
```

1. Build with development signing, unless `--ipa` is given.
2. Check that the device UDID is in the `ProvisionedDevices` of the profile, before the helper starts.
3. Call the helper and pass its output through: logs on a terminal until Ctrl-C; with JSON, no logs and a result `{ ipa, device, pid }`.
4. New error `device_unreachable`, exit code 9, documented in `docs/cli.md`.

Pairing stays manual for now and is documented: `pymobiledevice3 lockdown remotepairing --pair` once over USB, then the record goes to the machine that runs lipa, with `host_identifier` when it was made elsewhere.

## Phase 5: upstream

Propose to pymobiledevice3 a way to reach a RemotePairing service by host and port without bonjour, usable by the CLI commands with the userspace tunnel. Once released, the helper can call the CLI instead of the library.

## Risks

- The RemotePairing port is not fixed; the scan covers a restart, not a firewall.
- The personalized DDI is downloaded and signed through Apple on the first mount after a reboot; not tested yet.
- Clearing trusted computers on the device revokes the record; pairing has to be done again over USB.
- The device must have its VPN up when the network is Tailscale.

## Out of scope

Ad hoc profiles, a debugger, pairing from lipa, macOS hosts.
