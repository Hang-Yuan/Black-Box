//! Disabled-by-default Memory recovery control plane.
//!
//! R3AU is deliberately preparation-only. It gives every experimental Memory
//! writer a host-wide Unix lease and provides an HMAC-authenticated recovery
//! journal plus immutable rollback snapshots. It never switches the current
//! Memory authority, replaces a database, restores a snapshot, or touches the
//! production Black Box data directory.

use chrono::Utc;
use hmac::{Hmac, Mac};
use rand::{rngs::OsRng, RngCore};
use rusqlite::{params, Connection, DatabaseName, OpenFlags, TransactionBehavior};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::ffi::OsString;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::time::Duration;
use uuid::Uuid;

type HmacSha256 = Hmac<Sha256>;

const RECOVERY_FLAG: &str = "BLACKBOX_EXPERIMENTAL_MEMORY_RECOVERY_V1";
const HOME_OVERRIDE: &str = "BLACKBOX_EXPERIMENTAL_HOME";
const SCHEMA_VERSION: i64 = 1;
const MEMORY_SCHEMA_VERSION: i64 = 3;
const MAX_MEMORY_DATABASE_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const MAX_EXTERNAL_ANCHOR_BYTES: u64 = 4 * 1024;
const ZERO_HASH: &str = "0000000000000000000000000000000000000000000000000000000000000000";
const SCHEMA_SQL: &str = include_str!("../resources/experimental/memory-recovery-v1.sql");
const MEMORY_SCHEMA_SQL: &str = include_str!("../resources/experimental/memory-v3.sql");

const TABLE_SHAPES: &[(&str, &[&str])] = &[
    (
        "memory_recovery_meta",
        &[
            "id",
            "schema_version",
            "schema_sha256",
            "signing_key_id_sha256",
            "journal_head_sequence",
            "journal_head_sha256",
            "journal_anchor_hmac_sha256",
            "created_at_ms",
        ],
    ),
    (
        "memory_recovery_record",
        &[
            "sequence",
            "operation_id",
            "operation_kind",
            "phase",
            "idempotency_key",
            "input_payload_sha256",
            "memory_schema_sha256",
            "memory_database_sha256",
            "memory_device",
            "memory_inode",
            "memory_size",
            "snapshot_relative_path",
            "snapshot_sha256",
            "incident_reason_sha256",
            "previous_record_sha256",
            "record_sha256",
            "record_hmac_sha256",
            "external_effects",
            "production_memory_mutated",
            "created_at_ms",
        ],
    ),
];

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExperimentalMemoryRecoveryStatus {
    enabled: bool,
    platform_supported: bool,
    initialized: bool,
    ready: bool,
    path: String,
    schema_version: Option<i64>,
    schema_sha256: String,
    journal_record_count: u64,
    pending_recovery_count: u64,
    host_wide_lease_enforced: bool,
    journal_hmac_verified: bool,
    immutable_snapshots_enabled: bool,
    automatic_restore_enabled: bool,
    dual_read_enabled: bool,
    production_memory_mutated: bool,
    production_integration: bool,
    blocked_reason: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PrepareMemoryRecoveryDrillInput {
    pub(crate) operation_id: String,
    pub(crate) expected_memory_sha256: String,
    pub(crate) idempotency_key: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ReconcileMemoryRecoveryDrillInput {
    pub(crate) operation_id: String,
    pub(crate) expected_prepared_record_sha256: String,
    pub(crate) idempotency_key: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RecordMemoryQuarantineContractInput {
    operation_id: String,
    expected_memory_sha256: String,
    incident_reason_sha256: String,
    idempotency_key: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MemoryRecoveryReceipt {
    pub(crate) operation_id: String,
    pub(crate) operation_kind: String,
    pub(crate) phase: String,
    pub(crate) record_sequence: i64,
    pub(crate) record_sha256: String,
    pub(crate) record_hmac_sha256: String,
    pub(crate) memory_database_sha256: String,
    pub(crate) snapshot_relative_path: String,
    pub(crate) snapshot_sha256: String,
    rollback_snapshot_bound: bool,
    operator_action_required: bool,
    quarantine_performed: bool,
    automatic_restore_enabled: bool,
    production_memory_mutated: bool,
    external_effects: u8,
    duplicate: bool,
    production_integration: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MemoryRecoveryJournalInspection {
    schema_version: i64,
    journal_record_count: u64,
    pending_recovery_count: u64,
    last_record_sha256: String,
    hmac_verified: bool,
    chain_verified: bool,
    external_effects: u8,
    production_memory_mutated: bool,
    production_integration: bool,
}

#[derive(Clone, Debug)]
struct StoreInspection {
    initialized: bool,
    ready: bool,
    schema_version: Option<i64>,
    journal_record_count: u64,
    pending_recovery_count: u64,
    blocked_reason: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct MemoryFileSnapshot {
    pub(crate) sha256: String,
    pub(crate) device: String,
    pub(crate) inode: String,
    pub(crate) size: u64,
}

#[derive(Clone, Debug)]
struct StoredRecord {
    sequence: i64,
    operation_id: String,
    operation_kind: String,
    phase: String,
    idempotency_key: String,
    input_payload_sha256: String,
    memory_schema_sha256: String,
    memory_database_sha256: String,
    memory_device: String,
    memory_inode: String,
    memory_size: i64,
    snapshot_relative_path: String,
    snapshot_sha256: String,
    incident_reason_sha256: Option<String>,
    previous_record_sha256: String,
    record_sha256: String,
    record_hmac_sha256: String,
    external_effects: i64,
    production_memory_mutated: i64,
    created_at_ms: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CanonicalRecord<'a> {
    sequence: i64,
    operation_id: &'a str,
    operation_kind: &'a str,
    phase: &'a str,
    idempotency_key: &'a str,
    input_payload_sha256: &'a str,
    memory_schema_sha256: &'a str,
    memory_database_sha256: &'a str,
    memory_device: &'a str,
    memory_inode: &'a str,
    memory_size: i64,
    snapshot_relative_path: &'a str,
    snapshot_sha256: &'a str,
    incident_reason_sha256: Option<&'a str>,
    previous_record_sha256: &'a str,
    external_effects: i64,
    production_memory_mutated: i64,
    created_at_ms: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CanonicalJournalAnchor<'a> {
    schema_version: i64,
    schema_sha256: &'a str,
    signing_key_id_sha256: &'a str,
    journal_head_sequence: i64,
    journal_head_sha256: &'a str,
    created_at_ms: i64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ExternalJournalAnchor {
    schema_version: i64,
    schema_sha256: String,
    signing_key_id_sha256: String,
    journal_head_sequence: i64,
    journal_head_sha256: String,
    journal_anchor_hmac_sha256: String,
    created_at_ms: i64,
}

#[derive(Debug)]
pub(crate) struct HostWideMemoryLease {
    #[cfg(unix)]
    file: File,
}

#[cfg(unix)]
impl Drop for HostWideMemoryLease {
    fn drop(&mut self) {
        use std::os::fd::AsRawFd;
        unsafe {
            libc::flock(self.file.as_raw_fd(), libc::LOCK_UN);
        }
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn now_ms() -> i64 {
    Utc::now().timestamp_millis()
}

fn platform_supported() -> bool {
    cfg!(unix)
}

fn require_supported_platform() -> Result<(), String> {
    if platform_supported() {
        Ok(())
    } else {
        Err(
            "Experimental Memory recovery is unavailable on this platform; R3AU requires a native host-wide file lease and link-count proof"
                .to_string(),
        )
    }
}

fn feature_enabled() -> bool {
    platform_supported()
        && std::env::var(RECOVERY_FLAG)
            .ok()
            .map(|value| {
                matches!(
                    value.trim().to_ascii_lowercase().as_str(),
                    "1" | "true" | "yes" | "on"
                )
            })
            .unwrap_or(false)
}

fn validate_token(name: &str, value: &str) -> Result<(), String> {
    let valid = !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'));
    if valid {
        Ok(())
    } else {
        Err(format!("{name} is not a safe binding token"))
    }
}

fn validate_hash(name: &str, value: &str) -> Result<(), String> {
    if value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err(format!("{name} must be a 64-character SHA-256 hex digest"))
    }
}

pub(crate) fn normalize_platform_root_alias(path: PathBuf) -> PathBuf {
    #[cfg(target_os = "macos")]
    {
        for (alias, canonical) in [("/var", "/private/var"), ("/tmp", "/private/tmp")] {
            if let Ok(remainder) = path.strip_prefix(alias) {
                return Path::new(canonical).join(remainder);
            }
        }
    }
    path
}

fn reject_symlink_components(path: &Path) -> Result<(), String> {
    let mut current = PathBuf::new();
    for component in path.components() {
        current.push(component.as_os_str());
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(format!(
                    "{HOME_OVERRIDE} must not traverse symlink {}",
                    current.display()
                ));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!(
                    "Failed to inspect experimental path {}: {error}",
                    current.display()
                ));
            }
        }
    }
    Ok(())
}

fn resolve_existing_prefix(path: &Path) -> Result<PathBuf, String> {
    let mut cursor = path.to_path_buf();
    let mut missing = Vec::<OsString>::new();
    loop {
        match fs::canonicalize(&cursor) {
            Ok(mut resolved) => {
                for component in missing.iter().rev() {
                    resolved.push(component);
                }
                return Ok(resolved);
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let component = cursor.file_name().ok_or_else(|| {
                    format!("Failed to resolve experimental path {}", path.display())
                })?;
                missing.push(component.to_os_string());
                cursor = cursor
                    .parent()
                    .ok_or_else(|| {
                        format!("Failed to resolve experimental path {}", path.display())
                    })?
                    .to_path_buf();
            }
            Err(error) => {
                return Err(format!(
                    "Failed to resolve experimental path {}: {error}",
                    cursor.display()
                ));
            }
        }
    }
}

fn overlap_comparison_path(path: &Path) -> PathBuf {
    #[cfg(target_os = "macos")]
    {
        let mut comparison = PathBuf::new();
        for component in path.components() {
            comparison.push(component.as_os_str().to_string_lossy().to_lowercase());
        }
        return comparison;
    }
    #[cfg(not(target_os = "macos"))]
    path.to_path_buf()
}

pub(crate) fn validate_isolated_root(
    path: PathBuf,
    production_root: &Path,
) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err(format!("{HOME_OVERRIDE} must be an absolute path"));
    }
    if path
        .components()
        .any(|component| matches!(component, Component::ParentDir | Component::CurDir))
    {
        return Err(format!(
            "{HOME_OVERRIDE} must not contain relative path components"
        ));
    }
    let path = normalize_platform_root_alias(path);
    let production_root = normalize_platform_root_alias(production_root.to_path_buf());
    reject_symlink_components(&path)?;
    let resolved_path = resolve_existing_prefix(&path)?;
    let resolved_production = resolve_existing_prefix(&production_root)?;
    let comparison_path = overlap_comparison_path(&resolved_path);
    let comparison_production = overlap_comparison_path(&resolved_production);
    if comparison_path.starts_with(&comparison_production)
        || comparison_production.starts_with(&comparison_path)
    {
        return Err(format!(
            "{HOME_OVERRIDE} must not overlap the production Black Box data directory"
        ));
    }
    Ok(resolved_path)
}

fn status_root() -> Result<PathBuf, String> {
    if let Some(value) = std::env::var_os(HOME_OVERRIDE) {
        let path = PathBuf::from(value);
        return validate_isolated_root(path, &crate::safe_data_dir()?);
    }
    Ok(crate::safe_data_dir()?.join("experimental-memory-recovery-v1-status-only"))
}

fn isolated_root() -> Result<PathBuf, String> {
    require_supported_platform()?;
    if !feature_enabled() {
        return Err(format!(
            "Experimental Memory recovery is disabled; set {RECOVERY_FLAG}=1 only in an isolated profile"
        ));
    }
    let value = std::env::var_os(HOME_OVERRIDE)
        .ok_or_else(|| format!("{HOME_OVERRIDE} is required for every experimental mutation"))?;
    validate_isolated_root(PathBuf::from(value), &crate::safe_data_dir()?)
}

fn control_path(root: &Path) -> PathBuf {
    root.join("memory-recovery-v1.sqlite")
}

fn key_path(root: &Path) -> PathBuf {
    root.join("memory-recovery-v1.key")
}

fn external_anchor_path(root: &Path) -> PathBuf {
    root.join("memory-recovery-v1.anchor.json")
}

fn lease_path(root: &Path) -> PathBuf {
    root.join(".memory-v3.host-wide.lease")
}

pub(crate) fn memory_path(root: &Path) -> PathBuf {
    root.join("memory-v3.sqlite")
}

fn snapshot_root(root: &Path) -> PathBuf {
    root.join("memory-recovery-snapshots")
}

#[cfg(unix)]
fn set_directory_private(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
        .map_err(|error| format!("Failed to secure {}: {error}", path.display()))
}

#[cfg(not(unix))]
fn set_directory_private(_path: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(unix)]
fn set_file_mode(path: &Path, mode: u32) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(mode))
        .map_err(|error| format!("Failed to secure {}: {error}", path.display()))
}

#[cfg(not(unix))]
fn set_file_mode(_path: &Path, _mode: u32) -> Result<(), String> {
    Ok(())
}

fn ensure_private_directory(path: &Path, label: &str) -> Result<(), String> {
    reject_symlink_components(path)?;
    if path.exists() {
        let metadata = fs::symlink_metadata(path)
            .map_err(|error| format!("Failed to inspect {}: {error}", path.display()))?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(format!("{label} must be a real directory"));
        }
    } else {
        fs::create_dir_all(path)
            .map_err(|error| format!("Failed to create {}: {error}", path.display()))?;
    }
    set_directory_private(path)
}

