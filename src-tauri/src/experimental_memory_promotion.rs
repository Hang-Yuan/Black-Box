//! Disabled-by-default Memory production-promotion control plane.
//!
//! R3AV performs bounded parity assessment and seals operator proposals inside
//! an explicitly isolated profile. It never enables dual reads, changes the
//! current Memory authority, restores a database, or mutates production data.

use chrono::Utc;
use hmac::{Hmac, Mac};
use rand::{rngs::OsRng, RngCore};
use rusqlite::{params, Connection, OpenFlags, TransactionBehavior};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::time::Duration;
use uuid::Uuid;

type HmacSha256 = Hmac<Sha256>;

const PROMOTION_FLAG: &str = "BLACKBOX_EXPERIMENTAL_MEMORY_PROMOTION_V1";
const HOME_OVERRIDE: &str = "BLACKBOX_EXPERIMENTAL_HOME";
const SCHEMA_VERSION: i64 = 1;
const MAX_EXTERNAL_ANCHOR_BYTES: u64 = 4 * 1024;
const MAX_FORENSIC_MANIFEST_BYTES: u64 = 64 * 1024;
const FORENSIC_MANIFEST_SCHEMA_VERSION: i64 = 1;
const SQLITE_SIDECAR_SUFFIXES: &[&str] = &["-wal", "-shm", "-journal"];
const ZERO_HASH: &str = "0000000000000000000000000000000000000000000000000000000000000000";
const SCHEMA_SQL: &str = include_str!("../resources/experimental/memory-promotion-v1.sql");

