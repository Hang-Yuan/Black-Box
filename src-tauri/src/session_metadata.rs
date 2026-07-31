use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

const AUTHORITY_VERSION: u32 = 3;
const PORTABLE_BUNDLE_FORMAT: &str = "blackbox-session-organization";
const PORTABLE_BUNDLE_VERSION: u32 = 1;
const MAX_METADATA_BYTES: u64 = 16 * 1024 * 1024;
const AUTHORITY_FILENAME: &str = "session_metadata.json";
// Compatibility-only identifiers stay encoded until runtime. This preserves
// read-only import from the retired client's on-disk schema without embedding
// its former product name in current Black Box source or release binaries.
const RETIRED_CLIENT_DIR_ENCODED: &[u8] = &[137, 211, 200, 204, 194, 201, 206, 196, 200, 195, 194];
const RETIRED_NAMES_FILE_ENCODED: &[u8] = &[
    211, 200, 204, 194, 201, 206, 196, 200, 195, 194, 248, 212, 194, 212, 212, 206, 200, 201, 248,
    201, 198, 202, 194, 212, 137, 205, 212, 200, 201,
];

static AUTHORITY_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn authority_lock() -> &'static Mutex<()> {
    AUTHORITY_LOCK.get_or_init(|| Mutex::new(()))
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionGroupMetadata {
    id: String,
    label: String,
    workspace: String,
    #[serde(default)]
    session_ids: Vec<String>,
    #[serde(default)]
    pinned_in_group: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
struct GroupSessionRef {
    group_id: String,
    session_id: String,
}

impl GroupSessionRef {
    fn new(group_id: impl Into<String>, session_id: impl Into<String>) -> Self {
        Self {
            group_id: group_id.into(),
            session_id: session_id.into(),
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionMetadataTombstones {
    /// A conversation removed from Black Box must stay detached even if an
    /// old legacy ledger or a restored stale backup mentions it again. The
    /// private Black Box JSONL remains on disk for local recovery/export.
    #[serde(default)]
    deleted_session_ids: BTreeSet<String>,
    /// Deleted task groups are not recreated by later incremental imports.
    #[serde(default)]
    deleted_group_ids: BTreeSet<String>,
    /// Explicit global unpin/unarchive actions beat legacy positive-only lists.
    #[serde(default)]
    unpinned_session_ids: BTreeSet<String>,
    #[serde(default)]
    unarchived_session_ids: BTreeSet<String>,
    /// Clearing a custom title is an explicit local choice and must not be
    /// undone by importing an older organization bundle.
    #[serde(default)]
    cleared_custom_preview_ids: BTreeSet<String>,
    /// Removing a session from a group, or removing its in-group pin, is also
    /// durable. These pair tombstones allow other new members of the same
    /// legacy group to continue importing later.
    #[serde(default)]
    removed_group_memberships: BTreeSet<GroupSessionRef>,
    #[serde(default)]
    unpinned_in_groups: BTreeSet<GroupSessionRef>,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionMetadataImports {
    /// SHA-256 fingerprints of the immutable legacy-client ledgers plus the set of
    /// eligible top-level JSONLs. Stored in the authority so backup/restore
    /// keeps incremental-import state with the metadata it protects.
    #[serde(default)]
    legacy_client_fingerprints: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConversationRuntimePreference {
    /// `None` means the conversation explicitly uses the native Claude login.
    provider_id: Option<String>,
    /// Stable logical tier; provider-specific model IDs remain in providers.json.
    selected_model: String,
    /// Native-only exact model override from ANTHROPIC_CUSTOM_MODEL_OPTION.
    #[serde(default)]
    custom_model_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionMetadataAuthority {
    version: u32,
    #[serde(default)]
    revision: u64,
    #[serde(default)]
    groups: Vec<SessionGroupMetadata>,
    #[serde(default)]
    pinned_session_ids: BTreeSet<String>,
    #[serde(default)]
    archived_session_ids: BTreeSet<String>,
    /// User-defined conversation titles belong to the same durable authority
    /// as groups, pins, and archive state. Keeping them together makes backup
    /// and cross-computer restore transactional instead of best-effort.
    #[serde(default)]
    custom_previews: BTreeMap<String, String>,
    /// Last explicitly selected provider/key route and main model for each
    /// conversation. Credentials stay exclusively in providers.json.
    #[serde(default)]
    conversation_runtime_preferences: BTreeMap<String, ConversationRuntimePreference>,
    #[serde(default)]
    tombstones: SessionMetadataTombstones,
    #[serde(default)]
    imports: SessionMetadataImports,
}

impl Default for SessionMetadataAuthority {
    fn default() -> Self {
        Self {
            version: AUTHORITY_VERSION,
            revision: 0,
            groups: Vec::new(),
            pinned_session_ids: BTreeSet::new(),
            archived_session_ids: BTreeSet::new(),
            custom_previews: BTreeMap::new(),
            conversation_runtime_preferences: BTreeMap::new(),
            tombstones: SessionMetadataTombstones::default(),
            imports: SessionMetadataImports::default(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct PortableSessionOrganization {
    format: String,
    format_version: u32,
    exported_at: String,
    #[serde(default)]
    groups: Vec<SessionGroupMetadata>,
    #[serde(default)]
    pinned_session_ids: BTreeSet<String>,
    #[serde(default)]
    archived_session_ids: BTreeSet<String>,
    #[serde(default)]
    custom_previews: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionOrganizationReport {
    format_version: u32,
    groups: usize,
    group_members: usize,
    group_pins: usize,
    pinned: usize,
    archived: usize,
    custom_names: usize,
    referenced_sessions: usize,
    available_sessions: usize,
    unavailable_sessions: usize,
    added_groups: usize,
    added_group_members: usize,
    added_group_pins: usize,
    added_pinned: usize,
    added_archived: usize,
    added_custom_names: usize,
    skipped_conflicts: usize,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct SessionOrganizationMergeStats {
    added_groups: usize,
    added_group_members: usize,
    added_group_pins: usize,
    added_pinned: usize,
    added_archived: usize,
    added_custom_names: usize,
    skipped_conflicts: usize,
}

impl SessionOrganizationMergeStats {
    fn has_changes(&self) -> bool {
        self.added_groups > 0
            || self.added_group_members > 0
            || self.added_group_pins > 0
            || self.added_pinned > 0
            || self.added_archived > 0
            || self.added_custom_names > 0
    }
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LegacySessionImportReport {
    source_found: bool,
    fingerprint_changed: bool,
    candidates: usize,
    imported_sessions: usize,
    imported_names: usize,
    imported_groups: usize,
    imported_group_members: usize,
    imported_pins: usize,
    imported_archived: usize,
}

fn blackbox_dir(home: &Path) -> PathBuf {
    home.join(".blackbox")
}

fn decode_retired_identifier(encoded: &[u8]) -> String {
    // Prevent release optimization from folding the decoded compatibility
    // identifier back into one static string in the executable.
    let mask = std::hint::black_box(0xA7_u8);
    encoded
        .iter()
        .map(|value| char::from(*value ^ mask))
        .collect()
}

fn legacy_client_dir(home: &Path) -> PathBuf {
    home.join(decode_retired_identifier(RETIRED_CLIENT_DIR_ENCODED))
}

fn legacy_names_path(home: &Path) -> PathBuf {
    home.join(".claude")
        .join(decode_retired_identifier(RETIRED_NAMES_FILE_ENCODED))
}

fn blackbox_names_path(home: &Path) -> PathBuf {
    // `_in(home)` helpers are also used by portable-import and isolation
    // tests. Only consult the process-wide override for the actual runtime
    // home; synthetic homes must remain fully self-contained.
    let root = if dirs::home_dir().as_deref() == Some(home) {
        crate::client_runtime::claude_config_dir()
            .unwrap_or_else(|_| home.join(".blackbox").join("claude"))
    } else {
        home.join(".blackbox").join("claude")
    };
    root.join("blackbox_session_names.json")
}

fn authority_path(home: &Path) -> PathBuf {
    blackbox_dir(home).join(AUTHORITY_FILENAME)
}

fn current_home() -> Result<PathBuf, String> {
    dirs::home_dir().ok_or_else(|| "Cannot find home dir".to_string())
}

fn read_optional_bytes(path: &Path, label: &str) -> Result<Option<Vec<u8>>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let metadata = std::fs::metadata(path)
        .map_err(|error| format!("Failed to inspect {label} at {}: {error}", path.display()))?;
    if !metadata.is_file() {
        return Err(format!(
            "{label} at {} is not a regular file",
            path.display()
        ));
    }
    if metadata.len() > MAX_METADATA_BYTES {
        return Err(format!(
            "{label} at {} exceeds the {} MiB safety limit",
            path.display(),
            MAX_METADATA_BYTES / 1024 / 1024
        ));
    }
    std::fs::read(path)
        .map(Some)
        .map_err(|error| format!("Failed to read {label} at {}: {error}", path.display()))
}

fn parse_json_bytes<T>(bytes: Option<&[u8]>, label: &str) -> Result<T, String>
where
    T: serde::de::DeserializeOwned + Default,
{
    let Some(bytes) = bytes else {
        return Ok(T::default());
    };
    serde_json::from_slice(bytes).map_err(|error| format!("Failed to parse {label}: {error}"))
}

fn parse_string_set(value: Value, label: &str) -> Result<BTreeSet<String>, String> {
    let values: Vec<String> =
        serde_json::from_value(value).map_err(|error| format!("Invalid {label}: {error}"))?;
    Ok(values
        .into_iter()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .collect())
}

fn atomic_write_bytes(path: &Path, content: &[u8], label: &str) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("{label} path has no parent directory"))?;
    std::fs::create_dir_all(parent)
        .map_err(|error| format!("Failed to create {label} directory: {error}"))?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)
        .map_err(|error| format!("Failed to create temporary {label} file: {error}"))?;
    temporary
        .write_all(content)
        .map_err(|error| format!("Failed to write temporary {label} file: {error}"))?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|error| format!("Failed to sync temporary {label} file: {error}"))?;
    temporary
        .persist(path)
        .map_err(|error| format!("Failed to atomically replace {label} file: {}", error.error))?;
    // Persist the directory entry as well as the file contents on platforms
    // that support syncing directories.
    if let Ok(directory) = std::fs::File::open(parent) {
        let _ = directory.sync_all();
    }
    Ok(())
}

fn normalize_groups(groups: Vec<SessionGroupMetadata>) -> Vec<SessionGroupMetadata> {
    let mut seen_groups = HashSet::new();
    let mut assigned_sessions = HashSet::new();
    let mut normalized = Vec::new();

    for mut group in groups {
        group.id = group.id.trim().to_string();
        group.label = group.label.trim().to_string();
        group.workspace = group.workspace.trim().to_string();
        if group.id.is_empty()
            || group.label.is_empty()
            || group.workspace.is_empty()
            || !seen_groups.insert(group.id.clone())
        {
            continue;
        }

        let mut seen_members = HashSet::new();
        group.session_ids.retain(|session_id| {
            let valid = !session_id.trim().is_empty()
                && seen_members.insert(session_id.clone())
                && assigned_sessions.insert(session_id.clone());
            valid
        });
        let members: HashSet<&str> = group.session_ids.iter().map(String::as_str).collect();
        let mut seen_pins = HashSet::new();
        group.pinned_in_group.retain(|session_id| {
            members.contains(session_id.as_str()) && seen_pins.insert(session_id.clone())
        });
        normalized.push(group);
    }
    normalized
}

fn normalize_conversation_runtime_preferences(
    preferences: BTreeMap<String, ConversationRuntimePreference>,
) -> BTreeMap<String, ConversationRuntimePreference> {
    preferences
        .into_iter()
        .filter_map(|(session_id, mut preference)| {
            let session_id = session_id.trim().to_string();
            if session_id.is_empty()
                || session_id.starts_with("draft_")
                || session_id.starts_with("desk_")
            {
                return None;
            }

            preference.selected_model = preference.selected_model.trim().to_lowercase();
            if !matches!(
                preference.selected_model.as_str(),
                "fable" | "opus" | "sonnet" | "haiku"
            ) {
                return None;
            }

            preference.provider_id = preference.provider_id.and_then(|provider_id| {
                let provider_id = provider_id.trim().to_string();
                (!provider_id.is_empty() && provider_id.len() <= 256).then_some(provider_id)
            });
            preference.custom_model_id = preference.custom_model_id.and_then(|custom_model_id| {
                let custom_model_id = custom_model_id.trim().to_string();
                (!custom_model_id.is_empty() && custom_model_id.len() <= 256)
                    .then_some(custom_model_id)
            });
            Some((session_id, preference))
        })
        .collect()
}

fn normalize_authority(
    mut authority: SessionMetadataAuthority,
) -> Result<SessionMetadataAuthority, String> {
    if matches!(authority.version, 1 | 2) {
        authority.version = AUTHORITY_VERSION;
    } else if authority.version != AUTHORITY_VERSION {
        return Err(format!(
            "Unsupported Black Box session metadata version {} (supported: 1-{})",
            authority.version, AUTHORITY_VERSION,
        ));
    }
    authority.groups = normalize_groups(authority.groups);
    authority.custom_previews = authority
        .custom_previews
        .into_iter()
        .filter_map(|(session_id, label)| {
            let session_id = session_id.trim().to_string();
            let label = label.trim().to_string();
            (!session_id.is_empty() && !session_id.starts_with("draft_") && !label.is_empty())
                .then_some((session_id, label))
        })
        .collect();
    authority.conversation_runtime_preferences =
        normalize_conversation_runtime_preferences(authority.conversation_runtime_preferences);
    for deleted in authority.tombstones.deleted_session_ids.clone() {
        authority.pinned_session_ids.remove(&deleted);
        authority.archived_session_ids.remove(&deleted);
        authority.custom_previews.remove(&deleted);
        authority.conversation_runtime_preferences.remove(&deleted);
        for group in &mut authority.groups {
            group
                .session_ids
                .retain(|session_id| session_id != &deleted);
            group
                .pinned_in_group
                .retain(|session_id| session_id != &deleted);
        }
    }
    authority
        .groups
        .retain(|group| !authority.tombstones.deleted_group_ids.contains(&group.id));
    Ok(authority)
}

fn read_authority_unlocked(home: &Path) -> Result<SessionMetadataAuthority, String> {
    let path = authority_path(home);
    if let Some(bytes) = read_optional_bytes(&path, "Black Box session metadata")? {
        let authority: SessionMetadataAuthority = serde_json::from_slice(&bytes)
            .map_err(|error| format!("Failed to parse Black Box session metadata: {error}"))?;
        let needs_legacy_names_migration = authority.version == 1;
        let needs_authority_migration = authority.version < AUTHORITY_VERSION;
        let mut authority = normalize_authority(authority)?;
        if needs_authority_migration {
            if needs_legacy_names_migration {
                let names_bytes = read_optional_bytes(
                    &blackbox_names_path(home),
                    "legacy Black Box session names",
                )?;
                let names: BTreeMap<String, String> =
                    parse_json_bytes(names_bytes.as_deref(), "legacy Black Box session names")?;
                for (session_id, label) in names {
                    authority.custom_previews.entry(session_id).or_insert(label);
                }
            }
            authority.revision = authority.revision.saturating_add(1);
            write_authority_unlocked(home, &authority)?;
        }
        return Ok(authority);
    }

    // One-time consolidation of the three pre-authority Black Box ledgers.
    // They remain untouched as recovery evidence; all future writes target the
    // single authority document below.
    let groups_path = blackbox_dir(home).join("groups.json");
    let pinned_path = blackbox_dir(home).join("pinned.json");
    let archived_path = blackbox_dir(home).join("archived.json");
    let groups_bytes = read_optional_bytes(&groups_path, "legacy Black Box groups")?;
    let pinned_bytes = read_optional_bytes(&pinned_path, "legacy Black Box pins")?;
    let archived_bytes = read_optional_bytes(&archived_path, "legacy Black Box archive")?;
    let names_bytes =
        read_optional_bytes(&blackbox_names_path(home), "legacy Black Box session names")?;
    let source_found = groups_bytes.is_some()
        || pinned_bytes.is_some()
        || archived_bytes.is_some()
        || names_bytes.is_some();

    let mut authority = SessionMetadataAuthority {
        groups: parse_json_bytes(groups_bytes.as_deref(), "legacy Black Box groups")?,
        pinned_session_ids: parse_json_bytes(pinned_bytes.as_deref(), "legacy Black Box pins")?,
        archived_session_ids: parse_json_bytes(
            archived_bytes.as_deref(),
            "legacy Black Box archive",
        )?,
        custom_previews: parse_json_bytes(
            names_bytes.as_deref(),
            "legacy Black Box session names",
        )?,
        ..SessionMetadataAuthority::default()
    };
    authority = normalize_authority(authority)?;
    if source_found {
        authority.revision = 1;
        write_authority_unlocked(home, &authority)?;
    }
    Ok(authority)
}

fn write_authority_unlocked(
    home: &Path,
    authority: &SessionMetadataAuthority,
) -> Result<(), String> {
    let authority = normalize_authority(authority.clone())?;
    let encoded = serde_json::to_vec_pretty(&authority)
        .map_err(|error| format!("Failed to serialize Black Box session metadata: {error}"))?;
    if encoded.len() as u64 > MAX_METADATA_BYTES {
        return Err(format!(
            "Black Box session metadata exceeds the {} MiB safety limit",
            MAX_METADATA_BYTES / 1024 / 1024
        ));
    }
    atomic_write_bytes(
        &authority_path(home),
        &encoded,
        "Black Box session metadata",
    )
}

fn persist_authority_unlocked(
    home: &Path,
    authority: &mut SessionMetadataAuthority,
) -> Result<(), String> {
    authority.version = AUTHORITY_VERSION;
    authority.revision = authority.revision.saturating_add(1);
    write_authority_unlocked(home, authority)
}

fn with_authority_lock<T>(operation: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    let _guard = authority_lock()
        .lock()
        .map_err(|_| "Black Box session metadata lock was poisoned".to_string())?;
    operation()
}

fn load_pinned_sessions_in(home: &Path) -> Result<Value, String> {
    with_authority_lock(|| {
        let authority = read_authority_unlocked(home)?;
        serde_json::to_value(authority.pinned_session_ids)
            .map_err(|error| format!("Failed to encode pinned sessions: {error}"))
    })
}

fn save_pinned_sessions_in(home: &Path, data: Value) -> Result<(), String> {
    let next = parse_string_set(data, "pinned sessions")?;
    with_authority_lock(|| {
        let mut authority = read_authority_unlocked(home)?;
        for removed in authority.pinned_session_ids.difference(&next) {
            authority
                .tombstones
                .unpinned_session_ids
                .insert(removed.clone());
        }
        for added in &next {
            authority.tombstones.unpinned_session_ids.remove(added);
        }
        authority.pinned_session_ids = next;
        persist_authority_unlocked(home, &mut authority)
    })
}

fn load_archived_sessions_in(home: &Path) -> Result<Value, String> {
    with_authority_lock(|| {
        let authority = read_authority_unlocked(home)?;
        serde_json::to_value(authority.archived_session_ids)
            .map_err(|error| format!("Failed to encode archived sessions: {error}"))
    })
}

fn save_archived_sessions_in(home: &Path, data: Value) -> Result<(), String> {
    let next = parse_string_set(data, "archived sessions")?;
    with_authority_lock(|| {
        let mut authority = read_authority_unlocked(home)?;
        for removed in authority.archived_session_ids.difference(&next) {
            authority
                .tombstones
                .unarchived_session_ids
                .insert(removed.clone());
        }
        for added in &next {
            authority.tombstones.unarchived_session_ids.remove(added);
        }
        authority.archived_session_ids = next;
        persist_authority_unlocked(home, &mut authority)
    })
}

fn load_session_groups_in(home: &Path) -> Result<Value, String> {
    with_authority_lock(|| {
        let authority = read_authority_unlocked(home)?;
        serde_json::to_value(authority.groups)
            .map_err(|error| format!("Failed to encode session groups: {error}"))
    })
}

fn save_session_groups_in(home: &Path, data: Value) -> Result<(), String> {
    let next: Vec<SessionGroupMetadata> =
        serde_json::from_value(data).map_err(|error| format!("Invalid session groups: {error}"))?;
    let next = normalize_groups(next);
    with_authority_lock(|| {
        let mut authority = read_authority_unlocked(home)?;
        let next_by_id: HashMap<String, SessionGroupMetadata> = next
            .iter()
            .cloned()
            .map(|group| (group.id.clone(), group))
            .collect();

        for old_group in &authority.groups {
            if !next_by_id.contains_key(&old_group.id) {
                authority
                    .tombstones
                    .deleted_group_ids
                    .insert(old_group.id.clone());
            }
            let next_group = next_by_id.get(&old_group.id);
            for session_id in &old_group.session_ids {
                if !next_group.is_some_and(|group| group.session_ids.contains(session_id)) {
                    authority
                        .tombstones
                        .removed_group_memberships
                        .insert(GroupSessionRef::new(&old_group.id, session_id));
                }
            }
            for session_id in &old_group.pinned_in_group {
                if !next_group.is_some_and(|group| group.pinned_in_group.contains(session_id)) {
                    authority
                        .tombstones
                        .unpinned_in_groups
                        .insert(GroupSessionRef::new(&old_group.id, session_id));
                }
            }
        }

        for next_group in &next {
            authority
                .tombstones
                .deleted_group_ids
                .remove(&next_group.id);
            for session_id in &next_group.session_ids {
                authority
                    .tombstones
                    .removed_group_memberships
                    .remove(&GroupSessionRef::new(&next_group.id, session_id));
            }
            for session_id in &next_group.pinned_in_group {
                authority
                    .tombstones
                    .unpinned_in_groups
                    .remove(&GroupSessionRef::new(&next_group.id, session_id));
            }
        }

        authority.groups = next;
        persist_authority_unlocked(home, &mut authority)
    })
}

fn load_custom_previews_in(home: &Path) -> Result<Value, String> {
    with_authority_lock(|| {
        let authority = read_authority_unlocked(home)?;
        serde_json::to_value(authority.custom_previews)
            .map_err(|error| format!("Failed to encode custom session names: {error}"))
    })
}

fn save_custom_previews_in(home: &Path, data: Value) -> Result<(), String> {
    let next: BTreeMap<String, String> = serde_json::from_value(data)
        .map_err(|error| format!("Invalid custom session names: {error}"))?;
    let next: BTreeMap<String, String> = next
        .into_iter()
        .filter_map(|(session_id, label)| {
            let session_id = session_id.trim().to_string();
            let label = label.trim().to_string();
            (!session_id.is_empty() && !session_id.starts_with("draft_") && !label.is_empty())
                .then_some((session_id, label))
        })
        .collect();
    with_authority_lock(|| {
        let mut authority = read_authority_unlocked(home)?;
        for removed in authority.custom_previews.keys() {
            if !next.contains_key(removed) {
                authority
                    .tombstones
                    .cleared_custom_preview_ids
                    .insert(removed.clone());
            }
        }
        for added in next.keys() {
            authority
                .tombstones
                .cleared_custom_preview_ids
                .remove(added);
        }
        authority.custom_previews = next;
        persist_authority_unlocked(home, &mut authority)
    })
}

fn load_conversation_runtime_preferences_in(home: &Path) -> Result<Value, String> {
    with_authority_lock(|| {
        let authority = read_authority_unlocked(home)?;
        serde_json::to_value(authority.conversation_runtime_preferences)
            .map_err(|error| format!("Failed to encode conversation runtime preferences: {error}"))
    })
}

fn save_conversation_runtime_preferences_in(home: &Path, data: Value) -> Result<(), String> {
    let next: BTreeMap<String, ConversationRuntimePreference> = serde_json::from_value(data)
        .map_err(|error| format!("Invalid conversation runtime preferences: {error}"))?;
    let next = normalize_conversation_runtime_preferences(next);
    with_authority_lock(|| {
        let mut authority = read_authority_unlocked(home)?;
        authority.conversation_runtime_preferences = next;
        persist_authority_unlocked(home, &mut authority)
    })
}

pub(crate) fn tombstone_deleted_session_in(home: &Path, session_id: &str) -> Result<(), String> {
    let session_id = session_id.trim();
    if session_id.is_empty() || session_id.starts_with("draft_") {
        return Ok(());
    }
    with_authority_lock(|| {
        let mut authority = read_authority_unlocked(home)?;
        authority
            .tombstones
            .deleted_session_ids
            .insert(session_id.to_string());
        authority.pinned_session_ids.remove(session_id);
        authority.archived_session_ids.remove(session_id);
        authority.custom_previews.remove(session_id);
        authority
            .conversation_runtime_preferences
            .remove(session_id);
        authority
            .tombstones
            .cleared_custom_preview_ids
            .insert(session_id.to_string());
        for group in &mut authority.groups {
            group
                .session_ids
                .retain(|candidate| candidate != session_id);
            group
                .pinned_in_group
                .retain(|candidate| candidate != session_id);
        }
        persist_authority_unlocked(home, &mut authority)
    })
}

pub(crate) fn deleted_session_ids_in(home: &Path) -> Result<BTreeSet<String>, String> {
    with_authority_lock(|| {
        Ok(read_authority_unlocked(home)?
            .tombstones
            .deleted_session_ids)
    })
}

/// Return only session IDs that Black Box has explicitly organized.
///
/// This is a fail-closed recovery path for a missing tracking ledger. It must
/// never infer ownership by scanning the legacy host `~/.claude/projects` store.
pub(crate) fn recoverable_session_ids_in(home: &Path) -> Result<BTreeSet<String>, String> {
    with_authority_lock(|| {
        let authority = read_authority_unlocked(home)?;
        let deleted = authority.tombstones.deleted_session_ids.clone();
        let mut referenced = authority.pinned_session_ids.clone();
        referenced.extend(authority.archived_session_ids.iter().cloned());
        referenced.extend(authority.custom_previews.keys().cloned());
        referenced.extend(authority.conversation_runtime_preferences.keys().cloned());
        for group in &authority.groups {
            referenced.extend(group.session_ids.iter().cloned());
            referenced.extend(group.pinned_in_group.iter().cloned());
        }
        referenced.retain(|session_id| {
            !session_id.trim().is_empty()
                && !session_id.starts_with("desk_")
                && !deleted.contains(session_id)
        });
        Ok(referenced)
    })
}

pub(crate) fn load_pinned_sessions() -> Result<Value, String> {
    load_pinned_sessions_in(&current_home()?)
}

pub(crate) fn save_pinned_sessions(data: Value) -> Result<(), String> {
    save_pinned_sessions_in(&current_home()?, data)
}

pub(crate) fn load_archived_sessions() -> Result<Value, String> {
    load_archived_sessions_in(&current_home()?)
}

pub(crate) fn save_archived_sessions(data: Value) -> Result<(), String> {
    save_archived_sessions_in(&current_home()?, data)
}

pub(crate) fn load_session_groups() -> Result<Value, String> {
    load_session_groups_in(&current_home()?)
}

pub(crate) fn load_custom_previews() -> Result<Value, String> {
    load_custom_previews_in(&current_home()?)
}

pub(crate) fn save_custom_previews(data: Value) -> Result<(), String> {
    save_custom_previews_in(&current_home()?, data)
}

pub(crate) fn load_conversation_runtime_preferences() -> Result<Value, String> {
    load_conversation_runtime_preferences_in(&current_home()?)
}

pub(crate) fn save_conversation_runtime_preferences(data: Value) -> Result<(), String> {
    save_conversation_runtime_preferences_in(&current_home()?, data)
}

pub(crate) fn save_session_groups(data: Value) -> Result<(), String> {
    save_session_groups_in(&current_home()?, data)
}

pub(crate) fn deleted_session_ids() -> Result<BTreeSet<String>, String> {
    deleted_session_ids_in(&current_home()?)
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn insert_fingerprint(
    fingerprints: &mut BTreeMap<String, String>,
    key: &str,
    bytes: Option<&[u8]>,
) {
    if let Some(bytes) = bytes {
        fingerprints.insert(key.to_string(), sha256_hex(bytes));
    }
}

fn read_session_id_lines(bytes: Option<&[u8]>) -> BTreeSet<String> {
    let Some(bytes) = bytes else {
        return BTreeSet::new();
    };
    String::from_utf8_lossy(bytes)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with("desk_"))
        .map(ToString::to_string)
        .collect()
}

fn discover_top_level_session_ids(projects_dir: &Path) -> HashSet<String> {
    let mut ids = HashSet::new();
    let Ok(projects) = std::fs::read_dir(projects_dir) else {
        return ids;
    };
    for project in projects.flatten().filter(|entry| entry.path().is_dir()) {
        let Ok(files) = std::fs::read_dir(project.path()) else {
            continue;
        };
        for file in files.flatten() {
            let path = file.path();
            if path
                .extension()
                .is_some_and(|extension| extension == "jsonl")
            {
                if let Some(stem) = path.file_stem().and_then(|stem| stem.to_str()) {
                    ids.insert(stem.to_string());
                }
            }
        }
    }
    ids
}

fn normalize_portable_bundle(
    mut bundle: PortableSessionOrganization,
) -> Result<PortableSessionOrganization, String> {
    if bundle.format != PORTABLE_BUNDLE_FORMAT {
        return Err(format!(
            "Unsupported session organization file format '{}'; expected '{}'",
            bundle.format, PORTABLE_BUNDLE_FORMAT
        ));
    }
    if bundle.format_version != PORTABLE_BUNDLE_VERSION {
        return Err(format!(
            "Unsupported session organization file version {} (expected {})",
            bundle.format_version, PORTABLE_BUNDLE_VERSION
        ));
    }
    bundle.groups = normalize_groups(bundle.groups);
    bundle.pinned_session_ids = bundle
        .pinned_session_ids
        .into_iter()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty() && !value.starts_with("draft_"))
        .collect();
    bundle.archived_session_ids = bundle
        .archived_session_ids
        .into_iter()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty() && !value.starts_with("draft_"))
        .collect();
    bundle.custom_previews = bundle
        .custom_previews
        .into_iter()
        .filter_map(|(session_id, label)| {
            let session_id = session_id.trim().to_string();
            let label = label.trim().to_string();
            (!session_id.is_empty() && !session_id.starts_with("draft_") && !label.is_empty())
                .then_some((session_id, label))
        })
        .collect();
    Ok(bundle)
}

fn read_portable_bundle(path: &Path) -> Result<PortableSessionOrganization, String> {
    let bytes =
        read_optional_bytes(path, "Black Box session organization file")?.ok_or_else(|| {
            format!(
                "Session organization file does not exist: {}",
                path.display()
            )
        })?;
    let bundle: PortableSessionOrganization = serde_json::from_slice(&bytes)
        .map_err(|error| format!("Failed to parse session organization file: {error}"))?;
    normalize_portable_bundle(bundle)
}

fn portable_bundle_from_authority(
    authority: &SessionMetadataAuthority,
) -> PortableSessionOrganization {
    PortableSessionOrganization {
        format: PORTABLE_BUNDLE_FORMAT.to_string(),
        format_version: PORTABLE_BUNDLE_VERSION,
        exported_at: chrono::Utc::now().to_rfc3339(),
        groups: authority.groups.clone(),
        pinned_session_ids: authority.pinned_session_ids.clone(),
        archived_session_ids: authority.archived_session_ids.clone(),
        custom_previews: authority.custom_previews.clone(),
    }
}

fn referenced_session_ids(bundle: &PortableSessionOrganization) -> BTreeSet<String> {
    let mut referenced = BTreeSet::new();
    referenced.extend(bundle.pinned_session_ids.iter().cloned());
    referenced.extend(bundle.archived_session_ids.iter().cloned());
    referenced.extend(bundle.custom_previews.keys().cloned());
    for group in &bundle.groups {
        referenced.extend(group.session_ids.iter().cloned());
        referenced.extend(group.pinned_in_group.iter().cloned());
    }
    referenced
}

fn merge_portable_bundle(
    authority: &mut SessionMetadataAuthority,
    bundle: &PortableSessionOrganization,
) -> SessionOrganizationMergeStats {
    let mut stats = SessionOrganizationMergeStats::default();
    let mut membership: HashMap<String, String> = authority
        .groups
        .iter()
        .flat_map(|group| {
            group
                .session_ids
                .iter()
                .cloned()
                .map(move |session_id| (session_id, group.id.clone()))
        })
        .collect();

    for incoming in &bundle.groups {
        if authority
            .tombstones
            .deleted_group_ids
            .contains(&incoming.id)
        {
            stats.skipped_conflicts += 1;
            continue;
        }

        let existing_index = authority
            .groups
            .iter()
            .position(|group| group.id == incoming.id)
            .or_else(|| {
                authority.groups.iter().position(|group| {
                    group.workspace == incoming.workspace && group.label == incoming.label
                })
            });
        let target_index = if let Some(index) = existing_index {
            index
        } else {
            authority.groups.push(SessionGroupMetadata {
                id: incoming.id.clone(),
                label: incoming.label.clone(),
                workspace: incoming.workspace.clone(),
                session_ids: Vec::new(),
                pinned_in_group: Vec::new(),
            });
            stats.added_groups += 1;
            authority.groups.len() - 1
        };
        let target_id = authority.groups[target_index].id.clone();

        for session_id in &incoming.session_ids {
            let pair = GroupSessionRef::new(&target_id, session_id);
            let blocked = authority
                .tombstones
                .deleted_session_ids
                .contains(session_id)
                || authority
                    .tombstones
                    .removed_group_memberships
                    .contains(&pair);
            if blocked {
                stats.skipped_conflicts += 1;
                continue;
            }
            if let Some(existing_group) = membership.get(session_id) {
                if existing_group != &target_id {
                    stats.skipped_conflicts += 1;
                }
                continue;
            }
            authority.groups[target_index]
                .session_ids
                .push(session_id.clone());
            membership.insert(session_id.clone(), target_id.clone());
            stats.added_group_members += 1;
        }

        for session_id in &incoming.pinned_in_group {
            let pair = GroupSessionRef::new(&target_id, session_id);
            if authority.groups[target_index]
                .session_ids
                .contains(session_id)
                && !authority.groups[target_index]
                    .pinned_in_group
                    .contains(session_id)
                && !authority.tombstones.unpinned_in_groups.contains(&pair)
                && !authority
                    .tombstones
                    .deleted_session_ids
                    .contains(session_id)
            {
                authority.groups[target_index]
                    .pinned_in_group
                    .push(session_id.clone());
                stats.added_group_pins += 1;
            }
        }
    }

    for session_id in &bundle.pinned_session_ids {
        if authority
            .tombstones
            .deleted_session_ids
            .contains(session_id)
            || authority
                .tombstones
                .unpinned_session_ids
                .contains(session_id)
        {
            stats.skipped_conflicts += 1;
        } else if authority.pinned_session_ids.insert(session_id.clone()) {
            stats.added_pinned += 1;
        }
    }
    for session_id in &bundle.archived_session_ids {
        if authority
            .tombstones
            .deleted_session_ids
            .contains(session_id)
            || authority
                .tombstones
                .unarchived_session_ids
                .contains(session_id)
        {
            stats.skipped_conflicts += 1;
        } else if authority.archived_session_ids.insert(session_id.clone()) {
            stats.added_archived += 1;
        }
    }
    for (session_id, label) in &bundle.custom_previews {
        if authority
            .tombstones
            .deleted_session_ids
            .contains(session_id)
            || authority
                .tombstones
                .cleared_custom_preview_ids
                .contains(session_id)
        {
            stats.skipped_conflicts += 1;
        } else if !authority.custom_previews.contains_key(session_id) {
            authority
                .custom_previews
                .insert(session_id.clone(), label.clone());
            stats.added_custom_names += 1;
        }
    }
    stats
}

fn organization_report(
    home: &Path,
    bundle: &PortableSessionOrganization,
    stats: SessionOrganizationMergeStats,
) -> SessionOrganizationReport {
    let referenced = referenced_session_ids(bundle);
    let available = discover_top_level_session_ids(&home.join(".claude/projects"));
    let available_sessions = referenced
        .iter()
        .filter(|session_id| available.contains(*session_id))
        .count();
    SessionOrganizationReport {
        format_version: bundle.format_version,
        groups: bundle.groups.len(),
        group_members: bundle
            .groups
            .iter()
            .map(|group| group.session_ids.len())
            .sum(),
        group_pins: bundle
            .groups
            .iter()
            .map(|group| group.pinned_in_group.len())
            .sum(),
        pinned: bundle.pinned_session_ids.len(),
        archived: bundle.archived_session_ids.len(),
        custom_names: bundle.custom_previews.len(),
        referenced_sessions: referenced.len(),
        available_sessions,
        unavailable_sessions: referenced.len().saturating_sub(available_sessions),
        added_groups: stats.added_groups,
        added_group_members: stats.added_group_members,
        added_group_pins: stats.added_group_pins,
        added_pinned: stats.added_pinned,
        added_archived: stats.added_archived,
        added_custom_names: stats.added_custom_names,
        skipped_conflicts: stats.skipped_conflicts,
    }
}

fn export_session_organization_in(
    home: &Path,
    path: &Path,
) -> Result<SessionOrganizationReport, String> {
    with_authority_lock(|| {
        let authority = read_authority_unlocked(home)?;
        let bundle = portable_bundle_from_authority(&authority);
        let encoded = serde_json::to_vec_pretty(&bundle)
            .map_err(|error| format!("Failed to serialize session organization file: {error}"))?;
        if encoded.len() as u64 > MAX_METADATA_BYTES {
            return Err(format!(
                "Session organization file exceeds the {} MiB safety limit",
                MAX_METADATA_BYTES / 1024 / 1024
            ));
        }
        atomic_write_bytes(path, &encoded, "Black Box session organization file")?;
        Ok(organization_report(
            home,
            &bundle,
            SessionOrganizationMergeStats::default(),
        ))
    })
}

fn preview_session_organization_import_in(
    home: &Path,
    path: &Path,
) -> Result<SessionOrganizationReport, String> {
    let bundle = read_portable_bundle(path)?;
    with_authority_lock(|| {
        let mut preview = read_authority_unlocked(home)?;
        let stats = merge_portable_bundle(&mut preview, &bundle);
        Ok(organization_report(home, &bundle, stats))
    })
}

fn import_session_organization_in(
    home: &Path,
    path: &Path,
) -> Result<SessionOrganizationReport, String> {
    let bundle = read_portable_bundle(path)?;
    with_authority_lock(|| {
        let mut authority = read_authority_unlocked(home)?;
        let stats = merge_portable_bundle(&mut authority, &bundle);
        if stats.has_changes() {
            persist_authority_unlocked(home, &mut authority)?;
        }
        Ok(organization_report(home, &bundle, stats))
    })
}

pub(crate) fn export_session_organization(
    path: String,
) -> Result<SessionOrganizationReport, String> {
    let path = PathBuf::from(path);
    if path.as_os_str().is_empty() {
        return Err("Session organization export path is empty".to_string());
    }
    export_session_organization_in(&current_home()?, &path)
}

pub(crate) fn preview_session_organization_import(
    path: String,
) -> Result<SessionOrganizationReport, String> {
    preview_session_organization_import_in(&current_home()?, Path::new(&path))
}

pub(crate) fn import_session_organization(
    path: String,
) -> Result<SessionOrganizationReport, String> {
    import_session_organization_in(&current_home()?, Path::new(&path))
}

fn merge_legacy_groups(
    authority: &mut SessionMetadataAuthority,
    legacy_groups: Vec<SessionGroupMetadata>,
    eligible: &BTreeSet<String>,
) -> (usize, usize) {
    let mut imported_groups = 0;
    let mut imported_members = 0;
    let mut membership: HashMap<String, String> = authority
        .groups
        .iter()
        .flat_map(|group| {
            group
                .session_ids
                .iter()
                .cloned()
                .map(move |session_id| (session_id, group.id.clone()))
        })
        .collect();

    for legacy_group in normalize_groups(legacy_groups) {
        if authority
            .tombstones
            .deleted_group_ids
            .contains(&legacy_group.id)
        {
            continue;
        }
        let original_was_empty = legacy_group.session_ids.is_empty();
        let mut candidates = Vec::new();
        for session_id in &legacy_group.session_ids {
            let pair = GroupSessionRef::new(&legacy_group.id, session_id);
            if eligible.contains(session_id)
                && !authority
                    .tombstones
                    .deleted_session_ids
                    .contains(session_id)
                && !authority
                    .tombstones
                    .removed_group_memberships
                    .contains(&pair)
                && !membership.contains_key(session_id)
            {
                candidates.push(session_id.clone());
            }
        }

        if let Some(existing) = authority
            .groups
            .iter_mut()
            .find(|group| group.id == legacy_group.id)
        {
            for session_id in candidates {
                membership.insert(session_id.clone(), existing.id.clone());
                existing.session_ids.push(session_id);
                imported_members += 1;
            }
            for session_id in &legacy_group.pinned_in_group {
                let pair = GroupSessionRef::new(&legacy_group.id, session_id);
                if existing.session_ids.contains(session_id)
                    && !existing.pinned_in_group.contains(session_id)
                    && !authority.tombstones.unpinned_in_groups.contains(&pair)
                {
                    existing.pinned_in_group.push(session_id.clone());
                }
            }
            continue;
        }

        // Avoid creating a ghost group whose entire membership belonged to
        // missing/unowned JSONLs. A genuinely empty legacy group remains valid.
        if candidates.is_empty() && !original_was_empty {
            continue;
        }
        let mut group = SessionGroupMetadata {
            id: legacy_group.id,
            label: legacy_group.label,
            workspace: legacy_group.workspace,
            session_ids: candidates,
            pinned_in_group: Vec::new(),
        };
        for session_id in &group.session_ids {
            membership.insert(session_id.clone(), group.id.clone());
            imported_members += 1;
        }
        for session_id in legacy_group.pinned_in_group {
            let pair = GroupSessionRef::new(&group.id, &session_id);
            if group.session_ids.contains(&session_id)
                && !authority.tombstones.unpinned_in_groups.contains(&pair)
            {
                group.pinned_in_group.push(session_id);
            }
        }
        authority.groups.push(group);
        imported_groups += 1;
    }
    (imported_groups, imported_members)
}

fn migrate_legacy_client_sessions_in(home: &Path) -> Result<LegacySessionImportReport, String> {
    with_authority_lock(|| migrate_legacy_client_sessions_unlocked(home))
}

fn migrate_legacy_client_sessions_unlocked(
    home: &Path,
) -> Result<LegacySessionImportReport, String> {
    let legacy_client = legacy_client_dir(home);
    let claude = home.join(".claude");
    let tracking_path = legacy_client.join("tracked_sessions.txt");
    let names_path = legacy_names_path(home);
    let groups_path = legacy_client.join("groups.json");
    let pinned_path = legacy_client.join("pinned.json");
    let archived_path = legacy_client.join("archived.json");

    // Read every source once. The exact bytes used for parsing are also the
    // bytes fingerprinted, so a concurrent legacy-client write cannot make the
    // importer record a fingerprint for data it did not actually merge.
    let tracking_bytes = read_optional_bytes(&tracking_path, "legacy-client tracked sessions")?;
    let names_bytes = read_optional_bytes(&names_path, "legacy-client session names")?;
    let groups_bytes = read_optional_bytes(&groups_path, "legacy-client groups")?;
    let pinned_bytes = read_optional_bytes(&pinned_path, "legacy-client pins")?;
    let archived_bytes = read_optional_bytes(&archived_path, "legacy-client archive")?;
    let source_found = tracking_bytes.is_some()
        || names_bytes.is_some()
        || groups_bytes.is_some()
        || pinned_bytes.is_some()
        || archived_bytes.is_some();
    if !source_found {
        return Ok(LegacySessionImportReport::default());
    }

    let legacy_names: BTreeMap<String, String> =
        parse_json_bytes(names_bytes.as_deref(), "legacy-client session names")?;
    let legacy_groups: Vec<SessionGroupMetadata> =
        parse_json_bytes(groups_bytes.as_deref(), "legacy-client groups")?;
    let legacy_pins: BTreeSet<String> =
        parse_json_bytes(pinned_bytes.as_deref(), "legacy-client pins")?;
    let legacy_archived: BTreeSet<String> =
        parse_json_bytes(archived_bytes.as_deref(), "legacy-client archive")?;

    let mut candidates = read_session_id_lines(tracking_bytes.as_deref());
    candidates.extend(legacy_names.keys().cloned());
    candidates.extend(legacy_pins.iter().cloned());
    candidates.extend(legacy_archived.iter().cloned());
    for group in &legacy_groups {
        candidates.extend(group.session_ids.iter().cloned());
        candidates.extend(group.pinned_in_group.iter().cloned());
    }
    candidates.retain(|session_id| uuid::Uuid::parse_str(session_id).is_ok());

    let available = discover_top_level_session_ids(&claude.join("projects"));
    let eligible: BTreeSet<String> = candidates
        .iter()
        .filter(|session_id| available.contains(*session_id))
        .cloned()
        .collect();

    let mut fingerprints = BTreeMap::new();
    insert_fingerprint(
        &mut fingerprints,
        "trackedSessions",
        tracking_bytes.as_deref(),
    );
    insert_fingerprint(&mut fingerprints, "sessionNames", names_bytes.as_deref());
    insert_fingerprint(&mut fingerprints, "groups", groups_bytes.as_deref());
    insert_fingerprint(&mut fingerprints, "pinned", pinned_bytes.as_deref());
    insert_fingerprint(&mut fingerprints, "archived", archived_bytes.as_deref());
    let eligible_bytes = eligible.iter().cloned().collect::<Vec<_>>().join("\n");
    fingerprints.insert(
        "eligibleSessions".to_string(),
        sha256_hex(eligible_bytes.as_bytes()),
    );

    let mut authority = read_authority_unlocked(home)?;
    if authority.imports.legacy_client_fingerprints == fingerprints {
        return Ok(LegacySessionImportReport {
            source_found: true,
            candidates: candidates.len(),
            ..LegacySessionImportReport::default()
        });
    }

    let destination_tracking_path = blackbox_dir(home).join("tracked_sessions.txt");
    let destination_tracking_bytes =
        read_optional_bytes(&destination_tracking_path, "Black Box tracked sessions")?;
    let mut destination_ids = read_session_id_lines(destination_tracking_bytes.as_deref());
    let before_destination_ids = destination_ids.clone();
    destination_ids.retain(|session_id| {
        !authority
            .tombstones
            .deleted_session_ids
            .contains(session_id)
    });
    destination_ids.extend(eligible.iter().filter_map(|session_id| {
        (!authority
            .tombstones
            .deleted_session_ids
            .contains(session_id))
        .then_some(session_id.clone())
    }));
    let imported_sessions = destination_ids.difference(&before_destination_ids).count();

    let before_names = authority.custom_previews.len();
    for session_id in &eligible {
        if authority
            .tombstones
            .deleted_session_ids
            .contains(session_id)
            || authority
                .tombstones
                .cleared_custom_preview_ids
                .contains(session_id)
        {
            continue;
        }
        if let Some(name) = legacy_names.get(session_id) {
            authority
                .custom_previews
                .entry(session_id.clone())
                .or_insert_with(|| name.clone());
        }
    }
    let imported_names = authority.custom_previews.len().saturating_sub(before_names);

    let (imported_groups, imported_group_members) =
        merge_legacy_groups(&mut authority, legacy_groups, &eligible);
    let mut imported_pins = 0;
    for session_id in legacy_pins {
        if eligible.contains(&session_id)
            && !authority
                .tombstones
                .deleted_session_ids
                .contains(&session_id)
            && !authority
                .tombstones
                .unpinned_session_ids
                .contains(&session_id)
            && authority.pinned_session_ids.insert(session_id)
        {
            imported_pins += 1;
        }
    }
    let mut imported_archived = 0;
    for session_id in legacy_archived {
        if eligible.contains(&session_id)
            && !authority
                .tombstones
                .deleted_session_ids
                .contains(&session_id)
            && !authority
                .tombstones
                .unarchived_session_ids
                .contains(&session_id)
            && authority.archived_session_ids.insert(session_id)
        {
            imported_archived += 1;
        }
    }

    // Destination data first, fingerprint last. If a later write fails, the
    // next launch sees the old fingerprint and safely repeats this idempotent
    // merge instead of treating a partial transaction as complete.
    let mut tracking_content = destination_ids.into_iter().collect::<Vec<_>>().join("\n");
    if !tracking_content.is_empty() {
        tracking_content.push('\n');
    }
    atomic_write_bytes(
        &destination_tracking_path,
        tracking_content.as_bytes(),
        "Black Box tracked sessions",
    )?;
    authority.imports.legacy_client_fingerprints = fingerprints;
    persist_authority_unlocked(home, &mut authority)?;
    Ok(LegacySessionImportReport {
        source_found: true,
        fingerprint_changed: true,
        candidates: candidates.len(),
        imported_sessions,
        imported_names,
        imported_groups,
        imported_group_members,
        imported_pins,
        imported_archived,
    })
}

pub(crate) fn migrate_legacy_client_sessions() {
    let Ok(home) = current_home() else {
        return;
    };
    match migrate_legacy_client_sessions_in(&home) {
        Ok(report) if report.source_found && report.fingerprint_changed => eprintln!(
            "[BLACKBOX] legacy-client incremental import: {} sessions, {} names, {} groups/{} members, {} pins, {} archived ({} candidates)",
            report.imported_sessions,
            report.imported_names,
            report.imported_groups,
            report.imported_group_members,
            report.imported_pins,
            report.imported_archived,
            report.candidates,
        ),
        Ok(_) => {}
        Err(error) => eprintln!("[BLACKBOX] legacy-client incremental import deferred: {error}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const FIRST: &str = "550e8400-e29b-41d4-a716-446655440101";
    const SECOND: &str = "550e8400-e29b-41d4-a716-446655440102";
    const MISSING: &str = "550e8400-e29b-41d4-a716-446655440103";

    fn write_fixture(path: &Path, content: impl AsRef<[u8]>) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, content).unwrap();
    }

    fn jsonl(home: &Path, session_id: &str) -> PathBuf {
        home.join(format!(".claude/projects/-fixture/{session_id}.jsonl"))
    }

    fn authority(home: &Path) -> SessionMetadataAuthority {
        with_authority_lock(|| read_authority_unlocked(home)).unwrap()
    }

    fn seed_legacy(home: &Path) {
        write_fixture(
            &legacy_client_dir(home).join("tracked_sessions.txt"),
            format!("{FIRST}\n{MISSING}\ndesk_temporary\nnot-a-uuid\n"),
        );
        write_fixture(
            &legacy_names_path(home),
            serde_json::to_vec_pretty(&json!({ FIRST: "Legacy title", MISSING: "Missing" }))
                .unwrap(),
        );
        write_fixture(
            &legacy_client_dir(home).join("groups.json"),
            serde_json::to_vec_pretty(&json!([{
                "id": "legacy-group",
                "label": "Research",
                "workspace": "~/repo",
                "sessionIds": [FIRST, MISSING],
                "pinnedInGroup": [FIRST]
            }]))
            .unwrap(),
        );
        write_fixture(
            &legacy_client_dir(home).join("pinned.json"),
            serde_json::to_vec_pretty(&json!([FIRST, MISSING])).unwrap(),
        );
        write_fixture(
            &legacy_client_dir(home).join("archived.json"),
            serde_json::to_vec_pretty(&json!([FIRST])).unwrap(),
        );
        write_fixture(&jsonl(home, FIRST), b"{\"type\":\"user\"}\n");
    }

    #[test]
    fn compatibility_paths_keep_the_retired_client_layout_without_plaintext_identifiers() {
        let temp = tempfile::tempdir().unwrap();
        assert_eq!(
            sha256_hex(
                legacy_client_dir(temp.path())
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .as_bytes(),
            ),
            "168be361c2723ffbb2ca79545ce6fe6b0d28194adb3a966f4c3ee648c3c1a0da"
        );
        assert_eq!(
            sha256_hex(
                legacy_names_path(temp.path())
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .as_bytes(),
            ),
            "fd7d94d14f662535b8fc4d133c9ea564f8d404d9656441cae59da0194fa2fbf4"
        );
    }

    #[test]
    fn consolidates_old_blackbox_ledgers_into_one_atomic_authority() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        write_fixture(
            &home.join(".blackbox/groups.json"),
            serde_json::to_vec_pretty(&json!([{
                "id": "g1", "label": "Group", "workspace": "~/repo",
                "sessionIds": [FIRST], "pinnedInGroup": [FIRST]
            }]))
            .unwrap(),
        );
        write_fixture(
            &home.join(".blackbox/pinned.json"),
            serde_json::to_vec_pretty(&json!([FIRST])).unwrap(),
        );
        write_fixture(
            &home.join(".blackbox/archived.json"),
            serde_json::to_vec_pretty(&json!([FIRST])).unwrap(),
        );

        assert_eq!(load_pinned_sessions_in(home).unwrap(), json!([FIRST]));
        let loaded = authority(home);
        assert_eq!(loaded.groups[0].session_ids, vec![FIRST]);
        assert!(loaded.archived_session_ids.contains(FIRST));
        assert!(authority_path(home).exists());
        assert!(home.join(".blackbox/groups.json").exists());
    }

    #[test]
    fn incrementally_imports_new_sessions_and_legacy_metadata_by_fingerprint() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        seed_legacy(home);
        // A v1 one-shot marker must not suppress the new importer.
        write_fixture(
            &blackbox_dir(home).join("retired_import_v1.json"),
            b"{\"importedSessions\":1}",
        );
        write_fixture(
            &blackbox_names_path(home),
            serde_json::to_vec_pretty(&json!({ FIRST: "Black Box title wins" })).unwrap(),
        );

        let sources = [
            legacy_client_dir(home).join("tracked_sessions.txt"),
            legacy_names_path(home),
            legacy_client_dir(home).join("groups.json"),
            legacy_client_dir(home).join("pinned.json"),
            legacy_client_dir(home).join("archived.json"),
        ];
        let before: Vec<Vec<u8>> = sources
            .iter()
            .map(|path| std::fs::read(path).unwrap())
            .collect();

        let first = migrate_legacy_client_sessions_in(home).unwrap();
        assert!(first.fingerprint_changed);
        assert_eq!(first.imported_sessions, 1);
        assert_eq!(first.imported_groups, 1);
        assert_eq!(first.imported_group_members, 1);
        assert_eq!(first.imported_pins, 1);
        assert_eq!(first.imported_archived, 1);
        let names: BTreeMap<String, String> =
            serde_json::from_slice(&std::fs::read(blackbox_names_path(home)).unwrap()).unwrap();
        assert_eq!(names[FIRST], "Black Box title wins");
        assert_eq!(
            authority(home).custom_previews[FIRST],
            "Black Box title wins"
        );

        for (index, path) in sources.iter().enumerate() {
            assert_eq!(
                std::fs::read(path).unwrap(),
                before[index],
                "import modified legacy-client source {}",
                path.display()
            );
        }

        let unchanged = migrate_legacy_client_sessions_in(home).unwrap();
        assert!(!unchanged.fingerprint_changed);
        assert_eq!(unchanged.imported_sessions, 0);

        write_fixture(
            &legacy_client_dir(home).join("tracked_sessions.txt"),
            format!("{FIRST}\n{SECOND}\n"),
        );
        write_fixture(&jsonl(home, SECOND), b"{\"type\":\"user\"}\n");
        write_fixture(
            &legacy_client_dir(home).join("groups.json"),
            serde_json::to_vec_pretty(&json!([{
                "id": "legacy-group", "label": "Legacy renamed", "workspace": "~/repo",
                "sessionIds": [FIRST, SECOND], "pinnedInGroup": [FIRST]
            }]))
            .unwrap(),
        );
        let incremental = migrate_legacy_client_sessions_in(home).unwrap();
        assert!(incremental.fingerprint_changed);
        assert_eq!(incremental.imported_sessions, 1);
        assert_eq!(incremental.imported_group_members, 1);
        assert_eq!(authority(home).groups[0].session_ids, vec![FIRST, SECOND]);
        assert_eq!(authority(home).groups[0].label, "Research");

        // The first import was completely read-only with respect to the legacy client.
        for (index, path) in sources.iter().enumerate() {
            if index == 0 || index == 2 {
                continue; // intentionally changed above for the incremental run
            }
            assert_eq!(std::fs::read(path).unwrap(), before[index]);
        }
    }

    #[test]
    fn tombstones_prevent_old_imports_from_resurrecting_user_removals() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        seed_legacy(home);
        migrate_legacy_client_sessions_in(home).unwrap();

        save_pinned_sessions_in(home, json!([])).unwrap();
        save_archived_sessions_in(home, json!([])).unwrap();
        save_session_groups_in(home, json!([])).unwrap();
        tombstone_deleted_session_in(home, FIRST).unwrap();

        // Change an unrelated source fingerprint. Every old positive ledger is
        // replayed, and every explicit Black Box removal must still win.
        write_fixture(
            &legacy_names_path(home),
            serde_json::to_vec_pretty(&json!({ FIRST: "Changed legacy title" })).unwrap(),
        );
        migrate_legacy_client_sessions_in(home).unwrap();
        let loaded = authority(home);
        assert!(loaded.groups.is_empty());
        assert!(!loaded.pinned_session_ids.contains(FIRST));
        assert!(!loaded.archived_session_ids.contains(FIRST));
        assert!(loaded.tombstones.deleted_group_ids.contains("legacy-group"));
        assert!(loaded.tombstones.deleted_session_ids.contains(FIRST));
        assert!(
            !std::fs::read_to_string(home.join(".blackbox/tracked_sessions.txt"))
                .unwrap()
                .lines()
                .any(|line| line == FIRST)
        );
    }

    #[test]
    fn unpin_and_unarchive_tombstones_survive_an_unrelated_legacy_change() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        seed_legacy(home);
        migrate_legacy_client_sessions_in(home).unwrap();

        save_pinned_sessions_in(home, json!([])).unwrap();
        save_archived_sessions_in(home, json!([])).unwrap();
        write_fixture(
            &legacy_names_path(home),
            serde_json::to_vec_pretty(&json!({ FIRST: "Fingerprint changed" })).unwrap(),
        );
        migrate_legacy_client_sessions_in(home).unwrap();

        let loaded = authority(home);
        assert!(!loaded.pinned_session_ids.contains(FIRST));
        assert!(!loaded.archived_session_ids.contains(FIRST));
        assert!(loaded.tombstones.unpinned_session_ids.contains(FIRST));
        assert!(loaded.tombstones.unarchived_session_ids.contains(FIRST));
        assert!(!loaded.tombstones.deleted_session_ids.contains(FIRST));
    }

    #[test]
    fn restored_authority_round_trips_with_jsonls_on_a_new_home() {
        let source = tempfile::tempdir().unwrap();
        seed_legacy(source.path());
        migrate_legacy_client_sessions_in(source.path()).unwrap();
        let authority_bytes = std::fs::read(authority_path(source.path())).unwrap();
        let jsonl_bytes = std::fs::read(jsonl(source.path(), FIRST)).unwrap();

        let restored = tempfile::tempdir().unwrap();
        write_fixture(&authority_path(restored.path()), &authority_bytes);
        write_fixture(&jsonl(restored.path(), FIRST), &jsonl_bytes);
        assert_eq!(authority(restored.path()), authority(source.path()));
        assert_eq!(
            std::fs::read(jsonl(restored.path(), FIRST)).unwrap(),
            jsonl_bytes
        );
    }

    #[test]
    fn eligible_jsonl_set_is_part_of_the_fingerprint() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        write_fixture(
            &legacy_client_dir(home).join("tracked_sessions.txt"),
            format!("{FIRST}\n"),
        );
        let missing = migrate_legacy_client_sessions_in(home).unwrap();
        assert!(missing.fingerprint_changed);
        assert_eq!(missing.imported_sessions, 0);

        // The legacy ledger did not change, but the referenced JSONL became
        // available later. The eligible-session fingerprint triggers import.
        write_fixture(&jsonl(home, FIRST), b"{\"type\":\"user\"}\n");
        let available = migrate_legacy_client_sessions_in(home).unwrap();
        assert!(available.fingerprint_changed);
        assert_eq!(available.imported_sessions, 1);
    }

    #[test]
    fn no_legacy_source_creates_no_import_state() {
        let temp = tempfile::tempdir().unwrap();
        let report = migrate_legacy_client_sessions_in(temp.path()).unwrap();
        assert!(!report.source_found);
        assert!(!authority_path(temp.path()).exists());
    }

    #[test]
    fn upgrades_v1_authority_and_consolidates_custom_names_without_deleting_source() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        write_fixture(
            &authority_path(home),
            serde_json::to_vec_pretty(&json!({
                "version": 1,
                "revision": 7,
                "groups": [],
                "pinnedSessionIds": [],
                "archivedSessionIds": [],
                "tombstones": {},
                "imports": {}
            }))
            .unwrap(),
        );
        write_fixture(
            &blackbox_names_path(home),
            serde_json::to_vec_pretty(&json!({ FIRST: "Portable title" })).unwrap(),
        );

        let loaded = authority(home);
        assert_eq!(loaded.version, AUTHORITY_VERSION);
        assert_eq!(loaded.revision, 8);
        assert_eq!(loaded.custom_previews[FIRST], "Portable title");
        assert!(blackbox_names_path(home).exists());

        let persisted: SessionMetadataAuthority =
            serde_json::from_slice(&std::fs::read(authority_path(home)).unwrap()).unwrap();
        assert_eq!(persisted.version, AUTHORITY_VERSION);
        assert_eq!(persisted.custom_previews[FIRST], "Portable title");
    }

    #[test]
    fn upgrades_v2_authority_without_dropping_runtime_preferences() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        write_fixture(
            &authority_path(home),
            serde_json::to_vec_pretty(&json!({
                "version": 2,
                "revision": 4,
                "groups": [],
                "pinnedSessionIds": [],
                "archivedSessionIds": [],
                "customPreviews": {},
                "conversationRuntimePreferences": {
                    FIRST: {
                        "providerId": "relay",
                        "selectedModel": "opus",
                        "customModelId": null
                    }
                },
                "tombstones": {},
                "imports": {}
            }))
            .unwrap(),
        );

        let loaded = authority(home);
        assert_eq!(loaded.version, AUTHORITY_VERSION);
        assert_eq!(loaded.revision, 5);
        assert_eq!(
            loaded.conversation_runtime_preferences[FIRST].provider_id,
            Some("relay".to_string())
        );
        assert_eq!(
            loaded.conversation_runtime_preferences[FIRST].selected_model,
            "opus"
        );
        let persisted: SessionMetadataAuthority =
            serde_json::from_slice(&std::fs::read(authority_path(home)).unwrap()).unwrap();
        assert_eq!(persisted.version, AUTHORITY_VERSION);
        assert!(persisted
            .conversation_runtime_preferences
            .contains_key(FIRST));
    }

    #[test]
    fn portable_import_is_additive_keeps_local_conflicts_and_retains_missing_sessions() {
        let source = tempfile::tempdir().unwrap();
        save_session_groups_in(
            source.path(),
            json!([{
                "id": "portable-group",
                "label": "Research",
                "workspace": "~/repo",
                "sessionIds": [FIRST, SECOND],
                "pinnedInGroup": [SECOND]
            }]),
        )
        .unwrap();
        save_pinned_sessions_in(source.path(), json!([FIRST])).unwrap();
        save_archived_sessions_in(source.path(), json!([SECOND])).unwrap();
        save_custom_previews_in(
            source.path(),
            json!({ FIRST: "Source first", SECOND: "Source second" }),
        )
        .unwrap();
        let bundle_path = source.path().join("organization.json");
        export_session_organization_in(source.path(), &bundle_path).unwrap();

        let destination = tempfile::tempdir().unwrap();
        write_fixture(&jsonl(destination.path(), FIRST), b"{\"type\":\"user\"}\n");
        save_session_groups_in(
            destination.path(),
            json!([{
                "id": "local-group",
                "label": "Local",
                "workspace": "~/repo",
                "sessionIds": [FIRST],
                "pinnedInGroup": []
            }]),
        )
        .unwrap();
        save_custom_previews_in(destination.path(), json!({ FIRST: "Local title" })).unwrap();

        let before_preview = authority(destination.path());
        let preview =
            preview_session_organization_import_in(destination.path(), &bundle_path).unwrap();
        assert_eq!(preview.referenced_sessions, 2);
        assert_eq!(preview.available_sessions, 1);
        assert_eq!(preview.unavailable_sessions, 1);
        assert_eq!(preview.added_groups, 1);
        assert_eq!(authority(destination.path()), before_preview);

        let imported = import_session_organization_in(destination.path(), &bundle_path).unwrap();
        assert_eq!(imported.added_groups, 1);
        assert_eq!(imported.added_group_members, 1);
        assert_eq!(imported.added_group_pins, 1);
        assert_eq!(imported.added_custom_names, 1);
        let loaded = authority(destination.path());
        assert_eq!(loaded.custom_previews[FIRST], "Local title");
        assert_eq!(loaded.custom_previews[SECOND], "Source second");
        assert!(loaded.pinned_session_ids.contains(FIRST));
        assert!(loaded.archived_session_ids.contains(SECOND));
        assert_eq!(loaded.groups[0].session_ids, vec![FIRST]);
        assert_eq!(loaded.groups[1].session_ids, vec![SECOND]);
        assert_eq!(loaded.groups[1].pinned_in_group, vec![SECOND]);
    }

    #[test]
    fn portable_import_cannot_resurrect_explicit_local_removals() {
        let source = tempfile::tempdir().unwrap();
        save_session_groups_in(
            source.path(),
            json!([{
                "id": "removed-group", "label": "Removed", "workspace": "~/repo",
                "sessionIds": [FIRST], "pinnedInGroup": [FIRST]
            }]),
        )
        .unwrap();
        save_pinned_sessions_in(source.path(), json!([FIRST])).unwrap();
        save_archived_sessions_in(source.path(), json!([FIRST])).unwrap();
        save_custom_previews_in(source.path(), json!({ FIRST: "Old title" })).unwrap();
        let bundle_path = source.path().join("organization.json");
        export_session_organization_in(source.path(), &bundle_path).unwrap();

        let destination = tempfile::tempdir().unwrap();
        save_session_groups_in(
            destination.path(),
            json!([{
                "id": "removed-group", "label": "Removed", "workspace": "~/repo",
                "sessionIds": [FIRST], "pinnedInGroup": [FIRST]
            }]),
        )
        .unwrap();
        save_pinned_sessions_in(destination.path(), json!([FIRST])).unwrap();
        save_archived_sessions_in(destination.path(), json!([FIRST])).unwrap();
        save_custom_previews_in(destination.path(), json!({ FIRST: "Old title" })).unwrap();
        save_session_groups_in(destination.path(), json!([])).unwrap();
        save_pinned_sessions_in(destination.path(), json!([])).unwrap();
        save_archived_sessions_in(destination.path(), json!([])).unwrap();
        save_custom_previews_in(destination.path(), json!({})).unwrap();

        let imported = import_session_organization_in(destination.path(), &bundle_path).unwrap();
        assert_eq!(imported.added_groups, 0);
        assert!(imported.skipped_conflicts > 0);
        let loaded = authority(destination.path());
        assert!(loaded.groups.is_empty());
        assert!(loaded.pinned_session_ids.is_empty());
        assert!(loaded.archived_session_ids.is_empty());
        assert!(loaded.custom_previews.is_empty());
    }

    #[test]
    fn rejects_unknown_portable_format_before_mutating_authority() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("invalid.json");
        write_fixture(
            &path,
            serde_json::to_vec_pretty(&json!({
                "format": "some-other-product",
                "formatVersion": 1,
                "exportedAt": "2026-07-17T00:00:00Z"
            }))
            .unwrap(),
        );
        let error = import_session_organization_in(temp.path(), &path).unwrap_err();
        assert!(error.contains("Unsupported session organization file format"));
        assert!(!authority_path(temp.path()).exists());
    }

    #[test]
    fn conversation_runtime_preferences_round_trip_without_credentials() {
        let temp = tempfile::tempdir().unwrap();
        save_conversation_runtime_preferences_in(
            temp.path(),
            json!({
                FIRST: {
                    "providerId": "relay-key-route",
                    "selectedModel": "opus",
                    "customModelId": null
                },
                SECOND: {
                    "providerId": null,
                    "selectedModel": "sonnet",
                    "customModelId": "claude-native-custom"
                }
            }),
        )
        .unwrap();

        let loaded = load_conversation_runtime_preferences_in(temp.path()).unwrap();
        assert_eq!(loaded[FIRST]["providerId"], "relay-key-route");
        assert_eq!(loaded[FIRST]["selectedModel"], "opus");
        assert_eq!(loaded[SECOND]["providerId"], Value::Null);
        assert_eq!(loaded[SECOND]["customModelId"], "claude-native-custom");
        let encoded = serde_json::to_string(&authority(temp.path())).unwrap();
        assert!(!encoded.contains("apiKey"));
        assert!(!encoded.contains("credential"));
    }

    #[test]
    fn conversation_runtime_preferences_reject_ephemeral_and_invalid_entries() {
        let temp = tempfile::tempdir().unwrap();
        save_conversation_runtime_preferences_in(
            temp.path(),
            json!({
                "draft_123": {
                    "providerId": "relay",
                    "selectedModel": "sonnet",
                    "customModelId": null
                },
                "desk_123": {
                    "providerId": "relay",
                    "selectedModel": "sonnet",
                    "customModelId": null
                },
                FIRST: {
                    "providerId": "relay",
                    "selectedModel": "unknown-model",
                    "customModelId": null
                },
                SECOND: {
                    "providerId": "  relay  ",
                    "selectedModel": "HAIKU",
                    "customModelId": "  custom  "
                }
            }),
        )
        .unwrap();

        let loaded = load_conversation_runtime_preferences_in(temp.path()).unwrap();
        assert_eq!(loaded.as_object().unwrap().len(), 1);
        assert_eq!(loaded[SECOND]["providerId"], "relay");
        assert_eq!(loaded[SECOND]["selectedModel"], "haiku");
        assert_eq!(loaded[SECOND]["customModelId"], "custom");
    }

    #[test]
    fn deleting_a_session_removes_its_runtime_preference() {
        let temp = tempfile::tempdir().unwrap();
        save_conversation_runtime_preferences_in(
            temp.path(),
            json!({
                FIRST: {
                    "providerId": "relay",
                    "selectedModel": "fable",
                    "customModelId": null
                }
            }),
        )
        .unwrap();
        assert!(recoverable_session_ids_in(temp.path())
            .unwrap()
            .contains(FIRST));

        tombstone_deleted_session_in(temp.path(), FIRST).unwrap();
        let loaded = load_conversation_runtime_preferences_in(temp.path()).unwrap();
        assert!(loaded.as_object().unwrap().is_empty());
        assert!(!recoverable_session_ids_in(temp.path())
            .unwrap()
            .contains(FIRST));
    }
}
