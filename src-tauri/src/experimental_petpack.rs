//! Disabled-by-default PetPack v1 validation boundary.
//!
//! This module validates an explicit local pack directory, its immutable
//! manifest, referenced assets, provenance receipt and rights review. It does
//! not activate a pack, render an asset, change the current desktop companion
//! or export creator content. The current code-native companion remains the
//! only production authority.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Cursor, Read};
use std::path::{Component, Path, PathBuf};

#[cfg(unix)]
use std::ffi::CString;
#[cfg(unix)]
use std::os::fd::{AsRawFd, FromRawFd};
#[cfg(unix)]
use std::os::unix::ffi::OsStrExt;
#[cfg(unix)]
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};

const PETPACK_FLAG: &str = "BLACKBOX_EXPERIMENTAL_PETPACK_V1";
const HOME_OVERRIDE: &str = "BLACKBOX_EXPERIMENTAL_HOME";
const PETPACK_SCHEMA_VERSION: u8 = 1;
const MAX_MANIFEST_BYTES: u64 = 512 * 1024;
const MAX_RECEIPT_BYTES: u64 = 512 * 1024;
const MAX_ASSET_BYTES: u64 = 100 * 1024 * 1024;
const HARD_PACK_BYTES: u64 = 8 * 1024 * 1024;
const MAX_DECODED_PNG_BYTES: usize = 2048 * 2048 * 4;
const HARD_RESIDENT_MIB: u64 = 120;
const HARD_GPU_MIB: u64 = 128;
const HARD_TARGET_FPS: u64 = 30;
const REQUIRED_STATES: &[&str] = &["idle", "thinking", "tool", "running", "waiting", "error"];
const PETPACK_SCHEMA_JSON: &str = include_str!("../resources/experimental/petpack-v1.schema.json");

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExperimentalPetPackStatus {
    enabled: bool,
    production_integration: bool,
    validation_available: bool,
    activation_enabled: bool,
    creator_export_enabled: bool,
    schema_version: u8,
    schema_sha256: String,
    required_states: Vec<String>,
    performance_measurement_required: bool,
    rights_approval_required: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ValidatePetPackInput {
    pack_root: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PetPackValidationReport {
    valid: bool,
    pack_id: String,
    version: String,
    status: String,
    species: String,
    schema_version: u8,
    schema_sha256: String,
    manifest_sha256: String,
    asset_root_sha256: String,
    required_states_validated: usize,
    unique_primary_assets: usize,
    reduced_motion_assets: usize,
    total_unique_asset_bytes: u64,
    alpha_assets_validated: usize,
    provenance_receipt_validated: bool,
    rights_receipt_integrity_validated: bool,
    declared_performance_within_hard_limits: bool,
    performance_measured: bool,
    ship_eligible: bool,
    activation_enabled: bool,
    creator_export_enabled: bool,
    production_integration: bool,
    blockers: Vec<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PetPackManifest {
    schema_version: u8,
    status: String,
    pack_id: String,
    version: String,
    display_name: String,
    #[serde(default)]
    description: Option<String>,
    species: String,
    renderer: RendererContract,
    license: LicenseContract,
    asset_root_sha256: String,
    performance: PerformanceContract,
    states: BTreeMap<String, StateContract>,
    #[serde(default)]
    customization: Option<Vec<Value>>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RendererContract {
    #[serde(rename = "type")]
    renderer_type: String,
    pixel_size: PixelSize,
    anchor: Anchor,
    hit_regions: Vec<HitRegion>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PixelSize {
    width: u32,
    height: u32,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Anchor {
    x: f64,
    y: f64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HitRegion {
    id: String,
    shape: String,
    action: String,
    bounds: [f64; 4],
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LicenseContract {
    asset_owner: String,
    source: String,
    provenance: String,
    receipt_relative_path: String,
    receipt_sha256: String,
    current_use: String,
    commercial_use: bool,
    redistribution: bool,
    modification: bool,
    attribution_required: bool,
    #[serde(default)]
    attribution_text: Option<String>,
    #[serde(default)]
    likeness_release_reference: Option<String>,
    legal_review_required: bool,
    license_text_sha256: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PerformanceContract {
    max_resident_mi_b: u64,
    max_gpu_mi_b: u64,
    target_fps: u64,
    max_asset_bytes: u64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StateContract {
    asset: String,
    asset_sha256: String,
    asset_byte_size: u64,
    mime_type: String,
    r#loop: bool,
    duration_ms: u64,
    fallback: String,
    #[serde(default)]
    audio: Option<String>,
    #[serde(default)]
    reduced_motion: Option<ReducedMotionContract>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReducedMotionContract {
    asset: String,
    asset_sha256: String,
    asset_byte_size: u64,
    mime_type: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RightsReview {
    schema_version: u8,
    pack_id: String,
    status: String,
    allowed_now: Vec<String>,
    blocked_until_legal_review: Vec<String>,
    named_franchise_or_person_likeness: bool,
    production_approval: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProvenanceReceipt {
    schema_version: u8,
    receipt_class: String,
    pack_id: String,
    derived_asset: ProvenanceDerivedAsset,
    rights: ProvenanceRights,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProvenanceDerivedAsset {
    relative_path: String,
    sha256: String,
    byte_size: u64,
    mime_type: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProvenanceRights {
    current_use: String,
    production_redistribution_approved: bool,
    legal_review_required_before_shipping: bool,
    third_party_likeness_used: bool,
}

#[derive(Clone, Debug)]
struct FileEvidence {
    sha256: String,
    byte_size: u64,
    bytes: Vec<u8>,
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn feature_enabled() -> bool {
    std::env::var(PETPACK_FLAG)
        .map(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes"
            )
        })
        .unwrap_or(false)
}

fn status() -> ExperimentalPetPackStatus {
    let enabled = feature_enabled();
    ExperimentalPetPackStatus {
        enabled,
        production_integration: false,
        validation_available: enabled && cfg!(unix),
        activation_enabled: false,
        creator_export_enabled: false,
        schema_version: PETPACK_SCHEMA_VERSION,
        schema_sha256: sha256_hex(PETPACK_SCHEMA_JSON.as_bytes()),
        required_states: REQUIRED_STATES
            .iter()
            .map(|state| state.to_string())
            .collect(),
        performance_measurement_required: true,
        rights_approval_required: true,
    }
}

fn experimental_root() -> Result<PathBuf, String> {
    if let Ok(raw) = std::env::var(HOME_OVERRIDE) {
        let path = PathBuf::from(raw.trim());
        if !path.is_absolute() {
            return Err(format!("{HOME_OVERRIDE} must be an absolute path"));
        }
        return Ok(path);
    }
    Ok(crate::safe_data_dir()?.join("experimental-foundation-v1"))
}

fn normalize_pack_root(raw: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(raw);
    if !path.is_absolute() {
        return Err("PetPack root must be absolute".to_string());
    }
    if path
        .components()
        .any(|component| matches!(component, Component::CurDir | Component::ParentDir))
    {
        return Err("PetPack root must not contain relative path components".to_string());
    }
    let metadata = fs::symlink_metadata(&path)
        .map_err(|error| format!("Failed to inspect PetPack root: {error}"))?;
    if metadata.file_type().is_symlink() {
        return Err("PetPack root symlinks are not allowed".to_string());
    }
    if !metadata.is_dir() {
        return Err("PetPack root must be a directory".to_string());
    }
    fs::canonicalize(&path).map_err(|error| format!("Failed to canonicalize PetPack root: {error}"))
}

fn canonical_with_missing_tail(path: &Path) -> Result<PathBuf, String> {
    let mut cursor = path;
    let mut missing = Vec::new();
    loop {
        match fs::canonicalize(cursor) {
            Ok(mut canonical) => {
                for component in missing.iter().rev() {
                    canonical.push(component);
                }
                return Ok(canonical);
            }
            Err(_) => {
                let name = cursor.file_name().ok_or_else(|| {
                    format!(
                        "Failed to resolve Black Box control root {}",
                        path.display()
                    )
                })?;
                missing.push(name.to_os_string());
                cursor = cursor.parent().ok_or_else(|| {
                    format!(
                        "Failed to resolve Black Box control root {}",
                        path.display()
                    )
                })?;
            }
        }
    }
}

fn ensure_outside_control_roots(
    pack_root: &Path,
    production_root: &Path,
    experimental_root: &Path,
) -> Result<(), String> {
    let canonical_pack = canonical_with_missing_tail(pack_root)?;
    for control_root in [production_root, experimental_root] {
        let canonical_control = canonical_with_missing_tail(control_root)?;
        if canonical_pack.starts_with(&canonical_control)
            || canonical_control.starts_with(&canonical_pack)
        {
            return Err(
                "PetPack root must not overlap Black Box production or experimental control data"
                    .to_string(),
            );
        }
    }
    Ok(())
}

fn validate_relative_path(raw: &str, assets_only: bool) -> Result<PathBuf, String> {
    if raw.is_empty() || raw.len() > 512 || raw.contains('\\') || raw.contains('\0') {
        return Err("PetPack relative path is invalid".to_string());
    }
    let path = PathBuf::from(raw);
    if path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(format!("Unsafe PetPack relative path: {raw}"));
    }
    if assets_only
        && path
            .components()
            .next()
            .and_then(|component| component.as_os_str().to_str())
            != Some("assets")
    {
        return Err(format!("PetPack asset must stay under assets/: {raw}"));
    }
    Ok(path)
}

#[cfg(not(unix))]
fn open_relative_read_only(root: &Path, raw: &str, assets_only: bool) -> Result<File, String> {
    let _ = root;
    validate_relative_path(raw, assets_only)?;
    Err("Secure PetPack descriptor traversal is unavailable on this platform".to_string())
}

#[cfg(unix)]
fn open_directory_chain(root: &Path) -> Result<File, String> {
    let root_before = fs::symlink_metadata(root)
        .map_err(|error| format!("Failed to inspect PetPack root: {error}"))?;
    if root_before.file_type().is_symlink() || !root_before.is_dir() {
        return Err("PetPack root must remain a non-symlink directory".to_string());
    }

    let mut slash_options = OpenOptions::new();
    slash_options
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC);
    let mut parent = slash_options
        .open("/")
        .map_err(|error| format!("Failed to open filesystem root descriptor: {error}"))?;
    for component in root.components() {
        match component {
            Component::RootDir => continue,
            Component::Normal(name) => {
                let name = CString::new(name.as_bytes())
                    .map_err(|_| "PetPack root contains NUL bytes".to_string())?;
                let flags = libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC;
                // SAFETY: `parent` owns a live directory descriptor and `name` is a
                // NUL-terminated single path component. The returned descriptor is
                // checked before ownership is transferred to `File`.
                let descriptor = unsafe { libc::openat(parent.as_raw_fd(), name.as_ptr(), flags) };
                if descriptor < 0 {
                    let error = std::io::Error::last_os_error();
                    return Err(format!(
                        "PetPack root contains a missing or unsafe path component: {error}"
                    ));
                }
                // SAFETY: `openat` returned a new non-negative descriptor that has
                // not been transferred or closed elsewhere.
                parent = unsafe { File::from_raw_fd(descriptor) };
            }
            _ => return Err("PetPack root contains unsupported path components".to_string()),
        }
    }
    let root_after = parent
        .metadata()
        .map_err(|error| format!("Failed to inspect PetPack root descriptor: {error}"))?;
    if root_before.dev() != root_after.dev() || root_before.ino() != root_after.ino() {
        return Err("PetPack root changed while it was being opened".to_string());
    }
    Ok(parent)
}

#[cfg(unix)]
fn open_relative_read_only(root: &Path, raw: &str, assets_only: bool) -> Result<File, String> {
    let relative = validate_relative_path(raw, assets_only)?;
    let components = relative
        .components()
        .map(|component| component.as_os_str().to_os_string())
        .collect::<Vec<_>>();
    let mut parent = open_directory_chain(root)?;
    for (index, component) in components.iter().enumerate() {
        let name = CString::new(component.as_bytes())
            .map_err(|_| format!("PetPack path contains NUL bytes: {raw}"))?;
        let is_last = index + 1 == components.len();
        let flags = libc::O_RDONLY
            | libc::O_NOFOLLOW
            | libc::O_CLOEXEC
            | if is_last {
                libc::O_NONBLOCK
            } else {
                libc::O_DIRECTORY
            };
        // SAFETY: `parent` owns a live directory descriptor and `name` is a
        // NUL-terminated single relative component. O_NOFOLLOW applies to every
        // hop, and non-final hops must also be directories.
        let descriptor = unsafe { libc::openat(parent.as_raw_fd(), name.as_ptr(), flags) };
        if descriptor < 0 {
            let error = std::io::Error::last_os_error();
            return Err(format!(
                "PetPack path component is missing, unsafe, or a symlink ({raw}): {error}"
            ));
        }
        // SAFETY: `openat` returned a fresh non-negative descriptor and this is
        // the only transfer of ownership.
        let opened = unsafe { File::from_raw_fd(descriptor) };
        if is_last {
            return Ok(opened);
        }
        parent = opened;
    }
    Err(format!("PetPack relative path is empty: {raw}"))
}

#[cfg(unix)]
fn metadata_unchanged(before: &fs::Metadata, after: &fs::Metadata) -> bool {
    before.dev() == after.dev()
        && before.ino() == after.ino()
        && before.len() == after.len()
        && before.mtime() == after.mtime()
        && before.mtime_nsec() == after.mtime_nsec()
        && before.ctime() == after.ctime()
        && before.ctime_nsec() == after.ctime_nsec()
}

#[cfg(not(unix))]
fn metadata_unchanged(before: &fs::Metadata, after: &fs::Metadata) -> bool {
    before.len() == after.len() && before.modified().ok() == after.modified().ok()
}

fn read_evidence(
    root: &Path,
    raw: &str,
    limit: u64,
    assets_only: bool,
    expected_byte_size: Option<u64>,
) -> Result<FileEvidence, String> {
    let mut file = open_relative_read_only(root, raw, assets_only)?;
    let before = file
        .metadata()
        .map_err(|error| format!("Failed to inspect PetPack file {raw}: {error}"))?;
    if !before.is_file() || before.len() == 0 {
        return Err(format!(
            "PetPack file {raw} is empty or exceeds its byte limit"
        ));
    }
    if expected_byte_size.is_some_and(|expected| before.len() != expected) {
        return Err(format!(
            "PetPack file {raw} does not match its declared byte size"
        ));
    }
    if before.len() > limit {
        return Err(format!("PetPack file {raw} exceeds its byte limit"));
    }

    let mut hasher = Sha256::new();
    let capacity = usize::try_from(before.len())
        .map_err(|_| format!("PetPack file {raw} cannot fit in memory"))?;
    let mut bytes = Vec::with_capacity(capacity);
    let mut total = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("Failed to read PetPack file {raw}: {error}"))?;
        if read == 0 {
            break;
        }
        total = total
            .checked_add(read as u64)
            .ok_or_else(|| format!("PetPack file {raw} size overflow"))?;
        if total > limit {
            return Err(format!("PetPack file {raw} exceeds its byte limit"));
        }
        bytes.extend_from_slice(&buffer[..read]);
        hasher.update(&buffer[..read]);
    }
    let after = file
        .metadata()
        .map_err(|error| format!("Failed to re-inspect PetPack file {raw}: {error}"))?;
    if before.len() != total || after.len() != total || !metadata_unchanged(&before, &after) {
        return Err(format!(
            "PetPack file {raw} changed while it was being validated"
        ));
    }
    Ok(FileEvidence {
        sha256: format!("{:x}", hasher.finalize()),
        byte_size: total,
        bytes,
    })
}

fn read_json_evidence(root: &Path, raw: &str, limit: u64) -> Result<FileEvidence, String> {
    read_evidence(root, raw, limit, false, None)
}

fn validate_sha256(name: &str, value: &str) -> Result<(), String> {
    if value.len() == 64
        && value.bytes().all(|byte| byte.is_ascii_hexdigit())
        && value == value.to_ascii_lowercase()
    {
        Ok(())
    } else {
        Err(format!("{name} must be a lowercase SHA-256 hex digest"))
    }
}

fn validate_token(name: &str, value: &str) -> Result<(), String> {
    let valid = (3..=64).contains(&value.len())
        && value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_lowercase()
                || byte.is_ascii_digit()
                || (index > 0 && matches!(byte, b'.' | b'_' | b'-'))
        });
    if valid {
        Ok(())
    } else {
        Err(format!("{name} is not a safe PetPack token"))
    }
}

fn validate_semver(value: &str) -> bool {
    let parts: Vec<&str> = value.split('.').collect();
    parts.len() == 3
        && parts
            .iter()
            .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
}

fn validate_mime(
    reference: &StateContract,
    evidence: &FileEvidence,
    renderer: &RendererContract,
) -> Result<bool, String> {
    if renderer.renderer_type != "png_sequence" || reference.mime_type != "image/png" {
        return Err(format!(
            "PetPack renderer {} is not supported by the current full decoder boundary",
            renderer.renderer_type
        ));
    }
    validate_alpha_png(
        &reference.asset,
        evidence,
        renderer.pixel_size.width,
        renderer.pixel_size.height,
    )
}

fn validate_reduced_mime(
    reference: &ReducedMotionContract,
    evidence: &FileEvidence,
    renderer: &RendererContract,
) -> Result<bool, String> {
    if reference.mime_type != "image/png" {
        return Err(
            "Reduced-motion assets must use the fully decoded PNG format in this validation slice"
                .to_string(),
        );
    }
    validate_alpha_png(
        &reference.asset,
        evidence,
        renderer.pixel_size.width,
        renderer.pixel_size.height,
    )
}

fn validate_alpha_png(
    asset: &str,
    evidence: &FileEvidence,
    expected_width: u32,
    expected_height: u32,
) -> Result<bool, String> {
    let mut decoder = png::Decoder::new_with_limits(
        Cursor::new(evidence.bytes.as_slice()),
        png::Limits {
            bytes: MAX_DECODED_PNG_BYTES,
        },
    );
    decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
    let mut reader = decoder
        .read_info()
        .map_err(|error| format!("PetPack asset {asset} is not a valid PNG: {error}"))?;
    let info = reader.info();
    if info.width != expected_width || info.height != expected_height {
        return Err(format!(
            "PetPack PNG dimensions do not match renderer metadata: {asset}"
        ));
    }
    if info.animation_control.is_some() || info.frame_control.is_some() {
        return Err(format!(
            "PetPack asset {asset} must be a single-frame PNG in this validation slice"
        ));
    }
    let expected_output_ceiling = usize::try_from(expected_width)
        .ok()
        .and_then(|width| {
            usize::try_from(expected_height)
                .ok()
                .and_then(|height| width.checked_mul(height))
        })
        .and_then(|pixels| pixels.checked_mul(4))
        .filter(|bytes| *bytes <= MAX_DECODED_PNG_BYTES)
        .ok_or_else(|| format!("PetPack asset {asset} has unsafe decoded dimensions"))?;
    let output_buffer_size = reader.output_buffer_size();
    if output_buffer_size == 0 || output_buffer_size > expected_output_ceiling {
        return Err(format!(
            "PetPack asset {asset} exceeds its decoded pixel budget"
        ));
    }
    let mut decoded = vec![0; output_buffer_size];
    let frame = reader
        .next_frame(&mut decoded)
        .map_err(|error| format!("PetPack asset {asset} failed PNG decoding: {error}"))?;
    if frame.width != expected_width || frame.height != expected_height {
        return Err(format!(
            "PetPack PNG dimensions do not match renderer metadata: {asset}"
        ));
    }
    let bytes = &decoded[..frame.buffer_size()];
    let has_transparency = match frame.color_type {
        png::ColorType::Rgba => bytes.chunks_exact(4).any(|pixel| pixel[3] < u8::MAX),
        png::ColorType::GrayscaleAlpha => bytes.chunks_exact(2).any(|pixel| pixel[1] < u8::MAX),
        _ => false,
    };
    if !has_transparency {
        return Err(format!(
            "PetPack asset {asset} must decode to pixels with real alpha transparency"
        ));
    }
    Ok(true)
}

fn validate_manifest_shape(manifest: &PetPackManifest) -> Result<(), String> {
    if manifest.schema_version != PETPACK_SCHEMA_VERSION {
        return Err("Unsupported PetPack schemaVersion".to_string());
    }
    validate_token("packId", &manifest.pack_id)?;
    if !validate_semver(&manifest.version) {
        return Err("PetPack version must be strict x.y.z".to_string());
    }
    if manifest.display_name.is_empty() || manifest.display_name.chars().count() > 64 {
        return Err("PetPack displayName must contain 1 to 64 characters".to_string());
    }
    if manifest
        .description
        .as_ref()
        .is_some_and(|value| value.chars().count() > 500)
    {
        return Err("PetPack description exceeds 500 characters".to_string());
    }
    if !matches!(
        manifest.status.as_str(),
        "prototype_asset_validated" | "ship_candidate" | "shippable"
    ) {
        return Err("Unsupported PetPack status".to_string());
    }
    if !matches!(
        manifest.species.as_str(),
        "cat" | "dog" | "human_stylized" | "creature" | "custom"
    ) {
        return Err("Unsupported PetPack species".to_string());
    }
    if !(32..=2048).contains(&manifest.renderer.pixel_size.width)
        || !(32..=2048).contains(&manifest.renderer.pixel_size.height)
        || !(0.0..=1.0).contains(&manifest.renderer.anchor.x)
        || !(0.0..=1.0).contains(&manifest.renderer.anchor.y)
    {
        return Err("PetPack renderer dimensions or anchor are invalid".to_string());
    }
    if manifest.renderer.hit_regions.len() < 2 {
        return Err("PetPack requires at least two hit regions".to_string());
    }
    let mut hit_ids = BTreeSet::new();
    let mut has_drag = false;
    let mut has_ignore = false;
    for hit in &manifest.renderer.hit_regions {
        if hit.id.is_empty() || !hit_ids.insert(hit.id.as_str()) {
            return Err("PetPack hit-region IDs must be non-empty and unique".to_string());
        }
        if !matches!(hit.shape.as_str(), "rect" | "ellipse" | "alpha")
            || !matches!(
                hit.action.as_str(),
                "drag" | "open_app" | "pet" | "menu" | "ignore"
            )
        {
            return Err("PetPack hit-region shape or action is invalid".to_string());
        }
        let [x, y, width, height] = hit.bounds;
        if [x, y, width, height]
            .into_iter()
            .any(|value| !value.is_finite() || !(0.0..=1.0).contains(&value))
            || x + width > 1.0
            || y + height > 1.0
        {
            return Err(format!(
                "PetPack hit region {} exceeds normalized bounds",
                hit.id
            ));
        }
        has_drag |= hit.action == "drag";
        has_ignore |= hit.action == "ignore";
    }
    if !has_drag || !has_ignore {
        return Err("PetPack requires both drag and ignore hit regions".to_string());
    }

    let state_keys: BTreeSet<&str> = manifest.states.keys().map(String::as_str).collect();
    let required: BTreeSet<&str> = REQUIRED_STATES.iter().copied().collect();
    if state_keys != required {
        return Err(
            "PetPack states must be exactly idle/thinking/tool/running/waiting/error".to_string(),
        );
    }
    validate_sha256("assetRootSha256", &manifest.asset_root_sha256)?;
    validate_sha256("license.receiptSha256", &manifest.license.receipt_sha256)?;
    validate_sha256(
        "license.licenseTextSha256",
        &manifest.license.license_text_sha256,
    )?;
    if manifest.license.asset_owner.trim().is_empty() || manifest.license.source.trim().is_empty() {
        return Err("PetPack license owner and source are required".to_string());
    }
    if !matches!(
        manifest.license.provenance.as_str(),
        "original_generated" | "original_commissioned" | "user_owned" | "licensed_third_party"
    ) {
        return Err("Unsupported PetPack provenance".to_string());
    }
    if !matches!(
        manifest.license.current_use.as_str(),
        "internal_prototype" | "redistributable_product_asset"
    ) {
        return Err("Unsupported PetPack currentUse".to_string());
    }
    let _ = (
        manifest.license.modification,
        manifest.license.attribution_required,
        &manifest.license.attribution_text,
        &manifest.license.likeness_release_reference,
        &manifest.customization,
    );
    if !(1..=512).contains(&manifest.performance.max_resident_mi_b)
        || manifest.performance.max_gpu_mi_b > 1024
        || !matches!(manifest.performance.target_fps, 12 | 15 | 24 | 30 | 60)
        || !(1024..=MAX_ASSET_BYTES).contains(&manifest.performance.max_asset_bytes)
    {
        return Err("PetPack performance declaration is outside schema bounds".to_string());
    }
    Ok(())
}

type AssetIdentity = (String, u64);

fn preflight_asset_declarations(
    manifest: &PetPackManifest,
) -> Result<
    (
        BTreeMap<String, AssetIdentity>,
        BTreeMap<String, AssetIdentity>,
        usize,
        u64,
    ),
    String,
> {
    let mut primary_assets = BTreeMap::new();
    let mut all_assets = BTreeMap::new();
    let mut reduced_motion_assets = 0_usize;
    for state_name in REQUIRED_STATES {
        let state = manifest
            .states
            .get(*state_name)
            .ok_or_else(|| format!("PetPack state {state_name} is missing"))?;
        validate_sha256("state.assetSha256", &state.asset_sha256)?;
        validate_relative_path(&state.asset, true)?;
        if state.asset_byte_size == 0 || state.asset_byte_size > MAX_ASSET_BYTES {
            return Err(format!(
                "PetPack state {state_name} has an invalid byte size"
            ));
        }
        if !(100..=60_000).contains(&state.duration_ms)
            || !REQUIRED_STATES.contains(&state.fallback.as_str())
        {
            return Err(format!(
                "PetPack state {state_name} has invalid timing or fallback"
            ));
        }
        let _ = state.r#loop;
        if state.audio.is_some() {
            return Err(format!(
                "PetPack state {state_name} audio assets are unsupported in this validation slice"
            ));
        }
        let identity = (state.asset_sha256.clone(), state.asset_byte_size);
        if primary_assets
            .insert(state.asset.clone(), identity.clone())
            .is_some_and(|old| old != identity)
        {
            return Err(format!(
                "PetPack asset {} is described inconsistently",
                state.asset
            ));
        }
        if all_assets
            .insert(state.asset.clone(), identity)
            .is_some_and(|old| old != (state.asset_sha256.clone(), state.asset_byte_size))
        {
            return Err(format!(
                "PetPack asset {} is described inconsistently",
                state.asset
            ));
        }

        if let Some(reduced) = &state.reduced_motion {
            validate_sha256("state.reducedMotion.assetSha256", &reduced.asset_sha256)?;
            validate_relative_path(&reduced.asset, true)?;
            if reduced.asset_byte_size == 0 || reduced.asset_byte_size > MAX_ASSET_BYTES {
                return Err(format!(
                    "PetPack state {state_name} reduced-motion asset has an invalid byte size"
                ));
            }
            let identity = (reduced.asset_sha256.clone(), reduced.asset_byte_size);
            if all_assets
                .insert(reduced.asset.clone(), identity.clone())
                .is_some_and(|old| old != identity)
            {
                return Err(format!(
                    "PetPack asset {} is described inconsistently",
                    reduced.asset
                ));
            }
            reduced_motion_assets += 1;
        }
    }

    let total_unique_asset_bytes = all_assets.values().try_fold(0_u64, |total, (_, bytes)| {
        total
            .checked_add(*bytes)
            .ok_or("PetPack total asset size overflow".to_string())
    })?;
    if total_unique_asset_bytes > HARD_PACK_BYTES
        || total_unique_asset_bytes > manifest.performance.max_asset_bytes
    {
        return Err(
            "PetPack declared aggregate asset bytes exceed the pre-read validation budget"
                .to_string(),
        );
    }
    Ok((
        primary_assets,
        all_assets,
        reduced_motion_assets,
        total_unique_asset_bytes,
    ))
}

fn validate_pack_at(
    raw_root: &str,
    production_root: &Path,
    experimental_root: &Path,
) -> Result<PetPackValidationReport, String> {
    let root = normalize_pack_root(raw_root)?;
    ensure_outside_control_roots(&root, production_root, experimental_root)?;
    let manifest_evidence = read_json_evidence(&root, "pack.json", MAX_MANIFEST_BYTES)?;
    let manifest: PetPackManifest = serde_json::from_slice(&manifest_evidence.bytes)
        .map_err(|error| format!("PetPack manifest is invalid: {error}"))?;
    validate_manifest_shape(&manifest)?;

    let (primary_assets, _all_assets, reduced_motion_assets, total_unique_asset_bytes) =
        preflight_asset_declarations(&manifest)?;
    let mut alpha_assets = BTreeSet::new();
    let mut evidence_cache = BTreeMap::new();
    for state_name in REQUIRED_STATES {
        let state = manifest
            .states
            .get(*state_name)
            .ok_or_else(|| format!("PetPack state {state_name} is missing"))?;
        if !evidence_cache.contains_key(&state.asset) {
            evidence_cache.insert(
                state.asset.clone(),
                read_evidence(
                    &root,
                    &state.asset,
                    state.asset_byte_size,
                    true,
                    Some(state.asset_byte_size),
                )?,
            );
        }
        let evidence = evidence_cache
            .get(&state.asset)
            .ok_or_else(|| format!("PetPack state {state_name} asset evidence is missing"))?;
        if evidence.byte_size != state.asset_byte_size || evidence.sha256 != state.asset_sha256 {
            return Err(format!(
                "PetPack state {state_name} asset size or SHA-256 mismatch"
            ));
        }
        if validate_mime(state, &evidence, &manifest.renderer)? {
            alpha_assets.insert(state.asset.clone());
        }
        if let Some(reduced) = &state.reduced_motion {
            if !evidence_cache.contains_key(&reduced.asset) {
                evidence_cache.insert(
                    reduced.asset.clone(),
                    read_evidence(
                        &root,
                        &reduced.asset,
                        reduced.asset_byte_size,
                        true,
                        Some(reduced.asset_byte_size),
                    )?,
                );
            }
            let reduced_evidence = evidence_cache.get(&reduced.asset).ok_or_else(|| {
                format!("PetPack state {state_name} reduced-motion evidence is missing")
            })?;
            if reduced_evidence.byte_size != reduced.asset_byte_size
                || reduced_evidence.sha256 != reduced.asset_sha256
            {
                return Err(format!(
                    "PetPack state {state_name} reduced-motion asset mismatch"
                ));
            }
            if validate_reduced_mime(reduced, reduced_evidence, &manifest.renderer)? {
                alpha_assets.insert(reduced.asset.clone());
            }
        }
    }

    let asset_root_input = primary_assets
        .iter()
        .map(|(path, (digest, _))| format!("{path}:{digest}"))
        .collect::<Vec<_>>()
        .join("\n");
    let computed_asset_root = sha256_hex(asset_root_input.as_bytes());
    if computed_asset_root != manifest.asset_root_sha256 {
        return Err("PetPack assetRootSha256 mismatch".to_string());
    }

    let provenance_evidence = read_json_evidence(
        &root,
        &manifest.license.receipt_relative_path,
        MAX_RECEIPT_BYTES,
    )?;
    if provenance_evidence.sha256 != manifest.license.receipt_sha256 {
        return Err("PetPack provenance receipt SHA-256 mismatch".to_string());
    }
    let provenance: ProvenanceReceipt = serde_json::from_slice(&provenance_evidence.bytes)
        .map_err(|error| format!("PetPack provenance receipt is invalid JSON: {error}"))?;
    let expected_receipt_class_prefix = format!("{}", manifest.license.provenance);
    let expected_receipt_use = match manifest.license.current_use.as_str() {
        "internal_prototype" => "internal_prototype_and_loader_validation_only",
        "redistributable_product_asset" => "redistributable_product_asset",
        _ => return Err("Unsupported PetPack currentUse".to_string()),
    };
    let derived_identity = primary_assets.get(&provenance.derived_asset.relative_path);
    if provenance.schema_version != 1
        || provenance.pack_id != manifest.pack_id
        || !provenance
            .receipt_class
            .starts_with(&expected_receipt_class_prefix)
        || manifest.license.source != manifest.license.receipt_relative_path
        || validate_relative_path(&provenance.derived_asset.relative_path, true).is_err()
        || validate_sha256(
            "provenance.derivedAsset.sha256",
            &provenance.derived_asset.sha256,
        )
        .is_err()
        || derived_identity
            != Some(&(
                provenance.derived_asset.sha256.clone(),
                provenance.derived_asset.byte_size,
            ))
        || provenance.derived_asset.mime_type != "image/png"
        || provenance.rights.current_use != expected_receipt_use
    {
        return Err(
            "PetPack provenance receipt is not bound to this pack, primary asset, or declared use"
                .to_string(),
        );
    }
    let rights_evidence = read_json_evidence(&root, "rights-review.json", MAX_RECEIPT_BYTES)?;
    if rights_evidence.sha256 != manifest.license.license_text_sha256 {
        return Err("PetPack rights review SHA-256 mismatch".to_string());
    }
    let rights: RightsReview = serde_json::from_slice(&rights_evidence.bytes)
        .map_err(|error| format!("PetPack rights review is invalid: {error}"))?;
    if rights.schema_version != 1 || rights.pack_id != manifest.pack_id {
        return Err("PetPack rights review is bound to another schema or pack".to_string());
    }
    if rights.status.trim().is_empty()
        || rights
            .allowed_now
            .iter()
            .chain(rights.blocked_until_legal_review.iter())
            .any(|item| item.trim().is_empty())
        || (rights.production_approval && rights.status != "APPROVED_FOR_DISTRIBUTION")
    {
        return Err("PetPack rights review has inconsistent approval fields".to_string());
    }

    let declared_performance_within_hard_limits = manifest.performance.max_resident_mi_b
        <= HARD_RESIDENT_MIB
        && manifest.performance.max_gpu_mi_b <= HARD_GPU_MIB
        && manifest.performance.target_fps <= HARD_TARGET_FPS
        && manifest.performance.max_asset_bytes <= HARD_PACK_BYTES
        && total_unique_asset_bytes <= manifest.performance.max_asset_bytes
        && total_unique_asset_bytes <= HARD_PACK_BYTES;

    let mut blockers = BTreeSet::new();
    if manifest.status != "shippable" {
        blockers.insert("manifest_status_not_shippable".to_string());
    }
    let primary_content_identities = primary_assets.values().cloned().collect::<BTreeSet<_>>();
    if primary_content_identities.len() < REQUIRED_STATES.len() {
        blockers.insert("six_distinct_state_assets_required".to_string());
    }
    if reduced_motion_assets < REQUIRED_STATES.len() {
        blockers.insert("reduced_motion_asset_required_for_every_state".to_string());
    }
    if !declared_performance_within_hard_limits {
        blockers.insert("declared_performance_budget_exceeded".to_string());
    }
    blockers.insert("measured_performance_receipt_required".to_string());
    blockers.insert("independent_rights_authority_receipt_required".to_string());
    if manifest.license.current_use != "redistributable_product_asset"
        || !manifest.license.commercial_use
        || !manifest.license.redistribution
        || manifest.license.legal_review_required
        || rights.status != "APPROVED_FOR_DISTRIBUTION"
        || !rights.production_approval
        || rights.named_franchise_or_person_likeness
        || !provenance.rights.production_redistribution_approved
        || provenance.rights.legal_review_required_before_shipping
        || provenance.rights.third_party_likeness_used
    {
        blockers.insert("production_rights_approval_required".to_string());
    }

    Ok(PetPackValidationReport {
        valid: true,
        pack_id: manifest.pack_id,
        version: manifest.version,
        status: manifest.status,
        species: manifest.species,
        schema_version: PETPACK_SCHEMA_VERSION,
        schema_sha256: sha256_hex(PETPACK_SCHEMA_JSON.as_bytes()),
        manifest_sha256: manifest_evidence.sha256,
        asset_root_sha256: computed_asset_root,
        required_states_validated: REQUIRED_STATES.len(),
        unique_primary_assets: primary_content_identities.len(),
        reduced_motion_assets,
        total_unique_asset_bytes,
        alpha_assets_validated: alpha_assets.len(),
        provenance_receipt_validated: true,
        rights_receipt_integrity_validated: true,
        declared_performance_within_hard_limits,
        performance_measured: false,
        ship_eligible: false,
        activation_enabled: false,
        creator_export_enabled: false,
        production_integration: false,
        blockers: blockers.into_iter().collect(),
    })
}

#[tauri::command]
pub(crate) fn get_experimental_petpack_status() -> ExperimentalPetPackStatus {
    status()
}

#[tauri::command]
pub(crate) fn validate_experimental_petpack(
    input: ValidatePetPackInput,
) -> Result<PetPackValidationReport, String> {
    if !feature_enabled() {
        return Err(format!(
            "Experimental PetPack loader is disabled; set {PETPACK_FLAG}=1 only in an isolated profile"
        ));
    }
    if !cfg!(unix) {
        return Err(
            "Experimental PetPack validation is unavailable until secure platform traversal is implemented"
                .to_string(),
        );
    }
    validate_pack_at(
        &input.pack_root,
        &crate::safe_data_dir()?,
        &experimental_root()?,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn alpha_png(width: u32, height: u32) -> Vec<u8> {
        let mut bytes = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut bytes, width, height);
            encoder.set_color(png::ColorType::Rgba);
            encoder.set_depth(png::BitDepth::Eight);
            let mut writer = encoder.write_header().unwrap();
            let mut pixels = vec![0_u8; width as usize * height as usize * 4];
            for pixel in pixels.chunks_exact_mut(4) {
                pixel.copy_from_slice(&[90, 120, 160, 255]);
            }
            pixels[3] = 0;
            writer.write_image_data(&pixels).unwrap();
        }
        bytes
    }

    fn crc32(bytes: &[u8]) -> u32 {
        let mut crc = u32::MAX;
        for byte in bytes {
            crc ^= u32::from(*byte);
            for _ in 0..8 {
                let mask = 0_u32.wrapping_sub(crc & 1);
                crc = (crc >> 1) ^ (0xedb8_8320 & mask);
            }
        }
        !crc
    }

    fn rewrite_png_height(mut bytes: Vec<u8>, height: u32) -> Vec<u8> {
        assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n");
        assert_eq!(&bytes[12..16], b"IHDR");
        bytes[20..24].copy_from_slice(&height.to_be_bytes());
        let crc = crc32(&bytes[12..29]);
        bytes[29..33].copy_from_slice(&crc.to_be_bytes());
        bytes
    }

    fn fixture(temp: &tempfile::TempDir) -> PathBuf {
        let root = temp.path().join("packs").join("cat.fixture.v1");
        fs::create_dir_all(root.join("assets")).unwrap();
        let asset = alpha_png(64, 64);
        fs::write(root.join("assets/idle.png"), &asset).unwrap();
        let asset_sha = sha256_hex(&asset);

        let provenance = serde_json::to_vec(&json!({
            "schemaVersion": 1,
            "receiptClass": "original_generated_internal_prototype",
            "packId": "cat.fixture.v1",
            "derivedAsset": {
                "relativePath": "assets/idle.png",
                "sha256": asset_sha,
                "byteSize": asset.len(),
                "mimeType": "image/png"
            },
            "rights": {
                "currentUse": "internal_prototype_and_loader_validation_only",
                "productionRedistributionApproved": false,
                "legalReviewRequiredBeforeShipping": true,
                "thirdPartyLikenessUsed": false
            }
        }))
        .unwrap();
        fs::write(root.join("provenance.json"), &provenance).unwrap();
        let rights = serde_json::to_vec(&json!({
            "schemaVersion": 1,
            "packId": "cat.fixture.v1",
            "status": "INTERNAL_PROTOTYPE_ONLY",
            "allowedNow": ["local development"],
            "blockedUntilLegalReview": ["public distribution"],
            "namedFranchiseOrPersonLikeness": false,
            "productionApproval": false
        }))
        .unwrap();
        fs::write(root.join("rights-review.json"), &rights).unwrap();

        let state = json!({
            "asset": "assets/idle.png",
            "assetSha256": asset_sha,
            "assetByteSize": asset.len(),
            "mimeType": "image/png",
            "loop": false,
            "durationMs": 1000,
            "fallback": "idle",
            "reducedMotion": {
                "asset": "assets/idle.png",
                "assetSha256": asset_sha,
                "assetByteSize": asset.len(),
                "mimeType": "image/png"
            }
        });
        let asset_root_sha = sha256_hex(format!("assets/idle.png:{asset_sha}").as_bytes());
        let manifest = json!({
            "schemaVersion": 1,
            "status": "prototype_asset_validated",
            "packId": "cat.fixture.v1",
            "version": "0.1.0",
            "displayName": "Fixture cat",
            "description": "Synthetic test-only PetPack",
            "species": "cat",
            "renderer": {
                "type": "png_sequence",
                "pixelSize": { "width": 64, "height": 64 },
                "anchor": { "x": 0.5, "y": 1.0 },
                "hitRegions": [
                    { "id": "body", "shape": "alpha", "action": "drag", "bounds": [0.1, 0.1, 0.8, 0.8] },
                    { "id": "clear", "shape": "rect", "action": "ignore", "bounds": [0.0, 0.0, 0.1, 0.1] }
                ]
            },
            "license": {
                "assetOwner": "Synthetic test fixture",
                "source": "provenance.json",
                "provenance": "original_generated",
                "receiptRelativePath": "provenance.json",
                "receiptSha256": sha256_hex(&provenance),
                "currentUse": "internal_prototype",
                "commercialUse": false,
                "redistribution": false,
                "modification": true,
                "attributionRequired": false,
                "legalReviewRequired": true,
                "licenseTextSha256": sha256_hex(&rights)
            },
            "assetRootSha256": asset_root_sha,
            "performance": {
                "maxResidentMiB": 120,
                "maxGpuMiB": 128,
                "targetFps": 30,
                "maxAssetBytes": 1024
            },
            "states": {
                "idle": state,
                "thinking": state,
                "tool": state,
                "running": state,
                "waiting": state,
                "error": state
            }
        });
        fs::write(
            root.join("pack.json"),
            serde_json::to_vec_pretty(&manifest).unwrap(),
        )
        .unwrap();
        root
    }

    fn control_roots(temp: &tempfile::TempDir) -> (PathBuf, PathBuf) {
        let production = temp.path().join("production");
        let experimental = temp.path().join("foundation");
        fs::create_dir_all(&production).unwrap();
        fs::create_dir_all(&experimental).unwrap();
        (production, experimental)
    }

    #[test]
    fn disabled_status_is_inert_and_activation_stays_off() {
        let status = status();
        assert!(!status.production_integration);
        assert!(!status.activation_enabled);
        assert!(!status.creator_export_enabled);
        assert!(status.performance_measurement_required);
        assert!(status.rights_approval_required);
    }

    #[test]
    fn static_prototype_validates_but_cannot_ship_or_activate() {
        let temp = tempfile::tempdir().unwrap();
        let root = fixture(&temp);
        let (production, experimental) = control_roots(&temp);
        let report = validate_pack_at(root.to_str().unwrap(), &production, &experimental).unwrap();
        assert!(report.valid);
        assert_eq!(report.required_states_validated, 6);
        assert_eq!(report.unique_primary_assets, 1);
        assert_eq!(report.reduced_motion_assets, 6);
        assert_eq!(report.alpha_assets_validated, 1);
        assert!(!report.performance_measured);
        assert!(!report.ship_eligible);
        assert!(!report.activation_enabled);
        assert!(report
            .blockers
            .contains(&"six_distinct_state_assets_required".to_string()));
        assert!(report
            .blockers
            .contains(&"measured_performance_receipt_required".to_string()));
        assert!(report
            .blockers
            .contains(&"production_rights_approval_required".to_string()));
        assert!(report
            .blockers
            .contains(&"independent_rights_authority_receipt_required".to_string()));
        assert!(report.rights_receipt_integrity_validated);
    }

    #[test]
    fn asset_tamper_fails_closed() {
        let temp = tempfile::tempdir().unwrap();
        let root = fixture(&temp);
        let (production, experimental) = control_roots(&temp);
        let mut asset = fs::read(root.join("assets/idle.png")).unwrap();
        asset.push(1);
        fs::write(root.join("assets/idle.png"), asset).unwrap();
        assert!(
            validate_pack_at(root.to_str().unwrap(), &production, &experimental)
                .unwrap_err()
                .contains("does not match its declared byte size")
        );
    }

    #[test]
    fn rights_receipt_tamper_fails_closed() {
        let temp = tempfile::tempdir().unwrap();
        let root = fixture(&temp);
        let (production, experimental) = control_roots(&temp);
        fs::write(root.join("rights-review.json"), b"{}").unwrap();
        assert!(
            validate_pack_at(root.to_str().unwrap(), &production, &experimental)
                .unwrap_err()
                .contains("rights review SHA-256 mismatch")
        );
    }

    #[test]
    fn incomplete_provenance_receipt_fails_closed() {
        let temp = tempfile::tempdir().unwrap();
        let root = fixture(&temp);
        let (production, experimental) = control_roots(&temp);
        let provenance = serde_json::to_vec(&json!({
            "schemaVersion": 1,
            "packId": "cat.fixture.v1"
        }))
        .unwrap();
        fs::write(root.join("provenance.json"), &provenance).unwrap();
        let mut manifest: Value =
            serde_json::from_slice(&fs::read(root.join("pack.json")).unwrap()).unwrap();
        manifest["license"]["receiptSha256"] = json!(sha256_hex(&provenance));
        fs::write(
            root.join("pack.json"),
            serde_json::to_vec_pretty(&manifest).unwrap(),
        )
        .unwrap();
        assert!(
            validate_pack_at(root.to_str().unwrap(), &production, &experimental)
                .unwrap_err()
                .contains("provenance receipt is invalid JSON")
        );
    }

    #[test]
    fn header_only_png_is_rejected_even_when_manifest_hash_matches() {
        let temp = tempfile::tempdir().unwrap();
        let root = fixture(&temp);
        let (production, experimental) = control_roots(&temp);
        let mut fake = vec![0_u8; 1024];
        fake[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
        fake[8..12].copy_from_slice(&13_u32.to_be_bytes());
        fake[12..16].copy_from_slice(b"IHDR");
        fake[16..20].copy_from_slice(&64_u32.to_be_bytes());
        fake[20..24].copy_from_slice(&64_u32.to_be_bytes());
        fake[24] = 8;
        fake[25] = 6;
        fs::write(root.join("assets/idle.png"), &fake).unwrap();
        let fake_sha = sha256_hex(&fake);
        let mut manifest: Value =
            serde_json::from_slice(&fs::read(root.join("pack.json")).unwrap()).unwrap();
        for state_name in REQUIRED_STATES {
            manifest["states"][*state_name]["assetSha256"] = json!(fake_sha);
            manifest["states"][*state_name]["assetByteSize"] = json!(fake.len());
            manifest["states"][*state_name]["reducedMotion"]["assetSha256"] = json!(fake_sha);
            manifest["states"][*state_name]["reducedMotion"]["assetByteSize"] = json!(fake.len());
        }
        manifest["assetRootSha256"] =
            json!(sha256_hex(format!("assets/idle.png:{fake_sha}").as_bytes()));
        manifest["performance"]["maxAssetBytes"] = json!(fake.len());
        fs::write(
            root.join("pack.json"),
            serde_json::to_vec_pretty(&manifest).unwrap(),
        )
        .unwrap();
        assert!(
            validate_pack_at(root.to_str().unwrap(), &production, &experimental)
                .unwrap_err()
                .contains("not a valid PNG")
        );
    }

    #[test]
    fn oversized_ihdr_is_rejected_before_output_buffer_allocation() {
        let bytes = rewrite_png_height(alpha_png(1, 1), 4_000_000);
        let evidence = FileEvidence {
            sha256: sha256_hex(&bytes),
            byte_size: bytes.len() as u64,
            bytes,
        };
        let error = validate_alpha_png("assets/oversized.png", &evidence, 1, 1).unwrap_err();
        assert!(error.contains("dimensions do not match renderer metadata"));
    }

    #[test]
    fn self_approved_rights_still_require_independent_authority() {
        let temp = tempfile::tempdir().unwrap();
        let root = fixture(&temp);
        let (production, experimental) = control_roots(&temp);
        let rights = serde_json::to_vec(&json!({
            "schemaVersion": 1,
            "packId": "cat.fixture.v1",
            "status": "APPROVED_FOR_DISTRIBUTION",
            "allowedNow": ["public distribution"],
            "blockedUntilLegalReview": [],
            "namedFranchiseOrPersonLikeness": false,
            "productionApproval": true
        }))
        .unwrap();
        fs::write(root.join("rights-review.json"), &rights).unwrap();

        let mut provenance: Value =
            serde_json::from_slice(&fs::read(root.join("provenance.json")).unwrap()).unwrap();
        provenance["rights"]["currentUse"] = json!("redistributable_product_asset");
        provenance["rights"]["productionRedistributionApproved"] = json!(true);
        provenance["rights"]["legalReviewRequiredBeforeShipping"] = json!(false);
        let provenance = serde_json::to_vec(&provenance).unwrap();
        fs::write(root.join("provenance.json"), &provenance).unwrap();

        let mut manifest: Value =
            serde_json::from_slice(&fs::read(root.join("pack.json")).unwrap()).unwrap();
        manifest["status"] = json!("shippable");
        manifest["license"]["currentUse"] = json!("redistributable_product_asset");
        manifest["license"]["commercialUse"] = json!(true);
        manifest["license"]["redistribution"] = json!(true);
        manifest["license"]["legalReviewRequired"] = json!(false);
        manifest["license"]["receiptSha256"] = json!(sha256_hex(&provenance));
        manifest["license"]["licenseTextSha256"] = json!(sha256_hex(&rights));
        fs::write(
            root.join("pack.json"),
            serde_json::to_vec_pretty(&manifest).unwrap(),
        )
        .unwrap();

        let report = validate_pack_at(root.to_str().unwrap(), &production, &experimental).unwrap();
        assert!(report
            .blockers
            .contains(&"independent_rights_authority_receipt_required".to_string()));
        assert!(!report
            .blockers
            .contains(&"production_rights_approval_required".to_string()));
        assert!(!report.ship_eligible);
    }

    #[test]
    fn unsupported_audio_asset_fails_closed() {
        let temp = tempfile::tempdir().unwrap();
        let root = fixture(&temp);
        let (production, experimental) = control_roots(&temp);
        let mut manifest: Value =
            serde_json::from_slice(&fs::read(root.join("pack.json")).unwrap()).unwrap();
        manifest["states"]["idle"]["audio"] = json!("assets/idle.wav");
        fs::write(
            root.join("pack.json"),
            serde_json::to_vec_pretty(&manifest).unwrap(),
        )
        .unwrap();
        assert!(
            validate_pack_at(root.to_str().unwrap(), &production, &experimental)
                .unwrap_err()
                .contains("audio assets are unsupported")
        );
    }

    #[test]
    fn path_and_control_root_policy_fail_closed() {
        let temp = tempfile::tempdir().unwrap();
        let root = fixture(&temp);
        let (production, experimental) = control_roots(&temp);
        assert!(validate_relative_path("../escape.png", true).is_err());
        assert!(validate_relative_path("outside.png", true).is_err());
        assert!(ensure_outside_control_roots(&experimental, &production, &experimental).is_err());
        assert!(ensure_outside_control_roots(temp.path(), &production, &experimental).is_err());
        assert!(validate_pack_at(root.to_str().unwrap(), &production, &experimental).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn referenced_asset_symlinks_are_rejected() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().unwrap();
        let root = fixture(&temp);
        let target = root.join("assets/idle.png");
        let link = root.join("assets/link.png");
        symlink(&target, &link).unwrap();
        assert!(read_evidence(&root, "assets/link.png", MAX_ASSET_BYTES, true, None).is_err());

        let outside = temp.path().join("outside");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("idle.png"), alpha_png(64, 64)).unwrap();
        symlink(&outside, root.join("assets/linked-directory")).unwrap();
        assert!(read_evidence(
            &root,
            "assets/linked-directory/idle.png",
            MAX_ASSET_BYTES,
            true,
            None
        )
        .is_err());
    }

    #[cfg(unix)]
    #[test]
    fn fifo_asset_is_rejected_without_waiting_for_a_writer() {
        let temp = tempfile::tempdir().unwrap();
        let root = fixture(&temp);
        let (production, experimental) = control_roots(&temp);
        let asset = root.join("assets/idle.png");
        fs::remove_file(&asset).unwrap();
        let fifo = CString::new(asset.as_os_str().as_bytes()).unwrap();
        // SAFETY: `fifo` is a valid NUL-terminated path and points inside this
        // test's temporary directory. The path does not exist at this point.
        let result = unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) };
        assert_eq!(result, 0);

        let started = std::time::Instant::now();
        let error =
            validate_pack_at(root.to_str().unwrap(), &production, &experimental).unwrap_err();
        assert!(started.elapsed() < std::time::Duration::from_secs(1));
        assert!(error.contains("empty or exceeds its byte limit"));
    }

    #[test]
    fn declared_budget_overrun_is_a_ship_blocker() {
        let temp = tempfile::tempdir().unwrap();
        let root = fixture(&temp);
        let (production, experimental) = control_roots(&temp);
        let mut manifest: Value =
            serde_json::from_slice(&fs::read(root.join("pack.json")).unwrap()).unwrap();
        manifest["performance"]["maxResidentMiB"] = json!(121);
        fs::write(
            root.join("pack.json"),
            serde_json::to_vec_pretty(&manifest).unwrap(),
        )
        .unwrap();
        let report = validate_pack_at(root.to_str().unwrap(), &production, &experimental).unwrap();
        assert!(!report.declared_performance_within_hard_limits);
        assert!(report
            .blockers
            .contains(&"declared_performance_budget_exceeded".to_string()));
    }

    #[test]
    fn aggregate_asset_budget_overrun_fails_before_asset_reads() {
        let temp = tempfile::tempdir().unwrap();
        let root = fixture(&temp);
        let (production, experimental) = control_roots(&temp);
        let mut manifest: Value =
            serde_json::from_slice(&fs::read(root.join("pack.json")).unwrap()).unwrap();
        let oversized = HARD_PACK_BYTES + 1;
        for state_name in REQUIRED_STATES {
            manifest["states"][*state_name]["assetByteSize"] = json!(oversized);
            manifest["states"][*state_name]["reducedMotion"]["assetByteSize"] = json!(oversized);
        }
        manifest["performance"]["maxAssetBytes"] = json!(MAX_ASSET_BYTES);
        fs::write(
            root.join("pack.json"),
            serde_json::to_vec_pretty(&manifest).unwrap(),
        )
        .unwrap();
        assert!(
            validate_pack_at(root.to_str().unwrap(), &production, &experimental)
                .unwrap_err()
                .contains("pre-read validation budget")
        );
    }

    #[test]
    fn understated_asset_size_fails_before_allocation_or_read() {
        let temp = tempfile::tempdir().unwrap();
        let root = fixture(&temp);
        let (production, experimental) = control_roots(&temp);
        fs::write(root.join("assets/idle.png"), vec![0_u8; 2 * 1024 * 1024]).unwrap();

        let error =
            validate_pack_at(root.to_str().unwrap(), &production, &experimental).unwrap_err();
        assert!(error.contains("does not match its declared byte size"));
    }

    #[test]
    #[ignore = "requires BLACKBOX_PETPACK_PREP_ROOT pointing at isolated preparation assets"]
    fn frozen_preparation_prototypes_validate_without_becoming_shippable() {
        let prep_root = PathBuf::from(
            std::env::var("BLACKBOX_PETPACK_PREP_ROOT")
                .expect("BLACKBOX_PETPACK_PREP_ROOT must be set for this ignored audit test"),
        );
        let controls = tempfile::tempdir().unwrap();
        let (production, experimental) = control_roots(&controls);
        for pack_id in ["cat.silver-round.v1", "dog.shiba.v1", "human.engineer.v1"] {
            let root = prep_root.join(pack_id);
            let report =
                validate_pack_at(root.to_str().unwrap(), &production, &experimental).unwrap();
            assert_eq!(report.pack_id, pack_id);
            assert!(report.valid);
            assert!(report.rights_receipt_integrity_validated);
            assert!(!report.ship_eligible);
            assert!(!report.activation_enabled);
            assert!(!report.production_integration);
            assert!(report
                .blockers
                .contains(&"independent_rights_authority_receipt_required".to_string()));
            assert!(report
                .blockers
                .contains(&"six_distinct_state_assets_required".to_string()));
        }
    }

    #[test]
    fn embedded_schema_is_stable_json() {
        let schema: Value = serde_json::from_str(PETPACK_SCHEMA_JSON).unwrap();
        assert_eq!(schema["$id"], "blackbox://experimental/petpack-v1");
        assert_eq!(schema["properties"]["schemaVersion"]["const"], 1);
        assert_eq!(sha256_hex(PETPACK_SCHEMA_JSON.as_bytes()).len(), 64);
    }
}
