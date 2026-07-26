//! Disabled-by-default contract boundary for future Black Box managed model
//! access.
//!
//! The module persists only synthetic/evidence-pending provider onboarding
//! contracts, no-effect route proposals, zero-money ledger intents and pending
//! unknown-outcome reconciliation cases in an explicitly isolated profile.
//! Every open re-attests the complete reviewed SQLite DDL, including CHECK
//! constraints and trigger bodies. It has no networking, credential retrieval,
//! provider dispatch, balance mutation, payment processor or production UI
//! integration.

use chrono::Utc;
use rusqlite::{params, Connection, OpenFlags, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::ffi::OsString;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::time::Duration;
use uuid::Uuid;

const MANAGED_PROVIDER_FLAG: &str = "BLACKBOX_EXPERIMENTAL_MANAGED_PROVIDER_V1";
const HOME_OVERRIDE: &str = "BLACKBOX_EXPERIMENTAL_HOME";
const SCHEMA_VERSION: i64 = 1;
const SCHEMA_SQL: &str = include_str!("../resources/experimental/managed-provider-v1.sql");
const PROVIDER_IDS: &[&str] = &[
    "anthropic",
    "openai",
    "gemini",
    "deepseek",
    "glm",
    "doubao",
    "qwen",
    "minimax",
    "kimi",
];
const TIER_SLOTS: &[&str] = &["frontier", "high", "balanced", "fast"];
const AUXILIARY_EXECUTION_CLASSES: &[&str] = &["subagent", "web_search", "web_fetch"];

const TABLE_SHAPES: &[(&str, &[&str])] = &[
    (
        "managed_provider_meta",
        &["id", "schema_version", "schema_sha256", "created_at_ms"],
    ),
    (
        "managed_provider_money_policy",
        &[
            "scope_kind",
            "scope_id",
            "real_money_enabled",
            "policy_revision",
            "reason",
            "updated_at_ms",
        ],
    ),
    (
        "managed_provider_onboarding_contract",
        &[
            "record_id",
            "revision",
            "contract_status",
            "provider_id",
            "provider_sku",
            "model_family_id",
            "logical_tier",
            "supply_mode",
            "product_flow",
            "serving_region",
            "inference_region",
            "storage_region",
            "billing_region",
            "pricing_snapshot_id",
            "currency",
            "credential_route_class",
            "credential_reference_sha256",
            "evidence_bundle_sha256",
            "scope_sha256",
            "decision_sha256",
            "idempotency_key",
            "payload_sha256",
            "provider_authorization_effective",
            "renderer_credential_access",
            "api_credential_return",
            "dispatch_enabled",
            "real_money_enabled",
            "created_at_ms",
        ],
    ),
    (
        "managed_provider_route_contract",
        &[
            "tenant_id",
            "organization_id",
            "request_id",
            "attempt_id",
            "execution_class",
            "requested_tier",
            "model_id",
            "auxiliary_eligible",
            "allow_primary_fallback",
            "record_id",
            "onboarding_revision",
            "onboarding_scope_sha256",
            "onboarding_decision_sha256",
            "provider_id",
            "supply_mode",
            "pricing_snapshot_id",
            "currency",
            "credential_route_class",
            "credential_reference_sha256",
            "maximum_cost_micros",
            "binding_sha256",
            "route_state",
            "idempotency_key",
            "payload_sha256",
            "global_real_money_enabled",
            "provider_real_money_enabled",
            "tenant_real_money_enabled",
            "dispatch_enabled",
            "credential_access_enabled",
            "external_effects",
            "created_at_ms",
            "updated_at_ms",
        ],
    ),
    (
        "managed_provider_ledger_intent",
        &[
            "ledger_intent_id",
            "tenant_id",
            "organization_id",
            "request_id",
            "attempt_id",
            "operation_kind",
            "amount_micros",
            "currency",
            "onboarding_decision_sha256",
            "binding_sha256",
            "intent_state",
            "real_money_enabled",
            "balance_mutation_enabled",
            "external_effects",
            "created_at_ms",
        ],
    ),
    (
        "managed_provider_reconciliation_case",
        &[
            "reconciliation_case_id",
            "tenant_id",
            "organization_id",
            "request_id",
            "attempt_id",
            "binding_sha256",
            "outcome_kind",
            "case_status",
            "reason_sha256",
            "provider_request_reference_sha256",
            "idempotency_key",
            "payload_sha256",
            "automatic_settlement_enabled",
            "real_money_enabled",
            "external_effects",
            "created_at_ms",
        ],
    ),
];

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExperimentalManagedProviderStatus {
    enabled: bool,
    initialized: bool,
    ready: bool,
    path: String,
    schema_version: Option<i64>,
    schema_sha256: String,
    exact_schema_ddl_sha256: String,
    exact_schema_ddl_verified: bool,
    production_integration: bool,
    provider_dispatch_enabled: bool,
    real_money_collection_enabled: bool,
    balance_mutation_enabled: bool,
    hosted_credential_access_enabled: bool,
    renderer_credential_access_enabled: bool,
    required_providers: Vec<String>,
    logical_tier_slots: Vec<String>,
    auxiliary_execution_classes: Vec<String>,
    money_kill_switch_scopes: Vec<String>,
    blocked_reason: Option<String>,
}

#[cfg(all(test, not(unix)))]
mod unsupported_platform_tests {
    use super::*;

    #[test]
    fn unsupported_platform_is_disabled_and_cannot_create_a_store() {
        let temp = tempfile::tempdir().unwrap();
        let path = database_path(temp.path());
        assert!(!platform_supported());
        assert!(!feature_enabled());
        assert!(create_store(&path).is_err());
        assert!(!path.exists());

        let status = status_at(temp.path(), true);
        assert!(!status.enabled);
        assert!(!status.ready);
        assert!(!status.initialized);
        assert!(status
            .blocked_reason
            .as_deref()
            .is_some_and(|reason| reason.contains("Unix platforms only")));
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RegisterProviderContractInput {
    record_id: String,
    revision: u64,
    contract_status: String,
    provider_id: String,
    provider_sku: String,
    model_family_id: String,
    logical_tier: String,
    supply_mode: String,
    serving_region: String,
    inference_region: String,
    storage_region: String,
    billing_region: String,
    pricing_snapshot_id: String,
    currency: String,
    credential_reference_sha256: String,
    evidence_bundle_sha256: Option<String>,
    idempotency_key: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderContractReceipt {
    record_id: String,
    revision: u64,
    contract_status: String,
    provider_id: String,
    provider_sku: String,
    model_family_id: String,
    logical_tier: String,
    supply_mode: String,
    product_flow: String,
    credential_route_class: String,
    scope_sha256: String,
    onboarding_decision_sha256: String,
    provider_authorization_effective: bool,
    routing_eligible: bool,
    dispatch_enabled: bool,
    real_money_collection_enabled: bool,
    renderer_credential_access_enabled: bool,
    duplicate: bool,
    production_integration: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CreateManagedRouteContractInput {
    tenant_id: String,
    organization_id: String,
    request_id: String,
    attempt_id: String,
    execution_class: String,
    requested_tier: String,
    model_id: String,
    auxiliary_eligible: bool,
    allow_primary_fallback: bool,
    onboarding_record_id: String,
    onboarding_revision: u64,
    expected_onboarding_decision_sha256: String,
    maximum_cost_micros: u64,
    idempotency_key: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ManagedRouteContractReceipt {
    tenant_id: String,
    organization_id: String,
    request_id: String,
    attempt_id: String,
    execution_class: String,
    requested_tier: String,
    provider_id: String,
    model_id: String,
    supply_mode: String,
    onboarding_decision_sha256: String,
    binding_sha256: String,
    ledger_intent_id: String,
    route_state: String,
    auxiliary_route_forced: bool,
    primary_fallback_enabled: bool,
    global_real_money_enabled: bool,
    provider_real_money_enabled: bool,
    tenant_real_money_enabled: bool,
    dispatch_enabled: bool,
    credential_access_enabled: bool,
    balance_mutation_enabled: bool,
    external_effects: u8,
    duplicate: bool,
    production_integration: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RecordUnknownOutcomeInput {
    tenant_id: String,
    organization_id: String,
    request_id: String,
    attempt_id: String,
    expected_binding_sha256: String,
    reason_sha256: String,
    provider_request_reference_sha256: Option<String>,
    contract_simulation: bool,
    idempotency_key: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UnknownOutcomeReceipt {
    reconciliation_case_id: String,
    tenant_id: String,
    organization_id: String,
    request_id: String,
    attempt_id: String,
    binding_sha256: String,
    case_status: String,
    automatic_settlement_enabled: bool,
    real_money_collection_enabled: bool,
    external_effects: u8,
    duplicate: bool,
    production_integration: bool,
}

#[derive(Clone, Debug)]
struct StoreInspection {
    initialized: bool,
    ready: bool,
    schema_version: Option<i64>,
    exact_schema_ddl_sha256: String,
    exact_schema_ddl_verified: bool,
    blocked_reason: Option<String>,
}

#[derive(Clone, Debug)]
struct OnboardingRecord {
    record_id: String,
    revision: u64,
    contract_status: String,
    provider_id: String,
    provider_sku: String,
    model_family_id: String,
    logical_tier: String,
    supply_mode: String,
    product_flow: String,
    pricing_snapshot_id: String,
    currency: String,
    credential_route_class: String,
    credential_reference_sha256: String,
    scope_sha256: String,
    decision_sha256: String,
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

fn platform_supported() -> bool {
    cfg!(unix)
}

fn require_supported_platform() -> Result<(), String> {
    if platform_supported() {
        Ok(())
    } else {
        Err(
            "Experimental managed-provider contracts are unavailable on this platform; the R3AT filesystem-isolation proof currently covers Unix platforms only"
                .to_string(),
        )
    }
}

fn feature_enabled() -> bool {
    platform_supported()
        && std::env::var(MANAGED_PROVIDER_FLAG)
            .ok()
            .map(|value| {
                matches!(
                    value.trim().to_ascii_lowercase().as_str(),
                    "1" | "true" | "yes" | "on"
                )
            })
            .unwrap_or(false)
}

fn status_root() -> Result<PathBuf, String> {
    if let Some(value) = std::env::var_os(HOME_OVERRIDE) {
        let path = PathBuf::from(value);
        if !path.is_absolute() {
            return Err(format!("{HOME_OVERRIDE} must be an absolute path"));
        }
        return Ok(path);
    }
    Ok(crate::safe_data_dir()?.join("experimental-managed-provider-v1-status-only"))
}

fn normalize_platform_root_alias(path: PathBuf) -> PathBuf {
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

fn isolated_root() -> Result<PathBuf, String> {
    require_supported_platform()?;
    if !feature_enabled() {
        return Err(format!(
            "Experimental managed-provider contracts are disabled; set {MANAGED_PROVIDER_FLAG}=1 only in an isolated profile"
        ));
    }
    let value = std::env::var_os(HOME_OVERRIDE)
        .ok_or_else(|| format!("{HOME_OVERRIDE} is required for every experimental mutation"))?;
    validate_isolated_root(PathBuf::from(value), &crate::safe_data_dir()?)
}

fn database_path(root: &Path) -> PathBuf {
    root.join("managed-provider-v1.sqlite")
}

fn regular_database_file_exists(path: &Path) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() {
                return Err(format!(
                    "Managed-provider database must not be a symlink: {}",
                    path.display()
                ));
            }
            if !metadata.is_file() {
                return Err(format!(
                    "Managed-provider database must be a regular file: {}",
                    path.display()
                ));
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::MetadataExt;
                if metadata.nlink() != 1 {
                    return Err(format!(
                        "Managed-provider database must have exactly one filesystem link: {}",
                        path.display()
                    ));
                }
            }
            Ok(true)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!(
            "Failed to inspect managed-provider database {}: {error}",
            path.display()
        )),
    }
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
    reject_symlink_components(root)?;
    if root.exists() {
        let metadata = fs::symlink_metadata(root)
            .map_err(|error| format!("Failed to inspect {}: {error}", root.display()))?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err("Experimental managed-provider root must be a real directory".to_string());
        }
    } else {
        fs::create_dir_all(root)
            .map_err(|error| format!("Failed to create {}: {error}", root.display()))?;
    }
    set_directory_private(root)
}

fn acquire_init_lock(root: &Path) -> Result<InitLock, String> {
    ensure_private_root(root)?;
    let path = root.join(".managed-provider-init.lock");
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&path)
        .map_err(|error| format!("Another managed-provider initializer is active: {error}"))?;
    file.write_all(Uuid::new_v4().to_string().as_bytes())
        .map_err(|error| format!("Failed to write managed-provider initializer lock: {error}"))?;
    file.sync_all()
        .map_err(|error| format!("Failed to sync managed-provider initializer lock: {error}"))?;
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
    if !regular_database_file_exists(path)? {
        return Err(format!(
            "Managed-provider database does not exist: {}",
            path.display()
        ));
    }
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| format!("Failed to inspect {}: {error}", path.display()))?;
    connection
        .busy_timeout(Duration::from_secs(2))
        .map_err(|error| format!("Failed to configure managed-provider inspection: {error}"))?;
    connection
        .pragma_update(None, "query_only", true)
        .map_err(|error| {
            format!("Failed to make managed-provider inspection read-only: {error}")
        })?;
    Ok(connection)
}

fn open_read_write(path: &Path) -> Result<Connection, String> {
    if !regular_database_file_exists(path)? {
        return Err(format!(
            "Managed-provider database does not exist: {}",
            path.display()
        ));
    }
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| format!("Failed to open {}: {error}", path.display()))?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(|error| format!("Failed to configure managed-provider writer: {error}"))?;
    connection
        .pragma_update(None, "foreign_keys", true)
        .map_err(|error| format!("Failed to enable managed-provider foreign keys: {error}"))?;
    connection
        .pragma_update(None, "synchronous", "FULL")
        .map_err(|error| format!("Failed to enable durable managed-provider writes: {error}"))?;
    connection
        .pragma_update(None, "secure_delete", true)
        .map_err(|error| format!("Failed to enable secure managed-provider deletion: {error}"))?;
    Ok(connection)
}

fn sqlite_quick_check(connection: &Connection) -> Result<(), String> {
    let result: String = connection
        .query_row("PRAGMA quick_check", [], |row| row.get(0))
        .map_err(|error| format!("Managed-provider SQLite quick_check failed: {error}"))?;
    if result == "ok" {
        Ok(())
    } else {
        Err(format!(
            "Managed-provider SQLite quick_check reported {result}"
        ))
    }
}

fn table_columns(connection: &Connection, table: &str) -> Result<Vec<String>, String> {
    let quoted = table.replace('"', "\"\"");
    let mut statement = connection
        .prepare(&format!("PRAGMA table_info(\"{quoted}\")"))
        .map_err(|error| format!("Failed to inspect managed-provider table {table}: {error}"))?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| format!("Failed to read managed-provider table {table}: {error}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Failed to decode managed-provider table {table}: {error}"))
}

fn inspect_store(path: &Path) -> StoreInspection {
    let exists = match regular_database_file_exists(path) {
        Ok(exists) => exists,
        Err(error) => {
            return StoreInspection {
                initialized: true,
                ready: false,
                schema_version: None,
                exact_schema_ddl_sha256: String::new(),
                exact_schema_ddl_verified: false,
                blocked_reason: Some(error),
            };
        }
    };
    if !exists {
        return StoreInspection {
            initialized: false,
            ready: false,
            schema_version: None,
            exact_schema_ddl_sha256: String::new(),
            exact_schema_ddl_verified: false,
            blocked_reason: None,
        };
    }
    let result = (|| -> Result<(i64, String), String> {
        let connection = open_read_only(path)?;
        sqlite_quick_check(&connection)?;
        let (version, stored_hash): (i64, String) = connection
            .query_row(
                "SELECT schema_version, schema_sha256 FROM managed_provider_meta WHERE id = 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(|error| format!("Managed-provider schema metadata is missing: {error}"))?;
        let expected_hash = sha256_hex(SCHEMA_SQL.as_bytes());
        if version != SCHEMA_VERSION || stored_hash != expected_hash {
            return Err("Managed-provider schema identity mismatch".to_string());
        }
        let attestation = crate::experimental_sqlite_attestation::attest_exact_schema(
            &connection,
            SCHEMA_SQL,
            "Managed provider",
        )?;
        for (table, expected) in TABLE_SHAPES {
            let actual = table_columns(&connection, table)?;
            let expected: Vec<String> = expected.iter().map(|value| (*value).to_string()).collect();
            if actual != expected {
                return Err(format!("Managed-provider table shape mismatch: {table}"));
            }
        }
        let global_money: i64 = connection
            .query_row(
                "SELECT real_money_enabled FROM managed_provider_money_policy WHERE scope_kind = 'global' AND scope_id = '*'",
                [],
                |row| row.get(0),
            )
            .map_err(|error| format!("Managed-provider global kill switch is missing: {error}"))?;
        if global_money != 0 {
            return Err("Managed-provider global real-money kill switch is not off".to_string());
        }
        Ok((version, attestation.actual_manifest_sha256))
    })();
    match result {
        Ok((version, exact_schema_ddl_sha256)) => StoreInspection {
            initialized: true,
            ready: true,
            schema_version: Some(version),
            exact_schema_ddl_sha256,
            exact_schema_ddl_verified: true,
            blocked_reason: None,
        },
        Err(error) => StoreInspection {
            initialized: true,
            ready: false,
            schema_version: None,
            exact_schema_ddl_sha256: String::new(),
            exact_schema_ddl_verified: false,
            blocked_reason: Some(error),
        },
    }
}

fn status_at(root: &Path, enabled: bool) -> ExperimentalManagedProviderStatus {
    let path = database_path(root);
    let inspection = if platform_supported() {
        inspect_store(&path)
    } else {
        StoreInspection {
            initialized: false,
            ready: false,
            schema_version: None,
            exact_schema_ddl_sha256: String::new(),
            exact_schema_ddl_verified: false,
            blocked_reason: Some(
                "Experimental managed-provider contracts are unavailable on this platform; the R3AT filesystem-isolation proof currently covers Unix platforms only"
                    .to_string(),
            ),
        }
    };
    ExperimentalManagedProviderStatus {
        enabled: enabled && platform_supported(),
        initialized: inspection.initialized,
        ready: enabled && inspection.ready,
        path: path.display().to_string(),
        schema_version: inspection.schema_version,
        schema_sha256: sha256_hex(SCHEMA_SQL.as_bytes()),
        exact_schema_ddl_sha256: inspection.exact_schema_ddl_sha256,
        exact_schema_ddl_verified: inspection.exact_schema_ddl_verified,
        production_integration: false,
        provider_dispatch_enabled: false,
        real_money_collection_enabled: false,
        balance_mutation_enabled: false,
        hosted_credential_access_enabled: false,
        renderer_credential_access_enabled: false,
        required_providers: PROVIDER_IDS
            .iter()
            .map(|value| (*value).to_string())
            .collect(),
        logical_tier_slots: TIER_SLOTS
            .iter()
            .map(|value| (*value).to_string())
            .collect(),
        auxiliary_execution_classes: AUXILIARY_EXECUTION_CLASSES
            .iter()
            .map(|value| (*value).to_string())
            .collect(),
        money_kill_switch_scopes: vec![
            "global".to_string(),
            "provider".to_string(),
            "tenant".to_string(),
        ],
        blocked_reason: inspection.blocked_reason,
    }
}

#[tauri::command]
pub(crate) fn get_experimental_managed_provider_status(
) -> Result<ExperimentalManagedProviderStatus, String> {
    Ok(status_at(&status_root()?, feature_enabled()))
}

fn create_store(path: &Path) -> Result<(), String> {
    require_supported_platform()?;
    let root = path
        .parent()
        .ok_or("Managed-provider database path has no parent")?;
    let _lock = acquire_init_lock(root)?;
    if regular_database_file_exists(path)? {
        let inspection = inspect_store(path);
        return if inspection.ready {
            Ok(())
        } else {
            Err(inspection
                .blocked_reason
                .unwrap_or_else(|| "Managed-provider contract store is not ready".to_string()))
        };
    }
    let staging = root.join(format!(".managed-provider-v1.{}.sqlite", Uuid::new_v4()));
    let result = (|| -> Result<(), String> {
        let connection = Connection::open(&staging)
            .map_err(|error| format!("Failed to create staged managed-provider store: {error}"))?;
        connection
            .busy_timeout(Duration::from_secs(5))
            .map_err(|error| {
                format!("Failed to configure staged managed-provider store: {error}")
            })?;
        connection
            .execute_batch(SCHEMA_SQL)
            .map_err(|error| format!("Failed to apply managed-provider schema: {error}"))?;
        crate::experimental_sqlite_attestation::attest_exact_schema(
            &connection,
            SCHEMA_SQL,
            "Managed provider",
        )?;
        let timestamp = now_ms();
        connection
            .execute(
                "INSERT INTO managed_provider_meta(id, schema_version, schema_sha256, created_at_ms) VALUES(1, 1, ?1, ?2)",
                params![sha256_hex(SCHEMA_SQL.as_bytes()), timestamp],
            )
            .map_err(|error| format!("Failed to bind managed-provider schema identity: {error}"))?;
        let revision = sha256_hex(b"blackbox-managed-provider-v1|global|real-money-off");
        connection
            .execute(
                "INSERT INTO managed_provider_money_policy(scope_kind, scope_id, real_money_enabled, policy_revision, reason, updated_at_ms) VALUES('global', '*', 0, ?1, 'contract_slice_hard_stop', ?2)",
                params![revision, timestamp],
            )
            .map_err(|error| format!("Failed to install global managed-provider kill switch: {error}"))?;
        connection
            .pragma_update(None, "user_version", SCHEMA_VERSION)
            .map_err(|error| format!("Failed to set managed-provider schema version: {error}"))?;
        sqlite_quick_check(&connection)?;
        drop(connection);
        set_file_private(&staging)?;
        sync_file_and_parent(&staging)?;
        if regular_database_file_exists(path)? {
            return Err(
                "Managed-provider store appeared during initialization; refusing overwrite"
                    .to_string(),
            );
        }
        fs::rename(&staging, path)
            .map_err(|error| format!("Failed to publish managed-provider store: {error}"))?;
        sync_file_and_parent(path)?;
        let inspection = inspect_store(path);
        if !inspection.ready {
            return Err(inspection.blocked_reason.unwrap_or_else(|| {
                "Published managed-provider store failed inspection".to_string()
            }));
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&staging);
    }
    result
}

#[tauri::command]
pub(crate) fn initialize_experimental_managed_provider_store(
) -> Result<ExperimentalManagedProviderStatus, String> {
    let root = isolated_root()?;
    create_store(&database_path(&root))?;
    Ok(status_at(&root, true))
}

fn ready_database(root: &Path) -> Result<PathBuf, String> {
    let path = database_path(root);
    let inspection = inspect_store(&path);
    if inspection.ready {
        Ok(path)
    } else {
        Err(inspection
            .blocked_reason
            .unwrap_or_else(|| "Managed-provider contract store is not initialized".to_string()))
    }
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
    if value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        Ok(())
    } else {
        Err(format!(
            "{name} must be a lowercase 64-character SHA-256 hex digest"
        ))
    }
}

fn product_flow(supply_mode: &str) -> Result<&'static str, String> {
    match supply_mode {
        "managed" => Ok("server_side_managed_application"),
        "channel" => Ok("authorized_channel_service"),
        _ => Err("supplyMode must be managed or channel; BYOK has a separate path".to_string()),
    }
}

fn credential_route_class(supply_mode: &str) -> Result<&'static str, String> {
    match supply_mode {
        "managed" => Ok("hosted_blackbox_managed"),
        "channel" => Ok("hosted_authorized_channel"),
        _ => Err("Unsupported managed-provider credential route".to_string()),
    }
}

fn validate_contract_input(input: &RegisterProviderContractInput) -> Result<(), String> {
    validate_token("recordId", &input.record_id)?;
    validate_token("idempotencyKey", &input.idempotency_key)?;
    if input.revision == 0 || input.revision > i64::MAX as u64 {
        return Err("revision must be between 1 and i64::MAX".to_string());
    }
    if !matches!(
        input.contract_status.as_str(),
        "evidencePending" | "syntheticValidated"
    ) {
        return Err("contractStatus must be evidencePending or syntheticValidated".to_string());
    }
    if !PROVIDER_IDS.contains(&input.provider_id.as_str()) {
        return Err("providerId is outside the fixed nine-provider contract".to_string());
    }
    validate_token("providerSku", &input.provider_sku)?;
    validate_token("modelFamilyId", &input.model_family_id)?;
    if !TIER_SLOTS.contains(&input.logical_tier.as_str()) {
        return Err("logicalTier is outside the four logical slots".to_string());
    }
    product_flow(&input.supply_mode)?;
    for (name, value) in [
        ("servingRegion", &input.serving_region),
        ("inferenceRegion", &input.inference_region),
        ("storageRegion", &input.storage_region),
        ("billingRegion", &input.billing_region),
    ] {
        validate_token(name, value)?;
    }
    validate_token("pricingSnapshotId", &input.pricing_snapshot_id)?;
    if input.currency.len() != 3 || !input.currency.bytes().all(|byte| byte.is_ascii_uppercase()) {
        return Err("currency must be a three-letter uppercase code".to_string());
    }
    validate_sha256(
        "credentialReferenceSha256",
        &input.credential_reference_sha256,
    )?;
    match (
        &*input.contract_status,
        input.evidence_bundle_sha256.as_deref(),
    ) {
        ("evidencePending", None) => {}
        ("syntheticValidated", Some(value)) => {
            validate_sha256("evidenceBundleSha256", value)?;
        }
        ("evidencePending", Some(_)) => {
            return Err(
                "evidencePending records may not claim a validated evidence bundle".to_string(),
            );
        }
        ("syntheticValidated", None) => {
            return Err("syntheticValidated records require evidenceBundleSha256".to_string());
        }
        _ => unreachable!(),
    }
    Ok(())
}

fn contract_status_storage(value: &str) -> &'static str {
    match value {
        "syntheticValidated" => "synthetic_validated",
        _ => "evidence_pending",
    }
}

