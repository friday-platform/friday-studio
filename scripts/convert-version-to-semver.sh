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
    # Remove leading zeros from TIME and SHA to comply with semver
    time_no_zeros=$(echo "${parts[2]}" | sed 's/^0*//')
    [ -z "$time_no_zeros" ] && time_no_zeros="0"
    sha_no_zeros=$(echo "${parts[3]}" | sed 's/^0*//')
    [ -z "$sha_no_zeros" ] && sha_no_zeros="0"
    echo "0.0.0-edge.${sha_no_zeros}.${parts[1]}.${time_no_zeros}"
  else
    # nightly-DATE-SHA -> 0.0.0-nightly.SHA.DATE
    # Remove leading zeros from SHA to comply with semver
    sha_no_zeros=$(echo "${parts[2]}" | sed 's/^0*//')
    [ -z "$sha_no_zeros" ] && sha_no_zeros="0"
    echo "0.0.0-nightly.${sha_no_zeros}.${parts[1]}"
  fi
elif [[ "$version" =~ ^v(.+)$ ]]; then
  # v1.2.3 -> 1.2.3
  echo "${BASH_REMATCH[1]}"
else
  # Already semver or unknown format
  echo "$version"
fi