# lipa agent guide

Instructions for agents. They extend the global instructions.

## Context

- Product: a CLI that builds a signed iOS IPA on Linux. The Mac is used only for `actool` and for the Xcode SDK.
- Docs: `README.md` for usage, `docs/architecture.md` for the pipeline, `docs/cli.md` for commands.
- Current state: the latest `changes/` folder.

## Stack

- TypeScript strict on Bun, one binary with `bun build --compile`, no runtime dependencies.
- Lint and format: Biome. Full check: `bun run verify` (biome, tsc, test).
- Tools lipa installs are pinned in `src/core/tools.ts` with a sha256, and `setup` refuses a different hash.

## Project rules

- Every command answers JSON without a TTY or with `--json`, with the envelope `{ ok, data }` or `{ ok: false, error: { code, message, fix } }`.
- Exit codes are stable: 2 usage, 3 capability, 4 prebuilt_stale, 5 sdk_mismatch, 6 signing_invalid, 7 ipa_invalid, 8 remote_unreachable.
- `project.yml` is read, never written. Nothing of lipa goes inside a project except the IPA in `build/`.
- The Mac transport is generic: `ssh <host>` by default, or any command given with `--via` that runs `sh` there and passes stdin and stdout. lipa names no external tool of a user.
- Pure decisions (project.yml to a build spec, plist, Mach-O, entitlements, hashes, IPA checks) live in `src/core` and are tested without network, devices or a Mac.
- The binary that ships must stay generic: no app name, bundle id, team or path of a specific project in `src/`.
- The main executable inside the IPA must be mode 755, the SDK field in `LC_BUILD_VERSION` must be the linked SDK, and the assets must come from the cache that matches the asset catalog hash. `inspect` exists to catch all three.
- Never log a key, a profile or an App Store Connect token. Signing files are mode 600 under `~/.lipa/signing`.
- CLI text and docs in English, sentence case, no em dash.

## Verification

1. `bun run verify` passes.
2. `lipa doctor <project>` reports every check ok on the machine.
3. A release build of a real project ends with `lipa inspect` all ok. Run it before a release, not on every change.
4. Add a `changes/YYYY-MM-DD_HH-MM_slug/README.md` entry.
5. Grep changed files for em dashes.