fn sync_file_and_parent(path: &Path) -> Result<(), String> {
    File::open(path)
        .and_then(|file| file.sync_all())
        .map_err(|error| format!("Failed to sync {}: {error}", path.display()))?;
    if let Some(parent) = path.parent() {
        File::open(parent)
            .and_then(|file| file.sync_all())
            .map_err(|error| format!("Failed to sync {}: {error}", parent.display()))?;
    }
    Ok(())
}

fn regular_single_link_file(path: &Path, label: &str) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                return Err(format!("{label} must be a regular non-symlink file"));
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::MetadataExt;
                if metadata.nlink() != 1 {
                    return Err(format!("{label} must have exactly one filesystem link"));
                }
            }
            Ok(true)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!("Failed to inspect {label}: {error}")),
    }
}

pub(crate) fn validate_immutable_snapshot_file(path: &Path) -> Result<(), String> {
    if !regular_single_link_file(path, "Memory recovery snapshot")? {
        return Err("Memory recovery snapshot is missing".to_string());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(path)
            .map_err(|error| format!("Failed to inspect Memory recovery snapshot: {error}"))?
            .permissions()
            .mode()
            & 0o777;
        if mode != 0o400 {
            return Err("Memory recovery snapshot must have mode 0400".to_string());
        }
    }
    Ok(())
}

#[cfg(unix)]
pub(crate) fn acquire_host_wide_memory_lease(root: &Path) -> Result<HostWideMemoryLease, String> {
    use std::io::{Seek, SeekFrom};
    use std::os::fd::AsRawFd;
    use std::os::unix::fs::OpenOptionsExt;

    let normalized_root = normalize_platform_root_alias(root.to_path_buf());
    ensure_private_directory(&normalized_root, "Experimental Memory root")?;
    let path = lease_path(&normalized_root);
    let mut options = OpenOptions::new();
    options
        .read(true)
        .write(true)
        .create(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW);
    let mut file = options
        .open(&path)
        .map_err(|error| format!("Failed to open host-wide Memory lease: {error}"))?;
    let metadata = file
        .metadata()
        .map_err(|error| format!("Failed to inspect host-wide Memory lease: {error}"))?;
    use std::os::unix::fs::MetadataExt;
    if !metadata.is_file() || metadata.nlink() != 1 {
        return Err("Host-wide Memory lease must be a single-link regular file".to_string());
    }
    let result = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
    if result != 0 {
        return Err("Another process holds the host-wide Memory lease".to_string());
    }
    file.set_len(0)
        .and_then(|_| file.seek(SeekFrom::Start(0)).map(|_| ()))
        .map_err(|error| format!("Failed to reset host-wide Memory lease: {error}"))?;
    let owner = format!("pid={} token={}\n", std::process::id(), Uuid::new_v4());
    file.write_all(owner.as_bytes())
        .and_then(|_| file.sync_all())
        .map_err(|error| format!("Failed to persist host-wide Memory lease owner: {error}"))?;
    set_file_mode(&path, 0o600)?;
    Ok(HostWideMemoryLease { file })
}

#[cfg(not(unix))]
pub(crate) fn acquire_host_wide_memory_lease(_root: &Path) -> Result<HostWideMemoryLease, String> {
    require_supported_platform()?;
    unreachable!()
}

fn open_read_only(path: &Path, label: &str) -> Result<Connection, String> {
    let path = normalize_platform_root_alias(path.to_path_buf());
    if !regular_single_link_file(&path, label)? {
        return Err(format!("{label} does not exist"));
    }
    let connection = Connection::open_with_flags(
        &path,
        OpenFlags::SQLITE_OPEN_READ_ONLY
            | OpenFlags::SQLITE_OPEN_NO_MUTEX
            | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )
    .map_err(|error| format!("Failed to inspect {label}: {error}"))?;
    connection
        .busy_timeout(Duration::from_secs(2))
        .map_err(|error| format!("Failed to configure {label} inspection: {error}"))?;
    connection
        .pragma_update(None, "query_only", true)
        .map_err(|error| format!("Failed to make {label} inspection read-only: {error}"))?;
    Ok(connection)
}

fn open_read_write(path: &Path) -> Result<Connection, String> {
    let path = normalize_platform_root_alias(path.to_path_buf());
    if !regular_single_link_file(&path, "Memory recovery control database")? {
        return Err("Memory recovery control database is not initialized".to_string());
    }
    let connection = Connection::open_with_flags(
        &path,
        OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_NO_MUTEX
            | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )
    .map_err(|error| format!("Failed to open Memory recovery control database: {error}"))?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(|error| format!("Failed to configure Memory recovery writer: {error}"))?;
    connection
        .pragma_update(None, "foreign_keys", true)
        .map_err(|error| format!("Failed to enable Memory recovery foreign keys: {error}"))?;
    connection
        .pragma_update(None, "synchronous", "FULL")
        .map_err(|error| format!("Failed to enable durable Memory recovery writes: {error}"))?;
    Ok(connection)
}

fn sqlite_quick_check(connection: &Connection, label: &str) -> Result<(), String> {
    let result: String = connection
        .query_row("PRAGMA quick_check", [], |row| row.get(0))
        .map_err(|error| format!("{label} SQLite quick_check failed: {error}"))?;
    if result == "ok" {
        Ok(())
    } else {
        Err(format!("{label} SQLite quick_check reported {result}"))
    }
}

fn table_columns(connection: &Connection, table: &str) -> Result<Vec<String>, String> {
    let quoted = table.replace('"', "\"\"");
    let mut statement = connection
        .prepare(&format!("PRAGMA table_info(\"{quoted}\")"))
        .map_err(|error| format!("Failed to inspect Memory recovery table {table}: {error}"))?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| format!("Failed to read Memory recovery table {table}: {error}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Failed to decode Memory recovery table {table}: {error}"))
}

fn create_signing_key(path: &Path) -> Result<Vec<u8>, String> {
    if regular_single_link_file(path, "Memory recovery signing key")? {
        return read_signing_key(path);
    }
    let mut key = vec![0u8; 32];
    OsRng.fill_bytes(&mut key);
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = options
        .open(path)
        .map_err(|error| format!("Failed to create Memory recovery signing key: {error}"))?;
    file.write_all(&key)
        .and_then(|_| file.sync_all())
        .map_err(|error| format!("Failed to persist Memory recovery signing key: {error}"))?;
    set_file_mode(path, 0o600)?;
    sync_file_and_parent(path)?;
    Ok(key)
}

fn read_signing_key(path: &Path) -> Result<Vec<u8>, String> {
    if !regular_single_link_file(path, "Memory recovery signing key")? {
        return Err("Memory recovery signing key is missing".to_string());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(path)
            .map_err(|error| format!("Failed to inspect Memory recovery signing key: {error}"))?
            .permissions()
            .mode()
            & 0o777;
        if mode != 0o600 {
            return Err("Memory recovery signing key must have mode 0600".to_string());
        }
    }
    let bytes = fs::read(path)
        .map_err(|error| format!("Failed to read Memory recovery signing key: {error}"))?;
    if bytes.len() != 32 {
        return Err("Memory recovery signing key must be exactly 32 bytes".to_string());
    }
    Ok(bytes)
}

fn create_control_store(path: &Path, key: &[u8]) -> Result<(), String> {
    if regular_single_link_file(path, "Memory recovery control database")? {
        return inspect_control_store(path, key).and_then(|inspection| {
            if inspection.ready {
                Ok(())
            } else {
                Err(inspection
                    .blocked_reason
                    .unwrap_or_else(|| "Memory recovery control database is not ready".to_string()))
            }
        });
    }
    let root = path
        .parent()
        .ok_or("Memory recovery control database has no parent")?;
    let anchor_path = external_anchor_path(root);
    if regular_single_link_file(&anchor_path, "Memory recovery external journal anchor")? {
        return Err(
            "Memory recovery external journal anchor exists without its control database"
                .to_string(),
        );
    }
    let staging = root.join(format!(".memory-recovery-v1.{}.sqlite", Uuid::new_v4()));
    let mut published = false;
    let result = (|| -> Result<(), String> {
        let staging_open_path = normalize_platform_root_alias(staging.clone());
        let connection = Connection::open_with_flags(
            &staging_open_path,
            OpenFlags::SQLITE_OPEN_READ_WRITE
                | OpenFlags::SQLITE_OPEN_CREATE
                | OpenFlags::SQLITE_OPEN_NO_MUTEX
                | OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )
        .map_err(|error| format!("Failed to stage Memory recovery control database: {error}"))?;
        connection
            .busy_timeout(Duration::from_secs(5))
            .map_err(|error| format!("Failed to configure staged recovery database: {error}"))?;
        connection
            .execute_batch(SCHEMA_SQL)
            .map_err(|error| format!("Failed to apply Memory recovery schema: {error}"))?;
        let created_at_ms = now_ms();
        let anchor_hmac = journal_anchor_hmac(key, 0, ZERO_HASH, created_at_ms)?;
        connection
            .execute(
                "INSERT INTO memory_recovery_meta(id, schema_version, schema_sha256, signing_key_id_sha256, journal_head_sequence, journal_head_sha256, journal_anchor_hmac_sha256, created_at_ms) VALUES(1, 1, ?1, ?2, 0, ?3, ?4, ?5)",
                params![
                    sha256_hex(SCHEMA_SQL.as_bytes()),
                    sha256_hex(key),
                    ZERO_HASH,
                    anchor_hmac,
                    created_at_ms,
                ],
            )
            .map_err(|error| format!("Failed to bind Memory recovery schema identity: {error}"))?;
        sqlite_quick_check(&connection, "Memory recovery")?;
        drop(connection);
        set_file_mode(&staging, 0o600)?;
        sync_file_and_parent(&staging)?;
        if regular_single_link_file(path, "Memory recovery control database")? {
            return Err(
                "Memory recovery control database appeared during initialization".to_string(),
            );
        }
        fs::hard_link(&staging, path).map_err(|error| {
            format!("Failed to publish Memory recovery control database: {error}")
        })?;
        published = true;
        fs::remove_file(&staging).map_err(|error| {
            format!("Failed to settle Memory recovery control database: {error}")
        })?;
        if !regular_single_link_file(path, "Memory recovery control database")? {
            return Err("Published Memory recovery control database disappeared".to_string());
        }
        sync_file_and_parent(path)?;
        write_external_anchor(&anchor_path, key, 0, ZERO_HASH, created_at_ms)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&staging);
        if published {
            let _ = fs::remove_file(path);
            let _ = fs::remove_file(&anchor_path);
        }
    }
    result
}

