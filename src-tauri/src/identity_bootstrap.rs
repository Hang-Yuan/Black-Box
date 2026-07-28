use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Component, Path, PathBuf};

const MANIFEST_VERSION: u8 = 1;
const MAX_FILES: usize = 8;
const MAX_FILE_BYTES: u64 = 1024 * 1024;
const MAX_TOTAL_BYTES: u64 = 2 * 1024 * 1024;
const MAX_HOOK_INPUT_BYTES: u64 = 256 * 1024;
const MARKER: &str = "BLACKBOX_IDENTITY_BOOTSTRAP_V1";
const MANAGED_BEGIN: &str = "<!-- BLACKBOX-IDENTITY-BOOTSTRAP:BEGIN -->";
const MANAGED_END: &str = "<!-- BLACKBOX-IDENTITY-BOOTSTRAP:END -->";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IdentityFile {
    label: String,
    relative_path: String,
    sha256: String,
    bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IdentityBootstrapManifest {
    version: u8,
    enabled: bool,
    files: Vec<IdentityFile>,
    startup_skill: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IdentityBootstrapStatus {
    configured: bool,
    enabled: bool,
    files: Vec<String>,
    startup_skill: Option<String>,
    startup_skill_installed: bool,
    marker: String,
}

fn profile_root() -> Result<PathBuf, String> {
    Ok(crate::client_runtime::private_claude_config_dir()?.join("identity-bootstrap"))
}

fn manifest_path() -> Result<PathBuf, String> {
    Ok(profile_root()?.join("manifest.json"))
}

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn protect_directory(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path)
        .map_err(|error| format!("Cannot create identity bootstrap directory: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("Cannot protect identity bootstrap directory: {error}"))?;
    }
    Ok(())
}

fn protect_file(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
            .map_err(|error| format!("Cannot protect identity bootstrap file: {error}"))?;
    }
    Ok(())
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("Identity bootstrap path has no parent: {}", path.display()))?;
    protect_directory(parent)?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)
        .map_err(|error| format!("Cannot create identity bootstrap staging file: {error}"))?;
    temporary
        .write_all(bytes)
        .and_then(|_| temporary.as_file().sync_all())
        .map_err(|error| format!("Cannot stage identity bootstrap file: {error}"))?;
    protect_file(temporary.path())?;
    temporary
        .persist(path)
        .map_err(|error| format!("Cannot commit identity bootstrap file: {}", error.error))?;
    if let Ok(directory) = fs::File::open(parent) {
        let _ = directory.sync_all();
    }
    Ok(())
}

fn clean_label(path: &Path, index: usize) -> String {
    let fallback = format!("identity-{}", index + 1);
    let raw = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(&fallback);
    let cleaned: String = raw
        .chars()
        .map(|character| {
            if character.is_alphanumeric() || matches!(character, '.' | '-' | '_' | ' ') {
                character
            } else {
                '_'
            }
        })
        .take(96)
        .collect();
    let cleaned = cleaned.trim().trim_matches('.').trim();
    if cleaned.is_empty() {
        fallback
    } else {
        cleaned.to_string()
    }
}

fn validate_source(path: &Path) -> Result<Vec<u8>, String> {
    if !path.is_absolute() {
        return Err("Identity bootstrap sources must be absolute paths".to_string());
    }
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("Cannot inspect identity source {}: {error}", path.display()))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(format!(
            "Identity source must be a regular non-symlink file: {}",
            path.display()
        ));
    }
    if metadata.len() > MAX_FILE_BYTES {
        return Err(format!(
            "Identity source exceeds the 1 MiB limit: {}",
            path.display()
        ));
    }
    let bytes = fs::read(path)
        .map_err(|error| format!("Cannot read identity source {}: {error}", path.display()))?;
    std::str::from_utf8(&bytes)
        .map_err(|_| format!("Identity source must be UTF-8 text: {}", path.display()))?;
    Ok(bytes)
}

