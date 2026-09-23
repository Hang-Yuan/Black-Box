use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex, OnceLock};
use tokio::io::AsyncWriteExt;
use tokio::process::ChildStdin;
use tokio::sync::{oneshot, watch, Mutex};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SessionInfo {
    /// Desk-generated process key used as routing key and stdin identifier.
    /// Maps to StdinManager / ProcessManager keys. NOT the Claude CLI session UUID.
    pub stdin_id: String,
    /// Claude CLI's session UUID for --resume. `Some` when resuming an existing
    /// session (from `resume_session_id`), `None` for new sessions — the real
    /// UUID arrives later via the first system:init stream event and is stored
    /// on the frontend in `sessionStore.cliResumeId`.
    pub cli_session_id: Option<String>,
    pub pid: u32,
    pub cli_path: String,
    pub cli_version: String,
    pub sdk_capabilities: crate::commands::cli_resolver::CliSdkCapabilities,
}

/// A managed CLI session whose child process is owned by an independent
/// waiter task. `kill_tx` sends a request to that waiter task to kill the
/// child; the waiter task then emits `process_exit` authoritatively.
#[derive(Debug)]
#[allow(dead_code)]
pub struct ManagedProcess {
    pub session_id: String,
    /// Stable Claude CLI session UUID used by --session-id / --resume.
    /// A task handoff is forbidden while any process owns this UUID.
    pub cli_session_id: String,
    /// Unique ownership generation. Natural exit cleanup must match this token
    /// so an old stdout reader can never remove a newer process with the same
    /// desk-side stdin key.
    pub generation: String,
    pub pid: u32,
    /// Kill signal channel to the waiter task. Option so concurrent stop calls
    /// send at most one kill request while all callers wait on `exit_tx`.
    pub kill_tx: Option<oneshot::Sender<()>>,
    /// Persistent, multi-subscriber exit signal. The stdout reader publishes
    /// `true` only after draining output and completing authoritative cleanup.
    pub exit_tx: watch::Sender<bool>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
struct ManagedProcessLedgerEntry {
    owner_pid: u32,
    pid: u32,
    stdin_id: String,
    cli_session_id: String,
    generation: String,
}

static PROCESS_LEDGER_LOCK: OnceLock<StdMutex<()>> = OnceLock::new();

fn process_ledger_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".blackbox")
        .join("managed-cli-processes.json")
}

fn read_process_ledger(path: &Path) -> Result<Vec<ManagedProcessLedgerEntry>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let bytes = std::fs::read(path)
        .map_err(|error| format!("Failed to read managed process ledger: {error}"))?;
    serde_json::from_slice(&bytes)
        .map_err(|error| format!("Invalid managed process ledger: {error}"))
}

fn write_process_ledger(path: &Path, entries: &[ManagedProcessLedgerEntry]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Managed process ledger has no parent directory".to_string())?;
    std::fs::create_dir_all(parent)
        .map_err(|error| format!("Failed to create managed process ledger directory: {error}"))?;
    let temporary = path.with_extension(format!("json.{}.tmp", std::process::id()));
    let encoded = serde_json::to_vec_pretty(entries)
        .map_err(|error| format!("Failed to encode managed process ledger: {error}"))?;
    std::fs::write(&temporary, encoded)
        .map_err(|error| format!("Failed to stage managed process ledger: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&temporary, std::fs::Permissions::from_mode(0o600))
            .map_err(|error| format!("Failed to secure managed process ledger: {error}"))?;
    }
    std::fs::rename(&temporary, path)
        .map_err(|error| format!("Failed to publish managed process ledger: {error}"))
}

fn update_process_ledger(
    mutate: impl FnOnce(&mut Vec<ManagedProcessLedgerEntry>),
) -> Result<(), String> {
    let _guard = PROCESS_LEDGER_LOCK
        .get_or_init(|| StdMutex::new(()))
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let path = process_ledger_path();
    let mut entries = read_process_ledger(&path)?;
    mutate(&mut entries);
    write_process_ledger(&path, &entries)
}

pub fn register_managed_cli_process(
    pid: u32,
    stdin_id: &str,
    cli_session_id: &str,
    generation: &str,
) -> Result<(), String> {
    update_process_ledger(|entries| {
        entries.retain(|entry| {
            entry.pid != pid && entry.stdin_id != stdin_id && entry.cli_session_id != cli_session_id
        });
        entries.push(ManagedProcessLedgerEntry {
            owner_pid: std::process::id(),
            pid,
            stdin_id: stdin_id.to_string(),
            cli_session_id: cli_session_id.to_string(),
            generation: generation.to_string(),
        });
    })
}

pub fn unregister_managed_cli_process(pid: u32, generation: &str) -> Result<(), String> {
    update_process_ledger(|entries| {
        entries.retain(|entry| entry.pid != pid || entry.generation != generation);
    })
}

#[cfg(unix)]
fn process_command(pid: u32) -> Option<String> {
    let output = std::process::Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "command="])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let command = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!command.is_empty()).then_some(command)
}

