use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};

const METADATA_VERSION: u8 = 1;
const MAX_CHANGED_PATHS: usize = 10_000;
const MAX_PATCH_BYTES: u64 = 512 * 1024 * 1024;

fn handoff_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TaskRunLocation {
    Local,
    Worktree,
}

impl TaskRunLocation {
    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "local" => Ok(Self::Local),
            "worktree" => Ok(Self::Worktree),
            _ => Err("Task destination must be local or worktree".to_string()),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TaskLocationMetadata {
    version: u8,
    session_id: String,
    current_location: TaskRunLocation,
    repository_root: String,
    local_cwd: String,
    relative_cwd: String,
    worktree_root: String,
    worktree_cwd: String,
    sync_ref: String,
    sync_commit: String,
    generation: u32,
    managed_by: String,
    automation_run_id: Option<String>,
    released_branch: Option<String>,
    created_at: i64,
    updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TaskLocationStatus {
    pub session_id: String,
    pub current_location: TaskRunLocation,
    pub current_cwd: String,
    pub local_cwd: String,
    pub worktree_cwd: String,
    pub worktree_exists: bool,
    pub managed_by: String,
    pub generation: u32,
    pub released_branch: Option<String>,
}

#[derive(Debug)]
struct AutomationSeed {
    metadata: TaskLocationMetadata,
    worktree_cleaned: bool,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

fn data_dir() -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("BLACKBOX_AUTOMATION_HOME") {
        return Ok(PathBuf::from(path));
    }
    crate::safe_data_dir()
}

fn validate_session_id(session_id: &str) -> Result<(), String> {
    let parsed = uuid::Uuid::parse_str(session_id)
        .map_err(|_| "Task handoff requires a valid Claude session UUID".to_string())?;
    if parsed.is_nil() {
        return Err("Task handoff refuses a nil Claude session UUID".to_string());
    }
    Ok(())
}

fn safe_relative_path(path: &Path) -> bool {
    !path.is_absolute()
        && path
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
}

fn sanitize_id(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
                character
            } else {
                '_'
            }
        })
        .collect()
}

fn locations_dir(root: &Path) -> PathBuf {
    root.join("task-locations")
}

fn metadata_path(root: &Path, session_id: &str) -> PathBuf {
    locations_dir(root).join(format!("{session_id}.json"))
}

fn task_worktree_root(root: &Path, session_id: &str) -> PathBuf {
    root.join("task-worktrees").join(session_id)
}

fn sync_ref(session_id: &str) -> String {
    format!("refs/blackbox/task-handoffs/{session_id}/sync")
}

