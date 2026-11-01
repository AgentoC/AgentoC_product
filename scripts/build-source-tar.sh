#!/bin/bash
# Export a Linux-only source tarball of the current HEAD for packaging hosts
# (local amd64 builds and remote arm64 builds alike). Everything outside Linux
# scope — Android sources/design captures, Windows test fixtures, emulator
# shots/APKs, local scratch trees — is excluded so the tarball carries only
# what the Linux deb build reads.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HEAD_HASH="$(git -C "$ROOT" rev-parse --short=8 HEAD)"
OUTPUT_DIR="${AGENTOC_SRC_TAR_OUTPUT_DIR:-/tmp}"
OUTPUT="${AGENTOC_SRC_TAR:-$OUTPUT_DIR/agentoc-src-main-$HEAD_HASH.tar}"

git -C "$ROOT" archive --format=tar \
  --output="$OUTPUT" \
  HEAD \
  -- . \
    ':(exclude)android' \
    ':(exclude)design' \
    ':(exclude)work' \
    ':(exclude)release' \
    ':(exclude)releases' \
    ':(exclude)cache' \
    ':(exclude)artifacts' \
    ':(exclude)notes' \
    ':(exclude)./-' \
    ':(exclude)*\Users\*' \
    ':(exclude)*.apk' \
    ':(exclude,top)emu-*.png' \
    ':(exclude,top)emulator-*.png'

# Stamp the exported commit into the tarball: packaging hosts extract plain
# archives (no .git), and build-deb.sh uses this marker to keep the commit in
# the generated package version.
META_DIR="$(mktemp -d)"
printf '%s\n' "$(git -C "$ROOT" rev-parse HEAD)" > "$META_DIR/.agentoc-source-commit"
tar --append --file="$OUTPUT" --directory="$META_DIR" .agentoc-source-commit
rm -rf "$META_DIR"

# Packaging-script currency: git archive only snapshots committed content, but
# the deb build must always run the live packaging logic. Replace those members
# with the working-tree copies.
for packaged_script in scripts/build-deb.sh scripts/build-source-tar.sh; do
  [ -f "$ROOT/$packaged_script" ] || continue
  tar --delete --file="$OUTPUT" "$packaged_script" 2>/dev/null || true
  tar --append --file="$OUTPUT" --directory="$ROOT" "$packaged_script"
done

printf '%s\n' "$OUTPUT"
du -h "$OUTPUT" | cut -f1
sha256sum "$OUTPUT" | cut -c1-16