fn canonical_bytes(record: &StoredRecord) -> Result<Vec<u8>, String> {
    serde_json::to_vec(&CanonicalRecord {
        sequence: record.sequence,
        operation_id: &record.operation_id,
        operation_kind: &record.operation_kind,
        phase: &record.phase,
        idempotency_key: &record.idempotency_key,
        input_payload_sha256: &record.input_payload_sha256,
        memory_schema_sha256: &record.memory_schema_sha256,
        memory_database_sha256: &record.memory_database_sha256,
        memory_device: &record.memory_device,
        memory_inode: &record.memory_inode,
        memory_size: record.memory_size,
        snapshot_relative_path: &record.snapshot_relative_path,
        snapshot_sha256: &record.snapshot_sha256,
        incident_reason_sha256: record.incident_reason_sha256.as_deref(),
        previous_record_sha256: &record.previous_record_sha256,
        external_effects: record.external_effects,
        production_memory_mutated: record.production_memory_mutated,
        created_at_ms: record.created_at_ms,
    })
    .map_err(|error| format!("Failed to canonicalize Memory recovery record: {error}"))
}

fn journal_anchor_hmac(
    key: &[u8],
    head_sequence: i64,
    head_sha256: &str,
    created_at_ms: i64,
) -> Result<String, String> {
    let canonical = serde_json::to_vec(&CanonicalJournalAnchor {
        schema_version: SCHEMA_VERSION,
        schema_sha256: &sha256_hex(SCHEMA_SQL.as_bytes()),
        signing_key_id_sha256: &sha256_hex(key),
        journal_head_sequence: head_sequence,
        journal_head_sha256: head_sha256,
        created_at_ms,
    })
    .map_err(|error| format!("Failed to canonicalize Memory journal anchor: {error}"))?;
    let mut mac = HmacSha256::new_from_slice(key)
        .map_err(|_| "Failed to initialize Memory journal anchor HMAC".to_string())?;
    mac.update(&canonical);
    Ok(format!("{:x}", mac.finalize().into_bytes()))
}

fn external_anchor(
    key: &[u8],
    head_sequence: i64,
    head_sha256: &str,
    created_at_ms: i64,
) -> Result<ExternalJournalAnchor, String> {
    validate_hash("journalHeadSha256", head_sha256)?;
    Ok(ExternalJournalAnchor {
        schema_version: SCHEMA_VERSION,
        schema_sha256: sha256_hex(SCHEMA_SQL.as_bytes()),
        signing_key_id_sha256: sha256_hex(key),
        journal_head_sequence: head_sequence,
        journal_head_sha256: head_sha256.to_string(),
        journal_anchor_hmac_sha256: journal_anchor_hmac(
            key,
            head_sequence,
            head_sha256,
            created_at_ms,
        )?,
        created_at_ms,
    })
}

fn read_external_anchor(path: &Path, key: &[u8]) -> Result<ExternalJournalAnchor, String> {
    if !regular_single_link_file(path, "Memory recovery external journal anchor")? {
        return Err("Memory recovery external journal anchor is missing".to_string());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(path)
            .map_err(|error| {
                format!("Failed to inspect Memory recovery external journal anchor: {error}")
            })?
            .permissions()
            .mode()
            & 0o777;
        if mode != 0o400 {
            return Err("Memory recovery external journal anchor must have mode 0400".to_string());
        }
    }
    let normalized = normalize_platform_root_alias(path.to_path_buf());
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = options.open(&normalized).map_err(|error| {
        format!("Failed to open Memory recovery external journal anchor: {error}")
    })?;
    let before = file.metadata().map_err(|error| {
        format!("Failed to inspect Memory recovery external journal anchor: {error}")
    })?;
    if !before.is_file() || before.len() > MAX_EXTERNAL_ANCHOR_BYTES {
        return Err("Memory recovery external journal anchor is not bounded".to_string());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if before.nlink() != 1 {
            return Err(
                "Memory recovery external journal anchor must have exactly one filesystem link"
                    .to_string(),
            );
        }
    }
    let mut bytes = Vec::with_capacity(before.len() as usize);
    (&mut file)
        .take(MAX_EXTERNAL_ANCHOR_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| {
            format!("Failed to read Memory recovery external journal anchor: {error}")
        })?;
    if bytes.len() as u64 > MAX_EXTERNAL_ANCHOR_BYTES {
        return Err("Memory recovery external journal anchor exceeds its size limit".to_string());
    }
    let after = file.metadata().map_err(|error| {
        format!("Failed to re-inspect Memory recovery external journal anchor: {error}")
    })?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if before.dev() != after.dev()
            || before.ino() != after.ino()
            || before.len() != after.len()
            || after.nlink() != 1
        {
            return Err(
                "Memory recovery external journal anchor changed during inspection".to_string(),
            );
        }
    }
    let anchor: ExternalJournalAnchor = serde_json::from_slice(&bytes).map_err(|error| {
        format!("Memory recovery external journal anchor is malformed: {error}")
    })?;
    if anchor.schema_version != SCHEMA_VERSION
        || anchor.schema_sha256 != sha256_hex(SCHEMA_SQL.as_bytes())
        || anchor.signing_key_id_sha256 != sha256_hex(key)
        || anchor.journal_head_sequence < 0
    {
        return Err("Memory recovery external journal anchor identity mismatch".to_string());
    }
    validate_hash("journalHeadSha256", &anchor.journal_head_sha256)?;
    validate_hash(
        "journalAnchorHmacSha256",
        &anchor.journal_anchor_hmac_sha256,
    )?;
    let expected = journal_anchor_hmac(
        key,
        anchor.journal_head_sequence,
        &anchor.journal_head_sha256,
        anchor.created_at_ms,
    )?;
    if anchor.journal_anchor_hmac_sha256 != expected {
        return Err("Memory recovery external journal anchor HMAC mismatch".to_string());
    }
    Ok(anchor)
}

fn write_external_anchor(
    path: &Path,
    key: &[u8],
    head_sequence: i64,
    head_sha256: &str,
    created_at_ms: i64,
) -> Result<(), String> {
    let anchor = external_anchor(key, head_sequence, head_sha256, created_at_ms)?;
    let mut bytes = serde_json::to_vec(&anchor)
        .map_err(|error| format!("Failed to serialize Memory external journal anchor: {error}"))?;
    bytes.push(b'\n');
    if bytes.len() as u64 > MAX_EXTERNAL_ANCHOR_BYTES {
        return Err("Memory recovery external journal anchor exceeds its size limit".to_string());
    }
    if regular_single_link_file(path, "Memory recovery external journal anchor")? {
        let _ = read_external_anchor(path, key)?;
    }
    let parent = path
        .parent()
        .ok_or("Memory recovery external journal anchor has no parent")?;
    let staging = parent.join(format!(".memory-recovery-v1.{}.anchor.tmp", Uuid::new_v4()));
    let result = (|| -> Result<(), String> {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        }
        let mut file = options.open(&staging).map_err(|error| {
            format!("Failed to stage Memory recovery external journal anchor: {error}")
        })?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|error| {
                format!("Failed to persist Memory recovery external journal anchor: {error}")
            })?;
        drop(file);
        set_file_mode(&staging, 0o400)?;
        fs::rename(&staging, path).map_err(|error| {
            format!("Failed to publish Memory recovery external journal anchor: {error}")
        })?;
        sync_file_and_parent(path)?;
        let written = read_external_anchor(path, key)?;
        if written != anchor {
            return Err("Published Memory recovery external journal anchor drifted".to_string());
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&staging);
    }
    result
}

fn decode_hex(value: &str) -> Result<Vec<u8>, String> {
    if value.len() % 2 != 0 {
        return Err("Invalid Memory recovery HMAC encoding".to_string());
    }
    (0..value.len())
        .step_by(2)
        .map(|index| {
            u8::from_str_radix(&value[index..index + 2], 16)
                .map_err(|_| "Invalid Memory recovery HMAC encoding".to_string())
        })
        .collect()
}

fn sign_record(record: &mut StoredRecord, key: &[u8]) -> Result<(), String> {
    let canonical = canonical_bytes(record)?;
    record.record_sha256 = sha256_hex(&canonical);
    let mut mac = HmacSha256::new_from_slice(key)
        .map_err(|_| "Failed to initialize Memory recovery HMAC".to_string())?;
    mac.update(&canonical);
    record.record_hmac_sha256 = format!("{:x}", mac.finalize().into_bytes());
    Ok(())
}

fn verify_record(record: &StoredRecord, key: &[u8]) -> Result<(), String> {
    let canonical = canonical_bytes(record)?;
    if sha256_hex(&canonical) != record.record_sha256 {
        return Err(format!(
            "Memory recovery record {} hash mismatch",
            record.sequence
        ));
    }
    let signature = decode_hex(&record.record_hmac_sha256)?;
    let mut mac = HmacSha256::new_from_slice(key)
        .map_err(|_| "Failed to initialize Memory recovery HMAC".to_string())?;
    mac.update(&canonical);
    mac.verify_slice(&signature)
        .map_err(|_| format!("Memory recovery record {} HMAC mismatch", record.sequence))
}

fn decode_record(row: &rusqlite::Row<'_>) -> rusqlite::Result<StoredRecord> {
    Ok(StoredRecord {
        sequence: row.get(0)?,
        operation_id: row.get(1)?,
        operation_kind: row.get(2)?,
        phase: row.get(3)?,
        idempotency_key: row.get(4)?,
        input_payload_sha256: row.get(5)?,
        memory_schema_sha256: row.get(6)?,
        memory_database_sha256: row.get(7)?,
        memory_device: row.get(8)?,
        memory_inode: row.get(9)?,
        memory_size: row.get(10)?,
        snapshot_relative_path: row.get(11)?,
        snapshot_sha256: row.get(12)?,
        incident_reason_sha256: row.get(13)?,
        previous_record_sha256: row.get(14)?,
        record_sha256: row.get(15)?,
        record_hmac_sha256: row.get(16)?,
        external_effects: row.get(17)?,
        production_memory_mutated: row.get(18)?,
        created_at_ms: row.get(19)?,
    })
}

const RECORD_SELECT: &str = "SELECT sequence, operation_id, operation_kind, phase, idempotency_key, input_payload_sha256, memory_schema_sha256, memory_database_sha256, memory_device, memory_inode, memory_size, snapshot_relative_path, snapshot_sha256, incident_reason_sha256, previous_record_sha256, record_sha256, record_hmac_sha256, external_effects, production_memory_mutated, created_at_ms FROM memory_recovery_record";

fn read_all_records(connection: &Connection) -> Result<Vec<StoredRecord>, String> {
    let mut statement = connection
        .prepare(&format!("{RECORD_SELECT} ORDER BY sequence"))
        .map_err(|error| format!("Failed to inspect Memory recovery journal: {error}"))?;
    let rows = statement
        .query_map([], decode_record)
        .map_err(|error| format!("Failed to read Memory recovery journal: {error}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Failed to decode Memory recovery journal: {error}"))
}