fn run_git(cwd: &Path, arguments: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(cwd)
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
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn run_git_with_index(
    cwd: &Path,
    index_path: &Path,
    arguments: &[&str],
    author_identity: bool,
) -> Result<String, String> {
    let mut command = Command::new("git");
    command
        .arg("-C")
        .arg(cwd)
        .args(arguments)
        .env("GIT_INDEX_FILE", index_path);
    if author_identity {
        command
            .env("GIT_AUTHOR_NAME", "Black Box Handoff")
            .env("GIT_AUTHOR_EMAIL", "handoff@blackbox.invalid")
            .env("GIT_COMMITTER_NAME", "Black Box Handoff")
            .env("GIT_COMMITTER_EMAIL", "handoff@blackbox.invalid");
    }
    let output = command
        .output()
        .map_err(|error| format!("Cannot start Git handoff snapshot: {error}"))?;
    if !output.status.success() {
        let message = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if message.is_empty() {
            format!(
                "Git handoff snapshot exited with {:?}",
                output.status.code()
            )
        } else {
            message
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn repository_root(cwd: &Path) -> Result<PathBuf, String> {
    let root = PathBuf::from(run_git(cwd, &["rev-parse", "--show-toplevel"])?);
    fs::canonicalize(root).map_err(|error| format!("Cannot resolve Git repository: {error}"))
}

fn git_common_dir(cwd: &Path) -> Result<PathBuf, String> {
    let raw = PathBuf::from(run_git(cwd, &["rev-parse", "--git-common-dir"])?);
    let resolved = if raw.is_absolute() {
        raw
    } else {
        cwd.join(raw)
    };
    fs::canonicalize(resolved)
        .map_err(|error| format!("Cannot resolve Git common directory: {error}"))
}

fn validate_same_repository(local_root: &Path, worktree_root: &Path) -> Result<(), String> {
    if git_common_dir(local_root)? != git_common_dir(worktree_root)? {
        return Err("Task worktree no longer belongs to the Local repository".to_string());
    }
    let worktree_top = repository_root(worktree_root)?;
    let expected = fs::canonicalize(worktree_root)
        .map_err(|error| format!("Cannot resolve associated task worktree: {error}"))?;
    if worktree_top != expected {
        return Err(
            "Associated task worktree Git root does not match its managed path".to_string(),
        );
    }
    Ok(())
}

fn valid_oid(value: &str) -> bool {
    (40..=64).contains(&value.len()) && value.chars().all(|character| character.is_ascii_hexdigit())
}

fn tree_for_commit(repository: &Path, commit: &str) -> Result<String, String> {
    if !valid_oid(commit) {
        return Err("Task handoff metadata has an invalid Git snapshot".to_string());
    }
    let tree = run_git(repository, &["rev-parse", &format!("{commit}^{{tree}}")])?;
    if !valid_oid(&tree) {
        return Err("Git returned an invalid tree for task handoff".to_string());
    }
    Ok(tree)
}

fn temp_dir(root: &Path) -> Result<PathBuf, String> {
    let parent = root.join("task-handoff-tmp");
    fs::create_dir_all(&parent)
        .map_err(|error| format!("Cannot create task handoff staging root: {error}"))?;
    let path = parent.join(uuid::Uuid::new_v4().to_string());
    fs::create_dir(&path)
        .map_err(|error| format!("Cannot create task handoff staging directory: {error}"))?;
    Ok(path)
}

fn final_tree(root: &Path, repository: &Path) -> Result<String, String> {
    let staging = temp_dir(root)?;
    let result = (|| {
        let head = run_git(repository, &["rev-parse", "HEAD"])?;
        if !valid_oid(&head) {
            return Err("Task handoff requires a repository with a valid HEAD commit".to_string());
        }
        let index = staging.join("index");
        run_git_with_index(repository, &index, &["read-tree", &head], false)?;
        run_git_with_index(repository, &index, &["add", "-A", "--", "."], false)?;
        let tree = run_git_with_index(repository, &index, &["write-tree"], false)?;
        if !valid_oid(&tree) {
            return Err("Git returned an invalid final tree for task handoff".to_string());
        }
        Ok(tree)
    })();
    let _ = fs::remove_dir_all(staging);
    result
}

fn changed_path_count(repository: &Path, old: &str, new: &str) -> Result<usize, String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(repository)
        .args(["diff", "--name-only", "-z", old, new, "--"])
        .output()
        .map_err(|error| format!("Cannot inspect task handoff changes: {error}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(output
        .stdout
        .split(|byte| *byte == 0)
        .filter(|path| !path.is_empty())
        .count())
}

fn create_snapshot_commit(
    root: &Path,
    repository: &Path,
    session_id: &str,
    generation: u32,
    parent: &str,
) -> Result<String, String> {
    if !valid_oid(parent) {
        return Err("Task handoff has an invalid previous synchronization commit".to_string());
    }
    let tree = final_tree(root, repository)?;
    if tree == tree_for_commit(repository, parent)? {
        return Ok(parent.to_string());
    }
    let staging = temp_dir(root)?;
    let result = (|| {
        let index = staging.join("index");
        let message =
            format!("Black Box handoff snapshot for session {session_id}, generation {generation}");
        let commit = run_git_with_index(
            repository,
            &index,
            &["commit-tree", &tree, "-p", parent, "-m", &message],
            true,
        )?;
        if !valid_oid(&commit) {
            return Err("Git returned an invalid task handoff snapshot commit".to_string());
        }
        let paths = changed_path_count(repository, parent, &commit)?;
        if paths > MAX_CHANGED_PATHS {
            return Err(format!(
                "Task handoff changed too many paths ({paths} > {MAX_CHANGED_PATHS})"
            ));
        }
        Ok(commit)
    })();
    let _ = fs::remove_dir_all(staging);
    result
}

fn generate_patch(root: &Path, repository: &Path, old: &str, new: &str) -> Result<PathBuf, String> {
    let staging = temp_dir(root)?;
    let patch = staging.join("handoff.patch");
    let generate = if old != new {
        let output_arg = format!("--output={}", patch.to_string_lossy());
        run_git(
            repository,
            &[
                "diff",
                "--binary",
                "--full-index",
                old,
                new,
                &output_arg,
                "--",
            ],
        )
        .map(|_| ())
    } else {
        fs::write(&patch, []).map_err(|error| format!("Cannot create empty patch: {error}"))
    };
    if let Err(error) = generate {
        let _ = fs::remove_dir_all(staging);
        return Err(error);
    }
    let bytes = fs::metadata(&patch)
        .map_err(|error| format!("Cannot inspect task handoff patch: {error}"))?
        .len();
    if bytes > MAX_PATCH_BYTES {
        let _ = fs::remove_dir_all(staging);
        return Err(format!(
            "Task handoff patch is too large ({bytes} bytes > {MAX_PATCH_BYTES} bytes)"
        ));
    }
    Ok(patch)
}

fn apply_patch(destination: &Path, patch: &Path, reverse: bool) -> Result<(), String> {
    if fs::metadata(patch)
        .map_err(|error| format!("Cannot inspect task handoff patch: {error}"))?
        .len()
        == 0
    {
        return Ok(());
    }
    let mut command = Command::new("git");
    command
        .arg("-C")
        .arg(destination)
        .arg("apply")
        .arg("--whitespace=nowarn");
    if reverse {
        command.arg("--reverse");
    }
    let output = command
        .arg(patch)
        .output()
        .map_err(|error| format!("Cannot start Git task transfer: {error}"))?;
    if !output.status.success() {
        let message = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if message.is_empty() {
            "Git could not transfer the task changes".to_string()
        } else {
            message
        });
    }
    Ok(())
}

fn current_branch(repository: &Path) -> Result<Option<String>, String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(repository)
        .args(["symbolic-ref", "--quiet", "--short", "HEAD"])
        .output()
        .map_err(|error| format!("Cannot inspect task branch: {error}"))?;
    if output.status.success() {
        let branch = String::from_utf8_lossy(&output.stdout).trim().to_string();
        return Ok((!branch.is_empty()).then_some(branch));
    }
    if output.status.code() == Some(1) {
        return Ok(None);
    }
    Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
}

fn validate_metadata(root: &Path, metadata: &TaskLocationMetadata) -> Result<(), String> {
    validate_session_id(&metadata.session_id)?;
    if metadata.version != METADATA_VERSION
        || metadata.sync_ref != sync_ref(&metadata.session_id)
        || !valid_oid(&metadata.sync_commit)
        || !safe_relative_path(Path::new(&metadata.relative_cwd))
        || !matches!(metadata.managed_by.as_str(), "task" | "automation")
    {
        return Err("Stored task handoff metadata is invalid".to_string());
    }
    let expected_task_root = task_worktree_root(root, &metadata.session_id);
    let worktree_root = PathBuf::from(&metadata.worktree_root);
    if metadata.managed_by == "task" && worktree_root != expected_task_root {
        return Err("Stored task worktree path does not match Black Box storage".to_string());
    }
    if metadata.managed_by == "automation" && !worktree_root.starts_with(root.join("worktrees")) {
        return Err("Stored automation worktree path is outside Black Box storage".to_string());
    }
    let expected_cwd = worktree_root.join(&metadata.relative_cwd);
    if PathBuf::from(&metadata.worktree_cwd) != expected_cwd {
        return Err("Stored task worktree cwd is inconsistent".to_string());
    }
    Ok(())
}

fn load_metadata(root: &Path, session_id: &str) -> Result<Option<TaskLocationMetadata>, String> {
    let path = metadata_path(root, session_id);
    if !path.is_file() {
        return Ok(None);
    }
    let bytes =
        fs::read(&path).map_err(|error| format!("Cannot read task handoff metadata: {error}"))?;
    let metadata: TaskLocationMetadata = serde_json::from_slice(&bytes)
        .map_err(|error| format!("Cannot parse task handoff metadata: {error}"))?;
    if metadata.session_id != session_id {
        return Err("Task handoff metadata belongs to another session".to_string());
    }
    validate_metadata(root, &metadata)?;
    Ok(Some(metadata))
}

fn stage_metadata(root: &Path, metadata: &TaskLocationMetadata) -> Result<PathBuf, String> {
    validate_metadata(root, metadata)?;
    let directory = locations_dir(root);
    fs::create_dir_all(&directory)
        .map_err(|error| format!("Cannot create task location storage: {error}"))?;
    let temp = directory.join(format!(
        ".{}.{}.tmp",
        metadata.session_id,
        uuid::Uuid::new_v4()
    ));
    let mut file = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temp)
        .map_err(|error| format!("Cannot stage task location metadata: {error}"))?;
    file.write_all(
        &serde_json::to_vec_pretty(metadata)
            .map_err(|error| format!("Cannot encode task location metadata: {error}"))?,
    )
    .map_err(|error| format!("Cannot write task location metadata: {error}"))?;
    file.write_all(b"\n")
        .map_err(|error| format!("Cannot finalize task location metadata: {error}"))?;
    file.sync_all()
        .map_err(|error| format!("Cannot sync task location metadata: {error}"))?;
    Ok(temp)
}

fn publish_metadata(root: &Path, session_id: &str, staged: &Path) -> Result<(), String> {
    fs::rename(staged, metadata_path(root, session_id))
        .map_err(|error| format!("Cannot publish task location metadata: {error}"))
}

fn save_metadata(root: &Path, metadata: &TaskLocationMetadata) -> Result<(), String> {
    let staged = stage_metadata(root, metadata)?;
    if let Err(error) = publish_metadata(root, &metadata.session_id, &staged) {
        let _ = fs::remove_file(staged);
        return Err(error);
    }
    Ok(())
}

fn status(metadata: &TaskLocationMetadata) -> TaskLocationStatus {
    TaskLocationStatus {
        session_id: metadata.session_id.clone(),
        current_location: metadata.current_location,
        current_cwd: match metadata.current_location {
            TaskRunLocation::Local => metadata.local_cwd.clone(),
            TaskRunLocation::Worktree => metadata.worktree_cwd.clone(),
        },
        local_cwd: metadata.local_cwd.clone(),
        worktree_cwd: metadata.worktree_cwd.clone(),
        worktree_exists: Path::new(&metadata.worktree_root).is_dir(),
        managed_by: metadata.managed_by.clone(),
        generation: metadata.generation,
        released_branch: metadata.released_branch.clone(),
    }
}

fn update_sync_ref(
    repository: &Path,
    reference: &str,
    new_commit: &str,
    expected_old: Option<&str>,
) -> Result<(), String> {
    let mut arguments = vec!["update-ref", reference, new_commit];
    if let Some(old) = expected_old {
        arguments.push(old);
    }
    run_git(repository, &arguments).map(|_| ())
}

fn delete_sync_ref(repository: &Path, reference: &str, expected: &str) {
    let _ = run_git(repository, &["update-ref", "-d", reference, expected]);
}

fn relative_cwd(repository: &Path, cwd: &Path) -> Result<PathBuf, String> {
    let relative = cwd
        .strip_prefix(repository)
        .map(Path::to_path_buf)
        .map_err(|_| "Task directory is outside its Git repository".to_string())?;
    if relative.as_os_str().is_empty() {
        return Ok(PathBuf::from("."));
    }
    if !safe_relative_path(&relative) {
        return Err("Task directory has an unsafe relative path".to_string());
    }
    Ok(relative)
}

fn normalize_relative(path: &Path) -> PathBuf {
    if path == Path::new(".") {
        PathBuf::new()
    } else {
        path.to_path_buf()
    }
}

fn initialize_local_task(
    root: &Path,
    session_id: &str,
    current_cwd: &Path,
) -> Result<TaskLocationStatus, String> {
    let local_cwd = fs::canonicalize(current_cwd)
        .map_err(|error| format!("Cannot resolve current task directory: {error}"))?;
    let repository = repository_root(&local_cwd)?;
    let relative = normalize_relative(&relative_cwd(&repository, &local_cwd)?);
    let head = run_git(&repository, &["rev-parse", "HEAD"])?;
    if !valid_oid(&head) {
        return Err("Task handoff requires a valid Git HEAD".to_string());
    }
    let commit = create_snapshot_commit(root, &repository, session_id, 0, &head)?;
    let reference = sync_ref(session_id);
    if run_git(&repository, &["rev-parse", "--verify", &reference]).is_ok() {
        return Err("Task handoff ref exists without matching metadata".to_string());
    }
    update_sync_ref(&repository, &reference, &commit, None)?;

    let worktree_root = task_worktree_root(root, session_id);
    if worktree_root.exists() {
        delete_sync_ref(&repository, &reference, &commit);
        return Err("Associated task worktree exists without matching metadata".to_string());
    }
    if let Some(parent) = worktree_root.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Cannot create task worktree storage: {error}"))?;
    }
    let worktree_text = worktree_root.to_string_lossy().to_string();
    let create = run_git(
        &repository,
        &["worktree", "add", "--detach", &worktree_text, &commit],
    );
    if let Err(error) = create {
        delete_sync_ref(&repository, &reference, &commit);
        return Err(format!("Cannot create associated task worktree: {error}"));
    }
    let rollback = || {
        let _ = run_git(
            &repository,
            &["worktree", "remove", "--force", &worktree_text],
        );
        let _ = run_git(&repository, &["worktree", "prune"]);
        delete_sync_ref(&repository, &reference, &commit);
    };
    if let Err(error) =
        crate::automations::copy_worktree_included_files(&repository, &worktree_root)
    {
        rollback();
        return Err(error);
    }
    let worktree_cwd = worktree_root.join(&relative);
    if !worktree_cwd.is_dir() {
        rollback();
        return Err("Task subdirectory is absent from the associated worktree".to_string());
    }
    if let Err(error) =
        crate::automations::validate_worktree_git_identity(&repository, &worktree_root)
    {
        rollback();
        return Err(error);
    }
    let timestamp = now_ms();
    let metadata = TaskLocationMetadata {
        version: METADATA_VERSION,
        session_id: session_id.to_string(),
        current_location: TaskRunLocation::Worktree,
        repository_root: repository.to_string_lossy().to_string(),
        local_cwd: local_cwd.to_string_lossy().to_string(),
        relative_cwd: relative.to_string_lossy().to_string(),
        worktree_root: worktree_root.to_string_lossy().to_string(),
        worktree_cwd: worktree_cwd.to_string_lossy().to_string(),
        sync_ref: reference.clone(),
        sync_commit: commit.clone(),
        generation: 0,
        managed_by: "task".to_string(),
        automation_run_id: None,
        released_branch: None,
        created_at: timestamp,
        updated_at: timestamp,
    };
    if let Err(error) = save_metadata(root, &metadata) {
        rollback();
        return Err(error);
    }
    Ok(status(&metadata))
}

