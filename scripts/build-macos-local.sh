#!/usr/bin/env bash
set -euo pipefail

# Local-only release builder for the current Mac architecture.
# It never uploads artifacts and does not use the disabled app-updater key.

project_dir="$(cd "$(dirname "$0")/.." && pwd)"
cd "$project_dir"

archive_root="${BLACKBOX_RELEASE_ARCHIVE_DIR:-$project_dir/release-artifacts}"
archive_helper="$project_dir/scripts/archive-release-artifact.sh"
release_manifest_helper="$project_dir/scripts/write-release-manifest.mjs"
release_bundle_checker="$project_dir/scripts/check-release-bundle.mjs"

preserve_existing_dmgs() {
  local dmg_dir="$project_dir/src-tauri/target/release/bundle/dmg"
  local existing_dmg

  [[ -d "$dmg_dir" ]] || return 0
  shopt -s nullglob
  for existing_dmg in "$dmg_dir"/*.dmg; do
    bash "$archive_helper" "$existing_dmg" "$archive_root"
  done
  shopt -u nullglob
}

command -v node >/dev/null || { echo "ERROR: node not found"; exit 1; }
command -v pnpm >/dev/null || { echo "ERROR: pnpm not found"; exit 1; }
command -v cargo >/dev/null || { echo "ERROR: cargo not found"; exit 1; }
command -v codesign >/dev/null || { echo "ERROR: codesign not found"; exit 1; }
command -v hdiutil >/dev/null || { echo "ERROR: hdiutil not found"; exit 1; }

package_version="$(node -p "require('./package.json').version")"
tauri_version="$(node -p "require('./src-tauri/tauri.conf.json').version")"
cargo_version="$(awk -F '"' '/^version = "/ { print $2; exit }' src-tauri/Cargo.toml)"

if [[ "$package_version" != "$tauri_version" || "$package_version" != "$cargo_version" ]]; then
  echo "ERROR: version mismatch: package=$package_version tauri=$tauri_version cargo=$cargo_version"
  exit 1
fi

echo "Black Box local DMG build · v$package_version · $(uname -m)"
echo "This build is local/ad-hoc signed and is not uploaded anywhere."
echo "Immutable local archive: $archive_root"

# Tauri recreates the bundle output directory during a release build. Preserve
# every existing version before that cleanup starts.
preserve_existing_dmgs

pnpm install --frozen-lockfile

if [[ "${SKIP_TESTS:-0}" != "1" ]]; then
  pnpm exec vitest run
  cargo test --manifest-path src-tauri/Cargo.toml --lib
fi

# Freeze the exact source candidate before compilation. The resulting Git tree
# and aggregate content hash are later bound to the archived DMG, so a local
# artifact can always be traced back to the source bytes that produced it.
candidate_private_roots="$HOME:$project_dir"
if [[ -n "${BLACKBOX_PRIVATE_ROOTS:-}" ]]; then
  candidate_private_roots="$BLACKBOX_PRIVATE_ROOTS:$candidate_private_roots"
fi
candidate_audit_output="$(BLACKBOX_PRIVATE_ROOTS="$candidate_private_roots" node scripts/candidate-audit.mjs)"
printf '%s\n' "$candidate_audit_output"
candidate_audit_report="$(printf '%s' "$candidate_audit_output" | node -e '
  const fs = require("node:fs");
  const value = JSON.parse(fs.readFileSync(0, "utf8"));
  if (!value.passed || !value.reportFile) process.exit(2);
  process.stdout.write(value.reportFile);
')"
candidate_audit_report="$project_dir/$candidate_audit_report"

# Rust panic locations otherwise retain absolute Cargo registry paths, including
# the local account name. Remap the entire home prefix to a neutral relative
# provenance root before release compile; this avoids both host-private paths and
# a synthetic `/home` path that could be mistaken for another user's directory.
encoded_separator=$'\x1f'
remap_flag="--remap-path-prefix=$HOME=rust-src"
if [[ -n "${CARGO_ENCODED_RUSTFLAGS:-}" ]]; then
  export CARGO_ENCODED_RUSTFLAGS="${CARGO_ENCODED_RUSTFLAGS}${encoded_separator}${remap_flag}"
else
  export CARGO_ENCODED_RUSTFLAGS="$remap_flag"
fi

pnpm tauri build --bundles app,dmg --ci

app_path="src-tauri/target/release/bundle/macos/Black Box.app"
dmg_dir="src-tauri/target/release/bundle/dmg"
dmg_path="$(find "$dmg_dir" -maxdepth 1 -type f -name "*_${package_version}_*.dmg" -print | sort | tail -n 1)"

[[ -d "$app_path" ]] || { echo "ERROR: app bundle not found: $app_path"; exit 1; }
[[ -f "$dmg_path" ]] || { echo "ERROR: DMG not found for v$package_version"; exit 1; }
node "$release_bundle_checker" "$app_path"

codesign --verify --deep --strict --verbose=2 "$app_path"
hdiutil verify "$dmg_path"
bundle_version="$(defaults read "$project_dir/$app_path/Contents/Info" CFBundleShortVersionString)"
[[ "$bundle_version" == "$package_version" ]] || {
  echo "ERROR: bundle version mismatch: expected $package_version, got $bundle_version"
  exit 1
}

archive_result="$(bash "$archive_helper" "$dmg_path" "$archive_root" "$package_version")"
archived_dmg="$(printf '%s\n' "$archive_result" | sed -n '1p')"
archived_sha="$(printf '%s\n' "$archive_result" | sed -n '2p')"
release_manifest="$archive_root/v$package_version/RELEASE_MANIFEST.json"
release_manifest_result="$(node "$release_manifest_helper" \
  "$archived_dmg" \
  "$candidate_audit_report" \
  "$release_manifest" \
  "$package_version")"

echo ""
echo "DMG: $project_dir/$dmg_path"
shasum -a 256 "$dmg_path"
echo "Archived DMG: $archived_dmg"
echo "Archived SHA-256: $archived_sha"
printf '%s\n' "$release_manifest_result"
echo "Local build complete. Public distribution still requires a Developer ID certificate and notarization."
