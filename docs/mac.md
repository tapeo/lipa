# The Mac side

lipa needs the Mac for `actool` and for nothing else. It never installs anything there, writes nothing there and copies nothing back except the compiled asset catalog, or Xcode itself when `lipa sdk --mac` asks for it.

The pinned tools target Xcode 27 and the iOS 27 SDK. The commands below are the ones `lipa doctor --mac <host>` checks.

## Remote Login

System Settings, General, Sharing, Remote Login, on. The user named in the ssh command must be allowed to log in.

A key is the simplest way, and lipa requires one: ssh runs without a password prompt.

```bash
ssh-keygen -t ed25519 -C lipa
ssh-copy-id me@192.168.1.10
ssh me@192.168.1.10 true
```

The last line must print nothing and exit 0. If it asks for a password, the key is not in place yet.

## An alias in ~/.ssh/config

Anything ssh can do goes here, so `--mac` stays short:

```
Host macbook
  HostName 192.168.1.10
  User me
  IdentityFile ~/.ssh/id_ed25519
  ServerAliveInterval 30
```

```bash
ssh macbook true
lipa doctor --mac macbook
```

A different port, a jump host or a proxy all belong in this block. `--via <command>` exists for machines reachable some other way: it runs `<command> '<script>'` and takes the place of ssh.

## Xcode

```bash
sudo xcode-select -s /Applications/Xcode.app
sudo xcodebuild -license accept
xcodebuild -runFirstLaunch
xcrun --sdk iphoneos --show-sdk-version
```

- `xcode-select -p` must print a path inside `Xcode.app`, not `/Library/Developer/CommandLineTools`.
- The license has to be accepted once per machine, or `xcodebuild` refuses to answer.
- `-runFirstLaunch` installs the components that `actool` and the iOS platform need. If `xcrun -f actool` fails, the iOS platform is missing: Xcode, Settings, Components, then install the iOS platform.
- The last command prints the iOS SDK version on the Mac. `doctor --mac` compares it with the SDK on Linux: installing the SDK from that Xcode keeps the two aligned.

## What doctor runs

One ssh call, read only:

| Command | What it tells |
|---|---|
| `sw_vers -productVersion` | the version of macOS |
| `xcode-select -p` | which Xcode is selected |
| `xcodebuild -version` | the Xcode version, or that the license is not accepted |
| `xcrun -f actool` | whether the asset compiler is there |
| `xcrun --sdk iphoneos --show-sdk-version` | the iOS SDK on the Mac |

Nothing else runs, and nothing is written.

## The actool step

`lipa prepare --mac macbook` sends a tar with the asset catalog and a `run.sh`, which the Mac unpacks in a temporary directory and runs. The script calls `xcrun actool` and `PlistBuddy`, writes a tar on stdout, and the remote directory is removed on exit.

The compile happens on the Mac only when the cache is stale: a different tree hash of the asset catalog, a different Xcode build or a different SDK. Running `prepare` and `build` with `--mac` on a fresh cache does not open a connection.

When `actool` fails, its own message comes back in the error, so a catalog with an icon set named wrong says so instead of failing with an empty message.

## Failures

| What happens | Code | What to do |
|---|---|---|
| ssh cannot connect or authenticate | `remote_unreachable`, 8 | `lipa doctor --mac <host>`, then fix the key or the address |
| Xcode missing, not selected or not licensed | `capability_missing`, 3 | the fix printed in the error, on the Mac |
| `actool` reports a bad catalog | `remote_unreachable`, 8 | the message from `actool` is in the error |

lipa never waits on a password prompt: `BatchMode=yes` and a ten second connect timeout turn a silent hang into an error.
