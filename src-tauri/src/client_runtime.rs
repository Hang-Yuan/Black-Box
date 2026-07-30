use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

const CONFIG_OVERRIDE_ENV: &str = "BLACKBOX_CLAUDE_CONFIG_DIR";
const ACTIVE_ENVIRONMENT_ENV: &str = "BLACKBOX_ACTIVE_CLAUDE_ENVIRONMENT";
const MIGRATION_RECEIPT: &str = "claude-isolation-v1.json";
const RUNTIME_ENVIRONMENT_FILE: &str = "claude-runtime-environment.json";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ClaudeRuntimeEnvironment {
    Isolated,
    System,
}

impl ClaudeRuntimeEnvironment {
    fn as_str(self) -> &'static str {
        match self {
            Self::Isolated => "isolated",
            Self::System => "system",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "isolated" => Some(Self::Isolated),
            "system" => Some(Self::System),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeEnvironmentPreference {
    version: u8,
    environment: ClaudeRuntimeEnvironment,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimeEnvironmentStatus {
    pub(crate) active: ClaudeRuntimeEnvironment,
    pub(crate) selected: ClaudeRuntimeEnvironment,
    pub(crate) active_config_dir: String,
    pub(crate) requires_restart: bool,
    pub(crate) overridden_for_development: bool,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct IsolationMigrationReceipt {
    version: u8,
    source: String,
    destination: String,
    tracked_sessions: usize,
    copied_transcripts: usize,
    copied_runtime_directories: usize,
    copied_names_file: bool,
}

fn home_dir() -> Result<PathBuf, String> {
    dirs::home_dir().ok_or_else(|| "Cannot find home directory".to_string())
}

pub(crate) fn blackbox_dir() -> Result<PathBuf, String> {
    Ok(home_dir()?.join(".blackbox"))
}

pub(crate) fn private_claude_config_dir() -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os(CONFIG_OVERRIDE_ENV).filter(|value| !value.is_empty()) {
        return Ok(PathBuf::from(path));
    }
    Ok(blackbox_dir()?.join("claude"))
}

fn system_claude_config_dir() -> Result<PathBuf, String> {
    Ok(home_dir()?.join(".claude"))
}

fn runtime_environment_path() -> Result<PathBuf, String> {
    Ok(blackbox_dir()?.join(RUNTIME_ENVIRONMENT_FILE))
}

fn read_selected_environment() -> Result<ClaudeRuntimeEnvironment, String> {
    if std::env::var_os(CONFIG_OVERRIDE_ENV).is_some() {
        return Ok(ClaudeRuntimeEnvironment::Isolated);
    }
    let path = runtime_environment_path()?;
    if !path.exists() {
        return Ok(ClaudeRuntimeEnvironment::Isolated);
    }
    let bytes = std::fs::read(&path)
        .map_err(|error| format!("Cannot read Claude runtime environment preference: {error}"))?;
    let preference: RuntimeEnvironmentPreference = serde_json::from_slice(&bytes)
        .map_err(|error| format!("Cannot parse Claude runtime environment preference: {error}"))?;
    if preference.version != 1 {
        return Err(format!(
            "Unsupported Claude runtime environment preference version {}",
            preference.version
        ));
    }
    Ok(preference.environment)
}

pub(crate) fn active_environment() -> Result<ClaudeRuntimeEnvironment, String> {
    if std::env::var_os(CONFIG_OVERRIDE_ENV).is_some() {
        return Ok(ClaudeRuntimeEnvironment::Isolated);
    }
    if let Some(value) = std::env::var_os(ACTIVE_ENVIRONMENT_ENV) {
        let value = value.to_string_lossy();
        return ClaudeRuntimeEnvironment::parse(&value)
            .ok_or_else(|| format!("Invalid active Claude runtime environment: {value}"));
    }
    read_selected_environment()
}

pub(crate) fn uses_system_environment() -> Result<bool, String> {
    Ok(active_environment()? == ClaudeRuntimeEnvironment::System)
}

/// Resolve the active Claude state root. Isolated mode keeps Black Box state
/// private; system mode intentionally uses the user's normal ~/.claude state.
pub(crate) fn claude_config_dir() -> Result<PathBuf, String> {
    match active_environment()? {
        ClaudeRuntimeEnvironment::Isolated => private_claude_config_dir(),
        ClaudeRuntimeEnvironment::System => system_claude_config_dir(),
    }
}

pub(crate) fn apply_to_tokio_command(command: &mut tokio::process::Command) -> Result<(), String> {
    match active_environment()? {
        ClaudeRuntimeEnvironment::Isolated => {
            command.env("CLAUDE_CONFIG_DIR", private_claude_config_dir()?);
        }
        ClaudeRuntimeEnvironment::System => {
            command.env_remove("CLAUDE_CONFIG_DIR");
        }
    }
    Ok(())
}

pub(crate) fn apply_to_std_command(command: &mut std::process::Command) -> Result<(), String> {
    match active_environment()? {
        ClaudeRuntimeEnvironment::Isolated => {
            command.env("CLAUDE_CONFIG_DIR", private_claude_config_dir()?);
        }
        ClaudeRuntimeEnvironment::System => {
            command.env_remove("CLAUDE_CONFIG_DIR");
        }
    }
    Ok(())
}

pub(crate) fn activate_selected_environment() -> Result<PathBuf, String> {
    let environment = read_selected_environment()?;
    // SAFETY: the caller invokes this before the Tauri runtime and worker
    // threads start. Child hooks inherit this immutable active-mode marker.
    unsafe {
        std::env::set_var(ACTIVE_ENVIRONMENT_ENV, environment.as_str());
        match environment {
            ClaudeRuntimeEnvironment::Isolated => {
                std::env::set_var("CLAUDE_CONFIG_DIR", private_claude_config_dir()?);
            }
            ClaudeRuntimeEnvironment::System => {
                std::env::remove_var("CLAUDE_CONFIG_DIR");
            }
        }
    }
    claude_config_dir()
}

pub(crate) fn runtime_environment_status() -> Result<RuntimeEnvironmentStatus, String> {
    let active = active_environment()?;
    let selected = read_selected_environment()?;
    Ok(RuntimeEnvironmentStatus {
        active,
        selected,
        active_config_dir: claude_config_dir()?.to_string_lossy().into_owned(),
        requires_restart: active != selected,
        overridden_for_development: std::env::var_os(CONFIG_OVERRIDE_ENV).is_some(),
    })
}

pub(crate) fn select_runtime_environment(
    environment: String,
) -> Result<RuntimeEnvironmentStatus, String> {
    if std::env::var_os(CONFIG_OVERRIDE_ENV).is_some() {
        return Err(
            "The Claude runtime environment is fixed by BLACKBOX_CLAUDE_CONFIG_DIR in this development instance"
                .to_string(),
        );
    }
    let environment = ClaudeRuntimeEnvironment::parse(&environment)
        .ok_or_else(|| "Claude runtime environment must be isolated or system".to_string())?;
    let path = runtime_environment_path()?;
    let parent = path
        .parent()
        .ok_or_else(|| "Claude runtime environment preference has no parent".to_string())?;
    protect_directory(parent)?;
    let payload = serde_json::to_vec_pretty(&RuntimeEnvironmentPreference {
        version: 1,
        environment,
    })
    .map_err(|error| format!("Cannot encode Claude runtime environment preference: {error}"))?;
    let temporary = path.with_extension(format!("tmp-{}", uuid::Uuid::new_v4().simple()));
    std::fs::write(&temporary, payload)
        .map_err(|error| format!("Cannot stage Claude runtime environment preference: {error}"))?;
    protect_file(&temporary)?;
    std::fs::rename(&temporary, &path)
        .map_err(|error| format!("Cannot commit Claude runtime environment preference: {error}"))?;
    runtime_environment_status()
}

fn protect_directory(path: &Path) -> Result<(), String> {
    std::fs::create_dir_all(path)
        .map_err(|error| format!("Cannot create Black Box Claude state directory: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("Cannot protect Black Box Claude state directory: {error}"))?;
    }
    Ok(())
}

fn protect_file(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .map_err(|error| format!("Cannot protect migrated Black Box state: {error}"))?;
    }
    Ok(())
}

fn tracked_session_ids(blackbox: &Path) -> Result<BTreeSet<String>, String> {
    let path = blackbox.join("tracked_sessions.txt");
    if !path.exists() {
        return Ok(BTreeSet::new());
    }
    let text = std::fs::read_to_string(&path)
        .map_err(|error| format!("Cannot read Black Box session ledger: {error}"))?;
    Ok(text
        .lines()
        .map(str::trim)
        .filter(|value| uuid::Uuid::parse_str(value).is_ok())
        .map(str::to_string)
        .collect())
}

fn copy_file_if_missing(source: &Path, destination: &Path) -> Result<bool, String> {
    if destination.exists() || !source.is_file() {
        return Ok(false);
    }
    let parent = destination
        .parent()
        .ok_or_else(|| format!("Migrated path has no parent: {}", destination.display()))?;
    protect_directory(parent)?;
    std::fs::copy(source, destination).map_err(|error| {
        format!(
            "Cannot copy Black Box state {} to {}: {error}",
            source.display(),
            destination.display()
        )
    })?;
    protect_file(destination)?;
    Ok(true)
}

fn copy_directory_if_missing(source: &Path, destination: &Path) -> Result<bool, String> {
    if !source.is_dir() {
        return Ok(false);
    }
    let created = !destination.exists();
    protect_directory(destination)?;
    for entry in std::fs::read_dir(source)
        .map_err(|error| format!("Cannot read migrated state directory: {error}"))?
    {
        let entry = entry.map_err(|error| format!("Cannot inspect migrated state: {error}"))?;
        let file_type = entry
            .file_type()
            .map_err(|error| format!("Cannot inspect migrated state type: {error}"))?;
        let target = destination.join(entry.file_name());
        if file_type.is_symlink() {
            return Err(format!(
                "Refusing to migrate symlinked Claude state: {}",
                entry.path().display()
            ));
        }
        if file_type.is_dir() {
            copy_directory_if_missing(&entry.path(), &target)?;
        } else if file_type.is_file() {
            copy_file_if_missing(&entry.path(), &target)?;
        }
    }
    // Return whether this invocation created the directory, while still
    // merging missing descendants into a partially-copied destination. This
    // makes a migration interrupted before the receipt commit safely retryable.
    Ok(created)
}

fn copy_tracked_transcripts(
    source: &Path,
    destination: &Path,
    tracked: &BTreeSet<String>,
) -> Result<usize, String> {
    let source_projects = source.join("projects");
    if !source_projects.is_dir() || tracked.is_empty() {
        return Ok(0);
    }
    let mut copied = 0;
    for project in std::fs::read_dir(&source_projects)
        .map_err(|error| format!("Cannot inspect legacy Claude projects: {error}"))?
    {
        let project =
            project.map_err(|error| format!("Cannot inspect legacy Claude project: {error}"))?;
        if !project
            .file_type()
            .map_err(|error| format!("Cannot inspect legacy project type: {error}"))?
            .is_dir()
        {
            continue;
        }
        let destination_project = destination.join("projects").join(project.file_name());
        for session_id in tracked {
            let source_jsonl = project.path().join(format!("{session_id}.jsonl"));
            let destination_jsonl = destination_project.join(format!("{session_id}.jsonl"));
            if copy_file_if_missing(&source_jsonl, &destination_jsonl)? {
                copied += 1;
            }
            let source_children = project.path().join(session_id);
            let destination_children = destination_project.join(session_id);
            let _ = copy_directory_if_missing(&source_children, &destination_children)?;
        }
    }
    Ok(copied)
}

fn copy_runtime_directories(
    source: &Path,
    destination: &Path,
    tracked: &BTreeSet<String>,
) -> Result<usize, String> {
    let mut copied = 0;
    for collection in ["session-env", "tasks", "file-history"] {
        for session_id in tracked {
            if copy_directory_if_missing(
                &source.join(collection).join(session_id),
                &destination.join(collection).join(session_id),
            )? {
                copied += 1;
            }
        }
    }
    Ok(copied)
}

fn synchronize_tracked_state(
    source: &Path,
    destination: &Path,
    tracked: &BTreeSet<String>,
) -> Result<(usize, usize, bool), String> {
    let copied_transcripts = copy_tracked_transcripts(source, destination, tracked)?;
    let copied_runtime_directories = copy_runtime_directories(source, destination, tracked)?;
    let copied_names_file = copy_file_if_missing(
        &source.join("blackbox_session_names.json"),
        &destination.join("blackbox_session_names.json"),
    )?;
    Ok((
        copied_transcripts,
        copied_runtime_directories,
        copied_names_file,
    ))
}

fn write_receipt(path: &Path, receipt: &IsolationMigrationReceipt) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(receipt)
        .map_err(|error| format!("Cannot encode Black Box isolation receipt: {error}"))?;
    let temporary = path.with_extension(format!("tmp-{}", uuid::Uuid::new_v4().simple()));
    std::fs::write(&temporary, bytes)
        .map_err(|error| format!("Cannot write Black Box isolation receipt: {error}"))?;
    protect_file(&temporary)?;
    std::fs::rename(&temporary, path)
        .map_err(|error| format!("Cannot commit Black Box isolation receipt: {error}"))
}

/// Initialize the selected Claude root and merge missing Black Box-owned
/// sessions from the other root. Switching environments must not make tracked
/// conversations disappear. The source is copied, never moved, deleted, or
/// allowed to overwrite an existing destination transcript.
pub(crate) fn initialize() -> Result<PathBuf, String> {
    let destination = claude_config_dir()?;
    let blackbox = blackbox_dir()?;
    protect_directory(&blackbox)?;
    let tracked = tracked_session_ids(&blackbox)?;

    if uses_system_environment()? {
        if !destination.is_dir() {
            return Err(format!(
                "System Claude environment does not exist: {}",
                destination.display()
            ));
        }
        let source = private_claude_config_dir()?;
        let _ = synchronize_tracked_state(&source, &destination, &tracked)?;
        return Ok(destination);
    }
    protect_directory(&destination)?;

    // Explicit test/dev roots are already isolated and must never import host state.
    if std::env::var_os(CONFIG_OVERRIDE_ENV).is_some() {
        return Ok(destination);
    }

    let receipt_path = blackbox.join(MIGRATION_RECEIPT);
    let source = home_dir()?.join(".claude");
    let (copied_transcripts, copied_runtime_directories, copied_names_file) =
        synchronize_tracked_state(&source, &destination, &tracked)?;
    if !receipt_path.exists() {
        write_receipt(
            &receipt_path,
            &IsolationMigrationReceipt {
                version: 1,
                source: source.to_string_lossy().into_owned(),
                destination: destination.to_string_lossy().into_owned(),
                tracked_sessions: tracked.len(),
                copied_transcripts,
                copied_runtime_directories,
                copied_names_file,
            },
        )?;
    }
    Ok(destination)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transcript_migration_copies_only_tracked_sessions() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        let destination = temp.path().join("destination");
        let project = source.join("projects").join("-tmp-workspace");
        std::fs::create_dir_all(&project).unwrap();
        let owned = uuid::Uuid::new_v4().to_string();
        let foreign = uuid::Uuid::new_v4().to_string();
        std::fs::write(project.join(format!("{owned}.jsonl")), "owned").unwrap();
        std::fs::write(project.join(format!("{foreign}.jsonl")), "foreign").unwrap();

        let copied =
            copy_tracked_transcripts(&source, &destination, &BTreeSet::from([owned.clone()]))
                .unwrap();

        assert_eq!(copied, 1);
        assert!(destination
            .join("projects/-tmp-workspace")
            .join(format!("{owned}.jsonl"))
            .exists());
        assert!(!destination
            .join("projects/-tmp-workspace")
            .join(format!("{foreign}.jsonl"))
            .exists());
    }

    #[test]
    fn tracked_state_can_follow_the_selected_environment_without_overwriting() {
        let temp = tempfile::tempdir().unwrap();
        let system = temp.path().join("system");
        let isolated = temp.path().join("isolated");
        let project = "-tmp-workspace";
        let system_only = uuid::Uuid::new_v4().to_string();
        let isolated_only = uuid::Uuid::new_v4().to_string();
        let shared = uuid::Uuid::new_v4().to_string();
        let tracked = BTreeSet::from([system_only.clone(), isolated_only.clone(), shared.clone()]);

        std::fs::create_dir_all(system.join("projects").join(project)).unwrap();
        std::fs::create_dir_all(isolated.join("projects").join(project)).unwrap();
        std::fs::write(
            system
                .join("projects")
                .join(project)
                .join(format!("{system_only}.jsonl")),
            "system-only",
        )
        .unwrap();
        std::fs::write(
            isolated
                .join("projects")
                .join(project)
                .join(format!("{isolated_only}.jsonl")),
            "isolated-only",
        )
        .unwrap();
        std::fs::write(
            system
                .join("projects")
                .join(project)
                .join(format!("{shared}.jsonl")),
            "system-authority",
        )
        .unwrap();
        std::fs::write(
            isolated
                .join("projects")
                .join(project)
                .join(format!("{shared}.jsonl")),
            "isolated-authority",
        )
        .unwrap();

        synchronize_tracked_state(&isolated, &system, &tracked).unwrap();
        assert_eq!(
            std::fs::read_to_string(
                system
                    .join("projects")
                    .join(project)
                    .join(format!("{isolated_only}.jsonl"))
            )
            .unwrap(),
            "isolated-only"
        );
        assert_eq!(
            std::fs::read_to_string(
                system
                    .join("projects")
                    .join(project)
                    .join(format!("{shared}.jsonl"))
            )
            .unwrap(),
            "system-authority"
        );

        synchronize_tracked_state(&system, &isolated, &tracked).unwrap();
        assert_eq!(
            std::fs::read_to_string(
                isolated
                    .join("projects")
                    .join(project)
                    .join(format!("{system_only}.jsonl"))
            )
            .unwrap(),
            "system-only"
        );
        assert_eq!(
            std::fs::read_to_string(
                isolated
                    .join("projects")
                    .join(project)
                    .join(format!("{shared}.jsonl"))
            )
            .unwrap(),
            "isolated-authority"
        );
    }

    #[cfg(unix)]
    #[test]
    fn migrated_files_are_owner_only() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source.json");
        let destination = temp.path().join("private/destination.json");
        std::fs::write(&source, "{}").unwrap();
        assert!(copy_file_if_missing(&source, &destination).unwrap());
        assert_eq!(
            std::fs::metadata(destination).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}
