use futures_util::{stream, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tokio::process::Command;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

const LIST_TIMEOUT: Duration = Duration::from_secs(90);
const MUTATION_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const OUTPUT_LIMIT: usize = 2 * 1024 * 1024;
const MARKETPLACE_MANIFEST_LIMIT: u64 = 5 * 1024 * 1024;
const DIAGNOSTIC_FILE_LIMIT: usize = 4_096;
const DIAGNOSTIC_ENTRY_LIMIT: usize = 8_192;
const DIAGNOSTIC_DEPTH_LIMIT: usize = 64;
const DIAGNOSTIC_BYTE_LIMIT: u64 = 64 * 1024 * 1024;
const DIAGNOSTIC_SINGLE_FILE_LIMIT: u64 = 16 * 1024 * 1024;
const STRICT_VALIDATION_LIMIT: usize = 32;
const STRICT_VALIDATION_CONCURRENCY: usize = 4;
const STRICT_VALIDATION_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PluginScope {
    User,
    Project,
    Local,
    Managed,
}

impl PluginScope {
    fn as_cli(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Project => "project",
            Self::Local => "local",
            Self::Managed => "managed",
        }
    }

    fn ensure_mutable(self) -> Result<(), String> {
        if self == Self::Managed {
            Err("Managed plugins are read-only".to_string())
        } else {
            Ok(())
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PluginRecord {
    pub id: String,
    pub name: String,
    pub marketplace_name: Option<String>,
    pub description: Option<String>,
    pub version: Option<String>,
    pub available_version: Option<String>,
    pub scope: Option<PluginScope>,
    pub enabled: bool,
    pub installed: bool,
    pub update_available: bool,
    pub source: Option<String>,
    pub install_path: Option<String>,
    pub installed_at: Option<String>,
    pub last_updated: Option<String>,
    pub category: Option<String>,
    pub tags: Vec<String>,
    pub homepage: Option<String>,
    pub repository: Option<String>,
    pub author_name: Option<String>,
    pub install_count: Option<u64>,
    pub components: Vec<String>,
    pub strict: Option<bool>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PluginMarketplaceRecord {
    pub name: String,
    pub source: String,
    pub path: Option<String>,
    pub install_location: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PluginValidationStatus {
    Passed,
    Failed,
    Unavailable,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PluginSignatureStatus {
    NotProvided,
    Unsupported,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PluginSourcePinStatus {
    Matched,
    DifferentRevision,
    Recorded,
    Unpinned,
    Local,
    Unknown,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PluginConflictSeverity {
    Error,
    Warning,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PluginConflictKind {
    NamespaceCollision,
    DuplicateScope,
    McpEndpointOverlap,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PluginConflictRecord {
    pub id: String,
    pub kind: PluginConflictKind,
    pub severity: PluginConflictSeverity,
    pub key: String,
    pub plugin_ids: Vec<String>,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PluginDiagnosticRecord {
    pub plugin_id: String,
    pub plugin_name: String,
    pub scope: Option<PluginScope>,
    pub enabled: bool,
    pub install_path: Option<String>,
    pub manifest_name: Option<String>,
    pub validation_status: PluginValidationStatus,
    pub validation_message: String,
    pub signature_status: PluginSignatureStatus,
    pub source_pin_status: PluginSourcePinStatus,
    pub installed_revision: Option<String>,
    pub declared_revision: Option<String>,
    pub content_sha256: Option<String>,
    pub file_count: Option<usize>,
    pub total_bytes: Option<u64>,
    pub symlink_count: usize,
    pub external_symlink_count: usize,
    pub warnings: Vec<String>,
    pub conflict_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PluginDiagnosticsReport {
    pub generated_at: String,
    pub plugins: Vec<PluginDiagnosticRecord>,
    pub conflicts: Vec<PluginConflictRecord>,
    pub validation_passed: usize,
    pub validation_failed: usize,
    pub warning_count: usize,
    pub signature_verification_available: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct MarketplaceSourceMetadata {
    source_kind: String,
    declared_revision: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct ContentFingerprint {
    sha256: String,
    file_count: usize,
    total_bytes: u64,
    symlink_count: usize,
    external_symlink_count: usize,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct PluginInspection {
    manifest_name: Option<String>,
    signature_status: Option<PluginSignatureStatus>,
    mcp_endpoints: Vec<String>,
    fingerprint: Option<ContentFingerprint>,
    warnings: Vec<String>,
}

fn canonical_or_original(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn validate_cwd(cwd: Option<&str>) -> Result<Option<PathBuf>, String> {
    let Some(raw) = cwd.filter(|value| !value.trim().is_empty()) else {
        return Ok(None);
    };
    let path = PathBuf::from(raw);
    if !path.is_dir() {
        return Err(
            "Plugin project/local scope requires an existing working directory".to_string(),
        );
    }
    let path = canonical_or_original(&path);
    enforce_isolation(&path, "plugin working directory")?;
    Ok(Some(path))
}

fn enforce_isolation(path: &Path, label: &str) -> Result<(), String> {
    if let Some(root) = std::env::var_os("BLACKBOX_DEV_ISOLATION_ROOT") {
        let root = canonical_or_original(Path::new(&root));
        if !path.starts_with(&root) {
            return Err(format!(
                "Development isolation rejected {label} outside the test workspace"
            ));
        }
    }
    Ok(())
}

fn validate_scope_cwd(scope: PluginScope, cwd: Option<&Path>) -> Result<(), String> {
    scope.ensure_mutable()?;
    if matches!(scope, PluginScope::Project | PluginScope::Local) && cwd.is_none() {
        return Err("Project/local plugin scope requires a working directory".to_string());
    }
    Ok(())
}

fn validate_identifier(value: &str, label: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() || value.len() > 240 {
        return Err(format!("{label} must be 1-240 characters"));
    }
    if value.chars().any(char::is_control) {
        return Err(format!("{label} cannot contain control characters"));
    }
    Ok(value.to_string())
}

fn validate_marketplace_source(source: &str, cwd: Option<&Path>) -> Result<String, String> {
    let source = validate_identifier(source, "Marketplace source")?;
    let looks_like_path = source.starts_with('/')
        || source.starts_with('.')
        || source.starts_with('~')
        || source.contains('\\');
    if looks_like_path {
        let expanded = if let Some(rest) = source.strip_prefix("~/") {
            dirs::home_dir()
                .ok_or_else(|| "Cannot determine home directory".to_string())?
                .join(rest)
        } else {
            let path = PathBuf::from(&source);
            if path.is_absolute() {
                path
            } else {
                cwd.ok_or_else(|| {
                    "Relative marketplace paths require a project directory".to_string()
                })?
                .join(path)
            }
        };
        if !expanded.exists() {
            return Err("Local marketplace source does not exist".to_string());
        }
        let expanded = canonical_or_original(&expanded);
        enforce_isolation(&expanded, "local marketplace source")?;
        return Ok(expanded.to_string_lossy().to_string());
    }
    Ok(source)
}

fn string_field(value: &Value, name: &str) -> Option<String> {
    value
        .get(name)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(str::to_string)
}

fn nested_string_field(value: &Value, object: &str, name: &str) -> Option<String> {
    value.get(object).and_then(|item| string_field(item, name))
}

fn string_or_object_url(value: &Value, name: &str) -> Option<String> {
    value.get(name).and_then(|item| {
        item.as_str()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .or_else(|| string_field(item, "url"))
    })
}

fn string_array_fields(value: &Value, names: &[&str]) -> Vec<String> {
    let mut values = Vec::new();
    for name in names {
        let Some(items) = value.get(*name).and_then(Value::as_array) else {
            continue;
        };
        for item in items.iter().filter_map(Value::as_str) {
            let item = item.trim();
            if !item.is_empty() && item.len() <= 80 && !values.iter().any(|value| value == item) {
                values.push(item.to_string());
            }
            if values.len() >= 16 {
                return values;
            }
        }
    }
    values
}

fn source_summary(value: Option<&Value>) -> Option<String> {
    let value = value?;
    if let Some(source) = value.as_str() {
        let source = source.trim();
        return (!source.is_empty()).then(|| source.to_string());
    }
    let source_type = string_field(value, "source");
    let location = ["repo", "url", "package"]
        .into_iter()
        .find_map(|name| string_field(value, name));
    let path = string_field(value, "path");
    let mut parts = [source_type, location, path]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
    parts.dedup();
    (!parts.is_empty()).then(|| parts.join(" · "))
}

fn declared_components(value: &Value) -> Vec<String> {
    [
        ("skills", "Skills"),
        ("commands", "Commands"),
        ("agents", "Agents"),
        ("hooks", "Hooks"),
        ("mcpServers", "MCP"),
        ("lspServers", "LSP"),
    ]
    .into_iter()
    .filter_map(|(field, label)| {
        value.get(field).and_then(|item| {
            let declared = match item {
                Value::Null => false,
                Value::String(value) => !value.trim().is_empty(),
                Value::Array(values) => !values.is_empty(),
                Value::Object(values) => !values.is_empty(),
                _ => true,
            };
            declared.then(|| label.to_string())
        })
    })
    .collect()
}

fn split_plugin_id(id: &str) -> (String, Option<String>) {
    match id.rsplit_once('@') {
        Some((name, marketplace)) if !name.is_empty() && !marketplace.is_empty() => {
            (name.to_string(), Some(marketplace.to_string()))
        }
        _ => (id.to_string(), None),
    }
}

fn parse_scope(value: Option<String>) -> Option<PluginScope> {
    match value.as_deref() {
        Some("user") => Some(PluginScope::User),
        Some("project") => Some(PluginScope::Project),
        Some("local") => Some(PluginScope::Local),
        Some("managed") => Some(PluginScope::Managed),
        _ => None,
    }
}

fn installed_record(value: &Value) -> Option<PluginRecord> {
    let id = string_field(value, "id")?;
    let (name, marketplace_name) = split_plugin_id(&id);
    Some(PluginRecord {
        id,
        name,
        marketplace_name,
        description: None,
        version: string_field(value, "version"),
        available_version: None,
        scope: parse_scope(string_field(value, "scope")),
        enabled: value
            .get("enabled")
            .and_then(Value::as_bool)
            .unwrap_or(true),
        installed: true,
        update_available: false,
        source: None,
        install_path: string_field(value, "installPath"),
        installed_at: string_field(value, "installedAt"),
        last_updated: string_field(value, "lastUpdated"),
        category: string_field(value, "category"),
        tags: string_array_fields(value, &["tags", "keywords"]),
        homepage: string_field(value, "homepage"),
        repository: string_or_object_url(value, "repository"),
        author_name: nested_string_field(value, "author", "name"),
        install_count: value.get("installCount").and_then(Value::as_u64),
        components: declared_components(value),
        strict: value.get("strict").and_then(Value::as_bool),
    })
}

fn available_record(value: &Value) -> Option<PluginRecord> {
    let id = string_field(value, "pluginId")?;
    let (fallback_name, fallback_marketplace) = split_plugin_id(&id);
    let name = string_field(value, "name").unwrap_or(fallback_name);
    let marketplace_name = string_field(value, "marketplaceName").or(fallback_marketplace);
    let version = string_field(value, "version");
    Some(PluginRecord {
        id,
        name,
        marketplace_name,
        description: string_field(value, "description"),
        version: version.clone(),
        available_version: version,
        scope: None,
        enabled: false,
        installed: false,
        update_available: false,
        source: source_summary(value.get("source")),
        install_path: None,
        installed_at: None,
        last_updated: None,
        category: string_field(value, "category"),
        tags: string_array_fields(value, &["tags", "keywords"]),
        homepage: string_field(value, "homepage"),
        repository: string_or_object_url(value, "repository"),
        author_name: nested_string_field(value, "author", "name"),
        install_count: value.get("installCount").and_then(Value::as_u64),
        components: declared_components(value),
        strict: value.get("strict").and_then(Value::as_bool),
    })
}

fn parse_plugin_list(raw: &str) -> Result<Vec<PluginRecord>, String> {
    let value: Value = serde_json::from_str(raw)
        .map_err(|error| format!("Claude returned invalid plugin JSON: {error}"))?;
    let (installed, available) = if let Some(array) = value.as_array() {
        (array.as_slice(), &[][..])
    } else {
        let installed = value
            .get("installed")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        let available = value
            .get("available")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        (installed, available)
    };

    let mut records = Vec::<PluginRecord>::new();
    for value in installed {
        if let Some(record) = installed_record(value) {
            records.push(record);
        }
    }
    for value in available {
        let Some(available) = available_record(value) else {
            continue;
        };
        let mut matched = false;
        for installed in records
            .iter_mut()
            .filter(|record| record.id == available.id)
        {
            matched = true;
            installed.description = available.description.clone();
            installed.source = available.source.clone();
            installed.available_version = available.available_version.clone();
            installed.category = available.category.clone();
            installed.tags = available.tags.clone();
            installed.homepage = available.homepage.clone();
            installed.repository = available.repository.clone();
            installed.author_name = available.author_name.clone();
            installed.install_count = available.install_count;
            installed.components = available.components.clone();
            installed.strict = available.strict;
            installed.marketplace_name = installed
                .marketplace_name
                .clone()
                .or_else(|| available.marketplace_name.clone());
            installed.update_available = installed.version.is_some()
                && installed.available_version.is_some()
                && installed.version != installed.available_version;
        }
        if !matched {
            records.push(available);
        }
    }
    records.sort_by(|left, right| {
        left.id.cmp(&right.id).then_with(|| {
            left.scope
                .map(PluginScope::as_cli)
                .cmp(&right.scope.map(PluginScope::as_cli))
        })
    });
    Ok(records)
}

fn parse_marketplaces(raw: &str) -> Result<Vec<PluginMarketplaceRecord>, String> {
    let value: Value = serde_json::from_str(raw)
        .map_err(|error| format!("Claude returned invalid marketplace JSON: {error}"))?;
    let array = value
        .as_array()
        .ok_or_else(|| "Claude marketplace JSON must be an array".to_string())?;
    Ok(array
        .iter()
        .filter_map(|item| {
            Some(PluginMarketplaceRecord {
                name: string_field(item, "name")?,
                source: string_field(item, "source").unwrap_or_else(|| "unknown".to_string()),
                path: string_field(item, "path"),
                install_location: string_field(item, "installLocation"),
            })
        })
        .collect())
}

fn marketplace_manifest_path(record: &PluginMarketplaceRecord) -> Option<PathBuf> {
    for raw in [record.install_location.as_deref(), record.path.as_deref()]
        .into_iter()
        .flatten()
    {
        let base = PathBuf::from(raw);
        let candidates = if base.is_file() {
            vec![base]
        } else {
            vec![
                base.join(".claude-plugin").join("marketplace.json"),
                base.join("marketplace.json"),
            ]
        };
        for candidate in candidates {
            let Ok(metadata) = std::fs::metadata(&candidate) else {
                continue;
            };
            if metadata.is_file() && metadata.len() <= MARKETPLACE_MANIFEST_LIMIT {
                return Some(candidate);
            }
        }
    }
    None
}

fn enrich_plugin_records_from_manifest(
    records: &mut [PluginRecord],
    marketplace_name: &str,
    raw: &str,
) -> Result<(), String> {
    let manifest: Value = serde_json::from_str(raw)
        .map_err(|error| format!("Invalid marketplace manifest: {error}"))?;
    let entries = manifest
        .get("plugins")
        .and_then(Value::as_array)
        .ok_or_else(|| "Marketplace manifest has no plugin array".to_string())?;
    for entry in entries {
        let Some(name) = string_field(entry, "name") else {
            continue;
        };
        let id = format!("{name}@{marketplace_name}");
        for record in records.iter_mut().filter(|record| record.id == id) {
            record.description = record
                .description
                .take()
                .or_else(|| string_field(entry, "description"));
            record.category = record
                .category
                .take()
                .or_else(|| string_field(entry, "category").filter(|value| value.len() <= 80));
            if record.tags.is_empty() {
                record.tags = string_array_fields(entry, &["tags", "keywords"]);
            }
            record.homepage = record
                .homepage
                .take()
                .or_else(|| string_field(entry, "homepage"));
            record.repository = record
                .repository
                .take()
                .or_else(|| string_or_object_url(entry, "repository"));
            record.author_name = record
                .author_name
                .take()
                .or_else(|| nested_string_field(entry, "author", "name"));
            record.source = record
                .source
                .take()
                .or_else(|| source_summary(entry.get("source")));
            if record.components.is_empty() {
                record.components = declared_components(entry);
            }
            if record.strict.is_none() {
                record.strict = entry.get("strict").and_then(Value::as_bool);
            }
            if record.available_version.is_none() {
                record.available_version = string_field(entry, "version");
            }
        }
    }
    Ok(())
}

fn enrich_plugin_records(records: &mut [PluginRecord], marketplaces: &[PluginMarketplaceRecord]) {
    for marketplace in marketplaces {
        let Some(path) = marketplace_manifest_path(marketplace) else {
            continue;
        };
        let Ok(raw) = std::fs::read_to_string(path) else {
            continue;
        };
        let _ = enrich_plugin_records_from_manifest(records, &marketplace.name, &raw);
    }
}

fn claude_config_root() -> Result<PathBuf, String> {
    super::client_runtime::claude_config_dir().map(|root| canonical_or_original(&root))
}

fn validate_plugin_inspection_path(path: &Path) -> Result<PathBuf, String> {
    if !path.is_dir() {
        return Err("Installed plugin path is not a directory".to_string());
    }
    let path = std::fs::canonicalize(path)
        .map_err(|error| format!("Cannot resolve installed plugin path: {error}"))?;
    enforce_isolation(&path, "installed plugin path")?;
    let config_root = claude_config_root()?;
    if !path.starts_with(&config_root) {
        return Err("Installed plugin path is outside the Claude configuration root".to_string());
    }
    Ok(path)
}

fn hash_field(hasher: &mut Sha256, value: &[u8]) {
    hasher.update((value.len() as u64).to_le_bytes());
    hasher.update(value);
}

fn fingerprint_plugin_tree(root: &Path) -> Result<ContentFingerprint, String> {
    let root = validate_plugin_inspection_path(root)?;
    fingerprint_validated_plugin_tree(&root)
}

fn fingerprint_validated_plugin_tree(root: &Path) -> Result<ContentFingerprint, String> {
    let mut hasher = Sha256::new();
    let mut result = ContentFingerprint::default();

    fn visit(
        root: &Path,
        directory: &Path,
        depth: usize,
        visited_entries: &mut usize,
        hasher: &mut Sha256,
        result: &mut ContentFingerprint,
    ) -> Result<(), String> {
        if depth > DIAGNOSTIC_DEPTH_LIMIT {
            return Err(format!(
                "Plugin content exceeds the {DIAGNOSTIC_DEPTH_LIMIT}-level diagnostic depth limit"
            ));
        }
        let mut entries = fs::read_dir(directory)
            .map_err(|error| format!("Cannot read plugin directory: {error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("Cannot enumerate plugin directory: {error}"))?;
        entries.sort_by_key(|entry| entry.file_name());

        for entry in entries {
            *visited_entries = visited_entries.saturating_add(1);
            if *visited_entries > DIAGNOSTIC_ENTRY_LIMIT {
                return Err(format!(
                    "Plugin content exceeds the {DIAGNOSTIC_ENTRY_LIMIT}-entry diagnostic limit"
                ));
            }
            let path = entry.path();
            let relative = path
                .strip_prefix(root)
                .map_err(|_| "Plugin content escaped its install root".to_string())?;
            let relative = relative.to_string_lossy().replace('\\', "/");
            let metadata = fs::symlink_metadata(&path)
                .map_err(|error| format!("Cannot inspect plugin content: {error}"))?;

            if metadata.file_type().is_symlink() {
                result.symlink_count = result.symlink_count.saturating_add(1);
                hash_field(hasher, b"symlink");
                hash_field(hasher, relative.as_bytes());
                let target = fs::read_link(&path)
                    .map_err(|error| format!("Cannot read plugin symlink: {error}"))?;
                hash_field(hasher, target.to_string_lossy().as_bytes());
                let resolved = if target.is_absolute() {
                    target
                } else {
                    path.parent().unwrap_or(root).join(target)
                };
                match fs::canonicalize(&resolved) {
                    Ok(resolved) if !resolved.starts_with(root) => {
                        result.external_symlink_count =
                            result.external_symlink_count.saturating_add(1);
                    }
                    Err(_) => {
                        result.external_symlink_count =
                            result.external_symlink_count.saturating_add(1);
                    }
                    _ => {}
                }
                continue;
            }

            if metadata.is_dir() {
                hash_field(hasher, b"directory");
                hash_field(hasher, relative.as_bytes());
                visit(root, &path, depth + 1, visited_entries, hasher, result)?;
                continue;
            }

            if !metadata.is_file() {
                return Err(format!("Unsupported plugin file type: {relative}"));
            }
            if result.file_count >= DIAGNOSTIC_FILE_LIMIT {
                return Err(format!(
                    "Plugin content exceeds the {DIAGNOSTIC_FILE_LIMIT}-file diagnostic limit"
                ));
            }
            if metadata.len() > DIAGNOSTIC_SINGLE_FILE_LIMIT {
                return Err(format!(
                    "Plugin file exceeds the {} MiB diagnostic limit: {relative}",
                    DIAGNOSTIC_SINGLE_FILE_LIMIT / 1024 / 1024
                ));
            }
            let next_total = result.total_bytes.saturating_add(metadata.len());
            if next_total > DIAGNOSTIC_BYTE_LIMIT {
                return Err(format!(
                    "Plugin content exceeds the {} MiB diagnostic limit",
                    DIAGNOSTIC_BYTE_LIMIT / 1024 / 1024
                ));
            }

            hash_field(hasher, b"file");
            hash_field(hasher, relative.as_bytes());
            hash_field(hasher, &metadata.len().to_le_bytes());
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                hash_field(
                    hasher,
                    &(metadata.permissions().mode() & 0o111).to_le_bytes(),
                );
            }
            let mut file = fs::File::open(&path)
                .map_err(|error| format!("Cannot read plugin file {relative}: {error}"))?;
            let mut buffer = [0_u8; 64 * 1024];
            loop {
                let count = file
                    .read(&mut buffer)
                    .map_err(|error| format!("Cannot hash plugin file {relative}: {error}"))?;
                if count == 0 {
                    break;
                }
                hasher.update(&buffer[..count]);
            }
            result.file_count += 1;
            result.total_bytes = next_total;
        }
        Ok(())
    }

    let mut visited_entries = 0;
    visit(
        root,
        root,
        0,
        &mut visited_entries,
        &mut hasher,
        &mut result,
    )?;
    result.sha256 = format!("{:x}", hasher.finalize());
    Ok(result)
}

fn read_bounded_json(path: &Path, label: &str) -> Result<Value, String> {
    let metadata =
        fs::metadata(path).map_err(|error| format!("Cannot inspect {label}: {error}"))?;
    if !metadata.is_file() || metadata.len() > MARKETPLACE_MANIFEST_LIMIT {
        return Err(format!("{label} is missing or exceeds the size limit"));
    }
    let raw = fs::read_to_string(path).map_err(|error| format!("Cannot read {label}: {error}"))?;
    serde_json::from_str(&raw).map_err(|error| format!("Invalid {label}: {error}"))
}

fn mcp_endpoint_identity(value: &Value) -> Option<String> {
    let object = value.as_object()?;
    if let Some(url) = object.get("url").and_then(Value::as_str) {
        let url = url.trim();
        if !url.is_empty() {
            return Some(format!("url:{url}"));
        }
    }
    let command = object.get("command").and_then(Value::as_str)?.trim();
    if command.is_empty() {
        return None;
    }
    let args = object
        .get("args")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join("\u{0}")
        })
        .unwrap_or_default();
    Some(format!("stdio:{command}\u{0}{args}"))
}

fn collect_mcp_endpoints(value: &Value, endpoints: &mut BTreeSet<String>) {
    let servers = value
        .get("mcpServers")
        .and_then(Value::as_object)
        .or_else(|| value.as_object());
    let Some(servers) = servers else {
        return;
    };
    for config in servers.values() {
        let Some(identity) = mcp_endpoint_identity(config) else {
            continue;
        };
        endpoints.insert(format!("{:x}", Sha256::digest(identity.as_bytes())));
    }
}

fn manifest_signature_status(manifest: Option<&Value>) -> PluginSignatureStatus {
    if manifest.is_some_and(|value| {
        ["signature", "signatures", "publisherSignature"]
            .iter()
            .any(|field| value.get(*field).is_some())
    }) {
        PluginSignatureStatus::Unsupported
    } else {
        PluginSignatureStatus::NotProvided
    }
}

fn inspect_plugin_root(path: &Path) -> Result<PluginInspection, String> {
    let path = validate_plugin_inspection_path(path)?;
    let mut inspection = PluginInspection::default();
    match fingerprint_plugin_tree(&path) {
        Ok(fingerprint) => inspection.fingerprint = Some(fingerprint),
        Err(error) => inspection.warnings.push(error),
    }

    let manifest_path = path.join(".claude-plugin").join("plugin.json");
    let manifest = if manifest_path.is_file() {
        match read_bounded_json(&manifest_path, "plugin manifest") {
            Ok(value) => Some(value),
            Err(error) => {
                inspection.warnings.push(error);
                None
            }
        }
    } else {
        inspection
            .warnings
            .push("Plugin manifest is missing".to_string());
        None
    };
    inspection.manifest_name = manifest
        .as_ref()
        .and_then(|value| string_field(value, "name"));
    inspection.signature_status = Some(manifest_signature_status(manifest.as_ref()));

    let mut endpoints = BTreeSet::new();
    let default_mcp = path.join(".mcp.json");
    if default_mcp.is_file() {
        match read_bounded_json(&default_mcp, "plugin MCP configuration") {
            Ok(value) => collect_mcp_endpoints(&value, &mut endpoints),
            Err(error) => inspection.warnings.push(error),
        }
    }
    if let Some(manifest) = manifest.as_ref() {
        if let Some(mcp) = manifest.get("mcpServers") {
            match mcp {
                Value::Object(_) => collect_mcp_endpoints(mcp, &mut endpoints),
                Value::String(relative) => {
                    let candidate = path.join(relative.trim_start_matches("./"));
                    match read_bounded_json(&candidate, "declared plugin MCP configuration") {
                        Ok(value) => collect_mcp_endpoints(&value, &mut endpoints),
                        Err(error) => inspection.warnings.push(error),
                    }
                }
                _ => inspection
                    .warnings
                    .push("Unsupported mcpServers declaration shape".to_string()),
            }
        }
    }
    inspection.mcp_endpoints = endpoints.into_iter().collect();
    Ok(inspection)
}

fn installed_revision_key(id: &str, scope: Option<PluginScope>) -> String {
    format!(
        "{id}\u{0}{}",
        scope.map(PluginScope::as_cli).unwrap_or("unknown")
    )
}

fn installed_plugin_revisions() -> BTreeMap<String, String> {
    let Ok(root) = claude_config_root() else {
        return BTreeMap::new();
    };
    let path = root.join("plugins").join("installed_plugins.json");
    let Ok(raw) = fs::read_to_string(path) else {
        return BTreeMap::new();
    };
    let Ok(value) = serde_json::from_str::<Value>(&raw) else {
        return BTreeMap::new();
    };
    let mut revisions = BTreeMap::new();
    let Some(plugins) = value.get("plugins").and_then(Value::as_object) else {
        return revisions;
    };
    for (id, installs) in plugins {
        let Some(installs) = installs.as_array() else {
            continue;
        };
        for install in installs {
            let scope = parse_scope(string_field(install, "scope"));
            let Some(revision) = string_field(install, "gitCommitSha") else {
                continue;
            };
            revisions.insert(installed_revision_key(id, scope), revision);
        }
    }
    revisions
}

fn marketplace_source_metadata(
    marketplaces: &[PluginMarketplaceRecord],
) -> BTreeMap<String, MarketplaceSourceMetadata> {
    let mut metadata = BTreeMap::new();
    for marketplace in marketplaces {
        let Some(path) = marketplace_manifest_path(marketplace) else {
            continue;
        };
        let Ok(manifest) = read_bounded_json(&path, "marketplace manifest") else {
            continue;
        };
        let Some(plugins) = manifest.get("plugins").and_then(Value::as_array) else {
            continue;
        };
        for plugin in plugins {
            let Some(name) = string_field(plugin, "name") else {
                continue;
            };
            let source = plugin.get("source");
            let (source_kind, declared_revision) = match source {
                Some(Value::String(value)) => {
                    let kind = if value.trim().starts_with("./") {
                        if marketplace.source.eq_ignore_ascii_case("directory") {
                            "local"
                        } else {
                            "marketplaceRelative"
                        }
                    } else {
                        "remote"
                    };
                    (kind.to_string(), None)
                }
                Some(Value::Object(_)) => (
                    source
                        .and_then(|value| string_field(value, "source"))
                        .unwrap_or_else(|| "remote".to_string()),
                    source.and_then(|value| string_field(value, "sha")),
                ),
                _ => ("unknown".to_string(), None),
            };
            metadata.insert(
                format!("{name}@{}", marketplace.name),
                MarketplaceSourceMetadata {
                    source_kind,
                    declared_revision,
                },
            );
        }
    }
    metadata
}

fn source_pin_status(
    metadata: Option<&MarketplaceSourceMetadata>,
    installed_revision: Option<&str>,
) -> PluginSourcePinStatus {
    let Some(metadata) = metadata else {
        return installed_revision
            .map(|_| PluginSourcePinStatus::Recorded)
            .unwrap_or(PluginSourcePinStatus::Unknown);
    };
    if metadata.source_kind.eq_ignore_ascii_case("local")
        || metadata.source_kind.eq_ignore_ascii_case("directory")
    {
        return PluginSourcePinStatus::Local;
    }
    match (metadata.declared_revision.as_deref(), installed_revision) {
        (Some(declared), Some(installed)) if declared == installed => {
            PluginSourcePinStatus::Matched
        }
        (Some(_), Some(_)) => PluginSourcePinStatus::DifferentRevision,
        (Some(_), None) => PluginSourcePinStatus::Unpinned,
        (None, Some(_)) => PluginSourcePinStatus::Recorded,
        (None, None) if metadata.source_kind == "unknown" => PluginSourcePinStatus::Unknown,
        (None, None) => PluginSourcePinStatus::Unpinned,
    }
}

fn short_hash(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
        .chars()
        .take(12)
        .collect()
}

fn add_conflict(
    conflicts: &mut Vec<PluginConflictRecord>,
    diagnostics: &mut [PluginDiagnosticRecord],
    kind: PluginConflictKind,
    severity: PluginConflictSeverity,
    key: String,
    indices: &[usize],
    message: String,
) {
    let id = format!("{:?}:{}", kind, short_hash(&key));
    let plugin_ids = indices
        .iter()
        .filter_map(|index| diagnostics.get(*index))
        .map(|record| record.plugin_id.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    for index in indices {
        if let Some(record) = diagnostics.get_mut(*index) {
            record.conflict_ids.push(id.clone());
        }
    }
    conflicts.push(PluginConflictRecord {
        id,
        kind,
        severity,
        key,
        plugin_ids,
        message,
    });
}

fn detect_plugin_conflicts(
    diagnostics: &mut [PluginDiagnosticRecord],
    mcp_endpoints: &[Vec<String>],
) -> Vec<PluginConflictRecord> {
    let mut conflicts = Vec::new();
    let mut by_id = BTreeMap::<String, Vec<usize>>::new();
    let mut by_namespace = BTreeMap::<String, Vec<usize>>::new();
    let mut by_mcp_endpoint = BTreeMap::<String, Vec<usize>>::new();
    for (index, diagnostic) in diagnostics.iter().enumerate() {
        if !diagnostic.enabled {
            continue;
        }
        by_id
            .entry(diagnostic.plugin_id.clone())
            .or_default()
            .push(index);
        if let Some(namespace) = diagnostic.manifest_name.as_ref() {
            by_namespace
                .entry(namespace.clone())
                .or_default()
                .push(index);
        }
        for endpoint in mcp_endpoints.get(index).into_iter().flatten() {
            by_mcp_endpoint
                .entry(endpoint.clone())
                .or_default()
                .push(index);
        }
    }

    for (id, indices) in by_id.into_iter().filter(|(_, indices)| indices.len() > 1) {
        add_conflict(
            &mut conflicts,
            diagnostics,
            PluginConflictKind::DuplicateScope,
            PluginConflictSeverity::Warning,
            id.clone(),
            &indices,
            format!("{id} is enabled in more than one installation scope"),
        );
    }
    for (namespace, indices) in by_namespace {
        let ids = indices
            .iter()
            .map(|index| diagnostics[*index].plugin_id.as_str())
            .collect::<BTreeSet<_>>();
        if ids.len() <= 1 {
            continue;
        }
        add_conflict(
            &mut conflicts,
            diagnostics,
            PluginConflictKind::NamespaceCollision,
            PluginConflictSeverity::Error,
            namespace.clone(),
            &indices,
            format!("Multiple enabled plugins declare the namespace {namespace}"),
        );
    }
    for (endpoint, indices) in by_mcp_endpoint {
        let ids = indices
            .iter()
            .map(|index| diagnostics[*index].plugin_id.as_str())
            .collect::<BTreeSet<_>>();
        if ids.len() <= 1 {
            continue;
        }
        add_conflict(
            &mut conflicts,
            diagnostics,
            PluginConflictKind::McpEndpointOverlap,
            PluginConflictSeverity::Warning,
            format!("sha256:{}", endpoint.chars().take(12).collect::<String>()),
            &indices,
            "Multiple enabled plugins declare the same MCP endpoint; Claude may deduplicate one by endpoint precedence".to_string(),
        );
    }
    conflicts
}

async fn run_plugin_cli(
    cwd: Option<&Path>,
    arguments: &[String],
    timeout: Duration,
) -> Result<String, String> {
    let binary = super::find_claude_binary().ok_or_else(|| "Claude CLI not found".to_string())?;
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
        .env("PATH", super::build_enriched_path())
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
        .map_err(|error| format!("Cannot start Claude plugin command: {error}"))?;
    let output = tokio::time::timeout(timeout, child.wait_with_output())
        .await
        .map_err(|_| "Claude plugin command timed out".to_string())?
        .map_err(|error| format!("Cannot wait for Claude plugin command: {error}"))?;
    let stdout = super::strip_ansi(&String::from_utf8_lossy(&output.stdout));
    let stderr = super::strip_ansi(&String::from_utf8_lossy(&output.stderr));
    let message = format!("{}\n{}", stdout.trim(), stderr.trim())
        .trim()
        .chars()
        .take(OUTPUT_LIMIT)
        .collect::<String>();
    if output.status.success() {
        Ok(message)
    } else if message.is_empty() {
        Err(format!(
            "Claude plugin command exited with {:?}",
            output.status.code()
        ))
    } else {
        Err(message)
    }
}

async fn list_plugins_inner(
    cwd: Option<&Path>,
    include_available: bool,
) -> Result<Vec<PluginRecord>, String> {
    let mut arguments = vec![
        "plugin".to_string(),
        "list".to_string(),
        "--json".to_string(),
    ];
    if include_available {
        arguments.push("--available".to_string());
    }
    let raw = run_plugin_cli(cwd, &arguments, LIST_TIMEOUT).await?;
    let mut records = parse_plugin_list(&raw)?;
    if include_available {
        if let Ok(marketplaces) = list_marketplaces_inner(cwd).await {
            enrich_plugin_records(&mut records, &marketplaces);
        }
    }
    Ok(records)
}

async fn list_marketplaces_inner(
    cwd: Option<&Path>,
) -> Result<Vec<PluginMarketplaceRecord>, String> {
    let raw = run_plugin_cli(
        cwd,
        &[
            "plugin".to_string(),
            "marketplace".to_string(),
            "list".to_string(),
            "--json".to_string(),
        ],
        LIST_TIMEOUT,
    )
    .await?;
    parse_marketplaces(&raw)
}

#[tauri::command]
pub async fn list_plugins(
    cwd: Option<String>,
    include_available: bool,
) -> Result<Vec<PluginRecord>, String> {
    let cwd = validate_cwd(cwd.as_deref())?;
    list_plugins_inner(cwd.as_deref(), include_available).await
}

#[tauri::command]
pub async fn list_plugin_marketplaces(
    cwd: Option<String>,
) -> Result<Vec<PluginMarketplaceRecord>, String> {
    let cwd = validate_cwd(cwd.as_deref())?;
    list_marketplaces_inner(cwd.as_deref()).await
}

fn concise_diagnostic_message(message: &str) -> String {
    let message = message.trim();
    if message.is_empty() {
        return "Claude CLI returned no validation details".to_string();
    }
    message.chars().take(4_000).collect()
}

fn validation_cli_unavailable(message: &str) -> bool {
    let normalized = message.to_ascii_lowercase();
    normalized.contains("claude cli not found")
        || normalized.contains("timed out")
        || normalized.contains("cannot start claude plugin command")
        || normalized.contains("cannot wait for claude plugin command")
}

#[tauri::command]
pub async fn diagnose_plugins(cwd: Option<String>) -> Result<PluginDiagnosticsReport, String> {
    let cwd = validate_cwd(cwd.as_deref())?;
    let mut plugins = list_plugins_inner(cwd.as_deref(), false).await?;
    plugins.retain(|plugin| plugin.installed);
    plugins.sort_by(|left, right| {
        left.id.cmp(&right.id).then_with(|| {
            left.scope
                .map(PluginScope::as_cli)
                .cmp(&right.scope.map(PluginScope::as_cli))
        })
    });

    let marketplaces = list_marketplaces_inner(cwd.as_deref())
        .await
        .unwrap_or_default();
    let source_metadata = marketplace_source_metadata(&marketplaces);
    let installed_revisions = installed_plugin_revisions();
    let mut diagnostics = Vec::with_capacity(plugins.len());
    let mut mcp_endpoints = Vec::with_capacity(plugins.len());
    let mut validation_paths = Vec::<(usize, PathBuf)>::new();

    for plugin in plugins {
        let installed_revision = installed_revisions
            .get(&installed_revision_key(&plugin.id, plugin.scope))
            .cloned();
        let metadata = source_metadata.get(&plugin.id);
        let declared_revision = metadata.and_then(|value| value.declared_revision.clone());
        let source_pin_status = source_pin_status(metadata, installed_revision.as_deref());
        let mut warnings = Vec::new();
        if source_pin_status == PluginSourcePinStatus::DifferentRevision {
            warnings.push(
                "The marketplace now declares a different revision; review before updating"
                    .to_string(),
            );
        } else if source_pin_status == PluginSourcePinStatus::Unpinned {
            warnings
                .push("The remote plugin source is not pinned to an exact revision".to_string());
        }

        let mut inspection = PluginInspection::default();
        let safe_path = match plugin.install_path.as_deref() {
            Some(raw_path) => match validate_plugin_inspection_path(Path::new(raw_path)) {
                Ok(path) => {
                    match inspect_plugin_root(&path) {
                        Ok(value) => inspection = value,
                        Err(error) => warnings.push(error),
                    }
                    Some(path)
                }
                Err(error) => {
                    warnings.push(error);
                    None
                }
            },
            None => {
                warnings.push("Claude CLI did not report an installed plugin path".to_string());
                None
            }
        };
        warnings.append(&mut inspection.warnings);

        let fingerprint = inspection.fingerprint.as_ref();
        if fingerprint.is_some_and(|value| value.symlink_count > 0) {
            warnings.push("Plugin content contains symbolic links".to_string());
        }
        if fingerprint.is_some_and(|value| value.external_symlink_count > 0) {
            warnings.push(
                "Plugin content contains a symbolic link that resolves outside its install root"
                    .to_string(),
            );
        }

        let diagnostic_index = diagnostics.len();
        if let Some(path) = safe_path {
            if validation_paths.len() < STRICT_VALIDATION_LIMIT {
                validation_paths.push((diagnostic_index, path));
            } else {
                warnings.push(format!(
                    "Strict validation was skipped after the first {STRICT_VALIDATION_LIMIT} installed plugins"
                ));
            }
        }
        mcp_endpoints.push(inspection.mcp_endpoints);
        diagnostics.push(PluginDiagnosticRecord {
            plugin_id: plugin.id,
            plugin_name: plugin.name,
            scope: plugin.scope,
            enabled: plugin.enabled,
            install_path: plugin.install_path,
            manifest_name: inspection.manifest_name,
            validation_status: PluginValidationStatus::Unavailable,
            validation_message: "Strict validation was not run".to_string(),
            signature_status: inspection
                .signature_status
                .unwrap_or(PluginSignatureStatus::NotProvided),
            source_pin_status,
            installed_revision,
            declared_revision,
            content_sha256: fingerprint.map(|value| value.sha256.clone()),
            file_count: fingerprint.map(|value| value.file_count),
            total_bytes: fingerprint.map(|value| value.total_bytes),
            symlink_count: fingerprint.map(|value| value.symlink_count).unwrap_or(0),
            external_symlink_count: fingerprint
                .map(|value| value.external_symlink_count)
                .unwrap_or(0),
            warnings,
            conflict_ids: Vec::new(),
        });
    }

    let validation_cwd = cwd.clone();
    let validation_results = stream::iter(validation_paths.into_iter().map(|(index, path)| {
        let cwd = validation_cwd.clone();
        async move {
            let arguments = vec![
                "plugin".to_string(),
                "validate".to_string(),
                path.to_string_lossy().to_string(),
                "--strict".to_string(),
            ];
            let result =
                run_plugin_cli(cwd.as_deref(), &arguments, STRICT_VALIDATION_TIMEOUT).await;
            (index, result)
        }
    }))
    .buffer_unordered(STRICT_VALIDATION_CONCURRENCY)
    .collect::<Vec<_>>()
    .await;

    for (index, result) in validation_results {
        let Some(diagnostic) = diagnostics.get_mut(index) else {
            continue;
        };
        match result {
            Ok(message) => {
                diagnostic.validation_status = PluginValidationStatus::Passed;
                diagnostic.validation_message = concise_diagnostic_message(&message);
            }
            Err(message) if validation_cli_unavailable(&message) => {
                diagnostic.validation_status = PluginValidationStatus::Unavailable;
                diagnostic.validation_message = concise_diagnostic_message(&message);
                diagnostic
                    .warnings
                    .push("Claude CLI strict validation was unavailable".to_string());
            }
            Err(message) => {
                diagnostic.validation_status = PluginValidationStatus::Failed;
                diagnostic.validation_message = concise_diagnostic_message(&message);
            }
        }
    }

    let conflicts = detect_plugin_conflicts(&mut diagnostics, &mcp_endpoints);
    let validation_passed = diagnostics
        .iter()
        .filter(|plugin| plugin.validation_status == PluginValidationStatus::Passed)
        .count();
    let validation_failed = diagnostics
        .iter()
        .filter(|plugin| plugin.validation_status == PluginValidationStatus::Failed)
        .count();
    let warning_count = diagnostics
        .iter()
        .map(|plugin| plugin.warnings.len())
        .sum::<usize>()
        + conflicts
            .iter()
            .filter(|conflict| conflict.severity == PluginConflictSeverity::Warning)
            .count();

    Ok(PluginDiagnosticsReport {
        generated_at: chrono::Utc::now().to_rfc3339(),
        plugins: diagnostics,
        conflicts,
        validation_passed,
        validation_failed,
        warning_count,
        signature_verification_available: false,
    })
}

#[tauri::command]
pub async fn plugin_details(id: String, cwd: Option<String>) -> Result<String, String> {
    let id = validate_identifier(&id, "Plugin id")?;
    let cwd = validate_cwd(cwd.as_deref())?;
    run_plugin_cli(
        cwd.as_deref(),
        &["plugin".to_string(), "details".to_string(), id],
        LIST_TIMEOUT,
    )
    .await
}

#[tauri::command]
pub async fn install_plugin(
    id: String,
    scope: PluginScope,
    cwd: Option<String>,
) -> Result<Vec<PluginRecord>, String> {
    let id = validate_identifier(&id, "Plugin id")?;
    let cwd = validate_cwd(cwd.as_deref())?;
    validate_scope_cwd(scope, cwd.as_deref())?;
    run_plugin_cli(
        cwd.as_deref(),
        &[
            "plugin".to_string(),
            "install".to_string(),
            id,
            "--scope".to_string(),
            scope.as_cli().to_string(),
        ],
        MUTATION_TIMEOUT,
    )
    .await?;
    list_plugins_inner(cwd.as_deref(), true).await
}

#[tauri::command]
pub async fn set_plugin_enabled(
    id: String,
    enabled: bool,
    scope: PluginScope,
    cwd: Option<String>,
) -> Result<Vec<PluginRecord>, String> {
    let id = validate_identifier(&id, "Plugin id")?;
    let cwd = validate_cwd(cwd.as_deref())?;
    validate_scope_cwd(scope, cwd.as_deref())?;
    run_plugin_cli(
        cwd.as_deref(),
        &[
            "plugin".to_string(),
            if enabled { "enable" } else { "disable" }.to_string(),
            id,
            "--scope".to_string(),
            scope.as_cli().to_string(),
        ],
        MUTATION_TIMEOUT,
    )
    .await?;
    list_plugins_inner(cwd.as_deref(), true).await
}

#[tauri::command]
pub async fn update_plugin(
    id: String,
    scope: PluginScope,
    cwd: Option<String>,
) -> Result<Vec<PluginRecord>, String> {
    let id = validate_identifier(&id, "Plugin id")?;
    let cwd = validate_cwd(cwd.as_deref())?;
    validate_scope_cwd(scope, cwd.as_deref())?;
    run_plugin_cli(
        cwd.as_deref(),
        &[
            "plugin".to_string(),
            "update".to_string(),
            id,
            "--scope".to_string(),
            scope.as_cli().to_string(),
        ],
        MUTATION_TIMEOUT,
    )
    .await?;
    list_plugins_inner(cwd.as_deref(), true).await
}

#[tauri::command]
pub async fn uninstall_plugin(
    id: String,
    scope: PluginScope,
    keep_data: bool,
    cwd: Option<String>,
) -> Result<Vec<PluginRecord>, String> {
    let id = validate_identifier(&id, "Plugin id")?;
    let cwd = validate_cwd(cwd.as_deref())?;
    validate_scope_cwd(scope, cwd.as_deref())?;
    let mut arguments = vec![
        "plugin".to_string(),
        "uninstall".to_string(),
        id,
        "--scope".to_string(),
        scope.as_cli().to_string(),
    ];
    if keep_data {
        arguments.push("--keep-data".to_string());
    }
    run_plugin_cli(cwd.as_deref(), &arguments, MUTATION_TIMEOUT).await?;
    list_plugins_inner(cwd.as_deref(), true).await
}

#[tauri::command]
pub async fn add_plugin_marketplace(
    source: String,
    cwd: Option<String>,
) -> Result<Vec<PluginMarketplaceRecord>, String> {
    let cwd = validate_cwd(cwd.as_deref())?;
    let source = validate_marketplace_source(&source, cwd.as_deref())?;
    run_plugin_cli(
        cwd.as_deref(),
        &[
            "plugin".to_string(),
            "marketplace".to_string(),
            "add".to_string(),
            source,
        ],
        MUTATION_TIMEOUT,
    )
    .await?;
    list_plugin_marketplaces(cwd.map(|path| path.to_string_lossy().to_string())).await
}

#[tauri::command]
pub async fn update_plugin_marketplace(
    name: Option<String>,
    cwd: Option<String>,
) -> Result<Vec<PluginMarketplaceRecord>, String> {
    let cwd = validate_cwd(cwd.as_deref())?;
    let mut arguments = vec![
        "plugin".to_string(),
        "marketplace".to_string(),
        "update".to_string(),
    ];
    if let Some(name) = name {
        arguments.push(validate_identifier(&name, "Marketplace name")?);
    }
    run_plugin_cli(cwd.as_deref(), &arguments, MUTATION_TIMEOUT).await?;
    list_plugin_marketplaces(cwd.map(|path| path.to_string_lossy().to_string())).await
}

#[tauri::command]
pub async fn remove_plugin_marketplace(
    name: String,
    cwd: Option<String>,
) -> Result<Vec<PluginMarketplaceRecord>, String> {
    let name = validate_identifier(&name, "Marketplace name")?;
    let cwd = validate_cwd(cwd.as_deref())?;
    run_plugin_cli(
        cwd.as_deref(),
        &[
            "plugin".to_string(),
            "marketplace".to_string(),
            "remove".to_string(),
            name,
        ],
        MUTATION_TIMEOUT,
    )
    .await?;
    list_plugin_marketplaces(cwd.map(|path| path.to_string_lossy().to_string())).await
}

#[tauri::command]
pub async fn validate_plugin(
    path: String,
    strict: bool,
    cwd: Option<String>,
) -> Result<String, String> {
    let cwd = validate_cwd(cwd.as_deref())?;
    let raw_path = PathBuf::from(path.trim());
    let path = if raw_path.is_absolute() {
        raw_path
    } else {
        cwd.as_deref()
            .ok_or_else(|| {
                "Relative plugin validation paths require a project directory".to_string()
            })?
            .join(raw_path)
    };
    if !path.exists() {
        return Err("Plugin validation path does not exist".to_string());
    }
    let path = canonical_or_original(&path);
    enforce_isolation(&path, "plugin validation path")?;
    let mut arguments = vec![
        "plugin".to_string(),
        "validate".to_string(),
        path.to_string_lossy().to_string(),
    ];
    if strict {
        arguments.push("--strict".to_string());
    }
    run_plugin_cli(cwd.as_deref(), &arguments, LIST_TIMEOUT).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn diagnostic(
        id: &str,
        scope: PluginScope,
        enabled: bool,
        namespace: Option<&str>,
    ) -> PluginDiagnosticRecord {
        PluginDiagnosticRecord {
            plugin_id: id.to_string(),
            plugin_name: id.split('@').next().unwrap_or(id).to_string(),
            scope: Some(scope),
            enabled,
            install_path: None,
            manifest_name: namespace.map(str::to_string),
            validation_status: PluginValidationStatus::Passed,
            validation_message: "ok".to_string(),
            signature_status: PluginSignatureStatus::NotProvided,
            source_pin_status: PluginSourcePinStatus::Unknown,
            installed_revision: None,
            declared_revision: None,
            content_sha256: None,
            file_count: None,
            total_bytes: None,
            symlink_count: 0,
            external_symlink_count: 0,
            warnings: Vec::new(),
            conflict_ids: Vec::new(),
        }
    }

    #[test]
    fn parses_installed_and_available_plugin_inventory() {
        let raw = r#"{
          "installed":[{"id":"formatter@team","version":"1.0.0","scope":"local","enabled":true,"installPath":"/cache/formatter"}],
          "available":[
            {"pluginId":"formatter@team","name":"formatter","description":"Formats code","marketplaceName":"team","version":"1.1.0","source":"./formatter"},
            {"pluginId":"reviewer@team","name":"reviewer","description":"Reviews code","marketplaceName":"team","version":"2.0.0","source":"./reviewer","installCount":42}
          ]
        }"#;
        let records = parse_plugin_list(raw).unwrap();
        assert_eq!(records.len(), 2);
        let formatter = records
            .iter()
            .find(|record| record.name == "formatter")
            .unwrap();
        assert!(formatter.installed);
        assert!(formatter.enabled);
        assert_eq!(formatter.scope, Some(PluginScope::Local));
        assert_eq!(formatter.available_version.as_deref(), Some("1.1.0"));
        assert!(formatter.update_available);
        let reviewer = records
            .iter()
            .find(|record| record.name == "reviewer")
            .unwrap();
        assert!(!reviewer.installed);
        assert!(!reviewer.enabled);
        assert_eq!(reviewer.install_count, Some(42));
    }

    #[test]
    fn enriches_catalog_metadata_from_the_real_marketplace_manifest() {
        let mut records = parse_plugin_list(
            r#"{"installed":[],"available":[{"pluginId":"reviewer@team","name":"reviewer","marketplaceName":"team","description":"CLI description","installCount":42}]}"#,
        )
        .unwrap();
        enrich_plugin_records_from_manifest(
            &mut records,
            "team",
            r#"{"plugins":[{"name":"reviewer","source":{"source":"github","repo":"team/reviewer"},"category":"productivity","tags":["review","quality"],"homepage":"https://example.com/reviewer","repository":{"url":"https://example.com/reviewer.git"},"author":{"name":"Team Tools"},"skills":"./skills","mcpServers":"./.mcp.json","strict":true}]}"#,
        )
        .unwrap();
        let reviewer = &records[0];
        assert_eq!(reviewer.description.as_deref(), Some("CLI description"));
        assert_eq!(reviewer.category.as_deref(), Some("productivity"));
        assert_eq!(reviewer.tags, vec!["review", "quality"]);
        assert_eq!(
            reviewer.homepage.as_deref(),
            Some("https://example.com/reviewer")
        );
        assert_eq!(
            reviewer.repository.as_deref(),
            Some("https://example.com/reviewer.git")
        );
        assert_eq!(reviewer.author_name.as_deref(), Some("Team Tools"));
        assert_eq!(reviewer.install_count, Some(42));
        assert_eq!(reviewer.source.as_deref(), Some("github · team/reviewer"));
        assert_eq!(reviewer.components, vec!["Skills", "MCP"]);
        assert_eq!(reviewer.strict, Some(true));
    }

    #[test]
    fn parses_installed_only_array() {
        let records = parse_plugin_list(
            r#"[{"id":"trace@skills-dir","version":"0.1.0","scope":"user","enabled":false}]"#,
        )
        .unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].marketplace_name.as_deref(), Some("skills-dir"));
        assert!(!records[0].enabled);
    }

    #[test]
    fn preserves_same_plugin_installed_in_multiple_scopes() {
        let mut records = parse_plugin_list(
            r#"{
              "installed":[
                {"id":"trace@team","version":"1.0.0","scope":"user","enabled":true},
                {"id":"trace@team","version":"1.0.0","scope":"project","enabled":true}
              ],
              "available":[{"pluginId":"trace@team","name":"trace","description":"Trace","version":"1.0.0"}]
            }"#,
        )
        .unwrap();
        enrich_plugin_records_from_manifest(
            &mut records,
            "team",
            r#"{"plugins":[{"name":"trace","category":"observability","skills":"./skills"}]}"#,
        )
        .unwrap();
        assert_eq!(records.len(), 2);
        assert_eq!(records[0].scope, Some(PluginScope::Project));
        assert_eq!(records[1].scope, Some(PluginScope::User));
        assert!(records
            .iter()
            .all(|record| record.description.as_deref() == Some("Trace")));
        assert!(records
            .iter()
            .all(|record| record.category.as_deref() == Some("observability")));
    }

    #[test]
    fn fingerprints_content_deterministically_and_detects_external_symlinks() {
        let temp = tempfile::tempdir().unwrap();
        let plugin = temp.path().join("plugin");
        fs::create_dir_all(plugin.join("skills")).unwrap();
        fs::write(plugin.join("skills").join("SKILL.md"), "alpha").unwrap();
        let first = fingerprint_validated_plugin_tree(&plugin).unwrap();
        let again = fingerprint_validated_plugin_tree(&plugin).unwrap();
        assert_eq!(first, again);

        fs::write(plugin.join("skills").join("SKILL.md"), "beta").unwrap();
        let changed = fingerprint_validated_plugin_tree(&plugin).unwrap();
        assert_ne!(first.sha256, changed.sha256);

        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            let outside = temp.path().join("outside.txt");
            fs::write(&outside, "outside").unwrap();
            symlink(&outside, plugin.join("outside-link")).unwrap();
            let linked = fingerprint_validated_plugin_tree(&plugin).unwrap();
            assert_eq!(linked.symlink_count, 1);
            assert_eq!(linked.external_symlink_count, 1);
        }
    }

    #[test]
    fn reports_only_runtime_relevant_plugin_conflicts() {
        let mut diagnostics = vec![
            diagnostic("alpha@team", PluginScope::User, true, Some("shared")),
            diagnostic("beta@team", PluginScope::User, true, Some("shared")),
            diagnostic("trace@team", PluginScope::User, true, Some("trace")),
            diagnostic("trace@team", PluginScope::Project, true, Some("trace")),
            diagnostic("disabled@team", PluginScope::User, false, Some("shared")),
        ];
        let endpoints = vec![
            vec!["endpoint-a".to_string()],
            vec!["endpoint-a".to_string()],
            Vec::new(),
            Vec::new(),
            vec!["endpoint-a".to_string()],
        ];
        let conflicts = detect_plugin_conflicts(&mut diagnostics, &endpoints);
        assert_eq!(
            conflicts
                .iter()
                .filter(|conflict| conflict.kind == PluginConflictKind::NamespaceCollision)
                .count(),
            1
        );
        assert_eq!(
            conflicts
                .iter()
                .filter(|conflict| conflict.kind == PluginConflictKind::DuplicateScope)
                .count(),
            1
        );
        assert_eq!(
            conflicts
                .iter()
                .filter(|conflict| conflict.kind == PluginConflictKind::McpEndpointOverlap)
                .count(),
            1
        );
        assert!(conflicts
            .iter()
            .all(|conflict| !conflict.plugin_ids.contains(&"disabled@team".to_string())));
    }

    #[test]
    fn classifies_source_revision_pins() {
        let pinned = MarketplaceSourceMetadata {
            source_kind: "github".to_string(),
            declared_revision: Some("abc".to_string()),
        };
        assert_eq!(
            source_pin_status(Some(&pinned), Some("abc")),
            PluginSourcePinStatus::Matched
        );
        assert_eq!(
            source_pin_status(Some(&pinned), Some("def")),
            PluginSourcePinStatus::DifferentRevision
        );
        assert_eq!(
            source_pin_status(Some(&pinned), None),
            PluginSourcePinStatus::Unpinned
        );
    }

    #[test]
    fn labels_signature_metadata_without_claiming_verification() {
        assert_eq!(
            manifest_signature_status(None),
            PluginSignatureStatus::NotProvided
        );
        assert_eq!(
            manifest_signature_status(Some(&serde_json::json!({ "name": "plain" }))),
            PluginSignatureStatus::NotProvided
        );
        assert_eq!(
            manifest_signature_status(Some(
                &serde_json::json!({ "name": "signed", "signature": "opaque" })
            )),
            PluginSignatureStatus::Unsupported
        );
    }

    #[test]
    fn parses_marketplaces_without_exposing_unknown_fields() {
        let records = parse_marketplaces(
            r#"[{"name":"official","source":"github","path":"/cache","installLocation":"/cache/install","secret":"ignore"}]"#,
        )
        .unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].name, "official");
        assert_eq!(records[0].source, "github");
    }

    #[test]
    fn managed_scope_is_read_only_and_project_scope_needs_cwd() {
        assert!(PluginScope::Managed.ensure_mutable().is_err());
        assert!(validate_scope_cwd(PluginScope::Project, None).is_err());
        assert!(validate_scope_cwd(PluginScope::Local, None).is_err());
        assert!(validate_scope_cwd(PluginScope::User, None).is_ok());
    }

    #[test]
    fn identifiers_reject_empty_and_control_characters() {
        assert!(validate_identifier("", "Plugin id").is_err());
        assert!(validate_identifier("bad\nplugin", "Plugin id").is_err());
        assert_eq!(
            validate_identifier("formatter@team", "Plugin id").unwrap(),
            "formatter@team"
        );
    }
}