fn automation_seed(root: &Path, session_id: &str) -> Result<Option<AutomationSeed>, String> {
    let database = root.join("automations.sqlite");
    if !database.is_file() {
        return Ok(None);
    }
    let connection = Connection::open(database)
        .map_err(|error| format!("Cannot inspect Scheduled task location: {error}"))?;
    let row: Option<(
        String,
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<i64>,
        Option<String>,
        i64,
    )> = connection
        .query_row(
            "SELECT run_id,automation_id,source_cwd,execution_cwd,base_commit,worktree_cleaned_at,worktree_branch_name,started_at FROM automation_runs WHERE session_id=?1 ORDER BY started_at DESC LIMIT 1",
            [session_id],
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
        .map_err(|error| format!("Cannot read Scheduled task location: {error}"))?;
    let Some((
        run_id,
        automation_id,
        Some(source_cwd),
        Some(execution_cwd),
        Some(base_commit),
        cleaned_at,
        branch_name,
        started_at,
    )) = row
    else {
        return Ok(None);
    };
    if source_cwd == execution_cwd {
        return Ok(None);
    }
    if !valid_oid(&base_commit) {
        return Err("Scheduled run has an invalid worktree baseline".to_string());
    }
    let worktree_root = root
        .join("worktrees")
        .join(sanitize_id(&automation_id))
        .join(sanitize_id(&run_id));
    let execution = PathBuf::from(&execution_cwd);
    let relative = execution
        .strip_prefix(&worktree_root)
        .map(Path::to_path_buf)
        .map_err(|_| "Scheduled run cwd is outside its managed worktree".to_string())?;
    if !relative.as_os_str().is_empty() && !safe_relative_path(&relative) {
        return Err("Scheduled run has an unsafe worktree subdirectory".to_string());
    }
    let local_cwd = fs::canonicalize(&source_cwd)
        .map_err(|error| format!("Cannot resolve Scheduled Local directory: {error}"))?;
    let repository = repository_root(&local_cwd)?;
    let expected_relative = normalize_relative(&relative_cwd(&repository, &local_cwd)?);
    if expected_relative != relative {
        return Err("Scheduled Local and Worktree subdirectories do not match".to_string());
    }
    let metadata = TaskLocationMetadata {
        version: METADATA_VERSION,
        session_id: session_id.to_string(),
        current_location: TaskRunLocation::Worktree,
        repository_root: repository.to_string_lossy().to_string(),
        local_cwd: local_cwd.to_string_lossy().to_string(),
        relative_cwd: relative.to_string_lossy().to_string(),
        worktree_root: worktree_root.to_string_lossy().to_string(),
        worktree_cwd: execution_cwd,
        sync_ref: sync_ref(session_id),
        sync_commit: base_commit,
        generation: 0,
        managed_by: "automation".to_string(),
        automation_run_id: Some(run_id),
        released_branch: branch_name,
        created_at: started_at,
        updated_at: now_ms(),
    };
    validate_metadata(root, &metadata)?;
    Ok(Some(AutomationSeed {
        metadata,
        worktree_cleaned: cleaned_at.is_some(),
    }))
}

fn persist_seed(root: &Path, seed: AutomationSeed) -> Result<TaskLocationMetadata, String> {
    let metadata = seed.metadata;
    let repository = Path::new(&metadata.repository_root);
    let existing = run_git(repository, &["rev-parse", "--verify", &metadata.sync_ref]).ok();
    let created_ref = match existing {
        Some(existing) if existing == metadata.sync_commit => false,
        Some(_) => return Err("Task handoff ref conflicts with Scheduled baseline".to_string()),
        None => {
            update_sync_ref(repository, &metadata.sync_ref, &metadata.sync_commit, None)?;
            true
        }
    };
    if let Err(error) = save_metadata(root, &metadata) {
        if created_ref {
            delete_sync_ref(repository, &metadata.sync_ref, &metadata.sync_commit);
        }
        return Err(error);
    }
    if seed.worktree_cleaned {
        // The location remains Worktree even while its directory is snapshotted
        // away. A real handoff restores that exact associated worktree first.
    }
    Ok(metadata)
}

fn preview_local(
    root: &Path,
    session_id: &str,
    current_cwd: &Path,
) -> Result<TaskLocationStatus, String> {
    let local_cwd = fs::canonicalize(current_cwd)
        .map_err(|error| format!("Cannot resolve current task directory: {error}"))?;
    let repository = repository_root(&local_cwd)?;
    let relative = normalize_relative(&relative_cwd(&repository, &local_cwd)?);
    let worktree_root = task_worktree_root(root, session_id);
    Ok(TaskLocationStatus {
        session_id: session_id.to_string(),
        current_location: TaskRunLocation::Local,
        current_cwd: local_cwd.to_string_lossy().to_string(),
        local_cwd: local_cwd.to_string_lossy().to_string(),
        worktree_cwd: worktree_root.join(relative).to_string_lossy().to_string(),
        worktree_exists: worktree_root.is_dir(),
        managed_by: "task".to_string(),
        generation: 0,
        released_branch: None,
    })
}

fn get_task_location_at(
    root: &Path,
    session_id: &str,
    current_cwd: &Path,
) -> Result<TaskLocationStatus, String> {
    validate_session_id(session_id)?;
    if let Some(metadata) = load_metadata(root, session_id)? {
        return Ok(status(&metadata));
    }
    if let Some(seed) = automation_seed(root, session_id)? {
        return Ok(status(&seed.metadata));
    }
    preview_local(root, session_id, current_cwd)
}

fn restore_associated_worktree(
    _root: &Path,
    metadata: &TaskLocationMetadata,
) -> Result<(), String> {
    let worktree_root = PathBuf::from(&metadata.worktree_root);
    if worktree_root.is_dir() {
        return Ok(());
    }
    if metadata.managed_by == "automation" {
        let run_id = metadata
            .automation_run_id
            .as_ref()
            .ok_or_else(|| "Scheduled task handoff lost its run ID".to_string())?;
        crate::automations::restore_automation_worktree(run_id.clone())?;
        if !worktree_root.is_dir() {
            return Err("Scheduled worktree restore did not recreate its managed path".to_string());
        }
        return Ok(());
    }
    if let Some(parent) = worktree_root.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Cannot create task worktree storage: {error}"))?;
    }
    let repository = Path::new(&metadata.repository_root);
    let worktree_text = worktree_root.to_string_lossy().to_string();
    run_git(
        repository,
        &[
            "worktree",
            "add",
            "--detach",
            &worktree_text,
            &metadata.sync_commit,
        ],
    )
    .map_err(|error| format!("Cannot restore associated task worktree: {error}"))?;
    if let Err(error) = crate::automations::copy_worktree_included_files(repository, &worktree_root)
    {
        let _ = run_git(
            repository,
            &["worktree", "remove", "--force", &worktree_text],
        );
        return Err(error);
    }
    let worktree_cwd = Path::new(&metadata.worktree_cwd);
    if !worktree_cwd.is_dir() {
        let _ = run_git(
            repository,
            &["worktree", "remove", "--force", &worktree_text],
        );
        return Err("Restored task worktree is missing its task subdirectory".to_string());
    }
    Ok(())
}

