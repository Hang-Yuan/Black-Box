//! Signed application updates. Downloading is independent of installation;
//! installation shares the native maintenance exclusion with all CLI launches.
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, State, WebviewWindow};

fn require_main(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err("App updates require the main window".into())
    }
}
use tauri_plugin_updater::{Update, UpdaterExt};

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub phase: String,
    pub version: Option<String>,
    pub notes: Option<String>,
    pub downloaded: u64,
    pub total: Option<u64>,
    pub error: Option<String>,
    pub previous_version: Option<String>,
}

#[derive(Default)]
pub struct AppUpdateState {
    operation: tokio::sync::Mutex<()>,
    status: Arc<Mutex<UpdateStatus>>,
    candidate: tokio::sync::Mutex<Option<(Update, Vec<u8>)>>,
}

fn journal_path() -> Result<std::path::PathBuf, String> {
    Ok(crate::client_runtime::blackbox_dir()?.join("app-update.json"))
}

fn persist(status: &UpdateStatus) -> Result<(), String> {
    let path = journal_path()?;
    std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    let mut staging =
        tempfile::NamedTempFile::new_in(path.parent().unwrap()).map_err(|e| e.to_string())?;
    staging
        .write_all(&serde_json::to_vec(status).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    staging.as_file().sync_all().map_err(|e| e.to_string())?;
    staging.persist(&path).map_err(|e| e.to_string())?;
    Ok(())
}

fn read_journal() -> Option<UpdateStatus> {
    std::fs::read(journal_path().ok()?)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
}

fn snapshot(state: &AppUpdateState) -> UpdateStatus {
    state
        .status
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone()
}

fn publish(app: &AppHandle, state: &AppUpdateState, status: UpdateStatus) {
    *state
        .status
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = status.clone();
    let _ = crate::events::emit_to_frontend(app, "app:update", status);
}

#[tauri::command]
pub fn get_app_update_status(app: AppHandle, state: State<'_, AppUpdateState>) -> UpdateStatus {
    let mut status = snapshot(&state);
    if status.phase.is_empty() {
        status = read_journal().unwrap_or_default();
        if status.phase == "installing" {
            status.phase = if status.version.as_deref()
                == Some(app.package_info().version.to_string().as_str())
            {
                "installed"
            } else {
                "interrupted"
            }
            .into();
        } else if matches!(status.phase.as_str(), "downloaded" | "downloading") {
            status.phase = "interrupted".into();
        }
        publish(&app, &state, status.clone());
    }
    status
}

#[tauri::command]
pub async fn check_app_update(
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, AppUpdateState>,
    rollback: Option<bool>,
) -> Result<UpdateStatus, String> {
    require_main(&window)?;
    let _operation = state
        .operation
        .try_lock()
        .map_err(|_| "UPDATE_BUSY".to_string())?;
    let result: Result<UpdateStatus, String> = async {
        let previous = read_journal().and_then(|status| status.previous_version);
        let mut builder = app
            .updater_builder()
            .timeout(std::time::Duration::from_secs(30));
        if rollback.unwrap_or(false) {
            let version = previous
                .as_ref()
                .ok_or("No previous signed version is recorded")?;
            if !version.chars().all(|c| c.is_ascii_digit() || c == '.') {
                return Err("Invalid rollback version".into());
            }
            let endpoint = format!(
                "https://github.com/Hang-Yuan/Black-Box/releases/download/v{version}/latest.json"
            );
            builder = builder
                .endpoints(vec![endpoint
                    .parse::<reqwest::Url>()
                    .map_err(|e| e.to_string())?])
                .map_err(|e| e.to_string())?
                .version_comparator(|_, _| true);
        }
        let update = builder
            .build()
            .map_err(|e| e.to_string())?
            .check()
            .await
            .map_err(|e| e.to_string())?;
        if rollback.unwrap_or(false)
            && update.as_ref().map(|item| &item.version) != previous.as_ref()
        {
            return Err("Rollback manifest does not match the recorded previous version".into());
        }
        let status = UpdateStatus {
            phase: if update.is_some() {
                "available"
            } else {
                "current"
            }
            .into(),
            version: update.as_ref().map(|item| item.version.clone()),
            notes: update.as_ref().and_then(|item| item.body.clone()),
            previous_version: previous,
            ..Default::default()
        };
        *state.candidate.lock().await = update.map(|item| (item, vec![]));
        publish(&app, &state, status.clone());
        Ok(status)
    }
    .await;
    if let Err(error) = &result {
        let mut status = snapshot(&state);
        status.phase = "error".into();
        status.error = Some(error.clone());
        publish(&app, &state, status);
    }
    result
}

#[tauri::command]
pub async fn download_app_update(
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, AppUpdateState>,
) -> Result<UpdateStatus, String> {
    require_main(&window)?;
    let _operation = state
        .operation
        .try_lock()
        .map_err(|_| "UPDATE_BUSY".to_string())?;
    let mut candidate = state.candidate.lock().await;
    let (update, bytes) = candidate.as_mut().ok_or("Check for an update first")?;
    let mut status = snapshot(&state);
    status.phase = "downloading".into();
    status.downloaded = 0;
    status.error = None;
    publish(&app, &state, status.clone());
    let result = update
        .download(
            |chunk, total| {
                status.downloaded += chunk as u64;
                status.total = total;
                publish(&app, &state, status.clone());
            },
            || {},
        )
        .await;
    match result {
        Ok(downloaded) => {
            *bytes = downloaded;
            status.phase = "downloaded".into();
        }
        Err(error) => {
            status.phase = "error".into();
            status.error = Some(error.to_string());
            publish(&app, &state, status);
            return Err(error.to_string());
        }
    }
    persist(&status)?;
    publish(&app, &state, status.clone());
    Ok(status)
}

#[tauri::command]
pub async fn install_app_update(
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, AppUpdateState>,
    processes: State<'_, crate::ProcessManager>,
    maintenance: State<'_, crate::CliMaintenanceState>,
) -> Result<(), String> {
    require_main(&window)?;
    let _operation = state
        .operation
        .try_lock()
        .map_err(|_| "UPDATE_BUSY".to_string())?;
    let gate = maintenance
        .gate
        .try_write()
        .map_err(|_| "CLI_MAINTENANCE_BUSY".to_string())?;
    crate::CLI_UPDATE_IN_PROGRESS.store(true, std::sync::atomic::Ordering::SeqCst);
    let _lease = crate::CliUpdateLease {
        _gate: gate,
        _flag: crate::CliUpdateFlag,
    };
    let blockers = crate::cli_update_blockers_inner(processes.inner()).await?;
    if blockers.running_automation || !blockers.active_session_ids.is_empty() {
        return Err("UPDATE_WAITING_FOR_IDLE".into());
    }
    let candidate = state.candidate.lock().await;
    let (update, bytes) = candidate
        .as_ref()
        .filter(|(_, bytes)| !bytes.is_empty())
        .ok_or("Download and verify the update first")?;
    let mut status = snapshot(&state);
    status.previous_version = Some(app.package_info().version.to_string());
    status.phase = "installing".into();
    persist(&status)?;
    publish(&app, &state, status.clone());
    if let Err(error) = update.install(bytes) {
        status.phase = "error".into();
        status.error = Some(error.to_string());
        persist(&status)?;
        publish(&app, &state, status);
        return Err(error.to_string());
    }
    // Session IDs, drafts and panel positions are retained by the frontend
    // before this call; no foreground execution is interrupted.
    app.restart();
}
