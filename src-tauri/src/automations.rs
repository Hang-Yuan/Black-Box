//! Codex-compatible scheduled task runtime for Blackbox.
//!
//! Task definitions are portable TOML files. SQLite is a rebuildable index for
//! next-run calculation, run state, and the Scheduled inbox. The scheduler is
//! hosted by the desktop app, matching Codex's documented app-running model.

pub mod recovery;

use chrono::{Datelike, Duration as ChronoDuration, Local, TimeZone, Timelike, Utc, Weekday};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::process::Command as StdCommand;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::sync::{mpsc, oneshot};

const ACTIVE: &str = "ACTIVE";
const PAUSED: &str = "PAUSED";
const SCHEDULER_INTERVAL_SECS: u64 = 15;
const MAX_SNAPSHOT_CHANGED_PATHS: usize = 10_000;
const MAX_SNAPSHOT_CHANGED_BYTES: u64 = 512 * 1024 * 1024;
const MAX_WORKTREE_INCLUDE_FILE_BYTES: u64 = 64 * 1024;
const MAX_WORKTREE_INCLUDE_LIST_BYTES: usize = 1024 * 1024;
const MAX_WORKTREE_INCLUDED_PATHS: usize = 256;
const MAX_WORKTREE_INCLUDED_BYTES: u64 = 64 * 1024 * 1024;
const MAX_REVIEW_FILES: usize = 200;
const MAX_REVIEW_FILE_LIST_BYTES: usize = 1024 * 1024;
const MAX_REVIEW_PATCH_BYTES: usize = 256 * 1024;
const DEFAULT_WORKTREE_RETENTION_LIMIT: u32 = 15;
const MAX_WORKTREE_RETENTION_LIMIT: u32 = 100;
const DEFAULT_AUTOMATION_INACTIVITY_TIMEOUT_SECS: u64 = 15 * 60;
const DEFAULT_AUTOMATION_PIPE_DRAIN_TIMEOUT_SECS: u64 = 5;
static SCHEDULER_STARTED: AtomicBool = AtomicBool::new(false);
static RUN_CANCELLATIONS: OnceLock<Mutex<HashMap<String, oneshot::Sender<()>>>> = OnceLock::new();

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationTarget {
    #[serde(rename = "type")]
    pub target_type: String,
    pub project_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AutomationCompletionProbe {
    /// JSON receipt relative to either the automation project or Black Box's
    /// private data directory. `{date}` expands from the scheduled local date
    /// plus `scheduled_date_offset_days`.
    pub relative_path: String,
    #[serde(default = "default_completion_probe_base_directory")]
    pub base_directory: String,
    #[serde(default)]
    pub scheduled_date_offset_days: i64,
    #[serde(default)]
    pub json_equals: BTreeMap<String, String>,
    /// Optional JSON file whose named fields must equal the same fields in the
    /// completion receipt. This binds a receipt to the current durable bundle.
    #[serde(default)]
    pub reference_relative_path: Option<String>,
    #[serde(default)]
    pub json_matches_reference: Vec<String>,
    /// Recovery remains closed while any of these paths exist. Dream uses this
    /// to require transaction-lock release after writing its commit receipt.
    #[serde(default)]
    pub required_absent_relative_paths: Vec<String>,
    /// Optional title template for a recovered run. Supports `{name}` and
    /// `{date}`; absent templates preserve the historical task-name title.
    #[serde(default)]
    pub recovered_title: Option<String>,
}

fn default_completion_probe_base_directory() -> String {
    "project".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct AutomationDefinition {
    pub version: u8,
    pub id: String,
    pub kind: String,
    pub name: String,
    pub prompt: String,
    pub status: String,
    pub rrule: String,
    pub model: Option<String>,
    /// Optional per-task lightweight-model override. Missing values inherit
    /// the user's default system configuration at execution time.
    pub auxiliary_model: Option<String>,
    pub reasoning_effort: Option<String>,
    /// Explicit opt-in for Claude Code Agent Teams. Disabled by default because
    /// each teammate has an independent context and materially increases cost.
    pub agent_teams_enabled: bool,
    /// Automation-owned durable output roots under Black Box's data directory.
    /// Values must remain relative so task definitions cannot grant arbitrary
    /// host filesystem write access.
    pub data_write_subdirectories: Vec<String>,
    pub execution_environment: Option<String>,
    pub target: Option<AutomationTarget>,
    pub cwds: Vec<String>,
    pub target_thread_id: Option<String>,
    /// Optional durable receipt used to reconcile transport/tail failures with
    /// work that was already committed by the scheduled task.
    pub completion_probe: Option<AutomationCompletionProbe>,
    /// Pre-0.14.20 input only. Never exposed or serialized by the current API.
    #[serde(default, rename = "provider_id", skip_serializing)]
    legacy_provider_id: Option<String>,
    /// Pre-0.14.20 input only. Never exposed or serialized by the current API.
    #[serde(default, rename = "provider_revision", skip_serializing)]
    legacy_provider_revision: Option<u64>,
    pub created_at: i64,
    pub updated_at: i64,
}

impl Default for AutomationDefinition {
    fn default() -> Self {
        let now = now_ms();
        Self {
            version: 1,
            id: String::new(),
            kind: "cron".to_string(),
            name: String::new(),
            prompt: String::new(),
            status: ACTIVE.to_string(),
            rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0".to_string(),
            model: None,
            auxiliary_model: None,
            reasoning_effort: None,
            agent_teams_enabled: false,
            data_write_subdirectories: vec![],
            execution_environment: Some("worktree".to_string()),
            target: None,
            cwds: vec![],
            target_thread_id: None,
            completion_probe: None,
            legacy_provider_id: None,
            legacy_provider_revision: None,
            created_at: now,
            updated_at: now,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationSummary {
    #[serde(flatten)]
    pub definition: AutomationDefinition,
    pub next_run_at: Option<i64>,
    pub last_run_at: Option<i64>,
    pub running: bool,
    pub unread_runs: u32,
}

/// Redacted activity contract for task-center polling.
///
/// Keep this as a flat, explicit allowlist. Definition prompts and run bodies
/// intentionally have no representation in this type.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AutomationActivitySummary {
    pub id: String,
    pub title: String,
    pub definition_status: String,
    pub run_status: Option<String>,
    pub schedule_kind: String,
    pub next_run_at: Option<i64>,
    pub last_run_at: Option<i64>,
    pub active_run_id: Option<String>,
    pub running: bool,
    pub unread_runs: u32,
    pub updated_at: i64,
}

/// Minimal live-session projection used by the conversation surface.
///
/// The chat monitor only needs enough metadata to associate a durable Claude
/// session with an active scheduled run. Keep prompts, output, trace bodies,
/// provider data, and credentials out of this contract.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ActiveAutomationSession {
    pub run_id: String,
    pub automation_id: String,
    pub session_id: String,
    pub title: String,
    pub started_at: i64,
}

// Security boundary: this query may select status metadata only. Do not add
// definition prompts or automation_runs body columns here.
const AUTOMATION_ACTIVITY_SUMMARY_SQL: &str = r#"
    SELECT
      a.id,
      a.name,
      a.status,
      CASE
        WHEN a.active_run_id IS NOT NULL THEN COALESCE(
          (SELECT active.status
             FROM automation_runs active
            WHERE active.run_id = a.active_run_id
            LIMIT 1),
          'RUNNING'
        )
        ELSE (
          SELECT latest.status
            FROM automation_runs latest
           WHERE latest.automation_id = a.id
           ORDER BY latest.started_at DESC, latest.run_id DESC
           LIMIT 1
        )
      END AS run_status,
      a.kind,
      a.next_run_at,
      a.last_run_at,
      a.active_run_id,
      (SELECT COUNT(*)
         FROM automation_runs unread
        WHERE unread.automation_id = a.id
          AND unread.read_at IS NULL
          AND unread.status IN ('SUCCEEDED', 'NEEDS_ATTENTION', 'RESOLVED', 'FAILED', 'RECOVERED', 'PENDING_REVIEW')) AS unread_runs,
      a.updated_at
    FROM automations a
    ORDER BY a.updated_at DESC, a.name COLLATE NOCASE ASC, a.id ASC
"#;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationTraceEvent {
    pub sequence: u32,
    pub event_type: String,
    pub tool_name: Option<String>,
    pub tool_use_id: Option<String>,
    #[serde(default)]
    pub parent_tool_use_id: Option<String>,
    #[serde(default)]
    pub agent_id: Option<String>,
    #[serde(default)]
    pub agent_type: Option<String>,
    #[serde(default)]
    pub agent_kind: Option<String>,
    #[serde(default)]
    pub agent_depth: Option<u32>,
    pub summary: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationRun {
    pub run_id: String,
    pub automation_id: String,
    pub session_id: Option<String>,
    pub status: String,
    pub read_at: Option<i64>,
    pub title: String,
    pub summary: String,
    pub output: String,
    pub trace: Vec<AutomationTraceEvent>,
    pub error: Option<String>,
    pub source_cwd: Option<String>,
    pub execution_cwd: Option<String>,
    pub base_commit: Option<String>,
    pub source_head_commit: Option<String>,
    pub worktree_input_snapshot_ref: Option<String>,
    pub worktree_input_snapshot_at: Option<i64>,
    pub worktree_included_files: Option<u32>,
    pub worktree_cleaned_at: Option<i64>,
    pub worktree_snapshot_ref: Option<String>,
    pub worktree_snapshot_commit: Option<String>,
    pub worktree_snapshot_at: Option<i64>,
    pub worktree_branch_name: Option<String>,
    pub worktree_branch_at: Option<i64>,
    pub scheduled_at: Option<i64>,
    pub started_at: i64,
    pub finished_at: Option<i64>,
    pub archived_reason: Option<String>,
    pub retry_of_run_id: Option<String>,
    pub recovered_by_run_id: Option<String>,
    pub recovered_at: Option<i64>,
    pub recovery_evidence: Option<String>,
    pub attention_resolved_at: Option<i64>,
    pub attention_resolution: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationWorktreeReview {
    pub base_commit: String,
    pub review_source: String,
    pub status: String,
    pub commits: String,
    pub diff_stat: String,
    pub files: Vec<AutomationWorktreeFile>,
    pub files_truncated: bool,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AutomationPreferences {
    /// None disables automatic managed-worktree cleanup.
    pub worktree_retention_limit: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationWorktreeFile {
    pub path: String,
    pub display_path: String,
    pub status: String,
    pub untracked: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationWorktreeFileDiff {
    pub path: String,
    pub display_path: String,
    pub status: String,
    pub patch: String,
    pub binary: bool,
    pub truncated: bool,
    pub size_bytes: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorktreeSnapshotMetadata {
    version: u8,
    run_id: String,
    base_commit: String,
    snapshot_ref: String,
    snapshot_commit: String,
    relative_cwd: String,
    created_at: i64,
    changed_path_count: usize,
    changed_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorktreeInputSnapshotMetadata {
    version: u8,
    run_id: String,
    source_head_commit: String,
    input_snapshot_ref: String,
    input_snapshot_commit: String,
    created_at: i64,
    changed_path_count: usize,
    changed_bytes: u64,
}

#[derive(Debug)]
struct WorktreeInputSnapshot {
    source_head_commit: String,
    base_commit: String,
    input_snapshot_ref: Option<String>,
    input_snapshot_at: Option<i64>,
}

#[derive(Debug)]
struct AutomationExecution {
    output: String,
    trace: Vec<AutomationTraceEvent>,
    session_id: Option<String>,
    /// Position of the most recent root-agent assistant event with visible text.
    /// Thinking-only and tool-use-only events are progress, not final synthesis.
    last_main_assistant_event: Option<u64>,
    /// Position of the most recent completed background Agent notification.
    last_agent_completion_event: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct AutomationSessionTarget {
    session_id: String,
    arguments: Vec<String>,
    creates_new_session: bool,
}

#[derive(Debug, Clone)]
struct ManagedWorktreeRetentionRecord {
    run_id: String,
    status: String,
    source_cwd: Option<String>,
    execution_cwd: Option<String>,
    cleaned_at: Option<i64>,
    branch_name: Option<String>,
    handoff_protected: bool,
    started_at: i64,
    finished_at: Option<i64>,
}

enum ResolvedAutomationWorktreeReview {
    Live {
        worktree_root: PathBuf,
        base_commit: String,
    },
    Snapshot {
        repository: PathBuf,
        base_commit: String,
        snapshot_commit: String,
    },
}

#[derive(Debug)]
struct AutomationExecutionError {
    message: String,
    trace: Vec<AutomationTraceEvent>,
    output: String,
    recoverable_stall: bool,
}

#[derive(Debug)]
struct AutomationExecutionDirectory {
    source_cwd: PathBuf,
    execution_cwd: PathBuf,
    base_commit: Option<String>,
    source_head_commit: Option<String>,
    worktree_input_snapshot_ref: Option<String>,
    worktree_input_snapshot_at: Option<i64>,
    worktree_included_files: Option<u32>,
}

impl AutomationExecutionError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            trace: Vec::new(),
            output: String::new(),
            recoverable_stall: false,
        }
    }
}

impl From<String> for AutomationExecutionError {
    fn from(message: String) -> Self {
        Self::new(message)
    }
}

#[derive(Debug, Clone)]
struct ParsedRule {
    freq: String,
    interval: i64,
    by_hour: u32,
    by_minute: u32,
    by_second: u32,
    by_days: HashSet<Weekday>,
    by_month_day: Option<u32>,
}

fn now_ms() -> i64 {
    Utc::now().timestamp_millis()
}

fn run_cancellations() -> &'static Mutex<HashMap<String, oneshot::Sender<()>>> {
    RUN_CANCELLATIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn automation_timeout() -> Duration {
    let seconds = std::env::var("BLACKBOX_AUTOMATION_TIMEOUT_SECS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(4 * 60 * 60);
    Duration::from_secs(seconds)
}

fn automation_inactivity_timeout() -> Duration {
    let seconds = std::env::var("BLACKBOX_AUTOMATION_INACTIVITY_TIMEOUT_SECS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_AUTOMATION_INACTIVITY_TIMEOUT_SECS);
    Duration::from_secs(seconds)
}

#[derive(Debug, PartialEq, Eq)]
enum AutomationWaitFailure {
    Cancelled,
    Process(String),
    TimedOut(Duration),
    Inactive(Duration),
}

#[cfg(unix)]
fn isolate_automation_process_group(command: &mut Command) {
    use std::os::unix::process::CommandExt;

    command.as_std_mut().process_group(0);
}

#[cfg(not(unix))]
fn isolate_automation_process_group(_command: &mut Command) {}

async fn stop_automation_child(child: &mut tokio::process::Child) {
    #[cfg(unix)]
    if let Some(pid) = child.id() {
        // The CLI is spawned as its own process group. Killing the group also
        // closes pipes inherited by Bash/tool subprocesses, so recovery cannot
        // remain blocked on an orphaned writer after the parent exits.
        unsafe {
            libc::kill(-(pid as i32), libc::SIGKILL);
        }
    }

    #[cfg(windows)]
    if let Some(pid) = child.id() {
        let pid = pid.to_string();
        let _ = Command::new("taskkill")
            .args(["/PID", pid.as_str(), "/T", "/F"])
            .status()
            .await;
    }

    let _ = child.kill().await;
    let _ = child.wait().await;
}

async fn collect_automation_pipe(
    task: &mut tokio::task::JoinHandle<Result<Vec<u8>, std::io::Error>>,
    drain_timeout: Duration,
) -> Vec<u8> {
    match tokio::time::timeout(drain_timeout, &mut *task).await {
        Ok(Ok(Ok(bytes))) => bytes,
        Ok(Ok(Err(_))) | Ok(Err(_)) => Vec::new(),
        Err(_) => {
            task.abort();
            let _ = task.await;
            Vec::new()
        }
    }
}

impl AutomationWaitFailure {
    fn message(&self) -> String {
        match self {
            Self::Cancelled => "Automation cancelled by user".to_string(),
            Self::Process(error) => format!("Cannot wait for Claude CLI: {error}"),
            Self::TimedOut(duration) => {
                format!("Automation timed out after {} seconds", duration.as_secs())
            }
            Self::Inactive(duration) => format!(
                "Automation produced no stream activity for {} seconds; the unresponsive Claude CLI was stopped for same-session recovery",
                duration.as_secs()
            ),
        }
    }

    fn is_recoverable_stall(&self) -> bool {
        matches!(self, Self::Inactive(_))
    }
}

async fn wait_for_automation_child(
    child: &mut tokio::process::Child,
    mut cancel_receiver: oneshot::Receiver<()>,
    mut activity_receiver: mpsc::Receiver<()>,
    total_timeout: Duration,
    inactivity_timeout: Duration,
) -> Result<std::process::ExitStatus, AutomationWaitFailure> {
    let total_deadline = tokio::time::sleep(total_timeout);
    let inactivity_deadline = tokio::time::sleep(inactivity_timeout);
    tokio::pin!(total_deadline);
    tokio::pin!(inactivity_deadline);
    let mut activity_channel_open = true;

    loop {
        tokio::select! {
            result = child.wait() => {
                return result.map_err(|error| AutomationWaitFailure::Process(error.to_string()));
            }
            _ = &mut cancel_receiver => {
                stop_automation_child(child).await;
                return Err(AutomationWaitFailure::Cancelled);
            }
            _ = &mut total_deadline => {
                stop_automation_child(child).await;
                return Err(AutomationWaitFailure::TimedOut(total_timeout));
            }
            activity = activity_receiver.recv(), if activity_channel_open => {
                if activity.is_some() {
                    inactivity_deadline
                        .as_mut()
                        .reset(tokio::time::Instant::now() + inactivity_timeout);
                } else {
                    activity_channel_open = false;
                }
            }
            _ = &mut inactivity_deadline => {
                stop_automation_child(child).await;
                return Err(AutomationWaitFailure::Inactive(inactivity_timeout));
            }
        }
    }
}

fn automation_root() -> Result<PathBuf, String> {
    Ok(automation_data_dir()?.join("automations"))
}

fn database_path() -> Result<PathBuf, String> {
    Ok(automation_data_dir()?.join("automations.sqlite"))
}

fn automation_data_dir() -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("BLACKBOX_AUTOMATION_HOME") {
        return Ok(PathBuf::from(path));
    }
    crate::safe_data_dir()
}

fn definition_path(id: &str) -> Result<PathBuf, String> {
    Ok(automation_root()?.join(id).join("automation.toml"))
}

fn memory_path(id: &str) -> Result<PathBuf, String> {
    Ok(automation_root()?.join(id).join("memory.md"))
}

fn build_automation_security_settings(
    run_id: &str,
    auxiliary_model: &str,
    additional_write_paths: &[PathBuf],
) -> Result<PathBuf, String> {
    let directory = automation_data_dir()?.join("run-settings");
    fs::create_dir_all(&directory)
        .map_err(|error| format!("Cannot create automation security settings: {error}"))?;
    let path = directory.join(format!("{}.json", sanitize_id(run_id)));
    let mut settings = crate::auxiliary_model_hook_settings(auxiliary_model)?;
    settings["sandbox"] = serde_json::json!({
        "enabled": true,
        "autoAllowBashIfSandboxed": true,
        "allowUnsandboxedCommands": false,
        "failIfUnavailable": true,
        "filesystem": {
            "allowWrite": additional_write_paths
                .iter()
                .map(|path| path.to_string_lossy().to_string())
                .collect::<Vec<_>>()
        }
    });
    fs::write(
        &path,
        serde_json::to_vec_pretty(&settings)
            .map_err(|error| format!("Cannot encode automation security settings: {error}"))?,
    )
    .map_err(|error| format!("Cannot write automation security settings: {error}"))?;
    Ok(path)
}

fn validate_data_write_subdirectories(definition: &AutomationDefinition) -> Result<(), String> {
    let mut seen = HashSet::new();
    for subdirectory in &definition.data_write_subdirectories {
        if subdirectory.trim().is_empty()
            || subdirectory.trim() != subdirectory
            || !safe_relative_path(Path::new(subdirectory))
        {
            return Err(
                "dataWriteSubdirectories must contain safe relative paths under Black Box data"
                    .to_string(),
            );
        }
        if !seen.insert(subdirectory) {
            return Err("dataWriteSubdirectories cannot contain duplicates".to_string());
        }
    }
    Ok(())
}

fn prepare_automation_write_paths(
    definition: &AutomationDefinition,
    data_dir: &Path,
) -> Result<Vec<PathBuf>, String> {
    validate_data_write_subdirectories(definition)?;
    fs::create_dir_all(data_dir)
        .map_err(|error| format!("Cannot prepare Black Box data directory: {error}"))?;
    let canonical_data_dir = fs::canonicalize(data_dir)
        .map_err(|error| format!("Cannot resolve Black Box data directory: {error}"))?;
    let mut paths = Vec::with_capacity(definition.data_write_subdirectories.len());
    for subdirectory in &definition.data_write_subdirectories {
        let path = data_dir.join(subdirectory);
        fs::create_dir_all(&path).map_err(|error| {
            format!(
                "Cannot prepare automation write path {}: {error}",
                path.display()
            )
        })?;
        let canonical_path = fs::canonicalize(&path).map_err(|error| {
            format!(
                "Cannot resolve automation write path {}: {error}",
                path.display()
            )
        })?;
        if !canonical_path.starts_with(&canonical_data_dir) {
            return Err(format!(
                "Automation write path escaped Black Box data: {}",
                path.display()
            ));
        }
        paths.push(canonical_path);
    }
    Ok(paths)
}

fn cleanup_automation_security_settings(path: &Path) {
    let _ = fs::remove_file(path);
}

fn mcp_permission_rules(path: &Path) -> Vec<String> {
    let Ok(text) = fs::read_to_string(path) else {
        return Vec::new();
    };
    let Ok(config) = serde_json::from_str::<Value>(&text) else {
        return Vec::new();
    };
    let Some(servers) = config.get("mcpServers").and_then(Value::as_object) else {
        return Vec::new();
    };
    let mut rules = servers
        .keys()
        .map(|server| format!("mcp__{server}__*"))
        .collect::<Vec<_>>();
    rules.sort();
    rules
}

fn open_database_read_only() -> Result<Connection, String> {
    let path = database_path()?;
    open_database_read_only_at(&path)
}

fn open_database_read_only_at(path: &Path) -> Result<Connection, String> {
    if !path.is_file() {
        return Err(format!(
            "Automations database does not exist: {}",
            path.display()
        ));
    }
    let ordinary = Connection::open_with_flags(
        &path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .and_then(configure_read_only_connection);
    let ordinary_error = match ordinary {
        Ok(connection) => return Ok(connection),
        Err(error) => error,
    };
    let mut wal_name = path.as_os_str().to_os_string();
    wal_name.push("-wal");
    let wal_path = PathBuf::from(wal_name);
    if wal_path
        .metadata()
        .map(|metadata| metadata.len() > 0)
        .unwrap_or(false)
    {
        return Err(format!(
            "Cannot open active WAL automations database read-only: {ordinary_error}"
        ));
    }

    let mut normalized = path.to_string_lossy().replace('\\', "/");
    if cfg!(windows) && !normalized.starts_with('/') {
        normalized.insert(0, '/');
    }
    let mut encoded = String::with_capacity(normalized.len());
    for byte in normalized.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b':' | b'-' | b'_' | b'.' | b'~') {
            encoded.push(char::from(byte));
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    let immutable_uri = format!("file:{encoded}?mode=ro&immutable=1");
    Connection::open_with_flags(
        immutable_uri,
        OpenFlags::SQLITE_OPEN_READ_ONLY
            | OpenFlags::SQLITE_OPEN_NO_MUTEX
            | OpenFlags::SQLITE_OPEN_URI,
    )
    .and_then(configure_read_only_connection)
    .map_err(|immutable_error| {
        format!(
            "Cannot open automations database read-only: {ordinary_error}; immutable fallback failed: {immutable_error}"
        )
    })
}

fn configure_read_only_connection(connection: Connection) -> rusqlite::Result<Connection> {
    connection
        .busy_timeout(Duration::from_secs(5))
        .and_then(|_| connection.execute_batch("PRAGMA query_only=ON;"))?;
    connection.query_row("SELECT COUNT(*) FROM sqlite_schema", [], |_| Ok(()))?;
    Ok(connection)
}

fn migrate_legacy_run_statuses(connection: &Connection) -> rusqlite::Result<usize> {
    connection.execute(
        "UPDATE automation_runs SET status='SUCCEEDED' WHERE status='PENDING_REVIEW'",
        [],
    )
}

fn migrate_legacy_provider_index_bindings(connection: &Connection) -> rusqlite::Result<usize> {
    connection.execute(
        "UPDATE automations SET provider_id=NULL,provider_revision=NULL WHERE provider_id IS NOT NULL OR provider_revision IS NOT NULL",
        [],
    )
}

fn open_database() -> Result<Connection, String> {
    let path = database_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Cannot create Blackbox data directory: {e}"))?;
    }
    let connection =
        Connection::open(path).map_err(|e| format!("Cannot open automations database: {e}"))?;
    connection
        .execute_batch(
            r#"
            PRAGMA journal_mode=WAL;
            PRAGMA foreign_keys=ON;
            CREATE TABLE IF NOT EXISTS automations (
              id TEXT PRIMARY KEY,
              kind TEXT NOT NULL,
              name TEXT NOT NULL,
              prompt TEXT NOT NULL,
              status TEXT NOT NULL DEFAULT 'ACTIVE',
              next_run_at INTEGER,
              last_run_at INTEGER,
              cwds TEXT NOT NULL DEFAULT '[]',
              rrule TEXT NOT NULL,
              model TEXT,
              reasoning_effort TEXT,
              execution_environment TEXT,
              target_type TEXT,
              project_id TEXT,
              target_thread_id TEXT,
              provider_id TEXT,
              provider_revision INTEGER,
              active_run_id TEXT,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS automation_runs (
              run_id TEXT PRIMARY KEY,
              automation_id TEXT NOT NULL,
              session_id TEXT,
              status TEXT NOT NULL,
              read_at INTEGER,
              title TEXT,
              summary TEXT,
              output TEXT,
              trace_json TEXT NOT NULL DEFAULT '[]',
              error TEXT,
              source_cwd TEXT,
              execution_cwd TEXT,
              base_commit TEXT,
              source_head_commit TEXT,
              worktree_input_snapshot_ref TEXT,
              worktree_input_snapshot_at INTEGER,
              worktree_included_files INTEGER,
              worktree_cleaned_at INTEGER,
              worktree_snapshot_ref TEXT,
              worktree_snapshot_commit TEXT,
              worktree_snapshot_at INTEGER,
              worktree_branch_name TEXT,
              worktree_branch_at INTEGER,
              scheduled_at INTEGER,
              started_at INTEGER NOT NULL,
              finished_at INTEGER,
              archived_reason TEXT,
              retry_of_run_id TEXT,
              recovered_by_run_id TEXT,
              recovered_at INTEGER,
              recovery_evidence TEXT,
              attention_resolved_at INTEGER,
              attention_resolution TEXT
            );
            CREATE TABLE IF NOT EXISTS automation_recovery_plans (
              original_run_id TEXT PRIMARY KEY,
              automation_id TEXT NOT NULL,
              recovery_run_id TEXT NOT NULL,
              authorized_at INTEGER NOT NULL,
              phase TEXT NOT NULL,
              catchup_run_id TEXT,
              governance_pending INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS automation_claims (
              automation_id TEXT NOT NULL,
              scheduled_at INTEGER NOT NULL,
              run_id TEXT NOT NULL,
              PRIMARY KEY (automation_id, scheduled_at)
            );
            CREATE TABLE IF NOT EXISTS inbox_items (
              id TEXT PRIMARY KEY,
              title TEXT,
              description TEXT,
              run_id TEXT,
              read_at INTEGER,
              created_at INTEGER
            );
            CREATE TABLE IF NOT EXISTS automation_preferences (
              id INTEGER PRIMARY KEY CHECK (id = 1),
              worktree_retention_limit INTEGER
            );
            INSERT OR IGNORE INTO automation_preferences (id, worktree_retention_limit)
              VALUES (1, 15);
            CREATE INDEX IF NOT EXISTS automation_runs_by_automation
              ON automation_runs(automation_id, started_at DESC);
            "#,
        )
        .map_err(|e| format!("Cannot migrate automations database: {e}"))?;
    let has_trace: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('automation_runs') WHERE name='trace_json'",
            [],
            |row| row.get(0),
        )
        .map_err(|e| format!("Cannot inspect automations database: {e}"))?;
    if has_trace == 0 {
        connection
            .execute(
                "ALTER TABLE automation_runs ADD COLUMN trace_json TEXT NOT NULL DEFAULT '[]'",
                [],
            )
            .map_err(|e| format!("Cannot add automation trace storage: {e}"))?;
    }
    let has_execution_cwd: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('automation_runs') WHERE name='execution_cwd'",
            [],
            |row| row.get(0),
        )
        .map_err(|e| format!("Cannot inspect automations database: {e}"))?;
    if has_execution_cwd == 0 {
        connection
            .execute(
                "ALTER TABLE automation_runs ADD COLUMN execution_cwd TEXT",
                [],
            )
            .map_err(|e| format!("Cannot add automation execution directory storage: {e}"))?;
    }
    let has_worktree_cleaned_at: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('automation_runs') WHERE name='worktree_cleaned_at'",
            [],
            |row| row.get(0),
        )
        .map_err(|e| format!("Cannot inspect automations database: {e}"))?;
    if has_worktree_cleaned_at == 0 {
        connection
            .execute(
                "ALTER TABLE automation_runs ADD COLUMN worktree_cleaned_at INTEGER",
                [],
            )
            .map_err(|e| format!("Cannot add worktree cleanup storage: {e}"))?;
    }
    let has_base_commit: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('automation_runs') WHERE name='base_commit'",
            [],
            |row| row.get(0),
        )
        .map_err(|e| format!("Cannot inspect automations database: {e}"))?;
    if has_base_commit == 0 {
        connection
            .execute(
                "ALTER TABLE automation_runs ADD COLUMN base_commit TEXT",
                [],
            )
            .map_err(|e| format!("Cannot add automation worktree baseline storage: {e}"))?;
    }
    let has_provider_revision: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('automations') WHERE name='provider_revision'",
            [],
            |row| row.get(0),
        )
        .map_err(|e| format!("Cannot inspect automations database: {e}"))?;
    if has_provider_revision == 0 {
        connection
            .execute(
                "ALTER TABLE automations ADD COLUMN provider_revision INTEGER",
                [],
            )
            .map_err(|e| format!("Cannot add automation provider revision storage: {e}"))?;
    }
    for (column, sql) in [
        (
            "source_head_commit",
            "ALTER TABLE automation_runs ADD COLUMN source_head_commit TEXT",
        ),
        (
            "worktree_input_snapshot_ref",
            "ALTER TABLE automation_runs ADD COLUMN worktree_input_snapshot_ref TEXT",
        ),
        (
            "worktree_input_snapshot_at",
            "ALTER TABLE automation_runs ADD COLUMN worktree_input_snapshot_at INTEGER",
        ),
        (
            "worktree_included_files",
            "ALTER TABLE automation_runs ADD COLUMN worktree_included_files INTEGER",
        ),
        (
            "worktree_snapshot_ref",
            "ALTER TABLE automation_runs ADD COLUMN worktree_snapshot_ref TEXT",
        ),
        (
            "worktree_snapshot_commit",
            "ALTER TABLE automation_runs ADD COLUMN worktree_snapshot_commit TEXT",
        ),
        (
            "worktree_snapshot_at",
            "ALTER TABLE automation_runs ADD COLUMN worktree_snapshot_at INTEGER",
        ),
        (
            "worktree_branch_name",
            "ALTER TABLE automation_runs ADD COLUMN worktree_branch_name TEXT",
        ),
        (
            "worktree_branch_at",
            "ALTER TABLE automation_runs ADD COLUMN worktree_branch_at INTEGER",
        ),
    ] {
        let present: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('automation_runs') WHERE name=?1",
                params![column],
                |row| row.get(0),
            )
            .map_err(|e| format!("Cannot inspect automations database: {e}"))?;
        if present == 0 {
            connection
                .execute(sql, [])
                .map_err(|e| format!("Cannot add automation worktree lifecycle storage: {e}"))?;
        }
    }
    for (column, sql) in [
        (
            "attention_resolved_at",
            "ALTER TABLE automation_runs ADD COLUMN attention_resolved_at INTEGER",
        ),
        (
            "attention_resolution",
            "ALTER TABLE automation_runs ADD COLUMN attention_resolution TEXT",
        ),
    ] {
        let present: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('automation_runs') WHERE name=?1",
                params![column],
                |row| row.get(0),
            )
            .map_err(|e| format!("Cannot inspect automations database: {e}"))?;
        if present == 0 {
            connection
                .execute(sql, [])
                .map_err(|e| format!("Cannot add automation decision lifecycle storage: {e}"))?;
        }
    }
    for (column, sql) in [
        (
            "retry_of_run_id",
            "ALTER TABLE automation_runs ADD COLUMN retry_of_run_id TEXT",
        ),
        (
            "recovered_by_run_id",
            "ALTER TABLE automation_runs ADD COLUMN recovered_by_run_id TEXT",
        ),
        (
            "recovered_at",
            "ALTER TABLE automation_runs ADD COLUMN recovered_at INTEGER",
        ),
        (
            "recovery_evidence",
            "ALTER TABLE automation_runs ADD COLUMN recovery_evidence TEXT",
        ),
    ] {
        let present: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('automation_runs') WHERE name=?1",
                params![column],
                |row| row.get(0),
            )
            .map_err(|e| format!("Cannot inspect automations database: {e}"))?;
        if present == 0 {
            connection
                .execute(sql, [])
                .map_err(|e| format!("Cannot add automation retry storage: {e}"))?;
        }
    }
    migrate_legacy_run_statuses(&connection)
        .map_err(|e| format!("Cannot migrate legacy automation run statuses: {e}"))?;
    migrate_legacy_provider_index_bindings(&connection)
        .map_err(|e| format!("Cannot migrate legacy automation provider bindings: {e}"))?;
    Ok(connection)
}

fn load_automation_preferences(connection: &Connection) -> Result<AutomationPreferences, String> {
    let stored_limit: Option<Option<i64>> = connection
        .query_row(
            "SELECT worktree_retention_limit FROM automation_preferences WHERE id=1",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("Cannot read automation preferences: {error}"))?;
    let raw_limit = stored_limit.unwrap_or(Some(i64::from(DEFAULT_WORKTREE_RETENTION_LIMIT)));
    let worktree_retention_limit = match raw_limit {
        None => None,
        Some(value) if (1..=i64::from(MAX_WORKTREE_RETENTION_LIMIT)).contains(&value) => {
            Some(value as u32)
        }
        Some(_) => return Err("Stored worktree retention limit is invalid".to_string()),
    };
    Ok(AutomationPreferences {
        worktree_retention_limit,
    })
}

fn managed_worktree_retention_candidates(
    records: &[ManagedWorktreeRetentionRecord],
    limit: Option<u32>,
) -> Vec<String> {
    let Some(limit) = limit else {
        return Vec::new();
    };
    let is_managed = |record: &&ManagedWorktreeRetentionRecord| {
        !record.handoff_protected
            && record.cleaned_at.is_none()
            && matches!(
                (&record.source_cwd, &record.execution_cwd),
                (Some(source), Some(execution)) if source != execution
            )
    };
    let excess = records
        .iter()
        .filter(is_managed)
        .count()
        .saturating_sub(limit as usize);
    if excess == 0 {
        return Vec::new();
    }
    let mut eligible: Vec<&ManagedWorktreeRetentionRecord> = records
        .iter()
        .filter(is_managed)
        .filter(|record| record.status == "ARCHIVED" && record.branch_name.is_none())
        .collect();
    eligible.sort_by(|left, right| {
        left.finished_at
            .unwrap_or(left.started_at)
            .cmp(&right.finished_at.unwrap_or(right.started_at))
            .then_with(|| left.started_at.cmp(&right.started_at))
            .then_with(|| left.run_id.cmp(&right.run_id))
    });
    eligible
        .into_iter()
        .take(excess)
        .map(|record| record.run_id.clone())
        .collect()
}

fn enforce_managed_worktree_retention() -> Result<usize, String> {
    let connection = open_database()?;
    let preferences = load_automation_preferences(&connection)?;
    if preferences.worktree_retention_limit.is_none() {
        return Ok(0);
    }
    let records = {
        let mut statement = connection
            .prepare(
                "SELECT run_id,status,source_cwd,execution_cwd,worktree_cleaned_at,worktree_branch_name,session_id,started_at,finished_at FROM automation_runs",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| {
                let session_id: Option<String> = row.get(6)?;
                Ok(ManagedWorktreeRetentionRecord {
                    run_id: row.get(0)?,
                    status: row.get(1)?,
                    source_cwd: row.get(2)?,
                    execution_cwd: row.get(3)?,
                    cleaned_at: row.get(4)?,
                    branch_name: row.get(5)?,
                    handoff_protected: session_id
                        .as_deref()
                        .map(crate::task_handoff::is_current_worktree_session)
                        .unwrap_or(false),
                    started_at: row.get(7)?,
                    finished_at: row.get(8)?,
                })
            })
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?
    };
    drop(connection);
    let candidates =
        managed_worktree_retention_candidates(&records, preferences.worktree_retention_limit);
    let mut cleaned = 0;
    let mut failures = Vec::new();
    for run_id in candidates {
        match cleanup_automation_worktree(run_id.clone()) {
            Ok(()) => cleaned += 1,
            Err(error) => failures.push(format!("{run_id}: {error}")),
        }
    }
    if failures.is_empty() {
        Ok(cleaned)
    } else {
        Err(format!(
            "Managed worktree retention left protected worktrees in place: {}",
            failures.join("; ")
        ))
    }
}

#[tauri::command]
pub fn get_automation_preferences() -> Result<AutomationPreferences, String> {
    let connection = open_database()?;
    load_automation_preferences(&connection)
}

#[tauri::command]
pub fn set_automation_worktree_retention_limit(
    limit: Option<u32>,
) -> Result<AutomationPreferences, String> {
    if matches!(limit, Some(value) if value == 0 || value > MAX_WORKTREE_RETENTION_LIMIT) {
        return Err(format!(
            "Worktree retention limit must be between 1 and {MAX_WORKTREE_RETENTION_LIMIT}, or disabled"
        ));
    }
    let connection = open_database()?;
    connection
        .execute(
            "INSERT INTO automation_preferences (id,worktree_retention_limit) VALUES (1,?1) ON CONFLICT(id) DO UPDATE SET worktree_retention_limit=excluded.worktree_retention_limit",
            params![limit.map(i64::from)],
        )
        .map_err(|error| format!("Cannot save automation preferences: {error}"))?;
    drop(connection);
    if let Err(error) = enforce_managed_worktree_retention() {
        eprintln!(
            "[BLACKBOX AUTOMATIONS] worktree retention after preference change failed: {error}"
        );
    }
    Ok(AutomationPreferences {
        worktree_retention_limit: limit,
    })
}

pub(crate) fn has_running_automation() -> Result<bool, String> {
    let connection = open_database()?;
    let running: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM automation_runs WHERE status='RUNNING'",
            [],
            |row| row.get(0),
        )
        .map_err(|error| format!("Cannot inspect running automations: {error}"))?;
    Ok(running > 0)
}

fn parse_rrule(input: &str) -> Result<ParsedRule, String> {
    let mut fields = BTreeMap::new();
    let raw = input.strip_prefix("RRULE:").unwrap_or(input);
    for part in raw.split(';') {
        let (key, value) = part
            .split_once('=')
            .ok_or_else(|| format!("Invalid RRULE component: {part}"))?;
        fields.insert(key.to_ascii_uppercase(), value.to_ascii_uppercase());
    }
    let freq = fields
        .get("FREQ")
        .cloned()
        .ok_or_else(|| "RRULE requires FREQ".to_string())?;
    if !matches!(
        freq.as_str(),
        "MINUTELY" | "HOURLY" | "DAILY" | "WEEKLY" | "MONTHLY"
    ) {
        return Err(format!("Unsupported RRULE frequency: {freq}"));
    }
    let parse_u32 = |key: &str, default: u32| -> Result<u32, String> {
        fields
            .get(key)
            .map(|value| {
                value
                    .parse::<u32>()
                    .map_err(|_| format!("Invalid {key}: {value}"))
            })
            .unwrap_or(Ok(default))
    };
    let interval = i64::from(parse_u32("INTERVAL", 1)?.max(1));
    let by_hour = parse_u32("BYHOUR", 0)?;
    let by_minute = parse_u32("BYMINUTE", 0)?;
    let by_second = parse_u32("BYSECOND", 0)?;
    if by_hour > 23 || by_minute > 59 || by_second > 59 {
        return Err("RRULE time fields are out of range".to_string());
    }
    let mut by_days = HashSet::new();
    if let Some(days) = fields.get("BYDAY") {
        for day in days.split(',') {
            let weekday = match day {
                "MO" => Weekday::Mon,
                "TU" => Weekday::Tue,
                "WE" => Weekday::Wed,
                "TH" => Weekday::Thu,
                "FR" => Weekday::Fri,
                "SA" => Weekday::Sat,
                "SU" => Weekday::Sun,
                _ => return Err(format!("Unsupported BYDAY value: {day}")),
            };
            by_days.insert(weekday);
        }
    }
    let by_month_day = fields
        .get("BYMONTHDAY")
        .map(|value| {
            value
                .parse::<u32>()
                .map_err(|_| format!("Invalid BYMONTHDAY: {value}"))
        })
        .transpose()?;
    if by_month_day.is_some_and(|day| day == 0 || day > 31) {
        return Err("BYMONTHDAY must be between 1 and 31".to_string());
    }
    Ok(ParsedRule {
        freq,
        interval,
        by_hour,
        by_minute,
        by_second,
        by_days,
        by_month_day,
    })
}

fn local_from_ms(milliseconds: i64) -> Result<chrono::DateTime<Local>, String> {
    Local
        .timestamp_millis_opt(milliseconds)
        .single()
        .ok_or_else(|| format!("Invalid timestamp: {milliseconds}"))
}

fn next_occurrence(rrule: &str, after_ms: i64) -> Result<i64, String> {
    let rule = parse_rrule(rrule)?;
    let after = local_from_ms(after_ms)?;
    match rule.freq.as_str() {
        "MINUTELY" => {
            let minute_index = after.timestamp().div_euclid(60);
            let next_index =
                minute_index + (rule.interval - minute_index.rem_euclid(rule.interval));
            let mut next = Local
                .timestamp_opt(next_index * 60, rule.by_second)
                .single()
                .ok_or_else(|| "Cannot calculate minutely schedule".to_string())?;
            if next <= after {
                next += ChronoDuration::minutes(rule.interval);
            }
            Ok(next.timestamp_millis())
        }
        "HOURLY" => {
            let hour_index = after.timestamp().div_euclid(3600);
            for offset in 0..=(rule.interval + 2) {
                let index = hour_index + offset;
                if index.rem_euclid(rule.interval) != 0 {
                    continue;
                }
                let base = Local.timestamp_opt(index * 3600, 0).single();
                if let Some(base) = base {
                    if let Some(candidate) = base
                        .with_minute(rule.by_minute)
                        .and_then(|value| value.with_second(rule.by_second))
                    {
                        if candidate > after {
                            return Ok(candidate.timestamp_millis());
                        }
                    }
                }
            }
            Err("Cannot calculate hourly schedule".to_string())
        }
        _ => {
            let start_date = after.date_naive();
            for offset in 0..=3660_i64 {
                let date = start_date + ChronoDuration::days(offset);
                let cadence_match = match rule.freq.as_str() {
                    "DAILY" => i64::from(date.num_days_from_ce()).rem_euclid(rule.interval) == 0,
                    "WEEKLY" => {
                        let weekday_match =
                            rule.by_days.is_empty() || rule.by_days.contains(&date.weekday());
                        let week_index = i64::from(date.iso_week().year()) * 53
                            + i64::from(date.iso_week().week());
                        weekday_match && week_index.rem_euclid(rule.interval) == 0
                    }
                    "MONTHLY" => {
                        let month_index = i64::from(date.year()) * 12 + i64::from(date.month0());
                        let day_match = rule.by_month_day.unwrap_or(1) == date.day();
                        day_match && month_index.rem_euclid(rule.interval) == 0
                    }
                    _ => false,
                };
                if !cadence_match {
                    continue;
                }
                let Some(naive) = date.and_hms_opt(rule.by_hour, rule.by_minute, rule.by_second)
                else {
                    continue;
                };
                let Some(candidate) = naive.and_local_timezone(Local).single() else {
                    continue;
                };
                if candidate > after {
                    return Ok(candidate.timestamp_millis());
                }
            }
            Err("RRULE has no occurrence in the next ten years".to_string())
        }
    }
}

fn validate_definition(definition: &AutomationDefinition) -> Result<(), String> {
    if !matches!(definition.kind.as_str(), "cron" | "heartbeat") {
        return Err("kind must be cron or heartbeat".to_string());
    }
    if !matches!(definition.status.as_str(), ACTIVE | PAUSED) {
        return Err("status must be ACTIVE or PAUSED".to_string());
    }
    if definition.name.trim().is_empty() || definition.prompt.trim().is_empty() {
        return Err("name and prompt are required".to_string());
    }
    let execution_environment = definition
        .execution_environment
        .as_deref()
        .unwrap_or("local");
    if !matches!(execution_environment, "local" | "worktree") {
        return Err("executionEnvironment must be local or worktree".to_string());
    }
    if definition.kind == "heartbeat" && execution_environment == "worktree" {
        return Err("heartbeat automations cannot use a worktree".to_string());
    }
    validate_data_write_subdirectories(definition)?;
    validate_completion_probe(definition)?;
    parse_rrule(&definition.rrule)?;
    if definition.kind == "cron" {
        let project = definition
            .target
            .as_ref()
            .map(|target| target.project_id.as_str())
            .or_else(|| definition.cwds.first().map(String::as_str))
            .ok_or_else(|| "cron automation requires a project".to_string())?;
        if !Path::new(project).is_dir() {
            return Err(format!("Project is not available: {project}"));
        }
        if execution_environment == "worktree" {
            git_output(&["-C", project, "rev-parse", "--verify", "HEAD"]).map_err(|error| {
                format!("Worktree mode requires a Git repository with at least one commit: {error}")
            })?;
        }
    } else if definition
        .target_thread_id
        .as_deref()
        .unwrap_or("")
        .is_empty()
    {
        return Err("heartbeat automation requires targetThreadId".to_string());
    }
    validate_development_isolation(definition)?;
    Ok(())
}

fn validate_completion_probe(definition: &AutomationDefinition) -> Result<(), String> {
    let Some(probe) = &definition.completion_probe else {
        return Ok(());
    };
    if definition.kind != "cron" {
        return Err("completionProbe is only supported for cron automations".to_string());
    }
    if !matches!(probe.base_directory.as_str(), "project" | "automation_data") {
        return Err("completionProbe.baseDirectory must be project or automation_data".to_string());
    }
    let validate_path = |field: &str, raw: &str| -> Result<(), String> {
        let rendered = raw.replace("{date}", "2000-01-01");
        if raw.trim() != raw || raw.is_empty() || !safe_relative_path(Path::new(&rendered)) {
            return Err(format!(
                "completionProbe.{field} must be a safe relative path"
            ));
        }
        if probe.base_directory == "automation_data"
            && !definition.data_write_subdirectories.iter().any(|allowed| {
                let allowed = Path::new(allowed);
                let rendered = Path::new(&rendered);
                rendered == allowed || rendered.starts_with(allowed)
            })
        {
            return Err(format!(
                "completionProbe.{field} must stay within dataWriteSubdirectories"
            ));
        }
        Ok(())
    };
    validate_path("relativePath", &probe.relative_path)?;
    if let Some(reference) = probe.reference_relative_path.as_deref() {
        validate_path("referenceRelativePath", reference)?;
    }
    for path in &probe.required_absent_relative_paths {
        validate_path("requiredAbsentRelativePaths", path)?;
    }
    if !(-366..=366).contains(&probe.scheduled_date_offset_days) {
        return Err(
            "completionProbe.scheduledDateOffsetDays must be between -366 and 366".to_string(),
        );
    }
    if probe.json_equals.is_empty()
        || probe
            .json_equals
            .iter()
            .any(|(key, expected)| key.trim() != key || key.is_empty() || expected.is_empty())
    {
        return Err("completionProbe.jsonEquals must contain non-empty fields".to_string());
    }
    if probe.reference_relative_path.is_none() && !probe.json_matches_reference.is_empty() {
        return Err(
            "completionProbe.jsonMatchesReference requires referenceRelativePath".to_string(),
        );
    }
    if probe
        .json_matches_reference
        .iter()
        .any(|field| field.trim() != field || field.is_empty())
    {
        return Err(
            "completionProbe.jsonMatchesReference must contain non-empty fields".to_string(),
        );
    }
    if probe
        .recovered_title
        .as_deref()
        .is_some_and(|title| title.trim() != title || title.is_empty())
    {
        return Err("completionProbe.recoveredTitle must be non-empty".to_string());
    }
    Ok(())
}

/// Development and GUI tests can set BLACKBOX_DEV_ISOLATION_ROOT to make it
/// mechanically impossible for an automation to run in the user's live
/// projects or memory workspace. Canonicalization also rejects symlink escapes.
fn validate_development_isolation(definition: &AutomationDefinition) -> Result<(), String> {
    let Some(root) = std::env::var_os("BLACKBOX_DEV_ISOLATION_ROOT") else {
        return Ok(());
    };
    validate_development_paths(definition, Path::new(&root))
}

fn validate_development_paths(
    definition: &AutomationDefinition,
    root: &Path,
) -> Result<(), String> {
    let root = fs::canonicalize(root)
        .map_err(|e| format!("Cannot resolve development isolation root: {e}"))?;
    let mut paths = definition.cwds.clone();
    if let Some(target) = &definition.target {
        if !paths.iter().any(|path| path == &target.project_id) {
            paths.push(target.project_id.clone());
        }
    }
    if paths.is_empty() {
        return Err("Development isolation requires an isolated project directory".to_string());
    }
    for path in paths {
        let canonical = fs::canonicalize(&path)
            .map_err(|e| format!("Cannot resolve isolated project {path}: {e}"))?;
        if !canonical.starts_with(&root) {
            return Err(format!(
                "Development isolation blocked project outside {}: {}",
                root.display(),
                canonical.display()
            ));
        }
    }
    Ok(())
}

fn sanitize_id(value: &str) -> String {
    let mut output = String::new();
    let mut previous_dash = false;
    for character in value.to_lowercase().chars() {
        if character.is_ascii_alphanumeric() {
            output.push(character);
            previous_dash = false;
        } else if !previous_dash && !output.is_empty() {
            output.push('-');
            previous_dash = true;
        }
    }
    output.trim_matches('-').chars().take(64).collect()
}

fn atomic_write(path: &Path, contents: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Invalid automation path".to_string())?;
    fs::create_dir_all(parent).map_err(|e| format!("Cannot create automation directory: {e}"))?;
    let temporary = parent.join(format!(".automation.toml.tmp-{}", std::process::id()));
    fs::write(&temporary, contents).map_err(|e| format!("Cannot write automation: {e}"))?;
    fs::rename(&temporary, path).map_err(|e| format!("Cannot commit automation: {e}"))
}

fn read_definition(path: &Path) -> Result<AutomationDefinition, String> {
    let text =
        fs::read_to_string(path).map_err(|e| format!("Cannot read {}: {e}", path.display()))?;
    toml::from_str(&text).map_err(|e| format!("Cannot parse {}: {e}", path.display()))
}

fn clear_legacy_provider_binding(definition: &mut AutomationDefinition) -> bool {
    let changed =
        definition.legacy_provider_id.is_some() || definition.legacy_provider_revision.is_some();
    definition.legacy_provider_id = None;
    definition.legacy_provider_revision = None;
    changed
}

fn load_definition(id: &str) -> Result<AutomationDefinition, String> {
    let mut definition = read_definition(&definition_path(id)?)?;
    clear_legacy_provider_binding(&mut definition);
    Ok(definition)
}

fn load_all_definitions() -> Result<Vec<AutomationDefinition>, String> {
    let root = automation_root()?;
    if !root.exists() {
        return Ok(vec![]);
    }
    let mut definitions = Vec::new();
    for entry in fs::read_dir(root).map_err(|e| format!("Cannot read automations: {e}"))? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path().join("automation.toml");
        if path.is_file() {
            let mut definition = read_definition(&path)?;
            clear_legacy_provider_binding(&mut definition);
            definitions.push(definition);
        }
    }
    definitions.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(definitions)
}

