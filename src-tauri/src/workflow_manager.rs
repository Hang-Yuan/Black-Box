use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

const MAX_WORKFLOW_BYTES: u64 = 1024 * 1024;
const MAX_PHASES: usize = 24;
const MAX_PHASE_TITLE: usize = 80;
const MAX_PHASE_DETAIL: usize = 280;
const MAX_PHASE_PROMPT: usize = 12_000;
const MAX_RUN_LEDGER_BYTES: u64 = 2 * 1024 * 1024;
const MAX_WORKFLOW_JOURNAL_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum WorkflowScope {
    User,
    Project,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowPhase {
    pub title: String,
    pub detail: Option<String>,
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRecord {
    pub name: String,
    pub title: Option<String>,
    pub description: String,
    pub when_to_use: Option<String>,
    pub phases: Vec<WorkflowPhase>,
    pub path: String,
    pub scope: WorkflowScope,
    pub valid: bool,
    pub error: Option<String>,
    pub content_digest: String,
    pub modified_at: u64,
    pub black_box_managed: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveWorkflowRequest {
    pub original_path: Option<String>,
    pub name: String,
    pub title: Option<String>,
    pub description: String,
    pub when_to_use: Option<String>,
    pub phases: Vec<WorkflowPhase>,
    pub scope: WorkflowScope,
    pub cwd: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRuntimeProgress {
    pub available: bool,
    pub started: usize,
    pub completed: usize,
    pub failed: usize,
    pub journal_updated_at: u64,
}

#[derive(Debug, Clone, PartialEq)]
enum JsValue {
    String(String),
    Array(Vec<JsValue>),
    Object(BTreeMap<String, JsValue>),
    Literal(String),
}

#[derive(Debug, Clone, PartialEq)]
enum Token {
    String(String),
    Identifier(String),
    Punct(char),
}

struct TokenParser {
    tokens: Vec<Token>,
    cursor: usize,
}

impl TokenParser {
    fn new(tokens: Vec<Token>) -> Self {
        Self { tokens, cursor: 0 }
    }

    fn peek(&self) -> Option<&Token> {
        self.tokens.get(self.cursor)
    }

    fn next(&mut self) -> Option<Token> {
        let value = self.tokens.get(self.cursor).cloned();
        self.cursor += usize::from(value.is_some());
        value
    }

    fn consume_punct(&mut self, expected: char) -> bool {
        if self.peek() == Some(&Token::Punct(expected)) {
            self.cursor += 1;
            true
        } else {
            false
        }
    }

    fn parse_value(&mut self) -> Result<JsValue, String> {
        match self.next() {
            Some(Token::String(value)) => Ok(JsValue::String(value)),
            Some(Token::Identifier(value)) => Ok(JsValue::Literal(value)),
            Some(Token::Punct('{')) => self.parse_object_body(),
            Some(Token::Punct('[')) => self.parse_array_body(),
            _ => Err("meta contains a non-literal value".to_string()),
        }
    }

    fn parse_object_body(&mut self) -> Result<JsValue, String> {
        let mut object = BTreeMap::new();
        loop {
            if self.consume_punct('}') {
                return Ok(JsValue::Object(object));
            }
            let key = match self.next() {
                Some(Token::Identifier(value)) | Some(Token::String(value)) => value,
                _ => return Err("meta object contains an invalid property name".to_string()),
            };
            if !self.consume_punct(':') {
                return Err(format!("meta property '{key}' is missing ':'"));
            }
            object.insert(key, self.parse_value()?);
            if self.consume_punct('}') {
                return Ok(JsValue::Object(object));
            }
            if !self.consume_punct(',') {
                return Err("meta object properties must be comma-separated".to_string());
            }
        }
    }

    fn parse_array_body(&mut self) -> Result<JsValue, String> {
        let mut values = Vec::new();
        loop {
            if self.consume_punct(']') {
                return Ok(JsValue::Array(values));
            }
            values.push(self.parse_value()?);
            if self.consume_punct(']') {
                return Ok(JsValue::Array(values));
            }
            if !self.consume_punct(',') {
                return Err("meta array values must be comma-separated".to_string());
            }
        }
    }
}

fn claude_config_root() -> Result<PathBuf, String> {
    crate::client_runtime::claude_config_dir()
}

fn canonical_or_original(path: &Path) -> PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn validate_project_cwd(cwd: Option<&str>) -> Result<PathBuf, String> {
    let raw = cwd
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Project workflow scope requires a working directory".to_string())?;
    let cwd = PathBuf::from(raw);
    if !cwd.is_dir() {
        return Err("Workflow working directory does not exist".to_string());
    }
    let cwd = canonical_or_original(&cwd);
    if let Some(root) = std::env::var_os("BLACKBOX_DEV_ISOLATION_ROOT") {
        let root = canonical_or_original(Path::new(&root));
        if !cwd.starts_with(&root) {
            return Err(
                "Development isolation rejected a workflow project outside the test workspace"
                    .to_string(),
            );
        }
    }
    Ok(cwd)
}

fn workflow_roots(cwd: Option<&str>) -> Result<Vec<(WorkflowScope, PathBuf)>, String> {
    let mut roots = vec![(WorkflowScope::User, claude_config_root()?.join("workflows"))];
    if let Some(raw) = cwd.map(str::trim).filter(|value| !value.is_empty()) {
        let cwd = validate_project_cwd(Some(raw))?;
        let mut cursor = Some(cwd.as_path());
        while let Some(directory) = cursor {
            let candidate = directory.join(".claude").join("workflows");
            if candidate.is_dir() {
                roots.push((WorkflowScope::Project, candidate));
            }
            cursor = directory.parent();
        }
        let direct = cwd.join(".claude").join("workflows");
        if !roots.iter().any(|(_, root)| root == &direct) {
            roots.push((WorkflowScope::Project, direct));
        }
    }
    Ok(roots)
}

fn validate_slug(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() || value.len() > 64 {
        return Err("Workflow name must be 1-64 characters".to_string());
    }
    if !value.chars().enumerate().all(|(index, character)| {
        character.is_ascii_lowercase()
            || character.is_ascii_digit()
            || (index > 0 && matches!(character, '-' | '_'))
    }) {
        return Err("Workflow name must use lowercase letters, numbers, '-' or '_'".to_string());
    }
    Ok(value.to_string())
}

fn validate_text(value: &str, label: &str, max: usize) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > max {
        return Err(format!("{label} must be 1-{max} characters"));
    }
    if value.chars().any(char::is_control) {
        return Err(format!("{label} cannot contain control characters"));
    }
    Ok(value.to_string())
}

fn optional_text(value: Option<&str>, label: &str, max: usize) -> Result<Option<String>, String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| validate_text(value, label, max))
        .transpose()
}

fn lex_literal(source: &str) -> Result<Vec<Token>, String> {
    let bytes = source.as_bytes();
    let mut tokens = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        let character = bytes[index] as char;
        if character.is_ascii_whitespace() {
            index += 1;
            continue;
        }
        if matches!(character, '{' | '}' | '[' | ']' | ':' | ',') {
            tokens.push(Token::Punct(character));
            index += 1;
            continue;
        }
        if matches!(character, '\'' | '"' | '`') {
            let quote = character;
            index += 1;
            let mut value = String::new();
            while index < bytes.len() {
                let current = bytes[index] as char;
                index += 1;
                if current == quote {
                    tokens.push(Token::String(value));
                    break;
                }
                if current == '\\' {
                    if index >= bytes.len() {
                        return Err("unterminated escape in meta string".to_string());
                    }
                    let escaped = bytes[index] as char;
                    index += 1;
                    value.push(match escaped {
                        'n' => '\n',
                        'r' => '\r',
                        't' => '\t',
                        '\\' => '\\',
                        '\'' => '\'',
                        '"' => '"',
                        '`' => '`',
                        other => other,
                    });
                } else {
                    value.push(current);
                }
            }
            if !matches!(tokens.last(), Some(Token::String(_))) {
                return Err("unterminated meta string".to_string());
            }
            continue;
        }
        if character.is_ascii_alphanumeric() || matches!(character, '_' | '$' | '-') {
            let start = index;
            index += 1;
            while index < bytes.len() {
                let current = bytes[index] as char;
                if !(current.is_ascii_alphanumeric() || matches!(current, '_' | '$' | '-' | '.')) {
                    break;
                }
                index += 1;
            }
            tokens.push(Token::Identifier(source[start..index].to_string()));
            continue;
        }
        return Err(format!("unsupported token '{character}' in meta literal"));
    }
    Ok(tokens)
}