fn validate_skill_name(value: Option<String>) -> Result<Option<String>, String> {
    let Some(value) = value.map(|item| item.trim().to_string()) else {
        return Ok(None);
    };
    if value.is_empty() {
        return Ok(None);
    }
    let path = Path::new(&value);
    if path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
        || value.chars().any(char::is_control)
        || value.len() > 96
    {
        return Err("Startup skill must be one private skill name".to_string());
    }
    Ok(Some(value))
}

fn load_manifest() -> Result<Option<IdentityBootstrapManifest>, String> {
    let path = manifest_path()?;
    if !path.exists() {
        return Ok(None);
    }
    let metadata = fs::symlink_metadata(&path)
        .map_err(|error| format!("Cannot inspect identity bootstrap manifest: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() > MAX_FILE_BYTES {
        return Err("Identity bootstrap manifest failed its safety checks".to_string());
    }
    let manifest: IdentityBootstrapManifest = serde_json::from_slice(
        &fs::read(&path)
            .map_err(|error| format!("Cannot read identity bootstrap manifest: {error}"))?,
    )
    .map_err(|error| format!("Cannot parse identity bootstrap manifest: {error}"))?;
    if manifest.version != MANIFEST_VERSION {
        return Err(format!(
            "Unsupported identity bootstrap manifest version {}",
            manifest.version
        ));
    }
    Ok(Some(manifest))
}

fn snapshot_path(root: &Path, file: &IdentityFile) -> Result<PathBuf, String> {
    let relative = Path::new(&file.relative_path);
    if relative.is_absolute()
        || relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err("Identity bootstrap manifest contains an unsafe snapshot path".to_string());
    }
    Ok(root.join(relative))
}

fn fallback_block(manifest: &IdentityBootstrapManifest) -> Result<String, String> {
    let root = profile_root()?;
    let mut lines = vec![
        MANAGED_BEGIN.to_string(),
        "# Black Box identity bootstrap fallback".to_string(),
        String::new(),
    ];
    if !manifest.enabled {
        lines.push(
            "Identity bootstrap is disabled. Do not load the private snapshots listed below."
                .to_string(),
        );
        lines.push(MANAGED_END.to_string());
        return Ok(lines.join("\n"));
    }
    lines.extend([
        format!(
            "At every session start, require the `{MARKER}` marker from the Black Box SessionStart hook before responding."
        ),
        "If the marker is missing, read these private Black Box snapshots explicitly in order:"
            .to_string(),
    ]);
    for file in &manifest.files {
        lines.push(format!("- `{}`", snapshot_path(&root, file)?.display()));
    }
    if let Some(skill) = &manifest.startup_skill {
        lines.push(format!(
            "After the identity files are present, invoke the private `{skill}` skill before responding. If it is unavailable, say so explicitly and continue with the loaded identity."
        ));
    }
    lines.push(MANAGED_END.to_string());
    Ok(lines.join("\n"))
}

fn update_private_claude_fallback(manifest: &IdentityBootstrapManifest) -> Result<(), String> {
    let path = crate::client_runtime::private_claude_config_dir()?.join("CLAUDE.md");
    let existing = if path.exists() {
        fs::read_to_string(&path)
            .map_err(|error| format!("Cannot read private Black Box CLAUDE.md: {error}"))?
    } else {
        String::new()
    };
    let block = fallback_block(manifest)?;
    let updated = if let (Some(begin), Some(end)) =
        (existing.find(MANAGED_BEGIN), existing.find(MANAGED_END))
    {
        if end < begin {
            return Err("Private Black Box CLAUDE.md has a malformed managed block".to_string());
        }
        let suffix = end + MANAGED_END.len();
        format!("{}{}{}", &existing[..begin], block, &existing[suffix..])
    } else if existing.trim().is_empty() {
        format!("{block}\n")
    } else {
        format!("{}\n\n{block}\n", existing.trim_end())
    };
    atomic_write(&path, updated.as_bytes())
}