fn verify_journal(
    connection: &Connection,
    key: &[u8],
    external_path: &Path,
) -> Result<Vec<StoredRecord>, String> {
    let (
        schema_version,
        schema_sha256,
        key_id,
        anchored_sequence,
        anchored_sha256,
        anchor_hmac,
        created_at_ms,
    ): (i64, String, String, i64, String, String, i64) = connection
        .query_row(
            "SELECT schema_version, schema_sha256, signing_key_id_sha256, journal_head_sequence, journal_head_sha256, journal_anchor_hmac_sha256, created_at_ms FROM memory_recovery_meta WHERE id = 1",
            [],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                ))
            },
        )
        .map_err(|error| format!("Memory recovery journal anchor is missing: {error}"))?;
    if schema_version != SCHEMA_VERSION
        || schema_sha256 != sha256_hex(SCHEMA_SQL.as_bytes())
        || key_id != sha256_hex(key)
        || anchored_sequence < 0
    {
        return Err("Memory recovery journal anchor identity mismatch".to_string());
    }
    validate_hash("journalHeadSha256", &anchored_sha256)?;
    let actual_anchor_hmac = decode_hex(&anchor_hmac)?;
    let mut anchor_mac = HmacSha256::new_from_slice(key)
        .map_err(|_| "Failed to initialize Memory journal anchor HMAC".to_string())?;
    anchor_mac.update(
        &serde_json::to_vec(&CanonicalJournalAnchor {
            schema_version,
            schema_sha256: &schema_sha256,
            signing_key_id_sha256: &key_id,
            journal_head_sequence: anchored_sequence,
            journal_head_sha256: &anchored_sha256,
            created_at_ms,
        })
        .map_err(|error| format!("Failed to canonicalize Memory journal anchor: {error}"))?,
    );
    anchor_mac
        .verify_slice(&actual_anchor_hmac)
        .map_err(|_| "Memory recovery journal anchor HMAC mismatch".to_string())?;
    let external = read_external_anchor(external_path, key)?;
    if external.schema_version != schema_version
        || external.schema_sha256 != schema_sha256
        || external.signing_key_id_sha256 != key_id
        || external.journal_head_sequence != anchored_sequence
        || external.journal_head_sha256 != anchored_sha256
        || external.journal_anchor_hmac_sha256 != anchor_hmac
        || external.created_at_ms != created_at_ms
    {
        return Err(
            "Memory recovery external journal anchor detected control-database rollback"
                .to_string(),
        );
    }
    let records = read_all_records(connection)?;
    let mut previous = ZERO_HASH.to_string();
    for (index, record) in records.iter().enumerate() {
        if record.sequence != index as i64 + 1 {
            return Err("Memory recovery journal sequence is not contiguous".to_string());
        }
        if record.previous_record_sha256 != previous {
            return Err(format!(
                "Memory recovery record {} chain mismatch",
                record.sequence
            ));
        }
        if record.external_effects != 0 || record.production_memory_mutated != 0 {
            return Err("Memory recovery journal contains a forbidden effect".to_string());
        }
        verify_record(record, key)?;
        previous = record.record_sha256.clone();
    }
    let actual_sequence = records.last().map(|record| record.sequence).unwrap_or(0);
    if anchored_sequence != actual_sequence || anchored_sha256 != previous {
        return Err("Memory recovery journal truncation or rollback detected".to_string());
    }
    crate::experimental_sqlite_attestation::attest_exact_schema(
        connection,
        SCHEMA_SQL,
        "Memory recovery",
    )?;
    Ok(records)
}

fn inspect_control_store(path: &Path, key: &[u8]) -> Result<StoreInspection, String> {
    if !regular_single_link_file(path, "Memory recovery control database")? {
        return Ok(StoreInspection {
            initialized: false,
            ready: false,
            schema_version: None,
            journal_record_count: 0,
            pending_recovery_count: 0,
            blocked_reason: None,
        });
    }
    let result = (|| -> Result<(i64, u64, u64), String> {
        let connection = open_read_only(path, "Memory recovery control database")?;
        sqlite_quick_check(&connection, "Memory recovery")?;
        crate::experimental_sqlite_attestation::attest_exact_schema(
            &connection,
            SCHEMA_SQL,
            "Memory recovery",
        )?;
        let (version, schema_hash, key_id): (i64, String, String) = connection
            .query_row(
                "SELECT schema_version, schema_sha256, signing_key_id_sha256 FROM memory_recovery_meta WHERE id = 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .map_err(|error| format!("Memory recovery schema metadata is missing: {error}"))?;
        if version != SCHEMA_VERSION
            || schema_hash != sha256_hex(SCHEMA_SQL.as_bytes())
            || key_id != sha256_hex(key)
        {
            return Err("Memory recovery schema or signing-key identity mismatch".to_string());
        }
        for (table, expected) in TABLE_SHAPES {
            let actual = table_columns(&connection, table)?;
            let expected: Vec<String> = expected.iter().map(|value| (*value).to_string()).collect();
            if actual != expected {
                return Err(format!("Memory recovery table shape mismatch: {table}"));
            }
        }
        for trigger in [
            "memory_recovery_record_immutable",
            "memory_recovery_record_no_delete",
        ] {
            let count: i64 = connection
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger' AND name = ?1",
                    [trigger],
                    |row| row.get(0),
                )
                .map_err(|error| {
                    format!("Failed to inspect recovery trigger {trigger}: {error}")
                })?;
            if count != 1 {
                return Err(format!(
                    "Memory recovery schema is missing trigger {trigger}"
                ));
            }
        }
        let root = path
            .parent()
            .ok_or("Memory recovery control database has no parent")?;
        let records = verify_journal(&connection, key, &external_anchor_path(root))?;
        let pending = records
            .iter()
            .filter(|record| {
                record.phase == "prepared"
                    && !records.iter().any(|candidate| {
                        candidate.operation_id == record.operation_id
                            && candidate.phase == "recovered_no_effect"
                    })
            })
            .count() as u64;
        Ok((version, records.len() as u64, pending))
    })();
    Ok(match result {
        Ok((version, count, pending)) => StoreInspection {
            initialized: true,
            ready: true,
            schema_version: Some(version),
            journal_record_count: count,
            pending_recovery_count: pending,
            blocked_reason: None,
        },
        Err(error) => StoreInspection {
            initialized: true,
            ready: false,
            schema_version: None,
            journal_record_count: 0,
            pending_recovery_count: 0,
            blocked_reason: Some(error),
        },
    })
}

fn status_at(root: &Path, enabled: bool) -> ExperimentalMemoryRecoveryStatus {
    let path = control_path(root);
    let inspection = if !platform_supported() {
        StoreInspection {
            initialized: false,
            ready: false,
            schema_version: None,
            journal_record_count: 0,
            pending_recovery_count: 0,
            blocked_reason: Some(
                "Experimental Memory recovery requires a native Unix host-wide lease".to_string(),
            ),
        }
    } else if !enabled {
        StoreInspection {
            initialized: false,
            ready: false,
            schema_version: None,
            journal_record_count: 0,
            pending_recovery_count: 0,
            blocked_reason: None,
        }
    } else {
        read_signing_key(&key_path(root))
            .and_then(|key| inspect_control_store(&path, &key))
            .unwrap_or_else(|error| StoreInspection {
                initialized: path.exists(),
                ready: false,
                schema_version: None,
                journal_record_count: 0,
                pending_recovery_count: 0,
                blocked_reason: Some(error),
            })
    };
    ExperimentalMemoryRecoveryStatus {
        enabled: enabled && platform_supported(),
        platform_supported: platform_supported(),
        initialized: inspection.initialized,
        ready: enabled && inspection.ready,
        path: path.display().to_string(),
        schema_version: inspection.schema_version,
        schema_sha256: sha256_hex(SCHEMA_SQL.as_bytes()),
        journal_record_count: inspection.journal_record_count,
        pending_recovery_count: inspection.pending_recovery_count,
        host_wide_lease_enforced: platform_supported(),
        journal_hmac_verified: enabled && inspection.ready,
        immutable_snapshots_enabled: enabled && inspection.ready,
        automatic_restore_enabled: false,
        dual_read_enabled: false,
        production_memory_mutated: false,
        production_integration: false,
        blocked_reason: inspection.blocked_reason,
    }
}

#[tauri::command]
pub(crate) fn get_experimental_memory_recovery_status(
) -> Result<ExperimentalMemoryRecoveryStatus, String> {
    let root = status_root()?;
    Ok(status_at(&root, feature_enabled()))
}

pub(crate) fn initialize_at(root: &Path) -> Result<ExperimentalMemoryRecoveryStatus, String> {
    require_supported_platform()?;
    let root = normalize_platform_root_alias(root.to_path_buf());
    ensure_private_directory(&root, "Experimental Memory root")?;
    let _lease = acquire_host_wide_memory_lease(&root)?;
    let database_exists =
        regular_single_link_file(&control_path(&root), "Memory recovery control database")?;
    let key_exists = regular_single_link_file(&key_path(&root), "Memory recovery signing key")?;
    if database_exists && !key_exists {
        return Err(
            "Memory recovery control database exists without its signing key; refusing key rotation"
                .to_string(),
        );
    }
    let key = create_signing_key(&key_path(&root))?;
    create_control_store(&control_path(&root), &key)?;
    Ok(status_at(&root, true))
}

#[tauri::command]
pub(crate) fn initialize_experimental_memory_recovery(
) -> Result<ExperimentalMemoryRecoveryStatus, String> {
    initialize_at(&isolated_root()?)
}

pub(crate) fn validate_sqlite_sidecars(path: &Path) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or("Experimental Memory database path has no parent")?;
    let base = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or("Experimental Memory database filename is invalid")?;
    for suffix in ["-wal", "-shm", "-journal"] {
        let sidecar = parent.join(format!("{base}{suffix}"));
        match fs::symlink_metadata(&sidecar) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() || !metadata.is_file() {
                    return Err(format!(
                        "Experimental Memory SQLite sidecar {suffix} is not a regular file"
                    ));
                }
                #[cfg(unix)]
                {
                    use std::os::unix::fs::MetadataExt;
                    if metadata.nlink() != 1 {
                        return Err(format!(
                            "Experimental Memory SQLite sidecar {suffix} must have exactly one filesystem link"
                        ));
                    }
                }
                if suffix == "-wal" && metadata.len() > 0 {
                    if metadata.len() < 32 {
                        return Err(
                            "Experimental Memory database has a malformed SQLite sidecar: -wal"
                                .to_string(),
                        );
                    }
                    let mut header = [0u8; 4];
                    File::open(&sidecar)
                        .and_then(|mut file| file.read_exact(&mut header))
                        .map_err(|error| {
                            format!("Failed to inspect Experimental Memory SQLite sidecar: {error}")
                        })?;
                    if header != [0x37, 0x7f, 0x06, 0x82] && header != [0x37, 0x7f, 0x06, 0x83] {
                        return Err(
                            "Experimental Memory database has a malformed SQLite sidecar: -wal"
                                .to_string(),
                        );
                    }
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!(
                    "Failed to inspect Experimental Memory SQLite sidecar {suffix}: {error}"
                ))
            }
        }
    }
    let super_prefix = format!("{base}-mj");
    for entry in fs::read_dir(parent)
        .map_err(|error| format!("Failed to inspect Memory sidecars: {error}"))?
    {
        let name = entry
            .map_err(|error| format!("Failed to inspect Memory sidecar entry: {error}"))?
            .file_name();
        if name.to_string_lossy().starts_with(&super_prefix) {
            return Err(
                "Experimental Memory database has an unsettled SQLite super-journal".to_string(),
            );
        }
    }
    Ok(())
}

