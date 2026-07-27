use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command as StdCommand, Stdio};
use std::time::Duration;
use tokio::process::Command;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum McpScope {
    Local,
    Project,
    User,
}

impl McpScope {
    fn rank(self) -> u8 {
        match self {
            Self::Local => 3,
            Self::Project => 2,
            Self::User => 1,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum McpConnectionStatus {
    Connected,
    Failed,
    PendingApproval,
    Rejected,
    NeedsAuth,
    Unknown,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerRecord {
    pub name: String,
    pub scope: McpScope,
    pub config: Value,
    pub effective: bool,
    pub shadowed_by: Option<McpScope>,
    pub status: McpConnectionStatus,
    pub status_detail: Option<String>,
    pub tool_count: Option<u32>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpSaveRequest {
    pub original_name: Option<String>,
    pub original_scope: Option<McpScope>,
    pub name: String,
    pub scope: McpScope,
    pub config: Value,
    pub cwd: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ApprovalState {
    Approved,
    Pending,
    Rejected,
}

#[derive(Debug)]
struct McpConfigSnapshot {
    records: Vec<McpServerRecord>,
}

fn claude_state_path() -> Result<PathBuf, String> {
    Ok(super::client_runtime::claude_config_dir()?.join(".claude.json"))
}

fn read_json_document(path: &Path) -> Result<Value, String> {
    if !path.exists() {
        return Ok(Value::Object(Map::new()));
    }
    let raw = fs::read_to_string(path)
        .map_err(|error| format!("Cannot read MCP configuration: {error}"))?;
    serde_json::from_str(&raw).map_err(|error| format!("Invalid MCP configuration JSON: {error}"))
}

fn write_json_document(path: &Path, value: &Value, private: bool) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Cannot create MCP configuration directory: {error}"))?;
    }
    let mut payload = serde_json::to_string_pretty(value)
        .map_err(|error| format!("Cannot encode MCP configuration: {error}"))?;
    payload.push('\n');
    fs::write(path, payload).map_err(|error| format!("Cannot save MCP configuration: {error}"))?;
    #[cfg(unix)]
    if private {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
            .map_err(|error| format!("Cannot secure MCP configuration permissions: {error}"))?;
    }
    Ok(())
}

fn canonical_or_original(path: &Path) -> PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn validate_cwd(cwd: Option<&str>) -> Result<Option<PathBuf>, String> {
    let Some(raw) = cwd.filter(|value| !value.trim().is_empty()) else {
        return Ok(None);
    };
    let path = PathBuf::from(raw);
    if !path.is_dir() {
        return Err("MCP local/project scope requires an existing working directory".to_string());
    }
    let path = canonical_or_original(&path);
    if let Some(root) = std::env::var_os("BLACKBOX_DEV_ISOLATION_ROOT") {
        let root = canonical_or_original(Path::new(&root));
        if !path.starts_with(&root) {
            return Err(
                "Development isolation rejected an MCP path outside the test workspace".to_string(),
            );
        }
    }
    Ok(Some(path))
}

fn project_root(cwd: &Path) -> PathBuf {
    let output = StdCommand::new("git")
        .args(["-C", &cwd.to_string_lossy(), "rev-parse", "--show-toplevel"])
        .env("PATH", super::build_enriched_path())
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output();
    if let Ok(output) = output {
        if output.status.success() {
            let root = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !root.is_empty() {
                return canonical_or_original(Path::new(&root));
            }
        }
    }
    canonical_or_original(cwd)
}

fn project_mcp_path(cwd: &Path, root: &Path) -> PathBuf {
    let mut cursor = Some(cwd);
    while let Some(directory) = cursor {
        let candidate = directory.join(".mcp.json");
        if candidate.is_file() {
            return candidate;
        }
        if directory == root {
            break;
        }
        cursor = directory.parent();
    }
    root.join(".mcp.json")
}

fn object_at<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a Map<String, Value>> {
    let mut current = value;
    for key in keys {
        current = current.get(*key)?;
    }
    current.as_object()
}

fn ensure_object(value: &mut Value) -> &mut Map<String, Value> {
    if !value.is_object() {
        *value = Value::Object(Map::new());
    }
    value
        .as_object_mut()
        .expect("value was normalized to object")
}

fn ensure_child_object<'a>(parent: &'a mut Value, key: &str) -> &'a mut Map<String, Value> {
    let object = ensure_object(parent);
    let child = object
        .entry(key.to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    ensure_object(child)
}

fn string_set(value: Option<&Value>, key: &str) -> HashSet<String> {
    value
        .and_then(|item| item.get(key))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect()
}

fn approval_state(
    name: &str,
    project_state: Option<&Value>,
    local_settings: Option<&Value>,
) -> ApprovalState {
    let disabled = string_set(project_state, "disabledMcpjsonServers")
        .into_iter()
        .chain(string_set(local_settings, "disabledMcpjsonServers"))
        .collect::<HashSet<_>>();
    if disabled.contains(name) {
        return ApprovalState::Rejected;
    }
    let enabled = string_set(project_state, "enabledMcpjsonServers")
        .into_iter()
        .chain(string_set(local_settings, "enabledMcpjsonServers"))
        .collect::<HashSet<_>>();
    let enable_all = [project_state, local_settings]
        .into_iter()
        .flatten()
        .any(|value| {
            value
                .get("enableAllProjectMcpServers")
                .and_then(Value::as_bool)
                .unwrap_or(false)
        });
    if enable_all || enabled.contains(name) {
        ApprovalState::Approved
    } else {
        ApprovalState::Pending
    }
}

fn records_from_map(
    map: Option<&Map<String, Value>>,
    scope: McpScope,
    project_state: Option<&Value>,
    local_settings: Option<&Value>,
) -> Vec<McpServerRecord> {
    let map = map.and_then(|servers| {
        let legacy_nested = servers
            .get("mcpServers")
            .and_then(Value::as_object)
            .filter(|nested| {
                servers.len() == 1
                    && !nested.contains_key("type")
                    && !nested.contains_key("command")
                    && !nested.contains_key("url")
            });
        legacy_nested.or(Some(servers))
    });
    map.into_iter()
        .flat_map(|servers| servers.iter())
        .map(|(name, config)| {
            let approval = if scope == McpScope::Project {
                approval_state(name, project_state, local_settings)
            } else {
                ApprovalState::Approved
            };
            let (status, detail) = match approval {
                ApprovalState::Approved => (McpConnectionStatus::Unknown, None),
                ApprovalState::Pending => (
                    McpConnectionStatus::PendingApproval,
                    Some("Project server requires explicit approval".to_string()),
                ),
                ApprovalState::Rejected => (
                    McpConnectionStatus::Rejected,
                    Some("Project server was rejected".to_string()),
                ),
            };
            McpServerRecord {
                name: name.clone(),
                scope,
                config: config.clone(),
                effective: false,
                shadowed_by: None,
                status,
                status_detail: detail,
                tool_count: None,
            }
        })
        .collect()
}

fn mark_precedence(records: &mut [McpServerRecord]) {
    let mut winners = HashMap::<String, McpScope>::new();
    for record in records.iter() {
        winners
            .entry(record.name.clone())
            .and_modify(|scope| {
                if record.scope.rank() > scope.rank() {
                    *scope = record.scope;
                }
            })
            .or_insert(record.scope);
    }
    for record in records {
        let winner = winners[&record.name];
        record.effective = record.scope == winner;
        record.shadowed_by = (!record.effective).then_some(winner);
    }
}

fn config_snapshot(cwd: Option<&Path>) -> Result<McpConfigSnapshot, String> {
    let state_path = claude_state_path()?;
    let state = read_json_document(&state_path)?;
    let mut records = records_from_map(
        object_at(&state, &["mcpServers"]),
        McpScope::User,
        None,
        None,
    );

    if let Some(cwd) = cwd {
        let root = project_root(cwd);
        let root_key = root.to_string_lossy();
        let project_state = state
            .get("projects")
            .and_then(Value::as_object)
            .and_then(|projects| projects.get(root_key.as_ref()));
        records.extend(records_from_map(
            project_state
                .and_then(|value| value.get("mcpServers"))
                .and_then(Value::as_object),
            McpScope::Local,
            None,
            None,
        ));

        let project_path = project_mcp_path(cwd, &root);
        let project_doc = read_json_document(&project_path)?;
        let settings_path = project_path
            .parent()
            .unwrap_or(&root)
            .join(".claude")
            .join("settings.local.json");
        let local_settings = settings_path
            .is_file()
            .then(|| read_json_document(&settings_path))
            .transpose()?;
        records.extend(records_from_map(
            object_at(&project_doc, &["mcpServers"]),
            McpScope::Project,
            project_state,
            local_settings.as_ref(),
        ));
    }
    mark_precedence(&mut records);
    records.sort_by(|left, right| {
        left.name
            .cmp(&right.name)
            .then_with(|| right.scope.rank().cmp(&left.scope.rank()))
    });
    Ok(McpConfigSnapshot { records })
}

pub(crate) fn effective_mcp_servers(cwd: &Path) -> Result<Map<String, Value>, String> {
    let snapshot = config_snapshot(Some(cwd))?;
    Ok(effective_map_from_records(&snapshot.records))
}

fn effective_map_from_records(records: &[McpServerRecord]) -> Map<String, Value> {
    records
        .iter()
        .filter(|record| {
            record.effective
                && !matches!(
                    record.status,
                    McpConnectionStatus::PendingApproval | McpConnectionStatus::Rejected
                )
        })
        .map(|record| (record.name.clone(), record.config.clone()))
        .collect()
}

fn validate_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name.len() > 64 {
        return Err("MCP server name must contain 1-64 characters".to_string());
    }
    if !name
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || character == '-' || character == '_')
    {
        return Err(
            "MCP server names may contain only letters, numbers, hyphens, and underscores"
                .to_string(),
        );
    }
    let reserved = [
        "workspace",
        "claude-in-chrome",
        "computer-use",
        "claude preview",
        "claude browser",
    ];
    if reserved
        .iter()
        .any(|value| value.eq_ignore_ascii_case(name))
    {
        return Err("This MCP server name is reserved by Claude Code".to_string());
    }
    Ok(())
}

fn validate_string_map(config: &Map<String, Value>, key: &str) -> Result<(), String> {
    if let Some(value) = config.get(key) {
        let object = value
            .as_object()
            .ok_or_else(|| format!("MCP {key} must be an object"))?;
        if object.values().any(|item| !item.is_string()) {
            return Err(format!("Every MCP {key} value must be a string"));
        }
    }
    Ok(())
}

fn transport_of(config: &Value) -> String {
    config
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_else(|| {
            if config.get("command").is_some() {
                "stdio"
            } else {
                "unknown"
            }
        })
        .to_ascii_lowercase()
}

fn validate_config(config: &Value) -> Result<(), String> {
    let object = config
        .as_object()
        .ok_or_else(|| "MCP server configuration must be an object".to_string())?;
    let transport = transport_of(config);
    match transport.as_str() {
        "stdio" => {
            if object
                .get("command")
                .and_then(Value::as_str)
                .is_none_or(|command| command.trim().is_empty())
            {
                return Err("stdio MCP servers require a command".to_string());
            }
            if let Some(args) = object.get("args") {
                if args
                    .as_array()
                    .is_none_or(|items| items.iter().any(|item| !item.is_string()))
                {
                    return Err("MCP args must be an array of strings".to_string());
                }
            }
            validate_string_map(object, "env")?;
        }
        "http" | "streamable-http" | "sse" => {
            let url = object
                .get("url")
                .and_then(Value::as_str)
                .ok_or_else(|| "Remote MCP servers require a URL".to_string())?;
            if !(url.starts_with("https://") || url.starts_with("http://")) {
                return Err("HTTP/SSE MCP URLs must begin with https:// or http://".to_string());
            }
            validate_string_map(object, "headers")?;
        }
        "ws" => {
            let url = object
                .get("url")
                .and_then(Value::as_str)
                .ok_or_else(|| "WebSocket MCP servers require a URL".to_string())?;
            if !(url.starts_with("wss://") || url.starts_with("ws://")) {
                return Err("WebSocket MCP URLs must begin with wss:// or ws://".to_string());
            }
            validate_string_map(object, "headers")?;
        }
        _ => return Err("MCP type must be stdio, http, streamable-http, sse, or ws".to_string()),
    }
    if object.contains_key("url") && !object.contains_key("type") {
        return Err("Remote MCP servers require an explicit type".to_string());
    }
    if let Some(timeout) = object.get("timeout") {
        if timeout.as_u64().is_none_or(|value| value < 1000) {
            return Err("MCP timeout must be at least 1000 milliseconds".to_string());
        }
    }
    if let Some(oauth) = object.get("oauth") {
        if !matches!(transport.as_str(), "http" | "streamable-http") {
            return Err("OAuth is supported only for HTTP MCP servers".to_string());
        }
        let oauth = oauth
            .as_object()
            .ok_or_else(|| "MCP oauth must be an object".to_string())?;
        if oauth.contains_key("clientSecret") {
            return Err("OAuth client secrets must not be stored in MCP configuration".to_string());
        }
        if let Some(url) = oauth.get("authServerMetadataUrl").and_then(Value::as_str) {
            if !url.starts_with("https://") {
                return Err("OAuth metadata URLs must use https://".to_string());
            }
        }
        if let Some(port) = oauth.get("callbackPort") {
            if port
                .as_u64()
                .is_none_or(|value| value == 0 || value > u16::MAX as u64)
            {
                return Err("OAuth callback port must be between 1 and 65535".to_string());
            }
        }
    }
    Ok(())
}

enum ScopeTarget {
    State {
        path: PathBuf,
        project_key: Option<String>,
    },
    Project {
        path: PathBuf,
    },
}

fn scope_target(scope: McpScope, cwd: Option<&Path>) -> Result<ScopeTarget, String> {
    match scope {
        McpScope::User => Ok(ScopeTarget::State {
            path: claude_state_path()?,
            project_key: None,
        }),
        McpScope::Local => {
            let cwd = cwd.ok_or_else(|| {
                "Local MCP scope requires a selected working directory".to_string()
            })?;
            Ok(ScopeTarget::State {
                path: claude_state_path()?,
                project_key: Some(project_root(cwd).to_string_lossy().to_string()),
            })
        }
        McpScope::Project => {
            let cwd = cwd.ok_or_else(|| {
                "Project MCP scope requires a selected working directory".to_string()
            })?;
            let root = project_root(cwd);
            Ok(ScopeTarget::Project {
                path: project_mcp_path(cwd, &root),
            })
        }
    }
}

fn mutate_scope_entry(
    scope: McpScope,
    cwd: Option<&Path>,
    name: &str,
    config: Option<Value>,
    refuse_existing: bool,
) -> Result<(), String> {
    let target = scope_target(scope, cwd)?;
    let (path, mut document, private) = match &target {
        ScopeTarget::State { path, .. } => (path.clone(), read_json_document(path)?, true),
        ScopeTarget::Project { path } => (path.clone(), read_json_document(path)?, false),
    };
    let servers = match &target {
        ScopeTarget::State {
            project_key: None, ..
        } => ensure_child_object(&mut document, "mcpServers"),
        ScopeTarget::State {
            project_key: Some(project_key),
            ..
        } => {
            let projects = ensure_child_object(&mut document, "projects");
            let project = projects
                .entry(project_key.clone())
                .or_insert_with(|| Value::Object(Map::new()));
            ensure_child_object(project, "mcpServers")
        }
        ScopeTarget::Project { .. } => ensure_child_object(&mut document, "mcpServers"),
    };
    if servers.len() == 1 {
        if let Some(inner) = servers
            .get("mcpServers")
            .and_then(Value::as_object)
            .cloned()
        {
            *servers = inner;
        }
    }
    match config {
        Some(config) => {
            if refuse_existing && servers.contains_key(name) {
                return Err(
                    "An MCP server with this name already exists in the selected scope".to_string(),
                );
            }
            servers.insert(name.to_string(), config);
        }
        None => {
            if servers.remove(name).is_none() {
                return Err("MCP server was not found in the selected scope".to_string());
            }
        }
    }
    write_json_document(&path, &document, private)
}

#[tauri::command]
pub async fn list_mcp_servers(
    cwd: Option<String>,
    check_health: Option<bool>,
) -> Result<Vec<McpServerRecord>, String> {
    let cwd = validate_cwd(cwd.as_deref())?;
    let mut snapshot = config_snapshot(cwd.as_deref())?;
    if check_health.unwrap_or(false) {
        match query_health(cwd.as_deref()).await {
            Ok(health) => {
                for record in &mut snapshot.records {
                    if !record.effective
                        || matches!(
                            record.status,
                            McpConnectionStatus::PendingApproval | McpConnectionStatus::Rejected
                        )
                    {
                        continue;
                    }
                    if let Some((status, detail)) = health.get(&record.name) {
                        record.status = *status;
                        record.status_detail = Some(detail.clone());
                    }
                }
            }
            Err(error) => {
                for record in &mut snapshot.records {
                    if record.effective && record.status == McpConnectionStatus::Unknown {
                        record.status_detail = Some(error.clone());
                    }
                }
            }
        }
    }
    Ok(snapshot.records)
}

#[tauri::command]
pub fn save_mcp_server(request: McpSaveRequest) -> Result<Vec<McpServerRecord>, String> {
    let name = request.name.trim();
    validate_name(name)?;
    validate_config(&request.config)?;
    let cwd = validate_cwd(request.cwd.as_deref())?;
    let same_entry = request.original_name.as_deref() == Some(name)
        && request.original_scope == Some(request.scope);
    mutate_scope_entry(
        request.scope,
        cwd.as_deref(),
        name,
        Some(request.config),
        !same_entry,
    )?;
    if let (Some(original_name), Some(original_scope)) =
        (request.original_name.as_deref(), request.original_scope)
    {
        if !same_entry {
            mutate_scope_entry(original_scope, cwd.as_deref(), original_name, None, false)?;
        }
    }
    Ok(config_snapshot(cwd.as_deref())?.records)
}

#[tauri::command]
pub fn delete_mcp_server(
    name: String,
    scope: McpScope,
    cwd: Option<String>,
) -> Result<Vec<McpServerRecord>, String> {
    validate_name(name.trim())?;
    let cwd = validate_cwd(cwd.as_deref())?;
    mutate_scope_entry(scope, cwd.as_deref(), name.trim(), None, false)?;
    Ok(config_snapshot(cwd.as_deref())?.records)
}

fn update_string_array(object: &mut Map<String, Value>, key: &str, name: &str, include: bool) {
    let mut values = object
        .get(key)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect::<HashSet<_>>();
    if include {
        values.insert(name.to_string());
    } else {
        values.remove(name);
    }
    let mut values = values.into_iter().collect::<Vec<_>>();
    values.sort();
    object.insert(
        key.to_string(),
        Value::Array(values.into_iter().map(Value::String).collect()),
    );
}

#[tauri::command]
pub fn set_project_mcp_approval(
    name: String,
    approved: bool,
    cwd: String,
) -> Result<Vec<McpServerRecord>, String> {
    validate_name(name.trim())?;
    let cwd = validate_cwd(Some(&cwd))?
        .ok_or_else(|| "Project MCP approval requires a working directory".to_string())?;
    let root = project_root(&cwd);
    let project_path = project_mcp_path(&cwd, &root);
    let project_doc = read_json_document(&project_path)?;
    if object_at(&project_doc, &["mcpServers"])
        .is_none_or(|servers| !servers.contains_key(name.trim()))
    {
        return Err("Project MCP server was not found".to_string());
    }
    let settings_path = project_path
        .parent()
        .unwrap_or(&root)
        .join(".claude")
        .join("settings.local.json");
    if let Ok(relative) = settings_path.strip_prefix(&root) {
        let tracked = StdCommand::new("git")
            .args([
                "-C",
                &root.to_string_lossy(),
                "ls-files",
                "--error-unmatch",
                "--",
                &relative.to_string_lossy(),
            ])
            .env("PATH", super::build_enriched_path())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false);
        if tracked {
            return Err(
                "Claude ignores MCP approvals from a tracked settings.local.json file".to_string(),
            );
        }
    }
    let mut settings = read_json_document(&settings_path)?;
    let object = ensure_object(&mut settings);
    update_string_array(object, "enabledMcpjsonServers", name.trim(), approved);
    update_string_array(object, "disabledMcpjsonServers", name.trim(), !approved);
    write_json_document(&settings_path, &settings, true)?;
    Ok(config_snapshot(Some(&cwd))?.records)
}

