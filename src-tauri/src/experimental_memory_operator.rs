//! Disabled-by-default operator review and single-use authorization gate.
//!
//! R3AW records human review and issues short-lived single-use capabilities.
//! R3AX adds a signed pending-settlement protocol around the SQLite journal and
//! its independent anti-rollback anchor. R3AY adds an isolated authority-pointer
//! rehearsal: a purpose-bound capability can atomically switch or restore only
//! the rehearsal state stored in this control database. The production Memory
//! authority and database remain outside this module's write set.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chrono::Utc;
use hmac::{Hmac, Mac};
use rand::{rngs::OsRng, RngCore};
use rusqlite::{params, Connection, OpenFlags, TransactionBehavior};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;
use uuid::Uuid;

#[cfg(target_os = "macos")]
#[link(name = "LocalAuthentication", kind = "framework")]
extern "C" {}

type HmacSha256 = Hmac<Sha256>;

const OPERATOR_FLAG: &str = "BLACKBOX_EXPERIMENTAL_MEMORY_OPERATOR_V1";
const HOME_OVERRIDE: &str = "BLACKBOX_EXPERIMENTAL_HOME";
const NO_EFFECT_AUDIENCE: &str = "blackbox.memory.operator.no-effect.v1";
const REHEARSAL_AUDIENCE: &str = "blackbox.memory.operator.isolated-rehearsal.v1";
const SCHEMA_VERSION: i64 = 1;
const MIN_TTL_SECONDS: u64 = 60;
const MAX_TTL_SECONDS: u64 = 900;
const MAX_EXTERNAL_ANCHOR_BYTES: u64 = 4 * 1024;
const MAX_PENDING_SETTLEMENT_BYTES: u64 = 16 * 1024;
const REVIEWER_SESSION_PREFIX: &str = "bbmrs1_";
const REVIEWER_SESSION_TTL_MS: i64 = 120_000;
const MAX_REVIEWER_SESSION_TOKEN_BYTES: usize = 4 * 1024;
const ZERO_HASH: &str = "0000000000000000000000000000000000000000000000000000000000000000";
const SCHEMA_SQL: &str = include_str!("../resources/experimental/memory-operator-v1.sql");

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExperimentalMemoryOperatorStatus {
    enabled: bool,
    platform_supported: bool,
    initialized: bool,
    ready: bool,
    path: String,
    schema_version: Option<i64>,
    schema_sha256: String,
    exact_schema_ddl_sha256: String,
    exact_schema_ddl_verified: bool,
    journal_record_count: u64,
    approved_review_count: u64,
    rejected_review_count: u64,
    active_authorization_count: u64,
    consumed_authorization_count: u64,
    revoked_authorization_count: u64,
    journal_hmac_verified: bool,
    single_use_enforced: bool,
    preconsumption_validation_failure_preserves_authorization: bool,
    post_commit_recovery_supported: bool,
    execution_adapter_available: bool,
    isolated_rehearsal_only: bool,
    execution_dispatched: bool,
    rollback_performed: bool,
    production_memory_mutated: bool,
    production_integration: bool,
    blocked_reason: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ReviewMemoryProposalInput {
    operation_id: String,
    proposal_record_sha256: String,
    decision: String,
    reviewer_session_token: String,
    review_reason_sha256: String,
    idempotency_key: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CreateMemoryReviewerSessionInput {
    action_kind: String,
    operation_id: String,
    idempotency_key: String,
    proposal_record_sha256: String,
    decision: Option<String>,
    authorization_record_sha256: Option<String>,
    reason_sha256: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MemoryReviewerSessionReceipt {
    action_kind: String,
    reviewer_subject_sha256: String,
    reviewer_session_token: String,
    issued_at_ms: i64,
    expires_at_ms: i64,
    local_authentication_verified: bool,
    production_integration: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct IssueMemoryExecutionAuthorizationInput {
    operation_id: String,
    review_record_sha256: String,
    proposal_record_sha256: String,
    expected_memory_sha256: String,
    ttl_seconds: u64,
    idempotency_key: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RevokeMemoryExecutionAuthorizationInput {
    operation_id: String,
    authorization_record_sha256: String,
    proposal_record_sha256: String,
    reviewer_session_token: String,
    revocation_reason_sha256: String,
    idempotency_key: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ConsumeMemoryExecutionAuthorizationInput {
    operation_id: String,
    authorization_record_sha256: String,
    proposal_record_sha256: String,
    expected_memory_sha256: String,
    authorization_token: String,
    idempotency_key: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MemoryOperatorReceipt {
    operation_id: String,
    operation_kind: String,
    phase: String,
    record_sequence: i64,
    record_sha256: String,
    record_hmac_sha256: String,
    proposal_record_sha256: String,
    proposal_kind: String,
    review_record_sha256: Option<String>,
    decision: Option<String>,
    reviewer_subject_sha256: String,
    authorization_id: Option<String>,
    authorization_token: Option<String>,
    authorization_record_sha256: Option<String>,
    rehearsal_authority_state_sha256: Option<String>,
    issued_at_ms: Option<i64>,
    expires_at_ms: Option<i64>,
    promotion_schema_ddl_sha256: String,
    recovery_schema_ddl_sha256: String,
    memory_database_sha256: String,
    authorization_consumed: bool,
    execution_dispatched: bool,
    rollback_performed: bool,
    production_memory_mutated: bool,
    external_effects: u8,
    duplicate: bool,
    production_integration: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MemoryRehearsalAuthorityState {
    generation: i64,
    authority_kind: String,
    authority_binding_sha256: String,
    previous_authority_kind: Option<String>,
    previous_authority_binding_sha256: Option<String>,
    last_authorization_record_sha256: Option<String>,
    last_execution_record_sha256: Option<String>,
    production_integration: bool,
    updated_at_ms: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CanonicalRehearsalAuthorityState<'a> {
    generation: i64,
    authority_kind: &'a str,
    authority_binding_sha256: &'a str,
    previous_authority_kind: Option<&'a str>,
    previous_authority_binding_sha256: Option<&'a str>,
    last_authorization_record_sha256: Option<&'a str>,
    last_execution_record_sha256: Option<&'a str>,
    production_integration: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MemoryOperatorJournalInspection {
    schema_version: i64,
    exact_schema_ddl_sha256: String,
    journal_record_count: u64,
    approved_review_count: u64,
    rejected_review_count: u64,
    issued_authorization_count: u64,
    active_authorization_count: u64,
    consumed_authorization_count: u64,
    revoked_authorization_count: u64,
    last_record_sha256: String,
    hmac_verified: bool,
    chain_verified: bool,
    exact_schema_ddl_verified: bool,
    single_use_enforced: bool,
    preconsumption_validation_failure_preserves_authorization: bool,
    post_commit_recovery_supported: bool,
    execution_adapter_available: bool,
    isolated_rehearsal_only: bool,
    execution_dispatched: bool,
    rollback_performed: bool,
    production_memory_mutated: bool,
    external_effects: u8,
    production_integration: bool,
}

#[derive(Clone, Debug)]
struct StoreInspection {
    initialized: bool,
    ready: bool,
    schema_version: Option<i64>,
    exact_schema_ddl_sha256: String,
    journal_record_count: u64,
    approved_review_count: u64,
    rejected_review_count: u64,
    active_authorization_count: u64,
    consumed_authorization_count: u64,
    revoked_authorization_count: u64,
    execution_dispatched: bool,
    rollback_performed: bool,
    blocked_reason: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReviewerSessionClaims {
    schema_version: i64,
    session_id: String,
    reviewer_subject_sha256: String,
    action_binding_sha256: String,
    process_instance_sha256: String,
    issued_at_ms: i64,
    expires_at_ms: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CanonicalReviewerAction<'a> {
    action_kind: &'a str,
    operation_id: &'a str,
    idempotency_key: &'a str,
    proposal_record_sha256: &'a str,
    decision: Option<&'a str>,
    authorization_record_sha256: Option<&'a str>,
    reason_sha256: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CanonicalReviewRequest<'a> {
    operation_id: &'a str,
    proposal_record_sha256: &'a str,
    decision: &'a str,
    reviewer_subject_sha256: &'a str,
    review_reason_sha256: &'a str,
    idempotency_key: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CanonicalRevocationRequest<'a> {
    operation_id: &'a str,
    authorization_record_sha256: &'a str,
    proposal_record_sha256: &'a str,
    reviewer_subject_sha256: &'a str,
    revocation_reason_sha256: &'a str,
    idempotency_key: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CanonicalAuthorizationRequest<'a> {
    operation_id: &'a str,
    review_record_sha256: &'a str,
    proposal_record_sha256: &'a str,
    expected_memory_sha256: &'a str,
    ttl_seconds: u64,
    idempotency_key: &'a str,
    audience: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CanonicalConsumptionRequest<'a> {
    operation_id: &'a str,
    authorization_record_sha256: &'a str,
    proposal_record_sha256: &'a str,
    expected_memory_sha256: &'a str,
    authorization_token: &'a str,
    idempotency_key: &'a str,
    audience: &'a str,
    phase: &'a str,
}

#[derive(Clone, Copy, Debug)]
struct LocalAuthenticationWitness;

#[derive(Clone, Debug)]
struct StoredRecord {
    sequence: i64,
    operation_id: String,
    operation_kind: String,
    phase: String,
    idempotency_key: String,
    input_payload_sha256: String,
    proposal_record_sha256: String,
    proposal_kind: String,
    review_record_sha256: Option<String>,
    decision: Option<String>,
    reviewer_subject_sha256: String,
    review_reason_sha256: Option<String>,
    authorization_id: Option<String>,
    authorization_token_sha256: Option<String>,
    authorization_record_sha256: Option<String>,
    audience: Option<String>,
    rehearsal_authority_state_sha256: Option<String>,
    issued_at_ms: Option<i64>,
    expires_at_ms: Option<i64>,
    promotion_schema_ddl_sha256: String,
    recovery_schema_ddl_sha256: String,
    memory_database_sha256: String,
    memory_device: String,
    memory_inode: String,
    memory_size: i64,
    previous_record_sha256: String,
    record_sha256: String,
    record_hmac_sha256: String,
    authorization_consumed: i64,
    execution_dispatched: i64,
    rollback_performed: i64,
    production_memory_mutated: i64,
    external_effects: i64,
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
    proposal_record_sha256: &'a str,
    proposal_kind: &'a str,
    review_record_sha256: Option<&'a str>,
    decision: Option<&'a str>,
    reviewer_subject_sha256: &'a str,
    review_reason_sha256: Option<&'a str>,
    authorization_id: Option<&'a str>,
    authorization_token_sha256: Option<&'a str>,
    authorization_record_sha256: Option<&'a str>,
    audience: Option<&'a str>,
    rehearsal_authority_state_sha256: Option<&'a str>,
    issued_at_ms: Option<i64>,
    expires_at_ms: Option<i64>,
    promotion_schema_ddl_sha256: &'a str,
    recovery_schema_ddl_sha256: &'a str,
    memory_database_sha256: &'a str,
    memory_device: &'a str,
    memory_inode: &'a str,
    memory_size: i64,
    previous_record_sha256: &'a str,
    authorization_consumed: i64,
    execution_dispatched: i64,
    rollback_performed: i64,
    production_memory_mutated: i64,
    external_effects: i64,
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
struct PendingJournalSettlement {
    schema_version: i64,
    schema_sha256: String,
    signing_key_id_sha256: String,
    settlement_id: String,
    previous_anchor: Option<ExternalJournalAnchor>,
    next_anchor: ExternalJournalAnchor,
    record_sha256: Option<String>,
    prepared_at_ms: i64,
    settlement_hmac_sha256: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CanonicalPendingJournalSettlement<'a> {
    schema_version: i64,
    schema_sha256: &'a str,
    signing_key_id_sha256: &'a str,
    settlement_id: &'a str,
    previous_anchor: Option<&'a ExternalJournalAnchor>,
    next_anchor: &'a ExternalJournalAnchor,
    record_sha256: Option<&'a str>,
    prepared_at_ms: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SettlementRecovery {
    None,
    AbortedBeforeCommit,
    PublishedCommittedAnchor,
    RemovedSettledIntent,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SettlementStop {
    Complete,
    AfterPending,
    AfterCommit,
    AfterAnchor,
}

#[derive(Clone, Debug)]
struct ProposalSnapshot {
    proposal_record_sha256: String,
    proposal_kind: String,
    memory_database_sha256: String,
    memory_device: String,
    memory_inode: String,
    memory_size: u64,
}

impl From<&crate::experimental_memory_promotion::MemoryOperatorProposalBinding>
    for ProposalSnapshot
{
    fn from(value: &crate::experimental_memory_promotion::MemoryOperatorProposalBinding) -> Self {
        Self {
            proposal_record_sha256: value.proposal_record_sha256.clone(),
            proposal_kind: value.operation_kind.clone(),
            memory_database_sha256: value.memory_database_sha256.clone(),
            memory_device: value.memory_device.clone(),
            memory_inode: value.memory_inode.clone(),
            memory_size: value.memory_size,
        }
    }
}

impl From<&StoredRecord> for ProposalSnapshot {
    fn from(value: &StoredRecord) -> Self {
        Self {
            proposal_record_sha256: value.proposal_record_sha256.clone(),
            proposal_kind: value.proposal_kind.clone(),
            memory_database_sha256: value.memory_database_sha256.clone(),
            memory_device: value.memory_device.clone(),
            memory_inode: value.memory_inode.clone(),
            memory_size: value.memory_size.max(0) as u64,
        }
    }
}

struct NewRecord<'a> {
    operation_id: &'a str,
    operation_kind: &'a str,
    phase: &'a str,
    idempotency_key: &'a str,
    input_payload_sha256: &'a str,
    proposal: &'a ProposalSnapshot,
    review_record_sha256: Option<&'a str>,
    decision: Option<&'a str>,
    reviewer_subject_sha256: &'a str,
    review_reason_sha256: Option<&'a str>,
    authorization_id: Option<&'a str>,
    authorization_token_sha256: Option<&'a str>,
    authorization_record_sha256: Option<&'a str>,
    audience: Option<&'a str>,
    rehearsal_authority_state_sha256: Option<&'a str>,
    issued_at_ms: Option<i64>,
    expires_at_ms: Option<i64>,
    promotion_schema_ddl_sha256: &'a str,
    recovery_schema_ddl_sha256: &'a str,
    authorization_consumed: bool,
    execution_dispatched: bool,
    rollback_performed: bool,
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn now_ms() -> i64 {
    Utc::now().timestamp_millis()
}

fn feature_enabled() -> bool {
    std::env::var(OPERATOR_FLAG)
        .ok()
        .map(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(false)
}

fn platform_supported() -> bool {
    cfg!(unix)
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

fn stable_input_sha256<T: Serialize>(input: &T) -> Result<String, String> {
    serde_json::to_vec(input)
        .map(|bytes| sha256_hex(&bytes))
        .map_err(|error| format!("Failed to canonicalize Memory operator input: {error}"))
}

fn reviewer_action_sha256(
    action_kind: &str,
    operation_id: &str,
    idempotency_key: &str,
    proposal_record_sha256: &str,
    decision: Option<&str>,
    authorization_record_sha256: Option<&str>,
    reason_sha256: &str,
) -> Result<String, String> {
    stable_input_sha256(&CanonicalReviewerAction {
        action_kind,
        operation_id,
        idempotency_key,
        proposal_record_sha256,
        decision,
        authorization_record_sha256,
        reason_sha256,
    })
}

fn validate_reviewer_session_request(
    input: &CreateMemoryReviewerSessionInput,
) -> Result<String, String> {
    validate_token("operationId", &input.operation_id)?;
    validate_token("idempotencyKey", &input.idempotency_key)?;
    validate_hash("proposalRecordSha256", &input.proposal_record_sha256)?;
    validate_hash("reasonSha256", &input.reason_sha256)?;
    match input.action_kind.as_str() {
        "proposal_review" => {
            if input.authorization_record_sha256.is_some()
                || !matches!(input.decision.as_deref(), Some("approve" | "reject"))
            {
                return Err(
                    "Memory reviewer proposal session requires exactly one approve/reject decision"
                        .to_string(),
                );
            }
        }
        "authorization_revocation" => {
            if input.decision.is_some() {
                return Err(
                    "Memory reviewer revocation session cannot carry a review decision".to_string(),
                );
            }
            validate_hash(
                "authorizationRecordSha256",
                input
                    .authorization_record_sha256
                    .as_deref()
                    .ok_or("Memory reviewer revocation session requires an authorization record")?,
            )?;
        }
        _ => return Err(
            "Memory reviewer session action must be proposal_review or authorization_revocation"
                .to_string(),
        ),
    }
    reviewer_action_sha256(
        &input.action_kind,
        &input.operation_id,
        &input.idempotency_key,
        &input.proposal_record_sha256,
        input.decision.as_deref(),
        input.authorization_record_sha256.as_deref(),
        &input.reason_sha256,
    )
}

fn process_instance_sha256() -> &'static str {
    static PROCESS_INSTANCE_SHA256: OnceLock<String> = OnceLock::new();
    PROCESS_INSTANCE_SHA256
        .get_or_init(|| {
            let mut nonce = [0u8; 32];
            OsRng.fill_bytes(&mut nonce);
            sha256_hex(&nonce)
        })
        .as_str()
}

fn reviewer_subject_sha256(key: &[u8]) -> Result<String, String> {
    #[cfg(unix)]
    let effective_uid = unsafe { libc::geteuid() };
    #[cfg(not(unix))]
    return Err(
        "Trusted Memory reviewer sessions require a native local user identity".to_string(),
    );

    #[cfg(unix)]
    {
        let mut mac = HmacSha256::new_from_slice(key)
            .map_err(|_| "Failed to initialize Memory reviewer identity HMAC".to_string())?;
        mac.update(b"blackbox.memory.reviewer.subject.v1\0");
        mac.update(effective_uid.to_string().as_bytes());
        Ok(format!("{:x}", mac.finalize().into_bytes()))
    }
}

fn reviewer_session_hmac(payload: &[u8], key: &[u8]) -> Result<String, String> {
    let mut mac = HmacSha256::new_from_slice(key)
        .map_err(|_| "Failed to initialize Memory reviewer session HMAC".to_string())?;
    mac.update(b"blackbox.memory.reviewer.session.v1\0");
    mac.update(payload);
    Ok(format!("{:x}", mac.finalize().into_bytes()))
}

fn issue_reviewer_session(
    key: &[u8],
    input: &CreateMemoryReviewerSessionInput,
    _witness: LocalAuthenticationWitness,
    issued_at_ms: i64,
) -> Result<MemoryReviewerSessionReceipt, String> {
    let action_binding_sha256 = validate_reviewer_session_request(input)?;
    let expires_at_ms = issued_at_ms
        .checked_add(REVIEWER_SESSION_TTL_MS)
        .ok_or("Memory reviewer session expiry overflow")?;
    let reviewer_subject_sha256 = reviewer_subject_sha256(key)?;
    let claims = ReviewerSessionClaims {
        schema_version: 1,
        session_id: format!("memory-reviewer:{}", Uuid::new_v4()),
        reviewer_subject_sha256: reviewer_subject_sha256.clone(),
        action_binding_sha256,
        process_instance_sha256: process_instance_sha256().to_string(),
        issued_at_ms,
        expires_at_ms,
    };
    let payload = serde_json::to_vec(&claims)
        .map_err(|error| format!("Failed to encode Memory reviewer session: {error}"))?;
    let signature = reviewer_session_hmac(&payload, key)?;
    let reviewer_session_token = format!(
        "{REVIEWER_SESSION_PREFIX}{}.{}",
        URL_SAFE_NO_PAD.encode(payload),
        signature
    );
    if reviewer_session_token.len() > MAX_REVIEWER_SESSION_TOKEN_BYTES {
        return Err("Memory reviewer session token exceeded its size limit".to_string());
    }
    Ok(MemoryReviewerSessionReceipt {
        action_kind: input.action_kind.clone(),
        reviewer_subject_sha256,
        reviewer_session_token,
        issued_at_ms,
        expires_at_ms,
        local_authentication_verified: true,
        production_integration: false,
    })
}

fn verify_reviewer_session(
    token: &str,
    key: &[u8],
    expected_action_binding_sha256: &str,
    current_time_ms: i64,
) -> Result<ReviewerSessionClaims, String> {
    if token.len() > MAX_REVIEWER_SESSION_TOKEN_BYTES {
        return Err("Memory reviewer session token exceeded its size limit".to_string());
    }
    let encoded = token
        .strip_prefix(REVIEWER_SESSION_PREFIX)
        .ok_or("Memory reviewer session token has an invalid prefix")?;
    let (payload_base64, supplied_hmac) = encoded
        .split_once('.')
        .ok_or("Memory reviewer session token has an invalid envelope")?;
    if supplied_hmac.contains('.') {
        return Err("Memory reviewer session token has an invalid envelope".to_string());
    }
    validate_hash("reviewerSessionHmac", supplied_hmac)?;
    let payload = URL_SAFE_NO_PAD
        .decode(payload_base64)
        .map_err(|_| "Memory reviewer session token payload is invalid".to_string())?;
    let expected_hmac = reviewer_session_hmac(&payload, key)?;
    if !constant_time_eq(supplied_hmac, &expected_hmac) {
        return Err("Memory reviewer session HMAC mismatch".to_string());
    }
    let claims: ReviewerSessionClaims = serde_json::from_slice(&payload)
        .map_err(|error| format!("Memory reviewer session claims are invalid: {error}"))?;
    if claims.schema_version != 1 {
        return Err("Memory reviewer session schema mismatch".to_string());
    }
    validate_token("reviewerSessionId", &claims.session_id)?;
    validate_hash("reviewerSubjectSha256", &claims.reviewer_subject_sha256)?;
    validate_hash("reviewerActionBindingSha256", &claims.action_binding_sha256)?;
    validate_hash(
        "reviewerProcessInstanceSha256",
        &claims.process_instance_sha256,
    )?;
    if claims.expires_at_ms.checked_sub(claims.issued_at_ms) != Some(REVIEWER_SESSION_TTL_MS)
        || claims.issued_at_ms <= 0
        || current_time_ms < claims.issued_at_ms
        || current_time_ms >= claims.expires_at_ms
    {
        return Err("Memory reviewer session expired or has an invalid lifetime".to_string());
    }
    if claims.process_instance_sha256 != process_instance_sha256() {
        return Err("Memory reviewer session belongs to another process instance".to_string());
    }
    if claims.reviewer_subject_sha256 != reviewer_subject_sha256(key)? {
        return Err("Memory reviewer session local-user binding mismatch".to_string());
    }
    if claims.action_binding_sha256 != expected_action_binding_sha256 {
        return Err("Memory reviewer session action binding mismatch".to_string());
    }
    Ok(claims)
}

fn reviewer_session_key_at(root: &Path) -> Result<Vec<u8>, String> {
    let root =
        crate::experimental_memory_recovery::normalize_platform_root_alias(root.to_path_buf());
    let _lease = crate::experimental_memory_recovery::acquire_host_wide_memory_lease(&root)?;
    let key = read_signing_key(&key_path(&root))?;
    recover_pending_settlement(&root, &key)?;
    let inspection = inspect_control_store(&control_path(&root), &key)?;
    if !inspection.ready {
        return Err(inspection
            .blocked_reason
            .unwrap_or_else(|| "Memory operator control database is not ready".to_string()));
    }
    Ok(key)
}

#[cfg(target_os = "macos")]
unsafe fn local_authentication_error(error: *mut objc::runtime::Object) -> String {
    use objc::{msg_send, sel, sel_impl};
    if error.is_null() {
        return "unknown LocalAuthentication error".to_string();
    }
    let description: *mut objc::runtime::Object = msg_send![error, localizedDescription];
    if description.is_null() {
        return "unknown LocalAuthentication error".to_string();
    }
    let utf8: *const std::ffi::c_char = msg_send![description, UTF8String];
    if utf8.is_null() {
        "unknown LocalAuthentication error".to_string()
    } else {
        std::ffi::CStr::from_ptr(utf8)
            .to_string_lossy()
            .into_owned()
    }
}

#[cfg(target_os = "macos")]
async fn authenticate_local_reviewer() -> Result<LocalAuthenticationWitness, String> {
    use block::ConcreteBlock;
    use objc::runtime::Object;
    use objc::{class, msg_send, sel, sel_impl};
    use std::sync::{Arc, Mutex};

    let (sender, receiver) =
        tokio::sync::oneshot::channel::<Result<LocalAuthenticationWitness, String>>();
    let sender = Arc::new(Mutex::new(Some(sender)));
    unsafe {
        let context: *mut Object = msg_send![class!(LAContext), new];
        if context.is_null() {
            return Err("Failed to create a macOS LocalAuthentication context".to_string());
        }
        let policy = 2usize; // LAPolicyDeviceOwnerAuthentication
        let mut availability_error: *mut Object = std::ptr::null_mut();
        let available: bool = msg_send![context,
            canEvaluatePolicy: policy
            error: &mut availability_error
        ];
        if !available {
            let detail = local_authentication_error(availability_error);
            let _: () = msg_send![context, release];
            return Err(format!(
                "macOS cannot authenticate the current Memory reviewer: {detail}"
            ));
        }

        const REASON: &str = "确认本机用户授权此次 Memory 审核";
        let reason: *mut Object = msg_send![class!(NSString), alloc];
        let reason: *mut Object = msg_send![reason,
            initWithBytes: REASON.as_ptr() as *const std::ffi::c_void
            length: REASON.len()
            encoding: 4usize
        ];
        if reason.is_null() {
            let _: () = msg_send![context, release];
            return Err("Failed to create the macOS authentication reason".to_string());
        }

        let context_address = context as usize;
        let callback_sender = Arc::clone(&sender);
        let reply = ConcreteBlock::new(move |success: bool, error: *mut Object| {
            let sender = callback_sender
                .lock()
                .ok()
                .and_then(|mut sender| sender.take());
            if let Some(sender) = sender {
                let result = if success {
                    Ok(LocalAuthenticationWitness)
                } else {
                    let detail = local_authentication_error(error);
                    Err(format!(
                        "macOS Memory reviewer authentication failed: {detail}"
                    ))
                };
                let context = context_address as *mut Object;
                let _: () = msg_send![context, release];
                let _ = sender.send(result);
            }
        })
        .copy();
        let _: () = msg_send![context,
            evaluatePolicy: policy
            localizedReason: reason
            reply: &*reply
        ];
        let _: () = msg_send![reason, release];
    }
    receiver
        .await
        .map_err(|_| "macOS Memory reviewer authentication callback ended early".to_string())?
}

#[cfg(not(target_os = "macos"))]
async fn authenticate_local_reviewer() -> Result<LocalAuthenticationWitness, String> {
    Err("Trusted Memory reviewer sessions currently require macOS LocalAuthentication".to_string())
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
    Ok(crate::safe_data_dir()?.join("experimental-memory-operator-v1-status-only"))
}

fn isolated_root() -> Result<PathBuf, String> {
    if !platform_supported() {
        return Err(
            "Experimental Memory operator gate requires native Unix lease and link-count proof"
                .to_string(),
        );
    }
    if !feature_enabled() {
        return Err(format!(
            "Experimental Memory operator gate is disabled; set {OPERATOR_FLAG}=1 only in an isolated profile"
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
    root.join("memory-operator-v1.sqlite")
}

fn key_path(root: &Path) -> PathBuf {
    root.join("memory-operator-v1.key")
}

fn external_anchor_path(root: &Path) -> PathBuf {
    root.join("memory-operator-v1.anchor.json")
}

fn pending_settlement_path(root: &Path) -> PathBuf {
    root.join("memory-operator-v1.pending.json")
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

fn sync_parent_directory(path: &Path) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("{} has no parent directory", path.display()))?;
    File::open(parent)
        .and_then(|file| file.sync_all())
        .map_err(|error| format!("Failed to sync {}: {error}", parent.display()))
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
    .map_err(|error| format!("Failed to open Memory operator control database: {error}"))?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(|error| format!("Failed to configure Memory operator writer: {error}"))?;
    connection
        .pragma_update(None, "foreign_keys", true)
        .map_err(|error| format!("Failed to enable Memory operator foreign keys: {error}"))?;
    connection
        .pragma_update(None, "synchronous", "FULL")
        .map_err(|error| format!("Failed to enable durable Memory operator writes: {error}"))?;
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

fn create_signing_key(path: &Path) -> Result<Vec<u8>, String> {
    if regular_single_link_file(path, "Memory operator signing key")? {
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
        .map_err(|error| format!("Failed to create Memory operator signing key: {error}"))?;
    file.write_all(&key)
        .and_then(|_| file.sync_all())
        .map_err(|error| format!("Failed to persist Memory operator signing key: {error}"))?;
    drop(file);
    set_file_mode(path, 0o600)?;
    sync_file_and_parent(path)?;
    Ok(key)
}

fn read_signing_key(path: &Path) -> Result<Vec<u8>, String> {
    if !regular_single_link_file(path, "Memory operator signing key")? {
        return Err("Memory operator signing key is missing".to_string());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(path)
            .map_err(|error| format!("Failed to inspect Memory operator signing key: {error}"))?
            .permissions()
            .mode()
            & 0o777;
        if mode != 0o600 {
            return Err("Memory operator signing key must have mode 0600".to_string());
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
        .map_err(|error| format!("Failed to read Memory operator signing key: {error}"))?;
    if key.len() != 32 {
        return Err("Memory operator signing key must contain exactly 32 bytes".to_string());
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
    .map_err(|error| format!("Failed to canonicalize Memory operator anchor: {error}"))?;
    let mut mac = HmacSha256::new_from_slice(key)
        .map_err(|_| "Failed to initialize Memory operator anchor HMAC".to_string())?;
    mac.update(&canonical);
    Ok(format!("{:x}", mac.finalize().into_bytes()))
}

fn journal_anchor(
    key: &[u8],
    head_sequence: i64,
    head_sha256: &str,
    created_at_ms: i64,
) -> Result<ExternalJournalAnchor, String> {
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

fn verify_anchor_binding(anchor: &ExternalJournalAnchor, key: &[u8]) -> Result<(), String> {
    if anchor.schema_version != SCHEMA_VERSION
        || anchor.schema_sha256 != sha256_hex(SCHEMA_SQL.as_bytes())
        || anchor.signing_key_id_sha256 != sha256_hex(key)
        || anchor.journal_head_sequence < 0
        || anchor.journal_head_sha256.len() != 64
        || !anchor
            .journal_head_sha256
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
        || anchor.created_at_ms <= 0
        || anchor.journal_anchor_hmac_sha256
            != journal_anchor_hmac(
                key,
                anchor.journal_head_sequence,
                &anchor.journal_head_sha256,
                anchor.created_at_ms,
            )?
    {
        return Err("Memory operator external anchor binding mismatch".to_string());
    }
    Ok(())
}

fn read_external_anchor(path: &Path, key: &[u8]) -> Result<ExternalJournalAnchor, String> {
    if !regular_single_link_file(path, "Memory operator external journal anchor")? {
        return Err("Memory operator external journal anchor is missing".to_string());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(path)
            .map_err(|error| format!("Failed to inspect Memory operator anchor: {error}"))?
            .permissions()
            .mode()
            & 0o777;
        if mode != 0o400 {
            return Err("Memory operator anchor must have mode 0400".to_string());
        }
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let mut bytes = Vec::new();
    options
        .open(path)
        .and_then(|mut file| {
            (&mut file)
                .take(MAX_EXTERNAL_ANCHOR_BYTES + 1)
                .read_to_end(&mut bytes)
        })
        .map_err(|error| format!("Failed to read Memory operator anchor: {error}"))?;
    if bytes.len() as u64 > MAX_EXTERNAL_ANCHOR_BYTES {
        return Err("Memory operator external anchor is too large".to_string());
    }
    let anchor: ExternalJournalAnchor = serde_json::from_slice(&bytes)
        .map_err(|error| format!("Memory operator external anchor is invalid: {error}"))?;
    verify_anchor_binding(&anchor, key)?;
    Ok(anchor)
}

fn write_external_anchor(
    path: &Path,
    key: &[u8],
    head_sequence: i64,
    head_sha256: &str,
    created_at_ms: i64,
) -> Result<(), String> {
    let anchor = journal_anchor(key, head_sequence, head_sha256, created_at_ms)?;
    let bytes = serde_json::to_vec(&anchor)
        .map_err(|error| format!("Failed to encode Memory operator anchor: {error}"))?;
    let parent = path
        .parent()
        .ok_or("Memory operator external journal anchor has no parent")?;
    let staging = parent.join(format!(".memory-operator-v1.{}.anchor.tmp", Uuid::new_v4()));
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
            .map_err(|error| format!("Failed to stage Memory operator anchor: {error}"))?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|error| format!("Failed to persist Memory operator anchor: {error}"))?;
        drop(file);
        set_file_mode(&staging, 0o400)?;
        fs::rename(&staging, path)
            .map_err(|error| format!("Failed to publish Memory operator anchor: {error}"))?;
        sync_file_and_parent(path)?;
        if read_external_anchor(path, key)? != anchor {
            return Err("Published Memory operator anchor drifted".to_string());
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&staging);
    }
    result
}

fn pending_settlement_hmac(
    settlement: &PendingJournalSettlement,
    key: &[u8],
) -> Result<String, String> {
    let canonical = serde_json::to_vec(&CanonicalPendingJournalSettlement {
        schema_version: settlement.schema_version,
        schema_sha256: &settlement.schema_sha256,
        signing_key_id_sha256: &settlement.signing_key_id_sha256,
        settlement_id: &settlement.settlement_id,
        previous_anchor: settlement.previous_anchor.as_ref(),
        next_anchor: &settlement.next_anchor,
        record_sha256: settlement.record_sha256.as_deref(),
        prepared_at_ms: settlement.prepared_at_ms,
    })
    .map_err(|error| format!("Failed to canonicalize Memory operator settlement: {error}"))?;
    let mut mac = HmacSha256::new_from_slice(key)
        .map_err(|_| "Failed to initialize Memory operator settlement HMAC".to_string())?;
    mac.update(&canonical);
    Ok(format!("{:x}", mac.finalize().into_bytes()))
}

fn create_pending_settlement(
    key: &[u8],
    previous_anchor: Option<ExternalJournalAnchor>,
    next_anchor: ExternalJournalAnchor,
    record_sha256: Option<String>,
) -> Result<PendingJournalSettlement, String> {
    let mut settlement = PendingJournalSettlement {
        schema_version: SCHEMA_VERSION,
        schema_sha256: sha256_hex(SCHEMA_SQL.as_bytes()),
        signing_key_id_sha256: sha256_hex(key),
        settlement_id: format!("memory-settlement:{}", Uuid::new_v4()),
        previous_anchor,
        next_anchor,
        record_sha256,
        prepared_at_ms: now_ms(),
        settlement_hmac_sha256: String::new(),
    };
    settlement.settlement_hmac_sha256 = pending_settlement_hmac(&settlement, key)?;
    validate_pending_settlement(&settlement, key)?;
    Ok(settlement)
}

fn validate_pending_settlement(
    settlement: &PendingJournalSettlement,
    key: &[u8],
) -> Result<(), String> {
    if settlement.schema_version != SCHEMA_VERSION
        || settlement.schema_sha256 != sha256_hex(SCHEMA_SQL.as_bytes())
        || settlement.signing_key_id_sha256 != sha256_hex(key)
        || settlement.prepared_at_ms <= 0
    {
        return Err("Memory operator pending settlement identity mismatch".to_string());
    }
    validate_token("settlementId", &settlement.settlement_id)?;
    verify_anchor_binding(&settlement.next_anchor, key)?;
    match settlement.previous_anchor.as_ref() {
        Some(previous) => {
            verify_anchor_binding(previous, key)?;
            if settlement.next_anchor.created_at_ms != previous.created_at_ms
                || settlement.next_anchor.journal_head_sequence
                    != previous
                        .journal_head_sequence
                        .checked_add(1)
                        .ok_or("Memory operator pending settlement sequence overflow")?
                || settlement.record_sha256.as_deref()
                    != Some(settlement.next_anchor.journal_head_sha256.as_str())
            {
                return Err(
                    "Memory operator pending settlement append binding mismatch".to_string()
                );
            }
        }
        None => {
            if settlement.next_anchor.journal_head_sequence != 0
                || settlement.next_anchor.journal_head_sha256 != ZERO_HASH
                || settlement.record_sha256.is_some()
            {
                return Err(
                    "Memory operator pending bootstrap settlement binding mismatch".to_string(),
                );
            }
        }
    }
    let expected = pending_settlement_hmac(settlement, key)?;
    if !constant_time_eq(&settlement.settlement_hmac_sha256, &expected) {
        return Err("Memory operator pending settlement HMAC mismatch".to_string());
    }
    Ok(())
}

fn read_pending_settlement(
    path: &Path,
    key: &[u8],
) -> Result<Option<PendingJournalSettlement>, String> {
    if !regular_single_link_file(path, "Memory operator pending settlement")? {
        return Ok(None);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(path)
            .map_err(|error| format!("Failed to inspect Memory operator settlement: {error}"))?
            .permissions()
            .mode()
            & 0o777;
        if mode != 0o400 {
            return Err("Memory operator pending settlement must have mode 0400".to_string());
        }
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let mut bytes = Vec::new();
    options
        .open(path)
        .and_then(|mut file| {
            (&mut file)
                .take(MAX_PENDING_SETTLEMENT_BYTES + 1)
                .read_to_end(&mut bytes)
        })
        .map_err(|error| format!("Failed to read Memory operator settlement: {error}"))?;
    if bytes.len() as u64 > MAX_PENDING_SETTLEMENT_BYTES {
        return Err("Memory operator pending settlement is too large".to_string());
    }
    let settlement: PendingJournalSettlement = serde_json::from_slice(&bytes)
        .map_err(|error| format!("Memory operator pending settlement is invalid: {error}"))?;
    validate_pending_settlement(&settlement, key)?;
    Ok(Some(settlement))
}

fn write_pending_settlement(
    path: &Path,
    settlement: &PendingJournalSettlement,
    key: &[u8],
) -> Result<(), String> {
    validate_pending_settlement(settlement, key)?;
    if regular_single_link_file(path, "Memory operator pending settlement")? {
        return Err("Memory operator already has a pending settlement".to_string());
    }
    let bytes = serde_json::to_vec(settlement)
        .map_err(|error| format!("Failed to encode Memory operator settlement: {error}"))?;
    let parent = path
        .parent()
        .ok_or("Memory operator pending settlement has no parent")?;
    let staging = parent.join(format!(
        ".memory-operator-v1.{}.pending.tmp",
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
            .map_err(|error| format!("Failed to stage Memory operator settlement: {error}"))?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|error| format!("Failed to persist Memory operator settlement: {error}"))?;
        drop(file);
        set_file_mode(&staging, 0o400)?;
        fs::hard_link(&staging, path)
            .map_err(|error| format!("Failed to publish Memory operator settlement: {error}"))?;
        fs::remove_file(&staging)
            .map_err(|error| format!("Failed to settle Memory operator intent link: {error}"))?;
        sync_file_and_parent(path)?;
        if read_pending_settlement(path, key)?.as_ref() != Some(settlement) {
            return Err("Published Memory operator settlement drifted".to_string());
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&staging);
    }
    result
}

fn remove_pending_settlement(path: &Path) -> Result<(), String> {
    if !regular_single_link_file(path, "Memory operator pending settlement")? {
        return Err("Memory operator pending settlement disappeared".to_string());
    }
    fs::remove_file(path)
        .map_err(|error| format!("Failed to remove Memory operator settlement: {error}"))?;
    sync_parent_directory(path)
}

fn publish_settlement_anchor(
    path: &Path,
    key: &[u8],
    anchor: &ExternalJournalAnchor,
) -> Result<(), String> {
    verify_anchor_binding(anchor, key)?;
    write_external_anchor(
        path,
        key,
        anchor.journal_head_sequence,
        &anchor.journal_head_sha256,
        anchor.created_at_ms,
    )
}

fn recover_pending_settlement(root: &Path, key: &[u8]) -> Result<SettlementRecovery, String> {
    let pending_path = pending_settlement_path(root);
    let Some(settlement) = read_pending_settlement(&pending_path, key)? else {
        return Ok(SettlementRecovery::None);
    };
    let database_path = control_path(root);
    let anchor_path = external_anchor_path(root);
    let database_exists =
        regular_single_link_file(&database_path, "Memory operator control database")?;
    let anchor_exists =
        regular_single_link_file(&anchor_path, "Memory operator external journal anchor")?;

    if settlement.previous_anchor.is_none() {
        match (database_exists, anchor_exists) {
            (false, false) => {
                remove_pending_settlement(&pending_path)?;
                return Ok(SettlementRecovery::AbortedBeforeCommit);
            }
            (true, false) | (true, true) => {
                let connection =
                    open_read_only(&database_path, "Memory operator control database")?;
                let (internal, _) = verify_internal_journal(&connection, key)?;
                if internal != settlement.next_anchor {
                    return Err(
                        "Memory operator bootstrap settlement database binding mismatch"
                            .to_string(),
                    );
                }
                if anchor_exists {
                    let external = read_external_anchor(&anchor_path, key)?;
                    if external != settlement.next_anchor {
                        return Err(
                            "Memory operator bootstrap settlement anchor mismatch".to_string()
                        );
                    }
                    remove_pending_settlement(&pending_path)?;
                    return Ok(SettlementRecovery::RemovedSettledIntent);
                }
                publish_settlement_anchor(&anchor_path, key, &settlement.next_anchor)?;
                remove_pending_settlement(&pending_path)?;
                return Ok(SettlementRecovery::PublishedCommittedAnchor);
            }
            (false, true) => {
                return Err(
                    "Memory operator bootstrap anchor exists without its database".to_string(),
                );
            }
        }
    }

    if !database_exists || !anchor_exists {
        return Err("Memory operator append settlement lost a required artifact".to_string());
    }
    let previous = settlement
        .previous_anchor
        .as_ref()
        .ok_or("Memory operator append settlement previous anchor is missing")?;
    let connection = open_read_only(&database_path, "Memory operator control database")?;
    let (internal, _) = verify_internal_journal(&connection, key)?;
    let external = read_external_anchor(&anchor_path, key)?;
    match (
        internal == *previous,
        internal == settlement.next_anchor,
        external == *previous,
        external == settlement.next_anchor,
    ) {
        (true, false, true, false) => {
            remove_pending_settlement(&pending_path)?;
            Ok(SettlementRecovery::AbortedBeforeCommit)
        }
        (false, true, true, false) => {
            publish_settlement_anchor(&anchor_path, key, &settlement.next_anchor)?;
            remove_pending_settlement(&pending_path)?;
            Ok(SettlementRecovery::PublishedCommittedAnchor)
        }
        (false, true, false, true) => {
            remove_pending_settlement(&pending_path)?;
            Ok(SettlementRecovery::RemovedSettledIntent)
        }
        _ => Err("Memory operator pending settlement state is not provable".to_string()),
    }
}

fn create_control_store(path: &Path, key: &[u8]) -> Result<(), String> {
    create_control_store_with_settlement_stop(path, key, SettlementStop::Complete)
}

fn create_control_store_with_settlement_stop(
    path: &Path,
    key: &[u8],
    settlement_stop: SettlementStop,
) -> Result<(), String> {
    if regular_single_link_file(path, "Memory operator control database")? {
        let inspection = inspect_control_store(path, key)?;
        return if inspection.ready {
            Ok(())
        } else {
            Err(inspection
                .blocked_reason
                .unwrap_or_else(|| "Memory operator control database is not ready".to_string()))
        };
    }
    let root = path
        .parent()
        .ok_or("Memory operator control database has no parent")?;
    let anchor = external_anchor_path(root);
    if regular_single_link_file(&anchor, "Memory operator external journal anchor")? {
        return Err("Memory operator anchor exists without its control database".to_string());
    }
    let staging = root.join(format!(".memory-operator-v1.{}.sqlite", Uuid::new_v4()));
    let result = (|| -> Result<(), String> {
        let connection = Connection::open_with_flags(
            &staging,
            OpenFlags::SQLITE_OPEN_READ_WRITE
                | OpenFlags::SQLITE_OPEN_CREATE
                | OpenFlags::SQLITE_OPEN_NO_MUTEX
                | OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )
        .map_err(|error| format!("Failed to stage Memory operator database: {error}"))?;
        connection
            .execute_batch(SCHEMA_SQL)
            .map_err(|error| format!("Failed to apply Memory operator schema: {error}"))?;
        let created_at_ms = now_ms();
        let anchor_hmac = journal_anchor_hmac(key, 0, ZERO_HASH, created_at_ms)?;
        connection
            .execute(
                "INSERT INTO memory_operator_meta(id, schema_version, schema_sha256, signing_key_id_sha256, journal_head_sequence, journal_head_sha256, journal_anchor_hmac_sha256, created_at_ms) VALUES(1, 1, ?1, ?2, 0, ?3, ?4, ?5)",
                params![
                    sha256_hex(SCHEMA_SQL.as_bytes()),
                    sha256_hex(key),
                    ZERO_HASH,
                    anchor_hmac,
                    created_at_ms,
                ],
            )
            .map_err(|error| format!("Failed to bind Memory operator schema: {error}"))?;
        connection
            .execute(
                "INSERT INTO memory_operator_rehearsal_state(id, generation, authority_kind, authority_binding_sha256, previous_authority_kind, previous_authority_binding_sha256, last_authorization_record_sha256, last_execution_record_sha256, production_integration, updated_at_ms) VALUES(1, 0, 'legacy_snapshot', ?1, NULL, NULL, NULL, NULL, 0, ?2)",
                params![ZERO_HASH, created_at_ms],
            )
            .map_err(|error| format!("Failed to initialize Memory rehearsal authority: {error}"))?;
        sqlite_quick_check(&connection, "Memory operator")?;
        crate::experimental_sqlite_attestation::attest_exact_schema(
            &connection,
            SCHEMA_SQL,
            "Memory operator",
        )?;
        drop(connection);
        set_file_mode(&staging, 0o600)?;
        sync_file_and_parent(&staging)?;
        let next_anchor = journal_anchor(key, 0, ZERO_HASH, created_at_ms)?;
        let pending = create_pending_settlement(key, None, next_anchor.clone(), None)?;
        write_pending_settlement(&pending_settlement_path(root), &pending, key)?;
        if settlement_stop == SettlementStop::AfterPending {
            return Err("Injected Memory operator bootstrap stop after pending".to_string());
        }
        if regular_single_link_file(path, "Memory operator control database")? {
            return Err("Memory operator database appeared during initialization".to_string());
        }
        fs::hard_link(&staging, path)
            .map_err(|error| format!("Failed to publish Memory operator database: {error}"))?;
        fs::remove_file(&staging)
            .map_err(|error| format!("Failed to settle Memory operator database: {error}"))?;
        sync_file_and_parent(path)?;
        if settlement_stop == SettlementStop::AfterCommit {
            return Err(
                "Injected Memory operator bootstrap stop after database publish".to_string(),
            );
        }
        publish_settlement_anchor(&anchor, key, &next_anchor)?;
        if settlement_stop == SettlementStop::AfterAnchor {
            return Err("Injected Memory operator bootstrap stop after anchor publish".to_string());
        }
        remove_pending_settlement(&pending_settlement_path(root))?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&staging);
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
        proposal_record_sha256: &record.proposal_record_sha256,
        proposal_kind: &record.proposal_kind,
        review_record_sha256: record.review_record_sha256.as_deref(),
        decision: record.decision.as_deref(),
        reviewer_subject_sha256: &record.reviewer_subject_sha256,
        review_reason_sha256: record.review_reason_sha256.as_deref(),
        authorization_id: record.authorization_id.as_deref(),
        authorization_token_sha256: record.authorization_token_sha256.as_deref(),
        authorization_record_sha256: record.authorization_record_sha256.as_deref(),
        audience: record.audience.as_deref(),
        rehearsal_authority_state_sha256: record.rehearsal_authority_state_sha256.as_deref(),
        issued_at_ms: record.issued_at_ms,
        expires_at_ms: record.expires_at_ms,
        promotion_schema_ddl_sha256: &record.promotion_schema_ddl_sha256,
        recovery_schema_ddl_sha256: &record.recovery_schema_ddl_sha256,
        memory_database_sha256: &record.memory_database_sha256,
        memory_device: &record.memory_device,
        memory_inode: &record.memory_inode,
        memory_size: record.memory_size,
        previous_record_sha256: &record.previous_record_sha256,
        authorization_consumed: record.authorization_consumed,
        execution_dispatched: record.execution_dispatched,
        rollback_performed: record.rollback_performed,
        production_memory_mutated: record.production_memory_mutated,
        external_effects: record.external_effects,
        created_at_ms: record.created_at_ms,
    })
    .map_err(|error| format!("Failed to canonicalize Memory operator record: {error}"))
}

fn sign_record(record: &mut StoredRecord, key: &[u8]) -> Result<(), String> {
    let canonical = canonical_bytes(record)?;
    record.record_sha256 = sha256_hex(&canonical);
    let mut mac = HmacSha256::new_from_slice(key)
        .map_err(|_| "Failed to initialize Memory operator HMAC".to_string())?;
    mac.update(&canonical);
    record.record_hmac_sha256 = format!("{:x}", mac.finalize().into_bytes());
    Ok(())
}

fn decode_hex(value: &str) -> Result<Vec<u8>, String> {
    if value.len() % 2 != 0 {
        return Err("Invalid Memory operator HMAC encoding".to_string());
    }
    (0..value.len())
        .step_by(2)
        .map(|index| {
            u8::from_str_radix(&value[index..index + 2], 16)
                .map_err(|_| "Invalid Memory operator HMAC encoding".to_string())
        })
        .collect()
}

fn verify_record(record: &StoredRecord, key: &[u8]) -> Result<(), String> {
    let canonical = canonical_bytes(record)?;
    if sha256_hex(&canonical) != record.record_sha256 {
        return Err(format!(
            "Memory operator record {} hash mismatch",
            record.sequence
        ));
    }
    let expected = decode_hex(&record.record_hmac_sha256)?;
    let mut mac = HmacSha256::new_from_slice(key)
        .map_err(|_| "Failed to initialize Memory operator HMAC".to_string())?;
    mac.update(&canonical);
    mac.verify_slice(&expected)
        .map_err(|_| format!("Memory operator record {} HMAC mismatch", record.sequence))
}

const RECORD_SELECT: &str = "SELECT sequence, operation_id, operation_kind, phase, idempotency_key, input_payload_sha256, proposal_record_sha256, proposal_kind, review_record_sha256, decision, reviewer_subject_sha256, review_reason_sha256, authorization_id, authorization_token_sha256, authorization_record_sha256, audience, rehearsal_authority_state_sha256, issued_at_ms, expires_at_ms, promotion_schema_ddl_sha256, recovery_schema_ddl_sha256, memory_database_sha256, memory_device, memory_inode, memory_size, previous_record_sha256, record_sha256, record_hmac_sha256, authorization_consumed, execution_dispatched, rollback_performed, production_memory_mutated, external_effects, created_at_ms FROM memory_operator_record";

fn read_all_records(connection: &Connection) -> Result<Vec<StoredRecord>, String> {
    let mut statement = connection
        .prepare(&format!("{RECORD_SELECT} ORDER BY sequence ASC"))
        .map_err(|error| format!("Failed to prepare Memory operator journal read: {error}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok(StoredRecord {
                sequence: row.get(0)?,
                operation_id: row.get(1)?,
                operation_kind: row.get(2)?,
                phase: row.get(3)?,
                idempotency_key: row.get(4)?,
                input_payload_sha256: row.get(5)?,
                proposal_record_sha256: row.get(6)?,
                proposal_kind: row.get(7)?,
                review_record_sha256: row.get(8)?,
                decision: row.get(9)?,
                reviewer_subject_sha256: row.get(10)?,
                review_reason_sha256: row.get(11)?,
                authorization_id: row.get(12)?,
                authorization_token_sha256: row.get(13)?,
                authorization_record_sha256: row.get(14)?,
                audience: row.get(15)?,
                rehearsal_authority_state_sha256: row.get(16)?,
                issued_at_ms: row.get(17)?,
                expires_at_ms: row.get(18)?,
                promotion_schema_ddl_sha256: row.get(19)?,
                recovery_schema_ddl_sha256: row.get(20)?,
                memory_database_sha256: row.get(21)?,
                memory_device: row.get(22)?,
                memory_inode: row.get(23)?,
                memory_size: row.get(24)?,
                previous_record_sha256: row.get(25)?,
                record_sha256: row.get(26)?,
                record_hmac_sha256: row.get(27)?,
                authorization_consumed: row.get(28)?,
                execution_dispatched: row.get(29)?,
                rollback_performed: row.get(30)?,
                production_memory_mutated: row.get(31)?,
                external_effects: row.get(32)?,
                created_at_ms: row.get(33)?,
            })
        })
        .map_err(|error| format!("Failed to read Memory operator journal: {error}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Failed to decode Memory operator journal: {error}"))
}

fn same_binding(left: &StoredRecord, right: &StoredRecord) -> bool {
    left.proposal_record_sha256 == right.proposal_record_sha256
        && left.proposal_kind == right.proposal_kind
        && left.reviewer_subject_sha256 == right.reviewer_subject_sha256
        && left.promotion_schema_ddl_sha256 == right.promotion_schema_ddl_sha256
        && left.recovery_schema_ddl_sha256 == right.recovery_schema_ddl_sha256
        && left.memory_database_sha256 == right.memory_database_sha256
        && left.memory_device == right.memory_device
        && left.memory_inode == right.memory_inode
        && left.memory_size == right.memory_size
}

fn authorization_lifetime(record: &StoredRecord) -> Result<(i64, i64), String> {
    let issued_at_ms = record
        .issued_at_ms
        .ok_or("Memory execution authorization issue time is missing")?;
    let expires_at_ms = record
        .expires_at_ms
        .ok_or("Memory execution authorization expiry is missing")?;
    let lifetime_ms = expires_at_ms
        .checked_sub(issued_at_ms)
        .ok_or("Memory execution authorization lifetime overflow")?;
    let min_ttl_ms = i64::try_from(MIN_TTL_SECONDS)
        .map_err(|_| "Memory execution authorization minimum TTL overflow".to_string())?
        * 1000;
    let max_ttl_ms = i64::try_from(MAX_TTL_SECONDS)
        .map_err(|_| "Memory execution authorization maximum TTL overflow".to_string())?
        * 1000;
    if issued_at_ms <= 0 || !(min_ttl_ms..=max_ttl_ms).contains(&lifetime_ms) {
        return Err("Memory execution authorization lifetime is invalid".to_string());
    }
    Ok((issued_at_ms, expires_at_ms))
}

fn verify_semantic_links(records: &[StoredRecord], created_at_ms: i64) -> Result<(), String> {
    let mut reviewed_proposals = BTreeSet::new();
    let mut issued_reviews = BTreeSet::new();
    let mut terminal_authorizations = BTreeSet::new();
    let mut rehearsal_state = initial_rehearsal_state(created_at_ms);
    let mut previous_created_at_ms = created_at_ms;
    for record in records {
        let prior_created_at_ms = previous_created_at_ms;
        if record.created_at_ms < previous_created_at_ms {
            return Err("Memory operator journal clock moved backwards".to_string());
        }
        previous_created_at_ms = record.created_at_ms;
        match record.operation_kind.as_str() {
            "operator_review" => {
                if !reviewed_proposals.insert(record.proposal_record_sha256.clone()) {
                    return Err("Memory proposal has more than one operator review".to_string());
                }
            }
            "execution_authorization" => {
                let (issued_at_ms, _) = authorization_lifetime(record)?;
                if issued_at_ms < prior_created_at_ms || record.created_at_ms < issued_at_ms {
                    return Err(
                        "Memory execution authorization issue time is not journal-monotonic"
                            .to_string(),
                    );
                }
                let review_sha256 = record
                    .review_record_sha256
                    .as_deref()
                    .ok_or("Memory authorization review binding is missing")?;
                let review = records
                    .iter()
                    .find(|candidate| {
                        candidate.record_sha256 == review_sha256
                            && candidate.operation_kind == "operator_review"
                            && candidate.phase == "approved"
                            && candidate.sequence < record.sequence
                    })
                    .ok_or("Memory authorization references a missing approved review")?;
                if !same_binding(record, review) || record.decision.as_deref() != Some("approve") {
                    return Err("Memory authorization review binding mismatch".to_string());
                }
                if !issued_reviews.insert(review_sha256.to_string()) {
                    return Err(
                        "Approved Memory review issued more than one authorization".to_string()
                    );
                }
                match record.audience.as_deref() {
                    Some(NO_EFFECT_AUDIENCE)
                        if record.rehearsal_authority_state_sha256.is_none() => {}
                    Some(REHEARSAL_AUDIENCE) => {
                        validate_rehearsal_proposal_state(&rehearsal_state, &record.proposal_kind)?;
                        let supplied = record.rehearsal_authority_state_sha256.as_deref().ok_or(
                            "Memory rehearsal authorization authority-state binding is missing",
                        )?;
                        if !constant_time_eq(
                            supplied,
                            &rehearsal_authority_state_sha256(&rehearsal_state)?,
                        ) {
                            return Err(
                                "Memory rehearsal authorization authority-state binding mismatch"
                                    .to_string(),
                            );
                        }
                    }
                    _ => {
                        return Err("Memory execution authorization audience binding is invalid"
                            .to_string())
                    }
                }
            }
            "authorization_revocation" | "authorization_consumption" => {
                let authorization_sha256 = record
                    .authorization_record_sha256
                    .as_deref()
                    .ok_or("Memory authorization terminal binding is missing")?;
                let issued = records
                    .iter()
                    .find(|candidate| {
                        candidate.record_sha256 == authorization_sha256
                            && candidate.operation_kind == "execution_authorization"
                            && candidate.phase == "issued"
                            && candidate.sequence < record.sequence
                    })
                    .ok_or("Memory authorization terminal record references a missing issue")?;
                if !same_binding(record, issued)
                    || record.review_record_sha256 != issued.review_record_sha256
                    || record.authorization_id != issued.authorization_id
                    || record.authorization_token_sha256 != issued.authorization_token_sha256
                    || record.audience != issued.audience
                    || record.rehearsal_authority_state_sha256
                        != issued.rehearsal_authority_state_sha256
                    || record.issued_at_ms != issued.issued_at_ms
                    || record.expires_at_ms != issued.expires_at_ms
                {
                    return Err("Memory authorization terminal binding mismatch".to_string());
                }
                if !terminal_authorizations.insert(authorization_sha256.to_string()) {
                    return Err(
                        "Memory authorization has more than one terminal record".to_string()
                    );
                }
            }
            _ => return Err("Memory operator journal contains an unknown operation".to_string()),
        }
        if matches!(
            record.phase.as_str(),
            "consumed_rehearsal_applied" | "consumed_rehearsal_restored"
        ) {
            let supplied = record
                .rehearsal_authority_state_sha256
                .as_deref()
                .ok_or("Memory rehearsal consumption authority-state binding is missing")?;
            if !constant_time_eq(
                supplied,
                &rehearsal_authority_state_sha256(&rehearsal_state)?,
            ) {
                return Err(
                    "Memory rehearsal consumption authority-state binding mismatch".to_string(),
                );
            }
            apply_expected_rehearsal_transition(&mut rehearsal_state, record)?;
        }
    }
    Ok(())
}

fn read_rehearsal_state(connection: &Connection) -> Result<MemoryRehearsalAuthorityState, String> {
    connection
        .query_row(
            "SELECT generation, authority_kind, authority_binding_sha256, previous_authority_kind, previous_authority_binding_sha256, last_authorization_record_sha256, last_execution_record_sha256, production_integration, updated_at_ms FROM memory_operator_rehearsal_state WHERE id = 1",
            [],
            |row| {
                Ok(MemoryRehearsalAuthorityState {
                    generation: row.get(0)?,
                    authority_kind: row.get(1)?,
                    authority_binding_sha256: row.get(2)?,
                    previous_authority_kind: row.get(3)?,
                    previous_authority_binding_sha256: row.get(4)?,
                    last_authorization_record_sha256: row.get(5)?,
                    last_execution_record_sha256: row.get(6)?,
                    production_integration: row.get::<_, i64>(7)? != 0,
                    updated_at_ms: row.get(8)?,
                })
            },
        )
        .map_err(|error| format!("Memory rehearsal authority state is missing: {error}"))
}

fn rehearsal_authority_state_sha256(
    state: &MemoryRehearsalAuthorityState,
) -> Result<String, String> {
    stable_input_sha256(&CanonicalRehearsalAuthorityState {
        generation: state.generation,
        authority_kind: &state.authority_kind,
        authority_binding_sha256: &state.authority_binding_sha256,
        previous_authority_kind: state.previous_authority_kind.as_deref(),
        previous_authority_binding_sha256: state.previous_authority_binding_sha256.as_deref(),
        last_authorization_record_sha256: state.last_authorization_record_sha256.as_deref(),
        last_execution_record_sha256: state.last_execution_record_sha256.as_deref(),
        production_integration: state.production_integration,
    })
}

fn validate_rehearsal_proposal_state(
    state: &MemoryRehearsalAuthorityState,
    proposal_kind: &str,
) -> Result<(), String> {
    match proposal_kind {
        "authority_switch_proposal"
            if state.authority_kind == "legacy_snapshot"
                && state.previous_authority_kind.is_none()
                && state.previous_authority_binding_sha256.is_none() =>
        {
            Ok(())
        }
        "manual_restore_proposal"
            if state.authority_kind == "sqlite_memory_v3"
                && state.previous_authority_kind.is_some()
                && state.previous_authority_binding_sha256.is_some() =>
        {
            Ok(())
        }
        "authority_switch_proposal" => {
            Err("Memory rehearsal authority is already switched".to_string())
        }
        "manual_restore_proposal" => {
            Err("Memory rehearsal authority has no switch to restore".to_string())
        }
        _ => Err("Unsupported Memory rehearsal proposal kind".to_string()),
    }
}

fn expected_rehearsal_state(
    records: &[StoredRecord],
    created_at_ms: i64,
) -> Result<MemoryRehearsalAuthorityState, String> {
    let mut state = initial_rehearsal_state(created_at_ms);
    for record in records {
        apply_expected_rehearsal_transition(&mut state, record)?;
    }
    Ok(state)
}

fn initial_rehearsal_state(created_at_ms: i64) -> MemoryRehearsalAuthorityState {
    MemoryRehearsalAuthorityState {
        generation: 0,
        authority_kind: "legacy_snapshot".to_string(),
        authority_binding_sha256: ZERO_HASH.to_string(),
        previous_authority_kind: None,
        previous_authority_binding_sha256: None,
        last_authorization_record_sha256: None,
        last_execution_record_sha256: None,
        production_integration: false,
        updated_at_ms: created_at_ms,
    }
}

fn apply_expected_rehearsal_transition(
    state: &mut MemoryRehearsalAuthorityState,
    record: &StoredRecord,
) -> Result<(), String> {
    match record.phase.as_str() {
        "consumed_rehearsal_applied" => {
            if record.proposal_kind != "authority_switch_proposal"
                || record.audience.as_deref() != Some(REHEARSAL_AUDIENCE)
                || validate_rehearsal_proposal_state(state, &record.proposal_kind).is_err()
            {
                return Err("Memory rehearsal authority-switch sequence is invalid".to_string());
            }
            state.generation += 1;
            state.previous_authority_kind = Some(state.authority_kind.clone());
            state.previous_authority_binding_sha256 = Some(state.authority_binding_sha256.clone());
            state.authority_kind = "sqlite_memory_v3".to_string();
            state.authority_binding_sha256 = record.memory_database_sha256.clone();
            state.last_authorization_record_sha256 = record.authorization_record_sha256.clone();
            state.last_execution_record_sha256 = Some(record.record_sha256.clone());
            state.updated_at_ms = record.created_at_ms;
        }
        "consumed_rehearsal_restored" => {
            if record.proposal_kind != "manual_restore_proposal"
                || record.audience.as_deref() != Some(REHEARSAL_AUDIENCE)
                || validate_rehearsal_proposal_state(state, &record.proposal_kind).is_err()
            {
                return Err("Memory rehearsal restore sequence is invalid".to_string());
            }
            let previous_kind = state
                .previous_authority_kind
                .take()
                .ok_or("Memory rehearsal restore has no prior authority")?;
            let previous_binding = state
                .previous_authority_binding_sha256
                .take()
                .ok_or("Memory rehearsal restore has no prior binding")?;
            state.generation += 1;
            state.authority_kind = previous_kind;
            state.authority_binding_sha256 = previous_binding;
            state.last_authorization_record_sha256 = record.authorization_record_sha256.clone();
            state.last_execution_record_sha256 = Some(record.record_sha256.clone());
            state.updated_at_ms = record.created_at_ms;
        }
        _ => {}
    }
    Ok(())
}

fn verify_rehearsal_state(
    connection: &Connection,
    records: &[StoredRecord],
    created_at_ms: i64,
) -> Result<MemoryRehearsalAuthorityState, String> {
    let actual = read_rehearsal_state(connection)?;
    let expected = expected_rehearsal_state(records, created_at_ms)?;
    if actual != expected {
        return Err("Memory rehearsal authority state drifted from its signed journal".to_string());
    }
    Ok(actual)
}

fn read_internal_anchor(
    connection: &Connection,
    key: &[u8],
) -> Result<ExternalJournalAnchor, String> {
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
            "SELECT schema_version, schema_sha256, signing_key_id_sha256, journal_head_sequence, journal_head_sha256, journal_anchor_hmac_sha256, created_at_ms FROM memory_operator_meta WHERE id = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?)),
        )
        .map_err(|error| format!("Memory operator journal anchor is missing: {error}"))?;
    if schema_version != SCHEMA_VERSION
        || schema_sha256 != sha256_hex(SCHEMA_SQL.as_bytes())
        || key_id != sha256_hex(key)
    {
        return Err("Memory operator schema or signing-key identity mismatch".to_string());
    }
    if anchor_hmac != journal_anchor_hmac(key, head_sequence, &head_sha256, created_at_ms)? {
        return Err("Memory operator journal anchor HMAC mismatch".to_string());
    }
    journal_anchor(key, head_sequence, &head_sha256, created_at_ms)
}

fn verify_internal_records(
    connection: &Connection,
    key: &[u8],
    internal: &ExternalJournalAnchor,
) -> Result<Vec<StoredRecord>, String> {
    let records = read_all_records(connection)?;
    let mut previous = ZERO_HASH.to_string();
    for (index, record) in records.iter().enumerate() {
        if record.sequence != index as i64 + 1 {
            return Err("Memory operator journal sequence is not contiguous".to_string());
        }
        if record.previous_record_sha256 != previous {
            return Err(format!(
                "Memory operator record {} chain mismatch",
                record.sequence
            ));
        }
        if record.external_effects != 0 || record.production_memory_mutated != 0 {
            return Err("Memory operator journal contains a forbidden effect".to_string());
        }
        let expected_execution = i64::from(matches!(
            record.phase.as_str(),
            "consumed_rehearsal_applied" | "consumed_rehearsal_restored"
        ));
        let expected_rollback = i64::from(record.phase == "consumed_rehearsal_restored");
        if record.execution_dispatched != expected_execution
            || record.rollback_performed != expected_rollback
        {
            return Err(
                "Memory operator journal contains invalid rehearsal effect flags".to_string(),
            );
        }
        verify_record(record, key)?;
        previous = record.record_sha256.clone();
    }
    let observed_head_sequence = records.last().map(|record| record.sequence).unwrap_or(0);
    if internal.journal_head_sequence != observed_head_sequence
        || internal.journal_head_sha256 != previous
    {
        return Err("Memory operator journal truncation or rollback detected".to_string());
    }
    verify_semantic_links(&records, internal.created_at_ms)?;
    verify_rehearsal_state(connection, &records, internal.created_at_ms)?;
    crate::experimental_sqlite_attestation::attest_exact_schema(
        connection,
        SCHEMA_SQL,
        "Memory operator",
    )?;
    Ok(records)
}

fn verify_internal_journal(
    connection: &Connection,
    key: &[u8],
) -> Result<(ExternalJournalAnchor, Vec<StoredRecord>), String> {
    let internal = read_internal_anchor(connection, key)?;
    let records = verify_internal_records(connection, key, &internal)?;
    Ok((internal, records))
}

fn verify_journal(
    connection: &Connection,
    key: &[u8],
    external_path: &Path,
) -> Result<Vec<StoredRecord>, String> {
    let internal = read_internal_anchor(connection, key)?;
    let external = read_external_anchor(external_path, key)?;
    if external != internal {
        return Err(
            "Memory operator external anchor detected control-database rollback".to_string(),
        );
    }
    verify_internal_records(connection, key, &internal)
}

fn terminal_record<'a>(
    records: &'a [StoredRecord],
    authorization_sha256: &str,
) -> Option<&'a StoredRecord> {
    records.iter().find(|candidate| {
        candidate.authorization_record_sha256.as_deref() == Some(authorization_sha256)
            && matches!(
                candidate.operation_kind.as_str(),
                "authorization_revocation" | "authorization_consumption"
            )
    })
}

fn inspect_control_store(path: &Path, key: &[u8]) -> Result<StoreInspection, String> {
    if !regular_single_link_file(path, "Memory operator control database")? {
        return Ok(StoreInspection {
            initialized: false,
            ready: false,
            schema_version: None,
            exact_schema_ddl_sha256: String::new(),
            journal_record_count: 0,
            approved_review_count: 0,
            rejected_review_count: 0,
            active_authorization_count: 0,
            consumed_authorization_count: 0,
            revoked_authorization_count: 0,
            execution_dispatched: false,
            rollback_performed: false,
            blocked_reason: None,
        });
    }
    let result = (|| -> Result<(String, Vec<StoredRecord>), String> {
        let root = path
            .parent()
            .ok_or("Memory operator control database has no parent")?;
        if read_pending_settlement(&pending_settlement_path(root), key)?.is_some() {
            return Err(
                "Memory operator has a signed pending settlement; acquire the writer lease to recover it"
                    .to_string(),
            );
        }
        let connection = open_read_only(path, "Memory operator control database")?;
        sqlite_quick_check(&connection, "Memory operator")?;
        let attestation = crate::experimental_sqlite_attestation::attest_exact_schema(
            &connection,
            SCHEMA_SQL,
            "Memory operator",
        )?;
        let records = verify_journal(&connection, key, &external_anchor_path(root))?;
        Ok((attestation.actual_manifest_sha256, records))
    })();
    Ok(match result {
        Ok((ddl_sha256, records)) => {
            let issued = records
                .iter()
                .filter(|record| record.operation_kind == "execution_authorization")
                .collect::<Vec<_>>();
            StoreInspection {
                initialized: true,
                ready: true,
                schema_version: Some(SCHEMA_VERSION),
                exact_schema_ddl_sha256: ddl_sha256,
                journal_record_count: records.len() as u64,
                approved_review_count: records
                    .iter()
                    .filter(|record| record.phase == "approved")
                    .count() as u64,
                rejected_review_count: records
                    .iter()
                    .filter(|record| record.phase == "rejected")
                    .count() as u64,
                active_authorization_count: issued
                    .iter()
                    .filter(|record| terminal_record(&records, &record.record_sha256).is_none())
                    .count() as u64,
                consumed_authorization_count: records
                    .iter()
                    .filter(|record| record.operation_kind == "authorization_consumption")
                    .count() as u64,
                revoked_authorization_count: records
                    .iter()
                    .filter(|record| record.phase == "revoked")
                    .count() as u64,
                execution_dispatched: records
                    .iter()
                    .any(|record| record.execution_dispatched == 1),
                rollback_performed: records.iter().any(|record| record.rollback_performed == 1),
                blocked_reason: None,
            }
        }
        Err(error) => StoreInspection {
            initialized: true,
            ready: false,
            schema_version: None,
            exact_schema_ddl_sha256: String::new(),
            journal_record_count: 0,
            approved_review_count: 0,
            rejected_review_count: 0,
            active_authorization_count: 0,
            consumed_authorization_count: 0,
            revoked_authorization_count: 0,
            execution_dispatched: false,
            rollback_performed: false,
            blocked_reason: Some(error),
        },
    })
}

fn find_identity_record<'a>(
    records: &'a [StoredRecord],
    operation_id: &str,
    idempotency_key: &str,
) -> Result<Option<&'a StoredRecord>, String> {
    let operation = records
        .iter()
        .find(|record| record.operation_id == operation_id);
    let idempotent = records
        .iter()
        .find(|record| record.idempotency_key == idempotency_key);
    match (operation, idempotent) {
        (None, None) => Ok(None),
        (Some(left), Some(right)) if left.record_sha256 == right.record_sha256 => Ok(Some(left)),
        _ => Err("Memory operator operation/idempotency identity collision".to_string()),
    }
}

fn apply_rehearsal_transition(
    transaction: &rusqlite::Transaction<'_>,
    record: &StoredRecord,
) -> Result<(), String> {
    match record.phase.as_str() {
        "consumed_rehearsal_applied" => {
            let state = read_rehearsal_state(transaction)?;
            let expected_state_sha256 = record
                .rehearsal_authority_state_sha256
                .as_deref()
                .ok_or("Memory rehearsal authorization has no authority-state binding")?;
            if !constant_time_eq(
                expected_state_sha256,
                &rehearsal_authority_state_sha256(&state)?,
            ) {
                return Err("Memory rehearsal authorization authority state drifted".to_string());
            }
            validate_rehearsal_proposal_state(&state, &record.proposal_kind)?;
            let changed = transaction
                .execute(
                    "UPDATE memory_operator_rehearsal_state SET generation = generation + 1, previous_authority_kind = authority_kind, previous_authority_binding_sha256 = authority_binding_sha256, authority_kind = 'sqlite_memory_v3', authority_binding_sha256 = ?1, last_authorization_record_sha256 = ?2, last_execution_record_sha256 = ?3, updated_at_ms = ?4 WHERE id = 1 AND production_integration = 0 AND generation = ?5 AND authority_kind = ?6 AND authority_binding_sha256 = ?7 AND previous_authority_kind IS NULL AND previous_authority_binding_sha256 IS NULL",
                    params![
                        record.memory_database_sha256,
                        record.authorization_record_sha256,
                        record.record_sha256,
                        record.created_at_ms,
                        state.generation,
                        state.authority_kind,
                        state.authority_binding_sha256,
                    ],
                )
                .map_err(|error| format!("Failed to apply isolated Memory authority switch: {error}"))?;
            if changed != 1 {
                return Err(
                    "Memory rehearsal authority switch changed no singleton row".to_string()
                );
            }
        }
        "consumed_rehearsal_restored" => {
            let state = read_rehearsal_state(transaction)?;
            let expected_state_sha256 = record
                .rehearsal_authority_state_sha256
                .as_deref()
                .ok_or("Memory rehearsal authorization has no authority-state binding")?;
            if !constant_time_eq(
                expected_state_sha256,
                &rehearsal_authority_state_sha256(&state)?,
            ) {
                return Err("Memory rehearsal authorization authority state drifted".to_string());
            }
            validate_rehearsal_proposal_state(&state, &record.proposal_kind)?;
            let changed = transaction
                .execute(
                    "UPDATE memory_operator_rehearsal_state SET generation = generation + 1, authority_kind = previous_authority_kind, authority_binding_sha256 = previous_authority_binding_sha256, previous_authority_kind = NULL, previous_authority_binding_sha256 = NULL, last_authorization_record_sha256 = ?1, last_execution_record_sha256 = ?2, updated_at_ms = ?3 WHERE id = 1 AND production_integration = 0 AND generation = ?4 AND authority_kind = ?5 AND authority_binding_sha256 = ?6 AND previous_authority_kind = ?7 AND previous_authority_binding_sha256 = ?8",
                    params![
                        record.authorization_record_sha256,
                        record.record_sha256,
                        record.created_at_ms,
                        state.generation,
                        state.authority_kind,
                        state.authority_binding_sha256,
                        state.previous_authority_kind,
                        state.previous_authority_binding_sha256,
                    ],
                )
                .map_err(|error| format!("Failed to restore isolated Memory authority: {error}"))?;
            if changed != 1 {
                return Err("Memory rehearsal restore changed no singleton row".to_string());
            }
        }
        _ => {}
    }
    Ok(())
}

fn append_record(
    connection: &mut Connection,
    key: &[u8],
    external_path: &Path,
    input: NewRecord<'_>,
) -> Result<StoredRecord, String> {
    append_record_with_settlement_stop(
        connection,
        key,
        external_path,
        input,
        SettlementStop::Complete,
    )
}

fn append_record_with_settlement_stop(
    connection: &mut Connection,
    key: &[u8],
    external_path: &Path,
    input: NewRecord<'_>,
    settlement_stop: SettlementStop,
) -> Result<StoredRecord, String> {
    let root = external_path
        .parent()
        .ok_or("Memory operator anchor has no parent")?;
    if read_pending_settlement(&pending_settlement_path(root), key)?.is_some() {
        return Err("Memory operator append requires pending-settlement recovery".to_string());
    }
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("Failed to begin Memory operator transaction: {error}"))?;
    let records = verify_journal(&transaction, key, external_path)?;
    if find_identity_record(&records, input.operation_id, input.idempotency_key)?.is_some() {
        return Err("Memory operator record appeared during append".to_string());
    }
    let (sequence, previous, anchor_created_at_ms): (i64, String, i64) = transaction
        .query_row(
            "SELECT journal_head_sequence + 1, journal_head_sha256, created_at_ms FROM memory_operator_meta WHERE id = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(|error| format!("Failed to read Memory operator journal head: {error}"))?;
    let mut record = StoredRecord {
        sequence,
        operation_id: input.operation_id.to_string(),
        operation_kind: input.operation_kind.to_string(),
        phase: input.phase.to_string(),
        idempotency_key: input.idempotency_key.to_string(),
        input_payload_sha256: input.input_payload_sha256.to_string(),
        proposal_record_sha256: input.proposal.proposal_record_sha256.clone(),
        proposal_kind: input.proposal.proposal_kind.clone(),
        review_record_sha256: input.review_record_sha256.map(ToString::to_string),
        decision: input.decision.map(ToString::to_string),
        reviewer_subject_sha256: input.reviewer_subject_sha256.to_string(),
        review_reason_sha256: input.review_reason_sha256.map(ToString::to_string),
        authorization_id: input.authorization_id.map(ToString::to_string),
        authorization_token_sha256: input.authorization_token_sha256.map(ToString::to_string),
        authorization_record_sha256: input.authorization_record_sha256.map(ToString::to_string),
        audience: input.audience.map(ToString::to_string),
        rehearsal_authority_state_sha256: input
            .rehearsal_authority_state_sha256
            .map(ToString::to_string),
        issued_at_ms: input.issued_at_ms,
        expires_at_ms: input.expires_at_ms,
        promotion_schema_ddl_sha256: input.promotion_schema_ddl_sha256.to_string(),
        recovery_schema_ddl_sha256: input.recovery_schema_ddl_sha256.to_string(),
        memory_database_sha256: input.proposal.memory_database_sha256.clone(),
        memory_device: input.proposal.memory_device.clone(),
        memory_inode: input.proposal.memory_inode.clone(),
        memory_size: i64::try_from(input.proposal.memory_size)
            .map_err(|_| "Memory operator database size exceeds SQLite range".to_string())?,
        previous_record_sha256: previous,
        record_sha256: String::new(),
        record_hmac_sha256: String::new(),
        authorization_consumed: i64::from(input.authorization_consumed),
        execution_dispatched: i64::from(input.execution_dispatched),
        rollback_performed: i64::from(input.rollback_performed),
        production_memory_mutated: 0,
        external_effects: 0,
        created_at_ms: now_ms(),
    };
    sign_record(&mut record, key)?;
    transaction
        .execute(
            "INSERT INTO memory_operator_record(sequence, operation_id, operation_kind, phase, idempotency_key, input_payload_sha256, proposal_record_sha256, proposal_kind, review_record_sha256, decision, reviewer_subject_sha256, review_reason_sha256, authorization_id, authorization_token_sha256, authorization_record_sha256, audience, rehearsal_authority_state_sha256, issued_at_ms, expires_at_ms, promotion_schema_ddl_sha256, recovery_schema_ddl_sha256, memory_database_sha256, memory_device, memory_inode, memory_size, previous_record_sha256, record_sha256, record_hmac_sha256, authorization_consumed, execution_dispatched, rollback_performed, production_memory_mutated, external_effects, created_at_ms) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29, ?30, ?31, 0, 0, ?32)",
            params![
                record.sequence,
                record.operation_id,
                record.operation_kind,
                record.phase,
                record.idempotency_key,
                record.input_payload_sha256,
                record.proposal_record_sha256,
                record.proposal_kind,
                record.review_record_sha256,
                record.decision,
                record.reviewer_subject_sha256,
                record.review_reason_sha256,
                record.authorization_id,
                record.authorization_token_sha256,
                record.authorization_record_sha256,
                record.audience,
                record.rehearsal_authority_state_sha256,
                record.issued_at_ms,
                record.expires_at_ms,
                record.promotion_schema_ddl_sha256,
                record.recovery_schema_ddl_sha256,
                record.memory_database_sha256,
                record.memory_device,
                record.memory_inode,
                record.memory_size,
                record.previous_record_sha256,
                record.record_sha256,
                record.record_hmac_sha256,
                record.authorization_consumed,
                record.execution_dispatched,
                record.rollback_performed,
                record.created_at_ms,
            ],
        )
        .map_err(|error| format!("Failed to append Memory operator record: {error}"))?;
    apply_rehearsal_transition(&transaction, &record)?;
    let mut next_records = records;
    next_records.push(record.clone());
    verify_semantic_links(&next_records, anchor_created_at_ms)?;
    verify_rehearsal_state(&transaction, &next_records, anchor_created_at_ms)?;
    let next_anchor_hmac = journal_anchor_hmac(
        key,
        record.sequence,
        &record.record_sha256,
        anchor_created_at_ms,
    )?;
    transaction
        .execute(
            "UPDATE memory_operator_meta SET journal_head_sequence = ?1, journal_head_sha256 = ?2, journal_anchor_hmac_sha256 = ?3 WHERE id = 1",
            params![record.sequence, record.record_sha256, next_anchor_hmac],
        )
        .map_err(|error| format!("Failed to advance Memory operator journal head: {error}"))?;
    let previous_anchor = read_external_anchor(external_path, key)?;
    if previous_anchor.journal_head_sequence != record.sequence - 1
        || previous_anchor.journal_head_sha256 != record.previous_record_sha256
        || previous_anchor.created_at_ms != anchor_created_at_ms
    {
        return Err("Memory operator append previous anchor drifted".to_string());
    }
    let next_anchor = journal_anchor(
        key,
        record.sequence,
        &record.record_sha256,
        anchor_created_at_ms,
    )?;
    let pending = create_pending_settlement(
        key,
        Some(previous_anchor),
        next_anchor.clone(),
        Some(record.record_sha256.clone()),
    )?;
    write_pending_settlement(&pending_settlement_path(root), &pending, key)?;
    if settlement_stop == SettlementStop::AfterPending {
        return Err("Injected Memory operator stop after pending settlement".to_string());
    }
    transaction
        .commit()
        .map_err(|error| format!("Failed to commit Memory operator record: {error}"))?;
    sync_file_and_parent(&control_path(root))?;
    if settlement_stop == SettlementStop::AfterCommit {
        return Err("Injected Memory operator stop after SQLite commit".to_string());
    }
    publish_settlement_anchor(external_path, key, &next_anchor)?;
    if settlement_stop == SettlementStop::AfterAnchor {
        return Err("Injected Memory operator stop after anchor publish".to_string());
    }
    remove_pending_settlement(&pending_settlement_path(root))?;
    Ok(record)
}

fn receipt(
    record: &StoredRecord,
    authorization_token: Option<String>,
    duplicate: bool,
) -> MemoryOperatorReceipt {
    MemoryOperatorReceipt {
        operation_id: record.operation_id.clone(),
        operation_kind: record.operation_kind.clone(),
        phase: record.phase.clone(),
        record_sequence: record.sequence,
        record_sha256: record.record_sha256.clone(),
        record_hmac_sha256: record.record_hmac_sha256.clone(),
        proposal_record_sha256: record.proposal_record_sha256.clone(),
        proposal_kind: record.proposal_kind.clone(),
        review_record_sha256: record.review_record_sha256.clone(),
        decision: record.decision.clone(),
        reviewer_subject_sha256: record.reviewer_subject_sha256.clone(),
        authorization_id: record.authorization_id.clone(),
        authorization_token,
        authorization_record_sha256: record.authorization_record_sha256.clone(),
        rehearsal_authority_state_sha256: record.rehearsal_authority_state_sha256.clone(),
        issued_at_ms: record.issued_at_ms,
        expires_at_ms: record.expires_at_ms,
        promotion_schema_ddl_sha256: record.promotion_schema_ddl_sha256.clone(),
        recovery_schema_ddl_sha256: record.recovery_schema_ddl_sha256.clone(),
        memory_database_sha256: record.memory_database_sha256.clone(),
        authorization_consumed: record.authorization_consumed == 1,
        execution_dispatched: record.execution_dispatched == 1,
        rollback_performed: record.rollback_performed == 1,
        production_memory_mutated: record.production_memory_mutated == 1,
        external_effects: record.external_effects.max(0) as u8,
        duplicate,
        production_integration: false,
    }
}

fn validate_duplicate(
    record: &StoredRecord,
    input_payload_sha256: &str,
) -> Result<MemoryOperatorReceipt, String> {
    if record.input_payload_sha256 != input_payload_sha256 {
        return Err("Memory operator idempotency payload mismatch".to_string());
    }
    Ok(receipt(record, None, true))
}

fn dependency_attestation(
    root: &Path,
    proposal_record_sha256: &str,
) -> Result<(ProposalSnapshot, String, String), String> {
    let promotion =
        crate::experimental_memory_promotion::exact_control_schema_attestation_at(root)?;
    let recovery = crate::experimental_memory_recovery::exact_control_schema_attestation_at(root)?;
    let proposal = crate::experimental_memory_promotion::verify_operator_proposal_at(
        root,
        proposal_record_sha256,
    )?;
    Ok((
        ProposalSnapshot::from(&proposal),
        promotion.actual_manifest_sha256,
        recovery.actual_manifest_sha256,
    ))
}

fn binding_matches(
    record: &StoredRecord,
    proposal: &ProposalSnapshot,
    promotion_ddl_sha256: &str,
    recovery_ddl_sha256: &str,
) -> bool {
    record.proposal_record_sha256 == proposal.proposal_record_sha256
        && record.proposal_kind == proposal.proposal_kind
        && record.promotion_schema_ddl_sha256 == promotion_ddl_sha256
        && record.recovery_schema_ddl_sha256 == recovery_ddl_sha256
        && record.memory_database_sha256 == proposal.memory_database_sha256
        && record.memory_device == proposal.memory_device
        && record.memory_inode == proposal.memory_inode
        && record.memory_size == i64::try_from(proposal.memory_size).unwrap_or(-1)
}

fn constant_time_eq(left: &str, right: &str) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.as_bytes()
        .iter()
        .zip(right.as_bytes())
        .fold(0u8, |difference, (left, right)| difference | (left ^ right))
        == 0
}

fn random_capability_token() -> String {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    let encoded = bytes
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("bbm1_{encoded}")
}

fn status_at(root: &Path, enabled: bool) -> ExperimentalMemoryOperatorStatus {
    let path = control_path(root);
    let inspection = if !platform_supported() {
        StoreInspection {
            initialized: false,
            ready: false,
            schema_version: None,
            exact_schema_ddl_sha256: String::new(),
            journal_record_count: 0,
            approved_review_count: 0,
            rejected_review_count: 0,
            active_authorization_count: 0,
            consumed_authorization_count: 0,
            revoked_authorization_count: 0,
            execution_dispatched: false,
            rollback_performed: false,
            blocked_reason: Some(
                "Experimental Memory operator gate requires native Unix lease".to_string(),
            ),
        }
    } else if !enabled {
        StoreInspection {
            initialized: false,
            ready: false,
            schema_version: None,
            exact_schema_ddl_sha256: String::new(),
            journal_record_count: 0,
            approved_review_count: 0,
            rejected_review_count: 0,
            active_authorization_count: 0,
            consumed_authorization_count: 0,
            revoked_authorization_count: 0,
            execution_dispatched: false,
            rollback_performed: false,
            blocked_reason: None,
        }
    } else {
        read_signing_key(&key_path(root))
            .and_then(|key| inspect_control_store(&path, &key))
            .unwrap_or_else(|error| StoreInspection {
                initialized: path.exists(),
                ready: false,
                schema_version: None,
                exact_schema_ddl_sha256: String::new(),
                journal_record_count: 0,
                approved_review_count: 0,
                rejected_review_count: 0,
                active_authorization_count: 0,
                consumed_authorization_count: 0,
                revoked_authorization_count: 0,
                execution_dispatched: false,
                rollback_performed: false,
                blocked_reason: Some(error),
            })
    };
    ExperimentalMemoryOperatorStatus {
        enabled: enabled && platform_supported(),
        platform_supported: platform_supported(),
        initialized: inspection.initialized,
        ready: enabled && inspection.ready,
        path: path.display().to_string(),
        schema_version: inspection.schema_version,
        schema_sha256: sha256_hex(SCHEMA_SQL.as_bytes()),
        exact_schema_ddl_sha256: inspection.exact_schema_ddl_sha256,
        exact_schema_ddl_verified: enabled && inspection.ready,
        journal_record_count: inspection.journal_record_count,
        approved_review_count: inspection.approved_review_count,
        rejected_review_count: inspection.rejected_review_count,
        active_authorization_count: inspection.active_authorization_count,
        consumed_authorization_count: inspection.consumed_authorization_count,
        revoked_authorization_count: inspection.revoked_authorization_count,
        journal_hmac_verified: enabled && inspection.ready,
        single_use_enforced: enabled && inspection.ready,
        preconsumption_validation_failure_preserves_authorization: enabled && inspection.ready,
        post_commit_recovery_supported: enabled && inspection.ready,
        execution_adapter_available: enabled && inspection.ready,
        isolated_rehearsal_only: true,
        execution_dispatched: inspection.execution_dispatched,
        rollback_performed: inspection.rollback_performed,
        production_memory_mutated: false,
        production_integration: false,
        blocked_reason: inspection.blocked_reason,
    }
}

#[tauri::command]
pub(crate) fn get_experimental_memory_operator_status(
) -> Result<ExperimentalMemoryOperatorStatus, String> {
    let root = status_root()?;
    Ok(status_at(&root, feature_enabled()))
}

pub(crate) fn initialize_at(root: &Path) -> Result<ExperimentalMemoryOperatorStatus, String> {
    if !platform_supported() {
        return Err("Experimental Memory operator gate requires a Unix host".to_string());
    }
    let root =
        crate::experimental_memory_recovery::normalize_platform_root_alias(root.to_path_buf());
    ensure_private_directory(&root, "Experimental Memory root")?;
    let _lease = crate::experimental_memory_recovery::acquire_host_wide_memory_lease(&root)?;
    let database_exists =
        regular_single_link_file(&control_path(&root), "Memory operator control database")?;
    let key_exists = regular_single_link_file(&key_path(&root), "Memory operator signing key")?;
    if database_exists && !key_exists {
        return Err(
            "Memory operator control database exists without its signing key; refusing key rotation"
                .to_string(),
        );
    }
    let key = create_signing_key(&key_path(&root))?;
    recover_pending_settlement(&root, &key)?;
    create_control_store(&control_path(&root), &key)?;
    Ok(status_at(&root, true))
}

#[tauri::command]
pub(crate) fn initialize_experimental_memory_operator(
) -> Result<ExperimentalMemoryOperatorStatus, String> {
    initialize_at(&isolated_root()?)
}

#[tauri::command]
pub(crate) async fn create_experimental_memory_reviewer_session(
    input: CreateMemoryReviewerSessionInput,
) -> Result<MemoryReviewerSessionReceipt, String> {
    validate_reviewer_session_request(&input)?;
    let root = isolated_root()?;
    let key_before_authentication = reviewer_session_key_at(&root)?;
    let witness = authenticate_local_reviewer().await?;
    let key_after_authentication = reviewer_session_key_at(&root)?;
    if !constant_time_eq(
        &sha256_hex(&key_before_authentication),
        &sha256_hex(&key_after_authentication),
    ) {
        return Err(
            "Memory operator signing key changed during reviewer authentication".to_string(),
        );
    }
    issue_reviewer_session(&key_after_authentication, &input, witness, now_ms())
}

pub(crate) fn review_proposal_at(
    root: &Path,
    input: ReviewMemoryProposalInput,
) -> Result<MemoryOperatorReceipt, String> {
    validate_token("operationId", &input.operation_id)?;
    validate_token("idempotencyKey", &input.idempotency_key)?;
    validate_hash("proposalRecordSha256", &input.proposal_record_sha256)?;
    validate_hash("reviewReasonSha256", &input.review_reason_sha256)?;
    if !matches!(input.decision.as_str(), "approve" | "reject") {
        return Err("Memory operator review decision must be approve or reject".to_string());
    }
    let phase = if input.decision == "approve" {
        "approved"
    } else {
        "rejected"
    };
    let reviewer_action_sha256 = reviewer_action_sha256(
        "proposal_review",
        &input.operation_id,
        &input.idempotency_key,
        &input.proposal_record_sha256,
        Some(&input.decision),
        None,
        &input.review_reason_sha256,
    )?;
    let root =
        crate::experimental_memory_recovery::normalize_platform_root_alias(root.to_path_buf());
    let _lease = crate::experimental_memory_recovery::acquire_host_wide_memory_lease(&root)?;
    let key = read_signing_key(&key_path(&root))?;
    recover_pending_settlement(&root, &key)?;
    let reviewer_session = verify_reviewer_session(
        &input.reviewer_session_token,
        &key,
        &reviewer_action_sha256,
        now_ms(),
    )?;
    let input_hash = stable_input_sha256(&CanonicalReviewRequest {
        operation_id: &input.operation_id,
        proposal_record_sha256: &input.proposal_record_sha256,
        decision: &input.decision,
        reviewer_subject_sha256: &reviewer_session.reviewer_subject_sha256,
        review_reason_sha256: &input.review_reason_sha256,
        idempotency_key: &input.idempotency_key,
    })?;
    let mut connection = open_read_write(&control_path(&root))?;
    let records = verify_journal(&connection, &key, &external_anchor_path(&root))?;
    let (proposal, promotion_ddl, recovery_ddl) =
        dependency_attestation(&root, &input.proposal_record_sha256)?;
    if let Some(existing) =
        find_identity_record(&records, &input.operation_id, &input.idempotency_key)?
    {
        if !binding_matches(existing, &proposal, &promotion_ddl, &recovery_ddl) {
            return Err("Memory operator duplicate binding drifted".to_string());
        }
        return validate_duplicate(existing, &input_hash);
    }
    if records.iter().any(|record| {
        record.operation_kind == "operator_review"
            && record.proposal_record_sha256 == input.proposal_record_sha256
    }) {
        return Err("Memory proposal already has an operator review".to_string());
    }
    let record = append_record(
        &mut connection,
        &key,
        &external_anchor_path(&root),
        NewRecord {
            operation_id: &input.operation_id,
            operation_kind: "operator_review",
            phase,
            idempotency_key: &input.idempotency_key,
            input_payload_sha256: &input_hash,
            proposal: &proposal,
            review_record_sha256: None,
            decision: Some(&input.decision),
            reviewer_subject_sha256: &reviewer_session.reviewer_subject_sha256,
            review_reason_sha256: Some(&input.review_reason_sha256),
            authorization_id: None,
            authorization_token_sha256: None,
            authorization_record_sha256: None,
            audience: None,
            rehearsal_authority_state_sha256: None,
            issued_at_ms: None,
            expires_at_ms: None,
            promotion_schema_ddl_sha256: &promotion_ddl,
            recovery_schema_ddl_sha256: &recovery_ddl,
            authorization_consumed: false,
            execution_dispatched: false,
            rollback_performed: false,
        },
    )?;
    Ok(receipt(&record, None, false))
}

#[tauri::command]
pub(crate) fn review_experimental_memory_proposal(
    input: ReviewMemoryProposalInput,
) -> Result<MemoryOperatorReceipt, String> {
    review_proposal_at(&isolated_root()?, input)
}

fn issue_authorization_at_for_audience(
    root: &Path,
    input: IssueMemoryExecutionAuthorizationInput,
    audience: &str,
) -> Result<MemoryOperatorReceipt, String> {
    if !matches!(audience, NO_EFFECT_AUDIENCE | REHEARSAL_AUDIENCE) {
        return Err("Unsupported Memory execution authorization audience".to_string());
    }
    validate_token("operationId", &input.operation_id)?;
    validate_token("idempotencyKey", &input.idempotency_key)?;
    validate_hash("reviewRecordSha256", &input.review_record_sha256)?;
    validate_hash("proposalRecordSha256", &input.proposal_record_sha256)?;
    validate_hash("expectedMemorySha256", &input.expected_memory_sha256)?;
    if !(MIN_TTL_SECONDS..=MAX_TTL_SECONDS).contains(&input.ttl_seconds) {
        return Err(format!(
            "Memory execution authorization TTL must be between {MIN_TTL_SECONDS} and {MAX_TTL_SECONDS} seconds"
        ));
    }
    let input_hash = stable_input_sha256(&CanonicalAuthorizationRequest {
        operation_id: &input.operation_id,
        review_record_sha256: &input.review_record_sha256,
        proposal_record_sha256: &input.proposal_record_sha256,
        expected_memory_sha256: &input.expected_memory_sha256,
        ttl_seconds: input.ttl_seconds,
        idempotency_key: &input.idempotency_key,
        audience,
    })?;
    let root =
        crate::experimental_memory_recovery::normalize_platform_root_alias(root.to_path_buf());
    let _lease = crate::experimental_memory_recovery::acquire_host_wide_memory_lease(&root)?;
    let key = read_signing_key(&key_path(&root))?;
    recover_pending_settlement(&root, &key)?;
    let mut connection = open_read_write(&control_path(&root))?;
    let records = verify_journal(&connection, &key, &external_anchor_path(&root))?;
    let (proposal, promotion_ddl, recovery_ddl) =
        dependency_attestation(&root, &input.proposal_record_sha256)?;
    if let Some(existing) =
        find_identity_record(&records, &input.operation_id, &input.idempotency_key)?
    {
        if !binding_matches(existing, &proposal, &promotion_ddl, &recovery_ddl) {
            return Err("Memory authorization duplicate binding drifted".to_string());
        }
        return validate_duplicate(existing, &input_hash);
    }
    let review = records
        .iter()
        .find(|record| {
            record.record_sha256 == input.review_record_sha256
                && record.operation_kind == "operator_review"
                && record.phase == "approved"
        })
        .ok_or("Approved Memory operator review is missing")?;
    if review.proposal_record_sha256 != input.proposal_record_sha256
        || review.decision.as_deref() != Some("approve")
        || !binding_matches(review, &proposal, &promotion_ddl, &recovery_ddl)
        || proposal.memory_database_sha256 != input.expected_memory_sha256
    {
        return Err("Approved Memory review no longer matches its proposal".to_string());
    }
    if records.iter().any(|record| {
        record.operation_kind == "execution_authorization"
            && record.review_record_sha256.as_deref() == Some(&input.review_record_sha256)
    }) {
        return Err("Approved Memory review already issued an authorization".to_string());
    }
    let rehearsal_authority_state_sha256 = if audience == REHEARSAL_AUDIENCE {
        let state = read_rehearsal_state(&connection)?;
        validate_rehearsal_proposal_state(&state, &proposal.proposal_kind)?;
        Some(rehearsal_authority_state_sha256(&state)?)
    } else {
        None
    };
    let authorization_id = format!("memory-auth:{}", Uuid::new_v4());
    let authorization_token = random_capability_token();
    let authorization_token_sha256 = sha256_hex(authorization_token.as_bytes());
    let issued_at_ms = now_ms();
    let expires_at_ms = issued_at_ms
        .checked_add(
            i64::try_from(input.ttl_seconds)
                .map_err(|_| "Memory authorization TTL is too large".to_string())?
                * 1000,
        )
        .ok_or("Memory authorization expiry overflow")?;
    let record = append_record(
        &mut connection,
        &key,
        &external_anchor_path(&root),
        NewRecord {
            operation_id: &input.operation_id,
            operation_kind: "execution_authorization",
            phase: "issued",
            idempotency_key: &input.idempotency_key,
            input_payload_sha256: &input_hash,
            proposal: &proposal,
            review_record_sha256: Some(&review.record_sha256),
            decision: Some("approve"),
            reviewer_subject_sha256: &review.reviewer_subject_sha256,
            review_reason_sha256: None,
            authorization_id: Some(&authorization_id),
            authorization_token_sha256: Some(&authorization_token_sha256),
            authorization_record_sha256: None,
            audience: Some(audience),
            rehearsal_authority_state_sha256: rehearsal_authority_state_sha256.as_deref(),
            issued_at_ms: Some(issued_at_ms),
            expires_at_ms: Some(expires_at_ms),
            promotion_schema_ddl_sha256: &promotion_ddl,
            recovery_schema_ddl_sha256: &recovery_ddl,
            authorization_consumed: false,
            execution_dispatched: false,
            rollback_performed: false,
        },
    )?;
    Ok(receipt(&record, Some(authorization_token), false))
}

pub(crate) fn issue_authorization_at(
    root: &Path,
    input: IssueMemoryExecutionAuthorizationInput,
) -> Result<MemoryOperatorReceipt, String> {
    issue_authorization_at_for_audience(root, input, NO_EFFECT_AUDIENCE)
}

pub(crate) fn issue_rehearsal_authorization_at(
    root: &Path,
    input: IssueMemoryExecutionAuthorizationInput,
) -> Result<MemoryOperatorReceipt, String> {
    issue_authorization_at_for_audience(root, input, REHEARSAL_AUDIENCE)
}

#[tauri::command]
pub(crate) fn issue_experimental_memory_execution_authorization(
    input: IssueMemoryExecutionAuthorizationInput,
) -> Result<MemoryOperatorReceipt, String> {
    issue_authorization_at(&isolated_root()?, input)
}

#[tauri::command]
pub(crate) fn issue_experimental_memory_rehearsal_authorization(
    input: IssueMemoryExecutionAuthorizationInput,
) -> Result<MemoryOperatorReceipt, String> {
    issue_rehearsal_authorization_at(&isolated_root()?, input)
}

pub(crate) fn revoke_authorization_at(
    root: &Path,
    input: RevokeMemoryExecutionAuthorizationInput,
) -> Result<MemoryOperatorReceipt, String> {
    validate_token("operationId", &input.operation_id)?;
    validate_token("idempotencyKey", &input.idempotency_key)?;
    validate_hash(
        "authorizationRecordSha256",
        &input.authorization_record_sha256,
    )?;
    validate_hash("proposalRecordSha256", &input.proposal_record_sha256)?;
    validate_hash("revocationReasonSha256", &input.revocation_reason_sha256)?;
    let reviewer_action_sha256 = reviewer_action_sha256(
        "authorization_revocation",
        &input.operation_id,
        &input.idempotency_key,
        &input.proposal_record_sha256,
        None,
        Some(&input.authorization_record_sha256),
        &input.revocation_reason_sha256,
    )?;
    let root =
        crate::experimental_memory_recovery::normalize_platform_root_alias(root.to_path_buf());
    let _lease = crate::experimental_memory_recovery::acquire_host_wide_memory_lease(&root)?;
    let key = read_signing_key(&key_path(&root))?;
    recover_pending_settlement(&root, &key)?;
    let reviewer_session = verify_reviewer_session(
        &input.reviewer_session_token,
        &key,
        &reviewer_action_sha256,
        now_ms(),
    )?;
    let input_hash = stable_input_sha256(&CanonicalRevocationRequest {
        operation_id: &input.operation_id,
        authorization_record_sha256: &input.authorization_record_sha256,
        proposal_record_sha256: &input.proposal_record_sha256,
        reviewer_subject_sha256: &reviewer_session.reviewer_subject_sha256,
        revocation_reason_sha256: &input.revocation_reason_sha256,
        idempotency_key: &input.idempotency_key,
    })?;
    let mut connection = open_read_write(&control_path(&root))?;
    let records = verify_journal(&connection, &key, &external_anchor_path(&root))?;
    if let Some(existing) =
        find_identity_record(&records, &input.operation_id, &input.idempotency_key)?
    {
        return validate_duplicate(existing, &input_hash);
    }
    let issued = records
        .iter()
        .find(|record| {
            record.record_sha256 == input.authorization_record_sha256
                && record.operation_kind == "execution_authorization"
                && record.phase == "issued"
        })
        .ok_or("Memory execution authorization is missing")?;
    if issued.proposal_record_sha256 != input.proposal_record_sha256
        || issued.reviewer_subject_sha256 != reviewer_session.reviewer_subject_sha256
    {
        return Err("Memory authorization revocation binding mismatch".to_string());
    }
    if terminal_record(&records, &issued.record_sha256).is_some() {
        return Err("Memory execution authorization is already terminal".to_string());
    }
    let proposal = ProposalSnapshot::from(issued);
    let record = append_record(
        &mut connection,
        &key,
        &external_anchor_path(&root),
        NewRecord {
            operation_id: &input.operation_id,
            operation_kind: "authorization_revocation",
            phase: "revoked",
            idempotency_key: &input.idempotency_key,
            input_payload_sha256: &input_hash,
            proposal: &proposal,
            review_record_sha256: issued.review_record_sha256.as_deref(),
            decision: Some("approve"),
            reviewer_subject_sha256: &issued.reviewer_subject_sha256,
            review_reason_sha256: Some(&input.revocation_reason_sha256),
            authorization_id: issued.authorization_id.as_deref(),
            authorization_token_sha256: issued.authorization_token_sha256.as_deref(),
            authorization_record_sha256: Some(&issued.record_sha256),
            audience: issued.audience.as_deref(),
            rehearsal_authority_state_sha256: issued.rehearsal_authority_state_sha256.as_deref(),
            issued_at_ms: issued.issued_at_ms,
            expires_at_ms: issued.expires_at_ms,
            promotion_schema_ddl_sha256: &issued.promotion_schema_ddl_sha256,
            recovery_schema_ddl_sha256: &issued.recovery_schema_ddl_sha256,
            authorization_consumed: false,
            execution_dispatched: false,
            rollback_performed: false,
        },
    )?;
    Ok(receipt(&record, None, false))
}

#[tauri::command]
pub(crate) fn revoke_experimental_memory_execution_authorization(
    input: RevokeMemoryExecutionAuthorizationInput,
) -> Result<MemoryOperatorReceipt, String> {
    revoke_authorization_at(&isolated_root()?, input)
}

pub(crate) fn consume_authorization_no_effect_at(
    root: &Path,
    input: ConsumeMemoryExecutionAuthorizationInput,
) -> Result<MemoryOperatorReceipt, String> {
    consume_authorization_no_effect_at_time(root, input, now_ms())
}

fn consume_authorization_no_effect_at_time(
    root: &Path,
    input: ConsumeMemoryExecutionAuthorizationInput,
    current_time_ms: i64,
) -> Result<MemoryOperatorReceipt, String> {
    consume_authorization_at_time(
        root,
        input,
        current_time_ms,
        NO_EFFECT_AUDIENCE,
        false,
        SettlementStop::Complete,
    )
}

pub(crate) fn execute_authorization_rehearsal_at(
    root: &Path,
    input: ConsumeMemoryExecutionAuthorizationInput,
) -> Result<MemoryOperatorReceipt, String> {
    consume_authorization_at_time(
        root,
        input,
        now_ms(),
        REHEARSAL_AUDIENCE,
        true,
        SettlementStop::Complete,
    )
}

fn consume_authorization_at_time(
    root: &Path,
    input: ConsumeMemoryExecutionAuthorizationInput,
    current_time_ms: i64,
    expected_audience: &str,
    rehearsal: bool,
    settlement_stop: SettlementStop,
) -> Result<MemoryOperatorReceipt, String> {
    if !matches!(expected_audience, NO_EFFECT_AUDIENCE | REHEARSAL_AUDIENCE) {
        return Err("Unsupported Memory authorization consumption audience".to_string());
    }
    validate_token("operationId", &input.operation_id)?;
    validate_token("idempotencyKey", &input.idempotency_key)?;
    validate_hash(
        "authorizationRecordSha256",
        &input.authorization_record_sha256,
    )?;
    validate_hash("proposalRecordSha256", &input.proposal_record_sha256)?;
    validate_hash("expectedMemorySha256", &input.expected_memory_sha256)?;
    if input.authorization_token.len() != 69
        || !input.authorization_token.starts_with("bbm1_")
        || !input.authorization_token[5..]
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("Memory execution authorization token has an invalid format".to_string());
    }
    let root =
        crate::experimental_memory_recovery::normalize_platform_root_alias(root.to_path_buf());
    let _lease = crate::experimental_memory_recovery::acquire_host_wide_memory_lease(&root)?;
    let key = read_signing_key(&key_path(&root))?;
    recover_pending_settlement(&root, &key)?;
    let mut connection = open_read_write(&control_path(&root))?;
    let records = verify_journal(&connection, &key, &external_anchor_path(&root))?;
    let issued = records
        .iter()
        .find(|record| {
            record.record_sha256 == input.authorization_record_sha256
                && record.operation_kind == "execution_authorization"
                && record.phase == "issued"
        })
        .ok_or("Memory execution authorization is missing")?;
    if issued.proposal_record_sha256 != input.proposal_record_sha256
        || issued.memory_database_sha256 != input.expected_memory_sha256
        || issued.audience.as_deref() != Some(expected_audience)
    {
        return Err("Memory execution authorization binding mismatch".to_string());
    }
    let phase = if rehearsal {
        match issued.proposal_kind.as_str() {
            "authority_switch_proposal" => "consumed_rehearsal_applied",
            "manual_restore_proposal" => "consumed_rehearsal_restored",
            _ => return Err("Unsupported Memory rehearsal proposal kind".to_string()),
        }
    } else {
        "consumed_no_effect"
    };
    let input_hash = stable_input_sha256(&CanonicalConsumptionRequest {
        operation_id: &input.operation_id,
        authorization_record_sha256: &input.authorization_record_sha256,
        proposal_record_sha256: &input.proposal_record_sha256,
        expected_memory_sha256: &input.expected_memory_sha256,
        authorization_token: &input.authorization_token,
        idempotency_key: &input.idempotency_key,
        audience: expected_audience,
        phase,
    })?;
    if let Some(existing) =
        find_identity_record(&records, &input.operation_id, &input.idempotency_key)?
    {
        return validate_duplicate(existing, &input_hash);
    }
    if terminal_record(&records, &issued.record_sha256).is_some() {
        return Err("Memory execution authorization was revoked or consumed".to_string());
    }
    let (issued_at_ms, expires_at_ms) = authorization_lifetime(issued)?;
    if current_time_ms < issued_at_ms {
        return Err("Memory execution authorization rejected a system-clock rollback".to_string());
    }
    if current_time_ms >= expires_at_ms {
        return Err("Memory execution authorization expired".to_string());
    }
    let supplied_token_sha256 = sha256_hex(input.authorization_token.as_bytes());
    if !constant_time_eq(
        issued
            .authorization_token_sha256
            .as_deref()
            .ok_or("Memory execution authorization token binding is missing")?,
        &supplied_token_sha256,
    ) {
        return Err("Memory execution authorization token mismatch".to_string());
    }

    // Every fallible dependency check happens before the terminal journal row.
    // A failure therefore leaves the capability unconsumed and mechanically
    // demonstrates that pre-consumption validation failures preserve the
    // capability without touching data-plane state. The signed pending
    // settlement created by append_record covers the independent post-commit
    // control-journal crash window without changing any data-plane authority.
    let (proposal, promotion_ddl, recovery_ddl) =
        dependency_attestation(&root, &input.proposal_record_sha256)?;
    if !binding_matches(issued, &proposal, &promotion_ddl, &recovery_ddl) {
        return Err("Memory execution authorization dependencies drifted".to_string());
    }
    let record = append_record_with_settlement_stop(
        &mut connection,
        &key,
        &external_anchor_path(&root),
        NewRecord {
            operation_id: &input.operation_id,
            operation_kind: "authorization_consumption",
            phase,
            idempotency_key: &input.idempotency_key,
            input_payload_sha256: &input_hash,
            proposal: &proposal,
            review_record_sha256: issued.review_record_sha256.as_deref(),
            decision: Some("approve"),
            reviewer_subject_sha256: &issued.reviewer_subject_sha256,
            review_reason_sha256: None,
            authorization_id: issued.authorization_id.as_deref(),
            authorization_token_sha256: issued.authorization_token_sha256.as_deref(),
            authorization_record_sha256: Some(&issued.record_sha256),
            audience: issued.audience.as_deref(),
            rehearsal_authority_state_sha256: issued.rehearsal_authority_state_sha256.as_deref(),
            issued_at_ms: issued.issued_at_ms,
            expires_at_ms: issued.expires_at_ms,
            promotion_schema_ddl_sha256: &promotion_ddl,
            recovery_schema_ddl_sha256: &recovery_ddl,
            authorization_consumed: true,
            execution_dispatched: rehearsal,
            rollback_performed: phase == "consumed_rehearsal_restored",
        },
        settlement_stop,
    )?;
    Ok(receipt(&record, None, false))
}

#[tauri::command]
pub(crate) fn consume_experimental_memory_execution_authorization_no_effect(
    input: ConsumeMemoryExecutionAuthorizationInput,
) -> Result<MemoryOperatorReceipt, String> {
    consume_authorization_no_effect_at(&isolated_root()?, input)
}

#[tauri::command]
pub(crate) fn execute_experimental_memory_authority_rehearsal(
    input: ConsumeMemoryExecutionAuthorizationInput,
) -> Result<MemoryOperatorReceipt, String> {
    execute_authorization_rehearsal_at(&isolated_root()?, input)
}

fn inspect_journal_at(root: &Path) -> Result<MemoryOperatorJournalInspection, String> {
    let root =
        crate::experimental_memory_recovery::normalize_platform_root_alias(root.to_path_buf());
    let _lease = crate::experimental_memory_recovery::acquire_host_wide_memory_lease(&root)?;
    let key = read_signing_key(&key_path(&root))?;
    recover_pending_settlement(&root, &key)?;
    let connection = open_read_only(&control_path(&root), "Memory operator control database")?;
    let attestation = crate::experimental_sqlite_attestation::attest_exact_schema(
        &connection,
        SCHEMA_SQL,
        "Memory operator",
    )?;
    let records = verify_journal(&connection, &key, &external_anchor_path(&root))?;
    let issued = records
        .iter()
        .filter(|record| record.operation_kind == "execution_authorization")
        .collect::<Vec<_>>();
    Ok(MemoryOperatorJournalInspection {
        schema_version: SCHEMA_VERSION,
        exact_schema_ddl_sha256: attestation.actual_manifest_sha256,
        journal_record_count: records.len() as u64,
        approved_review_count: records
            .iter()
            .filter(|record| record.phase == "approved")
            .count() as u64,
        rejected_review_count: records
            .iter()
            .filter(|record| record.phase == "rejected")
            .count() as u64,
        issued_authorization_count: issued.len() as u64,
        active_authorization_count: issued
            .iter()
            .filter(|record| terminal_record(&records, &record.record_sha256).is_none())
            .count() as u64,
        consumed_authorization_count: records
            .iter()
            .filter(|record| record.operation_kind == "authorization_consumption")
            .count() as u64,
        revoked_authorization_count: records
            .iter()
            .filter(|record| record.phase == "revoked")
            .count() as u64,
        last_record_sha256: records
            .last()
            .map(|record| record.record_sha256.clone())
            .unwrap_or_else(|| ZERO_HASH.to_string()),
        hmac_verified: true,
        chain_verified: true,
        exact_schema_ddl_verified: true,
        single_use_enforced: true,
        preconsumption_validation_failure_preserves_authorization: true,
        post_commit_recovery_supported: true,
        execution_adapter_available: true,
        isolated_rehearsal_only: true,
        execution_dispatched: records
            .iter()
            .any(|record| record.execution_dispatched == 1),
        rollback_performed: records.iter().any(|record| record.rollback_performed == 1),
        production_memory_mutated: false,
        external_effects: 0,
        production_integration: false,
    })
}

#[tauri::command]
pub(crate) fn inspect_experimental_memory_operator_journal(
) -> Result<MemoryOperatorJournalInspection, String> {
    inspect_journal_at(&isolated_root()?)
}

pub(crate) fn inspect_rehearsal_authority_at(
    root: &Path,
) -> Result<MemoryRehearsalAuthorityState, String> {
    let root =
        crate::experimental_memory_recovery::normalize_platform_root_alias(root.to_path_buf());
    let _lease = crate::experimental_memory_recovery::acquire_host_wide_memory_lease(&root)?;
    let key = read_signing_key(&key_path(&root))?;
    recover_pending_settlement(&root, &key)?;
    let connection = open_read_only(&control_path(&root), "Memory operator control database")?;
    let records = verify_journal(&connection, &key, &external_anchor_path(&root))?;
    let internal = read_internal_anchor(&connection, &key)?;
    verify_rehearsal_state(&connection, &records, internal.created_at_ms)
}

#[tauri::command]
pub(crate) fn inspect_experimental_memory_rehearsal_authority(
) -> Result<MemoryRehearsalAuthorityState, String> {
    inspect_rehearsal_authority_at(&isolated_root()?)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture {
        _temp: tempfile::TempDir,
        root: PathBuf,
        proposal_sha256: String,
        dual_read_record_sha256: String,
        memory_sha256: String,
        memory_before: Vec<u8>,
        recovery_record_sha256: String,
        recovery_snapshot_relative_path: String,
        recovery_snapshot_sha256: String,
    }

    fn fixture() -> Fixture {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().to_path_buf();
        let memory_path = crate::experimental_foundation::memory_path(&root);
        crate::experimental_foundation::create_memory_store(&memory_path).unwrap();
        let source = root.join("legacy-memory.md");
        fs::write(
            &source,
            "# Preferences\n- Use Chinese by default\n\n# Project\nThe current task remains active.",
        )
        .unwrap();
        let source_sha256 = sha256_hex(&fs::read(&source).unwrap());
        crate::experimental_foundation::execute_memory_import_at(
            &root,
            crate::experimental_foundation::MemoryImportRequest {
                source_path: source.display().to_string(),
                user_id: "operator-user".to_string(),
                workspace_id: Some("operator-workspace".to_string()),
                expected_source_sha256: Some(source_sha256.clone()),
            },
        )
        .unwrap();
        crate::experimental_memory_recovery::initialize_at(&root).unwrap();
        crate::experimental_memory_promotion::initialize_at(&root).unwrap();
        initialize_at(&root).unwrap();
        let memory =
            crate::experimental_memory_recovery::capture_memory_file(&memory_path, None).unwrap();
        let prepared = crate::experimental_memory_recovery::prepare_at(
            &root,
            crate::experimental_memory_recovery::PrepareMemoryRecoveryDrillInput {
                operation_id: "operator-recovery".to_string(),
                expected_memory_sha256: memory.sha256.clone(),
                idempotency_key: "operator-recovery-prepare".to_string(),
            },
        )
        .unwrap();
        let recovery = crate::experimental_memory_recovery::reconcile_at(
            &root,
            crate::experimental_memory_recovery::ReconcileMemoryRecoveryDrillInput {
                operation_id: "operator-recovery".to_string(),
                expected_prepared_record_sha256: prepared.record_sha256,
                idempotency_key: "operator-recovery-reconcile".to_string(),
            },
        )
        .unwrap();
        let parity = crate::experimental_memory_promotion::assess_dual_read_at(
            &root,
            crate::experimental_memory_promotion::AssessMemoryDualReadInput {
                operation_id: "operator-parity".to_string(),
                source_path: source.display().to_string(),
                user_id: "operator-user".to_string(),
                workspace_id: Some("operator-workspace".to_string()),
                expected_source_sha256: source_sha256,
                expected_memory_sha256: memory.sha256.clone(),
                idempotency_key: "operator-parity-key".to_string(),
            },
        )
        .unwrap();
        assert_eq!(parity.phase, "parity_confirmed");
        let proposal = crate::experimental_memory_promotion::prepare_authority_switch_at(
            &root,
            crate::experimental_memory_promotion::PrepareMemoryAuthoritySwitchInput {
                operation_id: "operator-proposal".to_string(),
                dual_read_record_sha256: parity.record_sha256.clone(),
                recovery_record_sha256: recovery.record_sha256.clone(),
                expected_memory_sha256: memory.sha256.clone(),
                idempotency_key: "operator-proposal-key".to_string(),
            },
        )
        .unwrap();
        Fixture {
            _temp: temp,
            root,
            proposal_sha256: proposal.record_sha256,
            dual_read_record_sha256: parity.record_sha256,
            memory_sha256: memory.sha256,
            memory_before: fs::read(memory_path).unwrap(),
            recovery_record_sha256: recovery.record_sha256,
            recovery_snapshot_relative_path: recovery.snapshot_relative_path,
            recovery_snapshot_sha256: recovery.snapshot_sha256,
        }
    }

    fn authenticated_review_input(
        fixture: &Fixture,
        operation_id: &str,
        decision: &str,
        reason_sha256: &str,
        idempotency_key: &str,
    ) -> ReviewMemoryProposalInput {
        authenticated_review_input_for_proposal(
            fixture,
            &fixture.proposal_sha256,
            operation_id,
            decision,
            reason_sha256,
            idempotency_key,
        )
    }

    fn authenticated_review_input_for_proposal(
        fixture: &Fixture,
        proposal_record_sha256: &str,
        operation_id: &str,
        decision: &str,
        reason_sha256: &str,
        idempotency_key: &str,
    ) -> ReviewMemoryProposalInput {
        let key = read_signing_key(&key_path(&fixture.root)).unwrap();
        let session_input = CreateMemoryReviewerSessionInput {
            action_kind: "proposal_review".to_string(),
            operation_id: operation_id.to_string(),
            idempotency_key: idempotency_key.to_string(),
            proposal_record_sha256: proposal_record_sha256.to_string(),
            decision: Some(decision.to_string()),
            authorization_record_sha256: None,
            reason_sha256: reason_sha256.to_string(),
        };
        let session =
            issue_reviewer_session(&key, &session_input, LocalAuthenticationWitness, now_ms())
                .unwrap();
        ReviewMemoryProposalInput {
            operation_id: operation_id.to_string(),
            proposal_record_sha256: proposal_record_sha256.to_string(),
            decision: decision.to_string(),
            reviewer_session_token: session.reviewer_session_token,
            review_reason_sha256: reason_sha256.to_string(),
            idempotency_key: idempotency_key.to_string(),
        }
    }

    fn authenticated_revocation_input(
        fixture: &Fixture,
        authorization_record_sha256: &str,
        operation_id: &str,
        reason_sha256: &str,
        idempotency_key: &str,
    ) -> RevokeMemoryExecutionAuthorizationInput {
        let key = read_signing_key(&key_path(&fixture.root)).unwrap();
        let session_input = CreateMemoryReviewerSessionInput {
            action_kind: "authorization_revocation".to_string(),
            operation_id: operation_id.to_string(),
            idempotency_key: idempotency_key.to_string(),
            proposal_record_sha256: fixture.proposal_sha256.clone(),
            decision: None,
            authorization_record_sha256: Some(authorization_record_sha256.to_string()),
            reason_sha256: reason_sha256.to_string(),
        };
        let session =
            issue_reviewer_session(&key, &session_input, LocalAuthenticationWitness, now_ms())
                .unwrap();
        RevokeMemoryExecutionAuthorizationInput {
            operation_id: operation_id.to_string(),
            authorization_record_sha256: authorization_record_sha256.to_string(),
            proposal_record_sha256: fixture.proposal_sha256.clone(),
            reviewer_session_token: session.reviewer_session_token,
            revocation_reason_sha256: reason_sha256.to_string(),
            idempotency_key: idempotency_key.to_string(),
        }
    }

    fn approve(fixture: &Fixture, suffix: &str) -> MemoryOperatorReceipt {
        let input = authenticated_review_input(
            fixture,
            &format!("review-{suffix}"),
            "approve",
            &"b".repeat(64),
            &format!("review-key-{suffix}"),
        );
        review_proposal_at(&fixture.root, input).unwrap()
    }

    fn issue(
        fixture: &Fixture,
        review: &MemoryOperatorReceipt,
        suffix: &str,
    ) -> MemoryOperatorReceipt {
        issue_authorization_at(
            &fixture.root,
            IssueMemoryExecutionAuthorizationInput {
                operation_id: format!("issue-{suffix}"),
                review_record_sha256: review.record_sha256.clone(),
                proposal_record_sha256: fixture.proposal_sha256.clone(),
                expected_memory_sha256: fixture.memory_sha256.clone(),
                ttl_seconds: 300,
                idempotency_key: format!("issue-key-{suffix}"),
            },
        )
        .unwrap()
    }

    fn issue_rehearsal(
        fixture: &Fixture,
        review: &MemoryOperatorReceipt,
        suffix: &str,
    ) -> MemoryOperatorReceipt {
        issue_rehearsal_for_binding(
            fixture,
            review,
            &fixture.proposal_sha256,
            &fixture.memory_sha256,
            suffix,
        )
    }

    fn issue_rehearsal_for_binding(
        fixture: &Fixture,
        review: &MemoryOperatorReceipt,
        proposal_record_sha256: &str,
        expected_memory_sha256: &str,
        suffix: &str,
    ) -> MemoryOperatorReceipt {
        issue_rehearsal_authorization_at(
            &fixture.root,
            IssueMemoryExecutionAuthorizationInput {
                operation_id: format!("issue-rehearsal-{suffix}"),
                review_record_sha256: review.record_sha256.clone(),
                proposal_record_sha256: proposal_record_sha256.to_string(),
                expected_memory_sha256: expected_memory_sha256.to_string(),
                ttl_seconds: 300,
                idempotency_key: format!("issue-rehearsal-key-{suffix}"),
            },
        )
        .unwrap()
    }

    fn consume_input(
        fixture: &Fixture,
        authorization: &MemoryOperatorReceipt,
        token: String,
        suffix: &str,
    ) -> ConsumeMemoryExecutionAuthorizationInput {
        consume_input_for_binding(
            authorization,
            &fixture.proposal_sha256,
            &fixture.memory_sha256,
            token,
            suffix,
        )
    }

    fn consume_input_for_binding(
        authorization: &MemoryOperatorReceipt,
        proposal_record_sha256: &str,
        expected_memory_sha256: &str,
        token: String,
        suffix: &str,
    ) -> ConsumeMemoryExecutionAuthorizationInput {
        ConsumeMemoryExecutionAuthorizationInput {
            operation_id: format!("consume-{suffix}"),
            authorization_record_sha256: authorization.record_sha256.clone(),
            proposal_record_sha256: proposal_record_sha256.to_string(),
            expected_memory_sha256: expected_memory_sha256.to_string(),
            authorization_token: token,
            idempotency_key: format!("consume-key-{suffix}"),
        }
    }

    fn review_request(fixture: &Fixture, suffix: &str) -> ReviewMemoryProposalInput {
        authenticated_review_input(
            fixture,
            &format!("review-crash-{suffix}"),
            "approve",
            &"b".repeat(64),
            &format!("review-crash-key-{suffix}"),
        )
    }

    fn append_review_with_stop(
        fixture: &Fixture,
        request: &ReviewMemoryProposalInput,
        stop: SettlementStop,
    ) -> Result<StoredRecord, String> {
        let key = read_signing_key(&key_path(&fixture.root))?;
        let mut connection = open_read_write(&control_path(&fixture.root))?;
        let (proposal, promotion_ddl, recovery_ddl) =
            dependency_attestation(&fixture.root, &request.proposal_record_sha256)?;
        let action_sha256 = reviewer_action_sha256(
            "proposal_review",
            &request.operation_id,
            &request.idempotency_key,
            &request.proposal_record_sha256,
            Some(&request.decision),
            None,
            &request.review_reason_sha256,
        )?;
        let reviewer_session = verify_reviewer_session(
            &request.reviewer_session_token,
            &key,
            &action_sha256,
            now_ms(),
        )?;
        let input_hash = stable_input_sha256(&CanonicalReviewRequest {
            operation_id: &request.operation_id,
            proposal_record_sha256: &request.proposal_record_sha256,
            decision: &request.decision,
            reviewer_subject_sha256: &reviewer_session.reviewer_subject_sha256,
            review_reason_sha256: &request.review_reason_sha256,
            idempotency_key: &request.idempotency_key,
        })?;
        append_record_with_settlement_stop(
            &mut connection,
            &key,
            &external_anchor_path(&fixture.root),
            NewRecord {
                operation_id: &request.operation_id,
                operation_kind: "operator_review",
                phase: "approved",
                idempotency_key: &request.idempotency_key,
                input_payload_sha256: &input_hash,
                proposal: &proposal,
                review_record_sha256: None,
                decision: Some(&request.decision),
                reviewer_subject_sha256: &reviewer_session.reviewer_subject_sha256,
                review_reason_sha256: Some(&request.review_reason_sha256),
                authorization_id: None,
                authorization_token_sha256: None,
                authorization_record_sha256: None,
                audience: None,
                rehearsal_authority_state_sha256: None,
                issued_at_ms: None,
                expires_at_ms: None,
                promotion_schema_ddl_sha256: &promotion_ddl,
                recovery_schema_ddl_sha256: &recovery_ddl,
                authorization_consumed: false,
                execution_dispatched: false,
                rollback_performed: false,
            },
            stop,
        )
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
    fn reviewer_session_is_signed_short_lived_and_exactly_action_bound() {
        let fixture = fixture();
        let request = authenticated_review_input(
            &fixture,
            "review-session-bound",
            "approve",
            &"7".repeat(64),
            "review-session-bound-key",
        );
        let key = read_signing_key(&key_path(&fixture.root)).unwrap();
        let action_sha256 = reviewer_action_sha256(
            "proposal_review",
            &request.operation_id,
            &request.idempotency_key,
            &request.proposal_record_sha256,
            Some(&request.decision),
            None,
            &request.review_reason_sha256,
        )
        .unwrap();
        let claims = verify_reviewer_session(
            &request.reviewer_session_token,
            &key,
            &action_sha256,
            now_ms(),
        )
        .unwrap();

        let mut action_drift = request.clone();
        action_drift.review_reason_sha256 = "8".repeat(64);
        let action_error = review_proposal_at(&fixture.root, action_drift).unwrap_err();
        assert!(action_error.contains("action binding mismatch"));

        let mut tampered = request.clone();
        let replacement = if tampered.reviewer_session_token.ends_with('0') {
            '1'
        } else {
            '0'
        };
        tampered.reviewer_session_token.pop();
        tampered.reviewer_session_token.push(replacement);
        let tamper_error = review_proposal_at(&fixture.root, tampered).unwrap_err();
        assert!(tamper_error.contains("session HMAC mismatch"));

        let session_input = CreateMemoryReviewerSessionInput {
            action_kind: "proposal_review".to_string(),
            operation_id: request.operation_id.clone(),
            idempotency_key: request.idempotency_key.clone(),
            proposal_record_sha256: request.proposal_record_sha256.clone(),
            decision: Some(request.decision.clone()),
            authorization_record_sha256: None,
            reason_sha256: request.review_reason_sha256.clone(),
        };
        let expired_session = issue_reviewer_session(
            &key,
            &session_input,
            LocalAuthenticationWitness,
            now_ms() - REVIEWER_SESSION_TTL_MS - 1,
        )
        .unwrap();
        let mut expired = request.clone();
        expired.reviewer_session_token = expired_session.reviewer_session_token;
        let expiry_error = review_proposal_at(&fixture.root, expired).unwrap_err();
        assert!(expiry_error.contains("session expired"));

        assert_eq!(
            inspect_journal_at(&fixture.root)
                .unwrap()
                .journal_record_count,
            0
        );
        let review = review_proposal_at(&fixture.root, request).unwrap();
        assert_eq!(
            review.reviewer_subject_sha256,
            claims.reviewer_subject_sha256
        );
    }

    #[test]
    fn approval_issue_and_no_effect_consumption_are_durable_and_single_use() {
        let fixture = fixture();
        let review = approve(&fixture, "happy");
        assert_eq!(review.phase, "approved");
        let authorization = issue(&fixture, &review, "happy");
        let token = authorization.authorization_token.clone().unwrap();
        assert_eq!(authorization.phase, "issued");
        assert!(!authorization.authorization_consumed);
        let consumed = consume_authorization_no_effect_at(
            &fixture.root,
            consume_input(&fixture, &authorization, token.clone(), "happy"),
        )
        .unwrap();
        assert_eq!(consumed.phase, "consumed_no_effect");
        assert!(consumed.authorization_consumed);
        assert!(!consumed.execution_dispatched);
        assert!(!consumed.production_memory_mutated);
        assert_eq!(consumed.external_effects, 0);
        let replay = consume_authorization_no_effect_at(
            &fixture.root,
            consume_input(&fixture, &authorization, token, "replay"),
        )
        .unwrap_err();
        assert!(replay.contains("revoked or consumed"));
        let inspection = inspect_journal_at(&fixture.root).unwrap();
        assert_eq!(inspection.approved_review_count, 1);
        assert_eq!(inspection.issued_authorization_count, 1);
        assert_eq!(inspection.active_authorization_count, 0);
        assert_eq!(inspection.consumed_authorization_count, 1);
        assert!(inspection.single_use_enforced);
        assert!(inspection.preconsumption_validation_failure_preserves_authorization);
        assert!(inspection.post_commit_recovery_supported);
        assert_eq!(
            fs::read(crate::experimental_foundation::memory_path(&fixture.root)).unwrap(),
            fixture.memory_before
        );
    }

    #[test]
    fn purpose_bound_rehearsal_capability_atomically_switches_only_isolated_authority() {
        let fixture = fixture();
        let review = approve(&fixture, "rehearsal-switch");
        let authorization = issue_rehearsal(&fixture, &review, "switch");
        let token = authorization.authorization_token.clone().unwrap();
        let before = inspect_rehearsal_authority_at(&fixture.root).unwrap();
        assert_eq!(before.generation, 0);
        assert_eq!(before.authority_kind, "legacy_snapshot");
        assert_eq!(before.authority_binding_sha256, ZERO_HASH);

        let applied = execute_authorization_rehearsal_at(
            &fixture.root,
            consume_input(&fixture, &authorization, token.clone(), "rehearsal-switch"),
        )
        .unwrap();
        assert_eq!(applied.phase, "consumed_rehearsal_applied");
        assert!(applied.authorization_consumed);
        assert!(applied.execution_dispatched);
        assert!(!applied.rollback_performed);
        assert!(!applied.production_memory_mutated);
        assert_eq!(applied.external_effects, 0);

        let state = inspect_rehearsal_authority_at(&fixture.root).unwrap();
        assert_eq!(state.generation, 1);
        assert_eq!(state.authority_kind, "sqlite_memory_v3");
        assert_eq!(state.authority_binding_sha256, fixture.memory_sha256);
        assert_eq!(
            state.previous_authority_kind.as_deref(),
            Some("legacy_snapshot")
        );
        assert_eq!(
            state.previous_authority_binding_sha256.as_deref(),
            Some(ZERO_HASH)
        );
        assert_eq!(
            state.last_authorization_record_sha256.as_deref(),
            Some(authorization.record_sha256.as_str())
        );
        assert_eq!(
            state.last_execution_record_sha256.as_deref(),
            Some(applied.record_sha256.as_str())
        );
        assert!(!state.production_integration);
        assert_eq!(
            fs::read(crate::experimental_foundation::memory_path(&fixture.root)).unwrap(),
            fixture.memory_before
        );

        let replay = execute_authorization_rehearsal_at(
            &fixture.root,
            consume_input(&fixture, &authorization, token, "rehearsal-replay"),
        )
        .unwrap_err();
        assert!(replay.contains("revoked or consumed"));
    }

    #[test]
    fn rehearsal_capability_is_bound_to_one_authority_generation() {
        let fixture = fixture();
        let second_proposal = crate::experimental_memory_promotion::prepare_authority_switch_at(
            &fixture.root,
            crate::experimental_memory_promotion::PrepareMemoryAuthoritySwitchInput {
                operation_id: "operator-proposal-generation-bound".to_string(),
                dual_read_record_sha256: fixture.dual_read_record_sha256.clone(),
                recovery_record_sha256: fixture.recovery_record_sha256.clone(),
                expected_memory_sha256: fixture.memory_sha256.clone(),
                idempotency_key: "operator-proposal-generation-bound-key".to_string(),
            },
        )
        .unwrap();
        let first_review = approve(&fixture, "generation-bound-first");
        let second_review = review_proposal_at(
            &fixture.root,
            authenticated_review_input_for_proposal(
                &fixture,
                &second_proposal.record_sha256,
                "review-generation-bound-second",
                "approve",
                &"c".repeat(64),
                "review-generation-bound-second-key",
            ),
        )
        .unwrap();
        let first = issue_rehearsal(&fixture, &first_review, "generation-bound-first");
        let second = issue_rehearsal_for_binding(
            &fixture,
            &second_review,
            &second_proposal.record_sha256,
            &fixture.memory_sha256,
            "generation-bound-second",
        );
        assert_eq!(
            first.rehearsal_authority_state_sha256,
            second.rehearsal_authority_state_sha256
        );
        assert!(first.rehearsal_authority_state_sha256.is_some());

        execute_authorization_rehearsal_at(
            &fixture.root,
            consume_input(
                &fixture,
                &first,
                first.authorization_token.clone().unwrap(),
                "generation-bound-first",
            ),
        )
        .unwrap();

        let stale_error = execute_authorization_rehearsal_at(
            &fixture.root,
            consume_input_for_binding(
                &second,
                &second_proposal.record_sha256,
                &fixture.memory_sha256,
                second.authorization_token.clone().unwrap(),
                "generation-bound-second",
            ),
        )
        .unwrap_err();
        assert!(stale_error.contains("authority state drifted"));
        let inspection = inspect_journal_at(&fixture.root).unwrap();
        assert_eq!(inspection.active_authorization_count, 1);
        assert_eq!(inspection.consumed_authorization_count, 1);
        let state = inspect_rehearsal_authority_at(&fixture.root).unwrap();
        assert_eq!(state.generation, 1);
        assert_eq!(state.authority_kind, "sqlite_memory_v3");
    }

    #[test]
    fn restore_rehearsal_authorization_requires_an_active_switch() {
        let fixture = fixture();
        let database = crate::experimental_foundation::memory_path(&fixture.root);
        fs::write(
            &database,
            b"isolated restore proposal before authority switch",
        )
        .unwrap();
        let incident =
            crate::experimental_memory_recovery::capture_memory_file(&database, None).unwrap();
        let forensic = crate::experimental_memory_promotion::capture_raw_forensic_at(
            &fixture.root,
            crate::experimental_memory_promotion::CaptureRawForensicEvidenceInput {
                operation_id: "operator-restore-before-switch-forensic".to_string(),
                expected_memory_sha256: incident.sha256.clone(),
                incident_reason_sha256: "d".repeat(64),
                idempotency_key: "operator-restore-before-switch-forensic-key".to_string(),
            },
        )
        .unwrap();
        let proposal = crate::experimental_memory_promotion::prepare_manual_restore_at(
            &fixture.root,
            crate::experimental_memory_promotion::PrepareManualRestoreProposalInput {
                operation_id: "operator-restore-before-switch-proposal".to_string(),
                forensic_record_sha256: forensic.record_sha256,
                recovery_record_sha256: fixture.recovery_record_sha256.clone(),
                candidate_path: fixture
                    .root
                    .join(&fixture.recovery_snapshot_relative_path)
                    .display()
                    .to_string(),
                expected_candidate_sha256: fixture.recovery_snapshot_sha256.clone(),
                idempotency_key: "operator-restore-before-switch-proposal-key".to_string(),
            },
        )
        .unwrap();
        let review = review_proposal_at(
            &fixture.root,
            authenticated_review_input_for_proposal(
                &fixture,
                &proposal.record_sha256,
                "review-restore-before-switch",
                "approve",
                &"e".repeat(64),
                "review-restore-before-switch-key",
            ),
        )
        .unwrap();
        let error = issue_rehearsal_authorization_at(
            &fixture.root,
            IssueMemoryExecutionAuthorizationInput {
                operation_id: "issue-restore-before-switch".to_string(),
                review_record_sha256: review.record_sha256,
                proposal_record_sha256: proposal.record_sha256,
                expected_memory_sha256: incident.sha256,
                ttl_seconds: 300,
                idempotency_key: "issue-restore-before-switch-key".to_string(),
            },
        )
        .unwrap_err();
        assert!(error.contains("no switch to restore"));
        let inspection = inspect_journal_at(&fixture.root).unwrap();
        assert_eq!(inspection.active_authorization_count, 0);
        let state = inspect_rehearsal_authority_at(&fixture.root).unwrap();
        assert_eq!(state.generation, 0);
        assert_eq!(state.authority_kind, "legacy_snapshot");
    }

    #[test]
    fn rehearsal_stop_before_commit_preserves_authority_and_authorization() {
        let fixture = fixture();
        let review = approve(&fixture, "rehearsal-before-commit");
        let authorization = issue_rehearsal(&fixture, &review, "rehearsal-before-commit");
        let request = consume_input(
            &fixture,
            &authorization,
            authorization.authorization_token.clone().unwrap(),
            "rehearsal-before-commit",
        );

        let error = consume_authorization_at_time(
            &fixture.root,
            request.clone(),
            now_ms(),
            REHEARSAL_AUDIENCE,
            true,
            SettlementStop::AfterPending,
        )
        .unwrap_err();
        assert!(error.contains("after pending settlement"));

        let key = read_signing_key(&key_path(&fixture.root)).unwrap();
        assert_eq!(
            recover_pending_settlement(&fixture.root, &key).unwrap(),
            SettlementRecovery::AbortedBeforeCommit
        );
        let before_retry = inspect_rehearsal_authority_at(&fixture.root).unwrap();
        assert_eq!(before_retry.generation, 0);
        assert_eq!(before_retry.authority_kind, "legacy_snapshot");
        assert_eq!(before_retry.authority_binding_sha256, ZERO_HASH);
        assert_eq!(
            inspect_journal_at(&fixture.root)
                .unwrap()
                .active_authorization_count,
            1
        );

        let applied = consume_authorization_at_time(
            &fixture.root,
            request,
            now_ms(),
            REHEARSAL_AUDIENCE,
            true,
            SettlementStop::Complete,
        )
        .unwrap();
        assert_eq!(applied.phase, "consumed_rehearsal_applied");
        assert!(!applied.duplicate);
        let after_retry = inspect_rehearsal_authority_at(&fixture.root).unwrap();
        assert_eq!(after_retry.generation, 1);
        assert_eq!(after_retry.authority_kind, "sqlite_memory_v3");
        assert_eq!(after_retry.authority_binding_sha256, fixture.memory_sha256);
    }

    #[test]
    fn manual_restore_proposal_reverses_the_isolated_authority_pointer_only() {
        let fixture = fixture();
        let switch_review = approve(&fixture, "restore-switch");
        let switch_authorization = issue_rehearsal(&fixture, &switch_review, "restore-switch");
        execute_authorization_rehearsal_at(
            &fixture.root,
            consume_input(
                &fixture,
                &switch_authorization,
                switch_authorization.authorization_token.clone().unwrap(),
                "restore-switch",
            ),
        )
        .unwrap();

        let database = crate::experimental_foundation::memory_path(&fixture.root);
        let incident_bytes = b"isolated corrupt rehearsal database; preserve for proof".to_vec();
        fs::write(&database, &incident_bytes).unwrap();
        let incident =
            crate::experimental_memory_recovery::capture_memory_file(&database, None).unwrap();
        let forensic = crate::experimental_memory_promotion::capture_raw_forensic_at(
            &fixture.root,
            crate::experimental_memory_promotion::CaptureRawForensicEvidenceInput {
                operation_id: "operator-restore-forensic".to_string(),
                expected_memory_sha256: incident.sha256.clone(),
                incident_reason_sha256: "9".repeat(64),
                idempotency_key: "operator-restore-forensic-key".to_string(),
            },
        )
        .unwrap();
        let candidate = fixture.root.join(&fixture.recovery_snapshot_relative_path);
        let proposal = crate::experimental_memory_promotion::prepare_manual_restore_at(
            &fixture.root,
            crate::experimental_memory_promotion::PrepareManualRestoreProposalInput {
                operation_id: "operator-restore-proposal".to_string(),
                forensic_record_sha256: forensic.record_sha256,
                recovery_record_sha256: fixture.recovery_record_sha256.clone(),
                candidate_path: candidate.display().to_string(),
                expected_candidate_sha256: fixture.recovery_snapshot_sha256.clone(),
                idempotency_key: "operator-restore-proposal-key".to_string(),
            },
        )
        .unwrap();
        let restore_review_input = authenticated_review_input_for_proposal(
            &fixture,
            &proposal.record_sha256,
            "review-restore-proposal",
            "approve",
            &"a".repeat(64),
            "review-restore-proposal-key",
        );
        let restore_review = review_proposal_at(&fixture.root, restore_review_input).unwrap();
        let restore_authorization = issue_rehearsal_for_binding(
            &fixture,
            &restore_review,
            &proposal.record_sha256,
            &incident.sha256,
            "restore-proposal",
        );
        let restore_request = consume_input_for_binding(
            &restore_authorization,
            &proposal.record_sha256,
            &incident.sha256,
            restore_authorization.authorization_token.clone().unwrap(),
            "restore-proposal",
        );
        let stopped = consume_authorization_at_time(
            &fixture.root,
            restore_request.clone(),
            now_ms(),
            REHEARSAL_AUDIENCE,
            true,
            SettlementStop::AfterCommit,
        )
        .unwrap_err();
        assert!(stopped.contains("after SQLite commit"));
        let key = read_signing_key(&key_path(&fixture.root)).unwrap();
        assert_eq!(
            recover_pending_settlement(&fixture.root, &key).unwrap(),
            SettlementRecovery::PublishedCommittedAnchor
        );
        let restored = consume_authorization_at_time(
            &fixture.root,
            restore_request,
            now_ms(),
            REHEARSAL_AUDIENCE,
            true,
            SettlementStop::Complete,
        )
        .unwrap();
        assert_eq!(restored.phase, "consumed_rehearsal_restored");
        assert!(restored.duplicate);
        assert!(restored.execution_dispatched);
        assert!(restored.rollback_performed);
        assert!(!restored.production_memory_mutated);
        assert_eq!(restored.external_effects, 0);
        let state = inspect_rehearsal_authority_at(&fixture.root).unwrap();
        assert_eq!(state.generation, 2);
        assert_eq!(state.authority_kind, "legacy_snapshot");
        assert_eq!(state.authority_binding_sha256, ZERO_HASH);
        assert!(state.previous_authority_kind.is_none());
        assert!(state.previous_authority_binding_sha256.is_none());
        assert_eq!(fs::read(database).unwrap(), incident_bytes);
    }

    #[test]
    fn no_effect_and_rehearsal_capabilities_cannot_cross_audiences() {
        let no_effect_fixture = fixture();
        let no_effect_review = approve(&no_effect_fixture, "no-effect-audience");
        let no_effect = issue(&no_effect_fixture, &no_effect_review, "no-effect-audience");
        let no_effect_error = execute_authorization_rehearsal_at(
            &no_effect_fixture.root,
            consume_input(
                &no_effect_fixture,
                &no_effect,
                no_effect.authorization_token.clone().unwrap(),
                "wrong-rehearsal-audience",
            ),
        )
        .unwrap_err();
        assert!(no_effect_error.contains("binding mismatch"));
        assert_eq!(
            inspect_journal_at(&no_effect_fixture.root)
                .unwrap()
                .active_authorization_count,
            1
        );

        let rehearsal_fixture = fixture();
        let rehearsal_review = approve(&rehearsal_fixture, "rehearsal-audience");
        let rehearsal =
            issue_rehearsal(&rehearsal_fixture, &rehearsal_review, "rehearsal-audience");
        let rehearsal_error = consume_authorization_no_effect_at(
            &rehearsal_fixture.root,
            consume_input(
                &rehearsal_fixture,
                &rehearsal,
                rehearsal.authorization_token.clone().unwrap(),
                "wrong-no-effect-audience",
            ),
        )
        .unwrap_err();
        assert!(rehearsal_error.contains("binding mismatch"));
        assert_eq!(
            inspect_journal_at(&rehearsal_fixture.root)
                .unwrap()
                .active_authorization_count,
            1
        );
    }

    #[test]
    fn committed_rehearsal_switch_and_old_anchor_recover_as_one_proven_state() {
        let fixture = fixture();
        let review = approve(&fixture, "rehearsal-crash");
        let authorization = issue_rehearsal(&fixture, &review, "rehearsal-crash");
        let request = consume_input(
            &fixture,
            &authorization,
            authorization.authorization_token.clone().unwrap(),
            "rehearsal-crash",
        );
        let error = consume_authorization_at_time(
            &fixture.root,
            request.clone(),
            now_ms(),
            REHEARSAL_AUDIENCE,
            true,
            SettlementStop::AfterCommit,
        )
        .unwrap_err();
        assert!(error.contains("after SQLite commit"));
        let key = read_signing_key(&key_path(&fixture.root)).unwrap();
        assert_eq!(
            recover_pending_settlement(&fixture.root, &key).unwrap(),
            SettlementRecovery::PublishedCommittedAnchor
        );
        let state = inspect_rehearsal_authority_at(&fixture.root).unwrap();
        assert_eq!(state.generation, 1);
        assert_eq!(state.authority_kind, "sqlite_memory_v3");
        assert_eq!(state.authority_binding_sha256, fixture.memory_sha256);
        let duplicate = consume_authorization_at_time(
            &fixture.root,
            request,
            now_ms(),
            REHEARSAL_AUDIENCE,
            true,
            SettlementStop::Complete,
        )
        .unwrap();
        assert!(duplicate.duplicate);
        assert!(duplicate.execution_dispatched);
    }

    #[test]
    fn rehearsal_authority_tampering_is_detected_by_signed_journal_replay() {
        let fixture = fixture();
        let review = approve(&fixture, "rehearsal-drift");
        let authorization = issue_rehearsal(&fixture, &review, "rehearsal-drift");
        execute_authorization_rehearsal_at(
            &fixture.root,
            consume_input(
                &fixture,
                &authorization,
                authorization.authorization_token.clone().unwrap(),
                "rehearsal-drift",
            ),
        )
        .unwrap();
        let connection = Connection::open(control_path(&fixture.root)).unwrap();
        connection
            .execute(
                "UPDATE memory_operator_rehearsal_state SET authority_binding_sha256 = ?1 WHERE id = 1",
                params!["f".repeat(64)],
            )
            .unwrap();
        drop(connection);
        let error = inspect_rehearsal_authority_at(&fixture.root).unwrap_err();
        assert!(error.contains("authority state drifted"));
    }

    #[test]
    fn rejected_review_cannot_issue_authorization() {
        let fixture = fixture();
        let request = authenticated_review_input(
            &fixture,
            "review-reject",
            "reject",
            &"d".repeat(64),
            "review-reject-key",
        );
        let review = review_proposal_at(&fixture.root, request).unwrap();
        let error = issue_authorization_at(
            &fixture.root,
            IssueMemoryExecutionAuthorizationInput {
                operation_id: "issue-rejected".to_string(),
                review_record_sha256: review.record_sha256,
                proposal_record_sha256: fixture.proposal_sha256,
                expected_memory_sha256: fixture.memory_sha256,
                ttl_seconds: 300,
                idempotency_key: "issue-rejected-key".to_string(),
            },
        )
        .unwrap_err();
        assert!(error.contains("Approved Memory operator review is missing"));
    }

    #[test]
    fn failed_token_check_rolls_back_and_same_authorization_can_then_succeed() {
        let fixture = fixture();
        let review = approve(&fixture, "rollback");
        let authorization = issue(&fixture, &review, "rollback");
        let token = authorization.authorization_token.clone().unwrap();
        let wrong = format!("bbm1_{}", "0".repeat(64));
        let error = consume_authorization_no_effect_at(
            &fixture.root,
            consume_input(&fixture, &authorization, wrong, "wrong"),
        )
        .unwrap_err();
        assert!(error.contains("token mismatch"));
        let before_success = inspect_journal_at(&fixture.root).unwrap();
        assert_eq!(before_success.journal_record_count, 2);
        assert_eq!(before_success.active_authorization_count, 1);
        let success = consume_authorization_no_effect_at(
            &fixture.root,
            consume_input(&fixture, &authorization, token, "right"),
        )
        .unwrap();
        assert!(success.authorization_consumed);
    }

    #[test]
    fn expiration_failure_does_not_consume_the_authorization() {
        let fixture = fixture();
        let review = approve(&fixture, "expiry");
        let authorization = issue(&fixture, &review, "expiry");
        let token = authorization.authorization_token.clone().unwrap();
        let error = consume_authorization_no_effect_at_time(
            &fixture.root,
            consume_input(&fixture, &authorization, token.clone(), "expired"),
            authorization.expires_at_ms.unwrap(),
        )
        .unwrap_err();
        assert!(error.contains("expired"));
        let still_active = inspect_journal_at(&fixture.root).unwrap();
        assert_eq!(still_active.journal_record_count, 2);
        assert_eq!(still_active.active_authorization_count, 1);
        let consumed = consume_authorization_no_effect_at(
            &fixture.root,
            consume_input(&fixture, &authorization, token, "before-expiry"),
        )
        .unwrap();
        assert!(consumed.authorization_consumed);
    }

    #[test]
    fn system_clock_rollback_does_not_consume_the_authorization() {
        let fixture = fixture();
        let review = approve(&fixture, "clock-rollback");
        let authorization = issue(&fixture, &review, "clock-rollback");
        let token = authorization.authorization_token.clone().unwrap();
        let error = consume_authorization_no_effect_at_time(
            &fixture.root,
            consume_input(
                &fixture,
                &authorization,
                token.clone(),
                "clock-rollback-rejected",
            ),
            authorization.issued_at_ms.unwrap() - 1,
        )
        .unwrap_err();
        assert!(error.contains("system-clock rollback"));
        let still_active = inspect_journal_at(&fixture.root).unwrap();
        assert_eq!(still_active.journal_record_count, 2);
        assert_eq!(still_active.active_authorization_count, 1);
        let consumed = consume_authorization_no_effect_at(
            &fixture.root,
            consume_input(&fixture, &authorization, token, "clock-rollback-recovered"),
        )
        .unwrap();
        assert!(consumed.authorization_consumed);
    }

    #[test]
    fn proposal_has_exactly_one_terminal_operator_review() {
        let fixture = fixture();
        approve(&fixture, "only");
        let request = authenticated_review_input(
            &fixture,
            "review-second",
            "reject",
            &"1".repeat(64),
            "review-second-key",
        );
        let error = review_proposal_at(&fixture.root, request).unwrap_err();
        assert!(error.contains("already has an operator review"));
    }

    #[test]
    fn revocation_is_terminal_and_does_not_require_a_live_execution_adapter() {
        let fixture = fixture();
        let review = approve(&fixture, "revoke");
        let authorization = issue(&fixture, &review, "revoke");
        let token = authorization.authorization_token.clone().unwrap();
        let request = authenticated_revocation_input(
            &fixture,
            &authorization.record_sha256,
            "revoke-one",
            &"e".repeat(64),
            "revoke-one-key",
        );
        let revoked = revoke_authorization_at(&fixture.root, request).unwrap();
        assert_eq!(revoked.phase, "revoked");
        let error = consume_authorization_no_effect_at(
            &fixture.root,
            consume_input(&fixture, &authorization, token, "after-revoke"),
        )
        .unwrap_err();
        assert!(error.contains("revoked or consumed"));
        let inspection = inspect_journal_at(&fixture.root).unwrap();
        assert_eq!(inspection.revoked_authorization_count, 1);
        assert_eq!(inspection.active_authorization_count, 0);
    }

    #[test]
    fn recovery_trigger_drift_fails_before_consumption_and_repair_preserves_capability() {
        let fixture = fixture();
        let review = approve(&fixture, "ddl");
        let authorization = issue(&fixture, &review, "ddl");
        let token = authorization.authorization_token.clone().unwrap();
        let recovery_db = fixture.root.join("memory-recovery-v1.sqlite");
        let connection = Connection::open(&recovery_db).unwrap();
        let original_trigger_sql: String = connection
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'memory_recovery_record_immutable'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        connection
            .execute_batch(
                "DROP TRIGGER memory_recovery_record_immutable;
                 CREATE TRIGGER memory_recovery_record_immutable
                 BEFORE UPDATE ON memory_recovery_record
                 BEGIN SELECT RAISE(ABORT, 'changed'); END;",
            )
            .unwrap();
        drop(connection);
        let error = consume_authorization_no_effect_at(
            &fixture.root,
            consume_input(&fixture, &authorization, token.clone(), "ddl-drift"),
        )
        .unwrap_err();
        assert!(error.contains("exact control-schema DDL mismatch"));
        let still_active = inspect_journal_at(&fixture.root).unwrap();
        assert_eq!(still_active.journal_record_count, 2);
        assert_eq!(still_active.active_authorization_count, 1);
        let connection = Connection::open(&recovery_db).unwrap();
        connection
            .execute_batch("DROP TRIGGER memory_recovery_record_immutable;")
            .unwrap();
        connection.execute_batch(&original_trigger_sql).unwrap();
        drop(connection);
        let consumed = consume_authorization_no_effect_at(
            &fixture.root,
            consume_input(&fixture, &authorization, token, "ddl-repaired"),
        )
        .unwrap();
        assert!(consumed.authorization_consumed);
    }

    #[test]
    fn operator_trigger_drift_blocks_review_and_repair_preserves_the_request() {
        let fixture = fixture();
        let operator_db = control_path(&fixture.root);
        let connection = Connection::open(&operator_db).unwrap();
        let original_trigger_sql: String = connection
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'memory_operator_record_immutable'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        connection
            .execute_batch(
                "DROP TRIGGER memory_operator_record_immutable;
                 CREATE TRIGGER memory_operator_record_immutable
                 BEFORE UPDATE ON memory_operator_record
                 BEGIN SELECT RAISE(ABORT, 'changed'); END;",
            )
            .unwrap();
        drop(connection);

        let request = authenticated_review_input(
            &fixture,
            "review-operator-ddl",
            "approve",
            &"b".repeat(64),
            "review-operator-ddl-key",
        );
        let error = review_proposal_at(&fixture.root, request.clone()).unwrap_err();
        assert!(error.contains("exact control-schema DDL mismatch"));

        let connection = Connection::open(&operator_db).unwrap();
        connection
            .execute_batch("DROP TRIGGER memory_operator_record_immutable;")
            .unwrap();
        connection.execute_batch(&original_trigger_sql).unwrap();
        drop(connection);
        let review = review_proposal_at(&fixture.root, request).unwrap();
        assert_eq!(review.phase, "approved");
        assert_eq!(
            inspect_journal_at(&fixture.root)
                .unwrap()
                .journal_record_count,
            1
        );
    }

    #[test]
    fn issuance_duplicate_never_replays_plaintext_capability() {
        let fixture = fixture();
        let review = approve(&fixture, "duplicate");
        let input = IssueMemoryExecutionAuthorizationInput {
            operation_id: "issue-duplicate".to_string(),
            review_record_sha256: review.record_sha256,
            proposal_record_sha256: fixture.proposal_sha256,
            expected_memory_sha256: fixture.memory_sha256,
            ttl_seconds: 300,
            idempotency_key: "issue-duplicate-key".to_string(),
        };
        let first = issue_authorization_at(&fixture.root, input.clone()).unwrap();
        assert!(first.authorization_token.is_some());
        let duplicate = issue_authorization_at(&fixture.root, input).unwrap();
        assert!(duplicate.duplicate);
        assert!(duplicate.authorization_token.is_none());
        assert_eq!(duplicate.record_sha256, first.record_sha256);
    }

    #[test]
    fn pending_intent_before_commit_is_aborted_without_appending_a_record() {
        let fixture = fixture();
        let request = review_request(&fixture, "before-commit");
        let error =
            append_review_with_stop(&fixture, &request, SettlementStop::AfterPending).unwrap_err();
        assert!(error.contains("after pending settlement"));
        let key = read_signing_key(&key_path(&fixture.root)).unwrap();
        assert_eq!(
            recover_pending_settlement(&fixture.root, &key).unwrap(),
            SettlementRecovery::AbortedBeforeCommit
        );
        assert!(!pending_settlement_path(&fixture.root).exists());
        assert_eq!(
            inspect_journal_at(&fixture.root)
                .unwrap()
                .journal_record_count,
            0
        );
        let review = review_proposal_at(&fixture.root, request).unwrap();
        assert_eq!(review.phase, "approved");
        assert!(!review.duplicate);
    }

    #[test]
    fn committed_record_with_old_anchor_is_published_and_retry_is_idempotent() {
        let fixture = fixture();
        let request = review_request(&fixture, "after-commit");
        let error =
            append_review_with_stop(&fixture, &request, SettlementStop::AfterCommit).unwrap_err();
        assert!(error.contains("after SQLite commit"));
        let key = read_signing_key(&key_path(&fixture.root)).unwrap();
        assert_eq!(
            recover_pending_settlement(&fixture.root, &key).unwrap(),
            SettlementRecovery::PublishedCommittedAnchor
        );
        let inspection = inspect_journal_at(&fixture.root).unwrap();
        assert_eq!(inspection.journal_record_count, 1);
        assert!(inspection.post_commit_recovery_supported);
        let duplicate = review_proposal_at(&fixture.root, request).unwrap();
        assert!(duplicate.duplicate);
    }

    #[test]
    fn tampered_pending_intent_fails_closed_without_rewriting_the_anchor() {
        let fixture = fixture();
        let request = review_request(&fixture, "tampered-pending");
        let key = read_signing_key(&key_path(&fixture.root)).unwrap();
        let anchor_path = external_anchor_path(&fixture.root);
        let anchor_before = read_external_anchor(&anchor_path, &key).unwrap();
        let error =
            append_review_with_stop(&fixture, &request, SettlementStop::AfterCommit).unwrap_err();
        assert!(error.contains("after SQLite commit"));

        let pending_path = pending_settlement_path(&fixture.root);
        let mut pending = read_pending_settlement(&pending_path, &key)
            .unwrap()
            .unwrap();
        pending.settlement_hmac_sha256 = "0".repeat(64);
        set_file_mode(&pending_path, 0o600).unwrap();
        fs::write(&pending_path, serde_json::to_vec(&pending).unwrap()).unwrap();
        set_file_mode(&pending_path, 0o400).unwrap();
        sync_file_and_parent(&pending_path).unwrap();

        let recovery_error = recover_pending_settlement(&fixture.root, &key).unwrap_err();
        assert!(recovery_error.contains("pending settlement HMAC mismatch"));
        assert!(pending_path.exists());
        assert_eq!(
            read_external_anchor(&anchor_path, &key).unwrap(),
            anchor_before
        );
        let connection = open_read_only(
            &control_path(&fixture.root),
            "Memory operator control database",
        )
        .unwrap();
        let record_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM memory_operator_record", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(record_count, 1);
    }

    #[test]
    fn published_anchor_with_pending_intent_only_needs_intent_cleanup() {
        let fixture = fixture();
        let request = review_request(&fixture, "after-anchor");
        let error =
            append_review_with_stop(&fixture, &request, SettlementStop::AfterAnchor).unwrap_err();
        assert!(error.contains("after anchor publish"));
        let key = read_signing_key(&key_path(&fixture.root)).unwrap();
        assert_eq!(
            recover_pending_settlement(&fixture.root, &key).unwrap(),
            SettlementRecovery::RemovedSettledIntent
        );
        assert_eq!(
            inspect_journal_at(&fixture.root)
                .unwrap()
                .journal_record_count,
            1
        );
        assert!(!pending_settlement_path(&fixture.root).exists());
    }

    #[test]
    fn bootstrap_database_without_anchor_is_recovered_from_signed_intent() {
        let temp = tempfile::tempdir().unwrap();
        let root = crate::experimental_memory_recovery::normalize_platform_root_alias(
            temp.path().join("experimental"),
        );
        ensure_private_directory(&root, "Experimental Memory root").unwrap();
        let key = create_signing_key(&key_path(&root)).unwrap();
        let error = create_control_store_with_settlement_stop(
            &control_path(&root),
            &key,
            SettlementStop::AfterCommit,
        )
        .unwrap_err();
        assert!(error.contains("after database publish"), "{error}");
        assert!(control_path(&root).exists());
        assert!(!external_anchor_path(&root).exists());
        assert_eq!(
            recover_pending_settlement(&root, &key).unwrap(),
            SettlementRecovery::PublishedCommittedAnchor
        );
        let inspection = inspect_control_store(&control_path(&root), &key).unwrap();
        assert!(inspection.ready);
        assert!(!pending_settlement_path(&root).exists());
    }
}