fn migrate_legacy_definition_provider_bindings() -> Result<usize, String> {
    let root = automation_root()?;
    if !root.exists() {
        return Ok(0);
    }
    let mut migrated = 0;
    for entry in fs::read_dir(root).map_err(|e| format!("Cannot read automations: {e}"))? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path().join("automation.toml");
        if !path.is_file() {
            continue;
        }
        let mut definition = read_definition(&path)?;
        if clear_legacy_provider_binding(&mut definition) {
            save_definition(&definition)?;
            migrated += 1;
        }
    }
    Ok(migrated)
}

fn save_definition(definition: &AutomationDefinition) -> Result<AutomationDefinition, String> {
    let text = toml::to_string_pretty(definition)
        .map_err(|e| format!("Cannot serialize automation: {e}"))?;
    let path = definition_path(&definition.id)?;
    atomic_write(&path, text.as_bytes())?;
    let read_back = read_definition(&path)?;
    if read_back.updated_at != definition.updated_at || read_back.rrule != definition.rrule {
        return Err("Automation read-back verification failed".to_string());
    }
    Ok(read_back)
}

fn reconcile_definition(
    connection: &Connection,
    definition: &AutomationDefinition,
) -> Result<(), String> {
    let current: Option<(Option<i64>, Option<i64>, String, String, i64)> = connection
        .query_row(
            "SELECT next_run_at,last_run_at,rrule,status,updated_at FROM automations WHERE id = ?1",
            params![definition.id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let last_run_at = current.as_ref().and_then(|value| value.1);
    let next_run_at = if definition.status == ACTIVE {
        match current.as_ref() {
            // Preserve the indexed schedule point, including an overdue one.
            // Recomputing from "now" here would erase the catch-up signal before
            // claim_due_automations can atomically claim it.
            Some((Some(existing_next), _, stored_rrule, stored_status, stored_updated))
                if stored_rrule == &definition.rrule
                    && stored_status == ACTIVE
                    && *stored_updated == definition.updated_at =>
            {
                Some(*existing_next)
            }
            _ => Some(next_occurrence(&definition.rrule, now_ms() - 1_000)?),
        }
    } else {
        None
    };
    let cwds = serde_json::to_string(&definition.cwds).map_err(|e| e.to_string())?;
    connection
        .execute(
            r#"INSERT INTO automations
            (id,kind,name,prompt,status,next_run_at,last_run_at,cwds,rrule,model,reasoning_effort,
             execution_environment,target_type,project_id,target_thread_id,created_at,updated_at)
            VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17)
            ON CONFLICT(id) DO UPDATE SET
              kind=excluded.kind,name=excluded.name,prompt=excluded.prompt,status=excluded.status,
              next_run_at=excluded.next_run_at,cwds=excluded.cwds,rrule=excluded.rrule,
              model=excluded.model,reasoning_effort=excluded.reasoning_effort,
              execution_environment=excluded.execution_environment,target_type=excluded.target_type,
              project_id=excluded.project_id,target_thread_id=excluded.target_thread_id,
              updated_at=excluded.updated_at"#,
            params![
                definition.id,
                definition.kind,
                definition.name,
                definition.prompt,
                definition.status,
                next_run_at,
                last_run_at,
                cwds,
                definition.rrule,
                definition.model,
                definition.reasoning_effort,
                definition.execution_environment,
                definition
                    .target
                    .as_ref()
                    .map(|target| target.target_type.as_str()),
                definition
                    .target
                    .as_ref()
                    .map(|target| target.project_id.as_str()),
                definition.target_thread_id,
                definition.created_at,
                definition.updated_at,
            ],
        )
        .map_err(|e| format!("Cannot index automation {}: {e}", definition.id))?;
    Ok(())
}

fn reconcile_all() -> Result<(), String> {
    migrate_legacy_definition_provider_bindings()?;
    let connection = open_database()?;
    let definitions = load_all_definitions()?;
    for definition in &definitions {
        validate_definition(&definition)?;
        reconcile_definition(&connection, &definition)?;
    }
    reconcile_incomplete_attention_probes(&connection, &definitions)?;
    reconcile_failed_completion_probes(&connection, &definitions)?;
    Ok(())
}

fn query_summary(
    connection: &Connection,
    definition: AutomationDefinition,
) -> Result<AutomationSummary, String> {
    let (next_run_at, last_run_at, active_run_id): (Option<i64>, Option<i64>, Option<String>) =
        connection
            .query_row(
                "SELECT next_run_at,last_run_at,active_run_id FROM automations WHERE id=?1",
                params![definition.id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .map_err(|e| e.to_string())?;
    let unread_runs: u32 = connection
        .query_row(
            "SELECT COUNT(*) FROM automation_runs WHERE automation_id=?1 AND read_at IS NULL AND status IN ('SUCCEEDED','NEEDS_ATTENTION','RESOLVED','FAILED','RECOVERED','PENDING_REVIEW')",
            params![definition.id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    Ok(AutomationSummary {
        definition,
        next_run_at,
        last_run_at,
        running: active_run_id.is_some(),
        unread_runs,
    })
}

fn verify_definition_is_indexed(
    connection: &Connection,
    definition: &AutomationDefinition,
) -> Result<(), String> {
    let indexed: Option<(String, String, i64)> = connection
        .query_row(
            "SELECT rrule,status,updated_at FROM automations WHERE id=?1",
            params![definition.id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(|error| {
            format!(
                "Cannot inspect indexed automation {}: {error}",
                definition.id
            )
        })?;
    match indexed {
        Some((rrule, status, updated_at))
            if rrule == definition.rrule
                && status == definition.status
                && updated_at == definition.updated_at =>
        {
            Ok(())
        }
        Some(_) => Err(format!(
            "Automation {} definition/index mismatch; reopen Black Box to reconcile it",
            definition.id
        )),
        None => Err(format!(
            "Automation {} is not indexed; reopen Black Box to reconcile it",
            definition.id
        )),
    }
}

fn list_automations_read_only() -> Result<Vec<AutomationSummary>, String> {
    let connection = open_database_read_only()?;
    load_all_definitions()?
        .into_iter()
        .map(|definition| {
            validate_definition(&definition)?;
            verify_definition_is_indexed(&connection, &definition)?;
            query_summary(&connection, definition)
        })
        .collect()
}

fn get_automation_read_only(id: &str) -> Result<AutomationSummary, String> {
    let definition = load_definition(id)?;
    validate_definition(&definition)?;
    let connection = open_database_read_only()?;
    verify_definition_is_indexed(&connection, &definition)?;
    query_summary(&connection, definition)
}

#[tauri::command]
pub fn list_automations() -> Result<Vec<AutomationSummary>, String> {
    reconcile_all()?;
    let connection = open_database()?;
    load_all_definitions()?
        .into_iter()
        .map(|definition| query_summary(&connection, definition))
        .collect()
}

fn query_automation_activity_summaries(
    connection: &Connection,
) -> Result<Vec<AutomationActivitySummary>, String> {
    let mut statement = connection
        .prepare(AUTOMATION_ACTIVITY_SUMMARY_SQL)
        .map_err(|error| format!("Cannot prepare automation activity summary: {error}"))?;
    let rows = statement
        .query_map([], |row| {
            let active_run_id: Option<String> = row.get(7)?;
            Ok(AutomationActivitySummary {
                id: row.get(0)?,
                title: row.get(1)?,
                definition_status: row.get(2)?,
                run_status: row.get(3)?,
                schedule_kind: row.get(4)?,
                next_run_at: row.get(5)?,
                last_run_at: row.get(6)?,
                running: active_run_id.is_some(),
                active_run_id,
                unread_runs: row.get(8)?,
                updated_at: row.get(9)?,
            })
        })
        .map_err(|error| format!("Cannot query automation activity summary: {error}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Cannot read automation activity summary: {error}"))
}

#[tauri::command]
pub fn list_automation_activity_summaries() -> Result<Vec<AutomationActivitySummary>, String> {
    // Reconcile portable definitions into the SQLite status index first. The
    // activity query itself selects only the explicit metadata allowlist above.
    reconcile_all()?;
    let connection = open_database()?;
    query_automation_activity_summaries(&connection)
}

fn query_active_automation_sessions(
    connection: &Connection,
) -> Result<Vec<ActiveAutomationSession>, String> {
    let mut statement = connection
        .prepare(
            r#"
            SELECT r.run_id, r.automation_id, r.session_id, a.name, r.started_at
              FROM automation_runs r
              JOIN automations a ON a.id = r.automation_id
             WHERE r.status = 'RUNNING'
               AND r.session_id IS NOT NULL
               AND a.active_run_id = r.run_id
             ORDER BY r.started_at DESC, r.run_id DESC
            "#,
        )
        .map_err(|error| format!("Cannot prepare active automation sessions: {error}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok(ActiveAutomationSession {
                run_id: row.get(0)?,
                automation_id: row.get(1)?,
                session_id: row.get(2)?,
                title: row.get(3)?,
                started_at: row.get(4)?,
            })
        })
        .map_err(|error| format!("Cannot query active automation sessions: {error}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Cannot read active automation sessions: {error}"))
}

#[tauri::command]
pub fn list_active_automation_sessions() -> Result<Vec<ActiveAutomationSession>, String> {
    let connection = open_database_read_only()?;
    query_active_automation_sessions(&connection)
}

#[tauri::command]
pub fn get_automation(id: String) -> Result<AutomationSummary, String> {
    let definition = load_definition(&id)?;
    let connection = open_database()?;
    reconcile_definition(&connection, &definition)?;
    query_summary(&connection, definition)
}

#[tauri::command]
pub fn upsert_automation(
    mut definition: AutomationDefinition,
) -> Result<AutomationSummary, String> {
    let now = now_ms();
    if definition.id.trim().is_empty() {
        definition.id = sanitize_id(&definition.name);
        if definition.id.is_empty() {
            definition.id = format!("automation-{}", uuid::Uuid::new_v4().simple());
        }
    }
    if definition_path(&definition.id)?.exists() {
        let previous = load_definition(&definition.id)?;
        definition.created_at = previous.created_at;
    } else if definition.created_at <= 0 {
        definition.created_at = now;
    }
    definition.version = 1;
    clear_legacy_provider_binding(&mut definition);
    definition.updated_at = now;
    validate_definition(&definition)?;
    let definition = save_definition(&definition)?;
    let connection = open_database()?;
    reconcile_definition(&connection, &definition)?;
    query_summary(&connection, definition)
}

#[tauri::command]
pub fn delete_automation(id: String) -> Result<(), String> {
    let path = automation_root()?.join(&id);
    if path.exists() {
        fs::remove_dir_all(&path).map_err(|e| format!("Cannot delete automation {id}: {e}"))?;
    }
    let connection = open_database()?;
    connection
        .execute("DELETE FROM automations WHERE id=?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn set_automation_status(id: String, status: String) -> Result<AutomationSummary, String> {
    if !matches!(status.as_str(), ACTIVE | PAUSED) {
        return Err("status must be ACTIVE or PAUSED".to_string());
    }
    let mut definition = load_definition(&id)?;
    definition.status = status;
    upsert_automation(definition)
}

fn resolve_provider_and_models(
    definition: &AutomationDefinition,
) -> Result<(Option<String>, String, String, String), String> {
    let providers = crate::read_providers_file()?;
    let (provider_id, model) = resolve_provider_and_model_with(definition, &providers)?;
    let auxiliary_request = definition
        .auxiliary_model
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| providers.default_auxiliary_model.clone())
        .ok_or_else(|| {
            "Default system configuration is incomplete: choose a default auxiliary model"
                .to_string()
        })?;
    let mut auxiliary_definition = definition.clone();
    auxiliary_definition.model = Some(auxiliary_request.clone());
    let (_, auxiliary_model) = resolve_provider_and_model_with(&auxiliary_definition, &providers)?;
    if auxiliary_model.trim().is_empty() {
        return Err("Automation auxiliary model resolved to an empty value".to_string());
    }
    let auxiliary_model_tier = crate::native_agent_model_tier(&auxiliary_request)?;
    Ok((provider_id, model, auxiliary_model, auxiliary_model_tier))
}

fn logical_model_tier(value: &str) -> Option<&'static str> {
    let value = value.trim().to_ascii_lowercase();
    match value.as_str() {
        "fable" => Some("fable"),
        "opus" => Some("opus"),
        "sonnet" => Some("sonnet"),
        "haiku" => Some("haiku"),
        _ if value.starts_with("claude-") && value.contains("fable") => Some("fable"),
        _ if value.starts_with("claude-") && value.contains("opus") => Some("opus"),
        _ if value.starts_with("claude-") && value.contains("sonnet") => Some("sonnet"),
        _ if value.starts_with("claude-") && value.contains("haiku") => Some("haiku"),
        _ => None,
    }
}

fn resolve_provider_and_model_with(
    definition: &AutomationDefinition,
    providers: &crate::ProvidersFile,
) -> Result<(Option<String>, String), String> {
    let requested = definition
        .model
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| providers.default_main_model.clone())
        .ok_or_else(|| {
            "Default system configuration is incomplete: choose a default main model".to_string()
        })?;
    let runtime_provider = match providers.default_api.as_deref() {
        Some("system") => {
            return Err(
                "System Claude Login has been retired; choose a credentialed default API"
                    .to_string(),
            )
        }
        Some(id) => Some(
            providers
                .providers
                .iter()
                .find(|provider| provider.id == id)
                .ok_or_else(|| format!("The default system API {id} does not exist"))?,
        ),
        None => {
            return Err(
                "Default system configuration is incomplete: choose a default API".to_string(),
            )
        }
    };
    let provider_id = runtime_provider.map(|provider| provider.id.clone());
    let Some(tier) = logical_model_tier(&requested) else {
        return Ok((provider_id, requested));
    };
    let model = if let Some(provider) = runtime_provider {
        provider
            .model_mappings
            .iter()
            .find(|mapping| mapping.tier.eq_ignore_ascii_case(tier))
            .map(|mapping| mapping.provider_model.clone())
            .filter(|model| !model.trim().is_empty())
            .ok_or_else(|| {
                format!(
                    "The default new-conversation provider {} has no model mapping for the {tier} tier",
                    provider.name
                )
            })?
    } else {
        tier.to_string()
    };
    Ok((provider_id, model))
}

fn project_directory(definition: &AutomationDefinition) -> Result<String, String> {
    definition
        .target
        .as_ref()
        .map(|target| target.project_id.clone())
        .or_else(|| definition.cwds.first().cloned())
        .ok_or_else(|| "Automation has no project directory".to_string())
}

fn git_raw_output(arguments: &[&str]) -> Result<Vec<u8>, String> {
    let output = StdCommand::new("git")
        .args(arguments)
        .output()
        .map_err(|error| format!("Cannot start Git: {error}"))?;
    if !output.status.success() {
        let message = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if message.is_empty() {
            format!("Git exited with {:?}", output.status.code())
        } else {
            message
        });
    }
    Ok(output.stdout)
}

fn git_raw_output_capped(arguments: &[&str], limit: usize) -> Result<(Vec<u8>, bool), String> {
    let mut child = StdCommand::new("git")
        .args(arguments)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Cannot start Git: {error}"))?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Cannot capture Git output".to_string())?;
    let mut stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Cannot capture Git errors".to_string())?;
    let stderr_reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = stderr.read_to_end(&mut bytes);
        bytes
    });
    let mut bytes = Vec::new();
    stdout
        .by_ref()
        .take((limit + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Cannot read Git output: {error}"))?;
    let truncated = bytes.len() > limit;
    if truncated {
        bytes.truncate(limit);
        let _ = child.kill();
    }
    let status = child
        .wait()
        .map_err(|error| format!("Cannot wait for Git: {error}"))?;
    let stderr = stderr_reader
        .join()
        .unwrap_or_else(|_| b"Cannot read Git errors".to_vec());
    if !truncated && !status.success() {
        let message = String::from_utf8_lossy(&stderr).trim().to_string();
        return Err(if message.is_empty() {
            format!("Git exited with {:?}", status.code())
        } else {
            message
        });
    }
    Ok((bytes, truncated))
}

pub(crate) fn git_output(arguments: &[&str]) -> Result<String, String> {
    Ok(String::from_utf8_lossy(&git_raw_output(arguments)?)
        .trim()
        .to_string())
}

fn git_index_output(
    worktree_root: &Path,
    index_path: &Path,
    arguments: &[&str],
    author_identity: bool,
) -> Result<String, String> {
    let mut command = StdCommand::new("git");
    command
        .args(arguments)
        .current_dir(worktree_root)
        .env("GIT_INDEX_FILE", index_path);
    if author_identity {
        command
            .env("GIT_AUTHOR_NAME", "Black Box Recovery")
            .env("GIT_AUTHOR_EMAIL", "recovery@blackbox.invalid")
            .env("GIT_COMMITTER_NAME", "Black Box Recovery")
            .env("GIT_COMMITTER_EMAIL", "recovery@blackbox.invalid");
    }
    let output = command
        .output()
        .map_err(|error| format!("Cannot start Git snapshot command: {error}"))?;
    if !output.status.success() {
        let message = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if message.is_empty() {
            format!(
                "Git snapshot command exited with {:?}",
                output.status.code()
            )
        } else {
            message
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

pub(crate) fn valid_commit_id(value: &str) -> bool {
    (40..=64).contains(&value.len()) && value.chars().all(|character| character.is_ascii_hexdigit())
}

fn validate_worktree_cleanup_paths(
    worktrees_root: &Path,
    expected_root: &Path,
    execution_path: &Path,
) -> Result<PathBuf, String> {
    let canonical_worktrees_root = fs::canonicalize(worktrees_root)
        .map_err(|error| format!("Cannot resolve worktree storage: {error}"))?;
    let canonical_expected = fs::canonicalize(expected_root)
        .map_err(|error| format!("Cannot resolve worktree: {error}"))?;
    if !canonical_expected.starts_with(&canonical_worktrees_root)
        || !execution_path.starts_with(expected_root)
    {
        return Err("Refusing to clean a worktree outside Black Box storage".to_string());
    }
    Ok(canonical_expected)
}

fn validate_worktree_review_path(
    worktrees_root: &Path,
    expected_root: &Path,
    execution_path: &Path,
) -> Result<PathBuf, String> {
    let canonical_expected =
        validate_worktree_cleanup_paths(worktrees_root, expected_root, execution_path)?;
    let canonical_execution = fs::canonicalize(execution_path)
        .map_err(|error| format!("Cannot resolve worktree review directory: {error}"))?;
    if !canonical_execution.starts_with(&canonical_expected) {
        return Err("Refusing to review a directory outside the run worktree".to_string());
    }
    Ok(canonical_execution)
}

fn validate_managed_execution_cwd(
    expected_root: &Path,
    execution_path: &Path,
) -> Result<PathBuf, String> {
    let relative = execution_path
        .strip_prefix(expected_root)
        .map(Path::to_path_buf)
        .map_err(|_| "Run execution directory is outside its managed worktree".to_string())?;
    if !safe_relative_path(&relative) {
        return Err("Run execution directory has an unsafe relative path".to_string());
    }
    let canonical_root = fs::canonicalize(expected_root)
        .map_err(|error| format!("Cannot resolve managed worktree: {error}"))?;
    let canonical_execution = fs::canonicalize(execution_path)
        .map_err(|error| format!("Cannot resolve run execution directory: {error}"))?;
    if !canonical_execution.starts_with(&canonical_root) {
        return Err("Run execution directory escapes its managed worktree".to_string());
    }
    Ok(relative)
}

#[derive(Debug)]
struct WorktreeBranchCreation {
    branch_name: String,
    previous_head: String,
    created: bool,
}

fn normalize_worktree_branch_name(repository: &Path, requested: &str) -> Result<String, String> {
    let branch_name = requested.trim();
    if branch_name.is_empty() || branch_name.len() > 200 || branch_name.starts_with('-') {
        return Err("Enter a valid Git branch name (200 characters or fewer)".to_string());
    }
    let repository_text = repository.to_string_lossy().to_string();
    let normalized = git_output(&[
        "-C",
        &repository_text,
        "check-ref-format",
        "--branch",
        branch_name,
    ])
    .map_err(|_| "Enter a valid Git branch name".to_string())?;
    if normalized != branch_name || branch_name.contains("@{") {
        return Err("Enter a literal Git branch name without checkout shorthand".to_string());
    }
    Ok(branch_name.to_string())
}

fn rollback_created_worktree_branch(
    repository: &Path,
    worktree_root: &Path,
    branch_name: &str,
    previous_head: &str,
) -> Result<(), String> {
    let worktree = worktree_root.to_string_lossy().to_string();
    let repository = repository.to_string_lossy().to_string();
    git_output(&["-C", &worktree, "switch", "--detach", previous_head])?;
    git_output(&["-C", &repository, "branch", "-D", branch_name])?;
    Ok(())
}

fn create_branch_in_worktree(
    repository: &Path,
    worktree_root: &Path,
    requested: &str,
) -> Result<WorktreeBranchCreation, String> {
    let branch_name = normalize_worktree_branch_name(repository, requested)?;
    let worktree = worktree_root.to_string_lossy().to_string();
    let repository_text = repository.to_string_lossy().to_string();
    let previous_head = git_output(&["-C", &worktree, "rev-parse", "HEAD"])?;
    if !valid_commit_id(&previous_head) {
        return Err("Worktree HEAD is not a valid commit".to_string());
    }

    if let Ok(current_branch) = git_output(&[
        "-C",
        &worktree,
        "symbolic-ref",
        "--quiet",
        "--short",
        "HEAD",
    ]) {
        if current_branch == branch_name {
            return Ok(WorktreeBranchCreation {
                branch_name,
                previous_head,
                created: false,
            });
        }
        return Err(format!(
            "This worktree already has the branch '{current_branch}' checked out"
        ));
    }

    let full_ref = format!("refs/heads/{branch_name}");
    if git_output(&["-C", &repository_text, "rev-parse", "--verify", &full_ref]).is_ok() {
        return Err(format!("The branch '{branch_name}' already exists"));
    }

    git_output(&["-C", &worktree, "switch", "-c", &branch_name])
        .map_err(|error| format!("Cannot create branch in managed worktree: {error}"))?;
    let verified_branch = git_output(&[
        "-C",
        &worktree,
        "symbolic-ref",
        "--quiet",
        "--short",
        "HEAD",
    ]);
    let verified_head = git_output(&["-C", &worktree, "rev-parse", "HEAD"]);
    if verified_branch.as_deref() != Ok(branch_name.as_str())
        || verified_head.as_deref() != Ok(previous_head.as_str())
    {
        let rollback = rollback_created_worktree_branch(
            repository,
            worktree_root,
            &branch_name,
            &previous_head,
        );
        return match rollback {
            Ok(_) => Err("Git did not verify the newly created worktree branch".to_string()),
            Err(rollback_error) => Err(format!(
                "Git did not verify the newly created worktree branch; rollback also failed: {rollback_error}"
            )),
        };
    }
    Ok(WorktreeBranchCreation {
        branch_name,
        previous_head,
        created: true,
    })
}

pub(crate) fn validate_worktree_git_identity(
    source_cwd: &Path,
    expected_root: &Path,
) -> Result<PathBuf, String> {
    let source = source_cwd.to_string_lossy().to_string();
    let worktree = expected_root.to_string_lossy().to_string();
    let source_top = PathBuf::from(git_output(&[
        "-C",
        &source,
        "rev-parse",
        "--show-toplevel",
    ])?);
    let worktree_top = PathBuf::from(git_output(&[
        "-C",
        &worktree,
        "rev-parse",
        "--show-toplevel",
    ])?);
    let canonical_source_top = fs::canonicalize(&source_top)
        .map_err(|error| format!("Cannot resolve source Git repository: {error}"))?;
    let canonical_worktree_top = fs::canonicalize(&worktree_top)
        .map_err(|error| format!("Cannot resolve managed Git worktree: {error}"))?;
    let canonical_expected = fs::canonicalize(expected_root)
        .map_err(|error| format!("Cannot resolve expected worktree: {error}"))?;
    if canonical_worktree_top != canonical_expected {
        return Err("Managed worktree Git root does not match the expected run root".to_string());
    }

    let resolve_common = |cwd: &Path, raw: String| {
        let path = PathBuf::from(raw);
        if path.is_absolute() {
            path
        } else {
            cwd.join(path)
        }
    };
    let source_common = resolve_common(
        source_cwd,
        git_output(&["-C", &source, "rev-parse", "--git-common-dir"])?,
    );
    let worktree_common = resolve_common(
        expected_root,
        git_output(&["-C", &worktree, "rev-parse", "--git-common-dir"])?,
    );
    let canonical_source_common = fs::canonicalize(source_common)
        .map_err(|error| format!("Cannot resolve source Git common directory: {error}"))?;
    let canonical_worktree_common = fs::canonicalize(worktree_common)
        .map_err(|error| format!("Cannot resolve worktree Git common directory: {error}"))?;
    if canonical_source_common != canonical_worktree_common {
        return Err("Managed worktree does not belong to the source Git repository".to_string());
    }
    Ok(canonical_source_top)
}

pub(crate) fn safe_relative_path(path: &Path) -> bool {
    !path.is_absolute()
        && path
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
}

fn parse_nul_paths(bytes: Vec<u8>) -> Result<Vec<PathBuf>, String> {
    bytes
        .split(|byte| *byte == 0)
        .filter(|segment| !segment.is_empty())
        .map(|segment| {
            let value = std::str::from_utf8(segment)
                .map_err(|_| "Snapshot paths must be valid UTF-8".to_string())?;
            let path = PathBuf::from(value);
            if !safe_relative_path(&path) {
                return Err("Snapshot path escaped the managed worktree".to_string());
            }
            Ok(path)
        })
        .collect()
}

fn snapshot_change_budget(worktree_root: &Path, base_commit: &str) -> Result<(usize, u64), String> {
    if !valid_commit_id(base_commit) {
        return Err("Run has an invalid worktree starting commit".to_string());
    }
    let worktree = worktree_root.to_string_lossy().to_string();
    let mut paths: HashSet<PathBuf> = parse_nul_paths(git_raw_output(&[
        "-C",
        &worktree,
        "diff",
        "--name-only",
        "-z",
        base_commit,
        "--",
    ])?)?
    .into_iter()
    .collect();
    paths.extend(parse_nul_paths(git_raw_output(&[
        "-C",
        &worktree,
        "ls-files",
        "--others",
        "--exclude-standard",
        "-z",
    ])?)?);
    enforce_snapshot_budget(paths.len(), 0)?;
    let mut bytes = 0_u64;
    for relative in &paths {
        match fs::symlink_metadata(worktree_root.join(relative)) {
            Ok(metadata) if metadata.is_file() || metadata.file_type().is_symlink() => {
                bytes = bytes.saturating_add(metadata.len());
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("Cannot inspect snapshot path: {error}")),
        }
        enforce_snapshot_budget(paths.len(), bytes)?;
    }
    Ok((paths.len(), bytes))
}

fn enforce_snapshot_budget(path_count: usize, bytes: u64) -> Result<(), String> {
    if path_count > MAX_SNAPSHOT_CHANGED_PATHS {
        return Err(format!(
            "Recovery snapshot has too many changed paths ({} > {})",
            path_count, MAX_SNAPSHOT_CHANGED_PATHS
        ));
    }
    if bytes > MAX_SNAPSHOT_CHANGED_BYTES {
        return Err(format!(
            "Recovery snapshot changed content is too large ({} bytes > {} bytes)",
            bytes, MAX_SNAPSHOT_CHANGED_BYTES
        ));
    }
    Ok(())
}

fn snapshot_ref(automation_id: &str, run_id: &str) -> String {
    format!(
        "refs/blackbox/automation-snapshots/{}/{}",
        sanitize_id(automation_id),
        sanitize_id(run_id)
    )
}

fn input_snapshot_ref(automation_id: &str, run_id: &str) -> String {
    format!(
        "refs/blackbox/automation-inputs/{}/{}",
        sanitize_id(automation_id),
        sanitize_id(run_id)
    )
}

fn create_worktree_input_snapshot(
    repository: &Path,
    snapshot_dir: &Path,
    automation_id: &str,
    run_id: &str,
    source_head_commit: &str,
) -> Result<WorktreeInputSnapshot, String> {
    if !valid_commit_id(source_head_commit) {
        return Err("Source repository has an invalid HEAD commit".to_string());
    }
    let (changed_path_count, changed_bytes) =
        snapshot_change_budget(repository, source_head_commit)?;
    if changed_path_count == 0 {
        return Ok(WorktreeInputSnapshot {
            source_head_commit: source_head_commit.to_string(),
            base_commit: source_head_commit.to_string(),
            input_snapshot_ref: None,
            input_snapshot_at: None,
        });
    }
    if snapshot_dir.exists() {
        return Err("A worktree input snapshot already exists for this run".to_string());
    }
    let reference = input_snapshot_ref(automation_id, run_id);
    let repository_text = repository.to_string_lossy().to_string();
    if git_output(&["-C", &repository_text, "rev-parse", "--verify", &reference]).is_ok() {
        return Err("Worktree input snapshot ref already exists".to_string());
    }
    let parent = snapshot_dir
        .parent()
        .ok_or_else(|| "Worktree input snapshot has no parent directory".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Cannot create worktree input snapshot storage: {error}"))?;
    let temp_dir = parent.join(format!(
        ".{}.tmp-{}",
        snapshot_dir
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("input"),
        uuid::Uuid::new_v4()
    ));
    fs::create_dir(&temp_dir)
        .map_err(|error| format!("Cannot stage worktree input snapshot: {error}"))?;
    let result = (|| {
        let index_path = temp_dir.join("index");
        git_index_output(
            repository,
            &index_path,
            &["read-tree", source_head_commit],
            false,
        )?;
        git_index_output(repository, &index_path, &["add", "-A", "--", "."], false)?;
        let tree = git_index_output(repository, &index_path, &["write-tree"], false)?;
        let message = format!("Black Box input snapshot for automation run {run_id}");
        let input_snapshot_commit = git_index_output(
            repository,
            &index_path,
            &[
                "commit-tree",
                &tree,
                "-p",
                source_head_commit,
                "-m",
                &message,
            ],
            true,
        )?;
        if !valid_commit_id(&input_snapshot_commit) {
            return Err("Git returned an invalid worktree input snapshot commit".to_string());
        }
        fs::remove_file(&index_path)
            .map_err(|error| format!("Cannot finalize worktree input index: {error}"))?;
        let created_at = now_ms();
        let metadata = WorktreeInputSnapshotMetadata {
            version: 1,
            run_id: run_id.to_string(),
            source_head_commit: source_head_commit.to_string(),
            input_snapshot_ref: reference.clone(),
            input_snapshot_commit: input_snapshot_commit.clone(),
            created_at,
            changed_path_count,
            changed_bytes,
        };
        fs::write(
            temp_dir.join("metadata.json"),
            serde_json::to_vec_pretty(&metadata).map_err(|error| error.to_string())?,
        )
        .map_err(|error| format!("Cannot write worktree input metadata: {error}"))?;
        git_output(&[
            "-C",
            &repository_text,
            "update-ref",
            &reference,
            &input_snapshot_commit,
        ])?;
        if let Err(error) = fs::rename(&temp_dir, snapshot_dir) {
            let _ = git_output(&[
                "-C",
                &repository_text,
                "update-ref",
                "-d",
                &reference,
                &input_snapshot_commit,
            ]);
            return Err(format!("Cannot publish worktree input metadata: {error}"));
        }
        Ok(WorktreeInputSnapshot {
            source_head_commit: source_head_commit.to_string(),
            base_commit: input_snapshot_commit,
            input_snapshot_ref: Some(reference),
            input_snapshot_at: Some(created_at),
        })
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&temp_dir);
    }
    result
}

fn remove_worktree_input_snapshot(
    repository: &Path,
    snapshot_dir: &Path,
    snapshot: &WorktreeInputSnapshot,
) {
    if let Some(reference) = snapshot.input_snapshot_ref.as_deref() {
        let repository = repository.to_string_lossy().to_string();
        let _ = git_output(&["-C", &repository, "update-ref", "-d", reference]);
        let _ = fs::remove_dir_all(snapshot_dir);
    }
}

fn release_worktree_input_snapshot(
    repository: &Path,
    automation_id: &str,
    run_id: &str,
    reference: &str,
    expected_commit: &str,
) -> Result<(), String> {
    if reference != input_snapshot_ref(automation_id, run_id) || !valid_commit_id(expected_commit) {
        return Err("Stored worktree input snapshot reference is invalid".to_string());
    }
    let repository_text = repository.to_string_lossy().to_string();
    let resolved = git_output(&[
        "-C",
        &repository_text,
        "rev-parse",
        &format!("{reference}^{{commit}}"),
    ])?;
    if resolved != expected_commit {
        return Err("Worktree input snapshot ref no longer matches the run baseline".to_string());
    }
    git_output(&[
        "-C",
        &repository_text,
        "update-ref",
        "-d",
        reference,
        expected_commit,
    ])?;
    let input_snapshot_dir = automation_data_dir()?
        .join("worktree-inputs")
        .join(sanitize_id(automation_id))
        .join(sanitize_id(run_id));
    if input_snapshot_dir.exists() {
        if let Err(error) = fs::remove_dir_all(&input_snapshot_dir) {
            eprintln!(
                "[BLACKBOX AUTOMATIONS] released input ref but could not remove redundant metadata: {error}"
            );
        }
    }
    Ok(())
}

fn path_contains_symlink(root: &Path, relative: &Path) -> Result<bool, String> {
    let mut current = root.to_path_buf();
    for component in relative.components() {
        let Component::Normal(value) = component else {
            return Err("Worktree include path is unsafe".to_string());
        };
        current.push(value);
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => return Ok(true),
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(error) => return Err(format!("Cannot inspect worktree include path: {error}")),
        }
    }
    Ok(false)
}

fn ensure_safe_worktree_parent(worktree_root: &Path, relative: &Path) -> Result<PathBuf, String> {
    let parent = relative.parent().unwrap_or_else(|| Path::new(""));
    let mut current = worktree_root.to_path_buf();
    for component in parent.components() {
        let Component::Normal(value) = component else {
            return Err("Worktree include destination is unsafe".to_string());
        };
        current.push(value);
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
                return Err(
                    "Worktree include destination crosses a non-directory or symlink".to_string(),
                )
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => fs::create_dir(&current)
                .map_err(|error| format!("Cannot create worktree include directory: {error}"))?,
            Err(error) => {
                return Err(format!(
                    "Cannot inspect worktree include destination: {error}"
                ))
            }
        }
    }
    let canonical_root = fs::canonicalize(worktree_root)
        .map_err(|error| format!("Cannot resolve managed worktree: {error}"))?;
    let canonical_parent = fs::canonicalize(&current)
        .map_err(|error| format!("Cannot resolve worktree include destination: {error}"))?;
    if !canonical_parent.starts_with(&canonical_root) {
        return Err("Worktree include destination escaped the managed worktree".to_string());
    }
    Ok(current)
}

fn source_path_is_ignored(repository: &Path, relative: &Path) -> Result<bool, String> {
    let output = StdCommand::new("git")
        .args(["check-ignore", "--quiet", "--no-index", "--"])
        .arg(relative)
        .current_dir(repository)
        .output()
        .map_err(|error| format!("Cannot verify ignored worktree include path: {error}"))?;
    match output.status.code() {
        Some(0) => Ok(true),
        Some(1) => Ok(false),
        _ => Err(String::from_utf8_lossy(&output.stderr).trim().to_string()),
    }
}

pub(crate) fn copy_worktree_included_files(
    repository: &Path,
    worktree_root: &Path,
) -> Result<u32, String> {
    let include_path = repository.join(".worktreeinclude");
    let metadata = match fs::symlink_metadata(&include_path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(error) => return Err(format!("Cannot inspect .worktreeinclude: {error}")),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(".worktreeinclude must be a regular file, not a symlink".to_string());
    }
    if metadata.len() > MAX_WORKTREE_INCLUDE_FILE_BYTES {
        return Err(".worktreeinclude is too large".to_string());
    }
    let contents = fs::read_to_string(&include_path)
        .map_err(|error| format!("Cannot read .worktreeinclude: {error}"))?;
    if contents.contains('\0')
        || !contents
            .lines()
            .any(|line| !line.trim().is_empty() && !line.trim_start().starts_with('#'))
    {
        return if contents.contains('\0') {
            Err(".worktreeinclude contains an invalid NUL byte".to_string())
        } else {
            Ok(0)
        };
    }
    let repository_text = repository.to_string_lossy().to_string();
    let exclude_argument = format!("--exclude-from={}", include_path.to_string_lossy());
    let (candidates, candidates_truncated) = git_raw_output_capped(
        &[
            "-C",
            &repository_text,
            "ls-files",
            "--others",
            "--ignored",
            "-z",
            &exclude_argument,
        ],
        MAX_WORKTREE_INCLUDE_LIST_BYTES,
    )?;
    if candidates_truncated {
        return Err(".worktreeinclude matched too many paths".to_string());
    }
    let candidates: HashSet<PathBuf> = parse_nul_paths(candidates)?.into_iter().collect();
    if candidates.len() > MAX_WORKTREE_INCLUDED_PATHS {
        return Err(format!(
            ".worktreeinclude matched too many files ({} > {})",
            candidates.len(),
            MAX_WORKTREE_INCLUDED_PATHS
        ));
    }
    let canonical_repository = fs::canonicalize(repository)
        .map_err(|error| format!("Cannot resolve source Git repository: {error}"))?;
    let mut copied = 0_u32;
    let mut copied_bytes = 0_u64;
    for relative in candidates {
        if !source_path_is_ignored(repository, &relative)?
            || path_contains_symlink(repository, &relative)?
        {
            continue;
        }
        let source = repository.join(&relative);
        let source_metadata = fs::symlink_metadata(&source)
            .map_err(|error| format!("Cannot inspect worktree include source: {error}"))?;
        if !source_metadata.is_file() {
            continue;
        }
        let canonical_source = fs::canonicalize(&source)
            .map_err(|error| format!("Cannot resolve worktree include source: {error}"))?;
        if !canonical_source.starts_with(&canonical_repository) {
            return Err("Worktree include source escaped its repository".to_string());
        }
        copied_bytes = copied_bytes.saturating_add(source_metadata.len());
        if copied_bytes > MAX_WORKTREE_INCLUDED_BYTES {
            return Err(".worktreeinclude matched more than 64 MiB of files".to_string());
        }
        let destination = worktree_root.join(&relative);
        if destination.exists() || fs::symlink_metadata(&destination).is_ok() {
            continue;
        }
        ensure_safe_worktree_parent(worktree_root, &relative)?;
        let mut source_file = fs::File::open(&source)
            .map_err(|error| format!("Cannot open worktree include source: {error}"))?;
        let mut destination_file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&destination)
            .map_err(|error| format!("Cannot create worktree include destination: {error}"))?;
        if let Err(error) = std::io::copy(&mut source_file, &mut destination_file) {
            let _ = fs::remove_file(&destination);
            return Err(format!("Cannot copy worktree include file: {error}"));
        }
        fs::set_permissions(&destination, source_metadata.permissions())
            .map_err(|error| format!("Cannot preserve worktree include permissions: {error}"))?;
        copied += 1;
    }
    Ok(copied)
}

fn load_worktree_snapshot(
    repository: &Path,
    snapshot_dir: &Path,
    automation_id: &str,
    run_id: &str,
) -> Result<WorktreeSnapshotMetadata, String> {
    let bytes = fs::read(snapshot_dir.join("metadata.json"))
        .map_err(|error| format!("Cannot read recovery snapshot metadata: {error}"))?;
    let metadata: WorktreeSnapshotMetadata = serde_json::from_slice(&bytes)
        .map_err(|error| format!("Cannot parse recovery snapshot metadata: {error}"))?;
    let expected_ref = snapshot_ref(automation_id, run_id);
    if metadata.version != 1
        || metadata.run_id != run_id
        || metadata.snapshot_ref != expected_ref
        || !valid_commit_id(&metadata.base_commit)
        || !valid_commit_id(&metadata.snapshot_commit)
        || !safe_relative_path(Path::new(&metadata.relative_cwd))
    {
        return Err("Recovery snapshot metadata is invalid".to_string());
    }
    let repository = repository.to_string_lossy().to_string();
    let ref_commit = git_output(&[
        "-C",
        &repository,
        "rev-parse",
        &format!("{}^{{commit}}", metadata.snapshot_ref),
    ])?;
    let parent = git_output(&[
        "-C",
        &repository,
        "rev-parse",
        &format!("{}^", metadata.snapshot_commit),
    ])?;
    if ref_commit != metadata.snapshot_commit || parent != metadata.base_commit {
        return Err("Recovery snapshot Git ref does not match its metadata".to_string());
    }
    Ok(metadata)
}

fn create_worktree_snapshot(
    repository: &Path,
    worktree_root: &Path,
    snapshot_dir: &Path,
    automation_id: &str,
    run_id: &str,
    base_commit: &str,
    relative_cwd: &Path,
) -> Result<WorktreeSnapshotMetadata, String> {
    if !valid_commit_id(base_commit) || !safe_relative_path(relative_cwd) {
        return Err("Cannot snapshot an invalid worktree baseline or relative path".to_string());
    }
    if snapshot_dir.exists() {
        let metadata = load_worktree_snapshot(repository, snapshot_dir, automation_id, run_id)?;
        if metadata.base_commit == base_commit
            && metadata.relative_cwd == relative_cwd.to_string_lossy()
        {
            return Ok(metadata);
        }
        return Err("An incompatible recovery snapshot already exists for this run".to_string());
    }

    let reference = snapshot_ref(automation_id, run_id);
    let repository_text = repository.to_string_lossy().to_string();
    if git_output(&["-C", &repository_text, "rev-parse", "--verify", &reference]).is_ok() {
        return Err("Recovery snapshot ref exists without matching metadata".to_string());
    }
    let (changed_path_count, changed_bytes) = snapshot_change_budget(worktree_root, base_commit)?;
    let parent = snapshot_dir
        .parent()
        .ok_or_else(|| "Recovery snapshot has no parent directory".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Cannot create recovery snapshot storage: {error}"))?;
    let temp_dir = parent.join(format!(
        ".{}.tmp-{}",
        snapshot_dir
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("snapshot"),
        uuid::Uuid::new_v4()
    ));
    fs::create_dir(&temp_dir)
        .map_err(|error| format!("Cannot create recovery snapshot staging directory: {error}"))?;

    let result = (|| {
        let index_path = temp_dir.join("index");
        git_index_output(
            worktree_root,
            &index_path,
            &["read-tree", base_commit],
            false,
        )?;
        git_index_output(worktree_root, &index_path, &["add", "-A", "--", "."], false)?;
        let tree = git_index_output(worktree_root, &index_path, &["write-tree"], false)?;
        let message = format!("Black Box recovery snapshot for automation run {run_id}");
        let snapshot_commit = git_index_output(
            worktree_root,
            &index_path,
            &["commit-tree", &tree, "-p", base_commit, "-m", &message],
            true,
        )?;
        if !valid_commit_id(&snapshot_commit) {
            return Err("Git returned an invalid recovery snapshot commit".to_string());
        }
        fs::remove_file(&index_path)
            .map_err(|error| format!("Cannot finalize recovery snapshot index: {error}"))?;
        let metadata = WorktreeSnapshotMetadata {
            version: 1,
            run_id: run_id.to_string(),
            base_commit: base_commit.to_string(),
            snapshot_ref: reference.clone(),
            snapshot_commit: snapshot_commit.clone(),
            relative_cwd: relative_cwd.to_string_lossy().to_string(),
            created_at: now_ms(),
            changed_path_count,
            changed_bytes,
        };
        fs::write(
            temp_dir.join("metadata.json"),
            serde_json::to_vec_pretty(&metadata).map_err(|error| error.to_string())?,
        )
        .map_err(|error| format!("Cannot write recovery snapshot metadata: {error}"))?;
        git_output(&[
            "-C",
            &repository_text,
            "update-ref",
            &reference,
            &snapshot_commit,
        ])?;
        if let Err(error) = fs::rename(&temp_dir, snapshot_dir) {
            let _ = git_output(&[
                "-C",
                &repository_text,
                "update-ref",
                "-d",
                &reference,
                &snapshot_commit,
            ]);
            return Err(format!(
                "Cannot publish recovery snapshot metadata: {error}"
            ));
        }
        Ok(metadata)
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&temp_dir);
    }
    result
}

fn restore_worktree_snapshot(
    repository: &Path,
    expected_root: &Path,
    snapshot_dir: &Path,
    automation_id: &str,
    run_id: &str,
) -> Result<(PathBuf, WorktreeSnapshotMetadata), String> {
    if expected_root.exists() {
        return Err("Cannot restore because the managed worktree path already exists".to_string());
    }
    let metadata = load_worktree_snapshot(repository, snapshot_dir, automation_id, run_id)?;
    let parent = expected_root
        .parent()
        .ok_or_else(|| "Managed worktree has no parent directory".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Cannot create managed worktree storage: {error}"))?;
    let repository_text = repository.to_string_lossy().to_string();
    let expected_text = expected_root.to_string_lossy().to_string();
    let _ = git_output(&["-C", &repository_text, "worktree", "prune"]);
    git_output(&[
        "-C",
        &repository_text,
        "worktree",
        "add",
        "--detach",
        &expected_text,
        &metadata.snapshot_commit,
    ])
    .map_err(|error| format!("Cannot restore managed worktree: {error}"))?;
    if let Err(error) = validate_worktree_git_identity(repository, expected_root) {
        let _ = git_output(&[
            "-C",
            &repository_text,
            "worktree",
            "remove",
            "--force",
            &expected_text,
        ]);
        return Err(error);
    }
    if let Err(error) = copy_worktree_included_files(repository, expected_root) {
        let _ = git_output(&[
            "-C",
            &repository_text,
            "worktree",
            "remove",
            "--force",
            &expected_text,
        ]);
        return Err(format!(
            "Cannot restore .worktreeinclude files into managed worktree: {error}"
        ));
    }
    let restored_cwd = expected_root.join(&metadata.relative_cwd);
    let execution_cwd = if restored_cwd.is_dir() {
        match validate_managed_execution_cwd(expected_root, &restored_cwd) {
            Ok(_) => restored_cwd,
            Err(error) => {
                let _ = git_output(&[
                    "-C",
                    &repository_text,
                    "worktree",
                    "remove",
                    "--force",
                    &expected_text,
                ]);
                return Err(error);
            }
        }
    } else {
        expected_root.to_path_buf()
    };
    Ok((execution_cwd, metadata))
}

fn prepare_execution_directory(
    definition: &AutomationDefinition,
    run_id: &str,
) -> Result<AutomationExecutionDirectory, String> {
    if definition.kind == "heartbeat" {
        let source_cwd = definition
            .cwds
            .first()
            .map(PathBuf::from)
            .unwrap_or_else(|| dirs::home_dir().unwrap_or_else(|| PathBuf::from("/")));
        return Ok(AutomationExecutionDirectory {
            execution_cwd: source_cwd.clone(),
            source_cwd,
            base_commit: None,
            source_head_commit: None,
            worktree_input_snapshot_ref: None,
            worktree_input_snapshot_at: None,
            worktree_included_files: None,
        });
    }
    let source_cwd = PathBuf::from(project_directory(definition)?);
    if definition
        .execution_environment
        .as_deref()
        .unwrap_or("local")
        != "worktree"
    {
        return Ok(AutomationExecutionDirectory {
            execution_cwd: source_cwd.clone(),
            source_cwd,
            base_commit: None,
            source_head_commit: None,
            worktree_input_snapshot_ref: None,
            worktree_input_snapshot_at: None,
            worktree_included_files: None,
        });
    }

    let source_cwd = fs::canonicalize(&source_cwd)
        .map_err(|error| format!("Cannot resolve worktree source: {error}"))?;
    let source_text = source_cwd.to_string_lossy().to_string();
    let repository_text = git_output(&["-C", &source_text, "rev-parse", "--show-toplevel"])
        .map_err(|error| format!("Worktree mode requires a Git repository: {error}"))?;
    let repository = fs::canonicalize(&repository_text)
        .map_err(|error| format!("Cannot resolve Git repository root: {error}"))?;
    let relative_cwd = source_cwd
        .strip_prefix(&repository)
        .map(Path::to_path_buf)
        .map_err(|_| {
            "The selected project directory is outside its Git repository root".to_string()
        })?;

    let worktree_parent = automation_data_dir()?
        .join("worktrees")
        .join(sanitize_id(&definition.id));
    fs::create_dir_all(&worktree_parent)
        .map_err(|error| format!("Cannot create worktree storage: {error}"))?;
    let worktree_root = worktree_parent.join(sanitize_id(run_id));
    let repository_text = repository.to_string_lossy().to_string();
    let source_head_commit = git_output(&["-C", &repository_text, "rev-parse", "HEAD"])
        .map_err(|error| format!("Cannot record worktree starting commit: {error}"))?;
    let input_snapshot_dir = automation_data_dir()?
        .join("worktree-inputs")
        .join(sanitize_id(&definition.id))
        .join(sanitize_id(run_id));
    let input_snapshot = create_worktree_input_snapshot(
        &repository,
        &input_snapshot_dir,
        &definition.id,
        run_id,
        &source_head_commit,
    )
    .map_err(|error| format!("Cannot capture worktree inputs: {error}"))?;
    let worktree_text = worktree_root.to_string_lossy().to_string();
    if let Err(error) = git_output(&[
        "-C",
        &repository_text,
        "worktree",
        "add",
        "--detach",
        &worktree_text,
        &input_snapshot.base_commit,
    ]) {
        remove_worktree_input_snapshot(&repository, &input_snapshot_dir, &input_snapshot);
        let _ = fs::remove_dir_all(&worktree_root);
        return Err(format!("Cannot create isolated Git worktree: {error}"));
    }
    let included_files = match copy_worktree_included_files(&repository, &worktree_root) {
        Ok(count) => count,
        Err(error) => {
            let _ = git_output(&[
                "-C",
                &repository_text,
                "worktree",
                "remove",
                "--force",
                &worktree_text,
            ]);
            remove_worktree_input_snapshot(&repository, &input_snapshot_dir, &input_snapshot);
            return Err(format!("Cannot copy .worktreeinclude files: {error}"));
        }
    };
    let execution_cwd = worktree_root.join(&relative_cwd);
    if !execution_cwd.is_dir() {
        let _ = git_output(&[
            "-C",
            &repository_text,
            "worktree",
            "remove",
            "--force",
            &worktree_text,
        ]);
        remove_worktree_input_snapshot(&repository, &input_snapshot_dir, &input_snapshot);
        return Err("Selected project subdirectory is absent from the worktree inputs".to_string());
    }

    Ok(AutomationExecutionDirectory {
        source_cwd,
        execution_cwd,
        base_commit: Some(input_snapshot.base_commit),
        source_head_commit: Some(input_snapshot.source_head_commit),
        worktree_input_snapshot_ref: input_snapshot.input_snapshot_ref,
        worktree_input_snapshot_at: input_snapshot.input_snapshot_at,
        worktree_included_files: Some(included_files),
    })
}

fn rollback_prepared_execution_directory(
    definition: &AutomationDefinition,
    run_id: &str,
    directory: &AutomationExecutionDirectory,
) -> Result<(), String> {
    if directory.base_commit.is_none() || directory.execution_cwd == directory.source_cwd {
        return Ok(());
    }
    let source = directory.source_cwd.to_string_lossy().to_string();
    let repository = PathBuf::from(git_output(&[
        "-C",
        &source,
        "rev-parse",
        "--show-toplevel",
    ])?);
    let repository = fs::canonicalize(repository)
        .map_err(|error| format!("Cannot resolve source Git repository: {error}"))?;
    let worktree_root = automation_data_dir()?
        .join("worktrees")
        .join(sanitize_id(&definition.id))
        .join(sanitize_id(run_id));
    if worktree_root.exists() {
        let repository_text = repository.to_string_lossy().to_string();
        let worktree_text = worktree_root.to_string_lossy().to_string();
        git_output(&[
            "-C",
            &repository_text,
            "worktree",
            "remove",
            "--force",
            &worktree_text,
        ])?;
    }
    if let Some(reference) = directory.worktree_input_snapshot_ref.as_deref() {
        let repository_text = repository.to_string_lossy().to_string();
        let _ = git_output(&["-C", &repository_text, "update-ref", "-d", reference]);
        let input_snapshot_dir = automation_data_dir()?
            .join("worktree-inputs")
            .join(sanitize_id(&definition.id))
            .join(sanitize_id(run_id));
        let _ = fs::remove_dir_all(input_snapshot_dir);
    }
    Ok(())
}

fn split_native_skill_invocation(prompt: &str) -> Option<(String, String)> {
    let trimmed = prompt.trim_start();
    let skill_start = if trimmed.starts_with('/') {
        1
    } else if trimmed.starts_with("Use $") {
        "Use $".len()
    } else {
        return None;
    };
    let skill_len = trimmed[skill_start..]
        .chars()
        .take_while(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
        .map(char::len_utf8)
        .sum::<usize>();
    if skill_len == 0 {
        return None;
    }
    let skill_end = skill_start + skill_len;
    let next = trimmed[skill_end..].chars().next();
    if next.is_some_and(|character| !character.is_whitespace()) {
        return None;
    }
    Some((
        format!("/{}", &trimmed[skill_start..skill_end]),
        trimmed[skill_end..].trim_start().to_string(),
    ))
}

fn prepend_native_skill_invocation(invocation: Option<String>, body: String) -> String {
    match invocation {
        Some(invocation) => format!("{invocation}\n\n{body}"),
        None => body,
    }
}

fn automation_prompt(
    definition: &AutomationDefinition,
    scheduled_at: Option<i64>,
) -> Result<String, String> {
    let (native_skill_invocation, prompt) = split_native_skill_invocation(&definition.prompt)
        .map(|(invocation, prompt)| (Some(invocation), prompt))
        .unwrap_or_else(|| (None, definition.prompt.clone()));
    let team_contract = if definition.agent_teams_enabled {
        "\n<agent_teams_authorization>Agent Teams is explicitly authorized for this run. Use teammates only when parallel, independently scoped work materially helps; spawn at most 3 teammates, wait for them to finish, keep the shared task list accurate, and synthesize their results before returning. Do not use legacy TeamCreate or TeamDelete tools.</agent_teams_authorization>"
    } else {
        ""
    };
    if definition.kind == "heartbeat" {
        return Ok(prepend_native_skill_invocation(native_skill_invocation, format!(
            "<heartbeat>\n  <automation_id>{}</automation_id>\n  <current_time_iso>{}</current_time_iso>\n  <instructions>\n{}\n  </instructions>\n</heartbeat>{}",
            definition.id,
            Utc::now().to_rfc3339(),
            prompt,
            team_contract,
        )));
    }
    let memory = memory_path(&definition.id)?;
    let memory_text = if memory.is_file() {
        fs::read_to_string(&memory).unwrap_or_default()
    } else {
        String::new()
    };
    let result_contract = "\n<automation_result_contract>Before the control directive, write a self-contained user-facing report in plain language. Lead with what happened and its practical impact. When a decision is required, add one clearly named decision at a time, the recommended option and reason, what approval versus rejection changes, and the shortest reply the user can send. Put internal status codes, field names, locks, hashes, receipts, stages, commands, and paths in a final technical-evidence section; explain any unavoidable term on first use. Titles and directive summaries must be understandable without source code or an internal glossary. Never return a directive by itself. If every required step completes and no user action is required, end with ::inbox-item{title=\"short plain-language title\" summary=\"short factual outcome\"} on its own final line. If every required step completes but an explicit user decision or follow-up action is required, end with ::automation-needs-attention{title=\"short plain-language decision title\" summary=\"the exact decision or next action\"} on its own final line. If any required step is blocked, skipped, rejected, or fails, state the stopping point, any effects already made, and the recovery entrypoint, then end with ::automation-failed{summary=\"short factual reason\"} on its own final line. Do not emit a success or needs-attention directive for incomplete work.</automation_result_contract>";
    Ok(prepend_native_skill_invocation(native_skill_invocation, format!(
        "Automation: {name}\nAutomation ID: {id}\nAutomation memory: {memory}\nScheduled at: {scheduled}\n\n{prompt}\n\n{memory_block}{team_contract}{result_contract}",
        name = definition.name,
        id = definition.id,
        memory = memory.display(),
        scheduled = scheduled_at
            .and_then(|value| local_from_ms(value).ok())
            .map(|value| value.to_rfc3339())
            .unwrap_or_else(|| "manual".to_string()),
        prompt = prompt,
        memory_block = if memory_text.is_empty() {
            "The automation memory file does not exist yet. Create or update it only when a compact durable note will help the next run.".to_string()
        } else {
            format!("Existing automation memory:\n{memory_text}")
        },
        team_contract = team_contract,
        result_contract = result_contract,
    )))
}

const AUTOMATION_COMPLETION_RECOVERY_LIMIT: usize = 3;
const AUTOMATION_STALL_RECOVERY_LIMIT: usize = 2;

fn automation_completion_recovery_prompt(
    definition: &AutomationDefinition,
    attempt: usize,
) -> String {
    format!(
        "<automation_completion_recovery>\nRecovery attempt {attempt}/{limit}. The scheduled run for automation {id} returned control before producing a trustworthy terminal result. Resume the SAME durable session. Inspect the completed Agent/subagent results and any durable receipts already written by this run, finish any remaining required steps, and synthesize one final result. Do not repeat completed work, do not end with progress narration, and do not claim success from intent alone. Write a self-contained plain-language report: outcome and impact first; when a decision remains, state the exact question, recommended option and reason, approval/rejection consequences, and shortest reply; put internal codes and technical evidence last. Then emit exactly one final directive: ::inbox-item{{title=\"short plain-language title\" summary=\"short factual outcome\"}}, ::automation-needs-attention{{title=\"short plain-language decision title\" summary=\"the exact decision or next action\"}}, or ::automation-failed{{summary=\"short factual reason\"}}. Never return a directive by itself, and never use success or needs-attention for incomplete work.\n</automation_completion_recovery>",
        id = definition.id,
        limit = AUTOMATION_COMPLETION_RECOVERY_LIMIT,
    )
}

fn automation_stall_recovery_prompt(definition: &AutomationDefinition, attempt: usize) -> String {
    format!(
        "<automation_stall_recovery>\nBlack Box stopped the previous Claude CLI invocation after {idle_seconds} seconds without a stream event. Recovery attempt {attempt}/{limit}. Resume the SAME durable session for automation {id}. Treat unresolved tool calls from the interrupted invocation as indeterminate: inspect durable receipts and filesystem state before acting, preserve completed work, and do not blindly relaunch the same stalled Agent call. Prefer bounded direct reads or local commands when they can recover the missing evidence. Finish the remaining work and write a self-contained user-facing completion report before exactly one final directive: ::inbox-item{{title=\"short title\" summary=\"short factual summary\"}}, ::automation-needs-attention{{title=\"short title\" summary=\"short factual next action\"}}, or ::automation-failed{{summary=\"short factual reason\"}}. If state cannot be established safely, fail visibly instead of waiting indefinitely.\n</automation_stall_recovery>",
        idle_seconds = automation_inactivity_timeout().as_secs(),
        id = definition.id,
        limit = AUTOMATION_STALL_RECOVERY_LIMIT,
    )
}

fn parse_stream_execution(stdout: &str) -> Result<AutomationExecution, AutomationExecutionError> {
    #[derive(Clone)]
    struct ToolContext {
        name: String,
        parent_tool_use_id: Option<String>,
        agent_id: Option<String>,
        agent_type: Option<String>,
        agent_kind: Option<String>,
        agent_depth: u32,
    }

    fn event_string(event: &Value, keys: &[&str]) -> Option<String> {
        keys.iter()
            .find_map(|key| event.get(*key).and_then(Value::as_str))
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    }

    let mut trace = Vec::new();
    let mut tool_contexts = HashMap::<String, ToolContext>::new();
    let mut agent_depths = HashMap::<String, u32>::new();
    let mut agent_types = HashMap::<String, String>::new();
    let mut agent_kinds = HashMap::<String, String>::new();
    let mut final_output = None;
    let mut final_error = None;
    let mut session_id = None;
    let mut last_main_assistant_event = None;
    let mut last_agent_completion_event = None;

    for (event_index, line) in stdout
        .lines()
        .filter(|line| !line.trim().is_empty())
        .enumerate()
    {
        let event_position = event_index as u64 + 1;
        let Ok(event) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if session_id.is_none() {
            session_id = event_string(&event, &["session_id", "sessionId"]);
        }
        match event.get("type").and_then(Value::as_str) {
            Some("assistant") => {
                let parent_tool_use_id = event_string(&event, &["parent_tool_use_id"]);
                let event_agent_id = event_string(&event, &["agent_id", "agentId"]);
                let agent_depth = parent_tool_use_id
                    .as_ref()
                    .and_then(|id| agent_depths.get(id))
                    .copied()
                    .unwrap_or(u32::from(parent_tool_use_id.is_some()));
                let inherited_agent_type = parent_tool_use_id
                    .as_ref()
                    .and_then(|id| agent_types.get(id))
                    .cloned();
                let inherited_agent_kind = parent_tool_use_id
                    .as_ref()
                    .and_then(|id| agent_kinds.get(id))
                    .cloned();
                let blocks = event
                    .get("message")
                    .and_then(|message| message.get("content"))
                    .and_then(Value::as_array);
                let has_visible_text = blocks
                    .map(|items| {
                        items.iter().any(|block| {
                            block.get("type").and_then(Value::as_str) == Some("text")
                                && block
                                    .get("text")
                                    .and_then(Value::as_str)
                                    .is_some_and(|text| !text.trim().is_empty())
                        })
                    })
                    .unwrap_or(false);
                if parent_tool_use_id.is_none() && has_visible_text {
                    last_main_assistant_event = Some(event_position);
                }
                for block in blocks.into_iter().flatten() {
                    if block.get("type").and_then(Value::as_str) != Some("tool_use") {
                        continue;
                    }
                    let name = block
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or("Unknown")
                        .to_string();
                    let tool_use_id = block.get("id").and_then(Value::as_str).map(str::to_string);
                    let explicit_agent_type = block
                        .get("input")
                        .and_then(|input| input.get("subagent_type"))
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .map(|value| value.chars().take(200).collect::<String>());
                    let teammate_name = block
                        .get("input")
                        .and_then(|input| input.get("name"))
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .map(|value| value.chars().take(200).collect::<String>());
                    let agent_type = explicit_agent_type
                        .or_else(|| teammate_name.clone())
                        .or_else(|| inherited_agent_type.clone());
                    let agent_kind = if matches!(name.as_str(), "Agent" | "Task") {
                        Some(if teammate_name.is_some() {
                            "teammate".to_string()
                        } else {
                            "subagent".to_string()
                        })
                    } else {
                        inherited_agent_kind.clone()
                    };
                    if let Some(ref id) = tool_use_id {
                        tool_contexts.insert(
                            id.clone(),
                            ToolContext {
                                name: name.clone(),
                                parent_tool_use_id: parent_tool_use_id.clone(),
                                agent_id: event_agent_id.clone(),
                                agent_type: agent_type.clone(),
                                agent_kind: agent_kind.clone(),
                                agent_depth,
                            },
                        );
                        if matches!(name.as_str(), "Agent" | "Task") {
                            agent_depths.insert(id.clone(), agent_depth + 1);
                            if let Some(ref agent_type) = agent_type {
                                agent_types.insert(id.clone(), agent_type.clone());
                            }
                            if let Some(ref agent_kind) = agent_kind {
                                agent_kinds.insert(id.clone(), agent_kind.clone());
                            }
                        }
                    }
                    let input_fields = block
                        .get("input")
                        .and_then(Value::as_object)
                        .map(|input| {
                            let mut keys = input.keys().cloned().collect::<Vec<_>>();
                            keys.sort();
                            keys.join(", ")
                        })
                        .filter(|keys| !keys.is_empty());
                    trace.push(AutomationTraceEvent {
                        sequence: trace.len() as u32 + 1,
                        event_type: "tool_use".to_string(),
                        tool_name: Some(name),
                        tool_use_id,
                        parent_tool_use_id: parent_tool_use_id.clone(),
                        agent_id: event_agent_id.clone(),
                        agent_type,
                        agent_kind,
                        agent_depth: Some(agent_depth),
                        summary: input_fields
                            .map(|keys| format!("Input fields: {keys}"))
                            .unwrap_or_else(|| "Started".to_string()),
                    });
                }
            }
            Some("user") => {
                let event_parent = event_string(&event, &["parent_tool_use_id"]);
                let event_agent_id = event_string(&event, &["agent_id", "agentId"]);
                let blocks = event
                    .get("message")
                    .and_then(|message| message.get("content"))
                    .and_then(Value::as_array);
                for block in blocks.into_iter().flatten() {
                    if block.get("type").and_then(Value::as_str) != Some("tool_result") {
                        continue;
                    }
                    let tool_use_id = block
                        .get("tool_use_id")
                        .and_then(Value::as_str)
                        .map(str::to_string);
                    let context = tool_use_id
                        .as_ref()
                        .and_then(|id| tool_contexts.get(id))
                        .cloned();
                    let is_error = block
                        .get("is_error")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    trace.push(AutomationTraceEvent {
                        sequence: trace.len() as u32 + 1,
                        event_type: "tool_result".to_string(),
                        tool_name: context.as_ref().map(|value| value.name.clone()),
                        tool_use_id,
                        parent_tool_use_id: event_parent.clone().or_else(|| {
                            context
                                .as_ref()
                                .and_then(|value| value.parent_tool_use_id.clone())
                        }),
                        agent_id: event_agent_id
                            .clone()
                            .or_else(|| context.as_ref().and_then(|value| value.agent_id.clone())),
                        agent_type: context.as_ref().and_then(|value| value.agent_type.clone()),
                        agent_kind: context.as_ref().and_then(|value| value.agent_kind.clone()),
                        agent_depth: context.as_ref().map(|value| value.agent_depth),
                        summary: if is_error { "Failed" } else { "Completed" }.to_string(),
                    });
                }
            }
            Some("system") => {
                let subtype = event.get("subtype").and_then(Value::as_str).unwrap_or("");
                if subtype == "task_started" || subtype == "task_notification" {
                    let parent_tool_use_id = event_string(&event, &["tool_use_id"]);
                    let is_agent_lifecycle = parent_tool_use_id
                        .as_ref()
                        .is_some_and(|id| agent_kinds.contains_key(id));
                    // Claude can emit the same background-task system events
                    // for SendMessage and other asynchronous tools. Only an
                    // Agent/Task launch registered above belongs in the agent
                    // lifecycle; otherwise the UI would show ghost agents.
                    if !is_agent_lifecycle {
                        continue;
                    }
                    let agent_id = event_string(&event, &["task_id"]);
                    let recorded_agent_type = parent_tool_use_id
                        .as_ref()
                        .and_then(|id| agent_types.get(id))
                        .cloned();
                    let runtime_agent_type = event_string(&event, &["subagent_type"])
                        .map(|value| value.chars().take(200).collect::<String>())
                        .filter(|value| !value.is_empty());
                    let agent_kind = parent_tool_use_id
                        .as_ref()
                        .and_then(|id| agent_kinds.get(id))
                        .cloned();
                    // For a named teammate, the stable product identity is the
                    // Agent(name) value. The runtime's `general-purpose`
                    // subagent type is an implementation detail, not its name.
                    let agent_type = if agent_kind.as_deref() == Some("teammate") {
                        recorded_agent_type.or(runtime_agent_type)
                    } else {
                        runtime_agent_type.or(recorded_agent_type)
                    };
                    let agent_depth = parent_tool_use_id
                        .as_ref()
                        .and_then(|id| agent_depths.get(id))
                        .copied()
                        .unwrap_or(1);
                    if subtype == "task_started" {
                        if let Some(ref parent) = parent_tool_use_id {
                            agent_depths.insert(parent.clone(), agent_depth);
                            if let Some(ref agent_type) = agent_type {
                                agent_types.insert(parent.clone(), agent_type.clone());
                            }
                            if let Some(ref agent_kind) = agent_kind {
                                agent_kinds.insert(parent.clone(), agent_kind.clone());
                            }
                        }
                    } else {
                        last_agent_completion_event = Some(event_position);
                    }
                    let status = event.get("status").and_then(Value::as_str).unwrap_or(
                        if subtype == "task_started" {
                            "Started"
                        } else {
                            "Completed"
                        },
                    );
                    trace.push(AutomationTraceEvent {
                        sequence: trace.len() as u32 + 1,
                        event_type: if subtype == "task_started" {
                            "agent_start".to_string()
                        } else {
                            "agent_result".to_string()
                        },
                        tool_name: Some("Agent".to_string()),
                        tool_use_id: parent_tool_use_id.clone(),
                        parent_tool_use_id,
                        agent_id,
                        agent_type,
                        agent_kind,
                        agent_depth: Some(agent_depth),
                        summary: if status.eq_ignore_ascii_case("failed")
                            || status.eq_ignore_ascii_case("error")
                        {
                            "Failed".to_string()
                        } else if subtype == "task_started" {
                            "Started".to_string()
                        } else {
                            "Completed".to_string()
                        },
                    });
                }
            }
            Some("result") => {
                let parent_tool_use_id = event_string(&event, &["parent_tool_use_id"]);
                if parent_tool_use_id.is_some() {
                    last_agent_completion_event = Some(event_position);
                    let result_agent_type = parent_tool_use_id
                        .as_ref()
                        .and_then(|id| agent_types.get(id))
                        .cloned();
                    let result_agent_kind = parent_tool_use_id
                        .as_ref()
                        .and_then(|id| agent_kinds.get(id))
                        .cloned();
                    trace.push(AutomationTraceEvent {
                        sequence: trace.len() as u32 + 1,
                        event_type: "agent_result".to_string(),
                        tool_name: Some("Agent".to_string()),
                        tool_use_id: parent_tool_use_id.clone(),
                        parent_tool_use_id,
                        agent_id: event_string(&event, &["agent_id", "agentId"]),
                        agent_type: result_agent_type,
                        agent_kind: result_agent_kind,
                        agent_depth: Some(1),
                        summary: if event
                            .get("is_error")
                            .and_then(Value::as_bool)
                            .unwrap_or(false)
                        {
                            "Failed".to_string()
                        } else {
                            "Completed".to_string()
                        },
                    });
                    continue;
                }
                let result = event
                    .get("result")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim()
                    .to_string();
                if event
                    .get("is_error")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                {
                    final_error = Some(if result.is_empty() {
                        "Claude reported an error".to_string()
                    } else {
                        result
                    });
                } else {
                    final_output = Some(result);
                }
            }
            _ => {}
        }
    }

    if let Some(message) = final_error {
        return Err(AutomationExecutionError {
            message,
            trace,
            output: String::new(),
            recoverable_stall: false,
        });
    }
    match final_output {
        Some(output) => Ok(AutomationExecution {
            output,
            trace,
            session_id,
            last_main_assistant_event,
            last_agent_completion_event,
        }),
        None => Err(AutomationExecutionError {
            message: "Claude stream ended without a result event".to_string(),
            trace,
            output: String::new(),
            recoverable_stall: false,
        }),
    }
}

fn automation_session_target(
    definition: &AutomationDefinition,
    run_id: &str,
) -> Result<AutomationSessionTarget, String> {
    if definition.kind == "cron" {
        let parsed = uuid::Uuid::parse_str(run_id).map_err(|_| {
            "Scheduled run ID cannot be used as a durable Claude session ID".to_string()
        })?;
        if parsed.is_nil() {
            return Err("Scheduled run ID cannot be a nil Claude session ID".to_string());
        }
        return Ok(AutomationSessionTarget {
            session_id: run_id.to_string(),
            arguments: vec!["--session-id".to_string(), run_id.to_string()],
            creates_new_session: true,
        });
    }
    let session_id = definition
        .target_thread_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Heartbeat automation has no durable target session".to_string())?
        .to_string();
    Ok(AutomationSessionTarget {
        arguments: vec!["--resume".to_string(), session_id.clone()],
        session_id,
        creates_new_session: false,
    })
}

fn automation_trigger(scheduled_at: Option<i64>) -> &'static str {
    if scheduled_at.is_some() {
        "scheduled"
    } else {
        "manual"
    }
}

async fn invoke_claude(
    definition: &AutomationDefinition,
    scheduled_at: Option<i64>,
    run_id: &str,
    execution_cwd: &Path,
    session_target: &AutomationSessionTarget,
    prompt_override: Option<&str>,
) -> Result<AutomationExecution, AutomationExecutionError> {
    // Scheduled runs use the exact SDK execution kernel selected for ordinary
    // conversations. A second PATH resolver can silently launch another
    // Claude build with different protocol capabilities.
    let claude_bin = crate::resolve_claude_sdk_runtime()
        .map_err(AutomationExecutionError::new)?
        .path;
    let (provider_id, model, _auxiliary_model, auxiliary_model_tier) =
        resolve_provider_and_models(definition)?;
    let provider_id = provider_id.ok_or_else(|| {
        AutomationExecutionError::new(
            "Scheduled tasks require a credentialed default API in Default system configuration",
        )
    })?;
    let (mut provider_env, mut provider_remove, provider_args, _caps) =
        crate::resolve_provider_env(Some(provider_id.as_str()))?;
    crate::apply_provider_model_aliases(Some(provider_id.as_str()), &mut provider_env)?;
    let _provider_gateway_guard =
        crate::route_provider_through_gateway(Some(provider_id.as_str()), &mut provider_env)
            .await?;
    crate::enforce_provider_loopback_child_env(
        Some(provider_id.as_str()),
        &mut provider_env,
        &mut provider_remove,
    );
    let prompt = match prompt_override {
        Some(prompt) => prompt.to_string(),
        None => automation_prompt(definition, scheduled_at)?,
    };
    let data_dir = automation_data_dir().map_err(AutomationExecutionError::new)?;
    let additional_write_paths = prepare_automation_write_paths(definition, &data_dir)
        .map_err(AutomationExecutionError::new)?;
    let mut args = vec![
        "-p".to_string(),
        prompt,
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--verbose".to_string(),
        "--model".to_string(),
        model.clone(),
        "--permission-mode".to_string(),
        "dontAsk".to_string(),
        "--no-chrome".to_string(),
        "--strict-mcp-config".to_string(),
        "--tools".to_string(),
        "default".to_string(),
        "--max-turns".to_string(),
        "240".to_string(),
    ];
    for path in &additional_write_paths {
        args.push("--add-dir".to_string());
        args.push(path.to_string_lossy().to_string());
    }
    args.extend(session_target.arguments.clone());
    if let Some(effort) = &definition.reasoning_effort {
        args.push("--effort".to_string());
        args.push(effort.clone());
    }
    args.extend(provider_args);
    // Every ordinary Agent/subagent and every Agent Teams teammate uses the
    // task's selected auxiliary tier, even when Agent Teams itself is disabled.
    provider_env.insert(
        "CLAUDE_CODE_SUBAGENT_MODEL".to_string(),
        auxiliary_model_tier.clone(),
    );
    if definition.agent_teams_enabled {
        crate::ensure_agent_teams_supported(&claude_bin, &crate::build_enriched_path()).await?;
        args.push("--teammate-mode".to_string());
        args.push("in-process".to_string());
        provider_env.insert(
            "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS".to_string(),
            "1".to_string(),
        );
        provider_env.remove("CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS");
        if !provider_remove
            .iter()
            .any(|key| key == "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS")
        {
            provider_remove.push("CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS".to_string());
        }
    }

    // Scheduled work uses the same explicitly configured MCP servers as a
    // normal Black Box session. Strict mode still excludes every implicit or
    // unapproved server; the scratch file contains only the user's saved set.
    let mcp_scratch_id = format!("automation-{run_id}");
    let mcp_source_cwd = project_directory(definition).ok();
    let mcp_cwd = mcp_source_cwd
        .as_deref()
        .map(Path::new)
        .unwrap_or(execution_cwd);
    let mcp_scratch_path = crate::build_mcp_scratch_config(&mcp_scratch_id, mcp_cwd);
    if let Some(ref scratch) = mcp_scratch_path {
        args.push("--mcp-config".to_string());
        args.push(scratch.to_string_lossy().to_string());
    }
    let mut allowed_tools = vec![
        "Read".to_string(),
        "Write".to_string(),
        "Edit".to_string(),
        "Bash".to_string(),
        "WebSearch".to_string(),
        "WebFetch".to_string(),
        "Skill".to_string(),
        "Agent".to_string(),
    ];
    if definition.agent_teams_enabled {
        allowed_tools.extend(
            [
                "SendMessage",
                "TaskCreate",
                "TaskGet",
                "TaskList",
                "TaskUpdate",
                "TaskStop",
            ]
            .into_iter()
            .map(str::to_string),
        );
    }
    if let Some(ref scratch) = mcp_scratch_path {
        allowed_tools.extend(mcp_permission_rules(scratch));
    }
    args.push("--allowedTools".to_string());
    args.push(allowed_tools.join(","));
    let security_settings_path = match build_automation_security_settings(
        run_id,
        &auxiliary_model_tier,
        &additional_write_paths,
    ) {
        Ok(path) => path,
        Err(error) => {
            crate::cleanup_mcp_scratch_config(&mcp_scratch_id);
            return Err(AutomationExecutionError::new(error));
        }
    };
    args.push("--settings".to_string());
    args.push(security_settings_path.to_string_lossy().to_string());

    let env_config = crate::env_manager::ClaudeEnvConfig {
        auth_mode: crate::env_manager::AuthMode::ThirdParty,
        enriched_path: Some(crate::build_enriched_path()),
        extra: provider_env,
        extra_remove: provider_remove,
    };
    let mut command = Command::new(claude_bin);
    crate::client_runtime::apply_to_tokio_command(&mut command)
        .map_err(AutomationExecutionError::new)?;
    command
        .args(args)
        .current_dir(execution_cwd)
        .env("BLACKBOX_AUTOMATION_ID", &definition.id)
        .env("BLACKBOX_AUTOMATION_RUN_ID", run_id)
        .env(
            "BLACKBOX_AUTOMATION_TRIGGER",
            automation_trigger(scheduled_at),
        )
        .env_remove("CLAUDECODE")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command.kill_on_drop(true);
    isolate_automation_process_group(&mut command);
    crate::env_manager::apply_to_command(&mut command, &env_config);
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            crate::cleanup_mcp_scratch_config(&mcp_scratch_id);
            cleanup_automation_security_settings(&security_settings_path);
            return Err(AutomationExecutionError::new(format!(
                "Cannot start Claude CLI: {error}"
            )));
        }
    };
    let mut stdout_reader = child.stdout.take();
    let mut stderr_reader = child.stderr.take();
    let (stdout_activity_sender, stdout_activity_receiver) = mpsc::channel(1);
    let mut stdout_task = tokio::spawn(async move {
        let mut bytes = Vec::new();
        if let Some(ref mut reader) = stdout_reader {
            let mut buffer = [0_u8; 16 * 1024];
            loop {
                let read = reader.read(&mut buffer).await?;
                if read == 0 {
                    break;
                }
                bytes.extend_from_slice(&buffer[..read]);
                let _ = stdout_activity_sender.try_send(());
            }
        }
        Ok::<Vec<u8>, std::io::Error>(bytes)
    });
    let mut stderr_task = tokio::spawn(async move {
        let mut bytes = Vec::new();
        if let Some(ref mut reader) = stderr_reader {
            reader.read_to_end(&mut bytes).await?;
        }
        Ok::<Vec<u8>, std::io::Error>(bytes)
    });
    let (cancel_sender, cancel_receiver) = oneshot::channel();
    let registry_ready = run_cancellations()
        .lock()
        .map(|mut registry| {
            if registry.contains_key(run_id) {
                false
            } else {
                registry.insert(run_id.to_string(), cancel_sender);
                true
            }
        })
        .unwrap_or(false);
    if !registry_ready {
        let _ = child.kill().await;
        let _ = child.wait().await;
        crate::cleanup_mcp_scratch_config(&mcp_scratch_id);
        cleanup_automation_security_settings(&security_settings_path);
        return Err(AutomationExecutionError::new(
            "Cannot register automation cancellation handle",
        ));
    }

    let wait_result = wait_for_automation_child(
        &mut child,
        cancel_receiver,
        stdout_activity_receiver,
        automation_timeout(),
        automation_inactivity_timeout(),
    )
    .await;
    if let Ok(mut registry) = run_cancellations().lock() {
        registry.remove(run_id);
    }
    let pipe_drain_timeout = Duration::from_secs(DEFAULT_AUTOMATION_PIPE_DRAIN_TIMEOUT_SECS);
    let (stdout, stderr) = tokio::join!(
        collect_automation_pipe(&mut stdout_task, pipe_drain_timeout),
        collect_automation_pipe(&mut stderr_task, pipe_drain_timeout),
    );
    crate::cleanup_mcp_scratch_config(&mcp_scratch_id);
    cleanup_automation_security_settings(&security_settings_path);
    let stdout = String::from_utf8_lossy(&stdout).to_string();
    let stderr = String::from_utf8_lossy(&stderr).to_string();
    let parsed = parse_stream_execution(&stdout);
    let status = match wait_result {
        Ok(status) => status,
        Err(failure) => {
            let (output, trace) = match parsed {
                Ok(execution) => (execution.output, execution.trace),
                Err(error) => (error.output, error.trace),
            };
            return Err(AutomationExecutionError {
                message: failure.message(),
                trace,
                output,
                recoverable_stall: failure.is_recoverable_stall(),
            });
        }
    };
    if !status.success() {
        let (output, trace) = match parsed {
            Ok(execution) => (execution.output, execution.trace),
            Err(error) => (error.output, error.trace),
        };
        return Err(AutomationExecutionError {
            message: format!("Claude exited with {:?}: {}", status.code(), stderr.trim()),
            trace,
            output,
            recoverable_stall: false,
        });
    }
    let execution = parsed?;
    if execution.session_id.as_deref() != Some(session_target.session_id.as_str()) {
        return Err(AutomationExecutionError {
            message: format!(
                "Claude did not verify the durable session ID for this run (expected {}, received {})",
                session_target.session_id,
                execution.session_id.as_deref().unwrap_or("none")
            ),
            trace: execution.trace,
            output: execution.output,
            recoverable_stall: false,
        });
    }
    Ok(execution)
}

fn parse_result_directive(output: &str, marker: &str, fallback: &str) -> Option<(String, String)> {
    let start = final_automation_directive_start(output, marker)?;
    let directive = output[start..].trim();
    let field = |name: &str| -> Option<String> {
        let marker = format!("{name}=\"");
        let value = directive.split_once(&marker)?.1;
        Some(value.split('"').next()?.to_string())
    };
    Some((
        field("title").unwrap_or_else(|| fallback.to_string()),
        field("summary").unwrap_or_else(|| output.chars().take(240).collect()),
    ))
}

fn parse_inbox_directive(output: &str, fallback: &str) -> (String, String) {
    parse_result_directive(output, "::inbox-item{", fallback)
        .unwrap_or_else(|| (fallback.to_string(), output.chars().take(240).collect()))
}

fn parse_automation_attention_directive(output: &str, fallback: &str) -> Option<(String, String)> {
    parse_result_directive(output, "::automation-needs-attention{", fallback)
}

fn parse_automation_failure_directive(output: &str) -> Option<String> {
    let marker = "::automation-failed{";
    let start = final_automation_directive_start(output, marker)?;
    let directive = output[start..].trim();
    let summary_marker = "summary=\"";
    let summary = directive
        .split_once(summary_marker)?
        .1
        .split('"')
        .next()?
        .trim();
    (!summary.is_empty()).then(|| summary.chars().take(1000).collect())
}

fn final_automation_directive_start(output: &str, marker: &str) -> Option<usize> {
    let start = output.rfind(marker)?;
    if start > 0 && output.as_bytes().get(start.wrapping_sub(1)) != Some(&b'\n') {
        return None;
    }
    let suffix = output[start..].trim();
    (suffix.starts_with(marker) && suffix.ends_with('}') && suffix.lines().count() == 1)
        .then_some(start)
}

fn has_user_facing_report_before_directive(output: &str, marker: &str) -> bool {
    final_automation_directive_start(output, marker)
        .is_some_and(|start| !output[..start].trim().is_empty())
}

fn automation_reported_failure(
    execution: &AutomationExecution,
    require_terminal_directive: bool,
) -> Option<String> {
    if let Some(reason) = parse_automation_failure_directive(&execution.output) {
        return Some(reason);
    }
    let has_terminal_directive =
        has_user_facing_report_before_directive(&execution.output, "::inbox-item{")
            || has_user_facing_report_before_directive(
                &execution.output,
                "::automation-needs-attention{",
            );
    if execution
        .last_agent_completion_event
        .is_some_and(|completion| {
            execution
                .last_main_assistant_event
                .is_none_or(|main| main < completion)
        })
    {
        return Some(
            "Background Agents finished after the main Agent's last response; the run ended without a final synthesis"
                .to_string(),
        );
    }
    if has_terminal_directive {
        return None;
    }
    if require_terminal_directive {
        return Some(
            "Scheduled task ended without the required user-facing report and final result directive"
                .to_string(),
        );
    }
    let terminal_tool_failed = execution
        .trace
        .iter()
        .rev()
        .find(|event| event.event_type == "tool_result")
        .is_some_and(|event| event.summary == "Failed");
    terminal_tool_failed.then(|| {
        let summary = execution.output.trim();
        if summary.is_empty() {
            "The workflow stopped after a failed tool result".to_string()
        } else {
            summary.chars().take(1000).collect()
        }
    })
}

fn automation_needs_completion_recovery(execution: &AutomationExecution) -> bool {
    if parse_automation_failure_directive(&execution.output).is_some() {
        return false;
    }
    let background_finished_after_main =
        execution
            .last_agent_completion_event
            .is_some_and(|completion| {
                execution
                    .last_main_assistant_event
                    .is_none_or(|main| main < completion)
            });
    let has_terminal_directive =
        has_user_facing_report_before_directive(&execution.output, "::inbox-item{")
            || has_user_facing_report_before_directive(
                &execution.output,
                "::automation-needs-attention{",
            );
    background_finished_after_main || !has_terminal_directive
}

fn merge_automation_executions(
    mut first: AutomationExecution,
    mut continuation: AutomationExecution,
) -> AutomationExecution {
    let sequence_offset = first
        .trace
        .iter()
        .map(|event| event.sequence)
        .max()
        .unwrap_or(0);
    for event in &mut continuation.trace {
        event.sequence = event.sequence.saturating_add(sequence_offset);
    }
    let position_offset = first
        .last_main_assistant_event
        .into_iter()
        .chain(first.last_agent_completion_event)
        .max()
        .unwrap_or(0);
    let last_main_assistant_event = continuation
        .last_main_assistant_event
        .map(|position| position.saturating_add(position_offset))
        .or(first.last_main_assistant_event);
    let last_agent_completion_event = continuation
        .last_agent_completion_event
        .map(|position| position.saturating_add(position_offset))
        .or(first.last_agent_completion_event);
    first.trace.extend(continuation.trace);
    AutomationExecution {
        output: format!(
            "{}\n\n{}",
            first.output.trim_end(),
            continuation.output.trim_start()
        ),
        trace: first.trace,
        session_id: continuation.session_id.or(first.session_id),
        last_main_assistant_event,
        last_agent_completion_event,
    }
}

fn stalled_automation_execution(
    mut error: AutomationExecutionError,
    session_id: &str,
) -> AutomationExecution {
    let next_sequence = error
        .trace
        .iter()
        .map(|event| event.sequence)
        .max()
        .unwrap_or(0)
        .saturating_add(1);
    error.trace.push(AutomationTraceEvent {
        sequence: next_sequence,
        event_type: "runtime_recovery".to_string(),
        tool_name: None,
        tool_use_id: None,
        parent_tool_use_id: None,
        agent_id: None,
        agent_type: None,
        agent_kind: None,
        agent_depth: None,
        summary: error.message,
    });
    AutomationExecution {
        output: error.output,
        trace: error.trace,
        session_id: Some(session_id.to_string()),
        last_main_assistant_event: None,
        last_agent_completion_event: None,
    }
}

async fn recover_automation_stall(
    definition: &AutomationDefinition,
    scheduled_at: Option<i64>,
    run_id: &str,
    execution_cwd: &Path,
    session_target: &AutomationSessionTarget,
    initial_error: AutomationExecutionError,
) -> Result<AutomationExecution, AutomationExecutionError> {
    let resume_target = AutomationSessionTarget {
        session_id: session_target.session_id.clone(),
        arguments: vec!["--resume".to_string(), session_target.session_id.clone()],
        creates_new_session: false,
    };
    let mut execution = stalled_automation_execution(initial_error, &session_target.session_id);

    for attempt in 1..=AUTOMATION_STALL_RECOVERY_LIMIT {
        let recovery_prompt = automation_stall_recovery_prompt(definition, attempt);
        match invoke_claude(
            definition,
            scheduled_at,
            run_id,
            execution_cwd,
            &resume_target,
            Some(&recovery_prompt),
        )
        .await
        {
            Ok(continuation) => {
                return Ok(merge_automation_executions(execution, continuation));
            }
            Err(error) if error.recoverable_stall => {
                let stalled = stalled_automation_execution(error, &session_target.session_id);
                execution = merge_automation_executions(execution, stalled);
            }
            Err(mut error) => {
                let output = if error.output.trim().is_empty() {
                    execution.output
                } else {
                    format!(
                        "{}\n\n{}",
                        execution.output.trim_end(),
                        error.output.trim_start()
                    )
                };
                let mut trace = execution.trace;
                trace.append(&mut error.trace);
                return Err(AutomationExecutionError {
                    message: format!(
                        "Scheduled task stall recovery failed on attempt {attempt}: {}",
                        error.message
                    ),
                    trace,
                    output,
                    recoverable_stall: false,
                });
            }
        }
    }

    Err(AutomationExecutionError {
        message: format!(
            "Scheduled task remained inactive after {AUTOMATION_STALL_RECOVERY_LIMIT} same-session recovery attempts"
        ),
        trace: execution.trace,
        output: execution.output,
        recoverable_stall: false,
    })
}

async fn recover_automation_completion(
    definition: &AutomationDefinition,
    scheduled_at: Option<i64>,
    run_id: &str,
    execution_cwd: &Path,
    session_target: &AutomationSessionTarget,
    mut execution: AutomationExecution,
) -> Result<AutomationExecution, AutomationExecutionError> {
    let resume_target = AutomationSessionTarget {
        session_id: session_target.session_id.clone(),
        arguments: vec!["--resume".to_string(), session_target.session_id.clone()],
        creates_new_session: false,
    };
    for attempt in 1..=AUTOMATION_COMPLETION_RECOVERY_LIMIT {
        if !automation_needs_completion_recovery(&execution) {
            break;
        }
        let recovery_prompt = automation_completion_recovery_prompt(definition, attempt);
        match invoke_claude(
            definition,
            scheduled_at,
            run_id,
            execution_cwd,
            &resume_target,
            Some(&recovery_prompt),
        )
        .await
        {
            Ok(continuation) => {
                execution = merge_automation_executions(execution, continuation);
            }
            Err(mut error) => {
                let output = if error.output.trim().is_empty() {
                    execution.output
                } else {
                    format!(
                        "{}\n\n{}",
                        execution.output.trim_end(),
                        error.output.trim_start()
                    )
                };
                let mut trace = execution.trace;
                trace.append(&mut error.trace);
                return Err(AutomationExecutionError {
                    message: format!(
                        "Scheduled task completion recovery failed on attempt {attempt}: {}",
                        error.message
                    ),
                    trace,
                    output,
                    recoverable_stall: false,
                });
            }
        }
    }
    Ok(execution)
}

fn record_successful_retry(
    connection: &Connection,
    original_run_id: &str,
    recovery_run_id: &str,
    recovered_at: i64,
) -> Result<bool, String> {
    let evidence = format!("automation-run:{recovery_run_id}");
    let updated = connection
        .execute(
            "UPDATE automation_runs SET status='RECOVERED',read_at=NULL,recovered_by_run_id=?2,recovered_at=?3,recovery_evidence=?4 WHERE run_id=?1 AND status='FAILED' AND retry_of_run_id IS NULL",
            params![original_run_id, recovery_run_id, recovered_at, evidence],
        )
        .map_err(|error| format!("Cannot record recovered automation run: {error}"))?;
    if updated == 1 {
        connection
            .execute(
                "UPDATE automation_runs SET read_at=?2 WHERE run_id=?1",
                params![recovery_run_id, recovered_at],
            )
            .map_err(|error| format!("Cannot mark retry audit run read: {error}"))?;
        connection
            .execute(
                "UPDATE inbox_items SET read_at=?2 WHERE run_id=?1",
                params![recovery_run_id, recovered_at],
            )
            .map_err(|error| format!("Cannot mark retry inbox item read: {error}"))?;
    }
    Ok(updated == 1)
}

fn completion_probe_value_matches(actual: &Value, expected: &str) -> bool {
    actual
        .as_str()
        .map(|value| value == expected)
        .unwrap_or_else(|| actual.to_string() == expected)
}

fn completion_probe_root(
    definition: &AutomationDefinition,
    probe: &AutomationCompletionProbe,
    data_directory: &Path,
) -> Result<PathBuf, String> {
    let root = if probe.base_directory == "automation_data" {
        data_directory.to_path_buf()
    } else {
        PathBuf::from(project_directory(definition)?)
    };
    fs::canonicalize(&root).map_err(|error| {
        format!(
            "Cannot resolve completion probe {} directory: {error}",
            probe.base_directory
        )
    })
}

fn read_completion_probe_json(
    root: &Path,
    rendered_relative: &str,
    started_at: i64,
) -> Result<Option<Value>, String> {
    let relative = Path::new(rendered_relative);
    if !safe_relative_path(relative) {
        return Err("Completion probe path escaped its base directory".to_string());
    }
    let candidate = root.join(relative);
    if !candidate.is_file() {
        return Ok(None);
    }
    let resolved = fs::canonicalize(&candidate)
        .map_err(|error| format!("Cannot resolve completion probe file: {error}"))?;
    if !resolved.starts_with(root) {
        return Err("Completion probe file escaped its base directory".to_string());
    }
    let metadata = fs::metadata(&resolved)
        .map_err(|error| format!("Cannot inspect completion probe file: {error}"))?;
    if metadata.len() > 1024 * 1024 {
        return Err("Completion probe file exceeds the 1 MiB safety limit".to_string());
    }
    let modified_at = metadata
        .modified()
        .map_err(|error| format!("Cannot read completion probe timestamp: {error}"))?
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| "Completion probe timestamp predates the Unix epoch".to_string())?
        .as_millis() as i64;
    if modified_at.saturating_add(5_000) < started_at {
        return Ok(None);
    }
    let bytes = fs::read(&resolved)
        .map_err(|error| format!("Cannot read completion probe JSON: {error}"))?;
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|error| format!("Cannot parse completion probe JSON: {error}"))
}