fn parse_health_output(output: &str) -> HashMap<String, (McpConnectionStatus, String)> {
    let mut statuses = HashMap::new();
    for raw_line in output.lines() {
        let line = raw_line.trim();
        let Some((name, rest)) = line.split_once(':') else {
            continue;
        };
        if validate_name(name.trim()).is_err() {
            continue;
        }
        let detail = rest
            .rsplit_once(" - ")
            .map(|(_, value)| value.trim())
            .unwrap_or_else(|| rest.trim());
        let normalized = detail.to_ascii_lowercase();
        let status = if normalized.contains("pending approval") {
            McpConnectionStatus::PendingApproval
        } else if normalized.contains("rejected") {
            McpConnectionStatus::Rejected
        } else if normalized.contains("auth")
            || normalized.contains("login")
            || normalized.contains("401")
            || normalized.contains("403")
        {
            McpConnectionStatus::NeedsAuth
        } else if normalized.contains("connected") && !normalized.contains("failed") {
            McpConnectionStatus::Connected
        } else if normalized.contains("failed") || normalized.contains("error") {
            McpConnectionStatus::Failed
        } else {
            McpConnectionStatus::Unknown
        };
        statuses.insert(
            name.trim().to_string(),
            (status, detail.chars().take(300).collect()),
        );
    }
    statuses
}