#[cfg(unix)]
fn is_managed_cli_command(command: &str, cli_session_id: &str) -> bool {
    command.contains("claude")
        && command.contains("--print")
        && command.contains("--input-format stream-json")
        && command.contains("--output-format stream-json")
        && (command.contains(&format!("--resume {cli_session_id}"))
            || command.contains(&format!("--session-id {cli_session_id}")))
}

#[cfg(unix)]
fn is_live_blackbox_owner(pid: u32) -> bool {
    process_command(pid).is_some_and(|command| {
        command.contains("Black Box.app/Contents/MacOS/blackbox") || command.ends_with("/blackbox")
    })
}

/// Reap only children recorded by a previous Black Box process whose owner is
/// gone. This covers macOS termination paths that can bypass the async Tauri
/// ExitRequested handler without touching unrelated Claude CLI processes.
pub fn reap_stale_managed_cli_processes() -> Result<Vec<u32>, String> {
    #[cfg(not(unix))]
    {
        return Ok(Vec::new());
    }
    #[cfg(unix)]
    {
        let _guard = PROCESS_LEDGER_LOCK
            .get_or_init(|| StdMutex::new(()))
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let path = process_ledger_path();
        let entries = read_process_ledger(&path)?;
        let mut keep = Vec::new();
        let mut reaped = Vec::new();
        for entry in entries {
            if entry.owner_pid == std::process::id() || is_live_blackbox_owner(entry.owner_pid) {
                keep.push(entry);
                continue;
            }
            let Some(command) = process_command(entry.pid) else {
                continue;
            };
            if !is_managed_cli_command(&command, &entry.cli_session_id) {
                continue;
            }
            unsafe {
                libc::kill(entry.pid as i32, libc::SIGTERM);
            }
            for _ in 0..40 {
                if process_command(entry.pid).is_none() {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            if process_command(entry.pid).is_some() {
                unsafe {
                    libc::kill(entry.pid as i32, libc::SIGKILL);
                }
            }
            reaped.push(entry.pid);
        }
        write_process_ledger(&path, &keep)?;
        Ok(reaped)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SessionClaim {
    stdin_id: String,
    cli_session_id: String,
    generation: String,
}

#[derive(Debug, Default)]
struct ClaimRegistry {
    by_stdin: HashMap<String, SessionClaim>,
    by_cli_session: HashMap<String, SessionClaim>,
}

#[derive(Debug, Default, Clone)]
pub struct ProcessManager {
    processes: Arc<Mutex<HashMap<String, Arc<Mutex<ManagedProcess>>>>>,
    /// Spawn reservations and live ownership share one registry. A synchronous
    /// mutex keeps reservation Drop infallible and makes the CLI UUID + stdinId
    /// check one atomic critical section before any child is spawned.
    claims: Arc<StdMutex<ClaimRegistry>>,
}

#[derive(Debug)]
pub struct SpawnReservation {
    manager: ProcessManager,
    claim: SessionClaim,
    committed: bool,
}

/// Manages stdin handles for sending user responses to Claude processes
#[derive(Debug, Default, Clone)]
pub struct StdinManager {
    handles: Arc<Mutex<HashMap<String, ChildStdin>>>,
}

impl StdinManager {
    pub fn new() -> Self {
        Self {
            handles: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn insert(&self, id: String, stdin: ChildStdin) -> Result<(), String> {
        let mut map = self.handles.lock().await;
        if map.contains_key(&id) {
            return Err(format!("STDIN_ID_ALREADY_ACTIVE: stdin_id={}", id));
        }
        map.insert(id, stdin);
        Ok(())
    }

    pub async fn send(&self, id: &str, message: &str) -> Result<(), String> {
        let mut map = self.handles.lock().await;
        if let Some(stdin) = map.get_mut(id) {
            // Atomic write: message + newline in one call to prevent interleaving (P1-2 fix)
            let payload = format!("{}\n", message);
            stdin
                .write_all(payload.as_bytes())
                .await
                .map_err(|e| format!("Failed to write to stdin: {}", e))?;
            stdin
                .flush()
                .await
                .map_err(|e| format!("Failed to flush stdin: {}", e))?;
            Ok(())
        } else {
            Err(format!("No stdin handle for session: {}", id))
        }
    }

    pub async fn remove(&self, id: &str) {
        let mut map = self.handles.lock().await;
        map.remove(id);
    }

    /// Alias for remove — used by drop_entry path for natural process exit.
    pub async fn drop_entry(&self, id: &str) {
        self.remove(id).await;
    }
}

impl ProcessManager {
    pub fn new() -> Self {
        Self {
            processes: Arc::new(Mutex::new(HashMap::new())),
            claims: Arc::new(StdMutex::new(ClaimRegistry::default())),
        }
    }

    fn with_claims<T>(&self, f: impl FnOnce(&mut ClaimRegistry) -> T) -> T {
        let mut claims = self
            .claims
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        f(&mut claims)
    }

    /// Atomically reserve both routing identity and the canonical Claude UUID
    /// before spawning a child. The returned guard releases both claims on any
    /// pre-commit error path.
    pub fn reserve_session(
        &self,
        stdin_id: &str,
        cli_session_id: &str,
    ) -> Result<SpawnReservation, String> {
        let generation = uuid::Uuid::new_v4().to_string();
        let claim = SessionClaim {
            stdin_id: stdin_id.to_string(),
            cli_session_id: cli_session_id.to_string(),
            generation,
        };

        self.with_claims(|claims| {
            if let Some(existing) = claims.by_stdin.get(stdin_id) {
                return Err(format!(
                    "STDIN_ID_ALREADY_ACTIVE: stdin_id={} owner_cli_session_id={}",
                    stdin_id, existing.cli_session_id
                ));
            }
            if let Some(existing) = claims.by_cli_session.get(cli_session_id) {
                return Err(format!(
                    "SESSION_ALREADY_ACTIVE: cli_session_id={} owner_stdin_id={}",
                    cli_session_id, existing.stdin_id
                ));
            }
            claims.by_stdin.insert(stdin_id.to_string(), claim.clone());
            claims
                .by_cli_session
                .insert(cli_session_id.to_string(), claim.clone());
            Ok(SpawnReservation {
                manager: self.clone(),
                claim,
                committed: false,
            })
        })
    }

    fn release_claim_if_current(&self, claim: &SessionClaim) {
        self.with_claims(|claims| {
            let stdin_matches = claims
                .by_stdin
                .get(&claim.stdin_id)
                .is_some_and(|current| current == claim);
            let cli_matches = claims
                .by_cli_session
                .get(&claim.cli_session_id)
                .is_some_and(|current| current == claim);
            if stdin_matches {
                claims.by_stdin.remove(&claim.stdin_id);
            }
            if cli_matches {
                claims.by_cli_session.remove(&claim.cli_session_id);
            }
        });
    }

    pub fn cli_session_for_stdin(&self, stdin_id: &str) -> Option<String> {
        self.with_claims(|claims| {
            claims
                .by_stdin
                .get(stdin_id)
                .map(|claim| claim.cli_session_id.clone())
        })
    }

    pub fn has_stdin_claim(&self, stdin_id: &str) -> bool {
        self.with_claims(|claims| claims.by_stdin.contains_key(stdin_id))
    }

    /// Subscribe to authoritative stdout-drained exit completion without
    /// changing process ownership.
    pub async fn exit_receiver(&self, id: &str) -> Option<watch::Receiver<bool>> {
        let process = {
            let map = self.processes.lock().await;
            map.get(id).cloned()
        }?;
        let managed = process.lock().await;
        Some(managed.exit_tx.subscribe())
    }

    /// Ask the waiter to kill the child but deliberately keep both the process
    /// entry and CLI UUID claim until stdout cleanup confirms exit.
    pub async fn request_kill(&self, id: &str) -> Option<watch::Receiver<bool>> {
        let process = {
            let map = self.processes.lock().await;
            map.get(id).cloned()
        }?;
        let mut managed = process.lock().await;
        let receiver = managed.exit_tx.subscribe();
        if let Some(tx) = managed.kill_tx.take() {
            let _ = tx.send(());
        }
        Some(receiver)
    }

    /// TK-329: List all active stdinIds so the frontend can detect orphaned processes
    /// after a browser refresh (frontend state is wiped but backend keeps processes alive).
    pub async fn active_ids(&self) -> Vec<String> {
        // A start command owns its stdin/CLI identity before the child has
        // reached the process map. Include those pending reservations so a
        // reload/native close cannot pass the orphan barrier in that window.
        let mut ids =
            self.with_claims(|claims| claims.by_stdin.keys().cloned().collect::<Vec<_>>());
        let map = self.processes.lock().await;
        ids.extend(map.keys().cloned());
        ids.sort();
        ids.dedup();
        ids
    }

    /// Wait for a pending reservation to either publish its ManagedProcess or
    /// release the claim on a pre-commit failure. This closes the brief gap in
    /// which orphan cleanup can see the reservation but cannot yet subscribe
    /// to the child's authoritative stdout-drained exit signal.
    pub async fn wait_for_exit_receiver_or_claim_release(
        &self,
        id: &str,
        timeout: std::time::Duration,
    ) -> Result<Option<watch::Receiver<bool>>, ()> {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            if let Some(receiver) = self.exit_receiver(id).await {
                return Ok(Some(receiver));
            }
            if !self.has_stdin_claim(id) {
                return Ok(None);
            }
            let now = tokio::time::Instant::now();
            if now >= deadline {
                return Err(());
            }
            tokio::time::sleep(std::cmp::min(
                std::time::Duration::from_millis(10),
                deadline.saturating_duration_since(now),
            ))
            .await;
        }
    }

    /// Return whether a live child process currently owns a Claude CLI session.
    /// Reservations count as active so concurrent starts cannot pass during the
    /// child-spawn window or while a stop is still awaiting confirmed exit.
    pub async fn has_cli_session_id(&self, cli_session_id: &str) -> bool {
        self.with_claims(|claims| claims.by_cli_session.contains_key(cli_session_id))
    }

    /// Authoritative exit cleanup. The generation check prevents an old stdout
    /// reader from deleting or signalling a newer process that reused stdinId.
    pub async fn finish_if_current(&self, id: &str, generation: &str) -> bool {
        let candidate = {
            let map = self.processes.lock().await;
            map.get(id).cloned()
        };
        let Some(candidate) = candidate else {
            return false;
        };

        let (claim, exit_tx) = {
            let managed = candidate.lock().await;
            if managed.generation != generation {
                return false;
            }
            (
                SessionClaim {
                    stdin_id: managed.session_id.clone(),
                    cli_session_id: managed.cli_session_id.clone(),
                    generation: managed.generation.clone(),
                },
                managed.exit_tx.clone(),
            )
        };

        let removed = {
            let mut map = self.processes.lock().await;
            if map
                .get(id)
                .is_some_and(|current| Arc::ptr_eq(current, &candidate))
            {
                map.remove(id);
                true
            } else {
                false
            }
        };
        if !removed {
            return false;
        }

        self.release_claim_if_current(&claim);
        let _ = exit_tx.send(true);
        true
    }
}

impl SpawnReservation {
    pub fn generation(&self) -> &str {
        &self.claim.generation
    }

    pub async fn commit(
        mut self,
        process: ManagedProcess,
    ) -> Result<Arc<Mutex<ManagedProcess>>, String> {
        if process.session_id != self.claim.stdin_id
            || process.cli_session_id != self.claim.cli_session_id
            || process.generation != self.claim.generation
        {
            return Err(
                "SESSION_RESERVATION_MISMATCH: managed process identity changed before commit"
                    .to_string(),
            );
        }

        let process = Arc::new(Mutex::new(process));
        {
            let mut map = self.manager.processes.lock().await;
            if map.contains_key(&self.claim.stdin_id) {
                return Err(format!(
                    "STDIN_ID_ALREADY_ACTIVE: stdin_id={} owner_cli_session_id={}",
                    self.claim.stdin_id, self.claim.cli_session_id
                ));
            }
            map.insert(self.claim.stdin_id.clone(), process.clone());
        }
        self.committed = true;
        Ok(process)
    }
}

impl Drop for SpawnReservation {
    fn drop(&mut self) {
        if !self.committed {
            self.manager.release_claim_if_current(&self.claim);
        }
    }
}

/// Per-session bypass mode flag, shared between the stdout reader task and
/// the `send_control_request` command. When the user switches permission mode
/// at runtime (e.g. bypass → plan), `send_control_request` updates the flag
/// so the stdout reader's control_request handler uses the current mode.
#[derive(Debug, Default, Clone)]
pub struct BypassModeMap {
    flags: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
}

impl BypassModeMap {
    pub fn new() -> Self {
        Self {
            flags: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Register a session with its initial bypass mode. Returns a shared flag
    /// for the stdout reader task to read.
    pub async fn register(&self, session_id: &str, is_bypass: bool) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(is_bypass));
        let mut map = self.flags.lock().await;
        map.insert(session_id.to_string(), flag.clone());
        flag
    }

    /// Update bypass mode for a session (called when permission_mode changes at runtime).
    pub async fn set_bypass(&self, session_id: &str, is_bypass: bool) {
        let map = self.flags.lock().await;
        if let Some(flag) = map.get(session_id) {
            flag.store(is_bypass, Ordering::Relaxed);
        }
    }

    /// Remove a session's flag (called on process exit).
    pub async fn remove(&self, session_id: &str) {
        let mut map = self.flags.lock().await;
        map.remove(session_id);
    }

    /// Remove the stored flag only if it still points to the same Arc.
    /// This avoids an old stdout reader dropping a newer session's flag when
    /// the same stdin_id is reused during a fast restart.
    pub async fn drop_if_current(&self, session_id: &str, current: &Arc<AtomicBool>) {
        let mut map = self.flags.lock().await;
        if map
            .get(session_id)
            .is_some_and(|flag| Arc::ptr_eq(flag, current))
        {
            map.remove(session_id);
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct StartSessionParams {
    pub prompt: String,
    pub cwd: String,
    pub model: Option<String>,
    /// Provider-resolved lightweight model used by every subagent and the
    /// provider gateway.
    pub auxiliary_model: Option<String>,
    /// Native Agent tool enum used at the Claude tool boundary. Concrete
    /// provider model IDs must never be written into Agent.updatedInput.model.
    pub auxiliary_model_tier: Option<String>,
    pub session_id: Option<String>,
    pub allowed_tools: Option<Vec<String>>,
    /// When set, resume an existing Claude CLI session instead of starting a new one.
    /// The value should be the Claude CLI session ID (UUID).
    pub resume_session_id: Option<String>,
    /// Resume the source as an independent child conversation. Claude Code
    /// requires this to be paired with both --resume and a fresh --session-id.
    pub fork_session: Option<bool>,
    /// Thinking effort level: "off", "low", "medium", "high", or "max".
    pub thinking_level: Option<String>,
    /// Session mode: "ask", "plan", or "auto" (default).
    pub session_mode: Option<String>,
    /// Active provider ID from providers.json.
    /// When set, the provider's env vars are injected into the CLI process.
    pub provider_id: Option<String>,
    /// Permission mode for CLI. Maps from frontend session modes:
    ///   "acceptEdits" (code mode) | "default" (ask mode) | "plan" | "bypassPermissions" (bypass)
    /// When not "bypassPermissions", enables --permission-prompt-tool stdio for structured
    /// permission requests via the SDK control protocol.
    pub permission_mode: Option<String>,
    /// When true and resume_session_id is set, strip thinking blocks from the session JSONL
    /// before resuming. This prevents "invalid thinking signature" 400 errors when switching
    /// to a different model that can't verify the old model's cryptographic signatures.
    pub model_switch: Option<bool>,
    /// Explicit opt-in for Claude Code's experimental Agent Teams runtime.
    /// The backend pins teammates to `auxiliary_model`.
    pub agent_teams_enabled: Option<bool>,
}

#[cfg(test)]
mod process_manager_tests {
    use super::*;
    use tokio::sync::Barrier;

    fn managed_process(
        stdin_id: &str,
        cli_session_id: &str,
        generation: &str,
    ) -> (ManagedProcess, oneshot::Receiver<()>) {
        let (kill_tx, kill_rx) = oneshot::channel();
        let (exit_tx, _exit_rx) = watch::channel(false);
        (
            ManagedProcess {
                session_id: stdin_id.to_string(),
                cli_session_id: cli_session_id.to_string(),
                generation: generation.to_string(),
                pid: 1,
                kill_tx: Some(kill_tx),
                exit_tx,
            },
            kill_rx,
        )
    }

    #[cfg(unix)]
    #[test]
    fn managed_cli_identity_requires_stream_transport_and_exact_session() {
        let session = "550e8400-e29b-41d4-a716-446655440000";
        let managed = format!(
            "/Users/test/.local/bin/claude --print --input-format stream-json \
             --output-format stream-json --resume {session} --model claude-opus-5"
        );
        assert!(is_managed_cli_command(&managed, session));
        assert!(!is_managed_cli_command(
            &managed,
            "550e8400-e29b-41d4-a716-446655440001"
        ));
        assert!(!is_managed_cli_command(
            &format!("/Users/test/.local/bin/claude --resume {session}"),
            session
        ));
    }

    #[tokio::test]
    async fn concurrent_reserve_same_cli_uuid_has_exactly_one_winner() {
        const CONTENDERS: usize = 16;
        let manager = ProcessManager::new();
        let barrier = Arc::new(Barrier::new(CONTENDERS));
        let mut tasks = Vec::new();

        for index in 0..CONTENDERS {
            let manager = manager.clone();
            let barrier = barrier.clone();
            tasks.push(tokio::spawn(async move {
                barrier.wait().await;
                manager.reserve_session(
                    &format!("desk_{index}"),
                    "550e8400-e29b-41d4-a716-446655440000",
                )
            }));
        }

        let mut winner = None;
        let mut errors = Vec::new();
        for task in tasks {
            match task.await.unwrap() {
                Ok(reservation) => {
                    assert!(winner.replace(reservation).is_none());
                }
                Err(error) => errors.push(error),
            }
        }

        assert!(winner.is_some());
        assert_eq!(errors.len(), CONTENDERS - 1);
        assert!(errors
            .iter()
            .all(|error| error.starts_with("SESSION_ALREADY_ACTIVE:")));
        drop(winner);
        assert!(
            !manager
                .has_cli_session_id("550e8400-e29b-41d4-a716-446655440000")
                .await
        );
    }

    #[tokio::test]
    async fn failed_commit_releases_both_reservation_keys() {
        let manager = ProcessManager::new();
        let reservation = manager
            .reserve_session("desk_failed", "550e8400-e29b-41d4-a716-446655440001")
            .unwrap();
        let generation = reservation.generation().to_string();
        let (mut process, _kill_rx) = managed_process(
            "desk_failed",
            "550e8400-e29b-41d4-a716-446655440001",
            &generation,
        );
        process.generation = "wrong-generation".to_string();

        let error = reservation.commit(process).await.unwrap_err();
        assert!(error.starts_with("SESSION_RESERVATION_MISMATCH:"));
        assert!(!manager.has_stdin_claim("desk_failed"));
        assert!(
            !manager
                .has_cli_session_id("550e8400-e29b-41d4-a716-446655440001")
                .await
        );
        assert!(manager
            .reserve_session("desk_failed", "550e8400-e29b-41d4-a716-446655440001")
            .is_ok());
    }

    #[tokio::test]
    async fn pending_reservation_is_visible_to_orphan_cleanup_until_release() {
        let manager = ProcessManager::new();
        let reservation = manager
            .reserve_session("desk_pending", "550e8400-e29b-41d4-a716-446655440099")
            .unwrap();

        assert_eq!(manager.active_ids().await, vec!["desk_pending".to_string()]);
        assert!(manager.has_stdin_claim("desk_pending"));

        drop(reservation);
        assert!(manager.active_ids().await.is_empty());
        assert!(!manager.has_stdin_claim("desk_pending"));
    }

    #[tokio::test]
    async fn orphan_waiter_observes_a_process_committed_after_reservation() {
        let manager = ProcessManager::new();
        let reservation = manager
            .reserve_session(
                "desk_pending_commit",
                "550e8400-e29b-41d4-a716-446655440098",
            )
            .unwrap();
        let generation = reservation.generation().to_string();
        let waiter_manager = manager.clone();
        let waiter = tokio::spawn(async move {
            waiter_manager
                .wait_for_exit_receiver_or_claim_release(
                    "desk_pending_commit",
                    std::time::Duration::from_millis(250),
                )
                .await
        });
        tokio::task::yield_now().await;
        let (process, _kill_rx) = managed_process(
            "desk_pending_commit",
            "550e8400-e29b-41d4-a716-446655440098",
            &generation,
        );
        reservation.commit(process).await.unwrap();

        assert!(waiter.await.unwrap().unwrap().is_some());
        assert!(
            manager
                .finish_if_current("desk_pending_commit", &generation)
                .await
        );
    }

    #[tokio::test]
    async fn stale_generation_cannot_remove_new_process() {
        let manager = ProcessManager::new();
        let old = manager
            .reserve_session("desk_reused", "550e8400-e29b-41d4-a716-446655440002")
            .unwrap();
        let old_generation = old.generation().to_string();
        let (old_process, _old_kill_rx) = managed_process(
            "desk_reused",
            "550e8400-e29b-41d4-a716-446655440002",
            &old_generation,
        );
        old.commit(old_process).await.unwrap();
        assert!(
            manager
                .finish_if_current("desk_reused", &old_generation)
                .await
        );

        let new = manager
            .reserve_session("desk_reused", "550e8400-e29b-41d4-a716-446655440003")
            .unwrap();
        let new_generation = new.generation().to_string();
        let (new_process, _new_kill_rx) = managed_process(
            "desk_reused",
            "550e8400-e29b-41d4-a716-446655440003",
            &new_generation,
        );
        new.commit(new_process).await.unwrap();

        assert!(
            !manager
                .finish_if_current("desk_reused", &old_generation)
                .await
        );
        assert_eq!(manager.active_ids().await, vec!["desk_reused".to_string()]);
        assert!(
            manager
                .has_cli_session_id("550e8400-e29b-41d4-a716-446655440003")
                .await
        );
        assert!(
            manager
                .finish_if_current("desk_reused", &new_generation)
                .await
        );
    }

    #[test]
    fn duplicate_stdin_id_fails_closed() {
        let manager = ProcessManager::new();
        let reservation = manager
            .reserve_session("desk_duplicate", "550e8400-e29b-41d4-a716-446655440004")
            .unwrap();
        let error = manager
            .reserve_session("desk_duplicate", "550e8400-e29b-41d4-a716-446655440005")
            .unwrap_err();
        assert!(error.starts_with("STDIN_ID_ALREADY_ACTIVE:"));
        drop(reservation);
    }
}
