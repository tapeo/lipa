#!/bin/sh
#
# Installs the lipa binary from a GitHub release.
#
#   curl -fsSL https://github.com/tapeo/lipa/releases/latest/download/install.sh | sh
#
set -eu

repo="${LIPA_REPO:-tapeo/lipa}"
version="${LIPA_VERSION:-latest}"
home="${LIPA_HOME:-$HOME/.lipa}"

fail() {
  echo "$1" >&2
  exit 1
}

[ "$(uname -s)" = Linux ] || fail "lipa installs on Linux only"

case "$(uname -m)" in
  x86_64 | amd64) asset=lipa-linux-x64 ;;
  aarch64 | arm64) asset=lipa-linux-arm64 ;;
  *) fail "Unsupported architecture: $(uname -m)" ;;
esac

if [ "$version" = latest ]; then
  base="https://github.com/$repo/releases/latest/download"
else
  base="https://github.com/$repo/releases/download/$version"
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

command -v curl >/dev/null 2>&1 || fail "Missing curl"
command -v sha256sum >/dev/null 2>&1 || fail "Missing sha256sum"

curl -fsSL "$base/$asset" -o "$tmp/$asset" || fail "Cannot download $base/$asset"
curl -fsSL "$base/checksums.txt" -o "$tmp/checksums.txt" || fail "Cannot download checksums.txt"

expected=$(grep " $asset$" "$tmp/checksums.txt" | cut -d' ' -f1)

[ -n "$expected" ] || fail "No checksum for $asset"
actual=$(sha256sum "$tmp/$asset" | cut -d' ' -f1)

[ "$expected" = "$actual" ] || fail "Checksum mismatch for $asset"

mkdir -p "$home/bin"
install -m 755 "$tmp/$asset" "$home/bin/lipa"

echo "lipa installed in $home/bin"
echo "Add it to your PATH: export PATH=\"$home/bin:\$PATH\""