fn capture_consistent_memory_copy(
    memory_database: &Path,
    destination: &Path,
) -> Result<MemoryFileSnapshot, String> {
    validate_sqlite_sidecars(memory_database)?;
    let physical_before = capture_memory_file(memory_database, None)?;
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let staged_file = options
        .open(destination)
        .map_err(|error| format!("Failed to stage Memory recovery snapshot: {error}"))?;
    staged_file
        .sync_all()
        .map_err(|error| format!("Failed to sync staged Memory recovery snapshot: {error}"))?;
    drop(staged_file);

    let source = open_read_only(memory_database, "Experimental Memory database")?;
    sqlite_quick_check(&source, "Experimental Memory database")
        .map_err(|error| format!("Memory SQLite sidecar consistency check failed: {error}"))?;
    source
        .backup(DatabaseName::Main, destination, None)
        .map_err(|error| {
            format!("Failed to create consistent Memory recovery snapshot: {error}")
        })?;
    drop(source);

    validate_sqlite_sidecars(memory_database)?;
    let physical_after = capture_memory_file(memory_database, None)?;
    if physical_after != physical_before {
        return Err("Experimental Memory database changed during SQLite backup".to_string());
    }
    sync_file_and_parent(destination)?;
    let snapshot = capture_memory_file(destination, None)?;
    let snapshot_connection = open_read_only(destination, "Memory recovery snapshot")?;
    sqlite_quick_check(&snapshot_connection, "Memory recovery snapshot")?;
    drop(snapshot_connection);
    Ok(MemoryFileSnapshot {
        sha256: snapshot.sha256,
        device: physical_before.device,
        inode: physical_before.inode,
        size: snapshot.size,
    })
}

pub(crate) fn capture_memory_file(
    path: &Path,
    writer: Option<&mut File>,
) -> Result<MemoryFileSnapshot, String> {
    if !regular_single_link_file(path, "Experimental Memory database")? {
        return Err("Experimental Memory database is not initialized".to_string());
    }
    #[cfg(unix)]
    let mut source = {
        use std::os::unix::fs::OpenOptionsExt;
        let mut options = OpenOptions::new();
        options.read(true).custom_flags(libc::O_NOFOLLOW);
        options
            .open(path)
            .map_err(|error| format!("Failed to open Experimental Memory database: {error}"))?
    };
    #[cfg(not(unix))]
    let mut source = File::open(path)
        .map_err(|error| format!("Failed to open Experimental Memory database: {error}"))?;
    let before = source
        .metadata()
        .map_err(|error| format!("Failed to inspect Experimental Memory database: {error}"))?;
    if !before.is_file() || before.len() > MAX_MEMORY_DATABASE_BYTES {
        return Err("Experimental Memory database is not a bounded regular file".to_string());
    }
    #[cfg(unix)]
    let (device, inode, mtime, ctime, links) = {
        use std::os::unix::fs::MetadataExt;
        (
            before.dev().to_string(),
            before.ino().to_string(),
            (before.mtime(), before.mtime_nsec()),
            (before.ctime(), before.ctime_nsec()),
            before.nlink(),
        )
    };
    #[cfg(not(unix))]
    let (device, inode, mtime, ctime, links) = (
        "unsupported".to_string(),
        "unsupported".to_string(),
        (0, 0),
        (0, 0),
        1,
    );
    if links != 1 {
        return Err(
            "Experimental Memory database must have exactly one filesystem link".to_string(),
        );
    }
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    let mut writer = writer;
    let mut total = 0u64;
    loop {
        let count = source
            .read(&mut buffer)
            .map_err(|error| format!("Failed to read Experimental Memory database: {error}"))?;
        if count == 0 {
            break;
        }
        total = total
            .checked_add(count as u64)
            .ok_or("Experimental Memory database size overflow")?;
        if total > MAX_MEMORY_DATABASE_BYTES {
            return Err("Experimental Memory database exceeds recovery size limit".to_string());
        }
        hasher.update(&buffer[..count]);
        if let Some(output) = writer.as_deref_mut() {
            output
                .write_all(&buffer[..count])
                .map_err(|error| format!("Failed to write Memory recovery snapshot: {error}"))?;
        }
    }
    let after = source
        .metadata()
        .map_err(|error| format!("Failed to re-inspect Experimental Memory database: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if before.dev() != after.dev()
            || before.ino() != after.ino()
            || before.len() != after.len()
            || (after.mtime(), after.mtime_nsec()) != mtime
            || (after.ctime(), after.ctime_nsec()) != ctime
            || after.nlink() != 1
        {
            return Err("Experimental Memory database changed during recovery capture".to_string());
        }
    }
    if total != before.len() {
        return Err(
            "Experimental Memory database was truncated during recovery capture".to_string(),
        );
    }
    Ok(MemoryFileSnapshot {
        sha256: format!("{:x}", hasher.finalize()),
        device,
        inode,
        size: total,
    })
}

fn capture_snapshot(
    root: &Path,
    operation_id: &str,
    memory_database: &Path,
) -> Result<(MemoryFileSnapshot, String, String), String> {
    validate_token("operationId", operation_id)?;
    let root = normalize_platform_root_alias(root.to_path_buf());
    let memory_database = normalize_platform_root_alias(memory_database.to_path_buf());
    let snapshots = snapshot_root(&root);
    ensure_private_directory(&snapshots, "Memory recovery snapshot root")?;
    let relative = format!("memory-recovery-snapshots/{operation_id}.sqlite");
    let final_path = root.join(&relative);
    if regular_single_link_file(&final_path, "Memory recovery snapshot")? {
        validate_immutable_snapshot_file(&final_path)?;
        let verification = snapshots.join(format!(
            ".{operation_id}.{}.verification.tmp",
            Uuid::new_v4()
        ));
        let result = (|| -> Result<(MemoryFileSnapshot, String, String), String> {
            let source = capture_consistent_memory_copy(&memory_database, &verification)?;
            let snapshot = capture_memory_file(&final_path, None)?;
            if source.sha256 != snapshot.sha256 || source.size != snapshot.size {
                return Err(
                    "Existing Memory recovery snapshot does not match the source".to_string(),
                );
            }
            Ok((source, relative, snapshot.sha256))
        })();
        let cleanup = match fs::remove_file(&verification) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(format!(
                "Failed to remove Memory snapshot verification file: {error}"
            )),
        };
        return match result {
            Err(error) => Err(error),
            Ok(receipt) => {
                cleanup?;
                Ok(receipt)
            }
        };
    }
    let staging = snapshots.join(format!(".{operation_id}.{}.tmp", Uuid::new_v4()));
    let result = (|| -> Result<(MemoryFileSnapshot, String, String), String> {
        let source = capture_consistent_memory_copy(&memory_database, &staging)?;
        set_file_mode(&staging, 0o400)?;
        fs::hard_link(&staging, &final_path)
            .map_err(|error| format!("Failed to publish Memory recovery snapshot: {error}"))?;
        fs::remove_file(&staging)
            .map_err(|error| format!("Failed to settle Memory recovery snapshot: {error}"))?;
        sync_file_and_parent(&final_path)?;
        validate_immutable_snapshot_file(&final_path)?;
        let snapshot = capture_memory_file(&final_path, None)?;
        if source.sha256 != snapshot.sha256 || source.size != snapshot.size {
            return Err(
                "Published Memory recovery snapshot failed parity verification".to_string(),
            );
        }
        Ok((source, relative, snapshot.sha256))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&staging);
    }
    result
}

fn capture_transient_memory_state(
    root: &Path,
    operation_id: &str,
    memory_database: &Path,
) -> Result<MemoryFileSnapshot, String> {
    let root = normalize_platform_root_alias(root.to_path_buf());
    let memory_database = normalize_platform_root_alias(memory_database.to_path_buf());
    let snapshots = snapshot_root(&root);
    ensure_private_directory(&snapshots, "Memory recovery snapshot root")?;
    let transient = snapshots.join(format!(".{operation_id}.{}.reconcile.tmp", Uuid::new_v4()));
    let result = capture_consistent_memory_copy(&memory_database, &transient);
    let cleanup = match fs::remove_file(&transient) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!(
            "Failed to remove transient Memory reconciliation snapshot: {error}"
        )),
    };
    let state = result?;
    cleanup?;
    Ok(state)
}

fn stable_input_sha256<T: Serialize>(input: &T) -> Result<String, String> {
    serde_json::to_vec(input)
        .map(|bytes| sha256_hex(&bytes))
        .map_err(|error| format!("Failed to canonicalize Memory recovery input: {error}"))
}

fn find_phase_record(
    connection: &Connection,
    phase: &str,
    operation_id: &str,
    idempotency_key: &str,
) -> Result<Option<StoredRecord>, String> {
    let mut statement = connection
        .prepare(&format!(
            "{RECORD_SELECT} WHERE phase = ?1 AND (operation_id = ?2 OR idempotency_key = ?3) ORDER BY sequence"
        ))
        .map_err(|error| format!("Failed to inspect Memory recovery idempotency: {error}"))?;
    let rows = statement
        .query_map(params![phase, operation_id, idempotency_key], decode_record)
        .map_err(|error| format!("Failed to read Memory recovery idempotency: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Failed to decode Memory recovery idempotency: {error}"))?;
    if rows.len() > 1 {
        return Err(
            "Memory recovery identity and idempotency key resolve to different records".to_string(),
        );
    }
    Ok(rows.into_iter().next())
}

fn receipt(record: &StoredRecord, duplicate: bool) -> MemoryRecoveryReceipt {
    MemoryRecoveryReceipt {
        operation_id: record.operation_id.clone(),
        operation_kind: record.operation_kind.clone(),
        phase: record.phase.clone(),
        record_sequence: record.sequence,
        record_sha256: record.record_sha256.clone(),
        record_hmac_sha256: record.record_hmac_sha256.clone(),
        memory_database_sha256: record.memory_database_sha256.clone(),
        snapshot_relative_path: record.snapshot_relative_path.clone(),
        snapshot_sha256: record.snapshot_sha256.clone(),
        rollback_snapshot_bound: true,
        operator_action_required: record.phase == "quarantine_required",
        quarantine_performed: false,
        automatic_restore_enabled: false,
        production_memory_mutated: false,
        external_effects: 0,
        duplicate,
        production_integration: false,
    }
}

struct NewRecord<'a> {
    operation_id: &'a str,
    operation_kind: &'a str,
    phase: &'a str,
    idempotency_key: &'a str,
    input_payload_sha256: &'a str,
    memory: &'a MemoryFileSnapshot,
    snapshot_relative_path: &'a str,
    snapshot_sha256: &'a str,
    incident_reason_sha256: Option<&'a str>,
}