pub(crate) fn configure(
    source_files: Vec<String>,
    startup_skill: Option<String>,
    startup_skill_source: Option<String>,
) -> Result<IdentityBootstrapStatus, String> {
    if crate::client_runtime::uses_system_environment()? {
        return Err(
            "Identity bootstrap is managed by the selected system Claude environment".to_string(),
        );
    }
    if source_files.is_empty() || source_files.len() > MAX_FILES {
        return Err(format!("Select between 1 and {MAX_FILES} identity files"));
    }
    let root = profile_root()?;
    let files_root = root.join("files");
    protect_directory(&files_root)?;
    let mut files = Vec::with_capacity(source_files.len());
    let mut total_bytes = 0u64;
    for (index, source) in source_files.iter().enumerate() {
        let source = Path::new(source);
        let bytes = validate_source(source)?;
        total_bytes = total_bytes
            .checked_add(bytes.len() as u64)
            .ok_or_else(|| "Identity bootstrap size overflow".to_string())?;
        if total_bytes > MAX_TOTAL_BYTES {
            return Err("Identity bootstrap sources exceed the 2 MiB combined limit".to_string());
        }
        let digest = sha256(&bytes);
        let label = clean_label(source, index);
        let filename = format!("{:02}-{}-{}", index + 1, &digest[..12], label);
        let destination = files_root.join(&filename);
        if !destination.exists() {
            atomic_write(&destination, &bytes)?;
        }
        files.push(IdentityFile {
            label,
            relative_path: format!("files/{filename}"),
            sha256: digest,
            bytes: bytes.len() as u64,
        });
    }
    let startup_skill = validate_skill_name(startup_skill)?;
    if let Some(source) = startup_skill_source {
        let skill = startup_skill
            .as_ref()
            .ok_or_else(|| "Enter a startup skill name before importing SKILL.md".to_string())?;
        let source = Path::new(&source);
        if source.file_name().and_then(|value| value.to_str()) != Some("SKILL.md") {
            return Err("Startup skill source must be a SKILL.md file".to_string());
        }
        let bytes = validate_source(source)?;
        let destination = crate::client_runtime::private_claude_config_dir()?
            .join("skills")
            .join(skill)
            .join("SKILL.md");
        atomic_write(&destination, &bytes)?;
    }
    let manifest = IdentityBootstrapManifest {
        version: MANIFEST_VERSION,
        enabled: true,
        files,
        startup_skill,
    };
    let encoded = serde_json::to_vec_pretty(&manifest)
        .map_err(|error| format!("Cannot encode identity bootstrap manifest: {error}"))?;
    atomic_write(&manifest_path()?, &encoded)?;
    update_private_claude_fallback(&manifest)?;
    status()
}

pub(crate) fn set_enabled(enabled: bool) -> Result<IdentityBootstrapStatus, String> {
    if crate::client_runtime::uses_system_environment()? {
        return Err(
            "Identity bootstrap is managed by the selected system Claude environment".to_string(),
        );
    }
    let mut manifest =
        load_manifest()?.ok_or_else(|| "Identity bootstrap has not been configured".to_string())?;
    manifest.enabled = enabled;
    let encoded = serde_json::to_vec_pretty(&manifest)
        .map_err(|error| format!("Cannot encode identity bootstrap manifest: {error}"))?;
    atomic_write(&manifest_path()?, &encoded)?;
    update_private_claude_fallback(&manifest)?;
    status()
}

pub(crate) fn status() -> Result<IdentityBootstrapStatus, String> {
    let Some(manifest) = load_manifest()? else {
        return Ok(IdentityBootstrapStatus {
            configured: false,
            enabled: false,
            files: vec![],
            startup_skill: None,
            startup_skill_installed: false,
            marker: MARKER.to_string(),
        });
    };
    let installed = manifest.startup_skill.as_ref().is_some_and(|skill| {
        crate::client_runtime::private_claude_config_dir()
            .map(|root| root.join("skills").join(skill).join("SKILL.md").is_file())
            .unwrap_or(false)
    });
    Ok(IdentityBootstrapStatus {
        configured: true,
        enabled: manifest.enabled,
        files: manifest
            .files
            .iter()
            .map(|file| file.label.clone())
            .collect(),
        startup_skill: manifest.startup_skill,
        startup_skill_installed: installed,
        marker: MARKER.to_string(),
    })
}