fn find_meta_literal(source: &str) -> Result<&str, String> {
    let source = source.strip_prefix('\u{feff}').unwrap_or(source);
    let prefix = "export const meta";
    if !source.trim_start().starts_with(prefix) {
        return Err("Workflow must begin with `export const meta = { ... }`".to_string());
    }
    let offset = source
        .find(prefix)
        .ok_or_else(|| "Workflow meta export is missing".to_string())?;
    if !source[..offset].trim().is_empty() {
        return Err("Workflow meta export must be the first statement".to_string());
    }
    let after_prefix = &source[offset + prefix.len()..];
    let equals = after_prefix
        .find('=')
        .ok_or_else(|| "Workflow meta export is missing '='".to_string())?;
    let after_equals = &after_prefix[equals + 1..];
    let open = after_equals
        .find('{')
        .ok_or_else(|| "Workflow meta must be an object literal".to_string())?;
    let bytes = after_equals.as_bytes();
    let mut depth = 0usize;
    let mut quote: Option<u8> = None;
    let mut escaped = false;
    for index in open..bytes.len() {
        let byte = bytes[index];
        if let Some(active_quote) = quote {
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == active_quote {
                quote = None;
            }
            continue;
        }
        if matches!(byte, b'\'' | b'"' | b'`') {
            quote = Some(byte);
            continue;
        }
        if byte == b'{' {
            depth += 1;
        } else if byte == b'}' {
            depth = depth.saturating_sub(1);
            if depth == 0 {
                return Ok(&after_equals[open..=index]);
            }
        }
    }
    Err("Workflow meta object is not closed".to_string())
}