fn append_record(
    connection: &mut Connection,
    key: &[u8],
    external_path: &Path,
    new: NewRecord<'_>,
) -> Result<StoredRecord, String> {
    verify_journal(connection, key, external_path)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("Failed to lock Memory recovery journal: {error}"))?;
    let (sequence, previous): (i64, String) = transaction
        .query_row(
            "SELECT COALESCE(MAX(sequence), 0) + 1, COALESCE((SELECT record_sha256 FROM memory_recovery_record ORDER BY sequence DESC LIMIT 1), ?1) FROM memory_recovery_record",
            [ZERO_HASH],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|error| format!("Failed to advance Memory recovery journal: {error}"))?;
    let mut record = StoredRecord {
        sequence,
        operation_id: new.operation_id.to_string(),
        operation_kind: new.operation_kind.to_string(),
        phase: new.phase.to_string(),
        idempotency_key: new.idempotency_key.to_string(),
        input_payload_sha256: new.input_payload_sha256.to_string(),
        memory_schema_sha256: sha256_hex(MEMORY_SCHEMA_SQL.as_bytes()),
        memory_database_sha256: new.memory.sha256.clone(),
        memory_device: new.memory.device.clone(),
        memory_inode: new.memory.inode.clone(),
        memory_size: i64::try_from(new.memory.size)
            .map_err(|_| "Memory recovery source size exceeds SQLite range")?,
        snapshot_relative_path: new.snapshot_relative_path.to_string(),
        snapshot_sha256: new.snapshot_sha256.to_string(),
        incident_reason_sha256: new.incident_reason_sha256.map(str::to_string),
        previous_record_sha256: previous,
        record_sha256: String::new(),
        record_hmac_sha256: String::new(),
        external_effects: 0,
        production_memory_mutated: 0,
        created_at_ms: now_ms(),
    };
    sign_record(&mut record, key)?;
    let meta_created_at_ms: i64 = transaction
        .query_row(
            "SELECT created_at_ms FROM memory_recovery_meta WHERE id = 1",
            [],
            |row| row.get(0),
        )
        .map_err(|error| format!("Failed to read Memory journal anchor metadata: {error}"))?;
    let anchor_hmac = journal_anchor_hmac(
        key,
        record.sequence,
        &record.record_sha256,
        meta_created_at_ms,
    )?;
    transaction
        .execute(
            "INSERT INTO memory_recovery_record(sequence, operation_id, operation_kind, phase, idempotency_key, input_payload_sha256, memory_schema_sha256, memory_database_sha256, memory_device, memory_inode, memory_size, snapshot_relative_path, snapshot_sha256, incident_reason_sha256, previous_record_sha256, record_sha256, record_hmac_sha256, external_effects, production_memory_mutated, created_at_ms) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, 0, 0, ?18)",
            params![
                record.sequence,
                record.operation_id,
                record.operation_kind,
                record.phase,
                record.idempotency_key,
                record.input_payload_sha256,
                record.memory_schema_sha256,
                record.memory_database_sha256,
                record.memory_device,
                record.memory_inode,
                record.memory_size,
                record.snapshot_relative_path,
                record.snapshot_sha256,
                record.incident_reason_sha256,
                record.previous_record_sha256,
                record.record_sha256,
                record.record_hmac_sha256,
                record.created_at_ms,
            ],
        )
        .map_err(|error| format!("Failed to append Memory recovery journal: {error}"))?;
    let anchor_updates = transaction
        .execute(
            "UPDATE memory_recovery_meta SET journal_head_sequence = ?1, journal_head_sha256 = ?2, journal_anchor_hmac_sha256 = ?3 WHERE id = 1",
            params![record.sequence, record.record_sha256, anchor_hmac],
        )
        .map_err(|error| format!("Failed to advance Memory journal anchor: {error}"))?;
    if anchor_updates != 1 {
        return Err("Memory journal anchor update affected an unexpected row count".to_string());
    }
    transaction
        .commit()
        .map_err(|error| format!("Failed to commit Memory recovery journal: {error}"))?;
    write_external_anchor(
        external_path,
        key,
        record.sequence,
        &record.record_sha256,
        meta_created_at_ms,
    )?;
    verify_record(&record, key)?;
    Ok(record)
}

fn validate_duplicate(
    record: StoredRecord,
    operation_id: &str,
    idempotency_key: &str,
    input_payload_sha256: &str,
) -> Result<MemoryRecoveryReceipt, String> {
    if record.operation_id != operation_id
        || record.idempotency_key != idempotency_key
        || record.input_payload_sha256 != input_payload_sha256
    {
        return Err("Memory recovery idempotency payload conflict".to_string());
    }
    Ok(receipt(&record, true))
}

fn ensure_no_conflicting_operation(
    connection: &Connection,
    operation_id: &str,
    idempotency_key: &str,
) -> Result<(), String> {
    let count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM memory_recovery_record WHERE operation_id = ?1 OR idempotency_key = ?2",
            params![operation_id, idempotency_key],
            |row| row.get(0),
        )
        .map_err(|error| format!("Failed to inspect Memory recovery operation identity: {error}"))?;
    if count == 0 {
        Ok(())
    } else {
        Err("Memory recovery operation identity already belongs to another phase".to_string())
    }
}

pub(crate) fn prepare_at(
    root: &Path,
    input: PrepareMemoryRecoveryDrillInput,
) -> Result<MemoryRecoveryReceipt, String> {
    validate_token("operationId", &input.operation_id)?;
    validate_token("idempotencyKey", &input.idempotency_key)?;
    validate_hash("expectedMemorySha256", &input.expected_memory_sha256)?;
    let input_hash = stable_input_sha256(&input)?;
    let root = normalize_platform_root_alias(root.to_path_buf());
    let _lease = acquire_host_wide_memory_lease(&root)?;
    let key = read_signing_key(&key_path(&root))?;
    let mut connection = open_read_write(&control_path(&root))?;
    verify_journal(&connection, &key, &external_anchor_path(&root))?;
    if let Some(existing) = find_phase_record(
        &connection,
        "prepared",
        &input.operation_id,
        &input.idempotency_key,
    )? {
        return validate_duplicate(
            existing,
            &input.operation_id,
            &input.idempotency_key,
            &input_hash,
        );
    }
    ensure_no_conflicting_operation(&connection, &input.operation_id, &input.idempotency_key)?;
    let database = memory_path(&root);
    validate_sqlite_sidecars(&database)?;
    let before = capture_memory_file(&database, None)?;
    if before.sha256 != input.expected_memory_sha256 {
        return Err(
            "Experimental Memory database hash does not match the confirmed input".to_string(),
        );
    }
    crate::experimental_foundation::validate_memory_store_for_recovery(&database)?;
    let (captured, relative, snapshot_sha256) =
        capture_snapshot(&root, &input.operation_id, &database)?;
    validate_sqlite_sidecars(&database)?;
    let after = capture_memory_file(&database, None)?;
    if after != before || captured.device != before.device || captured.inode != before.inode {
        return Err("Experimental Memory database changed across recovery inspection".to_string());
    }
    let record = append_record(
        &mut connection,
        &key,
        &external_anchor_path(&root),
        NewRecord {
            operation_id: &input.operation_id,
            operation_kind: "crash_recovery_drill",
            phase: "prepared",
            idempotency_key: &input.idempotency_key,
            input_payload_sha256: &input_hash,
            memory: &captured,
            snapshot_relative_path: &relative,
            snapshot_sha256: &snapshot_sha256,
            incident_reason_sha256: None,
        },
    )?;
    Ok(receipt(&record, false))
}

#[tauri::command]
pub(crate) fn prepare_experimental_memory_recovery_drill(
    input: PrepareMemoryRecoveryDrillInput,
) -> Result<MemoryRecoveryReceipt, String> {
    prepare_at(&isolated_root()?, input)
}

pub(crate) fn reconcile_at(
    root: &Path,
    input: ReconcileMemoryRecoveryDrillInput,
) -> Result<MemoryRecoveryReceipt, String> {
    validate_token("operationId", &input.operation_id)?;
    validate_token("idempotencyKey", &input.idempotency_key)?;
    validate_hash(
        "expectedPreparedRecordSha256",
        &input.expected_prepared_record_sha256,
    )?;
    let input_hash = stable_input_sha256(&input)?;
    let root = normalize_platform_root_alias(root.to_path_buf());
    let _lease = acquire_host_wide_memory_lease(&root)?;
    let key = read_signing_key(&key_path(&root))?;
    let mut connection = open_read_write(&control_path(&root))?;
    let records = verify_journal(&connection, &key, &external_anchor_path(&root))?;
    if let Some(existing) = find_phase_record(
        &connection,
        "recovered_no_effect",
        &input.operation_id,
        &input.idempotency_key,
    )? {
        return validate_duplicate(
            existing,
            &input.operation_id,
            &input.idempotency_key,
            &input_hash,
        );
    }
    let prepared = records
        .iter()
        .find(|record| record.operation_id == input.operation_id && record.phase == "prepared")
        .cloned()
        .ok_or("Memory recovery drill has no prepared record")?;
    if prepared.record_sha256 != input.expected_prepared_record_sha256 {
        return Err("Prepared Memory recovery record hash mismatch".to_string());
    }
    if prepared.idempotency_key == input.idempotency_key {
        return Err("Reconciliation must use a distinct idempotency key".to_string());
    }
    let snapshot = root.join(&prepared.snapshot_relative_path);
    validate_immutable_snapshot_file(&snapshot)?;
    let snapshot_state = capture_memory_file(&snapshot, None)?;
    if snapshot_state.sha256 != prepared.snapshot_sha256
        || snapshot_state.sha256 != prepared.memory_database_sha256
    {
        return Err(
            "Memory recovery rollback snapshot no longer matches its signed record".to_string(),
        );
    }
    let database = memory_path(&root);
    validate_sqlite_sidecars(&database)?;
    let physical = capture_memory_file(&database, None)?;
    crate::experimental_foundation::validate_memory_store_for_recovery(&database)?;
    let current = capture_transient_memory_state(&root, &input.operation_id, &database)?;
    validate_sqlite_sidecars(&database)?;
    if current.sha256 != prepared.memory_database_sha256
        || current.device != prepared.memory_device
        || current.inode != prepared.memory_inode
        || i64::try_from(current.size).ok() != Some(prepared.memory_size)
        || current.device != physical.device
        || current.inode != physical.inode
    {
        return Err(
            "Experimental Memory database drifted after the prepared recovery record; operator review is required"
                .to_string(),
        );
    }
    let record = append_record(
        &mut connection,
        &key,
        &external_anchor_path(&root),
        NewRecord {
            operation_id: &input.operation_id,
            operation_kind: "crash_recovery_drill",
            phase: "recovered_no_effect",
            idempotency_key: &input.idempotency_key,
            input_payload_sha256: &input_hash,
            memory: &current,
            snapshot_relative_path: &prepared.snapshot_relative_path,
            snapshot_sha256: &prepared.snapshot_sha256,
            incident_reason_sha256: None,
        },
    )?;
    Ok(receipt(&record, false))
}

#[tauri::command]
pub(crate) fn reconcile_experimental_memory_recovery_drill(
    input: ReconcileMemoryRecoveryDrillInput,
) -> Result<MemoryRecoveryReceipt, String> {
    reconcile_at(&isolated_root()?, input)
}

fn quarantine_contract_at(
    root: &Path,
    input: RecordMemoryQuarantineContractInput,
) -> Result<MemoryRecoveryReceipt, String> {
    validate_token("operationId", &input.operation_id)?;
    validate_token("idempotencyKey", &input.idempotency_key)?;
    validate_hash("expectedMemorySha256", &input.expected_memory_sha256)?;
    validate_hash("incidentReasonSha256", &input.incident_reason_sha256)?;
    let input_hash = stable_input_sha256(&input)?;
    let root = normalize_platform_root_alias(root.to_path_buf());
    let _lease = acquire_host_wide_memory_lease(&root)?;
    let key = read_signing_key(&key_path(&root))?;
    let mut connection = open_read_write(&control_path(&root))?;
    verify_journal(&connection, &key, &external_anchor_path(&root))?;
    if let Some(existing) = find_phase_record(
        &connection,
        "quarantine_required",
        &input.operation_id,
        &input.idempotency_key,
    )? {
        return validate_duplicate(
            existing,
            &input.operation_id,
            &input.idempotency_key,
            &input_hash,
        );
    }
    ensure_no_conflicting_operation(&connection, &input.operation_id, &input.idempotency_key)?;
    let database = memory_path(&root);
    validate_sqlite_sidecars(&database)?;
    let before = capture_memory_file(&database, None)?;
    if before.sha256 != input.expected_memory_sha256 {
        return Err(
            "Experimental Memory database hash does not match the incident input".to_string(),
        );
    }
    let inspection = crate::experimental_foundation::inspect_memory_store_for_recovery(&database);
    if !inspection.initialized
        || inspection.ready
        || inspection.schema_version != Some(MEMORY_SCHEMA_VERSION)
        || inspection.blocked_reason.is_none()
    {
        return Err(
            "Memory quarantine contract applies only to a malformed current-schema database"
                .to_string(),
        );
    }
    let (captured, relative, snapshot_sha256) =
        capture_snapshot(&root, &input.operation_id, &database)?;
    validate_sqlite_sidecars(&database)?;
    let after = capture_memory_file(&database, None)?;
    if after != before || captured.device != before.device || captured.inode != before.inode {
        return Err("Experimental Memory database changed across incident inspection".to_string());
    }
    let record = append_record(
        &mut connection,
        &key,
        &external_anchor_path(&root),
        NewRecord {
            operation_id: &input.operation_id,
            operation_kind: "quarantine_required",
            phase: "quarantine_required",
            idempotency_key: &input.idempotency_key,
            input_payload_sha256: &input_hash,
            memory: &captured,
            snapshot_relative_path: &relative,
            snapshot_sha256: &snapshot_sha256,
            incident_reason_sha256: Some(&input.incident_reason_sha256),
        },
    )?;
    Ok(receipt(&record, false))
}