async fn run_mcp_cli(
    cwd: Option<&Path>,
    arguments: &[&str],
    timeout: Duration,
) -> Result<String, String> {
    let binary = super::find_claude_binary().ok_or_else(|| "Claude CLI not found".to_string())?;
    let enriched_path = super::build_enriched_path();
    #[cfg(target_os = "windows")]
    let mut command = if super::claude_needs_cmd_wrapper(&binary) {
        let mut command = Command::new("cmd");
        command.args(["/C", &binary]);
        command
    } else {
        Command::new(&binary)
    };
    #[cfg(not(target_os = "windows"))]
    let mut command = Command::new(&binary);
    super::client_runtime::apply_to_tokio_command(&mut command)?;
    command
        .args(arguments)
        .env("PATH", enriched_path)
        .env_remove("CLAUDECODE")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    #[cfg(target_os = "windows")]
    command.creation_flags(0x08000000);
    let child = command
        .spawn()
        .map_err(|error| format!("Cannot start Claude MCP command: {error}"))?;
    let output = tokio::time::timeout(timeout, child.wait_with_output())
        .await
        .map_err(|_| "Claude MCP command timed out".to_string())?
        .map_err(|error| format!("Cannot wait for Claude MCP command: {error}"))?;
    let stdout = super::strip_ansi(&String::from_utf8_lossy(&output.stdout));
    let stderr = super::strip_ansi(&String::from_utf8_lossy(&output.stderr));
    let message = format!("{}\n{}", stdout.trim(), stderr.trim())
        .trim()
        .chars()
        .take(4000)
        .collect::<String>();
    if output.status.success() {
        Ok(message)
    } else if message.is_empty() {
        Err(format!(
            "Claude MCP command exited with {:?}",
            output.status.code()
        ))
    } else {
        Err(message)
    }
}