fn property_string(object: &BTreeMap<String, JsValue>, key: &str) -> Option<String> {
    match object.get(key) {
        Some(JsValue::String(value)) => Some(value.trim().to_string()),
        _ => None,
    }
}

fn parse_phase(value: &JsValue) -> Result<WorkflowPhase, String> {
    let JsValue::Object(object) = value else {
        return Err("Workflow phases must be literal objects".to_string());
    };
    let title = property_string(object, "title")
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Workflow phase requires a title".to_string())?;
    Ok(WorkflowPhase {
        title,
        detail: property_string(object, "detail").filter(|value| !value.is_empty()),
        model: property_string(object, "model").filter(|value| !value.is_empty()),
        prompt: None,
    })
}

fn parse_managed_prompts(source: &str) -> Option<Vec<String>> {
    const MARKER: &str = "// blackbox-workflow-manifest:";
    let line = source
        .lines()
        .find(|line| line.trim_start().starts_with(MARKER))?;
    let payload = line.trim_start().strip_prefix(MARKER)?.trim();
    let value: Value = serde_json::from_str(payload).ok()?;
    value
        .get("prompts")?
        .as_array()?
        .iter()
        .map(|value| value.as_str().map(str::to_string))
        .collect()
}

fn contains_nondeterminism(source: &str) -> bool {
    let bytes = source.as_bytes();
    let mut code = String::with_capacity(source.len());
    let mut index = 0usize;
    let mut quote: Option<u8> = None;
    let mut escaped = false;
    let mut line_comment = false;
    let mut block_comment = false;
    while index < bytes.len() {
        let byte = bytes[index];
        let next = bytes.get(index + 1).copied();
        if line_comment {
            if byte == b'\n' {
                line_comment = false;
                code.push(' ');
            }
            index += 1;
            continue;
        }
        if block_comment {
            if byte == b'*' && next == Some(b'/') {
                block_comment = false;
                index += 2;
            } else {
                index += 1;
            }
            continue;
        }
        if let Some(active_quote) = quote {
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == active_quote {
                quote = None;
            }
            index += 1;
            continue;
        }
        if byte == b'/' && next == Some(b'/') {
            line_comment = true;
            index += 2;
            continue;
        }
        if byte == b'/' && next == Some(b'*') {
            block_comment = true;
            index += 2;
            continue;
        }
        if matches!(byte, b'\'' | b'"') {
            quote = Some(byte);
            code.push(' ');
            index += 1;
            continue;
        }
        code.push(byte as char);
        index += 1;
    }
    let compact: String = code
        .chars()
        .filter(|character| !character.is_whitespace())
        .collect();
    compact.contains("Date.now(")
        || compact.contains("Math.random(")
        || compact.contains("newDate(")
}

fn parse_workflow(
    source: &str,
) -> Result<
    (
        String,
        Option<String>,
        String,
        Option<String>,
        Vec<WorkflowPhase>,
        bool,
    ),
    String,
> {
    let literal = find_meta_literal(source)?;
    let mut parser = TokenParser::new(lex_literal(literal)?);
    let JsValue::Object(object) = parser.parse_value()? else {
        return Err("Workflow meta must be an object literal".to_string());
    };
    let name = property_string(&object, "name")
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Workflow meta requires name".to_string())?;
    let description = property_string(&object, "description")
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Workflow meta requires description".to_string())?;
    let phases = match object.get("phases") {
        None => Vec::new(),
        Some(JsValue::Array(values)) => values
            .iter()
            .map(parse_phase)
            .collect::<Result<Vec<_>, _>>()?,
        _ => return Err("Workflow meta phases must be a literal array".to_string()),
    };
    if contains_nondeterminism(source) {
        return Err(
            "Workflow uses Date.now, new Date, or Math.random and cannot resume deterministically"
                .to_string(),
        );
    }
    let prompts = parse_managed_prompts(source);
    let black_box_managed = prompts.is_some();
    let phases = phases
        .into_iter()
        .enumerate()
        .map(|(index, mut phase)| {
            phase.prompt = prompts
                .as_ref()
                .and_then(|values| values.get(index).cloned());
            phase
        })
        .collect();
    Ok((
        name,
        property_string(&object, "title").filter(|value| !value.is_empty()),
        description,
        property_string(&object, "whenToUse").filter(|value| !value.is_empty()),
        phases,
        black_box_managed,
    ))
}

