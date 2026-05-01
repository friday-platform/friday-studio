#!/usr/bin/env bash
#
# strip-dmg-applications-symlink — removes the /Applications shortcut
# from a Tauri-built macOS DMG.
#
# Why:
#   Tauri's bundler unconditionally adds an /Applications symlink to
#   every DMG it produces, intended for normal "drag the .app to your
#   Applications folder" UX. The Friday Studio Installer DMG is meant
#   to be DOUBLE-CLICKED to launch the wizard, not dragged anywhere —
#   the symlink is misleading there. As of Tauri 2.10.x there's no
#   bundle config flag to skip it (only position/background tweaks),
#   so we strip it post-bundle.
#
# How:
#   Tauri produces a UDZO (read-only compressed) DMG, so we can't edit
#   in place. We convert UDZO → UDRW, mount, rm the symlink, unmount,
#   convert back to UDZO over the original. Net effect: same DMG name,
#   same path, no Applications shortcut in the mounted view.
#
# Order in the build pipeline:
#   This MUST run AFTER `tauri build` (DMG exists) and BEFORE
#   notarization. The DMG itself isn't signed by APPLE_SIGNING_IDENTITY
#   — only the .app inside is — so re-compressing the DMG doesn't
#   invalidate any signature. Notarization will inspect the DMG, find
#   the still-signed .app inside, and notarize the new compressed DMG
#   as a unit.
#
# Usage:
#   strip-dmg-applications-symlink.sh <path-to-dmg>
#
# Exit codes:
#   0  symlink stripped (or wasn't present — both are success)
#   1  argument / preflight error
#   2  hdiutil convert/attach/detach failure
#
# Idempotent: running on a DMG that already lacks the symlink is a no-op.

set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <path-to-dmg>" >&2
  exit 1
fi

DMG="$1"
if [[ ! -f "$DMG" ]]; then
  echo "DMG not found: $DMG" >&2
  exit 1
fi

if [[ "$(uname)" != "Darwin" ]]; then
  echo "This script only runs on macOS (requires hdiutil)." >&2
  exit 1
fi

WORK="$(mktemp -d)"
RW="$WORK/rw.dmg"
MOUNT="$WORK/mount"
mkdir -p "$MOUNT"

cleanup() {
  # Best-effort detach; don't fail the script if the volume is already gone.
  if mount | grep -F " on $MOUNT " >/dev/null 2>&1; then
    hdiutil detach "$MOUNT" -quiet || hdiutil detach "$MOUNT" -force -quiet || true
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

echo "→ Stripping Applications symlink from $(basename "$DMG")"

echo "  1/4  convert UDZO → UDRW"
hdiutil convert "$DMG" -format UDRW -o "$RW" -quiet

echo "  2/4  mount"
hdiutil attach "$RW" -mountpoint "$MOUNT" -nobrowse -noverify -noautoopen -quiet

if [[ -L "$MOUNT/Applications" ]]; then
  echo "  3/4  rm Applications symlink"
  rm "$MOUNT/Applications"
else
  # Idempotent path: someone re-ran the script, or Tauri changed behavior.
  echo "  3/4  no Applications symlink present (skipping)"
fi

echo "  4/4  detach and re-compress UDRW → UDZO"
hdiutil detach "$MOUNT" -quiet
# zlib-level=9 matches Tauri's default compression so the resulting DMG
# size is comparable to (or slightly smaller than) the original.
#
# Write to $WORK/stripped.dmg (inside our temp dir) rather than alongside
# the input — hdiutil unconditionally appends ".dmg" to -o when the path
# doesn't already end in .dmg, which would break a "$DMG.tmp" → mv pattern.
hdiutil convert "$RW" -format UDZO -imagekey zlib-level=9 -o "$WORK/stripped.dmg" -quiet
mv "$WORK/stripped.dmg" "$DMG"

echo "✓ Done: $DMG"