fn paths_match(left: &Path, right: &Path) -> Result<bool, String> {
    let left = fs::canonicalize(left)
        .map_err(|error| format!("Cannot resolve current task directory: {error}"))?;
    let right = fs::canonicalize(right)
        .map_err(|error| format!("Cannot resolve stored task directory: {error}"))?;
    Ok(left == right)
}

fn rollback_destination(
    root: &Path,
    destination: &Path,
    patch: &Path,
    repository: &Path,
    old_commit: &str,
    new_commit: &str,
) -> Result<(), String> {
    let current = final_tree(root, destination)?;
    let old_tree = tree_for_commit(repository, old_commit)?;
    if current == old_tree {
        return Ok(());
    }
    let new_tree = tree_for_commit(repository, new_commit)?;
    if current != new_tree {
        return Err(
            "Task destination changed during rollback; refusing destructive recovery".to_string(),
        );
    }
    apply_patch(destination, patch, true)?;
    if final_tree(root, destination)? != old_tree {
        return Err("Task destination did not return to its pre-handoff state".to_string());
    }
    Ok(())
}

fn reattach_branch(worktree: &Path, branch: Option<&str>) -> Result<(), String> {
    if let Some(branch) = branch {
        run_git(worktree, &["switch", branch])?;
    }
    Ok(())
}