fn digest(source: &str) -> String {
    format!("{:x}", Sha256::digest(source.as_bytes()))
}

fn read_record(path: &Path, scope: WorkflowScope) -> WorkflowRecord {
    let metadata = fs::metadata(path).ok();
    let modified_at = metadata
        .and_then(|metadata| metadata.modified().ok())
        .and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|value| value.as_millis().min(u64::MAX as u128) as u64)
        .unwrap_or(0);
    let fallback_name = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("workflow")
        .to_string();
    let source = match fs::read_to_string(path) {
        Ok(source) => source,
        Err(error) => {
            return WorkflowRecord {
                name: fallback_name,
                title: None,
                description: String::new(),
                when_to_use: None,
                phases: Vec::new(),
                path: path.to_string_lossy().to_string(),
                scope,
                valid: false,
                error: Some(format!("Cannot read workflow: {error}")),
                content_digest: String::new(),
                modified_at,
                black_box_managed: false,
            }
        }
    };
    let source_digest = digest(&source);
    match parse_workflow(&source) {
        Ok((name, title, description, when_to_use, phases, black_box_managed)) => WorkflowRecord {
            name,
            title,
            description,
            when_to_use,
            phases,
            path: path.to_string_lossy().to_string(),
            scope,
            valid: true,
            error: None,
            content_digest: source_digest,
            modified_at,
            black_box_managed,
        },
        Err(error) => WorkflowRecord {
            name: fallback_name,
            title: None,
            description: String::new(),
            when_to_use: None,
            phases: Vec::new(),
            path: path.to_string_lossy().to_string(),
            scope,
            valid: false,
            error: Some(error),
            content_digest: source_digest,
            modified_at,
            black_box_managed: false,
        },
    }
}

fn allowed_workflow_path(path: &Path, cwd: Option<&str>) -> Result<PathBuf, String> {
    if path.extension().and_then(|value| value.to_str()) != Some("js") {
        return Err("Claude workflows must use the .js extension".to_string());
    }
    let canonical = canonical_or_original(path);
    let allowed = workflow_roots(cwd)?.into_iter().any(|(_, root)| {
        let canonical_root = canonical_or_original(&root);
        canonical.starts_with(canonical_root)
    });
    if !allowed {
        return Err("Workflow path is outside the user and project workflow roots".to_string());
    }
    Ok(canonical)
}

