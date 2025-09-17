#!/bin/bash
# Convert Atlas version formats to semver for npm/electron-builder compatibility
# Usage: ./convert-version-to-semver.sh <version>

version="$1"

if [[ "$version" =~ ^(edge|nightly)-(.+)-(.+)(-(.+))?$ ]]; then
  # edge-20250710-072728-fda047c or nightly-20250710-fda047c
  channel="${BASH_REMATCH[1]}"
  parts=(${version//-/ })

  if [ "$channel" = "edge" ] && [ "${#parts[@]}" -eq 4 ]; then
    # edge-DATE-TIME-SHA -> 0.0.0-edge.SHA.DATE.TIME
    echo "0.0.0-edge.${parts[3]}.${parts[1]}.${parts[2]}"
  else
    # nightly-DATE-SHA -> 0.0.0-nightly.SHA.DATE
    echo "0.0.0-nightly.${parts[2]}.${parts[1]}"
  fi
elif [[ "$version" =~ ^v(.+)$ ]]; then
  # v1.2.3 -> 1.2.3
  echo "${BASH_REMATCH[1]}"
else
  # Already semver or unknown format
  echo "$version"
fi