fn handoff_existing(
    root: &Path,
    mut metadata: TaskLocationMetadata,
    caller_cwd: &Path,
    destination: TaskRunLocation,
) -> Result<TaskLocationStatus, String> {
    if metadata.current_location == destination {
        return Ok(status(&metadata));
    }
    if metadata.current_location == TaskRunLocation::Worktree {
        restore_associated_worktree(root, &metadata)?;
    }
    let expected_current = match metadata.current_location {
        TaskRunLocation::Local => Path::new(&metadata.local_cwd),
        TaskRunLocation::Worktree => Path::new(&metadata.worktree_cwd),
    };
    if !paths_match(caller_cwd, expected_current)? {
        return Err(
            "Task moved since this handoff request was prepared; refresh and retry".to_string(),
        );
    }

    let local_root = PathBuf::from(&metadata.repository_root);
    let worktree_root = PathBuf::from(&metadata.worktree_root);
    if destination == TaskRunLocation::Worktree {
        restore_associated_worktree(root, &metadata)?;
    }
    crate::automations::validate_worktree_git_identity(&local_root, &worktree_root)?;
    validate_same_repository(&local_root, &worktree_root)?;

    let (source, target) = match metadata.current_location {
        TaskRunLocation::Local => (local_root.as_path(), worktree_root.as_path()),
        TaskRunLocation::Worktree => (worktree_root.as_path(), local_root.as_path()),
    };
    let expected_tree = tree_for_commit(&local_root, &metadata.sync_commit)?;
    if final_tree(root, target)? != expected_tree {
        return Err(
            "The inactive checkout changed after the last handoff; resolve it before transferring the task"
                .to_string(),
        );
    }

    let next_generation = metadata.generation.saturating_add(1);
    let next_commit = create_snapshot_commit(
        root,
        source,
        &metadata.session_id,
        next_generation,
        &metadata.sync_commit,
    )?;
    let patch = generate_patch(root, &local_root, &metadata.sync_commit, &next_commit)?;
    let patch_parent = patch.parent().map(Path::to_path_buf);

    let released_branch = if metadata.current_location == TaskRunLocation::Worktree {
        let branch = current_branch(source)?;
        if branch.is_some() {
            if let Err(error) = run_git(source, &["switch", "--detach", "HEAD"]) {
                if let Some(parent) = patch_parent {
                    let _ = fs::remove_dir_all(parent);
                }
                return Err(format!(
                    "Cannot release the worktree branch for handoff: {error}"
                ));
            }
        }
        branch
    } else {
        None
    };

    let previous_commit = metadata.sync_commit.clone();
    metadata.current_location = destination;
    metadata.sync_commit = next_commit.clone();
    metadata.generation = next_generation;
    metadata.updated_at = now_ms();
    if released_branch.is_some() {
        metadata.released_branch = released_branch.clone();
    }
    let staged_metadata = match stage_metadata(root, &metadata) {
        Ok(path) => path,
        Err(error) => {
            let _ = reattach_branch(source, released_branch.as_deref());
            if let Some(parent) = patch_parent {
                let _ = fs::remove_dir_all(parent);
            }
            return Err(error);
        }
    };

    if let Err(error) = apply_patch(target, &patch, false) {
        let rollback = rollback_destination(
            root,
            target,
            &patch,
            &local_root,
            &previous_commit,
            &next_commit,
        );
        let branch_rollback = reattach_branch(source, released_branch.as_deref());
        let _ = fs::remove_file(&staged_metadata);
        if let Some(parent) = patch_parent {
            let _ = fs::remove_dir_all(parent);
        }
        return match (rollback, branch_rollback) {
            (Ok(()), Ok(())) => Err(format!("Cannot transfer task changes: {error}")),
            (rollback, branch) => Err(format!(
                "Cannot transfer task changes ({error}); rollback failed: {}; branch rollback: {}",
                rollback.err().unwrap_or_else(|| "ok".to_string()),
                branch.err().unwrap_or_else(|| "ok".to_string())
            )),
        };
    }
    let verification = (|| {
        let transferred = final_tree(root, target)?;
        let expected = tree_for_commit(&local_root, &next_commit)?;
        if transferred != expected {
            return Err(
                "Transferred task tree does not match its synchronization snapshot".to_string(),
            );
        }
        Ok(())
    })();
    if let Err(verification_error) = verification {
        let rollback = rollback_destination(
            root,
            target,
            &patch,
            &local_root,
            &previous_commit,
            &next_commit,
        );
        let branch_rollback = reattach_branch(source, released_branch.as_deref());
        let _ = fs::remove_file(&staged_metadata);
        if let Some(parent) = patch_parent {
            let _ = fs::remove_dir_all(parent);
        }
        return Err(format!(
            "Transferred task tree did not verify ({verification_error}); rollback: {}; branch rollback: {}",
            rollback.err().unwrap_or_else(|| "ok".to_string()),
            branch_rollback.err().unwrap_or_else(|| "ok".to_string())
        ));
    }

    if let Err(error) = update_sync_ref(
        &local_root,
        &metadata.sync_ref,
        &next_commit,
        Some(&previous_commit),
    ) {
        let rollback = rollback_destination(
            root,
            target,
            &patch,
            &local_root,
            &previous_commit,
            &next_commit,
        );
        let branch_rollback = reattach_branch(source, released_branch.as_deref());
        let _ = fs::remove_file(&staged_metadata);
        if let Some(parent) = patch_parent {
            let _ = fs::remove_dir_all(parent);
        }
        return Err(format!(
            "Cannot advance task synchronization ref ({error}); rollback: {}; branch rollback: {}",
            rollback.err().unwrap_or_else(|| "ok".to_string()),
            branch_rollback.err().unwrap_or_else(|| "ok".to_string())
        ));
    }

    if let Err(error) = publish_metadata(root, &metadata.session_id, &staged_metadata) {
        let ref_rollback = update_sync_ref(
            &local_root,
            &metadata.sync_ref,
            &previous_commit,
            Some(&next_commit),
        );
        let destination_rollback = rollback_destination(
            root,
            target,
            &patch,
            &local_root,
            &previous_commit,
            &next_commit,
        );
        let branch_rollback = reattach_branch(source, released_branch.as_deref());
        let _ = fs::remove_file(&staged_metadata);
        if let Some(parent) = patch_parent {
            let _ = fs::remove_dir_all(parent);
        }
        return Err(format!(
            "Cannot commit task location ({error}); ref rollback: {}; destination rollback: {}; branch rollback: {}",
            ref_rollback.err().unwrap_or_else(|| "ok".to_string()),
            destination_rollback.err().unwrap_or_else(|| "ok".to_string()),
            branch_rollback.err().unwrap_or_else(|| "ok".to_string())
        ));
    }
    if let Some(parent) = patch_parent {
        let _ = fs::remove_dir_all(parent);
    }
    Ok(status(&metadata))
}