fn completion_probe_recovered_title(
    definition: &AutomationDefinition,
    probe: &AutomationCompletionProbe,
    date: &str,
) -> String {
    probe
        .recovered_title
        .as_deref()
        .unwrap_or(&definition.name)
        .replace("{name}", &definition.name)
        .replace("{date}", date)
}

fn probe_completion_receipt_at(
    definition: &AutomationDefinition,
    scheduled_at: i64,
    started_at: i64,
    data_directory: &Path,
) -> Result<Option<(String, String)>, String> {
    let Some(probe) = &definition.completion_probe else {
        return Ok(None);
    };
    let scheduled = local_from_ms(scheduled_at)?;
    let receipt_date =
        scheduled.date_naive() + ChronoDuration::days(probe.scheduled_date_offset_days);
    let date = receipt_date.format("%Y-%m-%d").to_string();
    let rendered_relative = probe.relative_path.replace("{date}", &date);
    let root = completion_probe_root(definition, probe, data_directory)?;
    let Some(json) = read_completion_probe_json(&root, &rendered_relative, started_at)? else {
        return Ok(None);
    };
    for (field, expected_template) in &probe.json_equals {
        let expected = expected_template.replace("{date}", &date);
        let Some(actual) = json.get(field) else {
            return Ok(None);
        };
        if !completion_probe_value_matches(actual, &expected) {
            return Ok(None);
        }
    }
    let mut evidence = format!("completion-receipt:{rendered_relative}");
    if let Some(reference_template) = probe.reference_relative_path.as_deref() {
        let reference_relative = reference_template.replace("{date}", &date);
        let Some(reference) = read_completion_probe_json(&root, &reference_relative, started_at)?
        else {
            return Ok(None);
        };
        for field in &probe.json_matches_reference {
            if json.get(field).is_none() || json.get(field) != reference.get(field) {
                return Ok(None);
            }
        }
        evidence.push_str(&format!(";reference:{reference_relative}"));
    }
    for path_template in &probe.required_absent_relative_paths {
        let rendered = path_template.replace("{date}", &date);
        let relative = Path::new(&rendered);
        if !safe_relative_path(relative) {
            return Err("Completion terminal path escaped its base directory".to_string());
        }
        let candidate = root.join(relative);
        if candidate.exists() {
            let resolved = fs::canonicalize(&candidate)
                .map_err(|error| format!("Cannot resolve completion terminal path: {error}"))?;
            if !resolved.starts_with(&root) {
                return Err("Completion terminal path escaped its base directory".to_string());
            }
            return Ok(None);
        }
        evidence.push_str(&format!(";absent:{rendered}"));
    }
    Ok(Some((
        evidence,
        completion_probe_recovered_title(definition, probe, &date),
    )))
}