const TABLE_SHAPES: &[(&str, &[&str])] = &[
    (
        "memory_promotion_meta",
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
        "memory_promotion_record",
        &[
            "sequence",
            "operation_id",
            "operation_kind",
            "phase",
            "idempotency_key",
            "input_payload_sha256",
            "source_authority_sha256",
            "memory_database_sha256",
            "memory_device",
            "memory_inode",
            "memory_size",
            "evidence_relative_path",
            "evidence_sha256",
            "compared_entry_count",
            "mismatch_count",
            "dependency_record_sha256",
            "recovery_record_sha256",
            "incident_reason_sha256",
            "previous_record_sha256",
            "record_sha256",
            "record_hmac_sha256",
            "external_effects",
            "dual_read_enabled",
            "authority_switch_applied",
            "restore_performed",
            "production_memory_mutated",
            "created_at_ms",
        ],
    ),
];

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExperimentalMemoryPromotionStatus {
    enabled: bool,
    platform_supported: bool,
    initialized: bool,
    ready: bool,
    path: String,
    schema_version: Option<i64>,
    schema_sha256: String,
    journal_record_count: u64,
    parity_confirmed_count: u64,
    operator_proposal_count: u64,
    journal_hmac_verified: bool,
    raw_forensic_capture_enabled: bool,
    dual_read_enabled: bool,
    authority_switch_applied: bool,
    restore_performed: bool,
    production_memory_mutated: bool,
    production_integration: bool,
    blocked_reason: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AssessMemoryDualReadInput {
    pub(crate) operation_id: String,
    pub(crate) source_path: String,
    pub(crate) user_id: String,
    pub(crate) workspace_id: Option<String>,
    pub(crate) expected_source_sha256: String,
    pub(crate) expected_memory_sha256: String,
    pub(crate) idempotency_key: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PrepareMemoryAuthoritySwitchInput {
    pub(crate) operation_id: String,
    pub(crate) dual_read_record_sha256: String,
    pub(crate) recovery_record_sha256: String,
    pub(crate) expected_memory_sha256: String,
    pub(crate) idempotency_key: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CaptureRawForensicEvidenceInput {
    pub(crate) operation_id: String,
    pub(crate) expected_memory_sha256: String,
    pub(crate) incident_reason_sha256: String,
    pub(crate) idempotency_key: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PrepareManualRestoreProposalInput {
    pub(crate) operation_id: String,
    pub(crate) forensic_record_sha256: String,
    pub(crate) recovery_record_sha256: String,
    pub(crate) candidate_path: String,
    pub(crate) expected_candidate_sha256: String,
    pub(crate) idempotency_key: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MemoryPromotionReceipt {
    operation_id: String,
    operation_kind: String,
    pub(crate) phase: String,
    record_sequence: i64,
    pub(crate) record_sha256: String,
    record_hmac_sha256: String,
    source_authority_sha256: Option<String>,
    memory_database_sha256: String,
    evidence_relative_path: Option<String>,
    evidence_sha256: Option<String>,
    compared_entry_count: u64,
    mismatch_count: u64,
    promotion_eligible: bool,
    operator_action_required: bool,
    raw_forensic_evidence_sealed: bool,
    dual_read_enabled: bool,
    authority_switch_applied: bool,
    restore_performed: bool,
    production_memory_mutated: bool,
    external_effects: u8,
    duplicate: bool,
    production_integration: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MemoryPromotionJournalInspection {
    schema_version: i64,
    journal_record_count: u64,
    parity_confirmed_count: u64,
    parity_failed_count: u64,
    operator_proposal_count: u64,
    raw_forensic_evidence_count: u64,
    last_record_sha256: String,
    hmac_verified: bool,
    chain_verified: bool,
    external_effects: u8,
    dual_read_enabled: bool,
    authority_switch_applied: bool,
    restore_performed: bool,
    production_memory_mutated: bool,
    production_integration: bool,
}

#[derive(Clone, Debug)]
pub(crate) struct MemoryOperatorProposalBinding {
    pub(crate) proposal_record_sha256: String,
    pub(crate) operation_kind: String,
    pub(crate) memory_database_sha256: String,
    pub(crate) memory_device: String,
    pub(crate) memory_inode: String,
    pub(crate) memory_size: u64,
}

#[derive(Clone, Debug)]
struct StoreInspection {
    initialized: bool,
    ready: bool,
    schema_version: Option<i64>,
    journal_record_count: u64,
    parity_confirmed_count: u64,
    operator_proposal_count: u64,
    blocked_reason: Option<String>,
}

#[derive(Clone, Debug)]
struct StoredRecord {
    sequence: i64,
    operation_id: String,
    operation_kind: String,
    phase: String,
    idempotency_key: String,
    input_payload_sha256: String,
    source_authority_sha256: Option<String>,
    memory_database_sha256: String,
    memory_device: String,
    memory_inode: String,
    memory_size: i64,
    evidence_relative_path: Option<String>,
    evidence_sha256: Option<String>,
    compared_entry_count: i64,
    mismatch_count: i64,
    dependency_record_sha256: Option<String>,
    recovery_record_sha256: Option<String>,
    incident_reason_sha256: Option<String>,
    previous_record_sha256: String,
    record_sha256: String,
    record_hmac_sha256: String,
    external_effects: i64,
    dual_read_enabled: i64,
    authority_switch_applied: i64,
    restore_performed: i64,
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
    source_authority_sha256: Option<&'a str>,
    memory_database_sha256: &'a str,
    memory_device: &'a str,
    memory_inode: &'a str,
    memory_size: i64,
    evidence_relative_path: Option<&'a str>,
    evidence_sha256: Option<&'a str>,
    compared_entry_count: i64,
    mismatch_count: i64,
    dependency_record_sha256: Option<&'a str>,
    recovery_record_sha256: Option<&'a str>,
    incident_reason_sha256: Option<&'a str>,
    previous_record_sha256: &'a str,
    external_effects: i64,
    dual_read_enabled: i64,
    authority_switch_applied: i64,
    restore_performed: i64,
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

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ForensicEvidenceFile {
    source_suffix: String,
    relative_path: String,
    sha256: String,
    size: u64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ForensicEvidenceManifest {
    schema_version: i64,
    operation_id: String,
    database: ForensicEvidenceFile,
    sidecars: Vec<ForensicEvidenceFile>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct IncidentSidecarState {
    suffix: String,
    snapshot: crate::experimental_memory_recovery::MemoryFileSnapshot,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct IncidentSourceState {
    database: crate::experimental_memory_recovery::MemoryFileSnapshot,
    sidecars: Vec<IncidentSidecarState>,
}

struct NewRecord<'a> {
    operation_id: &'a str,
    operation_kind: &'a str,
    phase: &'a str,
    idempotency_key: &'a str,
    input_payload_sha256: &'a str,
    source_authority_sha256: Option<&'a str>,
    memory: &'a crate::experimental_memory_recovery::MemoryFileSnapshot,
    evidence_relative_path: Option<&'a str>,
    evidence_sha256: Option<&'a str>,
    compared_entry_count: u64,
    mismatch_count: u64,
    dependency_record_sha256: Option<&'a str>,
    recovery_record_sha256: Option<&'a str>,
    incident_reason_sha256: Option<&'a str>,
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

fn feature_enabled() -> bool {
    std::env::var(PROMOTION_FLAG)
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
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
    {
        return Err(format!("{name} has an invalid format"));
    }
    Ok(())
}

fn validate_hash(name: &str, value: &str) -> Result<(), String> {
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(format!("{name} must be a 64-character SHA-256"));
    }
    Ok(())
}

fn status_root() -> Result<PathBuf, String> {
    if let Some(value) = std::env::var_os(HOME_OVERRIDE) {
        let path = PathBuf::from(value);
        if !path.is_absolute() {
            return Err(format!("{HOME_OVERRIDE} must be an absolute path"));
        }
        return crate::experimental_memory_recovery::validate_isolated_root(
            path,
            &crate::safe_data_dir()?,
        );
    }
    Ok(crate::safe_data_dir()?.join("experimental-memory-promotion-v1-status-only"))
}

fn isolated_root() -> Result<PathBuf, String> {
    if !platform_supported() {
        return Err(
            "Experimental Memory promotion requires native Unix lease and link-count proof"
                .to_string(),
        );
    }
    if !feature_enabled() {
        return Err(format!(
            "Experimental Memory promotion is disabled; set {PROMOTION_FLAG}=1 only in an isolated profile"
        ));
    }
    let value = std::env::var_os(HOME_OVERRIDE)
        .ok_or_else(|| format!("{HOME_OVERRIDE} is required for every experimental mutation"))?;
    crate::experimental_memory_recovery::validate_isolated_root(
        PathBuf::from(value),
        &crate::safe_data_dir()?,
    )
}

fn control_path(root: &Path) -> PathBuf {
    root.join("memory-promotion-v1.sqlite")
}

fn key_path(root: &Path) -> PathBuf {
    root.join("memory-promotion-v1.key")
}

fn external_anchor_path(root: &Path) -> PathBuf {
    root.join("memory-promotion-v1.anchor.json")
}

fn evidence_root(root: &Path) -> PathBuf {
    root.join("memory-promotion-evidence")
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
    if path.exists() {
        let metadata = fs::symlink_metadata(path)
            .map_err(|error| format!("Failed to inspect {label}: {error}"))?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(format!("{label} must be a real directory"));
        }
    } else {
        fs::create_dir_all(path).map_err(|error| format!("Failed to create {label}: {error}"))?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("Failed to secure {label}: {error}"))?;
    }
    Ok(())
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
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(format!("Failed to inspect {label}: {error}")),
    };
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

fn validate_immutable_evidence(path: &Path, label: &str) -> Result<(), String> {
    if !regular_single_link_file(path, label)? {
        return Err(format!("{label} is missing"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(path)
            .map_err(|error| format!("Failed to inspect {label}: {error}"))?
            .permissions()
            .mode()
            & 0o777;
        if mode != 0o400 {
            return Err(format!("{label} must have mode 0400"));
        }
    }
    Ok(())
}

fn open_read_only(path: &Path, label: &str) -> Result<Connection, String> {
    let path =
        crate::experimental_memory_recovery::normalize_platform_root_alias(path.to_path_buf());
    let connection = Connection::open_with_flags(
        &path,
        OpenFlags::SQLITE_OPEN_READ_ONLY
            | OpenFlags::SQLITE_OPEN_NO_MUTEX
            | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )
    .map_err(|error| format!("Failed to inspect {label}: {error}"))?;
    connection
        .busy_timeout(Duration::from_secs(2))
        .map_err(|error| format!("Failed to configure {label}: {error}"))?;
    connection
        .pragma_update(None, "query_only", true)
        .map_err(|error| format!("Failed to make {label} read-only: {error}"))?;
    Ok(connection)
}

fn open_read_write(path: &Path) -> Result<Connection, String> {
    let path =
        crate::experimental_memory_recovery::normalize_platform_root_alias(path.to_path_buf());
    let connection = Connection::open_with_flags(
        &path,
        OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_NO_MUTEX
            | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )
    .map_err(|error| format!("Failed to open Memory promotion control database: {error}"))?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(|error| format!("Failed to configure Memory promotion writer: {error}"))?;
    connection
        .pragma_update(None, "foreign_keys", true)
        .map_err(|error| format!("Failed to enable Memory promotion foreign keys: {error}"))?;
    connection
        .pragma_update(None, "synchronous", "FULL")
        .map_err(|error| format!("Failed to enable durable Memory promotion writes: {error}"))?;
    Ok(connection)
}

fn sqlite_quick_check(connection: &Connection, label: &str) -> Result<(), String> {
    let result: String = connection
        .query_row("PRAGMA quick_check", [], |row| row.get(0))
        .map_err(|error| format!("{label} SQLite quick_check failed to run: {error}"))?;
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
        .map_err(|error| format!("Failed to inspect Memory promotion table {table}: {error}"))?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| format!("Failed to read Memory promotion table {table}: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Failed to decode Memory promotion table {table}: {error}"))?;
    Ok(columns)
}

fn create_signing_key(path: &Path) -> Result<Vec<u8>, String> {
    if regular_single_link_file(path, "Memory promotion signing key")? {
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
        .map_err(|error| format!("Failed to create Memory promotion signing key: {error}"))?;
    file.write_all(&key)
        .and_then(|_| file.sync_all())
        .map_err(|error| format!("Failed to persist Memory promotion signing key: {error}"))?;
    drop(file);
    set_file_mode(path, 0o600)?;
    sync_file_and_parent(path)?;
    Ok(key)
}

fn read_signing_key(path: &Path) -> Result<Vec<u8>, String> {
    if !regular_single_link_file(path, "Memory promotion signing key")? {
        return Err("Memory promotion signing key is missing".to_string());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(path)
            .map_err(|error| format!("Failed to inspect Memory promotion signing key: {error}"))?
            .permissions()
            .mode()
            & 0o777;
        if mode != 0o600 {
            return Err("Memory promotion signing key must have mode 0600".to_string());
        }
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let mut key = Vec::new();
    options
        .open(path)
        .and_then(|mut file| (&mut file).take(33).read_to_end(&mut key))
        .map_err(|error| format!("Failed to read Memory promotion signing key: {error}"))?;
    if key.len() != 32 {
        return Err("Memory promotion signing key must be exactly 32 bytes".to_string());
    }
    Ok(key)
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
    .map_err(|error| format!("Failed to canonicalize Memory promotion anchor: {error}"))?;
    let mut mac = HmacSha256::new_from_slice(key)
        .map_err(|_| "Failed to initialize Memory promotion anchor HMAC".to_string())?;
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
    validate_immutable_evidence(path, "Memory promotion external journal anchor")?;
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = options.open(path).map_err(|error| {
        format!("Failed to open Memory promotion external journal anchor: {error}")
    })?;
    let before = file.metadata().map_err(|error| {
        format!("Failed to inspect Memory promotion external journal anchor: {error}")
    })?;
    if !before.is_file() || before.len() > MAX_EXTERNAL_ANCHOR_BYTES {
        return Err("Memory promotion external journal anchor is not bounded".to_string());
    }
    let mut bytes = Vec::with_capacity(before.len() as usize);
    (&mut file)
        .take(MAX_EXTERNAL_ANCHOR_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| {
            format!("Failed to read Memory promotion external journal anchor: {error}")
        })?;
    if bytes.len() as u64 > MAX_EXTERNAL_ANCHOR_BYTES {
        return Err("Memory promotion external journal anchor exceeds its size limit".to_string());
    }
    let after = file.metadata().map_err(|error| {
        format!("Failed to re-inspect Memory promotion external journal anchor: {error}")
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
                "Memory promotion external journal anchor changed during inspection".to_string(),
            );
        }
    }
    let anchor: ExternalJournalAnchor = serde_json::from_slice(&bytes).map_err(|error| {
        format!("Memory promotion external journal anchor is malformed: {error}")
    })?;
    if anchor.schema_version != SCHEMA_VERSION
        || anchor.schema_sha256 != sha256_hex(SCHEMA_SQL.as_bytes())
        || anchor.signing_key_id_sha256 != sha256_hex(key)
        || anchor.journal_head_sequence < 0
    {
        return Err("Memory promotion external journal anchor identity mismatch".to_string());
    }
    validate_hash("journalHeadSha256", &anchor.journal_head_sha256)?;
    let expected = journal_anchor_hmac(
        key,
        anchor.journal_head_sequence,
        &anchor.journal_head_sha256,
        anchor.created_at_ms,
    )?;
    if anchor.journal_anchor_hmac_sha256 != expected {
        return Err("Memory promotion external journal anchor HMAC mismatch".to_string());
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
        .map_err(|error| format!("Failed to serialize Memory promotion anchor: {error}"))?;
    bytes.push(b'\n');
    if bytes.len() as u64 > MAX_EXTERNAL_ANCHOR_BYTES {
        return Err("Memory promotion external journal anchor exceeds its size limit".to_string());
    }
    if regular_single_link_file(path, "Memory promotion external journal anchor")? {
        let _ = read_external_anchor(path, key)?;
    }
    let parent = path
        .parent()
        .ok_or("Memory promotion external journal anchor has no parent")?;
    let staging = parent.join(format!(
        ".memory-promotion-v1.{}.anchor.tmp",
        Uuid::new_v4()
    ));
    let result = (|| -> Result<(), String> {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        }
        let mut file = options
            .open(&staging)
            .map_err(|error| format!("Failed to stage Memory promotion anchor: {error}"))?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|error| format!("Failed to persist Memory promotion anchor: {error}"))?;
        drop(file);
        set_file_mode(&staging, 0o400)?;
        fs::rename(&staging, path)
            .map_err(|error| format!("Failed to publish Memory promotion anchor: {error}"))?;
        sync_file_and_parent(path)?;
        if read_external_anchor(path, key)? != anchor {
            return Err("Published Memory promotion anchor drifted".to_string());
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&staging);
    }
    result
}

fn create_control_store(path: &Path, key: &[u8]) -> Result<(), String> {
    if regular_single_link_file(path, "Memory promotion control database")? {
        let inspection = inspect_control_store(path, key)?;
        return if inspection.ready {
            Ok(())
        } else {
            Err(inspection
                .blocked_reason
                .unwrap_or_else(|| "Memory promotion control database is not ready".to_string()))
        };
    }
    let root = path
        .parent()
        .ok_or("Memory promotion control database has no parent")?;
    let anchor = external_anchor_path(root);
    if regular_single_link_file(&anchor, "Memory promotion external journal anchor")? {
        return Err("Memory promotion anchor exists without its control database".to_string());
    }
    let staging = root.join(format!(".memory-promotion-v1.{}.sqlite", Uuid::new_v4()));
    let mut published = false;
    let result = (|| -> Result<(), String> {
        let connection = Connection::open_with_flags(
            &staging,
            OpenFlags::SQLITE_OPEN_READ_WRITE
                | OpenFlags::SQLITE_OPEN_CREATE
                | OpenFlags::SQLITE_OPEN_NO_MUTEX
                | OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )
        .map_err(|error| format!("Failed to stage Memory promotion database: {error}"))?;
        connection
            .execute_batch(SCHEMA_SQL)
            .map_err(|error| format!("Failed to apply Memory promotion schema: {error}"))?;
        let created_at_ms = now_ms();
        let anchor_hmac = journal_anchor_hmac(key, 0, ZERO_HASH, created_at_ms)?;
        connection
            .execute(
                "INSERT INTO memory_promotion_meta(id, schema_version, schema_sha256, signing_key_id_sha256, journal_head_sequence, journal_head_sha256, journal_anchor_hmac_sha256, created_at_ms) VALUES(1, 1, ?1, ?2, 0, ?3, ?4, ?5)",
                params![
                    sha256_hex(SCHEMA_SQL.as_bytes()),
                    sha256_hex(key),
                    ZERO_HASH,
                    anchor_hmac,
                    created_at_ms,
                ],
            )
            .map_err(|error| format!("Failed to bind Memory promotion schema: {error}"))?;
        sqlite_quick_check(&connection, "Memory promotion")?;
        drop(connection);
        set_file_mode(&staging, 0o600)?;
        sync_file_and_parent(&staging)?;
        if regular_single_link_file(path, "Memory promotion control database")? {
            return Err("Memory promotion database appeared during initialization".to_string());
        }
        fs::hard_link(&staging, path)
            .map_err(|error| format!("Failed to publish Memory promotion database: {error}"))?;
        published = true;
        fs::remove_file(&staging)
            .map_err(|error| format!("Failed to settle Memory promotion database: {error}"))?;
        sync_file_and_parent(path)?;
        write_external_anchor(&anchor, key, 0, ZERO_HASH, created_at_ms)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&staging);
        if published {
            let _ = fs::remove_file(path);
            let _ = fs::remove_file(&anchor);
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
        source_authority_sha256: record.source_authority_sha256.as_deref(),
        memory_database_sha256: &record.memory_database_sha256,
        memory_device: &record.memory_device,
        memory_inode: &record.memory_inode,
        memory_size: record.memory_size,
        evidence_relative_path: record.evidence_relative_path.as_deref(),
        evidence_sha256: record.evidence_sha256.as_deref(),
        compared_entry_count: record.compared_entry_count,
        mismatch_count: record.mismatch_count,
        dependency_record_sha256: record.dependency_record_sha256.as_deref(),
        recovery_record_sha256: record.recovery_record_sha256.as_deref(),
        incident_reason_sha256: record.incident_reason_sha256.as_deref(),
        previous_record_sha256: &record.previous_record_sha256,
        external_effects: record.external_effects,
        dual_read_enabled: record.dual_read_enabled,
        authority_switch_applied: record.authority_switch_applied,
        restore_performed: record.restore_performed,
        production_memory_mutated: record.production_memory_mutated,
        created_at_ms: record.created_at_ms,
    })
    .map_err(|error| format!("Failed to canonicalize Memory promotion record: {error}"))
}

fn sign_record(record: &mut StoredRecord, key: &[u8]) -> Result<(), String> {
    let canonical = canonical_bytes(record)?;
    record.record_sha256 = sha256_hex(&canonical);
    let mut mac = HmacSha256::new_from_slice(key)
        .map_err(|_| "Failed to initialize Memory promotion HMAC".to_string())?;
    mac.update(&canonical);
    record.record_hmac_sha256 = format!("{:x}", mac.finalize().into_bytes());
    Ok(())
}

fn verify_record(record: &StoredRecord, key: &[u8]) -> Result<(), String> {
    let canonical = canonical_bytes(record)?;
    if sha256_hex(&canonical) != record.record_sha256 {
        return Err(format!(
            "Memory promotion record {} hash mismatch",
            record.sequence
        ));
    }
    let expected = decode_hex(&record.record_hmac_sha256)?;
    let mut mac = HmacSha256::new_from_slice(key)
        .map_err(|_| "Failed to initialize Memory promotion HMAC".to_string())?;
    mac.update(&canonical);
    mac.verify_slice(&expected)
        .map_err(|_| format!("Memory promotion record {} HMAC mismatch", record.sequence))
}

fn decode_hex(value: &str) -> Result<Vec<u8>, String> {
    if value.len() % 2 != 0 {
        return Err("Invalid Memory promotion HMAC encoding".to_string());
    }
    (0..value.len())
        .step_by(2)
        .map(|index| {
            u8::from_str_radix(&value[index..index + 2], 16)
                .map_err(|_| "Invalid Memory promotion HMAC encoding".to_string())
        })
        .collect()
}

fn decode_record(row: &rusqlite::Row<'_>) -> rusqlite::Result<StoredRecord> {
    Ok(StoredRecord {
        sequence: row.get(0)?,
        operation_id: row.get(1)?,
        operation_kind: row.get(2)?,
        phase: row.get(3)?,
        idempotency_key: row.get(4)?,
        input_payload_sha256: row.get(5)?,
        source_authority_sha256: row.get(6)?,
        memory_database_sha256: row.get(7)?,
        memory_device: row.get(8)?,
        memory_inode: row.get(9)?,
        memory_size: row.get(10)?,
        evidence_relative_path: row.get(11)?,
        evidence_sha256: row.get(12)?,
        compared_entry_count: row.get(13)?,
        mismatch_count: row.get(14)?,
        dependency_record_sha256: row.get(15)?,
        recovery_record_sha256: row.get(16)?,
        incident_reason_sha256: row.get(17)?,
        previous_record_sha256: row.get(18)?,
        record_sha256: row.get(19)?,
        record_hmac_sha256: row.get(20)?,
        external_effects: row.get(21)?,
        dual_read_enabled: row.get(22)?,
        authority_switch_applied: row.get(23)?,
        restore_performed: row.get(24)?,
        production_memory_mutated: row.get(25)?,
        created_at_ms: row.get(26)?,
    })
}

const RECORD_SELECT: &str = "SELECT sequence, operation_id, operation_kind, phase, idempotency_key, input_payload_sha256, source_authority_sha256, memory_database_sha256, memory_device, memory_inode, memory_size, evidence_relative_path, evidence_sha256, compared_entry_count, mismatch_count, dependency_record_sha256, recovery_record_sha256, incident_reason_sha256, previous_record_sha256, record_sha256, record_hmac_sha256, external_effects, dual_read_enabled, authority_switch_applied, restore_performed, production_memory_mutated, created_at_ms FROM memory_promotion_record";

fn read_all_records(connection: &Connection) -> Result<Vec<StoredRecord>, String> {
    connection
        .prepare(&format!("{RECORD_SELECT} ORDER BY sequence"))
        .map_err(|error| format!("Failed to inspect Memory promotion journal: {error}"))?
        .query_map([], decode_record)
        .map_err(|error| format!("Failed to read Memory promotion journal: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Failed to decode Memory promotion journal: {error}"))
}

fn verify_journal(
    connection: &Connection,
    key: &[u8],
    external_path: &Path,
) -> Result<Vec<StoredRecord>, String> {
    let (schema_version, schema_sha256, key_id, head_sequence, head_sha256, anchor_hmac, created_at_ms): (
        i64,
        String,
        String,
        i64,
        String,
        String,
        i64,
    ) = connection
        .query_row(
            "SELECT schema_version, schema_sha256, signing_key_id_sha256, journal_head_sequence, journal_head_sha256, journal_anchor_hmac_sha256, created_at_ms FROM memory_promotion_meta WHERE id = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?)),
        )
        .map_err(|error| format!("Memory promotion journal anchor is missing: {error}"))?;
    if schema_version != SCHEMA_VERSION
        || schema_sha256 != sha256_hex(SCHEMA_SQL.as_bytes())
        || key_id != sha256_hex(key)
    {
        return Err("Memory promotion schema or signing-key identity mismatch".to_string());
    }
    let expected_anchor_hmac =
        journal_anchor_hmac(key, head_sequence, &head_sha256, created_at_ms)?;
    if anchor_hmac != expected_anchor_hmac {
        return Err("Memory promotion journal anchor HMAC mismatch".to_string());
    }
    let external = read_external_anchor(external_path, key)?;
    if external.journal_head_sequence != head_sequence
        || external.journal_head_sha256 != head_sha256
        || external.created_at_ms != created_at_ms
        || external.journal_anchor_hmac_sha256 != anchor_hmac
    {
        return Err(
            "Memory promotion external anchor detected control-database rollback".to_string(),
        );
    }
    let records = read_all_records(connection)?;
    let mut previous = ZERO_HASH.to_string();
    for (index, record) in records.iter().enumerate() {
        if record.sequence != index as i64 + 1 {
            return Err("Memory promotion journal sequence is not contiguous".to_string());
        }
        if record.previous_record_sha256 != previous {
            return Err(format!(
                "Memory promotion record {} chain mismatch",
                record.sequence
            ));
        }
        if record.external_effects != 0
            || record.dual_read_enabled != 0
            || record.authority_switch_applied != 0
            || record.restore_performed != 0
            || record.production_memory_mutated != 0
        {
            return Err("Memory promotion journal contains a forbidden effect".to_string());
        }
        verify_record(record, key)?;
        previous = record.record_sha256.clone();
    }
    let observed_head_sequence = records.last().map(|record| record.sequence).unwrap_or(0);
    if head_sequence != observed_head_sequence || head_sha256 != previous {
        return Err("Memory promotion journal truncation or rollback detected".to_string());
    }
    crate::experimental_sqlite_attestation::attest_exact_schema(
        connection,
        SCHEMA_SQL,
        "Memory promotion",
    )?;
    Ok(records)
}

fn inspect_control_store(path: &Path, key: &[u8]) -> Result<StoreInspection, String> {
    if !regular_single_link_file(path, "Memory promotion control database")? {
        return Ok(StoreInspection {
            initialized: false,
            ready: false,
            schema_version: None,
            journal_record_count: 0,
            parity_confirmed_count: 0,
            operator_proposal_count: 0,
            blocked_reason: None,
        });
    }
    let result = (|| -> Result<(u64, u64, u64), String> {
        let connection = open_read_only(path, "Memory promotion control database")?;
        sqlite_quick_check(&connection, "Memory promotion")?;
        crate::experimental_sqlite_attestation::attest_exact_schema(
            &connection,
            SCHEMA_SQL,
            "Memory promotion",
        )?;
        for (table, expected) in TABLE_SHAPES {
            let actual = table_columns(&connection, table)?;
            let expected: Vec<String> = expected.iter().map(|value| (*value).to_string()).collect();
            if actual != expected {
                return Err(format!("Memory promotion table shape mismatch: {table}"));
            }
        }
        for trigger in [
            "memory_promotion_record_immutable",
            "memory_promotion_record_no_delete",
        ] {
            let exists: i64 = connection
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger' AND name = ?1",
                    [trigger],
                    |row| row.get(0),
                )
                .map_err(|error| format!("Failed to inspect Memory promotion trigger: {error}"))?;
            if exists != 1 {
                return Err(format!(
                    "Memory promotion schema is missing trigger {trigger}"
                ));
            }
        }
        let root = path
            .parent()
            .ok_or("Memory promotion control database has no parent")?;
        let records = verify_journal(&connection, key, &external_anchor_path(root))?;
        let parity = records
            .iter()
            .filter(|record| record.phase == "parity_confirmed")
            .count() as u64;
        let proposals = records
            .iter()
            .filter(|record| record.phase == "awaiting_operator")
            .count() as u64;
        Ok((records.len() as u64, parity, proposals))
    })();
    match result {
        Ok((count, parity, proposals)) => Ok(StoreInspection {
            initialized: true,
            ready: true,
            schema_version: Some(SCHEMA_VERSION),
            journal_record_count: count,
            parity_confirmed_count: parity,
            operator_proposal_count: proposals,
            blocked_reason: None,
        }),
        Err(error) => Ok(StoreInspection {
            initialized: true,
            ready: false,
            schema_version: None,
            journal_record_count: 0,
            parity_confirmed_count: 0,
            operator_proposal_count: 0,
            blocked_reason: Some(error),
        }),
    }
}

fn status_at(root: &Path, enabled: bool) -> ExperimentalMemoryPromotionStatus {
    let path = control_path(root);
    let key = key_path(root);
    let inspection =
        if regular_single_link_file(&key, "Memory promotion signing key").unwrap_or(false) {
            read_signing_key(&key)
                .and_then(|key| inspect_control_store(&path, &key))
                .unwrap_or_else(|error| StoreInspection {
                    initialized: path.exists(),
                    ready: false,
                    schema_version: None,
                    journal_record_count: 0,
                    parity_confirmed_count: 0,
                    operator_proposal_count: 0,
                    blocked_reason: Some(error),
                })
        } else {
            StoreInspection {
                initialized: path.exists(),
                ready: false,
                schema_version: None,
                journal_record_count: 0,
                parity_confirmed_count: 0,
                operator_proposal_count: 0,
                blocked_reason: if path.exists() {
                    Some("Memory promotion database exists without its signing key".to_string())
                } else {
                    None
                },
            }
        };
    ExperimentalMemoryPromotionStatus {
        enabled,
        platform_supported: platform_supported(),
        initialized: inspection.initialized,
        ready: enabled && inspection.ready,
        path: path.display().to_string(),
        schema_version: inspection.schema_version,
        schema_sha256: sha256_hex(SCHEMA_SQL.as_bytes()),
        journal_record_count: inspection.journal_record_count,
        parity_confirmed_count: inspection.parity_confirmed_count,
        operator_proposal_count: inspection.operator_proposal_count,
        journal_hmac_verified: inspection.ready,
        raw_forensic_capture_enabled: enabled && platform_supported(),
        dual_read_enabled: false,
        authority_switch_applied: false,
        restore_performed: false,
        production_memory_mutated: false,
        production_integration: false,
        blocked_reason: inspection.blocked_reason,
    }
}

#[tauri::command]
pub(crate) fn get_experimental_memory_promotion_status(
) -> Result<ExperimentalMemoryPromotionStatus, String> {
    let root = status_root()?;
    Ok(status_at(&root, feature_enabled()))
}

pub(crate) fn initialize_at(root: &Path) -> Result<ExperimentalMemoryPromotionStatus, String> {
    let root =
        crate::experimental_memory_recovery::normalize_platform_root_alias(root.to_path_buf());
    let _lease = crate::experimental_memory_recovery::acquire_host_wide_memory_lease(&root)?;
    ensure_private_directory(&root, "Memory promotion root")?;
    let control = control_path(&root);
    let key_path = key_path(&root);
    if regular_single_link_file(&control, "Memory promotion control database")?
        && !regular_single_link_file(&key_path, "Memory promotion signing key")?
    {
        return Err(
            "Memory promotion control database exists without its signing key; refusing key rotation"
                .to_string(),
        );
    }
    let key = create_signing_key(&key_path)?;
    create_control_store(&control, &key)?;
    Ok(status_at(&root, true))
}

#[tauri::command]
pub(crate) fn initialize_experimental_memory_promotion(
) -> Result<ExperimentalMemoryPromotionStatus, String> {
    initialize_at(&isolated_root()?)
}

fn stable_input_sha256<T: Serialize>(input: &T) -> Result<String, String> {
    serde_json::to_vec(input)
        .map(|bytes| sha256_hex(&bytes))
        .map_err(|error| format!("Failed to canonicalize Memory promotion input: {error}"))
}

fn find_identity_record(
    records: &[StoredRecord],
    operation_id: &str,
    idempotency_key: &str,
) -> Result<Option<StoredRecord>, String> {
    let matches: Vec<&StoredRecord> = records
        .iter()
        .filter(|record| {
            record.operation_id == operation_id || record.idempotency_key == idempotency_key
        })
        .collect();
    if matches.is_empty() {
        return Ok(None);
    }
    if matches.len() == 1
        && matches[0].operation_id == operation_id
        && matches[0].idempotency_key == idempotency_key
    {
        return Ok(Some(matches[0].clone()));
    }
    Err("Memory promotion operation identity conflict".to_string())
}

fn validate_duplicate(
    record: StoredRecord,
    input_hash: &str,
) -> Result<MemoryPromotionReceipt, String> {
    if record.input_payload_sha256 != input_hash {
        return Err("Memory promotion idempotency payload conflict".to_string());
    }
    Ok(receipt(&record, true))
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
        .map_err(|error| format!("Failed to lock Memory promotion journal: {error}"))?;
    let (sequence, previous): (i64, String) = transaction
        .query_row(
            "SELECT COALESCE(MAX(sequence), 0) + 1, COALESCE((SELECT record_sha256 FROM memory_promotion_record ORDER BY sequence DESC LIMIT 1), ?1) FROM memory_promotion_record",
            [ZERO_HASH],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|error| format!("Failed to advance Memory promotion journal: {error}"))?;
    let mut record = StoredRecord {
        sequence,
        operation_id: new.operation_id.to_string(),
        operation_kind: new.operation_kind.to_string(),
        phase: new.phase.to_string(),
        idempotency_key: new.idempotency_key.to_string(),
        input_payload_sha256: new.input_payload_sha256.to_string(),
        source_authority_sha256: new.source_authority_sha256.map(str::to_string),
        memory_database_sha256: new.memory.sha256.clone(),
        memory_device: new.memory.device.clone(),
        memory_inode: new.memory.inode.clone(),
        memory_size: i64::try_from(new.memory.size)
            .map_err(|_| "Memory promotion source size exceeds SQLite range")?,
        evidence_relative_path: new.evidence_relative_path.map(str::to_string),
        evidence_sha256: new.evidence_sha256.map(str::to_string),
        compared_entry_count: i64::try_from(new.compared_entry_count)
            .map_err(|_| "Memory promotion comparison count exceeds SQLite range")?,
        mismatch_count: i64::try_from(new.mismatch_count)
            .map_err(|_| "Memory promotion mismatch count exceeds SQLite range")?,
        dependency_record_sha256: new.dependency_record_sha256.map(str::to_string),
        recovery_record_sha256: new.recovery_record_sha256.map(str::to_string),
        incident_reason_sha256: new.incident_reason_sha256.map(str::to_string),
        previous_record_sha256: previous,
        record_sha256: String::new(),
        record_hmac_sha256: String::new(),
        external_effects: 0,
        dual_read_enabled: 0,
        authority_switch_applied: 0,
        restore_performed: 0,
        production_memory_mutated: 0,
        created_at_ms: now_ms(),
    };
    sign_record(&mut record, key)?;
    let created_at_ms: i64 = transaction
        .query_row(
            "SELECT created_at_ms FROM memory_promotion_meta WHERE id = 1",
            [],
            |row| row.get(0),
        )
        .map_err(|error| format!("Failed to read Memory promotion metadata: {error}"))?;
    let anchor_hmac =
        journal_anchor_hmac(key, record.sequence, &record.record_sha256, created_at_ms)?;
    transaction
        .execute(
            "INSERT INTO memory_promotion_record(sequence, operation_id, operation_kind, phase, idempotency_key, input_payload_sha256, source_authority_sha256, memory_database_sha256, memory_device, memory_inode, memory_size, evidence_relative_path, evidence_sha256, compared_entry_count, mismatch_count, dependency_record_sha256, recovery_record_sha256, incident_reason_sha256, previous_record_sha256, record_sha256, record_hmac_sha256, external_effects, dual_read_enabled, authority_switch_applied, restore_performed, production_memory_mutated, created_at_ms) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, 0, 0, 0, 0, 0, ?22)",
            params![
                record.sequence,
                record.operation_id,
                record.operation_kind,
                record.phase,
                record.idempotency_key,
                record.input_payload_sha256,
                record.source_authority_sha256,
                record.memory_database_sha256,
                record.memory_device,
                record.memory_inode,
                record.memory_size,
                record.evidence_relative_path,
                record.evidence_sha256,
                record.compared_entry_count,
                record.mismatch_count,
                record.dependency_record_sha256,
                record.recovery_record_sha256,
                record.incident_reason_sha256,
                record.previous_record_sha256,
                record.record_sha256,
                record.record_hmac_sha256,
                record.created_at_ms,
            ],
        )
        .map_err(|error| format!("Failed to append Memory promotion journal: {error}"))?;
    let updates = transaction
        .execute(
            "UPDATE memory_promotion_meta SET journal_head_sequence = ?1, journal_head_sha256 = ?2, journal_anchor_hmac_sha256 = ?3 WHERE id = 1",
            params![record.sequence, record.record_sha256, anchor_hmac],
        )
        .map_err(|error| format!("Failed to advance Memory promotion anchor: {error}"))?;
    if updates != 1 {
        return Err("Memory promotion anchor update affected an unexpected row count".to_string());
    }
    transaction
        .commit()
        .map_err(|error| format!("Failed to commit Memory promotion journal: {error}"))?;
    write_external_anchor(
        external_path,
        key,
        record.sequence,
        &record.record_sha256,
        created_at_ms,
    )?;
    verify_record(&record, key)?;
    Ok(record)
}

fn receipt(record: &StoredRecord, duplicate: bool) -> MemoryPromotionReceipt {
    MemoryPromotionReceipt {
        operation_id: record.operation_id.clone(),
        operation_kind: record.operation_kind.clone(),
        phase: record.phase.clone(),
        record_sequence: record.sequence,
        record_sha256: record.record_sha256.clone(),
        record_hmac_sha256: record.record_hmac_sha256.clone(),
        source_authority_sha256: record.source_authority_sha256.clone(),
        memory_database_sha256: record.memory_database_sha256.clone(),
        evidence_relative_path: record.evidence_relative_path.clone(),
        evidence_sha256: record.evidence_sha256.clone(),
        compared_entry_count: record.compared_entry_count.max(0) as u64,
        mismatch_count: record.mismatch_count.max(0) as u64,
        promotion_eligible: record.phase == "parity_confirmed"
            || record.operation_kind == "authority_switch_proposal",
        operator_action_required: record.phase == "awaiting_operator"
            || record.phase == "raw_evidence_sealed",
        raw_forensic_evidence_sealed: record.phase == "raw_evidence_sealed",
        dual_read_enabled: false,
        authority_switch_applied: false,
        restore_performed: false,
        production_memory_mutated: false,
        external_effects: 0,
        duplicate,
        production_integration: false,
    }
}

fn validate_isolated_legacy_source(root: &Path, source: &Path) -> Result<PathBuf, String> {
    let source =
        crate::experimental_memory_recovery::normalize_platform_root_alias(source.to_path_buf());
    if !source.is_absolute() {
        return Err("Legacy dual-read source must be an absolute path".to_string());
    }
    if source.extension().and_then(|value| value.to_str()) != Some("md") {
        return Err("Legacy dual-read source must be a Markdown file".to_string());
    }
    reject_symlink_components(&source)?;
    if !regular_single_link_file(&source, "Legacy dual-read source")? {
        return Err("Legacy dual-read source is missing".to_string());
    }
    let root_canonical = fs::canonicalize(root)
        .map_err(|error| format!("Failed to resolve Memory promotion root: {error}"))?;
    let source_canonical = fs::canonicalize(&source)
        .map_err(|error| format!("Failed to resolve legacy dual-read source: {error}"))?;
    if !source_canonical.starts_with(&root_canonical) {
        return Err("Legacy dual-read source must stay inside the isolated profile".to_string());
    }
    let reserved_files = [
        control_path(&root_canonical),
        key_path(&root_canonical),
        external_anchor_path(&root_canonical),
        crate::experimental_memory_recovery::memory_path(&root_canonical),
    ];
    let reserved_directories = [
        evidence_root(&root_canonical),
        root_canonical.join("memory-recovery-snapshots"),
    ];
    if reserved_files.iter().any(|path| path == &source_canonical)
        || reserved_directories
            .iter()
            .any(|path| source_canonical.starts_with(path))
    {
        return Err("Legacy dual-read source overlaps protected experiment evidence".to_string());
    }
    Ok(source_canonical)
}

pub(crate) fn assess_dual_read_at(
    root: &Path,
    input: AssessMemoryDualReadInput,
) -> Result<MemoryPromotionReceipt, String> {
    validate_token("operationId", &input.operation_id)?;
    validate_token("idempotencyKey", &input.idempotency_key)?;
    validate_hash("expectedSourceSha256", &input.expected_source_sha256)?;
    validate_hash("expectedMemorySha256", &input.expected_memory_sha256)?;
    let input_hash = stable_input_sha256(&input)?;
    let root =
        crate::experimental_memory_recovery::normalize_platform_root_alias(root.to_path_buf());
    let _lease = crate::experimental_memory_recovery::acquire_host_wide_memory_lease(&root)?;
    let key = read_signing_key(&key_path(&root))?;
    let mut connection = open_read_write(&control_path(&root))?;
    let records = verify_journal(&connection, &key, &external_anchor_path(&root))?;
    if let Some(existing) =
        find_identity_record(&records, &input.operation_id, &input.idempotency_key)?
    {
        return validate_duplicate(existing, &input_hash);
    }
    let database = crate::experimental_memory_recovery::memory_path(&root);
    crate::experimental_memory_recovery::validate_sqlite_sidecars(&database)?;
    let before = crate::experimental_memory_recovery::capture_memory_file(&database, None)?;
    if before.sha256 != input.expected_memory_sha256 {
        return Err(
            "Experimental Memory database hash does not match the dual-read input".to_string(),
        );
    }
    let source_path = validate_isolated_legacy_source(&root, Path::new(&input.source_path))?;
    let parity = crate::experimental_foundation::inspect_memory_dual_read_parity_at(
        &root,
        &crate::experimental_foundation::MemoryImportRequest {
            source_path: source_path.to_string_lossy().to_string(),
            user_id: input.user_id,
            workspace_id: input.workspace_id,
            expected_source_sha256: Some(input.expected_source_sha256),
        },
    )?;
    crate::experimental_memory_recovery::validate_sqlite_sidecars(&database)?;
    let after = crate::experimental_memory_recovery::capture_memory_file(&database, None)?;
    if after != before {
        return Err("Experimental Memory database changed during dual-read assessment".to_string());
    }
    if parity.source_size == 0 || parity.source_device.is_empty() || parity.source_inode.is_empty()
    {
        return Err("Legacy authority descriptor evidence is incomplete".to_string());
    }
    let mismatch_count = if parity.compared_entry_count == 0 {
        parity.mismatch_count.saturating_add(1)
    } else {
        parity.mismatch_count
    };
    let phase = if mismatch_count == 0 {
        "parity_confirmed"
    } else {
        "parity_failed"
    };
    let record = append_record(
        &mut connection,
        &key,
        &external_anchor_path(&root),
        NewRecord {
            operation_id: &input.operation_id,
            operation_kind: "dual_read_assessment",
            phase,
            idempotency_key: &input.idempotency_key,
            input_payload_sha256: &input_hash,
            source_authority_sha256: Some(&parity.source_sha256),
            memory: &before,
            evidence_relative_path: None,
            evidence_sha256: None,
            compared_entry_count: parity.compared_entry_count,
            mismatch_count,
            dependency_record_sha256: None,
            recovery_record_sha256: None,
            incident_reason_sha256: None,
        },
    )?;
    Ok(receipt(&record, false))
}

#[tauri::command]
pub(crate) fn assess_experimental_memory_dual_read(
    input: AssessMemoryDualReadInput,
) -> Result<MemoryPromotionReceipt, String> {
    assess_dual_read_at(&isolated_root()?, input)
}

pub(crate) fn prepare_authority_switch_at(
    root: &Path,
    input: PrepareMemoryAuthoritySwitchInput,
) -> Result<MemoryPromotionReceipt, String> {
    validate_token("operationId", &input.operation_id)?;
    validate_token("idempotencyKey", &input.idempotency_key)?;
    validate_hash("dualReadRecordSha256", &input.dual_read_record_sha256)?;
    validate_hash("recoveryRecordSha256", &input.recovery_record_sha256)?;
    validate_hash("expectedMemorySha256", &input.expected_memory_sha256)?;
    let input_hash = stable_input_sha256(&input)?;
    let root =
        crate::experimental_memory_recovery::normalize_platform_root_alias(root.to_path_buf());
    let _lease = crate::experimental_memory_recovery::acquire_host_wide_memory_lease(&root)?;
    let key = read_signing_key(&key_path(&root))?;
    let mut connection = open_read_write(&control_path(&root))?;
    let records = verify_journal(&connection, &key, &external_anchor_path(&root))?;
    if let Some(existing) =
        find_identity_record(&records, &input.operation_id, &input.idempotency_key)?
    {
        return validate_duplicate(existing, &input_hash);
    }
    let dual_read = records
        .iter()
        .find(|record| {
            record.record_sha256 == input.dual_read_record_sha256
                && record.operation_kind == "dual_read_assessment"
                && record.phase == "parity_confirmed"
        })
        .ok_or("Confirmed dual-read assessment is missing")?;
    if dual_read.memory_database_sha256 != input.expected_memory_sha256
        || dual_read.mismatch_count != 0
        || dual_read.compared_entry_count <= 0
    {
        return Err("Dual-read assessment is not eligible for promotion".to_string());
    }
    let snapshot_relative =
        crate::experimental_memory_recovery::verify_completed_recovery_binding_at(
            &root,
            &input.recovery_record_sha256,
            &input.expected_memory_sha256,
        )?;
    let snapshot_path = root.join(&snapshot_relative);
    crate::experimental_memory_recovery::validate_immutable_snapshot_file(&snapshot_path)?;
    let snapshot = crate::experimental_memory_recovery::capture_memory_file(&snapshot_path, None)?;
    let database = crate::experimental_memory_recovery::memory_path(&root);
    let current = crate::experimental_memory_recovery::capture_memory_file(&database, None)?;
    crate::experimental_foundation::validate_memory_store_for_recovery(&database)?;
    if current.sha256 != input.expected_memory_sha256
        || current.device != dual_read.memory_device
        || current.inode != dual_read.memory_inode
        || i64::try_from(current.size).ok() != Some(dual_read.memory_size)
    {
        return Err("Memory database drifted after dual-read assessment".to_string());
    }
    let record = append_record(
        &mut connection,
        &key,
        &external_anchor_path(&root),
        NewRecord {
            operation_id: &input.operation_id,
            operation_kind: "authority_switch_proposal",
            phase: "awaiting_operator",
            idempotency_key: &input.idempotency_key,
            input_payload_sha256: &input_hash,
            source_authority_sha256: dual_read.source_authority_sha256.as_deref(),
            memory: &current,
            evidence_relative_path: Some(&snapshot_relative),
            evidence_sha256: Some(&snapshot.sha256),
            compared_entry_count: dual_read.compared_entry_count as u64,
            mismatch_count: 0,
            dependency_record_sha256: Some(&dual_read.record_sha256),
            recovery_record_sha256: Some(&input.recovery_record_sha256),
            incident_reason_sha256: None,
        },
    )?;
    Ok(receipt(&record, false))
}

#[tauri::command]
pub(crate) fn prepare_experimental_memory_authority_switch(
    input: PrepareMemoryAuthoritySwitchInput,
) -> Result<MemoryPromotionReceipt, String> {
    prepare_authority_switch_at(&isolated_root()?, input)
}

fn incident_sidecar_path(database: &Path, suffix: &str) -> Result<PathBuf, String> {
    let parent = database
        .parent()
        .ok_or("Experimental Memory database path has no parent")?;
    let base = database
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or("Experimental Memory database filename is invalid")?;
    Ok(parent.join(format!("{base}{suffix}")))
}

fn forensic_file_name(source_suffix: &str) -> Result<&'static str, String> {
    match source_suffix {
        "database" => Ok("database.raw"),
        "-wal" => Ok("wal.raw"),
        "-shm" => Ok("shm.raw"),
        "-journal" => Ok("journal.raw"),
        _ => Err("Raw forensic evidence has an unsupported source suffix".to_string()),
    }
}

fn capture_incident_source_state(database: &Path) -> Result<IncidentSourceState, String> {
    let database_snapshot =
        crate::experimental_memory_recovery::capture_memory_file(database, None)?;
    let parent = database
        .parent()
        .ok_or("Experimental Memory database path has no parent")?;
    let base = database
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or("Experimental Memory database filename is invalid")?;
    let super_journal_prefix = format!("{base}-mj");
    for entry in fs::read_dir(parent)
        .map_err(|error| format!("Failed to inspect Memory forensic sidecars: {error}"))?
    {
        let name = entry
            .map_err(|error| format!("Failed to inspect Memory forensic sidecar: {error}"))?
            .file_name();
        if name.to_string_lossy().starts_with(&super_journal_prefix) {
            return Err(
                "Raw forensic capture cannot seal an unbounded SQLite super-journal set"
                    .to_string(),
            );
        }
    }
    let mut sidecars = Vec::new();
    for suffix in SQLITE_SIDECAR_SUFFIXES {
        let sidecar = incident_sidecar_path(database, suffix)?;
        match fs::symlink_metadata(&sidecar) {
            Ok(_) => sidecars.push(IncidentSidecarState {
                suffix: (*suffix).to_string(),
                snapshot: crate::experimental_memory_recovery::capture_memory_file(&sidecar, None)?,
            }),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!(
                    "Failed to inspect Experimental Memory SQLite sidecar {suffix}: {error}"
                ))
            }
        }
    }
    Ok(IncidentSourceState {
        database: database_snapshot,
        sidecars,
    })
}

fn write_forensic_copy(
    source_path: &Path,
    destination_path: &Path,
) -> Result<crate::experimental_memory_recovery::MemoryFileSnapshot, String> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let mut destination = options
        .open(destination_path)
        .map_err(|error| format!("Failed to stage raw forensic evidence: {error}"))?;
    let source = crate::experimental_memory_recovery::capture_memory_file(
        source_path,
        Some(&mut destination),
    )?;
    destination
        .sync_all()
        .map_err(|error| format!("Failed to sync raw forensic evidence: {error}"))?;
    drop(destination);
    set_file_mode(destination_path, 0o400)?;
    sync_file_and_parent(destination_path)?;
    validate_immutable_evidence(destination_path, "Memory raw forensic evidence file")?;
    let evidence =
        crate::experimental_memory_recovery::capture_memory_file(destination_path, None)?;
    if evidence.sha256 != source.sha256 || evidence.size != source.size {
        return Err("Staged raw forensic evidence failed parity verification".to_string());
    }
    Ok(source)
}

fn validate_forensic_entry(
    directory: &Path,
    entry: &ForensicEvidenceFile,
    expected_suffix: &str,
) -> Result<crate::experimental_memory_recovery::MemoryFileSnapshot, String> {
    if entry.source_suffix != expected_suffix {
        return Err("Raw forensic evidence manifest source suffix drifted".to_string());
    }
    validate_hash("raw forensic evidence SHA-256", &entry.sha256)?;
    let expected_name = forensic_file_name(expected_suffix)?;
    if entry.relative_path != expected_name {
        return Err("Raw forensic evidence manifest path drifted".to_string());
    }
    let path = directory.join(expected_name);
    validate_immutable_evidence(&path, "Memory raw forensic evidence file")?;
    let snapshot = crate::experimental_memory_recovery::capture_memory_file(&path, None)?;
    if snapshot.sha256 != entry.sha256 || snapshot.size != entry.size {
        return Err("Raw forensic evidence file binding drifted".to_string());
    }
    Ok(snapshot)
}

fn read_forensic_manifest_bytes(path: &Path) -> Result<Vec<u8>, String> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = options
        .open(path)
        .map_err(|error| format!("Failed to open raw forensic manifest: {error}"))?;
    let before = file
        .metadata()
        .map_err(|error| format!("Failed to inspect raw forensic manifest: {error}"))?;
    if !before.is_file() || before.len() == 0 || before.len() > MAX_FORENSIC_MANIFEST_BYTES {
        return Err("Raw forensic evidence manifest is empty or unbounded".to_string());
    }
    let mut bytes = Vec::with_capacity(before.len() as usize);
    (&mut file)
        .take(MAX_FORENSIC_MANIFEST_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Failed to read raw forensic manifest: {error}"))?;
    if bytes.len() as u64 != before.len() || bytes.len() as u64 > MAX_FORENSIC_MANIFEST_BYTES {
        return Err("Raw forensic evidence manifest changed during inspection".to_string());
    }
    let after = file
        .metadata()
        .map_err(|error| format!("Failed to re-inspect raw forensic manifest: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if before.dev() != after.dev()
            || before.ino() != after.ino()
            || before.len() != after.len()
            || before.mtime() != after.mtime()
            || before.mtime_nsec() != after.mtime_nsec()
            || before.ctime() != after.ctime()
            || before.ctime_nsec() != after.ctime_nsec()
            || after.nlink() != 1
        {
            return Err("Raw forensic evidence manifest changed during inspection".to_string());
        }
    }
    #[cfg(not(unix))]
    if before.len() != after.len() {
        return Err("Raw forensic evidence manifest changed during inspection".to_string());
    }
    Ok(bytes)
}

fn validate_forensic_bundle(
    root: &Path,
    operation_id: &str,
    manifest_path: &Path,
) -> Result<(ForensicEvidenceManifest, String), String> {
    validate_token("forensic operationId", operation_id)?;
    let expected_directory = evidence_root(root).join(operation_id);
    let expected_manifest = expected_directory.join("manifest.json");
    if manifest_path != expected_manifest {
        return Err("Raw forensic evidence manifest path escaped its operation bundle".to_string());
    }
    let directory_metadata = fs::symlink_metadata(&expected_directory)
        .map_err(|error| format!("Failed to inspect raw forensic evidence bundle: {error}"))?;
    if directory_metadata.file_type().is_symlink() || !directory_metadata.is_dir() {
        return Err("Raw forensic evidence bundle must be a real directory".to_string());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if directory_metadata.permissions().mode() & 0o777 != 0o500 {
            return Err("Raw forensic evidence bundle must have mode 0500".to_string());
        }
    }
    validate_immutable_evidence(&expected_manifest, "Memory raw forensic manifest")?;
    let manifest_bytes = read_forensic_manifest_bytes(&expected_manifest)?;
    let manifest: ForensicEvidenceManifest = serde_json::from_slice(&manifest_bytes)
        .map_err(|error| format!("Failed to decode raw forensic manifest: {error}"))?;
    if manifest.schema_version != FORENSIC_MANIFEST_SCHEMA_VERSION
        || manifest.operation_id != operation_id
    {
        return Err("Raw forensic evidence manifest identity drifted".to_string());
    }
    validate_forensic_entry(&expected_directory, &manifest.database, "database")?;
    let mut previous_position = None;
    let mut expected_names = vec!["manifest.json".to_string(), "database.raw".to_string()];
    for entry in &manifest.sidecars {
        let position = SQLITE_SIDECAR_SUFFIXES
            .iter()
            .position(|suffix| *suffix == entry.source_suffix)
            .ok_or("Raw forensic evidence manifest contains an unsupported sidecar")?;
        if previous_position.is_some_and(|previous| position <= previous) {
            return Err(
                "Raw forensic evidence sidecars must be unique and canonically ordered".to_string(),
            );
        }
        previous_position = Some(position);
        validate_forensic_entry(&expected_directory, entry, &entry.source_suffix)?;
        expected_names.push(entry.relative_path.clone());
    }
    expected_names.sort();
    let mut actual_names = fs::read_dir(&expected_directory)
        .map_err(|error| format!("Failed to enumerate raw forensic evidence bundle: {error}"))?
        .map(|entry| {
            entry
                .map_err(|error| format!("Failed to inspect raw forensic bundle entry: {error}"))
                .and_then(|entry| {
                    entry
                        .file_name()
                        .into_string()
                        .map_err(|_| "Raw forensic bundle filename is not UTF-8".to_string())
                })
        })
        .collect::<Result<Vec<_>, _>>()?;
    actual_names.sort();
    if actual_names != expected_names {
        return Err("Raw forensic evidence bundle contains unmanifested files".to_string());
    }
    Ok((manifest, sha256_hex(&manifest_bytes)))
}

fn validate_manifest_matches_incident(
    manifest: &ForensicEvidenceManifest,
    incident: &IncidentSourceState,
) -> Result<(), String> {
    if manifest.database.sha256 != incident.database.sha256
        || manifest.database.size != incident.database.size
        || manifest.sidecars.len() != incident.sidecars.len()
    {
        return Err("Raw forensic evidence bundle does not match the incident".to_string());
    }
    for (entry, sidecar) in manifest.sidecars.iter().zip(&incident.sidecars) {
        if entry.source_suffix != sidecar.suffix
            || entry.sha256 != sidecar.snapshot.sha256
            || entry.size != sidecar.snapshot.size
        {
            return Err("Raw forensic SQLite sidecar evidence drifted".to_string());
        }
    }
    Ok(())
}

fn capture_raw_evidence_bundle(
    root: &Path,
    operation_id: &str,
    database: &Path,
) -> Result<(IncidentSourceState, String, String), String> {
    let directory = evidence_root(root);
    ensure_private_directory(&directory, "Memory promotion evidence root")?;
    let final_directory = directory.join(operation_id);
    let relative = format!("memory-promotion-evidence/{operation_id}/manifest.json");
    let final_manifest = root.join(&relative);
    match fs::symlink_metadata(&final_directory) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err(
                    "Existing raw forensic evidence bundle is not a real directory".to_string(),
                );
            }
            let source = capture_incident_source_state(database)?;
            let (manifest, manifest_sha256) =
                validate_forensic_bundle(root, operation_id, &final_manifest)?;
            validate_manifest_matches_incident(&manifest, &source)?;
            return Ok((source, relative, manifest_sha256));
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(format!(
                "Failed to inspect raw forensic evidence bundle: {error}"
            ))
        }
    }

    let staging = directory.join(format!(".{operation_id}.{}.raw.tmp", Uuid::new_v4()));
    fs::create_dir(&staging)
        .map_err(|error| format!("Failed to create raw forensic staging directory: {error}"))?;
    set_file_mode(&staging, 0o700)?;
    let result = (|| -> Result<_, String> {
        let database_snapshot = write_forensic_copy(database, &staging.join("database.raw"))?;
        let mut sidecars = Vec::new();
        let mut manifest_sidecars = Vec::new();
        for suffix in SQLITE_SIDECAR_SUFFIXES {
            let source_path = incident_sidecar_path(database, suffix)?;
            match fs::symlink_metadata(&source_path) {
                Ok(_) => {
                    let relative_path = forensic_file_name(suffix)?.to_string();
                    let snapshot =
                        write_forensic_copy(&source_path, &staging.join(&relative_path))?;
                    manifest_sidecars.push(ForensicEvidenceFile {
                        source_suffix: (*suffix).to_string(),
                        relative_path,
                        sha256: snapshot.sha256.clone(),
                        size: snapshot.size,
                    });
                    sidecars.push(IncidentSidecarState {
                        suffix: (*suffix).to_string(),
                        snapshot,
                    });
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    return Err(format!(
                        "Failed to inspect Experimental Memory SQLite sidecar {suffix}: {error}"
                    ))
                }
            }
        }
        let source = IncidentSourceState {
            database: database_snapshot.clone(),
            sidecars,
        };
        let manifest = ForensicEvidenceManifest {
            schema_version: FORENSIC_MANIFEST_SCHEMA_VERSION,
            operation_id: operation_id.to_string(),
            database: ForensicEvidenceFile {
                source_suffix: "database".to_string(),
                relative_path: "database.raw".to_string(),
                sha256: database_snapshot.sha256,
                size: database_snapshot.size,
            },
            sidecars: manifest_sidecars,
        };
        let manifest_bytes = serde_json::to_vec(&manifest)
            .map_err(|error| format!("Failed to encode raw forensic manifest: {error}"))?;
        let staged_manifest = staging.join("manifest.json");
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        }
        let mut file = options
            .open(&staged_manifest)
            .map_err(|error| format!("Failed to stage raw forensic manifest: {error}"))?;
        file.write_all(&manifest_bytes)
            .and_then(|_| file.sync_all())
            .map_err(|error| format!("Failed to persist raw forensic manifest: {error}"))?;
        drop(file);
        set_file_mode(&staged_manifest, 0o400)?;
        sync_file_and_parent(&staged_manifest)?;
        set_file_mode(&staging, 0o500)?;
        fs::rename(&staging, &final_directory)
            .map_err(|error| format!("Failed to publish raw forensic evidence bundle: {error}"))?;
        File::open(&directory)
            .and_then(|file| file.sync_all())
            .map_err(|error| format!("Failed to sync raw forensic evidence root: {error}"))?;
        let (published_manifest, manifest_sha256) =
            validate_forensic_bundle(root, operation_id, &final_manifest)?;
        if published_manifest != manifest {
            return Err("Published raw forensic manifest changed during capture".to_string());
        }
        validate_manifest_matches_incident(&published_manifest, &source)?;
        Ok((source, relative, manifest_sha256))
    })();
    if result.is_err() && staging.exists() {
        let _ = set_file_mode(&staging, 0o700);
        let _ = fs::remove_dir_all(&staging);
    }
    result
}

pub(crate) fn capture_raw_forensic_at(
    root: &Path,
    input: CaptureRawForensicEvidenceInput,
) -> Result<MemoryPromotionReceipt, String> {
    validate_token("operationId", &input.operation_id)?;
    validate_token("idempotencyKey", &input.idempotency_key)?;
    validate_hash("expectedMemorySha256", &input.expected_memory_sha256)?;
    validate_hash("incidentReasonSha256", &input.incident_reason_sha256)?;
    let input_hash = stable_input_sha256(&input)?;
    let root =
        crate::experimental_memory_recovery::normalize_platform_root_alias(root.to_path_buf());
    let _lease = crate::experimental_memory_recovery::acquire_host_wide_memory_lease(&root)?;
    let key = read_signing_key(&key_path(&root))?;
    let mut connection = open_read_write(&control_path(&root))?;
    let records = verify_journal(&connection, &key, &external_anchor_path(&root))?;
    if let Some(existing) =
        find_identity_record(&records, &input.operation_id, &input.idempotency_key)?
    {
        return validate_duplicate(existing, &input_hash);
    }
    let database = crate::experimental_memory_recovery::memory_path(&root);
    let before = capture_incident_source_state(&database)?;
    if before.database.sha256 != input.expected_memory_sha256 {
        return Err("Experimental Memory database hash does not match the incident".to_string());
    }
    let inspection = crate::experimental_foundation::inspect_memory_store_for_recovery(&database);
    if !inspection.initialized || inspection.ready || inspection.blocked_reason.is_none() {
        return Err(
            "Raw forensic capture requires an unreadable or invalid Memory database".to_string(),
        );
    }
    let (captured, relative, evidence_sha256) =
        capture_raw_evidence_bundle(&root, &input.operation_id, &database)?;
    let after = capture_incident_source_state(&database)?;
    if before != after || before != captured {
        return Err(
            "Experimental Memory incident files changed during raw forensic capture".to_string(),
        );
    }
    let (sealed_manifest, sealed_manifest_sha256) =
        validate_forensic_bundle(&root, &input.operation_id, &root.join(&relative))?;
    if sealed_manifest_sha256 != evidence_sha256 {
        return Err("Raw forensic evidence manifest drifted before journal binding".to_string());
    }
    validate_manifest_matches_incident(&sealed_manifest, &captured)?;
    let record = append_record(
        &mut connection,
        &key,
        &external_anchor_path(&root),
        NewRecord {
            operation_id: &input.operation_id,
            operation_kind: "raw_forensic_evidence",
            phase: "raw_evidence_sealed",
            idempotency_key: &input.idempotency_key,
            input_payload_sha256: &input_hash,
            source_authority_sha256: None,
            memory: &captured.database,
            evidence_relative_path: Some(&relative),
            evidence_sha256: Some(&evidence_sha256),
            compared_entry_count: 0,
            mismatch_count: 0,
            dependency_record_sha256: None,
            recovery_record_sha256: None,
            incident_reason_sha256: Some(&input.incident_reason_sha256),
        },
    )?;
    Ok(receipt(&record, false))
}

#[tauri::command]
pub(crate) fn capture_experimental_memory_raw_forensic_evidence(
    input: CaptureRawForensicEvidenceInput,
) -> Result<MemoryPromotionReceipt, String> {
    capture_raw_forensic_at(&isolated_root()?, input)
}

fn reject_symlink_components(path: &Path) -> Result<(), String> {
    let mut cursor = PathBuf::new();
    for component in path.components() {
        match component {
            Component::RootDir | Component::Prefix(_) => cursor.push(component.as_os_str()),
            Component::Normal(value) => {
                cursor.push(value);
                match fs::symlink_metadata(&cursor) {
                    Ok(metadata) if metadata.file_type().is_symlink() => {
                        return Err("Memory promotion path contains a symlink".to_string())
                    }
                    Ok(_) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
                    Err(error) => {
                        return Err(format!("Failed to inspect Memory promotion path: {error}"))
                    }
                }
            }
            Component::CurDir | Component::ParentDir => {
                return Err("Memory promotion path contains relative components".to_string())
            }
        }
    }
    Ok(())
}

fn validate_restore_candidate(root: &Path, candidate: &Path) -> Result<(PathBuf, String), String> {
    let candidate =
        crate::experimental_memory_recovery::normalize_platform_root_alias(candidate.to_path_buf());
    if !candidate.is_absolute() {
        return Err("Manual restore candidate must be an absolute path".to_string());
    }
    reject_symlink_components(&candidate)?;
    let root_canonical = fs::canonicalize(root)
        .map_err(|error| format!("Failed to resolve Memory promotion root: {error}"))?;
    let snapshot_root = fs::canonicalize(root.join("memory-recovery-snapshots"))
        .map_err(|error| format!("Failed to resolve Memory recovery snapshot root: {error}"))?;
    let candidate_canonical = fs::canonicalize(&candidate)
        .map_err(|error| format!("Failed to resolve manual restore candidate: {error}"))?;
    if !candidate_canonical.starts_with(&root_canonical)
        || !candidate_canonical.starts_with(&snapshot_root)
    {
        return Err("Manual restore candidate must be a sealed recovery snapshot".to_string());
    }
    crate::experimental_memory_recovery::validate_immutable_snapshot_file(&candidate_canonical)?;
    crate::experimental_foundation::validate_memory_store_for_recovery(&candidate_canonical)?;
    let relative = candidate_canonical
        .strip_prefix(&root_canonical)
        .map_err(|_| "Failed to bind manual restore candidate path".to_string())?
        .to_string_lossy()
        .to_string();
    Ok((candidate_canonical, relative))
}

pub(crate) fn prepare_manual_restore_at(
    root: &Path,
    input: PrepareManualRestoreProposalInput,
) -> Result<MemoryPromotionReceipt, String> {
    validate_token("operationId", &input.operation_id)?;
    validate_token("idempotencyKey", &input.idempotency_key)?;
    validate_hash("forensicRecordSha256", &input.forensic_record_sha256)?;
    validate_hash("recoveryRecordSha256", &input.recovery_record_sha256)?;
    validate_hash("expectedCandidateSha256", &input.expected_candidate_sha256)?;
    let input_hash = stable_input_sha256(&input)?;
    let root =
        crate::experimental_memory_recovery::normalize_platform_root_alias(root.to_path_buf());
    let _lease = crate::experimental_memory_recovery::acquire_host_wide_memory_lease(&root)?;
    let key = read_signing_key(&key_path(&root))?;
    let mut connection = open_read_write(&control_path(&root))?;
    let records = verify_journal(&connection, &key, &external_anchor_path(&root))?;
    if let Some(existing) =
        find_identity_record(&records, &input.operation_id, &input.idempotency_key)?
    {
        return validate_duplicate(existing, &input_hash);
    }
    let forensic = records
        .iter()
        .find(|record| {
            record.record_sha256 == input.forensic_record_sha256
                && record.operation_kind == "raw_forensic_evidence"
                && record.phase == "raw_evidence_sealed"
        })
        .ok_or("Raw forensic evidence record is missing")?;
    let evidence_path = root.join(
        forensic
            .evidence_relative_path
            .as_deref()
            .ok_or("Raw forensic evidence path is missing")?,
    );
    let (manifest, manifest_sha256) =
        validate_forensic_bundle(&root, &forensic.operation_id, &evidence_path)?;
    if forensic.evidence_sha256.as_deref() != Some(manifest_sha256.as_str())
        || forensic.memory_database_sha256 != manifest.database.sha256
        || i64::try_from(manifest.database.size).ok() != Some(forensic.memory_size)
    {
        return Err("Raw forensic evidence binding drifted".to_string());
    }
    let current_incident =
        capture_incident_source_state(&crate::experimental_memory_recovery::memory_path(&root))?;
    validate_manifest_matches_incident(&manifest, &current_incident)?;
    if current_incident.database.device != forensic.memory_device
        || current_incident.database.inode != forensic.memory_inode
        || i64::try_from(current_incident.database.size).ok() != Some(forensic.memory_size)
    {
        return Err("Current Memory incident identity drifted after forensic capture".to_string());
    }
    let (candidate_path, relative) =
        validate_restore_candidate(&root, Path::new(&input.candidate_path))?;
    let signed_relative =
        crate::experimental_memory_recovery::verify_completed_recovery_snapshot_at(
            &root,
            &input.recovery_record_sha256,
            &candidate_path,
            &input.expected_candidate_sha256,
        )?;
    if signed_relative != relative {
        return Err("Manual restore candidate path disagrees with its signed record".to_string());
    }
    let candidate =
        crate::experimental_memory_recovery::capture_memory_file(&candidate_path, None)?;
    if candidate.sha256 != input.expected_candidate_sha256 {
        return Err("Manual restore candidate hash mismatch".to_string());
    }
    let incident_memory = crate::experimental_memory_recovery::MemoryFileSnapshot {
        sha256: forensic.memory_database_sha256.clone(),
        device: forensic.memory_device.clone(),
        inode: forensic.memory_inode.clone(),
        size: forensic.memory_size.max(0) as u64,
    };
    let record = append_record(
        &mut connection,
        &key,
        &external_anchor_path(&root),
        NewRecord {
            operation_id: &input.operation_id,
            operation_kind: "manual_restore_proposal",
            phase: "awaiting_operator",
            idempotency_key: &input.idempotency_key,
            input_payload_sha256: &input_hash,
            source_authority_sha256: None,
            memory: &incident_memory,
            evidence_relative_path: Some(&relative),
            evidence_sha256: Some(&candidate.sha256),
            compared_entry_count: 0,
            mismatch_count: 0,
            dependency_record_sha256: Some(&forensic.record_sha256),
            recovery_record_sha256: Some(&input.recovery_record_sha256),
            incident_reason_sha256: None,
        },
    )?;
    Ok(receipt(&record, false))
}

#[tauri::command]
pub(crate) fn prepare_experimental_memory_manual_restore(
    input: PrepareManualRestoreProposalInput,
) -> Result<MemoryPromotionReceipt, String> {
    prepare_manual_restore_at(&isolated_root()?, input)
}

pub(crate) fn exact_control_schema_attestation_at(
    root: &Path,
) -> Result<crate::experimental_sqlite_attestation::ExactSchemaAttestation, String> {
    let root =
        crate::experimental_memory_recovery::normalize_platform_root_alias(root.to_path_buf());
    let connection = open_read_only(&control_path(&root), "Memory promotion control database")?;
    crate::experimental_sqlite_attestation::attest_exact_schema(
        &connection,
        SCHEMA_SQL,
        "Memory promotion",
    )
}

/// Revalidates an awaiting-operator proposal and every mutable dependency.
/// The caller must hold the shared experimental host-wide lease.
pub(crate) fn verify_operator_proposal_at(
    root: &Path,
    expected_record_sha256: &str,
) -> Result<MemoryOperatorProposalBinding, String> {
    validate_hash("proposalRecordSha256", expected_record_sha256)?;
    let root =
        crate::experimental_memory_recovery::normalize_platform_root_alias(root.to_path_buf());
    let key = read_signing_key(&key_path(&root))?;
    let connection = open_read_only(&control_path(&root), "Memory promotion control database")?;
    crate::experimental_sqlite_attestation::attest_exact_schema(
        &connection,
        SCHEMA_SQL,
        "Memory promotion",
    )?;
    let records = verify_journal(&connection, &key, &external_anchor_path(&root))?;
    let proposal = records
        .iter()
        .find(|record| {
            record.record_sha256 == expected_record_sha256
                && record.phase == "awaiting_operator"
                && matches!(
                    record.operation_kind.as_str(),
                    "authority_switch_proposal" | "manual_restore_proposal"
                )
        })
        .ok_or("Awaiting-operator Memory proposal is missing")?;
    let dependency_sha256 = proposal
        .dependency_record_sha256
        .as_deref()
        .ok_or("Memory operator proposal dependency is missing")?;
    let recovery_sha256 = proposal
        .recovery_record_sha256
        .as_deref()
        .ok_or("Memory operator proposal recovery binding is missing")?;
    let evidence_relative_path = proposal
        .evidence_relative_path
        .as_deref()
        .ok_or("Memory operator proposal evidence path is missing")?;
    let evidence_sha256 = proposal
        .evidence_sha256
        .as_deref()
        .ok_or("Memory operator proposal evidence hash is missing")?;

    match proposal.operation_kind.as_str() {
        "authority_switch_proposal" => {
            let parity = records
                .iter()
                .find(|record| {
                    record.record_sha256 == dependency_sha256
                        && record.operation_kind == "dual_read_assessment"
                        && record.phase == "parity_confirmed"
                })
                .ok_or("Authority-switch proposal parity dependency is missing")?;
            if parity.mismatch_count != 0
                || parity.compared_entry_count <= 0
                || parity.source_authority_sha256 != proposal.source_authority_sha256
                || parity.memory_database_sha256 != proposal.memory_database_sha256
                || parity.memory_device != proposal.memory_device
                || parity.memory_inode != proposal.memory_inode
                || parity.memory_size != proposal.memory_size
            {
                return Err("Authority-switch proposal parity binding drifted".to_string());
            }
            let signed_snapshot =
                crate::experimental_memory_recovery::verify_completed_recovery_binding_at(
                    &root,
                    recovery_sha256,
                    &proposal.memory_database_sha256,
                )?;
            if signed_snapshot != evidence_relative_path {
                return Err("Authority-switch recovery path binding drifted".to_string());
            }
            let snapshot = crate::experimental_memory_recovery::capture_memory_file(
                &root.join(evidence_relative_path),
                None,
            )?;
            if snapshot.sha256 != evidence_sha256 {
                return Err("Authority-switch recovery evidence hash drifted".to_string());
            }
        }
        "manual_restore_proposal" => {
            let forensic = records
                .iter()
                .find(|record| {
                    record.record_sha256 == dependency_sha256
                        && record.operation_kind == "raw_forensic_evidence"
                        && record.phase == "raw_evidence_sealed"
                })
                .ok_or("Manual-restore forensic dependency is missing")?;
            let forensic_path = root.join(
                forensic
                    .evidence_relative_path
                    .as_deref()
                    .ok_or("Manual-restore forensic evidence path is missing")?,
            );
            let (manifest, manifest_sha256) =
                validate_forensic_bundle(&root, &forensic.operation_id, &forensic_path)?;
            if forensic.evidence_sha256.as_deref() != Some(manifest_sha256.as_str()) {
                return Err("Manual-restore forensic manifest binding drifted".to_string());
            }
            let current = capture_incident_source_state(
                &crate::experimental_memory_recovery::memory_path(&root),
            )?;
            validate_manifest_matches_incident(&manifest, &current)?;
            if current.database.sha256 != proposal.memory_database_sha256
                || current.database.device != proposal.memory_device
                || current.database.inode != proposal.memory_inode
                || i64::try_from(current.database.size).ok() != Some(proposal.memory_size)
            {
                return Err("Manual-restore incident identity drifted".to_string());
            }
            let candidate = root.join(evidence_relative_path);
            let signed_snapshot =
                crate::experimental_memory_recovery::verify_completed_recovery_snapshot_at(
                    &root,
                    recovery_sha256,
                    &candidate,
                    evidence_sha256,
                )?;
            if signed_snapshot != evidence_relative_path {
                return Err("Manual-restore candidate path binding drifted".to_string());
            }
        }
        _ => return Err("Unsupported Memory operator proposal kind".to_string()),
    }

    let current = crate::experimental_memory_recovery::capture_memory_file(
        &crate::experimental_memory_recovery::memory_path(&root),
        None,
    )?;
    if current.sha256 != proposal.memory_database_sha256
        || current.device != proposal.memory_device
        || current.inode != proposal.memory_inode
        || i64::try_from(current.size).ok() != Some(proposal.memory_size)
    {
        return Err("Memory operator proposal database identity drifted".to_string());
    }

    Ok(MemoryOperatorProposalBinding {
        proposal_record_sha256: proposal.record_sha256.clone(),
        operation_kind: proposal.operation_kind.clone(),
        memory_database_sha256: proposal.memory_database_sha256.clone(),
        memory_device: proposal.memory_device.clone(),
        memory_inode: proposal.memory_inode.clone(),
        memory_size: proposal.memory_size.max(0) as u64,
    })
}

fn inspect_journal_at(root: &Path) -> Result<MemoryPromotionJournalInspection, String> {
    let root =
        crate::experimental_memory_recovery::normalize_platform_root_alias(root.to_path_buf());
    let _lease = crate::experimental_memory_recovery::acquire_host_wide_memory_lease(&root)?;
    let key = read_signing_key(&key_path(&root))?;
    let connection = open_read_only(&control_path(&root), "Memory promotion control database")?;
    let records = verify_journal(&connection, &key, &external_anchor_path(&root))?;
    Ok(MemoryPromotionJournalInspection {
        schema_version: SCHEMA_VERSION,
        journal_record_count: records.len() as u64,
        parity_confirmed_count: records
            .iter()
            .filter(|record| record.phase == "parity_confirmed")
            .count() as u64,
        parity_failed_count: records
            .iter()
            .filter(|record| record.phase == "parity_failed")
            .count() as u64,
        operator_proposal_count: records
            .iter()
            .filter(|record| record.phase == "awaiting_operator")
            .count() as u64,
        raw_forensic_evidence_count: records
            .iter()
            .filter(|record| record.phase == "raw_evidence_sealed")
            .count() as u64,
        last_record_sha256: records
            .last()
            .map(|record| record.record_sha256.clone())
            .unwrap_or_else(|| ZERO_HASH.to_string()),
        hmac_verified: true,
        chain_verified: true,
        external_effects: 0,
        dual_read_enabled: false,
        authority_switch_applied: false,
        restore_performed: false,
        production_memory_mutated: false,
        production_integration: false,
    })
}

#[tauri::command]
pub(crate) fn inspect_experimental_memory_promotion_journal(
) -> Result<MemoryPromotionJournalInspection, String> {
    inspect_journal_at(&isolated_root()?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> (tempfile::TempDir, PathBuf, PathBuf, String) {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().to_path_buf();
        crate::experimental_foundation::create_memory_store(
            &crate::experimental_foundation::memory_path(&root),
        )
        .unwrap();
        let source = root.join("legacy-memory.md");
        fs::write(
            &source,
            "# Preferences\n- Keep answers concise\n- Use Chinese by default\n\n# Project\nThe current task remains active.",
        )
        .unwrap();
        let preview = crate::experimental_foundation::inspect_memory_dual_read_parity_at(
            &root,
            &crate::experimental_foundation::MemoryImportRequest {
                source_path: source.display().to_string(),
                user_id: "user-1".to_string(),
                workspace_id: Some("workspace-1".to_string()),
                expected_source_sha256: Some(sha256_hex(&fs::read(&source).unwrap())),
            },
        )
        .unwrap();
        assert!(preview.mismatch_count > 0);
        let source_sha256 = sha256_hex(&fs::read(&source).unwrap());
        crate::experimental_foundation::execute_memory_import_at(
            &root,
            crate::experimental_foundation::MemoryImportRequest {
                source_path: source.display().to_string(),
                user_id: "user-1".to_string(),
                workspace_id: Some("workspace-1".to_string()),
                expected_source_sha256: Some(source_sha256.clone()),
            },
        )
        .unwrap();
        crate::experimental_memory_recovery::initialize_at(&root).unwrap();
        initialize_at(&root).unwrap();
        (temp, root, source, source_sha256)
    }

    fn memory_state(root: &Path) -> crate::experimental_memory_recovery::MemoryFileSnapshot {
        crate::experimental_memory_recovery::capture_memory_file(
            &crate::experimental_memory_recovery::memory_path(root),
            None,
        )
        .unwrap()
    }

    fn dual_input(
        source: &Path,
        source_sha256: &str,
        memory_sha256: &str,
    ) -> AssessMemoryDualReadInput {
        AssessMemoryDualReadInput {
            operation_id: "dual-read-1".to_string(),
            source_path: source.display().to_string(),
            user_id: "user-1".to_string(),
            workspace_id: Some("workspace-1".to_string()),
            expected_source_sha256: source_sha256.to_string(),
            expected_memory_sha256: memory_sha256.to_string(),
            idempotency_key: "dual-read-key-1".to_string(),
        }
    }

    fn completed_recovery(
        root: &Path,
        memory_sha256: &str,
    ) -> crate::experimental_memory_recovery::MemoryRecoveryReceipt {
        let prepared = crate::experimental_memory_recovery::prepare_at(
            root,
            crate::experimental_memory_recovery::PrepareMemoryRecoveryDrillInput {
                operation_id: "promotion-recovery-drill".to_string(),
                expected_memory_sha256: memory_sha256.to_string(),
                idempotency_key: "promotion-recovery-prepare".to_string(),
            },
        )
        .unwrap();
        crate::experimental_memory_recovery::reconcile_at(
            root,
            crate::experimental_memory_recovery::ReconcileMemoryRecoveryDrillInput {
                operation_id: "promotion-recovery-drill".to_string(),
                expected_prepared_record_sha256: prepared.record_sha256,
                idempotency_key: "promotion-recovery-reconcile".to_string(),
            },
        )
        .unwrap()
    }

    #[test]
    fn disabled_status_does_not_create_files() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("never-created");
        let status = status_at(&root, false);
        assert!(!status.enabled);
        assert!(!status.ready);
        assert!(!root.exists());
        assert!(!status.production_integration);
    }

    #[test]
    fn parity_and_authority_proposal_are_durable_and_effect_free() {
        let (_temp, root, source, source_sha256) = setup();
        let memory = memory_state(&root);
        let recovery = completed_recovery(&root, &memory.sha256);
        let parity_input = dual_input(&source, &source_sha256, &memory.sha256);
        let parity = assess_dual_read_at(&root, parity_input.clone()).unwrap();
        assert_eq!(parity.phase, "parity_confirmed");
        assert!(parity.promotion_eligible);
        assert!(!parity.dual_read_enabled);
        let parity_duplicate = assess_dual_read_at(&root, parity_input).unwrap();
        assert!(parity_duplicate.duplicate);
        assert_eq!(parity_duplicate.record_sha256, parity.record_sha256);
        let proposal_input = PrepareMemoryAuthoritySwitchInput {
            operation_id: "authority-switch-1".to_string(),
            dual_read_record_sha256: parity.record_sha256,
            recovery_record_sha256: recovery.record_sha256,
            expected_memory_sha256: memory.sha256,
            idempotency_key: "authority-switch-key-1".to_string(),
        };
        let proposal = prepare_authority_switch_at(&root, proposal_input.clone()).unwrap();
        assert_eq!(proposal.phase, "awaiting_operator");
        assert!(proposal.operator_action_required);
        assert!(!proposal.authority_switch_applied);
        assert!(!proposal.restore_performed);
        assert!(!proposal.production_memory_mutated);
        assert_eq!(proposal.external_effects, 0);
        let proposal_duplicate = prepare_authority_switch_at(&root, proposal_input).unwrap();
        assert!(proposal_duplicate.duplicate);
        assert_eq!(proposal_duplicate.record_sha256, proposal.record_sha256);
        let inspection = inspect_journal_at(&root).unwrap();
        assert_eq!(inspection.parity_confirmed_count, 1);
        assert_eq!(inspection.operator_proposal_count, 1);
    }

    #[test]
    fn mismatch_cannot_create_an_authority_proposal() {
        let (_temp, root, source, source_sha256) = setup();
        let database = crate::experimental_memory_recovery::memory_path(&root);
        let connection = Connection::open(&database).unwrap();
        connection
            .execute(
                "UPDATE memory_item SET content_text = 'drift', version = version + 1, updated_at = ?1 WHERE rowid = (SELECT MIN(rowid) FROM memory_item)",
                [Utc::now().to_rfc3339()],
            )
            .unwrap();
        drop(connection);
        let memory = memory_state(&root);
        let parity =
            assess_dual_read_at(&root, dual_input(&source, &source_sha256, &memory.sha256))
                .unwrap();
        assert_eq!(parity.phase, "parity_failed");
        assert!(parity.mismatch_count > 0);
        let error = prepare_authority_switch_at(
            &root,
            PrepareMemoryAuthoritySwitchInput {
                operation_id: "authority-switch-rejected".to_string(),
                dual_read_record_sha256: parity.record_sha256,
                recovery_record_sha256: "a".repeat(64),
                expected_memory_sha256: memory.sha256,
                idempotency_key: "authority-switch-rejected-key".to_string(),
            },
        )
        .unwrap_err();
        assert!(error.contains("Confirmed dual-read"));
    }

    #[test]
    fn corrupt_database_is_sealed_and_restore_remains_a_proposal() {
        let (_temp, root, _source, _source_sha256) = setup();
        let memory = memory_state(&root);
        let recovery = completed_recovery(&root, &memory.sha256);
        let candidate = root.join(recovery.snapshot_relative_path);
        let database = crate::experimental_memory_recovery::memory_path(&root);
        fs::write(
            &database,
            b"not a sqlite database; retain exactly for evidence",
        )
        .unwrap();
        let wal = incident_sidecar_path(&database, "-wal").unwrap();
        fs::write(&wal, b"malformed WAL bytes must still be sealed").unwrap();
        let journal = incident_sidecar_path(&database, "-journal").unwrap();
        fs::write(&journal, b"retain the incident journal exactly as observed").unwrap();
        let corrupt = memory_state(&root);
        let original = fs::read(&database).unwrap();
        let original_wal = fs::read(&wal).unwrap();
        let original_journal = fs::read(&journal).unwrap();
        let forensic = capture_raw_forensic_at(
            &root,
            CaptureRawForensicEvidenceInput {
                operation_id: "raw-incident-1".to_string(),
                expected_memory_sha256: corrupt.sha256,
                incident_reason_sha256: "b".repeat(64),
                idempotency_key: "raw-incident-key-1".to_string(),
            },
        )
        .unwrap();
        assert!(forensic.raw_forensic_evidence_sealed);
        let evidence = root.join(forensic.evidence_relative_path.clone().unwrap());
        let (manifest, manifest_sha256) =
            validate_forensic_bundle(&root, "raw-incident-1", &evidence).unwrap();
        assert_eq!(
            forensic.evidence_sha256.as_deref(),
            Some(manifest_sha256.as_str())
        );
        assert_eq!(
            fs::read(
                evidence
                    .parent()
                    .unwrap()
                    .join(&manifest.database.relative_path)
            )
            .unwrap(),
            original
        );
        let wal_entry = manifest
            .sidecars
            .iter()
            .find(|entry| entry.source_suffix == "-wal")
            .unwrap();
        assert_eq!(
            fs::read(evidence.parent().unwrap().join(&wal_entry.relative_path)).unwrap(),
            original_wal
        );
        let journal_entry = manifest
            .sidecars
            .iter()
            .find(|entry| entry.source_suffix == "-journal")
            .unwrap();
        assert_eq!(
            fs::read(
                evidence
                    .parent()
                    .unwrap()
                    .join(&journal_entry.relative_path)
            )
            .unwrap(),
            original_journal
        );
        let candidate_sha256 = sha256_hex(&fs::read(&candidate).unwrap());
        let unsigned_candidate = candidate
            .parent()
            .unwrap()
            .join("unsigned-lookalike.sqlite");
        fs::copy(&candidate, &unsigned_candidate).unwrap();
        set_file_mode(&unsigned_candidate, 0o400).unwrap();
        let unsigned_error = prepare_manual_restore_at(
            &root,
            PrepareManualRestoreProposalInput {
                operation_id: "manual-restore-unsigned".to_string(),
                forensic_record_sha256: forensic.record_sha256.clone(),
                recovery_record_sha256: recovery.record_sha256.clone(),
                candidate_path: unsigned_candidate.display().to_string(),
                expected_candidate_sha256: candidate_sha256.clone(),
                idempotency_key: "manual-restore-unsigned-key".to_string(),
            },
        )
        .unwrap_err();
        assert!(unsigned_error.contains("not the snapshot bound to its signed record"));
        let proposal = prepare_manual_restore_at(
            &root,
            PrepareManualRestoreProposalInput {
                operation_id: "manual-restore-1".to_string(),
                forensic_record_sha256: forensic.record_sha256,
                recovery_record_sha256: recovery.record_sha256,
                candidate_path: candidate.display().to_string(),
                expected_candidate_sha256: candidate_sha256,
                idempotency_key: "manual-restore-key-1".to_string(),
            },
        )
        .unwrap();
        assert_eq!(proposal.phase, "awaiting_operator");
        assert!(!proposal.restore_performed);
        assert_eq!(fs::read(&database).unwrap(), original);
        assert_eq!(fs::read(&wal).unwrap(), original_wal);
        assert_eq!(fs::read(&journal).unwrap(), original_journal);
    }

    #[test]
    fn dual_read_source_cannot_escape_or_hardlink_into_the_isolated_profile() {
        let (_temp, root, source, source_sha256) = setup();
        let memory = memory_state(&root);
        let outside = tempfile::tempdir().unwrap();
        let outside_source = outside.path().join("legacy-memory.md");
        fs::copy(&source, &outside_source).unwrap();
        let outside_error = assess_dual_read_at(
            &root,
            dual_input(&outside_source, &source_sha256, &memory.sha256),
        )
        .unwrap_err();
        assert!(outside_error.contains("inside the isolated profile"));

        let hardlink = root.join("legacy-memory-hardlink.md");
        fs::hard_link(&source, &hardlink).unwrap();
        let hardlink_error =
            assess_dual_read_at(&root, dual_input(&hardlink, &source_sha256, &memory.sha256))
                .unwrap_err();
        assert!(hardlink_error.contains("exactly one filesystem link"));
        assert_eq!(inspect_journal_at(&root).unwrap().journal_record_count, 0);
    }

    #[test]
    fn external_anchor_detects_whole_control_database_rollback() {
        let (_temp, root, source, source_sha256) = setup();
        let memory = memory_state(&root);
        let first = assess_dual_read_at(&root, dual_input(&source, &source_sha256, &memory.sha256))
            .unwrap();
        assert_eq!(first.phase, "parity_confirmed");
        let old_database = fs::read(control_path(&root)).unwrap();
        let mut second_input = dual_input(&source, &source_sha256, &memory.sha256);
        second_input.operation_id = "dual-read-2".to_string();
        second_input.idempotency_key = "dual-read-key-2".to_string();
        assess_dual_read_at(&root, second_input).unwrap();
        fs::write(control_path(&root), old_database).unwrap();
        let error = inspect_journal_at(&root).unwrap_err();
        assert!(error.contains("control-database rollback"));
    }

    #[cfg(unix)]
    #[test]
    fn restore_candidate_symlinks_fail_closed() {
        use std::os::unix::fs::symlink;
        let (_temp, root, _source, _source_sha256) = setup();
        let memory = memory_state(&root);
        let recovery = completed_recovery(&root, &memory.sha256);
        let candidate = root.join(&recovery.snapshot_relative_path);
        let link = root.join("memory-recovery-snapshots/candidate-link.sqlite");
        symlink(&candidate, &link).unwrap();
        assert!(validate_restore_candidate(&root, &link)
            .unwrap_err()
            .contains("symlink"));
    }
}