fn handoff_task_at(
    root: &Path,
    session_id: &str,
    current_cwd: &Path,
    destination: TaskRunLocation,
) -> Result<TaskLocationStatus, String> {
    validate_session_id(session_id)?;
    let _guard = handoff_lock()
        .lock()
        .map_err(|_| "Task handoff lock is unavailable".to_string())?;
    let metadata = match load_metadata(root, session_id)? {
        Some(metadata) => metadata,
        None => match automation_seed(root, session_id)? {
            Some(seed) => persist_seed(root, seed)?,
            None if destination == TaskRunLocation::Worktree => {
                return initialize_local_task(root, session_id, current_cwd);
            }
            None => return preview_local(root, session_id, current_cwd),
        },
    };
    handoff_existing(root, metadata, current_cwd, destination)
}

pub fn get_task_location(
    session_id: String,
    current_cwd: String,
) -> Result<TaskLocationStatus, String> {
    get_task_location_at(&data_dir()?, &session_id, Path::new(&current_cwd))
}

pub fn handoff_task(
    session_id: String,
    current_cwd: String,
    destination: String,
) -> Result<TaskLocationStatus, String> {
    handoff_task_at(
        &data_dir()?,
        &session_id,
        Path::new(&current_cwd),
        TaskRunLocation::parse(&destination)?,
    )
}

