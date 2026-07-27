//! Disabled-by-default production foundations for the provider-neutral runtime
//! journal and the database-native Memory v3 store.
//!
//! This module deliberately has no call-site in the current chat/session path.
//! The only public surface is an explicit Tauri command set guarded by two
//! environment feature flags.  That keeps v0.14.14 behaviour authoritative
//! while giving the next small version a durable, restart-safe integration
//! seam that can be exercised in an isolated profile.

use chrono::Utc;
use rusqlite::{params, Connection, OpenFlags, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;
use uuid::Uuid;

const FOUNDATION_SCHEMA_VERSION: u16 = 1;
const MEMORY_SCHEMA_VERSION: i64 = 3;
const RUNTIME_FLAG: &str = "BLACKBOX_EXPERIMENTAL_RUNTIME_V1";
const MEMORY_FLAG: &str = "BLACKBOX_EXPERIMENTAL_MEMORY_V3";
const HOME_OVERRIDE: &str = "BLACKBOX_EXPERIMENTAL_HOME";
const MAX_LEGACY_SOURCE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_IMPORT_ENTRIES: usize = 10_000;
const MAX_ENTRY_BYTES: usize = 64 * 1024;

const RUNTIME_SCHEMA_SQL: &str = include_str!("../resources/experimental/runtime-journal-v1.sql");
const MEMORY_SCHEMA_SQL: &str = include_str!("../resources/experimental/memory-v3.sql");

const MEMORY_TABLE_SHAPES: &[(&str, &[&str])] = &[
    (
        "schema_migration",
        &["component", "version", "applied_at", "checksum"],
    ),
    (
        "memory_event",
        &[
            "event_id",
            "tenant_id",
            "user_id",
            "workspace_id",
            "session_id",
            "event_kind",
            "observed_at",
            "source_uri",
            "content_text",
            "payload_json",
            "content_sha256",
            "idempotency_key",
            "idempotency_payload_sha256",
            "created_at",
        ],
    ),
    (
        "memory_item",
        &[
            "item_id",
            "tenant_id",
            "user_id",
            "workspace_id",
            "memory_kind",
            "lifecycle_state",
            "importance",
            "canonical_key",
            "title",
            "content_text",
            "attributes_json",
            "confidence",
            "decay_score",
            "first_observed_at",
            "last_reinforced_at",
            "next_review_at",
            "valid_from",
            "valid_until",
            "version",
            "created_at",
            "updated_at",
        ],
    ),
    (
        "memory_evidence",
        &[
            "tenant_id",
            "item_id",
            "event_id",
            "evidence_role",
            "excerpt_start",
            "excerpt_end",
            "added_at",
        ],
    ),
    (
        "legacy_memory_import",
        &[
            "import_id",
            "source_uri",
            "source_sha256",
            "generation",
            "imported_event_count",
            "imported_item_count",
            "status",
            "result_json",
            "created_at",
            "completed_at",
        ],
    ),
];

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FoundationComponentStatus {
    enabled: bool,
    initialized: bool,
    ready: bool,
    path: String,
    schema_version: Option<i64>,
    schema_sha256: String,
    blocked_reason: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExperimentalFoundationStatus {
    schema_version: u16,
    production_integration: bool,
    current_runtime_authority: &'static str,
    current_memory_authority: &'static str,
    runtime: FoundationComponentStatus,
    memory: FoundationComponentStatus,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NoEffectTurnInput {
    command_id: String,
    session_id: String,
    adapter_id: String,
    generation: u64,
    config_hash: String,
    policy_snapshot_hash: String,
    text: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NoEffectTurnReceipt {
    command_id: String,
    session_id: String,
    generation: u64,
    phase: String,
    journal_sequence: i64,
    canonical_payload_sha256: String,
    adapter_receipt_sha256: String,
    duplicate: bool,
    external_effects: u8,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MemoryImportRequest {
    pub(crate) source_path: String,
    pub(crate) user_id: String,
    pub(crate) workspace_id: Option<String>,
    pub(crate) expected_source_sha256: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MemoryImportPreview {
    source_path: String,
    source_sha256: String,
    source_bytes: u64,
    source_device: String,
    source_inode: String,
    event_count: usize,
    item_count: usize,
    confirmation_required: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MemoryImportReceipt {
    import_id: String,
    source_sha256: String,
    backup_sha256: String,
    backup_path: String,
    imported_event_count: usize,
    imported_item_count: usize,
    parity_verified: bool,
    duplicate: bool,
    current_reads_switched: bool,
}

#[derive(Clone, Debug)]
struct StoreInspection {
    initialized: bool,
    ready: bool,
    schema_version: Option<i64>,
    blocked_reason: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct DatabaseFileIdentity {
    device: String,
    inode: String,
    size: u64,
}

#[derive(Clone, Debug)]
pub(crate) struct MemoryStoreRecoveryInspection {
    pub(crate) initialized: bool,
    pub(crate) ready: bool,
    pub(crate) schema_version: Option<i64>,
    pub(crate) blocked_reason: Option<String>,
}

#[derive(Clone, Debug)]
pub(crate) struct MemoryDualReadParityInspection {
    pub(crate) source_sha256: String,
    pub(crate) source_device: String,
    pub(crate) source_inode: String,
    pub(crate) source_size: u64,
    pub(crate) compared_entry_count: u64,
    pub(crate) mismatch_count: u64,
}

#[derive(Clone, Debug)]
struct LegacyEntry {
    title: String,
    content: String,
}

#[derive(Clone, Debug)]
struct SourceSnapshot {
    display_path: String,
    bytes: Vec<u8>,
    sha256: String,
    device: String,
    inode: String,
}

struct InitLock {
    path: PathBuf,
}

impl Drop for InitLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn now_rfc3339() -> String {
    Utc::now().to_rfc3339()
}

fn now_ms() -> i64 {
    Utc::now().timestamp_millis()
}

fn feature_enabled(name: &str) -> bool {
    std::env::var(name)
        .ok()
        .map(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(false)
}

fn foundation_root() -> Result<PathBuf, String> {
    if let Some(value) = std::env::var_os(HOME_OVERRIDE) {
        let path = PathBuf::from(value);
        if !path.is_absolute() {
            return Err(format!("{HOME_OVERRIDE} must be an absolute path"));
        }
        return Ok(path);
    }
    Ok(crate::safe_data_dir()?.join("experimental-foundation-v1"))
}

fn validate_isolated_root(path: PathBuf, production_root: &Path) -> Result<PathBuf, String> {
    crate::experimental_memory_recovery::validate_isolated_root(path, production_root)
}

fn isolated_foundation_root(feature: &str) -> Result<PathBuf, String> {
    require_enabled(feature_enabled(feature), feature)?;
    let value = std::env::var_os(HOME_OVERRIDE)
        .ok_or_else(|| format!("{HOME_OVERRIDE} is required for every experimental mutation"))?;
    validate_isolated_root(PathBuf::from(value), &crate::safe_data_dir()?)
}

fn runtime_path(root: &Path) -> PathBuf {
    root.join("runtime-journal-v1.sqlite")
}

pub(crate) fn memory_path(root: &Path) -> PathBuf {
    root.join("memory-v3.sqlite")
}

fn backup_dir(root: &Path) -> PathBuf {
    root.join("legacy-memory-backups")
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
fn set_file_private(path: &Path, mode: u32) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(mode))
        .map_err(|error| format!("Failed to secure {}: {error}", path.display()))
}

#[cfg(not(unix))]
fn set_file_private(_path: &Path, _mode: u32) -> Result<(), String> {
    Ok(())
}

fn ensure_private_root(root: &Path) -> Result<(), String> {
    if root.exists() {
        let metadata = fs::symlink_metadata(root)
            .map_err(|error| format!("Failed to inspect {}: {error}", root.display()))?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err("Experimental foundation root must be a real directory".to_string());
        }
    } else {
        fs::create_dir_all(root)
            .map_err(|error| format!("Failed to create {}: {error}", root.display()))?;
    }
    set_directory_private(root)
}

fn acquire_init_lock(root: &Path) -> Result<InitLock, String> {
    ensure_private_root(root)?;
    let path = root.join(".foundation-init.lock");
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&path).map_err(|error| {
        format!("Another foundation initializer is active or the prior run did not settle: {error}")
    })?;
    file.write_all(Uuid::new_v4().to_string().as_bytes())
        .map_err(|error| format!("Failed to write initializer lock: {error}"))?;
    file.sync_all()
        .map_err(|error| format!("Failed to sync initializer lock: {error}"))?;
    Ok(InitLock { path })
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

fn database_file_identity(
    path: &Path,
    label: &str,
) -> Result<Option<DatabaseFileIdentity>, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
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
        return Ok(Some(DatabaseFileIdentity {
            device: metadata.dev().to_string(),
            inode: metadata.ino().to_string(),
            size: metadata.len(),
        }));
    }
    #[cfg(not(unix))]
    Ok(Some(DatabaseFileIdentity {
        device: "unsupported".to_string(),
        inode: fs::canonicalize(path)
            .map_err(|error| format!("Failed to resolve {label}: {error}"))?
            .display()
            .to_string(),
        size: metadata.len(),
    }))
}

fn require_same_database_identity(
    path: &Path,
    label: &str,
    expected: &DatabaseFileIdentity,
) -> Result<(), String> {
    let current = database_file_identity(path, label)?
        .ok_or_else(|| format!("{label} disappeared during the operation"))?;
    if &current == expected {
        Ok(())
    } else {
        Err(format!("{label} identity changed during the operation"))
    }
}

fn open_read_only(path: &Path) -> Result<Connection, String> {
    let path =
        crate::experimental_memory_recovery::normalize_platform_root_alias(path.to_path_buf());
    let connection = Connection::open_with_flags(
        &path,
        OpenFlags::SQLITE_OPEN_READ_ONLY
            | OpenFlags::SQLITE_OPEN_NO_MUTEX
            | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )
    .map_err(|error| format!("Failed to inspect {}: {error}", path.display()))?;
    connection
        .busy_timeout(Duration::from_secs(2))
        .map_err(|error| format!("Failed to configure SQLite inspection: {error}"))?;
    connection
        .pragma_update(None, "query_only", true)
        .map_err(|error| format!("Failed to make SQLite inspection read-only: {error}"))?;
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
    .map_err(|error| format!("Failed to open {}: {error}", path.display()))?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(|error| format!("Failed to configure SQLite writer: {error}"))?;
    connection
        .pragma_update(None, "foreign_keys", true)
        .map_err(|error| format!("Failed to enable SQLite foreign keys: {error}"))?;
    connection
        .pragma_update(None, "synchronous", "FULL")
        .map_err(|error| format!("Failed to enable durable SQLite writes: {error}"))?;
    Ok(connection)
}

fn sqlite_quick_check(connection: &Connection) -> Result<(), String> {
    let result: String = connection
        .query_row("PRAGMA quick_check", [], |row| row.get(0))
        .map_err(|error| format!("SQLite quick_check failed to run: {error}"))?;
    if result == "ok" {
        Ok(())
    } else {
        Err(format!("SQLite quick_check reported {result}"))
    }
}

fn table_columns(connection: &Connection, table: &str) -> Result<Vec<String>, String> {
    let quoted = table.replace('"', "\"\"");
    let mut statement = connection
        .prepare(&format!("PRAGMA table_info(\"{quoted}\")"))
        .map_err(|error| format!("Failed to inspect {table}: {error}"))?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| format!("Failed to read {table} columns: {error}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Failed to decode {table} columns: {error}"))
}

fn inspect_runtime_store(path: &Path) -> StoreInspection {
    if !path.exists() {
        return StoreInspection {
            initialized: false,
            ready: false,
            schema_version: None,
            blocked_reason: None,
        };
    }
    let result = (|| -> Result<i64, String> {
        let connection = open_read_only(path)?;
        sqlite_quick_check(&connection)?;
        let expected_hash = sha256_hex(RUNTIME_SCHEMA_SQL.as_bytes());
        let (version, stored_hash): (i64, String) = connection
            .query_row(
                "SELECT schema_version, schema_sha256 FROM blackbox_runtime_meta WHERE id = 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(|error| format!("Runtime schema metadata is missing: {error}"))?;
        if version != 1 || stored_hash != expected_hash {
            return Err("Runtime schema identity mismatch".to_string());
        }
        for table in ["runtime_session", "runtime_command", "runtime_journal"] {
            let exists: i64 = connection
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                    [table],
                    |row| row.get(0),
                )
                .map_err(|error| format!("Failed to inspect runtime table {table}: {error}"))?;
            if exists != 1 {
                return Err(format!("Runtime schema is missing {table}"));
            }
        }
        Ok(version)
    })();
    match result {
        Ok(version) => StoreInspection {
            initialized: true,
            ready: true,
            schema_version: Some(version),
            blocked_reason: None,
        },
        Err(error) => StoreInspection {
            initialized: true,
            ready: false,
            schema_version: None,
            blocked_reason: Some(error),
        },
    }
}

fn inspect_memory_store(path: &Path) -> StoreInspection {
    let identity = match database_file_identity(path, "Experimental Memory database") {
        Ok(Some(identity)) => identity,
        Ok(None) => {
            return StoreInspection {
                initialized: false,
                ready: false,
                schema_version: None,
                blocked_reason: None,
            }
        }
        Err(error) => {
            return StoreInspection {
                initialized: true,
                ready: false,
                schema_version: None,
                blocked_reason: Some(error),
            }
        }
    };
    let result = (|| -> Result<i64, String> {
        let connection = open_read_only(path)?;
        require_same_database_identity(path, "Experimental Memory database", &identity)?;
        sqlite_quick_check(&connection)?;
        let (version, stored_hash): (i64, String) = connection
            .query_row(
                "SELECT version, checksum FROM schema_migration WHERE component = 'memory' ORDER BY version DESC LIMIT 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(|error| format!("Memory schema metadata is missing: {error}"))?;
        let expected_hash = sha256_hex(MEMORY_SCHEMA_SQL.as_bytes());
        if version != MEMORY_SCHEMA_VERSION || stored_hash != expected_hash {
            return Err(format!(
                "Memory schema identity mismatch (found version {version})"
            ));
        }
        for (table, expected) in MEMORY_TABLE_SHAPES {
            let actual = table_columns(&connection, table)?;
            let expected: Vec<String> = expected.iter().map(|value| (*value).to_string()).collect();
            if actual != expected {
                return Err(format!("Memory table shape mismatch: {table}"));
            }
        }
        let fts_exists: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'memory_item_fts'",
                [],
                |row| row.get(0),
            )
            .map_err(|error| format!("Failed to inspect Memory FTS table: {error}"))?;
        if fts_exists != 1 {
            return Err("Memory schema is missing memory_item_fts".to_string());
        }
        require_same_database_identity(path, "Experimental Memory database", &identity)?;
        Ok(version)
    })();
    match result {
        Ok(version) => StoreInspection {
            initialized: true,
            ready: true,
            schema_version: Some(version),
            blocked_reason: None,
        },
        Err(error) => StoreInspection {
            initialized: true,
            ready: false,
            schema_version: None,
            blocked_reason: Some(error),
        },
    }
}

pub(crate) fn inspect_memory_store_for_recovery(path: &Path) -> MemoryStoreRecoveryInspection {
    let inspection = inspect_memory_store(path);
    let detected_schema_version = inspection.schema_version.or_else(|| {
        open_read_only(path).ok().and_then(|connection| {
            connection
                .query_row(
                    "SELECT version FROM schema_migration WHERE component = 'memory' ORDER BY version DESC LIMIT 1",
                    [],
                    |row| row.get(0),
                )
                .ok()
        })
    });
    MemoryStoreRecoveryInspection {
        initialized: inspection.initialized,
        ready: inspection.ready,
        schema_version: detected_schema_version,
        blocked_reason: inspection.blocked_reason,
    }
}

pub(crate) fn validate_memory_store_for_recovery(path: &Path) -> Result<(), String> {
    let inspection = inspect_memory_store(path);
    if inspection.ready {
        Ok(())
    } else {
        Err(inspection
            .blocked_reason
            .unwrap_or_else(|| "Experimental Memory store is not ready".to_string()))
    }
}

fn component_status(
    enabled: bool,
    path: &Path,
    schema_hash: String,
    inspection: StoreInspection,
) -> FoundationComponentStatus {
    FoundationComponentStatus {
        enabled,
        initialized: inspection.initialized,
        ready: enabled && inspection.ready,
        path: path.display().to_string(),
        schema_version: inspection.schema_version,
        schema_sha256: schema_hash,
        blocked_reason: inspection.blocked_reason,
    }
}

fn status_at(
    root: &Path,
    runtime_enabled: bool,
    memory_enabled: bool,
) -> ExperimentalFoundationStatus {
    let runtime_path = runtime_path(root);
    let memory_path = memory_path(root);
    ExperimentalFoundationStatus {
        schema_version: FOUNDATION_SCHEMA_VERSION,
        production_integration: false,
        current_runtime_authority: "claude-sdk-session-path",
        current_memory_authority: "existing-markdown-and-session-context",
        runtime: component_status(
            runtime_enabled,
            &runtime_path,
            sha256_hex(RUNTIME_SCHEMA_SQL.as_bytes()),
            inspect_runtime_store(&runtime_path),
        ),
        memory: component_status(
            memory_enabled,
            &memory_path,
            sha256_hex(MEMORY_SCHEMA_SQL.as_bytes()),
            inspect_memory_store(&memory_path),
        ),
    }
}

#[tauri::command]
pub(crate) fn get_experimental_foundation_status() -> Result<ExperimentalFoundationStatus, String> {
    let root = foundation_root()?;
    Ok(status_at(
        &root,
        feature_enabled(RUNTIME_FLAG),
        feature_enabled(MEMORY_FLAG),
    ))
}

fn create_runtime_store(path: &Path) -> Result<(), String> {
    let root = path.parent().ok_or("Runtime database path has no parent")?;
    let _lock = acquire_init_lock(root)?;
    if path.exists() {
        let inspection = inspect_runtime_store(path);
        return if inspection.ready {
            Ok(())
        } else {
            Err(inspection
                .blocked_reason
                .unwrap_or_else(|| "Runtime store is not ready".to_string()))
        };
    }
    let staging = root.join(format!(".runtime-journal-v1.{}.sqlite", Uuid::new_v4()));
    let result = (|| -> Result<(), String> {
        let connection = Connection::open(&staging)
            .map_err(|error| format!("Failed to create staged runtime store: {error}"))?;
        connection
            .busy_timeout(Duration::from_secs(5))
            .map_err(|error| format!("Failed to configure staged runtime store: {error}"))?;
        connection
            .execute_batch(RUNTIME_SCHEMA_SQL)
            .map_err(|error| format!("Failed to apply runtime schema: {error}"))?;
        connection
            .execute_batch(
                "CREATE TABLE blackbox_runtime_meta(\
                   id INTEGER PRIMARY KEY CHECK(id = 1),\
                   schema_version INTEGER NOT NULL CHECK(schema_version = 1),\
                   schema_sha256 TEXT NOT NULL,\
                   created_at_ms INTEGER NOT NULL\
                 );",
            )
            .map_err(|error| format!("Failed to create runtime schema metadata: {error}"))?;
        connection
            .execute(
                "INSERT INTO blackbox_runtime_meta(id, schema_version, schema_sha256, created_at_ms) VALUES(1, 1, ?1, ?2)",
                params![sha256_hex(RUNTIME_SCHEMA_SQL.as_bytes()), now_ms()],
            )
            .map_err(|error| format!("Failed to bind runtime schema identity: {error}"))?;
        sqlite_quick_check(&connection)?;
        drop(connection);
        set_file_private(&staging, 0o600)?;
        sync_file_and_parent(&staging)?;
        if path.exists() {
            return Err(
                "Runtime store appeared during initialization; refusing overwrite".to_string(),
            );
        }
        fs::rename(&staging, path)
            .map_err(|error| format!("Failed to publish runtime store: {error}"))?;
        sync_file_and_parent(path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&staging);
    }
    result
}

pub(crate) fn create_memory_store(path: &Path) -> Result<(), String> {
    let root = path.parent().ok_or("Memory database path has no parent")?;
    let _lease = crate::experimental_memory_recovery::acquire_host_wide_memory_lease(root)?;
    let _lock = acquire_init_lock(root)?;
    if database_file_identity(path, "Experimental Memory database")?.is_some() {
        let inspection = inspect_memory_store(path);
        return if inspection.ready {
            Ok(())
        } else {
            Err(inspection
                .blocked_reason
                .unwrap_or_else(|| "Memory store is not ready".to_string()))
        };
    }
    let staging = root.join(format!(".memory-v3.{}.sqlite", Uuid::new_v4()));
    let mut published = false;
    let result = (|| -> Result<(), String> {
        let staging_open_path =
            crate::experimental_memory_recovery::normalize_platform_root_alias(staging.clone());
        let connection = Connection::open_with_flags(
            &staging_open_path,
            OpenFlags::SQLITE_OPEN_READ_WRITE
                | OpenFlags::SQLITE_OPEN_CREATE
                | OpenFlags::SQLITE_OPEN_NO_MUTEX
                | OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )
        .map_err(|error| format!("Failed to create staged Memory store: {error}"))?;
        connection
            .busy_timeout(Duration::from_secs(5))
            .map_err(|error| format!("Failed to configure staged Memory store: {error}"))?;
        connection
            .execute_batch(MEMORY_SCHEMA_SQL)
            .map_err(|error| format!("Failed to apply Memory schema: {error}"))?;
        let applied_at = now_rfc3339();
        connection
            .execute(
                "INSERT INTO schema_migration(component, version, applied_at, checksum) VALUES('memory', 1, ?1, 'blackbox-memory-foundation-v1')",
                [&applied_at],
            )
            .map_err(|error| format!("Failed to record Memory v1 migration: {error}"))?;
        connection
            .execute(
                "INSERT INTO schema_migration(component, version, applied_at, checksum) VALUES('memory', 2, ?1, 'blackbox-memory-scope-v2')",
                [&applied_at],
            )
            .map_err(|error| format!("Failed to record Memory v2 migration: {error}"))?;
        connection
            .execute(
                "INSERT INTO schema_migration(component, version, applied_at, checksum) VALUES('memory', 3, ?1, ?2)",
                params![applied_at, sha256_hex(MEMORY_SCHEMA_SQL.as_bytes())],
            )
            .map_err(|error| format!("Failed to bind Memory v3 schema identity: {error}"))?;
        connection
            .pragma_update(None, "user_version", MEMORY_SCHEMA_VERSION)
            .map_err(|error| format!("Failed to set Memory schema version: {error}"))?;
        sqlite_quick_check(&connection)?;
        drop(connection);
        let staging_identity = database_file_identity(&staging, "Staged Memory database")?
            .ok_or("Staged Memory database disappeared before publication")?;
        set_file_private(&staging, 0o600)?;
        sync_file_and_parent(&staging)?;
        if database_file_identity(path, "Experimental Memory database")?.is_some() {
            return Err(
                "Memory store appeared during initialization; refusing overwrite".to_string(),
            );
        }
        fs::hard_link(&staging, path)
            .map_err(|error| format!("Failed to publish Memory store: {error}"))?;
        published = true;
        fs::remove_file(&staging)
            .map_err(|error| format!("Failed to settle Memory store: {error}"))?;
        require_same_database_identity(path, "Experimental Memory database", &staging_identity)?;
        sync_file_and_parent(path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&staging);
        if published {
            let _ = fs::remove_file(path);
        }
    }
    result
}

fn require_enabled(enabled: bool, feature: &str) -> Result<(), String> {
    if enabled {
        Ok(())
    } else {
        Err(format!(
            "Experimental foundation is disabled; set {feature}=1 only in an isolated profile"
        ))
    }
}

#[tauri::command]
pub(crate) fn initialize_experimental_runtime_fence() -> Result<ExperimentalFoundationStatus, String>
{
    let root = isolated_foundation_root(RUNTIME_FLAG)?;
    create_runtime_store(&runtime_path(&root))?;
    get_experimental_foundation_status()
}

#[tauri::command]
pub(crate) fn initialize_experimental_memory_store() -> Result<ExperimentalFoundationStatus, String>
{
    let root = isolated_foundation_root(MEMORY_FLAG)?;
    create_memory_store(&memory_path(&root))?;
    get_experimental_foundation_status()
}

fn validate_binding_token(name: &str, value: &str) -> Result<(), String> {
    let valid = !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-' | b':'));
    if valid {
        Ok(())
    } else {
        Err(format!("{name} is not a safe binding token"))
    }
}

fn record_no_effect_turn_at(
    root: &Path,
    input: NoEffectTurnInput,
) -> Result<NoEffectTurnReceipt, String> {
    validate_binding_token("commandId", &input.command_id)?;
    validate_binding_token("sessionId", &input.session_id)?;
    validate_binding_token("adapterId", &input.adapter_id)?;
    validate_binding_token("configHash", &input.config_hash)?;
    validate_binding_token("policySnapshotHash", &input.policy_snapshot_hash)?;
    if input.generation == 0 {
        return Err("generation must be greater than zero".to_string());
    }
    if input.text.is_empty() || input.text.len() > 1024 * 1024 {
        return Err("turn text must contain 1 byte to 1 MiB".to_string());
    }
    let path = runtime_path(root);
    let inspection = inspect_runtime_store(&path);
    if !inspection.ready {
        return Err(inspection
            .blocked_reason
            .unwrap_or_else(|| "Runtime fence is not initialized".to_string()));
    }
    let payload_hash = sha256_hex(input.text.as_bytes());
    let receipt_hash = sha256_hex(
        format!(
            "blackbox-no-effect-v1|{}|{}|{}|{}|{}",
            input.session_id,
            input.generation,
            input.command_id,
            payload_hash,
            input.policy_snapshot_hash
        )
        .as_bytes(),
    );
    let mut connection = open_read_write(&path)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("Failed to begin runtime fence transaction: {error}"))?;
    let existing_session: Option<(String, String, String)> = transaction
        .query_row(
            "SELECT adapter_id, config_hash, capability_snapshot_json FROM runtime_session WHERE session_id = ?1 AND generation = ?2",
            params![input.session_id, input.generation as i64],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(|error| format!("Failed to inspect runtime session binding: {error}"))?;
    let capability_json = r#"{"supportedCommandKinds":["turn.submit"]}"#;
    match existing_session {
        Some((adapter, config, capabilities))
            if adapter == input.adapter_id
                && config == input.config_hash
                && capabilities == capability_json => {}
        Some(_) => {
            return Err(
                "Runtime session binding already exists with different authority".to_string(),
            )
        }
        None => {
            let timestamp = now_ms();
            transaction
                .execute(
                    "INSERT INTO runtime_session(session_id, adapter_id, generation, config_hash, capability_snapshot_json, state, created_at_ms, updated_at_ms) VALUES(?1, ?2, ?3, ?4, ?5, 'running', ?6, ?6)",
                    params![
                        input.session_id,
                        input.adapter_id,
                        input.generation as i64,
                        input.config_hash,
                        capability_json,
                        timestamp
                    ],
                )
                .map_err(|error| format!("Failed to reserve runtime session: {error}"))?;
        }
    }
    let existing_command: Option<(String, String, String, Option<String>)> = transaction
        .query_row(
            "SELECT canonical_payload_hash, policy_snapshot_hash, phase, adapter_receipt_hash FROM runtime_command WHERE session_id = ?1 AND generation = ?2 AND command_id = ?3",
            params![input.session_id, input.generation as i64, input.command_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()
        .map_err(|error| format!("Failed to inspect runtime command reservation: {error}"))?;
    if let Some((stored_payload, stored_policy, phase, stored_receipt)) = existing_command {
        if stored_payload != payload_hash || stored_policy != input.policy_snapshot_hash {
            return Err("Command ID is already bound to a different payload or policy".to_string());
        }
        if phase != "completed" || stored_receipt.as_deref() != Some(receipt_hash.as_str()) {
            return Err(format!(
                "Command is in {phase}; explicit reconciliation is required before retry"
            ));
        }
        let sequence: i64 = transaction
            .query_row(
                "SELECT sequence FROM runtime_journal WHERE session_id = ?1 AND generation = ?2 AND command_id = ?3 AND phase = 'completed'",
                params![input.session_id, input.generation as i64, input.command_id],
                |row| row.get(0),
            )
            .map_err(|error| format!("Failed to read duplicate runtime receipt: {error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("Failed to close duplicate runtime transaction: {error}"))?;
        return Ok(NoEffectTurnReceipt {
            command_id: input.command_id,
            session_id: input.session_id,
            generation: input.generation,
            phase,
            journal_sequence: sequence,
            canonical_payload_sha256: payload_hash,
            adapter_receipt_sha256: receipt_hash,
            duplicate: true,
            external_effects: 0,
        });
    }
    let timestamp = now_ms();
    transaction
        .execute(
            "INSERT INTO runtime_command(session_id, generation, command_id, adapter_id, config_hash, command_kind, canonical_payload_hash, policy_snapshot_hash, phase, adapter_receipt_hash, outcome_code, created_at_ms, updated_at_ms, target_interaction_id) VALUES(?1, ?2, ?3, ?4, ?5, 'turn.submit', ?6, ?7, 'accepted', NULL, 'ACCEPTED', ?8, ?8, NULL)",
            params![
                input.session_id,
                input.generation as i64,
                input.command_id,
                input.adapter_id,
                input.config_hash,
                payload_hash,
                input.policy_snapshot_hash,
                timestamp
            ],
        )
        .map_err(|error| format!("Failed to accept runtime command: {error}"))?;
    transaction
        .execute(
            "INSERT INTO runtime_journal(session_id, generation, command_id, phase, command_kind, canonical_payload_hash, policy_snapshot_hash, adapter_receipt_hash, outcome_code, created_at_ms) VALUES(?1, ?2, ?3, 'dispatch_intent', 'turn.submit', ?4, ?5, NULL, 'NO_EFFECT_DISPATCH_INTENT', ?6)",
            params![input.session_id, input.generation as i64, input.command_id, payload_hash, input.policy_snapshot_hash, timestamp + 1],
        )
        .map_err(|error| format!("Failed to persist no-effect dispatch intent: {error}"))?;
    transaction
        .execute(
            "INSERT INTO runtime_journal(session_id, generation, command_id, phase, command_kind, canonical_payload_hash, policy_snapshot_hash, adapter_receipt_hash, outcome_code, created_at_ms) VALUES(?1, ?2, ?3, 'completed', 'turn.submit', ?4, ?5, ?6, 'NO_EFFECT_COMPLETED', ?7)",
            params![input.session_id, input.generation as i64, input.command_id, payload_hash, input.policy_snapshot_hash, receipt_hash, timestamp + 2],
        )
        .map_err(|error| format!("Failed to complete no-effect runtime command: {error}"))?;
    transaction
        .execute(
            "UPDATE runtime_session SET updated_at_ms = ?3 WHERE session_id = ?1 AND generation = ?2",
            params![input.session_id, input.generation as i64, timestamp + 2],
        )
        .map_err(|error| format!("Failed to advance runtime session timestamp: {error}"))?;
    let sequence: i64 = transaction
        .query_row(
            "SELECT sequence FROM runtime_journal WHERE session_id = ?1 AND generation = ?2 AND command_id = ?3 AND phase = 'completed'",
            params![input.session_id, input.generation as i64, input.command_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("Failed to read runtime completion receipt: {error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("Failed to commit runtime fence transaction: {error}"))?;
    Ok(NoEffectTurnReceipt {
        command_id: input.command_id,
        session_id: input.session_id,
        generation: input.generation,
        phase: "completed".to_string(),
        journal_sequence: sequence,
        canonical_payload_sha256: payload_hash,
        adapter_receipt_sha256: receipt_hash,
        duplicate: false,
        external_effects: 0,
    })
}

#[tauri::command]
pub(crate) fn record_experimental_no_effect_turn(
    input: NoEffectTurnInput,
) -> Result<NoEffectTurnReceipt, String> {
    record_no_effect_turn_at(&isolated_foundation_root(RUNTIME_FLAG)?, input)
}

#[cfg(unix)]
fn open_source_nofollow(path: &Path) -> Result<File, String> {
    use std::os::unix::fs::OpenOptionsExt;
    OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
        .map_err(|error| format!("Failed to open legacy source without following links: {error}"))
}

#[cfg(not(unix))]
fn open_source_nofollow(path: &Path) -> Result<File, String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("Failed to inspect legacy source: {error}"))?;
    if metadata.file_type().is_symlink() {
        return Err("Legacy source symlinks are not allowed".to_string());
    }
    OpenOptions::new()
        .read(true)
        .open(path)
        .map_err(|error| format!("Failed to open legacy source: {error}"))
}

fn read_source_snapshot(path: &Path) -> Result<SourceSnapshot, String> {
    if !path.is_absolute() {
        return Err("Legacy source path must be absolute".to_string());
    }
    let mut file = open_source_nofollow(path)?;
    let metadata = file
        .metadata()
        .map_err(|error| format!("Failed to inspect opened legacy source: {error}"))?;
    if !metadata.is_file() {
        return Err("Legacy source must be a regular file".to_string());
    }
    if metadata.len() > MAX_LEGACY_SOURCE_BYTES {
        return Err(format!(
            "Legacy source exceeds the {} byte limit",
            MAX_LEGACY_SOURCE_BYTES
        ));
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.read_to_end(&mut bytes)
        .map_err(|error| format!("Failed to read legacy source descriptor: {error}"))?;
    if bytes.len() as u64 != metadata.len() {
        return Err("Legacy source size changed during descriptor read".to_string());
    }
    std::str::from_utf8(&bytes).map_err(|_| "Legacy source must be UTF-8 Markdown".to_string())?;
    #[cfg(unix)]
    let (device, inode) = {
        use std::os::unix::fs::MetadataExt;
        (metadata.dev().to_string(), metadata.ino().to_string())
    };
    #[cfg(not(unix))]
    let (device, inode) = ("unsupported".to_string(), "unsupported".to_string());
    Ok(SourceSnapshot {
        display_path: path.display().to_string(),
        sha256: sha256_hex(&bytes),
        bytes,
        device,
        inode,
    })
}

fn clean_markdown_prefix(line: &str) -> &str {
    let trimmed = line.trim();
    for prefix in ["- ", "* ", "+ "] {
        if let Some(value) = trimmed.strip_prefix(prefix) {
            return value.trim();
        }
    }
    let digit_count = trimmed
        .chars()
        .take_while(|character| character.is_ascii_digit())
        .count();
    if digit_count > 0 {
        let remainder = &trimmed[digit_count..];
        if let Some(value) = remainder.strip_prefix(". ") {
            return value.trim();
        }
    }
    trimmed
}

fn parse_legacy_markdown(bytes: &[u8]) -> Result<Vec<LegacyEntry>, String> {
    let text = std::str::from_utf8(bytes)
        .map_err(|_| "Legacy source must be UTF-8 Markdown".to_string())?;
    let mut entries = Vec::new();
    let mut heading = "Imported memory".to_string();
    let mut paragraph = Vec::new();
    let flush = |entries: &mut Vec<LegacyEntry>, heading: &str, paragraph: &mut Vec<String>| {
        if paragraph.is_empty() {
            return;
        }
        let content = paragraph.join(" ").trim().to_string();
        paragraph.clear();
        if !content.is_empty() {
            entries.push(LegacyEntry {
                title: heading.to_string(),
                content,
            });
        }
    };
    for raw_line in text.lines() {
        let line = raw_line.trim();
        if line.is_empty() {
            flush(&mut entries, &heading, &mut paragraph);
            continue;
        }
        if line.starts_with('#') {
            flush(&mut entries, &heading, &mut paragraph);
            let title = line.trim_start_matches('#').trim();
            if !title.is_empty() {
                heading = title.to_string();
            }
            continue;
        }
        let cleaned = clean_markdown_prefix(line);
        let is_list = cleaned.len() != line.len();
        if is_list {
            flush(&mut entries, &heading, &mut paragraph);
            if !cleaned.is_empty() {
                entries.push(LegacyEntry {
                    title: heading.clone(),
                    content: cleaned.to_string(),
                });
            }
        } else {
            paragraph.push(cleaned.to_string());
        }
        if entries.len() + paragraph.len() > MAX_IMPORT_ENTRIES {
            return Err(format!(
                "Legacy source exceeds {MAX_IMPORT_ENTRIES} import entries"
            ));
        }
    }
    flush(&mut entries, &heading, &mut paragraph);
    entries.retain(|entry| !entry.content.trim().is_empty());
    if entries.is_empty() && !text.trim().is_empty() {
        entries.push(LegacyEntry {
            title: "Imported memory".to_string(),
            content: text.trim().to_string(),
        });
    }
    if entries.len() > MAX_IMPORT_ENTRIES {
        return Err(format!(
            "Legacy source exceeds {MAX_IMPORT_ENTRIES} import entries"
        ));
    }
    if let Some(entry) = entries
        .iter()
        .find(|entry| entry.content.len() > MAX_ENTRY_BYTES)
    {
        return Err(format!(
            "Legacy entry '{}' exceeds the {} byte limit",
            entry.title, MAX_ENTRY_BYTES
        ));
    }
    Ok(entries)
}

fn preview_memory_import_at(
    request: &MemoryImportRequest,
) -> Result<(MemoryImportPreview, SourceSnapshot, Vec<LegacyEntry>), String> {
    validate_binding_token("userId", &request.user_id)?;
    if let Some(workspace_id) = &request.workspace_id {
        validate_binding_token("workspaceId", workspace_id)?;
    }
    let snapshot = read_source_snapshot(Path::new(&request.source_path))?;
    if let Some(expected) = &request.expected_source_sha256 {
        if expected != &snapshot.sha256 {
            return Err("Legacy source hash changed after preview".to_string());
        }
    }
    let entries = parse_legacy_markdown(&snapshot.bytes)?;
    let preview = MemoryImportPreview {
        source_path: snapshot.display_path.clone(),
        source_sha256: snapshot.sha256.clone(),
        source_bytes: snapshot.bytes.len() as u64,
        source_device: snapshot.device.clone(),
        source_inode: snapshot.inode.clone(),
        event_count: entries.len(),
        item_count: entries.len(),
        confirmation_required: request.expected_source_sha256.is_none(),
    };
    Ok((preview, snapshot, entries))
}

#[tauri::command]
pub(crate) fn preview_experimental_memory_import(
    request: MemoryImportRequest,
) -> Result<MemoryImportPreview, String> {
    isolated_foundation_root(MEMORY_FLAG)?;
    preview_memory_import_at(&request).map(|(preview, _, _)| preview)
}

fn preserve_source_backup(
    root: &Path,
    import_id: &str,
    snapshot: &SourceSnapshot,
) -> Result<(PathBuf, String), String> {
    let directory = backup_dir(root);
    fs::create_dir_all(&directory)
        .map_err(|error| format!("Failed to create legacy backup directory: {error}"))?;
    set_directory_private(&directory)?;
    let path = directory.join(format!("{import_id}.md"));
    if path.exists() {
        let existing = read_source_snapshot(&path)?;
        if existing.sha256 == snapshot.sha256 {
            return Ok((path, existing.sha256));
        }
        return Err("Existing legacy backup does not match the source hash".to_string());
    }
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&path)
        .map_err(|error| format!("Failed to create exclusive legacy backup: {error}"))?;
    if let Err(error) = file
        .write_all(&snapshot.bytes)
        .and_then(|_| file.sync_all())
    {
        let _ = fs::remove_file(&path);
        return Err(format!("Failed to persist legacy backup: {error}"));
    }
    drop(file);
    set_file_private(&path, 0o444)?;
    sync_file_and_parent(&path)?;
    Ok((path, snapshot.sha256.clone()))
}

fn verify_import_parity(
    transaction: &rusqlite::Transaction<'_>,
    snapshot: &SourceSnapshot,
    user_id: &str,
    workspace_id: Option<&str>,
    expected: usize,
) -> Result<(), String> {
    let (events, items, evidence): (i64, i64, i64) = transaction
        .query_row(
            "SELECT \
               (SELECT COUNT(*) FROM memory_event \
                WHERE tenant_id = 'local' AND user_id = ?3 AND workspace_id IS ?4 \
                  AND idempotency_key LIKE ?1), \
               (SELECT COUNT(*) FROM memory_item \
                WHERE tenant_id = 'local' AND user_id = ?3 AND workspace_id IS ?4 \
                  AND canonical_key LIKE ?2), \
               (SELECT COUNT(*) FROM memory_evidence evidence_link \
                JOIN memory_event event ON event.tenant_id = evidence_link.tenant_id \
                  AND event.event_id = evidence_link.event_id \
                JOIN memory_item item ON item.tenant_id = evidence_link.tenant_id \
                  AND item.item_id = evidence_link.item_id \
                WHERE event.tenant_id = 'local' \
                  AND event.user_id = ?3 AND event.workspace_id IS ?4 \
                  AND item.user_id = ?3 AND item.workspace_id IS ?4 \
                  AND event.idempotency_key LIKE ?1 \
                  AND item.canonical_key LIKE ?2)",
            params![
                format!("legacy_import:{}:%", snapshot.sha256),
                format!("legacy:{}:%", snapshot.sha256),
                user_id,
                workspace_id
            ],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(|error| format!("Failed to verify Memory import parity: {error}"))?;
    if events as usize != expected || items as usize != expected || evidence as usize != expected {
        return Err(format!(
            "Memory import parity mismatch: expected {expected}, found {events} events, {items} items and {evidence} evidence links"
        ));
    }
    Ok(())
}

pub(crate) fn execute_memory_import_at(
    root: &Path,
    request: MemoryImportRequest,
) -> Result<MemoryImportReceipt, String> {
    let _lease = crate::experimental_memory_recovery::acquire_host_wide_memory_lease(root)?;
    let expected_hash = request.expected_source_sha256.clone().ok_or_else(|| {
        "Execute import requires the exact sourceSha256 returned by preview".to_string()
    })?;
    let (_preview, snapshot, entries) = preview_memory_import_at(&request)?;
    if snapshot.sha256 != expected_hash {
        return Err("Legacy source hash changed after preview".to_string());
    }
    let database_path = memory_path(root);
    let database_identity = database_file_identity(&database_path, "Experimental Memory database")?
        .ok_or("Memory store is not initialized")?;
    let inspection = inspect_memory_store(&database_path);
    if !inspection.ready {
        return Err(inspection
            .blocked_reason
            .unwrap_or_else(|| "Memory store is not initialized".to_string()));
    }
    let import_id = format!("legacy_{}", &snapshot.sha256[..32]);
    let (backup_path, backup_sha256) = preserve_source_backup(root, &import_id, &snapshot)?;
    let after_backup = read_source_snapshot(Path::new(&request.source_path))?;
    if after_backup.sha256 != snapshot.sha256
        || after_backup.device != snapshot.device
        || after_backup.inode != snapshot.inode
    {
        return Err("Legacy source identity changed before import commit".to_string());
    }
    let mut connection = open_read_write(&database_path)?;
    require_same_database_identity(
        &database_path,
        "Experimental Memory database",
        &database_identity,
    )?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("Failed to begin Memory import transaction: {error}"))?;
    let existing: Option<(String, i64, i64, String)> = transaction
        .query_row(
            "SELECT status, imported_event_count, imported_item_count, result_json FROM legacy_memory_import WHERE import_id = ?1",
            [&import_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()
        .map_err(|error| format!("Failed to inspect prior Memory import: {error}"))?;
    if let Some((status, event_count, item_count, result_json)) = existing {
        if status != "completed" {
            return Err(format!(
                "Prior import is in {status}; explicit recovery is required"
            ));
        }
        let result: serde_json::Value = serde_json::from_str(&result_json)
            .map_err(|error| format!("Prior import receipt is malformed: {error}"))?;
        if result.get("sourceDevice").and_then(|value| value.as_str())
            != Some(snapshot.device.as_str())
            || result.get("sourceInode").and_then(|value| value.as_str())
                != Some(snapshot.inode.as_str())
        {
            return Err("Prior import identity does not match this source descriptor".to_string());
        }
        if event_count as usize != entries.len() || item_count as usize != entries.len() {
            return Err("Prior import receipt count does not match the current source".to_string());
        }
        verify_import_parity(
            &transaction,
            &snapshot,
            &request.user_id,
            request.workspace_id.as_deref(),
            entries.len(),
        )?;
        transaction
            .commit()
            .map_err(|error| format!("Failed to close duplicate Memory import: {error}"))?;
        return Ok(MemoryImportReceipt {
            import_id,
            source_sha256: snapshot.sha256,
            backup_sha256,
            backup_path: backup_path.display().to_string(),
            imported_event_count: event_count as usize,
            imported_item_count: item_count as usize,
            parity_verified: true,
            duplicate: true,
            current_reads_switched: false,
        });
    }
    let created_at = now_rfc3339();
    transaction
        .execute(
            "INSERT INTO legacy_memory_import(import_id, source_uri, source_sha256, generation, imported_event_count, imported_item_count, status, result_json, created_at, completed_at) VALUES(?1, ?2, ?3, 1, 0, 0, 'planned', '{}', ?4, NULL)",
            params![import_id, snapshot.display_path, snapshot.sha256, created_at],
        )
        .map_err(|error| format!("Failed to reserve Memory import: {error}"))?;
    let workspace = request.workspace_id.as_deref();
    for (index, entry) in entries.iter().enumerate() {
        let seed = format!("{}:{index}", snapshot.sha256);
        let event_id = format!(
            "legacy_event_{}",
            sha256_hex(format!("event:{seed}").as_bytes())
        );
        let item_id = format!(
            "legacy_item_{}",
            sha256_hex(format!("item:{seed}").as_bytes())
        );
        let content_sha = sha256_hex(entry.content.as_bytes());
        let canonical_key = format!("legacy:{}:{index}", snapshot.sha256);
        let idempotency_key = format!("legacy_import:{}:{index}", snapshot.sha256);
        let payload = serde_json::json!({
            "importId": import_id,
            "sourceSha256": snapshot.sha256,
            "ordinal": index,
        })
        .to_string();
        let payload_hash = sha256_hex(payload.as_bytes());
        transaction
            .execute(
                "INSERT INTO memory_event(event_id, tenant_id, user_id, workspace_id, session_id, event_kind, observed_at, source_uri, content_text, payload_json, content_sha256, idempotency_key, idempotency_payload_sha256, created_at) VALUES(?1, 'local', ?2, ?3, NULL, 'import', ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?4)",
                params![
                    event_id,
                    request.user_id,
                    workspace,
                    created_at,
                    snapshot.display_path,
                    entry.content,
                    payload,
                    content_sha,
                    idempotency_key,
                    payload_hash
                ],
            )
            .map_err(|error| format!("Failed to import Memory event {index}: {error}"))?;
        transaction
            .execute(
                "INSERT INTO memory_item(item_id, tenant_id, user_id, workspace_id, memory_kind, lifecycle_state, importance, canonical_key, title, content_text, attributes_json, confidence, decay_score, first_observed_at, last_reinforced_at, next_review_at, valid_from, valid_until, version, created_at, updated_at) VALUES(?1, 'local', ?2, ?3, 'episodic', 'candidate', 1, ?4, ?5, ?6, ?7, 1.0, 1.0, ?8, ?8, NULL, NULL, NULL, 1, ?8, ?8)",
                params![
                    item_id,
                    request.user_id,
                    workspace,
                    canonical_key,
                    entry.title,
                    entry.content,
                    serde_json::json!({"legacyImportId": import_id, "ordinal": index}).to_string(),
                    created_at
                ],
            )
            .map_err(|error| format!("Failed to import Memory item {index}: {error}"))?;
        transaction
            .execute(
                "INSERT INTO memory_evidence(tenant_id, item_id, event_id, evidence_role, excerpt_start, excerpt_end, added_at) VALUES('local', ?1, ?2, 'originates', 0, ?3, ?4)",
                params![item_id, event_id, entry.content.chars().count() as i64, created_at],
            )
            .map_err(|error| format!("Failed to link Memory evidence {index}: {error}"))?;
    }
    let result_json = serde_json::json!({
        "schemaVersion": 1,
        "sourceSha256": snapshot.sha256,
        "sourceDevice": snapshot.device,
        "sourceInode": snapshot.inode,
        "backupSha256": backup_sha256,
        "eventCount": entries.len(),
        "itemCount": entries.len(),
        "plaintextBackupRetained": true,
        "currentReadsSwitched": false,
    })
    .to_string();
    transaction
        .execute(
            "UPDATE legacy_memory_import SET imported_event_count = ?2, imported_item_count = ?2, status = 'completed', result_json = ?3, completed_at = ?4 WHERE import_id = ?1 AND status = 'planned'",
            params![import_id, entries.len() as i64, result_json, now_rfc3339()],
        )
        .map_err(|error| format!("Failed to complete Memory import receipt: {error}"))?;
    verify_import_parity(
        &transaction,
        &snapshot,
        &request.user_id,
        request.workspace_id.as_deref(),
        entries.len(),
    )?;
    require_same_database_identity(
        &database_path,
        "Experimental Memory database",
        &database_identity,
    )?;
    transaction
        .commit()
        .map_err(|error| format!("Failed to commit Memory import: {error}"))?;
    Ok(MemoryImportReceipt {
        import_id,
        source_sha256: snapshot.sha256,
        backup_sha256,
        backup_path: backup_path.display().to_string(),
        imported_event_count: entries.len(),
        imported_item_count: entries.len(),
        parity_verified: true,
        duplicate: false,
        current_reads_switched: false,
    })
}

pub(crate) fn inspect_memory_dual_read_parity_at(
    root: &Path,
    request: &MemoryImportRequest,
) -> Result<MemoryDualReadParityInspection, String> {
    let (preview, snapshot, entries) = preview_memory_import_at(request)?;
    let expected_source_sha256 = request
        .expected_source_sha256
        .as_deref()
        .ok_or("Dual-read assessment requires an exact expectedSourceSha256")?;
    if snapshot.sha256 != expected_source_sha256 {
        return Err("Legacy source hash changed before dual-read assessment".to_string());
    }
    let database = memory_path(root);
    let identity = database_file_identity(&database, "Experimental Memory database")?
        .ok_or("Memory store is not initialized")?;
    validate_memory_store_for_recovery(&database)?;
    let connection = open_read_only(&database)?;
    require_same_database_identity(&database, "Experimental Memory database", &identity)?;

    let mut mismatch_count = 0u64;
    for (index, entry) in entries.iter().enumerate() {
        let seed = format!("{}:{index}", snapshot.sha256);
        let event_id = format!(
            "legacy_event_{}",
            sha256_hex(format!("event:{seed}").as_bytes())
        );
        let item_id = format!(
            "legacy_item_{}",
            sha256_hex(format!("item:{seed}").as_bytes())
        );
        let expected_content_sha256 = sha256_hex(entry.content.as_bytes());
        let expected_canonical_key = format!("legacy:{}:{index}", snapshot.sha256);
        let expected_idempotency_key = format!("legacy_import:{}:{index}", snapshot.sha256);
        let workspace = request.workspace_id.as_deref();

        let event: Option<(String, String)> = connection
            .query_row(
                "SELECT content_sha256, idempotency_key FROM memory_event WHERE tenant_id = 'local' AND user_id = ?1 AND workspace_id IS ?2 AND event_id = ?3",
                params![request.user_id, workspace, event_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|error| format!("Failed to inspect dual-read event {index}: {error}"))?;
        let item: Option<(String, String, String, String, i64)> = connection
            .query_row(
                "SELECT title, content_text, canonical_key, lifecycle_state, version FROM memory_item WHERE tenant_id = 'local' AND user_id = ?1 AND workspace_id IS ?2 AND item_id = ?3",
                params![request.user_id, workspace, item_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
            )
            .optional()
            .map_err(|error| format!("Failed to inspect dual-read item {index}: {error}"))?;
        let evidence_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM memory_evidence WHERE tenant_id = 'local' AND item_id = ?1 AND event_id = ?2 AND evidence_role = 'originates'",
                params![item_id, event_id],
                |row| row.get(0),
            )
            .map_err(|error| format!("Failed to inspect dual-read evidence {index}: {error}"))?;

        let event_matches = event
            .map(|(content_sha256, idempotency_key)| {
                content_sha256 == expected_content_sha256
                    && idempotency_key == expected_idempotency_key
            })
            .unwrap_or(false);
        let item_matches = item
            .map(|(title, content, canonical_key, lifecycle, version)| {
                title == entry.title
                    && sha256_hex(content.as_bytes()) == expected_content_sha256
                    && canonical_key == expected_canonical_key
                    && lifecycle == "candidate"
                    && version == 1
            })
            .unwrap_or(false);
        if !event_matches || !item_matches || evidence_count != 1 {
            mismatch_count = mismatch_count.saturating_add(1);
        }
    }

    let workspace = request.workspace_id.as_deref();
    let source_event_pattern = format!("legacy_import:{}:%", snapshot.sha256);
    let source_item_pattern = format!("legacy:{}:%", snapshot.sha256);
    let (event_count, item_count, evidence_count): (i64, i64, i64) = connection
        .query_row(
            "SELECT \
               (SELECT COUNT(*) FROM memory_event WHERE tenant_id = 'local' AND user_id = ?3 AND workspace_id IS ?4 AND idempotency_key LIKE ?1), \
               (SELECT COUNT(*) FROM memory_item WHERE tenant_id = 'local' AND user_id = ?3 AND workspace_id IS ?4 AND canonical_key LIKE ?2), \
               (SELECT COUNT(*) FROM memory_evidence evidence_link \
                JOIN memory_event event ON event.tenant_id = evidence_link.tenant_id AND event.event_id = evidence_link.event_id \
                JOIN memory_item item ON item.tenant_id = evidence_link.tenant_id AND item.item_id = evidence_link.item_id \
                WHERE event.tenant_id = 'local' AND event.user_id = ?3 AND event.workspace_id IS ?4 \
                  AND item.user_id = ?3 AND item.workspace_id IS ?4 \
                  AND event.idempotency_key LIKE ?1 AND item.canonical_key LIKE ?2)",
            params![
                source_event_pattern,
                source_item_pattern,
                request.user_id,
                workspace
            ],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(|error| format!("Failed to inspect dual-read aggregate parity: {error}"))?;
    let expected = i64::try_from(entries.len())
        .map_err(|_| "Dual-read entry count exceeds SQLite range".to_string())?;
    for count in [event_count, item_count, evidence_count] {
        if count != expected {
            mismatch_count = mismatch_count.saturating_add(count.abs_diff(expected));
        }
    }
    require_same_database_identity(&database, "Experimental Memory database", &identity)?;
    let after = read_source_snapshot(Path::new(&preview.source_path))?;
    if after.sha256 != snapshot.sha256
        || after.device != snapshot.device
        || after.inode != snapshot.inode
        || after.bytes.len() != snapshot.bytes.len()
    {
        return Err("Legacy source identity changed during dual-read assessment".to_string());
    }

    Ok(MemoryDualReadParityInspection {
        source_sha256: snapshot.sha256,
        source_device: snapshot.device,
        source_inode: snapshot.inode,
        source_size: snapshot.bytes.len() as u64,
        compared_entry_count: entries.len() as u64,
        mismatch_count,
    })
}

#[tauri::command]
pub(crate) fn execute_experimental_memory_import(
    request: MemoryImportRequest,
) -> Result<MemoryImportReceipt, String> {
    let root = isolated_foundation_root(MEMORY_FLAG)?;
    execute_memory_import_at(&root, request)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn turn(command_id: &str) -> NoEffectTurnInput {
        NoEffectTurnInput {
            command_id: command_id.to_string(),
            session_id: "session-1".to_string(),
            adapter_id: "blackbox-owned-stub".to_string(),
            generation: 1,
            config_hash: "cfg-abc".to_string(),
            policy_snapshot_hash: "policy-abc".to_string(),
            text: "synthetic no-effect turn".to_string(),
        }
    }

    #[test]
    fn disabled_status_does_not_create_the_foundation_root() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("never-created");
        let status = status_at(&root, false, false);
        assert!(!status.runtime.enabled);
        assert!(!status.runtime.ready);
        assert!(!status.memory.enabled);
        assert!(!status.memory.ready);
        assert!(!root.exists());
        assert!(!status.production_integration);
    }

    #[test]
    fn isolated_root_rejects_relative_and_production_paths() {
        let production = Path::new("/Users/test/.blackbox");
        assert!(
            validate_isolated_root(PathBuf::from("relative"), production)
                .unwrap_err()
                .contains("absolute")
        );
        assert!(validate_isolated_root(
            PathBuf::from("/Users/test/.blackbox/experimental"),
            production
        )
        .unwrap_err()
        .contains("overlap"));
        assert!(
            validate_isolated_root(PathBuf::from("/Users/test"), production)
                .unwrap_err()
                .contains("overlap")
        );
        assert!(
            validate_isolated_root(PathBuf::from("/tmp/../tmp/foundation"), production)
                .unwrap_err()
                .contains("relative path")
        );
        let isolated =
            validate_isolated_root(PathBuf::from("/tmp/blackbox-foundation"), production).unwrap();
        #[cfg(target_os = "macos")]
        assert_eq!(isolated, PathBuf::from("/private/tmp/blackbox-foundation"));
        #[cfg(not(target_os = "macos"))]
        assert_eq!(isolated, PathBuf::from("/tmp/blackbox-foundation"));
    }

    #[test]
    fn runtime_fence_is_durable_idempotent_and_has_zero_external_effects() {
        let temp = tempfile::tempdir().unwrap();
        create_runtime_store(&runtime_path(temp.path())).unwrap();
        let first = record_no_effect_turn_at(temp.path(), turn("cmd-1")).unwrap();
        assert!(!first.duplicate);
        assert_eq!(first.external_effects, 0);
        let duplicate = record_no_effect_turn_at(temp.path(), turn("cmd-1")).unwrap();
        assert!(duplicate.duplicate);
        assert_eq!(
            duplicate.adapter_receipt_sha256,
            first.adapter_receipt_sha256
        );
        assert_eq!(duplicate.journal_sequence, first.journal_sequence);

        let connection = open_read_only(&runtime_path(temp.path())).unwrap();
        let phases: Vec<String> = connection
            .prepare("SELECT phase FROM runtime_journal ORDER BY sequence")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(phases, ["accepted", "dispatch_intent", "completed"]);
    }

    #[test]
    fn runtime_fence_rejects_binding_and_payload_reuse() {
        let temp = tempfile::tempdir().unwrap();
        create_runtime_store(&runtime_path(temp.path())).unwrap();
        record_no_effect_turn_at(temp.path(), turn("cmd-1")).unwrap();
        let mut drift = turn("cmd-1");
        drift.text = "different".to_string();
        assert!(record_no_effect_turn_at(temp.path(), drift)
            .unwrap_err()
            .contains("different payload"));
        let mut session_drift = turn("cmd-2");
        session_drift.config_hash = "cfg-other".to_string();
        assert!(record_no_effect_turn_at(temp.path(), session_drift)
            .unwrap_err()
            .contains("different authority"));
    }

    #[test]
    fn memory_store_import_is_transactional_idempotent_and_keeps_source_authoritative() {
        let temp = tempfile::tempdir().unwrap();
        create_memory_store(&memory_path(temp.path())).unwrap();
        let source = temp.path().join("legacy-memory.md");
        fs::write(
            &source,
            "# Preferences\n- Keep answers concise\n- Use Chinese by default\n\n# Project\nThe current task remains active.",
        )
        .unwrap();
        let original = fs::read(&source).unwrap();
        let request = MemoryImportRequest {
            source_path: source.display().to_string(),
            user_id: "user-1".to_string(),
            workspace_id: Some("workspace-1".to_string()),
            expected_source_sha256: None,
        };
        let (preview, _, _) = preview_memory_import_at(&request).unwrap();
        assert!(preview.confirmation_required);
        let confirmed = MemoryImportRequest {
            expected_source_sha256: Some(preview.source_sha256.clone()),
            ..request
        };
        let receipt = execute_memory_import_at(temp.path(), confirmed.clone()).unwrap();
        assert!(receipt.parity_verified);
        assert!(!receipt.current_reads_switched);
        assert!(!receipt.duplicate);
        assert_eq!(fs::read(&source).unwrap(), original);
        let duplicate = execute_memory_import_at(temp.path(), confirmed).unwrap();
        assert!(duplicate.duplicate);
        assert_eq!(duplicate.import_id, receipt.import_id);

        let connection = open_read_only(&memory_path(temp.path())).unwrap();
        let fts_hits: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM memory_item_fts WHERE memory_item_fts MATCH 'concise'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(fts_hits, 1);
    }

    #[test]
    fn memory_import_rejects_source_drift_before_writing() {
        let temp = tempfile::tempdir().unwrap();
        create_memory_store(&memory_path(temp.path())).unwrap();
        let source = temp.path().join("legacy-memory.md");
        fs::write(&source, "# One\nOriginal").unwrap();
        let request = MemoryImportRequest {
            source_path: source.display().to_string(),
            user_id: "user-1".to_string(),
            workspace_id: None,
            expected_source_sha256: None,
        };
        let (preview, _, _) = preview_memory_import_at(&request).unwrap();
        fs::write(&source, "# One\nChanged").unwrap();
        let error = execute_memory_import_at(
            temp.path(),
            MemoryImportRequest {
                expected_source_sha256: Some(preview.source_sha256),
                ..request
            },
        )
        .unwrap_err();
        assert!(error.contains("hash changed"));
        let connection = open_read_only(&memory_path(temp.path())).unwrap();
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM legacy_memory_import", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn duplicate_memory_import_fails_closed_when_owned_rows_are_missing() {
        let temp = tempfile::tempdir().unwrap();
        create_memory_store(&memory_path(temp.path())).unwrap();
        let source = temp.path().join("legacy-memory.md");
        fs::write(&source, "# One\nDurable evidence").unwrap();
        let request = MemoryImportRequest {
            source_path: source.display().to_string(),
            user_id: "user-1".to_string(),
            workspace_id: None,
            expected_source_sha256: None,
        };
        let (preview, _, _) = preview_memory_import_at(&request).unwrap();
        let confirmed = MemoryImportRequest {
            expected_source_sha256: Some(preview.source_sha256),
            ..request
        };
        execute_memory_import_at(temp.path(), confirmed.clone()).unwrap();

        let connection = open_read_write(&memory_path(temp.path())).unwrap();
        connection.execute("DELETE FROM memory_item", []).unwrap();
        drop(connection);

        let error = execute_memory_import_at(temp.path(), confirmed).unwrap_err();
        assert!(error.contains("parity mismatch"));
    }

    #[cfg(unix)]
    #[test]
    fn memory_import_rejects_symlink_sources() {
        use std::os::unix::fs::symlink;
        let temp = tempfile::tempdir().unwrap();
        let real = temp.path().join("real.md");
        let link = temp.path().join("link.md");
        fs::write(&real, "fixture").unwrap();
        symlink(&real, &link).unwrap();
        let request = MemoryImportRequest {
            source_path: link.display().to_string(),
            user_id: "user-1".to_string(),
            workspace_id: None,
            expected_source_sha256: None,
        };
        assert!(preview_memory_import_at(&request)
            .unwrap_err()
            .contains("without following links"));
    }

    #[cfg(unix)]
    #[test]
    fn memory_database_symlinks_and_hardlinks_fail_closed() {
        use std::os::unix::fs::symlink;

        {
            let temp = tempfile::tempdir().unwrap();
            let external = tempfile::tempdir().unwrap();
            let target = external.path().join("outside.sqlite");
            let original = b"outside database must remain untouched".to_vec();
            fs::write(&target, &original).unwrap();
            symlink(&target, memory_path(temp.path())).unwrap();

            let error = create_memory_store(&memory_path(temp.path())).unwrap_err();
            assert!(error.contains("regular non-symlink"));
            assert_eq!(fs::read(&target).unwrap(), original);
        }

        {
            let temp = tempfile::tempdir().unwrap();
            let database = memory_path(temp.path());
            create_memory_store(&database).unwrap();
            let second_link = temp.path().join("memory-hardlink.sqlite");
            fs::hard_link(&database, &second_link).unwrap();

            assert!(create_memory_store(&database)
                .unwrap_err()
                .contains("exactly one filesystem link"));

            let source = temp.path().join("legacy-memory.md");
            fs::write(&source, "# One\nNo write may start through a hardlink").unwrap();
            let request = MemoryImportRequest {
                source_path: source.display().to_string(),
                user_id: "user-1".to_string(),
                workspace_id: None,
                expected_source_sha256: None,
            };
            let (preview, _, _) = preview_memory_import_at(&request).unwrap();
            let error = execute_memory_import_at(
                temp.path(),
                MemoryImportRequest {
                    expected_source_sha256: Some(preview.source_sha256),
                    ..request
                },
            )
            .unwrap_err();
            assert!(error.contains("exactly one filesystem link"));
        }
    }

    #[test]
    fn malformed_current_memory_schema_fails_closed_without_reinitialization() {
        let temp = tempfile::tempdir().unwrap();
        let path = memory_path(temp.path());
        let connection = Connection::open(&path).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE schema_migration(component TEXT, version INTEGER, applied_at TEXT, checksum TEXT);",
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO schema_migration VALUES('memory', 3, 'now', ?1)",
                [sha256_hex(MEMORY_SCHEMA_SQL.as_bytes())],
            )
            .unwrap();
        drop(connection);
        let inspection = inspect_memory_store(&path);
        assert!(inspection.initialized);
        assert!(!inspection.ready);
        assert!(inspection
            .blocked_reason
            .unwrap()
            .contains("shape mismatch"));
        assert!(create_memory_store(&path)
            .unwrap_err()
            .contains("shape mismatch"));
    }
}