fn probe_completion_receipt(
    definition: &AutomationDefinition,
    scheduled_at: i64,
    started_at: i64,
) -> Result<Option<(String, String)>, String> {
    let data_directory = automation_data_dir()?;
    probe_completion_receipt_at(definition, scheduled_at, started_at, &data_directory)
}

fn recover_run_from_completion_probe(
    connection: &Connection,
    definition: &AutomationDefinition,
    run_id: &str,
    scheduled_at: i64,
    started_at: i64,
    recovered_at: i64,
) -> Result<bool, String> {
    let Some((evidence, recovered_title)) =
        probe_completion_receipt(definition, scheduled_at, started_at)?
    else {
        return Ok(false);
    };
    let updated = connection
        .execute(
            "UPDATE automation_runs SET status='RECOVERED',read_at=NULL,title=?2,recovered_at=?3,recovery_evidence=?4 WHERE run_id=?1 AND status='FAILED' AND retry_of_run_id IS NULL",
            params![run_id, recovered_title, recovered_at, evidence],
        )
        .map_err(|error| format!("Cannot reconcile automation completion receipt: {error}"))?;
    if updated == 1 {
        connection
            .execute(
                "UPDATE inbox_items SET title=?2,description=?3,read_at=NULL WHERE run_id=?1",
                params![
                    run_id,
                    recovered_title,
                    "Durable completion receipt verified; original runtime failure preserved",
                ],
            )
            .map_err(|error| format!("Cannot reconcile automation inbox item: {error}"))?;
    }
    Ok(updated == 1)
}