fn build_output(payload: &Value) -> Result<Value, String> {
    if crate::client_runtime::uses_system_environment()? {
        return Ok(json!({"continue": true, "suppressOutput": true}));
    }
    if let Some(event) = payload.get("hook_event_name").and_then(Value::as_str) {
        if event != "SessionStart" {
            return Err("Identity bootstrap hook only accepts SessionStart events".to_string());
        }
    }
    let source = payload
        .get("source")
        .and_then(Value::as_str)
        .unwrap_or("startup");
    if !matches!(source, "startup" | "resume" | "clear" | "compact" | "fork") {
        return Err(format!("Unsupported SessionStart source: {source}"));
    }
    let Some(manifest) = load_manifest()? else {
        return Ok(json!({"continue": true, "suppressOutput": true}));
    };
    if !manifest.enabled {
        return Ok(json!({"continue": true, "suppressOutput": true}));
    }
    let root = profile_root()?;
    let mut context = format!("{MARKER} source={source}\n");
    for file in &manifest.files {
        let path = snapshot_path(&root, file)?;
        let metadata = fs::symlink_metadata(&path).map_err(|error| {
            format!(
                "Cannot inspect identity snapshot {}: {error}",
                path.display()
            )
        })?;
        if metadata.file_type().is_symlink()
            || !metadata.is_file()
            || metadata.len() != file.bytes
            || metadata.len() > MAX_FILE_BYTES
        {
            return Err(format!(
                "Identity snapshot failed its safety checks: {}",
                file.label
            ));
        }
        let bytes = fs::read(&path)
            .map_err(|error| format!("Cannot read identity snapshot {}: {error}", file.label))?;
        if sha256(&bytes) != file.sha256 {
            return Err(format!("Identity snapshot changed: {}", file.label));
        }
        let text = std::str::from_utf8(&bytes)
            .map_err(|_| format!("Identity snapshot is not UTF-8: {}", file.label))?;
        context.push_str(&format!(
            "\n--- BEGIN PRIVATE IDENTITY: {} ---\n{}\n--- END PRIVATE IDENTITY: {} ---\n",
            file.label,
            text.trim_end(),
            file.label
        ));
    }
    if let Some(skill) = &manifest.startup_skill {
        let installed = crate::client_runtime::private_claude_config_dir()?
            .join("skills")
            .join(skill)
            .join("SKILL.md")
            .is_file();
        if installed {
            context.push_str(&format!(
                "\nBefore responding, invoke the private `{skill}` startup synchronization skill.\n"
            ));
        } else {
            context.push_str(&format!(
                "\nThe configured private startup skill `{skill}` is missing. Report this once, then continue with the injected identity.\n"
            ));
        }
    }
    Ok(json!({
        "continue": true,
        "suppressOutput": true,
        "hookSpecificOutput": {
            "hookEventName": "SessionStart",
            "additionalContext": context
        }
    }))
}