pub fn current_cwd_override(session_id: &str) -> Option<String> {
    let root = data_dir().ok()?;
    let metadata = load_metadata(&root, session_id).ok()??;
    Some(status(&metadata).current_cwd)
}

pub fn is_current_worktree_session(session_id: &str) -> bool {
    let Ok(root) = data_dir() else {
        return false;
    };
    matches!(
        load_metadata(&root, session_id),
        Ok(Some(TaskLocationMetadata {
            current_location: TaskRunLocation::Worktree,
            ..
        }))
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn git(cwd: &Path, args: &[&str]) -> String {
        run_git(cwd, args).unwrap()
    }

    fn fixture() -> (TempDir, PathBuf, PathBuf, String) {
        let temp = tempfile::tempdir().unwrap();
        let repository = temp.path().join("repository");
        let data = temp.path().join("data");
        fs::create_dir_all(&repository).unwrap();
        git(&repository, &["init", "-q"]);
        git(&repository, &["config", "user.name", "Black Box Test"]);
        git(
            &repository,
            &["config", "user.email", "blackbox-test@example.invalid"],
        );
        fs::write(repository.join("tracked.txt"), "base\n").unwrap();
        git(&repository, &["add", "."]);
        git(&repository, &["commit", "-qm", "base"]);
        let session_id = uuid::Uuid::new_v4().to_string();
        (temp, data, repository, session_id)
    }

    #[test]
    fn handoff_round_trip_reuses_one_worktree_and_transfers_final_tree() {
        let (_temp, data, repository, session_id) = fixture();
        fs::write(repository.join("tracked.txt"), "local input\n").unwrap();
        fs::write(repository.join("local-untracked.txt"), "input\n").unwrap();
        let local_status_before = git(&repository, &["status", "--porcelain"]);

        let worktree =
            handoff_task_at(&data, &session_id, &repository, TaskRunLocation::Worktree).unwrap();
        assert_eq!(worktree.current_location, TaskRunLocation::Worktree);
        assert_eq!(
            fs::read_to_string(repository.join("tracked.txt")).unwrap(),
            "local input\n"
        );
        assert_eq!(
            git(&repository, &["status", "--porcelain"]),
            local_status_before
        );
        let associated_root = PathBuf::from(&worktree.worktree_cwd);
        assert_eq!(
            fs::read_to_string(associated_root.join("tracked.txt")).unwrap(),
            "local input\n"
        );
        assert!(associated_root.join("local-untracked.txt").is_file());

        fs::write(associated_root.join("tracked.txt"), "worktree result\n").unwrap();
        fs::write(associated_root.join("agent.txt"), "created in worktree\n").unwrap();
        let local =
            handoff_task_at(&data, &session_id, &associated_root, TaskRunLocation::Local).unwrap();
        assert_eq!(local.current_location, TaskRunLocation::Local);
        assert_eq!(
            fs::read_to_string(repository.join("tracked.txt")).unwrap(),
            "worktree result\n"
        );
        assert_eq!(
            fs::read_to_string(repository.join("agent.txt")).unwrap(),
            "created in worktree\n"
        );

        fs::write(repository.join("tracked.txt"), "local continuation\n").unwrap();
        fs::write(repository.join("continued.txt"), "continued locally\n").unwrap();
        let returned =
            handoff_task_at(&data, &session_id, &repository, TaskRunLocation::Worktree).unwrap();
        assert_eq!(returned.current_location, TaskRunLocation::Worktree);
        assert_eq!(returned.worktree_cwd, worktree.worktree_cwd);
        assert_eq!(
            fs::read_to_string(associated_root.join("tracked.txt")).unwrap(),
            "local continuation\n"
        );
        assert_eq!(
            fs::read_to_string(associated_root.join("continued.txt")).unwrap(),
            "continued locally\n"
        );
    }

    #[test]
    fn handoff_refuses_diverged_inactive_checkout_without_moving_location() {
        let (_temp, data, repository, session_id) = fixture();
        let worktree =
            handoff_task_at(&data, &session_id, &repository, TaskRunLocation::Worktree).unwrap();
        let associated = PathBuf::from(&worktree.worktree_cwd);
        fs::write(associated.join("tracked.txt"), "agent result\n").unwrap();
        fs::write(repository.join("unrelated-local-edit.txt"), "collision\n").unwrap();

        let error =
            handoff_task_at(&data, &session_id, &associated, TaskRunLocation::Local).unwrap_err();
        assert!(error.contains("inactive checkout changed"));
        let stored = load_metadata(&data, &session_id).unwrap().unwrap();
        assert_eq!(stored.current_location, TaskRunLocation::Worktree);
        assert_eq!(
            fs::read_to_string(associated.join("tracked.txt")).unwrap(),
            "agent result\n"
        );
    }

    #[test]
    fn handoff_detaches_a_worktree_branch_but_preserves_its_ref() {
        let (_temp, data, repository, session_id) = fixture();
        let worktree =
            handoff_task_at(&data, &session_id, &repository, TaskRunLocation::Worktree).unwrap();
        let associated = PathBuf::from(&worktree.worktree_cwd);
        git(&associated, &["switch", "-c", "feature/handoff"]);
        fs::write(associated.join("tracked.txt"), "branched work\n").unwrap();

        let local =
            handoff_task_at(&data, &session_id, &associated, TaskRunLocation::Local).unwrap();
        assert_eq!(local.released_branch.as_deref(), Some("feature/handoff"));
        assert!(current_branch(&associated).unwrap().is_none());
        assert_eq!(
            git(
                &repository,
                &["rev-parse", "--verify", "refs/heads/feature/handoff"]
            )
            .len(),
            40
        );
        assert_eq!(
            fs::read_to_string(repository.join("tracked.txt")).unwrap(),
            "branched work\n"
        );
    }

    #[test]
    fn handoff_adopts_and_reuses_a_scheduled_task_worktree() {
        let (_temp, data, repository, session_id) = fixture();
        fs::create_dir_all(&data).unwrap();
        let automation_id = "scheduled-dream";
        let run_id = "run-42";
        let worktree_root = data.join("worktrees").join(automation_id).join(run_id);
        fs::create_dir_all(worktree_root.parent().unwrap()).unwrap();
        let head = git(&repository, &["rev-parse", "HEAD"]);
        let worktree_text = worktree_root.to_string_lossy().to_string();
        git(
            &repository,
            &["worktree", "add", "--detach", &worktree_text, &head],
        );
        fs::write(worktree_root.join("tracked.txt"), "scheduled result\n").unwrap();

        let connection = Connection::open(data.join("automations.sqlite")).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE automation_runs (
                    run_id TEXT PRIMARY KEY,
                    automation_id TEXT NOT NULL,
                    session_id TEXT,
                    source_cwd TEXT,
                    execution_cwd TEXT,
                    base_commit TEXT,
                    worktree_cleaned_at INTEGER,
                    worktree_branch_name TEXT,
                    started_at INTEGER NOT NULL
                );",
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO automation_runs (
                    run_id,automation_id,session_id,source_cwd,execution_cwd,
                    base_commit,worktree_cleaned_at,worktree_branch_name,started_at
                ) VALUES (?1,?2,?3,?4,?5,?6,NULL,NULL,100)",
                rusqlite::params![
                    run_id,
                    automation_id,
                    session_id,
                    repository.to_string_lossy(),
                    worktree_root.to_string_lossy(),
                    head,
                ],
            )
            .unwrap();
        drop(connection);

        let preview = get_task_location_at(&data, &session_id, &worktree_root).unwrap();
        assert_eq!(preview.current_location, TaskRunLocation::Worktree);
        assert_eq!(preview.managed_by, "automation");
        assert_eq!(preview.worktree_cwd, worktree_root.to_string_lossy());

        let local =
            handoff_task_at(&data, &session_id, &worktree_root, TaskRunLocation::Local).unwrap();
        assert_eq!(local.current_location, TaskRunLocation::Local);
        assert_eq!(local.managed_by, "automation");
        assert_eq!(local.worktree_cwd, worktree_root.to_string_lossy());
        assert_eq!(
            fs::read_to_string(repository.join("tracked.txt")).unwrap(),
            "scheduled result\n"
        );
        let stored = load_metadata(&data, &session_id).unwrap().unwrap();
        assert_eq!(stored.automation_run_id.as_deref(), Some(run_id));
        assert_eq!(stored.worktree_root, worktree_root.to_string_lossy());
    }
}