fn validate_request(request: &SaveWorkflowRequest) -> Result<SaveWorkflowRequest, String> {
    let name = validate_slug(&request.name)?;
    let description = validate_text(&request.description, "Workflow description", 500)?;
    let title = optional_text(request.title.as_deref(), "Workflow title", 100)?;
    let when_to_use = optional_text(request.when_to_use.as_deref(), "Workflow usage hint", 500)?;
    if request.phases.is_empty() || request.phases.len() > MAX_PHASES {
        return Err(format!("Workflow requires 1-{MAX_PHASES} phases"));
    }
    let mut titles = HashSet::new();
    let phases = request
        .phases
        .iter()
        .map(|phase| {
            let title = validate_text(&phase.title, "Phase title", MAX_PHASE_TITLE)?;
            if !titles.insert(title.to_lowercase()) {
                return Err("Workflow phase titles must be unique".to_string());
            }
            let detail = optional_text(phase.detail.as_deref(), "Phase detail", MAX_PHASE_DETAIL)?;
            let prompt = optional_text(phase.prompt.as_deref(), "Phase prompt", MAX_PHASE_PROMPT)?
                .ok_or_else(|| "Every workflow phase requires a prompt".to_string())?;
            let model = optional_text(phase.model.as_deref(), "Phase model", 120)?;
            Ok(WorkflowPhase {
                title,
                detail,
                model,
                prompt: Some(prompt),
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(SaveWorkflowRequest {
        original_path: request.original_path.clone(),
        name,
        title,
        description,
        when_to_use,
        phases,
        scope: request.scope,
        cwd: request.cwd.clone(),
    })
}

fn js_literal(value: &str) -> Result<String, String> {
    serde_json::to_string(value).map_err(|error| format!("Cannot encode workflow text: {error}"))
}

fn render_workflow(request: &SaveWorkflowRequest) -> Result<String, String> {
    let mut meta = serde_json::Map::new();
    meta.insert("name".to_string(), Value::String(request.name.clone()));
    if let Some(title) = &request.title {
        meta.insert("title".to_string(), Value::String(title.clone()));
    }
    meta.insert(
        "description".to_string(),
        Value::String(request.description.clone()),
    );
    if let Some(when_to_use) = &request.when_to_use {
        meta.insert("whenToUse".to_string(), Value::String(when_to_use.clone()));
    }
    meta.insert(
        "phases".to_string(),
        Value::Array(
            request
                .phases
                .iter()
                .map(|phase| {
                    let mut value = serde_json::Map::new();
                    value.insert("title".to_string(), Value::String(phase.title.clone()));
                    if let Some(detail) = &phase.detail {
                        value.insert("detail".to_string(), Value::String(detail.clone()));
                    }
                    if let Some(model) = &phase.model {
                        value.insert("model".to_string(), Value::String(model.clone()));
                    }
                    Value::Object(value)
                })
                .collect(),
        ),
    );
    let meta = serde_json::to_string_pretty(&Value::Object(meta))
        .map_err(|error| format!("Cannot encode workflow meta: {error}"))?;
    let prompts: Vec<String> = request
        .phases
        .iter()
        .map(|phase| phase.prompt.clone().unwrap_or_default())
        .collect();
    let marker = serde_json::json!({"version": 1, "prompts": prompts});
    let mut source = format!(
        "export const meta = {meta};\n\n// blackbox-workflow-manifest: {}\n\nconst workflowInput = typeof args === \"string\" ? args : JSON.stringify(args ?? null);\nlet previousOutput = \"\";\n",
        serde_json::to_string(&marker).map_err(|error| format!("Cannot encode workflow manifest: {error}"))?,
    );
    for (index, phase) in request.phases.iter().enumerate() {
        let title = js_literal(&phase.title)?;
        let prompt = js_literal(phase.prompt.as_deref().unwrap_or_default())?;
        let label = js_literal(&format!("{} · {}", index + 1, phase.title))?;
        let model = phase
            .model
            .as_deref()
            .map(js_literal)
            .transpose()?
            .map(|value| format!(", model: {value}"))
            .unwrap_or_default();
        source.push_str(&format!(
            "\nphase({title});\npreviousOutput = await agent(\n  [\n    \"Original workflow input:\",\n    workflowInput,\n    previousOutput ? \"Previous phase output:\" : \"\",\n    previousOutput,\n    \"Current phase instructions:\",\n    {prompt},\n  ].filter(Boolean).join(\"\\n\\n\"),\n  {{ phase: {title}, label: {label}{model} }},\n);\n",
        ));
    }
    source.push_str("\nreturn previousOutput;\n");
    if source.len() as u64 > MAX_WORKFLOW_BYTES {
        return Err("Generated workflow exceeds the 1 MiB limit".to_string());
    }
    Ok(source)
}

fn atomic_write(path: &Path, source: &str) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Workflow path has no parent directory".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Cannot create workflow directory: {error}"))?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)
        .map_err(|error| format!("Cannot create workflow staging file: {error}"))?;
    temporary
        .write_all(source.as_bytes())
        .and_then(|_| temporary.as_file().sync_all())
        .map_err(|error| format!("Cannot stage workflow: {error}"))?;
    temporary
        .persist(path)
        .map_err(|error| format!("Cannot commit workflow: {}", error.error))?;
    Ok(())
}

fn workflow_run_ledger_path() -> Result<PathBuf, String> {
    let home =
        dirs::home_dir().ok_or_else(|| "Cannot determine Black Box data directory".to_string())?;
    Ok(home.join(".blackbox").join("workflow-runs.json"))
}

fn validate_runtime_run_id(run_id: &str) -> Result<&str, String> {
    let run_id = run_id.trim();
    if !run_id.starts_with("wf_")
        || run_id.len() > 96
        || !run_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err("Invalid native Workflow run id".to_string());
    }
    Ok(run_id)
}

