//! Disabled-by-default consent and proposal boundary for the future local RAG
//! system.
//!
//! This module does not watch, parse, index, retrieve, upload or reorganize
//! files. It only persists an isolated source authorization generation and
//! proposal-only review ledger. The current Black Box chat and file paths do
//! not call these commands.

use chrono::Utc;
use rusqlite::{params, Connection, OpenFlags, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::time::Duration;
use uuid::Uuid;

const RAG_FLAG: &str = "BLACKBOX_EXPERIMENTAL_RAG_V1";
const HOME_OVERRIDE: &str = "BLACKBOX_EXPERIMENTAL_HOME";
const RAG_SCHEMA_VERSION: i64 = 1;
const MAX_GLOBS: usize = 64;
const MAX_GLOB_BYTES: usize = 512;
const MAX_TARGET_BYTES: usize = 64 * 1024;
const MAX_EVIDENCE_HASHES: usize = 64;
const MAX_REASON_BYTES: usize = 4 * 1024;
const RAG_SCHEMA_SQL: &str = include_str!("../resources/experimental/rag-consent-v1.sql");

const RAG_TABLE_SHAPES: &[(&str, &[&str])] = &[
    (
        "rag_consent_meta",
        &["id", "schema_version", "schema_sha256", "created_at_ms"],
    ),
    (
        "rag_source",
        &[
            "source_id",
            "tenant_id",
            "owner_user_id",
            "source_kind",
            "root_path",
            "source_binding_revision",
            "consent_state",
            "authorization_generation",
            "policy_revision",
            "include_globs_json",
            "exclude_globs_json",
            "enabled",
            "registration_idempotency_key",
            "registration_payload_sha256",
            "registration_receipt_sha256",
            "created_at_ms",
            "updated_at_ms",
        ],
    ),
    (
        "rag_authorization_event",
        &[
            "event_id",
            "tenant_id",
            "owner_user_id",
            "source_id",
            "request_id",
            "request_payload_sha256",
            "from_state",
            "to_state",
            "expected_generation",
            "resulting_generation",
            "policy_revision",
            "cancelled_proposal_count",
            "receipt_sha256",
            "created_at_ms",
        ],
    ),
    (
        "rag_organization_cancellation",
        &[
            "tenant_id",
            "proposal_id",
            "source_id",
            "owner_user_id",
            "authorization_generation",
            "policy_revision",
            "previous_status",
            "cancelled_at_ms",
        ],
    ),
    (
        "rag_organization_proposal",
        &[
            "proposal_id",
            "tenant_id",
            "owner_user_id",
            "source_id",
            "authorization_generation",
            "policy_revision",
            "source_binding_revision",
            "proposal_kind",
            "target_json",
            "evidence_sha256_json",
            "model_id",
            "prompt_version",
            "confidence",
            "status",
            "auto_apply",
            "idempotency_key",
            "payload_sha256",
            "receipt_sha256",
            "created_at_ms",
            "updated_at_ms",
        ],
    ),
    (
        "rag_organization_review",
        &[
            "review_id",
            "tenant_id",
            "owner_user_id",
            "proposal_id",
            "action",
            "reason_sha256",
            "idempotency_key",
            "payload_sha256",
            "receipt_sha256",
            "resulting_status",
            "created_at_ms",
        ],
    ),
];

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExperimentalRagStatus {
    enabled: bool,
    initialized: bool,
    ready: bool,
    path: String,
    schema_version: Option<i64>,
    schema_sha256: String,
    production_integration: bool,
    current_knowledge_authority: &'static str,
    ingest_enabled: bool,
    retrieval_enabled: bool,
    auto_organization_enabled: bool,
    blocked_reason: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RegisterRagSourceInput {
    source_id: String,
    tenant_id: String,
    owner_user_id: String,
    source_kind: String,
    root_path: String,
    include_globs: Vec<String>,
    exclude_globs: Vec<String>,
    idempotency_key: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RagSourceReceipt {
    source_id: String,
    tenant_id: String,
    owner_user_id: String,
    source_kind: String,
    root_path: String,
    source_binding_revision: String,
    consent_state: String,
    authorization_generation: u64,
    policy_revision: String,
    enabled: bool,
    receipt_sha256: String,
    duplicate: bool,
    ingest_enabled: bool,
    retrieval_enabled: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ChangeRagConsentInput {
    source_id: String,
    tenant_id: String,
    owner_user_id: String,
    expected_generation: u64,
    next_state: String,
    include_globs: Option<Vec<String>>,
    exclude_globs: Option<Vec<String>>,
    request_id: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RagConsentReceipt {
    source_id: String,
    from_state: String,
    to_state: String,
    authorization_generation: u64,
    policy_revision: String,
    cancelled_proposal_count: u64,
    receipt_sha256: String,
    duplicate: bool,
    logical_payloads_purged: bool,
    forensic_erasure_guaranteed: bool,
    ingest_enabled: bool,
    retrieval_enabled: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CreateRagProposalInput {
    proposal_id: String,
    tenant_id: String,
    owner_user_id: String,
    source_id: String,
    expected_generation: u64,
    expected_policy_revision: String,
    proposal_kind: String,
    target: Value,
    evidence_sha256: Vec<String>,
    model_id: String,
    prompt_version: String,
    confidence: f64,
    idempotency_key: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RagProposalReceipt {
    proposal_id: String,
    source_id: String,
    authorization_generation: u64,
    policy_revision: String,
    source_binding_revision: String,
    status: String,
    auto_apply: bool,
    receipt_sha256: String,
    duplicate: bool,
    external_effects: u8,
    ingest_performed: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ReviewRagProposalInput {
    proposal_id: String,
    tenant_id: String,
    owner_user_id: String,
    action: String,
    reason: String,
    idempotency_key: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RagProposalReviewReceipt {
    proposal_id: String,
    action: String,
    status: String,
    receipt_sha256: String,
    duplicate: bool,
    auto_applied: bool,
    external_effects: u8,
}

#[derive(Clone, Debug)]
struct StoreInspection {
    initialized: bool,
    ready: bool,
    schema_version: Option<i64>,
    blocked_reason: Option<String>,
}

#[derive(Clone, Debug)]
struct SourceRecord {
    source_id: String,
    tenant_id: String,
    owner_user_id: String,
    source_kind: String,
    root_path: String,
    source_binding_revision: String,
    consent_state: String,
    authorization_generation: u64,
    policy_revision: String,
    include_globs: Vec<String>,
    exclude_globs: Vec<String>,
    enabled: bool,
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

fn now_ms() -> i64 {
    Utc::now().timestamp_millis()
}

fn feature_enabled() -> bool {
    std::env::var(RAG_FLAG)
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
    if path.starts_with(production_root) {
        return Err(format!(
            "{HOME_OVERRIDE} must be outside the production Black Box data directory"
        ));
    }
    Ok(path)
}

fn isolated_root() -> Result<PathBuf, String> {
    if !feature_enabled() {
        return Err(format!(
            "Experimental RAG is disabled; set {RAG_FLAG}=1 only in an isolated profile"
        ));
    }
    let value = std::env::var_os(HOME_OVERRIDE)
        .ok_or_else(|| format!("{HOME_OVERRIDE} is required for every experimental mutation"))?;
    validate_isolated_root(PathBuf::from(value), &crate::safe_data_dir()?)
}

fn database_path(root: &Path) -> PathBuf {
    root.join("rag-consent-v1.sqlite")
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
fn set_file_private(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .map_err(|error| format!("Failed to secure {}: {error}", path.display()))
}

#[cfg(not(unix))]
fn set_file_private(_path: &Path) -> Result<(), String> {
    Ok(())
}

fn ensure_private_root(root: &Path) -> Result<(), String> {
    if root.exists() {
        let metadata = fs::symlink_metadata(root)
            .map_err(|error| format!("Failed to inspect {}: {error}", root.display()))?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err("Experimental RAG root must be a real directory".to_string());
        }
    } else {
        fs::create_dir_all(root)
            .map_err(|error| format!("Failed to create {}: {error}", root.display()))?;
    }
    set_directory_private(root)
}

fn acquire_init_lock(root: &Path) -> Result<InitLock, String> {
    ensure_private_root(root)?;
    let path = root.join(".rag-consent-init.lock");
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&path)
        .map_err(|error| format!("Another RAG initializer is active: {error}"))?;
    file.write_all(Uuid::new_v4().to_string().as_bytes())
        .map_err(|error| format!("Failed to write RAG initializer lock: {error}"))?;
    file.sync_all()
        .map_err(|error| format!("Failed to sync RAG initializer lock: {error}"))?;
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

fn open_read_only(path: &Path) -> Result<Connection, String> {
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| format!("Failed to inspect {}: {error}", path.display()))?;
    connection
        .busy_timeout(Duration::from_secs(2))
        .map_err(|error| format!("Failed to configure RAG inspection: {error}"))?;
    connection
        .pragma_update(None, "query_only", true)
        .map_err(|error| format!("Failed to make RAG inspection read-only: {error}"))?;
    Ok(connection)
}

fn open_read_write(path: &Path) -> Result<Connection, String> {
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| format!("Failed to open {}: {error}", path.display()))?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(|error| format!("Failed to configure RAG writer: {error}"))?;
    connection
        .pragma_update(None, "foreign_keys", true)
        .map_err(|error| format!("Failed to enable RAG foreign keys: {error}"))?;
    connection
        .pragma_update(None, "synchronous", "FULL")
        .map_err(|error| format!("Failed to enable durable RAG writes: {error}"))?;
    connection
        .pragma_update(None, "secure_delete", true)
        .map_err(|error| format!("Failed to enable secure RAG payload deletion: {error}"))?;
    Ok(connection)
}

fn sqlite_quick_check(connection: &Connection) -> Result<(), String> {
    let result: String = connection
        .query_row("PRAGMA quick_check", [], |row| row.get(0))
        .map_err(|error| format!("RAG SQLite quick_check failed: {error}"))?;
    if result == "ok" {
        Ok(())
    } else {
        Err(format!("RAG SQLite quick_check reported {result}"))
    }
}

fn table_columns(connection: &Connection, table: &str) -> Result<Vec<String>, String> {
    let quoted = table.replace('"', "\"\"");
    let mut statement = connection
        .prepare(&format!("PRAGMA table_info(\"{quoted}\")"))
        .map_err(|error| format!("Failed to inspect RAG table {table}: {error}"))?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| format!("Failed to read RAG table {table}: {error}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Failed to decode RAG table {table}: {error}"))
}

fn inspect_store(path: &Path) -> StoreInspection {
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
        let (version, stored_hash): (i64, String) = connection
            .query_row(
                "SELECT schema_version, schema_sha256 FROM rag_consent_meta WHERE id = 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(|error| format!("RAG schema metadata is missing: {error}"))?;
        let expected_hash = sha256_hex(RAG_SCHEMA_SQL.as_bytes());
        if version != RAG_SCHEMA_VERSION || stored_hash != expected_hash {
            return Err("RAG consent schema identity mismatch".to_string());
        }
        for (table, expected) in RAG_TABLE_SHAPES {
            let actual = table_columns(&connection, table)?;
            let expected: Vec<String> = expected.iter().map(|value| (*value).to_string()).collect();
            if actual != expected {
                return Err(format!("RAG consent table shape mismatch: {table}"));
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

fn status_at(root: &Path, enabled: bool) -> ExperimentalRagStatus {
    let path = database_path(root);
    let inspection = inspect_store(&path);
    ExperimentalRagStatus {
        enabled,
        initialized: inspection.initialized,
        ready: enabled && inspection.ready,
        path: path.display().to_string(),
        schema_version: inspection.schema_version,
        schema_sha256: sha256_hex(RAG_SCHEMA_SQL.as_bytes()),
        production_integration: false,
        current_knowledge_authority: "existing-files-and-explicit-user-context",
        ingest_enabled: false,
        retrieval_enabled: false,
        auto_organization_enabled: false,
        blocked_reason: inspection.blocked_reason,
    }
}

#[tauri::command]
pub(crate) fn get_experimental_rag_consent_status() -> Result<ExperimentalRagStatus, String> {
    Ok(status_at(&foundation_root()?, feature_enabled()))
}

fn create_store(path: &Path) -> Result<(), String> {
    let root = path.parent().ok_or("RAG database path has no parent")?;
    let _lock = acquire_init_lock(root)?;
    if path.exists() {
        let inspection = inspect_store(path);
        return if inspection.ready {
            Ok(())
        } else {
            Err(inspection
                .blocked_reason
                .unwrap_or_else(|| "RAG consent store is not ready".to_string()))
        };
    }
    let staging = root.join(format!(".rag-consent-v1.{}.sqlite", Uuid::new_v4()));
    let result = (|| -> Result<(), String> {
        let connection = Connection::open(&staging)
            .map_err(|error| format!("Failed to create staged RAG store: {error}"))?;
        connection
            .busy_timeout(Duration::from_secs(5))
            .map_err(|error| format!("Failed to configure staged RAG store: {error}"))?;
        connection
            .execute_batch(RAG_SCHEMA_SQL)
            .map_err(|error| format!("Failed to apply RAG consent schema: {error}"))?;
        connection
            .execute(
                "INSERT INTO rag_consent_meta(id, schema_version, schema_sha256, created_at_ms) VALUES(1, 1, ?1, ?2)",
                params![sha256_hex(RAG_SCHEMA_SQL.as_bytes()), now_ms()],
            )
            .map_err(|error| format!("Failed to bind RAG schema identity: {error}"))?;
        connection
            .pragma_update(None, "user_version", RAG_SCHEMA_VERSION)
            .map_err(|error| format!("Failed to set RAG schema version: {error}"))?;
        sqlite_quick_check(&connection)?;
        drop(connection);
        set_file_private(&staging)?;
        sync_file_and_parent(&staging)?;
        if path.exists() {
            return Err("RAG store appeared during initialization; refusing overwrite".to_string());
        }
        fs::rename(&staging, path)
            .map_err(|error| format!("Failed to publish RAG consent store: {error}"))?;
        sync_file_and_parent(path)?;
        let inspection = inspect_store(path);
        if !inspection.ready {
            return Err(inspection
                .blocked_reason
                .unwrap_or_else(|| "Published RAG consent store failed inspection".to_string()));
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&staging);
    }
    result
}

#[tauri::command]
pub(crate) fn initialize_experimental_rag_consent_store() -> Result<ExperimentalRagStatus, String> {
    let root = isolated_root()?;
    create_store(&database_path(&root))?;
    get_experimental_rag_consent_status()
}

fn validate_token(name: &str, value: &str) -> Result<(), String> {
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

fn validate_label(name: &str, value: &str, maximum: usize) -> Result<(), String> {
    if value.is_empty()
        || value.len() > maximum
        || value.chars().any(|character| character.is_control())
    {
        Err(format!("{name} must be 1 to {maximum} non-control bytes"))
    } else {
        Ok(())
    }
}

fn validate_sha256(name: &str, value: &str) -> Result<(), String> {
    if value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err(format!("{name} must be a 64-character SHA-256 hex digest"))
    }
}

fn normalize_source_root(kind: &str, raw: &str) -> Result<String, String> {
    if !matches!(kind, "directory" | "file") {
        return Err("sourceKind must be directory or file in this slice".to_string());
    }
    let path = PathBuf::from(raw);
    if !path.is_absolute() {
        return Err("RAG source root must be absolute".to_string());
    }
    if path
        .components()
        .any(|component| matches!(component, Component::ParentDir | Component::CurDir))
    {
        return Err("RAG source root must not contain relative path components".to_string());
    }
    let metadata = fs::symlink_metadata(&path)
        .map_err(|error| format!("Failed to inspect RAG source root: {error}"))?;
    if metadata.file_type().is_symlink() {
        return Err("RAG source root symlinks are not allowed".to_string());
    }
    if (kind == "directory" && !metadata.is_dir()) || (kind == "file" && !metadata.is_file()) {
        return Err(format!("RAG source root is not a {kind}"));
    }
    fs::canonicalize(&path)
        .map_err(|error| format!("Failed to canonicalize RAG source root: {error}"))
        .map(|value| value.display().to_string())
}

fn ensure_source_outside_control_roots(
    source_path: &Path,
    experimental_root: &Path,
    production_root: &Path,
) -> Result<(), String> {
    let canonical_experimental = fs::canonicalize(experimental_root).map_err(|error| {
        format!(
            "Failed to canonicalize experimental RAG root {}: {error}",
            experimental_root.display()
        )
    })?;
    let canonical_production =
        fs::canonicalize(production_root).unwrap_or_else(|_| production_root.to_path_buf());
    if source_path.starts_with(&canonical_experimental)
        || source_path.starts_with(&canonical_production)
    {
        return Err(
            "RAG source root must be outside Black Box production and experimental control data"
                .to_string(),
        );
    }
    Ok(())
}

fn normalize_globs(values: Vec<String>) -> Result<Vec<String>, String> {
    if values.len() > MAX_GLOBS {
        return Err(format!("RAG source permits at most {MAX_GLOBS} globs"));
    }
    let mut normalized = BTreeSet::new();
    for value in values {
        if value.is_empty() || value.len() > MAX_GLOB_BYTES {
            return Err(format!("RAG glob must contain 1 to {MAX_GLOB_BYTES} bytes"));
        }
        if value.contains('\\')
            || value.contains('\0')
            || value.starts_with('/')
            || value.starts_with("./")
            || value.ends_with('/')
            || value.contains("//")
            || value.split('/').any(|part| matches!(part, "." | ".."))
        {
            return Err("RAG glob is not a safe root-relative pattern".to_string());
        }
        normalized.insert(value);
    }
    Ok(normalized.into_iter().collect())
}

fn binding_revision(
    source_id: &str,
    tenant_id: &str,
    owner_user_id: &str,
    source_kind: &str,
    root_path: &str,
) -> String {
    sha256_hex(
        serde_json::json!({
            "schemaVersion": 1,
            "sourceId": source_id,
            "tenantId": tenant_id,
            "ownerUserId": owner_user_id,
            "sourceKind": source_kind,
            "rootPath": root_path,
            "followSymlinks": false,
        })
        .to_string()
        .as_bytes(),
    )
}

#[allow(clippy::too_many_arguments)]
fn policy_revision(
    source_id: &str,
    tenant_id: &str,
    owner_user_id: &str,
    source_kind: &str,
    root_path: &str,
    generation: u64,
    consent_state: &str,
    enabled: bool,
    include_globs: &[String],
    exclude_globs: &[String],
) -> String {
    sha256_hex(
        serde_json::json!({
            "schemaVersion": 1,
            "sourceId": source_id,
            "tenantId": tenant_id,
            "ownerUserId": owner_user_id,
            "sourceKind": source_kind,
            "rootPath": root_path,
            "authorizationGeneration": generation,
            "consentState": consent_state,
            "enabled": enabled,
            "includeGlobs": include_globs,
            "excludeGlobs": exclude_globs,
            "followSymlinks": false,
            "cloudSync": false,
        })
        .to_string()
        .as_bytes(),
    )
}

fn parse_json_array(value: &str, name: &str) -> Result<Vec<String>, String> {
    serde_json::from_str(value).map_err(|error| format!("Stored {name} is malformed: {error}"))
}

fn load_source(
    connection: &Connection,
    source_id: &str,
    tenant_id: &str,
    owner_user_id: &str,
) -> Result<SourceRecord, String> {
    connection
        .query_row(
            "SELECT source_id, tenant_id, owner_user_id, source_kind, root_path, source_binding_revision, consent_state, authorization_generation, policy_revision, include_globs_json, exclude_globs_json, enabled FROM rag_source WHERE source_id = ?1 AND tenant_id = ?2 AND owner_user_id = ?3",
            params![source_id, tenant_id, owner_user_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, i64>(7)?,
                    row.get::<_, String>(8)?,
                    row.get::<_, String>(9)?,
                    row.get::<_, String>(10)?,
                    row.get::<_, i64>(11)?,
                ))
            },
        )
        .optional()
        .map_err(|error| format!("Failed to inspect RAG source: {error}"))?
        .ok_or_else(|| "RAG source does not exist for this actor".to_string())
        .and_then(
            |(
                source_id,
                tenant_id,
                owner_user_id,
                source_kind,
                root_path,
                source_binding_revision,
                consent_state,
                authorization_generation,
                policy_revision,
                include_globs_json,
                exclude_globs_json,
                enabled,
            )| {
                Ok(SourceRecord {
                    source_id,
                    tenant_id,
                    owner_user_id,
                    source_kind,
                    root_path,
                    source_binding_revision,
                    consent_state,
                    authorization_generation: u64::try_from(authorization_generation)
                        .map_err(|_| "Stored RAG generation is invalid".to_string())?,
                    policy_revision,
                    include_globs: parse_json_array(&include_globs_json, "include globs")?,
                    exclude_globs: parse_json_array(&exclude_globs_json, "exclude globs")?,
                    enabled: enabled == 1,
                })
            },
        )
}

fn ready_database(root: &Path) -> Result<PathBuf, String> {
    let path = database_path(root);
    let inspection = inspect_store(&path);
    if inspection.ready {
        Ok(path)
    } else {
        Err(inspection
            .blocked_reason
            .unwrap_or_else(|| "RAG consent store is not initialized".to_string()))
    }
}

fn register_source_at(
    root: &Path,
    input: RegisterRagSourceInput,
) -> Result<RagSourceReceipt, String> {
    validate_token("sourceId", &input.source_id)?;
    validate_token("tenantId", &input.tenant_id)?;
    validate_token("ownerUserId", &input.owner_user_id)?;
    validate_token("idempotencyKey", &input.idempotency_key)?;
    let root_path = normalize_source_root(&input.source_kind, &input.root_path)?;
    ensure_source_outside_control_roots(Path::new(&root_path), root, &crate::safe_data_dir()?)?;
    let include_globs = normalize_globs(input.include_globs)?;
    let exclude_globs = normalize_globs(input.exclude_globs)?;
    let source_binding_revision = binding_revision(
        &input.source_id,
        &input.tenant_id,
        &input.owner_user_id,
        &input.source_kind,
        &root_path,
    );
    let policy_revision = policy_revision(
        &input.source_id,
        &input.tenant_id,
        &input.owner_user_id,
        &input.source_kind,
        &root_path,
        1,
        "pending",
        false,
        &include_globs,
        &exclude_globs,
    );
    let payload_sha256 = sha256_hex(
        serde_json::json!({
            "sourceId": input.source_id,
            "tenantId": input.tenant_id,
            "ownerUserId": input.owner_user_id,
            "sourceKind": input.source_kind,
            "rootPath": root_path,
            "includeGlobs": include_globs,
            "excludeGlobs": exclude_globs,
        })
        .to_string()
        .as_bytes(),
    );
    let receipt_sha256 = sha256_hex(
        format!(
            "blackbox-rag-source-v1|{}|{}|{}|{}|{}",
            input.tenant_id,
            input.owner_user_id,
            input.source_id,
            source_binding_revision,
            policy_revision
        )
        .as_bytes(),
    );
    let path = ready_database(root)?;
    let mut connection = open_read_write(&path)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("Failed to begin RAG source transaction: {error}"))?;
    let existing: Option<(String, String, String)> = transaction
        .query_row(
            "SELECT source_id, registration_payload_sha256, registration_receipt_sha256 FROM rag_source WHERE source_id = ?1 OR (tenant_id = ?2 AND owner_user_id = ?3 AND registration_idempotency_key = ?4)",
            params![input.source_id, input.tenant_id, input.owner_user_id, input.idempotency_key],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(|error| format!("Failed to inspect prior RAG source registration: {error}"))?;
    if let Some((existing_source_id, existing_payload, existing_receipt)) = existing {
        if existing_source_id != input.source_id || existing_payload != payload_sha256 {
            return Err(
                "RAG source or idempotency key is already bound to another payload".to_string(),
            );
        }
        transaction
            .commit()
            .map_err(|error| format!("Failed to close duplicate RAG registration: {error}"))?;
        return Ok(RagSourceReceipt {
            source_id: input.source_id,
            tenant_id: input.tenant_id,
            owner_user_id: input.owner_user_id,
            source_kind: input.source_kind,
            root_path,
            source_binding_revision,
            consent_state: "pending".to_string(),
            authorization_generation: 1,
            policy_revision,
            enabled: false,
            receipt_sha256: existing_receipt,
            duplicate: true,
            ingest_enabled: false,
            retrieval_enabled: false,
        });
    }
    let timestamp = now_ms();
    transaction
        .execute(
            "INSERT INTO rag_source(source_id, tenant_id, owner_user_id, source_kind, root_path, source_binding_revision, consent_state, authorization_generation, policy_revision, include_globs_json, exclude_globs_json, enabled, registration_idempotency_key, registration_payload_sha256, registration_receipt_sha256, created_at_ms, updated_at_ms) VALUES(?1, ?2, ?3, ?4, ?5, ?6, 'pending', 1, ?7, ?8, ?9, 0, ?10, ?11, ?12, ?13, ?13)",
            params![
                input.source_id,
                input.tenant_id,
                input.owner_user_id,
                input.source_kind,
                root_path,
                source_binding_revision,
                policy_revision,
                serde_json::to_string(&include_globs).unwrap(),
                serde_json::to_string(&exclude_globs).unwrap(),
                input.idempotency_key,
                payload_sha256,
                receipt_sha256,
                timestamp,
            ],
        )
        .map_err(|error| format!("Failed to register RAG source: {error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("Failed to commit RAG source registration: {error}"))?;
    Ok(RagSourceReceipt {
        source_id: input.source_id,
        tenant_id: input.tenant_id,
        owner_user_id: input.owner_user_id,
        source_kind: input.source_kind,
        root_path,
        source_binding_revision,
        consent_state: "pending".to_string(),
        authorization_generation: 1,
        policy_revision,
        enabled: false,
        receipt_sha256,
        duplicate: false,
        ingest_enabled: false,
        retrieval_enabled: false,
    })
}

#[tauri::command]
pub(crate) fn register_experimental_rag_source(
    input: RegisterRagSourceInput,
) -> Result<RagSourceReceipt, String> {
    register_source_at(&isolated_root()?, input)
}

fn change_consent_at(
    root: &Path,
    input: ChangeRagConsentInput,
) -> Result<RagConsentReceipt, String> {
    validate_token("sourceId", &input.source_id)?;
    validate_token("tenantId", &input.tenant_id)?;
    validate_token("ownerUserId", &input.owner_user_id)?;
    validate_token("requestId", &input.request_id)?;
    if input.expected_generation == 0 {
        return Err("expectedGeneration must be greater than zero".to_string());
    }
    if !matches!(input.next_state.as_str(), "grantedLocalOnly" | "revoked") {
        return Err("nextState must be grantedLocalOnly or revoked".to_string());
    }
    let (requested_include, requested_exclude) = if input.next_state == "grantedLocalOnly" {
        (
            Some(normalize_globs(input.include_globs.clone().ok_or(
                "Granting RAG consent requires includeGlobs".to_string(),
            )?)?),
            Some(normalize_globs(input.exclude_globs.clone().ok_or(
                "Granting RAG consent requires excludeGlobs".to_string(),
            )?)?),
        )
    } else {
        if input.include_globs.is_some() || input.exclude_globs.is_some() {
            return Err("Revocation must not carry replacement globs".to_string());
        }
        (None, None)
    };
    let request_payload_sha256 = sha256_hex(
        serde_json::json!({
            "sourceId": input.source_id,
            "tenantId": input.tenant_id,
            "ownerUserId": input.owner_user_id,
            "expectedGeneration": input.expected_generation,
            "nextState": input.next_state,
            "includeGlobs": requested_include,
            "excludeGlobs": requested_exclude,
        })
        .to_string()
        .as_bytes(),
    );
    let path = ready_database(root)?;
    let mut connection = open_read_write(&path)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("Failed to begin RAG authorization transaction: {error}"))?;
    let duplicate: Option<(String, String, i64, String, i64, String)> = transaction
        .query_row(
            "SELECT request_payload_sha256, from_state, resulting_generation, policy_revision, cancelled_proposal_count, receipt_sha256 FROM rag_authorization_event WHERE tenant_id = ?1 AND owner_user_id = ?2 AND request_id = ?3",
            params![input.tenant_id, input.owner_user_id, input.request_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?)),
        )
        .optional()
        .map_err(|error| format!("Failed to inspect prior RAG authorization request: {error}"))?;
    if let Some((stored_payload, from_state, generation, policy, cancelled, receipt)) = duplicate {
        if stored_payload != request_payload_sha256 {
            return Err("RAG authorization request ID is bound to another payload".to_string());
        }
        transaction
            .commit()
            .map_err(|error| format!("Failed to close duplicate RAG authorization: {error}"))?;
        return Ok(RagConsentReceipt {
            source_id: input.source_id,
            from_state,
            to_state: input.next_state,
            authorization_generation: u64::try_from(generation)
                .map_err(|_| "Stored RAG generation is invalid".to_string())?,
            policy_revision: policy,
            cancelled_proposal_count: u64::try_from(cancelled)
                .map_err(|_| "Stored RAG cancellation count is invalid".to_string())?,
            receipt_sha256: receipt,
            duplicate: true,
            logical_payloads_purged: true,
            forensic_erasure_guaranteed: false,
            ingest_enabled: false,
            retrieval_enabled: false,
        });
    }
    let source = load_source(
        &transaction,
        &input.source_id,
        &input.tenant_id,
        &input.owner_user_id,
    )?;
    if source.authorization_generation != input.expected_generation {
        return Err(format!(
            "RAG authorization generation mismatch: expected {}, current {}",
            input.expected_generation, source.authorization_generation
        ));
    }
    let next_db_state = if input.next_state == "grantedLocalOnly" {
        "granted_local_only"
    } else {
        "revoked"
    };
    let next_enabled = input.next_state == "grantedLocalOnly";
    let next_include = requested_include.unwrap_or_else(|| source.include_globs.clone());
    let next_exclude = requested_exclude.unwrap_or_else(|| source.exclude_globs.clone());
    let next_generation = source.authorization_generation + 1;
    let next_policy = policy_revision(
        &source.source_id,
        &source.tenant_id,
        &source.owner_user_id,
        &source.source_kind,
        &source.root_path,
        next_generation,
        next_db_state,
        next_enabled,
        &next_include,
        &next_exclude,
    );
    let cancelled: i64 = transaction
        .query_row(
            "SELECT COUNT(*) FROM rag_organization_proposal WHERE source_id = ?1 AND tenant_id = ?2 AND owner_user_id = ?3",
            params![source.source_id, source.tenant_id, source.owner_user_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("Failed to count RAG proposals for cancellation: {error}"))?;
    let timestamp = now_ms();
    transaction
        .execute(
            "INSERT OR IGNORE INTO rag_organization_cancellation(tenant_id, proposal_id, source_id, owner_user_id, authorization_generation, policy_revision, previous_status, cancelled_at_ms) SELECT tenant_id, proposal_id, source_id, owner_user_id, authorization_generation, policy_revision, status, ?4 FROM rag_organization_proposal WHERE source_id = ?1 AND tenant_id = ?2 AND owner_user_id = ?3",
            params![source.source_id, source.tenant_id, source.owner_user_id, timestamp],
        )
        .map_err(|error| format!("Failed to create RAG proposal cancellation fences: {error}"))?;
    transaction
        .execute(
            "DELETE FROM rag_organization_proposal WHERE source_id = ?1 AND tenant_id = ?2 AND owner_user_id = ?3",
            params![source.source_id, source.tenant_id, source.owner_user_id],
        )
        .map_err(|error| format!("Failed to purge RAG proposal payloads: {error}"))?;
    transaction
        .execute(
            "UPDATE rag_source SET consent_state = ?4, authorization_generation = ?5, policy_revision = ?6, include_globs_json = ?7, exclude_globs_json = ?8, enabled = ?9, updated_at_ms = ?10 WHERE source_id = ?1 AND tenant_id = ?2 AND owner_user_id = ?3 AND authorization_generation = ?11",
            params![
                source.source_id,
                source.tenant_id,
                source.owner_user_id,
                next_db_state,
                next_generation as i64,
                next_policy,
                serde_json::to_string(&next_include).unwrap(),
                serde_json::to_string(&next_exclude).unwrap(),
                i64::from(next_enabled),
                timestamp,
                input.expected_generation as i64,
            ],
        )
        .map_err(|error| format!("Failed to advance RAG authorization generation: {error}"))?;
    let receipt_sha256 = sha256_hex(
        format!(
            "blackbox-rag-consent-v1|{}|{}|{}|{}|{}|{}",
            source.source_id,
            source.consent_state,
            next_db_state,
            next_generation,
            next_policy,
            cancelled
        )
        .as_bytes(),
    );
    transaction
        .execute(
            "INSERT INTO rag_authorization_event(event_id, tenant_id, owner_user_id, source_id, request_id, request_payload_sha256, from_state, to_state, expected_generation, resulting_generation, policy_revision, cancelled_proposal_count, receipt_sha256, created_at_ms) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
            params![
                format!("rag_auth_{}", Uuid::new_v4()),
                source.tenant_id,
                source.owner_user_id,
                source.source_id,
                input.request_id,
                request_payload_sha256,
                source.consent_state,
                next_db_state,
                input.expected_generation as i64,
                next_generation as i64,
                next_policy,
                cancelled,
                receipt_sha256,
                timestamp,
            ],
        )
        .map_err(|error| format!("Failed to persist RAG authorization receipt: {error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("Failed to commit RAG authorization change: {error}"))?;
    Ok(RagConsentReceipt {
        source_id: source.source_id,
        from_state: source.consent_state,
        to_state: input.next_state,
        authorization_generation: next_generation,
        policy_revision: next_policy,
        cancelled_proposal_count: u64::try_from(cancelled)
            .map_err(|_| "RAG cancellation count is invalid".to_string())?,
        receipt_sha256,
        duplicate: false,
        logical_payloads_purged: true,
        forensic_erasure_guaranteed: false,
        ingest_enabled: false,
        retrieval_enabled: false,
    })
}

#[tauri::command]
pub(crate) fn change_experimental_rag_source_consent(
    input: ChangeRagConsentInput,
) -> Result<RagConsentReceipt, String> {
    change_consent_at(&isolated_root()?, input)
}

fn create_proposal_at(
    root: &Path,
    input: CreateRagProposalInput,
) -> Result<RagProposalReceipt, String> {
    validate_token("proposalId", &input.proposal_id)?;
    validate_token("tenantId", &input.tenant_id)?;
    validate_token("ownerUserId", &input.owner_user_id)?;
    validate_token("sourceId", &input.source_id)?;
    validate_token("idempotencyKey", &input.idempotency_key)?;
    validate_sha256("expectedPolicyRevision", &input.expected_policy_revision)?;
    validate_label("modelId", &input.model_id, 256)?;
    validate_label("promptVersion", &input.prompt_version, 128)?;
    if input.expected_generation == 0 {
        return Err("expectedGeneration must be greater than zero".to_string());
    }
    if !matches!(
        input.proposal_kind.as_str(),
        "tag" | "cluster" | "link" | "title"
    ) {
        return Err("proposalKind is unsupported".to_string());
    }
    if !input.target.is_object() {
        return Err("RAG proposal target must be a JSON object".to_string());
    }
    let target_json = serde_json::to_string(&input.target)
        .map_err(|error| format!("Failed to encode RAG proposal target: {error}"))?;
    if target_json.len() > MAX_TARGET_BYTES {
        return Err(format!(
            "RAG proposal target exceeds {MAX_TARGET_BYTES} bytes"
        ));
    }
    if input.evidence_sha256.is_empty() || input.evidence_sha256.len() > MAX_EVIDENCE_HASHES {
        return Err(format!(
            "RAG proposal requires 1 to {MAX_EVIDENCE_HASHES} evidence hashes"
        ));
    }
    let mut evidence = BTreeSet::new();
    for value in input.evidence_sha256 {
        validate_sha256("evidenceSha256", &value)?;
        evidence.insert(value.to_ascii_lowercase());
    }
    let evidence: Vec<String> = evidence.into_iter().collect();
    if !input.confidence.is_finite() || !(0.0..=1.0).contains(&input.confidence) {
        return Err("confidence must be a finite value from 0 to 1".to_string());
    }
    let payload_sha256 = sha256_hex(
        serde_json::json!({
            "proposalId": input.proposal_id,
            "tenantId": input.tenant_id,
            "ownerUserId": input.owner_user_id,
            "sourceId": input.source_id,
            "expectedGeneration": input.expected_generation,
            "expectedPolicyRevision": input.expected_policy_revision,
            "proposalKind": input.proposal_kind,
            "target": input.target,
            "evidenceSha256": evidence,
            "modelId": input.model_id,
            "promptVersion": input.prompt_version,
            "confidence": input.confidence,
            "autoApply": false,
        })
        .to_string()
        .as_bytes(),
    );
    let path = ready_database(root)?;
    let mut connection = open_read_write(&path)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("Failed to begin RAG proposal transaction: {error}"))?;
    let existing: Option<(String, String, String, String, i64, String)> = transaction
        .query_row(
            "SELECT proposal_id, source_id, payload_sha256, receipt_sha256, authorization_generation, policy_revision FROM rag_organization_proposal WHERE proposal_id = ?1 OR (tenant_id = ?2 AND owner_user_id = ?3 AND idempotency_key = ?4)",
            params![input.proposal_id, input.tenant_id, input.owner_user_id, input.idempotency_key],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?)),
        )
        .optional()
        .map_err(|error| format!("Failed to inspect prior RAG proposal: {error}"))?;
    if let Some((proposal_id, source_id, stored_payload, receipt, generation, policy)) = existing {
        if proposal_id != input.proposal_id || stored_payload != payload_sha256 {
            return Err("RAG proposal or idempotency key is bound to another payload".to_string());
        }
        let binding: String = transaction
            .query_row(
                "SELECT source_binding_revision FROM rag_organization_proposal WHERE proposal_id = ?1",
                [&input.proposal_id],
                |row| row.get(0),
            )
            .map_err(|error| format!("Failed to read duplicate RAG proposal: {error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("Failed to close duplicate RAG proposal: {error}"))?;
        return Ok(RagProposalReceipt {
            proposal_id,
            source_id,
            authorization_generation: u64::try_from(generation)
                .map_err(|_| "Stored RAG proposal generation is invalid".to_string())?,
            policy_revision: policy,
            source_binding_revision: binding,
            status: "pending".to_string(),
            auto_apply: false,
            receipt_sha256: receipt,
            duplicate: true,
            external_effects: 0,
            ingest_performed: false,
        });
    }
    let source = load_source(
        &transaction,
        &input.source_id,
        &input.tenant_id,
        &input.owner_user_id,
    )?;
    if !source.enabled
        || source.consent_state != "granted_local_only"
        || source.authorization_generation != input.expected_generation
        || source.policy_revision != input.expected_policy_revision
    {
        return Err("RAG proposal source authority is stale or not granted".to_string());
    }
    let receipt_sha256 = sha256_hex(
        format!(
            "blackbox-rag-proposal-v1|{}|{}|{}|{}|{}",
            input.proposal_id,
            source.source_id,
            source.authorization_generation,
            source.policy_revision,
            payload_sha256
        )
        .as_bytes(),
    );
    let timestamp = now_ms();
    transaction
        .execute(
            "INSERT INTO rag_organization_proposal(proposal_id, tenant_id, owner_user_id, source_id, authorization_generation, policy_revision, source_binding_revision, proposal_kind, target_json, evidence_sha256_json, model_id, prompt_version, confidence, status, auto_apply, idempotency_key, payload_sha256, receipt_sha256, created_at_ms, updated_at_ms) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 'pending', 0, ?14, ?15, ?16, ?17, ?17)",
            params![
                input.proposal_id,
                input.tenant_id,
                input.owner_user_id,
                input.source_id,
                input.expected_generation as i64,
                input.expected_policy_revision,
                source.source_binding_revision,
                input.proposal_kind,
                target_json,
                serde_json::to_string(&evidence).unwrap(),
                input.model_id,
                input.prompt_version,
                input.confidence,
                input.idempotency_key,
                payload_sha256,
                receipt_sha256,
                timestamp,
            ],
        )
        .map_err(|error| format!("Failed to persist RAG proposal: {error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("Failed to commit RAG proposal: {error}"))?;
    Ok(RagProposalReceipt {
        proposal_id: input.proposal_id,
        source_id: input.source_id,
        authorization_generation: input.expected_generation,
        policy_revision: input.expected_policy_revision,
        source_binding_revision: source.source_binding_revision,
        status: "pending".to_string(),
        auto_apply: false,
        receipt_sha256,
        duplicate: false,
        external_effects: 0,
        ingest_performed: false,
    })
}

#[tauri::command]
pub(crate) fn create_experimental_rag_organization_proposal(
    input: CreateRagProposalInput,
) -> Result<RagProposalReceipt, String> {
    create_proposal_at(&isolated_root()?, input)
}

fn review_proposal_at(
    root: &Path,
    input: ReviewRagProposalInput,
) -> Result<RagProposalReviewReceipt, String> {
    validate_token("proposalId", &input.proposal_id)?;
    validate_token("tenantId", &input.tenant_id)?;
    validate_token("ownerUserId", &input.owner_user_id)?;
    validate_token("idempotencyKey", &input.idempotency_key)?;
    if !matches!(input.action.as_str(), "approve" | "reject" | "revert") {
        return Err("RAG proposal action is unsupported".to_string());
    }
    if input.reason.len() > MAX_REASON_BYTES {
        return Err(format!(
            "RAG review reason exceeds {MAX_REASON_BYTES} bytes"
        ));
    }
    let reason_sha256 = sha256_hex(input.reason.as_bytes());
    let payload_sha256 = sha256_hex(
        serde_json::json!({
            "proposalId": input.proposal_id,
            "tenantId": input.tenant_id,
            "ownerUserId": input.owner_user_id,
            "action": input.action,
            "reasonSha256": reason_sha256,
        })
        .to_string()
        .as_bytes(),
    );
    let path = ready_database(root)?;
    let mut connection = open_read_write(&path)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("Failed to begin RAG review transaction: {error}"))?;
    let existing: Option<(String, String, String, String)> = transaction
        .query_row(
            "SELECT proposal_id, payload_sha256, receipt_sha256, resulting_status FROM rag_organization_review WHERE tenant_id = ?1 AND owner_user_id = ?2 AND idempotency_key = ?3",
            params![input.tenant_id, input.owner_user_id, input.idempotency_key],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()
        .map_err(|error| format!("Failed to inspect prior RAG review: {error}"))?;
    if let Some((proposal_id, stored_payload, receipt, status)) = existing {
        if proposal_id != input.proposal_id || stored_payload != payload_sha256 {
            return Err("RAG review idempotency key is bound to another payload".to_string());
        }
        transaction
            .commit()
            .map_err(|error| format!("Failed to close duplicate RAG review: {error}"))?;
        return Ok(RagProposalReviewReceipt {
            proposal_id,
            action: input.action,
            status,
            receipt_sha256: receipt,
            duplicate: true,
            auto_applied: false,
            external_effects: 0,
        });
    }
    let cancelled: i64 = transaction
        .query_row(
            "SELECT COUNT(*) FROM rag_organization_cancellation WHERE tenant_id = ?1 AND proposal_id = ?2",
            params![input.tenant_id, input.proposal_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("Failed to inspect RAG cancellation fence: {error}"))?;
    if cancelled > 0 {
        return Err(
            "RAG proposal was permanently cancelled by an authorization change".to_string(),
        );
    }
    let status: String = transaction
        .query_row(
            "SELECT status FROM rag_organization_proposal WHERE proposal_id = ?1 AND tenant_id = ?2 AND owner_user_id = ?3",
            params![input.proposal_id, input.tenant_id, input.owner_user_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("Failed to inspect RAG proposal state: {error}"))?
        .ok_or_else(|| "RAG proposal does not exist for this actor".to_string())?;
    let next_status = match (status.as_str(), input.action.as_str()) {
        ("pending", "approve") => "approved",
        ("pending", "reject") => "rejected",
        ("approved", "revert") => "reverted",
        _ => return Err(format!("Invalid RAG proposal transition from {status}")),
    };
    let receipt_sha256 = sha256_hex(
        format!(
            "blackbox-rag-review-v1|{}|{}|{}|{}",
            input.proposal_id, input.action, next_status, payload_sha256
        )
        .as_bytes(),
    );
    let timestamp = now_ms();
    transaction
        .execute(
            "INSERT INTO rag_organization_review(review_id, tenant_id, owner_user_id, proposal_id, action, reason_sha256, idempotency_key, payload_sha256, receipt_sha256, resulting_status, created_at_ms) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                format!("rag_review_{}", Uuid::new_v4()),
                input.tenant_id,
                input.owner_user_id,
                input.proposal_id,
                input.action,
                reason_sha256,
                input.idempotency_key,
                payload_sha256,
                receipt_sha256,
                next_status,
                timestamp,
            ],
        )
        .map_err(|error| format!("Failed to persist RAG review receipt: {error}"))?;
    transaction
        .execute(
            "UPDATE rag_organization_proposal SET status = ?2, updated_at_ms = ?3 WHERE proposal_id = ?1",
            params![input.proposal_id, next_status, timestamp],
        )
        .map_err(|error| format!("Failed to advance RAG proposal state: {error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("Failed to commit RAG proposal review: {error}"))?;
    Ok(RagProposalReviewReceipt {
        proposal_id: input.proposal_id,
        action: input.action,
        status: next_status.to_string(),
        receipt_sha256,
        duplicate: false,
        auto_applied: false,
        external_effects: 0,
    })
}

#[tauri::command]
pub(crate) fn review_experimental_rag_organization_proposal(
    input: ReviewRagProposalInput,
) -> Result<RagProposalReviewReceipt, String> {
    review_proposal_at(&isolated_root()?, input)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Barrier};
    use std::thread;

    fn register_input(root: &Path, source_id: &str) -> RegisterRagSourceInput {
        let source = root.join(format!("knowledge-{source_id}"));
        fs::create_dir_all(&source).unwrap();
        RegisterRagSourceInput {
            source_id: source_id.to_string(),
            tenant_id: "local".to_string(),
            owner_user_id: "user-1".to_string(),
            source_kind: "directory".to_string(),
            root_path: source.display().to_string(),
            include_globs: vec!["**/*.md".to_string()],
            exclude_globs: vec!["private/**".to_string()],
            idempotency_key: format!("register-{source_id}"),
        }
    }

    fn grant_input(source_id: &str, request_id: &str) -> ChangeRagConsentInput {
        ChangeRagConsentInput {
            source_id: source_id.to_string(),
            tenant_id: "local".to_string(),
            owner_user_id: "user-1".to_string(),
            expected_generation: 1,
            next_state: "grantedLocalOnly".to_string(),
            include_globs: Some(vec!["**/*.md".to_string()]),
            exclude_globs: Some(vec!["private/**".to_string()]),
            request_id: request_id.to_string(),
        }
    }

    fn proposal_input(
        source_id: &str,
        policy_revision: &str,
        marker: &str,
    ) -> CreateRagProposalInput {
        CreateRagProposalInput {
            proposal_id: format!("proposal-{source_id}"),
            tenant_id: "local".to_string(),
            owner_user_id: "user-1".to_string(),
            source_id: source_id.to_string(),
            expected_generation: 2,
            expected_policy_revision: policy_revision.to_string(),
            proposal_kind: "tag".to_string(),
            target: serde_json::json!({"tag": marker}),
            evidence_sha256: vec![sha256_hex(b"synthetic evidence")],
            model_id: "local-fixture".to_string(),
            prompt_version: "proposal-v1".to_string(),
            confidence: 0.9,
            idempotency_key: format!("proposal-request-{source_id}"),
        }
    }

    #[test]
    fn disabled_status_is_inert_and_does_not_create_a_store() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("never-created");
        let status = status_at(&root, false);
        assert!(!status.enabled);
        assert!(!status.initialized);
        assert!(!status.ready);
        assert!(!status.production_integration);
        assert!(!status.ingest_enabled);
        assert!(!status.retrieval_enabled);
        assert!(!status.auto_organization_enabled);
        assert!(!root.exists());
    }

    #[test]
    fn isolated_root_and_source_policy_fail_closed() {
        let production = Path::new("/Users/test/.blackbox");
        assert!(validate_isolated_root(PathBuf::from("relative"), production).is_err());
        assert!(validate_isolated_root(
            PathBuf::from("/Users/test/.blackbox/experimental"),
            production
        )
        .is_err());
        assert!(validate_isolated_root(PathBuf::from("/tmp/../tmp/rag"), production).is_err());
        assert!(normalize_globs(vec!["../escape/**".to_string()]).is_err());
        assert!(normalize_globs(vec!["/absolute/**".to_string()]).is_err());

        let temp = tempfile::tempdir().unwrap();
        let experimental_root = temp.path().join("foundation");
        let controlled_source = experimental_root.join("knowledge");
        fs::create_dir_all(&controlled_source).unwrap();
        assert!(ensure_source_outside_control_roots(
            &fs::canonicalize(&controlled_source).unwrap(),
            &experimental_root,
            &temp.path().join("production")
        )
        .unwrap_err()
        .contains("outside Black Box production and experimental control data"));
    }

    #[test]
    fn source_registration_is_pending_and_idempotent() {
        let temp = tempfile::tempdir().unwrap();
        let store_root = temp.path().join("foundation");
        create_store(&database_path(&store_root)).unwrap();
        let input = register_input(temp.path(), "source-1");
        let first = register_source_at(&store_root, input.clone()).unwrap();
        assert_eq!(first.consent_state, "pending");
        assert_eq!(first.authorization_generation, 1);
        assert!(!first.enabled);
        assert!(!first.ingest_enabled);
        assert!(!first.retrieval_enabled);
        assert!(!first.duplicate);

        let duplicate = register_source_at(&store_root, input.clone()).unwrap();
        assert!(duplicate.duplicate);
        assert_eq!(duplicate.receipt_sha256, first.receipt_sha256);

        let mut drift = input;
        drift.include_globs = vec!["**/*.txt".to_string()];
        assert!(register_source_at(&store_root, drift)
            .unwrap_err()
            .contains("another payload"));
    }

    #[test]
    fn consent_proposal_review_and_revocation_are_generation_bound() {
        let temp = tempfile::tempdir().unwrap();
        let store_root = temp.path().join("foundation");
        create_store(&database_path(&store_root)).unwrap();
        register_source_at(&store_root, register_input(temp.path(), "source-1")).unwrap();
        let grant = change_consent_at(&store_root, grant_input("source-1", "grant-1")).unwrap();
        assert_eq!(grant.from_state, "pending");
        assert_eq!(grant.to_state, "grantedLocalOnly");
        assert_eq!(grant.authorization_generation, 2);
        assert!(!grant.ingest_enabled);
        assert!(!grant.retrieval_enabled);

        const SECRET_MARKER: &str = "proposal-secret-marker-must-be-purged";
        let proposal = create_proposal_at(
            &store_root,
            proposal_input("source-1", &grant.policy_revision, SECRET_MARKER),
        )
        .unwrap();
        assert_eq!(proposal.status, "pending");
        assert!(!proposal.auto_apply);
        assert_eq!(proposal.external_effects, 0);
        assert!(!proposal.ingest_performed);

        let review = review_proposal_at(
            &store_root,
            ReviewRagProposalInput {
                proposal_id: proposal.proposal_id.clone(),
                tenant_id: "local".to_string(),
                owner_user_id: "user-1".to_string(),
                action: "approve".to_string(),
                reason: "Explicit local approval".to_string(),
                idempotency_key: "review-1".to_string(),
            },
        )
        .unwrap();
        assert_eq!(review.status, "approved");
        assert!(!review.auto_applied);
        assert_eq!(review.external_effects, 0);

        let revoke = change_consent_at(
            &store_root,
            ChangeRagConsentInput {
                source_id: "source-1".to_string(),
                tenant_id: "local".to_string(),
                owner_user_id: "user-1".to_string(),
                expected_generation: 2,
                next_state: "revoked".to_string(),
                include_globs: None,
                exclude_globs: None,
                request_id: "revoke-1".to_string(),
            },
        )
        .unwrap();
        assert_eq!(revoke.authorization_generation, 3);
        assert_eq!(revoke.cancelled_proposal_count, 1);
        assert!(revoke.logical_payloads_purged);
        assert!(!revoke.forensic_erasure_guaranteed);

        let connection = open_read_only(&database_path(&store_root)).unwrap();
        let proposal_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM rag_organization_proposal",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let review_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM rag_organization_review", [], |row| {
                row.get(0)
            })
            .unwrap();
        let cancellation_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM rag_organization_cancellation",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            (proposal_count, review_count, cancellation_count),
            (0, 0, 1)
        );
        let cancellation_columns =
            table_columns(&connection, "rag_organization_cancellation").unwrap();
        assert!(!cancellation_columns
            .iter()
            .any(|name| name.contains("target")));
        assert!(!cancellation_columns
            .iter()
            .any(|name| name.contains("evidence")));
        drop(connection);

        let stale_review = review_proposal_at(
            &store_root,
            ReviewRagProposalInput {
                proposal_id: proposal.proposal_id,
                tenant_id: "local".to_string(),
                owner_user_id: "user-1".to_string(),
                action: "reject".to_string(),
                reason: String::new(),
                idempotency_key: "review-after-revoke".to_string(),
            },
        )
        .unwrap_err();
        assert!(stale_review.contains("permanently cancelled"));

        let database_bytes = fs::read(database_path(&store_root)).unwrap();
        assert!(!database_bytes
            .windows(SECRET_MARKER.len())
            .any(|window| window == SECRET_MARKER.as_bytes()));
    }

    #[test]
    fn authorization_requests_are_idempotent_and_payload_bound() {
        let temp = tempfile::tempdir().unwrap();
        let store_root = temp.path().join("foundation");
        create_store(&database_path(&store_root)).unwrap();
        register_source_at(&store_root, register_input(temp.path(), "source-1")).unwrap();
        let input = grant_input("source-1", "grant-1");
        let first = change_consent_at(&store_root, input.clone()).unwrap();
        let duplicate = change_consent_at(&store_root, input.clone()).unwrap();
        assert!(duplicate.duplicate);
        assert_eq!(duplicate.receipt_sha256, first.receipt_sha256);

        let mut drift = input;
        drift.include_globs = Some(vec!["**/*.txt".to_string()]);
        assert!(change_consent_at(&store_root, drift)
            .unwrap_err()
            .contains("another payload"));
    }

    #[test]
    fn concurrent_authorization_changes_have_one_generation_winner() {
        let temp = tempfile::tempdir().unwrap();
        let store_root = temp.path().join("foundation");
        create_store(&database_path(&store_root)).unwrap();
        register_source_at(&store_root, register_input(temp.path(), "source-1")).unwrap();
        let root = store_root;
        let barrier = Arc::new(Barrier::new(2));
        let mut handles = Vec::new();
        for request_id in ["grant-a", "grant-b"] {
            let root = root.clone();
            let barrier = barrier.clone();
            let input = grant_input("source-1", request_id);
            handles.push(thread::spawn(move || {
                barrier.wait();
                change_consent_at(&root, input)
            }));
        }
        let results: Vec<Result<RagConsentReceipt, String>> = handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect();
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(results.iter().filter(|result| result.is_err()).count(), 1);
        assert!(results
            .iter()
            .filter_map(|result| result.as_ref().err())
            .any(|error| error.contains("generation mismatch")));
    }

    #[cfg(unix)]
    #[test]
    fn source_root_symlinks_are_rejected() {
        use std::os::unix::fs::symlink;
        let temp = tempfile::tempdir().unwrap();
        let real = temp.path().join("real");
        let link = temp.path().join("link");
        fs::create_dir(&real).unwrap();
        symlink(&real, &link).unwrap();
        assert!(
            normalize_source_root("directory", &link.display().to_string())
                .unwrap_err()
                .contains("symlinks")
        );
    }

    #[test]
    fn malformed_current_schema_fails_closed_without_reinitialization() {
        let temp = tempfile::tempdir().unwrap();
        let path = database_path(temp.path());
        let connection = Connection::open(&path).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE rag_consent_meta(id INTEGER, schema_version INTEGER, schema_sha256 TEXT, created_at_ms INTEGER);",
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO rag_consent_meta VALUES(1, 1, ?1, 1)",
                [sha256_hex(RAG_SCHEMA_SQL.as_bytes())],
            )
            .unwrap();
        drop(connection);
        let inspection = inspect_store(&path);
        assert!(inspection.initialized);
        assert!(!inspection.ready);
        assert!(inspection
            .blocked_reason
            .unwrap()
            .contains("shape mismatch"));
        assert!(create_store(&path).unwrap_err().contains("shape mismatch"));
    }
}