pub fn run() -> Result<(), String> {
    let mut input = String::new();
    io::stdin()
        .take(MAX_HOOK_INPUT_BYTES)
        .read_to_string(&mut input)
        .map_err(|error| format!("Cannot read identity bootstrap hook input: {error}"))?;
    let payload: Value = serde_json::from_str(&input)
        .map_err(|error| format!("Invalid identity bootstrap hook JSON: {error}"))?;
    let output = build_output(&payload)?;
    println!(
        "{}",
        serde_json::to_string(&output)
            .map_err(|error| format!("Cannot encode identity bootstrap hook output: {error}"))?
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Mutex, OnceLock};

    fn env_lock() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(())).lock().unwrap()
    }

    fn with_private_root<T>(run: impl FnOnce(&Path) -> T) -> T {
        let _guard = env_lock();
        let temp = tempfile::tempdir().unwrap();
        std::env::set_var("BLACKBOX_CLAUDE_CONFIG_DIR", temp.path());
        let result = run(temp.path());
        std::env::remove_var("BLACKBOX_CLAUDE_CONFIG_DIR");
        result
    }

    #[test]
    fn all_supported_session_start_sources_receive_the_marker() {
        with_private_root(|root| {
            let soul = root.join("source-soul.md");
            let user = root.join("source-user.md");
            fs::write(&soul, "SOUL body").unwrap();
            fs::write(&user, "USER body").unwrap();
            configure(
                vec![
                    soul.to_string_lossy().to_string(),
                    user.to_string_lossy().to_string(),
                ],
                None,
                None,
            )
            .unwrap();

            for source in ["startup", "resume", "clear", "compact", "fork"] {
                let output = build_output(&json!({
                    "hook_event_name": "SessionStart",
                    "source": source
                }))
                .unwrap();
                let context = output["hookSpecificOutput"]["additionalContext"]
                    .as_str()
                    .unwrap();
                assert!(context.contains(MARKER));
                assert!(context.contains(&format!("source={source}")));
                assert!(context.contains("SOUL body"));
                assert!(context.contains("USER body"));
            }
        });
    }

    #[test]
    fn unconfigured_or_disabled_profiles_are_silent() {
        with_private_root(|root| {
            let output = build_output(&json!({
                "hook_event_name": "SessionStart",
                "source": "startup"
            }))
            .unwrap();
            assert!(output.get("hookSpecificOutput").is_none());

            let source = root.join("identity.md");
            fs::write(&source, "identity").unwrap();
            configure(vec![source.to_string_lossy().to_string()], None, None).unwrap();
            set_enabled(false).unwrap();
            let output = build_output(&json!({
                "hook_event_name": "SessionStart",
                "source": "resume"
            }))
            .unwrap();
            assert!(output.get("hookSpecificOutput").is_none());
        });
    }

    #[test]
    fn changed_snapshots_fail_closed() {
        with_private_root(|root| {
            let source = root.join("identity.md");
            fs::write(&source, "identity").unwrap();
            configure(vec![source.to_string_lossy().to_string()], None, None).unwrap();
            let manifest = load_manifest().unwrap().unwrap();
            let snapshot = snapshot_path(&profile_root().unwrap(), &manifest.files[0]).unwrap();
            fs::write(snapshot, "tampered").unwrap();
            let error = build_output(&json!({
                "hook_event_name": "SessionStart",
                "source": "compact"
            }))
            .unwrap_err();
            assert!(error.contains("safety checks") || error.contains("changed"));
        });
    }

    #[test]
    fn fallback_is_written_into_private_claude_md() {
        with_private_root(|root| {
            let source = root.join("identity.md");
            fs::write(&source, "identity").unwrap();
            configure(
                vec![source.to_string_lossy().to_string()],
                Some("week-sync".to_string()),
                None,
            )
            .unwrap();
            let fallback = fs::read_to_string(root.join("CLAUDE.md")).unwrap();
            assert!(fallback.contains(MARKER));
            assert!(fallback.contains("identity-bootstrap/files/"));
            assert!(fallback.contains("week-sync"));
        });
    }

    #[test]
    fn selected_startup_skill_is_copied_into_the_private_runtime() {
        with_private_root(|root| {
            let identity = root.join("identity.md");
            let skill_root = root.join("source-skill");
            fs::create_dir_all(&skill_root).unwrap();
            let skill = skill_root.join("SKILL.md");
            fs::write(&identity, "identity").unwrap();
            fs::write(&skill, "---\nname: week-sync\n---\n# Week sync").unwrap();
            let status = configure(
                vec![identity.to_string_lossy().to_string()],
                Some("week-sync".to_string()),
                Some(skill.to_string_lossy().to_string()),
            )
            .unwrap();
            assert!(status.startup_skill_installed);
            assert_eq!(
                fs::read_to_string(root.join("skills/week-sync/SKILL.md")).unwrap(),
                "---\nname: week-sync\n---\n# Week sync"
            );
        });
    }
}