fn reconcile_failed_completion_probes(
    connection: &Connection,
    definitions: &[AutomationDefinition],
) -> Result<u64, String> {
    let recovered_at = now_ms();
    let mut recovered = 0_u64;
    for definition in definitions
        .iter()
        .filter(|definition| definition.completion_probe.is_some())
    {
        let failed_runs: Vec<(String, i64, i64)> = {
            let mut statement = connection
                .prepare(
                    "SELECT run_id,scheduled_at,started_at FROM automation_runs WHERE automation_id=?1 AND status='FAILED' AND scheduled_at IS NOT NULL AND retry_of_run_id IS NULL",
                )
                .map_err(|error| format!("Cannot inspect failed automation runs: {error}"))?;
            let rows = statement
                .query_map(params![definition.id], |row| {
                    Ok((row.get(0)?, row.get(1)?, row.get(2)?))
                })
                .map_err(|error| format!("Cannot query failed automation runs: {error}"))?;
            rows.filter_map(Result::ok).collect()
        };
        for (run_id, scheduled_at, started_at) in failed_runs {
            match recover_run_from_completion_probe(
                connection,
                definition,
                &run_id,
                scheduled_at,
                started_at,
                recovered_at,
            ) {
                Ok(true) => recovered += 1,
                Ok(false) => {}
                Err(error) => eprintln!(
                    "[BLACKBOX AUTOMATIONS] completion probe {} failed closed: {error}",
                    definition.id
                ),
            }
        }
    }
    Ok(recovered)
}

fn reconcile_incomplete_attention_probes_at(
    connection: &Connection,
    definitions: &[AutomationDefinition],
    data_directory: &Path,
) -> Result<u64, String> {
    let mut reclassified = 0_u64;
    for definition in definitions
        .iter()
        .filter(|definition| definition.completion_probe.is_some())
    {
        let attention_runs: Vec<(String, i64, i64)> = {
            let mut statement = connection
                .prepare(
                    "SELECT run_id,scheduled_at,started_at FROM automation_runs WHERE automation_id=?1 AND status='NEEDS_ATTENTION' AND scheduled_at IS NOT NULL AND retry_of_run_id IS NULL",
                )
                .map_err(|error| format!("Cannot inspect attention automation runs: {error}"))?;
            let rows = statement
                .query_map(params![definition.id], |row| {
                    Ok((row.get(0)?, row.get(1)?, row.get(2)?))
                })
                .map_err(|error| format!("Cannot query attention automation runs: {error}"))?;
            rows.filter_map(Result::ok).collect()
        };
        for (run_id, scheduled_at, started_at) in attention_runs {
            match probe_completion_receipt_at(
                definition,
                scheduled_at,
                started_at,
                data_directory,
            ) {
                Ok(Some(_)) => {}
                Ok(None) => {
                    let summary = "This scheduled task stopped before producing its required completion receipt. Resume it from the saved recovery point.";
                    let title = format!("{} failed", definition.name);
                    let updated = connection
                        .execute(
                            "UPDATE automation_runs SET status='FAILED',read_at=NULL,title=?2,summary=?3,error=?3 WHERE run_id=?1 AND status='NEEDS_ATTENTION'",
                            params![run_id, title, summary],
                        )
                        .map_err(|error| {
                            format!("Cannot reclassify incomplete attention run: {error}")
                        })?;
                    if updated == 1 {
                        connection
                            .execute(
                                "UPDATE inbox_items SET title=?2,description=?3,read_at=NULL WHERE run_id=?1",
                                params![run_id, title, summary],
                            )
                            .map_err(|error| {
                                format!("Cannot update incomplete attention inbox item: {error}")
                            })?;
                        reclassified += 1;
                    }
                }
                Err(error) => eprintln!(
                    "[BLACKBOX AUTOMATIONS] attention completion probe {} could not be verified: {error}",
                    definition.id
                ),
            }
        }
    }
    Ok(reclassified)
}

fn reconcile_incomplete_attention_probes(
    connection: &Connection,
    definitions: &[AutomationDefinition],
) -> Result<u64, String> {
    let data_directory = automation_data_dir()?;
    reconcile_incomplete_attention_probes_at(connection, definitions, &data_directory)
}

fn attention_completion_failure(
    definition: &AutomationDefinition,
    scheduled_at: Option<i64>,
    started_at: i64,
) -> Option<String> {
    definition.completion_probe.as_ref()?;
    let probe_time = scheduled_at.unwrap_or(started_at);
    match probe_completion_receipt(definition, probe_time, started_at) {
        Ok(Some(_)) => None,
        Ok(None) => Some(
            "The task requested a decision before its required completion receipt existed. The run is incomplete and must resume from its recorded recovery point."
                .to_string(),
        ),
        Err(error) => Some(format!(
            "The task requested a decision, but its completion evidence could not be verified: {error}"
        )),
    }
}

async fn execute_automation(
    definition: AutomationDefinition,
    run_id: String,
    scheduled_at: Option<i64>,
    retry_of_run_id: Option<String>,
) {
    // A run already claimed immediately before maintenance waits instead of
    // spawning a second Claude process while the CLI executable is replaced.
    while crate::cli_update_in_progress() {
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    let started_at = now_ms();
    let session_target = automation_session_target(&definition, &run_id);
    let durable_session_id = session_target
        .as_ref()
        .ok()
        .map(|target| target.session_id.clone());
    let source_cwd = if definition.kind == "cron" {
        project_directory(&definition).ok()
    } else {
        definition.cwds.first().cloned()
    };
    if let Ok(connection) = open_database() {
        let _ = connection.execute(
            "INSERT OR REPLACE INTO automation_runs (run_id,automation_id,session_id,status,title,summary,output,source_cwd,scheduled_at,started_at,retry_of_run_id) VALUES (?1,?2,?3,'RUNNING',?4,'','',?5,?6,?7,?8)",
            params![run_id, definition.id, durable_session_id, definition.name, source_cwd, scheduled_at, started_at, retry_of_run_id],
        );
        let _ = connection.execute(
            "UPDATE automations SET active_run_id=?2 WHERE id=?1",
            params![definition.id, run_id],
        );
    }

    let result = match session_target {
        Err(error) => Err(AutomationExecutionError::new(error)),
        Ok(session_target) => match prepare_execution_directory(&definition, &run_id) {
            Ok(directory) => {
                let source_cwd = directory.source_cwd.to_string_lossy().to_string();
                let execution_cwd = directory.execution_cwd.to_string_lossy().to_string();
                let persisted = open_database().and_then(|connection| {
                    let changed = connection
                        .execute(
                            "UPDATE automation_runs SET source_cwd=?2,execution_cwd=?3,base_commit=?4,source_head_commit=?5,worktree_input_snapshot_ref=?6,worktree_input_snapshot_at=?7,worktree_included_files=?8 WHERE run_id=?1",
                            params![
                                run_id,
                                source_cwd,
                                execution_cwd,
                                directory.base_commit.clone(),
                                directory.source_head_commit.clone(),
                                directory.worktree_input_snapshot_ref.clone(),
                                directory.worktree_input_snapshot_at,
                                directory.worktree_included_files,
                            ],
                        )
                        .map_err(|error| {
                            format!("Cannot record automation execution directory: {error}")
                        })?;
                    if changed != 1 {
                        return Err(
                            "Automation run disappeared before execution started".to_string()
                        );
                    }
                    Ok(())
                });
                match persisted {
                    Ok(()) => {
                        let session_indexed = if session_target.creates_new_session {
                            crate::track_managed_session(session_target.session_id.clone()).await
                        } else {
                            Ok(())
                        };
                        match session_indexed {
                            Ok(()) => {
                                let first_execution = invoke_claude(
                                    &definition,
                                    scheduled_at,
                                    &run_id,
                                    &directory.execution_cwd,
                                    &session_target,
                                    None,
                                )
                                .await;
                                let first_execution = match first_execution {
                                    Err(error)
                                        if definition.kind == "cron" && error.recoverable_stall =>
                                    {
                                        recover_automation_stall(
                                            &definition,
                                            scheduled_at,
                                            &run_id,
                                            &directory.execution_cwd,
                                            &session_target,
                                            error,
                                        )
                                        .await
                                    }
                                    other => other,
                                };
                                match first_execution {
                                    Ok(execution) if definition.kind == "cron" => {
                                        recover_automation_completion(
                                            &definition,
                                            scheduled_at,
                                            &run_id,
                                            &directory.execution_cwd,
                                            &session_target,
                                            execution,
                                        )
                                        .await
                                    }
                                    other => other,
                                }
                            }
                            Err(error) => {
                                let rollback = rollback_prepared_execution_directory(
                                    &definition,
                                    &run_id,
                                    &directory,
                                );
                                let message = match rollback {
                                    Ok(()) => format!(
                                        "Refusing to run without a durable session index: {error}"
                                    ),
                                    Err(rollback_error) => format!(
                                        "Refusing to run without a durable session index ({error}); worktree rollback also failed: {rollback_error}"
                                    ),
                                };
                                Err(AutomationExecutionError::new(message))
                            }
                        }
                    }
                    Err(error) => {
                        let rollback =
                            rollback_prepared_execution_directory(&definition, &run_id, &directory);
                        let message = match rollback {
                            Ok(()) => {
                                format!("Refusing to run without durable worktree metadata: {error}")
                            }
                            Err(rollback_error) => format!(
                                "Refusing to run without durable worktree metadata ({error}); worktree rollback also failed: {rollback_error}"
                            ),
                        };
                        Err(AutomationExecutionError::new(message))
                    }
                }
            }
            Err(error) => Err(AutomationExecutionError::new(error)),
        },
    };
    let finished_at = now_ms();
    if let Ok(connection) = open_database() {
        match result {
            Ok(execution) => {
                let trace_json =
                    serde_json::to_string(&execution.trace).unwrap_or_else(|_| "[]".to_string());
                let attention =
                    parse_automation_attention_directive(&execution.output, &definition.name);
                let failure = automation_reported_failure(&execution, definition.kind == "cron")
                    .or_else(|| {
                        attention.as_ref().and_then(|_| {
                            attention_completion_failure(&definition, scheduled_at, started_at)
                        })
                    });
                if let Some(reason) = failure {
                    let title = format!("{} failed", definition.name);
                    let _ = connection.execute(
                        "UPDATE automation_runs SET status='FAILED',title=?2,summary=?3,output=?4,error=?3,trace_json=?5,finished_at=?6 WHERE run_id=?1",
                        params![run_id, title, reason, execution.output, trace_json, finished_at],
                    );
                    let _ = connection.execute(
                        "INSERT OR REPLACE INTO inbox_items (id,title,description,run_id,created_at) VALUES (?1,?2,?3,?1,?4)",
                        params![run_id, title, reason, finished_at],
                    );
                } else if let Some((title, summary)) = attention {
                    let _ = connection.execute(
                        "UPDATE automation_runs SET status='NEEDS_ATTENTION',title=?2,summary=?3,output=?4,trace_json=?5,finished_at=?6 WHERE run_id=?1",
                        params![run_id, title, summary, execution.output, trace_json, finished_at],
                    );
                    let _ = connection.execute(
                        "INSERT OR REPLACE INTO inbox_items (id,title,description,run_id,created_at) VALUES (?1,?2,?3,?1,?4)",
                        params![run_id, title, summary, finished_at],
                    );
                } else {
                    let (title, summary) =
                        parse_inbox_directive(&execution.output, &definition.name);
                    let _ = connection.execute(
                        "UPDATE automation_runs SET status='SUCCEEDED',title=?2,summary=?3,output=?4,trace_json=?5,finished_at=?6 WHERE run_id=?1",
                        params![run_id, title, summary, execution.output, trace_json, finished_at],
                    );
                    let _ = connection.execute(
                        "INSERT OR REPLACE INTO inbox_items (id,title,description,run_id,created_at) VALUES (?1,?2,?3,?1,?4)",
                        params![run_id, title, summary, finished_at],
                    );
                    if let Some(original_run_id) = retry_of_run_id.as_deref() {
                        if let Err(error) = record_successful_retry(
                            &connection,
                            original_run_id,
                            &run_id,
                            finished_at,
                        ) {
                            eprintln!(
                                "[BLACKBOX AUTOMATIONS] retry recovery linkage failed: {error}"
                            );
                        }
                    }
                }
            }
            Err(error) => {
                let trace_json =
                    serde_json::to_string(&error.trace).unwrap_or_else(|_| "[]".to_string());
                let message = error.message;
                let output = error.output;
                let status = if message == "Automation cancelled by user" {
                    "CANCELLED"
                } else {
                    "FAILED"
                };
                let _ = connection.execute(
                    "UPDATE automation_runs SET status=?2,error=?3,summary=?3,output=?4,trace_json=?5,finished_at=?6 WHERE run_id=?1",
                    params![run_id, status, message, output, trace_json, finished_at],
                );
                let _ = connection.execute(
                    "INSERT OR REPLACE INTO inbox_items (id,title,description,run_id,created_at) VALUES (?1,?2,?3,?1,?4)",
                    params![run_id, format!("{} {}", definition.name, status.to_ascii_lowercase()), message, finished_at],
                );
                if status == "FAILED" {
                    if let Some(scheduled_at) = scheduled_at {
                        if let Err(error) = recover_run_from_completion_probe(
                            &connection,
                            &definition,
                            &run_id,
                            scheduled_at,
                            started_at,
                            finished_at,
                        ) {
                            eprintln!(
                                "[BLACKBOX AUTOMATIONS] completion probe {} failed closed: {error}",
                                definition.id
                            );
                        }
                    }
                }
            }
        }
        let _ = connection.execute(
            "UPDATE automations SET active_run_id=NULL WHERE id=?1 AND active_run_id=?2",
            params![definition.id, run_id],
        );
    }
}

fn claim_due_automations() -> Result<Vec<(AutomationDefinition, String, i64)>, String> {
    reconcile_all()?;
    let mut connection = open_database()?;
    let transaction = connection.transaction().map_err(|e| e.to_string())?;
    let now = now_ms();
    let due: Vec<(String, i64, String)> = {
        let mut statement = transaction
            .prepare("SELECT id,next_run_at,rrule FROM automations WHERE status='ACTIVE' AND next_run_at IS NOT NULL AND next_run_at<=?1 AND active_run_id IS NULL AND NOT EXISTS (SELECT 1 FROM automation_recovery_plans p WHERE p.automation_id=automations.id AND p.phase IN ('BACKFILL','CATCHUP','VERDICT_PENDING'))")
            .map_err(|e| e.to_string())?;
        let rows = statement
            .query_map(params![now], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })
            .map_err(|e| e.to_string())?;
        rows.filter_map(Result::ok).collect()
    };
    let mut claimed = Vec::new();
    for (id, scheduled_at, rrule) in due {
        let run_id = uuid::Uuid::new_v4().to_string();
        let inserted = transaction
            .execute(
                "INSERT OR IGNORE INTO automation_claims (automation_id,scheduled_at,run_id) VALUES (?1,?2,?3)",
                params![id, scheduled_at, run_id],
            )
            .map_err(|e| e.to_string())?;
        if inserted == 0 {
            continue;
        }
        // One catch-up only: after an overdue claim, calculate from now rather than
        // replaying every missed interval.
        let next = next_occurrence(&rrule, now)?;
        transaction
            .execute(
                "UPDATE automations SET last_run_at=?2,next_run_at=?3,active_run_id=?4 WHERE id=?1",
                params![id, scheduled_at, next, run_id],
            )
            .map_err(|e| e.to_string())?;
        claimed.push((load_definition(&id)?, run_id, scheduled_at));
    }
    transaction.commit().map_err(|e| e.to_string())?;
    Ok(claimed)
}

async fn scheduler_tick() {
    if crate::cli_update_in_progress() {
        return;
    }
    let recovery_runs = match recovery::claim_ready() {
        Ok(runs) => runs,
        Err(error) => {
            eprintln!("[BLACKBOX AUTOMATIONS] recovery plan failed closed: {error}");
            return;
        }
    };
    for (definition, run_id, scheduled_at) in recovery_runs {
        tauri::async_runtime::spawn(execute_automation(
            definition,
            run_id,
            Some(scheduled_at),
            None,
        ));
    }
    match claim_due_automations() {
        Ok(claimed) => {
            for (definition, run_id, scheduled_at) in claimed {
                tauri::async_runtime::spawn(execute_automation(
                    definition,
                    run_id,
                    Some(scheduled_at),
                    None,
                ));
            }
        }
        Err(error) => eprintln!("[BLACKBOX AUTOMATIONS] scheduler tick failed: {error}"),
    }
}

fn recover_interrupted_runs() -> Result<usize, String> {
    let mut connection = open_database()?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let interrupted = {
        let mut statement = transaction
            .prepare(
                "SELECT run_id,automation_id,title FROM automation_runs WHERE status='RUNNING'",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                ))
            })
            .map_err(|error| error.to_string())?;
        rows.filter_map(Result::ok).collect::<Vec<_>>()
    };
    let finished_at = now_ms();
    for (run_id, automation_id, title) in &interrupted {
        let message = "Interrupted because Black Box exited before the run completed";
        transaction
            .execute(
                "UPDATE automation_runs SET status='FAILED',summary=?2,error=?2,finished_at=?3 WHERE run_id=?1",
                params![run_id, message, finished_at],
            )
            .map_err(|error| error.to_string())?;
        transaction
            .execute(
                "UPDATE automations SET active_run_id=NULL WHERE id=?1 AND active_run_id=?2",
                params![automation_id, run_id],
            )
            .map_err(|error| error.to_string())?;
        transaction
            .execute(
                "INSERT OR REPLACE INTO inbox_items (id,title,description,run_id,created_at) VALUES (?1,?2,?3,?1,?4)",
                params![
                    run_id,
                    if title.is_empty() {
                        format!("{automation_id} interrupted")
                    } else {
                        format!("{title} interrupted")
                    },
                    message,
                    finished_at
                ],
            )
            .map_err(|error| error.to_string())?;
    }
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(interrupted.len())
}

pub fn start_scheduler() {
    if SCHEDULER_STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    match recover_interrupted_runs() {
        Ok(count) if count > 0 => {
            eprintln!("[BLACKBOX AUTOMATIONS] recovered {count} interrupted run(s)")
        }
        Ok(_) => {}
        Err(error) => eprintln!("[BLACKBOX AUTOMATIONS] interrupted run recovery failed: {error}"),
    }
    match enforce_managed_worktree_retention() {
        Ok(count) if count > 0 => {
            eprintln!("[BLACKBOX AUTOMATIONS] retained worktree limit by cleaning {count} archived run(s)")
        }
        Ok(_) => {}
        Err(error) => eprintln!("[BLACKBOX AUTOMATIONS] worktree retention failed: {error}"),
    }
    tauri::async_runtime::spawn(async {
        loop {
            scheduler_tick().await;
            tokio::time::sleep(Duration::from_secs(SCHEDULER_INTERVAL_SECS)).await;
        }
    });
}

fn copy_tree(source: &Path, destination: &Path) -> Result<(), String> {
    fs::create_dir_all(destination)
        .map_err(|e| format!("Cannot create {}: {e}", destination.display()))?;
    for entry in
        fs::read_dir(source).map_err(|e| format!("Cannot read {}: {e}", source.display()))?
    {
        let entry = entry.map_err(|e| e.to_string())?;
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        if source_path.is_dir() {
            copy_tree(&source_path, &destination_path)?;
        } else {
            fs::copy(&source_path, &destination_path)
                .map_err(|e| format!("Cannot install {}: {e}", destination_path.display()))?;
        }
    }
    Ok(())
}

pub fn install_bundled_skills(app: &AppHandle) -> Result<(), String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("Cannot locate Blackbox resources: {e}"))?;
    // Test and production launches both install into Black Box's private
    // Claude root.
    let skills_dir = if let Some(path) = std::env::var_os("BLACKBOX_SKILL_HOME") {
        PathBuf::from(path)
    } else {
        crate::client_runtime::claude_config_dir()?.join("skills")
    };
    for name in ["blackbox-schedule"] {
        let source = resource_dir.join(name);
        if !source.join("SKILL.md").is_file() {
            return Err(format!(
                "Bundled {name} skill is missing at {}",
                source.display()
            ));
        }
        copy_tree(&source, &skills_dir.join(name))?;
    }
    Ok(())
}

#[tauri::command]
pub fn run_automation_now(id: String) -> Result<String, String> {
    if crate::cli_update_in_progress() {
        return Err("CLI_UPDATE_IN_PROGRESS".to_string());
    }
    let (definition, run_id) = claim_manual_run(&id)?;
    let returned = run_id.clone();
    tauri::async_runtime::spawn(execute_automation(definition, run_id, None, None));
    Ok(returned)
}