#[tauri::command]
pub(crate) fn record_experimental_memory_quarantine_contract(
    input: RecordMemoryQuarantineContractInput,
) -> Result<MemoryRecoveryReceipt, String> {
    quarantine_contract_at(&isolated_root()?, input)
}

pub(crate) fn verify_completed_recovery_binding_at(
    root: &Path,
    expected_record_sha256: &str,
    expected_memory_sha256: &str,
) -> Result<String, String> {
    validate_hash("recoveryRecordSha256", expected_record_sha256)?;
    validate_hash("expectedMemorySha256", expected_memory_sha256)?;
    let root = normalize_platform_root_alias(root.to_path_buf());
    let key = read_signing_key(&key_path(&root))?;
    let connection = open_read_only(&control_path(&root), "Memory recovery control database")?;
    crate::experimental_sqlite_attestation::attest_exact_schema(
        &connection,
        SCHEMA_SQL,
        "Memory recovery",
    )?;
    let records = verify_journal(&connection, &key, &external_anchor_path(&root))?;
    let completed = records
        .iter()
        .find(|record| {
            record.phase == "recovered_no_effect" && record.record_sha256 == expected_record_sha256
        })
        .ok_or("Completed Memory recovery record is missing")?;
    let pending = records.iter().any(|record| {
        record.phase == "prepared"
            && !records.iter().any(|candidate| {
                candidate.operation_id == record.operation_id
                    && candidate.phase == "recovered_no_effect"
            })
    });
    if pending {
        return Err("Memory recovery journal still has a pending drill".to_string());
    }
    let snapshot = root.join(&completed.snapshot_relative_path);
    validate_immutable_snapshot_file(&snapshot)?;
    let snapshot_state = capture_memory_file(&snapshot, None)?;
    if snapshot_state.sha256 != completed.snapshot_sha256
        || snapshot_state.sha256 != completed.memory_database_sha256
    {
        return Err("Completed Memory recovery snapshot binding drifted".to_string());
    }
    let database = memory_path(&root);
    validate_sqlite_sidecars(&database)?;
    let physical = capture_memory_file(&database, None)?;
    if physical.sha256 != expected_memory_sha256 {
        return Err("Current Memory database hash does not match the promotion input".to_string());
    }
    crate::experimental_foundation::validate_memory_store_for_recovery(&database)?;
    let consistent =
        capture_transient_memory_state(&root, "promotion-recovery-binding", &database)?;
    validate_sqlite_sidecars(&database)?;
    let physical_after = capture_memory_file(&database, None)?;
    if physical_after != physical
        || consistent.sha256 != completed.memory_database_sha256
        || consistent.device != completed.memory_device
        || consistent.inode != completed.memory_inode
        || consistent.device != physical.device
        || consistent.inode != physical.inode
    {
        return Err(
            "Current Memory database no longer matches its completed recovery drill".to_string(),
        );
    }
    Ok(completed.snapshot_relative_path.clone())
}

pub(crate) fn verify_completed_recovery_snapshot_at(
    root: &Path,
    expected_record_sha256: &str,
    candidate_path: &Path,
    expected_candidate_sha256: &str,
) -> Result<String, String> {
    validate_hash("recoveryRecordSha256", expected_record_sha256)?;
    validate_hash("expectedCandidateSha256", expected_candidate_sha256)?;
    let root = normalize_platform_root_alias(root.to_path_buf());
    let candidate = normalize_platform_root_alias(candidate_path.to_path_buf());
    if !candidate.is_absolute() {
        return Err("Memory recovery candidate must be an absolute path".to_string());
    }
    reject_symlink_components(&candidate)?;
    let key = read_signing_key(&key_path(&root))?;
    let connection = open_read_only(&control_path(&root), "Memory recovery control database")?;
    crate::experimental_sqlite_attestation::attest_exact_schema(
        &connection,
        SCHEMA_SQL,
        "Memory recovery",
    )?;
    let records = verify_journal(&connection, &key, &external_anchor_path(&root))?;
    let completed = records
        .iter()
        .find(|record| {
            record.phase == "recovered_no_effect" && record.record_sha256 == expected_record_sha256
        })
        .ok_or("Completed Memory recovery record is missing")?;
    let signed_snapshot = root.join(&completed.snapshot_relative_path);
    let signed_canonical = fs::canonicalize(&signed_snapshot)
        .map_err(|error| format!("Failed to resolve signed Memory recovery snapshot: {error}"))?;
    let candidate_canonical = fs::canonicalize(&candidate)
        .map_err(|error| format!("Failed to resolve Memory recovery candidate: {error}"))?;
    let snapshot_root_canonical = fs::canonicalize(snapshot_root(&root))
        .map_err(|error| format!("Failed to resolve Memory recovery snapshot root: {error}"))?;
    if candidate_canonical != signed_canonical
        || !candidate_canonical.starts_with(&snapshot_root_canonical)
    {
        return Err(
            "Memory recovery candidate is not the snapshot bound to its signed record".to_string(),
        );
    }
    validate_immutable_snapshot_file(&candidate_canonical)?;
    let snapshot = capture_memory_file(&candidate_canonical, None)?;
    if snapshot.sha256 != expected_candidate_sha256
        || snapshot.sha256 != completed.snapshot_sha256
        || snapshot.sha256 != completed.memory_database_sha256
    {
        return Err("Signed Memory recovery candidate binding drifted".to_string());
    }
    crate::experimental_foundation::validate_memory_store_for_recovery(&candidate_canonical)?;
    Ok(completed.snapshot_relative_path.clone())
}

pub(crate) fn exact_control_schema_attestation_at(
    root: &Path,
) -> Result<crate::experimental_sqlite_attestation::ExactSchemaAttestation, String> {
    let root = normalize_platform_root_alias(root.to_path_buf());
    let connection = open_read_only(&control_path(&root), "Memory recovery control database")?;
    crate::experimental_sqlite_attestation::attest_exact_schema(
        &connection,
        SCHEMA_SQL,
        "Memory recovery",
    )
}

fn inspect_journal_at(root: &Path) -> Result<MemoryRecoveryJournalInspection, String> {
    let root = normalize_platform_root_alias(root.to_path_buf());
    let _lease = acquire_host_wide_memory_lease(&root)?;
    let key = read_signing_key(&key_path(&root))?;
    let connection = open_read_only(&control_path(&root), "Memory recovery control database")?;
    let records = verify_journal(&connection, &key, &external_anchor_path(&root))?;
    let pending = records
        .iter()
        .filter(|record| {
            record.phase == "prepared"
                && !records.iter().any(|candidate| {
                    candidate.operation_id == record.operation_id
                        && candidate.phase == "recovered_no_effect"
                })
        })
        .count() as u64;
    Ok(MemoryRecoveryJournalInspection {
        schema_version: SCHEMA_VERSION,
        journal_record_count: records.len() as u64,
        pending_recovery_count: pending,
        last_record_sha256: records
            .last()
            .map(|record| record.record_sha256.clone())
            .unwrap_or_else(|| ZERO_HASH.to_string()),
        hmac_verified: true,
        chain_verified: true,
        external_effects: 0,
        production_memory_mutated: false,
        production_integration: false,
    })
}

