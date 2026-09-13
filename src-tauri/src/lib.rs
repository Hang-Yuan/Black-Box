mod automations;
mod auxiliary_model_hook;
mod client_runtime;
mod app_update;
mod commands;
mod conversation_projection;
mod debug_runtime_guard;
mod desktop_pet;
pub mod env_manager;
mod events;
mod experimental_foundation;
mod experimental_managed_provider;
mod experimental_memory_operator;
mod experimental_memory_promotion;
mod experimental_memory_recovery;
mod experimental_petpack;
mod experimental_rag;
mod experimental_sqlite_attestation;
mod identity_bootstrap;
mod mcp_manager;
pub mod path_access;
mod plugin_manager;
mod protocol;
mod provider_catalog;
mod provider_credentials;
mod provider_gateway;
mod provider_protocol;
#[allow(dead_code)]
mod runtime_harness;
mod session_metadata;
mod task_handoff;
mod time_context_hook;
mod workflow_manager;
// windows_ps compiles on all platforms so its pure-logic tests run on
// non-Windows CI; it is only *invoked* from `#[cfg(target_os = "windows")]`
// code paths.
mod windows_ps;

use crate::events::emit_to_frontend;
use crate::path_access::{PathAccessManager, PathCapability};
use crate::provider_protocol::{ProviderAuthScheme, ProviderProtocol};
use commands::{
    BypassModeMap, ManagedProcess, ProcessManager, SessionInfo, StartSessionParams, StdinManager,
};
// protocol module kept for ControlRequest (send_control_request) and tests
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap};
use std::process::Stdio;
use std::sync::Arc;
#[cfg(target_os = "macos")]
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State, WindowEvent};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::Mutex as TokioMutex;

pub fn enforce_debug_runtime_isolation() -> Result<(), String> {
    debug_runtime_guard::enforce_process_isolation()
}

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

/// A dedicated monochrome alpha mask for the macOS menu bar. The application
/// icon has an opaque square background, so using it as a template image makes
/// macOS faithfully render that entire background as a white square.
#[cfg(target_os = "macos")]
fn menu_bar_template_icon() -> tauri::image::Image<'static> {
    const SIZE: u32 = 36;
    const SAMPLES: u32 = 4;
    const HALF_STROKE: f32 = 1.55;
    let segments = [
        ((8.0_f32, 6.5_f32), (28.0_f32, 6.5_f32)),
        ((28.0_f32, 7.0_f32), (8.0_f32, 29.0_f32)),
        ((8.0_f32, 29.5_f32), (28.0_f32, 29.5_f32)),
        ((8.0_f32, 7.0_f32), (28.0_f32, 29.0_f32)),
    ];
    let mut rgba = vec![0_u8; (SIZE * SIZE * 4) as usize];

    let distance_to_segment = |px: f32, py: f32, start: (f32, f32), end: (f32, f32)| {
        let dx = end.0 - start.0;
        let dy = end.1 - start.1;
        let length_sq = dx * dx + dy * dy;
        let t = if length_sq > 0.0 {
            (((px - start.0) * dx + (py - start.1) * dy) / length_sq).clamp(0.0, 1.0)
        } else {
            0.0
        };
        let nearest_x = start.0 + t * dx;
        let nearest_y = start.1 + t * dy;
        ((px - nearest_x).powi(2) + (py - nearest_y).powi(2)).sqrt()
    };

    for y in 0..SIZE {
        for x in 0..SIZE {
            let mut covered = 0_u32;
            for sy in 0..SAMPLES {
                for sx in 0..SAMPLES {
                    let px = x as f32 + (sx as f32 + 0.5) / SAMPLES as f32;
                    let py = y as f32 + (sy as f32 + 0.5) / SAMPLES as f32;
                    if segments.iter().any(|(start, end)| {
                        distance_to_segment(px, py, *start, *end) <= HALF_STROKE
                    }) {
                        covered += 1;
                    }
                }
            }
            let index = ((y * SIZE + x) * 4) as usize;
            rgba[index + 3] = ((covered * 255) / (SAMPLES * SAMPLES)) as u8;
        }
    }

    tauri::image::Image::new_owned(rgba, SIZE, SIZE)
}

#[cfg(all(test, target_os = "macos"))]
mod menu_bar_icon_tests {
    use super::menu_bar_template_icon;

    #[test]
    fn template_icon_keeps_the_background_transparent() {
        let icon = menu_bar_template_icon();
        let alpha = icon
            .rgba()
            .chunks_exact(4)
            .map(|pixel| pixel[3])
            .collect::<Vec<_>>();
        assert_eq!((icon.width(), icon.height()), (36, 36));
        assert_eq!(alpha[0], 0);
        assert!(alpha.iter().any(|value| *value == 255));
        assert!(alpha.iter().filter(|value| **value == 0).count() > alpha.len() / 2);
    }
}

#[cfg(target_os = "windows")]
fn claude_needs_cmd_wrapper(bin: &str) -> bool {
    bin.ends_with(".cmd")
        || bin.ends_with(".bat")
        || (!bin.contains('\\') && !bin.contains('/') && !bin.contains('.'))
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn shell_single_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r#"'\''"#))
}

/// Strip ANSI escape sequences from a string (terminal color/cursor codes).
fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\x1b' {
            match chars.peek() {
                Some('[') => {
                    chars.next();
                    while let Some(&ch) = chars.peek() {
                        chars.next();
                        if ('\x40'..='\x7e').contains(&ch) {
                            break;
                        }
                    }
                }
                Some(']') => {
                    chars.next();
                    while let Some(ch) = chars.next() {
                        if ch == '\x07' {
                            break;
                        }
                        if ch == '\x1b' && chars.peek() == Some(&'\\') {
                            chars.next();
                            break;
                        }
                    }
                }
                Some('(' | ')') => {
                    chars.next();
                    chars.next();
                }
                _ => {
                    chars.next();
                }
            }
        } else if c < '\x20' && c != '\n' && c != '\r' && c != '\t' {
            // skip control chars
        } else {
            out.push(c);
        }
    }
    out
}

/// Manages active file watchers
#[derive(Default)]
struct WatcherManager {
    watchers: Arc<TokioMutex<HashMap<String, notify::RecommendedWatcher>>>,
}

#[derive(Clone, Debug, Default)]
struct CliMaintenanceState {
    gate: Arc<tokio::sync::RwLock<()>>,
}

static CLI_UPDATE_IN_PROGRESS: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);
static CLI_UPDATE_DOWNLOADED: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static CLI_UPDATE_TOTAL: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static CLI_UPDATE_PERCENT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static CLI_UPDATE_PHASE: std::sync::OnceLock<std::sync::Mutex<String>> = std::sync::OnceLock::new();

fn set_cli_update_progress(downloaded: u64, total: u64, percent: u64, phase: &str) {
    CLI_UPDATE_DOWNLOADED.store(downloaded, std::sync::atomic::Ordering::SeqCst);
    CLI_UPDATE_TOTAL.store(total, std::sync::atomic::Ordering::SeqCst);
    CLI_UPDATE_PERCENT.store(percent.min(100), std::sync::atomic::Ordering::SeqCst);
    let phase_state = CLI_UPDATE_PHASE.get_or_init(|| std::sync::Mutex::new("idle".to_string()));
    *phase_state
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = phase.to_string();
}

fn cli_update_progress_snapshot() -> (u64, u64, u64, String) {
    let downloaded = CLI_UPDATE_DOWNLOADED.load(std::sync::atomic::Ordering::SeqCst);
    let total = CLI_UPDATE_TOTAL.load(std::sync::atomic::Ordering::SeqCst);
    let percent = CLI_UPDATE_PERCENT.load(std::sync::atomic::Ordering::SeqCst);
    let phase = CLI_UPDATE_PHASE
        .get_or_init(|| std::sync::Mutex::new("idle".to_string()))
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone();
    (downloaded, total, percent, phase)
}

fn emit_cli_update_progress(
    app: &AppHandle,
    downloaded: u64,
    total: u64,
    percent: u64,
    phase: &str,
) {
    set_cli_update_progress(downloaded, total, percent, phase);
    let _ = emit_to_frontend(
        app,
        "setup:download:progress",
        serde_json::json!({
            "downloaded": downloaded,
            "total": total,
            "percent": percent.min(100),
            "phase": phase,
        }),
    );
}

pub(crate) fn cli_update_in_progress() -> bool {
    CLI_UPDATE_IN_PROGRESS.load(std::sync::atomic::Ordering::SeqCst)
}

struct CliUpdateFlag;

impl Drop for CliUpdateFlag {
    fn drop(&mut self) {
        CLI_UPDATE_IN_PROGRESS.store(false, std::sync::atomic::Ordering::SeqCst);
        set_cli_update_progress(0, 0, 0, "idle");
    }
}

// Fields are dropped in declaration order: release the spawn/update gate
// first, then clear the automation-visible flag.
struct CliUpdateLease<'a> {
    _gate: tokio::sync::RwLockWriteGuard<'a, ()>,
    _flag: CliUpdateFlag,
}

#[derive(Debug, Default)]
struct PowerAssertionIds {
    system: Option<u32>,
    display: Option<u32>,
}

#[derive(Debug, Default)]
struct PowerAssertionInner {
    ids: std::sync::Mutex<PowerAssertionIds>,
}

#[derive(Clone, Debug, Default)]
struct PowerAssertionState {
    inner: Arc<PowerAssertionInner>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PowerAssertionStatus {
    supported: bool,
    keep_system_awake: bool,
    keep_display_awake: bool,
}

fn normalize_power_request(keep_system_awake: bool, keep_display_awake: bool) -> (bool, bool) {
    (keep_system_awake, keep_system_awake && keep_display_awake)
}

#[cfg(target_os = "macos")]
mod macos_power_assertion {
    use std::ffi::{c_char, c_void, CString};

    type CfStringRef = *const c_void;

    const K_CF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;
    const K_IOPM_ASSERTION_LEVEL_ON: u32 = 255;

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFStringCreateWithCString(
            allocator: *const c_void,
            c_str: *const c_char,
            encoding: u32,
        ) -> CfStringRef;
        fn CFRelease(value: *const c_void);
    }

    #[link(name = "IOKit", kind = "framework")]
    extern "C" {
        fn IOPMAssertionCreateWithName(
            assertion_type: CfStringRef,
            level: u32,
            assertion_name: CfStringRef,
            assertion_id: *mut u32,
        ) -> i32;
        fn IOPMAssertionRelease(assertion_id: u32) -> i32;
    }

    fn cf_string(value: &str) -> Result<CfStringRef, String> {
        let value = CString::new(value)
            .map_err(|_| "Power assertion string contains an interior NUL".to_string())?;
        let result = unsafe {
            CFStringCreateWithCString(std::ptr::null(), value.as_ptr(), K_CF_STRING_ENCODING_UTF8)
        };
        if result.is_null() {
            Err("macOS could not allocate a power assertion string".to_string())
        } else {
            Ok(result)
        }
    }

    pub(super) fn create(kind: &str, reason: &str) -> Result<u32, String> {
        let kind_ref = cf_string(kind)?;
        let reason_ref = match cf_string(reason) {
            Ok(value) => value,
            Err(error) => {
                unsafe { CFRelease(kind_ref) };
                return Err(error);
            }
        };
        let mut assertion_id = 0u32;
        let result = unsafe {
            IOPMAssertionCreateWithName(
                kind_ref,
                K_IOPM_ASSERTION_LEVEL_ON,
                reason_ref,
                &mut assertion_id,
            )
        };
        unsafe {
            CFRelease(reason_ref);
            CFRelease(kind_ref);
        }
        if result == 0 {
            Ok(assertion_id)
        } else {
            Err(format!(
                "IOPMAssertionCreateWithName({kind}) failed with IOReturn {result}"
            ))
        }
    }

    pub(super) fn release(assertion_id: u32) -> Result<(), String> {
        let result = unsafe { IOPMAssertionRelease(assertion_id) };
        if result == 0 {
            Ok(())
        } else {
            Err(format!(
                "IOPMAssertionRelease({assertion_id}) failed with IOReturn {result}"
            ))
        }
    }
}

impl PowerAssertionState {
    fn status_from(ids: &PowerAssertionIds) -> PowerAssertionStatus {
        PowerAssertionStatus {
            supported: cfg!(target_os = "macos"),
            keep_system_awake: ids.system.is_some(),
            keep_display_awake: ids.display.is_some(),
        }
    }

    fn status(&self) -> Result<PowerAssertionStatus, String> {
        let ids = self
            .inner
            .ids
            .lock()
            .map_err(|_| "Power assertion state lock was poisoned".to_string())?;
        Ok(Self::status_from(&ids))
    }

    fn apply(
        &self,
        keep_system_awake: bool,
        keep_display_awake: bool,
    ) -> Result<PowerAssertionStatus, String> {
        let (keep_system_awake, keep_display_awake) =
            normalize_power_request(keep_system_awake, keep_display_awake);

        #[cfg(not(target_os = "macos"))]
        {
            let _ = (keep_system_awake, keep_display_awake);
            return Ok(PowerAssertionStatus {
                supported: false,
                keep_system_awake: false,
                keep_display_awake: false,
            });
        }

        #[cfg(target_os = "macos")]
        {
            let mut ids = self
                .inner
                .ids
                .lock()
                .map_err(|_| "Power assertion state lock was poisoned".to_string())?;

            if keep_system_awake && ids.system.is_none() {
                ids.system = Some(macos_power_assertion::create(
                    "PreventUserIdleSystemSleep",
                    "Black Box is running background work",
                )?);
            }
            if keep_display_awake && ids.display.is_none() {
                ids.display = Some(macos_power_assertion::create(
                    "PreventUserIdleDisplaySleep",
                    "Black Box is keeping the display awake",
                )?);
            }

            if !keep_display_awake {
                if let Some(assertion_id) = ids.display {
                    macos_power_assertion::release(assertion_id)?;
                    ids.display = None;
                }
            }
            if !keep_system_awake {
                if let Some(assertion_id) = ids.system {
                    macos_power_assertion::release(assertion_id)?;
                    ids.system = None;
                }
            }

            Ok(Self::status_from(&ids))
        }
    }

    fn release_all(&self) -> Result<(), String> {
        self.apply(false, false).map(|_| ())
    }
}

impl Drop for PowerAssertionInner {
    fn drop(&mut self) {
        #[cfg(target_os = "macos")]
        if let Ok(ids) = self.ids.get_mut() {
            if let Some(assertion_id) = ids.display.take() {
                let _ = macos_power_assertion::release(assertion_id);
            }
            if let Some(assertion_id) = ids.system.take() {
                let _ = macos_power_assertion::release(assertion_id);
            }
        }
    }
}

/// Shared app data directory name — all Black Box editions use the same
/// directory so they share a single CLI installation and settings.
const APP_DATA_DIR_NAME: &str = "com.blackbox.app";

/// GCS bucket for Claude Code releases.
const CLI_GCS_BASE: &str = "https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases";

/// Self-hosted mirror for China users.
const CLI_MIRROR_BASE: &str = "https://herear.cn:8443/releases/claude-code";

/// Path to the CLI download directory under the app's local data dir.
pub(crate) fn cli_download_dir() -> Option<std::path::PathBuf> {
    dirs::data_local_dir().map(|d| d.join(APP_DATA_DIR_NAME).join("cli"))
}

/// Path to the local Git installation directory (Windows only).
#[cfg(target_os = "windows")]
fn git_download_dir() -> Result<std::path::PathBuf, String> {
    dirs::data_local_dir()
        .map(|d| d.join(APP_DATA_DIR_NAME).join("git"))
        .ok_or_else(|| "Cannot determine app data directory".to_string())
}

/// Check if app-local PortableGit bash.exe exists (Windows only).
#[cfg(target_os = "windows")]
fn get_local_git_bash() -> Option<String> {
    let git_dir = git_download_dir().ok()?;
    let bash = git_dir.join("bin").join("bash.exe");
    if bash.exists() {
        Some(bash.to_string_lossy().to_string())
    } else {
        None
    }
}

// is_valid_executable moved to commands/cli_resolver.rs

/// On Windows, find git-bash (bash.exe) to satisfy Claude Code's requirement.
/// Returns the path to bash.exe if found.
#[cfg(target_os = "windows")]
pub(crate) fn find_git_bash() -> Option<String> {
    // 1. Check app-local PortableGit first (auto-installed by BLACKBOX)
    if let Some(local) = get_local_git_bash() {
        return Some(local);
    }
    // 2. Check standard installation paths (all common drive letters)
    let mut candidates = vec![
        r"C:\Program Files\Git\bin\bash.exe".to_string(),
        r"C:\Program Files (x86)\Git\bin\bash.exe".to_string(),
    ];
    // Also check non-C drives (D:, E:, F:, etc.) where Git may be installed
    for drive in b'D'..=b'F' {
        candidates.push(format!(
            r"{}:\Program Files\Git\bin\bash.exe",
            drive as char
        ));
    }
    for c in &candidates {
        if std::path::Path::new(c).exists() {
            return Some(c.to_string());
        }
    }
    // Check user-level scoop/chocolatey installs
    if let Some(home) = dirs::home_dir() {
        let scoop = home.join(r"scoop\apps\git\current\bin\bash.exe");
        if scoop.exists() {
            return Some(scoop.to_string_lossy().to_string());
        }
    }
    // Try `where bash` as last resort
    if let Ok(output) = std::process::Command::new("cmd")
        .args(["/C", "where", "bash"])
        .creation_flags(0x08000000)
        .output()
    {
        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            if let Some(path) = stdout.lines().next() {
                let path = path.trim().to_string();
                if !path.is_empty()
                    && commands::cli_resolver::is_valid_executable(std::path::Path::new(&path))
                {
                    return Some(path);
                }
            }
        }
    }
    None
}

fn find_claude_binary() -> Option<String> {
    commands::cli_resolver::find_binary()
}

fn resolve_claude_sdk_runtime() -> Result<commands::cli_resolver::SdkRuntime, String> {
    commands::cli_resolver::resolve_sdk_runtime()
}

/// On macOS/Linux, GUI apps inherit a minimal launchd PATH and miss version
/// managers (nvm, volta, fnm) that are set up in login-shell config files.
/// This function spawns a login shell once, captures its PATH, and caches it
/// for the lifetime of the process via OnceLock.
#[cfg(not(target_os = "windows"))]
pub(crate) fn login_shell_extra_path() -> &'static str {
    static CACHE: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    CACHE.get_or_init(|| {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
        let output = std::process::Command::new(&shell)
            .args(["-l", "-c", "echo $PATH"])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .output();
        match output {
            Ok(o) if o.status.success() => {
                let p = String::from_utf8_lossy(&o.stdout).trim().to_string();
                if !p.is_empty() {
                    eprintln!(
                        "login shell PATH captured ({} entries)",
                        p.split(':').count()
                    );
                }
                p
            }
            _ => {
                eprintln!("login shell PATH capture failed");
                String::new()
            }
        }
    })
}

/// Capture proxy-related environment variables from the user's login shell.
/// GUI apps launched from Finder/Dock don't inherit shell env vars (including
/// proxy settings), which causes API requests to fail in regions that require
/// a proxy to reach Anthropic's API.
#[cfg(not(target_os = "windows"))]
fn login_shell_proxy_env() -> &'static HashMap<String, String> {
    static CACHE: std::sync::OnceLock<HashMap<String, String>> = std::sync::OnceLock::new();
    CACHE.get_or_init(|| {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
        // Print proxy-related vars in key=value format, one per line.
        // Must use -ic (interactive) instead of -l (login) because proxy vars
        // are typically set in .zshrc/.bashrc which are only sourced for
        // interactive shells, not non-interactive login shells.
        let script = r#"for v in https_proxy http_proxy all_proxy no_proxy HTTPS_PROXY HTTP_PROXY ALL_PROXY NO_PROXY; do eval "val=\$$v"; if [ -n "$val" ]; then echo "$v=$val"; fi; done"#;
        let output = std::process::Command::new(&shell)
            .args(["-ic", script])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .output();
        let mut map = HashMap::new();
        if let Ok(o) = output {
            if o.status.success() {
                let text = String::from_utf8_lossy(&o.stdout);
                for line in text.lines() {
                    if let Some((k, v)) = line.split_once('=') {
                        let k = k.trim();
                        let v = v.trim();
                        if !k.is_empty() && !v.is_empty() {
                            map.insert(k.to_string(), v.to_string());
                        }
                    }
                }
            }
        }
        if !map.is_empty() {
            eprintln!("login shell proxy env captured: {:?}", map.keys().collect::<Vec<_>>());
        }
        map
    })
}

/// Capture ANTHROPIC_* environment variables from the user's login shell.
/// GUI apps launched from Finder/Dock don't inherit shell env vars, so the
/// CLI child process won't see ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL, etc.
/// This captures them once at startup and injects them into CLI spawns when
/// no explicit provider is configured (the "inherit system config" path).
#[cfg(not(target_os = "windows"))]
fn login_shell_anthropic_env() -> &'static HashMap<String, String> {
    static CACHE: std::sync::OnceLock<HashMap<String, String>> = std::sync::OnceLock::new();
    CACHE.get_or_init(|| {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
        let script = r#"env | grep -E '^ANTHROPIC_|^CLAUDE_CODE_' | grep -v '^CLAUDE_CODE_ENABLE_SDK' | grep -v '^CLAUDE_CODE_MAX_OUTPUT' | grep -v '^CLAUDE_CODE_AUTO_COMPACT'"#;
        let output = std::process::Command::new(&shell)
            .args(["-ic", script])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .output();
        let mut map = HashMap::new();
        if let Ok(o) = output {
            if o.status.success() {
                let text = String::from_utf8_lossy(&o.stdout);
                for line in text.lines() {
                    if let Some((k, v)) = line.split_once('=') {
                        let k = k.trim();
                        let v = v.trim();
                        if !k.is_empty() && !v.is_empty() {
                            map.insert(k.to_string(), v.to_string());
                        }
                    }
                }
            }
        }
        if !map.is_empty() {
            eprintln!(
                "login shell anthropic env captured: {:?}",
                map.keys().collect::<Vec<_>>()
            );
        }
        map
    })
}

/// Windows GUI processes receive user-level environment variables directly
/// from Explorer, so there is no login shell to query. Keep the same accessor
/// available on Windows and snapshot the inherited ANTHROPIC_/CLAUDE_CODE_
/// variables for native-model discovery.
#[cfg(target_os = "windows")]
fn login_shell_anthropic_env() -> &'static HashMap<String, String> {
    static CACHE: std::sync::OnceLock<HashMap<String, String>> = std::sync::OnceLock::new();
    CACHE.get_or_init(|| {
        std::env::vars()
            .filter(|(key, value)| {
                !value.trim().is_empty()
                    && (key.starts_with("ANTHROPIC_") || key.starts_with("CLAUDE_CODE_"))
                    && !matches!(
                        key.as_str(),
                        "CLAUDE_CODE_ENABLE_SDK"
                            | "CLAUDE_CODE_MAX_OUTPUT"
                            | "CLAUDE_CODE_AUTO_COMPACT"
                    )
            })
            .collect()
    })
}

/// Check whether a URL's host looks internal/private (not needing a proxy).
fn is_internal_host(url: &str) -> bool {
    let host = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))
        .unwrap_or(url)
        .split('/')
        .next()
        .unwrap_or("");
    let host = host.split(':').next().unwrap_or(host); // strip port
    if host.is_empty() {
        return false;
    }
    // localhost
    if host == "localhost" || host == "127.0.0.1" || host == "::1" {
        return true;
    }
    // private IPv4 ranges
    if let Some(first) = host.split('.').next() {
        if let Ok(n) = first.parse::<u32>() {
            if n == 10 {
                return true;
            }
        }
    }
    if host.starts_with("192.168.") || host.starts_with("172.") {
        if host.starts_with("172.") {
            if let Some(second) = host.split('.').nth(1) {
                if let Ok(n) = second.parse::<u32>() {
                    if (16..=31).contains(&n) {
                        return true;
                    }
                }
            }
        } else {
            return true; // 192.168.
        }
    }
    // RFC 6762 / 8375 pseudo-TLDs commonly used in private networks
    if host.ends_with(".internal") || host.ends_with(".local") {
        return true;
    }
    false
}

/// Read macOS system proxy settings from `scutil --proxy`.
/// Re-reads every call so proxy changes are picked up immediately.
#[cfg(target_os = "macos")]
fn system_proxy_url() -> Option<String> {
    let output = std::process::Command::new("scutil")
        .arg("--proxy")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let get_val = |key: &str| -> Option<String> {
        text.lines()
            .find(|l| l.trim().starts_with(&format!("{} :", key)))
            .and_then(|l| l.split(':').nth(1))
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
    };
    let is_enabled = |key: &str| get_val(key).map_or(false, |v| v == "1");

    // Prefer HTTPS > SOCKS > HTTP
    if is_enabled("HTTPSEnable") {
        if let (Some(host), Some(port)) = (get_val("HTTPSProxy"), get_val("HTTPSPort")) {
            let url = format!("http://{}:{}", host, port);
            eprintln!("system proxy detected (HTTPS): {}", url);
            return Some(url);
        }
    }
    if is_enabled("SOCKSEnable") {
        if let (Some(host), Some(port)) = (get_val("SOCKSProxy"), get_val("SOCKSPort")) {
            let url = format!("socks5://{}:{}", host, port);
            eprintln!("system proxy detected (SOCKS): {}", url);
            return Some(url);
        }
    }
    if is_enabled("HTTPEnable") {
        if let (Some(host), Some(port)) = (get_val("HTTPProxy"), get_val("HTTPPort")) {
            let url = format!("http://{}:{}", host, port);
            eprintln!("system proxy detected (HTTP): {}", url);
            return Some(url);
        }
    }
    None
}

/// Probe common local proxy ports and return the first reachable one.
/// Re-probes every call (fast: ~100ms worst case) so proxy tools started after
/// BLACKBOX are still detected. Covers Clash, Surge, common SOCKS.
fn probe_local_proxy() -> Option<String> {
    let ports: &[(u16, &str)] = &[
        (7890, "http"),   // Clash default
        (7897, "http"),   // Clash Verge default
        (6152, "http"),   // Surge HTTP
        (1080, "socks5"), // Common SOCKS
    ];
    for &(port, scheme) in ports {
        let addr: std::net::SocketAddr = ([127, 0, 0, 1], port).into();
        if std::net::TcpStream::connect_timeout(&addr, std::time::Duration::from_millis(80)).is_ok()
        {
            let url = format!("{}://127.0.0.1:{}", scheme, port);
            eprintln!("auto-detected local proxy: {}", url);
            return Some(url);
        }
    }
    None
}

/// Resolve the best proxy URL from environment variables, system proxy, and login shell.
/// Returns Some(url) if a proxy is configured, None otherwise.
fn resolve_proxy_url() -> Option<String> {
    // 1. Check current process env vars (set by VPN/Clash when running)
    let from_env = std::env::var("https_proxy")
        .ok()
        .or_else(|| std::env::var("HTTPS_PROXY").ok())
        .or_else(|| std::env::var("all_proxy").ok())
        .or_else(|| std::env::var("ALL_PROXY").ok())
        .or_else(|| std::env::var("http_proxy").ok())
        .or_else(|| std::env::var("HTTP_PROXY").ok());
    if let Some(url) = from_env {
        if !url.is_empty() {
            return Some(url);
        }
    }
    // 2. macOS system proxy (System Settings > Network > Proxy)
    #[cfg(target_os = "macos")]
    {
        if let Some(url) = system_proxy_url() {
            return Some(url);
        }
    }
    // 3. macOS/Linux GUI apps don't inherit shell env; check login shell
    #[cfg(not(target_os = "windows"))]
    {
        let proxy_env = login_shell_proxy_env();
        let url = proxy_env
            .get("https_proxy")
            .or_else(|| proxy_env.get("HTTPS_PROXY"))
            .or_else(|| proxy_env.get("all_proxy"))
            .or_else(|| proxy_env.get("ALL_PROXY"))
            .or_else(|| proxy_env.get("http_proxy"))
            .or_else(|| proxy_env.get("HTTP_PROXY"));
        if let Some(u) = url {
            if !u.is_empty() {
                return Some(u.clone());
            }
        }
    }
    // 4. Probe common local proxy ports (Clash 7890, Surge 6152, SOCKS 1080)
    if let Some(url) = probe_local_proxy() {
        return Some(url);
    }
    None
}

/// Check if a proxy endpoint is actually reachable (TCP connect with 1s timeout).
async fn is_proxy_reachable(proxy_url: &str) -> bool {
    // Parse host:port from proxy URL like "http://127.0.0.1:7890"
    let addr = proxy_url
        .trim_start_matches("http://")
        .trim_start_matches("https://")
        .trim_start_matches("socks5://")
        .trim_start_matches("socks5h://")
        .trim_end_matches('/');
    match tokio::time::timeout(
        std::time::Duration::from_secs(1),
        tokio::net::TcpStream::connect(addr),
    )
    .await
    {
        Ok(Ok(_)) => true,
        _ => false,
    }
}

/// Build a reqwest Client with smart proxy handling.
///
/// Logic: if a proxy URL is found in env/login-shell, probe the proxy port first.
/// If reachable → use proxy; if not (VPN off) → bypass and connect directly.
/// This makes the app "just work" regardless of VPN state.
async fn build_smart_http_client(
    connect_timeout: std::time::Duration,
    request_timeout: std::time::Duration,
) -> reqwest::Client {
    let mut builder = reqwest::Client::builder()
        .connect_timeout(connect_timeout)
        .timeout(request_timeout)
        .no_proxy(); // Disable automatic env proxy reading — we manage it ourselves

    if let Some(proxy_url) = resolve_proxy_url() {
        if is_proxy_reachable(&proxy_url).await {
            if let Ok(proxy) = reqwest::Proxy::all(&proxy_url) {
                eprintln!("Smart proxy: using proxy {}", proxy_url);
                builder = builder.proxy(proxy);
            }
        } else {
            eprintln!(
                "Smart proxy: proxy {} unreachable, connecting directly",
                proxy_url
            );
        }
    }

    builder.build().unwrap_or_else(|_| {
        reqwest::Client::builder()
            .no_proxy()
            .build()
            .unwrap_or_default()
    })
}

/// Truncate excessively large string values inside a JSON structure.
/// Used to prevent Tauri IPC / WebView freezes when Claude CLI returns
/// huge tool results (e.g. 24MB PDF text content).
fn truncate_large_content(value: &mut Value, max_bytes: usize) {
    match value {
        Value::String(s) => {
            if s.len() > max_bytes {
                // Truncate at a safe UTF-8 boundary
                let mut end = max_bytes;
                while end > 0 && !s.is_char_boundary(end) {
                    end -= 1;
                }
                s.truncate(end);
                s.push_str(
                    "\n\n... [content truncated for display, full content available to Claude]",
                );
            }
        }
        Value::Array(arr) => {
            for item in arr.iter_mut() {
                truncate_large_content(item, max_bytes);
            }
        }
        Value::Object(map) => {
            for (_k, v) in map.iter_mut() {
                truncate_large_content(v, max_bytes);
            }
        }
        _ => {}
    }
}

/// Build an enriched PATH that includes common binary locations
pub(crate) fn build_enriched_path() -> String {
    let current = std::env::var("PATH").unwrap_or_default();
    let mut paths = vec![];

    #[cfg(target_os = "windows")]
    let separator = ";";
    #[cfg(not(target_os = "windows"))]
    let separator = ":";

    // Highest priority: local npm-global/bin (where CLI is installed via local npm)
    if let Some(npm_bin) = get_npm_global_bin() {
        paths.push(npm_bin.to_string_lossy().to_string());
    }

    // Local Node.js bin (for running npm-installed CLI)
    if let Some(node_bin) = get_local_node_bin() {
        paths.push(node_bin.to_string_lossy().to_string());
    }

    // App-local CLI download directory
    if let Some(cli_dir) = cli_download_dir() {
        paths.push(cli_dir.to_string_lossy().to_string());
    }

    // App-local Git (PortableGit) bin directory (Windows only)
    #[cfg(target_os = "windows")]
    {
        if let Ok(git_dir) = git_download_dir() {
            let git_bin = git_dir.join("bin");
            if git_bin.exists() {
                paths.push(git_bin.to_string_lossy().to_string());
            }
            // Also add cmd/ for git.exe
            let git_cmd = git_dir.join("cmd");
            if git_cmd.exists() {
                paths.push(git_cmd.to_string_lossy().to_string());
            }
            // Also add usr/bin/ for cygpath.exe (required by Claude CLI for path conversion)
            let git_usr_bin = git_dir.join("usr").join("bin");
            if git_usr_bin.exists() {
                paths.push(git_usr_bin.to_string_lossy().to_string());
            }
        }

        // Also check system-installed Git (not just app-local PortableGit)
        // to find usr/bin/cygpath.exe which Claude CLI needs for path conversion.
        if let Some(git_bash_path) = find_git_bash() {
            // git_bash_path is like "D:\Program Files\Git\bin\bash.exe"
            // We need the parent's parent to get the Git root, then add usr/bin
            let bash_path = std::path::Path::new(&git_bash_path);
            if let Some(git_root) = bash_path.parent().and_then(|p| p.parent()) {
                let usr_bin = git_root.join("usr").join("bin");
                if usr_bin.exists() {
                    let usr_bin_str = usr_bin.to_string_lossy().to_string();
                    if !paths.contains(&usr_bin_str) {
                        paths.push(usr_bin_str);
                    }
                }
                // Also ensure Git bin/ and cmd/ are in PATH
                for sub in &["bin", "cmd"] {
                    let dir = git_root.join(sub);
                    if dir.exists() {
                        let dir_str = dir.to_string_lossy().to_string();
                        if !paths.contains(&dir_str) {
                            paths.push(dir_str);
                        }
                    }
                }
            }
        }
    }

    if let Some(home) = dirs::home_dir() {
        #[cfg(target_os = "windows")]
        {
            if let Some(app_data) = dirs::data_dir() {
                paths.push(app_data.join("npm").to_string_lossy().to_string());
            }
            if let Some(local_app) = dirs::data_local_dir() {
                paths.push(
                    local_app
                        .join("Programs")
                        .join("claude-code")
                        .to_string_lossy()
                        .to_string(),
                );
            }
            paths.push(
                home.join("scoop")
                    .join("shims")
                    .to_string_lossy()
                    .to_string(),
            );
            paths.push(
                home.join(".cargo")
                    .join("bin")
                    .to_string_lossy()
                    .to_string(),
            );
            paths.push(
                home.join(".volta")
                    .join("bin")
                    .to_string_lossy()
                    .to_string(),
            );

            // nvm-windows: version dirs inside %NVM_HOME% (or %APPDATA%\nvm)
            let nvm_home = std::env::var("NVM_HOME")
                .map(std::path::PathBuf::from)
                .or_else(|_| dirs::config_dir().map(|d| d.join("nvm")).ok_or(()))
                .ok();
            if let Some(ref nvm_dir) = nvm_home {
                if nvm_dir.is_dir() {
                    if let Ok(entries) = std::fs::read_dir(nvm_dir) {
                        let mut version_dirs: Vec<std::path::PathBuf> = entries
                            .flatten()
                            .filter(|e| {
                                e.path().is_dir()
                                    && e.file_name().to_string_lossy().starts_with('v')
                            })
                            .map(|e| e.path())
                            .collect();
                        version_dirs.sort();
                        if let Some(latest) = version_dirs.last() {
                            paths.push(latest.to_string_lossy().to_string());
                        }
                    }
                }
            }
            // nvm-windows symlink (typically C:\Program Files\nodejs)
            if let Ok(symlink) = std::env::var("NVM_SYMLINK") {
                paths.push(symlink);
            }

            // fnm on Windows
            paths.push(
                home.join(".fnm")
                    .join("aliases")
                    .join("default")
                    .to_string_lossy()
                    .to_string(),
            );

            // Standard Node.js install path
            if let Ok(pf) = std::env::var("ProgramFiles") {
                let node_path = format!("{}\\nodejs", pf);
                paths.push(node_path);
            }
        }
        #[cfg(not(target_os = "windows"))]
        {
            paths.push(home.join(".cargo/bin").to_string_lossy().to_string());
            paths.push(home.join(".local/bin").to_string_lossy().to_string());
            paths.push(home.join(".npm-global/bin").to_string_lossy().to_string());

            // volta (version manager) — shims live here
            paths.push(home.join(".volta/bin").to_string_lossy().to_string());

            // fnm (version manager) — default alias symlink
            paths.push(
                home.join(".fnm/aliases/default/bin")
                    .to_string_lossy()
                    .to_string(),
            );

            // nvm: find the latest installed Node.js version
            let nvm_dir = std::env::var("NVM_DIR")
                .map(std::path::PathBuf::from)
                .unwrap_or_else(|_| home.join(".nvm"));
            let nvm_versions = nvm_dir.join("versions/node");
            if nvm_versions.is_dir() {
                if let Ok(entries) = std::fs::read_dir(&nvm_versions) {
                    let mut version_dirs: Vec<std::path::PathBuf> = entries
                        .flatten()
                        .filter(|e| e.path().is_dir())
                        .map(|e| e.path())
                        .collect();
                    version_dirs.sort_by(|a, b| {
                        let parse_ver = |p: &std::path::Path| -> (u32, u32, u32) {
                            let name = p.file_name().unwrap_or_default().to_string_lossy();
                            let s = name.strip_prefix('v').unwrap_or(&name);
                            let parts: Vec<u32> =
                                s.split('.').filter_map(|x| x.parse().ok()).collect();
                            (
                                parts.first().copied().unwrap_or(0),
                                parts.get(1).copied().unwrap_or(0),
                                parts.get(2).copied().unwrap_or(0),
                            )
                        };
                        parse_ver(a).cmp(&parse_ver(b))
                    });
                    if let Some(latest) = version_dirs.last() {
                        paths.push(latest.join("bin").to_string_lossy().to_string());
                    }
                }
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        paths.push("/opt/homebrew/bin".to_string());
        paths.push("/usr/local/bin".to_string());
    }

    // Merge login shell PATH (macOS/Linux) to catch version managers we missed
    #[cfg(not(target_os = "windows"))]
    {
        let shell_path = login_shell_extra_path();
        if !shell_path.is_empty() {
            let existing: std::collections::HashSet<String> = paths.iter().cloned().collect();
            let extra: Vec<String> = shell_path
                .split(':')
                .filter(|p| !p.is_empty() && !existing.contains(*p))
                .map(|p| p.to_string())
                .collect();
            paths.extend(extra);
        }
    }

    let mut result = paths.join(separator);
    if !current.is_empty() {
        result.push_str(separator);
        result.push_str(&current);
    }
    result
}

// --- Credential storage ---

/// Directory for BLACKBOX app data (may be wiped by NSIS installer on Windows)
fn app_data_dir() -> Result<std::path::PathBuf, String> {
    dirs::data_local_dir()
        .map(|d| d.join(APP_DATA_DIR_NAME))
        .ok_or_else(|| "Cannot determine app data directory".to_string())
}

/// Safe directory in user's home — survives Windows NSIS updates.
/// Uses ~/.blackbox/ which already stores tracked_sessions.txt.
fn safe_data_dir() -> Result<std::path::PathBuf, String> {
    dirs::home_dir()
        .map(|d| d.join(".blackbox"))
        .ok_or_else(|| "Cannot determine home directory".to_string())
}

// ================================================================
// Provider system — provider metadata and credentials in ~/.blackbox/providers.json.
// The file is atomically replaced with owner-only permissions by write_providers_file.
// ================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelMapping {
    tier: String,
    provider_model: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApiProvider {
    id: String,
    name: String,
    base_url: String,
    api_format: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    auth_scheme: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    api_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    credential_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    credential_hint: Option<String>,
    #[serde(default)]
    credential_state: String,
    #[serde(default)]
    revision: u64,
    model_mappings: Vec<ModelMapping>,
    extra_env: Option<HashMap<String, String>>,
    proxy_url: Option<String>,
    preset: Option<String>,
    created_at: u64,
    updated_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProvidersFile {
    version: u32,
    #[serde(default)]
    default_api: Option<String>,
    #[serde(default)]
    default_main_model: Option<String>,
    #[serde(default)]
    default_auxiliary_model: Option<String>,
    active_provider_id: Option<String>,
    providers: Vec<ApiProvider>,
}

const PARTIAL_MESSAGES_OVERRIDE_ENV: &str = "BLACKBOX_INCLUDE_PARTIAL_MESSAGES";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ProviderRuntimeCapabilities {
    is_native_anthropic: bool,
    supports_partial_messages: bool,
    supports_thinking_effort: bool,
}

impl ProviderRuntimeCapabilities {
    fn native_anthropic() -> Self {
        Self {
            is_native_anthropic: true,
            supports_partial_messages: true,
            supports_thinking_effort: true,
        }
    }
}

type ProviderEnvResolution = (
    HashMap<String, String>,
    Vec<String>,
    Vec<String>,
    ProviderRuntimeCapabilities,
);

impl Default for ProvidersFile {
    fn default() -> Self {
        Self {
            version: 1,
            default_api: None,
            default_main_model: None,
            default_auxiliary_model: None,
            active_provider_id: None,
            providers: vec![],
        }
    }
}

fn providers_path() -> Result<std::path::PathBuf, String> {
    Ok(safe_data_dir()?.join("providers.json"))
}

pub(crate) fn read_providers_file() -> Result<ProvidersFile, String> {
    let path = providers_path()?;
    if !path.exists() {
        return Ok(ProvidersFile::default());
    }
    let data =
        std::fs::read_to_string(&path).map_err(|e| format!("Cannot read providers: {}", e))?;
    let providers: ProvidersFile =
        serde_json::from_str(&data).map_err(|e| format!("Cannot parse providers: {}", e))?;
    Ok(normalize_provider_defaults(providers))
}

fn normalize_provider_defaults(mut providers: ProvidersFile) -> ProvidersFile {
    if providers.default_api.as_deref() == Some("system") {
        providers.default_api = None;
    }
    // v1-v3 did not have an explicit per-user default system configuration.
    // Missing defaults intentionally remain unconfigured instead of guessing
    // from the provider attached to whichever conversation happened to be open.
    providers
}

fn credential_state_for(provider: &ApiProvider) -> &'static str {
    if legacy_provider_secret(provider).is_some() {
        "local_file"
    } else {
        "missing"
    }
}

fn is_sensitive_provider_env_key(key: &str) -> bool {
    let upper = key.to_ascii_uppercase();
    upper.contains("API_KEY")
        || upper.contains("AUTH_TOKEN")
        || upper.contains("ACCESS_TOKEN")
        || upper.ends_with("_TOKEN")
        || upper.contains("SECRET")
        || upper.contains("PASSWORD")
        || upper.contains("CREDENTIAL")
        || upper.contains("PRIVATE_KEY")
}

fn merge_provider_extra_env(
    env: &mut HashMap<String, String>,
    keys_to_remove: &mut Vec<String>,
    extra: &HashMap<String, String>,
) {
    for (key, value) in extra {
        // Capability switches are consumed by Black Box itself. Provider
        // credentials belong exclusively to the native gateway's upstream
        // hop; neither category may reach Claude CLI or a shell tool it runs.
        if key == PARTIAL_MESSAGES_OVERRIDE_ENV {
            continue;
        }
        if is_sensitive_provider_env_key(key) {
            keys_to_remove.push(key.clone());
            continue;
        }
        if value.is_empty() {
            keys_to_remove.push(key.clone());
            env.remove(key);
        } else {
            env.insert(key.clone(), value.clone());
        }
    }
}

fn provider_inherited_env_removals() -> Vec<String> {
    [
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "ANTHROPIC_MODEL",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL",
        "ANTHROPIC_DEFAULT_SONNET_MODEL",
        "ANTHROPIC_DEFAULT_OPUS_MODEL",
        "CLAUDE_CODE_OAUTH_TOKEN",
        "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
        "CLAUDE_CODE_ENTRYPOINT",
        "CLAUDE_CODE_ENTRY",
    ]
    .into_iter()
    .map(str::to_string)
    .collect()
}

const MAIN_CLI_NESTED_GUARDS: &[&str] =
    &["CLAUDECODE", "CLAUDE_CODE_ENTRY", "CLAUDE_CODE_ENTRYPOINT"];

pub(crate) fn enforce_provider_loopback_child_env(
    provider_id: Option<&str>,
    env: &mut HashMap<String, String>,
    keys_to_remove: &mut Vec<String>,
) {
    if provider_id.is_none() {
        return;
    }

    for key in [
        "http_proxy",
        "https_proxy",
        "all_proxy",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "no_proxy",
        "NO_PROXY",
    ] {
        env.remove(key);
        if !keys_to_remove.iter().any(|candidate| candidate == key) {
            keys_to_remove.push(key.to_string());
        }
    }

    const LOOPBACK_NO_PROXY: &str = "127.0.0.1,localhost,::1";
    env.insert("no_proxy".to_string(), LOOPBACK_NO_PROXY.to_string());
    env.insert("NO_PROXY".to_string(), LOOPBACK_NO_PROXY.to_string());
}

fn should_inject_login_shell_provider_env(provider_id: Option<&str>) -> bool {
    provider_id.is_none()
}

/// Expose native custom model option to the frontend so the model selector
/// can show user-configured models (e.g. ANTHROPIC_CUSTOM_MODEL_OPTION) alongside
/// the four standard tiers. Only meaningful in native mode (no provider).
#[derive(Debug, Clone, serde::Serialize)]
struct NativeCustomModelOption {
    model_id: String,
    label: String,
    description: String,
}

#[tauri::command]
fn get_native_custom_model_options() -> Vec<NativeCustomModelOption> {
    let env_map = login_shell_anthropic_env();
    let model_id = match env_map.get("ANTHROPIC_CUSTOM_MODEL_OPTION") {
        Some(v) => v.clone(),
        None => return vec![],
    };
    let label = env_map
        .get("ANTHROPIC_CUSTOM_MODEL_OPTION_NAME")
        .cloned()
        .unwrap_or_else(|| model_id.clone());
    let description = env_map
        .get("ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION")
        .cloned()
        .unwrap_or_default();
    vec![NativeCustomModelOption {
        model_id,
        label,
        description,
    }]
}

fn legacy_provider_secret(provider: &ApiProvider) -> Option<&str> {
    provider
        .api_key
        .as_deref()
        .map(str::trim)
        .filter(|secret| !secret.is_empty())
        .or_else(|| {
            provider.extra_env.as_ref().and_then(|extra| {
                extra.iter().find_map(|(key, value)| {
                    let value = value.trim();
                    (is_sensitive_provider_env_key(key) && !value.is_empty()).then_some(value)
                })
            })
        })
}

fn strip_sensitive_provider_env(provider: &mut ApiProvider) {
    if let Some(extra) = provider.extra_env.as_mut() {
        extra.retain(|key, _| !is_sensitive_provider_env_key(key));
    }
}

fn sanitized_providers(mut data: ProvidersFile) -> ProvidersFile {
    for provider in &mut data.providers {
        let local_secret = legacy_provider_secret(provider).map(str::to_string);
        if provider.credential_hint.is_none() {
            provider.credential_hint = local_secret
                .as_deref()
                .map(provider_credentials::hint_for_secret);
        }
        provider.credential_state = credential_state_for(provider).to_string();
        provider.revision = provider.revision.max(1);
        provider.api_key = None;
        provider.credential_ref = None;
        strip_sensitive_provider_env(provider);
    }
    data
}

fn write_providers_file(path: &std::path::Path, data: &ProvidersFile) -> Result<(), String> {
    let json =
        serde_json::to_vec_pretty(data).map_err(|error| format!("Serialize error: {error}"))?;
    atomic_write_bytes(path, &json, "providers")
}

#[tauri::command]
fn load_providers() -> Result<ProvidersFile, String> {
    read_providers_file().map(sanitized_providers)
}

#[tauri::command]
fn save_providers(mut data: ProvidersFile) -> Result<ProvidersFile, String> {
    let path = providers_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Cannot create dir: {}", e))?;
    }
    let existing = read_providers_file().unwrap_or_default();
    let existing_by_id: HashMap<String, ApiProvider> = existing
        .providers
        .into_iter()
        .map(|provider| (provider.id.clone(), provider))
        .collect();

    if let Some(default_api) = data.default_api.as_deref() {
        if !data
            .providers
            .iter()
            .any(|provider| provider.id == default_api)
        {
            return Err(format!("Default API '{default_api}' does not exist"));
        }
    }
    for (label, model) in [
        ("main", data.default_main_model.as_deref()),
        ("auxiliary", data.default_auxiliary_model.as_deref()),
    ] {
        if let Some(model) = model {
            if !matches!(model, "fable" | "opus" | "sonnet" | "haiku") {
                return Err(format!("Default {label} model tier '{model}' is invalid"));
            }
        }
    }

    for provider in &mut data.providers {
        provider.auth_scheme = Some(resolve_provider_auth_scheme(provider)?);
        let previous = existing_by_id.get(&provider.id);
        let incoming_secret = provider
            .api_key
            .take()
            .map(|secret| secret.trim().to_string())
            .filter(|secret| !secret.is_empty());
        let previous_secret = previous
            .and_then(legacy_provider_secret)
            .map(str::to_string);
        let stored_secret = incoming_secret.or_else(|| previous_secret.clone());
        let credential_changed = stored_secret != previous_secret;

        strip_sensitive_provider_env(provider);
        provider.credential_ref = None;
        if let Some(secret) = stored_secret {
            provider.credential_hint = Some(provider_credentials::hint_for_secret(&secret));
            provider.api_key = Some(secret);
            provider.credential_state = "local_file".to_string();
        } else {
            provider.api_key = None;
            provider.credential_hint = None;
            provider.credential_state = "missing".to_string();
        }

        let previous_revision = previous.map(|entry| entry.revision.max(1)).unwrap_or(0);
        let metadata_changed = previous
            .map(|entry| entry.updated_at != provider.updated_at)
            .unwrap_or(true);
        provider.revision = if metadata_changed || credential_changed {
            previous_revision.saturating_add(1).max(1)
        } else {
            previous_revision.max(1)
        };
        provider.credential_state = credential_state_for(provider).to_string();
    }

    if let Some(default_api) = data.default_api.as_deref() {
        let default_provider = data
            .providers
            .iter()
            .find(|provider| provider.id == default_api)
            .ok_or_else(|| format!("Default API '{default_api}' does not exist"))?;
        if legacy_provider_secret(default_provider).is_none() {
            return Err(format!(
                "Default API '{default_api}' does not have a saved credential"
            ));
        }
    }

    data.version = 4;

    write_providers_file(&path, &data)?;
    Ok(sanitized_providers(data))
}

#[tauri::command]
fn clear_provider_credential(provider_id: String) -> Result<ProvidersFile, String> {
    let path = providers_path()?;
    let mut data = read_providers_file()?;
    let provider = data
        .providers
        .iter_mut()
        .find(|provider| provider.id == provider_id)
        .ok_or_else(|| format!("Provider '{provider_id}' not found"))?;

    provider.api_key = None;
    strip_sensitive_provider_env(provider);
    provider.credential_ref = None;
    provider.credential_hint = None;
    provider.credential_state = "missing".to_string();
    provider.revision = provider.revision.max(1).saturating_add(1);
    provider.updated_at = u64::try_from(chrono::Utc::now().timestamp_millis()).unwrap_or(u64::MAX);
    if data.default_api.as_deref() == Some(provider_id.as_str()) {
        data.default_api = None;
    }
    data.version = 4;
    write_providers_file(&path, &data)?;
    Ok(sanitized_providers(data))
}

#[tauri::command]
fn delete_provider(provider_id: String) -> Result<ProvidersFile, String> {
    let path = providers_path()?;
    let mut data = read_providers_file()?;
    data.providers
        .iter()
        .find(|provider| provider.id == provider_id)
        .ok_or_else(|| format!("Provider '{provider_id}' not found"))?;
    data.providers.retain(|provider| provider.id != provider_id);
    if data.active_provider_id.as_deref() == Some(provider_id.as_str()) {
        data.active_provider_id = None;
    }
    if data.default_api.as_deref() == Some(provider_id.as_str()) {
        data.default_api = None;
    }
    data.version = 4;
    write_providers_file(&path, &data)?;
    Ok(sanitized_providers(data))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StepResult {
    ok: bool,
    message: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct ConnectionTestResult {
    connectivity: StepResult,
    auth: StepResult,
    model: StepResult,
}

fn provider_connection_probe_url(
    protocol: ProviderProtocol,
    base_url: &str,
    model: &str,
) -> Result<String, String> {
    match protocol {
        ProviderProtocol::AnthropicMessages => Ok(format!("{base_url}/v1/messages")),
        ProviderProtocol::OpenAiChatCompletions => {
            Ok(provider_gateway::openai_chat_completions_url(base_url))
        }
        ProviderProtocol::GeminiGenerateContent => {
            provider_gateway::gemini_generate_content_url(base_url, model, false)
        }
    }
}

fn provider_connection_probe_body(
    protocol: ProviderProtocol,
    base_url: &str,
    model: &str,
) -> Value {
    if protocol == ProviderProtocol::GeminiGenerateContent {
        return serde_json::json!({
            "contents": [{
                "role": "user",
                "parts": [{"text": "hi"}]
            }],
            "generationConfig": {
                "maxOutputTokens": 1
            }
        });
    }

    let mut body = serde_json::json!({
        "model": model,
        "messages": [{"role": "user", "content": "hi"}]
    });
    let token_limit_field = if protocol == ProviderProtocol::OpenAiChatCompletions
        && provider_gateway::openai_uses_max_completion_tokens(base_url, model)
    {
        "max_completion_tokens"
    } else {
        "max_tokens"
    };
    body[token_limit_field] = serde_json::json!(1);
    body
}

fn apply_provider_connection_auth(
    request: reqwest::RequestBuilder,
    auth_scheme: ProviderAuthScheme,
    api_key: &str,
) -> reqwest::RequestBuilder {
    match auth_scheme {
        ProviderAuthScheme::Bearer => {
            request.header(reqwest::header::AUTHORIZATION, format!("Bearer {api_key}"))
        }
        ProviderAuthScheme::XApiKey => request
            .header("x-api-key", api_key)
            .header("anthropic-version", "2023-06-01"),
        ProviderAuthScheme::XGoogApiKey => request.header("x-goog-api-key", api_key),
    }
}

fn provider_error_indicates_auth_failure(status: u16, response_text: &str) -> bool {
    if status == 401 {
        return true;
    }
    if status != 400 && status != 403 {
        return false;
    }
    let text = response_text.to_ascii_lowercase();
    let identifies_credentials = text.contains("api key")
        || text.contains("api_key")
        || text.contains("auth token")
        || text.contains("access token")
        || text.contains("bearer token")
        || text.contains("credentials");
    identifies_credentials
        && (text.contains("invalid")
            || text.contains("not valid")
            || text.contains("unauthenticated"))
}

#[tauri::command]
async fn test_provider_connection(
    base_url: String,
    api_format: String,
    auth_scheme: Option<String>,
    api_key: Option<String>,
    provider_id: Option<String>,
    model: String,
    proxy_url: Option<String>,
) -> Result<ConnectionTestResult, String> {
    let stored_provider = if let Some(provider_id) = provider_id.as_deref() {
        let providers = read_providers_file()?;
        Some(
            providers
                .providers
                .into_iter()
                .find(|provider| provider.id == provider_id)
                .ok_or_else(|| format!("Provider '{provider_id}' not found"))?,
        )
    } else {
        None
    };
    let supplied_key = api_key
        .map(|secret| secret.trim().to_string())
        .filter(|secret| !secret.is_empty());
    let stored_key = if supplied_key.is_none() {
        if let Some(provider) = stored_provider.as_ref() {
            resolve_provider_secret(provider)?
        } else {
            None
        }
    } else {
        None
    };
    let api_key = supplied_key
        .or(stored_key)
        .ok_or_else(|| "Provider credential is missing".to_string())?;
    let protocol = ProviderProtocol::parse(&api_format)?;
    let auth_scheme = ProviderAuthScheme::parse(&resolve_provider_auth_scheme_parts(
        protocol.id(),
        auth_scheme
            .as_deref()
            .or_else(|| stored_provider.as_ref()?.auth_scheme.as_deref()),
        stored_provider
            .as_ref()
            .and_then(|provider| provider.preset.as_deref()),
    )?)?;
    // If provider has a proxy configured, build a client that uses it.
    // Otherwise fall back to the smart proxy detection.
    let client = if let Some(ref purl) = proxy_url {
        if !purl.is_empty() {
            if let Ok(proxy) = reqwest::Proxy::all(purl) {
                if is_proxy_reachable(purl).await {
                    eprintln!("test_provider_connection: using provider proxy {}", purl);
                    reqwest::Client::builder()
                        .connect_timeout(std::time::Duration::from_secs(10))
                        .timeout(std::time::Duration::from_secs(30))
                        .no_proxy()
                        .proxy(proxy)
                        .build()
                        .unwrap_or_default()
                } else {
                    eprintln!(
                        "test_provider_connection: provider proxy {} unreachable, direct",
                        purl
                    );
                    build_smart_http_client(
                        std::time::Duration::from_secs(10),
                        std::time::Duration::from_secs(30),
                    )
                    .await
                }
            } else {
                build_smart_http_client(
                    std::time::Duration::from_secs(10),
                    std::time::Duration::from_secs(30),
                )
                .await
            }
        } else {
            build_smart_http_client(
                std::time::Duration::from_secs(10),
                std::time::Duration::from_secs(30),
            )
            .await
        }
    } else {
        build_smart_http_client(
            std::time::Duration::from_secs(10),
            std::time::Duration::from_secs(30),
        )
        .await
    };

    let base = base_url.trim().trim_end_matches('/');
    let skipped = StepResult {
        ok: false,
        message: "Skipped".to_string(),
    };

    // Step 1: Connectivity — HEAD request to base URL without auth
    let connectivity_url = provider_connection_probe_url(protocol, base, &model)?;
    let conn_result = client
        .head(&connectivity_url)
        .timeout(std::time::Duration::from_secs(5))
        .send()
        .await;
    let connectivity = match conn_result {
        Ok(_resp) => StepResult {
            ok: true,
            message: "Reachable".to_string(),
        },
        Err(e) => {
            return Ok(ConnectionTestResult {
                connectivity: StepResult {
                    ok: false,
                    message: format!("Unreachable: {}", e),
                },
                auth: skipped.clone(),
                model: skipped,
            });
        }
    };

    // Steps 2+3: Auth + Model — single request with the REAL model name.
    // Previously used a dummy "test-auth-probe" model for auth, then the real model
    // for model validation. But some providers (e.g. MiMo) tie model access to API
    // key permissions and return 403 for unknown models, causing false auth failures.
    // Now we send one request and derive both auth and model status from it.
    let test_body = provider_connection_probe_body(protocol, base, &model);
    let test_req = client
        .post(&connectivity_url)
        .header("Content-Type", "application/json")
        .json(&test_body)
        .timeout(std::time::Duration::from_secs(15));
    let test_resp = apply_provider_connection_auth(test_req, auth_scheme, &api_key)
        .send()
        .await;
    let (auth, model_step) = match test_resp {
        Ok(resp) => {
            let status = resp.status().as_u16();
            if status == 401 {
                // Definitely auth failure
                let text = resp.text().await.unwrap_or_default();
                (
                    StepResult {
                        ok: false,
                        message: format!(
                            "HTTP {} — {}",
                            status,
                            text.chars().take(200).collect::<String>()
                        ),
                    },
                    skipped,
                )
            } else if status == 403 {
                // 403 is ambiguous: could be auth failure OR model access restriction.
                // Read body to disambiguate.
                let text = resp.text().await.unwrap_or_default();
                if provider_error_indicates_auth_failure(status, &text) {
                    (
                        StepResult {
                            ok: false,
                            message: format!(
                                "HTTP 403 — {}",
                                text.chars().take(200).collect::<String>()
                            ),
                        },
                        skipped,
                    )
                } else {
                    // 403 but not clearly auth — treat as auth OK + model issue
                    (
                        StepResult {
                            ok: true,
                            message: "Authenticated (HTTP 403 — access restricted)".to_string(),
                        },
                        StepResult {
                            ok: false,
                            message: format!(
                                "HTTP 403 — {}",
                                text.chars().take(200).collect::<String>()
                            ),
                        },
                    )
                }
            } else if status >= 200 && status < 300 {
                (
                    StepResult {
                        ok: true,
                        message: format!("Authenticated (HTTP {})", status),
                    },
                    StepResult {
                        ok: true,
                        message: format!("Model OK (HTTP {})", status),
                    },
                )
            } else {
                // 400, 404, 429, 500, etc. — auth is OK (server processed the request)
                let text = resp.text().await.unwrap_or_default();
                let text_lower = text.to_lowercase();
                if provider_error_indicates_auth_failure(status, &text) {
                    return Ok(ConnectionTestResult {
                        connectivity,
                        auth: StepResult {
                            ok: false,
                            message: format!(
                                "HTTP {} — {}",
                                status,
                                text.chars().take(200).collect::<String>()
                            ),
                        },
                        model: skipped,
                    });
                }
                let is_model_error = (status == 404)
                    || (text_lower.contains("model")
                        && (text_lower.contains("not found")
                            || text_lower.contains("not_found")
                            || text_lower.contains("does not exist")
                            || text_lower.contains("invalid model")
                            || text_lower.contains("invalid_model")));
                let model_result = if is_model_error {
                    StepResult {
                        ok: false,
                        message: format!(
                            "HTTP {} — {}",
                            status,
                            text.chars().take(200).collect::<String>()
                        ),
                    }
                } else {
                    StepResult {
                        ok: true,
                        message: format!("Model accepted (HTTP {})", status),
                    }
                };
                (
                    StepResult {
                        ok: true,
                        message: format!("Authenticated (HTTP {})", status),
                    },
                    model_result,
                )
            }
        }
        Err(e) => (
            StepResult {
                ok: false,
                message: format!("Request failed: {}", e),
            },
            skipped,
        ),
    };

    Ok(ConnectionTestResult {
        connectivity,
        auth,
        model: model_step,
    })
}

fn resolve_provider_secret(provider: &ApiProvider) -> Result<Option<String>, String> {
    Ok(legacy_provider_secret(provider).map(str::to_string))
}

fn resolve_provider_auth_scheme_parts(
    api_format: &str,
    configured: Option<&str>,
    preset: Option<&str>,
) -> Result<String, String> {
    let protocol = ProviderProtocol::parse(api_format)?;
    // Preserve the legacy OpenAI behavior: it is always bearer-authenticated,
    // even if historical metadata contains a stale scheme.
    if protocol == ProviderProtocol::OpenAiChatCompletions {
        return Ok(protocol.default_auth_scheme().id().to_string());
    }
    if let Some(configured) = configured {
        let scheme = ProviderAuthScheme::parse(configured)?;
        if protocol.accepts_auth_scheme(scheme) {
            return Ok(scheme.id().to_string());
        }
        return Err(format!(
            "Provider protocol '{}' cannot use '{}' authentication",
            protocol.id(),
            scheme.id()
        ));
    }
    if let Some(preset) = preset {
        if let Some(contract) = provider_catalog::find(preset)? {
            if contract.api_format.eq_ignore_ascii_case(protocol.id()) {
                let scheme = ProviderAuthScheme::parse(&contract.auth_scheme)?;
                if protocol.accepts_auth_scheme(scheme) {
                    return Ok(scheme.id().to_string());
                }
            }
        }
    }
    // The protocol contract owns the custom-provider default: x-api-key for
    // Anthropic and x-goog-api-key for native Gemini GenerateContent.
    Ok(protocol.default_auth_scheme().id().to_string())
}

fn resolve_provider_auth_scheme(provider: &ApiProvider) -> Result<String, String> {
    resolve_provider_auth_scheme_parts(
        &provider.api_format,
        provider.auth_scheme.as_deref(),
        provider.preset.as_deref(),
    )
}

/// Resolve provider env vars and CLI args from a provider_id.
/// Returns (extra_env, keys_to_remove, extra_args, runtime capabilities).
/// Phase 5 / C8 (v3 §4.3) originally treated every non-native provider as
/// degraded. That avoided compatibility errors, but also disabled the partial
/// text/thinking stream for providers that do support Anthropic-compatible
/// partial messages. Keep risky native-only env vars native-only, but default
/// Anthropic-format API providers to the same partial-message stream path as
/// native Claude. Providers can opt out with BLACKBOX_INCLUDE_PARTIAL_MESSAGES=false.
fn resolve_provider_env(provider_id: Option<&str>) -> Result<ProviderEnvResolution, String> {
    let Some(pid) = provider_id else {
        // No provider → assume native Anthropic (Claude Desktop / CCswitch).
        return Ok((
            HashMap::new(),
            vec![],
            vec![],
            ProviderRuntimeCapabilities::native_anthropic(),
        ));
    };

    let providers_file = read_providers_file()?;
    let provider = providers_file
        .providers
        .iter()
        .find(|p| p.id == pid)
        .ok_or_else(|| format!("Provider '{}' not found", pid))?;

    let mut env = HashMap::new();

    // Set base URL
    if !provider.base_url.is_empty() {
        env.insert("ANTHROPIC_BASE_URL".to_string(), provider.base_url.clone());
    }

    // Resolve the API key from Black Box's owner-only local providers file.
    // The plaintext secret is never returned to the frontend.
    // The child always authenticates to Black Box's loopback gateway with an
    // ephemeral x-api-key. The gateway applies the provider's upstream scheme.
    if let Some(key) = resolve_provider_secret(provider)? {
        if !key.is_empty() {
            env.insert("ANTHROPIC_API_KEY".to_string(), key);
        }
    }

    // Merge extra_env (empty string = delete from child process env)
    // Selecting any explicit Provider makes Black Box's loopback gateway the
    // sole authentication authority. Clear host/login-shell Claude auth even
    // when the upstream itself is Anthropic; spawn order removes inherited
    // values first and then injects the gateway's ephemeral session token.
    let mut keys_to_remove = provider_inherited_env_removals();
    if let Some(ref extra) = provider.extra_env {
        merge_provider_extra_env(&mut env, &mut keys_to_remove, extra);
    }

    // Inject provider-level proxy URL into CLI subprocess env.
    // This takes highest priority — if set, it overrides all other proxy sources.
    if let Some(ref proxy_url) = provider.proxy_url {
        if !proxy_url.is_empty() {
            for key in &["https_proxy", "http_proxy", "HTTPS_PROXY", "HTTP_PROXY"] {
                env.insert(key.to_string(), proxy_url.clone());
            }
            if proxy_url.starts_with("socks") {
                env.insert("all_proxy".to_string(), proxy_url.clone());
                env.insert("ALL_PROXY".to_string(), proxy_url.clone());
            }
        }
    }

    // Auto-disable experimental betas for non-Anthropic providers (#69).
    // Beta flags (cache_control.scope, structured-outputs, eager_input_streaming)
    // are only supported by Anthropic's native API. Bedrock, Vertex, and all
    // third-party proxies (including those that route through Bedrock internally)
    // will return 400 errors if these flags are present.
    // Only keep betas enabled when the base URL is explicitly Anthropic's native API.
    let base_lower = provider.base_url.to_lowercase();
    let is_native_anthropic = base_lower.is_empty() || base_lower.contains("api.anthropic.com");
    let provider_capabilities = resolve_provider_capabilities(provider, is_native_anthropic);
    if !is_native_anthropic {
        env.entry("CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS".to_string())
            .or_insert_with(|| "1".to_string());
    }

    // HOT-FIX (v0.10.5): strip inherited OAuth / host-managed env vars when
    // using a third-party provider, WITHOUT the v0.10.3 side effects.
    //
    // Background: the Black Box parent process inherits CCswitch's
    // ANTHROPIC_AUTH_TOKEN and Claude Desktop's CLAUDE_CODE_OAUTH_TOKEN /
    // CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST from its own environment.
    // tokio::process::Command inherits parent env by default, so the CLI
    // child sees those too. With an OAuth token present the CLI goes into
    // Bearer-auth mode and sends `Authorization: Bearer <token>` to the
    // third-party provider, which rejects with 401/429. Need to wipe them.
    //
    // What v0.10.3 got wrong (and we do NOT repeat):
    //   • `env.insert(<name>, "")` — a defined-but-empty AUTH_TOKEN is read
    //     by the CLI as "OAuth path with stale token" and triggers an
    //     oauth_token_refresh control_request which we can only deny →
    //     deadlock, CLI waits forever, user sees "send → spinner forever".
    //   • `--setting-sources project,local` — skips user settings.json and
    //     thus loses workspace trust / agents / MCP, which somehow causes
    //     the CLI to produce 429-triggering requests to third-party
    //     endpoints (same key works fine via curl).
    //
    // So: only env_remove, no empty insert, no setting-sources arg.
    let extra_args: Vec<String> = if !is_native_anthropic {
        for key in &keys_to_remove {
            if key != "ANTHROPIC_API_KEY" {
                env.remove(key);
            }
        }
        vec![]
    } else {
        vec![]
    };

    Ok((env, keys_to_remove, extra_args, provider_capabilities))
}

/// Replace provider credentials in the Claude child environment with a
/// loopback URL and a per-process token. The returned guard must live for the
/// full child lifetime.
pub(crate) async fn route_provider_through_gateway(
    provider_id: Option<&str>,
    env: &mut HashMap<String, String>,
) -> Result<Option<provider_gateway::ProviderGatewayGuard>, String> {
    let Some(provider_id) = provider_id else {
        return Ok(None);
    };
    let providers = read_providers_file()?;
    let provider = providers
        .providers
        .iter()
        .find(|provider| provider.id == provider_id)
        .ok_or_else(|| format!("Provider '{provider_id}' not found"))?;
    let protocol = ProviderProtocol::parse(&provider.api_format).map_err(|_| {
        format!(
            "Provider '{}' uses the unsupported '{}' protocol",
            provider.name, provider.api_format
        )
    })?;
    let upstream_base_url = env
        .remove("ANTHROPIC_BASE_URL")
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| format!("Provider '{}' has no base URL", provider.name))?;
    let upstream_api_key = env
        .remove("ANTHROPIC_API_KEY")
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| format!("Provider '{}' has no credential", provider.name))?;

    // The Claude child talks only to 127.0.0.1. Any provider proxy belongs on
    // the gateway's upstream client; leaving it in the child can proxy the
    // loopback request itself.
    for key in [
        "http_proxy",
        "https_proxy",
        "all_proxy",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "ANTHROPIC_AUTH_TOKEN",
        "CLAUDE_CODE_OAUTH_TOKEN",
    ] {
        env.remove(key);
    }

    let gateway = provider_gateway::start(provider_gateway::ProviderGatewayConfig {
        upstream_base_url,
        upstream_api_key,
        api_format: protocol.id().to_string(),
        auth_scheme: resolve_provider_auth_scheme(provider)?,
        proxy_url: provider.proxy_url.clone(),
    })
    .await?;
    env.insert(
        "ANTHROPIC_BASE_URL".to_string(),
        gateway.base_url().to_string(),
    );
    env.insert(
        "ANTHROPIC_API_KEY".to_string(),
        gateway.session_token().to_string(),
    );
    Ok(Some(gateway))
}

fn resolve_provider_capabilities(
    provider: &ApiProvider,
    is_native_anthropic: bool,
) -> ProviderRuntimeCapabilities {
    if is_native_anthropic {
        return ProviderRuntimeCapabilities::native_anthropic();
    }

    // Every recognized protocol terminates at Black Box's local Anthropic
    // gateway, so translated OpenAI and Gemini deltas can keep partial output.
    // The Gemini adapter does not yet map output_config.effort, so only
    // Anthropic and OpenAI may advertise thinking-effort support.
    let gateway_protocol = ProviderProtocol::parse(&provider.api_format).ok();
    let supports_partial_messages =
        provider_partial_messages_override(provider).unwrap_or(gateway_protocol.is_some());
    let supports_thinking_effort = matches!(
        gateway_protocol,
        Some(ProviderProtocol::AnthropicMessages) | Some(ProviderProtocol::OpenAiChatCompletions)
    );

    ProviderRuntimeCapabilities {
        is_native_anthropic: false,
        supports_partial_messages,
        supports_thinking_effort,
    }
}

fn provider_partial_messages_override(provider: &ApiProvider) -> Option<bool> {
    provider
        .extra_env
        .as_ref()
        .and_then(|extra| extra.get(PARTIAL_MESSAGES_OVERRIDE_ENV))
        .and_then(|value| parse_bool_override(value))
}

fn parse_bool_override(value: &str) -> Option<bool> {
    match value.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Some(true),
        "0" | "false" | "no" | "off" => Some(false),
        _ => None,
    }
}

fn redacted_env_for_log(env: &HashMap<String, String>) -> BTreeMap<String, String> {
    env.iter()
        .map(|(key, value)| {
            let key_upper = key.to_ascii_uppercase();
            let should_redact = key_upper.contains("KEY")
                || key_upper.contains("TOKEN")
                || key_upper.contains("AUTH")
                || key_upper.contains("SECRET")
                || key_upper.contains("PASSWORD")
                || key_upper.contains("PROXY");
            (
                key.clone(),
                if should_redact {
                    "[REDACTED]".to_string()
                } else {
                    value.clone()
                },
            )
        })
        .collect()
}

/// Normalize a UI model id to the CLI-expected model name.
///
/// The frontend already maps its `-1m` UI ids to the CLI's `[1m]` form
/// (see api-provider.ts CLI_MODEL_MAP) before the id reaches Rust, so standard
/// and 1M Opus variants both pass through unchanged. Kept as a seam in case
/// future models need backend-side rewriting.
fn normalize_cli_model_id(model: &str) -> String {
    model.to_string()
}

#[cfg(test)]
mod provider_capability_tests {
    use super::{
        apply_provider_connection_auth, enforce_provider_loopback_child_env,
        merge_provider_extra_env, normalize_cli_model_id, parse_bool_override,
        provider_connection_probe_body, provider_connection_probe_url,
        provider_error_indicates_auth_failure, provider_inherited_env_removals,
        redacted_env_for_log, resolve_provider_auth_scheme, resolve_provider_auth_scheme_parts,
        resolve_provider_capabilities, should_inject_login_shell_provider_env, ApiProvider,
        ModelMapping, ProviderAuthScheme, ProviderProtocol, MAIN_CLI_NESTED_GUARDS,
        PARTIAL_MESSAGES_OVERRIDE_ENV,
    };
    use std::collections::HashMap;

    fn provider(
        base_url: &str,
        preset: Option<&str>,
        api_format: &str,
        extra_env: Option<HashMap<String, String>>,
    ) -> ApiProvider {
        ApiProvider {
            id: "p1".to_string(),
            name: "Provider".to_string(),
            base_url: base_url.to_string(),
            api_format: api_format.to_string(),
            auth_scheme: None,
            api_key: Some("key".to_string()),
            credential_ref: None,
            credential_hint: None,
            credential_state: "local_file".to_string(),
            revision: 1,
            model_mappings: vec![ModelMapping {
                tier: "sonnet".to_string(),
                provider_model: "model".to_string(),
            }],
            extra_env,
            proxy_url: None,
            preset: preset.map(str::to_string),
            created_at: 1,
            updated_at: 1,
        }
    }

    #[test]
    fn native_anthropic_always_supports_partial_messages() {
        let p = provider("https://api.anthropic.com", None, "anthropic", None);
        let caps = resolve_provider_capabilities(&p, true);
        assert!(caps.is_native_anthropic);
        assert!(caps.supports_partial_messages);
        assert!(caps.supports_thinking_effort);
    }

    #[test]
    fn normalize_cli_model_id_passes_models_through_unchanged() {
        // Standard Opus passes through; the 1M form already arrives in `[1m]`
        // shape from the frontend, so it is also untouched.
        assert_eq!(normalize_cli_model_id("claude-opus-4-8"), "claude-opus-4-8");
        assert_eq!(
            normalize_cli_model_id("claude-opus-4-8[1m]"),
            "claude-opus-4-8[1m]"
        );
        assert_eq!(normalize_cli_model_id("glm-5"), "glm-5");
    }

    #[test]
    fn anthropic_format_providers_default_to_partial_messages() {
        let p = provider(
            "https://dashscope.aliyuncs.com/apps/anthropic",
            Some("qwen"),
            "anthropic",
            None,
        );
        let caps = resolve_provider_capabilities(&p, false);
        assert!(!caps.is_native_anthropic);
        assert!(caps.supports_partial_messages);
        assert!(caps.supports_thinking_effort);
    }

    #[test]
    fn openai_format_providers_use_gateway_partial_messages() {
        let p = provider("https://example.com/v1", None, "openai", None);
        let caps = resolve_provider_capabilities(&p, false);
        assert!(caps.supports_partial_messages);
        assert!(caps.supports_thinking_effort);
    }

    #[test]
    fn gemini_uses_native_auth_and_gateway_capabilities() {
        let gemini = provider(
            "https://generativelanguage.googleapis.com/v1beta",
            Some("gemini"),
            "gemini",
            None,
        );
        assert_eq!(
            resolve_provider_auth_scheme(&gemini).unwrap(),
            "x-goog-api-key"
        );
        assert_eq!(
            resolve_provider_auth_scheme_parts("gemini", None, None).unwrap(),
            "x-goog-api-key"
        );
        assert_eq!(
            resolve_provider_auth_scheme_parts("gemini", Some("x-goog-api-key"), Some("gemini"))
                .unwrap(),
            "x-goog-api-key"
        );
        assert!(resolve_provider_auth_scheme_parts("gemini", Some("bearer"), None).is_err());

        let caps = resolve_provider_capabilities(&gemini, false);
        assert!(!caps.is_native_anthropic);
        assert!(caps.supports_partial_messages);
        assert!(!caps.supports_thinking_effort);
    }

    #[test]
    fn gemini_connection_probe_uses_generate_content_and_x_goog_api_key() {
        let base = "https://generativelanguage.googleapis.com/v1beta";
        let model = "gemini-3.5-flash";
        let url =
            provider_connection_probe_url(ProviderProtocol::GeminiGenerateContent, base, model)
                .unwrap();
        assert_eq!(
            url,
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent"
        );

        let body =
            provider_connection_probe_body(ProviderProtocol::GeminiGenerateContent, base, model);
        assert_eq!(body["contents"][0]["role"], "user");
        assert_eq!(body["contents"][0]["parts"][0]["text"], "hi");
        assert_eq!(body["generationConfig"]["maxOutputTokens"], 1);
        assert!(body.get("model").is_none());
        assert!(body.get("messages").is_none());

        let request = apply_provider_connection_auth(
            reqwest::Client::new()
                .post(&url)
                .header("Content-Type", "application/json")
                .json(&body),
            ProviderAuthScheme::XGoogApiKey,
            "gemini-test-key",
        )
        .build()
        .unwrap();
        assert_eq!(
            request
                .headers()
                .get("x-goog-api-key")
                .and_then(|value| value.to_str().ok()),
            Some("gemini-test-key")
        );
        assert!(request
            .headers()
            .get(reqwest::header::AUTHORIZATION)
            .is_none());
        assert!(request.headers().get("x-api-key").is_none());
    }

    #[test]
    fn gemini_invalid_key_response_is_classified_as_auth_failure() {
        assert!(provider_error_indicates_auth_failure(
            400,
            r#"{"error":{"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT","reason":"API_KEY_INVALID"}}"#,
        ));
        assert!(provider_error_indicates_auth_failure(
            403,
            "invalid credentials",
        ));
        assert!(!provider_error_indicates_auth_failure(
            400,
            "invalid model name",
        ));
        assert!(!provider_error_indicates_auth_failure(
            400,
            "invalid max output token value",
        ));
    }

    #[test]
    fn fixed_provider_auth_schemes_preserve_legacy_custom_behavior() {
        let claude = provider(
            "https://api.anthropic.com",
            Some("anthropic"),
            "anthropic",
            None,
        );
        assert_eq!(resolve_provider_auth_scheme(&claude).unwrap(), "x-api-key");

        for (preset, expected) in [
            ("deepseek", "x-api-key"),
            ("zhipu", "x-api-key"),
            ("doubao", "bearer"),
            ("qwen", "bearer"),
            ("minimax", "x-api-key"),
            ("kimi", "bearer"),
        ] {
            let provider = provider(
                "https://example.com/anthropic",
                Some(preset),
                "anthropic",
                None,
            );
            assert_eq!(resolve_provider_auth_scheme(&provider).unwrap(), expected);
        }

        let legacy_custom = provider("https://relay.example.com", None, "anthropic", None);
        assert_eq!(
            resolve_provider_auth_scheme(&legacy_custom).unwrap(),
            "x-api-key"
        );

        let openai = provider("https://api.openai.com/v1", Some("openai"), "openai", None);
        assert_eq!(resolve_provider_auth_scheme(&openai).unwrap(), "bearer");
    }

    #[test]
    fn explicit_partial_messages_override_wins_for_non_native_provider() {
        let mut extra = HashMap::new();
        extra.insert(
            PARTIAL_MESSAGES_OVERRIDE_ENV.to_string(),
            "false".to_string(),
        );
        let p = provider(
            "https://openrouter.ai/api",
            Some("openrouter"),
            "anthropic",
            Some(extra),
        );
        let caps = resolve_provider_capabilities(&p, false);
        assert!(!caps.supports_partial_messages);
        assert!(caps.supports_thinking_effort);

        let mut extra = HashMap::new();
        extra.insert(
            PARTIAL_MESSAGES_OVERRIDE_ENV.to_string(),
            "true".to_string(),
        );
        let p = provider(
            "https://unknown.example.com",
            None,
            "anthropic",
            Some(extra),
        );
        let caps = resolve_provider_capabilities(&p, false);
        assert!(caps.supports_partial_messages);
        assert!(caps.supports_thinking_effort);
    }

    #[test]
    fn bool_override_parser_accepts_common_values() {
        assert_eq!(parse_bool_override("1"), Some(true));
        assert_eq!(parse_bool_override("on"), Some(true));
        assert_eq!(parse_bool_override("false"), Some(false));
        assert_eq!(parse_bool_override("OFF"), Some(false));
        assert_eq!(parse_bool_override("maybe"), None);
    }

    #[test]
    fn custom_provider_extra_env_never_reaches_cli_with_credentials() {
        let extra = HashMap::from([
            ("OPENAI_API_KEY".to_string(), "sk-sensitive".to_string()),
            (
                "CUSTOM_ACCESS_TOKEN".to_string(),
                "token-sensitive".to_string(),
            ),
            ("API_TIMEOUT_MS".to_string(), "300000".to_string()),
            ("REMOVE_ME".to_string(), String::new()),
            (
                PARTIAL_MESSAGES_OVERRIDE_ENV.to_string(),
                "true".to_string(),
            ),
        ]);
        let mut env = HashMap::from([(
            "ANTHROPIC_API_KEY".to_string(),
            "canonical-upstream-secret".to_string(),
        )]);
        let mut removals = Vec::new();
        merge_provider_extra_env(&mut env, &mut removals, &extra);

        assert!(!env.contains_key("OPENAI_API_KEY"));
        assert!(!env.contains_key("CUSTOM_ACCESS_TOKEN"));
        assert!(!env.contains_key(PARTIAL_MESSAGES_OVERRIDE_ENV));
        assert_eq!(
            env.get("ANTHROPIC_API_KEY").map(String::as_str),
            Some("canonical-upstream-secret")
        );
        assert_eq!(
            env.get("API_TIMEOUT_MS").map(String::as_str),
            Some("300000")
        );
        assert!(removals.iter().any(|key| key == "OPENAI_API_KEY"));
        assert!(removals.iter().any(|key| key == "CUSTOM_ACCESS_TOKEN"));
        assert!(removals.iter().any(|key| key == "REMOVE_ME"));
    }

    #[test]
    fn selected_provider_never_inherits_login_shell_anthropic_credentials() {
        assert!(should_inject_login_shell_provider_env(None));
        assert!(!should_inject_login_shell_provider_env(Some("gemini")));
        assert!(!should_inject_login_shell_provider_env(Some(
            "anthropic-relay"
        )));

        let removals = provider_inherited_env_removals();
        for key in [
            "ANTHROPIC_API_KEY",
            "ANTHROPIC_AUTH_TOKEN",
            "CLAUDE_CODE_OAUTH_TOKEN",
            "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
            "CLAUDE_CODE_ENTRY",
        ] {
            assert!(removals.iter().any(|candidate| candidate == key));
        }
        assert!(MAIN_CLI_NESTED_GUARDS.contains(&"CLAUDE_CODE_ENTRY"));
    }

    #[test]
    fn provider_loopback_child_env_cannot_be_reproxied() {
        let mut env = HashMap::from([
            (
                "https_proxy".to_string(),
                "http://127.0.0.1:7890".to_string(),
            ),
            (
                "HTTP_PROXY".to_string(),
                "http://127.0.0.1:7890".to_string(),
            ),
            (
                "ALL_PROXY".to_string(),
                "socks5://127.0.0.1:7890".to_string(),
            ),
            ("NO_PROXY".to_string(), "corp.example".to_string()),
            ("KEEP_ME".to_string(), "yes".to_string()),
        ]);
        let mut removals = Vec::new();

        enforce_provider_loopback_child_env(Some("p1"), &mut env, &mut removals);

        for key in [
            "http_proxy",
            "https_proxy",
            "all_proxy",
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "ALL_PROXY",
        ] {
            assert!(!env.contains_key(key));
            assert!(removals.iter().any(|candidate| candidate == key));
        }
        assert_eq!(env.get("KEEP_ME").map(String::as_str), Some("yes"));
        assert_eq!(
            env.get("no_proxy").map(String::as_str),
            Some("127.0.0.1,localhost,::1")
        );
        assert_eq!(
            env.get("NO_PROXY").map(String::as_str),
            Some("127.0.0.1,localhost,::1")
        );

        let mut native_env = HashMap::from([(
            "HTTPS_PROXY".to_string(),
            "http://127.0.0.1:7890".to_string(),
        )]);
        let mut native_removals = Vec::new();
        enforce_provider_loopback_child_env(None, &mut native_env, &mut native_removals);
        assert!(native_env.contains_key("HTTPS_PROXY"));
        assert!(native_removals.is_empty());
    }

    #[test]
    fn env_log_redacts_secrets_but_keeps_routing_context() {
        let env = HashMap::from([
            ("ANTHROPIC_API_KEY".to_string(), "sk-real".to_string()),
            (
                "ANTHROPIC_BASE_URL".to_string(),
                "https://api.example.com".to_string(),
            ),
            (
                "https_proxy".to_string(),
                "http://user:pass@127.0.0.1:7890".to_string(),
            ),
        ]);
        let redacted = redacted_env_for_log(&env);
        assert_eq!(
            redacted.get("ANTHROPIC_API_KEY").map(String::as_str),
            Some("[REDACTED]")
        );
        assert_eq!(
            redacted.get("https_proxy").map(String::as_str),
            Some("[REDACTED]")
        );
        assert_eq!(
            redacted.get("ANTHROPIC_BASE_URL").map(String::as_str),
            Some("https://api.example.com")
        );
    }
}

#[cfg(test)]
mod local_provider_credential_tests {
    use super::{
        normalize_provider_defaults, sanitized_providers, write_providers_file, ProvidersFile,
    };

    fn legacy_fixture() -> ProvidersFile {
        serde_json::from_value(serde_json::json!({
            "version": 1,
            "activeProviderId": "relay",
            "providers": [{
                "id": "relay",
                "name": "Relay",
                "baseUrl": "https://relay.invalid",
                "apiFormat": "anthropic",
                "apiKey": "sk-synthetic-1234",
                "modelMappings": [{ "tier": "haiku", "providerModel": "relay-haiku" }],
                "createdAt": 1,
                "updatedAt": 2
            }]
        }))
        .unwrap()
    }

    #[test]
    fn legacy_provider_files_do_not_guess_system_defaults_from_the_active_conversation() {
        let fixture = legacy_fixture();
        assert_eq!(fixture.active_provider_id.as_deref(), Some("relay"));
        assert!(fixture.default_api.is_none());
        assert!(fixture.default_main_model.is_none());
        assert!(fixture.default_auxiliary_model.is_none());
    }

    #[test]
    fn retired_system_login_defaults_load_as_unconfigured() {
        let mut fixture = legacy_fixture();
        fixture.default_api = Some("system".to_string());
        let normalized = normalize_provider_defaults(fixture);
        assert!(normalized.default_api.is_none());
    }

    #[test]
    fn local_plaintext_is_never_returned_to_the_frontend() {
        let sanitized = sanitized_providers(legacy_fixture());
        let provider = &sanitized.providers[0];
        assert!(provider.api_key.is_none());
        assert_eq!(provider.credential_state, "local_file");
        assert_eq!(provider.credential_hint.as_deref(), Some("•••• 1234"));
        let json = serde_json::to_string(&sanitized).unwrap();
        assert!(!json.contains("sk-synthetic"));
        assert!(!json.contains("apiKey"));
    }

    #[test]
    fn legacy_secrets_in_extra_env_are_also_hidden_from_the_frontend() {
        let mut fixture = legacy_fixture();
        let provider = &mut fixture.providers[0];
        provider.api_key = None;
        provider.extra_env = Some(std::collections::HashMap::from([
            (
                "OPENAI_API_KEY".to_string(),
                "sk-env-synthetic-5678".to_string(),
            ),
            ("API_TIMEOUT_MS".to_string(), "300000".to_string()),
        ]));
        let sanitized = sanitized_providers(fixture);
        let provider = &sanitized.providers[0];
        assert_eq!(provider.credential_state, "local_file");
        assert_eq!(provider.credential_hint.as_deref(), Some("•••• 5678"));
        let extra = provider.extra_env.as_ref().unwrap();
        assert!(!extra.contains_key("OPENAI_API_KEY"));
        assert_eq!(
            extra.get("API_TIMEOUT_MS").map(String::as_str),
            Some("300000")
        );
        assert!(!serde_json::to_string(&sanitized)
            .unwrap()
            .contains("sk-env-synthetic"));
        let value = serde_json::to_value(&sanitized).unwrap();
        assert_eq!(
            value.pointer("/providers/0/extraEnv/API_TIMEOUT_MS"),
            Some(&serde_json::json!("300000"))
        );
        assert!(value.pointer("/providers/0/extra_env").is_none());
    }

    #[test]
    fn schema_v3_persists_the_key_locally_with_owner_only_permissions() {
        let mut fixture = legacy_fixture();
        fixture.version = 3;
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("providers.json");
        write_providers_file(&path, &fixture).unwrap();
        let json = std::fs::read_to_string(&path).unwrap();
        assert!(json.contains("\"apiKey\""));
        assert!(json.contains("sk-synthetic-1234"));
        assert!(!json.contains("credentialRef"));

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }
}

/// Find the JSONL file for a given session UUID inside Black Box's private
/// Claude state root.
/// Returns the path if found, None otherwise.
/// Validates that session_id looks like a UUID to prevent path traversal.
fn find_session_jsonl(session_id: &str) -> Option<std::path::PathBuf> {
    // Reject non-UUID session IDs to prevent path traversal (e.g. "../../../etc/passwd")
    if uuid::Uuid::parse_str(session_id).is_err() {
        eprintln!(
            "[BLACKBOX] find_session_jsonl: rejecting non-UUID session_id: {}",
            session_id
        );
        return None;
    }

    let claude_projects = client_runtime::claude_config_dir().ok()?.join("projects");
    if !claude_projects.exists() {
        return None;
    }

    let target_filename = format!("{}.jsonl", session_id);
    if let Ok(entries) = std::fs::read_dir(&claude_projects) {
        for entry in entries.flatten() {
            if entry.path().is_dir() {
                let candidate = entry.path().join(&target_filename);
                if candidate.exists() {
                    return Some(candidate);
                }
            }
        }
    }
    None
}

/// Strip thinking and redacted_thinking blocks from a session's JSONL file.
/// This is used before resuming a session with a different model, because the
/// new model cannot verify the old model's cryptographic thinking signatures
/// and will reject the request with a 400 error.
///
/// Returns Ok(blocks_stripped) on success, or Err with a description on failure.
/// The caller should NOT block the session resume on failure — let the auto-retry
/// path handle it as a safety net.
fn strip_thinking_blocks_from_session(session_id: &str) -> Result<usize, String> {
    use std::io::{BufRead, Write};

    let jsonl_path = find_session_jsonl(session_id)
        .ok_or_else(|| format!("Session JSONL not found for id: {}", session_id))?;

    eprintln!(
        "[BLACKBOX] strip_thinking_blocks: processing {:?}",
        jsonl_path
    );

    // Read all lines
    let file =
        std::fs::File::open(&jsonl_path).map_err(|e| format!("Failed to open JSONL: {}", e))?;
    let reader = std::io::BufReader::new(file);
    let lines: Vec<String> = reader
        .lines()
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("Failed to read JSONL: {}", e))?;

    let mut total_stripped = 0usize;
    let mut modified_lines = Vec::with_capacity(lines.len());

    for line in lines {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            modified_lines.push(line);
            continue;
        }

        match serde_json::from_str::<serde_json::Value>(trimmed) {
            Ok(mut json_line) => {
                // Look for assistant messages with content arrays.
                // Format: {"type":"assistant","message":{"role":"assistant","content":[...]}}
                // Thinking blocks only appear at this level — tool_result content arrays
                // contain tool output, not model thinking.
                if let Some(stripped) = strip_thinking_from_value(&mut json_line) {
                    total_stripped += stripped;
                }
                modified_lines.push(serde_json::to_string(&json_line).unwrap_or(line));
            }
            Err(_) => {
                // Not valid JSON — keep the line as-is
                modified_lines.push(line);
            }
        }
    }

    if total_stripped > 0 {
        // Backup the original file before overwriting
        let backup_path = jsonl_path.with_extension("jsonl.bak");
        if let Err(e) = std::fs::copy(&jsonl_path, &backup_path) {
            eprintln!(
                "[BLACKBOX] strip_thinking_blocks: backup failed ({}) — proceeding anyway",
                e
            );
        }

        // Write the cleaned JSONL via temp file + platform-specific replace.
        let tmp_path = jsonl_path.with_extension("jsonl.tmp");
        let mut tmp_file = std::fs::File::create(&tmp_path)
            .map_err(|e| format!("Failed to create temp file: {}", e))?;
        for line in &modified_lines {
            writeln!(tmp_file, "{}", line)
                .map_err(|e| format!("Failed to write temp file: {}", e))?;
        }
        tmp_file
            .flush()
            .map_err(|e| format!("Failed to flush temp file: {}", e))?;
        // Drop the file handle before rename — on Windows, an open handle
        // can prevent rename from succeeding.
        drop(tmp_file);

        // On Unix, rename() atomically replaces the target — no data loss window.
        // On Windows, rename() cannot overwrite an existing file, so we use a
        // two-step approach with rollback from backup on failure.
        #[cfg(not(target_os = "windows"))]
        {
            std::fs::rename(&tmp_path, &jsonl_path)
                .map_err(|e| format!("Failed to rename temp file: {}", e))?;
        }
        #[cfg(target_os = "windows")]
        {
            let replace_result = (|| -> std::io::Result<()> {
                // Try std::fs::rename first — works if target doesn't exist
                if std::fs::rename(&tmp_path, &jsonl_path).is_ok() {
                    return Ok(());
                }
                // Fallback: backup old file, rename new, rollback on failure
                let win_backup = jsonl_path.with_extension("jsonl.wbak");
                let _ = std::fs::remove_file(&win_backup);
                std::fs::rename(&jsonl_path, &win_backup)?;
                if let Err(e) = std::fs::rename(&tmp_path, &jsonl_path) {
                    // Rollback: restore original file
                    let _ = std::fs::rename(&win_backup, &jsonl_path);
                    return Err(e);
                }
                let _ = std::fs::remove_file(&win_backup);
                Ok(())
            })();
            replace_result.map_err(|e| format!("Failed to replace JSONL on Windows: {}", e))?;
        }

        eprintln!(
            "[BLACKBOX] strip_thinking_blocks: stripped {} thinking blocks from {:?}",
            total_stripped, jsonl_path
        );
    } else {
        eprintln!(
            "[BLACKBOX] strip_thinking_blocks: no thinking blocks found in {:?}",
            jsonl_path
        );
    }

    Ok(total_stripped)
}

/// Strip thinking/redacted_thinking content blocks from a JSON value's message.content array.
/// Returns the number of blocks stripped, or None if nothing was modified.
fn strip_thinking_from_value(value: &mut serde_json::Value) -> Option<usize> {
    let mut stripped = 0usize;

    // Look for message.content array (assistant messages)
    if let Some(message) = value.get_mut("message") {
        if let Some(content) = message.get_mut("content") {
            if let Some(arr) = content.as_array_mut() {
                let before_len = arr.len();
                arr.retain(|item| {
                    item.get("type")
                        .and_then(|t| t.as_str())
                        .map_or(true, |t| t != "thinking" && t != "redacted_thinking")
                });
                stripped += before_len - arr.len();
            }
        }
    }

    if stripped > 0 {
        Some(stripped)
    } else {
        None
    }
}

/// Phase 4 §5.4 (S10): write a per-session MCP config scratch file so the
/// CLI's `--strict-mcp-config` doesn't strip the user's configured servers.
///
/// Resolves user/local/approved-project MCP definitions for the current project
/// and writes the effective set into `~/.blackbox/mcp-session-<stdin_id>.json`.
/// Returns `None` when there are no approved servers to carry over (or on I/O error).
pub(crate) fn build_mcp_scratch_config(
    stdin_id: &str,
    cwd: &std::path::Path,
) -> Option<std::path::PathBuf> {
    let home = dirs::home_dir()?;
    let servers = mcp_manager::effective_mcp_servers(cwd).unwrap_or_default();
    if servers.is_empty() {
        return None;
    }
    let dir = home.join(".blackbox");
    if std::fs::create_dir_all(&dir).is_err() {
        return None;
    }
    let path = dir.join(format!(
        "mcp-session-{}.json",
        safe_stdin_for_path(stdin_id)
    ));
    let payload = serde_json::json!({ "mcpServers": servers });
    std::fs::write(&path, serde_json::to_string_pretty(&payload).ok()?).ok()?;
    Some(path)
}

fn safe_stdin_for_path(id: &str) -> String {
    id.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

/// Remove the per-session MCP scratch file written by `build_mcp_scratch_config`.
/// Called after the CLI process exits so `~/.blackbox/` doesn't accumulate
/// stale files across sessions.
pub(crate) fn cleanup_mcp_scratch_config(stdin_id: &str) {
    if let Some(home) = dirs::home_dir() {
        let path = home.join(".blackbox").join(format!(
            "mcp-session-{}.json",
            safe_stdin_for_path(stdin_id)
        ));
        let _ = std::fs::remove_file(&path);
    }
}

pub fn run_auxiliary_model_hook(model: String) -> Result<(), String> {
    auxiliary_model_hook::run(model)
}

pub fn run_time_context_hook() -> Result<(), String> {
    time_context_hook::run()
}

pub fn run_identity_bootstrap_hook() -> Result<(), String> {
    identity_bootstrap::run()
}

pub(crate) fn native_agent_model_tier(raw: &str) -> Result<String, String> {
    let normalized = raw.trim().to_ascii_lowercase();
    let tier = match normalized.as_str() {
        "haiku" => "haiku",
        "sonnet" => "sonnet",
        "opus" => "opus",
        "fable" => "fable",
        _ if normalized.contains("haiku") => "haiku",
        _ if normalized.contains("sonnet") => "sonnet",
        _ if normalized.contains("opus") => "opus",
        _ if normalized.contains("fable") => "fable",
        _ => return Err(
            "Auxiliary model must resolve to the native Agent tier haiku, sonnet, opus, or fable"
                .to_string(),
        ),
    };
    Ok(tier.to_string())
}

pub(crate) fn resolve_auxiliary_model_tier(
    explicit_tier: Option<&str>,
    resolved_model: &str,
) -> Result<String, String> {
    match explicit_tier {
        Some(tier) => native_agent_model_tier(tier),
        None => native_agent_model_tier(resolved_model),
    }
}

pub(crate) fn apply_provider_model_aliases(
    provider_id: Option<&str>,
    env: &mut HashMap<String, String>,
) -> Result<(), String> {
    let Some(provider_id) = provider_id else {
        return Ok(());
    };
    let providers = read_providers_file()?;
    let provider = providers
        .providers
        .iter()
        .find(|provider| provider.id == provider_id)
        .ok_or_else(|| format!("Provider '{provider_id}' not found"))?;
    for mapping in &provider.model_mappings {
        let Ok(tier) = native_agent_model_tier(&mapping.tier) else {
            continue;
        };
        let variable = match tier.as_str() {
            "haiku" => "ANTHROPIC_DEFAULT_HAIKU_MODEL",
            "sonnet" => "ANTHROPIC_DEFAULT_SONNET_MODEL",
            "opus" => "ANTHROPIC_DEFAULT_OPUS_MODEL",
            "fable" => "ANTHROPIC_DEFAULT_FABLE_MODEL",
            _ => unreachable!(),
        };
        let model = mapping.provider_model.trim();
        if !model.is_empty() {
            env.insert(variable.to_string(), model.to_string());
        }
    }
    Ok(())
}

pub(crate) fn auxiliary_model_hook_settings(
    auxiliary_model_tier: &str,
) -> Result<serde_json::Value, String> {
    let model = native_agent_model_tier(auxiliary_model_tier)?;
    let current_exe = std::env::current_exe().map_err(|error| {
        format!("Cannot resolve Black Box executable for model routing: {error}")
    })?;
    let use_system_hooks = client_runtime::uses_system_environment()?;
    let hooks = if use_system_hooks {
        read_system_claude_hooks()?
    } else {
        serde_json::Map::new()
    };
    build_auxiliary_model_hook_settings(&model, &current_exe, hooks, !use_system_hooks)
}

fn read_system_claude_hooks() -> Result<serde_json::Map<String, serde_json::Value>, String> {
    let path = client_runtime::claude_config_dir()?.join("settings.json");
    if !path.is_file() {
        return Ok(serde_json::Map::new());
    }
    let settings: serde_json::Value = serde_json::from_slice(
        &std::fs::read(&path)
            .map_err(|error| format!("Cannot read system Claude settings: {error}"))?,
    )
    .map_err(|error| format!("Cannot parse system Claude settings: {error}"))?;
    let Some(hooks) = settings.get("hooks") else {
        return Ok(serde_json::Map::new());
    };
    hooks
        .as_object()
        .cloned()
        .ok_or_else(|| "System Claude settings hooks must be an object".to_string())
}

fn append_runtime_hook(
    hooks: &mut serde_json::Map<String, serde_json::Value>,
    event: &str,
    definition: serde_json::Value,
) -> Result<(), String> {
    let entries = hooks
        .entry(event.to_string())
        .or_insert_with(|| serde_json::Value::Array(Vec::new()))
        .as_array_mut()
        .ok_or_else(|| format!("Claude hook event {event} must be an array"))?;
    entries.push(definition);
    Ok(())
}

fn build_auxiliary_model_hook_settings(
    model: &str,
    current_exe: &std::path::Path,
    mut hooks: serde_json::Map<String, serde_json::Value>,
    include_private_runtime_hooks: bool,
) -> Result<serde_json::Value, String> {
    append_runtime_hook(
        &mut hooks,
        "PreToolUse",
        serde_json::json!({
            "matcher": "Agent",
            "hooks": [{
                "type": "command",
                "command": current_exe.to_string_lossy(),
                "args": ["--auxiliary-model-hook", model],
                "timeout": 10
            }]
        }),
    )?;
    if include_private_runtime_hooks {
        append_runtime_hook(
            &mut hooks,
            "UserPromptSubmit",
            serde_json::json!({
                "matcher": "",
                "hooks": [{
                    "type": "command",
                    "command": current_exe.to_string_lossy(),
                    "args": ["--time-context-hook"],
                    "timeout": 5
                }]
            }),
        )?;
        append_runtime_hook(
            &mut hooks,
            "SessionStart",
            serde_json::json!({
                "matcher": "startup|resume|clear|compact|fork",
                "hooks": [{
                    "type": "command",
                    "command": current_exe.to_string_lossy(),
                    "args": ["--identity-bootstrap-hook"],
                    "timeout": 10
                }]
            }),
        )?;
    }
    Ok(serde_json::json!({ "hooks": hooks }))
}

#[cfg(test)]
mod native_hook_merge_tests {
    use super::*;

    #[test]
    fn system_hooks_are_preserved_without_private_hook_replacements() {
        let mut hooks = serde_json::Map::new();
        hooks.insert(
            "SessionStart".to_string(),
            serde_json::json!([{
                "matcher": "startup|resume|clear|compact|fork",
                "hooks": [{"type": "command", "command": "native-identity"}]
            }]),
        );
        hooks.insert(
            "UserPromptSubmit".to_string(),
            serde_json::json!([{
                "matcher": "",
                "hooks": [{"type": "command", "command": "native-time"}]
            }]),
        );

        let settings = build_auxiliary_model_hook_settings(
            "sonnet",
            std::path::Path::new("/Applications/Black Box.app/blackbox"),
            hooks,
            false,
        )
        .unwrap();
        let encoded = settings.to_string();

        assert!(encoded.contains("native-identity"));
        assert!(encoded.contains("native-time"));
        assert!(encoded.contains("--auxiliary-model-hook"));
        assert!(!encoded.contains("--identity-bootstrap-hook"));
        assert!(!encoded.contains("--time-context-hook"));
    }

    #[test]
    fn isolated_runtime_registers_its_private_identity_and_time_hooks() {
        let settings = build_auxiliary_model_hook_settings(
            "haiku",
            std::path::Path::new("/Applications/Black Box.app/blackbox"),
            serde_json::Map::new(),
            true,
        )
        .unwrap();
        let encoded = settings.to_string();

        assert!(encoded.contains("--auxiliary-model-hook"));
        assert!(encoded.contains("--identity-bootstrap-hook"));
        assert!(encoded.contains("--time-context-hook"));
        assert!(encoded.contains("startup|resume|clear|compact|fork"));
    }
}

#[tauri::command]
async fn get_identity_bootstrap_status(
) -> Result<identity_bootstrap::IdentityBootstrapStatus, String> {
    identity_bootstrap::status()
}

#[tauri::command]
async fn configure_identity_bootstrap(
    source_files: Vec<String>,
    startup_skill: Option<String>,
    startup_skill_source: Option<String>,
) -> Result<identity_bootstrap::IdentityBootstrapStatus, String> {
    identity_bootstrap::configure(source_files, startup_skill, startup_skill_source)
}

#[tauri::command]
async fn set_identity_bootstrap_enabled(
    enabled: bool,
) -> Result<identity_bootstrap::IdentityBootstrapStatus, String> {
    identity_bootstrap::set_enabled(enabled)
}

#[tauri::command]
async fn start_claude_session(
    app: AppHandle,
    state: State<'_, ProcessManager>,
    stdin_mgr: State<'_, StdinManager>,
    bypass_modes: State<'_, BypassModeMap>,
    path_access: State<'_, PathAccessManager>,
    cli_maintenance: State<'_, CliMaintenanceState>,
    params: StartSessionParams,
) -> Result<SessionInfo, String> {
    // Hold a read lease until this spawn is either committed or rolled back.
    // The updater takes the write lease, so it cannot pass its final blocker
    // check while a new child is still entering ProcessManager.
    let _spawn_lease = cli_maintenance
        .gate
        .try_read()
        .map_err(|_| "CLI_UPDATE_IN_PROGRESS".to_string())?;
    let auxiliary_model = params
        .auxiliary_model
        .as_deref()
        .map(normalize_cli_model_id)
        .filter(|model| !model.trim().is_empty())
        .ok_or_else(|| "A resolved auxiliary model is required for subagents".to_string())?;
    let auxiliary_model_tier =
        resolve_auxiliary_model_tier(params.auxiliary_model_tier.as_deref(), &auxiliary_model)?;
    let session_id = params
        .session_id
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let fork_session = params.fork_session.unwrap_or(false);
    let canonical_resume_session_id = params
        .resume_session_id
        .as_deref()
        .map(|raw| {
            uuid::Uuid::parse_str(raw)
                .map(|value| value.to_string())
                .map_err(|_| format!("INVALID_CLI_SESSION_ID: cli_session_id={raw}"))
        })
        .transpose()?;
    if fork_session && canonical_resume_session_id.is_none() {
        return Err("Fork session requires a source resume_session_id".to_string());
    }
    // Pin the Claude session UUID up front. Besides making new-session identity
    // deterministic, this exposes a stable target to the bundled scheduling
    // skill so a heartbeat can return to the current conversation.
    let cli_session_id = if fork_session {
        uuid::Uuid::new_v4().to_string()
    } else {
        canonical_resume_session_id
            .clone()
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string())
    };

    // Reserve both desk-side routing identity and the canonical Claude UUID in
    // one atomic critical section before any child is spawned. The guard drops
    // both claims automatically on every pre-commit error path.
    let session_reservation = state.reserve_session(&session_id, &cli_session_id)?;

    // Phase 3 §3.1: publish process ownership before the first await in this
    // command. Reload/native-close orphan scans must see the pending claim even
    // while the cwd is being registered or the child is still being prepared.
    path_access
        .register_cwd(std::path::Path::new(&params.cwd))
        .await;

    // Use Claude Code's supported SDK/headless transport: print mode plus
    // bidirectional stream-json. With streaming stdin, --print remains alive
    // across turns until Black Box closes the pipe.
    let mut args = vec![
        "--print".to_string(),
        "--input-format".to_string(),
        "stream-json".to_string(),
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--verbose".to_string(),
        "--include-partial-messages".to_string(),
        "--replay-user-messages".to_string(),
        // Skip global MCP servers from ~/.claude.json to avoid slow cold start.
        // MCP servers (chrome-devtools, codex, gemini, pencil etc.) add 20-30s startup
        // overhead as each must initialize before the CLI accepts input.
        // Phase 4 §5.4 (S10): pair with a per-session scratch config so the
        // user's configured servers remain available (see below).
        "--strict-mcp-config".to_string(),
    ];

    // Phase 4 §5.4 (S10): build a per-session MCP scratch config file.
    // The CLI is spawned with --strict-mcp-config to exclude global MCP
    // servers from ~/.claude.json (they'd slow cold start by 20-30 seconds).
    // BUT users also need their explicitly-configured MCP servers available
    // inside the session. Solution: write the mcpServers block from
    // ~/.claude.json into a scratch file at ~/.blackbox/mcp-session-<id>.json
    // and pass it via --mcp-config. Cleaned up on process exit.
    let mcp_scratch_path = build_mcp_scratch_config(&session_id, std::path::Path::new(&params.cwd));
    if let Some(ref scratch) = mcp_scratch_path {
        args.push("--mcp-config".to_string());
        args.push(scratch.to_string_lossy().to_string());
        eprintln!(
            "[BLACKBOX] MCP scratch config for {}: {:?}",
            session_id, scratch
        );
    }

    // Model switch: strip thinking blocks from the session JSONL before resuming.
    // When switching models, the old model's cryptographic thinking signatures in the
    // JSONL cause the new model to reject the request (400 error). Stripping them
    // preserves the conversation text while removing the invalid signatures.
    // This is best-effort: failure is logged but does NOT block the resume attempt.
    // If the provider still rejects the signature, the frontend fails closed
    // and preserves this resume target instead of opening a fresh thread.
    if params.model_switch.unwrap_or(false) && !fork_session {
        if let Some(ref resume_id) = canonical_resume_session_id {
            match strip_thinking_blocks_from_session(resume_id) {
                Ok(n) => eprintln!("[BLACKBOX] model_switch: stripped {} thinking blocks before resume", n),
                Err(e) => eprintln!("[BLACKBOX] model_switch: thinking-block strip failed ({}), attempting resume anyway", e),
            }
        }
    }

    // Resume an existing CLI session if requested
    if let Some(ref resume_id) = canonical_resume_session_id {
        args.push("--resume".to_string());
        args.push(resume_id.clone());
        if fork_session {
            args.push("--fork-session".to_string());
            args.push("--session-id".to_string());
            args.push(cli_session_id.clone());
        }
    } else {
        args.push("--session-id".to_string());
        args.push(cli_session_id.clone());
    }

    if let Some(ref model) = params.model {
        args.push("--model".to_string());
        args.push(normalize_cli_model_id(model));
    }

    if let Some(ref tools) = params.allowed_tools {
        for tool in tools {
            args.push("--allowedTools".to_string());
            args.push(tool.clone());
        }
    }
    // Permission mode: all modes use --permission-prompt-tool stdio so the CLI
    // routes user interactions (AskUserQuestion, ExitPlanMode) via control_request.
    // In bypassPermissions mode the CLI auto-approves tool permissions internally
    // (zero overhead) but still sends control_requests for user interactions.
    let permission_mode = params.permission_mode.as_deref().unwrap_or("manual");
    args.push("--permission-mode".to_string());
    args.push(permission_mode.to_string());
    args.push("--permission-prompt-tool".to_string());
    args.push("stdio".to_string());

    // Pin every Agent invocation at the tool boundary as well as through the
    // environment variable below. Named Agent calls are Agent Teams teammates,
    // and their tool input may otherwise override the global subagent default.
    let thinking_level = params.thinking_level.as_deref().unwrap_or("high");
    let mut runtime_settings = auxiliary_model_hook_settings(&auxiliary_model_tier)?;
    runtime_settings["alwaysThinkingEnabled"] = serde_json::Value::Bool(thinking_level != "off");
    args.push("--settings".to_string());
    args.push(runtime_settings.to_string());

    // Resolve and health-check one exact CLI as this session's SDK execution
    // kernel. A selected runtime is fail-closed, so a broken pin can never send
    // a resumed or new conversation through an unrelated PATH installation.
    let sdk_runtime = resolve_claude_sdk_runtime()?;
    let claude_bin = sdk_runtime.path.clone();
    if sdk_runtime.capabilities.include_hook_events {
        args.push("--include-hook-events".to_string());
    }
    if sdk_runtime.capabilities.forward_subagent_text {
        args.push("--forward-subagent-text".to_string());
    }

    // Build an enriched PATH for the child process
    let enriched_path = build_enriched_path();

    let agent_teams_enabled = params.agent_teams_enabled.unwrap_or(false);
    if agent_teams_enabled {
        let version = ensure_agent_teams_supported(&claude_bin, &enriched_path).await?;
        args.push("--teammate-mode".to_string());
        // Black Box owns one embedded WebView, so split-pane terminal modes are
        // neither visible nor controllable. In-process teammates still emit the
        // full stream-json hierarchy that the Agent panel renders.
        args.push("in-process".to_string());
        eprintln!("[BLACKBOX] Agent Teams enabled with Claude Code {version}");
    }

    // Resolve provider environment variables from provider_id.
    // ProviderRuntimeCapabilities keeps native-only env vars separate from
    // partial-message streaming support. Some Anthropic-compatible providers
    // support partial text/thinking deltas even though they are not the native
    // api.anthropic.com endpoint.
    let (mut resolved_env, mut inherited_keys_to_remove, provider_extra_args, provider_caps) =
        resolve_provider_env(params.provider_id.as_deref())?;
    apply_provider_model_aliases(params.provider_id.as_deref(), &mut resolved_env)?;
    let provider_gateway_guard =
        route_provider_through_gateway(params.provider_id.as_deref(), &mut resolved_env).await?;

    // Claude Code applies this environment variable to every Agent/subagent
    // invocation, including ordinary Agent calls when Agent Teams is disabled.
    // Fail-closed validation above prevents silent fallback to the lead model.
    resolved_env.insert(
        "CLAUDE_CODE_SUBAGENT_MODEL".to_string(),
        auxiliary_model_tier.clone(),
    );

    if agent_teams_enabled {
        resolved_env.insert(
            "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS".to_string(),
            "1".to_string(),
        );
        resolved_env.remove("CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS");
        if !inherited_keys_to_remove
            .iter()
            .any(|key| key == "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS")
        {
            inherited_keys_to_remove.push("CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS".to_string());
        }
    }

    // Append provider-specific CLI args (e.g. --setting-sources project,local)
    args.extend(provider_extra_args);

    // Keep partial text/thinking deltas for known-compatible providers; degrade
    // explicitly for unknown providers that may reject the partial-message path.
    if !provider_caps.supports_partial_messages {
        if let Some(idx) = args.iter().position(|a| a == "--include-partial-messages") {
            args.remove(idx);
        }
        eprintln!(
            "[BLACKBOX] partial streaming disabled for provider {:?} (unsupported/unknown capability)",
            params.provider_id
        );
    } else if !provider_caps.is_native_anthropic {
        eprintln!(
            "[BLACKBOX] partial streaming enabled for provider {:?}",
            params.provider_id
        );
    }

    // Apply effort level for non-off thinking levels.
    // Native Claude keeps the existing env path. Anthropic-format API
    // providers use the CLI's public --effort flag so the setting can reach
    // provider-routed sessions without enabling native-only env side effects.
    if thinking_level != "off" && provider_caps.is_native_anthropic {
        resolved_env.insert(
            "CLAUDE_CODE_EFFORT_LEVEL".to_string(),
            thinking_level.to_string(),
        );
    } else if thinking_level != "off" && provider_caps.supports_thinking_effort {
        args.push("--effort".to_string());
        args.push(thinking_level.to_string());
    }

    // Raise the per-turn output token cap from the CLI default (32K) to 64K.
    // NEW-N (v3 §4.3): CLAUDE_CODE_MAX_OUTPUT_TOKENS=64000 confuses some
    // third-party providers (their underlying models cap lower and they
    // reject the request with 400). Keep this Anthropic-native only; users
    // on third-party providers can still override via provider extra_env.
    if provider_caps.is_native_anthropic {
        resolved_env
            .entry("CLAUDE_CODE_MAX_OUTPUT_TOKENS".to_string())
            .or_insert_with(|| "64000".to_string());
    }

    // Enable CLI-managed file checkpoints for every SDK session. Snapshotting
    // is a local Claude Code capability, not an API-endpoint capability: it is
    // needed just as much when Haiku/Sonnet are routed through a compatible
    // relay. Black Box always launches the SDK with --replay-user-messages, so
    // gating this on api.anthropic.com silently made restore_all/restore_code
    // unavailable for the provider configuration most users actually run.
    resolved_env.insert(
        "CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING".to_string(),
        "1".to_string(),
    );

    // For models with a 1M context window (explicit Opus 1M variants such as
    // `claude-opus-4-8[1m]` / `claude-opus-4-6[1m]`, MiMo v2 Pro, etc.), override
    // the auto-compact threshold so Claude Code doesn't compact prematurely. The
    // CLI's internal model map may only know ~200K for some of these models; this
    // env var directly sets the compact window. Standard 200K variants (e.g.
    // `claude-opus-4-8`) deliberately do not match.
    if let Some(model_name) = params.model.as_deref() {
        let m = model_name.to_lowercase();
        let is_1m_model = m.contains("mimo") || m.contains("[1m]") || m.ends_with("-1m");
        if is_1m_model {
            resolved_env.insert(
                "CLAUDE_CODE_AUTO_COMPACT_WINDOW".to_string(),
                "1000000".to_string(),
            );
            eprintln!(
                "[BLACKBOX] Set CLAUDE_CODE_AUTO_COMPACT_WINDOW=1000000 for model {}",
                model_name
            );
        }
    }

    // On Windows, disable MSYS2/Git Bash automatic path conversion.
    // Without this, MSYS2 converts Windows paths (e.g. F:\秀\input\file.xlsx)
    // to Unix-style paths (/f/秀/input/file.xlsx), which breaks file operations
    // especially with non-ASCII (Chinese) characters in paths.
    #[cfg(target_os = "windows")]
    {
        resolved_env
            .entry("MSYS_NO_PATHCONV".to_string())
            .or_insert_with(|| "1".to_string());
        resolved_env
            .entry("MSYS2_ARG_CONV_EXCL".to_string())
            .or_insert_with(|| "*".to_string());
    }

    // On Windows, auto-detect git-bash and inject CLAUDE_CODE_GIT_BASH_PATH
    // so Claude Code CLI can find bash.exe without user manual configuration.
    #[cfg(target_os = "windows")]
    {
        if !resolved_env.contains_key("CLAUDE_CODE_GIT_BASH_PATH") {
            if let Some(bash_path) = find_git_bash() {
                resolved_env.insert("CLAUDE_CODE_GIT_BASH_PATH".to_string(), bash_path);
            } else {
                // git-bash is a hard requirement for Claude Code on Windows.
                // Fail fast with a clear error instead of spawning and getting a silent exit.
                return Err("Claude Code requires Git Bash on Windows.\n\
                     Please reinstall Claude Code via Settings to auto-install Git,\n\
                     or install Git for Windows manually: https://git-scm.com/downloads/win"
                    .to_string());
            }
        }
    }

    // Auto-inject ANTHROPIC_* / CLAUDE_CODE_* env vars from login shell.
    // GUI apps don't inherit shell env, so without this the CLI can't find
    // the user's API key/base URL when using "inherit system config" mode.
    #[cfg(not(target_os = "windows"))]
    if should_inject_login_shell_provider_env(params.provider_id.as_deref()) {
        let anthropic_env = login_shell_anthropic_env();
        for (k, v) in anthropic_env {
            if !resolved_env.contains_key(k) && std::env::var(k).is_err() {
                resolved_env.insert(k.clone(), v.clone());
            }
        }
    }

    // Auto-detect and inject proxy env vars into CLI subprocess.
    // GUI apps launched from Finder/Dock don't inherit shell proxy settings.
    // Detection order: login shell > macOS system proxy > local port probing.
    #[cfg(not(target_os = "windows"))]
    {
        let proxy_env = login_shell_proxy_env();
        for (k, v) in proxy_env {
            if !resolved_env.contains_key(k) && std::env::var(k).is_err() {
                resolved_env.insert(k.clone(), v.clone());
            }
        }
    }

    // If still no proxy env vars, try system proxy + port probing.
    // Skip proxy injection when ANTHROPIC_BASE_URL points to an internal host
    // (company gateway, localhost, private IP) — these don't need a proxy.
    {
        // Determine the effective ANTHROPIC_BASE_URL: provider > shell env > process env.
        let effective_base_url = resolved_env.get("ANTHROPIC_BASE_URL").cloned();
        #[cfg(not(target_os = "windows"))]
        let effective_base_url = effective_base_url.or_else(|| {
            login_shell_anthropic_env()
                .get("ANTHROPIC_BASE_URL")
                .cloned()
        });
        let effective_base_url =
            effective_base_url.or_else(|| std::env::var("ANTHROPIC_BASE_URL").ok());
        // Skip auto proxy when a non-public endpoint is configured.
        // localhost / private IP / corporate TLDs don't need a system proxy.
        // If the user has set a custom ANTHROPIC_BASE_URL at all, we also
        // skip — they know their network better than auto-detection does.
        let has_custom_endpoint = effective_base_url.is_some();
        let is_internal = effective_base_url
            .as_ref()
            .is_some_and(|u| is_internal_host(u));
        let skip_proxy = is_internal || has_custom_endpoint;
        if skip_proxy {
            eprintln!(
                "[BLACKBOX] skipping proxy injection (endpoint: {:?})",
                effective_base_url.as_deref().unwrap_or("")
            );
        }
        let has_proxy = resolved_env.keys().any(|k| {
            let kl = k.to_lowercase();
            kl == "https_proxy" || kl == "http_proxy" || kl == "all_proxy"
        });
        if !has_proxy && !skip_proxy {
            // resolve_proxy_url checks: process env > system proxy > login shell > port probing
            if let Some(url) = resolve_proxy_url() {
                for key in &["https_proxy", "http_proxy", "HTTPS_PROXY", "HTTP_PROXY"] {
                    resolved_env.insert(key.to_string(), url.clone());
                }
                if url.starts_with("socks") {
                    resolved_env.insert("all_proxy".to_string(), url.clone());
                    resolved_env.insert("ALL_PROXY".to_string(), url.clone());
                }
            }
        }
    }

    // An explicit Provider child talks only to Black Box's loopback gateway.
    // Apply this after every login-shell/system proxy discovery path so none
    // of them can re-route 127.0.0.1; the gateway owns the upstream proxy.
    enforce_provider_loopback_child_env(
        params.provider_id.as_deref(),
        &mut resolved_env,
        &mut inherited_keys_to_remove,
    );

    // On Windows, .cmd/.bat files must be launched via cmd /C
    #[cfg(target_os = "windows")]
    let mut child = {
        // Helper: build and spawn a Command for the given binary
        let spawn_win = |bin: &str| {
            let needs_cmd = bin.ends_with(".cmd")
                || bin.ends_with(".bat")
                || (!bin.contains('\\') && !bin.contains('/') && !bin.contains('.'));
            let mut cmd = if needs_cmd {
                let mut c = Command::new("cmd");
                c.arg("/C").arg(bin);
                c
            } else {
                Command::new(bin)
            };
            cmd.args(&args)
                .current_dir(&params.cwd)
                .env("PATH", &enriched_path)
                .env("BLACKBOX_SESSION_ID", &cli_session_id);
            client_runtime::apply_to_tokio_command(&mut cmd).map_err(std::io::Error::other)?;
            for key in MAIN_CLI_NESTED_GUARDS {
                cmd.env_remove(key);
            }
            for key in &inherited_keys_to_remove {
                cmd.env_remove(key);
            }
            for (key, value) in &resolved_env {
                cmd.env(key, value);
            }
            cmd.stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .creation_flags(0x08000000)
                .kill_on_drop(true)
                .spawn()
        };

        match spawn_win(&claude_bin) {
            Ok(c) => c,
            Err(e) if e.raw_os_error() == Some(193) => {
                // Error 193: not a valid Win32 application — binary is corrupt.
                // Delete the exact file that failed (covers both ~/.claude/local/
                // and npm-global paths) and fall back to the next candidate.
                eprintln!("error 193 on '{}', cleaning up and retrying...", claude_bin);
                remove_corrupt_claude_exe(&claude_bin);
                let alt_bin = find_claude_binary().ok_or_else(|| {
                    format!(
                        "Failed to spawn selected SDK runtime '{}': {}; no healthy SDK fallback is available",
                        claude_bin, e
                    )
                })?;
                if alt_bin == claude_bin {
                    return Err(format!(
                        "Failed to spawn claude (tried '{}'): {}",
                        claude_bin, e
                    ));
                }
                eprintln!("Retrying with alternative: {}", alt_bin);
                spawn_win(&alt_bin).map_err(|e2| {
                    format!(
                        "Failed to spawn claude (tried '{}' then '{}'): {}",
                        claude_bin, alt_bin, e2
                    )
                })?
            }
            Err(e) => {
                return Err(format!(
                    "Failed to spawn claude (tried '{}'): {}",
                    claude_bin, e
                ));
            }
        }
    };
    #[cfg(not(target_os = "windows"))]
    let mut child = {
        let spawn_unix = |bin: &str| -> std::io::Result<tokio::process::Child> {
            let mut cmd = Command::new(bin);
            cmd.args(&args)
                .current_dir(&params.cwd)
                .env("PATH", &enriched_path)
                .env("BLACKBOX_SESSION_ID", &cli_session_id);
            client_runtime::apply_to_tokio_command(&mut cmd).map_err(std::io::Error::other)?;
            // Clear every known nested-launch guard so Black Box can be opened
            // from a Claude-hosted parent without the child refusing to start.
            for key in MAIN_CLI_NESTED_GUARDS {
                cmd.env_remove(key);
            }
            // Clear inherited ANTHROPIC_* env vars that conflict with our overrides
            for key in &inherited_keys_to_remove {
                cmd.env_remove(key);
            }
            // Inject custom API provider env vars
            for (key, value) in &resolved_env {
                cmd.env(key, value);
            }
            cmd.stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .kill_on_drop(true)
                .spawn()
        };

        match spawn_unix(&claude_bin) {
            Ok(c) => c,
            Err(e) if e.raw_os_error() == Some(13) => {
                // EACCES
                // Permission denied — attempt to fix execute permission and retry.
                eprintln!(
                    "EACCES on '{}', attempting chmod +x and retrying...",
                    claude_bin
                );
                let path = std::path::Path::new(&claude_bin);
                let fixed = (|| -> Result<(), std::io::Error> {
                    use std::os::unix::fs::PermissionsExt;
                    let metadata = std::fs::metadata(path)?;
                    let mut perms = metadata.permissions();
                    perms.set_mode(perms.mode() | 0o755);
                    std::fs::set_permissions(path, perms)?;
                    Ok(())
                })();
                if let Err(chmod_err) = fixed {
                    eprintln!("chmod +x failed: {}", chmod_err);
                    return Err(format!(
                        "Failed to spawn claude (tried '{}', permission denied, chmod fix also failed: {}): {}",
                        claude_bin, chmod_err, e
                    ));
                }
                eprintln!("chmod +x succeeded, retrying spawn...");
                spawn_unix(&claude_bin).map_err(|e2| {
                    format!(
                        "Failed to spawn claude (tried '{}', retried after chmod +x): {}",
                        claude_bin, e2
                    )
                })?
            }
            Err(e) if e.raw_os_error() == Some(88) || e.raw_os_error() == Some(8) => {
                // ENOEXEC (88 on macOS, 8 on Linux) — Malformed binary.
                // Delete the corrupt binary and try to find an alternative.
                eprintln!(
                    "ENOEXEC on '{}' (malformed binary), cleaning up and retrying...",
                    claude_bin
                );
                if let Some(cli_dir) = cli_download_dir() {
                    let suspect = cli_dir.join("claude");
                    if suspect.exists() {
                        let _ = std::fs::remove_file(&suspect);
                        eprintln!("Removed corrupt binary: {:?}", suspect);
                    }
                }
                let alt_bin = find_claude_binary().ok_or_else(|| {
                    format!(
                        "Failed to spawn selected SDK runtime '{}': {}; no healthy SDK fallback is available",
                        claude_bin, e
                    )
                })?;
                if alt_bin == claude_bin {
                    return Err(format!(
                        "Failed to spawn claude (tried '{}', binary is malformed/corrupt — \
                         please reinstall CLI from Settings): {}",
                        claude_bin, e
                    ));
                }
                eprintln!("Retrying with alternative: {}", alt_bin);
                spawn_unix(&alt_bin).map_err(|e2| {
                    format!(
                        "Failed to spawn claude (tried '{}' then '{}'): {}",
                        claude_bin, alt_bin, e2
                    )
                })?
            }
            Err(e) => {
                return Err(format!(
                    "Failed to spawn claude (tried '{}'): {}",
                    claude_bin, e
                ));
            }
        }
    };

    let pid = child.id().unwrap_or(0);
    eprintln!(
        "[BLACKBOX] SDK runtime spawned: pid={}, bin={}, version={}, permission_mode={}",
        pid, claude_bin, sdk_runtime.version, permission_mode
    );
    eprintln!("[BLACKBOX] args: {:?}", &args);
    eprintln!("[BLACKBOX] PATH: {}", &enriched_path);
    eprintln!(
        "[BLACKBOX] resolved_env: {:?}",
        redacted_env_for_log(&resolved_env)
    );
    eprintln!("[BLACKBOX] cwd: {}", &params.cwd);

    // Capture every pipe before publishing stdin ownership. With kill_on_drop,
    // any capture failure terminates the uncommitted child and the reservation
    // guard releases both identity claims.
    let stdin = child.stdin.take().ok_or("Failed to capture stdin")?;
    let stdout = child.stdout.take().ok_or("Failed to capture stdout")?;
    let stderr = child.stderr.take().ok_or("Failed to capture stderr")?;
    stdin_mgr.insert(session_id.clone(), stdin).await?;

    let sid = session_id.clone();

    // ── Spawn child waiter task — owns the child process ──
    //
    // The waiter task's sole purpose is to **own the child process** and
    // provide a kill channel for kill_session. It does NOT emit process_exit
    // or do any cleanup — those responsibilities belong to the stdout reader,
    // because stdout EOF is naturally time-ordered after all stream messages
    // have been drained, whereas child.wait() can return BEFORE the stdout
    // reader has finished processing the last buffered lines (race!).
    //
    //   1. child.wait() returns naturally → child exited on its own.
    //      stdout will close, stdout_reader will hit EOF, THAT emits
    //      process_exit. The waiter simply ends, silent.
    //   2. kill_rx fires → kill_session was called. We start_kill the child,
    //      wait for reap, then end silently. stdout reader will see EOF.
    let (kill_tx, kill_rx) = tokio::sync::oneshot::channel::<()>();
    {
        let waiter_sid = sid.clone();
        tokio::spawn(async move {
            let mut child = child;
            tokio::select! {
                status = child.wait() => {
                    eprintln!(
                        "[BLACKBOX] child naturally exited for {}: code={:?} (stdout reader will emit process_exit)",
                        waiter_sid,
                        status.as_ref().ok().and_then(|s| s.code())
                    );
                }
                _ = kill_rx => {
                    eprintln!("[BLACKBOX] kill signal received for {} — killing child", waiter_sid);
                    if let Err(e) = child.start_kill() {
                        eprintln!("[BLACKBOX] start_kill failed for {}: {}", waiter_sid, e);
                    }
                    // Wait for child to actually die, then stdout reader will
                    // see EOF and do the ProcessExit + cleanup.
                    let _ = child.wait().await;
                }
            }
        });
    }

    let generation = session_reservation.generation().to_string();
    let (exit_tx, _exit_rx) = tokio::sync::watch::channel(false);
    let managed_process = ManagedProcess {
        session_id: sid.clone(),
        cli_session_id: cli_session_id.clone(),
        generation: generation.clone(),
        pid,
        kill_tx: Some(kill_tx),
        exit_tx,
    };
    if let Err(error) = session_reservation.commit(managed_process).await {
        // Dropping the uncommitted ManagedProcess closes kill_tx, which selects
        // the waiter kill branch. Remove the published stdin handle as well.
        stdin_mgr.remove(&sid).await;
        return Err(error);
    }

    // Spawn stdout reader — streams NDJSON to frontend, intercepts control_request
    let app_clone = app.clone();
    let sid_clone = sid.clone();
    let stdin_clone = stdin_mgr.inner().clone();
    let state_clone = state.inner().clone();
    let stdin_mgr_clone = stdin_mgr.inner().clone();
    let bypass_modes_clone = bypass_modes.inner().clone();
    let bypass_flag = bypass_modes
        .register(&sid, permission_mode == "bypassPermissions")
        .await;
    let bypass_flag_for_reader = bypass_flag.clone();
    tokio::spawn(async move {
        // Keep the per-session loopback gateway alive until stdout reaches
        // authoritative EOF and all child output has been drained.
        let _provider_gateway_guard = provider_gateway_guard;
        let stream_event = format!("claude:stream:{}", sid_clone);
        // Use a large buffer (1MB) to efficiently read large NDJSON lines from Claude CLI.
        // Default 8KB buffer causes thousands of syscalls for large outputs (e.g. 24.8MB PDF),
        // which stalls on Windows pipes. 1MB buffer reduces syscalls by ~125x.
        let reader = BufReader::with_capacity(1024 * 1024, stdout);
        let mut lines = reader.lines();
        let mut line_count: u64 = 0;
        let mut execution_projection = conversation_projection::ExecutionProjection::new(generation.clone());
        let mut emit_fail_count: u32 = 0;
        let spawn_time = std::time::Instant::now();
        loop {
            let line = match lines.next_line().await {
                Ok(Some(line)) => line,
                Ok(None) => break, // normal EOF
                Err(e) => {
                    eprintln!(
                        "[BLACKBOX:CRITICAL] stdout read error after {} lines: {}",
                        line_count, e
                    );
                    break;
                }
            };
            line_count += 1;
            // Log first 10 lines with timing to diagnose startup delay
            if line_count <= 10 {
                eprintln!("[BLACKBOX:stdout] #{} @{}ms", line_count, spawn_time.elapsed().as_millis());
            }
            // Parse every line as a JSON Value first (avoids serde enum pitfalls)
            let mut json = match serde_json::from_str::<Value>(&line) {
                Ok(v) => v,
                Err(_) => continue, // skip non-JSON lines
            };
            if json.get("type").and_then(Value::as_str) == Some("system")
                && json.get("subtype").and_then(Value::as_str) == Some("init")
            {
                let tools = json
                    .get("tools")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>();
                eprintln!(
                    "[BLACKBOX] Claude runtime tool inventory ({}): {}",
                    tools.len(),
                    tools.join(",")
                );
            }

            execution_projection.annotate(&mut json);

            // Newer SDK transports can cancel a pending control request after an
            // interrupt or tool-state transition. Forward the cancellation to the
            // owning tab so stale AskUserQuestion/permission cards expire instead
            // of remaining clickable after the CLI has stopped waiting for them.
            if let Some("control_cancel_request") = json.get("type").and_then(|v| v.as_str()) {
                let request_id = json
                    .get("request_id")
                    .or_else(|| json.get("requestId"))
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string();
                let cancel_payload = serde_json::json!({
                    "type": "blackbox_control_request_cancelled",
                    "request_id": request_id,
                    "reason": json.get("reason").cloned(),
                });
                let _ = emit_to_frontend(&app_clone, &stream_event, cancel_payload);
                continue;
            }

            // Intercept control_request messages for SDK control protocol routing.
            // All modes use --permission-prompt-tool stdio. In bypass mode, we
            // auto-approve tool permissions here (zero frontend overhead) but route
            // user interactions (AskUserQuestion) to the frontend.
            if let Some("control_request") = json.get("type").and_then(|v| v.as_str()) {
                let request_id = json
                    .get("request_id")
                    .or_else(|| json.get("requestId"))
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string();

                if let Some(request) = json.get("request") {
                    let subtype = request
                        .get("subtype")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default();

                    // Bypass mode: auto-approve everything except user interactions.
                    if bypass_flag_for_reader.load(std::sync::atomic::Ordering::Relaxed) {
                        let tool_name = request
                            .get("tool_name")
                            .or_else(|| request.get("toolName"))
                            .and_then(|v| v.as_str())
                            .unwrap_or_default();
                        if tool_name != "AskUserQuestion" {
                            let mut allow = serde_json::json!({ "behavior": "allow" });
                            if subtype == "can_use_tool" {
                                allow["updatedInput"] = request
                                    .get("input")
                                    .cloned()
                                    .unwrap_or(Value::Object(serde_json::Map::new()));
                                if let Some(id) = request
                                    .get("tool_use_id")
                                    .or_else(|| request.get("toolUseId"))
                                    .and_then(|v| v.as_str())
                                {
                                    allow["toolUseID"] = Value::String(id.to_string());
                                }
                            }
                            let resp = serde_json::json!({
                                "type": "control_response",
                                "response": { "subtype": "success", "request_id": request_id, "response": allow }
                            });
                            let _ = stdin_clone.send(&sid_clone, &resp.to_string()).await;
                            continue;
                        }
                        // AskUserQuestion: fall through to frontend routing
                    }

                    match subtype {
                        "can_use_tool" => {
                            let tool_name = request
                                .get("tool_name")
                                .or_else(|| request.get("toolName"))
                                .and_then(|v| v.as_str())
                                .unwrap_or_default()
                                .to_string();
                            let input = request.get("input").cloned().unwrap_or(Value::Null);
                            let description = request
                                .get("description")
                                .and_then(|v| v.as_str())
                                .map(String::from);
                            let tool_use_id = request
                                .get("tool_use_id")
                                .or_else(|| request.get("toolUseId"))
                                .and_then(|v| v.as_str())
                                .map(String::from);
                            // P0-1 (#39): forward parent_tool_use_id and agent_id so the
                            // frontend can compute sub-agent depth. Without these, every
                            // sub-agent permission freezes the main input because
                            // resolveAgentId falls back to "main agent" depth 0.
                            let parent_tool_use_id = request
                                .get("parent_tool_use_id")
                                .or_else(|| request.get("parentToolUseId"))
                                .and_then(|v| v.as_str())
                                .map(String::from);
                            let agent_id = request
                                .get("agent_id")
                                .or_else(|| request.get("agentId"))
                                .and_then(|v| v.as_str())
                                .map(String::from);
                            let permission_suggestions = request
                                .get("permission_suggestions")
                                .or_else(|| request.get("permissionSuggestions"))
                                .cloned();
                            let blocked_path = request
                                .get("blocked_path")
                                .or_else(|| request.get("blockedPath"))
                                .and_then(|v| v.as_str())
                                .map(String::from);
                            let decision_reason = request
                                .get("decision_reason")
                                .or_else(|| request.get("decisionReason"))
                                .and_then(|v| v.as_str())
                                .map(String::from);
                            let decision_reason_type = request
                                .get("decision_reason_type")
                                .or_else(|| request.get("decisionReasonType"))
                                .and_then(|v| v.as_str())
                                .map(String::from);
                            let classifier_approvable = request
                                .get("classifier_approvable")
                                .or_else(|| request.get("classifierApprovable"))
                                .and_then(|v| v.as_bool());
                            let title = request
                                .get("title")
                                .and_then(|v| v.as_str())
                                .map(String::from);
                            let display_name = request
                                .get("display_name")
                                .or_else(|| request.get("displayName"))
                                .and_then(|v| v.as_str())
                                .map(String::from);
                            let requires_user_interaction = request
                                .get("requires_user_interaction")
                                .or_else(|| request.get("requiresUserInteraction"))
                                .and_then(|v| v.as_bool());

                            eprintln!(
                                "[BLACKBOX] permission request: tool={} request_id={} parent_tool_use_id={:?} agent_id={:?}",
                                tool_name, request_id, parent_tool_use_id, agent_id
                            );

                            // Emit as a special stream message (reuses the working stream channel)
                            let perm_payload = serde_json::json!({
                                "type": "blackbox_permission_request",
                                "request_id": request_id,
                                "tool_name": tool_name,
                                "input": input,
                                "description": description,
                                "tool_use_id": tool_use_id,
                                "parent_tool_use_id": parent_tool_use_id,
                                "agent_id": agent_id,
                                "permission_suggestions": permission_suggestions,
                                "blocked_path": blocked_path,
                                "decision_reason": decision_reason,
                                "decision_reason_type": decision_reason_type,
                                "classifier_approvable": classifier_approvable,
                                "title": title,
                                "display_name": display_name,
                                "requires_user_interaction": requires_user_interaction,
                            });
                            let _ = emit_to_frontend(&app_clone, &stream_event, perm_payload);
                            continue; // Don't forward to stream as normal msg
                        }
                        "hook_callback" => {
                            // Auto-allow hook callbacks (BLACKBOX doesn't manage hooks)
                            let auto_resp = serde_json::json!({
                                "type": "control_response",
                                "response": {
                                    "subtype": "success",
                                    "request_id": request_id,
                                    "response": { "behavior": "allow" }
                                }
                            });
                            let _ = stdin_clone.send(&sid_clone, &auto_resp.to_string()).await;
                            continue;
                        }
                        "oauth_token_refresh" => {
                            // Deny oauth_token_refresh — allowing it makes CLI refresh to
                            // an Anthropic OAuth token that overrides the provider's API key.
                            eprintln!("[BLACKBOX] oauth_token_refresh: denying to prevent OAuth override (request_id={})", request_id);
                            let deny_resp = serde_json::json!({
                                "type": "control_response",
                                "response": {
                                    "subtype": "success",
                                    "request_id": request_id,
                                    "response": { "behavior": "deny" }
                                }
                            });
                            let _ = stdin_clone.send(&sid_clone, &deny_resp.to_string()).await;
                            continue;
                        }
                        other => {
                            // Unknown control request subtype — deny by default (P0-4 fix)
                            eprintln!("[BLACKBOX] control_request/{}: denying unknown subtype (request_id={})", other, request_id);
                            let deny_resp = serde_json::json!({
                                "type": "control_response",
                                "response": {
                                    "subtype": "success",
                                    "request_id": request_id,
                                    "response": { "behavior": "deny", "message": format!("Unknown permission type '{}' denied by BLACKBOX", other) }
                                }
                            });
                            let _ = stdin_clone.send(&sid_clone, &deny_resp.to_string()).await;
                            continue;
                        }
                    }
                } else {
                    eprintln!(
                        "[BLACKBOX] control_request missing 'request' field: {}",
                        &line[..line.len().min(200)]
                    );
                    // Auto-allow to avoid blocking CLI
                    let auto_resp = serde_json::json!({
                        "type": "control_response",
                        "response": {
                            "subtype": "success",
                            "request_id": request_id,
                            "response": { "behavior": "allow" }
                        }
                    });
                    let _ = stdin_clone.send(&sid_clone, &auto_resp.to_string()).await;
                    continue;
                }
            }

            // Normal message — forward to frontend stream.
            // For very large messages (e.g. PDF content, large file reads), truncate the
            // content before sending through Tauri IPC to avoid freezing the WebView.
            // Claude CLI already has the full content internally; the frontend only needs
            // a preview for display purposes.
            let json_to_emit = {
                let serialized_len = line.len();
                const MAX_IPC_BYTES: usize = 2 * 1024 * 1024; // 2MB threshold
                if serialized_len > MAX_IPC_BYTES {
                    let mut truncated = json.clone();
                    // Truncate content in tool_result blocks and message content
                    if let Some(content) = truncated.get_mut("content") {
                        truncate_large_content(content, MAX_IPC_BYTES / 2);
                    }
                    if let Some(msg) = truncated.get_mut("message") {
                        if let Some(content) = msg.get_mut("content") {
                            truncate_large_content(content, MAX_IPC_BYTES / 2);
                        }
                    }
                    truncated
                } else {
                    json
                }
            };
            if let Err(e) = emit_to_frontend(&app_clone, &stream_event, json_to_emit) {
                emit_fail_count += 1;
                // Log every 10 failures to avoid flooding stderr when the
                // WebView is unresponsive for a sustained period.
                if emit_fail_count == 1 || emit_fail_count % 10 == 0 {
                    eprintln!(
                        "[BLACKBOX] emit_to_frontend failed (#{emit_fail_count}): {e} — continuing (watchdog will recover user session if needed)"
                    );
                }
                // DO NOT break. Previously we broke after 10 failures, but
                // that caused permanent silent disconnection: subsequent
                // events would never reach the WebView, and the frontend
                // session would stay stuck in 'running' forever. Keep
                // trying — WebView usually recovers quickly, and the
                // frontend watchdog (App.tsx) handles user-facing recovery
                // if the stall persists.
            } else {
                if emit_fail_count > 0 {
                    eprintln!(
                        "[BLACKBOX] emit_to_frontend recovered after {} failures",
                        emit_fail_count
                    );
                }
                emit_fail_count = 0;
            }
        }
        // stdout EOF means the child's write end is closed (child exited,
        // naturally or via kill). This is ALWAYS the authoritative signal
        // for process_exit because it guarantees all buffered stream
        // messages have been drained and emitted before the exit event.
        // The child waiter task only provides a kill proxy; it does NOT
        // emit process_exit, to avoid racing with stdout drain.
        eprintln!(
            "[BLACKBOX] stdout reader reached EOF for {} after {} lines",
            sid_clone, line_count
        );
        // Emit process_exit on the stream channel (primary detection)
        let _ = emit_to_frontend(
            &app_clone,
            &stream_event,
            serde_json::json!({"type": "process_exit"}),
        );
        // Also emit on the dedicated exit channel (backup detection via onSessionExit)
        let _ = emit_to_frontend(
            &app_clone,
            &format!("claude:exit:{}", sid_clone),
            serde_json::json!(null),
        );
        // Notify frontend that session list may have changed
        let _ = emit_to_frontend(&app_clone, "sessions:changed", serde_json::json!(null));

        // Finish per-process cleanup before releasing the CLI UUID claim and
        // publishing confirmed exit to any stop/restart waiter.
        stdin_mgr_clone.drop_entry(&sid_clone).await;
        bypass_modes_clone
            .drop_if_current(&sid_clone, &bypass_flag_for_reader)
            .await;

        // Phase 4 §5.4 (S10): remove the per-session MCP scratch config.
        cleanup_mcp_scratch_config(&sid_clone);
        state_clone.finish_if_current(&sid_clone, &generation).await;
    });

    // Spawn stderr reader
    let app_clone2 = app.clone();
    let sid_clone2 = sid.clone();
    tokio::spawn(async move {
        let reader = BufReader::with_capacity(256 * 1024, stderr);
        let mut lines = reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = emit_to_frontend(
                &app_clone2,
                &format!("claude:stderr:{}", sid_clone2),
                serde_json::json!(line),
            );
        }
    });

    // Send the first message via stdin as NDJSON (skip if prompt is empty — pre-warm mode)
    if !params.prompt.is_empty() {
        let first_msg = serde_json::json!({
            "type": "user",
            "message": {
                "role": "user",
                "content": params.prompt
            }
        });
        if let Err(error) = stdin_mgr.send(&sid, &first_msg.to_string()).await {
            let cleanup = graceful_stop_session_inner(
                state.inner(),
                stdin_mgr.inner(),
                bypass_modes.inner(),
                &sid,
            )
            .await;
            return Err(match cleanup {
                Ok(_) => format!("SESSION_START_FAILED: failed to send first prompt: {error}"),
                Err(stop_error) => format!(
                    "SESSION_START_FAILED: failed to send first prompt: {error}; {stop_error}"
                ),
            });
        }
    }

    // A successful start response must already be discoverable after a
    // WebView reload. Do not leave first-session ownership to a frontend
    // fire-and-forget call that can disappear with the page.
    if let Err(error) = track_managed_session(cli_session_id.clone()).await {
        let cleanup = graceful_stop_session_inner(
            state.inner(),
            stdin_mgr.inner(),
            bypass_modes.inner(),
            &sid,
        )
        .await;
        return Err(match cleanup {
            Ok(_) => format!("SESSION_START_FAILED: failed to track CLI session: {error}"),
            Err(stop_error) => {
                format!("SESSION_START_FAILED: failed to track CLI session: {error}; {stop_error}")
            }
        });
    }

    Ok(SessionInfo {
        stdin_id: sid,
        cli_session_id: Some(cli_session_id),
        pid,
        cli_path: claude_bin.clone(),
        cli_version: sdk_runtime.version,
        sdk_capabilities: sdk_runtime.capabilities,
    })
}

#[tauri::command]
async fn send_stdin(
    stdin_mgr: State<'_, StdinManager>,
    session_id: String,
    message: String,
) -> Result<(), String> {
    // Wrap user text in stream-json NDJSON format
    let json_msg = serde_json::json!({
        "type": "user",
        "message": {
            "role": "user",
            "content": message
        }
    });
    stdin_mgr.send(&session_id, &json_msg.to_string()).await
}

#[tauri::command]
async fn send_raw_stdin(
    stdin_mgr: State<'_, StdinManager>,
    session_id: String,
    message: String,
) -> Result<(), String> {
    stdin_mgr.send(&session_id, &message).await
}

/// Respond to a structured permission request from the SDK control protocol.
/// Called by the frontend when the user approves or denies a tool use.
///
/// IMPORTANT: The SDK always sends `updatedInput` with the original tool input when allowing.
/// CLI internally relies on this field. For deny, only `message` is included.
/// Format mirrors exactly what the SDK constructs (from reverse-engineered source).
fn build_permission_response(
    request_id: String,
    allow: bool,
    message: Option<String>,
    tool_use_id: Option<String>,
    updated_input: Option<Value>,
    updated_permissions: Option<Value>,
) -> Result<Value, String> {
    let mut inner = serde_json::Map::new();
    if allow {
        inner.insert("behavior".into(), Value::String("allow".into()));
        inner.insert(
            "updatedInput".into(),
            updated_input.unwrap_or(Value::Object(serde_json::Map::new())),
        );
        if let Some(updates) = updated_permissions {
            if !updates.is_array() {
                return Err("updatedPermissions must be an array".into());
            }
            inner.insert("updatedPermissions".into(), updates);
        }
    } else {
        inner.insert("behavior".into(), Value::String("deny".into()));
        inner.insert(
            "message".into(),
            Value::String(message.unwrap_or_else(|| "User denied this operation".into())),
        );
    }
    if let Some(tuid) = tool_use_id {
        inner.insert("toolUseID".into(), Value::String(tuid));
    }

    Ok(serde_json::json!({
        "type": "control_response",
        "response": {
            "subtype": "success",
            "request_id": request_id,
            "response": inner,
        }
    }))
}

#[tauri::command]
async fn respond_permission(
    stdin_mgr: State<'_, StdinManager>,
    session_id: String,
    request_id: String,
    allow: bool,
    message: Option<String>,
    tool_use_id: Option<String>,
    updated_input: Option<Value>,
    updated_permissions: Option<Value>,
) -> Result<(), String> {
    let resp = build_permission_response(
        request_id,
        allow,
        message,
        tool_use_id,
        updated_input,
        updated_permissions,
    )?;
    let json_str = resp.to_string();
    stdin_mgr.send(&session_id, &json_str).await
}

#[cfg(test)]
mod permission_response_tests {
    use super::build_permission_response;
    use serde_json::json;

    #[test]
    fn allow_response_echoes_session_permission_updates() {
        let updates = json!([{
            "type": "addRules",
            "rules": [{ "toolName": "Bash", "ruleContent": "git status:*" }],
            "behavior": "allow",
            "destination": "session"
        }]);
        let response = build_permission_response(
            "request-1".into(),
            true,
            None,
            Some("tool-1".into()),
            Some(json!({ "command": "git status" })),
            Some(updates.clone()),
        )
        .expect("valid permission response");

        assert_eq!(
            response["response"]["response"]["updatedPermissions"],
            updates
        );
        assert_eq!(response["response"]["response"]["toolUseID"], "tool-1");
    }

    #[test]
    fn deny_response_never_applies_permission_updates() {
        let response = build_permission_response(
            "request-2".into(),
            false,
            Some("no".into()),
            None,
            None,
            Some(json!([{ "type": "setMode" }])),
        )
        .expect("deny response");

        assert!(response["response"]["response"]
            .get("updatedPermissions")
            .is_none());
        assert_eq!(response["response"]["response"]["message"], "no");
    }

    #[test]
    fn permission_updates_must_be_an_array() {
        let error = build_permission_response(
            "request-3".into(),
            true,
            None,
            None,
            Some(json!({})),
            Some(json!({ "type": "addRules" })),
        )
        .expect_err("non-array updates must be rejected");

        assert_eq!(error, "updatedPermissions must be an array");
    }
}

/// Send a runtime control request to the CLI (set_permission_mode, set_model, interrupt).
#[tauri::command]
async fn send_control_request(
    stdin_mgr: State<'_, StdinManager>,
    bypass_modes: State<'_, BypassModeMap>,
    session_id: String,
    subtype: String,
    payload: Value,
) -> Result<(), String> {
    use protocol::ControlRequest;
    let next_bypass_mode = match subtype.as_str() {
        "set_permission_mode" => Some(
            payload
                .get("mode")
                .and_then(|v| v.as_str())
                .ok_or("Missing 'mode' in payload")?
                == "bypassPermissions",
        ),
        _ => None,
    };
    let req = match subtype.as_str() {
        "interrupt" => ControlRequest::interrupt(),
        "set_permission_mode" => {
            let mode = payload
                .get("mode")
                .and_then(|v| v.as_str())
                .ok_or("Missing 'mode' in payload")?
                .to_string();
            ControlRequest::set_permission_mode(mode)
        }
        "set_model" => {
            let model = payload
                .get("model")
                .and_then(|v| v.as_str())
                .map(normalize_cli_model_id);
            ControlRequest::set_model(model)
        }
        "rewind_files" => {
            let user_message_id = payload
                .get("user_message_id")
                .and_then(|v| v.as_str())
                .ok_or("Missing 'user_message_id' in payload")?
                .to_string();
            ControlRequest::rewind_files(user_message_id)
        }
        other => return Err(format!("Unknown control request subtype: {}", other)),
    };
    let json_str = serde_json::to_string(&req)
        .map_err(|e| format!("Failed to serialize control request: {}", e))?;
    stdin_mgr.send(&session_id, &json_str).await?;
    if let Some(is_bypass) = next_bypass_mode {
        bypass_modes.set_bypass(&session_id, is_bypass).await;
    }
    Ok(())
}

#[tauri::command]
async fn kill_session(
    state: State<'_, ProcessManager>,
    stdin_mgr: State<'_, StdinManager>,
    bypass_modes: State<'_, BypassModeMap>,
    session_id: String,
) -> Result<(), String> {
    kill_session_inner(
        state.inner(),
        stdin_mgr.inner(),
        bypass_modes.inner(),
        &session_id,
        std::time::Duration::from_secs(5),
    )
    .await
}

fn session_stop_timeout_error(state: &ProcessManager, session_id: &str) -> String {
    let cli_session_id = state
        .cli_session_for_stdin(session_id)
        .unwrap_or_else(|| "unknown".to_string());
    format!(
        "SESSION_STOP_TIMEOUT: stdin_id={} cli_session_id={}",
        session_id, cli_session_id
    )
}

async fn wait_for_confirmed_exit(
    receiver: &mut tokio::sync::watch::Receiver<bool>,
    timeout: std::time::Duration,
) -> bool {
    if *receiver.borrow() {
        return true;
    }
    tokio::time::timeout(timeout, async {
        loop {
            if receiver.changed().await.is_err() {
                return *receiver.borrow();
            }
            if *receiver.borrow() {
                return true;
            }
        }
    })
    .await
    .unwrap_or(false)
}

async fn kill_session_inner(
    state: &ProcessManager,
    stdin_mgr: &StdinManager,
    bypass_modes: &BypassModeMap,
    session_id: &str,
    timeout: std::time::Duration,
) -> Result<(), String> {
    stdin_mgr.remove(&session_id).await;
    let Some(mut pending_receiver) = state
        .wait_for_exit_receiver_or_claim_release(session_id, timeout)
        .await
        .map_err(|_| session_stop_timeout_error(state, session_id))?
    else {
        bypass_modes.remove(session_id).await;
        return Ok(());
    };
    let Some(mut exit_receiver) = state.request_kill(session_id).await else {
        if wait_for_confirmed_exit(&mut pending_receiver, timeout).await {
            bypass_modes.remove(session_id).await;
            return Ok(());
        }
        return Err(session_stop_timeout_error(state, session_id));
    };
    if !wait_for_confirmed_exit(&mut exit_receiver, timeout).await {
        return Err(session_stop_timeout_error(state, session_id));
    }
    bypass_modes.remove(session_id).await;
    Ok(())
}

async fn graceful_stop_session_inner(
    state: &ProcessManager,
    stdin_mgr: &StdinManager,
    bypass_modes: &BypassModeMap,
    session_id: &str,
) -> Result<String, String> {
    graceful_stop_session_inner_with_timeouts(
        state,
        stdin_mgr,
        bypass_modes,
        session_id,
        std::time::Duration::from_secs(3),
        std::time::Duration::from_secs(5),
    )
    .await
}

async fn graceful_stop_session_inner_with_timeouts(
    state: &ProcessManager,
    stdin_mgr: &StdinManager,
    bypass_modes: &BypassModeMap,
    session_id: &str,
    graceful_timeout: std::time::Duration,
    kill_timeout: std::time::Duration,
) -> Result<String, String> {
    let Some(mut exit_receiver) = state
        .wait_for_exit_receiver_or_claim_release(session_id, graceful_timeout)
        .await
        .map_err(|_| session_stop_timeout_error(state, session_id))?
    else {
        stdin_mgr.remove(session_id).await;
        bypass_modes.remove(session_id).await;
        return Ok("missing".to_string());
    };

    // EOF first: Claude Code can close its current session cleanly instead of
    // being SIGKILLed immediately after a browser refresh or app close.
    stdin_mgr.remove(session_id).await;
    if wait_for_confirmed_exit(&mut exit_receiver, graceful_timeout).await {
        bypass_modes.remove(session_id).await;
        return Ok("graceful".to_string());
    }

    // EOF did not finish the child. Request a hard kill but retain the process
    // entry and CLI UUID claim until stdout cleanup confirms the exit.
    let _ = state.request_kill(session_id).await;
    if !wait_for_confirmed_exit(&mut exit_receiver, kill_timeout).await {
        return Err(session_stop_timeout_error(state, session_id));
    }
    bypass_modes.remove(session_id).await;
    Ok("killed".to_string())
}

async fn graceful_stop_all_sessions_inner(
    state: &ProcessManager,
    stdin_mgr: &StdinManager,
    bypass_modes: &BypassModeMap,
) -> Vec<String> {
    graceful_stop_all_sessions_inner_with_timeouts(
        state,
        stdin_mgr,
        bypass_modes,
        std::time::Duration::from_secs(3),
        std::time::Duration::from_secs(5),
    )
    .await
}

async fn graceful_stop_all_sessions_inner_with_timeouts(
    state: &ProcessManager,
    stdin_mgr: &StdinManager,
    bypass_modes: &BypassModeMap,
    graceful_timeout: std::time::Duration,
    kill_timeout: std::time::Duration,
) -> Vec<String> {
    let active_ids = state.active_ids().await;
    let stops = active_ids.into_iter().map(|session_id| async move {
        graceful_stop_session_inner_with_timeouts(
            state,
            stdin_mgr,
            bypass_modes,
            &session_id,
            graceful_timeout,
            kill_timeout,
        )
        .await
    });
    futures_util::future::join_all(stops)
        .await
        .into_iter()
        .filter_map(Result::err)
        .collect()
}

/// Close a persistent stream-json process without throwing away the tail of
/// its session. Dropping stdin sends EOF, which lets Claude Code finish its own
/// persistence path. A bounded hard-kill fallback keeps shutdown deterministic
/// when the child does not honor EOF.
#[tauri::command]
async fn graceful_stop_session(
    state: State<'_, ProcessManager>,
    stdin_mgr: State<'_, StdinManager>,
    bypass_modes: State<'_, BypassModeMap>,
    session_id: String,
) -> Result<String, String> {
    graceful_stop_session_inner(
        state.inner(),
        stdin_mgr.inner(),
        bypass_modes.inner(),
        &session_id,
    )
    .await
}

/// TK-329: List all active stdinIds from ProcessManager.
/// Frontend uses this after refresh to detect and clean up orphaned backend processes.
#[tauri::command]
async fn list_active_processes(state: State<'_, ProcessManager>) -> Result<Vec<String>, String> {
    Ok(state.active_ids().await)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CliUpdateBlockers {
    active_session_ids: Vec<String>,
    running_automation: bool,
    maintenance_in_progress: bool,
    maintenance_downloaded: u64,
    maintenance_total: u64,
    maintenance_percent: u64,
    maintenance_phase: String,
}

async fn cli_update_blockers_inner(
    processes: &ProcessManager,
) -> Result<CliUpdateBlockers, String> {
    let (
        maintenance_downloaded,
        maintenance_total,
        maintenance_percent,
        maintenance_phase,
    ) = cli_update_progress_snapshot();
    Ok(CliUpdateBlockers {
        active_session_ids: processes.active_ids().await,
        running_automation: automations::has_running_automation()?,
        maintenance_in_progress: cli_update_in_progress(),
        maintenance_downloaded,
        maintenance_total,
        maintenance_percent,
        maintenance_phase,
    })
}

/// Updating the CLI replaces the executable used by every persistent chat
/// process. Expose the blockers separately so the UI can ask for permission,
/// settle its own session state, and then retry the update without parsing an
/// English error string.
#[tauri::command]
async fn get_cli_update_blockers(
    processes: State<'_, ProcessManager>,
) -> Result<CliUpdateBlockers, String> {
    cli_update_blockers_inner(processes.inner()).await
}

/// Path to the file tracking BLACKBOX-managed session IDs
fn tracked_sessions_path() -> std::path::PathBuf {
    let home = dirs::home_dir().unwrap_or_else(|| std::path::PathBuf::from("."));
    tracked_sessions_path_in(&home)
}

fn tracked_sessions_path_in(home: &std::path::Path) -> std::path::PathBuf {
    home.join(".blackbox").join("tracked_sessions.txt")
}

fn read_json_object(path: &std::path::Path) -> Result<serde_json::Map<String, Value>, String> {
    if !path.exists() {
        return Ok(serde_json::Map::new());
    }
    let metadata = std::fs::metadata(path)
        .map_err(|e| format!("Failed to inspect {}: {e}", path.display()))?;
    if metadata.len() > 1024 * 1024 {
        return Err(format!("{} exceeds the 1 MiB safety limit", path.display()));
    }
    let content = std::fs::read_to_string(path)
        .map_err(|e| format!("Failed to read {}: {e}", path.display()))?;
    let value: Value = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse {}: {e}", path.display()))?;
    value
        .as_object()
        .cloned()
        .ok_or_else(|| format!("{} must contain a JSON object", path.display()))
}

fn atomic_write_bytes(path: &std::path::Path, content: &[u8], label: &str) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("{label} path has no parent directory"))?;
    std::fs::create_dir_all(parent)
        .map_err(|e| format!("Failed to create {label} directory: {e}"))?;
    let mut temp = tempfile::NamedTempFile::new_in(parent)
        .map_err(|e| format!("Failed to create temporary {label} file: {e}"))?;
    use std::io::Write;
    temp.write_all(content)
        .map_err(|e| format!("Failed to write temporary {label} file: {e}"))?;
    temp.as_file()
        .sync_all()
        .map_err(|e| format!("Failed to sync temporary {label} file: {e}"))?;
    temp.persist(path)
        .map_err(|e| format!("Failed to atomically replace {label} file: {}", e.error))?;
    Ok(())
}

fn write_tracked_session_ids(
    home: &std::path::Path,
    session_ids: &std::collections::HashSet<String>,
) -> Result<(), String> {
    let mut sorted: Vec<&str> = session_ids.iter().map(String::as_str).collect();
    sorted.sort_unstable();
    let content = if sorted.is_empty() {
        String::new()
    } else {
        format!("{}\n", sorted.join("\n"))
    };
    atomic_write_bytes(
        &tracked_sessions_path_in(home),
        content.as_bytes(),
        "tracked sessions",
    )
}

fn migrate_legacy_client_sessions() {
    session_metadata::migrate_legacy_client_sessions();
}

/// Load the set of session IDs explicitly managed by Black Box.
///
/// When the tracking ledger is missing, recovery is deliberately fail-closed:
/// only IDs already referenced by Black Box metadata are eligible. The legacy
/// host transcript store may include conversations from other clients and is
/// used solely as a one-time migration source, never as an ownership index.
fn load_tracked_sessions_in(
    home: &std::path::Path,
) -> Result<std::collections::HashSet<String>, String> {
    use std::io::BufRead;
    let path = tracked_sessions_path_in(home);
    let deleted = session_metadata::deleted_session_ids_in(home)?;
    let mut set = std::collections::HashSet::new();
    if let Ok(file) = std::fs::File::open(&path) {
        for line in std::io::BufReader::new(file).lines().flatten() {
            let trimmed = line.trim().to_string();
            if !trimmed.is_empty() && !deleted.contains(&trimmed) {
                set.insert(trimmed);
            }
        }
    }

    // Recover only from Black Box-owned metadata. Never scan shared JSONLs.
    if set.is_empty() {
        set.extend(session_metadata::recoverable_session_ids_in(home)?);
        if !set.is_empty() {
            write_tracked_session_ids(home, &set)?;
            eprintln!(
                "[BLACKBOX] Recovered tracked_sessions.txt from explicit metadata: {} sessions",
                set.len()
            );
        }
    }

    Ok(set)
}

fn load_tracked_sessions() -> std::collections::HashSet<String> {
    dirs::home_dir()
        .and_then(|home| load_tracked_sessions_in(&home).ok())
        .unwrap_or_default()
}

/// Register a CLI session ID as managed by BLACKBOX.
///
/// Keep the reusable implementation separate from the private Tauri command:
/// exporting a command function from this module makes Tauri's generated
/// `__cmd__*` macro collide with its invoke-handler import.
pub(crate) async fn track_managed_session(session_id: String) -> Result<(), String> {
    // Defense-in-depth: never persist desk-generated temporary IDs
    if session_id.starts_with("desk_") {
        return Ok(());
    }
    let path = tracked_sessions_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create .blackbox dir: {}", e))?;
    }
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("Failed to open tracked sessions: {}", e))?;
    writeln!(file, "{}", session_id).map_err(|e| format!("Failed to write session ID: {}", e))?;
    Ok(())
}

#[tauri::command]
async fn track_session(session_id: String) -> Result<(), String> {
    track_managed_session(session_id).await
}

/// One-time cleanup: remove desk_* entries and duplicates from tracked_sessions.txt.
/// Uses atomic write (write to temp file, then rename) to prevent truncation on crash.
fn cleanup_tracked_sessions() {
    let path = tracked_sessions_path();
    if !path.exists() {
        return;
    }
    use std::io::{BufRead, Write};
    let lines: Vec<String> = match std::fs::File::open(&path) {
        Ok(f) => std::io::BufReader::new(f).lines().flatten().collect(),
        Err(_) => return,
    };
    let mut seen = std::collections::HashSet::new();
    let deleted = session_metadata::deleted_session_ids().unwrap_or_default();
    let clean: Vec<&String> = lines
        .iter()
        .filter(|l| {
            let t = l.trim();
            !t.is_empty()
                && !t.starts_with("desk_")
                && !deleted.contains(t)
                && seen.insert(t.to_string())
        })
        .collect();
    if clean.len() < lines.len() {
        // Atomic write: temp file + rename to prevent truncation
        let tmp = path.with_extension("txt.tmp");
        if let Ok(mut f) = std::fs::File::create(&tmp) {
            for line in &clean {
                let _ = writeln!(f, "{}", line.trim());
            }
            let _ = std::fs::rename(&tmp, &path);
        }
    }
}

fn detach_session_in(home: &std::path::Path, session_id: &str) -> Result<(), String> {
    let session_id = session_id.trim();
    if session_id.is_empty() || session_id.starts_with("desk_") {
        return Ok(());
    }

    // Persist the tombstone first. Even if the ownership ledger cannot be
    // rewritten afterwards, the session remains hidden from Black Box.
    session_metadata::tombstone_deleted_session_in(home, session_id)?;

    let track_path = tracked_sessions_path_in(home);
    if !track_path.exists() {
        return Ok(());
    }

    use std::io::BufRead;
    let file = std::fs::File::open(&track_path)
        .map_err(|e| format!("Failed to read tracked sessions: {e}"))?;
    let retained: std::collections::HashSet<String> = std::io::BufReader::new(file)
        .lines()
        .map_while(Result::ok)
        .map(|line| line.trim().to_string())
        .filter(|candidate| {
            !candidate.is_empty() && !candidate.starts_with("desk_") && candidate != session_id
        })
        .collect();
    write_tracked_session_ids(home, &retained)
}

/// Remove a conversation from Black Box while preserving its private transcript
/// for local recovery and export.
#[tauri::command]
async fn delete_session(session_id: String, session_path: String) -> Result<(), String> {
    // Keep the parameter for bridge compatibility. Detaching a conversation
    // removes it from Black Box indexes without destroying its private JSONL.
    let _private_transcript_path = session_path;
    let home = dirs::home_dir().ok_or("Cannot find home dir")?;
    detach_session_in(&home, &session_id)
}

#[cfg(test)]
mod session_ownership_tests {
    use super::*;

    fn create_legacy_host_transcript(
        home: &std::path::Path,
        session_id: &str,
    ) -> std::path::PathBuf {
        let project = home.join(".claude").join("projects").join("workspace");
        std::fs::create_dir_all(&project).unwrap();
        let path = project.join(format!("{session_id}.jsonl"));
        std::fs::write(&path, b"{\"type\":\"user\"}\n").unwrap();
        path
    }

    #[test]
    fn missing_ledger_does_not_adopt_legacy_host_transcripts() {
        let temp = tempfile::tempdir().unwrap();
        create_legacy_host_transcript(temp.path(), "foreign-session");

        let tracked = load_tracked_sessions_in(temp.path()).unwrap();

        assert!(tracked.is_empty());
        assert!(!tracked_sessions_path_in(temp.path()).exists());
    }

    #[test]
    fn missing_ledger_recovers_only_explicit_black_box_metadata() {
        let temp = tempfile::tempdir().unwrap();
        create_legacy_host_transcript(temp.path(), "owned-session");
        create_legacy_host_transcript(temp.path(), "foreign-session");
        let blackbox = temp.path().join(".blackbox");
        std::fs::create_dir_all(&blackbox).unwrap();
        std::fs::write(
            blackbox.join("session_metadata.json"),
            serde_json::to_vec_pretty(&serde_json::json!({
                "version": 2,
                "revision": 1,
                "groups": [],
                "pinnedSessionIds": [],
                "archivedSessionIds": [],
                "customPreviews": { "owned-session": "Owned" },
                "tombstones": {},
                "imports": {}
            }))
            .unwrap(),
        )
        .unwrap();

        let tracked = load_tracked_sessions_in(temp.path()).unwrap();

        assert_eq!(
            tracked,
            std::collections::HashSet::from(["owned-session".to_string()])
        );
        let ledger = std::fs::read_to_string(tracked_sessions_path_in(temp.path())).unwrap();
        assert_eq!(ledger, "owned-session\n");
        assert!(!tracked.contains("foreign-session"));
    }

    #[test]
    fn removing_from_black_box_preserves_private_transcript() {
        let temp = tempfile::tempdir().unwrap();
        let transcript = create_legacy_host_transcript(temp.path(), "owned-session");
        let tracked = std::collections::HashSet::from(["owned-session".to_string()]);
        write_tracked_session_ids(temp.path(), &tracked).unwrap();

        detach_session_in(temp.path(), "owned-session").unwrap();

        assert!(transcript.exists());
        assert!(load_tracked_sessions_in(temp.path()).unwrap().is_empty());
        assert!(session_metadata::deleted_session_ids_in(temp.path())
            .unwrap()
            .contains("owned-session"));
    }
}

/// Return the timestamp of the newest user-visible conversation event.
///
/// Claude may append bookkeeping records such as `last-prompt` after the final
/// message. Those writes change the JSONL mtime without changing conversation
/// activity, so the sidebar must derive its display and sort time from the
/// transcript itself. Scanning backwards keeps this cheap for large sessions.
fn session_activity_timestamp_ms(path: &std::path::Path) -> Option<u64> {
    use std::io::{Read, Seek};

    const BLOCK_SIZE: u64 = 16 * 1024;

    let mut file = std::fs::File::open(path).ok()?;
    let mut cursor = file.metadata().ok()?.len();
    let mut reversed_line = Vec::new();

    while cursor > 0 {
        let block_start = cursor.saturating_sub(BLOCK_SIZE);
        let block_len = usize::try_from(cursor - block_start).ok()?;
        let mut block = vec![0_u8; block_len];
        file.seek(std::io::SeekFrom::Start(block_start)).ok()?;
        file.read_exact(&mut block).ok()?;

        for byte in block.into_iter().rev() {
            if byte == b'\n' {
                if let Some(timestamp) =
                    session_activity_timestamp_from_reversed_line(&mut reversed_line)
                {
                    return Some(timestamp);
                }
            } else if byte != b'\r' {
                reversed_line.push(byte);
            }
        }
        cursor = block_start;
    }

    session_activity_timestamp_from_reversed_line(&mut reversed_line)
}

fn session_activity_timestamp_from_reversed_line(line: &mut Vec<u8>) -> Option<u64> {
    if line.is_empty() {
        return None;
    }

    line.reverse();
    let timestamp = parse_session_activity_timestamp(line);
    line.clear();
    timestamp
}

fn parse_session_activity_timestamp(line: &[u8]) -> Option<u64> {
    let event: Value = serde_json::from_slice(line).ok()?;
    if event.get("isSidechain").and_then(Value::as_bool) == Some(true)
        || event
            .get("sourceToolAssistantUUID")
            .is_some_and(|value| !value.is_null())
    {
        return None;
    }

    let event_type = event.get("type").and_then(Value::as_str);
    let message_role = event
        .get("message")
        .and_then(|message| message.get("role"))
        .and_then(Value::as_str);
    let is_conversation_event = matches!(event_type, Some("user" | "human" | "assistant"))
        || matches!(message_role, Some("user" | "assistant"));
    if !is_conversation_event {
        return None;
    }

    let content = event
        .get("message")
        .and_then(|message| message.get("content"))
        .or_else(|| event.get("content"));
    if !content.is_some_and(session_content_is_user_visible) {
        return None;
    }

    let timestamp = event.get("timestamp")?.as_str()?;
    let timestamp_ms = chrono::DateTime::parse_from_rfc3339(timestamp)
        .ok()?
        .timestamp_millis();
    u64::try_from(timestamp_ms).ok()
}

fn session_content_is_user_visible(content: &Value) -> bool {
    match content {
        Value::String(text) => !text.trim().is_empty(),
        Value::Array(blocks) => blocks.iter().any(|block| match block {
            Value::String(text) => !text.trim().is_empty(),
            Value::Object(object) => match object.get("type").and_then(Value::as_str) {
                Some("text") => object
                    .get("text")
                    .and_then(Value::as_str)
                    .is_some_and(|text| !text.trim().is_empty()),
                Some("image" | "document") => true,
                Some(_) => false,
                None => false,
            },
            _ => false,
        }),
        _ => false,
    }
}

#[cfg(test)]
mod session_activity_timestamp_tests {
    use super::*;

    fn timestamp_ms(timestamp: &str) -> u64 {
        chrono::DateTime::parse_from_rfc3339(timestamp)
            .unwrap()
            .timestamp_millis() as u64
    }

    #[test]
    fn trailing_bookkeeping_and_tool_records_do_not_advance_session_time() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("session.jsonl");
        let events = [
            serde_json::json!({
                "type": "assistant",
                "timestamp": "2026-08-21T17:26:12.912Z",
                "message": { "role": "assistant", "content": [{ "type": "text", "text": "done" }] }
            }),
            serde_json::json!({
                "type": "assistant",
                "timestamp": "2026-08-21T22:30:00.000Z",
                "message": { "role": "assistant", "content": [{ "type": "tool_use", "name": "Read" }] }
            }),
            serde_json::json!({
                "type": "user",
                "timestamp": "2026-08-21T22:30:01.000Z",
                "sourceToolAssistantUUID": "tool-call-id",
                "message": { "role": "user", "content": [{ "type": "tool_result", "content": "ok" }] }
            }),
            serde_json::json!({
                "type": "assistant",
                "timestamp": "2026-08-21T22:30:02.000Z",
                "isSidechain": true,
                "message": { "role": "assistant", "content": [{ "type": "text", "text": "internal" }] }
            }),
            serde_json::json!({
                "type": "last-prompt",
                "lastPrompt": "done"
            }),
        ];
        let jsonl = events
            .into_iter()
            .map(|event| serde_json::to_string(&event).unwrap())
            .collect::<Vec<_>>()
            .join("\n");
        std::fs::write(&path, format!("{jsonl}\n")).unwrap();

        assert_eq!(
            session_activity_timestamp_ms(&path),
            Some(timestamp_ms("2026-08-21T17:26:12.912Z"))
        );
    }

    #[test]
    fn newest_visible_user_event_advances_session_time_across_block_boundaries() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("session.jsonl");
        let long_prompt = "x".repeat(20 * 1024);
        let events = [
            serde_json::json!({
                "type": "assistant",
                "timestamp": "2026-08-21T17:26:12.912Z",
                "message": { "role": "assistant", "content": [{ "type": "text", "text": "done" }] }
            }),
            serde_json::json!({
                "type": "user",
                "timestamp": "2026-08-21T17:27:00.000Z",
                "message": { "role": "user", "content": [{ "type": "text", "text": long_prompt }] }
            }),
        ];
        let jsonl = events
            .into_iter()
            .map(|event| serde_json::to_string(&event).unwrap())
            .collect::<Vec<_>>()
            .join("\n");
        std::fs::write(&path, jsonl).unwrap();

        assert_eq!(
            session_activity_timestamp_ms(&path),
            Some(timestamp_ms("2026-08-21T17:27:00.000Z"))
        );
    }

    #[test]
    fn sessions_without_visible_timestamped_events_use_the_caller_fallback() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("session.jsonl");
        std::fs::write(
            &path,
            "{\"type\":\"last-prompt\",\"lastPrompt\":\"hello\"}\n",
        )
        .unwrap();

        assert_eq!(session_activity_timestamp_ms(&path), None);
    }
}

#[tauri::command]
async fn list_sessions() -> Result<Vec<Value>, String> {
    let claude_dir = client_runtime::claude_config_dir()?.join("projects");

    if !claude_dir.exists() {
        return Ok(vec![]);
    }

    // Only show sessions tracked by BLACKBOX
    let tracked = load_tracked_sessions();

    let mut sessions = vec![];
    if let Ok(entries) = std::fs::read_dir(&claude_dir) {
        for entry in entries.flatten() {
            if entry.path().is_dir() {
                if let Ok(files) = std::fs::read_dir(entry.path()) {
                    for file in files.flatten() {
                        let path = file.path();
                        if path.extension().map_or(false, |e| e == "jsonl") {
                            if let Some(name) = path.file_stem() {
                                let id = name.to_string_lossy().to_string();

                                // Skip sessions not created by BLACKBOX
                                if !tracked.contains(&id) {
                                    continue;
                                }

                                // Use the newest visible conversation event for
                                // sidebar display and ordering. Filesystem mtime
                                // is only a compatibility fallback for malformed
                                // or legacy transcripts without such an event.
                                let modified = session_activity_timestamp_ms(&path)
                                    .or_else(|| {
                                        std::fs::metadata(&path)
                                            .and_then(|metadata| metadata.modified())
                                            .ok()
                                            .and_then(|timestamp| {
                                                timestamp.duration_since(std::time::UNIX_EPOCH).ok()
                                            })
                                            .map(|duration| duration.as_millis() as u64)
                                    })
                                    .unwrap_or(0);

                                // Read first few lines to extract preview and cwd
                                let (preview, cwd) = extract_session_info(&path);

                                // Use cwd from JSONL if available (authoritative),
                                // otherwise fall back to decoding the directory name.
                                let project_dir = entry.file_name().to_string_lossy().to_string();
                                let project_name = task_handoff::current_cwd_override(&id)
                                    .unwrap_or_else(|| {
                                        if cwd.is_empty() {
                                            decode_project_name(&project_dir)
                                        } else {
                                            cwd
                                        }
                                    });

                                sessions.push(serde_json::json!({
                                    "id": id,
                                    // A persisted Claude JSONL filename is the
                                    // authoritative --resume credential.
                                    "cliResumeId": id,
                                    "path": path.to_string_lossy(),
                                    "project": project_name,
                                    "projectDir": project_dir,
                                    "modifiedAt": modified,
                                    "preview": preview,
                                }));
                            }
                        }
                    }
                }
            }
        }
    }

    // Sort by modified time, newest first
    sessions.sort_by(|a, b| {
        let ta = a["modifiedAt"].as_u64().unwrap_or(0);
        let tb = b["modifiedAt"].as_u64().unwrap_or(0);
        tb.cmp(&ta)
    });

    Ok(sessions)
}

#[tauri::command]
fn get_task_location(
    session_id: String,
    current_cwd: String,
) -> Result<task_handoff::TaskLocationStatus, String> {
    task_handoff::get_task_location(session_id, current_cwd)
}

#[tauri::command]
async fn handoff_task(
    state: State<'_, ProcessManager>,
    session_id: String,
    current_cwd: String,
    destination: String,
) -> Result<task_handoff::TaskLocationStatus, String> {
    if state.has_cli_session_id(&session_id).await {
        return Err(
            "Stop the active response before handing this task to another location".to_string(),
        );
    }
    tauri::async_runtime::spawn_blocking(move || {
        task_handoff::handoff_task(session_id, current_cwd, destination)
    })
    .await
    .map_err(|error| format!("Task handoff worker failed: {error}"))?
}

/// Search across tracked session JSONL files for a query string.
/// Returns matching sessions with snippets, sorted by match_count descending (max 50).
#[tauri::command]
async fn search_sessions(query: String) -> Result<Vec<Value>, String> {
    if query.len() < 2 {
        return Ok(vec![]);
    }

    let claude_dir = client_runtime::claude_config_dir()?.join("projects");

    if !claude_dir.exists() {
        return Ok(vec![]);
    }

    let tracked = load_tracked_sessions();
    let query_lower = query.to_lowercase();

    let mut results: Vec<Value> = Vec::new();

    if let Ok(entries) = std::fs::read_dir(&claude_dir) {
        for entry in entries.flatten() {
            if entry.path().is_dir() {
                if let Ok(files) = std::fs::read_dir(entry.path()) {
                    for file in files.flatten() {
                        let path = file.path();
                        if path.extension().map_or(false, |e| e == "jsonl") {
                            if let Some(name) = path.file_stem() {
                                let id = name.to_string_lossy().to_string();
                                if !tracked.contains(&id) {
                                    continue;
                                }
                                if let Some(result) = search_session_file(&path, &query_lower) {
                                    results.push(result);
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // Sort by match_count descending
    results.sort_by(|a, b| {
        let ca = a["match_count"].as_u64().unwrap_or(0);
        let cb = b["match_count"].as_u64().unwrap_or(0);
        cb.cmp(&ca)
    });

    results.truncate(50);
    Ok(results)
}

/// Search a single session JSONL file for the query string.
/// Returns a JSON value with session_id, snippet, match_count, and match_role if any matches found.
fn search_session_file(path: &std::path::Path, query_lower: &str) -> Option<serde_json::Value> {
    use std::io::BufRead;

    let file = std::fs::File::open(path).ok()?;
    let reader = std::io::BufReader::new(file);

    let session_id = path.file_stem()?.to_string_lossy().to_string();

    let mut match_count: u64 = 0;
    let mut first_snippet = String::new();
    let mut first_role = String::new();
    let mut snippets_collected: usize = 0;

    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => continue,
        };

        // Quick rejection: skip lines where the query doesn't appear at all
        let line_lower = line.to_lowercase();
        if !line_lower.contains(query_lower) {
            continue;
        }

        // Skip lines that aren't user or assistant messages (raw string check before JSON parse)
        if !line.contains("\"type\":\"user\"")
            && !line.contains("\"type\":\"human\"")
            && !line.contains("\"type\":\"assistant\"")
            && !line.contains("\"type\": \"user\"")
            && !line.contains("\"type\": \"human\"")
            && !line.contains("\"type\": \"assistant\"")
            && !line.contains("\"role\":\"user\"")
            && !line.contains("\"role\":\"assistant\"")
            && !line.contains("\"role\": \"user\"")
            && !line.contains("\"role\": \"assistant\"")
        {
            continue;
        }

        let obj: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };

        // Determine role
        let role = if obj["type"].as_str() == Some("human")
            || obj["type"].as_str() == Some("user")
            || obj["message"]["role"].as_str() == Some("user")
        {
            "user"
        } else if obj["type"].as_str() == Some("assistant")
            || obj["message"]["role"].as_str() == Some("assistant")
        {
            "assistant"
        } else {
            continue;
        };

        // Skip meta and sidechain messages
        if obj["isMeta"].as_bool() == Some(true) || obj["isSidechain"].as_bool() == Some(true) {
            continue;
        }

        // Extract text from content blocks
        let content_arr = obj["content"]
            .as_array()
            .or_else(|| obj["message"]["content"].as_array());

        let mut text_parts: Vec<String> = Vec::new();
        if let Some(blocks) = content_arr {
            for block in blocks {
                let block_type = block["type"].as_str().unwrap_or("");
                if block_type == "tool_result"
                    || block_type == "tool_use"
                    || block_type == "thinking"
                    || block_type == "image"
                {
                    continue;
                }
                if block_type == "text" {
                    if let Some(text) = block["text"].as_str() {
                        text_parts.push(text.to_string());
                    }
                }
            }
        }

        let full_text = text_parts.join(" ");
        let full_text_lower = full_text.to_lowercase();

        if !full_text_lower.contains(query_lower) {
            continue;
        }

        match_count += 1;

        if snippets_collected < 3 {
            // Extract snippet using char indices for Unicode safety
            let chars: Vec<char> = full_text_lower.chars().collect();
            if let Some(char_pos) = chars
                .windows(query_lower.chars().count())
                .position(|w| w.iter().collect::<String>() == query_lower)
            {
                let original_chars: Vec<char> = full_text.chars().collect();
                let total_chars = original_chars.len();
                let start = if char_pos > 75 { char_pos - 75 } else { 0 };
                let end = std::cmp::min(total_chars, char_pos + query_lower.chars().count() + 75);

                let mut snippet: String = original_chars[start..end].iter().collect();
                if start > 0 {
                    snippet = format!("...{}", snippet);
                }
                if end < total_chars {
                    snippet = format!("{}...", snippet);
                }

                if snippets_collected == 0 {
                    first_snippet = snippet;
                    first_role = role.to_string();
                }
                snippets_collected += 1;
            }
        }
    }

    if match_count > 0 {
        Some(serde_json::json!({
            "session_id": session_id,
            "snippet": first_snippet,
            "match_count": match_count,
            "match_role": first_role,
        }))
    } else {
        None
    }
}

/// Extract preview (first user message) and cwd from a session .jsonl file.
/// Returns (preview, cwd) — cwd may be empty if not found.
fn extract_session_info(path: &std::path::Path) -> (String, String) {
    use std::io::BufRead;
    let file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return (String::new(), String::new()),
    };
    let reader = std::io::BufReader::new(file);
    let mut cwd = String::new();
    let mut preview = String::new();

    // Scan up to 100 lines to find cwd and first real user message.
    for line in reader.lines().take(100) {
        let line = match line {
            Ok(l) => l,
            Err(_) => continue,
        };
        let json = match serde_json::from_str::<Value>(&line) {
            Ok(j) => j,
            Err(_) => continue,
        };

        // Extract cwd from the first line that has it
        if cwd.is_empty() {
            if let Some(c) = json["cwd"].as_str() {
                if !c.is_empty() {
                    cwd = c.to_string();
                }
            }
        }

        // Extract preview from first user message
        if preview.is_empty() {
            let is_user = json["type"].as_str() == Some("human")
                || json["type"].as_str() == Some("user")
                || json["role"].as_str() == Some("user")
                || json["message"]["role"].as_str() == Some("user");

            if !is_user {
                continue;
            }

            // Try to extract text from message.content array
            if let Some(content) = json["message"]["content"].as_array() {
                // First pass: look for direct text blocks
                for block in content {
                    if let Some(text) = block["text"].as_str() {
                        let trimmed = text.trim();
                        if !trimmed.is_empty() {
                            preview = trimmed.chars().take(120).collect();
                            break;
                        }
                    }
                }
                // Second pass: look for text inside nested content
                if preview.is_empty() {
                    for block in content {
                        if let Some(inner) = block["content"].as_array() {
                            for inner_block in inner {
                                if let Some(text) = inner_block["text"].as_str() {
                                    let trimmed = text.trim();
                                    if !trimmed.is_empty() {
                                        preview = trimmed.chars().take(120).collect();
                                        break;
                                    }
                                }
                            }
                            if !preview.is_empty() {
                                break;
                            }
                        }
                        if let Some(text) = block["content"].as_str() {
                            let trimmed = text.trim();
                            if !trimmed.is_empty() {
                                preview = trimmed.chars().take(120).collect();
                                break;
                            }
                        }
                    }
                }
            }
            // Try direct content string
            if preview.is_empty() {
                if let Some(text) = json["message"]["content"].as_str() {
                    let trimmed = text.trim();
                    if !trimmed.is_empty() {
                        preview = trimmed.chars().take(120).collect();
                    }
                }
            }
        }

        // Stop early if we have both
        if !cwd.is_empty() && !preview.is_empty() {
            break;
        }
    }
    (preview, cwd)
}

/// Decode project directory name back to readable path.
///
/// Claude CLI encodes paths by replacing `/` with `-`, e.g.:
///   /Users/user/Desktop/ppt-maker → -Users-user-Desktop-ppt-maker
///
/// Simple `.replace('-', '/')` fails when directory names contain hyphens
/// (e.g. "ppt-maker" becomes "ppt/maker").
///
/// Claude CLI encodes project paths by replacing `/`, `.`, and ` ` (space)
/// with `-`. This is lossy: "a-b" could mean "a/b", "a.b", "a b", or literal
/// "a-b". We resolve ambiguity via greedy filesystem probing.
///
/// Strategy: greedily match real filesystem segments from left to right.
/// At each position, try the longest possible segment first.  For each
/// candidate span of dash-separated parts, try joining them with the
/// original `-`, then ` ` (space), then `.` — whichever produces a path
/// that actually exists on disk wins.
fn decode_project_name(encoded: &str) -> String {
    // Detect Windows-style encoded paths: "C-Users-..." (drive letter prefix without leading dash)
    // vs Unix-style: "-Users-..." (leading dash = root /)
    let is_windows_path = encoded.len() >= 2
        && encoded.as_bytes()[0].is_ascii_alphabetic()
        && encoded.as_bytes()[1] == b'-';

    let (trimmed, root, sep) = if is_windows_path {
        // Windows: "C-Users-foo" → root = "C:\", rest = "Users-foo"
        let drive = &encoded[0..1];
        let rest = &encoded[2..]; // skip "C-"
        (rest, format!("{}:\\", drive), "\\")
    } else {
        // Unix: "-Users-foo" → root = "/", rest = "Users-foo"
        let rest = encoded.strip_prefix('-').unwrap_or(encoded);
        (rest, "/".to_string(), "/")
    };

    let parts: Vec<&str> = trimmed.split('-').collect();

    if parts.is_empty() {
        return encoded.to_string();
    }

    let mut decoded_segments: Vec<String> = Vec::new();
    let mut i = 0;

    while i < parts.len() {
        let mut best_len = 1;
        let mut best_segment = parts[i].to_string();

        // Build the parent path for existence checking
        let parent = if decoded_segments.is_empty() {
            root.clone()
        } else {
            format!("{}{}", root, decoded_segments.join(sep))
        };

        // Try combining parts[i..j], longest first.
        // For each candidate length, try multiple join separators.
        let max_j = parts.len().min(i + 10); // limit lookahead
        let mut found = false;
        'outer: for j in (i + 1..=max_j).rev() {
            let slice = &parts[i..j];
            // Separators to try: hyphen (original name), space, dot
            for join_sep in ["-", " ", "."] {
                let candidate = slice.join(join_sep);
                let full_path = format!(
                    "{}{}{}",
                    parent,
                    if parent.ends_with(sep) { "" } else { sep },
                    candidate
                );
                if std::path::Path::new(&full_path).exists() {
                    best_len = j - i;
                    best_segment = candidate;
                    found = true;
                    break 'outer;
                }
            }
        }

        // Handle empty parts from consecutive dashes (e.g. "/." encoded as "--").
        // If we're at an empty part and no filesystem match was found, try
        // prepending a "." to the next segment (hidden dirs like .claude).
        if !found && parts[i].is_empty() {
            // Collect consecutive empty parts (each represents one encoded char)
            let start = i;
            while i < parts.len() && parts[i].is_empty() {
                i += 1;
            }
            let dot_count = i - start; // number of dots/special chars

            if i < parts.len() {
                // Try interpreting as dot-prefixed segment:
                // e.g. empty + "claude-worktrees" → ".claude-worktrees"
                let prefix = ".".repeat(dot_count);
                // Greedy match on the remaining parts after the dots
                let remaining_max = parts.len().min(i + 10);
                let mut dot_found = false;
                for j in (i + 1..=remaining_max).rev() {
                    for join_sep in ["-", " ", "."] {
                        let after = parts[i..j].join(join_sep);
                        let candidate = format!("{}{}", prefix, after);
                        let full_path = format!(
                            "{}{}{}",
                            parent,
                            if parent.ends_with(sep) { "" } else { sep },
                            candidate
                        );
                        if std::path::Path::new(&full_path).exists() {
                            decoded_segments.push(candidate);
                            i = j;
                            dot_found = true;
                            break;
                        }
                    }
                    if dot_found {
                        break;
                    }
                }
                if !dot_found {
                    // Fallback: just use dot + next part as segment
                    let candidate = format!("{}{}", prefix, parts[i]);
                    decoded_segments.push(candidate);
                    i += 1;
                }
            } else {
                // Trailing empty parts — append dots to last segment or ignore
                if let Some(prev) = decoded_segments.last_mut() {
                    prev.push_str(&".".repeat(dot_count));
                }
            }
            continue;
        }

        decoded_segments.push(best_segment);
        i += best_len;
    }

    format!("{}{}", root, decoded_segments.join(sep))
}

#[tauri::command]
async fn load_session(path: String) -> Result<Vec<Value>, String> {
    use std::io::BufRead;
    let file = std::fs::File::open(&path).map_err(|e| format!("Failed to open session: {}", e))?;
    let reader = std::io::BufReader::new(file);
    let mut messages = vec![];
    for line in reader.lines() {
        if let Ok(line) = line {
            if let Ok(json) = serde_json::from_str::<Value>(&line) {
                messages.push(conversation_projection::without_thinking(json));
            }
        }
    }
    Ok(messages)
}

#[tauri::command]
async fn open_in_vscode(path: String) -> Result<(), String> {
    let mut cmd = Command::new("code");
    cmd.arg(&path);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000);
    cmd.spawn()
        .map_err(|e| format!("Failed to open VS Code: {}", e))?;
    Ok(())
}

#[tauri::command]
async fn reveal_in_finder(path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        // Use 'open -R' to reveal (select) the file in Finder
        Command::new("open")
            .args(["-R", &path])
            .spawn()
            .map_err(|e| format!("Failed to reveal in Finder: {}", e))?;
    }
    #[cfg(target_os = "windows")]
    {
        let mut cmd = Command::new("explorer");
        cmd.args(["/select,", &path]);
        cmd.creation_flags(0x08000000);
        cmd.spawn()
            .map_err(|e| format!("Failed to reveal in Explorer: {}", e))?;
    }
    #[cfg(target_os = "linux")]
    {
        // xdg-open on the parent directory
        let parent = std::path::Path::new(&path)
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or(path.clone());
        Command::new("xdg-open")
            .arg(&parent)
            .spawn()
            .map_err(|e| format!("Failed to reveal in file manager: {}", e))?;
    }
    Ok(())
}

#[tauri::command]
async fn open_with_default_app(path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to open file: {}", e))?;
    }
    #[cfg(target_os = "windows")]
    {
        Command::new("cmd")
            .args(["/C", "start", "", &path])
            .creation_flags(0x08000000)
            .spawn()
            .map_err(|e| format!("Failed to open file: {}", e))?;
    }
    #[cfg(target_os = "linux")]
    {
        Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to open file: {}", e))?;
    }
    Ok(())
}

/// Helper: create an NSURL from a file path string (macOS only).
/// Returns a raw pointer to the NSURL object, or null on failure.
#[cfg(target_os = "macos")]
unsafe fn create_nsurl_from_path(path: &str) -> *mut objc::runtime::Object {
    use objc::msg_send;
    use objc::runtime::{Class, Object};
    use objc::sel;
    use objc::sel_impl;

    let nsstring_class = Class::get("NSString").unwrap();
    let path_nsstring: *mut Object = msg_send![nsstring_class, alloc];
    let path_nsstring: *mut Object = msg_send![path_nsstring,
        initWithBytes: path.as_ptr() as *const std::ffi::c_void
        length: path.len()
        encoding: 4u64  // NSUTF8StringEncoding
    ];
    if path_nsstring.is_null() {
        return std::ptr::null_mut();
    }

    let nsurl_class = Class::get("NSURL").unwrap();
    let file_url: *mut Object = msg_send![nsurl_class,
        fileURLWithPath: path_nsstring
        isDirectory: false
    ];
    file_url
}

/// Show the macOS native share sheet for a file at the current mouse position.
#[tauri::command]
async fn share_file(path: String, app: AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        app.run_on_main_thread(move || {
            objc::rc::autoreleasepool(|| {
                unsafe {
                    use objc::msg_send;
                    use objc::runtime::{Class, Object};
                    use objc::sel;
                    use objc::sel_impl;

                    let file_url = create_nsurl_from_path(&path);
                    if file_url.is_null() {
                        return;
                    }

                    // Create NSArray with the URL
                    let nsarray_class = Class::get("NSArray").unwrap();
                    let items: *mut Object = msg_send![nsarray_class,
                        arrayWithObject: file_url
                    ];

                    // Create NSSharingServicePicker
                    let picker_class = Class::get("NSSharingServicePicker").unwrap();
                    let picker: *mut Object = msg_send![picker_class, alloc];
                    let picker: *mut Object = msg_send![picker, initWithItems: items];
                    if picker.is_null() {
                        return;
                    }

                    // Get key window's content view
                    let nsapp_class = Class::get("NSApplication").unwrap();
                    let nsapp: *mut Object = msg_send![nsapp_class, sharedApplication];
                    let key_window: *mut Object = msg_send![nsapp, keyWindow];
                    if key_window.is_null() {
                        return;
                    }

                    let content_view: *mut Object = msg_send![key_window, contentView];
                    if content_view.is_null() {
                        return;
                    }

                    // Get mouse position and convert to view coordinates
                    let nsevent_class = Class::get("NSEvent").unwrap();
                    let mouse_screen: cocoa::foundation::NSPoint =
                        msg_send![nsevent_class, mouseLocation];
                    let mouse_window: cocoa::foundation::NSPoint = msg_send![key_window,
                        convertPointFromScreen: mouse_screen
                    ];
                    let mouse_view: cocoa::foundation::NSPoint = msg_send![content_view,
                        convertPoint: mouse_window fromView: std::ptr::null::<Object>()
                    ];

                    let anchor_rect = cocoa::foundation::NSRect::new(
                        mouse_view,
                        cocoa::foundation::NSSize::new(1.0, 1.0),
                    );

                    let _: () = msg_send![picker,
                        showRelativeToRect: anchor_rect
                        ofView: content_view
                        preferredEdge: 1u64  // NSRectEdge.minY (bottom)
                    ];
                }
            });
        })
        .map_err(|e| format!("Failed to share: {}", e))?;
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        let _ = path;
    }

    Ok(())
}

/// Share a file to WeChat.
///
/// Strategy (macOS):
///   1. Try NSSharingService — works when WeChat registers a share extension.
///   2. Fallback: copy the file to the system pasteboard and open WeChat via
///      its `weixin://` URL scheme so the user can paste.
///   Returns `"fallback"` when using the clipboard path.
///
/// Strategy (Windows):
///   Copy file to clipboard via PowerShell, then open WeChat via `weixin://`.
#[tauri::command]
#[allow(deprecated)]
async fn share_to_wechat(path: String, app: AppHandle) -> Result<String, String> {
    if !std::path::Path::new(&path).exists() {
        return Err("File not found".to_string());
    }

    #[cfg(target_os = "macos")]
    {
        let (tx, rx) = std::sync::mpsc::channel::<String>();

        let path_clone = path.clone();
        app.run_on_main_thread(move || {
            let result = objc::rc::autoreleasepool(|| -> String {
                unsafe {
                    use objc::msg_send;
                    use objc::runtime::{Class, Object};
                    use objc::sel;
                    use objc::sel_impl;

                    let file_url = create_nsurl_from_path(&path_clone);
                    if file_url.is_null() {
                        return "error:Failed to create file URL".to_string();
                    }

                    let nsarray_class = Class::get("NSArray").unwrap();
                    let items: *mut Object = msg_send![nsarray_class,
                        arrayWithObject: file_url
                    ];

                    let service_class = Class::get("NSSharingService").unwrap();
                    let services: *mut Object = msg_send![service_class,
                        sharingServicesForItems: items
                    ];
                    let count: usize = msg_send![services, count];

                    for i in 0..count {
                        let service: *mut Object = msg_send![services, objectAtIndex: i];
                        let title: *mut Object = msg_send![service, title];
                        let utf8: *const std::ffi::c_char = msg_send![title, UTF8String];
                        if utf8.is_null() {
                            continue;
                        }
                        let title_str = std::ffi::CStr::from_ptr(utf8).to_string_lossy();
                        let lower = title_str.to_lowercase();
                        if lower.contains("wechat") || title_str.contains("微信") {
                            let _: () = msg_send![service, performWithItems: items];
                            return "service".to_string();
                        }
                    }

                    // Clipboard fallback
                    let pb_class = Class::get("NSPasteboard").unwrap();
                    let pb: *mut Object = msg_send![pb_class, generalPasteboard];
                    let _: () = msg_send![pb, clearContents];

                    let write_arr: *mut Object = msg_send![nsarray_class,
                        arrayWithObject: file_url
                    ];
                    let ok: bool = msg_send![pb, writeObjects: write_arr];
                    if !ok {
                        return "error:Failed to copy file to clipboard".to_string();
                    }

                    let ws_class = Class::get("NSWorkspace").unwrap();
                    let ws: *mut Object = msg_send![ws_class, sharedWorkspace];

                    let scheme = "weixin://";
                    let nsstring_class = Class::get("NSString").unwrap();
                    let scheme_ns: *mut Object = msg_send![nsstring_class, alloc];
                    let scheme_ns: *mut Object = msg_send![scheme_ns,
                        initWithBytes: scheme.as_ptr() as *const std::ffi::c_void
                        length: scheme.len()
                        encoding: 4u64
                    ];

                    let nsurl_class = Class::get("NSURL").unwrap();
                    let wechat_url: *mut Object = msg_send![nsurl_class,
                        URLWithString: scheme_ns
                    ];

                    if !wechat_url.is_null() {
                        let _: bool = msg_send![ws, openURL: wechat_url];
                    }

                    "fallback".to_string()
                }
            });
            let _ = tx.send(result);
        })
        .map_err(|e| format!("Failed to share to WeChat: {}", e))?;

        match rx.recv() {
            Ok(ref r) if r.starts_with("error:") => {
                return Err(r.strip_prefix("error:").unwrap_or(r).to_string());
            }
            Ok(r) => return Ok(r),
            Err(_) => return Err("Share thread communication failed".to_string()),
        }
    }

    #[cfg(target_os = "windows")]
    {
        let _ = app;
        let ps_script = format!(
            "Add-Type -AssemblyName System.Windows.Forms; \
             $fc = New-Object System.Collections.Specialized.StringCollection; \
             $fc.Add('{}'); \
             [System.Windows.Forms.Clipboard]::SetFileDropList($fc)",
            path.replace('\'', "''")
        );
        let _ = std::process::Command::new("powershell")
            .args(["-NoProfile", "-Command", &ps_script])
            .output();
        let _ = std::process::Command::new("cmd")
            .args(["/c", "start", "", "weixin://"])
            .spawn();

        return Ok("fallback".to_string());
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = app;
        let _ = path;
        return Err("Not supported on this platform".to_string());
    }
}

/// NEW-Q (v3 §4.3): extract a semver triple from raw CLI version output.
/// `claude --version` prints "2.1.92 (Claude Code)" today, but some builds
/// prefix ANSI warnings, deprecation notices, or (on Windows) "Claude Code v"
/// markers before the number. Earlier code used `split_whitespace().next()`
/// which broke on any of those variants; this helper scans for the first
/// `\d+.\d+.\d+` substring so the parse is stable across builds.
fn extract_semver(raw: &str) -> Option<String> {
    let bytes = raw.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i].is_ascii_digit() {
            let start = i;
            let mut dots = 0;
            while i < bytes.len() && (bytes[i].is_ascii_digit() || bytes[i] == b'.') {
                if bytes[i] == b'.' {
                    dots += 1;
                    if dots > 2 {
                        break;
                    }
                }
                i += 1;
            }
            let candidate = &raw[start..i];
            // Require at least x.y.z (dots == 2) and digits on both sides of
            // each dot. `2.1.92` passes; `2.1` and `2..` do not.
            if dots == 2 {
                let parts: Vec<&str> = candidate.split('.').collect();
                if parts.len() == 3
                    && parts
                        .iter()
                        .all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))
                {
                    return Some(candidate.to_string());
                }
            }
        } else {
            i += 1;
        }
    }
    None
}

fn semver_at_least(version: &str, minimum: &str) -> bool {
    let parse = |value: &str| -> Option<[u64; 3]> {
        let version = extract_semver(value)?;
        let mut parts = version.split('.').map(|part| part.parse::<u64>().ok());
        Some([parts.next()??, parts.next()??, parts.next()??])
    };
    match (parse(version), parse(minimum)) {
        (Some(actual), Some(required)) => actual >= required,
        _ => false,
    }
}

/// Agent Teams changed from named TeamCreate/TeamDelete state to one implicit
/// session team in Claude Code 2.1.178. Black Box deliberately supports only
/// that current contract so it never presents legacy task tools as teammates.
pub(crate) async fn ensure_agent_teams_supported(
    binary: &str,
    enriched_path: &str,
) -> Result<String, String> {
    #[cfg(target_os = "windows")]
    let output = {
        let mut command = if claude_needs_cmd_wrapper(binary) {
            let mut command = Command::new("cmd");
            command.arg("/C").arg(binary);
            command.creation_flags(0x08000000);
            command
        } else {
            let mut command = Command::new(binary);
            command.creation_flags(0x08000000);
            command
        };
        command.arg("--version").env("PATH", enriched_path);
        tokio::time::timeout(std::time::Duration::from_secs(5), command.output())
            .await
            .map_err(|_| "Timed out while checking Claude Code for Agent Teams".to_string())?
            .map_err(|error| format!("Cannot check Claude Code version for Agent Teams: {error}"))?
    };
    #[cfg(not(target_os = "windows"))]
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        Command::new(binary)
            .arg("--version")
            .env("PATH", enriched_path)
            .output(),
    )
    .await
    .map_err(|_| "Timed out while checking Claude Code for Agent Teams".to_string())?
    .map_err(|error| format!("Cannot check Claude Code version for Agent Teams: {error}"))?;

    if !output.status.success() {
        return Err("Claude Code --version failed; Agent Teams was not enabled".to_string());
    }
    let raw = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr),
    );
    let version = extract_semver(&strip_ansi(&raw)).ok_or_else(|| {
        "Cannot parse Claude Code version; Agent Teams was not enabled".to_string()
    })?;
    if !semver_at_least(&version, "2.1.178") {
        return Err(format!(
            "Agent Teams requires Claude Code 2.1.178 or newer; found {version}"
        ));
    }
    Ok(version)
}

#[cfg(test)]
mod extract_semver_tests {
    use super::{extract_semver, semver_at_least};

    #[test]
    fn simple_version() {
        assert_eq!(extract_semver("2.1.92"), Some("2.1.92".into()));
    }

    #[test]
    fn with_suffix() {
        assert_eq!(
            extract_semver("2.1.92 (Claude Code)"),
            Some("2.1.92".into())
        );
    }

    #[test]
    fn with_prefix() {
        assert_eq!(extract_semver("Claude Code v2.1.92"), Some("2.1.92".into()));
    }

    #[test]
    fn with_warning_prefix() {
        assert_eq!(
            extract_semver("(node:1) Warning: ...\nclaude 2.1.92"),
            Some("2.1.92".into())
        );
    }

    #[test]
    fn rejects_two_part() {
        assert_eq!(extract_semver("2.1"), None);
    }

    #[test]
    fn empty() {
        assert_eq!(extract_semver(""), None);
    }

    #[test]
    fn compares_agent_team_floor() {
        assert!(semver_at_least("2.1.178 (Claude Code)", "2.1.178"));
        assert!(semver_at_least("2.1.207", "2.1.178"));
        assert!(!semver_at_least("2.1.177", "2.1.178"));
        assert!(!semver_at_least("unknown", "2.1.178"));
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct FileNode {
    name: String,
    path: String,
    is_dir: bool,
    children: Option<Vec<FileNode>>,
    children_truncated: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct FileSearchMatch {
    name: String,
    path: String,
    is_dir: bool,
    relative_dir: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct FileSearchResponse {
    matches: Vec<FileSearchMatch>,
    truncated: bool,
    skipped_directories: usize,
}

const FILE_SEARCH_DEFAULT_LIMIT: usize = 200;
const FILE_SEARCH_MAX_LIMIT: usize = 500;
const FILE_SEARCH_ENTRY_LIMIT: usize = 50_000;

fn is_ignored_file_tree_entry(name: &str) -> bool {
    matches!(
        name,
        "node_modules"
            | "target"
            | "__pycache__"
            | ".git"
            | ".DS_Store"
            | "Thumbs.db"
            | ".venv"
            | "venv"
            | ".env"
            | "dist"
            | "build"
            | ".next"
            | ".nuxt"
            | ".parcel-cache"
            | "coverage"
            | ".turbo"
            | ".svelte-kit"
    )
}

// ── Path access (Phase 3 §3.1) ───────────────────────────────────────────
//
// Frontend entry points for recording/clearing per-tab path grants. These
// are called after the user has explicitly authorized a path via the native
// file dialog, OS drag-drop, or a Markdown "authorize" button.

#[tauri::command]
async fn add_path_grant(
    path_access: State<'_, PathAccessManager>,
    tab_id: String,
    path: String,
) -> Result<(), String> {
    path_access
        .add_grant(&tab_id, std::path::Path::new(&path))
        .await;
    Ok(())
}

#[tauri::command]
async fn clear_path_grants(
    path_access: State<'_, PathAccessManager>,
    tab_id: String,
) -> Result<(), String> {
    path_access.clear_grants(&tab_id).await;
    Ok(())
}

/// Decode a `~/.claude/projects/` directory name back to its source path.
/// Used by the frontend to avoid the buggy `.replace('-', '/')` fallback
/// that breaks on names containing hyphens (S16).
#[tauri::command]
async fn decode_project_dir(encoded: String) -> Result<String, String> {
    Ok(decode_project_name(&encoded))
}

#[tauri::command]
async fn read_file_tree(
    path_access: State<'_, PathAccessManager>,
    path: String,
    depth: Option<u32>,
) -> Result<Vec<FileNode>, String> {
    // Register the browsed directory as a fixed root so file operations
    // (preview, read) work even before the first CLI session is started.
    path_access.register_cwd(std::path::Path::new(&path)).await;
    let max_depth = depth.unwrap_or(5);
    let root = std::path::Path::new(&path);
    if !root.exists() {
        return Err("Directory does not exist".to_string());
    }
    Ok(read_dir_recursive(root, 0, max_depth))
}

#[tauri::command]
async fn search_file_tree(
    path_access: State<'_, PathAccessManager>,
    path: String,
    query: String,
    show_hidden: Option<bool>,
    max_results: Option<usize>,
) -> Result<FileSearchResponse, String> {
    let root = std::fs::canonicalize(&path)
        .map_err(|error| format!("Cannot open search directory: {error}"))?;
    if !root.is_dir() {
        return Err("Directory does not exist".to_string());
    }
    path_access.register_cwd(&root).await;
    let show_hidden = show_hidden.unwrap_or(false);
    let max_results = max_results.unwrap_or(FILE_SEARCH_DEFAULT_LIMIT);

    tauri::async_runtime::spawn_blocking(move || {
        search_file_tree_recursive(&root, &query, show_hidden, max_results)
    })
    .await
    .map_err(|error| format!("File search worker failed: {error}"))
}

fn search_file_tree_recursive(
    root: &std::path::Path,
    query: &str,
    show_hidden: bool,
    max_results: usize,
) -> FileSearchResponse {
    let normalized_query = query.trim().to_lowercase();
    if normalized_query.is_empty() {
        return FileSearchResponse {
            matches: vec![],
            truncated: false,
            skipped_directories: 0,
        };
    }

    let result_limit = max_results.clamp(1, FILE_SEARCH_MAX_LIMIT);
    let mut matches = Vec::new();
    let mut pending = vec![root.to_path_buf()];
    let mut entries_seen = 0usize;
    let mut truncated = false;
    let mut skipped_directories = 0usize;

    while let Some(dir) = pending.pop() {
        let entries = match std::fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(_) => {
                skipped_directories += 1;
                continue;
            }
        };
        let mut entries: Vec<(std::fs::DirEntry, bool, String)> = entries
            .flatten()
            .filter_map(|entry| {
                let file_type = entry.file_type().ok()?;
                // Symlinked directories are deliberately treated as leaf entries so an
                // arbitrary-depth search cannot follow cycles outside the workspace.
                let is_dir = file_type.is_dir();
                let name = entry.file_name().to_string_lossy().to_string();
                Some((entry, is_dir, name))
            })
            .collect();
        entries.sort_by(|a, b| {
            b.1.cmp(&a.1)
                .then_with(|| a.2.to_lowercase().cmp(&b.2.to_lowercase()))
        });

        // Push in reverse because this is a LIFO stack; the next visited directory then
        // follows the same alphabetical ordering as the visible file tree.
        for (entry, is_dir, name) in entries.into_iter().rev() {
            entries_seen += 1;
            if entries_seen > FILE_SEARCH_ENTRY_LIMIT {
                truncated = true;
                break;
            }
            if is_ignored_file_tree_entry(&name) || (!show_hidden && name.starts_with('.')) {
                continue;
            }

            let entry_path = entry.path();
            if is_dir {
                pending.push(entry_path.clone());
            }
            if !name.to_lowercase().contains(&normalized_query) {
                continue;
            }
            if matches.len() >= result_limit {
                truncated = true;
                break;
            }

            let relative_dir = entry_path
                .parent()
                .and_then(|parent| parent.strip_prefix(root).ok())
                .map(|relative| relative.to_string_lossy().to_string())
                .unwrap_or_default();
            matches.push(FileSearchMatch {
                name,
                path: entry_path.to_string_lossy().to_string(),
                is_dir,
                relative_dir,
            });
        }

        if truncated {
            break;
        }
    }

    matches.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| {
                a.relative_dir
                    .to_lowercase()
                    .cmp(&b.relative_dir.to_lowercase())
            })
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    FileSearchResponse {
        matches,
        truncated,
        skipped_directories,
    }
}

fn read_dir_recursive(dir: &std::path::Path, current_depth: u32, max_depth: u32) -> Vec<FileNode> {
    let mut nodes = vec![];
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return nodes,
    };

    // PATCH C (v0.10.5): snapshot is_dir() + lowercase name BEFORE sort_by.
    //
    // The previous closure called `a.path().is_dir()` inline — a filesystem
    // syscall on every comparison. While the sort runs, the Claude CLI
    // concurrently writes SDK checkpoint / temp files into the workspace,
    // so the same entry can return `true` on one call and `false` on the next.
    // Rust 1.81+'s strict total-order check detects this violation and panics
    // the tokio worker thread, tearing down all async tauri commands (CLI
    // detection, file scan, chat) → "CLI env / file manager disappears after
    // first response" + flood of "Couldn't find callback id" warnings.
    let mut entries_meta: Vec<(std::fs::DirEntry, bool, String)> = entries
        .flatten()
        .map(|e| {
            // `DirEntry::file_type` does not follow directory symlinks. Treating
            // them as leaves keeps the visible tree inside the selected workspace.
            let is_dir = e.file_type().map(|kind| kind.is_dir()).unwrap_or(false);
            let lower = e.file_name().to_string_lossy().to_lowercase();
            (e, is_dir, lower)
        })
        .collect();
    entries_meta.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.2.cmp(&b.2)));

    for (entry, is_dir, _) in entries_meta {
        let name = entry.file_name().to_string_lossy().to_string();
        // Skip specific ignored dirs (but show dotfiles like .claude, .github, .vscode)
        if is_ignored_file_tree_entry(&name) {
            continue;
        }

        let path = entry.path();
        let children_truncated = is_dir && current_depth >= max_depth;
        let children = if is_dir && current_depth < max_depth {
            Some(read_dir_recursive(&path, current_depth + 1, max_depth))
        } else if is_dir {
            Some(vec![]) // Placeholder for unexpanded dirs
        } else {
            None
        };

        nodes.push(FileNode {
            name,
            path: path.to_string_lossy().to_string(),
            is_dir,
            children,
            children_truncated,
        });
    }
    nodes
}

#[cfg(test)]
mod file_tree_depth_tests {
    use super::{read_dir_recursive, search_file_tree_recursive, FileNode};

    fn directory<'a>(nodes: &'a [FileNode], name: &str) -> &'a FileNode {
        nodes
            .iter()
            .find(|node| node.is_dir && node.name == name)
            .unwrap_or_else(|| panic!("missing directory {name}"))
    }

    #[test]
    fn marks_depth_boundaries_and_allows_scanning_past_ten_levels() {
        let temp = tempfile::tempdir().unwrap();
        let mut current = temp.path().to_path_buf();
        for depth in 0..12 {
            current = current.join(format!("level_{depth}"));
            std::fs::create_dir(&current).unwrap();
        }
        std::fs::write(current.join("deep.md"), "visible").unwrap();

        let initial = read_dir_recursive(temp.path(), 0, 8);
        let mut level = directory(&initial, "level_0");
        for depth in 1..=8 {
            level = directory(level.children.as_ref().unwrap(), &format!("level_{depth}"));
        }
        assert!(level.children_truncated);
        assert!(level.children.as_ref().unwrap().is_empty());

        // The frontend hydrates this exact boundary as a new bounded subtree.
        let hydrated = read_dir_recursive(std::path::Path::new(&level.path), 0, 8);
        let level_9 = directory(&hydrated, "level_9");
        let level_10 = directory(level_9.children.as_ref().unwrap(), "level_10");
        let level_11 = directory(level_10.children.as_ref().unwrap(), "level_11");
        assert!(level_11
            .children
            .as_ref()
            .unwrap()
            .iter()
            .any(|node| !node.is_dir && node.name == "deep.md"));
    }

    #[test]
    fn search_reaches_deep_files_without_entering_ignored_or_symlinked_directories() {
        let temp = tempfile::tempdir().unwrap();
        let mut current = temp.path().to_path_buf();
        for depth in 0..14 {
            current = current.join(format!("level_{depth}"));
            std::fs::create_dir(&current).unwrap();
        }
        let deep_file = current.join("deep-needle.md");
        std::fs::write(&deep_file, "visible").unwrap();

        let ignored = temp.path().join("node_modules").join("package");
        std::fs::create_dir_all(&ignored).unwrap();
        std::fs::write(ignored.join("ignored-needle.md"), "hidden").unwrap();

        #[cfg(unix)]
        std::os::unix::fs::symlink(temp.path(), current.join("workspace-cycle")).unwrap();

        let result = search_file_tree_recursive(temp.path(), "needle", false, 200);
        assert!(!result.truncated);
        assert_eq!(result.matches.len(), 1);
        assert_eq!(result.matches[0].path, deep_file.to_string_lossy());
        assert!(result.matches[0].relative_dir.contains("level_13"));
    }

    #[test]
    fn search_applies_result_cap_and_reports_truncation() {
        let temp = tempfile::tempdir().unwrap();
        for index in 0..4 {
            std::fs::write(temp.path().join(format!("needle-{index}.md")), "match").unwrap();
        }

        let result = search_file_tree_recursive(temp.path(), "needle", false, 2);
        assert_eq!(result.matches.len(), 2);
        assert!(result.truncated);
    }

    #[test]
    fn search_respects_hidden_toggle_and_permanent_ignored_directories() {
        let temp = tempfile::tempdir().unwrap();
        let github = temp.path().join(".github");
        let git = temp.path().join(".git");
        let modules = temp.path().join("node_modules");
        std::fs::create_dir_all(&github).unwrap();
        std::fs::create_dir_all(&git).unwrap();
        std::fs::create_dir_all(&modules).unwrap();
        std::fs::write(github.join("hidden-needle.md"), "visible when enabled").unwrap();
        std::fs::write(git.join("git-needle.md"), "always ignored").unwrap();
        std::fs::write(modules.join("module-needle.md"), "always ignored").unwrap();

        let hidden_off = search_file_tree_recursive(temp.path(), "needle", false, 200);
        assert!(hidden_off.matches.is_empty());
        let hidden_on = search_file_tree_recursive(temp.path(), "needle", true, 200);
        assert_eq!(hidden_on.matches.len(), 1);
        assert_eq!(hidden_on.matches[0].name, "hidden-needle.md");
    }

    #[cfg(unix)]
    #[test]
    fn visible_tree_and_search_do_not_follow_directory_symlinks() {
        let workspace = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("outside-needle.md"), "outside").unwrap();
        let link = workspace.path().join("linked-outside");
        std::os::unix::fs::symlink(outside.path(), &link).unwrap();

        let result = search_file_tree_recursive(workspace.path(), "needle", true, 200);
        assert!(result.matches.is_empty());

        let visible = read_dir_recursive(workspace.path(), 0, 8);
        let link_node = visible
            .iter()
            .find(|node| node.name == "linked-outside")
            .unwrap();
        assert!(!link_node.is_dir);
        assert!(link_node.children.is_none());
    }
}

#[tauri::command]
async fn read_file_content(
    path_access: State<'_, PathAccessManager>,
    path: String,
    tab_id: Option<String>,
) -> Result<String, String> {
    let p = path_access
        .validate(
            std::path::Path::new(&path),
            tab_id.as_deref(),
            PathCapability::Read,
        )
        .await?;
    // Limit to 1MB to prevent loading huge files
    let metadata = std::fs::metadata(&p).map_err(|e| format!("Cannot read file: {}", e))?;
    if metadata.len() > 1_048_576 {
        return Err("File too large (>1MB)".to_string());
    }
    std::fs::read_to_string(&p).map_err(|e| format!("Cannot read file: {}", e))
}

/// Check if the app has file system access to a given directory.
/// Returns Ok(true) if readable, Ok(false) if not, Err on other failures.
/// Used at startup to detect macOS TCC restrictions.
#[tauri::command]
async fn check_file_access(path: String) -> Result<bool, String> {
    match std::fs::read_dir(&path) {
        Ok(_) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => Ok(false),
        Err(e) => Err(format!("Cannot check path: {}", e)),
    }
}

/// Read a binary file and return it as a base64-encoded data URL.
/// Used for previewing images, PDFs, and other binary files in the webview.
/// Limit: 50MB to prevent memory issues.
#[tauri::command]
async fn read_file_base64(
    path_access: State<'_, PathAccessManager>,
    path: String,
    tab_id: Option<String>,
) -> Result<String, String> {
    use base64::Engine as _;

    let p = path_access
        .validate(
            std::path::Path::new(&path),
            tab_id.as_deref(),
            PathCapability::Read,
        )
        .await?;

    let metadata = std::fs::metadata(&p).map_err(|e| format!("Cannot read file: {}", e))?;
    if metadata.len() > 50_000_000 {
        return Err("File too large (>50MB)".to_string());
    }

    let bytes = std::fs::read(&p).map_err(|e| format!("Cannot read file: {}", e))?;

    // Guess MIME type from extension
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    let mime = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "svg" => "image/svg+xml",
        "pdf" => "application/pdf",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        _ => "application/octet-stream",
    };

    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:{};base64,{}", mime, b64))
}

#[tauri::command]
async fn write_file_content(
    path_access: State<'_, PathAccessManager>,
    path: String,
    content: String,
    tab_id: Option<String>,
) -> Result<(), String> {
    let p = path_access
        .validate(
            std::path::Path::new(&path),
            tab_id.as_deref(),
            PathCapability::Write,
        )
        .await?;
    std::fs::write(&p, &content).map_err(|e| format!("Cannot write file: {}", e))
}

#[tauri::command]
fn get_home_dir() -> Result<String, String> {
    dirs::home_dir()
        .map(|path| path.to_string_lossy().to_string())
        .ok_or_else(|| "Cannot determine home directory".to_string())
}

#[tauri::command]
async fn copy_file(
    path_access: State<'_, PathAccessManager>,
    src: String,
    dest: String,
    tab_id: Option<String>,
) -> Result<(), String> {
    let s = path_access
        .validate(
            std::path::Path::new(&src),
            tab_id.as_deref(),
            PathCapability::Read,
        )
        .await?;
    let d = path_access
        .validate(
            std::path::Path::new(&dest),
            tab_id.as_deref(),
            PathCapability::Write,
        )
        .await?;
    std::fs::copy(&s, &d)
        .map(|_| ())
        .map_err(|e| format!("Cannot copy file: {}", e))
}

#[tauri::command]
async fn rename_file(
    path_access: State<'_, PathAccessManager>,
    src: String,
    dest: String,
    tab_id: Option<String>,
) -> Result<(), String> {
    let s = path_access
        .validate(
            std::path::Path::new(&src),
            tab_id.as_deref(),
            PathCapability::Write,
        )
        .await?;
    let d = path_access
        .validate(
            std::path::Path::new(&dest),
            tab_id.as_deref(),
            PathCapability::Write,
        )
        .await?;
    std::fs::rename(&s, &d).map_err(|e| format!("Cannot rename file: {}", e))
}

#[tauri::command]
async fn delete_file(
    path_access: State<'_, PathAccessManager>,
    path: String,
    tab_id: Option<String>,
) -> Result<(), String> {
    let p = path_access
        .validate(
            std::path::Path::new(&path),
            tab_id.as_deref(),
            PathCapability::Delete,
        )
        .await?;
    // Move to system trash/recycle bin (recoverable) instead of permanent delete
    trash::delete(&p).map_err(|e| format!("Cannot move to trash: {}", e))
}

#[tauri::command]
async fn create_directory(
    path_access: State<'_, PathAccessManager>,
    path: String,
    tab_id: Option<String>,
) -> Result<(), String> {
    let p = path_access
        .validate(
            std::path::Path::new(&path),
            tab_id.as_deref(),
            PathCapability::Write,
        )
        .await?;
    std::fs::create_dir_all(&p).map_err(|e| format!("Cannot create directory: {}", e))
}

#[tauri::command]
async fn export_session_markdown(
    path: String,
    output_path: String,
    conversation_only: bool,
) -> Result<(), String> {
    use std::io::{BufRead, Write};
    let file = std::fs::File::open(&path).map_err(|e| format!("Failed to open session: {}", e))?;
    let reader = std::io::BufReader::new(file);

    let mut md = String::from("# Claude Code Session\n\n");
    md.push_str(&format!("*Exported from: {}*\n\n---\n\n", path));

    for line in reader.lines() {
        if let Ok(line) = line {
            if let Ok(json) = serde_json::from_str::<Value>(&line) {
                let msg_type = json["type"].as_str().unwrap_or("");
                match msg_type {
                    "user" | "human" => {
                        let mut text_buf = String::new();
                        let content = &json["message"]["content"];
                        if let Some(text) = content.as_str() {
                            text_buf.push_str(text);
                            text_buf.push_str("\n\n");
                        } else if let Some(arr) = content.as_array() {
                            for block in arr {
                                if let Some(text) = block["text"].as_str() {
                                    text_buf.push_str(text);
                                    text_buf.push_str("\n\n");
                                }
                            }
                        }
                        if !conversation_only || !text_buf.trim().is_empty() {
                            md.push_str("## User\n\n");
                            md.push_str(&text_buf);
                        }
                    }
                    "assistant" => {
                        let mut has_text = false;
                        let mut text_buf = String::new();
                        if let Some(content) = json["message"]["content"].as_array() {
                            for block in content {
                                if block["type"].as_str() == Some("text") {
                                    if let Some(text) = block["text"].as_str() {
                                        has_text = true;
                                        text_buf.push_str(text);
                                        text_buf.push_str("\n\n");
                                    }
                                } else if !conversation_only
                                    && block["type"].as_str() == Some("tool_use")
                                {
                                    let name = block["name"].as_str().unwrap_or("Tool");
                                    text_buf.push_str(&format!("**Tool: {}**\n\n", name));
                                    if let Some(input) = block.get("input") {
                                        text_buf.push_str("```json\n");
                                        text_buf.push_str(
                                            &serde_json::to_string_pretty(input)
                                                .unwrap_or_default(),
                                        );
                                        text_buf.push_str("\n```\n\n");
                                    }
                                }
                            }
                        }
                        if !conversation_only || has_text {
                            md.push_str("## Assistant\n\n");
                            md.push_str(&text_buf);
                        }
                    }
                    _ => {}
                }
            }
        }
    }

    let mut out = std::fs::File::create(&output_path)
        .map_err(|e| format!("Failed to create output: {}", e))?;
    out.write_all(md.as_bytes())
        .map_err(|e| format!("Failed to write: {}", e))?;
    Ok(())
}

#[tauri::command]
async fn export_session_json(path: String, output_path: String) -> Result<(), String> {
    use std::io::{BufRead, Write};
    let file = std::fs::File::open(&path).map_err(|e| format!("Failed to open session: {}", e))?;
    let reader = std::io::BufReader::new(file);
    let mut messages = vec![];
    for line in reader.lines() {
        if let Ok(line) = line {
            if let Ok(json) = serde_json::from_str::<Value>(&line) {
                messages.push(conversation_projection::without_thinking(json));
            }
        }
    }
    let json_str = serde_json::to_string_pretty(&messages)
        .map_err(|e| format!("Failed to serialize: {}", e))?;
    let mut out = std::fs::File::create(&output_path)
        .map_err(|e| format!("Failed to create output: {}", e))?;
    out.write_all(json_str.as_bytes())
        .map_err(|e| format!("Failed to write: {}", e))?;
    Ok(())
}

/// List recent projects from Black Box's private Claude session root.
#[tauri::command]
async fn list_recent_projects() -> Result<Vec<Value>, String> {
    let projects_dir = client_runtime::claude_config_dir()?.join("projects");

    if !projects_dir.exists() {
        return Ok(vec![]);
    }

    let mut projects: HashMap<String, u64> = HashMap::new();

    if let Ok(entries) = std::fs::read_dir(&projects_dir) {
        for entry in entries.flatten() {
            if entry.path().is_dir() {
                let dir_name = entry.file_name().to_string_lossy().to_string();
                // S16 (v3 §4.3): use the filesystem-aware decoder instead of
                // `dir_name.replace('-', "/")` which silently mangles any
                // project whose folder name contains a hyphen (e.g. ppt-maker).
                let actual_path = decode_project_name(&dir_name);

                // Find the most recent session file in this project
                let mut latest: u64 = 0;
                if let Ok(files) = std::fs::read_dir(entry.path()) {
                    for file in files.flatten() {
                        if let Ok(meta) = file.metadata() {
                            if let Ok(modified) = meta.modified() {
                                if let Ok(dur) = modified.duration_since(std::time::UNIX_EPOCH) {
                                    latest = latest.max(dur.as_millis() as u64);
                                }
                            }
                        }
                    }
                }

                // Only include if the actual directory exists
                if std::path::Path::new(&actual_path).exists() {
                    projects.insert(actual_path.clone(), latest);
                }
            }
        }
    }

    let mut result: Vec<Value> = projects
        .into_iter()
        .map(|(path, ts)| {
            let name = std::path::Path::new(&path)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| path.clone());
            let short_path = {
                if let Some(home) = dirs::home_dir() {
                    let home_str = home.to_string_lossy().to_string();
                    if path.starts_with(&home_str) {
                        format!("~{}", &path[home_str.len()..])
                    } else {
                        path.clone()
                    }
                } else {
                    path.clone()
                }
            };
            serde_json::json!({
                "name": name,
                "path": path,
                "shortPath": short_path,
                "lastUsed": ts,
            })
        })
        .collect();

    result.sort_by(|a, b| {
        let ta = a["lastUsed"].as_u64().unwrap_or(0);
        let tb = b["lastUsed"].as_u64().unwrap_or(0);
        tb.cmp(&ta)
    });

    // TK-321: Keep only the 4 most recent projects
    result.truncate(4);

    Ok(result)
}

/// Start watching a directory for file changes, emit events to frontend
#[tauri::command]
async fn watch_directory(
    app: AppHandle,
    state: State<'_, WatcherManager>,
    path: String,
) -> Result<(), String> {
    use notify::{Event, EventKind, RecursiveMode, Watcher};

    // Stop existing watcher for this path if any
    {
        let mut watchers = state.watchers.lock().await;
        watchers.remove(&path);
    }

    let app_clone = app.clone();
    let path_clone = path.clone();

    // Directories whose changes are noise for the UI (high-frequency writes by CLI, git, etc.)
    const IGNORED_SEGMENTS: &[&str] = &[
        ".claude",
        ".git",
        "node_modules",
        ".next",
        "target",
        "__pycache__",
        ".venv",
    ];

    let mut watcher = notify::recommended_watcher(move |res: Result<Event, notify::Error>| {
        if let Ok(event) = res {
            let kind = match event.kind {
                EventKind::Create(_) => "created",
                EventKind::Modify(_) => "modified",
                EventKind::Remove(_) => "removed",
                _ => return,
            };
            // Filter out paths under ignored directories to prevent UI render storms
            let paths: Vec<String> = event
                .paths
                .iter()
                .filter(|p| {
                    !p.components()
                        .any(|c| IGNORED_SEGMENTS.iter().any(|seg| c.as_os_str() == *seg))
                })
                .map(|p| p.to_string_lossy().to_string())
                .collect();
            if paths.is_empty() {
                return;
            }
            let _ = emit_to_frontend(
                &app_clone,
                "fs:change",
                serde_json::json!({
                    "kind": kind,
                    "paths": paths,
                    "root": path_clone,
                }),
            );
        }
    })
    .map_err(|e| format!("Failed to create watcher: {}", e))?;

    watcher
        .watch(std::path::Path::new(&path), RecursiveMode::Recursive)
        .map_err(|e| format!("Failed to watch: {}", e))?;

    let mut watchers = state.watchers.lock().await;
    watchers.insert(path, watcher);

    Ok(())
}

#[tauri::command]
async fn unwatch_directory(state: State<'_, WatcherManager>, path: String) -> Result<(), String> {
    let mut watchers = state.watchers.lock().await;
    watchers.remove(&path);
    Ok(())
}

/// Get file size in bytes for a given path
#[tauri::command]
async fn get_file_size(
    path_access: State<'_, PathAccessManager>,
    path: String,
    tab_id: Option<String>,
) -> Result<u64, String> {
    let p = path_access
        .validate(
            std::path::Path::new(&path),
            tab_id.as_deref(),
            PathCapability::Read,
        )
        .await?;
    let metadata =
        std::fs::metadata(&p).map_err(|e| format!("Cannot read file metadata: {}", e))?;
    Ok(metadata.len())
}

/// Save a file to a temp directory and return its path.
/// Uses a unique suffix to avoid name collisions (e.g. multiple pasted images all named "image.png").
#[tauri::command]
async fn save_temp_file(
    name: String,
    data: Vec<u8>,
    cwd: Option<String>,
) -> Result<String, String> {
    // If a working directory is provided, save inside it so Claude CLI can access the file.
    // Falls back to system temp if cwd is not set.
    let tmp = if let Some(ref dir) = cwd {
        let p = std::path::PathBuf::from(dir).join(".blackbox").join("tmp");
        if std::fs::create_dir_all(&p).is_ok() {
            // Ensure .blackbox is gitignored in user's project
            let gitignore = std::path::PathBuf::from(dir)
                .join(".blackbox")
                .join(".gitignore");
            if !gitignore.exists() {
                let _ = std::fs::write(&gitignore, "*\n");
            }
            p
        } else {
            std::env::temp_dir().join("blackbox")
        }
    } else {
        std::env::temp_dir().join("blackbox")
    };
    std::fs::create_dir_all(&tmp).map_err(|e| format!("Failed to create temp dir: {}", e))?;

    // Split name into stem + extension, append timestamp + counter for uniqueness
    let path_buf = std::path::PathBuf::from(&name);
    let stem = path_buf
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let ext = path_buf
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();

    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let count = COUNTER.fetch_add(1, Ordering::Relaxed);
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();

    let unique_name = format!("{}_{}{}{}", stem, ts, count, ext);
    let path = tmp.join(&unique_name);
    std::fs::write(&path, &data).map_err(|e| format!("Failed to write temp file: {}", e))?;
    Ok(path.to_string_lossy().to_string())
}

// ── Slash Commands & Skills ──────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
struct SlashCommand {
    name: String,
    description: String,
    source: String,
    has_args: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct UnifiedCommand {
    name: String,
    description: String,
    source: String,       // Legacy display scope: "builtin" | "global" | "project"
    category: String,     // Legacy display kind: "builtin" | "command" | "skill" | "workflow"
    owner: String,        // "blackbox" | "filesystem" | "claude" | "plugin" | "mcp"
    kind: String,         // "command" | "skill" | "workflow"
    availability: String, // "available" | "provisional" | "reference"
    has_args: bool,
    path: Option<String>, // Only for skills, points to SKILL.md
    immediate: bool,      // true = execute immediately (no message sent)
    #[serde(skip_serializing_if = "Option::is_none")]
    argument_hint: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    aliases: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    execution: Option<String>, // "ui" | "cli" | "session" — how command is executed
}

/// Legacy projection retained for older renderer calls. The unified catalogue
/// below is the single discovery authority so these endpoints cannot drift.
#[tauri::command]
async fn list_slash_commands(cwd: Option<String>) -> Result<Vec<SlashCommand>, String> {
    Ok(list_all_commands(cwd)
        .await?
        .into_iter()
        .map(|command| SlashCommand {
            name: command.name,
            description: command.description,
            source: command.source,
            has_args: command.has_args,
        })
        .collect())
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct SkillInfo {
    name: String,
    description: String,
    path: String,
    scope: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    disable_model_invocation: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    user_invocable: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    allowed_tools: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    argument_hint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    context: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    agent: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    version: Option<String>,
}

/// YAML frontmatter fields for SKILL.md files
#[derive(Debug, Deserialize, Default)]
struct SkillFrontmatter {
    #[serde(default)]
    description: Option<String>,
    #[serde(default, rename = "disable-model-invocation")]
    disable_model_invocation: Option<bool>,
    #[serde(default, rename = "user-invocable")]
    user_invocable: Option<bool>,
    #[serde(default, rename = "allowed-tools")]
    allowed_tools: Option<Vec<String>>,
    #[serde(default, rename = "argument-hint")]
    argument_hint: Option<String>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    context: Option<String>,
    #[serde(default)]
    agent: Option<String>,
    #[serde(default)]
    version: Option<String>,
}

/// Parse YAML frontmatter from a SKILL.md file content.
/// Returns (parsed frontmatter, body text after frontmatter).
fn parse_skill_frontmatter(content: &str) -> (SkillFrontmatter, &str) {
    let trimmed = content.trim_start();
    if !trimmed.starts_with("---") {
        return (SkillFrontmatter::default(), content);
    }
    // Find the closing ---
    let after_open = &trimmed[3..];
    if let Some(close_idx) = after_open.find("\n---") {
        let yaml_str = &after_open[..close_idx];
        let body_start = 3 + close_idx + 4; // "---" + yaml + "\n---"
        let body = trimmed.get(body_start..).unwrap_or("");
        // Skip leading newline in body
        let body = body.strip_prefix('\n').unwrap_or(body);
        match serde_yaml::from_str::<SkillFrontmatter>(yaml_str) {
            Ok(fm) => (fm, body),
            Err(_) => (SkillFrontmatter::default(), content),
        }
    } else {
        (SkillFrontmatter::default(), content)
    }
}

/// Update or insert a single YAML frontmatter field.
/// If value is None, the field is removed. If no frontmatter exists, one is created.
fn update_frontmatter_field(content: &str, field: &str, value: Option<&str>) -> String {
    let trimmed = content.trim_start();
    if trimmed.starts_with("---") {
        let after_open = &trimmed[3..];
        if let Some(close_idx) = after_open.find("\n---") {
            let yaml_section = &after_open[..close_idx];
            let body = &trimmed[3 + close_idx + 4..];

            // Filter out existing field line
            let mut lines: Vec<&str> = yaml_section
                .lines()
                .filter(|line| {
                    let trimmed_line = line.trim();
                    !trimmed_line.starts_with(&format!("{}:", field))
                })
                .collect();

            // Add field if value is provided
            if let Some(val) = value {
                lines.push(&""); // will be replaced
                let new_line = format!("{}: {}", field, val);
                // Replace the empty placeholder
                let last = lines.len() - 1;
                lines.remove(last);
                let owned_lines: Vec<String> = lines.iter().map(|l| l.to_string()).collect();
                let mut result = String::from("---\n");
                for line in &owned_lines {
                    result.push_str(line);
                    result.push('\n');
                }
                result.push_str(&new_line);
                result.push_str("\n---");
                result.push_str(body);
                return result;
            }

            // Just remove the field
            let owned_lines: Vec<String> = lines.iter().map(|l| l.to_string()).collect();
            if owned_lines.iter().all(|l| l.trim().is_empty()) {
                // No fields left, remove frontmatter entirely
                let body = body.strip_prefix('\n').unwrap_or(body);
                return body.to_string();
            }
            let mut result = String::from("---\n");
            for line in &owned_lines {
                result.push_str(line);
                result.push('\n');
            }
            result.push_str("---");
            result.push_str(body);
            return result;
        }
    }

    // No existing frontmatter — add one if value is provided
    if let Some(val) = value {
        return format!("---\n{}: {}\n---\n{}", field, val, content);
    }

    content.to_string()
}

/// Scan and return all available skills (global + project)
#[tauri::command]
async fn list_skills(cwd: Option<String>) -> Result<Vec<SkillInfo>, String> {
    let mut skills: Vec<SkillInfo> = vec![];

    // Helper: scan a skills directory for */SKILL.md
    fn scan_skills_dir(dir: &std::path::Path, scope: &str) -> Vec<SkillInfo> {
        let mut found = vec![];
        let entries = match std::fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => return found,
        };
        for entry in entries.flatten() {
            let entry_path = entry.path();
            if entry_path.is_dir() {
                let skill_file = entry_path.join("SKILL.md");
                if skill_file.exists() {
                    let name = entry_path
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_default();
                    let content = std::fs::read_to_string(&skill_file).unwrap_or_default();
                    let (fm, body) = parse_skill_frontmatter(&content);

                    // Description priority: frontmatter > first non-empty body line > dir name
                    let description = fm
                        .description
                        .clone()
                        .or_else(|| {
                            body.lines()
                                .find(|line| !line.trim().is_empty())
                                .map(|line| line.trim_start_matches('#').trim().to_string())
                        })
                        .unwrap_or_else(|| name.clone());

                    let path = skill_file.to_string_lossy().to_string();

                    found.push(SkillInfo {
                        name,
                        description,
                        path,
                        scope: scope.to_string(),
                        disable_model_invocation: fm.disable_model_invocation,
                        user_invocable: fm.user_invocable,
                        allowed_tools: fm.allowed_tools,
                        argument_hint: fm.argument_hint,
                        model: fm.model,
                        context: fm.context,
                        agent: fm.agent,
                        version: fm.version,
                    });
                }
            }
        }
        found
    }

    // Black Box user skills live in its private Claude root.
    skills.extend(scan_skills_dir(
        &client_runtime::claude_config_dir()?.join("skills"),
        "global",
    ));

    // Project skills: {cwd}/.claude/skills/*/SKILL.md
    if let Some(ref cwd_path) = cwd {
        let project_dir = std::path::Path::new(cwd_path)
            .join(".claude")
            .join("skills");
        skills.extend(scan_skills_dir(&project_dir, "project"));
    }

    Ok(skills)
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AgentDefinitionInfo {
    name: String,
    description: String,
    path: String,
    scope: String,
    model: Option<String>,
    tools: Vec<String>,
    skills: Vec<String>,
    isolation: Option<String>,
}

fn yaml_frontmatter_value<'a>(
    value: &'a serde_yaml::Value,
    field: &str,
) -> Option<&'a serde_yaml::Value> {
    let key = serde_yaml::Value::String(field.to_string());
    value.as_mapping()?.get(&key)
}

fn yaml_string_list(value: Option<&serde_yaml::Value>) -> Vec<String> {
    match value {
        Some(serde_yaml::Value::Sequence(items)) => items
            .iter()
            .filter_map(|item| item.as_str().map(str::trim))
            .filter(|item| !item.is_empty())
            .map(str::to_string)
            .collect(),
        Some(serde_yaml::Value::String(items)) => items
            .split(',')
            .map(str::trim)
            .filter(|item| !item.is_empty())
            .map(str::to_string)
            .collect(),
        _ => vec![],
    }
}

fn scan_agent_definitions(dir: &std::path::Path, scope: &str) -> Vec<AgentDefinitionInfo> {
    let mut found = vec![];
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(_) => return found,
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() || path.extension().and_then(|value| value.to_str()) != Some("md") {
            continue;
        }
        let content = std::fs::read_to_string(&path).unwrap_or_default();
        let trimmed = content.trim_start();
        let (frontmatter, body) = if let Some(after_open) = trimmed.strip_prefix("---") {
            if let Some(close_index) = after_open.find("\n---") {
                let yaml = &after_open[..close_index];
                let body = after_open
                    .get(close_index + 4..)
                    .unwrap_or("")
                    .strip_prefix('\n')
                    .unwrap_or_else(|| after_open.get(close_index + 4..).unwrap_or(""));
                (
                    serde_yaml::from_str::<serde_yaml::Value>(yaml).unwrap_or_default(),
                    body,
                )
            } else {
                (serde_yaml::Value::Null, content.as_str())
            }
        } else {
            (serde_yaml::Value::Null, content.as_str())
        };

        let fallback_name = path
            .file_stem()
            .map(|value| value.to_string_lossy().to_string())
            .unwrap_or_default();
        let name = yaml_frontmatter_value(&frontmatter, "name")
            .and_then(serde_yaml::Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| fallback_name.clone());
        let description = yaml_frontmatter_value(&frontmatter, "description")
            .and_then(serde_yaml::Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .or_else(|| {
                body.lines()
                    .find(|line| !line.trim().is_empty())
                    .map(|line| line.trim_start_matches('#').trim().to_string())
            })
            .unwrap_or_else(|| fallback_name.clone());

        found.push(AgentDefinitionInfo {
            name,
            description,
            path: path.to_string_lossy().to_string(),
            scope: scope.to_string(),
            model: yaml_frontmatter_value(&frontmatter, "model")
                .and_then(serde_yaml::Value::as_str)
                .map(str::to_string),
            tools: yaml_string_list(yaml_frontmatter_value(&frontmatter, "tools")),
            skills: yaml_string_list(yaml_frontmatter_value(&frontmatter, "skills")),
            isolation: yaml_frontmatter_value(&frontmatter, "isolation")
                .and_then(serde_yaml::Value::as_str)
                .map(str::to_string),
        });
    }
    found
}

#[tauri::command]
async fn list_agent_definitions(cwd: Option<String>) -> Result<Vec<AgentDefinitionInfo>, String> {
    let mut agents = vec![];
    agents.extend(scan_agent_definitions(
        &client_runtime::claude_config_dir()?.join("agents"),
        "user",
    ));
    if let Some(cwd) = cwd.filter(|value| !value.trim().is_empty()) {
        agents.extend(scan_agent_definitions(
            &std::path::Path::new(&cwd).join(".claude").join("agents"),
            "project",
        ));
    }
    agents.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));
    Ok(agents)
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct HookDefinitionInfo {
    id: String,
    event: String,
    matcher: String,
    handler_type: String,
    summary: String,
    handler_value: String,
    timeout_seconds: Option<u64>,
    source_digest: String,
    handler_fingerprint: String,
    path: String,
    scope: String,
    disabled_by_source: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateHookRequest {
    scope: String,
    event: String,
    matcher: Option<String>,
    handler_type: String,
    value: String,
    timeout_seconds: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HookMutationGuard {
    id: String,
    path: String,
    source_digest: String,
    handler_fingerprint: String,
}

fn hook_handler_summary(handler: &Value) -> String {
    for field in ["command", "url", "prompt", "tool", "agent"] {
        if let Some(value) = handler.get(field).and_then(Value::as_str) {
            if !value.trim().is_empty() {
                return value.trim().to_string();
            }
        }
    }
    handler.to_string()
}

fn hook_handler_value(handler: &Value) -> String {
    for field in ["command", "url", "prompt", "tool", "agent"] {
        if let Some(value) = handler.get(field).and_then(Value::as_str) {
            return value.to_string();
        }
    }
    String::new()
}

fn hook_sha256(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(bytes))
}

fn hook_handler_fingerprint(event: &str, matcher: &str, handler: &Value) -> String {
    let identity = serde_json::json!({
        "event": event,
        "matcher": matcher,
        "handler": handler,
    });
    hook_sha256(identity.to_string().as_bytes())
}

fn hook_settings_snapshot(
    path: &std::path::Path,
) -> Result<(serde_json::Map<String, Value>, String), String> {
    if !path.exists() {
        return Ok((serde_json::Map::new(), "missing".to_string()));
    }
    let metadata = std::fs::metadata(path)
        .map_err(|error| format!("Failed to inspect {}: {error}", path.display()))?;
    if metadata.len() > 1024 * 1024 {
        return Err(format!("{} exceeds the 1 MiB safety limit", path.display()));
    }
    let bytes = std::fs::read(path)
        .map_err(|error| format!("Failed to read {}: {error}", path.display()))?;
    let digest = hook_sha256(&bytes);
    let value: Value = serde_json::from_slice(&bytes)
        .map_err(|error| format!("Failed to parse {}: {error}", path.display()))?;
    let document = value
        .as_object()
        .cloned()
        .ok_or_else(|| format!("{} must contain a JSON object", path.display()))?;
    Ok((document, digest))
}

fn verify_hook_source_unchanged(path: &std::path::Path, expected: &str) -> Result<(), String> {
    let (_, current) = hook_settings_snapshot(path)?;
    if current != expected {
        return Err(
            "Hook configuration changed outside Black Box; refresh and try again".to_string(),
        );
    }
    Ok(())
}

fn hook_settings_mutation_lock() -> &'static std::sync::Mutex<()> {
    static LOCK: std::sync::OnceLock<std::sync::Mutex<()>> = std::sync::OnceLock::new();
    LOCK.get_or_init(|| std::sync::Mutex::new(()))
}

fn scan_hook_settings(path: &std::path::Path, scope: &str) -> Vec<HookDefinitionInfo> {
    let content = match std::fs::read_to_string(path) {
        Ok(content) => content,
        Err(_) => return vec![],
    };
    let settings: Value = match serde_json::from_str(&content) {
        Ok(settings) => settings,
        Err(_) => return vec![],
    };
    let source_digest = hook_sha256(content.as_bytes());
    let disabled_by_source = settings
        .get("disableAllHooks")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let Some(events) = settings.get("hooks").and_then(Value::as_object) else {
        return vec![];
    };

    let mut found = vec![];
    for (event, matcher_groups) in events {
        let Some(matcher_groups) = matcher_groups.as_array() else {
            continue;
        };
        for (group_index, matcher_group) in matcher_groups.iter().enumerate() {
            let matcher = matcher_group
                .get("matcher")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let Some(handlers) = matcher_group.get("hooks").and_then(Value::as_array) else {
                continue;
            };
            for (handler_index, handler) in handlers.iter().enumerate() {
                let handler_type = handler
                    .get("type")
                    .and_then(Value::as_str)
                    .unwrap_or("command")
                    .to_string();
                found.push(HookDefinitionInfo {
                    id: format!("{}:{}:{}:{}", scope, event, group_index, handler_index),
                    event: event.clone(),
                    matcher: matcher.clone(),
                    handler_type,
                    summary: hook_handler_summary(handler),
                    handler_value: hook_handler_value(handler),
                    timeout_seconds: handler.get("timeout").and_then(Value::as_u64),
                    source_digest: source_digest.clone(),
                    handler_fingerprint: hook_handler_fingerprint(event, &matcher, handler),
                    path: path.to_string_lossy().to_string(),
                    scope: scope.to_string(),
                    disabled_by_source,
                });
            }
        }
    }
    found
}

fn scan_hook_tree(
    root: &std::path::Path,
    scope: &str,
    depth: usize,
    remaining: &mut usize,
) -> Vec<HookDefinitionInfo> {
    if depth > 8 || *remaining == 0 {
        return vec![];
    }
    let Ok(entries) = std::fs::read_dir(root) else {
        return vec![];
    };
    let mut found = vec![];
    for entry in entries.flatten() {
        if *remaining == 0 {
            break;
        }
        let path = entry.path();
        if path.is_dir() {
            found.extend(scan_hook_tree(&path, scope, depth + 1, remaining));
        } else if path.file_name().and_then(|name| name.to_str()) == Some("hooks.json") {
            *remaining -= 1;
            found.extend(scan_hook_settings(&path, scope));
        }
    }
    found
}

fn hook_settings_path(scope: &str, cwd: Option<&str>) -> Result<std::path::PathBuf, String> {
    match scope {
        "user" => Ok(client_runtime::claude_config_dir()?.join("settings.json")),
        "project" | "local" => {
            let cwd = cwd
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| format!("A working directory is required for {scope} hooks"))?;
            let directory = std::path::Path::new(cwd);
            if !directory.is_absolute() || !directory.is_dir() {
                return Err(
                    "The hook working directory must be an existing absolute path".to_string(),
                );
            }
            let file = if scope == "local" {
                "settings.local.json"
            } else {
                "settings.json"
            };
            Ok(directory.join(".claude").join(file))
        }
        _ => Err("Hook scope must be user, project, or local".to_string()),
    }
}

fn build_hook_handler(request: &CreateHookRequest) -> Result<Value, String> {
    let value = request.value.trim();
    if value.is_empty() || value.len() > 16 * 1024 || value.chars().any(|ch| ch == '\0') {
        return Err("Hook handler content is empty or invalid".to_string());
    }
    let timeout = request.timeout_seconds.unwrap_or(30).clamp(1, 600);
    match request.handler_type.as_str() {
        "command" => Ok(serde_json::json!({
            "type": "command",
            "command": value,
            "timeout": timeout
        })),
        "http" => Ok(serde_json::json!({
            "type": "http",
            "url": value,
            "timeout": timeout
        })),
        "prompt" => Ok(serde_json::json!({"type": "prompt", "prompt": value})),
        "agent" => Ok(serde_json::json!({"type": "agent", "prompt": value})),
        "mcp_tool" => Ok(serde_json::json!({"type": "mcp_tool", "tool": value})),
        _ => Err("Unsupported Hook handler type".to_string()),
    }
}

const HOOK_EVENTS: &[&str] = &[
    "PreToolUse",
    "PermissionRequest",
    "PermissionDenied",
    "PostToolUse",
    "PostToolUseFailure",
    "PostToolBatch",
    "Notification",
    "UserPromptSubmit",
    "UserPromptExpansion",
    "SessionStart",
    "SessionEnd",
    "Stop",
    "StopFailure",
    "SubagentStart",
    "SubagentStop",
    "TeammateIdle",
    "TaskCreated",
    "TaskCompleted",
    "PreCompact",
    "PostCompact",
    "Setup",
    "ConfigChange",
    "InstructionsLoaded",
    "CwdChanged",
    "FileChanged",
    "Elicitation",
    "WorktreeCreate",
    "WorktreeRemove",
];

fn validate_hook_event(event: &str) -> Result<&str, String> {
    let event = event.trim();
    HOOK_EVENTS
        .contains(&event)
        .then_some(event)
        .ok_or_else(|| "Unsupported Claude Code Hook event".to_string())
}

#[tauri::command]
async fn list_hook_events() -> Vec<String> {
    HOOK_EVENTS
        .iter()
        .map(|event| (*event).to_string())
        .collect()
}

#[tauri::command]
async fn create_hook_definition(
    cwd: Option<String>,
    request: CreateHookRequest,
) -> Result<HookDefinitionInfo, String> {
    let event = validate_hook_event(&request.event)?.to_string();
    let path = hook_settings_path(&request.scope, cwd.as_deref())?;
    let handler = build_hook_handler(&request)?;
    let matcher = request.matcher.as_deref().unwrap_or("").trim().to_string();
    if matcher.len() > 1024 || matcher.chars().any(|ch| ch == '\0') {
        return Err("Hook matcher is invalid".to_string());
    }

    let _mutation_lock = hook_settings_mutation_lock()
        .lock()
        .map_err(|_| "Hook settings mutation lock is unavailable".to_string())?;
    let (mut document, source_digest) = hook_settings_snapshot(&path)?;
    let hooks = document
        .entry("hooks".to_string())
        .or_insert_with(|| Value::Object(serde_json::Map::new()))
        .as_object_mut()
        .ok_or_else(|| "Claude settings hooks must be a JSON object".to_string())?;
    let groups = hooks
        .entry(event.clone())
        .or_insert_with(|| Value::Array(vec![]))
        .as_array_mut()
        .ok_or_else(|| format!("Claude settings hooks.{event} must be an array"))?;
    let candidate = serde_json::json!({
        "matcher": matcher.clone(),
        "hooks": [handler.clone()]
    });
    if groups.iter().any(|group| group == &candidate) {
        return Err("This Hook already exists in the selected scope".to_string());
    }
    let group_index = groups.len();
    groups.push(candidate);
    let encoded = serde_json::to_vec_pretty(&Value::Object(document))
        .map_err(|error| format!("Cannot encode Claude Hook settings: {error}"))?;
    verify_hook_source_unchanged(&path, &source_digest)?;
    atomic_write_bytes(&path, &encoded, "Claude Hook settings")?;
    let handler_fingerprint = hook_handler_fingerprint(&event, &matcher, &handler);

    Ok(HookDefinitionInfo {
        id: format!("{}:{}:{}:0", request.scope, event, group_index),
        event,
        matcher,
        handler_type: request.handler_type,
        summary: hook_handler_summary(&handler),
        handler_value: hook_handler_value(&handler),
        timeout_seconds: handler.get("timeout").and_then(Value::as_u64),
        source_digest: hook_sha256(&encoded),
        handler_fingerprint,
        path: path.to_string_lossy().to_string(),
        scope: request.scope,
        disabled_by_source: false,
    })
}

fn parse_editable_hook_id(id: &str) -> Result<(&str, &str, usize, usize), String> {
    let parts: Vec<&str> = id.split(':').collect();
    if parts.len() != 4 || !matches!(parts[0], "user" | "project" | "local") {
        return Err("Only user, project, and local Hooks can be changed".to_string());
    }
    let group_index = parts[2]
        .parse::<usize>()
        .map_err(|_| "Hook identifier is invalid".to_string())?;
    let handler_index = parts[3]
        .parse::<usize>()
        .map_err(|_| "Hook identifier is invalid".to_string())?;
    Ok((parts[0], parts[1], group_index, handler_index))
}

fn validate_hook_guard_path(
    expected_path: &std::path::Path,
    provided_path: &str,
) -> Result<(), String> {
    let expected = std::fs::canonicalize(expected_path)
        .map_err(|_| "Hook source no longer exists; refresh and try again".to_string())?;
    let provided = std::fs::canonicalize(provided_path)
        .map_err(|_| "Hook source no longer exists; refresh and try again".to_string())?;
    if expected != provided {
        return Err("Hook source changed; refresh and try again".to_string());
    }
    Ok(())
}

fn hook_handler_snapshot(
    document: &serde_json::Map<String, Value>,
    event: &str,
    group_index: usize,
    handler_index: usize,
) -> Result<(String, Value), String> {
    let group = document
        .get("hooks")
        .and_then(Value::as_object)
        .and_then(|hooks| hooks.get(event))
        .and_then(Value::as_array)
        .and_then(|groups| groups.get(group_index))
        .ok_or_else(|| "Hook no longer exists; refresh and try again".to_string())?;
    let matcher = group
        .get("matcher")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let handler = group
        .get("hooks")
        .and_then(Value::as_array)
        .and_then(|handlers| handlers.get(handler_index))
        .cloned()
        .ok_or_else(|| "Hook no longer exists; refresh and try again".to_string())?;
    Ok((matcher, handler))
}

fn patch_hook_handler(existing: &Value, request: &CreateHookRequest) -> Result<Value, String> {
    let existing_type = existing.get("type").and_then(Value::as_str).unwrap_or("");
    if existing_type != request.handler_type {
        return build_hook_handler(request);
    }
    let mut handler = existing
        .as_object()
        .cloned()
        .ok_or_else(|| "Hook handler must be a JSON object".to_string())?;
    let value = request.value.trim();
    if value.is_empty() || value.len() > 16 * 1024 || value.chars().any(|ch| ch == '\0') {
        return Err("Hook handler content is empty or invalid".to_string());
    }
    handler.insert(
        "type".to_string(),
        Value::String(request.handler_type.clone()),
    );
    let primary_field = match request.handler_type.as_str() {
        "command" => "command",
        "http" => "url",
        "prompt" | "agent" => "prompt",
        "mcp_tool" => "tool",
        _ => return Err("Unsupported Hook handler type".to_string()),
    };
    handler.insert(primary_field.to_string(), Value::String(value.to_string()));
    if matches!(request.handler_type.as_str(), "command" | "http") {
        handler.insert(
            "timeout".to_string(),
            Value::Number(request.timeout_seconds.unwrap_or(30).clamp(1, 600).into()),
        );
    }
    Ok(Value::Object(handler))
}

fn remove_hook_handler_from_document(
    document: &mut serde_json::Map<String, Value>,
    event: &str,
    group_index: usize,
    handler_index: usize,
) -> Result<Value, String> {
    let hooks = document
        .get_mut("hooks")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| "Claude settings hooks must be a JSON object".to_string())?;
    let mut remove_event = false;
    let removed = {
        let groups = hooks
            .get_mut(event)
            .and_then(Value::as_array_mut)
            .ok_or_else(|| "Hook event no longer exists; refresh and try again".to_string())?;
        let group = groups
            .get_mut(group_index)
            .and_then(Value::as_object_mut)
            .ok_or_else(|| "Hook group no longer exists; refresh and try again".to_string())?;
        let handlers = group
            .get_mut("hooks")
            .and_then(Value::as_array_mut)
            .ok_or_else(|| "Hook handler list is invalid".to_string())?;
        if handler_index >= handlers.len() {
            return Err("Hook handler no longer exists; refresh and try again".to_string());
        }
        let removed = handlers.remove(handler_index);
        if handlers.is_empty() {
            groups.remove(group_index);
        }
        if groups.is_empty() {
            remove_event = true;
        }
        removed
    };
    if remove_event {
        hooks.remove(event);
    }
    Ok(removed)
}

fn append_hook_group(
    document: &mut serde_json::Map<String, Value>,
    event: &str,
    matcher: &str,
    handler: Value,
) -> Result<usize, String> {
    let hooks = document
        .entry("hooks".to_string())
        .or_insert_with(|| Value::Object(serde_json::Map::new()))
        .as_object_mut()
        .ok_or_else(|| "Claude settings hooks must be a JSON object".to_string())?;
    let groups = hooks
        .entry(event.to_string())
        .or_insert_with(|| Value::Array(vec![]))
        .as_array_mut()
        .ok_or_else(|| format!("Claude settings hooks.{event} must be an array"))?;
    let candidate = serde_json::json!({
        "matcher": matcher,
        "hooks": [handler]
    });
    if groups.iter().any(|group| group == &candidate) {
        return Err("This Hook already exists in the selected scope".to_string());
    }
    let group_index = groups.len();
    groups.push(candidate);
    Ok(group_index)
}

#[tauri::command]
async fn update_hook_definition(
    cwd: Option<String>,
    guard: HookMutationGuard,
    request: CreateHookRequest,
) -> Result<HookDefinitionInfo, String> {
    let (scope, old_event, group_index, handler_index) = parse_editable_hook_id(&guard.id)?;
    if request.scope != scope {
        return Err("Hook scope cannot be changed while editing".to_string());
    }
    let requested_event = request.event.trim();
    let event = if requested_event == old_event {
        // Preserve an existing event introduced by a newer Claude Code version
        // even when this Black Box build does not know it yet. Creating or
        // switching to an unknown event still requires a runtime update.
        old_event.to_string()
    } else {
        validate_hook_event(requested_event)?.to_string()
    };
    let matcher = request.matcher.as_deref().unwrap_or("").trim().to_string();
    if matcher.len() > 1024 || matcher.chars().any(|ch| ch == '\0') {
        return Err("Hook matcher is invalid".to_string());
    }
    let path = hook_settings_path(scope, cwd.as_deref())?;
    validate_hook_guard_path(&path, &guard.path)?;
    let _mutation_lock = hook_settings_mutation_lock()
        .lock()
        .map_err(|_| "Hook settings mutation lock is unavailable".to_string())?;
    let (mut document, source_digest) = hook_settings_snapshot(&path)?;
    if source_digest != guard.source_digest {
        return Err(
            "Hook configuration changed outside Black Box; refresh and try again".to_string(),
        );
    }
    let (old_matcher, existing_handler) =
        hook_handler_snapshot(&document, old_event, group_index, handler_index)?;
    if hook_handler_fingerprint(old_event, &old_matcher, &existing_handler)
        != guard.handler_fingerprint
    {
        return Err("Hook changed outside Black Box; refresh and try again".to_string());
    }
    let handler = patch_hook_handler(&existing_handler, &request)?;
    let disabled_by_source = document
        .get("disableAllHooks")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    let (new_group_index, new_handler_index) = if event == old_event && matcher == old_matcher {
        let handlers = document
            .get_mut("hooks")
            .and_then(Value::as_object_mut)
            .and_then(|hooks| hooks.get_mut(old_event))
            .and_then(Value::as_array_mut)
            .and_then(|groups| groups.get_mut(group_index))
            .and_then(|group| group.get_mut("hooks"))
            .and_then(Value::as_array_mut)
            .ok_or_else(|| "Hook no longer exists; refresh and try again".to_string())?;
        if handler_index >= handlers.len() {
            return Err("Hook no longer exists; refresh and try again".to_string());
        }
        handlers[handler_index] = handler.clone();
        (group_index, handler_index)
    } else {
        remove_hook_handler_from_document(&mut document, old_event, group_index, handler_index)?;
        (
            append_hook_group(&mut document, &event, &matcher, handler.clone())?,
            0,
        )
    };

    let encoded = serde_json::to_vec_pretty(&Value::Object(document))
        .map_err(|error| format!("Cannot encode Claude Hook settings: {error}"))?;
    verify_hook_source_unchanged(&path, &source_digest)?;
    atomic_write_bytes(&path, &encoded, "Claude Hook settings")?;
    let handler_fingerprint = hook_handler_fingerprint(&event, &matcher, &handler);

    Ok(HookDefinitionInfo {
        id: format!(
            "{}:{}:{}:{}",
            request.scope, event, new_group_index, new_handler_index
        ),
        event,
        matcher,
        handler_type: request.handler_type,
        summary: hook_handler_summary(&handler),
        handler_value: hook_handler_value(&handler),
        timeout_seconds: handler.get("timeout").and_then(Value::as_u64),
        source_digest: hook_sha256(&encoded),
        handler_fingerprint,
        path: path.to_string_lossy().to_string(),
        scope: request.scope,
        disabled_by_source,
    })
}

#[tauri::command]
async fn delete_hook_definition(
    cwd: Option<String>,
    guard: HookMutationGuard,
) -> Result<(), String> {
    let (scope, event, group_index, handler_index) = parse_editable_hook_id(&guard.id)?;
    let path = hook_settings_path(scope, cwd.as_deref())?;
    validate_hook_guard_path(&path, &guard.path)?;
    let _mutation_lock = hook_settings_mutation_lock()
        .lock()
        .map_err(|_| "Hook settings mutation lock is unavailable".to_string())?;
    let (mut document, source_digest) = hook_settings_snapshot(&path)?;
    if source_digest != guard.source_digest {
        return Err(
            "Hook configuration changed outside Black Box; refresh and try again".to_string(),
        );
    }
    let (matcher, handler) = hook_handler_snapshot(&document, event, group_index, handler_index)?;
    if hook_handler_fingerprint(event, &matcher, &handler) != guard.handler_fingerprint {
        return Err("Hook changed outside Black Box; refresh and try again".to_string());
    }
    remove_hook_handler_from_document(&mut document, event, group_index, handler_index)?;
    let encoded = serde_json::to_vec_pretty(&Value::Object(document))
        .map_err(|error| format!("Cannot encode Claude Hook settings: {error}"))?;
    verify_hook_source_unchanged(&path, &source_digest)?;
    atomic_write_bytes(&path, &encoded, "Claude Hook settings")
}

#[tauri::command]
async fn list_hook_definitions(cwd: Option<String>) -> Result<Vec<HookDefinitionInfo>, String> {
    let mut hooks = vec![HookDefinitionInfo {
        id: "built-in:UserPromptSubmit:time-context".to_string(),
        event: "UserPromptSubmit".to_string(),
        matcher: "*".to_string(),
        handler_type: "built-in".to_string(),
        summary: "Black Box · Time Context — injects the computer's live local time into every prompt without exposing it in the chat.".to_string(),
        handler_value: String::new(),
        timeout_seconds: None,
        source_digest: String::new(),
        handler_fingerprint: String::new(),
        path: String::new(),
        scope: "built-in".to_string(),
        disabled_by_source: false,
    }];
    let private_claude = client_runtime::claude_config_dir()?;
    hooks.extend(scan_hook_settings(
        &private_claude.join("settings.json"),
        "user",
    ));
    let mut remaining = 256;
    hooks.extend(scan_hook_tree(
        &private_claude.join("plugins").join("cache"),
        "plugin",
        0,
        &mut remaining,
    ));
    if let Some(cwd) = cwd.filter(|value| !value.trim().is_empty()) {
        let claude_dir = std::path::Path::new(&cwd).join(".claude");
        hooks.extend(scan_hook_settings(
            &claude_dir.join("settings.json"),
            "project",
        ));
        hooks.extend(scan_hook_settings(
            &claude_dir.join("settings.local.json"),
            "local",
        ));
    }
    #[cfg(target_os = "macos")]
    hooks.extend(scan_hook_settings(
        std::path::Path::new("/Library/Application Support/ClaudeCode/managed-settings.json"),
        "managed",
    ));
    hooks.sort_by(|left, right| {
        left.event
            .cmp(&right.event)
            .then_with(|| left.matcher.cmp(&right.matcher))
            .then_with(|| left.id.cmp(&right.id))
    });
    Ok(hooks)
}

/// Read a skill file and return its content
#[tauri::command]
async fn read_skill(
    path_access: State<'_, PathAccessManager>,
    path: String,
    tab_id: Option<String>,
) -> Result<String, String> {
    let p = path_access
        .validate(
            std::path::Path::new(&path),
            tab_id.as_deref(),
            PathCapability::Read,
        )
        .await?;
    std::fs::read_to_string(&p).map_err(|e| format!("Cannot read skill file: {}", e))
}

/// Write content to a skill file, creating parent directories if needed
#[tauri::command]
async fn write_skill(
    path_access: State<'_, PathAccessManager>,
    path: String,
    content: String,
    tab_id: Option<String>,
) -> Result<(), String> {
    let p = path_access
        .validate(
            std::path::Path::new(&path),
            tab_id.as_deref(),
            PathCapability::Write,
        )
        .await?;
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create directories: {}", e))?;
    }
    std::fs::write(&p, &content).map_err(|e| format!("Cannot write skill file: {}", e))
}

/// Delete a skill file; remove the parent directory if it becomes empty
#[tauri::command]
async fn delete_skill(
    path_access: State<'_, PathAccessManager>,
    path: String,
    tab_id: Option<String>,
) -> Result<(), String> {
    let p = path_access
        .validate(
            std::path::Path::new(&path),
            tab_id.as_deref(),
            PathCapability::Delete,
        )
        .await?;
    let p = p.as_path();
    std::fs::remove_file(p).map_err(|e| format!("Failed to delete skill file: {}", e))?;

    // If the parent directory is now empty, remove it too
    if let Some(parent) = p.parent() {
        if parent.is_dir() {
            let is_empty = std::fs::read_dir(parent)
                .map(|mut entries| entries.next().is_none())
                .unwrap_or(false);
            if is_empty {
                let _ = std::fs::remove_dir(parent);
            }
        }
    }

    Ok(())
}

/// Unified endpoint that returns all commands and skills in a single call
#[tauri::command]
async fn list_all_commands(cwd: Option<String>) -> Result<Vec<UnifiedCommand>, String> {
    let mut commands: Vec<UnifiedCommand> = vec![];

    // Black Box owns only UI-level composer controls. Claude Code commands,
    // bundled skills/workflows, plugin commands, and MCP prompts enter through
    // the live runtime inventory emitted by system:init/commands_changed.
    let blackbox_commands: &[(&str, &str, bool)] = &[
        (
            "/ask",
            "Switch to manual permission mode (legacy alias)",
            false,
        ),
        ("/auto", "Switch to automatic permission mode", false),
        (
            "/bypass",
            "Switch to bypass mode (skip all permission prompts)",
            false,
        ),
        ("/code", "Switch to code mode (default)", false),
        ("/manual", "Switch to manual permission mode", false),
        ("/todos", "View the persistent thread Plan", false),
    ];
    for (name, description, has_args) in blackbox_commands {
        commands.push(UnifiedCommand {
            name: name.to_string(),
            description: description.to_string(),
            source: "builtin".to_string(),
            category: "builtin".to_string(),
            owner: "blackbox".to_string(),
            kind: "command".to_string(),
            availability: "available".to_string(),
            has_args: *has_args,
            path: None,
            immediate: true,
            argument_hint: None,
            aliases: vec![],
            execution: Some("ui".to_string()),
        });
    }

    fn read_small_text_file(path: &std::path::Path) -> String {
        const MAX_COMMAND_FILE_BYTES: u64 = 1024 * 1024;
        if std::fs::metadata(path)
            .map(|metadata| metadata.len() > MAX_COMMAND_FILE_BYTES)
            .unwrap_or(true)
        {
            return String::new();
        }
        std::fs::read_to_string(path).unwrap_or_default()
    }

    fn command_name_from_relative(path: &std::path::Path, root: &std::path::Path) -> String {
        let relative = path.strip_prefix(root).unwrap_or(path);
        let mut parts: Vec<String> = relative
            .components()
            .filter_map(|component| match component {
                std::path::Component::Normal(value) => Some(value.to_string_lossy().to_string()),
                _ => None,
            })
            .collect();
        if let Some(last) = parts.last_mut() {
            *last = last.trim_end_matches(".md").to_string();
        }
        format!("/{}", parts.join(":"))
    }

    // Legacy command files may be nested. Claude exposes nested directories as
    // command namespaces, so preserve that structure as `/parent:child`.
    fn scan_commands_dir(dir: &std::path::Path, source: &str) -> Vec<UnifiedCommand> {
        fn walk(
            root: &std::path::Path,
            dir: &std::path::Path,
            source: &str,
            depth: usize,
            cmds: &mut Vec<UnifiedCommand>,
        ) {
            if depth > 4 || cmds.len() >= 512 {
                return;
            }
            let entries = match std::fs::read_dir(dir) {
                Ok(entries) => entries,
                Err(_) => return,
            };
            for entry in entries.flatten() {
                let path = entry.path();
                let file_type = match entry.file_type() {
                    Ok(file_type) => file_type,
                    Err(_) => continue,
                };
                if file_type.is_dir() {
                    walk(root, &path, source, depth + 1, cmds);
                    continue;
                }
                if !file_type.is_file()
                    || path.extension().and_then(|extension| extension.to_str()) != Some("md")
                {
                    continue;
                }
                let name = command_name_from_relative(&path, root);
                let fallback = name.trim_start_matches('/').replace(':', " ");
                let content = read_small_text_file(&path);
                let description = content
                    .lines()
                    .find(|line| !line.trim().is_empty() && line.trim() != "---")
                    .map(|line| line.trim_start_matches('#').trim().to_string())
                    .filter(|value| !value.is_empty())
                    .unwrap_or(fallback);
                let has_args = content.contains("$ARGUMENTS") || content.contains("$1");
                cmds.push(UnifiedCommand {
                    name,
                    description,
                    source: source.to_string(),
                    category: "command".to_string(),
                    owner: "filesystem".to_string(),
                    kind: "command".to_string(),
                    availability: "provisional".to_string(),
                    has_args,
                    path: Some(path.to_string_lossy().to_string()),
                    immediate: false,
                    argument_hint: has_args.then(|| "$ARGUMENTS".to_string()),
                    aliases: vec![],
                    execution: None,
                });
            }
        }

        let mut cmds = vec![];
        walk(dir, dir, source, 0, &mut cmds);
        cmds
    }

    // Skills are allowed in nested collections (for example a synced company
    // bundle). Discover every bounded SKILL.md rather than only one directory
    // below the configured root.
    fn scan_skills_dir(dir: &std::path::Path, source: &str) -> Vec<UnifiedCommand> {
        fn walk(
            dir: &std::path::Path,
            source: &str,
            depth: usize,
            found: &mut Vec<UnifiedCommand>,
        ) {
            if depth > 5 || found.len() >= 512 {
                return;
            }
            let entries = match std::fs::read_dir(dir) {
                Ok(entries) => entries,
                Err(_) => return,
            };
            for entry in entries.flatten() {
                let entry_path = entry.path();
                let file_type = match entry.file_type() {
                    Ok(file_type) => file_type,
                    Err(_) => continue,
                };
                if file_type.is_dir() {
                    walk(&entry_path, source, depth + 1, found);
                    continue;
                }
                if !file_type.is_file()
                    || entry_path.file_name().and_then(|value| value.to_str()) != Some("SKILL.md")
                {
                    continue;
                }
                let name = entry_path
                    .parent()
                    .and_then(std::path::Path::file_name)
                    .map(|value| value.to_string_lossy().to_string())
                    .unwrap_or_default();
                if name.is_empty() {
                    continue;
                }
                let content = read_small_text_file(&entry_path);
                let (fm, body) = parse_skill_frontmatter(&content);
                let description = fm
                    .description
                    .clone()
                    .or_else(|| {
                        body.lines()
                            .find(|line| !line.trim().is_empty())
                            .map(|line| line.trim_start_matches('#').trim().to_string())
                    })
                    .unwrap_or_else(|| name.clone());
                found.push(UnifiedCommand {
                    name: format!("/{}", name),
                    description,
                    source: source.to_string(),
                    category: "skill".to_string(),
                    owner: "filesystem".to_string(),
                    kind: "skill".to_string(),
                    availability: "provisional".to_string(),
                    has_args: fm.argument_hint.is_some(),
                    path: Some(entry_path.to_string_lossy().to_string()),
                    immediate: false,
                    argument_hint: fm.argument_hint.clone(),
                    aliases: vec![],
                    execution: None,
                });
            }
        }

        let mut found = vec![];
        walk(dir, source, 0, &mut found);
        found
    }

    // 2. Black Box user commands.
    let private_claude = client_runtime::claude_config_dir()?;
    commands.extend(scan_commands_dir(
        &private_claude.join("commands"),
        "global",
    ));

    // 3. Black Box user skills.
    commands.extend(scan_skills_dir(&private_claude.join("skills"), "global"));

    // 4. Project-local configuration follows the active file upward. Scan
    // outer roots first and the nearest root last so the nearest definition
    // wins during stable de-duplication below.
    if let Some(ref cwd_path) = cwd {
        let canonical =
            std::fs::canonicalize(cwd_path).unwrap_or_else(|_| std::path::PathBuf::from(cwd_path));
        let home = dirs::home_dir();
        let mut roots: Vec<std::path::PathBuf> = canonical
            .ancestors()
            .take(32)
            .take_while(|ancestor| {
                home.as_ref()
                    .map(|home_dir| {
                        *ancestor != home_dir.as_path() && ancestor.starts_with(home_dir)
                    })
                    .unwrap_or(true)
            })
            .map(std::path::Path::to_path_buf)
            .collect();
        roots.reverse();
        for root in roots {
            let claude_dir = root.join(".claude");
            commands.extend(scan_commands_dir(&claude_dir.join("commands"), "project"));
            commands.extend(scan_skills_dir(&claude_dir.join("skills"), "project"));
        }
    }

    let mut deduped: Vec<UnifiedCommand> = vec![];
    let mut positions: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for command in commands {
        let key = command.name.to_lowercase();
        if let Some(position) = positions.get(&key).copied() {
            // Black Box UI controls are reserved. Claude's documented personal
            // scope outranks project scope; within one scope the later entry
            // wins so a skill can override a legacy command and the nearest
            // project root can override an outer project root.
            let existing = &deduped[position];
            let should_replace = existing.owner != "blackbox"
                && (command.owner == "blackbox"
                    || command.source == existing.source
                    || (command.source == "global" && existing.source == "project"));
            if should_replace {
                deduped[position] = command;
            }
            continue;
        }
        positions.insert(key, deduped.len());
        deduped.push(command);
    }

    Ok(deduped)
}

/// Toggle a skill's enabled/disabled state by writing/removing
/// `disable-model-invocation` in its YAML frontmatter.
#[tauri::command]
async fn toggle_skill_enabled(
    path_access: State<'_, PathAccessManager>,
    path: String,
    enabled: bool,
    tab_id: Option<String>,
) -> Result<(), String> {
    let p = path_access
        .validate(
            std::path::Path::new(&path),
            tab_id.as_deref(),
            PathCapability::Write,
        )
        .await?;
    let content =
        std::fs::read_to_string(&p).map_err(|e| format!("Cannot read skill file: {}", e))?;
    let new_content = if enabled {
        // Remove disable-model-invocation (or set to false)
        update_frontmatter_field(&content, "disable-model-invocation", None)
    } else {
        // Set disable-model-invocation: true
        update_frontmatter_field(&content, "disable-model-invocation", Some("true"))
    };
    std::fs::write(&p, &new_content).map_err(|e| format!("Cannot write skill file: {}", e))
}

// --- Git / Shell helpers for Rewind code restore ---

/// Resolve a usable git binary path on macOS without triggering the Xcode CLT install popup.
///
/// **Why this exists**: macOS ships `/usr/bin/git` as a shim. When Xcode Command Line Tools
/// (CLT) are not installed, running `/usr/bin/git` spawns a **GUI dialog** asking the user to
/// install CLT. BLACKBOX calls git for snapshot/rewind on every message, so this popup
/// would appear repeatedly.
///
/// Strategy:
///   1. `xcode-select -p` — checks if CLT is installed (silent, never triggers popup).
///   2. CLT installed → safe to use bare "git" (resolves to /usr/bin/git which works).
///   3. CLT not installed → scan known third-party git locations (Homebrew, MacPorts, Nix, etc.)
///      skipping `/usr/bin/git` (the shim) to avoid the popup.
///   4. Nothing found → return None; caller returns Err without spawning any process.
///
/// Result is cached for the process lifetime via OnceLock.
#[cfg(target_os = "macos")]
fn resolve_git_binary() -> Option<&'static str> {
    static GIT_BIN: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();
    GIT_BIN
        .get_or_init(|| {
            // Check if Xcode CLT is installed (xcode-select -p does NOT trigger popup)
            let clt_check = std::process::Command::new("xcode-select")
                .arg("-p")
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
            if let Ok(status) = clt_check {
                if status.success() {
                    // CLT installed → /usr/bin/git works, use bare "git" to respect PATH order
                    return Some("git".to_string());
                }
            }

            // CLT not installed → scan known third-party git install locations.
            // IMPORTANT: Do NOT include /usr/bin/git here — that's the shim that triggers the popup.
            let candidates = [
                "/opt/homebrew/bin/git",                 // Homebrew (Apple Silicon)
                "/usr/local/bin/git",                    // Homebrew (Intel) or manual install
                "/opt/local/bin/git",                    // MacPorts
                "/nix/var/nix/profiles/default/bin/git", // Nix
            ];
            for path in &candidates {
                if std::path::Path::new(path).exists() {
                    eprintln!("resolve_git_binary: CLT not installed, using {}", path);
                    return Some(path.to_string());
                }
            }

            eprintln!("resolve_git_binary: no git found (CLT not installed, no third-party git)");
            None
        })
        .as_deref()
}

/// Run a git command in a specific working directory and return stdout.
/// Only allows safe, read-or-restore git operations.
#[tauri::command]
async fn run_git_command(cwd: String, args: Vec<String>) -> Result<String, String> {
    // Allowlist: only safe git subcommands
    let allowed_subcommands = [
        "status",
        "diff",
        "log",
        "show",
        "stash",
        "checkout",
        "rev-parse",
        "hash-object",
        "cat-file",
    ];
    let subcmd = args.first().map(|s| s.as_str()).unwrap_or("");
    if !allowed_subcommands.contains(&subcmd) {
        return Err(format!("Git subcommand '{}' not allowed", subcmd));
    }

    // P1-1: Reject null bytes in args (could truncate strings in C-level APIs)
    for arg in &args {
        if arg.contains('\0') {
            return Err("Arguments must not contain null bytes".to_string());
        }
    }

    // P1-1: Validate cwd is an existing directory
    let cwd_path = std::path::Path::new(&cwd);
    if !cwd_path.is_dir() {
        return Err(format!("Working directory does not exist: {}", cwd));
    }

    // P1-1: Reject dangerous git flags that could enable command execution
    let dangerous_prefixes = ["-c", "--exec", "--upload-pack", "--receive-pack"];
    for arg in &args[1..] {
        let lower = arg.to_lowercase();
        for prefix in &dangerous_prefixes {
            if lower == *prefix || lower.starts_with(&format!("{}=", prefix)) {
                return Err(format!("Git flag '{}' not allowed", arg));
            }
        }
    }

    // On macOS, resolve git binary without triggering Xcode CLT popup
    #[cfg(target_os = "macos")]
    let git_bin = resolve_git_binary()
        .ok_or_else(|| "git not available (no Xcode CLT or Homebrew git found)".to_string())?;
    #[cfg(not(target_os = "macos"))]
    let git_bin = "git";

    let mut cmd = Command::new(git_bin);
    cmd.args(&args).current_dir(&cwd);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000);
    let output = cmd
        .output()
        .await
        .map_err(|e| format!("Failed to run git: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        return Err(format!("git {} failed: {}", subcmd, stderr));
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

const MAX_CONVERSATION_REWIND_BYTES: u64 = 256 * 1024 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConversationRewindResult {
    retained_lines: usize,
    removed_lines: usize,
    backup_path: String,
}

struct PreparedConversationRewind {
    staged: tempfile::NamedTempFile,
    result: ConversationRewindResult,
}

fn prepare_conversation_rewind_at(
    session_path: &std::path::Path,
    session_id: &str,
    checkpoint_uuid: &str,
    backup_root: &std::path::Path,
) -> Result<PreparedConversationRewind, String> {
    use std::io::Write;

    let metadata = std::fs::metadata(session_path)
        .map_err(|error| format!("Failed to inspect session before rewind: {error}"))?;
    if metadata.len() > MAX_CONVERSATION_REWIND_BYTES {
        return Err(format!(
            "Session is too large to rewind safely ({} bytes)",
            metadata.len()
        ));
    }

    let source = std::fs::read_to_string(session_path)
        .map_err(|error| format!("Failed to read session before rewind: {error}"))?;
    let lines: Vec<&str> = source.split_inclusive('\n').collect();
    let checkpoint_index = lines
        .iter()
        .position(|line| {
            let Ok(value) = serde_json::from_str::<Value>(line.trim_end_matches(['\r', '\n']))
            else {
                return false;
            };
            let is_user = matches!(
                value.get("type").and_then(Value::as_str),
                Some("user" | "human")
            ) || value
                .get("message")
                .and_then(|message| message.get("role"))
                .and_then(Value::as_str)
                == Some("user");
            let is_meta = value.get("isMeta").and_then(Value::as_bool) == Some(true);
            is_user
                && !is_meta
                && value.get("uuid").and_then(Value::as_str) == Some(checkpoint_uuid)
        })
        .ok_or_else(|| "The selected conversation checkpoint was not found".to_string())?;

    let retained = lines[..checkpoint_index].concat();
    if !retained.lines().any(|line| {
        serde_json::from_str::<Value>(line)
            .ok()
            .and_then(|value| value.get("type").and_then(Value::as_str).map(str::to_owned))
            .is_some_and(|kind| kind == "user" || kind == "human" || kind == "assistant")
    }) {
        return Err(
            "The first turn cannot be rewound in place; start a new task instead".to_string(),
        );
    }

    std::fs::create_dir_all(backup_root)
        .map_err(|error| format!("Failed to create rewind backup directory: {error}"))?;
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| format!("System clock error while creating rewind backup: {error}"))?
        .as_millis();
    let backup_path = backup_root.join(format!(
        "{session_id}--{checkpoint_uuid}--{timestamp}.jsonl"
    ));
    std::fs::copy(session_path, &backup_path)
        .map_err(|error| format!("Failed to create rewind backup: {error}"))?;
    std::fs::File::open(&backup_path)
        .and_then(|file| file.sync_all())
        .map_err(|error| format!("Failed to sync rewind backup: {error}"))?;

    let parent = session_path
        .parent()
        .ok_or_else(|| "Session path has no parent directory".to_string())?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)
        .map_err(|error| format!("Failed to stage rewound session: {error}"))?;
    temporary
        .as_file_mut()
        .set_permissions(metadata.permissions())
        .map_err(|error| format!("Failed to preserve session permissions: {error}"))?;
    temporary
        .write_all(retained.as_bytes())
        .and_then(|_| temporary.flush())
        .and_then(|_| temporary.as_file().sync_all())
        .map_err(|error| format!("Failed to write rewound session: {error}"))?;
    Ok(PreparedConversationRewind {
        staged: temporary,
        result: ConversationRewindResult {
            retained_lines: checkpoint_index,
            removed_lines: lines.len().saturating_sub(checkpoint_index),
            backup_path: backup_path.to_string_lossy().to_string(),
        },
    })
}

fn publish_prepared_conversation_rewind(
    prepared: PreparedConversationRewind,
    session_path: &std::path::Path,
) -> Result<ConversationRewindResult, String> {
    prepared
        .staged
        .persist(session_path)
        .map_err(|error| format!("Failed to publish rewound session: {}", error.error))?;
    Ok(prepared.result)
}

fn rewind_conversation_file_at(
    session_path: &std::path::Path,
    session_id: &str,
    checkpoint_uuid: &str,
    backup_root: &std::path::Path,
) -> Result<ConversationRewindResult, String> {
    let prepared =
        prepare_conversation_rewind_at(session_path, session_id, checkpoint_uuid, backup_root)?;
    publish_prepared_conversation_rewind(prepared, session_path)
}

/// Rewind Claude's durable conversation graph to immediately before a selected
/// user turn. The original JSONL is copied to Black Box recovery storage before
/// an atomic replacement, so the UI and the next `--resume` share one history.
#[tauri::command]
async fn rewind_session_conversation(
    session_id: String,
    checkpoint_uuid: String,
) -> Result<ConversationRewindResult, String> {
    uuid::Uuid::parse_str(&session_id)
        .map_err(|_| format!("Invalid session_id format: {session_id}"))?;
    uuid::Uuid::parse_str(&checkpoint_uuid)
        .map_err(|_| format!("Invalid checkpoint_uuid format: {checkpoint_uuid}"))?;
    let session_path = find_session_jsonl(&session_id)
        .ok_or_else(|| format!("Session JSONL not found for id: {session_id}"))?;
    let home = dirs::home_dir().ok_or_else(|| "Cannot find home directory".to_string())?;
    let backup_root = home
        .join(".blackbox")
        .join("session-rewind-backups")
        .join(&session_id);
    tauri::async_runtime::spawn_blocking(move || {
        rewind_conversation_file_at(&session_path, &session_id, &checkpoint_uuid, &backup_root)
    })
    .await
    .map_err(|error| format!("Conversation rewind worker failed: {error}"))?
}

async fn run_rewind_files_cli(
    session_id: &str,
    checkpoint_uuid: &str,
    cwd: &str,
) -> Result<String, String> {
    let claude_bin = resolve_claude_sdk_runtime()?.path;

    let enriched_path = build_enriched_path();

    let mut rewind_cmd = tokio::process::Command::new(&claude_bin);
    rewind_cmd
        .args(["--resume", session_id, "--rewind-files", checkpoint_uuid])
        .current_dir(cwd)
        .env("PATH", &enriched_path)
        .env("CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING", "1")
        .env_remove("CLAUDECODE");
    client_runtime::apply_to_tokio_command(&mut rewind_cmd)?;
    // Disable MSYS2 auto path conversion on Windows (Chinese path fix)
    #[cfg(target_os = "windows")]
    rewind_cmd
        .env("MSYS_NO_PATHCONV", "1")
        .env("MSYS2_ARG_CONV_EXCL", "*");

    let output = rewind_cmd
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .output()
        .await
        .map_err(|e| format!("Failed to run claude --rewind-files: {}", e))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("rewind_files failed: {}", stderr))
    }
}

fn validate_rewind_request(
    session_id: String,
    checkpoint_uuid: String,
    cwd: String,
) -> Result<(String, String, String), String> {
    let session_id = uuid::Uuid::parse_str(&session_id)
        .map_err(|_| format!("Invalid session_id format: {session_id}"))?
        .to_string();
    let checkpoint_uuid = uuid::Uuid::parse_str(&checkpoint_uuid)
        .map_err(|_| format!("Invalid checkpoint_uuid format: {checkpoint_uuid}"))?
        .to_string();
    if !std::path::Path::new(&cwd).is_dir() {
        return Err(format!("Rewind working directory does not exist: {cwd}"));
    }
    Ok((session_id, checkpoint_uuid, cwd))
}

/// Rewind files to a CLI checkpoint via `claude --resume <session_id> --rewind-files <uuid>`.
/// This delegates file restoration to the CLI's native checkpoint system.
#[tauri::command]
async fn rewind_files(
    state: State<'_, ProcessManager>,
    session_id: String,
    checkpoint_uuid: String,
    cwd: String,
) -> Result<String, String> {
    let (session_id, checkpoint_uuid, cwd) =
        validate_rewind_request(session_id, checkpoint_uuid, cwd)?;

    // The fallback is a second Claude process using --resume. Claim the same
    // canonical CLI UUID atomically so it can never overlap a live chat CLI or
    // another fallback. The uncommitted guard releases on every return path.
    let rewind_stdin_id = format!("rewind-files-{}", uuid::Uuid::new_v4());
    let _rewind_reservation = state.reserve_session(&rewind_stdin_id, &session_id)?;
    run_rewind_files_cli(&session_id, &checkpoint_uuid, &cwd).await
}

/// Restore files and conversation as one ordered transaction. The rewound
/// JSONL is fully staged and fsynced first but remains unpublished while the
/// native CLI reads the original checkpoint graph. Only after file rewind
/// succeeds is the staged JSONL atomically promoted.
#[tauri::command]
async fn rewind_all_transaction(
    state: State<'_, ProcessManager>,
    session_id: String,
    checkpoint_uuid: String,
    cwd: String,
) -> Result<ConversationRewindResult, String> {
    let (session_id, checkpoint_uuid, cwd) =
        validate_rewind_request(session_id, checkpoint_uuid, cwd)?;
    let rewind_stdin_id = format!("rewind-all-{}", uuid::Uuid::new_v4());
    let _rewind_reservation = state.reserve_session(&rewind_stdin_id, &session_id)?;

    let session_path = find_session_jsonl(&session_id)
        .ok_or_else(|| format!("Session JSONL not found for id: {session_id}"))?;
    let home = dirs::home_dir().ok_or_else(|| "Cannot find home directory".to_string())?;
    let backup_root = home
        .join(".blackbox")
        .join("session-rewind-backups")
        .join(&session_id);
    let prepare_path = session_path.clone();
    let prepare_session = session_id.clone();
    let prepare_checkpoint = checkpoint_uuid.clone();
    let prepared = tauri::async_runtime::spawn_blocking(move || {
        prepare_conversation_rewind_at(
            &prepare_path,
            &prepare_session,
            &prepare_checkpoint,
            &backup_root,
        )
    })
    .await
    .map_err(|error| format!("Conversation rewind prepare worker failed: {error}"))??;

    // The original transcript is still present here, so Claude can resolve
    // checkpoint_uuid. On any CLI failure, dropping `prepared` removes only
    // the private staged temp; the durable conversation remains untouched.
    run_rewind_files_cli(&session_id, &checkpoint_uuid, &cwd).await?;

    tauri::async_runtime::spawn_blocking(move || {
        publish_prepared_conversation_rewind(prepared, &session_path)
    })
    .await
    .map_err(|error| format!("Conversation rewind publish worker failed: {error}"))?
}

// ── Setup: CLI Detection, Installation & Login ──────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
struct CliStatus {
    installed: bool,
    path: Option<String>,
    version: Option<String>,
    git_bash_missing: bool,
    sdk_capabilities: Option<commands::cli_resolver::CliSdkCapabilities>,
    sdk_error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
enum CliInstallMethod {
    Native,
    AppLocalNative,
    AppLocalNpm,
    HomebrewStable,
    HomebrewLatest,
    Winget,
    Apt,
    Dnf,
    Apk,
    Npm,
    VersionManager,
    DesktopBundled,
    Unknown,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CliLifecycleInfo {
    path: Option<String>,
    version: Option<String>,
    install_method: CliInstallMethod,
    release_channel: Option<String>,
    auto_updates: bool,
    can_update_in_app: bool,
    update_command: Option<String>,
    note: String,
}

fn path_matches_root(path: &str, root: Option<std::path::PathBuf>) -> bool {
    root.and_then(|value| std::fs::canonicalize(value).ok())
        .is_some_and(|root| {
            std::fs::canonicalize(path)
                .map(|candidate| candidate.starts_with(&root))
                .unwrap_or_else(|_| std::path::Path::new(path).starts_with(&root))
        })
}

fn classify_cli_install_method(path: &str) -> CliInstallMethod {
    let canonical = std::fs::canonicalize(path)
        .unwrap_or_else(|_| std::path::PathBuf::from(path))
        .to_string_lossy()
        .to_lowercase();
    let raw = path.to_lowercase();
    let combined = format!("{raw}\n{canonical}").replace('\\', "/");

    if path_matches_root(path, cli_download_dir()) {
        return CliInstallMethod::AppLocalNative;
    }
    if path_matches_root(path, npm_global_dir().ok()) {
        return CliInstallMethod::AppLocalNpm;
    }
    if combined.contains("/library/application support/claude/claude-code/") {
        return CliInstallMethod::DesktopBundled;
    }
    if combined.contains("/caskroom/claude-code@latest/") {
        return CliInstallMethod::HomebrewLatest;
    }
    if combined.contains("/caskroom/claude-code/")
        || combined.contains("/homebrew/cellar/claude-code/")
    {
        return CliInstallMethod::HomebrewStable;
    }
    if combined.contains("winget/packages/anthropic.claudecode")
        || combined.contains("microsoft/winget/links/claude")
    {
        return CliInstallMethod::Winget;
    }
    if combined.contains("/.nvm/")
        || combined.contains("/.fnm/")
        || combined.contains("/.volta/")
        || combined.contains("/.bun/")
    {
        return CliInstallMethod::VersionManager;
    }
    if combined.contains("node_modules/@anthropic-ai/claude-code")
        || combined.contains("/lib/node_modules/")
        || combined.contains("/.npm-global/")
        || combined.contains("/appdata/roaming/npm/")
    {
        return CliInstallMethod::Npm;
    }
    if combined.contains("/.local/share/claude/")
        || combined.contains("/.local/bin/claude")
        || combined.contains("/.claude/local/claude")
    {
        return CliInstallMethod::Native;
    }
    let raw_normalized = raw.replace('\\', "/");
    if raw_normalized.ends_with("/usr/bin/claude")
        || raw_normalized.ends_with("/bin/claude")
        || canonical.ends_with("/usr/bin/claude")
        || canonical.ends_with("/bin/claude")
    {
        if std::path::Path::new("/etc/alpine-release").is_file() {
            return CliInstallMethod::Apk;
        }
        if std::path::Path::new("/etc/fedora-release").is_file()
            || std::path::Path::new("/etc/redhat-release").is_file()
        {
            return CliInstallMethod::Dnf;
        }
        if std::path::Path::new("/etc/debian_version").is_file() {
            return CliInstallMethod::Apt;
        }
    }
    CliInstallMethod::Unknown
}

fn native_release_channel() -> String {
    let settings = client_runtime::claude_config_dir()
        .ok()
        .map(|root| root.join("settings.json"))
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok());
    settings
        .as_ref()
        .and_then(|value| value.get("autoUpdatesChannel"))
        .and_then(serde_json::Value::as_str)
        .filter(|value| matches!(*value, "latest" | "stable"))
        .unwrap_or("latest")
        .to_string()
}

fn cli_lifecycle_for(path: Option<String>, version: Option<String>) -> CliLifecycleInfo {
    let method = path
        .as_deref()
        .map(classify_cli_install_method)
        .unwrap_or(CliInstallMethod::Unknown);
    let (release_channel, auto_updates, can_update_in_app, update_command, note) = match method {
        CliInstallMethod::Native => (
            Some(native_release_channel()),
            false,
            true,
            Some("claude update".to_string()),
            "Official native installation; Black Box disables background checks and owns visible manual updates for the selected channel."
                .to_string(),
        ),
        CliInstallMethod::AppLocalNative => (
            Some("latest".to_string()),
            false,
            true,
            None,
            "Native binary managed by Black Box.".to_string(),
        ),
        CliInstallMethod::AppLocalNpm => (
            Some("latest".to_string()),
            false,
            true,
            None,
            "npm installation managed inside Black Box data storage.".to_string(),
        ),
        CliInstallMethod::HomebrewStable => (
            Some("stable".to_string()),
            false,
            true,
            Some("brew upgrade --cask claude-code".to_string()),
            "Homebrew stable cask; updates follow the cask rather than upstream latest."
                .to_string(),
        ),
        CliInstallMethod::HomebrewLatest => (
            Some("latest".to_string()),
            false,
            true,
            Some("brew upgrade --cask claude-code@latest".to_string()),
            "Homebrew latest cask.".to_string(),
        ),
        CliInstallMethod::Winget => (
            Some("managed".to_string()),
            false,
            true,
            Some("winget upgrade --id Anthropic.ClaudeCode --exact".to_string()),
            "WinGet installation; Windows may require Claude processes to stop first.".to_string(),
        ),
        CliInstallMethod::Apt => (
            Some("managed".to_string()),
            false,
            false,
            Some("sudo apt update && sudo apt upgrade claude-code".to_string()),
            "apt requires an interactive elevated terminal; Black Box will not request sudo."
                .to_string(),
        ),
        CliInstallMethod::Dnf => (
            Some("managed".to_string()),
            false,
            false,
            Some("sudo dnf upgrade claude-code".to_string()),
            "dnf requires an interactive elevated terminal; Black Box will not request sudo."
                .to_string(),
        ),
        CliInstallMethod::Apk => (
            Some("managed".to_string()),
            false,
            false,
            Some("doas apk update && doas apk upgrade claude-code".to_string()),
            "apk package upgrades require an elevated terminal.".to_string(),
        ),
        CliInstallMethod::Npm => (
            Some("latest".to_string()),
            false,
            true,
            Some("npm install -g @anthropic-ai/claude-code@latest".to_string()),
            "System npm installation; the same global npm prefix will be updated.".to_string(),
        ),
        CliInstallMethod::VersionManager => (
            None,
            false,
            false,
            Some("npm install -g @anthropic-ai/claude-code@latest".to_string()),
            "Run the update inside the shell that owns this Node version manager.".to_string(),
        ),
        CliInstallMethod::DesktopBundled => (
            None,
            true,
            false,
            None,
            "This CLI belongs to Claude Desktop; update Claude Desktop instead.".to_string(),
        ),
        CliInstallMethod::Unknown => (
            None,
            false,
            false,
            None,
            "Installation owner is unknown; Black Box will not overwrite it.".to_string(),
        ),
    };
    CliLifecycleInfo {
        path,
        version,
        install_method: method,
        release_channel,
        auto_updates,
        can_update_in_app,
        update_command,
        note,
    }
}

#[tauri::command]
async fn get_cli_lifecycle() -> Result<CliLifecycleInfo, String> {
    let status = check_claude_cli().await?;
    Ok(cli_lifecycle_for(status.path, status.version))
}

/// Run a Claude CLI subcommand (e.g. `claude doctor`) as a one-shot process
/// and return its combined stdout/stderr output.
#[tauri::command]
async fn run_claude_command(subcommand: String, cwd: Option<String>) -> Result<String, String> {
    // P1-1: Allowlist safe subcommands
    let allowed = ["doctor", "--version", "config", "mcp"];
    if !allowed.contains(&subcommand.as_str()) {
        return Err(format!("Claude subcommand '{}' not allowed", subcommand));
    }

    let binary = find_claude_binary().ok_or_else(|| "Claude CLI not found".to_string())?;
    let enriched_path = build_enriched_path();
    #[cfg(target_os = "windows")]
    let mut cmd = if claude_needs_cmd_wrapper(&binary) {
        let mut c = Command::new("cmd");
        c.arg("/C").arg(&binary).arg(&subcommand);
        c
    } else {
        let mut c = Command::new(&binary);
        c.arg(&subcommand);
        c
    };
    #[cfg(not(target_os = "windows"))]
    let mut cmd = {
        let mut c = Command::new(&binary);
        c.arg(&subcommand);
        c
    };
    client_runtime::apply_to_tokio_command(&mut cmd)?;
    cmd.env("PATH", &enriched_path);
    cmd.env_remove("CLAUDECODE");
    cmd.stdin(Stdio::null());
    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(0x08000000);
        // Disable MSYS2 auto path conversion on Windows (Chinese path fix)
        cmd.env("MSYS_NO_PATHCONV", "1")
            .env("MSYS2_ARG_CONV_EXCL", "*");
    }
    if let Some(ref dir) = cwd {
        cmd.current_dir(dir);
    }
    let future = cmd.output();
    let output = tokio::time::timeout(std::time::Duration::from_secs(30), future)
        .await
        .map_err(|_| format!("claude {} timed out after 30s", subcommand))?
        .map_err(|e| format!("Failed to run claude {}: {}", subcommand, e))?;
    let stdout = strip_ansi(&String::from_utf8_lossy(&output.stdout));
    let stderr = strip_ansi(&String::from_utf8_lossy(&output.stderr));
    if output.status.success() {
        let combined = if stderr.is_empty() {
            stdout
        } else {
            format!("{}\n{}", stdout, stderr)
        };
        Ok(combined.trim().to_string())
    } else {
        let combined = format!("{}\n{}", stdout, stderr);
        Err(combined.trim().to_string())
    }
}

/// Remove a claude.exe that Windows refuses to execute (error 193 / "16-bit application").
///
/// This covers the full set of known CLI locations, not just `~/.claude/local/`:
///   - The AppLocal native-install dir (`cli_download_dir()`)
///   - The app's npm-global prefix (where `@anthropic-ai/claude-code` lives)
///
/// For the npm case we also purge the `@anthropic-ai/claude-code` package dir
/// so a subsequent scan falls back to the working `claude.cmd` shim (or triggers
/// a clean reinstall), instead of re-discovering the same bad exe on the next run.
#[cfg(target_os = "windows")]
fn remove_corrupt_claude_exe(suspect_path: &str) {
    let suspect = std::path::Path::new(suspect_path);
    if suspect.exists() {
        match std::fs::remove_file(suspect) {
            Ok(()) => eprintln!("[cli_repair] removed corrupt exe: {}", suspect.display()),
            Err(e) => eprintln!("[cli_repair] failed to remove {}: {}", suspect.display(), e),
        }
    }

    // If the suspect lives inside our npm-global prefix, purge the pkg dir
    // so find_claude_binary doesn't re-discover the same bad exe.
    if let Ok(npm_dir) = npm_global_dir() {
        let npm_dir_str = npm_dir.to_string_lossy().to_string();
        if suspect_path.starts_with(npm_dir_str.as_str()) {
            let pkg = npm_dir
                .join("node_modules")
                .join("@anthropic-ai")
                .join("claude-code");
            if pkg.exists() {
                match std::fs::remove_dir_all(&pkg) {
                    Ok(()) => eprintln!("[cli_repair] removed corrupt pkg: {}", pkg.display()),
                    Err(e) => {
                        eprintln!("[cli_repair] failed to remove pkg {}: {}", pkg.display(), e)
                    }
                }
            }
        }
    }
}

/// Check whether the Claude CLI is installed and return its path and version.
#[tauri::command]
async fn check_claude_cli() -> Result<CliStatus, String> {
    match resolve_claude_sdk_runtime() {
        Ok(runtime) => {
            #[cfg(target_os = "windows")]
            let git_bash_missing = find_git_bash().is_none();
            #[cfg(not(target_os = "windows"))]
            let git_bash_missing = false;
            eprintln!(
                "[check_claude_cli] SDK runtime ready: {} v{}",
                runtime.path, runtime.version
            );
            Ok(CliStatus {
                installed: true,
                path: Some(runtime.path),
                version: Some(runtime.version),
                git_bash_missing,
                sdk_capabilities: Some(runtime.capabilities),
                sdk_error: None,
            })
        }
        Err(error) => {
            eprintln!("[check_claude_cli] {}", error);
            Ok(CliStatus {
                installed: false,
                path: commands::cli_resolver::get_pinned_cli(),
                version: None,
                git_bash_missing: false,
                sdk_capabilities: None,
                sdk_error: Some(error),
            })
        }
    }
}

// ─── CLI Diagnostics ───────────────────────────────────────

/// Scan all CLI installations and return candidates with version info.
#[tauri::command]
async fn diagnose_cli() -> Result<Vec<commands::cli_resolver::CliCandidate>, String> {
    let mut candidates = commands::cli_resolver::scan_all();

    for candidate in &mut candidates {
        if !candidate.issues.is_empty() && candidate.version.is_none() {
            continue;
        }
        let path = candidate.path.clone();
        match tokio::task::spawn_blocking(move || {
            commands::cli_resolver::probe_sdk_runtime(std::path::Path::new(&path))
        })
        .await
        {
            Ok(Ok(runtime)) => candidate.version = Some(runtime.version),
            Ok(Err(error)) => candidate.issues.push(error),
            Err(error) => candidate
                .issues
                .push(format!("SDK runtime probe worker failed: {error}")),
        }
    }

    Ok(candidates)
}

fn newest_healthy_cli_candidate<'a>(
    candidates: &'a [commands::cli_resolver::CliCandidate],
    previous_path: &str,
) -> Option<&'a commands::cli_resolver::CliCandidate> {
    candidates
        .iter()
        .filter(|candidate| {
            candidate.issues.is_empty()
                && candidate.version.is_some()
                && commands::cli_resolver::is_expected_update_successor(
                    std::path::Path::new(previous_path),
                    std::path::Path::new(&candidate.path),
                )
        })
        .reduce(|best, candidate| {
            let best_version = best.version.as_deref().unwrap_or_default();
            let candidate_version = candidate.version.as_deref().unwrap_or_default();
            if version_gt(candidate_version, best_version) {
                candidate
            } else {
                best
            }
        })
}

/// Claude's native updater can migrate a legacy `~/.claude/local/claude`
/// installation into the current `~/.local/bin/claude` launcher. Resolve that
/// migration after an explicit update, pin the newer healthy environment, and
/// verify the requested target before reporting success to the UI.
async fn reconcile_cli_after_update(
    previous_path: &str,
    previous_version: Option<&str>,
    expected_version: Option<&str>,
) -> Result<String, String> {
    let expected = match expected_version
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(raw) => Some(
            extract_semver(raw)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| format!("Invalid requested CLI version: {raw}"))?,
        ),
        None => None,
    };
    let mut last_best: Option<(String, String)> = None;

    for attempt in 0..3 {
        let candidates = diagnose_cli().await?;
        if let Some(best) = newest_healthy_cli_candidate(&candidates, previous_path) {
            let version = best.version.clone().unwrap_or_default();
            last_best = Some((best.path.clone(), version.clone()));
            let meets_target = expected
                .as_deref()
                .map(|target| semver_at_least(&version, target))
                .unwrap_or(true);
            let previous_is_older = previous_version
                .map(|current| version_gt(&version, current))
                .unwrap_or(true);
            let changed_without_target = expected.is_some() || previous_is_older;
            if meets_target && changed_without_target {
                if best.path != previous_path && previous_is_older {
                    commands::cli_resolver::pin_cli(&best.path)?;
                }

                let verified = check_claude_cli().await?;
                let verified_version = verified.version.unwrap_or_default();
                if let Some(target) = expected.as_deref() {
                    if !semver_at_least(&verified_version, target) {
                        return Err(format!(
                            "CLI update downloaded v{}, but the active environment is still v{}. Switch to {} and retry.",
                            version,
                            if verified_version.is_empty() { "unknown" } else { &verified_version },
                            best.path,
                        ));
                    }
                }
                return Ok(if verified_version.is_empty() {
                    version
                } else {
                    verified_version
                });
            }
        }

        if attempt < 2 {
            tokio::time::sleep(std::time::Duration::from_millis(350)).await;
        }
    }

    let detail = last_best
        .map(|(path, version)| format!("best detected candidate is v{} at {}", version, path))
        .unwrap_or_else(|| "no healthy CLI candidate was detected".to_string());
    Err(match expected {
        Some(target) => format!(
            "CLI update did not reach the requested v{}; {}. The previous environment remains available.",
            target, detail,
        ),
        None => format!("CLI update could not be verified; {}.", detail),
    })
}

/// Clean up selected CLI installations.
#[tauri::command]
async fn cleanup_old_cli(
    targets: Vec<String>,
) -> Result<commands::cli_resolver::CleanupResult, String> {
    Ok(commands::cli_resolver::cleanup(&targets))
}

#[tauri::command]
async fn pin_cli(path: String) -> Result<(), String> {
    commands::cli_resolver::pin_cli(&path)
}

#[tauri::command]
async fn unpin_cli() -> Result<(), String> {
    commands::cli_resolver::unpin_cli()
}

#[tauri::command]
async fn get_pinned_cli() -> Result<Option<String>, String> {
    Ok(commands::cli_resolver::get_pinned_cli())
}

#[tauri::command]
async fn inject_cli_path(path: String) -> Result<String, String> {
    commands::cli_resolver::inject_path(&path)
}

#[tauri::command]
async fn delete_cli(path: String) -> Result<String, String> {
    commands::cli_resolver::delete_cli(&path)
}

/// Result of a CLI repair scan: which binaries were probed, removed, kept.
#[derive(serde::Serialize)]
struct RepairReport {
    scanned: Vec<String>,
    removed: Vec<String>,
    /// Non-fatal notes (e.g. "skipped non-app-local path").
    notes: Vec<String>,
}

/// Scan all discoverable Claude CLI binaries, probe each by running
/// `--version`, and remove any that fail with Windows error 193
/// ("不支持的 16 位应用程序" / not-a-valid-Win32-application).
///
/// User-facing repair entry point — reached from the CLI settings tab.
/// Safe to call on any platform (no-op on non-Windows, where error 193
/// does not occur).
#[tauri::command]
async fn repair_cli() -> Result<RepairReport, String> {
    let mut report = RepairReport {
        scanned: Vec::new(),
        removed: Vec::new(),
        notes: Vec::new(),
    };

    #[cfg(not(target_os = "windows"))]
    {
        report.notes.push(
            "Repair is a Windows-specific operation (error 193 / 16-bit app). No-op here."
                .to_string(),
        );
    }

    #[cfg(target_os = "windows")]
    {
        let enriched_path = build_enriched_path();
        let candidates = commands::cli_resolver::resolve_ordered();
        for (path, _source) in candidates {
            // Only probe .exe binaries — .cmd / .bat shims can't trigger error 193.
            if !path.ends_with(".exe") {
                continue;
            }
            report.scanned.push(path.clone());

            let probe = Command::new(&path)
                .arg("--version")
                .env("PATH", &enriched_path)
                .stdin(Stdio::null())
                .stderr(Stdio::null())
                .creation_flags(0x08000000)
                .output();

            let probe_result = tokio::time::timeout(std::time::Duration::from_secs(5), probe).await;

            match probe_result {
                // Timed out: leave it alone. Could be a hang, not corruption.
                Err(_) => {
                    report
                        .notes
                        .push(format!("timed out probing {} — skipped", path));
                }
                Ok(Ok(_)) => {
                    // Exited (any status) — binary ran, not corrupt.
                }
                Ok(Err(ref e)) if e.raw_os_error() == Some(193) => {
                    eprintln!("[repair_cli] error 193 on {} — removing", path);
                    remove_corrupt_claude_exe(&path);
                    report.removed.push(path);
                }
                Ok(Err(e)) => {
                    report
                        .notes
                        .push(format!("spawn failed on {}: {}", path, e));
                }
            }
        }
    }

    Ok(report)
}

/// Detect whether the user is behind the GFW (China network).
/// Tries to connect to Google — if unreachable within 3 seconds, assume China network.
/// Result is cached for the lifetime of the process via OnceLock.
static CHINA_NETWORK: std::sync::OnceLock<bool> = std::sync::OnceLock::new();

async fn detect_china_network() -> bool {
    // Network detection must bypass proxy to test the real network path.
    // If proxy is used, Google might be reachable via proxy even in China,
    // giving a false negative.
    let client = reqwest::Client::builder()
        .no_proxy()
        .connect_timeout(std::time::Duration::from_secs(3))
        .timeout(std::time::Duration::from_secs(3))
        .build()
        .unwrap_or_default();

    let is_china = client
        .head("https://www.google.com/generate_204")
        .send()
        .await
        .is_err();

    eprintln!(
        "Network detection: {}",
        if is_china {
            "China (Google unreachable)"
        } else {
            "Global (Google reachable)"
        }
    );
    is_china
}

async fn is_china_network() -> bool {
    if let Some(&cached) = CHINA_NETWORK.get() {
        return cached;
    }
    let result = detect_china_network().await;
    let _ = CHINA_NETWORK.set(result);
    result
}

/// Install Claude CLI via npm. Supports system npm or local Node.js npm.
/// Install Claude CLI via npm. Supports system npm or local Node.js npm.
/// Uses --prefix to install into app-local directory when using local Node.js.
async fn install_cli_via_npm(app: &AppHandle, china: bool) -> Result<(), String> {
    let _ = emit_to_frontend(
        app,
        "setup:download:progress",
        serde_json::json!({
            "downloaded": 0, "total": 0, "percent": 0, "phase": "npm_fallback"
        }),
    );

    // Determine npm path: local Node.js takes priority, then system npm
    let npm_path = if let Some(local_bin) = get_local_node_bin() {
        #[cfg(target_os = "windows")]
        let npm = local_bin.join("npm.cmd");
        #[cfg(not(target_os = "windows"))]
        let npm = local_bin.join("npm");
        npm.to_string_lossy().to_string()
    } else {
        #[cfg(target_os = "windows")]
        let npm = "npm.cmd".to_string();
        #[cfg(not(target_os = "windows"))]
        let npm = "npm".to_string();
        npm
    };

    // Build PATH that includes local Node.js bin
    let enriched_path = build_enriched_path();

    // Always use --prefix to install into our controlled directory.
    // This avoids polluting system npm globals and ensures finalize_cli_install_paths
    // can reliably add the bin directory to PATH (fixes PowerShell not finding `claude`).
    let prefix_dir = npm_global_dir()?;
    std::fs::create_dir_all(&prefix_dir)
        .map_err(|e| format!("Failed to create npm-global dir: {}", e))?;

    // Use app-local npm cache to avoid EPERM when system cache dir is locked
    // (common on Windows with antivirus or concurrent npm processes).
    let cache_dir = npm_cache_dir()?;
    std::fs::create_dir_all(&cache_dir)
        .map_err(|e| format!("Failed to create npm-cache dir: {}", e))?;

    let registries: Vec<&str> = if china {
        vec![
            "https://registry.npmmirror.com",
            "https://mirrors.huaweicloud.com/repository/npm",
            "https://mirrors.cloud.tencent.com/npm",
            "https://registry.npmjs.org",
        ]
    } else {
        vec![
            "https://registry.npmjs.org",
            "https://registry.npmmirror.com",
        ]
    };

    let mut last_err = String::new();
    for registry in &registries {
        eprintln!(
            "Trying npm install with registry: {} (prefix: {}, cache: {})",
            registry,
            prefix_dir.display(),
            cache_dir.display()
        );

        let _ = emit_to_frontend(
            app,
            "setup:download:progress",
            serde_json::json!({
                "downloaded": 0, "total": 0, "percent": 50, "phase": "npm_fallback"
            }),
        );

        // Build args — always use --prefix and --cache for isolation
        let args: Vec<String> = vec![
            "install".to_string(),
            "-g".to_string(),
            "@anthropic-ai/claude-code".to_string(),
            format!("--registry={}", registry),
            format!("--prefix={}", prefix_dir.display()),
            format!("--cache={}", cache_dir.display()),
        ];

        let args_str: Vec<&str> = args.iter().map(|s| s.as_str()).collect();

        #[cfg(target_os = "windows")]
        let result = {
            let mut cmd = Command::new("cmd");
            cmd.arg("/C").arg(&npm_path);
            cmd.args(&args_str);
            cmd.env("PATH", &enriched_path)
                .stdin(Stdio::null())
                .creation_flags(0x08000000);
            tokio::time::timeout(std::time::Duration::from_secs(300), cmd.output()).await
        };
        #[cfg(not(target_os = "windows"))]
        let result = {
            let mut cmd = Command::new(&npm_path);
            cmd.args(&args_str)
                .env("PATH", &enriched_path)
                .stdin(Stdio::null());
            tokio::time::timeout(std::time::Duration::from_secs(300), cmd.output()).await
        };

        match result {
            Ok(Ok(output)) if output.status.success() => {
                eprintln!("npm install succeeded via {}", registry);
                let _ = emit_to_frontend(
                    app,
                    "setup:download:progress",
                    serde_json::json!({
                        "downloaded": 0, "total": 0, "percent": 100, "phase": "installing"
                    }),
                );
                return Ok(());
            }
            Ok(Ok(output)) => {
                let stderr = String::from_utf8_lossy(&output.stderr);
                last_err = format!("npm install failed ({}): {}", registry, stderr);
                eprintln!("{}", last_err);
            }
            Ok(Err(e)) => {
                last_err = format!("npm not found or failed to run: {}", e);
                eprintln!("{}", last_err);
                return Err(last_err);
            }
            Err(_) => {
                last_err = format!("npm install timed out ({})", registry);
                eprintln!("{}", last_err);
            }
        }
    }

    Err(last_err)
}

/// Compare two semver-style version strings (e.g. "2.1.92" > "2.1.81").
/// Handles "v" prefix, "(Claude Code)" suffix, and non-numeric noise.
fn version_gt(a: &str, b: &str) -> bool {
    let parse = |s: &str| -> Vec<u64> {
        // Take only the first whitespace-delimited token ("2.1.92 (Claude Code)" → "2.1.92")
        let ver = s
            .trim()
            .trim_start_matches('v')
            .split_whitespace()
            .next()
            .unwrap_or("");
        ver.split('.')
            .filter_map(|p| p.parse::<u64>().ok())
            .collect()
    };
    let va = parse(a);
    let vb = parse(b);
    // Only compare if both parsed to the same number of segments
    if va.len() != vb.len() && (va.is_empty() || vb.is_empty()) {
        return false;
    }
    va > vb
}

/// Return the platform key matching the server manifest (e.g. "win32-x64").
fn native_platform_key() -> &'static str {
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    {
        "win32-x64"
    }
    #[cfg(all(target_os = "windows", target_arch = "aarch64"))]
    {
        "win32-arm64"
    }
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        "darwin-arm64"
    }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        "darwin-x64"
    }
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    {
        "linux-x64"
    }
    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    {
        "linux-arm64"
    }
}

/// Probe a release base for `/latest` and return the version string.
async fn fetch_latest_version(client: &reqwest::Client, base: &str) -> Option<String> {
    let url = format!("{}/latest", base);
    let resp = client.get(&url).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let text = resp.text().await.ok()?;
    let v = text.trim().to_string();
    if v.is_empty() {
        None
    } else {
        Some(v)
    }
}

/// Order the two release bases, prefer the one with the highest version.
///
/// This protects against mirror lag: if `herear.cn` is several versions behind
/// GCS (as happened 2026-04: GCS=2.1.114 vs mirror=2.1.92), we still serve the
/// latest to users and log a warning. If one source is unreachable, the other
/// is used unconditionally.
///
/// Returns `Vec<(base_url, version)>` in preferred order, empty if both fail.
async fn choose_native_sources(china: bool) -> Vec<(&'static str, String)> {
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(6))
        .build()
    {
        Ok(c) => c,
        Err(_) => return Vec::new(),
    };

    // China: probe both (mirror has lower latency, GCS has the freshest version).
    // Non-China: GCS only — `herear.cn` is a China-oriented mirror with limited bandwidth.
    let bases: Vec<&'static str> = if china {
        vec![CLI_MIRROR_BASE, CLI_GCS_BASE]
    } else {
        vec![CLI_GCS_BASE]
    };

    let probes = futures_util::future::join_all(
        bases
            .iter()
            .map(|b| async { (*b, fetch_latest_version(&client, b).await) }),
    )
    .await;

    let mut available: Vec<(&'static str, String)> = probes
        .into_iter()
        .filter_map(|(b, v)| v.map(|v| (b, v)))
        .collect();

    if available.len() > 1 {
        // Log lag if the china mirror is behind GCS so ops can notice.
        if let (Some(mirror_v), Some(gcs_v)) = (
            available
                .iter()
                .find(|(b, _)| *b == CLI_MIRROR_BASE)
                .map(|(_, v)| v.clone()),
            available
                .iter()
                .find(|(b, _)| *b == CLI_GCS_BASE)
                .map(|(_, v)| v.clone()),
        ) {
            if version_gt(&gcs_v, &mirror_v) {
                eprintln!(
                    "[native_download] mirror lag detected: herear.cn={} < GCS={} — preferring GCS",
                    mirror_v, gcs_v
                );
            }
        }
        // Sort descending by version — highest version first.
        available.sort_by(|a, b| {
            if version_gt(&a.1, &b.1) {
                std::cmp::Ordering::Less
            } else if version_gt(&b.1, &a.1) {
                std::cmp::Ordering::Greater
            } else {
                std::cmp::Ordering::Equal
            }
        });
    }

    available
}

/// Download and install a native CLI binary into `~/.claude/local/`.
///
/// Shared by both `install_claude_cli` (first-time install) and `update_claude_cli`
/// (in-app update). Works for both China and non-China users:
///   - China: probes both `herear.cn` mirror and GCS, serves whichever has the
///     highest version (protects against mirror lag).
///   - Non-China: GCS only.
///
/// Native binary install is the preferred path because it bypasses the npm
/// optional-dependency fragility that caused TK-0.10.5's Windows install
/// failure (bin/claude.exe shipped by `@anthropic-ai/claude-code` was corrupt,
/// triggering Windows error 193 "16-bit application not supported").
async fn try_native_cli_download(app: Option<&AppHandle>, china: bool) -> Result<String, String> {
    let sources = choose_native_sources(china).await;
    if sources.is_empty() {
        return Err("No native release source reachable".to_string());
    }
    // All candidate sources agree on platform key + binary name; pick the winning
    // version from the first source and fetch its manifest for the checksum.
    let (primary_base, version) = sources[0].clone();
    eprintln!(
        "[native_download] selected source: {} @ v{}",
        primary_base, version
    );

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("HTTP client: {e}"))?;

    // 1. Fetch manifest for checksum + binary name (try sources in order).
    let platform = native_platform_key();
    let mut expected_checksum = String::new();
    let mut binary_name = if cfg!(target_os = "windows") {
        "claude.exe"
    } else {
        "claude"
    }
    .to_string();
    let mut manifest_ok = false;

    for (base, ver) in &sources {
        if ver != &version {
            continue; // skip stale mirrors — we already committed to `version`
        }
        let url = format!("{}/{}/manifest.json", base, version);
        if let Ok(resp) = client.get(&url).send().await {
            if let Ok(manifest) = resp.json::<serde_json::Value>().await {
                if let Some(info) = manifest.get("platforms").and_then(|p| p.get(platform)) {
                    if let Some(cs) = info.get("checksum").and_then(|v| v.as_str()) {
                        expected_checksum = cs.to_string();
                    }
                    if let Some(bn) = info.get("binary").and_then(|v| v.as_str()) {
                        binary_name = bn.to_string();
                    }
                    manifest_ok = true;
                    break;
                }
            }
        }
    }
    if !manifest_ok {
        return Err(format!(
            "Cannot fetch manifest for v{} on platform {}",
            version, platform
        ));
    }

    // 2. Install path: ~/.claude/local/ (same layout as official install.sh).
    let home = dirs::home_dir().ok_or("Cannot determine home directory")?;
    let install_dir = home.join(".claude").join("local");
    std::fs::create_dir_all(&install_dir)
        .map_err(|e| format!("Cannot create ~/.claude/local/: {e}"))?;
    let dest_path = install_dir.join(&binary_name);
    let tmp_path = install_dir.join(format!("{}.tmp", binary_name));

    // 3. Stream binary to tmp file (~200MB).
    let dl_client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(600))
        .build()
        .map_err(|e| format!("HTTP client: {e}"))?;

    let mut downloaded = false;
    for (base, ver) in &sources {
        if ver != &version {
            continue;
        }
        let url = format!("{}/{}/{}/{}", base, version, platform, binary_name);
        eprintln!("[native_download] downloading from {}", url);
        if let Some(h) = app {
            let _ = emit_to_frontend(
                h,
                "setup:download:progress",
                serde_json::json!({
                    "downloaded": 0, "total": 0, "percent": 10, "phase": "native_download"
                }),
            );
        }

        let resp = match dl_client.get(&url).send().await {
            Ok(r) if r.status().is_success() => r,
            Ok(r) => {
                eprintln!("[native_download] HTTP {} from {}", r.status(), base);
                continue;
            }
            Err(e) => {
                eprintln!("[native_download] request failed: {} ({})", e, base);
                continue;
            }
        };

        let total_bytes = resp.content_length();
        let mut written: u64 = 0;
        let mut stream = resp.bytes_stream();
        let mut file =
            std::fs::File::create(&tmp_path).map_err(|e| format!("Cannot create tmp file: {e}"))?;

        use std::io::Write;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| format!("Download stream error: {e}"))?;
            file.write_all(&chunk)
                .map_err(|e| format!("Write error: {e}"))?;
            written += chunk.len() as u64;
            if let (Some(h), Some(total)) = (app, total_bytes) {
                let percent = ((written as f64 / total as f64) * 80.0) as u64 + 10;
                let _ = emit_to_frontend(
                    h,
                    "setup:download:progress",
                    serde_json::json!({
                        "downloaded": written, "total": total,
                        "percent": percent.min(90), "phase": "native_download"
                    }),
                );
            }
        }
        drop(file);

        // 4. Verify SHA-256 checksum.
        if !expected_checksum.is_empty() {
            use sha2::{Digest, Sha256};
            let data =
                std::fs::read(&tmp_path).map_err(|e| format!("Cannot read tmp file: {e}"))?;
            let actual = format!("{:x}", Sha256::digest(&data));
            if actual != expected_checksum {
                eprintln!(
                    "[native_download] checksum mismatch: expected {}… got {}…",
                    &expected_checksum[..12.min(expected_checksum.len())],
                    &actual[..12.min(actual.len())]
                );
                let _ = std::fs::remove_file(&tmp_path);
                continue;
            }
            eprintln!("[native_download] checksum verified");
        }

        downloaded = true;
        break;
    }

    if !downloaded {
        let _ = std::fs::remove_file(&tmp_path);
        return Err("All native download sources failed".to_string());
    }

    // 5. Set executable permission and move to final location.
    #[cfg(not(target_os = "windows"))]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&tmp_path, std::fs::Permissions::from_mode(0o755));
    }

    // On Windows the running binary may be locked; try rename, then copy+delete.
    if std::fs::rename(&tmp_path, &dest_path).is_err() {
        std::fs::copy(&tmp_path, &dest_path).map_err(|e| format!("Cannot install binary: {e}"))?;
        let _ = std::fs::remove_file(&tmp_path);
    }

    eprintln!(
        "[native_download] installed {} -> {}",
        binary_name,
        dest_path.display()
    );
    Ok(version)
}

/// Update the Claude CLI to the latest version.
/// Strategy (same for China and non-China):
///   Phase 1: Native binary via GCS (and herear.cn mirror for China) with lag detection
///   Phase 2: npm multi-registry fallback with version verification
async fn update_app_local_cli(app: AppHandle) -> Result<String, String> {
    let china = is_china_network().await;

    // Phase 1: Try native binary download.
    match try_native_cli_download(Some(&app), china).await {
        Ok(version) => {
            eprintln!(
                "[update_claude_cli] native binary update success: v{}",
                version
            );
            return Ok(version);
        }
        Err(e) => {
            eprintln!(
                "[update_claude_cli] native binary skipped/failed: {}, using npm",
                e
            );
        }
    }

    // Phase 2: npm with multi-registry + version verification
    // For China: npmmirror first (fast), verify version matches target,
    // if stale → auto-retry with npm official
    let npm_path = if let Some(local_bin) = get_local_node_bin() {
        #[cfg(target_os = "windows")]
        let npm = local_bin.join("npm.cmd");
        #[cfg(not(target_os = "windows"))]
        let npm = local_bin.join("npm");
        npm.to_string_lossy().to_string()
    } else {
        #[cfg(target_os = "windows")]
        let npm = "npm.cmd".to_string();
        #[cfg(not(target_os = "windows"))]
        let npm = "npm".to_string();
        npm
    };

    let enriched_path = build_enriched_path();
    let prefix_dir = npm_global_dir()?;
    std::fs::create_dir_all(&prefix_dir)
        .map_err(|e| format!("Failed to create npm prefix dir: {e}"))?;
    let cache_dir = npm_cache_dir()?;
    std::fs::create_dir_all(&cache_dir).ok();

    // Fetch target version for post-install verification (herear.cn for China, GCS for others)
    let target_version = {
        let c = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .build()
            .unwrap_or_default();
        let urls = if china {
            vec![
                format!("{}/latest", CLI_MIRROR_BASE),
                format!("{}/latest", CLI_GCS_BASE),
            ]
        } else {
            vec![format!("{}/latest", CLI_GCS_BASE)]
        };
        let mut ver: Option<String> = None;
        for url in &urls {
            if let Ok(resp) = c.get(url).send().await {
                if let Ok(text) = resp.text().await {
                    let v = text.trim().to_string();
                    if !v.is_empty() {
                        ver = Some(v);
                        break;
                    }
                }
            }
        }
        ver
    };

    let registries: Vec<&str> = if china {
        vec![
            "https://registry.npmmirror.com",
            "https://registry.npmjs.org",
        ]
    } else {
        vec!["https://registry.npmjs.org"]
    };

    let mut last_err = String::new();
    for registry in &registries {
        eprintln!("[update_claude_cli] trying npm registry: {}", registry);
        let _ = emit_to_frontend(
            &app,
            "setup:download:progress",
            serde_json::json!({
                "downloaded": 0, "total": 0, "percent": 30, "phase": "npm_fallback"
            }),
        );

        let args: Vec<String> = vec![
            "install".to_string(),
            "-g".to_string(),
            "@anthropic-ai/claude-code@latest".to_string(),
            format!("--registry={}", registry),
            format!("--prefix={}", prefix_dir.display()),
            format!("--cache={}", cache_dir.display()),
        ];
        let args_str: Vec<&str> = args.iter().map(|s| s.as_str()).collect();

        #[cfg(target_os = "windows")]
        let result = {
            let mut cmd = Command::new("cmd");
            cmd.arg("/C").arg(&npm_path);
            cmd.args(&args_str);
            cmd.env("PATH", &enriched_path)
                .stdin(Stdio::null())
                .creation_flags(0x08000000);
            tokio::time::timeout(std::time::Duration::from_secs(300), cmd.output()).await
        };
        #[cfg(not(target_os = "windows"))]
        let result = {
            let mut cmd = Command::new(&npm_path);
            cmd.args(&args_str);
            cmd.env("PATH", &enriched_path).stdin(Stdio::null());
            tokio::time::timeout(std::time::Duration::from_secs(300), cmd.output()).await
        };

        match result {
            Ok(Ok(output)) if output.status.success() => {
                let check = check_claude_cli().await.unwrap_or(CliStatus {
                    installed: false,
                    version: None,
                    path: None,
                    git_bash_missing: false,
                    sdk_capabilities: None,
                    sdk_error: None,
                });
                let version = check.version.unwrap_or_else(|| "unknown".to_string());
                eprintln!(
                    "[update_claude_cli] npm installed v{} from {}",
                    version, registry
                );
                let _ = emit_to_frontend(
                    &app,
                    "setup:download:progress",
                    serde_json::json!({
                        "downloaded": 0, "total": 0, "percent": 100, "phase": "complete"
                    }),
                );

                // Version verification: if target is known and installed version is stale,
                // try next registry (npmmirror may be behind)
                if let Some(ref target) = target_version {
                    if version != *target && version_gt(target, &version) {
                        eprintln!(
                            "[update_claude_cli] v{} < target v{}, trying next registry",
                            version, target
                        );
                        last_err = format!(
                            "Mirror {} has v{} but latest is v{}",
                            registry, version, target
                        );
                        continue;
                    }
                }

                return Ok(version);
            }
            Ok(Ok(output)) => {
                let stderr = String::from_utf8_lossy(&output.stderr);
                last_err = format!(
                    "npm install failed ({}): {}",
                    registry,
                    stderr.chars().take(500).collect::<String>()
                );
                eprintln!("[update_claude_cli] {}", last_err);
            }
            Ok(Err(e)) => {
                last_err = format!("Failed to run npm: {e}");
                eprintln!("[update_claude_cli] {}", last_err);
            }
            Err(_) => {
                last_err = format!("npm install timed out ({})", registry);
                eprintln!("[update_claude_cli] {}", last_err);
            }
        }
    }

    Err(last_err)
}

fn cli_owner_update_result(output: std::process::Output) -> Result<(), String> {
    if output.status.success() {
        return Ok(());
    }
    let stdout = strip_ansi(&String::from_utf8_lossy(&output.stdout));
    let stderr = strip_ansi(&String::from_utf8_lossy(&output.stderr));
    let message = format!("{}\n{}", stdout.trim(), stderr.trim())
        .trim()
        .chars()
        .take(1000)
        .collect::<String>();
    Err(if message.is_empty() {
        format!("Update command exited with {:?}", output.status.code())
    } else {
        message
    })
}

fn native_owner_update_percent(downloaded: u64, total: u64) -> u64 {
    if total == 0 {
        return 0;
    }
    let fraction = (downloaded.min(total) as f64) / (total as f64);
    (10.0 + fraction * 80.0).round().clamp(10.0, 90.0) as u64
}

fn native_owner_staging_bytes(version: &str, pid: u32) -> Option<u64> {
    let staging_root = dirs::home_dir()?
        .join(".cache")
        .join("claude")
        .join("staging");
    let prefix = format!("{}.{pid}.", version.trim_start_matches('v'));
    let entries = std::fs::read_dir(staging_root).ok()?;
    entries
        .filter_map(Result::ok)
        .filter(|entry| entry.file_name().to_string_lossy().starts_with(&prefix))
        .filter_map(|entry| {
            let plain = entry.path().join("claude");
            let windows = entry.path().join("claude.exe");
            std::fs::metadata(&plain)
                .or_else(|_| std::fs::metadata(&windows))
                .ok()
                .map(|metadata| metadata.len())
        })
        .max()
}

async fn native_owner_release_size(version: &str) -> Option<u64> {
    let version = version.trim_start_matches('v');
    if version.is_empty() {
        return None;
    }
    let url = format!(
        "{}/{}/{}/{}",
        CLI_GCS_BASE,
        version,
        native_platform_key(),
        if cfg!(target_os = "windows") {
            "claude.exe"
        } else {
            "claude"
        },
    );
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(8))
        .timeout(std::time::Duration::from_secs(12))
        .build()
        .ok()?;
    let response_length = |response: &reqwest::Response| {
        let headers = response.headers();
        headers
            .get("x-goog-stored-content-length")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<u64>().ok())
            .or_else(|| {
                headers
                    .get(reqwest::header::CONTENT_RANGE)
                    .and_then(|value| value.to_str().ok())
                    .and_then(|value| value.rsplit('/').next())
                    .and_then(|value| value.parse::<u64>().ok())
            })
            .or_else(|| response.content_length())
            .filter(|length| *length > 1)
    };

    if let Ok(response) = client.head(&url).send().await {
        if response.status().is_success() {
            if let Some(length) = response_length(&response) {
                return Some(length);
            }
        }
    }

    let response = client
        .get(url)
        .header(reqwest::header::RANGE, "bytes=0-0")
        .send()
        .await
        .ok()?;
    response.status().is_success().then(|| response_length(&response)).flatten()
}

#[cfg(test)]
mod native_owner_update_progress_tests {
    use super::native_owner_update_percent;

    #[test]
    fn maps_real_download_fraction_into_the_update_phase() {
        assert_eq!(native_owner_update_percent(0, 294_720_528), 10);
        assert_eq!(native_owner_update_percent(147_360_264, 294_720_528), 50);
        assert_eq!(native_owner_update_percent(294_720_528, 294_720_528), 90);
        assert_eq!(native_owner_update_percent(10, 0), 0);
    }
}

async fn run_native_cli_owner_update(
    app: &AppHandle,
    program: &str,
    expected_version: Option<&str>,
) -> Result<(), String> {
    let target_version = expected_version
        .and_then(extract_semver)
        .unwrap_or_default();
    emit_cli_update_progress(app, 0, 0, 0, "native_manifest");
    let total_bytes = native_owner_release_size(&target_version)
        .await
        .unwrap_or(0);

    let enriched_path = build_enriched_path();
    #[cfg(target_os = "windows")]
    let mut command = Command::new(program);
    #[cfg(not(target_os = "windows"))]
    let mut command = Command::new(program);
    command
        .arg("update")
        .env("PATH", enriched_path)
        .env(client_runtime::DISABLE_BACKGROUND_AUTOUPDATER_ENV, "1")
        .env_remove("CLAUDECODE")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(target_os = "windows")]
    command.creation_flags(0x08000000);
    let child = command
        .spawn()
        .map_err(|error| format!("Cannot start update command: {error}"))?;
    let pid = child.id().unwrap_or(0);
    let wait = child.wait_with_output();
    tokio::pin!(wait);
    let deadline = tokio::time::sleep(std::time::Duration::from_secs(15 * 60));
    tokio::pin!(deadline);
    let mut interval = tokio::time::interval(std::time::Duration::from_secs(1));
    let mut last_bytes = 0_u64;
    let mut last_change = std::time::Instant::now();
    let mut last_emitted: Option<(u64, &'static str)> = None;

    loop {
        tokio::select! {
            result = &mut wait => {
                let output = result.map_err(|error| format!("Cannot wait for update command: {error}"))?;
                return cli_owner_update_result(output);
            }
            _ = &mut deadline => {
                return Err("CLI update timed out after 15 minutes without completing; the existing CLI was kept".to_string());
            }
            _ = interval.tick() => {
                let Some(downloaded) = native_owner_staging_bytes(&target_version, pid) else {
                    if last_bytes > 0 && last_emitted != Some((95, "native_verify")) {
                        emit_cli_update_progress(app, last_bytes, total_bytes, 95, "native_verify");
                        last_emitted = Some((95, "native_verify"));
                    }
                    continue;
                };
                if downloaded > last_bytes {
                    last_bytes = downloaded;
                    last_change = std::time::Instant::now();
                }
                let percent = native_owner_update_percent(downloaded, total_bytes);
                let phase = if last_change.elapsed() >= std::time::Duration::from_secs(30) {
                    "native_stalled"
                } else {
                    "native_download"
                };
                if last_emitted != Some((percent, phase)) {
                    emit_cli_update_progress(app, downloaded, total_bytes, percent, phase);
                    last_emitted = Some((percent, phase));
                }
            }
        }
    }
}

async fn run_cli_owner_update(program: &str, arguments: &[&str]) -> Result<(), String> {
    let enriched_path = build_enriched_path();
    #[cfg(target_os = "windows")]
    let mut command = if program.eq_ignore_ascii_case("npm")
        || program.ends_with(".cmd")
        || program.ends_with(".bat")
    {
        let mut command = Command::new("cmd");
        command.arg("/C").arg(program);
        command
    } else {
        Command::new(program)
    };
    #[cfg(not(target_os = "windows"))]
    let mut command = Command::new(program);
    command
        .args(arguments)
        .env("PATH", enriched_path)
        .env_remove("CLAUDECODE")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(target_os = "windows")]
    command.creation_flags(0x08000000);
    let child = command
        .spawn()
        .map_err(|error| format!("Cannot start update command: {error}"))?;
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(15 * 60),
        child.wait_with_output(),
    )
    .await
    .map_err(|_| "CLI update timed out after 15 minutes".to_string())?
    .map_err(|error| format!("Cannot wait for update command: {error}"))?;
    cli_owner_update_result(output)
}

#[tauri::command]
async fn update_claude_cli(
    app: AppHandle,
    processes: State<'_, ProcessManager>,
    cli_maintenance: State<'_, CliMaintenanceState>,
    expected_version: Option<String>,
) -> Result<String, String> {
    let maintenance_gate = cli_maintenance
        .gate
        .try_write()
        .map_err(|_| "CLI_MAINTENANCE_BUSY".to_string())?;
    CLI_UPDATE_IN_PROGRESS.store(true, std::sync::atomic::Ordering::SeqCst);
    set_cli_update_progress(0, 0, 0, "configuring");
    let _maintenance_lease = CliUpdateLease {
        _gate: maintenance_gate,
        _flag: CliUpdateFlag,
    };

    // Fail closed even after the frontend preflight. A session or scheduled
    // run may start in the short interval between confirmation and update.
    let blockers = cli_update_blockers_inner(processes.inner()).await?;
    if !blockers.active_session_ids.is_empty() {
        return Err(format!(
            "CLI_UPDATE_BLOCKED_SESSIONS:{}",
            blockers.active_session_ids.len()
        ));
    }
    if blockers.running_automation {
        return Err("CLI_UPDATE_BLOCKED_AUTOMATION".to_string());
    }

    let status = check_claude_cli().await?;
    let previous_version = status.version.clone();
    let lifecycle = cli_lifecycle_for(status.path.clone(), status.version.clone());
    let path = status
        .path
        .ok_or_else(|| "Claude CLI is not installed".to_string())?;
    if lifecycle.install_method != CliInstallMethod::Native {
        emit_cli_update_progress(&app, 0, 0, 20, "configuring");
    }

    match lifecycle.install_method {
        CliInstallMethod::Native => {
            run_native_cli_owner_update(&app, &path, expected_version.as_deref()).await?
        }
        CliInstallMethod::HomebrewStable => {
            run_cli_owner_update("brew", &["upgrade", "--cask", "claude-code"]).await?
        }
        CliInstallMethod::HomebrewLatest => {
            run_cli_owner_update("brew", &["upgrade", "--cask", "claude-code@latest"]).await?
        }
        CliInstallMethod::Winget => {
            run_cli_owner_update(
                "winget",
                &[
                    "upgrade",
                    "--id",
                    "Anthropic.ClaudeCode",
                    "--exact",
                    "--accept-package-agreements",
                    "--accept-source-agreements",
                ],
            )
            .await?
        }
        CliInstallMethod::Npm => {
            run_cli_owner_update(
                "npm",
                &["install", "-g", "@anthropic-ai/claude-code@latest"],
            )
            .await?
        }
        CliInstallMethod::AppLocalNative | CliInstallMethod::AppLocalNpm => {
            let _ = update_app_local_cli(app.clone()).await?;
        }
        CliInstallMethod::Apt
        | CliInstallMethod::Dnf
        | CliInstallMethod::Apk
        | CliInstallMethod::VersionManager
        | CliInstallMethod::DesktopBundled
        | CliInstallMethod::Unknown => {
            return Err(match lifecycle.update_command {
                Some(command) => format!(
                    "This installation must be updated by its owner. Run in a terminal: {command}"
                ),
                None => lifecycle.note,
            });
        }
    }

    let version = reconcile_cli_after_update(
        &path,
        previous_version.as_deref(),
        expected_version.as_deref(),
    )
    .await?;
    emit_cli_update_progress(&app, 0, 0, 100, "complete");
    Ok(version)
}

/// Reinstall the selected CLI through the installation owner that already
/// manages it. This is deliberately separate from first-time installation:
/// clicking "Reinstall" must repair the selected SDK runtime rather than
/// silently creating another Black Box-local copy beside it.
#[tauri::command]
async fn reinstall_claude_cli(
    app: AppHandle,
    processes: State<'_, ProcessManager>,
    cli_maintenance: State<'_, CliMaintenanceState>,
) -> Result<String, String> {
    let maintenance_gate = cli_maintenance
        .gate
        .try_write()
        .map_err(|_| "CLI_MAINTENANCE_BUSY".to_string())?;
    CLI_UPDATE_IN_PROGRESS.store(true, std::sync::atomic::Ordering::SeqCst);
    let _maintenance_lease = CliUpdateLease {
        _gate: maintenance_gate,
        _flag: CliUpdateFlag,
    };

    let blockers = cli_update_blockers_inner(processes.inner()).await?;
    if !blockers.active_session_ids.is_empty() {
        return Err(format!(
            "CLI_UPDATE_BLOCKED_SESSIONS:{}",
            blockers.active_session_ids.len()
        ));
    }
    if blockers.running_automation {
        return Err("CLI_UPDATE_BLOCKED_AUTOMATION".to_string());
    }

    let status = check_claude_cli().await?;
    let lifecycle = cli_lifecycle_for(status.path.clone(), status.version.clone());
    let path = status
        .path
        .ok_or_else(|| "Claude CLI is not installed".to_string())?;
    let _ = emit_to_frontend(
        &app,
        "setup:download:progress",
        serde_json::json!({
            "downloaded": 0, "total": 0, "percent": 20, "phase": "configuring"
        }),
    );

    match lifecycle.install_method {
        CliInstallMethod::Native => {
            let channel = lifecycle
                .release_channel
                .as_deref()
                .filter(|value| matches!(*value, "stable" | "latest"))
                .unwrap_or("latest");
            run_cli_owner_update(&path, &["install", "--force", channel]).await?;
        }
        CliInstallMethod::HomebrewStable => {
            run_cli_owner_update("brew", &["reinstall", "--cask", "claude-code"]).await?
        }
        CliInstallMethod::HomebrewLatest => {
            run_cli_owner_update("brew", &["reinstall", "--cask", "claude-code@latest"]).await?
        }
        CliInstallMethod::Winget => {
            run_cli_owner_update(
                "winget",
                &[
                    "install",
                    "--id",
                    "Anthropic.ClaudeCode",
                    "--exact",
                    "--force",
                    "--accept-package-agreements",
                    "--accept-source-agreements",
                ],
            )
            .await?
        }
        CliInstallMethod::Npm => {
            run_cli_owner_update(
                "npm",
                &[
                    "install",
                    "-g",
                    "@anthropic-ai/claude-code@latest",
                    "--force",
                ],
            )
            .await?
        }
        CliInstallMethod::AppLocalNative | CliInstallMethod::AppLocalNpm => {
            let _ = update_app_local_cli(app.clone()).await?;
        }
        CliInstallMethod::Apt
        | CliInstallMethod::Dnf
        | CliInstallMethod::Apk
        | CliInstallMethod::VersionManager
        | CliInstallMethod::DesktopBundled
        | CliInstallMethod::Unknown => {
            return Err(match lifecycle.update_command {
                Some(command) => format!(
                    "This installation must be reinstalled by its owner. Run in a terminal: {command}"
                ),
                None => lifecycle.note,
            });
        }
    }

    let candidates = diagnose_cli().await?;
    let best = newest_healthy_cli_candidate(&candidates, &path).ok_or_else(|| {
        "Reinstall completed, but no healthy SDK runtime was detected.".to_string()
    })?;
    if best.path != path {
        commands::cli_resolver::pin_cli(&best.path)?;
    }
    let runtime = resolve_claude_sdk_runtime()?;
    let _ = emit_to_frontend(
        &app,
        "setup:download:progress",
        serde_json::json!({
            "downloaded": 0, "total": 0, "percent": 100, "phase": "complete"
        }),
    );
    Ok(runtime.version)
}

/// Check if a newer CLI version is available.
/// Sources: herear.cn mirror (China-first) → GCS → npm registry.
#[derive(serde::Serialize)]
struct CliUpdateCheck {
    current: Option<String>,
    latest: Option<String>,
    update_available: bool,
}

#[tauri::command]
async fn check_cli_update() -> Result<CliUpdateCheck, String> {
    let cli = check_claude_cli().await.ok();
    let current = cli.as_ref().and_then(|c| c.version.clone());
    let lifecycle = cli
        .as_ref()
        .map(|status| cli_lifecycle_for(status.path.clone(), status.version.clone()));
    let release = lifecycle
        .as_ref()
        .and_then(|info| match info.install_method {
            CliInstallMethod::Native => info.release_channel.clone(),
            CliInstallMethod::AppLocalNative
            | CliInstallMethod::AppLocalNpm
            | CliInstallMethod::Npm => Some("latest".to_string()),
            _ => None,
        });
    let Some(release) = release else {
        return Ok(CliUpdateCheck {
            current,
            latest: None,
            update_available: false,
        });
    };

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .unwrap_or_default();

    let china = is_china_network().await;

    // Compare only against the release channel that owns this installation.
    // Package-managed installations are intentionally excluded above because
    // their repositories can lag upstream and must remain the authority source.
    let version_urls: Vec<String> = if china {
        vec![
            format!("{}/{}", CLI_MIRROR_BASE, release),
            format!("{}/{}", CLI_GCS_BASE, release),
        ]
    } else {
        vec![
            format!("{}/{}", CLI_GCS_BASE, release),
            format!("{}/{}", CLI_MIRROR_BASE, release),
        ]
    };

    let mut latest: Option<String> = None;
    for url in &version_urls {
        if let Ok(resp) = client.get(url).send().await {
            if resp.status().is_success() {
                if let Ok(text) = resp.text().await {
                    let v = text.trim().to_string();
                    if !v.is_empty() {
                        latest = Some(v);
                        break;
                    }
                }
            }
        }
    }

    // Final fallback: npm registry
    if latest.is_none() && release == "latest" {
        if let Ok(resp) = client
            .get("https://registry.npmjs.org/@anthropic-ai/claude-code/latest")
            .header("Accept", "application/json")
            .send()
            .await
        {
            let json: serde_json::Value = resp.json().await.unwrap_or_default();
            latest = json
                .get("version")
                .and_then(|v| v.as_str())
                .map(String::from);
        }
    }

    let update_available = match (&current, &latest) {
        (Some(cur), Some(lat)) => version_gt(lat.trim(), cur.trim()),
        _ => false,
    };

    Ok(CliUpdateCheck {
        current,
        latest,
        update_available,
    })
}

/// Install the Claude CLI via npm with network-aware mirror selection:
/// 0. Detect network environment (China vs Global)
/// 1. (Windows) Ensure git-bash is available — auto-install PortableGit if missing
/// 2. Ensure npm is available — download Node.js locally if needed
/// 3. Install CLI via npm with region-appropriate registry mirrors
#[tauri::command]
async fn install_claude_cli(app: AppHandle) -> Result<(), String> {
    // Skip installation if CLI already exists on system.
    // On Windows, still continue when git-bash is missing because reinstall is the repair path.
    let existing_cli = find_claude_binary();
    #[cfg(target_os = "windows")]
    let can_skip_install = existing_cli.is_some() && find_git_bash().is_some();
    #[cfg(not(target_os = "windows"))]
    let can_skip_install = existing_cli.is_some();
    if can_skip_install {
        eprintln!("CLI already found on system, skipping installation");
        let _ = emit_to_frontend(
            &app,
            "setup:download:progress",
            serde_json::json!({
                "downloaded": 0, "total": 0, "percent": 100, "phase": "complete"
            }),
        );
        return Ok(());
    }

    // Phase 0: Detect network environment (used by all subsequent phases)
    let china = is_china_network().await;

    // Phase 1 (Windows only): Ensure git-bash is available
    #[cfg(target_os = "windows")]
    {
        if find_git_bash().is_none() {
            eprintln!("git-bash not found, auto-installing PortableGit...");
            install_git_bash_inner(&app, china).await.map_err(|e| {
                format!(
                    "Failed to install Git for Windows: {}. \
                     Please install Git for Windows manually: https://git-scm.com/downloads/win",
                    e
                )
            })?;
        }

        // If CLI is already installed (only git-bash was missing), skip download phases
        if find_claude_binary().is_some() {
            eprintln!("CLI already installed, git-bash was the only missing dependency");
            finalize_cli_install_paths(&app);
            return Ok(());
        }
    }

    // Phase 2: Try native binary download first.
    // Preferred over npm because:
    //   (a) Binary is served directly by Anthropic's GCS bucket — no npm
    //       optional-dependency machinery that can silently skip the
    //       Windows-specific package (TK-0.10.5 field report).
    //   (b) No Node.js dependency on the happy path. Node.js install is
    //       still triggered below if native fails, so npm can take over.
    match try_native_cli_download(Some(&app), china).await {
        Ok(version) => {
            eprintln!(
                "[install_claude_cli] native binary install success: v{}",
                version
            );
            finalize_cli_install_paths(&app);
            let _ = emit_to_frontend(
                &app,
                "setup:download:progress",
                serde_json::json!({
                    "downloaded": 0, "total": 0, "percent": 100, "phase": "complete"
                }),
            );
            return Ok(());
        }
        Err(e) => {
            eprintln!(
                "[install_claude_cli] native binary unavailable: {}, falling back to npm",
                e
            );
        }
    }

    // Phase 3: Ensure npm is available for the fallback path.
    let has_npm = is_system_npm_available().await || get_local_node_bin().is_some();

    if !has_npm {
        eprintln!("npm not available, deploying Node.js locally...");
        install_node_env_inner(&app, china).await.map_err(|e| {
            format!(
                "Failed to install Node.js runtime: {}. Please install Node.js manually.",
                e
            )
        })?;
    }

    // Phase 4: Install CLI via npm (fallback).
    install_cli_via_npm(&app, china)
        .await
        .map_err(|npm_err| format!("CLI installation failed via npm: {}", npm_err))?;

    eprintln!("CLI installed via npm");
    finalize_cli_install_paths(&app);
    Ok(())
}

/// Inject a directory into the user's Unix shell profile PATH.
/// Appends an export line to the first existing profile file (.zshrc, .bashrc, etc.).
#[cfg(not(target_os = "windows"))]
fn inject_unix_shell_path(dir: &str) {
    let home = match dirs::home_dir() {
        Some(h) => h,
        None => return,
    };
    let export_line = format!("export PATH=\"{}:$PATH\"", dir);
    let marker = "# Added by BLACKBOX";
    let block = format!("\n{}\n{}\n", marker, export_line);

    let profiles = [
        home.join(".zshrc"),
        home.join(".bashrc"),
        home.join(".bash_profile"),
        home.join(".profile"),
    ];

    // Check if already injected
    for p in &profiles {
        if let Ok(c) = std::fs::read_to_string(p) {
            if c.contains(&export_line) {
                return;
            }
        }
    }

    // Append to the first existing profile
    for p in &profiles {
        if p.exists() {
            if let Ok(mut f) = std::fs::OpenOptions::new().append(true).open(p) {
                use std::io::Write;
                let _ = f.write_all(block.as_bytes());
                eprintln!("Injected PATH into {}", p.display());
                return;
            }
        }
    }

    // None exist — create ~/.profile
    let _ = std::fs::write(home.join(".profile"), block);
    eprintln!("Created ~/.profile with PATH injection");
}

/// Post-install: add relevant directories to Windows user PATH and emit completion.
fn finalize_cli_install_paths(app: &AppHandle) {
    #[cfg(target_os = "windows")]
    {
        // Collect all directories that should be on PATH
        let mut dirs_to_add: Vec<String> = vec![];

        if let Some(cli_dir) = cli_download_dir() {
            dirs_to_add.push(cli_dir.to_string_lossy().to_string());
        }
        if let Some(node_bin) = get_local_node_bin() {
            dirs_to_add.push(node_bin.to_string_lossy().to_string());
        }
        if let Some(npm_bin) = get_npm_global_bin() {
            dirs_to_add.push(npm_bin.to_string_lossy().to_string());
        }
        // Include local PortableGit bin and cmd directories
        if let Ok(git_dir) = git_download_dir() {
            let git_bin = git_dir.join("bin");
            if git_bin.exists() {
                dirs_to_add.push(git_bin.to_string_lossy().to_string());
            }
            let git_cmd = git_dir.join("cmd");
            if git_cmd.exists() {
                dirs_to_add.push(git_cmd.to_string_lossy().to_string());
            }
        }

        for dir in &dirs_to_add {
            let ps_script = format!(
                "$old = [Environment]::GetEnvironmentVariable('Path','User'); \
                 if ($old -and -not $old.Contains('{}')) {{ \
                   [Environment]::SetEnvironmentVariable('Path', $old + ';{}', 'User') \
                 }} elseif (-not $old) {{ \
                   [Environment]::SetEnvironmentVariable('Path', '{}', 'User') \
                 }}",
                dir.replace('\'', "''"),
                dir.replace('\'', "''"),
                dir.replace('\'', "''"),
            );
            let path_result = std::process::Command::new("powershell")
                .args(["-NoProfile", "-NonInteractive", "-Command", &ps_script])
                .creation_flags(0x08000000)
                .output();
            match path_result {
                Ok(output) if output.status.success() => {
                    eprintln!("Added to user PATH: {}", dir);
                }
                Ok(output) => {
                    let stderr = String::from_utf8_lossy(&output.stderr);
                    eprintln!("Failed to add to PATH: {}", stderr);
                }
                Err(e) => eprintln!("Failed to run PowerShell for PATH: {}", e),
            }
        }

        // Set CLAUDE_CODE_GIT_BASH_PATH user env var so `claude` works from any terminal
        if let Some(bash_path) = find_git_bash() {
            let ps_script = format!(
                "[Environment]::SetEnvironmentVariable('CLAUDE_CODE_GIT_BASH_PATH', '{}', 'User')",
                bash_path.replace('\'', "''"),
            );
            let result = std::process::Command::new("powershell")
                .args(["-NoProfile", "-NonInteractive", "-Command", &ps_script])
                .creation_flags(0x08000000)
                .output();
            match result {
                Ok(output) if output.status.success() => {
                    eprintln!("Set CLAUDE_CODE_GIT_BASH_PATH={}", bash_path);
                }
                Ok(output) => {
                    let stderr = String::from_utf8_lossy(&output.stderr);
                    eprintln!("Failed to set CLAUDE_CODE_GIT_BASH_PATH: {}", stderr);
                }
                Err(e) => eprintln!("Failed to run PowerShell for env var: {}", e),
            }
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        if let Some(node_bin) = get_local_node_bin() {
            inject_unix_shell_path(&node_bin.to_string_lossy());
        }
        if let Some(npm_bin) = get_npm_global_bin() {
            inject_unix_shell_path(&npm_bin.to_string_lossy());
        }
        let _ = app;
    }

    let _ = emit_to_frontend(
        app,
        "setup:download:progress",
        serde_json::json!({
            "downloaded": 0, "total": 0, "percent": 100, "phase": "complete"
        }),
    );
}

// ─── Node.js local deployment ──────────────────────────────────────────

/// Hardcoded Node.js LTS version for local deployment.
const NODE_LTS_VERSION: &str = "v22.22.0";

/// Primary Node.js download base URL (official).
const NODE_DIST_OFFICIAL: &str = "https://nodejs.org/dist";

/// China mirror: npmmirror CDN for Node.js binaries.
const NODE_DIST_NPMMIRROR: &str = "https://cdn.npmmirror.com/binaries/node";

/// China mirror: Huawei Cloud for Node.js binaries.
const NODE_DIST_HUAWEI: &str = "https://mirrors.huaweicloud.com/nodejs";

/// Directory for app-local Node.js installation.
fn node_download_dir() -> Result<std::path::PathBuf, String> {
    app_data_dir().map(|d| d.join("node"))
}

/// Directory for npm global installs (--prefix target).
pub(crate) fn npm_global_dir() -> Result<std::path::PathBuf, String> {
    app_data_dir().map(|d| d.join("npm-global"))
}

/// Directory for npm cache (avoids system cache EPERM on Windows).
fn npm_cache_dir() -> Result<std::path::PathBuf, String> {
    app_data_dir().map(|d| d.join("npm-cache"))
}

/// Get the bin directory of the local Node.js installation, if it exists.
pub(crate) fn get_local_node_bin() -> Option<std::path::PathBuf> {
    let node_dir = node_download_dir().ok()?;
    #[cfg(target_os = "windows")]
    {
        // Windows: node.exe is at the root of the extracted directory
        let node_exe = node_dir.join("node.exe");
        if node_exe.exists() {
            return Some(node_dir);
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let bin = node_dir.join("bin");
        if bin.join("node").exists() {
            return Some(bin);
        }
    }
    None
}

/// Get the bin directory of npm-global, if it exists.
pub(crate) fn get_npm_global_bin() -> Option<std::path::PathBuf> {
    let dir = npm_global_dir().ok()?;
    #[cfg(target_os = "windows")]
    let bin = dir.clone();
    #[cfg(not(target_os = "windows"))]
    let bin = dir.join("bin");
    if bin.exists() {
        Some(bin)
    } else {
        None
    }
}

/// Determine Node.js archive filename and format for the current platform.
fn get_node_archive_info() -> Result<(String, &'static str), String> {
    // Returns (filename, extension)
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => Ok((format!("node-{}-darwin-arm64", NODE_LTS_VERSION), "tar.gz")),
        ("macos", "x86_64") => Ok((format!("node-{}-darwin-x64", NODE_LTS_VERSION), "tar.gz")),
        ("windows", "x86_64") => Ok((format!("node-{}-win-x64", NODE_LTS_VERSION), "zip")),
        ("windows", "aarch64") => Ok((format!("node-{}-win-arm64", NODE_LTS_VERSION), "zip")),
        ("linux", "x86_64") => Ok((format!("node-{}-linux-x64", NODE_LTS_VERSION), "tar.gz")),
        ("linux", "aarch64") => Ok((format!("node-{}-linux-arm64", NODE_LTS_VERSION), "tar.gz")),
        (os, arch) => Err(format!("Unsupported platform for Node.js: {}-{}", os, arch)),
    }
}

/// Check if npm is available on the system (not counting local Node.js).
async fn is_system_npm_available() -> bool {
    let enriched_path = build_enriched_path();

    // 1. Direct PATH check
    #[cfg(target_os = "windows")]
    let result = {
        let mut cmd = Command::new("cmd");
        cmd.args(["/C", "npm.cmd", "--version"])
            .env("PATH", &enriched_path)
            .stdin(Stdio::null())
            .creation_flags(0x08000000);
        tokio::time::timeout(std::time::Duration::from_secs(10), cmd.output()).await
    };
    #[cfg(not(target_os = "windows"))]
    let result = {
        let mut cmd = Command::new("npm");
        cmd.arg("--version")
            .env("PATH", &enriched_path)
            .stdin(Stdio::null());
        tokio::time::timeout(std::time::Duration::from_secs(10), cmd.output()).await
    };

    if matches!(&result, Ok(Ok(output)) if output.status.success()) {
        return true;
    }

    // 2. Fallback: login shell (macOS/Linux GUI apps don't inherit shell PATH)
    #[cfg(not(target_os = "windows"))]
    {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
        let shell_result = {
            let mut cmd = Command::new(&shell);
            cmd.args(["-l", "-c", "npm --version"])
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::null());
            tokio::time::timeout(std::time::Duration::from_secs(10), cmd.output()).await
        };
        if matches!(shell_result, Ok(Ok(output)) if output.status.success()) {
            eprintln!(
                "npm found via login shell ({}) but not via enriched PATH",
                shell
            );
            return true;
        }
    }

    false
}

#[derive(Serialize)]
struct NodeEnvStatus {
    node_available: bool,
    node_version: Option<String>,
    node_source: Option<String>, // "system" | "local"
    npm_available: bool,
}

#[tauri::command]
async fn check_node_env() -> Result<NodeEnvStatus, String> {
    let enriched_path = build_enriched_path();

    // 1. Check local Node.js first
    if let Some(local_bin) = get_local_node_bin() {
        let node_path = local_bin.join(if cfg!(target_os = "windows") {
            "node.exe"
        } else {
            "node"
        });
        let mut node_cmd = Command::new(&node_path);
        node_cmd.arg("--version").stdin(Stdio::null());
        #[cfg(target_os = "windows")]
        node_cmd.creation_flags(0x08000000);
        if let Ok(Ok(output)) =
            tokio::time::timeout(std::time::Duration::from_secs(10), node_cmd.output()).await
        {
            if output.status.success() {
                let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
                return Ok(NodeEnvStatus {
                    node_available: true,
                    node_version: Some(version),
                    node_source: Some("local".to_string()),
                    npm_available: true, // local Node.js always comes with npm
                });
            }
        }
    }

    // 2. Check system Node.js
    #[cfg(target_os = "windows")]
    let node_result = {
        let mut cmd = Command::new("cmd");
        cmd.args(["/C", "node", "--version"])
            .env("PATH", &enriched_path)
            .stdin(Stdio::null())
            .creation_flags(0x08000000);
        tokio::time::timeout(std::time::Duration::from_secs(10), cmd.output()).await
    };
    #[cfg(not(target_os = "windows"))]
    let node_result = {
        let mut cmd = Command::new("node");
        cmd.arg("--version")
            .env("PATH", &enriched_path)
            .stdin(Stdio::null());
        tokio::time::timeout(std::time::Duration::from_secs(10), cmd.output()).await
    };

    match node_result {
        Ok(Ok(output)) if output.status.success() => {
            let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
            let npm_available = is_system_npm_available().await;
            Ok(NodeEnvStatus {
                node_available: true,
                node_version: Some(version),
                node_source: Some("system".to_string()),
                npm_available,
            })
        }
        _ => Ok(NodeEnvStatus {
            node_available: false,
            node_version: None,
            node_source: None,
            npm_available: is_system_npm_available().await,
        }),
    }
}

/// Download and extract Node.js LTS to the local app directory.
#[tauri::command]
async fn install_node_env(app: AppHandle) -> Result<(), String> {
    let china = is_china_network().await;
    install_node_env_inner(&app, china).await
}

async fn install_node_env_inner(app: &AppHandle, china: bool) -> Result<(), String> {
    let (archive_name, ext) = get_node_archive_info()?;
    let filename = format!("{}.{}", archive_name, ext);

    let install_dir = node_download_dir()?;
    std::fs::create_dir_all(&install_dir)
        .map_err(|e| format!("Failed to create node dir: {}", e))?;

    let client = build_smart_http_client(
        std::time::Duration::from_secs(10),
        std::time::Duration::from_secs(120),
    )
    .await;

    // Network-aware source ordering
    let sources: Vec<String> = if china {
        vec![
            format!("{}/{}/{}", NODE_DIST_NPMMIRROR, NODE_LTS_VERSION, filename),
            format!("{}/{}/{}", NODE_DIST_HUAWEI, NODE_LTS_VERSION, filename),
            format!("{}/{}/{}", NODE_DIST_OFFICIAL, NODE_LTS_VERSION, filename),
        ]
    } else {
        vec![
            format!("{}/{}/{}", NODE_DIST_OFFICIAL, NODE_LTS_VERSION, filename),
            format!("{}/{}/{}", NODE_DIST_NPMMIRROR, NODE_LTS_VERSION, filename),
        ]
    };

    let mut last_err = String::new();
    let mut archive_bytes: Option<Vec<u8>> = None;

    for (i, url) in sources.iter().enumerate() {
        eprintln!("Trying Node.js download: {}", url);
        let _ = emit_to_frontend(
            app,
            "setup:download:progress",
            serde_json::json!({
                "downloaded": 0, "total": 0, "percent": 0, "phase": "node_downloading"
            }),
        );

        match download_with_progress(app, &client, url, "node_downloading").await {
            Ok(bytes) => {
                eprintln!("Node.js download succeeded from source {}", i);
                archive_bytes = Some(bytes);
                break;
            }
            Err(e) => {
                last_err = format!("Source {}: {}", url, e);
                eprintln!("{}", last_err);
            }
        }
    }

    let bytes = archive_bytes
        .ok_or_else(|| format!("All Node.js download sources failed: {}", last_err))?;

    // Extract
    let _ = emit_to_frontend(
        app,
        "setup:download:progress",
        serde_json::json!({
            "downloaded": 0, "total": 0, "percent": 85, "phase": "node_extracting"
        }),
    );

    extract_node_archive(&bytes, ext, &archive_name, &install_dir)?;

    // Set executable permissions on Unix
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let bin_dir = install_dir.join("bin");
        if bin_dir.exists() {
            if let Ok(entries) = std::fs::read_dir(&bin_dir) {
                for entry in entries.flatten() {
                    let _ = std::fs::set_permissions(
                        entry.path(),
                        std::fs::Permissions::from_mode(0o755),
                    );
                }
            }
        }
    }

    let _ = emit_to_frontend(
        app,
        "setup:download:progress",
        serde_json::json!({
            "downloaded": 0, "total": 0, "percent": 100, "phase": "node_complete"
        }),
    );

    eprintln!(
        "Node.js {} installed to {:?}",
        NODE_LTS_VERSION, install_dir
    );
    Ok(())
}

// ─── Git for Windows (PortableGit) local deployment ─────────────────────────

/// PortableGit version for auto-deployment on Windows (when git-bash is missing).
#[cfg(target_os = "windows")]
const GIT_PORTABLE_VERSION: &str = "2.47.1.2";

/// Git for Windows release tag (used in download URLs).
#[cfg(target_os = "windows")]
const GIT_RELEASE_TAG: &str = "v2.47.1.windows.2";

/// GitHub releases URL for Git for Windows.
#[cfg(target_os = "windows")]
const GIT_DIST_GITHUB: &str = "https://github.com/git-for-windows/git/releases/download";

/// China mirror: npmmirror binary mirror.
#[cfg(target_os = "windows")]
const GIT_DIST_NPMMIRROR: &str = "https://registry.npmmirror.com/-/binary/git-for-windows";

/// China mirror: Huawei Cloud.
#[cfg(target_os = "windows")]
const GIT_DIST_HUAWEI: &str = "https://mirrors.huaweicloud.com/git-for-windows";

/// Download and install PortableGit to provide bash.exe on Windows.
/// The .7z.exe self-extracting archive is downloaded and executed silently.
#[cfg(target_os = "windows")]
async fn install_git_bash_inner(app: &AppHandle, china: bool) -> Result<(), String> {
    let install_dir = git_download_dir()?;

    // If an incomplete installation exists (no bash.exe), clean it up
    if install_dir.exists() {
        let bash = install_dir.join("bin").join("bash.exe");
        if !bash.exists() {
            eprintln!("Incomplete Git installation found, cleaning up...");
            let _ = std::fs::remove_dir_all(&install_dir);
        }
    }

    // Already installed?
    if install_dir.join("bin").join("bash.exe").exists() {
        eprintln!("PortableGit already installed at {:?}", install_dir);
        return Ok(());
    }

    std::fs::create_dir_all(&install_dir)
        .map_err(|e| format!("Failed to create git dir: {}", e))?;

    // Determine architecture: x64 or arm64 (64-bit only)
    let arch_suffix = match std::env::consts::ARCH {
        "aarch64" => "arm64",
        _ => "64", // x86_64 and fallback
    };
    let filename = format!(
        "PortableGit-{}-{}-bit.7z.exe",
        GIT_PORTABLE_VERSION, arch_suffix
    );

    let sources: Vec<String> = if china {
        vec![
            // China: Huawei fastest, then npmmirror, GitHub last
            format!("{}/{}/{}", GIT_DIST_HUAWEI, GIT_RELEASE_TAG, filename),
            format!("{}/{}/{}", GIT_DIST_NPMMIRROR, GIT_RELEASE_TAG, filename),
            format!("{}/{}/{}", GIT_DIST_GITHUB, GIT_RELEASE_TAG, filename),
        ]
    } else {
        vec![
            format!("{}/{}/{}", GIT_DIST_GITHUB, GIT_RELEASE_TAG, filename),
            format!("{}/{}/{}", GIT_DIST_HUAWEI, GIT_RELEASE_TAG, filename),
            format!("{}/{}/{}", GIT_DIST_NPMMIRROR, GIT_RELEASE_TAG, filename),
        ]
    };

    let client = build_smart_http_client(
        std::time::Duration::from_secs(15), // Fast failover between mirrors
        std::time::Duration::from_secs(300), // 5 min for large download
    )
    .await;

    let mut last_err = String::new();
    let mut archive_bytes: Option<Vec<u8>> = None;

    for url in &sources {
        eprintln!("Trying PortableGit download: {}", url);
        let _ = emit_to_frontend(
            app,
            "setup:download:progress",
            serde_json::json!({
                "downloaded": 0, "total": 0, "percent": 0, "phase": "git_downloading"
            }),
        );

        match download_with_progress(app, &client, url, "git_downloading").await {
            Ok(bytes) => {
                eprintln!("PortableGit download succeeded ({} bytes)", bytes.len());
                archive_bytes = Some(bytes);
                break;
            }
            Err(e) => {
                last_err = format!("Source {}: {}", url, e);
                eprintln!("{}", last_err);
            }
        }
    }

    let bytes =
        archive_bytes.ok_or_else(|| format!("All Git download sources failed: {}", last_err))?;

    // Write the .7z.exe to a temp file
    let temp_path = install_dir.join(&filename);
    std::fs::write(&temp_path, &bytes)
        .map_err(|e| format!("Failed to write PortableGit archive: {}", e))?;

    let _ = emit_to_frontend(
        app,
        "setup:download:progress",
        serde_json::json!({
            "downloaded": 0, "total": 0, "percent": 85, "phase": "git_extracting"
        }),
    );

    // Run the self-extracting archive silently: -o<dir> -y
    eprintln!("Extracting PortableGit to {:?}...", install_dir);
    let extract_result = tokio::time::timeout(
        std::time::Duration::from_secs(120),
        Command::new(&temp_path)
            .args([&format!("-o{}", install_dir.display()), "-y"])
            .stdin(Stdio::null())
            .creation_flags(0x08000000) // CREATE_NO_WINDOW
            .output(),
    )
    .await;

    // Clean up the downloaded archive regardless of result
    let _ = std::fs::remove_file(&temp_path);

    match extract_result {
        Ok(Ok(output)) if output.status.success() => {
            eprintln!("PortableGit extraction succeeded");
        }
        Ok(Ok(output)) => {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!(
                "PortableGit extraction failed (exit {}): {}",
                output.status, stderr
            ));
        }
        Ok(Err(e)) => {
            return Err(format!("Failed to run PortableGit extractor: {}", e));
        }
        Err(_) => {
            return Err("PortableGit extraction timed out after 120s".to_string());
        }
    }

    // Verify bash.exe exists
    let bash = install_dir.join("bin").join("bash.exe");
    if !bash.exists() {
        return Err("bash.exe not found after PortableGit extraction".to_string());
    }

    let _ = emit_to_frontend(
        app,
        "setup:download:progress",
        serde_json::json!({
            "downloaded": 0, "total": 0, "percent": 100, "phase": "git_complete"
        }),
    );

    eprintln!("PortableGit installed to {:?}", install_dir);
    Ok(())
}

/// Download a URL with streaming progress events.
async fn download_with_progress(
    app: &AppHandle,
    client: &reqwest::Client,
    url: &str,
    phase: &str,
) -> Result<Vec<u8>, String> {
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }

    let total = resp.content_length().unwrap_or(0);
    let mut downloaded: u64 = 0;
    let mut bytes = Vec::with_capacity(total as usize);
    let mut stream = resp.bytes_stream();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Stream error: {}", e))?;
        bytes.extend_from_slice(&chunk);
        downloaded += chunk.len() as u64;

        let percent = if total > 0 {
            (downloaded * 80 / total) as u8
        } else {
            0
        };
        let _ = emit_to_frontend(
            app,
            "setup:download:progress",
            serde_json::json!({
                "downloaded": downloaded, "total": total, "percent": percent, "phase": phase
            }),
        );
    }

    Ok(bytes)
}

/// Extract a Node.js archive (tar.gz or zip) into the target directory.
fn extract_node_archive(
    data: &[u8],
    ext: &str,
    _archive_name: &str,
    install_dir: &std::path::Path,
) -> Result<(), String> {
    match ext {
        "tar.gz" => {
            let decoder = flate2::read::GzDecoder::new(std::io::Cursor::new(data));
            let mut archive = tar::Archive::new(decoder);

            // Node.js tar.gz extracts to a subdirectory like "node-v22.22.0-darwin-arm64/"
            // We want the contents directly in install_dir
            for entry in archive.entries().map_err(|e| format!("tar error: {}", e))? {
                let mut entry = entry.map_err(|e| format!("tar entry error: {}", e))?;
                let path = entry.path().map_err(|e| format!("path error: {}", e))?;

                // Strip the top-level directory (e.g., "node-v22.22.0-darwin-arm64/bin/node" -> "bin/node")
                let stripped: std::path::PathBuf = path
                    .components()
                    .skip(1) // skip "node-v22.22.0-platform/"
                    .collect();

                if stripped.as_os_str().is_empty() {
                    continue; // skip the top-level dir itself
                }

                let target = install_dir.join(&stripped);
                if let Some(parent) = target.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }

                entry
                    .unpack(&target)
                    .map_err(|e| format!("unpack error for {:?}: {}", stripped, e))?;
            }
            Ok(())
        }
        "zip" => {
            let reader = std::io::Cursor::new(data);
            let mut archive =
                zip::ZipArchive::new(reader).map_err(|e| format!("zip open error: {}", e))?;

            for i in 0..archive.len() {
                let mut file = archive
                    .by_index(i)
                    .map_err(|e| format!("zip entry error: {}", e))?;

                let name = file.name().to_string();
                // Strip top-level directory (e.g., "node-v22.22.0-win-x64/node.exe" -> "node.exe")
                let stripped: String = name.splitn(2, '/').nth(1).unwrap_or("").to_string();
                if stripped.is_empty() {
                    continue;
                }

                let target = install_dir.join(&stripped);
                if file.is_dir() {
                    let _ = std::fs::create_dir_all(&target);
                } else {
                    if let Some(parent) = target.parent() {
                        let _ = std::fs::create_dir_all(parent);
                    }
                    let mut outfile = std::fs::File::create(&target)
                        .map_err(|e| format!("create file error: {}", e))?;
                    std::io::copy(&mut file, &mut outfile)
                        .map_err(|e| format!("write error: {}", e))?;
                }
            }
            Ok(())
        }
        _ => Err(format!("Unsupported archive format: {}", ext)),
    }
}

/// Start the Claude OAuth login flow by running `claude login`.
#[tauri::command]
async fn start_claude_login(app: AppHandle) -> Result<(), String> {
    let claude_bin = find_claude_binary().ok_or_else(|| {
        "Claude CLI not found. Please install it first via the Setup Wizard.".to_string()
    })?;
    let enriched_path = build_enriched_path();

    // On Windows, .cmd/.bat files must be launched via cmd /C (same logic as start_session)
    #[cfg(target_os = "windows")]
    let mut child = {
        let needs_cmd = claude_bin.ends_with(".cmd")
            || claude_bin.ends_with(".bat")
            || (!claude_bin.contains('\\')
                && !claude_bin.contains('/')
                && !claude_bin.contains('.'));
        let mut cmd = if needs_cmd {
            let mut c = Command::new("cmd");
            c.arg("/C").arg(&claude_bin);
            c
        } else {
            Command::new(&claude_bin)
        };
        client_runtime::apply_to_tokio_command(&mut cmd)?;
        cmd.args(["login"])
            .env("PATH", &enriched_path)
            .env_remove("CLAUDECODE")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .creation_flags(0x08000000) // CREATE_NO_WINDOW
            .spawn()
            .map_err(|e| format!("Failed to start login (tried '{}'): {}", claude_bin, e))?
    };
    #[cfg(not(target_os = "windows"))]
    let mut child = {
        let mut login_command = Command::new(&claude_bin);
        client_runtime::apply_to_tokio_command(&mut login_command)?;
        login_command
            .args(["login"])
            .env("PATH", &enriched_path)
            .env_remove("CLAUDECODE")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Failed to start login (tried '{}'): {}", claude_bin, e))?
    };

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let app1 = app.clone();
    let stdout_handle = tokio::spawn(async move {
        if let Some(out) = stdout {
            let reader = BufReader::new(out);
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = emit_to_frontend(
                    &app1,
                    "setup:login:output",
                    serde_json::json!({ "stream": "stdout", "line": line }),
                );
            }
        }
    });

    let app2 = app.clone();
    let stderr_handle = tokio::spawn(async move {
        if let Some(err) = stderr {
            let reader = BufReader::new(err);
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = emit_to_frontend(
                    &app2,
                    "setup:login:output",
                    serde_json::json!({ "stream": "stderr", "line": line }),
                );
            }
        }
    });

    let status = child
        .wait()
        .await
        .map_err(|e| format!("Login process error: {}", e))?;

    let _ = stdout_handle.await;
    let _ = stderr_handle.await;

    let code = status.code().unwrap_or(-1);
    let _ = app.emit_to(
        "main",
        "setup:login:exit",
        serde_json::json!({ "code": code }),
    );

    if code != 0 {
        return Err(format!("Login exited with code {}", code));
    }
    Ok(())
}

#[derive(Debug, Serialize, Deserialize)]
pub(crate) struct AuthStatus {
    pub(crate) authenticated: bool,
    pub(crate) unknown: bool,
}

pub(crate) async fn probe_claude_auth_status() -> Result<AuthStatus, String> {
    let claude_bin = resolve_claude_sdk_runtime()?.path;
    let enriched_path = build_enriched_path();

    #[cfg(target_os = "windows")]
    let mut cmd = if claude_needs_cmd_wrapper(&claude_bin) {
        let mut c = Command::new("cmd");
        c.args(["/C", &claude_bin, "auth", "status", "--json"]);
        c
    } else {
        let mut c = Command::new(&claude_bin);
        c.args(["auth", "status", "--json"]);
        c
    };
    #[cfg(not(target_os = "windows"))]
    let mut cmd = {
        let mut c = Command::new(&claude_bin);
        c.args(["auth", "status", "--json"]);
        c
    };
    client_runtime::apply_to_tokio_command(&mut cmd)?;
    cmd.env("PATH", &enriched_path).env_remove("CLAUDECODE");
    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000);
    let result = tokio::time::timeout(std::time::Duration::from_secs(8), cmd.output()).await;

    match result {
        Ok(Ok(output)) => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);
            let payload = serde_json::from_str::<Value>(stdout.trim())
                .or_else(|_| serde_json::from_str::<Value>(stderr.trim()));
            if let Ok(payload) = payload {
                if let Some(logged_in) = payload.get("loggedIn").and_then(Value::as_bool) {
                    return Ok(AuthStatus {
                        authenticated: logged_in,
                        unknown: false,
                    });
                }
            }
            let combined = format!("{stdout} {stderr}").to_ascii_lowercase();
            if combined.contains("not authenticated")
                || combined.contains("not logged in")
                || combined.contains("login required")
                || combined.contains("unauthorized")
            {
                return Ok(AuthStatus {
                    authenticated: false,
                    unknown: false,
                });
            }
            Err(format!(
                "Claude auth status returned an unreadable response (exit {:?})",
                output.status.code()
            ))
        }
        Ok(Err(e)) => Err(format!("Failed to run auth check: {}", e)),
        Err(_) => {
            // Timeout — cannot determine auth status
            Ok(AuthStatus {
                authenticated: false,
                unknown: true,
            })
        }
    }
}

/// Check the CLI's own authoritative authentication state for the active
/// runtime environment. Credential-file presence alone is not proof of login.
#[tauri::command]
async fn check_claude_auth() -> Result<AuthStatus, String> {
    probe_claude_auth_status().await
}

#[tauri::command]
fn get_claude_runtime_environment() -> Result<client_runtime::RuntimeEnvironmentStatus, String> {
    client_runtime::runtime_environment_status()
}

#[tauri::command]
fn set_claude_runtime_environment(
    environment: String,
) -> Result<client_runtime::RuntimeEnvironmentStatus, String> {
    client_runtime::select_runtime_environment(environment)
}

/// Load custom session display names from the unified metadata authority.
#[tauri::command]
async fn load_custom_previews() -> Result<Value, String> {
    session_metadata::load_custom_previews()
}

/// Save custom session display names to the unified metadata authority.
#[tauri::command]
async fn save_custom_previews(data: Value) -> Result<(), String> {
    session_metadata::save_custom_previews(data)
}

/// Load the last provider/key route and main-model choice for each conversation.
#[tauri::command]
async fn load_conversation_runtime_preferences() -> Result<Value, String> {
    session_metadata::load_conversation_runtime_preferences()
}

/// Persist per-conversation runtime choices without ever copying credentials.
#[tauri::command]
async fn save_conversation_runtime_preferences(data: Value) -> Result<(), String> {
    session_metadata::save_conversation_runtime_preferences(data)
}

fn blackbox_data_path(filename: &str) -> Result<std::path::PathBuf, String> {
    let home = dirs::home_dir().ok_or("Cannot find home dir")?;
    let dir = home.join(".blackbox");
    if !dir.exists() {
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("Failed to create .blackbox dir: {}", e))?;
    }
    Ok(dir.join(filename))
}

/// Load pinned session IDs from disk.
#[tauri::command]
async fn load_pinned_sessions() -> Result<Value, String> {
    session_metadata::load_pinned_sessions()
}

/// Save pinned session IDs to disk.
#[tauri::command]
async fn save_pinned_sessions(data: Value) -> Result<(), String> {
    session_metadata::save_pinned_sessions(data)
}

#[tauri::command]
async fn load_archived_sessions() -> Result<Value, String> {
    session_metadata::load_archived_sessions()
}

/// Save archived session IDs to disk.
#[tauri::command]
async fn save_archived_sessions(data: Value) -> Result<(), String> {
    session_metadata::save_archived_sessions(data)
}

/// Load session groups (the grouping ledger) from disk.
#[tauri::command]
async fn load_session_groups() -> Result<Value, String> {
    session_metadata::load_session_groups()
}

/// Save session groups (the grouping ledger) to disk.
#[tauri::command]
async fn save_session_groups(data: Value) -> Result<(), String> {
    session_metadata::save_session_groups(data)
}

/// Export portable task-group, order, pin, archive, and custom-title metadata.
/// Conversation JSONLs and credentials are deliberately excluded.
#[tauri::command]
async fn export_session_organization(
    path: String,
) -> Result<session_metadata::SessionOrganizationReport, String> {
    session_metadata::export_session_organization(path)
}

/// Inspect a portable organization file without modifying local metadata.
#[tauri::command]
async fn preview_session_organization_import(
    path: String,
) -> Result<session_metadata::SessionOrganizationReport, String> {
    session_metadata::preview_session_organization_import(path)
}

/// Additively merge a portable organization file. Local removals and local
/// conflict choices always win; the import cannot delete existing metadata.
#[tauri::command]
async fn import_session_organization(
    path: String,
) -> Result<session_metadata::SessionOrganizationReport, String> {
    session_metadata::import_session_organization(path)
}

/// Load thread-scoped Plan state. Plans are Black Box control metadata rather
/// than model memory, so they share the same private application data root as
/// Goals while remaining a separate authority file.
#[tauri::command]
async fn load_plans() -> Result<Value, String> {
    let path = blackbox_data_path("plans.json")?;
    if !path.exists() {
        return Ok(serde_json::json!({}));
    }
    let metadata =
        std::fs::metadata(&path).map_err(|e| format!("Failed to inspect plans: {}", e))?;
    if metadata.len() > 1024 * 1024 {
        return Err("Plans file exceeds the 1 MiB safety limit".to_string());
    }
    let content =
        std::fs::read_to_string(&path).map_err(|e| format!("Failed to read plans: {}", e))?;
    let value: Value =
        serde_json::from_str(&content).map_err(|e| format!("Failed to parse plans: {}", e))?;
    if !value.is_object() {
        return Err("Plans file must contain a JSON object".to_string());
    }
    Ok(value)
}

/// Atomically replace Plan state so progress cannot be truncated by a crash.
#[tauri::command]
async fn save_plans(data: Value) -> Result<(), String> {
    if !data.is_object() {
        return Err("Plans payload must be a JSON object".to_string());
    }
    let content = serde_json::to_vec_pretty(&data)
        .map_err(|e| format!("Failed to serialize plans: {}", e))?;
    if content.len() > 1024 * 1024 {
        return Err("Plans payload exceeds the 1 MiB safety limit".to_string());
    }
    let path = blackbox_data_path("plans.json")?;
    let parent = path.parent().ok_or("Plans path has no parent directory")?;
    let mut temp = tempfile::NamedTempFile::new_in(parent)
        .map_err(|e| format!("Failed to create temporary plans file: {}", e))?;
    use std::io::Write;
    temp.write_all(&content)
        .map_err(|e| format!("Failed to write temporary plans file: {}", e))?;
    temp.as_file()
        .sync_all()
        .map_err(|e| format!("Failed to sync temporary plans file: {}", e))?;
    temp.persist(&path)
        .map_err(|e| format!("Failed to atomically replace plans file: {}", e.error))?;
    Ok(())
}

/// Load parent/child thread lineage for user-created conversation forks.
#[tauri::command]
async fn load_fork_lineage() -> Result<Value, String> {
    let path = blackbox_data_path("forks.json")?;
    if !path.exists() {
        return Ok(serde_json::json!({}));
    }
    let metadata = std::fs::metadata(&path).map_err(|e| format!("Failed to inspect forks: {e}"))?;
    if metadata.len() > 1024 * 1024 {
        return Err("Fork lineage file exceeds the 1 MiB safety limit".to_string());
    }
    let content =
        std::fs::read_to_string(&path).map_err(|e| format!("Failed to read forks: {e}"))?;
    let value: Value =
        serde_json::from_str(&content).map_err(|e| format!("Failed to parse forks: {e}"))?;
    if !value.is_object() {
        return Err("Fork lineage file must contain a JSON object".to_string());
    }
    Ok(value)
}

/// Atomically replace fork lineage so a child never silently loses its parent link.
#[tauri::command]
async fn save_fork_lineage(data: Value) -> Result<(), String> {
    if !data.is_object() {
        return Err("Fork lineage payload must be a JSON object".to_string());
    }
    let content =
        serde_json::to_vec_pretty(&data).map_err(|e| format!("Failed to serialize forks: {e}"))?;
    if content.len() > 1024 * 1024 {
        return Err("Fork lineage payload exceeds the 1 MiB safety limit".to_string());
    }
    let path = blackbox_data_path("forks.json")?;
    let parent = path
        .parent()
        .ok_or("Fork lineage path has no parent directory")?;
    let mut temp = tempfile::NamedTempFile::new_in(parent)
        .map_err(|e| format!("Failed to create temporary forks file: {e}"))?;
    use std::io::Write;
    temp.write_all(&content)
        .map_err(|e| format!("Failed to write temporary forks file: {e}"))?;
    temp.as_file()
        .sync_all()
        .map_err(|e| format!("Failed to sync temporary forks file: {e}"))?;
    temp.persist(&path)
        .map_err(|e| format!("Failed to atomically replace forks file: {}", e.error))?;
    Ok(())
}

/// Load user-authored inline review comments. Comments are application
/// metadata tied to a run/path/line, never injected into model context until
/// the user explicitly opens the task with a prepared feedback draft.
#[tauri::command]
async fn load_review_comments() -> Result<Value, String> {
    let path = blackbox_data_path("review-comments.json")?;
    if !path.exists() {
        return Ok(serde_json::json!({}));
    }
    let metadata =
        std::fs::metadata(&path).map_err(|e| format!("Failed to inspect review comments: {e}"))?;
    if metadata.len() > 2 * 1024 * 1024 {
        return Err("Review comments file exceeds the 2 MiB safety limit".to_string());
    }
    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read review comments: {e}"))?;
    let value: Value = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse review comments: {e}"))?;
    if !value.is_object() {
        return Err("Review comments file must contain a JSON object".to_string());
    }
    Ok(value)
}

/// Atomically replace inline review comments so a crash cannot truncate notes.
#[tauri::command]
async fn save_review_comments(data: Value) -> Result<(), String> {
    if !data.is_object() {
        return Err("Review comments payload must be a JSON object".to_string());
    }
    let content = serde_json::to_vec_pretty(&data)
        .map_err(|e| format!("Failed to serialize review comments: {e}"))?;
    if content.len() > 2 * 1024 * 1024 {
        return Err("Review comments payload exceeds the 2 MiB safety limit".to_string());
    }
    let path = blackbox_data_path("review-comments.json")?;
    let parent = path
        .parent()
        .ok_or("Review comments path has no parent directory")?;
    let mut temp = tempfile::NamedTempFile::new_in(parent)
        .map_err(|e| format!("Failed to create temporary review comments file: {e}"))?;
    use std::io::Write;
    temp.write_all(&content)
        .map_err(|e| format!("Failed to write temporary review comments file: {e}"))?;
    temp.as_file()
        .sync_all()
        .map_err(|e| format!("Failed to sync temporary review comments file: {e}"))?;
    temp.persist(&path).map_err(|e| {
        format!(
            "Failed to atomically replace review comments file: {}",
            e.error
        )
    })?;
    Ok(())
}

/// Max wall-clock time the title-gen spawn may run. Beyond this we return
/// `Ok(None)` — the frontend shows a default title and the user can rename
/// later. Chosen for two reasons:
///   1. Title gen is best-effort cosmetic metadata; hanging the main stream on
///      it (v0.5.2-era regression) is never acceptable.
///   2. Haiku round-trips complete in ~2–4s typical. 10s covers cold TLS +
///      provider warmup without tolerating outright hangs.
const TITLE_GEN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// Generate a short AI title for a session by spawning a separate Claude CLI process.
/// Uses Haiku model for fast, cheap title generation. Completely isolated from the
/// main conversation channel — spawns a new process that exits after one response.
///
/// Returns:
///   - `Ok(Some(title))` — successful, usable title
///   - `Ok(None)` — timeout, empty/unparseable output, or provider missing haiku
///     mapping. Caller should fall back to default title. Never blocks the UI.
///   - `Err(msg)` — hard failure worth surfacing (binary missing, bad input).
#[tauri::command]
async fn generate_session_title(
    user_message: String,
    assistant_message: String,
    provider_id: Option<String>,
) -> Result<Option<String>, String> {
    // Safe UTF-8 truncation (don't slice mid-character)
    fn safe_truncate(s: &str, max_bytes: usize) -> &str {
        if s.len() <= max_bytes {
            return s;
        }
        let mut end = max_bytes;
        while end > 0 && !s.is_char_boundary(end) {
            end -= 1;
        }
        &s[..end]
    }

    let user_msg = safe_truncate(&user_message, 500);
    let asst_msg = safe_truncate(&assistant_message, 500);

    let prompt = format!(
        "Generate a very short title (5-10 words, in the same language as the conversation) for this conversation. Reply with ONLY the title text, no quotes, no extra text, no explanation.\n\nUser: {}\n\nAssistant: {}",
        user_msg, asst_msg
    );

    // Resolve model and env vars for provider
    let (mut provider_env, mut provider_keys_to_remove, model_name) =
        if let Some(ref pid) = provider_id {
            let (env, keys, _args, _caps) = resolve_provider_env(Some(pid))?;
            // Find haiku tier mapping from provider
            let providers_file = read_providers_file()?;
            let provider = providers_file.providers.iter().find(|p| p.id == *pid);
            let haiku_model = provider.and_then(|p| {
                p.model_mappings
                    .iter()
                    .find(|m| m.tier == "haiku" && !m.provider_model.is_empty())
                    .map(|m| m.provider_model.clone())
            });
            match haiku_model {
                Some(m) => (env, keys, m),
                None => {
                    // Provider has no haiku mapping — degrade silently, don't error.
                    eprintln!(
                        "[title-gen] provider {} has no haiku mapping, skipping",
                        pid
                    );
                    return Ok(None);
                }
            }
        } else {
            (
                HashMap::new(),
                vec![],
                "claude-haiku-4-5-20251001".to_string(),
            )
        };
    let _provider_gateway_guard =
        route_provider_through_gateway(provider_id.as_deref(), &mut provider_env).await?;

    // Title generation is still an SDK turn. Keep it on the same selected,
    // health-probed runtime as ordinary and scheduled conversations.
    let claude_bin = resolve_claude_sdk_runtime()?.path;

    let enriched_path = build_enriched_path();

    // Spawn a one-shot CLI process: -p for single prompt, --output-format json for structured output
    let mut args = vec![
        "-p".to_string(),
        prompt,
        "--model".to_string(),
        model_name,
        "--output-format".to_string(),
        "json".to_string(),
        "--max-turns".to_string(),
        "1".to_string(),
        "--dangerously-skip-permissions".to_string(),
    ];
    if provider_id.is_some() {
        args.extend(["--setting-sources".to_string(), "project,local".to_string()]);
    }

    // Build the unified env config. Replaces ~20 lines of scattered .env /
    // .env_remove calls with a single grep-able "ClaudeEnvConfig" site.
    let auth_mode = if provider_id.is_some() {
        env_manager::AuthMode::ThirdParty
    } else {
        env_manager::AuthMode::Native
    };
    let mut extra = provider_env.clone();

    // Inject proxy env vars from login shell for GUI apps (macOS/Linux only)
    #[cfg(not(target_os = "windows"))]
    {
        let proxy_env = login_shell_proxy_env();
        for (k, v) in proxy_env {
            if std::env::var(k).is_err() && !extra.contains_key(k) {
                extra.insert(k.clone(), v.clone());
            }
        }
    }

    enforce_provider_loopback_child_env(
        provider_id.as_deref(),
        &mut extra,
        &mut provider_keys_to_remove,
    );

    let cfg = env_manager::ClaudeEnvConfig {
        auth_mode,
        enriched_path: Some(enriched_path),
        extra,
        extra_remove: provider_keys_to_remove,
    };

    let mut cmd = tokio::process::Command::new(&claude_bin);
    client_runtime::apply_to_tokio_command(&mut cmd)?;
    cmd.args(&args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    env_manager::apply_to_command(&mut cmd, &cfg);

    // Suppress console window on Windows
    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW

    // Spawn + wait under a timeout. If the child hangs (e.g. 401-retry loop
    // inside the Haiku CLI when ANTHROPIC_AUTH_TOKEN was set to ""),
    // `tokio::time::timeout` fires and we degrade instead of blocking the
    // main streaming loop forever.
    let child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn claude for title gen: {}", e))?;

    let output = match tokio::time::timeout(TITLE_GEN_TIMEOUT, child.wait_with_output()).await {
        Ok(Ok(out)) => out,
        Ok(Err(e)) => {
            return Err(format!("Failed to wait for title gen process: {}", e));
        }
        Err(_) => {
            eprintln!(
                "[title-gen] timed out after {}s, returning default title",
                TITLE_GEN_TIMEOUT.as_secs()
            );
            return Ok(None);
        }
    };

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        eprintln!(
            "[title-gen] process failed (status={:?}): {}",
            output.status.code(),
            stderr.chars().take(200).collect::<String>()
        );
        return Ok(None);
    }

    let stdout = String::from_utf8_lossy(&output.stdout);

    // Parse JSON output — Claude CLI --output-format json returns:
    // { "type": "result", "result": "the title text", ... }
    if let Ok(json) = serde_json::from_str::<Value>(stdout.trim()) {
        let title = json
            .get("result")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .trim_matches('"')
            .to_string();
        if title.is_empty() {
            return Ok(None);
        }
        return Ok(Some(title));
    }

    // Fallback: if not valid JSON, try to use raw stdout as title
    let raw = stdout.trim().trim_matches('"').to_string();
    if raw.is_empty() || raw.len() > 200 {
        return Ok(None);
    }
    Ok(Some(raw))
}

/// Open a native terminal window to run `claude login`.
/// On macOS: uses osascript to open Terminal.app.
/// On Linux: tries common terminal emulators.
/// On Windows: opens cmd.exe with enriched PATH.
#[tauri::command]
async fn open_terminal_login() -> Result<(), String> {
    let claude_bin = find_claude_binary().ok_or_else(|| {
        "Claude CLI not found. Please install it first via the Setup Wizard.".to_string()
    })?;
    let claude_config_dir = client_runtime::claude_config_dir()?;

    #[cfg(target_os = "macos")]
    {
        let command = format!(
            "CLAUDE_CONFIG_DIR={} {} login",
            shell_single_quote(&claude_config_dir.to_string_lossy()),
            shell_single_quote(&claude_bin)
        );
        let script = format!(
            r#"tell application "Terminal"
    activate
    do script "{}"
end tell"#,
            command.replace('\\', "\\\\").replace('"', "\\\"")
        );
        std::process::Command::new("osascript")
            .args(["-e", &script])
            .spawn()
            .map_err(|e| format!("Failed to open Terminal: {}", e))?;
    }

    #[cfg(target_os = "linux")]
    {
        // Try common terminal emulators in order of preference
        let xterm_cmd = format!("{} login", shell_single_quote(&claude_bin));
        let terminals = [
            ("gnome-terminal", vec!["--", &claude_bin, "login"]),
            ("konsole", vec!["-e", &claude_bin, "login"]),
            ("xterm", vec!["-e", xterm_cmd.as_str()]),
        ];
        let mut opened = false;
        for (term, args) in &terminals {
            if std::process::Command::new(term)
                .args(args.iter().copied())
                .env("CLAUDE_CONFIG_DIR", &claude_config_dir)
                .spawn()
                .is_ok()
            {
                opened = true;
                break;
            }
        }
        if !opened {
            return Err("No supported terminal emulator found".to_string());
        }
    }

    #[cfg(target_os = "windows")]
    {
        // Spawn cmd /k with CREATE_NEW_CONSOLE to open a visible terminal window.
        // This avoids the `start` command's tricky quoting rules.
        let enriched_path = build_enriched_path();
        std::process::Command::new("cmd")
            .arg("/k")
            .arg(&format!("\"{}\" login", claude_bin))
            .env("PATH", &enriched_path)
            .env("CLAUDE_CONFIG_DIR", &claude_config_dir)
            .creation_flags(0x00000010) // CREATE_NEW_CONSOLE
            .spawn()
            .map_err(|e| format!("Failed to open terminal: {}", e))?;
    }

    Ok(())
}

/// Set the macOS dock icon dynamically from base64-encoded PNG data.
#[tauri::command]
async fn set_dock_icon(app: AppHandle, png_base64: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use base64::Engine;
        let data = base64::engine::general_purpose::STANDARD
            .decode(&png_base64)
            .map_err(|e| format!("Invalid base64: {}", e))?;

        // NSApplication APIs must be called on the main thread
        app.run_on_main_thread(move || {
            objc::rc::autoreleasepool(|| unsafe {
                use objc::msg_send;
                use objc::runtime::{Class, Object};
                use objc::sel;
                use objc::sel_impl;

                let nsdata_class = Class::get("NSData").unwrap();
                let nsdata: *mut Object = msg_send![nsdata_class, alloc];
                let nsdata: *mut Object = msg_send![nsdata,
                    initWithBytes: data.as_ptr()
                    length: data.len()
                ];

                let nsimage_class = Class::get("NSImage").unwrap();
                let nsimage: *mut Object = msg_send![nsimage_class, alloc];
                let nsimage: *mut Object = msg_send![nsimage, initWithData: nsdata];

                if !nsimage.is_null() {
                    let nsapp_class = Class::get("NSApplication").unwrap();
                    let nsapp: *mut Object = msg_send![nsapp_class, sharedApplication];
                    let _: () = msg_send![nsapp, setApplicationIconImage: nsimage];
                }
            });
        })
        .map_err(|e| format!("Failed to run on main thread: {}", e))?;
    }

    #[cfg(not(target_os = "macos"))]
    let _ = app;

    Ok(())
}

#[tauri::command]
fn set_power_assertion(
    keep_system_awake: bool,
    keep_display_awake: bool,
    state: State<'_, PowerAssertionState>,
) -> Result<PowerAssertionStatus, String> {
    state.apply(keep_system_awake, keep_display_awake)
}

#[tauri::command]
fn get_power_assertion_status(
    state: State<'_, PowerAssertionState>,
) -> Result<PowerAssertionStatus, String> {
    state.status()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    static CLOSE_IN_PROGRESS: std::sync::atomic::AtomicBool =
        std::sync::atomic::AtomicBool::new(false);
    client_runtime::activate_selected_environment().unwrap_or_else(|error| {
        panic!("Black Box cannot activate its Claude environment: {error}")
    });
    client_runtime::initialize().unwrap_or_else(|error| {
        panic!("Black Box cannot initialize its Claude environment: {error}")
    });
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--background"]),
        ))
        .manage(ProcessManager::new())
        .manage(StdinManager::new())
        .manage(BypassModeMap::new())
        .manage(WatcherManager::default())
        .manage(PathAccessManager::new())
        .manage(CliMaintenanceState::default())
        .manage(app_update::AppUpdateState::default())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(PowerAssertionState::default())
        .plugin(tauri_plugin_process::init())
        .on_window_event(|window, event| {
            if desktop_pet::handle_window_event(window, event) {
                return;
            }
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                // The macOS red traffic-light hides only the window. Scheduled
                // work, live conversations and background Agents stay resident.
                // Cmd-Q / Quit follows the graceful process-settlement path.
                if let Err(error) = window.hide() {
                    eprintln!("[BLACKBOX] failed to hide main window: {error}");
                }
            }
        })
        .setup(|app| {
            // titleBarStyle: "Overlay" in tauri.conf.json handles macOS traffic lights
            // and native titlebar drag/double-click-to-maximize automatically.

            // Login-item launches host scheduled work without interrupting the
            // desktop session. A normal launch remains visible, and RunEvent::Reopen
            // below restores this hidden window when the user activates the app.
            if std::env::args().any(|argument| argument == "--background") {
                if let Some(window) = app.get_webview_window("main") {
                    window.hide()?;
                }
            }

            #[cfg(target_os = "macos")]
            {
                let show = MenuItem::with_id(
                    app,
                    "blackbox-show",
                    "Show Black Box",
                    true,
                    None::<&str>,
                )?;
                let quit = MenuItem::with_id(
                    app,
                    "blackbox-quit",
                    "Quit Black Box",
                    true,
                    None::<&str>,
                )?;
                let menu = Menu::with_items(app, &[&show, &quit])?;
                let mut tray = TrayIconBuilder::with_id("blackbox-menu-bar")
                    .tooltip("Black Box")
                    .icon_as_template(true)
                    .show_menu_on_left_click(false)
                    .menu(&menu)
                    .on_menu_event(|app, event| match event.id().as_ref() {
                        "blackbox-show" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                        "blackbox-quit" => app.exit(0),
                        _ => {}
                    })
                    .on_tray_icon_event(|tray, event| {
                        if matches!(
                            event,
                            TrayIconEvent::Click {
                                button: MouseButton::Left,
                                button_state: MouseButtonState::Up,
                                ..
                            }
                        ) {
                            if let Some(window) = tray.app_handle().get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                    });
                tray = tray.icon(menu_bar_template_icon());
                tray.build(app)?;
            }

            // Acquire the default assertion before the WebView finishes
            // hydrating persisted settings. The frontend immediately
            // reconciles this with the user's stored toggles.
            if let Err(error) = app.state::<PowerAssertionState>().apply(true, false) {
                eprintln!("[BLACKBOX] failed to acquire launch power assertion: {error}");
            }

            // Import the retired client's explicit ownership ledger before cleaning the
            // merged Black Box index. This never reads transcript contents.
            migrate_legacy_client_sessions();

            // One-time cleanup: purge desk_* entries from tracked_sessions.txt
            cleanup_tracked_sessions();

            // Persistent scheduled tasks are hosted by the desktop process.
            // Definitions survive restarts in ~/.blackbox/automations and are
            // reconciled into SQLite before each scheduler tick.
            automations::start_scheduler();
            if let Err(error) = automations::install_bundled_skills(app.handle()) {
                eprintln!("[BLACKBOX AUTOMATIONS] bundled skill install skipped: {error}");
            }

            // Propagate proxy env vars from login shell to the process environment
            // so that subprocesses and HTTP clients can reach external services
            // through the proxy.
            #[cfg(not(target_os = "windows"))]
            {
                let proxy_env = login_shell_proxy_env();
                for (k, v) in proxy_env {
                    if std::env::var(k).is_err() {
                        // SAFETY: called once during single-threaded setup
                        unsafe {
                            std::env::set_var(k, v);
                        }
                    }
                }
            }

            // The companion window owns its own persisted visibility and
            // position. Restoring it here does not hydrate or mutate sessions.
            desktop_pet::restore_if_enabled(app.handle());

            // Register test harness socket server (debug builds only).
            // Provides a Unix socket that blackbox-cli.mjs connects to for
            // automated GUI testing. Release builds never include this.
            #[cfg(debug_assertions)]
            {
                // Parallel isolated dev/smoke instances must never contend for
                // the global default socket. The existing debug CLI already
                // honors BLACKBOX_SOCKET, so keep both ends on one contract.
                let test_socket = std::env::var_os("BLACKBOX_SOCKET")
                    .map(std::path::PathBuf::from)
                    .unwrap_or_else(|| std::path::PathBuf::from("/tmp/blackbox-test.sock"));
                let mcp_config = tauri_plugin_mcp::PluginConfig::new("BLACKBOX".to_string())
                    .start_socket_server(true)
                    .socket_path(test_socket.clone());
                // The harness is diagnostic-only. A stale/colliding socket must
                // never turn a normal Dev app launch (including macOS "Reopen")
                // into an application crash. Smoke scripts still pass a unique
                // BLACKBOX_SOCKET and fail later if the harness is unavailable.
                match app
                    .handle()
                    .plugin(tauri_plugin_mcp::init_with_config(mcp_config))
                {
                    Ok(()) => eprintln!(
                        "[BLACKBOX] Test harness registered on {}",
                        test_socket.display()
                    ),
                    Err(error) => eprintln!(
                        "[BLACKBOX] Test harness unavailable on {}; continuing without it: {}",
                        test_socket.display(),
                        error
                    ),
                }
            }

            #[cfg(not(desktop))]
            let _ = app;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            start_claude_session,
            send_stdin,
            send_raw_stdin,
            kill_session,
            graceful_stop_session,
            list_active_processes,
            get_native_custom_model_options,
            get_cli_update_blockers,
            track_session,
            delete_session,
            list_sessions,
            get_task_location,
            handoff_task,
            search_sessions,
            load_session,
            load_fork_lineage,
            save_fork_lineage,
            load_review_comments,
            save_review_comments,
            add_path_grant,
            clear_path_grants,
            decode_project_dir,
            read_file_tree,
            search_file_tree,
            read_file_content,
            write_file_content,
            get_home_dir,
            copy_file,
            rename_file,
            delete_file,
            create_directory,
            open_in_vscode,
            reveal_in_finder,
            open_with_default_app,
            share_file,
            share_to_wechat,
            export_session_markdown,
            export_session_json,
            list_recent_projects,
            watch_directory,
            unwatch_directory,
            save_temp_file,
            get_file_size,
            check_file_access,
            read_file_base64,
            list_slash_commands,
            list_skills,
            list_agent_definitions,
            list_hook_definitions,
            list_hook_events,
            create_hook_definition,
            update_hook_definition,
            delete_hook_definition,
            get_identity_bootstrap_status,
            configure_identity_bootstrap,
            set_identity_bootstrap_enabled,
            read_skill,
            write_skill,
            delete_skill,
            toggle_skill_enabled,
            list_all_commands,
            run_git_command,
            rewind_files,
            rewind_all_transaction,
            rewind_session_conversation,
            set_dock_icon,
            set_power_assertion,
            get_power_assertion_status,
            experimental_foundation::get_experimental_foundation_status,
            experimental_foundation::initialize_experimental_runtime_fence,
            experimental_foundation::initialize_experimental_memory_store,
            experimental_foundation::record_experimental_no_effect_turn,
            experimental_foundation::preview_experimental_memory_import,
            experimental_foundation::execute_experimental_memory_import,
            experimental_rag::get_experimental_rag_consent_status,
            experimental_rag::initialize_experimental_rag_consent_store,
            experimental_rag::register_experimental_rag_source,
            experimental_rag::change_experimental_rag_source_consent,
            experimental_rag::create_experimental_rag_organization_proposal,
            experimental_rag::review_experimental_rag_organization_proposal,
            experimental_petpack::get_experimental_petpack_status,
            experimental_petpack::validate_experimental_petpack,
            experimental_managed_provider::get_experimental_managed_provider_status,
            experimental_managed_provider::initialize_experimental_managed_provider_store,
            experimental_managed_provider::register_experimental_provider_contract,
            experimental_managed_provider::create_experimental_managed_route_contract,
            experimental_managed_provider::record_experimental_managed_unknown_outcome,
            experimental_memory_recovery::get_experimental_memory_recovery_status,
            experimental_memory_recovery::initialize_experimental_memory_recovery,
            experimental_memory_recovery::prepare_experimental_memory_recovery_drill,
            experimental_memory_recovery::reconcile_experimental_memory_recovery_drill,
            experimental_memory_recovery::record_experimental_memory_quarantine_contract,
            experimental_memory_recovery::inspect_experimental_memory_recovery_journal,
            experimental_memory_promotion::get_experimental_memory_promotion_status,
            experimental_memory_promotion::initialize_experimental_memory_promotion,
            experimental_memory_promotion::assess_experimental_memory_dual_read,
            experimental_memory_promotion::prepare_experimental_memory_authority_switch,
            experimental_memory_promotion::capture_experimental_memory_raw_forensic_evidence,
            experimental_memory_promotion::prepare_experimental_memory_manual_restore,
            experimental_memory_promotion::inspect_experimental_memory_promotion_journal,
            experimental_memory_operator::get_experimental_memory_operator_status,
            experimental_memory_operator::initialize_experimental_memory_operator,
            experimental_memory_operator::create_experimental_memory_reviewer_session,
            experimental_memory_operator::review_experimental_memory_proposal,
            experimental_memory_operator::issue_experimental_memory_execution_authorization,
            experimental_memory_operator::issue_experimental_memory_rehearsal_authorization,
            experimental_memory_operator::revoke_experimental_memory_execution_authorization,
            experimental_memory_operator::consume_experimental_memory_execution_authorization_no_effect,
            experimental_memory_operator::execute_experimental_memory_authority_rehearsal,
            experimental_memory_operator::inspect_experimental_memory_operator_journal,
            experimental_memory_operator::inspect_experimental_memory_rehearsal_authority,
            desktop_pet::get_desktop_pet_status,
            desktop_pet::set_desktop_pet_enabled,
            desktop_pet::set_desktop_pet_appearance,
            desktop_pet::focus_main_window,
            run_claude_command,
            check_claude_cli,
            get_cli_lifecycle,
            diagnose_cli,
            cleanup_old_cli,
            pin_cli,
            unpin_cli,
            get_pinned_cli,
            inject_cli_path,
            delete_cli,
            repair_cli,
            install_claude_cli,
            app_update::get_app_update_status,
            app_update::check_app_update,
            app_update::download_app_update,
            app_update::install_app_update,
            update_claude_cli,
            reinstall_claude_cli,
            check_cli_update,
            check_node_env,
            install_node_env,
            mcp_manager::list_mcp_servers,
            mcp_manager::save_mcp_server,
            mcp_manager::delete_mcp_server,
            mcp_manager::set_project_mcp_approval,
            mcp_manager::login_mcp_server,
            mcp_manager::logout_mcp_server,
            plugin_manager::list_plugins,
            plugin_manager::list_plugin_marketplaces,
            plugin_manager::diagnose_plugins,
            plugin_manager::plugin_details,
            plugin_manager::install_plugin,
            plugin_manager::set_plugin_enabled,
            plugin_manager::update_plugin,
            plugin_manager::uninstall_plugin,
            plugin_manager::add_plugin_marketplace,
            plugin_manager::update_plugin_marketplace,
            plugin_manager::remove_plugin_marketplace,
            plugin_manager::validate_plugin,
            workflow_manager::list_workflows,
            workflow_manager::read_workflow_source,
            workflow_manager::save_workflow,
            workflow_manager::load_workflow_runs,
            workflow_manager::save_workflow_runs,
            workflow_manager::inspect_workflow_runtime_progress,
            start_claude_login,
            check_claude_auth,
            get_claude_runtime_environment,
            set_claude_runtime_environment,
            open_terminal_login,
            load_custom_previews,
            save_custom_previews,
            load_conversation_runtime_preferences,
            save_conversation_runtime_preferences,
            load_pinned_sessions,
            save_pinned_sessions,
            load_archived_sessions,
            save_archived_sessions,
            load_session_groups,
            save_session_groups,
            export_session_organization,
            preview_session_organization_import,
            import_session_organization,
            load_plans,
            save_plans,
            generate_session_title,
            load_providers,
            save_providers,
            clear_provider_credential,
            delete_provider,
            test_provider_connection,
            respond_permission,
            send_control_request,
            commands::feedback::submit_feedback,
            commands::feedback::feedback_is_configured,
            automations::list_automations,
            automations::list_automation_activity_summaries,
            automations::list_active_automation_sessions,
            automations::get_automation_preferences,
            automations::set_automation_worktree_retention_limit,
            automations::get_automation,
            automations::upsert_automation,
            automations::delete_automation,
            automations::set_automation_status,
            automations::run_automation_now,
            automations::retry_automation_run,
            automations::recovery::list_automation_recovery_plans,
            automations::cancel_automation_run,
            automations::list_automation_runs,
            automations::get_automation_worktree_review,
            automations::get_automation_worktree_file_diff,
            automations::create_automation_worktree_branch,
            automations::mark_automation_run_read,
            automations::mark_all_automation_runs_read,
            automations::archive_automation_run,
            automations::cleanup_automation_worktree,
            automations::restore_automation_worktree,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| match event {
            #[cfg(target_os = "macos")]
            RunEvent::Reopen { .. } => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            RunEvent::ExitRequested { api, code, .. } => {
                // Cmd-Q / menu Quit does not necessarily emit a window close.
                // Explicit Quit is the only desktop path that settles live CLI
                // sessions and stops local scheduling. A second ExitRequested
                // caused by app.exit is allowed through while CLOSE_IN_PROGRESS=true.
                if CLOSE_IN_PROGRESS.swap(true, std::sync::atomic::Ordering::SeqCst) {
                    return;
                }
                api.prevent_exit();
                let app = app.clone();
                let process_manager = app.state::<ProcessManager>().inner().clone();
                let stdin_manager = app.state::<StdinManager>().inner().clone();
                let bypass_modes = app.state::<BypassModeMap>().inner().clone();
                let power_assertions =
                    PowerAssertionState::clone(app.state::<PowerAssertionState>().inner());
                tauri::async_runtime::spawn(async move {
                    // Keep ownership of an in-flight installer until its bounded
                    // update command reaches a terminal result. Exiting the Tokio
                    // runtime first can orphan `claude update`, leaving a download
                    // that the relaunched application cannot observe or cancel.
                    while cli_update_in_progress() {
                        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                    }
                    let failures = graceful_stop_all_sessions_inner(
                        &process_manager,
                        &stdin_manager,
                        &bypass_modes,
                    )
                    .await;
                    if !failures.is_empty() {
                        eprintln!(
                            "[BLACKBOX] quit kept application open because CLI exit was not confirmed: {:?}",
                            failures
                        );
                        CLOSE_IN_PROGRESS.store(false, std::sync::atomic::Ordering::SeqCst);
                        return;
                    }
                    if let Err(error) = power_assertions.release_all() {
                        eprintln!("[BLACKBOX] failed to release power assertions: {error}");
                    }
                    eprintln!("[BLACKBOX] quit settled CLI sessions; exiting application");
                    app.exit(code.unwrap_or(0));
                });
            }
            _ => {}
        });
}

pub fn run_automation_cli(arguments: &[String]) -> Result<String, String> {
    automations::run_cli(arguments)
}

#[cfg(test)]
mod auxiliary_model_tier_tests {
    use super::resolve_auxiliary_model_tier;

    #[test]
    fn explicit_native_tier_wins_over_provider_model_name() {
        assert_eq!(
            resolve_auxiliary_model_tier(Some("haiku"), "glm-4.7").unwrap(),
            "haiku"
        );
    }

    #[test]
    fn native_model_name_is_inferred_only_without_an_explicit_tier() {
        assert_eq!(
            resolve_auxiliary_model_tier(None, "claude-haiku-4-5-20251001").unwrap(),
            "haiku"
        );
        assert!(resolve_auxiliary_model_tier(None, "glm-4.7").is_err());
    }
}

#[cfg(test)]
mod hook_mutation_tests {
    use super::{
        hook_handler_fingerprint, hook_settings_snapshot, parse_editable_hook_id,
        patch_hook_handler, remove_hook_handler_from_document, verify_hook_source_unchanged,
        CreateHookRequest,
    };
    use serde_json::json;

    fn request(handler_type: &str, value: &str, timeout_seconds: Option<u64>) -> CreateHookRequest {
        CreateHookRequest {
            scope: "user".to_string(),
            event: "PreToolUse".to_string(),
            matcher: Some("Bash".to_string()),
            handler_type: handler_type.to_string(),
            value: value.to_string(),
            timeout_seconds,
        }
    }

    #[test]
    fn removing_one_handler_keeps_sibling_and_unrelated_document_fields() {
        let mut document = json!({
            "otherSetting": { "preserved": true },
            "hooks": {
                "PreToolUse": [{
                    "matcher": "Bash",
                    "hooks": [
                        { "type": "command", "command": "first" },
                        {
                            "type": "command",
                            "command": "second",
                            "async": true,
                            "statusMessage": "Still here"
                        }
                    ]
                }]
            }
        })
        .as_object()
        .expect("fixture must be an object")
        .clone();

        let removed = remove_hook_handler_from_document(&mut document, "PreToolUse", 0, 0)
            .expect("the selected handler should be removed");

        assert_eq!(removed["command"], "first");
        let siblings = document["hooks"]["PreToolUse"][0]["hooks"]
            .as_array()
            .expect("remaining handlers must be an array");
        assert_eq!(siblings.len(), 1);
        assert_eq!(siblings[0]["command"], "second");
        assert_eq!(siblings[0]["async"], true);
        assert_eq!(siblings[0]["statusMessage"], "Still here");
        assert_eq!(document["otherSetting"]["preserved"], true);
    }

    #[test]
    fn removing_last_handlers_cleans_empty_group_then_event() {
        let mut document = json!({
            "hooks": {
                "PreToolUse": [
                    {
                        "matcher": "Bash",
                        "hooks": [{ "type": "command", "command": "first" }]
                    },
                    {
                        "matcher": "Write",
                        "hooks": [{ "type": "command", "command": "second" }]
                    }
                ],
                "PostToolUse": [{
                    "matcher": "Bash",
                    "hooks": [{ "type": "command", "command": "unrelated" }]
                }]
            }
        })
        .as_object()
        .expect("fixture must be an object")
        .clone();

        remove_hook_handler_from_document(&mut document, "PreToolUse", 0, 0)
            .expect("the first group should be removed with its last handler");
        let remaining_groups = document["hooks"]["PreToolUse"]
            .as_array()
            .expect("the event should remain while another group exists");
        assert_eq!(remaining_groups.len(), 1);
        assert_eq!(remaining_groups[0]["matcher"], "Write");

        remove_hook_handler_from_document(&mut document, "PreToolUse", 0, 0)
            .expect("the event should be removed with its final group");
        let hooks = document["hooks"]
            .as_object()
            .expect("hooks must remain an object");
        assert!(!hooks.contains_key("PreToolUse"));
        assert!(hooks.contains_key("PostToolUse"));
    }

    #[test]
    fn same_type_patch_preserves_advanced_handler_fields() {
        let existing = json!({
            "type": "command",
            "command": "old command",
            "timeout": 120,
            "async": true,
            "statusMessage": "Working",
            "if": "Bash(git *)",
            "shell": "zsh",
            "futureField": { "nested": 1 }
        });

        let patched = patch_hook_handler(&existing, &request("command", "new command", Some(45)))
            .expect("same-type patch should succeed");

        assert_eq!(patched["type"], "command");
        assert_eq!(patched["command"], "new command");
        assert_eq!(patched["timeout"], 45);
        assert_eq!(patched["async"], true);
        assert_eq!(patched["statusMessage"], "Working");
        assert_eq!(patched["if"], "Bash(git *)");
        assert_eq!(patched["shell"], "zsh");
        assert_eq!(patched["futureField"], json!({ "nested": 1 }));
    }

    #[test]
    fn changing_handler_type_drops_fields_that_do_not_apply() {
        let existing = json!({
            "type": "http",
            "url": "https://old.example.test/hook",
            "timeout": 90,
            "headers": { "Authorization": "secret" },
            "allowedEnvVars": ["TOKEN"],
            "async": true
        });

        let patched = patch_hook_handler(
            &existing,
            &request("prompt", "Review the tool request", Some(120)),
        )
        .expect("type-changing patch should rebuild the handler");

        assert_eq!(
            patched,
            json!({ "type": "prompt", "prompt": "Review the tool request" })
        );
    }

    #[test]
    fn handler_fingerprint_changes_with_event_matcher_or_handler() {
        let handler = json!({
            "type": "command",
            "command": "echo one",
            "async": true
        });
        let baseline = hook_handler_fingerprint("PreToolUse", "Bash", &handler);

        assert_eq!(
            baseline,
            hook_handler_fingerprint("PreToolUse", "Bash", &handler)
        );
        assert_ne!(
            baseline,
            hook_handler_fingerprint("PostToolUse", "Bash", &handler)
        );
        assert_ne!(
            baseline,
            hook_handler_fingerprint("PreToolUse", "Write", &handler)
        );
        assert_ne!(
            baseline,
            hook_handler_fingerprint(
                "PreToolUse",
                "Bash",
                &json!({ "type": "command", "command": "echo two", "async": true })
            )
        );
    }

    #[test]
    fn editable_hook_id_rejects_non_owned_sources() {
        for id in [
            "built-in:UserPromptSubmit:0:0",
            "managed:PreToolUse:0:0",
            "plugin:PostToolUse:1:2",
        ] {
            assert!(
                parse_editable_hook_id(id).is_err(),
                "{id} must not be editable"
            );
        }

        assert_eq!(
            parse_editable_hook_id("user:PreToolUse:1:2"),
            Ok(("user", "PreToolUse", 1, 2))
        );
        assert_eq!(
            parse_editable_hook_id("project:PostToolUse:0:3"),
            Ok(("project", "PostToolUse", 0, 3))
        );
        assert_eq!(
            parse_editable_hook_id("local:Stop:4:5"),
            Ok(("local", "Stop", 4, 5))
        );
    }

    #[test]
    fn source_digest_mismatch_is_rejected_without_writing() {
        let temp = tempfile::TempDir::new().expect("temp directory should be created");
        let path = temp.path().join("settings.json");
        let original = br#"{"hooks":{"PreToolUse":[]}}"#;
        std::fs::write(&path, original).expect("fixture should be written");
        let (_, original_digest) =
            hook_settings_snapshot(&path).expect("the initial snapshot should succeed");

        let external_change = br#"{"hooks":{"PostToolUse":[]},"external":true}"#;
        std::fs::write(&path, external_change).expect("external change should be written");

        let error = verify_hook_source_unchanged(&path, &original_digest)
            .expect_err("stale source digest must be rejected");
        assert!(error.contains("changed outside Black Box"));
        assert_eq!(
            std::fs::read(&path).expect("fixture should remain readable"),
            external_change
        );
    }
}

#[cfg(test)]
mod power_assertion_tests {
    use super::normalize_power_request;

    #[test]
    fn display_wake_requires_system_wake() {
        assert_eq!(normalize_power_request(false, true), (false, false));
        assert_eq!(normalize_power_request(false, false), (false, false));
        assert_eq!(normalize_power_request(true, false), (true, false));
        assert_eq!(normalize_power_request(true, true), (true, true));
    }
}

#[cfg(test)]
mod cli_lifecycle_tests {
    use super::{
        classify_cli_install_method, cli_lifecycle_for, newest_healthy_cli_candidate,
        CliInstallMethod,
    };
    use crate::commands::cli_resolver::{CliCandidate, CliSource};

    #[test]
    fn classifies_owner_specific_cli_paths() {
        assert_eq!(
            classify_cli_install_method("/Users/test/.local/bin/claude"),
            CliInstallMethod::Native
        );
        assert_eq!(
            classify_cli_install_method("/Users/test/.claude/local/claude"),
            CliInstallMethod::Native
        );
        assert_eq!(
            classify_cli_install_method("/opt/homebrew/Caskroom/claude-code/2.1.0/claude"),
            CliInstallMethod::HomebrewStable
        );
        assert_eq!(
            classify_cli_install_method("/opt/homebrew/Caskroom/claude-code@latest/2.1.0/claude"),
            CliInstallMethod::HomebrewLatest
        );
        assert_eq!(
            classify_cli_install_method(
                "C:\\Users\\test\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Anthropic.ClaudeCode_x64\\claude.exe"
            ),
            CliInstallMethod::Winget
        );
        assert_eq!(
            classify_cli_install_method(
                "/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js"
            ),
            CliInstallMethod::Npm
        );
        assert_eq!(
            classify_cli_install_method("/Users/test/.nvm/versions/node/v22/bin/claude"),
            CliInstallMethod::VersionManager
        );
        assert_eq!(
            classify_cli_install_method(
                "/Users/test/Library/Application Support/Claude/claude-code/2.1.0/claude"
            ),
            CliInstallMethod::DesktopBundled
        );
    }

    #[test]
    fn external_owner_routes_do_not_fall_back_to_black_box_installers() {
        let brew = cli_lifecycle_for(
            Some("/opt/homebrew/Caskroom/claude-code/2.1.0/claude".to_string()),
            Some("2.1.0".to_string()),
        );
        assert!(brew.can_update_in_app);
        assert_eq!(
            brew.update_command.as_deref(),
            Some("brew upgrade --cask claude-code")
        );

        let version_manager = cli_lifecycle_for(
            Some("/Users/test/.volta/bin/claude".to_string()),
            Some("2.1.0".to_string()),
        );
        assert!(!version_manager.can_update_in_app);
        assert!(version_manager
            .update_command
            .as_deref()
            .unwrap()
            .starts_with("npm install -g"));
    }

    #[test]
    fn update_reconciliation_stays_with_the_installation_that_was_updated() {
        let candidate = |path: &str, version: Option<&str>, issues: Vec<String>| CliCandidate {
            path: path.to_string(),
            source: CliSource::Official,
            is_native: true,
            can_delete: true,
            version: version.map(str::to_string),
            issues,
        };
        let candidates = vec![
            candidate("/legacy/claude", Some("2.1.210"), vec![]),
            candidate("/current/claude", Some("2.1.211"), vec![]),
            candidate(
                "/broken/claude",
                Some("9.9.9"),
                vec!["failed to execute".to_string()],
            ),
        ];

        let selected = newest_healthy_cli_candidate(&candidates, "/legacy/claude").unwrap();
        assert_eq!(selected.path, "/legacy/claude");
        assert_eq!(selected.version.as_deref(), Some("2.1.210"));
    }
}

#[cfg(test)]
mod decode_tests {
    use super::decode_project_name;
    use tempfile::TempDir;

    /// Encode a Unix absolute path the way Claude CLI encodes project dirs:
    /// `/` → `-`, `.` before a path component → empty part (so `/.foo` → `--foo`).
    fn encode_path(path: &str) -> String {
        // Replace leading `/` with `-`, then all remaining `/` with `-`.
        // Dots at the start of a component become empty parts between dashes.
        let mut encoded = String::new();
        for ch in path.chars() {
            if ch == '/' {
                encoded.push('-');
            } else {
                encoded.push(ch);
            }
        }
        encoded
    }

    #[test]
    fn test_simple_no_ambiguity() {
        // When no filesystem probing is needed (all parts are unambiguous
        // single-segment names), the decoder just replaces `-` with `/`.
        // Use a path prefix that definitely does NOT exist so the decoder
        // falls back to segment-per-dash.
        let result = decode_project_name("-nonexistent9999-aaa-bbb-ccc");
        assert_eq!(result, "/nonexistent9999/aaa/bbb/ccc");
    }

    #[test]
    fn test_hyphenated_dir_with_tempdir() {
        // Create a real directory structure with a hyphenated leaf name so
        // the filesystem probe can disambiguate.
        let tmp = TempDir::new().unwrap();
        let base = tmp.path().join("sub");
        let hyphenated = base.join("ppt-maker");
        std::fs::create_dir_all(&hyphenated).unwrap();

        // Encode the path: e.g. /tmp/xxx/sub/ppt-maker
        let full_path = hyphenated.to_string_lossy().to_string();
        let encoded = encode_path(&full_path);

        let result = decode_project_name(&encoded);
        assert_eq!(
            result, full_path,
            "Decoder should find the hyphenated dir on disk and keep the hyphen"
        );
    }

    #[test]
    fn test_hidden_dir_double_dash_with_tempdir() {
        // Create .claude-worktrees/condescending-brown inside a temp dir
        let tmp = TempDir::new().unwrap();
        let hidden = tmp
            .path()
            .join(".claude-worktrees")
            .join("condescending-brown");
        std::fs::create_dir_all(&hidden).unwrap();

        let full_path = hidden.to_string_lossy().to_string();
        let encoded = encode_path(&full_path);
        // The `.` in `.claude-worktrees` encodes as an empty part → `--claude-worktrees`
        let encoded = encoded.replacen("-.", "--", 1);

        let result = decode_project_name(&encoded);
        println!("Encoded: {}", encoded);
        println!("Result:  {}", result);
        assert!(
            result.contains(".claude"),
            "Expected .claude in path, got: {}",
            result
        );
    }

    #[test]
    fn test_space_in_dir_name_with_tempdir() {
        // Create a dir with a space in its name
        let tmp = TempDir::new().unwrap();
        let spaced = tmp.path().join("jd 设计");
        std::fs::create_dir_all(&spaced).unwrap();

        let full_path = spaced.to_string_lossy().to_string();
        // Claude CLI encodes spaces as dashes too (same as `/`)
        let encoded = encode_path(&full_path).replace(' ', "-");

        let result = decode_project_name(&encoded);
        assert_eq!(
            result, full_path,
            "Decoder should find the space-containing dir on disk"
        );
    }

    #[test]
    fn test_no_false_positive_without_dir() {
        // When the hyphenated path does NOT exist on disk, the decoder
        // should fall back to treating each dash as a separator.
        let result = decode_project_name("-nonexistent9999-sub-ppt-maker");
        assert_eq!(result, "/nonexistent9999/sub/ppt/maker");
    }
}

#[cfg(test)]
mod conversation_rewind_tests {
    use super::*;
    use serde_json::json;

    fn line(value: Value) -> String {
        format!("{}\n", serde_json::to_string(&value).unwrap())
    }

    #[test]
    fn conversation_rewind_keeps_the_prefix_and_preserves_a_full_backup() {
        let temp = tempfile::tempdir().unwrap();
        let session_id = "550e8400-e29b-41d4-a716-446655440000";
        let first_user = "11111111-1111-4111-8111-111111111111";
        let first_assistant = "22222222-2222-4222-8222-222222222222";
        let second_user = "33333333-3333-4333-8333-333333333333";
        let second_assistant = "44444444-4444-4444-8444-444444444444";
        let path = temp.path().join(format!("{session_id}.jsonl"));
        let original = [
            line(json!({"type":"queue-operation","sessionId":session_id})),
            line(json!({"type":"user","uuid":first_user,"sessionId":session_id,"message":{"role":"user","content":"one"}})),
            line(json!({"type":"assistant","uuid":first_assistant,"parentUuid":first_user,"sessionId":session_id,"message":{"role":"assistant","content":[{"type":"text","text":"ack one"}]}})),
            line(json!({"type":"user","uuid":second_user,"parentUuid":first_assistant,"sessionId":session_id,"message":{"role":"user","content":"two"}})),
            line(json!({"type":"assistant","uuid":second_assistant,"parentUuid":second_user,"sessionId":session_id,"message":{"role":"assistant","content":[{"type":"text","text":"ack two"}]}})),
        ]
        .concat();
        std::fs::write(&path, &original).unwrap();

        let result = rewind_conversation_file_at(
            &path,
            session_id,
            second_user,
            &temp.path().join("backups"),
        )
        .unwrap();

        let rewound = std::fs::read_to_string(&path).unwrap();
        assert!(rewound.contains("ack one"));
        assert!(!rewound.contains("\"content\":\"two\""));
        assert!(!rewound.contains("ack two"));
        assert_eq!(result.retained_lines, 3);
        assert_eq!(result.removed_lines, 2);
        assert_eq!(
            std::fs::read_to_string(result.backup_path).unwrap(),
            original
        );
    }

    #[test]
    fn conversation_rewind_prepare_does_not_publish_until_atomic_commit() {
        let temp = tempfile::tempdir().unwrap();
        let session_id = "550e8400-e29b-41d4-a716-446655440000";
        let first_user = "11111111-1111-4111-8111-111111111111";
        let first_assistant = "22222222-2222-4222-8222-222222222222";
        let second_user = "33333333-3333-4333-8333-333333333333";
        let path = temp.path().join(format!("{session_id}.jsonl"));
        let original = [
            line(json!({"type":"user","uuid":first_user,"sessionId":session_id,"message":{"role":"user","content":"one"}})),
            line(json!({"type":"assistant","uuid":first_assistant,"parentUuid":first_user,"sessionId":session_id,"message":{"role":"assistant","content":[{"type":"text","text":"ack one"}]}})),
            line(json!({"type":"user","uuid":second_user,"parentUuid":first_assistant,"sessionId":session_id,"message":{"role":"user","content":"two"}})),
        ]
        .concat();
        std::fs::write(&path, &original).unwrap();
        let backup_root = temp.path().join("backups");
        let prepared =
            prepare_conversation_rewind_at(&path, session_id, second_user, &backup_root).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), original);
        assert_eq!(
            std::fs::read_to_string(&prepared.result.backup_path).unwrap(),
            original
        );

        publish_prepared_conversation_rewind(prepared, &path).unwrap();
        assert_ne!(std::fs::read_to_string(&path).unwrap(), original);
    }

    #[test]
    fn conversation_rewind_rejects_non_user_or_first_turn_checkpoints() {
        let temp = tempfile::tempdir().unwrap();
        let session_id = "550e8400-e29b-41d4-a716-446655440000";
        let first_user = "11111111-1111-4111-8111-111111111111";
        let assistant = "22222222-2222-4222-8222-222222222222";
        let path = temp.path().join(format!("{session_id}.jsonl"));
        std::fs::write(
            &path,
            [
                line(json!({"type":"user","uuid":first_user,"sessionId":session_id,"message":{"role":"user","content":"one"}})),
                line(json!({"type":"assistant","uuid":assistant,"parentUuid":first_user,"sessionId":session_id,"message":{"role":"assistant","content":[{"type":"text","text":"ack"}]}})),
            ]
            .concat(),
        )
        .unwrap();

        assert!(rewind_conversation_file_at(
            &path,
            session_id,
            assistant,
            &temp.path().join("backups"),
        )
        .is_err());
        assert!(rewind_conversation_file_at(
            &path,
            session_id,
            first_user,
            &temp.path().join("backups"),
        )
        .unwrap_err()
        .contains("first turn"));
    }
}

#[cfg(test)]
mod strip_thinking_tests {
    use super::strip_thinking_from_value;
    use serde_json::json;

    #[test]
    fn test_strip_thinking_removes_thinking_blocks() {
        let mut value = json!({
            "type": "assistant",
            "message": {
                "role": "assistant",
                "content": [
                    {"type": "thinking", "thinking": "private thoughts"},
                    {"type": "text", "text": "Hello!"},
                    {"type": "redacted_thinking", "data": "opaque"},
                ]
            }
        });
        let stripped = strip_thinking_from_value(&mut value);
        assert_eq!(stripped, Some(2));
        let content = value["message"]["content"].as_array().unwrap();
        assert_eq!(content.len(), 1);
        assert_eq!(content[0]["type"], "text");
    }

    #[test]
    fn test_strip_thinking_preserves_other_types() {
        let mut value = json!({
            "type": "assistant",
            "message": {
                "role": "assistant",
                "content": [
                    {"type": "text", "text": "Hello!"},
                    {"type": "tool_use", "id": "t1", "name": "bash"},
                    {"type": "tool_result", "tool_use_id": "t1", "content": "output"},
                ]
            }
        });
        let stripped = strip_thinking_from_value(&mut value);
        assert_eq!(stripped, None);
        assert_eq!(value["message"]["content"].as_array().unwrap().len(), 3);
    }

    #[test]
    fn test_strip_thinking_user_message_unchanged() {
        let mut value = json!({
            "type": "user",
            "message": {
                "role": "user",
                "content": "What is 2+2?"
            }
        });
        let stripped = strip_thinking_from_value(&mut value);
        assert_eq!(stripped, None);
    }

    #[test]
    fn test_strip_thinking_empty_content() {
        let mut value = json!({
            "type": "assistant",
            "message": {
                "role": "assistant",
                "content": []
            }
        });
        let stripped = strip_thinking_from_value(&mut value);
        assert_eq!(stripped, None);
    }

    #[test]
    fn test_strip_thinking_only_thinking_blocks() {
        // Edge case: all blocks are thinking — result is empty content array
        let mut value = json!({
            "type": "assistant",
            "message": {
                "role": "assistant",
                "content": [
                    {"type": "thinking", "thinking": "hmm"},
                    {"type": "redacted_thinking", "data": "abc"},
                ]
            }
        });
        let stripped = strip_thinking_from_value(&mut value);
        assert_eq!(stripped, Some(2));
        assert_eq!(value["message"]["content"].as_array().unwrap().len(), 0);
    }
}

#[cfg(test)]
mod process_stop_tests {
    use super::*;
    use std::time::Duration;
    use tokio::sync::{oneshot, watch};

    async fn install_managed_process(
        manager: &ProcessManager,
        stdin_id: &str,
        cli_session_id: &str,
    ) -> (String, oneshot::Receiver<()>) {
        let reservation = manager.reserve_session(stdin_id, cli_session_id).unwrap();
        let generation = reservation.generation().to_string();
        let (kill_tx, kill_rx) = oneshot::channel();
        let (exit_tx, _exit_rx) = watch::channel(false);
        reservation
            .commit(ManagedProcess {
                session_id: stdin_id.to_string(),
                cli_session_id: cli_session_id.to_string(),
                generation: generation.clone(),
                pid: 1,
                kill_tx: Some(kill_tx),
                exit_tx,
            })
            .await
            .unwrap();
        (generation, kill_rx)
    }

    #[tokio::test]
    async fn graceful_stop_timeout_returns_stable_error_and_retains_claim() {
        let manager = ProcessManager::new();
        let stdin = StdinManager::new();
        let bypass = BypassModeMap::new();
        let cli_session_id = "550e8400-e29b-41d4-a716-446655440010";
        let (generation, _kill_rx) =
            install_managed_process(&manager, "desk_stop_timeout", cli_session_id).await;

        let error = graceful_stop_session_inner_with_timeouts(
            &manager,
            &stdin,
            &bypass,
            "desk_stop_timeout",
            Duration::from_millis(1),
            Duration::from_millis(1),
        )
        .await
        .unwrap_err();

        assert!(error.starts_with("SESSION_STOP_TIMEOUT:"));
        assert!(manager.has_cli_session_id(cli_session_id).await);
        assert_eq!(
            manager.active_ids().await,
            vec!["desk_stop_timeout".to_string()]
        );
        assert!(
            manager
                .finish_if_current("desk_stop_timeout", &generation)
                .await
        );
    }

    #[tokio::test]
    async fn kill_timeout_returns_stable_error_and_retains_claim() {
        let manager = ProcessManager::new();
        let stdin = StdinManager::new();
        let bypass = BypassModeMap::new();
        let cli_session_id = "550e8400-e29b-41d4-a716-446655440011";
        let (generation, _kill_rx) =
            install_managed_process(&manager, "desk_kill_timeout", cli_session_id).await;

        let error = kill_session_inner(
            &manager,
            &stdin,
            &bypass,
            "desk_kill_timeout",
            Duration::from_millis(1),
        )
        .await
        .unwrap_err();

        assert!(error.starts_with("SESSION_STOP_TIMEOUT:"));
        assert!(manager.has_cli_session_id(cli_session_id).await);
        assert!(
            manager
                .finish_if_current("desk_kill_timeout", &generation)
                .await
        );
    }

    #[tokio::test]
    async fn graceful_stop_reports_killed_only_after_confirmed_exit() {
        let manager = ProcessManager::new();
        let stdin = StdinManager::new();
        let bypass = BypassModeMap::new();
        let (generation, kill_rx) = install_managed_process(
            &manager,
            "desk_kill_confirmed",
            "550e8400-e29b-41d4-a716-446655440012",
        )
        .await;
        let finisher = manager.clone();
        tokio::spawn(async move {
            let _ = kill_rx.await;
            finisher
                .finish_if_current("desk_kill_confirmed", &generation)
                .await;
        });

        let outcome = graceful_stop_session_inner_with_timeouts(
            &manager,
            &stdin,
            &bypass,
            "desk_kill_confirmed",
            Duration::from_millis(1),
            Duration::from_millis(100),
        )
        .await
        .unwrap();

        assert_eq!(outcome, "killed");
        assert!(
            !manager
                .has_cli_session_id("550e8400-e29b-41d4-a716-446655440012")
                .await
        );
    }

    #[tokio::test]
    async fn graceful_stop_all_settles_multiple_active_sessions() {
        let manager = ProcessManager::new();
        let stdin = StdinManager::new();
        let bypass = BypassModeMap::new();
        let (generation_a, kill_rx_a) = install_managed_process(
            &manager,
            "desk_multi_a",
            "550e8400-e29b-41d4-a716-446655440013",
        )
        .await;
        let (generation_b, kill_rx_b) = install_managed_process(
            &manager,
            "desk_multi_b",
            "550e8400-e29b-41d4-a716-446655440014",
        )
        .await;

        for (stdin_id, generation, kill_rx) in [
            ("desk_multi_a", generation_a, kill_rx_a),
            ("desk_multi_b", generation_b, kill_rx_b),
        ] {
            let finisher = manager.clone();
            tokio::spawn(async move {
                let _ = kill_rx.await;
                finisher.finish_if_current(stdin_id, &generation).await;
            });
        }

        let failures = graceful_stop_all_sessions_inner_with_timeouts(
            &manager,
            &stdin,
            &bypass,
            Duration::from_millis(1),
            Duration::from_millis(100),
        )
        .await;

        assert!(failures.is_empty());
        assert!(manager.active_ids().await.is_empty());
    }

    #[tokio::test]
    async fn graceful_stop_all_waits_for_pending_reservation_commit() {
        let manager = ProcessManager::new();
        let stdin = StdinManager::new();
        let bypass = BypassModeMap::new();
        let reservation = manager
            .reserve_session("desk_pending_close", "550e8400-e29b-41d4-a716-446655440015")
            .unwrap();
        let generation = reservation.generation().to_string();
        let committer_manager = manager.clone();

        let settle = graceful_stop_all_sessions_inner_with_timeouts(
            &manager,
            &stdin,
            &bypass,
            Duration::from_millis(20),
            Duration::from_millis(100),
        );
        let commit = async move {
            tokio::task::yield_now().await;
            let (kill_tx, kill_rx) = oneshot::channel();
            let (exit_tx, _exit_rx) = watch::channel(false);
            reservation
                .commit(ManagedProcess {
                    session_id: "desk_pending_close".to_string(),
                    cli_session_id: "550e8400-e29b-41d4-a716-446655440015".to_string(),
                    generation: generation.clone(),
                    pid: 1,
                    kill_tx: Some(kill_tx),
                    exit_tx,
                })
                .await
                .unwrap();
            tokio::spawn(async move {
                let _ = kill_rx.await;
                committer_manager
                    .finish_if_current("desk_pending_close", &generation)
                    .await;
            });
        };

        let (failures, ()) = tokio::join!(settle, commit);
        assert!(failures.is_empty());
        assert!(manager.active_ids().await.is_empty());
    }
}