#[tauri::command]
pub fn retry_automation_run(run_id: String, catch_up: Option<bool>) -> Result<String, String> {
    if crate::cli_update_in_progress() {
        return Err("CLI_UPDATE_IN_PROGRESS".to_string());
    }
    let connection = open_database()?;
    let target: Option<(String, String, Option<i64>, Option<String>, Option<String>)> = connection
        .query_row(
            "SELECT automation_id,status,scheduled_at,retry_of_run_id,recovered_by_run_id FROM automation_runs WHERE run_id=?1",
            params![run_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let (automation_id, status, scheduled_at, retry_of_run_id, recovered_by_run_id) =
        target.ok_or_else(|| "Automation run does not exist".to_string())?;
    if retry_of_run_id.is_some() {
        return Err("Retry the original failed automation run".to_string());
    }
    if recovered_by_run_id.is_some() || status == "RECOVERED" {
        return Err("Automation run was already recovered".to_string());
    }
    if status != "FAILED" {
        return Err("Only failed automation runs can be retried".to_string());
    }
    drop(connection);

    let (definition, recovery_run_id) = claim_manual_run(&automation_id)?;
    if catch_up.unwrap_or(false) {
        if let Err(error) = recovery::authorize(&definition, &run_id, &recovery_run_id) {
            let _ = open_database()?.execute(
                "UPDATE automations SET active_run_id=NULL WHERE id=?1 AND active_run_id=?2",
                params![automation_id, recovery_run_id],
            );
            return Err(error);
        }
    }
    let returned = recovery_run_id.clone();
    tauri::async_runtime::spawn(execute_automation(
        definition,
        recovery_run_id,
        scheduled_at,
        Some(run_id),
    ));
    Ok(returned)
}

#[tauri::command]
pub fn cancel_automation_run(run_id: String) -> Result<(), String> {
    let connection = open_database()?;
    let status: Option<String> = connection
        .query_row(
            "SELECT status FROM automation_runs WHERE run_id=?1",
            params![run_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    if status.as_deref() != Some("RUNNING") {
        return Err("Automation run is not running".to_string());
    }
    let sender = run_cancellations()
        .lock()
        .map_err(|_| "Automation cancellation registry is unavailable".to_string())?
        .remove(&run_id)
        .ok_or_else(|| "Run is not attached to this Black Box process".to_string())?;
    sender
        .send(())
        .map_err(|_| "Automation run already stopped".to_string())
}

fn claim_manual_run(id: &str) -> Result<(AutomationDefinition, String), String> {
    let definition = load_definition(&id)?;
    validate_definition(&definition)?;
    let connection = open_database()?;
    reconcile_definition(&connection, &definition)?;
    let run_id = uuid::Uuid::new_v4().to_string();
    let changed = connection
        .execute(
            "UPDATE automations SET active_run_id=?2 WHERE id=?1 AND active_run_id IS NULL",
            params![id, run_id],
        )
        .map_err(|e| e.to_string())?;
    if changed != 1 {
        return Err("Automation is already running".to_string());
    }
    Ok((definition, run_id))
}

fn run_automation_blocking(id: &str) -> Result<AutomationRun, String> {
    let (definition, run_id) = claim_manual_run(id)?;
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|e| format!("Cannot create automation runtime: {e}"))?
        .block_on(execute_automation(definition, run_id.clone(), None, None));
    list_automation_runs(Some(id.to_string()), Some(500))?
        .into_iter()
        .find(|run| run.run_id == run_id)
        .ok_or_else(|| "Automation run finished without a run record".to_string())
}

#[tauri::command]
pub fn list_automation_runs(
    automation_id: Option<String>,
    limit: Option<u32>,
) -> Result<Vec<AutomationRun>, String> {
    reconcile_all()?;
    let connection = open_database()?;
    query_automation_runs(&connection, automation_id, limit)
}

fn list_automation_runs_read_only(
    automation_id: Option<String>,
    limit: Option<u32>,
) -> Result<Vec<AutomationRun>, String> {
    let connection = open_database_read_only()?;
    query_automation_runs(&connection, automation_id, limit)
}

fn query_automation_runs(
    connection: &Connection,
    automation_id: Option<String>,
    limit: Option<u32>,
) -> Result<Vec<AutomationRun>, String> {
    let limit = limit.unwrap_or(100).min(500);
    let sql = if automation_id.is_some() {
        "SELECT run_id,automation_id,session_id,status,read_at,title,summary,output,trace_json,error,source_cwd,execution_cwd,base_commit,source_head_commit,worktree_input_snapshot_ref,worktree_input_snapshot_at,worktree_included_files,worktree_cleaned_at,worktree_snapshot_ref,worktree_snapshot_commit,worktree_snapshot_at,worktree_branch_name,worktree_branch_at,scheduled_at,started_at,finished_at,archived_reason,retry_of_run_id,recovered_by_run_id,recovered_at,recovery_evidence,attention_resolved_at,attention_resolution FROM automation_runs WHERE automation_id=?1 ORDER BY started_at DESC LIMIT ?2"
    } else {
        "SELECT run_id,automation_id,session_id,status,read_at,title,summary,output,trace_json,error,source_cwd,execution_cwd,base_commit,source_head_commit,worktree_input_snapshot_ref,worktree_input_snapshot_at,worktree_included_files,worktree_cleaned_at,worktree_snapshot_ref,worktree_snapshot_commit,worktree_snapshot_at,worktree_branch_name,worktree_branch_at,scheduled_at,started_at,finished_at,archived_reason,retry_of_run_id,recovered_by_run_id,recovered_at,recovery_evidence,attention_resolved_at,attention_resolution FROM automation_runs ORDER BY started_at DESC LIMIT ?1"
    };
    let mut statement = connection.prepare(sql).map_err(|e| e.to_string())?;
    let mapper = |row: &rusqlite::Row<'_>| {
        Ok(AutomationRun {
            run_id: row.get(0)?,
            automation_id: row.get(1)?,
            session_id: row.get(2)?,
            status: row.get(3)?,
            read_at: row.get(4)?,
            title: row.get::<_, Option<String>>(5)?.unwrap_or_default(),
            summary: row.get::<_, Option<String>>(6)?.unwrap_or_default(),
            output: row.get::<_, Option<String>>(7)?.unwrap_or_default(),
            trace: serde_json::from_str(
                &row.get::<_, Option<String>>(8)?
                    .unwrap_or_else(|| "[]".to_string()),
            )
            .unwrap_or_default(),
            error: row.get(9)?,
            source_cwd: row.get(10)?,
            execution_cwd: row.get(11)?,
            base_commit: row.get(12)?,
            source_head_commit: row.get(13)?,
            worktree_input_snapshot_ref: row.get(14)?,
            worktree_input_snapshot_at: row.get(15)?,
            worktree_included_files: row.get(16)?,
            worktree_cleaned_at: row.get(17)?,
            worktree_snapshot_ref: row.get(18)?,
            worktree_snapshot_commit: row.get(19)?,
            worktree_snapshot_at: row.get(20)?,
            worktree_branch_name: row.get(21)?,
            worktree_branch_at: row.get(22)?,
            scheduled_at: row.get(23)?,
            started_at: row.get(24)?,
            finished_at: row.get(25)?,
            archived_reason: row.get(26)?,
            retry_of_run_id: row.get(27)?,
            recovered_by_run_id: row.get(28)?,
            recovered_at: row.get(29)?,
            recovery_evidence: row.get(30)?,
            attention_resolved_at: row.get(31)?,
            attention_resolution: row.get(32)?,
        })
    };
    let rows = if let Some(id) = automation_id {
        statement.query_map(params![id, limit], mapper)
    } else {
        statement.query_map(params![limit], mapper)
    }
    .map_err(|e| e.to_string())?;
    Ok(rows.filter_map(Result::ok).collect())
}

fn cap_review_text(value: String, limit: usize) -> (String, bool) {
    if value.chars().count() <= limit {
        return (value, false);
    }
    let mut capped: String = value.chars().take(limit).collect();
    capped.push_str("\n… [review output truncated]");
    (capped, true)
}

fn cap_review_bytes(mut value: String, limit: usize) -> (String, bool) {
    if value.len() <= limit {
        return (value, false);
    }
    let mut boundary = limit;
    while boundary > 0 && !value.is_char_boundary(boundary) {
        boundary -= 1;
    }
    value.truncate(boundary);
    value.push_str("\n… [file patch truncated]");
    (value, true)
}

fn display_review_path(path: &str) -> String {
    path.chars().flat_map(char::escape_default).collect()
}

fn parse_tracked_review_files(
    tracked: &[u8],
) -> Result<BTreeMap<String, AutomationWorktreeFile>, String> {
    let tracked_fields: Vec<&[u8]> = tracked
        .split(|byte| *byte == 0)
        .filter(|field| !field.is_empty())
        .collect();
    if tracked_fields.len() % 2 != 0 {
        return Err("Git returned malformed worktree file status".to_string());
    }
    let mut files = BTreeMap::new();
    for pair in tracked_fields.chunks_exact(2) {
        let status = std::str::from_utf8(pair[0])
            .map_err(|_| "Git returned a non-UTF-8 file status".to_string())?;
        if status.len() != 1 || !matches!(status, "A" | "M" | "D" | "T" | "U" | "X" | "B") {
            return Err("Git returned an unsupported worktree file status".to_string());
        }
        let path = std::str::from_utf8(pair[1])
            .map_err(|_| "Worktree review paths must be valid UTF-8".to_string())?;
        if !safe_relative_path(Path::new(path)) {
            return Err("Worktree review path escaped the managed worktree".to_string());
        }
        files.insert(
            path.to_string(),
            AutomationWorktreeFile {
                path: path.to_string(),
                display_path: display_review_path(path),
                status: status.to_string(),
                untracked: false,
            },
        );
    }
    Ok(files)
}

fn collect_worktree_files(
    worktree_root: &Path,
    base_commit: &str,
) -> Result<(Vec<AutomationWorktreeFile>, bool), String> {
    if !valid_commit_id(base_commit) {
        return Err("Run has an invalid worktree starting commit".to_string());
    }
    let worktree = worktree_root.to_string_lossy().to_string();
    let (tracked, tracked_truncated) = git_raw_output_capped(
        &[
            "-C",
            &worktree,
            "diff",
            "--name-status",
            "-z",
            "--no-renames",
            base_commit,
            "--",
        ],
        MAX_REVIEW_FILE_LIST_BYTES,
    )?;
    let (untracked, untracked_truncated) = git_raw_output_capped(
        &[
            "-C",
            &worktree,
            "ls-files",
            "--others",
            "--exclude-standard",
            "-z",
        ],
        MAX_REVIEW_FILE_LIST_BYTES,
    )?;
    if tracked_truncated
        || untracked_truncated
        || tracked.len().saturating_add(untracked.len()) > MAX_REVIEW_FILE_LIST_BYTES
    {
        return Err("Worktree file review list is too large".to_string());
    }

    let mut files = parse_tracked_review_files(&tracked)?;
    for path in parse_nul_paths(untracked)? {
        let path = path
            .to_str()
            .ok_or_else(|| "Worktree review paths must be valid UTF-8".to_string())?;
        files
            .entry(path.to_string())
            .or_insert_with(|| AutomationWorktreeFile {
                path: path.to_string(),
                display_path: display_review_path(path),
                status: "?".to_string(),
                untracked: true,
            });
    }
    let files_truncated = files.len() > MAX_REVIEW_FILES;
    Ok((
        files.into_values().take(MAX_REVIEW_FILES).collect(),
        files_truncated,
    ))
}

fn collect_snapshot_files(
    repository: &Path,
    base_commit: &str,
    snapshot_commit: &str,
) -> Result<(Vec<AutomationWorktreeFile>, bool), String> {
    if !valid_commit_id(base_commit) || !valid_commit_id(snapshot_commit) {
        return Err("Recovery snapshot has an invalid Git commit".to_string());
    }
    let repository = repository.to_string_lossy().to_string();
    let (tracked, truncated) = git_raw_output_capped(
        &[
            "-C",
            &repository,
            "diff",
            "--name-status",
            "-z",
            "--no-renames",
            base_commit,
            snapshot_commit,
            "--",
        ],
        MAX_REVIEW_FILE_LIST_BYTES,
    )?;
    if truncated {
        return Err("Recovery snapshot file review list is too large".to_string());
    }
    let files = parse_tracked_review_files(&tracked)?;
    let files_truncated = files.len() > MAX_REVIEW_FILES;
    Ok((
        files.into_values().take(MAX_REVIEW_FILES).collect(),
        files_truncated,
    ))
}

fn collect_worktree_review(
    execution_cwd: &Path,
    base_commit: &str,
) -> Result<AutomationWorktreeReview, String> {
    if !valid_commit_id(base_commit) {
        return Err("Run has an invalid worktree starting commit".to_string());
    }
    let execution = execution_cwd.to_string_lossy().to_string();
    let range = format!("{base_commit}..HEAD");
    let status = git_output(&[
        "-C",
        &execution,
        "status",
        "--short",
        "--untracked-files=normal",
    ])?;
    let commits = git_output(&[
        "-C",
        &execution,
        "log",
        "--oneline",
        "--max-count=50",
        &range,
    ])?;
    let diff_stat = git_output(&[
        "-C",
        &execution,
        "diff",
        "--stat=120,80",
        "--stat-count=200",
        base_commit,
    ])?;
    let (files, files_truncated) = collect_worktree_files(execution_cwd, base_commit)?;
    let (status, status_truncated) = cap_review_text(status, 50_000);
    let (commits, commits_truncated) = cap_review_text(commits, 20_000);
    let (diff_stat, diff_truncated) = cap_review_text(diff_stat, 50_000);
    Ok(AutomationWorktreeReview {
        base_commit: base_commit.to_string(),
        review_source: "live".to_string(),
        status,
        commits,
        diff_stat,
        files,
        files_truncated,
        truncated: status_truncated || commits_truncated || diff_truncated,
    })
}

fn collect_snapshot_review(
    repository: &Path,
    base_commit: &str,
    snapshot_commit: &str,
) -> Result<AutomationWorktreeReview, String> {
    if !valid_commit_id(base_commit) || !valid_commit_id(snapshot_commit) {
        return Err("Recovery snapshot has an invalid Git commit".to_string());
    }
    let repository_text = repository.to_string_lossy().to_string();
    let range = format!("{base_commit}..{snapshot_commit}");
    let status = git_output(&[
        "-C",
        &repository_text,
        "diff",
        "--name-status",
        "--no-renames",
        base_commit,
        snapshot_commit,
        "--",
    ])?;
    let commits = git_output(&[
        "-C",
        &repository_text,
        "log",
        "--oneline",
        "--max-count=50",
        &range,
    ])?;
    let diff_stat = git_output(&[
        "-C",
        &repository_text,
        "diff",
        "--stat=120,80",
        "--stat-count=200",
        base_commit,
        snapshot_commit,
        "--",
    ])?;
    let (files, files_truncated) =
        collect_snapshot_files(repository, base_commit, snapshot_commit)?;
    let (status, status_truncated) = cap_review_text(status, 50_000);
    let (commits, commits_truncated) = cap_review_text(commits, 20_000);
    let (diff_stat, diff_truncated) = cap_review_text(diff_stat, 50_000);
    Ok(AutomationWorktreeReview {
        base_commit: base_commit.to_string(),
        review_source: "snapshot".to_string(),
        status,
        commits,
        diff_stat,
        files,
        files_truncated,
        truncated: status_truncated || commits_truncated || diff_truncated,
    })
}

fn resolve_automation_worktree_review(
    run_id: &str,
) -> Result<ResolvedAutomationWorktreeReview, String> {
    let connection = open_database()?;
    let record: Option<(
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<i64>,
        Option<String>,
        Option<String>,
    )> = connection
        .query_row(
            "SELECT automation_id,source_cwd,execution_cwd,base_commit,worktree_cleaned_at,worktree_snapshot_ref,worktree_snapshot_commit FROM automation_runs WHERE run_id=?1",
            params![run_id],
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
        .optional()
        .map_err(|error| error.to_string())?;
    let (
        automation_id,
        source_cwd,
        execution_cwd,
        base_commit,
        cleaned_at,
        stored_snapshot_ref,
        stored_snapshot_commit,
    ) = record.ok_or_else(|| "Automation run not found".to_string())?;
    let source_cwd = source_cwd.ok_or_else(|| "Run has no source directory".to_string())?;
    let execution_cwd =
        execution_cwd.ok_or_else(|| "Run has no execution directory".to_string())?;
    if execution_cwd == source_cwd {
        return Err("Run did not use an isolated worktree".to_string());
    }
    let base_commit =
        base_commit.ok_or_else(|| "Run predates worktree review metadata".to_string())?;
    if !valid_commit_id(&base_commit) {
        return Err("Run has an invalid worktree starting commit".to_string());
    }
    if cleaned_at.is_some() {
        let source_text = source_cwd.clone();
        let repository = PathBuf::from(git_output(&[
            "-C",
            &source_text,
            "rev-parse",
            "--show-toplevel",
        ])?);
        let repository = fs::canonicalize(repository)
            .map_err(|error| format!("Cannot resolve source Git repository: {error}"))?;
        let snapshot_dir = automation_data_dir()?
            .join("worktree-snapshots")
            .join(sanitize_id(&automation_id))
            .join(sanitize_id(run_id));
        let metadata = load_worktree_snapshot(&repository, &snapshot_dir, &automation_id, run_id)?;
        if stored_snapshot_ref.as_deref() != Some(metadata.snapshot_ref.as_str())
            || stored_snapshot_commit.as_deref() != Some(metadata.snapshot_commit.as_str())
            || base_commit != metadata.base_commit
        {
            return Err("Stored run snapshot does not match recovery metadata".to_string());
        }
        return Ok(ResolvedAutomationWorktreeReview::Snapshot {
            repository,
            base_commit,
            snapshot_commit: metadata.snapshot_commit,
        });
    }
    let worktrees_root = automation_data_dir()?.join("worktrees");
    let expected_root = worktrees_root
        .join(sanitize_id(&automation_id))
        .join(sanitize_id(run_id));
    if !expected_root.exists() {
        return Err("The run worktree no longer exists".to_string());
    }
    validate_worktree_git_identity(Path::new(&source_cwd), &expected_root)?;
    let execution_path = PathBuf::from(&execution_cwd);
    validate_worktree_review_path(&worktrees_root, &expected_root, &execution_path)?;
    let canonical_expected = fs::canonicalize(&expected_root)
        .map_err(|error| format!("Cannot resolve managed worktree: {error}"))?;
    Ok(ResolvedAutomationWorktreeReview::Live {
        worktree_root: canonical_expected,
        base_commit,
    })
}

fn untracked_file_diff(
    worktree_root: &Path,
    file: &AutomationWorktreeFile,
) -> Result<AutomationWorktreeFileDiff, String> {
    let relative = Path::new(&file.path);
    let path = worktree_root.join(relative);
    let metadata = fs::symlink_metadata(&path)
        .map_err(|error| format!("Cannot inspect untracked review file: {error}"))?;
    let display_path = file.display_path.clone();
    if metadata.file_type().is_symlink() {
        let target = fs::read_link(&path)
            .map_err(|error| format!("Cannot read untracked review symlink: {error}"))?;
        let target = display_review_path(&target.to_string_lossy());
        return Ok(AutomationWorktreeFileDiff {
            path: file.path.clone(),
            display_path: display_path.clone(),
            status: file.status.clone(),
            patch: format!(
                "diff --git a/{0} b/{0}\nnew file mode 120000\n--- /dev/null\n+++ b/{0}\n@@ -0,0 +1 @@\n+{1}",
                display_path, target
            ),
            binary: false,
            truncated: false,
            size_bytes: Some(metadata.len()),
        });
    }
    if !metadata.is_file() {
        return Err("Untracked review path is not a regular file or symlink".to_string());
    }
    let canonical_root = fs::canonicalize(worktree_root)
        .map_err(|error| format!("Cannot resolve managed worktree: {error}"))?;
    let canonical_path = fs::canonicalize(&path)
        .map_err(|error| format!("Cannot resolve untracked review file: {error}"))?;
    if !canonical_path.starts_with(&canonical_root) {
        return Err("Untracked review file escaped the managed worktree".to_string());
    }
    let mut bytes = Vec::new();
    fs::File::open(&path)
        .map_err(|error| format!("Cannot open untracked review file: {error}"))?
        .take((MAX_REVIEW_PATCH_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Cannot read untracked review file: {error}"))?;
    let truncated = bytes.len() > MAX_REVIEW_PATCH_BYTES;
    if truncated {
        bytes.truncate(MAX_REVIEW_PATCH_BYTES);
    }
    if bytes.contains(&0) {
        return Ok(AutomationWorktreeFileDiff {
            path: file.path.clone(),
            display_path,
            status: file.status.clone(),
            patch: String::new(),
            binary: true,
            truncated,
            size_bytes: Some(metadata.len()),
        });
    }
    let text = match std::str::from_utf8(&bytes) {
        Ok(text) => text,
        Err(error) if truncated && error.error_len().is_none() => {
            std::str::from_utf8(&bytes[..error.valid_up_to()])
                .map_err(|_| "Cannot decode untracked review file".to_string())?
        }
        Err(_) => {
            return Ok(AutomationWorktreeFileDiff {
                path: file.path.clone(),
                display_path,
                status: file.status.clone(),
                patch: String::new(),
                binary: true,
                truncated,
                size_bytes: Some(metadata.len()),
            })
        }
    };
    let mut patch = format!(
        "diff --git a/{0} b/{0}\nnew file mode 100644\n--- /dev/null\n+++ b/{0}\n@@ -0,0 +1,{1} @@\n",
        display_path,
        text.lines().count()
    );
    for line in text.lines() {
        patch.push('+');
        patch.push_str(line);
        patch.push('\n');
    }
    if truncated {
        patch.push_str("… [file patch truncated]\n");
    }
    let (patch, patch_truncated) = cap_review_bytes(patch, MAX_REVIEW_PATCH_BYTES);
    Ok(AutomationWorktreeFileDiff {
        path: file.path.clone(),
        display_path,
        status: file.status.clone(),
        patch,
        binary: false,
        truncated: truncated || patch_truncated,
        size_bytes: Some(metadata.len()),
    })
}

fn collect_worktree_file_diff(
    worktree_root: &Path,
    base_commit: &str,
    requested_path: &str,
) -> Result<AutomationWorktreeFileDiff, String> {
    let relative = Path::new(requested_path);
    if !safe_relative_path(relative) {
        return Err("Worktree review file path is unsafe".to_string());
    }
    let (files, _) = collect_worktree_files(worktree_root, base_commit)?;
    let file = files
        .into_iter()
        .find(|file| file.path == requested_path)
        .ok_or_else(|| "Requested path is not an exposed worktree change".to_string())?;
    if file.untracked {
        return untracked_file_diff(worktree_root, &file);
    }
    let worktree = worktree_root.to_string_lossy().to_string();
    let (patch, output_truncated) = git_raw_output_capped(
        &[
            "-C",
            &worktree,
            "diff",
            "--no-ext-diff",
            "--no-color",
            "--unified=3",
            base_commit,
            "--",
            requested_path,
        ],
        MAX_REVIEW_PATCH_BYTES,
    )?;
    let mut patch = String::from_utf8_lossy(&patch).to_string();
    if output_truncated {
        patch.push_str("\n… [file patch truncated]");
    }
    let binary = patch.contains("Binary files") || patch.contains("GIT binary patch");
    let (patch, capped_truncated) = cap_review_bytes(patch, MAX_REVIEW_PATCH_BYTES);
    let size_bytes = fs::symlink_metadata(worktree_root.join(relative))
        .ok()
        .map(|metadata| metadata.len());
    Ok(AutomationWorktreeFileDiff {
        path: file.path,
        display_path: file.display_path,
        status: file.status,
        patch,
        binary,
        truncated: output_truncated || capped_truncated,
        size_bytes,
    })
}

fn snapshot_object_size(repository: &Path, commit: &str, path: &str) -> Option<u64> {
    let repository = repository.to_string_lossy().to_string();
    git_output(&[
        "-C",
        &repository,
        "cat-file",
        "-s",
        &format!("{commit}:{path}"),
    ])
    .ok()
    .and_then(|value| value.parse().ok())
}

fn collect_snapshot_file_diff(
    repository: &Path,
    base_commit: &str,
    snapshot_commit: &str,
    requested_path: &str,
) -> Result<AutomationWorktreeFileDiff, String> {
    let relative = Path::new(requested_path);
    if !safe_relative_path(relative) {
        return Err("Worktree review file path is unsafe".to_string());
    }
    let (files, _) = collect_snapshot_files(repository, base_commit, snapshot_commit)?;
    let file = files
        .into_iter()
        .find(|file| file.path == requested_path)
        .ok_or_else(|| "Requested path is not an exposed recovery snapshot change".to_string())?;
    let repository_text = repository.to_string_lossy().to_string();
    let (patch, output_truncated) = git_raw_output_capped(
        &[
            "-C",
            &repository_text,
            "diff",
            "--no-ext-diff",
            "--no-color",
            "--unified=3",
            base_commit,
            snapshot_commit,
            "--",
            requested_path,
        ],
        MAX_REVIEW_PATCH_BYTES,
    )?;
    let mut patch = String::from_utf8_lossy(&patch).to_string();
    if output_truncated {
        patch.push_str("\n… [file patch truncated]");
    }
    let binary = patch.contains("Binary files") || patch.contains("GIT binary patch");
    let (patch, capped_truncated) = cap_review_bytes(patch, MAX_REVIEW_PATCH_BYTES);
    let size_bytes = snapshot_object_size(repository, snapshot_commit, requested_path)
        .or_else(|| snapshot_object_size(repository, base_commit, requested_path));
    Ok(AutomationWorktreeFileDiff {
        path: file.path,
        display_path: file.display_path,
        status: file.status,
        patch,
        binary,
        truncated: output_truncated || capped_truncated,
        size_bytes,
    })
}

#[tauri::command]
pub fn get_automation_worktree_review(run_id: String) -> Result<AutomationWorktreeReview, String> {
    match resolve_automation_worktree_review(&run_id)? {
        ResolvedAutomationWorktreeReview::Live {
            worktree_root,
            base_commit,
        } => collect_worktree_review(&worktree_root, &base_commit),
        ResolvedAutomationWorktreeReview::Snapshot {
            repository,
            base_commit,
            snapshot_commit,
        } => collect_snapshot_review(&repository, &base_commit, &snapshot_commit),
    }
}

#[tauri::command]
pub fn get_automation_worktree_file_diff(
    run_id: String,
    path: String,
) -> Result<AutomationWorktreeFileDiff, String> {
    match resolve_automation_worktree_review(&run_id)? {
        ResolvedAutomationWorktreeReview::Live {
            worktree_root,
            base_commit,
        } => collect_worktree_file_diff(&worktree_root, &base_commit, &path),
        ResolvedAutomationWorktreeReview::Snapshot {
            repository,
            base_commit,
            snapshot_commit,
        } => collect_snapshot_file_diff(&repository, &base_commit, &snapshot_commit, &path),
    }
}

#[tauri::command]
pub fn create_automation_worktree_branch(
    run_id: String,
    branch_name: String,
) -> Result<String, String> {
    let connection = open_database()?;
    let record: Option<(
        String,
        Option<String>,
        Option<String>,
        String,
        Option<i64>,
        Option<String>,
    )> = connection
        .query_row(
            "SELECT automation_id,source_cwd,execution_cwd,status,worktree_cleaned_at,worktree_branch_name FROM automation_runs WHERE run_id=?1",
            params![run_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                ))
            },
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let (automation_id, source_cwd, execution_cwd, status, cleaned_at, stored_branch) =
        record.ok_or_else(|| "Automation run not found".to_string())?;
    if status == "RUNNING" {
        return Err("Stop the automation before creating a worktree branch".to_string());
    }
    if cleaned_at.is_some() {
        return Err("Restore the managed worktree before creating a branch here".to_string());
    }
    if let Some(stored_branch) = stored_branch {
        if stored_branch == branch_name.trim() {
            return Ok(stored_branch);
        }
        return Err(format!(
            "This run already created the branch '{stored_branch}'"
        ));
    }
    let source_cwd = source_cwd.ok_or_else(|| "Run has no source directory".to_string())?;
    let execution_cwd =
        execution_cwd.ok_or_else(|| "Run has no execution directory".to_string())?;
    if execution_cwd == source_cwd {
        return Err("Run did not use an isolated worktree".to_string());
    }

    let worktrees_root = automation_data_dir()?.join("worktrees");
    let expected_root = worktrees_root
        .join(sanitize_id(&automation_id))
        .join(sanitize_id(&run_id));
    let execution_path = PathBuf::from(&execution_cwd);
    let canonical_expected =
        validate_worktree_cleanup_paths(&worktrees_root, &expected_root, &execution_path)?;
    validate_managed_execution_cwd(&expected_root, &execution_path)?;
    let repository = validate_worktree_git_identity(Path::new(&source_cwd), &canonical_expected)?;
    let creation = create_branch_in_worktree(&repository, &canonical_expected, &branch_name)?;
    let created_at = now_ms();
    if let Err(database_error) = connection.execute(
        "UPDATE automation_runs SET worktree_branch_name=?2,worktree_branch_at=?3 WHERE run_id=?1",
        params![run_id, creation.branch_name, created_at],
    ) {
        if !creation.created {
            return Err(format!("Cannot record worktree branch: {database_error}"));
        }
        let rollback = rollback_created_worktree_branch(
            &repository,
            &canonical_expected,
            &creation.branch_name,
            &creation.previous_head,
        );
        return match rollback {
            Ok(_) => Err(format!(
                "Worktree branch creation was rolled back because its state could not be recorded: {database_error}"
            )),
            Err(rollback_error) => Err(format!(
                "Worktree branch state could not be recorded ({database_error}); rollback also failed: {rollback_error}"
            )),
        };
    }
    Ok(creation.branch_name)
}

#[tauri::command]
pub fn mark_automation_run_read(run_id: String) -> Result<(), String> {
    let connection = open_database()?;
    let now = now_ms();
    connection
        .execute(
            "UPDATE automation_runs SET read_at=?2 WHERE run_id=?1",
            params![run_id, now],
        )
        .map_err(|e| e.to_string())?;
    connection
        .execute(
            "UPDATE inbox_items SET read_at=?2 WHERE run_id=?1",
            params![run_id, now],
        )
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn mark_all_automation_runs_read() -> Result<u64, String> {
    let mut connection = open_database()?;
    let transaction = connection.transaction().map_err(|e| e.to_string())?;
    let now = now_ms();
    let updated = transaction
        .execute(
            "UPDATE automation_runs SET read_at=?1 WHERE read_at IS NULL AND status IN ('SUCCEEDED','NEEDS_ATTENTION','RESOLVED','FAILED','RECOVERED','PENDING_REVIEW')",
            params![now],
        )
        .map_err(|e| e.to_string())?;
    transaction
        .execute(
            "UPDATE inbox_items SET read_at=?1 WHERE read_at IS NULL AND run_id IN (SELECT run_id FROM automation_runs WHERE status IN ('SUCCEEDED','NEEDS_ATTENTION','RESOLVED','FAILED','RECOVERED','PENDING_REVIEW'))",
            params![now],
        )
        .map_err(|e| e.to_string())?;
    transaction.commit().map_err(|e| e.to_string())?;
    Ok(updated as u64)
}

fn resolve_automation_attention_in(
    connection: &mut Connection,
    run_id: &str,
    resolved_at: i64,
    resolution: &str,
) -> Result<(), String> {
    let transaction = connection.transaction().map_err(|e| e.to_string())?;
    let updated = transaction
        .execute(
            "UPDATE automation_runs SET status='RESOLVED',read_at=?2,attention_resolved_at=?2,attention_resolution=?3 WHERE run_id=?1 AND status='NEEDS_ATTENTION'",
            params![run_id, resolved_at, resolution],
        )
        .map_err(|e| e.to_string())?;
    if updated != 1 {
        return Err("Only a run currently awaiting a decision can be marked resolved".to_string());
    }
    transaction
        .execute(
            "UPDATE inbox_items SET read_at=?2 WHERE run_id=?1",
            params![run_id, resolved_at],
        )
        .map_err(|e| e.to_string())?;
    transaction
        .execute(
            "UPDATE automation_recovery_plans SET governance_pending=0,phase=CASE WHEN phase='VERDICT_PENDING' THEN 'COMPLETE' ELSE phase END WHERE original_run_id=?1 OR recovery_run_id=?1 OR catchup_run_id=?1",
            params![run_id],
        )
        .map_err(|e| e.to_string())?;
    transaction.commit().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn resolve_automation_attention(
    run_id: String,
    resolution: Option<String>,
) -> Result<(), String> {
    let mut connection = open_database()?;
    let resolution = resolution
        .map(|value| value.trim().chars().take(500).collect::<String>())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "user_confirmed".to_string());
    resolve_automation_attention_in(&mut connection, &run_id, now_ms(), &resolution)
}

#[tauri::command]
pub fn archive_automation_run(run_id: String, reason: Option<String>) -> Result<(), String> {
    let connection = open_database()?;
    connection
        .execute(
            "UPDATE automation_runs SET status='ARCHIVED',archived_reason=?2 WHERE run_id=?1",
            params![run_id, reason.unwrap_or_else(|| "user".to_string())],
        )
        .map_err(|e| e.to_string())?;
    connection
        .execute("DELETE FROM inbox_items WHERE run_id=?1", params![run_id])
        .map_err(|e| e.to_string())?;
    drop(connection);
    if let Err(error) = enforce_managed_worktree_retention() {
        eprintln!("[BLACKBOX AUTOMATIONS] worktree retention after archive failed: {error}");
    }
    Ok(())
}

#[tauri::command]
pub fn cleanup_automation_worktree(run_id: String) -> Result<(), String> {
    let connection = open_database()?;
    let record: Option<(
        String,
        Option<String>,
        Option<String>,
        String,
        Option<i64>,
        Option<String>,
        Option<String>,
        Option<String>,
    )> = connection
        .query_row(
            "SELECT automation_id,source_cwd,execution_cwd,status,worktree_cleaned_at,base_commit,worktree_input_snapshot_ref,session_id FROM automation_runs WHERE run_id=?1",
            params![run_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                    row.get(7)?,
                ))
            },
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let (
        automation_id,
        source_cwd,
        execution_cwd,
        status,
        cleaned_at,
        base_commit,
        input_snapshot_ref,
        session_id,
    ) = record.ok_or_else(|| "Automation run not found".to_string())?;
    if session_id
        .as_deref()
        .map(crate::task_handoff::is_current_worktree_session)
        .unwrap_or(false)
    {
        return Err(
            "This worktree is the current location of a handed-off task; hand it back to Local before cleaning"
                .to_string(),
        );
    }
    if status == "RUNNING" {
        return Err("Stop the automation before cleaning its worktree".to_string());
    }
    if cleaned_at.is_some() {
        return Ok(());
    }
    let source_cwd = source_cwd.ok_or_else(|| "Run has no source directory".to_string())?;
    let execution_cwd =
        execution_cwd.ok_or_else(|| "Run has no execution directory".to_string())?;
    if execution_cwd == source_cwd {
        return Err("Run did not use an isolated worktree".to_string());
    }

    let worktrees_root = automation_data_dir()?.join("worktrees");
    let expected_root = worktrees_root
        .join(sanitize_id(&automation_id))
        .join(sanitize_id(&run_id));
    if !expected_root.exists() {
        connection
            .execute(
                "UPDATE automation_runs SET worktree_cleaned_at=?2 WHERE run_id=?1",
                params![run_id, now_ms()],
            )
            .map_err(|error| error.to_string())?;
        return Ok(());
    }
    let execution_path = PathBuf::from(&execution_cwd);
    let canonical_expected =
        validate_worktree_cleanup_paths(&worktrees_root, &expected_root, &execution_path)?;
    let repository = validate_worktree_git_identity(Path::new(&source_cwd), &canonical_expected)?;
    let relative_cwd = validate_managed_execution_cwd(&expected_root, &execution_path)?;
    let expected_text = canonical_expected.to_string_lossy().to_string();
    let base_commit = match base_commit {
        Some(value) if valid_commit_id(&value) => value,
        _ => git_output(&["-C", &expected_text, "rev-parse", "HEAD"])
            .map_err(|error| format!("Cannot recover a legacy worktree baseline: {error}"))?,
    };
    let snapshot_dir = automation_data_dir()?
        .join("worktree-snapshots")
        .join(sanitize_id(&automation_id))
        .join(sanitize_id(&run_id));
    let snapshot = create_worktree_snapshot(
        &repository,
        &canonical_expected,
        &snapshot_dir,
        &automation_id,
        &run_id,
        &base_commit,
        &relative_cwd,
    )
    .map_err(|error| format!("Refusing to clean without a recovery snapshot: {error}"))?;
    connection
        .execute(
            "UPDATE automation_runs SET base_commit=?2,worktree_snapshot_ref=?3,worktree_snapshot_commit=?4,worktree_snapshot_at=?5 WHERE run_id=?1",
            params![
                run_id,
                snapshot.base_commit,
                snapshot.snapshot_ref,
                snapshot.snapshot_commit,
                snapshot.created_at
            ],
        )
        .map_err(|error| error.to_string())?;

    let repository_text = repository.to_string_lossy().to_string();
    git_output(&[
        "-C",
        &repository_text,
        "worktree",
        "remove",
        "--force",
        &expected_text,
    ])
    .map_err(|error| format!("Cannot clean isolated worktree: {error}"))?;
    let _ = git_output(&["-C", &repository_text, "worktree", "prune"]);
    if let Err(database_error) = connection.execute(
        "UPDATE automation_runs SET worktree_cleaned_at=?2 WHERE run_id=?1",
        params![run_id, now_ms()],
    ) {
        let rollback = restore_worktree_snapshot(
            &repository,
            &canonical_expected,
            &snapshot_dir,
            &automation_id,
            &run_id,
        );
        return match rollback {
            Ok(_) => Err(format!(
                "Worktree cleanup was rolled back because its state could not be recorded: {database_error}"
            )),
            Err(rollback_error) => Err(format!(
                "Worktree was cleaned but its state could not be recorded ({database_error}); automatic recovery also failed: {rollback_error}"
            )),
        };
    }
    if let Some(reference) = input_snapshot_ref.as_deref() {
        match release_worktree_input_snapshot(
            &repository,
            &automation_id,
            &run_id,
            reference,
            &snapshot.base_commit,
        ) {
            Ok(()) => {
                if let Err(error) = connection.execute(
                    "UPDATE automation_runs SET worktree_input_snapshot_ref=NULL WHERE run_id=?1",
                    params![run_id],
                ) {
                    eprintln!(
                        "[BLACKBOX AUTOMATIONS] released input ref but could not clear its run metadata: {error}"
                    );
                }
            }
            Err(error) => eprintln!(
                "[BLACKBOX AUTOMATIONS] kept redundant input snapshot ref after cleanup: {error}"
            ),
        }
    }
    Ok(())
}

#[tauri::command]
pub fn restore_automation_worktree(run_id: String) -> Result<(), String> {
    let connection = open_database()?;
    let record: Option<(
        String,
        Option<String>,
        Option<i64>,
        Option<String>,
        Option<String>,
    )> = connection
        .query_row(
            "SELECT automation_id,source_cwd,worktree_cleaned_at,worktree_snapshot_ref,worktree_snapshot_commit FROM automation_runs WHERE run_id=?1",
            params![run_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let (automation_id, source_cwd, cleaned_at, stored_ref, stored_commit) =
        record.ok_or_else(|| "Automation run not found".to_string())?;
    if cleaned_at.is_none() {
        return Err("This worktree has not been cleaned".to_string());
    }
    let source_cwd = source_cwd.ok_or_else(|| "Run has no source directory".to_string())?;
    let source_text = source_cwd.clone();
    let repository = PathBuf::from(git_output(&[
        "-C",
        &source_text,
        "rev-parse",
        "--show-toplevel",
    ])?);
    let repository = fs::canonicalize(repository)
        .map_err(|error| format!("Cannot resolve source Git repository: {error}"))?;
    let worktrees_root = automation_data_dir()?.join("worktrees");
    let expected_root = worktrees_root
        .join(sanitize_id(&automation_id))
        .join(sanitize_id(&run_id));
    let snapshot_dir = automation_data_dir()?
        .join("worktree-snapshots")
        .join(sanitize_id(&automation_id))
        .join(sanitize_id(&run_id));
    let (execution_cwd, metadata) = restore_worktree_snapshot(
        &repository,
        &expected_root,
        &snapshot_dir,
        &automation_id,
        &run_id,
    )?;
    if stored_ref.as_deref() != Some(metadata.snapshot_ref.as_str())
        || stored_commit.as_deref() != Some(metadata.snapshot_commit.as_str())
    {
        let repository_text = repository.to_string_lossy().to_string();
        let expected_text = expected_root.to_string_lossy().to_string();
        let _ = git_output(&[
            "-C",
            &repository_text,
            "worktree",
            "remove",
            "--force",
            &expected_text,
        ]);
        return Err("Stored run snapshot does not match recovery metadata".to_string());
    }
    if let Err(database_error) = connection.execute(
        "UPDATE automation_runs SET execution_cwd=?2,worktree_cleaned_at=NULL WHERE run_id=?1",
        params![run_id, execution_cwd.to_string_lossy().to_string()],
    ) {
        let repository_text = repository.to_string_lossy().to_string();
        let expected_text = expected_root.to_string_lossy().to_string();
        let rollback = git_output(&[
            "-C",
            &repository_text,
            "worktree",
            "remove",
            "--force",
            &expected_text,
        ]);
        let _ = git_output(&["-C", &repository_text, "worktree", "prune"]);
        return match rollback {
            Ok(_) => Err(format!(
                "Worktree restore was rolled back because its state could not be recorded: {database_error}"
            )),
            Err(rollback_error) => Err(format!(
                "Restored worktree state could not be recorded ({database_error}); automatic cleanup also failed: {rollback_error}"
            )),
        };
    }
    Ok(())
}

/// Deterministic command surface used by the bundled blackbox-schedule skill.
/// JSON is returned only after the same TOML read-back and SQLite reconciliation
/// gates used by the GUI commands have passed.
pub fn run_cli(arguments: &[String]) -> Result<String, String> {
    let command = arguments.first().map(String::as_str).unwrap_or("list");
    match command {
        "list" => {
            serde_json::to_string_pretty(&list_automations_read_only()?).map_err(|e| e.to_string())
        }
        "get" => {
            let id = arguments
                .get(1)
                .ok_or_else(|| "get requires an automation id".to_string())?;
            serde_json::to_string_pretty(&get_automation_read_only(id)?).map_err(|e| e.to_string())
        }
        "upsert" => {
            let path = arguments
                .get(1)
                .ok_or_else(|| "upsert requires a JSON file path".to_string())?;
            let bytes = fs::read(path).map_err(|e| format!("Cannot read definition JSON: {e}"))?;
            let mut definition: AutomationDefinition = serde_json::from_slice(&bytes)
                .map_err(|e| format!("Cannot parse definition JSON: {e}"))?;
            if definition.kind == "heartbeat" && definition.target_thread_id.is_none() {
                definition.target_thread_id = std::env::var("BLACKBOX_SESSION_ID").ok();
            }
            if definition.kind == "cron" && definition.target.is_none() {
                let cwd = std::env::current_dir()
                    .map_err(|e| e.to_string())?
                    .to_string_lossy()
                    .to_string();
                definition.target = Some(AutomationTarget {
                    target_type: "project".to_string(),
                    project_id: cwd.clone(),
                });
                definition.cwds = vec![cwd];
            }
            serde_json::to_string_pretty(&upsert_automation(definition)?).map_err(|e| e.to_string())
        }
        "pause" | "resume" => {
            let id = arguments
                .get(1)
                .ok_or_else(|| format!("{command} requires an automation id"))?;
            let status = if command == "pause" { PAUSED } else { ACTIVE };
            serde_json::to_string_pretty(&set_automation_status(id.clone(), status.to_string())?)
                .map_err(|e| e.to_string())
        }
        "delete" => {
            let id = arguments
                .get(1)
                .ok_or_else(|| "delete requires an automation id".to_string())?;
            delete_automation(id.clone())?;
            Ok(serde_json::json!({"deleted": id}).to_string())
        }
        "run" => {
            let id = arguments
                .get(1)
                .ok_or_else(|| "run requires an automation id".to_string())?;
            serde_json::to_string_pretty(&run_automation_blocking(id)).map_err(|e| e.to_string())
        }
        "runs" => {
            let automation_id = arguments.get(1).cloned();
            serde_json::to_string_pretty(&list_automation_runs_read_only(automation_id, Some(50))?)
                .map_err(|e| e.to_string())
        }
        "review" => {
            let run_id = arguments
                .get(1)
                .ok_or_else(|| "review requires a run id".to_string())?;
            serde_json::to_string_pretty(&get_automation_worktree_review(run_id.clone())?)
                .map_err(|e| e.to_string())
        }
        _ => Err(format!("Unknown automation command: {command}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_only_database_connection_cannot_mutate_state() {
        let sandbox = tempfile::tempdir().unwrap();
        let path = sandbox.path().join("automations.sqlite");
        let writable = Connection::open(&path).unwrap();
        writable
            .execute_batch(
                "CREATE TABLE probe (id INTEGER PRIMARY KEY); INSERT INTO probe (id) VALUES (1);",
            )
            .unwrap();
        drop(writable);

        let read_only = open_database_read_only_at(&path).unwrap();
        let query_only: i64 = read_only
            .query_row("PRAGMA query_only", [], |row| row.get(0))
            .unwrap();
        let count: i64 = read_only
            .query_row("SELECT COUNT(*) FROM probe", [], |row| row.get(0))
            .unwrap();

        assert_eq!(query_only, 1);
        assert_eq!(count, 1);
        assert!(read_only
            .execute("INSERT INTO probe (id) VALUES (2)", [])
            .is_err());
    }

    #[test]
    fn read_only_database_connection_observes_an_active_wal() {
        let sandbox = tempfile::tempdir().unwrap();
        let path = sandbox.path().join("automations.sqlite");
        let writable = Connection::open(&path).unwrap();
        writable
            .execute_batch(
                "PRAGMA journal_mode=WAL; CREATE TABLE probe (id INTEGER PRIMARY KEY); INSERT INTO probe (id) VALUES (1);",
            )
            .unwrap();

        let read_only = open_database_read_only_at(&path).unwrap();
        let count: i64 = read_only
            .query_row("SELECT COUNT(*) FROM probe", [], |row| row.get(0))
            .unwrap();

        assert_eq!(count, 1);
    }

    #[test]
    fn manual_and_scheduled_automation_triggers_are_distinct() {
        assert_eq!(automation_trigger(None), "manual");
        assert_eq!(automation_trigger(Some(1_785_363_000_000)), "scheduled");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn automation_child_is_stopped_after_stream_inactivity() {
        let mut command = Command::new("sh");
        command
            .args(["-c", "sleep 5 & wait"])
            .stdout(Stdio::piped());
        isolate_automation_process_group(&mut command);
        let mut child = command.spawn().unwrap();
        let mut stdout = child.stdout.take().unwrap();
        let (_cancel_sender, cancel_receiver) = oneshot::channel();
        let (_activity_sender, activity_receiver) = mpsc::channel(1);
        let inactivity = Duration::from_millis(50);

        let result = wait_for_automation_child(
            &mut child,
            cancel_receiver,
            activity_receiver,
            Duration::from_secs(1),
            inactivity,
        )
        .await;

        assert_eq!(result, Err(AutomationWaitFailure::Inactive(inactivity)));
        assert!(child.try_wait().unwrap().is_some());
        let mut bytes = Vec::new();
        assert!(
            tokio::time::timeout(Duration::from_millis(250), stdout.read_to_end(&mut bytes))
                .await
                .is_ok(),
            "the isolated tool subprocess must not keep stdout open"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn stream_activity_resets_the_automation_inactivity_deadline() {
        let mut child = Command::new("sh")
            .args(["-c", "sleep 0.14"])
            .stdout(Stdio::null())
            .spawn()
            .unwrap();
        let (_cancel_sender, cancel_receiver) = oneshot::channel();
        let (activity_sender, activity_receiver) = mpsc::channel(1);
        let activity_task = tokio::spawn(async move {
            for _ in 0..5 {
                tokio::time::sleep(Duration::from_millis(25)).await;
                let _ = activity_sender.send(()).await;
            }
        });

        let result = wait_for_automation_child(
            &mut child,
            cancel_receiver,
            activity_receiver,
            Duration::from_secs(1),
            Duration::from_millis(50),
        )
        .await;
        activity_task.await.unwrap();

        assert!(result.unwrap().success());
    }

    #[test]
    fn configured_automation_write_paths_stay_under_the_data_root() {
        let sandbox = tempfile::tempdir().unwrap();
        let data_dir = sandbox.path().join("blackbox-data");
        let definition = AutomationDefinition {
            data_write_subdirectories: vec!["task-artifacts".to_string()],
            ..Default::default()
        };
        assert_eq!(
            prepare_automation_write_paths(&definition, &data_dir).unwrap(),
            vec![fs::canonicalize(data_dir.join("task-artifacts")).unwrap()]
        );
        assert!(
            prepare_automation_write_paths(&AutomationDefinition::default(), &data_dir)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn automation_write_paths_reject_parent_traversal() {
        let definition = AutomationDefinition {
            data_write_subdirectories: vec!["../escape".to_string()],
            ..Default::default()
        };
        assert!(validate_data_write_subdirectories(&definition).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn automation_write_paths_reject_symlink_escape() {
        use std::os::unix::fs::symlink;

        let sandbox = tempfile::tempdir().unwrap();
        let data_dir = sandbox.path().join("blackbox-data");
        let outside = tempfile::tempdir().unwrap();
        fs::create_dir_all(&data_dir).unwrap();
        symlink(outside.path(), data_dir.join("escape")).unwrap();
        let definition = AutomationDefinition {
            data_write_subdirectories: vec!["escape".to_string()],
            ..Default::default()
        };

        let error = prepare_automation_write_paths(&definition, &data_dir).unwrap_err();
        assert!(error.contains("escaped Black Box data"));
    }

    #[test]
    fn automation_activity_summary_query_reads_metadata_only() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                r#"
                CREATE TABLE automations (
                  id TEXT PRIMARY KEY,
                  kind TEXT NOT NULL,
                  name TEXT NOT NULL,
                  prompt TEXT NOT NULL,
                  status TEXT NOT NULL,
                  next_run_at INTEGER,
                  last_run_at INTEGER,
                  active_run_id TEXT,
                  updated_at INTEGER NOT NULL
                );
                CREATE TABLE automation_runs (
                  run_id TEXT PRIMARY KEY,
                  automation_id TEXT NOT NULL,
                  session_id TEXT,
                  status TEXT NOT NULL,
                  read_at INTEGER,
                  started_at INTEGER NOT NULL,
                  summary TEXT,
                  output TEXT,
                  trace_json TEXT,
                  error TEXT
                );
                INSERT INTO automations
                  (id,kind,name,prompt,status,next_run_at,last_run_at,active_run_id,updated_at)
                VALUES
                  ('auto-1','cron','Nightly review','PROMPT_SECRET','ACTIVE',200,100,'run-active',300);
                INSERT INTO automation_runs
                  (run_id,automation_id,status,read_at,started_at,summary,output,trace_json,error)
                VALUES
                  ('run-success','auto-1','SUCCEEDED',NULL,100,'SUMMARY_SECRET','OUTPUT_SECRET','TRACE_SECRET','ERROR_SECRET'),
                  ('run-attention','auto-1','NEEDS_ATTENTION',NULL,110,'SUMMARY_SECRET','OUTPUT_SECRET','TRACE_SECRET','ERROR_SECRET'),
                  ('run-resolved','auto-1','RESOLVED',NULL,115,'SUMMARY_SECRET','OUTPUT_SECRET','TRACE_SECRET','ERROR_SECRET'),
                  ('run-failed','auto-1','FAILED',NULL,120,'SUMMARY_SECRET','OUTPUT_SECRET','TRACE_SECRET','ERROR_SECRET'),
                  ('run-recovered','auto-1','RECOVERED',NULL,125,'SUMMARY_SECRET','OUTPUT_SECRET','TRACE_SECRET','ERROR_SECRET'),
                  ('run-legacy','auto-1','PENDING_REVIEW',NULL,130,'SUMMARY_SECRET','OUTPUT_SECRET','TRACE_SECRET','ERROR_SECRET'),
                  ('run-active','auto-1','RUNNING',NULL,200,'ACTIVE_SUMMARY_SECRET','ACTIVE_OUTPUT_SECRET','ACTIVE_TRACE_SECRET','ACTIVE_ERROR_SECRET');
                UPDATE automation_runs
                   SET session_id='session-active'
                 WHERE run_id='run-active';
                "#,
            )
            .unwrap();

        let summaries = query_automation_activity_summaries(&connection).unwrap();
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].id, "auto-1");
        assert_eq!(summaries[0].title, "Nightly review");
        assert_eq!(summaries[0].definition_status, "ACTIVE");
        assert_eq!(summaries[0].run_status.as_deref(), Some("RUNNING"));
        assert_eq!(summaries[0].schedule_kind, "cron");
        assert_eq!(summaries[0].active_run_id.as_deref(), Some("run-active"));
        assert!(summaries[0].running);
        assert_eq!(summaries[0].unread_runs, 6);

        let active_sessions = query_active_automation_sessions(&connection).unwrap();
        assert_eq!(active_sessions.len(), 1);
        assert_eq!(active_sessions[0].run_id, "run-active");
        assert_eq!(active_sessions[0].automation_id, "auto-1");
        assert_eq!(active_sessions[0].session_id, "session-active");
        assert_eq!(active_sessions[0].title, "Nightly review");
        assert_eq!(active_sessions[0].started_at, 200);

        let serialized_text = serde_json::to_string(&summaries).unwrap();
        let active_serialized = serde_json::to_string(&active_sessions).unwrap();
        for sentinel in [
            "PROMPT_SECRET",
            "SUMMARY_SECRET",
            "OUTPUT_SECRET",
            "TRACE_SECRET",
            "ERROR_SECRET",
        ] {
            assert!(!serialized_text.contains(sentinel));
            assert!(!active_serialized.contains(sentinel));
        }

        let query = AUTOMATION_ACTIVITY_SUMMARY_SQL.to_ascii_lowercase();
        for forbidden_column in [
            "prompt",
            "summary",
            "output",
            "trace_json",
            "error",
            "secret",
            "api_key",
        ] {
            assert!(
                !query.contains(forbidden_column),
                "activity query selected forbidden column {forbidden_column}"
            );
        }
    }

    #[test]
    fn legacy_pending_review_runs_migrate_to_succeeded() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                r#"
                CREATE TABLE automation_runs (
                  run_id TEXT PRIMARY KEY,
                  status TEXT NOT NULL
                );
                INSERT INTO automation_runs (run_id,status) VALUES
                  ('legacy','PENDING_REVIEW'),
                  ('attention','NEEDS_ATTENTION');
                "#,
            )
            .unwrap();

        assert_eq!(migrate_legacy_run_statuses(&connection).unwrap(), 1);
        assert_eq!(
            connection
                .query_row(
                    "SELECT status FROM automation_runs WHERE run_id='legacy'",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            "SUCCEEDED"
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT status FROM automation_runs WHERE run_id='attention'",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            "NEEDS_ATTENTION"
        );
    }

    #[test]
    fn attention_resolution_is_a_durable_one_way_transition() {
        let mut connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                r#"
                CREATE TABLE automation_runs (
                  run_id TEXT PRIMARY KEY,
                  status TEXT NOT NULL,
                  read_at INTEGER,
                  attention_resolved_at INTEGER,
                  attention_resolution TEXT
                );
                CREATE TABLE inbox_items (run_id TEXT PRIMARY KEY, read_at INTEGER);
                CREATE TABLE automation_recovery_plans (
                  original_run_id TEXT PRIMARY KEY,
                  recovery_run_id TEXT NOT NULL,
                  catchup_run_id TEXT,
                  phase TEXT NOT NULL,
                  governance_pending INTEGER NOT NULL DEFAULT 0
                );
                INSERT INTO automation_runs (run_id,status) VALUES ('attention','NEEDS_ATTENTION');
                INSERT INTO inbox_items (run_id,read_at) VALUES ('attention',NULL);
                INSERT INTO automation_recovery_plans
                  (original_run_id,recovery_run_id,catchup_run_id,phase,governance_pending)
                VALUES ('attention','retry',NULL,'VERDICT_PENDING',1);
                "#,
            )
            .unwrap();

        resolve_automation_attention_in(&mut connection, "attention", 1234, "user_confirmed")
            .unwrap();
        let resolved: (String, Option<i64>, Option<i64>, Option<String>) = connection
            .query_row(
                "SELECT status,read_at,attention_resolved_at,attention_resolution FROM automation_runs WHERE run_id='attention'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(resolved.0, "RESOLVED");
        assert_eq!(resolved.1, Some(1234));
        assert_eq!(resolved.2, Some(1234));
        assert_eq!(resolved.3.as_deref(), Some("user_confirmed"));
        let plan: (String, bool) = connection
            .query_row(
                "SELECT phase,governance_pending FROM automation_recovery_plans WHERE original_run_id='attention'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(plan, ("COMPLETE".to_string(), false));
        assert!(
            resolve_automation_attention_in(&mut connection, "attention", 5678, "duplicate",)
                .is_err()
        );
    }

    #[test]
    fn successful_retry_recovers_original_without_erasing_failure_evidence() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                r#"
                CREATE TABLE automation_runs (
                  run_id TEXT PRIMARY KEY,
                  status TEXT NOT NULL,
                  read_at INTEGER,
                  error TEXT,
                  trace_json TEXT,
                  retry_of_run_id TEXT,
                  recovered_by_run_id TEXT,
                  recovered_at INTEGER,
                  recovery_evidence TEXT
                );
                CREATE TABLE inbox_items (
                  run_id TEXT PRIMARY KEY,
                  read_at INTEGER
                );
                INSERT INTO automation_runs
                  (run_id,status,error,trace_json,retry_of_run_id)
                VALUES
                  ('original','FAILED','ORIGINAL_FAILURE','ORIGINAL_TRACE',NULL),
                  ('retry','SUCCEEDED',NULL,'RETRY_TRACE','original');
                INSERT INTO inbox_items (run_id,read_at) VALUES ('retry',NULL);
                "#,
            )
            .unwrap();

        assert!(record_successful_retry(&connection, "original", "retry", 1234).unwrap());
        let original: (String, Option<String>, Option<i64>, Option<String>, String, String) =
            connection
                .query_row(
                    "SELECT status,recovered_by_run_id,recovered_at,recovery_evidence,error,trace_json FROM automation_runs WHERE run_id='original'",
                    [],
                    |row| {
                        Ok((
                            row.get(0)?,
                            row.get(1)?,
                            row.get(2)?,
                            row.get(3)?,
                            row.get(4)?,
                            row.get(5)?,
                        ))
                    },
                )
                .unwrap();
        assert_eq!(original.0, "RECOVERED");
        assert_eq!(original.1.as_deref(), Some("retry"));
        assert_eq!(original.2, Some(1234));
        assert_eq!(original.3.as_deref(), Some("automation-run:retry"));
        assert_eq!(original.4, "ORIGINAL_FAILURE");
        assert_eq!(original.5, "ORIGINAL_TRACE");
        assert_eq!(
            connection
                .query_row(
                    "SELECT read_at FROM automation_runs WHERE run_id='retry'",
                    [],
                    |row| row.get::<_, Option<i64>>(0),
                )
                .unwrap(),
            Some(1234)
        );
    }

    fn receipt_probe_definition(project: &Path) -> AutomationDefinition {
        AutomationDefinition {
            id: "daily-review-dream".to_string(),
            name: "daily-dream".to_string(),
            target: Some(AutomationTarget {
                target_type: "project".to_string(),
                project_id: project.to_string_lossy().to_string(),
            }),
            cwds: vec![project.to_string_lossy().to_string()],
            completion_probe: Some(AutomationCompletionProbe {
                relative_path: "receipts/{date}.json".to_string(),
                base_directory: "project".to_string(),
                scheduled_date_offset_days: -1,
                json_equals: BTreeMap::from([
                    ("logical_date".to_string(), "{date}".to_string()),
                    ("status".to_string(), "COMMITTED".to_string()),
                ]),
                reference_relative_path: None,
                json_matches_reference: vec![],
                required_absent_relative_paths: vec![],
                recovered_title: Some("{name} {date} 完成".to_string()),
            }),
            ..Default::default()
        }
    }

    fn durable_bundle_probe_definition(project: &Path) -> AutomationDefinition {
        AutomationDefinition {
            id: "daily-review-dream".to_string(),
            name: "daily-dream".to_string(),
            target: Some(AutomationTarget {
                target_type: "project".to_string(),
                project_id: project.to_string_lossy().to_string(),
            }),
            cwds: vec![project.to_string_lossy().to_string()],
            data_write_subdirectories: vec!["dream-runs".to_string()],
            completion_probe: Some(AutomationCompletionProbe {
                relative_path: "dream-runs/{date}/commit_receipt.json".to_string(),
                base_directory: "automation_data".to_string(),
                scheduled_date_offset_days: -1,
                json_equals: BTreeMap::from([
                    ("logical_date".to_string(), "{date}".to_string()),
                    ("status".to_string(), "COMMITTED".to_string()),
                ]),
                reference_relative_path: Some("dream-runs/{date}/manifest.json".to_string()),
                json_matches_reference: vec!["logical_date".to_string(), "run_id".to_string()],
                required_absent_relative_paths: vec![
                    "dream-runs/_locks/{date}.lock.json".to_string()
                ],
                recovered_title: Some("{name} {date} 完成".to_string()),
            }),
            ..Default::default()
        }
    }

    #[test]
    fn completion_probe_expands_scheduled_date_and_verifies_json_receipt() {
        let project = tempfile::tempdir().unwrap();
        let receipts = project.path().join("receipts");
        fs::create_dir_all(&receipts).unwrap();
        fs::write(
            receipts.join("2026-08-15.json"),
            br#"{"logical_date":"2026-08-15","status":"COMMITTED"}"#,
        )
        .unwrap();
        let scheduled_at = Local
            .with_ymd_and_hms(2026, 8, 16, 6, 30, 0)
            .single()
            .unwrap()
            .timestamp_millis();
        let evidence =
            probe_completion_receipt(&receipt_probe_definition(project.path()), scheduled_at, 0)
                .unwrap();
        assert_eq!(
            evidence.as_ref().map(|(evidence, _)| evidence.as_str()),
            Some("completion-receipt:receipts/2026-08-15.json")
        );
        let stale = probe_completion_receipt(
            &receipt_probe_definition(project.path()),
            scheduled_at,
            now_ms().saturating_add(60_000),
        )
        .unwrap();
        assert!(stale.is_none());
    }

    #[test]
    fn attention_requires_the_configured_completion_receipt() {
        let project = tempfile::tempdir().unwrap();
        let scheduled_at = Local
            .with_ymd_and_hms(2026, 8, 16, 6, 30, 0)
            .single()
            .unwrap()
            .timestamp_millis();
        let definition = receipt_probe_definition(project.path());
        assert!(attention_completion_failure(&definition, Some(scheduled_at), 0).is_some());

        let receipts = project.path().join("receipts");
        fs::create_dir_all(&receipts).unwrap();
        fs::write(
            receipts.join("2026-08-15.json"),
            br#"{"logical_date":"2026-08-15","status":"COMMITTED"}"#,
        )
        .unwrap();
        assert!(attention_completion_failure(&definition, Some(scheduled_at), 0).is_none());
    }

    #[test]
    fn completion_probe_requires_matching_bundle_and_released_lock() {
        let project = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        let bundle = data.path().join("dream-runs/2026-08-15");
        let locks = data.path().join("dream-runs/_locks");
        fs::create_dir_all(&bundle).unwrap();
        fs::create_dir_all(&locks).unwrap();
        fs::write(
            bundle.join("commit_receipt.json"),
            br#"{"logical_date":"2026-08-15","status":"COMMITTED","run_id":"dream-run-1"}"#,
        )
        .unwrap();
        fs::write(
            bundle.join("manifest.json"),
            br#"{"logical_date":"2026-08-15","run_id":"dream-run-1"}"#,
        )
        .unwrap();
        let definition = durable_bundle_probe_definition(project.path());
        validate_completion_probe(&definition).unwrap();
        let scheduled_at = Local
            .with_ymd_and_hms(2026, 8, 16, 6, 30, 0)
            .single()
            .unwrap()
            .timestamp_millis();

        let completed =
            probe_completion_receipt_at(&definition, scheduled_at, 0, data.path()).unwrap();
        assert_eq!(
            completed.as_ref().map(|(_, title)| title.as_str()),
            Some("daily-dream 2026-08-15 完成")
        );
        assert!(completed
            .as_ref()
            .is_some_and(|(evidence, _)| evidence.contains("manifest.json")));

        fs::write(
            locks.join("2026-08-15.lock.json"),
            br#"{"holder":"schedule:run-1"}"#,
        )
        .unwrap();
        assert!(
            probe_completion_receipt_at(&definition, scheduled_at, 0, data.path())
                .unwrap()
                .is_none()
        );
        fs::remove_file(locks.join("2026-08-15.lock.json")).unwrap();

        fs::write(
            bundle.join("manifest.json"),
            br#"{"logical_date":"2026-08-15","run_id":"other-run"}"#,
        )
        .unwrap();
        assert!(
            probe_completion_receipt_at(&definition, scheduled_at, 0, data.path())
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn automation_data_completion_probe_cannot_read_outside_write_scope() {
        let project = tempfile::tempdir().unwrap();
        let mut definition = durable_bundle_probe_definition(project.path());
        definition.completion_probe.as_mut().unwrap().relative_path =
            "automations.sqlite".to_string();
        assert!(validate_completion_probe(&definition).is_err());
    }

    #[test]
    fn failed_scheduled_run_is_recovered_from_a_fresh_completion_receipt() {
        let project = tempfile::tempdir().unwrap();
        let receipts = project.path().join("receipts");
        fs::create_dir_all(&receipts).unwrap();
        fs::write(
            receipts.join("2026-08-15.json"),
            br#"{"logical_date":"2026-08-15","status":"COMMITTED"}"#,
        )
        .unwrap();
        let scheduled_at = Local
            .with_ymd_and_hms(2026, 8, 16, 6, 30, 0)
            .single()
            .unwrap()
            .timestamp_millis();
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                r#"
                CREATE TABLE automation_runs (
                  run_id TEXT PRIMARY KEY,
                  automation_id TEXT NOT NULL,
                  status TEXT NOT NULL,
                  read_at INTEGER,
                  title TEXT,
                  scheduled_at INTEGER,
                  started_at INTEGER NOT NULL,
                  retry_of_run_id TEXT,
                  recovered_at INTEGER,
                  recovery_evidence TEXT
                );
                CREATE TABLE inbox_items (
                  run_id TEXT PRIMARY KEY,
                  title TEXT,
                  description TEXT,
                  read_at INTEGER
                );
                "#,
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO automation_runs (run_id,automation_id,status,title,scheduled_at,started_at) VALUES ('run-1','daily-review-dream','FAILED','daily-dream failed',?1,0)",
                params![scheduled_at],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO inbox_items (run_id,title,description) VALUES ('run-1','failed','transport failed')",
                [],
            )
            .unwrap();

        let recovered = reconcile_failed_completion_probes(
            &connection,
            &[receipt_probe_definition(project.path())],
        )
        .unwrap();
        assert_eq!(recovered, 1);
        let result: (String, String, Option<i64>, Option<String>) = connection
            .query_row(
                "SELECT status,title,recovered_at,recovery_evidence FROM automation_runs WHERE run_id='run-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(result.0, "RECOVERED");
        assert_eq!(result.1, "daily-dream 2026-08-15 完成");
        assert!(result.2.is_some());
        assert_eq!(
            result.3.as_deref(),
            Some("completion-receipt:receipts/2026-08-15.json")
        );
    }

    #[test]
    fn historical_attention_without_completion_receipt_is_reclassified_as_failed() {
        let project = tempfile::tempdir().unwrap();
        let receipts = project.path().join("receipts");
        fs::create_dir_all(&receipts).unwrap();
        fs::write(
            receipts.join("2026-08-15.json"),
            br#"{"logical_date":"2026-08-15","status":"COMMITTED"}"#,
        )
        .unwrap();
        let completed_at = Local
            .with_ymd_and_hms(2026, 8, 16, 6, 30, 0)
            .single()
            .unwrap()
            .timestamp_millis();
        let incomplete_at = Local
            .with_ymd_and_hms(2026, 8, 17, 6, 30, 0)
            .single()
            .unwrap()
            .timestamp_millis();
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                r#"
                CREATE TABLE automation_runs (
                  run_id TEXT PRIMARY KEY,
                  automation_id TEXT NOT NULL,
                  status TEXT NOT NULL,
                  read_at INTEGER,
                  title TEXT,
                  summary TEXT,
                  error TEXT,
                  scheduled_at INTEGER,
                  started_at INTEGER NOT NULL,
                  retry_of_run_id TEXT
                );
                CREATE TABLE inbox_items (
                  run_id TEXT PRIMARY KEY,
                  title TEXT,
                  description TEXT,
                  read_at INTEGER
                );
                "#,
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO automation_runs (run_id,automation_id,status,title,summary,scheduled_at,started_at) VALUES ('complete','daily-review-dream','NEEDS_ATTENTION','complete','decision',?1,0),('incomplete','daily-review-dream','NEEDS_ATTENTION','incomplete','decision',?2,0)",
                params![completed_at, incomplete_at],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO inbox_items (run_id,title,description) VALUES ('complete','complete','decision'),('incomplete','incomplete','decision')",
                [],
            )
            .unwrap();

        let reclassified = reconcile_incomplete_attention_probes_at(
            &connection,
            &[receipt_probe_definition(project.path())],
            project.path(),
        )
        .unwrap();
        assert_eq!(reclassified, 1);
        assert_eq!(
            connection
                .query_row(
                    "SELECT status FROM automation_runs WHERE run_id='complete'",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            "NEEDS_ATTENTION"
        );
        let incomplete: (String, String, String) = connection
            .query_row(
                "SELECT status,title,summary FROM automation_runs WHERE run_id='incomplete'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(incomplete.0, "FAILED");
        assert_eq!(incomplete.1, "daily-dream failed");
        assert!(incomplete.2.contains("completion receipt"));
    }

    #[test]
    fn legacy_provider_index_bindings_migrate_to_conversation_runtime() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                r#"
                CREATE TABLE automations (
                  id TEXT PRIMARY KEY,
                  provider_id TEXT,
                  provider_revision INTEGER
                );
                INSERT INTO automations (id,provider_id,provider_revision) VALUES
                  ('legacy','deleted-provider',7),
                  ('portable',NULL,NULL);
                "#,
            )
            .unwrap();

        assert_eq!(
            migrate_legacy_provider_index_bindings(&connection).unwrap(),
            1
        );
        let binding: (Option<String>, Option<u64>) = connection
            .query_row(
                "SELECT provider_id,provider_revision FROM automations WHERE id='legacy'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(binding, (None, None));
    }

    #[test]
    fn automation_activity_summary_serialization_uses_exact_allowlist() {
        let summary = AutomationActivitySummary {
            id: "auto-1".to_string(),
            title: "Nightly review".to_string(),
            definition_status: "ACTIVE".to_string(),
            run_status: Some("RUNNING".to_string()),
            schedule_kind: "cron".to_string(),
            next_run_at: Some(200),
            last_run_at: Some(100),
            active_run_id: Some("run-active".to_string()),
            running: true,
            unread_runs: 1,
            updated_at: 300,
        };
        let serialized = serde_json::to_value(summary).unwrap();
        let object = serialized.as_object().unwrap();
        let keys = object
            .keys()
            .map(String::as_str)
            .collect::<std::collections::BTreeSet<_>>();
        let expected = [
            "activeRunId",
            "definitionStatus",
            "id",
            "lastRunAt",
            "nextRunAt",
            "runStatus",
            "running",
            "scheduleKind",
            "title",
            "unreadRuns",
            "updatedAt",
        ]
        .into_iter()
        .collect::<std::collections::BTreeSet<_>>();
        assert_eq!(keys, expected);
        for forbidden in [
            "prompt", "summary", "output", "trace", "error", "secret", "apiKey",
        ] {
            assert!(!object.contains_key(forbidden));
        }
    }

    #[test]
    fn parses_daily_and_weekly_rules() {
        let daily = parse_rrule("FREQ=DAILY;BYHOUR=2;BYMINUTE=15;BYSECOND=0").unwrap();
        assert_eq!(daily.freq, "DAILY");
        assert_eq!(daily.by_hour, 2);
        let weekly = parse_rrule("RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR;BYHOUR=18;BYMINUTE=30").unwrap();
        assert!(weekly.by_days.contains(&Weekday::Wed));
    }

    #[test]
    fn next_daily_occurrence_is_in_the_future() {
        let now = now_ms();
        let next = next_occurrence("FREQ=DAILY;BYHOUR=6;BYMINUTE=10;BYSECOND=0", now).unwrap();
        assert!(next > now);
    }

    #[test]
    fn id_sanitization_is_stable() {
        assert_eq!(sanitize_id("Daily Dream  02:00"), "daily-dream-02-00");
    }

    #[test]
    fn worktree_retention_only_selects_old_archived_unbranched_runs() {
        let record = |run_id: &str,
                      status: &str,
                      source: &str,
                      execution: &str,
                      cleaned_at: Option<i64>,
                      branch_name: Option<&str>,
                      started_at: i64| ManagedWorktreeRetentionRecord {
            run_id: run_id.to_string(),
            status: status.to_string(),
            source_cwd: Some(source.to_string()),
            execution_cwd: Some(execution.to_string()),
            cleaned_at,
            branch_name: branch_name.map(str::to_string),
            handoff_protected: false,
            started_at,
            finished_at: Some(started_at + 1),
        };
        let records = vec![
            record(
                "archived-old",
                "ARCHIVED",
                "/repo",
                "/wt/old",
                None,
                None,
                10,
            ),
            record(
                "archived-new",
                "ARCHIVED",
                "/repo",
                "/wt/new",
                None,
                None,
                20,
            ),
            record(
                "completed",
                "SUCCEEDED",
                "/repo",
                "/wt/completed",
                None,
                None,
                1,
            ),
            record("running", "RUNNING", "/repo", "/wt/running", None, None, 2),
            record(
                "branched",
                "ARCHIVED",
                "/repo",
                "/wt/branched",
                None,
                Some("blackbox/keep"),
                3,
            ),
            record(
                "cleaned",
                "ARCHIVED",
                "/repo",
                "/wt/cleaned",
                Some(4),
                None,
                4,
            ),
            record("local", "ARCHIVED", "/repo", "/repo", None, None, 5),
        ];
        let mut records = records;
        let mut protected = record(
            "handoff-protected",
            "ARCHIVED",
            "/repo",
            "/wt/protected",
            None,
            None,
            0,
        );
        protected.handoff_protected = true;
        records.push(protected);

        assert_eq!(
            managed_worktree_retention_candidates(&records, Some(3)),
            vec!["archived-old".to_string(), "archived-new".to_string()]
        );
        assert!(managed_worktree_retention_candidates(&records, None).is_empty());
        assert!(managed_worktree_retention_candidates(&records, Some(5)).is_empty());
        assert_eq!(
            managed_worktree_retention_candidates(&records, Some(1)),
            vec!["archived-old".to_string(), "archived-new".to_string()]
        );
    }

    fn provider_fixture() -> crate::ProvidersFile {
        serde_json::from_value(serde_json::json!({
            "version": 4,
            "defaultApi": "relay",
            "defaultMainModel": "sonnet",
            "defaultAuxiliaryModel": "haiku",
            "activeProviderId": "relay",
            "providers": [{
                "id": "relay",
                "name": "Relay",
                "baseUrl": "https://example.invalid",
                "apiFormat": "anthropic",
                "apiKey": "test-only",
                "revision": 7,
                "modelMappings": [
                    { "tier": "fable", "providerModel": "relay-fable" },
                    { "tier": "opus", "providerModel": "relay-opus" },
                    { "tier": "sonnet", "providerModel": "relay-sonnet" },
                    { "tier": "haiku", "providerModel": "relay-haiku" }
                ],
                "createdAt": 0,
                "updatedAt": 0
            }]
        }))
        .unwrap()
    }

    #[test]
    fn automation_models_follow_the_default_system_configuration() {
        let providers = provider_fixture();
        let haiku = AutomationDefinition {
            model: Some("haiku".to_string()),
            legacy_provider_id: Some("deleted-provider".to_string()),
            legacy_provider_revision: Some(99),
            ..Default::default()
        };
        let (provider, model) = resolve_provider_and_model_with(&haiku, &providers).unwrap();
        assert_eq!(provider.as_deref(), Some("relay"));
        assert_eq!(model, "relay-haiku");
    }

    #[test]
    fn automation_models_migrate_legacy_claude_ids_by_family() {
        let providers = provider_fixture();
        let definition = AutomationDefinition {
            model: Some("claude-opus-4-8".to_string()),
            legacy_provider_id: Some("relay".to_string()),
            legacy_provider_revision: Some(7),
            ..Default::default()
        };
        assert_eq!(
            resolve_provider_and_model_with(&definition, &providers)
                .unwrap()
                .1,
            "relay-opus"
        );
    }

    #[test]
    fn automation_models_fail_closed_when_a_provider_tier_is_missing() {
        let mut providers = provider_fixture();
        providers.providers[0]
            .model_mappings
            .retain(|mapping| mapping.tier != "fable");
        let definition = AutomationDefinition {
            model: Some("fable".to_string()),
            legacy_provider_id: Some("relay".to_string()),
            legacy_provider_revision: Some(7),
            ..Default::default()
        };
        let error = resolve_provider_and_model_with(&definition, &providers).unwrap_err();
        assert!(error.contains("no model mapping for the fable tier"));
    }

    #[test]
    fn legacy_task_provider_bindings_never_control_execution() {
        let mut providers = provider_fixture();
        let legacy = AutomationDefinition {
            model: Some("opus".to_string()),
            legacy_provider_id: Some("deleted-provider".to_string()),
            legacy_provider_revision: Some(1),
            ..Default::default()
        };
        providers.providers[0].revision = 500;
        assert_eq!(
            resolve_provider_and_model_with(&legacy, &providers).unwrap(),
            (Some("relay".to_string()), "relay-opus".to_string())
        );

        providers.default_api = Some("missing-default".to_string());
        assert!(resolve_provider_and_model_with(&legacy, &providers)
            .unwrap_err()
            .contains("default system API missing-default does not exist"));
    }

    #[test]
    fn automation_models_require_explicit_system_defaults() {
        let mut providers = provider_fixture();
        providers.default_api = None;
        let error = resolve_provider_and_model_with(&AutomationDefinition::default(), &providers)
            .unwrap_err();
        assert!(error.contains("choose a default API"));

        providers.default_api = Some("system".to_string());
        let error = resolve_provider_and_model_with(&AutomationDefinition::default(), &providers)
            .unwrap_err();
        assert!(error.contains("System Claude Login has been retired"));
    }

    #[test]
    fn agent_teams_are_opt_in_and_add_an_explicit_run_contract() {
        let solo = AutomationDefinition {
            kind: "heartbeat".to_string(),
            id: "solo-test".to_string(),
            prompt: "Continue safely".to_string(),
            ..Default::default()
        };
        assert!(!solo.agent_teams_enabled);
        assert!(!automation_prompt(&solo, None)
            .unwrap()
            .contains("<agent_teams_authorization>"));

        let team = AutomationDefinition {
            agent_teams_enabled: true,
            ..solo
        };
        let prompt = automation_prompt(&team, None).unwrap();
        assert!(prompt.contains("<agent_teams_authorization>"));
        assert!(prompt.contains("spawn at most 3 teammates"));
        assert!(prompt.contains("Do not use legacy TeamCreate or TeamDelete"));
    }

    #[test]
    fn scheduled_native_skill_invocations_stay_at_the_start_of_the_prompt() {
        let definition = AutomationDefinition {
            kind: "cron".to_string(),
            id: "native-skill-test".to_string(),
            prompt: "/reporting\n\nClose the latest work window.".to_string(),
            ..Default::default()
        };
        let prompt = automation_prompt(&definition, None).unwrap();
        assert!(prompt.starts_with("/reporting\n\nAutomation:"));
        assert!(prompt.contains("Close the latest work window."));
    }

    #[test]
    fn scheduled_legacy_skill_hints_are_normalized_to_native_invocations() {
        let definition = AutomationDefinition {
            kind: "cron".to_string(),
            id: "legacy-skill-test".to_string(),
            prompt: "Use $reporting to close the latest work window.".to_string(),
            ..Default::default()
        };
        let prompt = automation_prompt(&definition, None).unwrap();
        assert!(prompt.starts_with("/reporting\n\nAutomation:"));
        assert!(prompt.contains("to close the latest work window."));
        assert!(!prompt.contains("Use $reporting"));
    }

    #[test]
    fn scheduled_plain_prompts_keep_their_existing_envelope() {
        let definition = AutomationDefinition {
            kind: "cron".to_string(),
            id: "plain-prompt-test".to_string(),
            prompt: "Inspect the latest build.".to_string(),
            ..Default::default()
        };
        let prompt = automation_prompt(&definition, None).unwrap();
        assert!(prompt.starts_with("Automation:"));
        assert!(prompt.contains("Inspect the latest build."));
        assert!(prompt.contains("<automation_result_contract>"));
        assert!(prompt.contains("self-contained user-facing report in plain language"));
        assert!(prompt.contains("the shortest reply the user can send"));
        assert!(prompt.contains("Never return a directive by itself"));
        assert!(prompt.contains("::automation-needs-attention{title="));
        assert!(prompt.contains("::automation-failed{summary="));
    }

    fn tool_result(sequence: u32, summary: &str) -> AutomationTraceEvent {
        AutomationTraceEvent {
            sequence,
            event_type: "tool_result".to_string(),
            tool_name: Some("Bash".to_string()),
            tool_use_id: Some(format!("tool-{sequence}")),
            parent_tool_use_id: None,
            agent_id: None,
            agent_type: None,
            agent_kind: None,
            agent_depth: Some(0),
            summary: summary.to_string(),
        }
    }

    #[test]
    fn scheduled_failure_directive_becomes_a_failed_run_reason() {
        let execution = AutomationExecution {
            output: "The lock was denied.\n::automation-failed{summary=\"Lock denied\"}"
                .to_string(),
            trace: vec![],
            session_id: None,
            last_main_assistant_event: Some(1),
            last_agent_completion_event: None,
        };
        assert_eq!(
            automation_reported_failure(&execution, true).as_deref(),
            Some("Lock denied")
        );
    }

    #[test]
    fn scheduled_attention_directive_becomes_an_actionable_result() {
        let output = "The report is ready.\n::automation-needs-attention{title=\"Choose release\" summary=\"Approve one release candidate\"}";
        assert_eq!(
            parse_automation_attention_directive(output, "Fallback"),
            Some((
                "Choose release".to_string(),
                "Approve one release candidate".to_string(),
            ))
        );

        let execution = AutomationExecution {
            output: output.to_string(),
            trace: vec![tool_result(1, "Failed")],
            session_id: None,
            last_main_assistant_event: Some(1),
            last_agent_completion_event: None,
        };
        assert!(automation_reported_failure(&execution, true).is_none());
    }

    #[test]
    fn terminal_success_directive_requires_a_user_facing_report() {
        for output in [
            "::inbox-item{title=\"Done\" summary=\"Committed\"}",
            "::automation-needs-attention{title=\"Review\" summary=\"Choose one option\"}",
        ] {
            let execution = AutomationExecution {
                output: output.to_string(),
                trace: vec![],
                session_id: None,
                last_main_assistant_event: Some(1),
                last_agent_completion_event: None,
            };
            assert!(automation_needs_completion_recovery(&execution));
            assert!(automation_reported_failure(&execution, true).is_some());
        }
    }

    #[test]
    fn terminal_tool_failure_without_success_receipt_fails_closed() {
        let failed = AutomationExecution {
            output: "Stopped after the required lock command failed.".to_string(),
            trace: vec![tool_result(1, "Failed")],
            session_id: None,
            last_main_assistant_event: Some(1),
            last_agent_completion_event: None,
        };
        assert!(automation_reported_failure(&failed, true).is_some());

        let recovered = AutomationExecution {
            output: "Recovered.\n::inbox-item{title=\"Done\" summary=\"Recovered\"}".to_string(),
            trace: vec![tool_result(1, "Failed")],
            session_id: None,
            last_main_assistant_event: Some(2),
            last_agent_completion_event: None,
        };
        assert!(automation_reported_failure(&recovered, true).is_none());

        let later_success = AutomationExecution {
            output: "Recovered without a control record.".to_string(),
            trace: vec![tool_result(1, "Failed"), tool_result(2, "Completed")],
            session_id: None,
            last_main_assistant_event: Some(2),
            last_agent_completion_event: None,
        };
        assert!(automation_reported_failure(&later_success, true).is_some());
        assert!(automation_reported_failure(&later_success, false).is_none());

        let literal_success_example = AutomationExecution {
            output: "Example: ::inbox-item{title=\"Done\"}\nThe required step still failed."
                .to_string(),
            trace: vec![tool_result(1, "Failed")],
            session_id: None,
            last_main_assistant_event: Some(1),
            last_agent_completion_event: None,
        };
        assert!(automation_reported_failure(&literal_success_example, true).is_some());

        let literal_attention_example = AutomationExecution {
            output: "Example: ::automation-needs-attention{title=\"Review\"}\nThe required step still failed."
                .to_string(),
            trace: vec![tool_result(1, "Failed")],
            session_id: None,
            last_main_assistant_event: Some(1),
            last_agent_completion_event: None,
        };
        assert!(automation_reported_failure(&literal_attention_example, true).is_some());
    }

    #[test]
    fn completed_background_agents_require_a_later_main_agent_synthesis() {
        let stale_main_result = AutomationExecution {
            output: "Phase A is done.\n::inbox-item{title=\"Done\" summary=\"Phase A\"}"
                .to_string(),
            trace: vec![],
            session_id: None,
            last_main_assistant_event: Some(10),
            last_agent_completion_event: Some(12),
        };
        let reason = automation_reported_failure(&stale_main_result, true).unwrap();
        assert!(reason.contains("without a final synthesis"));

        let synthesized = AutomationExecution {
            last_main_assistant_event: Some(13),
            ..stale_main_result
        };
        assert!(automation_reported_failure(&synthesized, true).is_none());
    }

    #[test]
    fn scheduled_runs_use_bounded_same_session_completion_recovery() {
        let incomplete = AutomationExecution {
            output: "Background extraction finished; waiting for results.".to_string(),
            trace: vec![tool_result(1, "Completed")],
            session_id: Some("session-1".to_string()),
            last_main_assistant_event: Some(4),
            last_agent_completion_event: Some(5),
        };
        assert!(automation_needs_completion_recovery(&incomplete));

        let explicit_failure = AutomationExecution {
            output: "Blocked.\n::automation-failed{summary=\"Lock conflict\"}".to_string(),
            ..incomplete
        };
        assert!(!automation_needs_completion_recovery(&explicit_failure));

        let prompt = automation_completion_recovery_prompt(
            &AutomationDefinition {
                id: "daily-review-dream".to_string(),
                ..Default::default()
            },
            1,
        );
        assert!(prompt.contains("Resume the SAME durable session"));
        assert!(prompt.contains("do not end with progress narration"));
        assert!(prompt.contains("self-contained plain-language report"));
        assert!(prompt.contains("approval/rejection consequences"));
        assert!(prompt.contains("Never return a directive by itself"));
        assert!(prompt.contains("::automation-failed"));
        assert!(prompt.contains("Recovery attempt 1/3"));
        assert_eq!(AUTOMATION_COMPLETION_RECOVERY_LIMIT, 3);

        let stall_prompt = automation_stall_recovery_prompt(
            &AutomationDefinition {
                id: "daily-review-dream".to_string(),
                ..Default::default()
            },
            1,
        );
        assert!(stall_prompt.contains("Resume the SAME durable session"));
        assert!(stall_prompt.contains("unresolved tool calls"));
        assert!(stall_prompt.contains("do not blindly relaunch the same stalled Agent call"));
        assert!(stall_prompt.contains("fail visibly instead of waiting indefinitely"));
        assert!(stall_prompt.contains("Recovery attempt 1/2"));
        assert_eq!(AUTOMATION_STALL_RECOVERY_LIMIT, 2);
    }

    #[test]
    fn repeated_empty_recovery_stays_incomplete_until_a_final_directive_arrives() {
        let initial = AutomationExecution {
            output: "Work is still in progress.\n::inbox-item{title=\"Early\" summary=\"Agent work still running\"}".to_string(),
            trace: vec![tool_result(1, "Completed")],
            session_id: Some("session-1".to_string()),
            last_main_assistant_event: Some(2),
            last_agent_completion_event: Some(3),
        };
        let empty = AutomationExecution {
            output: String::new(),
            trace: vec![],
            session_id: Some("session-1".to_string()),
            last_main_assistant_event: None,
            last_agent_completion_event: None,
        };
        let still_incomplete = merge_automation_executions(initial, empty);
        assert!(automation_needs_completion_recovery(&still_incomplete));

        let final_result = AutomationExecution {
            output: "Finished.\n::inbox-item{title=\"Done\" summary=\"Closed\"}".to_string(),
            trace: vec![],
            session_id: Some("session-1".to_string()),
            last_main_assistant_event: Some(1),
            last_agent_completion_event: None,
        };
        let completed = merge_automation_executions(still_incomplete, final_result);
        assert!(!automation_needs_completion_recovery(&completed));
        assert!(automation_reported_failure(&completed, true).is_none());
    }

    #[test]
    fn completion_recovery_merges_trace_and_keeps_the_final_directive_last() {
        let first = AutomationExecution {
            output: "Initial work finished.".to_string(),
            trace: vec![tool_result(1, "Completed")],
            session_id: Some("session-1".to_string()),
            last_main_assistant_event: Some(2),
            last_agent_completion_event: Some(3),
        };
        let continuation = AutomationExecution {
            output: "Synthesized.\n::inbox-item{title=\"Done\" summary=\"Closed\"}".to_string(),
            trace: vec![tool_result(1, "Completed")],
            session_id: Some("session-1".to_string()),
            last_main_assistant_event: Some(2),
            last_agent_completion_event: None,
        };
        let merged = merge_automation_executions(first, continuation);
        assert_eq!(merged.trace.len(), 2);
        assert_eq!(merged.trace[1].sequence, 2);
        assert_eq!(merged.last_main_assistant_event, Some(5));
        assert_eq!(merged.last_agent_completion_event, Some(3));
        assert!(automation_reported_failure(&merged, true).is_none());
    }

    #[test]
    fn scheduled_runs_use_durable_sessions_and_heartbeats_resume_their_target() {
        let run_id = "550e8400-e29b-41d4-a716-446655440000";
        let cron = AutomationDefinition::default();
        let cron_target = automation_session_target(&cron, run_id).unwrap();
        assert_eq!(cron_target.session_id, run_id);
        assert_eq!(cron_target.arguments, vec!["--session-id", run_id]);
        assert!(cron_target.creates_new_session);

        let heartbeat = AutomationDefinition {
            kind: "heartbeat".to_string(),
            target_thread_id: Some("thread-existing".to_string()),
            ..Default::default()
        };
        let heartbeat_target = automation_session_target(&heartbeat, run_id).unwrap();
        assert_eq!(heartbeat_target.session_id, "thread-existing");
        assert_eq!(
            heartbeat_target.arguments,
            vec!["--resume", "thread-existing"]
        );
        assert!(!heartbeat_target.creates_new_session);
        assert!(automation_session_target(&cron, "not-a-uuid").is_err());
    }

    #[test]
    fn development_isolation_accepts_only_paths_inside_root() {
        let sandbox = tempfile::tempdir().unwrap();
        let allowed = sandbox.path().join("workspace");
        let outside = tempfile::tempdir().unwrap();
        fs::create_dir_all(&allowed).unwrap();

        let mut definition = AutomationDefinition {
            name: "isolated".to_string(),
            prompt: "test".to_string(),
            cwds: vec![allowed.to_string_lossy().to_string()],
            ..Default::default()
        };
        assert!(validate_development_paths(&definition, sandbox.path()).is_ok());

        definition.cwds = vec![outside.path().to_string_lossy().to_string()];
        let error = validate_development_paths(&definition, sandbox.path()).unwrap_err();
        assert!(error.contains("blocked project outside"));
    }

    #[cfg(unix)]
    #[test]
    fn development_isolation_rejects_symlink_escape() {
        use std::os::unix::fs::symlink;

        let sandbox = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let escape = sandbox.path().join("escape");
        symlink(outside.path(), &escape).unwrap();
        let definition = AutomationDefinition {
            name: "isolated".to_string(),
            prompt: "test".to_string(),
            cwds: vec![escape.to_string_lossy().to_string()],
            ..Default::default()
        };

        let error = validate_development_paths(&definition, sandbox.path()).unwrap_err();
        assert!(error.contains("blocked project outside"));
    }

    #[test]
    fn stream_execution_extracts_redacted_tool_trace() {
        let stdout = concat!(
            r#"{"type":"system","subtype":"init","session_id":"550e8400-e29b-41d4-a716-446655440000"}"#,
            "\n",
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Write","input":{"file_path":"/tmp/x","content":"secret"}}]}}"#,
            "\n",
            r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]}}"#,
            "\n",
            r#"{"type":"result","subtype":"success","is_error":false,"result":"finished"}"#,
            "\n",
        );
        let execution = parse_stream_execution(stdout).unwrap();
        assert_eq!(execution.output, "finished");
        assert_eq!(
            execution.session_id.as_deref(),
            Some("550e8400-e29b-41d4-a716-446655440000")
        );
        assert_eq!(execution.trace.len(), 2);
        assert_eq!(execution.trace[0].tool_name.as_deref(), Some("Write"));
        assert_eq!(
            execution.trace[0].summary,
            "Input fields: content, file_path"
        );
        assert!(!execution.trace[0].summary.contains("secret"));
        assert_eq!(execution.trace[1].event_type, "tool_result");
        assert_eq!(execution.trace[1].summary, "Completed");
    }

    #[test]
    fn stream_execution_preserves_trace_on_failure() {
        let stdout = concat!(
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t2","name":"Bash","input":{"command":"false"}}]}}"#,
            "\n",
            r#"{"type":"result","subtype":"error","is_error":true,"result":"failed safely"}"#,
            "\n",
        );
        let error = parse_stream_execution(stdout).unwrap_err();
        assert_eq!(error.message, "failed safely");
        assert_eq!(error.trace.len(), 1);
        assert_eq!(error.trace[0].tool_name.as_deref(), Some("Bash"));
    }

    #[test]
    fn stream_execution_attributes_nested_subagent_tools() {
        let stdout = concat!(
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"agent-1","name":"Agent","input":{"subagent_type":"plugin:worker","prompt":"secret"}}]}}"#,
            "\n",
            r#"{"type":"system","subtype":"task_started","task_id":"task-1","tool_use_id":"agent-1","subagent_type":"plugin:worker","prompt":"secret"}"#,
            "\n",
            r#"{"type":"assistant","parent_tool_use_id":"agent-1","message":{"content":[{"type":"tool_use","id":"write-1","name":"Write","input":{"file_path":"/tmp/x","content":"secret"}}]}}"#,
            "\n",
            r#"{"type":"user","parent_tool_use_id":"agent-1","message":{"content":[{"type":"tool_result","tool_use_id":"write-1","content":"ok"}]}}"#,
            "\n",
            r#"{"type":"system","subtype":"task_notification","task_id":"task-1","tool_use_id":"agent-1","status":"completed","summary":"secret"}"#,
            "\n",
            r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"agent-1","content":"secret"}]}}"#,
            "\n",
            r#"{"type":"result","subtype":"success","is_error":false,"result":"finished"}"#,
            "\n",
        );
        let execution = parse_stream_execution(stdout).unwrap();
        assert_eq!(execution.output, "finished");
        let write = execution
            .trace
            .iter()
            .find(|event| {
                event.event_type == "tool_use" && event.tool_name.as_deref() == Some("Write")
            })
            .unwrap();
        assert_eq!(write.parent_tool_use_id.as_deref(), Some("agent-1"));
        assert_eq!(write.agent_type.as_deref(), Some("plugin:worker"));
        assert_eq!(write.agent_depth, Some(1));
        assert!(!write.summary.contains("secret"));
        assert!(execution.trace.iter().any(|event| {
            event.event_type == "agent_start"
                && event.agent_id.as_deref() == Some("task-1")
                && event.agent_type.as_deref() == Some("plugin:worker")
        }));
        assert!(execution.trace.iter().any(|event| {
            event.event_type == "agent_result"
                && event.summary == "Completed"
                && event.agent_type.as_deref() == Some("plugin:worker")
        }));
        assert!(execution.last_main_assistant_event.is_none());
        assert!(execution.last_agent_completion_event.is_some());
    }

    #[test]
    fn stream_execution_does_not_accept_empty_thinking_as_final_synthesis() {
        let stdout = concat!(
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Early result"}]}}"#,
            "\n",
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"agent-1","name":"Agent","input":{"prompt":"work"}}]}}"#,
            "\n",
            r#"{"type":"system","subtype":"task_started","task_id":"task-1","tool_use_id":"agent-1"}"#,
            "\n",
            r#"{"type":"system","subtype":"task_notification","task_id":"task-1","tool_use_id":"agent-1","status":"completed"}"#,
            "\n",
            r#"{"type":"assistant","message":{"content":[{"type":"thinking","thinking":""}]}}"#,
            "\n",
            r#"{"type":"result","subtype":"success","is_error":false,"result":"Early result\n::inbox-item{title=\"Early\" summary=\"Agent work still running\"}"}"#,
            "\n",
        );
        let execution = parse_stream_execution(stdout).unwrap();
        assert!(
            execution.last_main_assistant_event.unwrap()
                < execution.last_agent_completion_event.unwrap()
        );
        assert!(automation_needs_completion_recovery(&execution));
    }

    #[test]
    fn stream_execution_recognizes_a_main_synthesis_after_background_completion() {
        let stdout = concat!(
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"agent-1","name":"Agent","input":{"prompt":"work"}}]}}"#,
            "\n",
            r#"{"type":"system","subtype":"task_started","task_id":"task-1","tool_use_id":"agent-1"}"#,
            "\n",
            r#"{"type":"system","subtype":"task_notification","task_id":"task-1","tool_use_id":"agent-1","status":"completed"}"#,
            "\n",
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Final synthesis"}]}}"#,
            "\n",
            r#"{"type":"result","subtype":"success","is_error":false,"result":"Final synthesis\n::inbox-item{title=\"Done\" summary=\"Complete\"}"}"#,
            "\n",
        );
        let execution = parse_stream_execution(stdout).unwrap();
        assert!(
            execution.last_main_assistant_event.unwrap()
                > execution.last_agent_completion_event.unwrap()
        );
        assert!(automation_reported_failure(&execution, true).is_none());
    }

    #[test]
    fn stream_execution_distinguishes_named_teammates_from_subagents() {
        let stdout = concat!(
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"agent-alpha","name":"Agent","input":{"name":"reader-alpha","description":"Inspect alpha","prompt":"secret"}}]}}"#,
            "\n",
            r#"{"type":"system","subtype":"task_started","task_id":"task-alpha","tool_use_id":"agent-alpha","subagent_type":"general-purpose"}"#,
            "\n",
            r#"{"type":"assistant","parent_tool_use_id":"agent-alpha","message":{"content":[{"type":"tool_use","id":"read-alpha","name":"Read","input":{"file_path":"alpha.txt"}}]}}"#,
            "\n",
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"message-alpha","name":"SendMessage","input":{"recipient":"reader-alpha","content":"ping"}}]}}"#,
            "\n",
            r#"{"type":"system","subtype":"task_started","task_id":"message-task","tool_use_id":"message-alpha","subagent_type":"general-purpose"}"#,
            "\n",
            r#"{"type":"system","subtype":"task_notification","task_id":"message-task","tool_use_id":"message-alpha","status":"completed"}"#,
            "\n",
            r#"{"type":"system","subtype":"task_notification","task_id":"task-alpha","tool_use_id":"agent-alpha","status":"completed"}"#,
            "\n",
            r#"{"type":"result","subtype":"success","is_error":false,"result":"team finished"}"#,
            "\n",
        );
        let execution = parse_stream_execution(stdout).unwrap();

        let launch = execution
            .trace
            .iter()
            .find(|event| {
                event.tool_use_id.as_deref() == Some("agent-alpha")
                    && event.event_type == "tool_use"
            })
            .unwrap();
        assert_eq!(launch.agent_kind.as_deref(), Some("teammate"));
        assert_eq!(launch.agent_type.as_deref(), Some("reader-alpha"));

        let nested_read = execution
            .trace
            .iter()
            .find(|event| event.tool_use_id.as_deref() == Some("read-alpha"))
            .unwrap();
        assert_eq!(
            nested_read.parent_tool_use_id.as_deref(),
            Some("agent-alpha")
        );
        assert_eq!(nested_read.agent_kind.as_deref(), Some("teammate"));
        assert_eq!(nested_read.agent_type.as_deref(), Some("reader-alpha"));
        assert_eq!(nested_read.agent_depth, Some(1));

        assert!(execution.trace.iter().any(|event| {
            event.event_type == "agent_result"
                && event.agent_kind.as_deref() == Some("teammate")
                && event.agent_type.as_deref() == Some("reader-alpha")
        }));
        assert!(!execution.trace.iter().any(|event| {
            event.event_type.starts_with("agent_")
                && event.tool_use_id.as_deref() == Some("message-alpha")
        }));
    }

    #[test]
    fn subagent_result_does_not_replace_main_result() {
        let stdout = concat!(
            r#"{"type":"result","parent_tool_use_id":"agent-1","subtype":"error","is_error":true,"result":"worker failed"}"#,
            "\n",
            r#"{"type":"result","subtype":"success","is_error":false,"result":"parent recovered"}"#,
            "\n",
        );
        let execution = parse_stream_execution(stdout).unwrap();
        assert_eq!(execution.output, "parent recovered");
        assert_eq!(execution.trace.len(), 1);
        assert_eq!(execution.trace[0].event_type, "agent_result");
        assert_eq!(execution.trace[0].summary, "Failed");
    }

    #[tokio::test]
    async fn cancellation_registry_delivers_signal() {
        let run_id = format!("test-cancel-{}", uuid::Uuid::new_v4());
        let (sender, receiver) = oneshot::channel();
        run_cancellations()
            .lock()
            .unwrap()
            .insert(run_id.clone(), sender);
        let sender = run_cancellations().lock().unwrap().remove(&run_id).unwrap();
        sender.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(1), receiver)
            .await
            .unwrap()
            .unwrap();
    }

    #[test]
    fn worktree_cleanup_paths_stay_inside_managed_storage() {
        let sandbox = tempfile::tempdir().unwrap();
        let root = sandbox.path().join("worktrees");
        let expected = root.join("task").join("run");
        let execution = expected.join("subproject");
        fs::create_dir_all(&execution).unwrap();
        assert_eq!(
            validate_worktree_cleanup_paths(&root, &expected, &execution).unwrap(),
            fs::canonicalize(&expected).unwrap()
        );
        let outside = sandbox.path().join("outside");
        fs::create_dir_all(&outside).unwrap();
        let error = validate_worktree_cleanup_paths(&root, &expected, &outside).unwrap_err();
        assert!(error.contains("outside Black Box storage"));
    }

    #[cfg(unix)]
    #[test]
    fn worktree_cleanup_rejects_symlink_escape() {
        use std::os::unix::fs::symlink;

        let sandbox = tempfile::tempdir().unwrap();
        let root = sandbox.path().join("worktrees");
        let task = root.join("task");
        let outside = sandbox.path().join("outside");
        fs::create_dir_all(&task).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let expected = task.join("run");
        symlink(&outside, &expected).unwrap();
        let error = validate_worktree_cleanup_paths(&root, &expected, &expected.join("subproject"))
            .unwrap_err();
        assert!(error.contains("outside Black Box storage"));
    }

    #[cfg(unix)]
    #[test]
    fn worktree_review_rejects_nested_symlink_escape() {
        use std::os::unix::fs::symlink;

        let sandbox = tempfile::tempdir().unwrap();
        let root = sandbox.path().join("worktrees");
        let expected = root.join("task").join("run");
        let outside = sandbox.path().join("outside");
        fs::create_dir_all(&expected).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let execution = expected.join("subproject");
        symlink(&outside, &execution).unwrap();
        let error = validate_worktree_review_path(&root, &expected, &execution).unwrap_err();
        assert!(error.contains("outside the run worktree"));
    }

    #[cfg(unix)]
    #[test]
    fn managed_execution_cwd_rejects_nested_symlink_escape() {
        use std::os::unix::fs::symlink;

        let sandbox = tempfile::tempdir().unwrap();
        let expected = sandbox.path().join("worktrees/task/run");
        let outside = sandbox.path().join("outside");
        fs::create_dir_all(&expected).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let execution = expected.join("subproject");
        symlink(&outside, &execution).unwrap();
        let error = validate_managed_execution_cwd(&expected, &execution).unwrap_err();
        assert!(error.contains("escapes its managed worktree"));
    }

    #[test]
    fn worktree_review_captures_committed_uncommitted_and_untracked_changes() {
        let sandbox = tempfile::tempdir().unwrap();
        let repository = sandbox.path();
        let run_git = |arguments: &[&str]| {
            let output = StdCommand::new("git")
                .args(arguments)
                .current_dir(repository)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
        };
        run_git(&["init", "-q"]);
        run_git(&["config", "user.name", "Black Box Test"]);
        run_git(&["config", "user.email", "blackbox@example.invalid"]);
        fs::write(repository.join("tracked.txt"), "base\n").unwrap();
        fs::write(repository.join(".gitignore"), ".env\n").unwrap();
        run_git(&["add", "tracked.txt", ".gitignore"]);
        run_git(&["commit", "-qm", "base"]);
        let base_commit =
            git_output(&["-C", &repository.to_string_lossy(), "rev-parse", "HEAD"]).unwrap();

        fs::write(repository.join("tracked.txt"), "committed\n").unwrap();
        run_git(&["add", "tracked.txt"]);
        run_git(&["commit", "-qm", "scheduled change"]);
        fs::write(repository.join("tracked.txt"), "working tree\n").unwrap();
        fs::write(repository.join("untracked.txt"), "new\n").unwrap();
        fs::write(repository.join("binary.dat"), [0_u8, 255, 1, 2]).unwrap();
        fs::write(repository.join("large.txt"), "line\n".repeat(70_000)).unwrap();
        fs::write(repository.join(".env"), "secret\n").unwrap();

        let review = collect_worktree_review(repository, &base_commit).unwrap();
        assert!(review.commits.contains("scheduled change"));
        assert!(review.status.contains("tracked.txt"));
        assert!(review.status.contains("untracked.txt"));
        assert!(review.diff_stat.contains("tracked.txt"));
        assert!(!review.truncated);
        assert!(!review.files_truncated);
        assert!(review
            .files
            .iter()
            .any(|file| file.path == "tracked.txt" && file.status == "M"));
        assert!(review
            .files
            .iter()
            .any(|file| file.path == "untracked.txt" && file.untracked));
        assert!(review
            .files
            .iter()
            .any(|file| file.path == "binary.dat" && file.untracked));
        assert!(!review.files.iter().any(|file| file.path == ".env"));

        let tracked = collect_worktree_file_diff(repository, &base_commit, "tracked.txt").unwrap();
        assert!(tracked.patch.contains("+working tree"));
        assert!(!tracked.binary);
        let untracked =
            collect_worktree_file_diff(repository, &base_commit, "untracked.txt").unwrap();
        assert!(untracked.patch.contains("+new"));
        assert!(!untracked.binary);
        let binary = collect_worktree_file_diff(repository, &base_commit, "binary.dat").unwrap();
        assert!(binary.binary);
        assert!(binary.patch.is_empty());
        let large = collect_worktree_file_diff(repository, &base_commit, "large.txt").unwrap();
        assert!(large.truncated);
        assert!(large.patch.len() <= MAX_REVIEW_PATCH_BYTES + 64);
        assert!(collect_worktree_file_diff(repository, &base_commit, ".env").is_err());
        assert!(collect_worktree_file_diff(repository, &base_commit, "../secret").is_err());
    }

    #[test]
    fn worktree_review_rejects_flag_like_or_malformed_baselines() {
        let sandbox = tempfile::tempdir().unwrap();
        assert!(collect_worktree_review(sandbox.path(), "--stat").is_err());
        assert!(collect_worktree_review(sandbox.path(), &"g".repeat(40)).is_err());
    }

    #[test]
    fn create_branch_here_preserves_head_and_working_changes() {
        let sandbox = tempfile::tempdir().unwrap();
        let repository = sandbox.path().join("repository");
        fs::create_dir(&repository).unwrap();
        let run_git = |cwd: &Path, arguments: &[&str]| {
            let output = StdCommand::new("git")
                .args(arguments)
                .current_dir(cwd)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
        };
        run_git(&repository, &["init", "-q"]);
        run_git(&repository, &["config", "user.name", "Black Box Test"]);
        run_git(
            &repository,
            &["config", "user.email", "blackbox@example.invalid"],
        );
        fs::write(repository.join("tracked.txt"), "base\n").unwrap();
        run_git(&repository, &["add", "."]);
        run_git(&repository, &["commit", "-qm", "base"]);
        let base_commit =
            git_output(&["-C", &repository.to_string_lossy(), "rev-parse", "HEAD"]).unwrap();
        run_git(&repository, &["branch", "existing-branch", &base_commit]);

        let worktree = sandbox.path().join("managed/task/run");
        fs::create_dir_all(worktree.parent().unwrap()).unwrap();
        run_git(
            &repository,
            &[
                "worktree",
                "add",
                "--detach",
                &worktree.to_string_lossy(),
                &base_commit,
            ],
        );
        fs::write(worktree.join("tracked.txt"), "committed\n").unwrap();
        run_git(&worktree, &["add", "tracked.txt"]);
        run_git(&worktree, &["commit", "-qm", "agent commit"]);
        let agent_head =
            git_output(&["-C", &worktree.to_string_lossy(), "rev-parse", "HEAD"]).unwrap();
        fs::write(worktree.join("tracked.txt"), "working\n").unwrap();
        fs::write(worktree.join("untracked.txt"), "untracked\n").unwrap();

        assert!(normalize_worktree_branch_name(&repository, "@{-1}").is_err());
        assert!(normalize_worktree_branch_name(&repository, "-unsafe").is_err());
        assert!(create_branch_in_worktree(&repository, &worktree, "existing-branch").is_err());

        let creation =
            create_branch_in_worktree(&repository, &worktree, "blackbox/scheduled-run").unwrap();
        assert!(creation.created);
        assert_eq!(creation.previous_head, agent_head);
        assert_eq!(
            git_output(&[
                "-C",
                &worktree.to_string_lossy(),
                "symbolic-ref",
                "--short",
                "HEAD",
            ])
            .unwrap(),
            "blackbox/scheduled-run"
        );
        assert_eq!(
            git_output(&["-C", &worktree.to_string_lossy(), "rev-parse", "HEAD"]).unwrap(),
            agent_head
        );
        let status = git_output(&["-C", &worktree.to_string_lossy(), "status", "--short"]).unwrap();
        assert!(status.contains("tracked.txt"));
        assert!(status.contains("untracked.txt"));
        let idempotent =
            create_branch_in_worktree(&repository, &worktree, "blackbox/scheduled-run").unwrap();
        assert!(!idempotent.created);
        assert!(create_branch_in_worktree(&repository, &worktree, "blackbox/other").is_err());
    }

    #[test]
    fn recovery_snapshot_budget_fails_closed_without_large_fixture_files() {
        assert!(
            enforce_snapshot_budget(MAX_SNAPSHOT_CHANGED_PATHS, MAX_SNAPSHOT_CHANGED_BYTES).is_ok()
        );
        assert!(enforce_snapshot_budget(MAX_SNAPSHOT_CHANGED_PATHS + 1, 0).is_err());
        assert!(enforce_snapshot_budget(1, MAX_SNAPSHOT_CHANGED_BYTES + 1).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn worktree_inputs_capture_local_changes_and_copy_only_selected_ignored_files() {
        use std::os::unix::fs::symlink;

        let sandbox = tempfile::tempdir().unwrap();
        let repository = sandbox.path().join("repository");
        fs::create_dir(&repository).unwrap();
        let run_git = |cwd: &Path, arguments: &[&str]| {
            let output = StdCommand::new("git")
                .args(arguments)
                .current_dir(cwd)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
        };
        run_git(&repository, &["init", "-q"]);
        run_git(&repository, &["config", "user.name", "Black Box Test"]);
        run_git(
            &repository,
            &["config", "user.email", "blackbox@example.invalid"],
        );
        fs::write(repository.join("tracked.txt"), "base\n").unwrap();
        fs::write(
            repository.join(".gitignore"),
            ".env\nconfig/\nignored-link\n",
        )
        .unwrap();
        fs::write(
            repository.join(".worktreeinclude"),
            ".env\nconfig/*.json\n!config/skip.json\nignored-link\n",
        )
        .unwrap();
        run_git(&repository, &["add", "."]);
        run_git(&repository, &["commit", "-qm", "base"]);
        let source_head =
            git_output(&["-C", &repository.to_string_lossy(), "rev-parse", "HEAD"]).unwrap();
        let clean_snapshot_dir = sandbox.path().join("inputs/task/clean-run");
        let clean_snapshot = create_worktree_input_snapshot(
            &repository,
            &clean_snapshot_dir,
            "task",
            "clean-run",
            &source_head,
        )
        .unwrap();
        assert_eq!(clean_snapshot.base_commit, source_head);
        assert!(clean_snapshot.input_snapshot_ref.is_none());
        assert!(!clean_snapshot_dir.exists());

        fs::write(repository.join("tracked.txt"), "working\n").unwrap();
        fs::write(repository.join("untracked.txt"), "untracked\n").unwrap();
        fs::write(repository.join(".env"), "source-secret\n").unwrap();
        fs::create_dir(repository.join("config")).unwrap();
        fs::write(repository.join("config/keep.json"), "keep\n").unwrap();
        fs::write(repository.join("config/skip.json"), "skip\n").unwrap();
        symlink(".env", repository.join("ignored-link")).unwrap();
        let source_status_before =
            git_output(&["-C", &repository.to_string_lossy(), "status", "--short"]).unwrap();

        let snapshot_dir = sandbox.path().join("inputs/task/run");
        let snapshot =
            create_worktree_input_snapshot(&repository, &snapshot_dir, "task", "run", &source_head)
                .unwrap();
        assert_eq!(snapshot.source_head_commit, source_head);
        assert_ne!(snapshot.base_commit, source_head);
        assert_eq!(
            git_output(&[
                "-C",
                &repository.to_string_lossy(),
                "rev-parse",
                &format!("{}^", snapshot.base_commit),
            ])
            .unwrap(),
            source_head
        );
        assert_eq!(
            git_output(&[
                "-C",
                &repository.to_string_lossy(),
                "show",
                &format!("{}:tracked.txt", snapshot.base_commit),
            ])
            .unwrap(),
            "working"
        );
        assert_eq!(
            git_output(&[
                "-C",
                &repository.to_string_lossy(),
                "show",
                &format!("{}:untracked.txt", snapshot.base_commit),
            ])
            .unwrap(),
            "untracked"
        );

        let worktree = sandbox.path().join("managed/task/run");
        fs::create_dir_all(worktree.parent().unwrap()).unwrap();
        run_git(
            &repository,
            &[
                "worktree",
                "add",
                "--detach",
                &worktree.to_string_lossy(),
                &snapshot.base_commit,
            ],
        );
        fs::write(worktree.join(".env"), "existing\n").unwrap();
        let copied = copy_worktree_included_files(&repository, &worktree).unwrap();
        assert_eq!(copied, 1);
        assert_eq!(
            fs::read_to_string(worktree.join(".env")).unwrap(),
            "existing\n"
        );
        assert_eq!(
            fs::read_to_string(worktree.join("config/keep.json")).unwrap(),
            "keep\n"
        );
        assert!(!worktree.join("config/skip.json").exists());
        assert!(!worktree.join("ignored-link").exists());
        assert_eq!(
            git_output(&["-C", &repository.to_string_lossy(), "status", "--short",]).unwrap(),
            source_status_before
        );

        run_git(
            &repository,
            &["worktree", "remove", "--force", &worktree.to_string_lossy()],
        );
        let reference = snapshot.input_snapshot_ref.clone().unwrap();
        remove_worktree_input_snapshot(&repository, &snapshot_dir, &snapshot);
        assert!(git_output(&[
            "-C",
            &repository.to_string_lossy(),
            "rev-parse",
            "--verify",
            &reference,
        ])
        .is_err());
        assert!(!snapshot_dir.exists());
    }

    #[cfg(unix)]
    #[test]
    fn recovery_snapshot_round_trips_committed_binary_untracked_and_symlink_state() {
        use std::os::unix::fs::symlink;

        let sandbox = tempfile::tempdir().unwrap();
        let repository = sandbox.path().join("repository");
        fs::create_dir(&repository).unwrap();
        let run_git = |cwd: &Path, arguments: &[&str]| {
            let output = StdCommand::new("git")
                .args(arguments)
                .current_dir(cwd)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
        };
        run_git(&repository, &["init", "-q"]);
        run_git(&repository, &["config", "user.name", "Black Box Test"]);
        run_git(
            &repository,
            &["config", "user.email", "blackbox@example.invalid"],
        );
        fs::write(repository.join("tracked.txt"), "base\n").unwrap();
        fs::write(repository.join("binary.dat"), [0_u8, 1, 2, 3]).unwrap();
        run_git(&repository, &["add", "."]);
        run_git(&repository, &["commit", "-qm", "base"]);
        let base_commit =
            git_output(&["-C", &repository.to_string_lossy(), "rev-parse", "HEAD"]).unwrap();

        let worktree = sandbox.path().join("managed/task/run");
        fs::create_dir_all(worktree.parent().unwrap()).unwrap();
        run_git(
            &repository,
            &[
                "worktree",
                "add",
                "--detach",
                &worktree.to_string_lossy(),
                &base_commit,
            ],
        );
        assert_eq!(
            validate_worktree_git_identity(&repository, &worktree).unwrap(),
            fs::canonicalize(&repository).unwrap()
        );
        fs::write(worktree.join("tracked.txt"), "committed\n").unwrap();
        run_git(&worktree, &["add", "tracked.txt"]);
        run_git(&worktree, &["commit", "-qm", "agent commit"]);
        fs::write(worktree.join("tracked.txt"), "working\n").unwrap();
        fs::write(worktree.join("binary.dat"), [0_u8, 255, 10, 13, 42]).unwrap();
        fs::write(worktree.join("untracked.txt"), "untracked\n").unwrap();
        symlink("tracked.txt", worktree.join("tracked-link")).unwrap();

        let snapshot_dir = sandbox.path().join("snapshots/task/run");
        let metadata = create_worktree_snapshot(
            &repository,
            &worktree,
            &snapshot_dir,
            "task",
            "run",
            &base_commit,
            Path::new(""),
        )
        .unwrap();
        assert!(metadata.changed_path_count >= 4);
        assert!(metadata.changed_bytes > 0);
        assert_eq!(
            git_output(&[
                "-C",
                &repository.to_string_lossy(),
                "rev-parse",
                &metadata.snapshot_ref,
            ])
            .unwrap(),
            metadata.snapshot_commit
        );

        run_git(
            &repository,
            &["worktree", "remove", "--force", &worktree.to_string_lossy()],
        );
        let snapshot_review =
            collect_snapshot_review(&repository, &base_commit, &metadata.snapshot_commit).unwrap();
        assert_eq!(snapshot_review.review_source, "snapshot");
        assert!(snapshot_review.diff_stat.contains("tracked.txt"));
        assert!(snapshot_review
            .files
            .iter()
            .any(|file| file.path == "untracked.txt" && file.status == "A"));
        assert!(snapshot_review
            .files
            .iter()
            .any(|file| file.path == "binary.dat"));
        let tracked_diff = collect_snapshot_file_diff(
            &repository,
            &base_commit,
            &metadata.snapshot_commit,
            "tracked.txt",
        )
        .unwrap();
        assert!(tracked_diff.patch.contains("+working"));
        let untracked_diff = collect_snapshot_file_diff(
            &repository,
            &base_commit,
            &metadata.snapshot_commit,
            "untracked.txt",
        )
        .unwrap();
        assert!(untracked_diff.patch.contains("+untracked"));
        let binary_diff = collect_snapshot_file_diff(
            &repository,
            &base_commit,
            &metadata.snapshot_commit,
            "binary.dat",
        )
        .unwrap();
        assert!(binary_diff.binary);
        assert!(collect_snapshot_file_diff(
            &repository,
            &base_commit,
            &metadata.snapshot_commit,
            "../secret",
        )
        .is_err());
        let (restored, loaded) =
            restore_worktree_snapshot(&repository, &worktree, &snapshot_dir, "task", "run")
                .unwrap();
        assert_eq!(restored, worktree);
        assert_eq!(loaded.snapshot_commit, metadata.snapshot_commit);
        assert_eq!(
            fs::read_to_string(worktree.join("tracked.txt")).unwrap(),
            "working\n"
        );
        assert_eq!(
            fs::read(worktree.join("binary.dat")).unwrap(),
            vec![0_u8, 255, 10, 13, 42]
        );
        assert_eq!(
            fs::read_to_string(worktree.join("untracked.txt")).unwrap(),
            "untracked\n"
        );
        assert_eq!(
            fs::read_link(worktree.join("tracked-link")).unwrap(),
            PathBuf::from("tracked.txt")
        );
        let review = collect_worktree_review(&worktree, &base_commit).unwrap();
        assert!(review.commits.contains("Black Box recovery snapshot"));
        assert!(review.diff_stat.contains("tracked.txt"));
    }

    #[test]
    fn worktree_git_identity_rejects_a_tampered_git_pointer() {
        let sandbox = tempfile::tempdir().unwrap();
        let initialize = |path: &Path| {
            fs::create_dir(path).unwrap();
            let run = |arguments: &[&str]| {
                let output = StdCommand::new("git")
                    .args(arguments)
                    .current_dir(path)
                    .output()
                    .unwrap();
                assert!(output.status.success());
            };
            run(&["init", "-q"]);
            run(&["config", "user.name", "Black Box Test"]);
            run(&["config", "user.email", "blackbox@example.invalid"]);
            fs::write(path.join("file.txt"), "base\n").unwrap();
            run(&["add", "."]);
            run(&["commit", "-qm", "base"]);
        };
        let source = sandbox.path().join("source");
        let outside = sandbox.path().join("outside");
        initialize(&source);
        initialize(&outside);
        let worktree = sandbox.path().join("managed/run");
        fs::create_dir_all(worktree.parent().unwrap()).unwrap();
        let output = StdCommand::new("git")
            .args([
                "worktree",
                "add",
                "--detach",
                &worktree.to_string_lossy(),
                "HEAD",
            ])
            .current_dir(&source)
            .output()
            .unwrap();
        assert!(output.status.success());
        fs::write(
            worktree.join(".git"),
            format!("gitdir: {}\n", outside.join(".git").display()),
        )
        .unwrap();
        assert!(validate_worktree_git_identity(&source, &worktree).is_err());
    }
}