fn inspect_workflow_runtime_progress_at(
    projects_root: &Path,
    transcript_dir: &Path,
    run_id: &str,
) -> Result<WorkflowRuntimeProgress, String> {
    let run_id = validate_runtime_run_id(run_id)?;
    let projects_root = fs::canonicalize(projects_root)
        .map_err(|error| format!("Cannot inspect Claude projects root: {error}"))?;
    let transcript_dir = fs::canonicalize(transcript_dir)
        .map_err(|error| format!("Cannot inspect native Workflow transcript: {error}"))?;
    let valid_shape = transcript_dir.starts_with(&projects_root)
        && transcript_dir.file_name().and_then(|value| value.to_str()) == Some(run_id)
        && transcript_dir
            .parent()
            .and_then(Path::file_name)
            .and_then(|value| value.to_str())
            == Some("workflows")
        && transcript_dir
            .parent()
            .and_then(Path::parent)
            .and_then(Path::file_name)
            .and_then(|value| value.to_str())
            == Some("subagents");
    if !valid_shape {
        return Err("Native Workflow transcript is outside Claude's managed runtime".to_string());
    }

    let journal = transcript_dir.join("journal.jsonl");
    if !journal.exists() {
        return Ok(WorkflowRuntimeProgress {
            available: false,
            started: 0,
            completed: 0,
            failed: 0,
            journal_updated_at: 0,
        });
    }
    let symlink_metadata = fs::symlink_metadata(&journal)
        .map_err(|error| format!("Cannot inspect native Workflow journal: {error}"))?;
    if symlink_metadata.file_type().is_symlink() || !symlink_metadata.is_file() {
        return Err("Native Workflow journal must be a regular file".to_string());
    }
    if symlink_metadata.len() > MAX_WORKFLOW_JOURNAL_BYTES {
        return Err("Native Workflow journal exceeds the 2 MiB read limit".to_string());
    }
    let canonical_journal = fs::canonicalize(&journal)
        .map_err(|error| format!("Cannot resolve native Workflow journal: {error}"))?;
    if !canonical_journal.starts_with(&transcript_dir) {
        return Err("Native Workflow journal escaped its managed runtime".to_string());
    }

    let source = fs::read_to_string(&canonical_journal)
        .map_err(|error| format!("Cannot read native Workflow journal: {error}"))?;
    let mut started = HashSet::new();
    let mut completed = HashSet::new();
    let mut failed = HashSet::new();
    for (index, line) in source.lines().enumerate() {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            // Claude appends the journal while the run is live. A read can
            // catch the final line between writes, so only complete JSON
            // records participate in the progress probe.
            continue;
        };
        let kind = value
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let key = value
            .get("key")
            .and_then(Value::as_str)
            .or_else(|| value.get("agentId").and_then(Value::as_str))
            .map(str::to_string)
            .unwrap_or_else(|| format!("event-{index}"));
        match kind {
            "started" => {
                started.insert(key);
            }
            "result" => {
                completed.insert(key);
            }
            "error" | "failed" => {
                failed.insert(key);
            }
            _ => {}
        }
    }
    let journal_updated_at = symlink_metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|value| value.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or_default();
    Ok(WorkflowRuntimeProgress {
        available: true,
        started: started.len(),
        completed: completed.len(),
        failed: failed.len(),
        journal_updated_at,
    })
}

fn load_run_ledger_at(path: &Path) -> Result<Value, String> {
    if !path.exists() {
        return Ok(serde_json::json!({}));
    }
    let metadata = fs::metadata(path)
        .map_err(|error| format!("Cannot inspect Workflow run ledger: {error}"))?;
    if metadata.len() > MAX_RUN_LEDGER_BYTES {
        return Err("Workflow run ledger exceeds the 2 MiB safety limit".to_string());
    }
    let source = fs::read_to_string(path)
        .map_err(|error| format!("Cannot read Workflow run ledger: {error}"))?;
    let value: Value = serde_json::from_str(&source)
        .map_err(|error| format!("Cannot parse Workflow run ledger: {error}"))?;
    if !value.is_object() {
        return Err("Workflow run ledger must contain a JSON object".to_string());
    }
    Ok(value)
}