async fn query_health(
    cwd: Option<&Path>,
) -> Result<HashMap<String, (McpConnectionStatus, String)>, String> {
    let output = run_mcp_cli(cwd, &["mcp", "list"], Duration::from_secs(45)).await?;
    Ok(parse_health_output(&output))
}

fn effective_record(name: &str, cwd: Option<&Path>) -> Result<McpServerRecord, String> {
    config_snapshot(cwd)?
        .records
        .into_iter()
        .find(|record| record.name == name && record.effective)
        .ok_or_else(|| "MCP server is not configured for this project".to_string())
}

#[tauri::command]
pub async fn login_mcp_server(name: String, cwd: Option<String>) -> Result<String, String> {
    validate_name(name.trim())?;
    let cwd = validate_cwd(cwd.as_deref())?;
    let record = effective_record(name.trim(), cwd.as_deref())?;
    if matches!(
        record.status,
        McpConnectionStatus::PendingApproval | McpConnectionStatus::Rejected
    ) {
        return Err("Approve the project MCP server before starting OAuth".to_string());
    }
    let transport = transport_of(&record.config);
    if !matches!(transport.as_str(), "http" | "streamable-http" | "sse") {
        return Err("OAuth login is available only for HTTP or SSE MCP servers".to_string());
    }
    let has_authorization_header = record
        .config
        .get("headers")
        .and_then(Value::as_object)
        .is_some_and(|headers| {
            headers
                .keys()
                .any(|key| key.eq_ignore_ascii_case("authorization"))
        });
    if has_authorization_header {
        return Err(
            "This server uses a static Authorization header; remove it before using OAuth"
                .to_string(),
        );
    }
    run_mcp_cli(
        cwd.as_deref(),
        &["mcp", "login", name.trim()],
        Duration::from_secs(10 * 60),
    )
    .await
}

