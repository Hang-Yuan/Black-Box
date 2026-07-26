#!/usr/bin/env bash
set -euo pipefail

artifact_path="${1:-}"
archive_root="${2:-}"
explicit_version="${3:-}"

if [[ -z "$artifact_path" || -z "$archive_root" ]]; then
  echo "Usage: $0 <artifact.dmg> <archive-root> [version]" >&2
  exit 2
fi

if [[ ! -f "$artifact_path" ]]; then
  echo "ERROR: artifact not found: $artifact_path" >&2
  exit 1
fi

artifact_name="$(basename "$artifact_path")"
if [[ "$artifact_name" != *.dmg ]]; then
  echo "ERROR: only DMG artifacts can be archived: $artifact_name" >&2
  exit 1
fi

version="$explicit_version"
if [[ -z "$version" ]]; then
  if [[ "$artifact_name" =~ _([0-9]+\.[0-9]+\.[0-9]+)_ ]]; then
    version="${BASH_REMATCH[1]}"
  else
    echo "ERROR: cannot infer a semantic version from: $artifact_name" >&2
    exit 1
  fi
fi

version_dir="$archive_root/v$version"
destination="$version_dir/$artifact_name"
mkdir -p "$version_dir"

source_sha="$(shasum -a 256 "$artifact_path" | awk '{print $1}')"

if [[ -e "$destination" ]]; then
  destination_sha="$(shasum -a 256 "$destination" | awk '{print $1}')"
  if [[ "$destination_sha" != "$source_sha" ]]; then
    echo "ERROR: immutable artifact conflict for $destination" >&2
    echo "existing=$destination_sha incoming=$source_sha" >&2
    exit 1
  fi
else
  artifact_tmp="$(mktemp "$version_dir/.artifact.XXXXXX")"
  cleanup_artifact_tmp() {
    rm -f "$artifact_tmp"
  }
  trap cleanup_artifact_tmp EXIT

  cp -p "$artifact_path" "$artifact_tmp"
  copied_sha="$(shasum -a 256 "$artifact_tmp" | awk '{print $1}')"
  if [[ "$copied_sha" != "$source_sha" ]]; then
    echo "ERROR: artifact checksum changed while copying" >&2
    exit 1
  fi

  if [[ -e "$destination" ]]; then
    destination_sha="$(shasum -a 256 "$destination" | awk '{print $1}')"
    if [[ "$destination_sha" != "$source_sha" ]]; then
      echo "ERROR: immutable artifact conflict for $destination" >&2
      exit 1
    fi
  else
    mv "$artifact_tmp" "$destination"
  fi
fi

manifest_tmp="$(mktemp "$version_dir/.SHA256SUMS.XXXXXX")"
cleanup_manifest_tmp() {
  rm -f "$manifest_tmp"
}
trap cleanup_manifest_tmp EXIT

for archived_dmg in "$version_dir"/*.dmg; do
  archived_name="$(basename "$archived_dmg")"
  archived_sha="$(shasum -a 256 "$archived_dmg" | awk '{print $1}')"
  printf '%s  %s\n' "$archived_sha" "$archived_name"
done | LC_ALL=C sort > "$manifest_tmp"

mv "$manifest_tmp" "$version_dir/SHA256SUMS"
trap - EXIT

echo "$destination"
echo "$source_sha"