fn register_contract_at(
    root: &Path,
    input: RegisterProviderContractInput,
) -> Result<ProviderContractReceipt, String> {
    require_supported_platform()?;
    validate_contract_input(&input)?;
    let product_flow = product_flow(&input.supply_mode)?.to_string();
    let credential_route_class = credential_route_class(&input.supply_mode)?.to_string();
    let scope_sha256 = sha256_hex(
        serde_json::json!({
            "schemaVersion": 1,
            "providerId": input.provider_id,
            "providerSku": input.provider_sku,
            "modelFamilyId": input.model_family_id,
            "logicalTier": input.logical_tier,
            "supplyMode": input.supply_mode,
            "productFlow": product_flow,
            "servingRegion": input.serving_region,
            "inferenceRegion": input.inference_region,
            "storageRegion": input.storage_region,
            "billingRegion": input.billing_region,
            "pricingSnapshotId": input.pricing_snapshot_id,
            "currency": input.currency,
            "credentialRouteClass": credential_route_class,
            "credentialReferenceSha256": input.credential_reference_sha256,
        })
        .to_string()
        .as_bytes(),
    );
    let decision_sha256 = sha256_hex(
        serde_json::json!({
            "recordId": input.record_id,
            "revision": input.revision,
            "contractStatus": input.contract_status,
            "scopeSha256": scope_sha256,
            "evidenceBundleSha256": input.evidence_bundle_sha256,
            "providerAuthorizationEffective": false,
            "dispatchEnabled": false,
            "realMoneyCollectionEnabled": false,
        })
        .to_string()
        .as_bytes(),
    );
    let payload_sha256 = sha256_hex(
        serde_json::json!({
            "recordId": input.record_id,
            "revision": input.revision,
            "contractStatus": input.contract_status,
            "scopeSha256": scope_sha256,
            "decisionSha256": decision_sha256,
        })
        .to_string()
        .as_bytes(),
    );
    let path = ready_database(root)?;
    let mut connection = open_read_write(&path)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("Failed to begin provider contract transaction: {error}"))?;
    let existing: Option<(String, i64, String, String)> = transaction
        .query_row(
            "SELECT record_id, revision, payload_sha256, idempotency_key FROM managed_provider_onboarding_contract WHERE (record_id = ?1 AND revision = ?2) OR idempotency_key = ?3",
            params![input.record_id, input.revision as i64, input.idempotency_key],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()
        .map_err(|error| format!("Failed to inspect prior provider contract: {error}"))?;
    if let Some((record_id, revision, stored_payload, stored_idempotency_key)) = existing {
        if record_id != input.record_id
            || revision != input.revision as i64
            || stored_payload != payload_sha256
            || stored_idempotency_key != input.idempotency_key
        {
            return Err(
                "Provider contract identity or idempotency key is bound to another payload"
                    .to_string(),
            );
        }
        transaction
            .commit()
            .map_err(|error| format!("Failed to close duplicate provider contract: {error}"))?;
        return Ok(ProviderContractReceipt {
            record_id: input.record_id,
            revision: input.revision,
            contract_status: input.contract_status,
            provider_id: input.provider_id,
            provider_sku: input.provider_sku,
            model_family_id: input.model_family_id,
            logical_tier: input.logical_tier,
            supply_mode: input.supply_mode,
            product_flow,
            credential_route_class,
            scope_sha256,
            onboarding_decision_sha256: decision_sha256,
            provider_authorization_effective: false,
            routing_eligible: false,
            dispatch_enabled: false,
            real_money_collection_enabled: false,
            renderer_credential_access_enabled: false,
            duplicate: true,
            production_integration: false,
        });
    }
    let timestamp = now_ms();
    let provider_policy_revision = sha256_hex(
        format!(
            "blackbox-managed-provider-v1|provider|{}|real-money-off",
            input.provider_id
        )
        .as_bytes(),
    );
    transaction
        .execute(
            "INSERT OR IGNORE INTO managed_provider_money_policy(scope_kind, scope_id, real_money_enabled, policy_revision, reason, updated_at_ms) VALUES('provider', ?1, 0, ?2, 'contract_slice_hard_stop', ?3)",
            params![input.provider_id, provider_policy_revision, timestamp],
        )
        .map_err(|error| format!("Failed to install provider money kill switch: {error}"))?;
    transaction
        .execute(
            "INSERT INTO managed_provider_onboarding_contract(record_id, revision, contract_status, provider_id, provider_sku, model_family_id, logical_tier, supply_mode, product_flow, serving_region, inference_region, storage_region, billing_region, pricing_snapshot_id, currency, credential_route_class, credential_reference_sha256, evidence_bundle_sha256, scope_sha256, decision_sha256, idempotency_key, payload_sha256, provider_authorization_effective, renderer_credential_access, api_credential_return, dispatch_enabled, real_money_enabled, created_at_ms) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, 0, 0, 0, 0, 0, ?23)",
            params![
                input.record_id,
                input.revision as i64,
                contract_status_storage(&input.contract_status),
                input.provider_id,
                input.provider_sku,
                input.model_family_id,
                input.logical_tier,
                input.supply_mode,
                product_flow,
                input.serving_region,
                input.inference_region,
                input.storage_region,
                input.billing_region,
                input.pricing_snapshot_id,
                input.currency,
                credential_route_class,
                input.credential_reference_sha256,
                input.evidence_bundle_sha256,
                scope_sha256,
                decision_sha256,
                input.idempotency_key,
                payload_sha256,
                timestamp,
            ],
        )
        .map_err(|error| format!("Failed to store provider contract: {error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("Failed to commit provider contract: {error}"))?;
    Ok(ProviderContractReceipt {
        record_id: input.record_id,
        revision: input.revision,
        contract_status: input.contract_status,
        provider_id: input.provider_id,
        provider_sku: input.provider_sku,
        model_family_id: input.model_family_id,
        logical_tier: input.logical_tier,
        supply_mode: input.supply_mode,
        product_flow,
        credential_route_class,
        scope_sha256,
        onboarding_decision_sha256: decision_sha256,
        provider_authorization_effective: false,
        routing_eligible: false,
        dispatch_enabled: false,
        real_money_collection_enabled: false,
        renderer_credential_access_enabled: false,
        duplicate: false,
        production_integration: false,
    })
}

#[tauri::command]
pub(crate) fn register_experimental_provider_contract(
    input: RegisterProviderContractInput,
) -> Result<ProviderContractReceipt, String> {
    register_contract_at(&isolated_root()?, input)
}

fn load_onboarding(
    transaction: &rusqlite::Transaction<'_>,
    record_id: &str,
    revision: u64,
) -> Result<OnboardingRecord, String> {
    transaction
        .query_row(
            "SELECT record_id, revision, contract_status, provider_id, provider_sku, model_family_id, logical_tier, supply_mode, product_flow, pricing_snapshot_id, currency, credential_route_class, credential_reference_sha256, scope_sha256, decision_sha256 FROM managed_provider_onboarding_contract WHERE record_id = ?1 AND revision = ?2",
            params![record_id, revision as i64],
            |row| {
                Ok(OnboardingRecord {
                    record_id: row.get(0)?,
                    revision: u64::try_from(row.get::<_, i64>(1)?).unwrap_or_default(),
                    contract_status: row.get(2)?,
                    provider_id: row.get(3)?,
                    provider_sku: row.get(4)?,
                    model_family_id: row.get(5)?,
                    logical_tier: row.get(6)?,
                    supply_mode: row.get(7)?,
                    product_flow: row.get(8)?,
                    pricing_snapshot_id: row.get(9)?,
                    currency: row.get(10)?,
                    credential_route_class: row.get(11)?,
                    credential_reference_sha256: row.get(12)?,
                    scope_sha256: row.get(13)?,
                    decision_sha256: row.get(14)?,
                })
            },
        )
        .optional()
        .map_err(|error| format!("Failed to load provider onboarding contract: {error}"))?
        .ok_or_else(|| "Provider onboarding contract does not exist".to_string())
}

fn validate_route_input(input: &CreateManagedRouteContractInput) -> Result<(), String> {
    for (name, value) in [
        ("tenantId", &input.tenant_id),
        ("organizationId", &input.organization_id),
        ("requestId", &input.request_id),
        ("attemptId", &input.attempt_id),
        ("onboardingRecordId", &input.onboarding_record_id),
        ("idempotencyKey", &input.idempotency_key),
    ] {
        validate_token(name, value)?;
    }
    validate_label("modelId", &input.model_id, 128)?;
    if input.onboarding_revision == 0 || input.onboarding_revision > i64::MAX as u64 {
        return Err("onboardingRevision must be between 1 and i64::MAX".to_string());
    }
    validate_sha256(
        "expectedOnboardingDecisionSha256",
        &input.expected_onboarding_decision_sha256,
    )?;
    if !matches!(
        input.execution_class.as_str(),
        "conversation" | "subagent" | "webSearch" | "webFetch"
    ) {
        return Err(
            "executionClass must be conversation, subagent, webSearch or webFetch".to_string(),
        );
    }
    if !TIER_SLOTS.contains(&input.requested_tier.as_str()) {
        return Err("requestedTier is outside the four logical slots".to_string());
    }
    if input.maximum_cost_micros == 0 || input.maximum_cost_micros > i64::MAX as u64 {
        return Err("maximumCostMicros must be between 1 and i64::MAX".to_string());
    }
    let auxiliary = input.execution_class != "conversation";
    if auxiliary
        && (!input.auxiliary_eligible
            || input.allow_primary_fallback
            || !matches!(input.requested_tier.as_str(), "balanced" | "fast"))
    {
        return Err(
            "Subagent/web routes require an auxiliary-eligible balanced/fast model and primary fallback off"
                .to_string(),
        );
    }
    Ok(())
}

fn execution_class_storage(value: &str) -> &'static str {
    match value {
        "webSearch" => "web_search",
        "webFetch" => "web_fetch",
        "subagent" => "subagent",
        _ => "conversation",
    }
}

fn create_route_at(
    root: &Path,
    input: CreateManagedRouteContractInput,
) -> Result<ManagedRouteContractReceipt, String> {
    require_supported_platform()?;
    validate_route_input(&input)?;
    let auxiliary_route_forced = input.execution_class != "conversation";
    let path = ready_database(root)?;
    let mut connection = open_read_write(&path)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("Failed to begin managed route transaction: {error}"))?;
    let onboarding = load_onboarding(
        &transaction,
        &input.onboarding_record_id,
        input.onboarding_revision,
    )?;
    if onboarding.contract_status != "synthetic_validated" {
        return Err(
            "Evidence-pending Provider contracts cannot produce even a no-effect route proposal"
                .to_string(),
        );
    }
    if onboarding.decision_sha256 != input.expected_onboarding_decision_sha256 {
        return Err("Provider onboarding decision binding mismatch".to_string());
    }
    if onboarding.model_family_id != input.model_id {
        return Err("Requested model is outside the POR-bound model family".to_string());
    }
    if onboarding.logical_tier != input.requested_tier {
        return Err("Requested tier is outside the POR-bound logical tier".to_string());
    }
    let timestamp = now_ms();
    let tenant_policy_revision = sha256_hex(
        format!(
            "blackbox-managed-provider-v1|tenant|{}|real-money-off",
            input.tenant_id
        )
        .as_bytes(),
    );
    transaction
        .execute(
            "INSERT OR IGNORE INTO managed_provider_money_policy(scope_kind, scope_id, real_money_enabled, policy_revision, reason, updated_at_ms) VALUES('tenant', ?1, 0, ?2, 'contract_slice_hard_stop', ?3)",
            params![input.tenant_id, tenant_policy_revision, timestamp],
        )
        .map_err(|error| format!("Failed to install tenant money kill switch: {error}"))?;
    let execution_class = execution_class_storage(&input.execution_class).to_string();
    let payload_sha256 = sha256_hex(
        serde_json::json!({
            "tenantId": input.tenant_id,
            "organizationId": input.organization_id,
            "requestId": input.request_id,
            "attemptId": input.attempt_id,
            "executionClass": execution_class,
            "requestedTier": input.requested_tier,
            "modelId": input.model_id,
            "auxiliaryEligible": input.auxiliary_eligible,
            "allowPrimaryFallback": input.allow_primary_fallback,
            "onboardingRecordId": input.onboarding_record_id,
            "onboardingRevision": input.onboarding_revision,
            "onboardingDecisionSha256": input.expected_onboarding_decision_sha256,
            "maximumCostMicros": input.maximum_cost_micros,
            "realMoney": false,
            "dispatchEnabled": false,
        })
        .to_string()
        .as_bytes(),
    );
    let binding_sha256 = sha256_hex(
        serde_json::json!({
            "schemaVersion": 1,
            "tenantId": input.tenant_id,
            "organizationId": input.organization_id,
            "requestId": input.request_id,
            "attemptId": input.attempt_id,
            "providerId": onboarding.provider_id,
            "providerSku": onboarding.provider_sku,
            "modelId": input.model_id,
            "tier": input.requested_tier,
            "executionClass": execution_class,
            "supplyMode": onboarding.supply_mode,
            "productFlow": onboarding.product_flow,
            "pricingSnapshotId": onboarding.pricing_snapshot_id,
            "currency": onboarding.currency,
            "onboardingDecisionSha256": onboarding.decision_sha256,
            "maximumCostMicros": input.maximum_cost_micros,
            "realMoney": false,
        })
        .to_string()
        .as_bytes(),
    );
    let existing: Option<(String, String, String, String, String, String)> = transaction
        .query_row(
            "SELECT route.request_id, route.payload_sha256, route.binding_sha256, route.route_state, ledger.ledger_intent_id, route.idempotency_key FROM managed_provider_route_contract route JOIN managed_provider_ledger_intent ledger ON ledger.tenant_id = route.tenant_id AND ledger.organization_id = route.organization_id AND ledger.request_id = route.request_id WHERE route.tenant_id = ?1 AND route.organization_id = ?2 AND (route.request_id = ?3 OR route.idempotency_key = ?4)",
            params![input.tenant_id, input.organization_id, input.request_id, input.idempotency_key],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?)),
        )
        .optional()
        .map_err(|error| format!("Failed to inspect prior managed route: {error}"))?;
    if let Some((
        request_id,
        stored_payload,
        stored_binding,
        route_state,
        ledger_intent_id,
        stored_idempotency_key,
    )) = existing
    {
        if request_id != input.request_id
            || stored_payload != payload_sha256
            || stored_binding != binding_sha256
            || stored_idempotency_key != input.idempotency_key
        {
            return Err(
                "Managed route identity or idempotency key is bound to another payload".to_string(),
            );
        }
        transaction
            .commit()
            .map_err(|error| format!("Failed to close duplicate managed route: {error}"))?;
        return Ok(ManagedRouteContractReceipt {
            tenant_id: input.tenant_id,
            organization_id: input.organization_id,
            request_id: input.request_id,
            attempt_id: input.attempt_id,
            execution_class: input.execution_class,
            requested_tier: input.requested_tier,
            provider_id: onboarding.provider_id,
            model_id: input.model_id,
            supply_mode: onboarding.supply_mode,
            onboarding_decision_sha256: onboarding.decision_sha256,
            binding_sha256,
            ledger_intent_id,
            route_state,
            auxiliary_route_forced,
            primary_fallback_enabled: false,
            global_real_money_enabled: false,
            provider_real_money_enabled: false,
            tenant_real_money_enabled: false,
            dispatch_enabled: false,
            credential_access_enabled: false,
            balance_mutation_enabled: false,
            external_effects: 0,
            duplicate: true,
            production_integration: false,
        });
    }
    let ledger_intent_id = Uuid::new_v4().to_string();
    transaction
        .execute(
            "INSERT INTO managed_provider_route_contract(tenant_id, organization_id, request_id, attempt_id, execution_class, requested_tier, model_id, auxiliary_eligible, allow_primary_fallback, record_id, onboarding_revision, onboarding_scope_sha256, onboarding_decision_sha256, provider_id, supply_mode, pricing_snapshot_id, currency, credential_route_class, credential_reference_sha256, maximum_cost_micros, binding_sha256, route_state, idempotency_key, payload_sha256, global_real_money_enabled, provider_real_money_enabled, tenant_real_money_enabled, dispatch_enabled, credential_access_enabled, external_effects, created_at_ms, updated_at_ms) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, 'prepared_no_effect', ?22, ?23, 0, 0, 0, 0, 0, 0, ?24, ?24)",
            params![
                input.tenant_id,
                input.organization_id,
                input.request_id,
                input.attempt_id,
                execution_class,
                input.requested_tier,
                input.model_id,
                if input.auxiliary_eligible { 1 } else { 0 },
                if input.allow_primary_fallback { 1 } else { 0 },
                onboarding.record_id,
                onboarding.revision as i64,
                onboarding.scope_sha256,
                onboarding.decision_sha256,
                onboarding.provider_id,
                onboarding.supply_mode,
                onboarding.pricing_snapshot_id,
                onboarding.currency,
                onboarding.credential_route_class,
                onboarding.credential_reference_sha256,
                input.maximum_cost_micros as i64,
                binding_sha256,
                input.idempotency_key,
                payload_sha256,
                timestamp,
            ],
        )
        .map_err(|error| format!("Failed to store managed route contract: {error}"))?;
    transaction
        .execute(
            "INSERT INTO managed_provider_ledger_intent(ledger_intent_id, tenant_id, organization_id, request_id, attempt_id, operation_kind, amount_micros, currency, onboarding_decision_sha256, binding_sha256, intent_state, real_money_enabled, balance_mutation_enabled, external_effects, created_at_ms) VALUES(?1, ?2, ?3, ?4, ?5, 'synthetic_reservation', ?6, ?7, ?8, ?9, 'contract_only', 0, 0, 0, ?10)",
            params![
                ledger_intent_id,
                input.tenant_id,
                input.organization_id,
                input.request_id,
                input.attempt_id,
                input.maximum_cost_micros as i64,
                onboarding.currency,
                onboarding.decision_sha256,
                binding_sha256,
                timestamp,
            ],
        )
        .map_err(|error| format!("Failed to store no-money ledger intent: {error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("Failed to commit managed route contract: {error}"))?;
    Ok(ManagedRouteContractReceipt {
        tenant_id: input.tenant_id,
        organization_id: input.organization_id,
        request_id: input.request_id,
        attempt_id: input.attempt_id,
        execution_class: input.execution_class,
        requested_tier: input.requested_tier,
        provider_id: onboarding.provider_id,
        model_id: input.model_id,
        supply_mode: onboarding.supply_mode,
        onboarding_decision_sha256: onboarding.decision_sha256,
        binding_sha256,
        ledger_intent_id,
        route_state: "prepared_no_effect".to_string(),
        auxiliary_route_forced,
        primary_fallback_enabled: false,
        global_real_money_enabled: false,
        provider_real_money_enabled: false,
        tenant_real_money_enabled: false,
        dispatch_enabled: false,
        credential_access_enabled: false,
        balance_mutation_enabled: false,
        external_effects: 0,
        duplicate: false,
        production_integration: false,
    })
}

#[tauri::command]
pub(crate) fn create_experimental_managed_route_contract(
    input: CreateManagedRouteContractInput,
) -> Result<ManagedRouteContractReceipt, String> {
    create_route_at(&isolated_root()?, input)
}

fn record_unknown_outcome_at(
    root: &Path,
    input: RecordUnknownOutcomeInput,
) -> Result<UnknownOutcomeReceipt, String> {
    require_supported_platform()?;
    for (name, value) in [
        ("tenantId", &input.tenant_id),
        ("organizationId", &input.organization_id),
        ("requestId", &input.request_id),
        ("attemptId", &input.attempt_id),
        ("idempotencyKey", &input.idempotency_key),
    ] {
        validate_token(name, value)?;
    }
    validate_sha256("expectedBindingSha256", &input.expected_binding_sha256)?;
    validate_sha256("reasonSha256", &input.reason_sha256)?;
    if let Some(reference) = input.provider_request_reference_sha256.as_deref() {
        validate_sha256("providerRequestReferenceSha256", reference)?;
    }
    if !input.contract_simulation {
        return Err(
            "Unknown outcomes are accepted only as explicit contractSimulation in this no-dispatch slice"
                .to_string(),
        );
    }
    let payload_sha256 = sha256_hex(
        serde_json::json!({
            "tenantId": input.tenant_id,
            "organizationId": input.organization_id,
            "requestId": input.request_id,
            "attemptId": input.attempt_id,
            "bindingSha256": input.expected_binding_sha256,
            "reasonSha256": input.reason_sha256,
            "providerRequestReferenceSha256": input.provider_request_reference_sha256,
            "contractSimulation": true,
        })
        .to_string()
        .as_bytes(),
    );
    let path = ready_database(root)?;
    let mut connection = open_read_write(&path)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("Failed to begin reconciliation transaction: {error}"))?;
    let existing: Option<(String, String, String, String, String)> = transaction
        .query_row(
            "SELECT reconciliation_case_id, request_id, payload_sha256, binding_sha256, idempotency_key FROM managed_provider_reconciliation_case WHERE tenant_id = ?1 AND organization_id = ?2 AND (request_id = ?3 OR idempotency_key = ?4)",
            params![input.tenant_id, input.organization_id, input.request_id, input.idempotency_key],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        )
        .optional()
        .map_err(|error| format!("Failed to inspect prior reconciliation case: {error}"))?;
    if let Some((case_id, request_id, stored_payload, stored_binding, stored_idempotency_key)) =
        existing
    {
        if request_id != input.request_id
            || stored_payload != payload_sha256
            || stored_binding != input.expected_binding_sha256
            || stored_idempotency_key != input.idempotency_key
        {
            return Err(
                "Reconciliation identity or idempotency key is bound to another payload"
                    .to_string(),
            );
        }
        transaction
            .commit()
            .map_err(|error| format!("Failed to close duplicate reconciliation case: {error}"))?;
        return Ok(UnknownOutcomeReceipt {
            reconciliation_case_id: case_id,
            tenant_id: input.tenant_id,
            organization_id: input.organization_id,
            request_id: input.request_id,
            attempt_id: input.attempt_id,
            binding_sha256: input.expected_binding_sha256,
            case_status: "pending".to_string(),
            automatic_settlement_enabled: false,
            real_money_collection_enabled: false,
            external_effects: 0,
            duplicate: true,
            production_integration: false,
        });
    }
    let route: Option<(String, String)> = transaction
        .query_row(
            "SELECT attempt_id, route_state FROM managed_provider_route_contract WHERE tenant_id = ?1 AND organization_id = ?2 AND request_id = ?3 AND binding_sha256 = ?4",
            params![input.tenant_id, input.organization_id, input.request_id, input.expected_binding_sha256],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|error| format!("Failed to inspect managed route for reconciliation: {error}"))?;
    let Some((attempt_id, route_state)) = route else {
        return Err("Unknown outcome is outside the tenant/org/route binding".to_string());
    };
    if attempt_id != input.attempt_id || route_state != "prepared_no_effect" {
        return Err("Unknown outcome is outside the active attempt or route state".to_string());
    }
    let case_id = Uuid::new_v4().to_string();
    let timestamp = now_ms();
    transaction
        .execute(
            "INSERT INTO managed_provider_reconciliation_case(reconciliation_case_id, tenant_id, organization_id, request_id, attempt_id, binding_sha256, outcome_kind, case_status, reason_sha256, provider_request_reference_sha256, idempotency_key, payload_sha256, automatic_settlement_enabled, real_money_enabled, external_effects, created_at_ms) VALUES(?1, ?2, ?3, ?4, ?5, ?6, 'unknown', 'pending', ?7, ?8, ?9, ?10, 0, 0, 0, ?11)",
            params![
                case_id,
                input.tenant_id,
                input.organization_id,
                input.request_id,
                input.attempt_id,
                input.expected_binding_sha256,
                input.reason_sha256,
                input.provider_request_reference_sha256,
                input.idempotency_key,
                payload_sha256,
                timestamp,
            ],
        )
        .map_err(|error| format!("Failed to create pending reconciliation case: {error}"))?;
    transaction
        .execute(
            "UPDATE managed_provider_route_contract SET route_state = 'reconciliation_pending', updated_at_ms = ?1 WHERE tenant_id = ?2 AND organization_id = ?3 AND request_id = ?4 AND binding_sha256 = ?5 AND route_state = 'prepared_no_effect'",
            params![timestamp, input.tenant_id, input.organization_id, input.request_id, input.expected_binding_sha256],
        )
        .map_err(|error| format!("Failed to bind route to pending reconciliation: {error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("Failed to commit pending reconciliation case: {error}"))?;
    Ok(UnknownOutcomeReceipt {
        reconciliation_case_id: case_id,
        tenant_id: input.tenant_id,
        organization_id: input.organization_id,
        request_id: input.request_id,
        attempt_id: input.attempt_id,
        binding_sha256: input.expected_binding_sha256,
        case_status: "pending".to_string(),
        automatic_settlement_enabled: false,
        real_money_collection_enabled: false,
        external_effects: 0,
        duplicate: false,
        production_integration: false,
    })
}

#[tauri::command]
pub(crate) fn record_experimental_managed_unknown_outcome(
    input: RecordUnknownOutcomeInput,
) -> Result<UnknownOutcomeReceipt, String> {
    record_unknown_outcome_at(&isolated_root()?, input)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn digest(seed: &str) -> String {
        sha256_hex(seed.as_bytes())
    }

    fn contract(status: &str, idempotency_key: &str) -> RegisterProviderContractInput {
        RegisterProviderContractInput {
            record_id: "por-fixture-openai-1".to_string(),
            revision: 1,
            contract_status: status.to_string(),
            provider_id: "openai".to_string(),
            provider_sku: "openai-frontier-fixture".to_string(),
            model_family_id: "openai-frontier-fixture".to_string(),
            logical_tier: "frontier".to_string(),
            supply_mode: "managed".to_string(),
            serving_region: "SG".to_string(),
            inference_region: "SG".to_string(),
            storage_region: "SG".to_string(),
            billing_region: "SG".to_string(),
            pricing_snapshot_id: "price-fixture-v1".to_string(),
            currency: "USD".to_string(),
            credential_reference_sha256: digest("secret-manager-fixture-ref"),
            evidence_bundle_sha256: (status == "syntheticValidated")
                .then(|| digest("synthetic-evidence-bundle")),
            idempotency_key: idempotency_key.to_string(),
        }
    }

    fn route(decision: &str, idempotency_key: &str) -> CreateManagedRouteContractInput {
        CreateManagedRouteContractInput {
            tenant_id: "tenant-fixture".to_string(),
            organization_id: "organization-fixture".to_string(),
            request_id: "request-fixture".to_string(),
            attempt_id: "attempt-fixture".to_string(),
            execution_class: "conversation".to_string(),
            requested_tier: "frontier".to_string(),
            model_id: "openai-frontier-fixture".to_string(),
            auxiliary_eligible: false,
            allow_primary_fallback: false,
            onboarding_record_id: "por-fixture-openai-1".to_string(),
            onboarding_revision: 1,
            expected_onboarding_decision_sha256: decision.to_string(),
            maximum_cost_micros: 1_000_000,
            idempotency_key: idempotency_key.to_string(),
        }
    }

    fn initialized_root() -> (tempfile::TempDir, PathBuf) {
        let temp = tempfile::tempdir().unwrap();
        let root = normalize_platform_root_alias(temp.path().join("isolated-managed-provider"));
        create_store(&database_path(&root)).unwrap();
        (temp, root)
    }

    #[test]
    fn status_is_fail_closed_and_covers_nine_providers_four_tiers() {
        let temp = tempfile::tempdir().unwrap();
        let status = status_at(temp.path(), false);
        assert!(!status.enabled);
        assert!(!status.ready);
        assert!(!status.production_integration);
        assert!(!status.provider_dispatch_enabled);
        assert!(!status.real_money_collection_enabled);
        assert!(!status.balance_mutation_enabled);
        assert!(!status.hosted_credential_access_enabled);
        assert!(!status.renderer_credential_access_enabled);
        assert_eq!(status.required_providers.len(), 9);
        assert_eq!(status.logical_tier_slots.len(), 4);
        assert_eq!(status.money_kill_switch_scopes.len(), 3);
    }

    #[test]
    fn store_initialization_is_staged_private_and_schema_bound() {
        let (_temp, root) = initialized_root();
        let path = database_path(&root);
        let inspection = inspect_store(&path);
        assert!(inspection.ready);
        assert_eq!(inspection.schema_version, Some(1));
        assert!(inspection.exact_schema_ddl_verified);
        assert_eq!(inspection.exact_schema_ddl_sha256.len(), 64);
        let status = status_at(&root, true);
        assert!(status.exact_schema_ddl_verified);
        assert_eq!(status.exact_schema_ddl_sha256.len(), 64);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&root).unwrap().permissions().mode() & 0o777,
                0o700
            );
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        let connection = open_read_write(&path).unwrap();
        assert!(connection
            .execute(
                "UPDATE managed_provider_money_policy SET real_money_enabled = 1 WHERE scope_kind = 'global'",
                [],
            )
            .is_err());
    }

    #[test]
    fn trigger_body_drift_blocks_every_mutation_until_exact_ddl_is_restored() {
        let (_temp, root) = initialized_root();
        let path = database_path(&root);
        let trigger_name = "managed_provider_route_por_binding_guard";
        let connection = open_read_write(&path).unwrap();
        let original_trigger_sql: String = connection
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?1",
                params![trigger_name],
                |row| row.get(0),
            )
            .unwrap();
        connection
            .execute_batch(
                "DROP TRIGGER managed_provider_route_por_binding_guard;
                 CREATE TRIGGER managed_provider_route_por_binding_guard
                 BEFORE INSERT ON managed_provider_route_contract
                 BEGIN
                   SELECT RAISE(ABORT, 'changed trigger body');
                 END;",
            )
            .unwrap();
        drop(connection);

        let blocked = inspect_store(&path);
        assert!(blocked.initialized);
        assert!(!blocked.ready);
        assert!(!blocked.exact_schema_ddl_verified);
        assert!(blocked.exact_schema_ddl_sha256.is_empty());
        assert!(blocked
            .blocked_reason
            .as_deref()
            .is_some_and(|reason| reason.contains("exact control-schema DDL mismatch")));
        assert!(register_contract_at(
            &root,
            contract("syntheticValidated", "blocked-by-trigger-drift")
        )
        .is_err());
        let connection = open_read_only(&path).unwrap();
        let count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM managed_provider_onboarding_contract",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 0);
        drop(connection);

        let connection = open_read_write(&path).unwrap();
        connection
            .execute_batch("DROP TRIGGER managed_provider_route_por_binding_guard;")
            .unwrap();
        connection.execute_batch(&original_trigger_sql).unwrap();
        drop(connection);
        let restored = inspect_store(&path);
        assert!(restored.ready);
        assert!(restored.exact_schema_ddl_verified);
        assert_eq!(restored.exact_schema_ddl_sha256.len(), 64);
        register_contract_at(&root, contract("syntheticValidated", "restored-exact-ddl")).unwrap();
    }

    #[test]
    fn evidence_pending_contract_never_becomes_routable() {
        let (_temp, root) = initialized_root();
        let receipt =
            register_contract_at(&root, contract("evidencePending", "por-pending")).unwrap();
        assert_eq!(receipt.contract_status, "evidencePending");
        assert!(!receipt.routing_eligible);
        assert!(!receipt.provider_authorization_effective);
        assert!(!receipt.dispatch_enabled);
        assert!(!receipt.real_money_collection_enabled);
        let error = create_route_at(&root, route(&receipt.onboarding_decision_sha256, "route-1"))
            .unwrap_err();
        assert!(error.contains("Evidence-pending"));
    }

    #[test]
    fn contract_registration_is_idempotent_and_secret_reference_is_hash_only() {
        let (_temp, root) = initialized_root();
        let receipt =
            register_contract_at(&root, contract("syntheticValidated", "por-synthetic")).unwrap();
        let duplicate =
            register_contract_at(&root, contract("syntheticValidated", "por-synthetic")).unwrap();
        assert!(duplicate.duplicate);
        assert_eq!(
            duplicate.onboarding_decision_sha256,
            receipt.onboarding_decision_sha256
        );
        let bytes = fs::read(database_path(&root)).unwrap();
        assert!(!bytes
            .windows("secret-manager-fixture-ref".len())
            .any(|window| window == b"secret-manager-fixture-ref"));
        let mut conflict = contract("syntheticValidated", "por-synthetic");
        conflict.provider_sku = "forged-sku".to_string();
        assert!(register_contract_at(&root, conflict).is_err());

        let mut second = contract("syntheticValidated", "por-second");
        second.record_id = "por-fixture-openai-2".to_string();
        register_contract_at(&root, second).unwrap();
        let ambiguous = contract("syntheticValidated", "por-second");
        assert!(register_contract_at(&root, ambiguous).is_err());
    }

    #[test]
    fn route_and_ledger_intent_are_bound_with_zero_external_effects() {
        let (_temp, root) = initialized_root();
        let por =
            register_contract_at(&root, contract("syntheticValidated", "por-synthetic")).unwrap();
        let receipt = create_route_at(
            &root,
            route(&por.onboarding_decision_sha256, "route-synthetic"),
        )
        .unwrap();
        assert_eq!(receipt.route_state, "prepared_no_effect");
        assert!(!receipt.dispatch_enabled);
        assert!(!receipt.credential_access_enabled);
        assert!(!receipt.balance_mutation_enabled);
        assert_eq!(receipt.external_effects, 0);
        assert!(!receipt.global_real_money_enabled);
        assert!(!receipt.provider_real_money_enabled);
        assert!(!receipt.tenant_real_money_enabled);
        let duplicate = create_route_at(
            &root,
            route(&por.onboarding_decision_sha256, "route-synthetic"),
        )
        .unwrap();
        assert!(duplicate.duplicate);
        assert_eq!(duplicate.binding_sha256, receipt.binding_sha256);
        assert_eq!(duplicate.ledger_intent_id, receipt.ledger_intent_id);

        let connection = open_read_only(&database_path(&root)).unwrap();
        let ledger: (String, String, i64, i64, i64) = connection
            .query_row(
                "SELECT onboarding_decision_sha256, binding_sha256, real_money_enabled, balance_mutation_enabled, external_effects FROM managed_provider_ledger_intent WHERE ledger_intent_id = ?1",
                params![receipt.ledger_intent_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
            )
            .unwrap();
        assert_eq!(ledger.0, por.onboarding_decision_sha256);
        assert_eq!(ledger.1, receipt.binding_sha256);
        assert_eq!((ledger.2, ledger.3, ledger.4), (0, 0, 0));
    }

    #[test]
    fn route_rejects_por_forgery_cross_scope_and_idempotency_reuse() {
        let (_temp, root) = initialized_root();
        let por =
            register_contract_at(&root, contract("syntheticValidated", "por-synthetic")).unwrap();
        let mut forged = route(&digest("forged-decision"), "route-forged");
        assert!(create_route_at(&root, forged.clone()).is_err());
        forged.expected_onboarding_decision_sha256 = por.onboarding_decision_sha256.clone();
        forged.model_id = "different-model".to_string();
        assert!(create_route_at(&root, forged).is_err());

        create_route_at(&root, route(&por.onboarding_decision_sha256, "route-fixed")).unwrap();
        let mut conflict = route(&por.onboarding_decision_sha256, "route-fixed");
        conflict.request_id = "request-other".to_string();
        assert!(create_route_at(&root, conflict).is_err());

        let mut second = route(&por.onboarding_decision_sha256, "route-second");
        second.request_id = "request-second".to_string();
        second.attempt_id = "attempt-second".to_string();
        create_route_at(&root, second).unwrap();
        let ambiguous = route(&por.onboarding_decision_sha256, "route-second");
        assert!(create_route_at(&root, ambiguous).is_err());
    }

    #[test]
    fn subagent_and_web_routes_force_lightweight_auxiliary_models() {
        let (_temp, root) = initialized_root();
        let frontier =
            register_contract_at(&root, contract("syntheticValidated", "por-synthetic")).unwrap();
        let mut mislabeled = route(&frontier.onboarding_decision_sha256, "route-tier-forgery");
        mislabeled.execution_class = "webSearch".to_string();
        mislabeled.requested_tier = "fast".to_string();
        mislabeled.auxiliary_eligible = true;
        assert!(create_route_at(&root, mislabeled).is_err());

        let mut fast_contract = contract("syntheticValidated", "por-fast");
        fast_contract.record_id = "por-fixture-openai-fast".to_string();
        fast_contract.provider_sku = "openai-fast-fixture".to_string();
        fast_contract.model_family_id = "openai-fast-fixture".to_string();
        fast_contract.logical_tier = "fast".to_string();
        let por = register_contract_at(&root, fast_contract).unwrap();
        for (ordinal, class) in ["subagent", "webSearch", "webFetch"]
            .into_iter()
            .enumerate()
        {
            let mut input = route(
                &por.onboarding_decision_sha256,
                &format!("route-aux-{ordinal}"),
            );
            input.request_id = format!("request-aux-{ordinal}");
            input.attempt_id = format!("attempt-aux-{ordinal}");
            input.execution_class = class.to_string();
            input.requested_tier = "fast".to_string();
            input.model_id = "openai-fast-fixture".to_string();
            input.onboarding_record_id = "por-fixture-openai-fast".to_string();
            input.auxiliary_eligible = true;
            let receipt = create_route_at(&root, input).unwrap();
            assert!(receipt.auxiliary_route_forced);
            assert!(!receipt.primary_fallback_enabled);
        }
        let mut invalid = route(&por.onboarding_decision_sha256, "route-aux-invalid");
        invalid.request_id = "request-aux-invalid".to_string();
        invalid.execution_class = "webSearch".to_string();
        invalid.requested_tier = "frontier".to_string();
        invalid.model_id = "openai-fast-fixture".to_string();
        invalid.onboarding_record_id = "por-fixture-openai-fast".to_string();
        invalid.auxiliary_eligible = true;
        assert!(create_route_at(&root, invalid).is_err());
    }

    #[test]
    fn unknown_outcome_is_pending_and_cannot_auto_settle() {
        let (_temp, root) = initialized_root();
        let por =
            register_contract_at(&root, contract("syntheticValidated", "por-synthetic")).unwrap();
        let route_receipt = create_route_at(
            &root,
            route(&por.onboarding_decision_sha256, "route-synthetic"),
        )
        .unwrap();
        let input = RecordUnknownOutcomeInput {
            tenant_id: route_receipt.tenant_id.clone(),
            organization_id: route_receipt.organization_id.clone(),
            request_id: route_receipt.request_id.clone(),
            attempt_id: route_receipt.attempt_id.clone(),
            expected_binding_sha256: route_receipt.binding_sha256.clone(),
            reason_sha256: digest("synthetic-timeout"),
            provider_request_reference_sha256: Some(digest("synthetic-provider-ref")),
            contract_simulation: true,
            idempotency_key: "unknown-synthetic".to_string(),
        };
        let receipt = record_unknown_outcome_at(&root, input.clone()).unwrap();
        assert_eq!(receipt.case_status, "pending");
        assert!(!receipt.automatic_settlement_enabled);
        assert!(!receipt.real_money_collection_enabled);
        assert_eq!(receipt.external_effects, 0);
        assert!(
            record_unknown_outcome_at(&root, input.clone())
                .unwrap()
                .duplicate
        );

        let mut second_route_input = route(
            &por.onboarding_decision_sha256,
            "route-second-reconciliation",
        );
        second_route_input.request_id = "request-second-reconciliation".to_string();
        second_route_input.attempt_id = "attempt-second-reconciliation".to_string();
        let second_route = create_route_at(&root, second_route_input).unwrap();
        let second_unknown = RecordUnknownOutcomeInput {
            tenant_id: second_route.tenant_id.clone(),
            organization_id: second_route.organization_id.clone(),
            request_id: second_route.request_id.clone(),
            attempt_id: second_route.attempt_id.clone(),
            expected_binding_sha256: second_route.binding_sha256.clone(),
            reason_sha256: digest("synthetic-timeout-second"),
            provider_request_reference_sha256: None,
            contract_simulation: true,
            idempotency_key: "unknown-second".to_string(),
        };
        record_unknown_outcome_at(&root, second_unknown).unwrap();
        let mut ambiguous = input;
        ambiguous.idempotency_key = "unknown-second".to_string();
        assert!(record_unknown_outcome_at(&root, ambiguous).is_err());
        let connection = open_read_only(&database_path(&root)).unwrap();
        let route_state: String = connection
            .query_row(
                "SELECT route_state FROM managed_provider_route_contract WHERE tenant_id = ?1 AND organization_id = ?2 AND request_id = ?3",
                params![
                    route_receipt.tenant_id,
                    route_receipt.organization_id,
                    route_receipt.request_id
                ],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(route_state, "reconciliation_pending");
        let ledger_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM managed_provider_ledger_intent WHERE request_id = ?1",
                params![route_receipt.request_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(ledger_count, 1);
    }

    #[test]
    fn unknown_outcome_requires_explicit_simulation_and_exact_scope() {
        let (_temp, root) = initialized_root();
        let por =
            register_contract_at(&root, contract("syntheticValidated", "por-synthetic")).unwrap();
        let route = create_route_at(
            &root,
            route(&por.onboarding_decision_sha256, "route-synthetic"),
        )
        .unwrap();
        let mut input = RecordUnknownOutcomeInput {
            tenant_id: route.tenant_id.clone(),
            organization_id: route.organization_id.clone(),
            request_id: route.request_id.clone(),
            attempt_id: route.attempt_id.clone(),
            expected_binding_sha256: route.binding_sha256.clone(),
            reason_sha256: digest("synthetic-timeout"),
            provider_request_reference_sha256: None,
            contract_simulation: false,
            idempotency_key: "unknown-synthetic".to_string(),
        };
        assert!(record_unknown_outcome_at(&root, input.clone()).is_err());
        input.contract_simulation = true;
        input.organization_id = "organization-other".to_string();
        assert!(record_unknown_outcome_at(&root, input).is_err());
    }

    #[test]
    fn byok_and_unrecognized_provider_are_rejected_from_managed_contracts() {
        let mut input = contract("evidencePending", "por-invalid");
        input.supply_mode = "byok".to_string();
        assert!(validate_contract_input(&input).is_err());
        input.supply_mode = "managed".to_string();
        input.provider_id = "unknown".to_string();
        assert!(validate_contract_input(&input).is_err());
    }

    #[test]
    fn isolated_root_rejects_both_direction_overlap_and_symlink() {
        let temp = tempfile::tempdir().unwrap();
        let production = temp.path().join("production");
        fs::create_dir_all(&production).unwrap();
        assert!(validate_isolated_root(production.join("child"), &production).is_err());
        assert!(validate_isolated_root(temp.path().to_path_buf(), &production).is_err());
        #[cfg(target_os = "macos")]
        {
            let mixed_case = temp.path().join("ProductionCase");
            fs::create_dir_all(&mixed_case).unwrap();
            let case_alias = temp.path().join("productioncase");
            if fs::canonicalize(&case_alias).ok() == fs::canonicalize(&mixed_case).ok() {
                assert!(validate_isolated_root(case_alias.join("child"), &mixed_case).is_err());
            }

            let missing_production = temp.path().join(".blackbox");
            let missing_case_alias = temp.path().join(".BLACKBOX").join("isolated");
            assert!(validate_isolated_root(missing_case_alias, &missing_production).is_err());
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            let real = temp.path().join("real");
            fs::create_dir_all(&real).unwrap();
            let link = temp.path().join("link");
            symlink(&real, &link).unwrap();
            assert!(validate_isolated_root(link.join("child"), &production).is_err());
        }
    }

    #[cfg(unix)]
    #[test]
    fn database_file_symlink_is_rejected_before_inspection_or_write() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().unwrap();
        let base = normalize_platform_root_alias(temp.path().to_path_buf());
        let target_root = base.join("target-root");
        create_store(&database_path(&target_root)).unwrap();
        let link_root = base.join("link-root");
        fs::create_dir_all(&link_root).unwrap();
        symlink(database_path(&target_root), database_path(&link_root)).unwrap();

        let inspection = inspect_store(&database_path(&link_root));
        assert!(inspection.initialized);
        assert!(!inspection.ready);
        assert!(inspection
            .blocked_reason
            .as_deref()
            .is_some_and(|reason| reason.contains("must not be a symlink")));
        assert!(register_contract_at(
            &link_root,
            contract("syntheticValidated", "must-not-cross-symlink")
        )
        .is_err());

        let connection = open_read_only(&database_path(&target_root)).unwrap();
        let count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM managed_provider_onboarding_contract",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 0);
    }

    #[cfg(unix)]
    #[test]
    fn database_file_hard_link_is_rejected_before_inspection_or_write() {
        let temp = tempfile::tempdir().unwrap();
        let base = normalize_platform_root_alias(temp.path().to_path_buf());
        let target_root = base.join("hard-link-target-root");
        create_store(&database_path(&target_root)).unwrap();
        let alias_root = base.join("hard-link-alias-root");
        fs::create_dir_all(&alias_root).unwrap();
        fs::hard_link(database_path(&target_root), database_path(&alias_root)).unwrap();

        let inspection = inspect_store(&database_path(&alias_root));
        assert!(inspection.initialized);
        assert!(!inspection.ready);
        assert!(inspection
            .blocked_reason
            .as_deref()
            .is_some_and(|reason| reason.contains("exactly one filesystem link")));
        assert!(register_contract_at(
            &alias_root,
            contract("syntheticValidated", "must-not-cross-hard-link")
        )
        .is_err());

        fs::remove_file(database_path(&alias_root)).unwrap();
        let connection = open_read_only(&database_path(&target_root)).unwrap();
        let count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM managed_provider_onboarding_contract",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 0);
    }
}