#[tauri::command]
pub async fn logout_mcp_server(name: String, cwd: Option<String>) -> Result<String, String> {
    validate_name(name.trim())?;
    let cwd = validate_cwd(cwd.as_deref())?;
    run_mcp_cli(
        cwd.as_deref(),
        &["mcp", "logout", name.trim()],
        Duration::from_secs(30),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(name: &str, scope: McpScope, status: McpConnectionStatus) -> McpServerRecord {
        McpServerRecord {
            name: name.to_string(),
            scope,
            config: serde_json::json!({"type":"stdio","command":"test"}),
            effective: false,
            shadowed_by: None,
            status,
            status_detail: None,
            tool_count: None,
        }
    }

    #[test]
    fn precedence_is_local_then_project_then_user() {
        let mut records = vec![
            record("same", McpScope::User, McpConnectionStatus::Unknown),
            record("same", McpScope::Project, McpConnectionStatus::Unknown),
            record("same", McpScope::Local, McpConnectionStatus::Unknown),
        ];
        mark_precedence(&mut records);
        assert!(records
            .iter()
            .any(|record| record.scope == McpScope::Local && record.effective));
        assert!(records
            .iter()
            .filter(|record| record.scope != McpScope::Local)
            .all(|record| record.shadowed_by == Some(McpScope::Local)));
    }

    #[test]
    fn pending_project_server_does_not_fall_through_to_user_scope() {
        let mut records = vec![
            record("same", McpScope::User, McpConnectionStatus::Unknown),
            record(
                "same",
                McpScope::Project,
                McpConnectionStatus::PendingApproval,
            ),
        ];
        mark_precedence(&mut records);
        assert!(effective_map_from_records(&records).is_empty());
    }

    #[test]
    fn validates_remote_and_stdio_shapes() {
        assert!(validate_config(&serde_json::json!({
            "type":"http", "url":"https://example.test/mcp"
        }))
        .is_ok());
        assert!(validate_config(&serde_json::json!({
            "type":"stdio", "command":"node", "args":["server.mjs"]
        }))
        .is_ok());
        assert!(validate_config(&serde_json::json!({
            "url":"https://example.test/mcp"
        }))
        .is_err());
    }

    #[test]
    fn refuses_oauth_secrets_and_insecure_metadata() {
        assert!(validate_config(&serde_json::json!({
            "type":"http",
            "url":"https://example.test/mcp",
            "oauth":{"clientSecret":"do-not-store"}
        }))
        .is_err());
        assert!(validate_config(&serde_json::json!({
            "type":"http",
            "url":"https://example.test/mcp",
            "oauth":{"authServerMetadataUrl":"http://example.test/.well-known"}
        }))
        .is_err());
    }

    #[test]
    fn parses_health_without_retaining_commands_or_urls() {
        let health = parse_health_output(
            "server-a: https://secret.example/mcp - ✓ Connected\nserver-b: node x - ⏸ Pending approval (run `claude` to approve)\nserver-c: https://example.test - Authentication required",
        );
        assert_eq!(health["server-a"].0, McpConnectionStatus::Connected);
        assert_eq!(health["server-b"].0, McpConnectionStatus::PendingApproval);
        assert_eq!(health["server-c"].0, McpConnectionStatus::NeedsAuth);
        assert!(!health["server-a"].1.contains("secret.example"));
    }

    #[test]
    fn approval_denial_overrides_enablement() {
        let project = serde_json::json!({
            "enabledMcpjsonServers":["server"],
            "disabledMcpjsonServers":["server"]
        });
        assert_eq!(
            approval_state("server", Some(&project), None),
            ApprovalState::Rejected
        );
    }

    #[test]
    fn legacy_double_nested_server_map_is_flattened() {
        let value = serde_json::json!({
            "mcpServers": {
                "legacy": {"command":"node","args":["server.mjs"]}
            }
        });
        let records = records_from_map(value.as_object(), McpScope::User, None, None);
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].name, "legacy");
    }

    #[test]
    fn single_server_map_is_not_dropped() {
        let value = serde_json::json!({
            "scheduler_smoke": {
                "type":"stdio",
                "command":"node",
                "args":["server.mjs"]
            }
        });
        let records = records_from_map(value.as_object(), McpScope::User, None, None);
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].name, "scheduler_smoke");
    }

    #[test]
    fn server_named_mcp_servers_is_not_mistaken_for_legacy_nesting() {
        let value = serde_json::json!({
            "mcpServers": {
                "type":"stdio",
                "command":"node",
                "args":["server.mjs"]
            }
        });
        let records = records_from_map(value.as_object(), McpScope::User, None, None);
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].name, "mcpServers");
    }
}