fn save_run_ledger_at(path: &Path, data: &Value) -> Result<(), String> {
    if !data.is_object() {
        return Err("Workflow run ledger payload must be a JSON object".to_string());
    }
    let source = serde_json::to_string_pretty(data)
        .map_err(|error| format!("Cannot serialize Workflow run ledger: {error}"))?;
    if source.len() as u64 > MAX_RUN_LEDGER_BYTES {
        return Err("Workflow run ledger payload exceeds the 2 MiB safety limit".to_string());
    }
    let parent = path
        .parent()
        .ok_or_else(|| "Workflow run ledger path has no parent directory".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Cannot create Workflow run ledger directory: {error}"))?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)
        .map_err(|error| format!("Cannot create Workflow run ledger staging file: {error}"))?;
    temporary
        .write_all(source.as_bytes())
        .and_then(|_| temporary.as_file().sync_all())
        .map_err(|error| format!("Cannot stage Workflow run ledger: {error}"))?;
    temporary
        .persist(path)
        .map_err(|error| format!("Cannot commit Workflow run ledger: {}", error.error))?;
    Ok(())
}

#[tauri::command]
pub fn list_workflows(cwd: Option<String>) -> Result<Vec<WorkflowRecord>, String> {
    let mut records = Vec::new();
    let mut seen_paths = HashSet::new();
    for (scope, root) in workflow_roots(cwd.as_deref())? {
        if !root.is_dir() {
            continue;
        }
        let entries = fs::read_dir(&root).map_err(|error| {
            format!("Cannot read workflow directory {}: {error}", root.display())
        })?;
        for entry in entries {
            let entry = entry.map_err(|error| format!("Cannot read workflow entry: {error}"))?;
            let path = entry.path();
            if !path.is_file() || path.extension().and_then(|value| value.to_str()) != Some("js") {
                continue;
            }
            let path_key = canonical_or_original(&path);
            if seen_paths.insert(path_key) {
                records.push(read_record(&path, scope));
            }
        }
    }
    records.sort_by(|left, right| {
        left.name
            .to_lowercase()
            .cmp(&right.name.to_lowercase())
            .then_with(|| match (left.scope, right.scope) {
                (WorkflowScope::Project, WorkflowScope::User) => std::cmp::Ordering::Less,
                (WorkflowScope::User, WorkflowScope::Project) => std::cmp::Ordering::Greater,
                _ => left.path.cmp(&right.path),
            })
    });
    Ok(records)
}

#[tauri::command]
pub fn read_workflow_source(path: String, cwd: Option<String>) -> Result<String, String> {
    let path = allowed_workflow_path(Path::new(&path), cwd.as_deref())?;
    let metadata = fs::metadata(&path)
        .map_err(|error| format!("Cannot inspect workflow {}: {error}", path.display()))?;
    if metadata.len() > MAX_WORKFLOW_BYTES {
        return Err("Workflow exceeds the 1 MiB read limit".to_string());
    }
    fs::read_to_string(&path)
        .map_err(|error| format!("Cannot read workflow {}: {error}", path.display()))
}

#[tauri::command]
pub fn save_workflow(request: SaveWorkflowRequest) -> Result<WorkflowRecord, String> {
    let request = validate_request(&request)?;
    let root = match request.scope {
        WorkflowScope::User => claude_config_root()?.join("workflows"),
        WorkflowScope::Project => validate_project_cwd(request.cwd.as_deref())?
            .join(".claude")
            .join("workflows"),
    };
    let path = root.join(format!("{}.js", request.name));
    if let Some(original_path) = request.original_path.as_deref() {
        let original = allowed_workflow_path(Path::new(original_path), request.cwd.as_deref())?;
        if canonical_or_original(&path) != original {
            return Err("Renaming a workflow requires an explicit remove operation; save it under its existing name".to_string());
        }
    } else if path.exists() {
        return Err("A workflow with this name already exists in the selected scope".to_string());
    }
    let source = render_workflow(&request)?;
    parse_workflow(&source)?;
    atomic_write(&path, &source)?;
    let read_back = fs::read_to_string(&path)
        .map_err(|error| format!("Cannot verify saved workflow: {error}"))?;
    if digest(&read_back) != digest(&source) {
        return Err("Workflow read-back verification failed".to_string());
    }
    let record = read_record(&path, request.scope);
    if !record.valid {
        return Err(record
            .error
            .unwrap_or_else(|| "Workflow validation failed".to_string()));
    }
    Ok(record)
}

#[tauri::command]
pub fn load_workflow_runs() -> Result<Value, String> {
    load_run_ledger_at(&workflow_run_ledger_path()?)
}

#[tauri::command]
pub fn save_workflow_runs(data: Value) -> Result<(), String> {
    save_run_ledger_at(&workflow_run_ledger_path()?, &data)
}

#[tauri::command]
pub fn inspect_workflow_runtime_progress(
    transcript_dir: String,
    run_id: String,
) -> Result<WorkflowRuntimeProgress, String> {
    let projects_root = claude_config_root()?.join("projects");
    inspect_workflow_runtime_progress_at(&projects_root, Path::new(transcript_dir.trim()), &run_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temporary_project() -> tempfile::TempDir {
        if let Some(root) = std::env::var_os("BLACKBOX_DEV_ISOLATION_ROOT") {
            fs::create_dir_all(&root).expect("create isolated workflow test root");
            return tempfile::Builder::new()
                .prefix("workflow-project-")
                .tempdir_in(root)
                .expect("temporary isolated project");
        }
        tempfile::tempdir().expect("temporary project")
    }

    fn request() -> SaveWorkflowRequest {
        SaveWorkflowRequest {
            original_path: None,
            name: "review-release".to_string(),
            title: Some("Review release".to_string()),
            description: "Review a release candidate in two deterministic phases".to_string(),
            when_to_use: Some("Use before packaging a release candidate".to_string()),
            phases: vec![
                WorkflowPhase {
                    title: "Inspect".to_string(),
                    detail: Some("Inspect evidence".to_string()),
                    model: None,
                    prompt: Some("Inspect the current state and list risks.".to_string()),
                },
                WorkflowPhase {
                    title: "Verify".to_string(),
                    detail: None,
                    model: Some("haiku".to_string()),
                    prompt: Some("Verify the highest-risk findings.".to_string()),
                },
            ],
            scope: WorkflowScope::Project,
            cwd: None,
        }
    }

    #[test]
    fn generated_workflow_round_trips_native_meta_and_managed_prompts() {
        let request = validate_request(&request()).expect("valid request");
        let source = render_workflow(&request).expect("render workflow");
        assert!(source.starts_with("export const meta = {"));
        assert!(source.contains("phase(\"Inspect\")"));
        assert!(source.contains("await agent("));
        let (name, title, description, when_to_use, phases, managed) =
            parse_workflow(&source).expect("parse generated workflow");
        assert_eq!(name, "review-release");
        assert_eq!(title.as_deref(), Some("Review release"));
        assert!(description.contains("deterministic"));
        assert!(when_to_use.is_some());
        assert_eq!(phases.len(), 2);
        assert_eq!(
            phases[1].prompt.as_deref(),
            Some("Verify the highest-risk findings.")
        );
        assert!(managed);
    }

    #[test]
    fn rejects_non_literal_or_nondeterministic_workflows() {
        let computed = "export const meta = { name: makeName(), description: 'x', phases: [] };";
        assert!(parse_workflow(computed).is_err());
        let nondeterministic =
            "export const meta = { name: 'x', description: 'x', phases: [] };\nDate.now();";
        assert!(parse_workflow(nondeterministic)
            .unwrap_err()
            .contains("cannot resume deterministically"));
        let string_literal =
            "export const meta = { name: 'x', description: 'x', phases: [] };\nlog(\"Do not call Date.now()\");";
        assert!(parse_workflow(string_literal).is_ok());
    }

    #[test]
    fn validates_names_and_phase_limits() {
        assert!(validate_slug("Release Review").is_err());
        assert!(validate_slug("release-review").is_ok());
        let mut duplicate = request();
        duplicate.phases[1].title = "inspect".to_string();
        assert!(validate_request(&duplicate).unwrap_err().contains("unique"));
    }

    #[test]
    fn project_save_is_atomic_readable_and_refuses_implicit_overwrite() {
        let directory = temporary_project();
        let mut request = request();
        request.cwd = Some(directory.path().to_string_lossy().to_string());
        let saved = save_workflow(request.clone()).expect("save workflow");
        assert!(saved.valid);
        assert!(saved.black_box_managed);
        assert!(saved.path.ends_with(".claude/workflows/review-release.js"));
        assert!(Path::new(&saved.path).is_file());
        assert!(save_workflow(request.clone())
            .unwrap_err()
            .contains("already exists"));

        request.original_path = Some(saved.path.clone());
        request.phases[0].prompt = Some("Inspect the revised evidence.".to_string());
        let updated = save_workflow(request).expect("update workflow");
        assert_eq!(
            updated.phases[0].prompt.as_deref(),
            Some("Inspect the revised evidence.")
        );
    }

    #[test]
    fn workflow_run_ledger_round_trips_atomically_and_rejects_arrays() {
        let directory = tempfile::tempdir().expect("temporary ledger");
        let path = directory.path().join("workflow-runs.json");
        let ledger = serde_json::json!({
            "thread-1": [{"localId": "run-1", "status": "completed"}]
        });
        save_run_ledger_at(&path, &ledger).expect("save ledger");
        assert_eq!(load_run_ledger_at(&path).expect("load ledger"), ledger);
        assert!(save_run_ledger_at(&path, &serde_json::json!([]))
            .unwrap_err()
            .contains("JSON object"));
    }

    #[test]
    fn native_runtime_progress_reads_only_the_managed_workflow_journal() {
        let directory = tempfile::tempdir().expect("temporary Claude root");
        let projects_root = directory.path().join("projects");
        let transcript = projects_root
            .join("project")
            .join("session")
            .join("subagents")
            .join("workflows")
            .join("wf_runtime-1");
        fs::create_dir_all(&transcript).expect("create transcript directory");
        fs::write(
            transcript.join("journal.jsonl"),
            concat!(
                "{\"type\":\"started\",\"key\":\"phase-1\"}\n",
                "{\"type\":\"result\",\"key\":\"phase-1\"}\n",
                "{\"type\":\"started\",\"key\":\"phase-2\"}\n",
            ),
        )
        .expect("write journal");

        let progress =
            inspect_workflow_runtime_progress_at(&projects_root, &transcript, "wf_runtime-1")
                .expect("inspect progress");
        assert!(progress.available);
        assert_eq!(progress.started, 2);
        assert_eq!(progress.completed, 1);
        assert_eq!(progress.failed, 0);
        assert!(progress.journal_updated_at > 0);

        let outside = directory.path().join("outside").join("wf_runtime-1");
        fs::create_dir_all(&outside).expect("create outside path");
        assert!(
            inspect_workflow_runtime_progress_at(&projects_root, &outside, "wf_runtime-1",)
                .unwrap_err()
                .contains("outside Claude's managed runtime")
        );
    }
}