#[tauri::command]
pub(crate) fn inspect_experimental_memory_recovery_journal(
) -> Result<MemoryRecoveryJournalInspection, String> {
    inspect_journal_at(&isolated_root()?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn create_healthy_memory_store(root: &Path) -> PathBuf {
        let path = memory_path(root);
        let connection = Connection::open(&path).unwrap();
        connection.execute_batch(MEMORY_SCHEMA_SQL).unwrap();
        let applied_at = Utc::now().to_rfc3339();
        connection
            .execute(
                "INSERT INTO schema_migration(component, version, applied_at, checksum) VALUES('memory', 1, ?1, 'blackbox-memory-foundation-v1')",
                [&applied_at],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO schema_migration(component, version, applied_at, checksum) VALUES('memory', 2, ?1, 'blackbox-memory-scope-v2')",
                [&applied_at],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO schema_migration(component, version, applied_at, checksum) VALUES('memory', 3, ?1, ?2)",
                params![applied_at, sha256_hex(MEMORY_SCHEMA_SQL.as_bytes())],
            )
            .unwrap();
        connection
            .pragma_update(None, "user_version", MEMORY_SCHEMA_VERSION)
            .unwrap();
        drop(connection);
        set_file_mode(&path, 0o600).unwrap();
        path
    }

    fn file_sha(path: &Path) -> String {
        capture_memory_file(path, None).unwrap().sha256
    }

    #[test]
    fn disabled_status_is_inert() {
        let temp = tempfile::tempdir().unwrap();
        let status = status_at(temp.path(), false);
        assert!(!status.enabled);
        assert!(!status.ready);
        assert!(!status.initialized);
        assert!(!status.production_integration);
        assert!(!status.production_memory_mutated);
        assert!(!control_path(temp.path()).exists());
        assert!(!key_path(temp.path()).exists());
        assert!(!external_anchor_path(temp.path()).exists());
    }

    #[cfg(unix)]
    #[test]
    fn host_wide_lease_excludes_a_second_writer_and_persists_its_inode() {
        let temp = tempfile::tempdir().unwrap();
        let first = acquire_host_wide_memory_lease(temp.path()).unwrap();
        let lease = lease_path(temp.path());
        let before = fs::metadata(&lease).unwrap();
        assert!(acquire_host_wide_memory_lease(temp.path())
            .unwrap_err()
            .contains("Another process"));
        drop(first);
        let second = acquire_host_wide_memory_lease(temp.path()).unwrap();
        let after = fs::metadata(&lease).unwrap();
        use std::os::unix::fs::MetadataExt;
        assert_eq!(before.dev(), after.dev());
        assert_eq!(before.ino(), after.ino());
        drop(second);
    }

    #[cfg(unix)]
    #[test]
    fn prepare_and_reconcile_are_signed_idempotent_and_no_effect() {
        let temp = tempfile::tempdir().unwrap();
        create_healthy_memory_store(temp.path());
        initialize_at(temp.path()).unwrap();
        let database = memory_path(temp.path());
        let before = fs::read(&database).unwrap();
        let prepare = PrepareMemoryRecoveryDrillInput {
            operation_id: "recovery-drill-1".to_string(),
            expected_memory_sha256: file_sha(&database),
            idempotency_key: "prepare-key-1".to_string(),
        };
        let first = prepare_at(temp.path(), prepare.clone()).unwrap();
        assert_eq!(first.phase, "prepared");
        assert!(!first.duplicate);
        assert!(first.rollback_snapshot_bound);
        assert_eq!(fs::read(&database).unwrap(), before);
        let duplicate = prepare_at(temp.path(), prepare).unwrap();
        assert!(duplicate.duplicate);
        assert_eq!(duplicate.record_sha256, first.record_sha256);

        let reconcile = ReconcileMemoryRecoveryDrillInput {
            operation_id: "recovery-drill-1".to_string(),
            expected_prepared_record_sha256: first.record_sha256.clone(),
            idempotency_key: "reconcile-key-1".to_string(),
        };
        let resolved = reconcile_at(temp.path(), reconcile.clone()).unwrap();
        assert_eq!(resolved.phase, "recovered_no_effect");
        assert!(!resolved.duplicate);
        assert_eq!(fs::read(&database).unwrap(), before);
        let resolved_duplicate = reconcile_at(temp.path(), reconcile).unwrap();
        assert!(resolved_duplicate.duplicate);
        assert_eq!(resolved_duplicate.record_sha256, resolved.record_sha256);

        let inspection = inspect_journal_at(temp.path()).unwrap();
        assert_eq!(inspection.journal_record_count, 2);
        assert_eq!(inspection.pending_recovery_count, 0);
        assert!(inspection.hmac_verified && inspection.chain_verified);
    }

    #[cfg(unix)]
    #[test]
    fn orphaned_immutable_snapshot_is_reconciled_before_journal_append() {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};

        let temp = tempfile::tempdir().unwrap();
        let database = create_healthy_memory_store(temp.path());
        initialize_at(temp.path()).unwrap();
        let (_, relative, snapshot_sha256) =
            capture_snapshot(temp.path(), "orphan-drill", &database).unwrap();
        let snapshot = temp.path().join(&relative);
        let metadata = fs::metadata(&snapshot).unwrap();
        assert_eq!(metadata.nlink(), 1);
        assert_eq!(metadata.permissions().mode() & 0o777, 0o400);

        let receipt = prepare_at(
            temp.path(),
            PrepareMemoryRecoveryDrillInput {
                operation_id: "orphan-drill".to_string(),
                expected_memory_sha256: file_sha(&database),
                idempotency_key: "orphan-prepare".to_string(),
            },
        )
        .unwrap();
        assert_eq!(receipt.snapshot_sha256, snapshot_sha256);
        assert_eq!(receipt.snapshot_relative_path, relative);
        assert_eq!(receipt.record_sequence, 1);
    }

    #[cfg(unix)]
    #[test]
    fn mutable_snapshot_permissions_fail_closed_on_reuse_and_reconcile() {
        use std::os::unix::fs::PermissionsExt;

        {
            let temp = tempfile::tempdir().unwrap();
            let database = create_healthy_memory_store(temp.path());
            initialize_at(temp.path()).unwrap();
            let (_, relative, _) =
                capture_snapshot(temp.path(), "mutable-reuse", &database).unwrap();
            let snapshot = temp.path().join(relative);
            fs::set_permissions(&snapshot, fs::Permissions::from_mode(0o600)).unwrap();

            let error = prepare_at(
                temp.path(),
                PrepareMemoryRecoveryDrillInput {
                    operation_id: "mutable-reuse".to_string(),
                    expected_memory_sha256: file_sha(&database),
                    idempotency_key: "mutable-reuse-key".to_string(),
                },
            )
            .unwrap_err();
            assert!(error.contains("mode 0400"));
        }

        {
            let temp = tempfile::tempdir().unwrap();
            let database = create_healthy_memory_store(temp.path());
            initialize_at(temp.path()).unwrap();
            let prepared = prepare_at(
                temp.path(),
                PrepareMemoryRecoveryDrillInput {
                    operation_id: "mutable-reconcile".to_string(),
                    expected_memory_sha256: file_sha(&database),
                    idempotency_key: "mutable-reconcile-prepare".to_string(),
                },
            )
            .unwrap();
            let snapshot = temp.path().join(&prepared.snapshot_relative_path);
            fs::set_permissions(&snapshot, fs::Permissions::from_mode(0o600)).unwrap();

            let error = reconcile_at(
                temp.path(),
                ReconcileMemoryRecoveryDrillInput {
                    operation_id: "mutable-reconcile".to_string(),
                    expected_prepared_record_sha256: prepared.record_sha256,
                    idempotency_key: "mutable-reconcile-finish".to_string(),
                },
            )
            .unwrap_err();
            assert!(error.contains("mode 0400"));
        }
    }

    #[cfg(unix)]
    #[test]
    fn malformed_current_schema_creates_evidence_only_quarantine_contract() {
        let temp = tempfile::tempdir().unwrap();
        let database = create_healthy_memory_store(temp.path());
        initialize_at(temp.path()).unwrap();
        let connection = Connection::open(&database).unwrap();
        connection
            .execute(
                "UPDATE schema_migration SET checksum = 'forged-current-marker' WHERE component = 'memory' AND version = 3",
                [],
            )
            .unwrap();
        drop(connection);
        let before = fs::read(&database).unwrap();
        let result = quarantine_contract_at(
            temp.path(),
            RecordMemoryQuarantineContractInput {
                operation_id: "incident-1".to_string(),
                expected_memory_sha256: file_sha(&database),
                incident_reason_sha256: "a".repeat(64),
                idempotency_key: "incident-key-1".to_string(),
            },
        )
        .unwrap();
        assert_eq!(result.phase, "quarantine_required");
        assert!(result.operator_action_required);
        assert!(!result.quarantine_performed);
        assert!(!result.production_memory_mutated);
        assert_eq!(fs::read(&database).unwrap(), before);
        assert_eq!(
            file_sha(&temp.path().join(&result.snapshot_relative_path)),
            result.snapshot_sha256
        );
    }

    #[cfg(unix)]
    #[test]
    fn journal_tampering_and_database_drift_fail_closed() {
        let temp = tempfile::tempdir().unwrap();
        let database = create_healthy_memory_store(temp.path());
        initialize_at(temp.path()).unwrap();
        let prepared = prepare_at(
            temp.path(),
            PrepareMemoryRecoveryDrillInput {
                operation_id: "drift-drill".to_string(),
                expected_memory_sha256: file_sha(&database),
                idempotency_key: "drift-prepare".to_string(),
            },
        )
        .unwrap();
        let connection = Connection::open(&database).unwrap();
        connection
            .execute(
                "INSERT INTO memory_policy(policy_id, tenant_id, scope_kind, scope_id, policy_json, version, active, created_at, updated_at) VALUES('drift-policy', 'local', 'user', 'drift', '{}', 1, 1, ?1, ?1)",
                [Utc::now().to_rfc3339()],
            )
            .unwrap();
        drop(connection);
        let error = reconcile_at(
            temp.path(),
            ReconcileMemoryRecoveryDrillInput {
                operation_id: "drift-drill".to_string(),
                expected_prepared_record_sha256: prepared.record_sha256,
                idempotency_key: "drift-reconcile".to_string(),
            },
        )
        .unwrap_err();
        assert!(error.contains("drifted"));

        let control = open_read_write(&control_path(temp.path())).unwrap();
        control
            .execute_batch("DROP TRIGGER memory_recovery_record_immutable;")
            .unwrap();
        control
            .execute(
                "UPDATE memory_recovery_record SET record_hmac_sha256 = ?1 WHERE sequence = 1",
                ["0".repeat(64)],
            )
            .unwrap();
        drop(control);
        assert!(inspect_journal_at(temp.path())
            .unwrap_err()
            .contains("HMAC mismatch"));
    }

    #[cfg(unix)]
    #[test]
    fn authenticated_anchor_detects_journal_truncation() {
        let temp = tempfile::tempdir().unwrap();
        let database = create_healthy_memory_store(temp.path());
        initialize_at(temp.path()).unwrap();
        let prepared = prepare_at(
            temp.path(),
            PrepareMemoryRecoveryDrillInput {
                operation_id: "truncation-drill".to_string(),
                expected_memory_sha256: file_sha(&database),
                idempotency_key: "truncation-prepare".to_string(),
            },
        )
        .unwrap();
        reconcile_at(
            temp.path(),
            ReconcileMemoryRecoveryDrillInput {
                operation_id: "truncation-drill".to_string(),
                expected_prepared_record_sha256: prepared.record_sha256,
                idempotency_key: "truncation-reconcile".to_string(),
            },
        )
        .unwrap();

        let control = open_read_write(&control_path(temp.path())).unwrap();
        control
            .execute_batch("DROP TRIGGER memory_recovery_record_no_delete;")
            .unwrap();
        control
            .execute("DELETE FROM memory_recovery_record WHERE sequence = 2", [])
            .unwrap();
        drop(control);
        assert!(inspect_journal_at(temp.path())
            .unwrap_err()
            .contains("truncation or rollback"));
    }

    #[cfg(unix)]
    #[test]
    fn external_anchor_detects_whole_control_database_rollback() {
        let temp = tempfile::tempdir().unwrap();
        let database = create_healthy_memory_store(temp.path());
        initialize_at(temp.path()).unwrap();
        let prepared = prepare_at(
            temp.path(),
            PrepareMemoryRecoveryDrillInput {
                operation_id: "database-rollback".to_string(),
                expected_memory_sha256: file_sha(&database),
                idempotency_key: "database-rollback-prepare".to_string(),
            },
        )
        .unwrap();
        let control = control_path(temp.path());
        let prior_control_database = fs::read(&control).unwrap();

        reconcile_at(
            temp.path(),
            ReconcileMemoryRecoveryDrillInput {
                operation_id: "database-rollback".to_string(),
                expected_prepared_record_sha256: prepared.record_sha256,
                idempotency_key: "database-rollback-finish".to_string(),
            },
        )
        .unwrap();
        assert_eq!(
            inspect_journal_at(temp.path())
                .unwrap()
                .journal_record_count,
            2
        );

        fs::write(&control, prior_control_database).unwrap();
        sync_file_and_parent(&control).unwrap();
        let error = inspect_journal_at(temp.path()).unwrap_err();
        assert!(error.contains("external journal anchor detected control-database rollback"));
    }

    #[cfg(unix)]
    #[test]
    fn sidecars_symlink_and_hardlink_are_rejected() {
        use std::os::unix::fs::symlink;
        let temp = tempfile::tempdir().unwrap();
        let database = create_healthy_memory_store(temp.path());
        initialize_at(temp.path()).unwrap();
        fs::write(format!("{}-wal", database.display()), b"pending").unwrap();
        assert!(prepare_at(
            temp.path(),
            PrepareMemoryRecoveryDrillInput {
                operation_id: "sidecar".to_string(),
                expected_memory_sha256: file_sha(&database),
                idempotency_key: "sidecar-key".to_string(),
            }
        )
        .unwrap_err()
        .contains("sidecar"));
        fs::remove_file(format!("{}-wal", database.display())).unwrap();

        let hardlink = temp.path().join("memory-hardlink.sqlite");
        fs::hard_link(&database, &hardlink).unwrap();
        assert!(capture_memory_file(&database, None)
            .unwrap_err()
            .contains("exactly one"));
        fs::remove_file(&hardlink).unwrap();

        let target = tempfile::tempdir().unwrap();
        let linked = target.path().join("linked-root");
        symlink(temp.path(), &linked).unwrap();
        assert!(validate_isolated_root(linked, target.path())
            .unwrap_err()
            .contains("symlink"));
    }
}

#[cfg(all(test, not(unix)))]
mod unsupported_platform_tests {
    use super::*;

    #[test]
    fn non_unix_platform_is_inert() {
        let temp = tempfile::tempdir().unwrap();
        assert!(!platform_supported());
        assert!(!feature_enabled());
        assert!(initialize_at(temp.path()).is_err());
        assert!(!control_path(temp.path()).exists());
        assert!(!key_path(temp.path()).exists());
    }
}
