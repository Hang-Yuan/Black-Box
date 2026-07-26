use serde_json::{json, Value};
use std::io::{self, Read};
#[cfg(debug_assertions)]
use std::path::{Path, PathBuf};

const MAX_HOOK_INPUT_BYTES: u64 = 1024 * 1024;

fn validate_model(model: &str) -> Result<&str, String> {
    let model = model.trim().to_ascii_lowercase();
    match model.as_str() {
        "haiku" => Ok("haiku"),
        "sonnet" => Ok("sonnet"),
        "opus" => Ok("opus"),
        "fable" => Ok("fable"),
        _ => Err("Agent tool model must be one of haiku, sonnet, opus, or fable".to_string()),
    }
}

fn rewrite_agent_input(payload: Value, model: &str) -> Result<Value, String> {
    let model = validate_model(model)?;
    if payload.get("tool_name").and_then(Value::as_str) != Some("Agent") {
        return Err("Auxiliary model hook only accepts Agent tool calls".to_string());
    }
    let mut tool_input = payload
        .get("tool_input")
        .and_then(Value::as_object)
        .cloned()
        .ok_or_else(|| "Agent hook input is missing tool_input".to_string())?;
    tool_input.insert("model".to_string(), Value::String(model.to_string()));

    Ok(json!({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "allow",
            "permissionDecisionReason": "Black Box pins every subagent and teammate to the configured native Agent model tier.",
            "updatedInput": tool_input
        }
    }))
}

#[cfg(debug_assertions)]
fn build_audit_record(payload: &Value, enforced_model: &str) -> Value {
    json!({
        "toolName": payload.get("tool_name").and_then(Value::as_str),
        "requestedModel": payload.pointer("/tool_input/model").and_then(Value::as_str),
        "enforcedModel": enforced_model,
        "routing": "blackbox-auxiliary-model-hook"
    })
}

#[cfg(debug_assertions)]
fn validate_audit_path(path: &Path, isolation_root: &Path) -> Result<PathBuf, String> {
    let root = isolation_root
        .canonicalize()
        .map_err(|error| format!("Cannot resolve auxiliary audit isolation root: {error}"))?;
    let parent = path
        .parent()
        .ok_or_else(|| "Auxiliary audit file has no parent directory".to_string())?
        .canonicalize()
        .map_err(|error| format!("Cannot resolve auxiliary audit directory: {error}"))?;
    if !parent.starts_with(&root) {
        return Err(
            "Auxiliary audit file must stay inside BLACKBOX_DEV_ISOLATION_ROOT".to_string(),
        );
    }
    let file_name = path
        .file_name()
        .filter(|name| !name.is_empty())
        .ok_or_else(|| "Auxiliary audit file name is invalid".to_string())?;
    Ok(parent.join(file_name))
}

fn audit_auxiliary_model_decision(payload: &Value, model: &str) -> Result<(), String> {
    #[cfg(debug_assertions)]
    {
        use std::io::Write;

        let Some(raw_path) = std::env::var_os("BLACKBOX_DEV_AUXILIARY_MODEL_AUDIT_FILE") else {
            return Ok(());
        };
        let isolation_root = std::env::var_os("BLACKBOX_DEV_ISOLATION_ROOT")
            .ok_or_else(|| "Auxiliary audit requires BLACKBOX_DEV_ISOLATION_ROOT".to_string())?;
        let path = validate_audit_path(Path::new(&raw_path), Path::new(&isolation_root))?;
        let record = serde_json::to_string(&build_audit_record(payload, model))
            .map_err(|error| format!("Cannot encode auxiliary model audit record: {error}"))?;
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .map_err(|error| format!("Cannot open auxiliary model audit file: {error}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
                .map_err(|error| format!("Cannot protect auxiliary model audit file: {error}"))?;
        }
        writeln!(file, "{record}")
            .map_err(|error| format!("Cannot append auxiliary model audit record: {error}"))?;
    }
    #[cfg(not(debug_assertions))]
    {
        let _ = (payload, model);
    }
    Ok(())
}

pub fn run(model: String) -> Result<(), String> {
    let mut input = String::new();
    io::stdin()
        .take(MAX_HOOK_INPUT_BYTES)
        .read_to_string(&mut input)
        .map_err(|error| format!("Cannot read auxiliary model hook input: {error}"))?;
    let payload: Value = serde_json::from_str(&input)
        .map_err(|error| format!("Invalid auxiliary model hook JSON: {error}"))?;
    let output = rewrite_agent_input(payload.clone(), &model)?;
    audit_auxiliary_model_decision(&payload, &model)?;
    println!(
        "{}",
        serde_json::to_string(&output)
            .map_err(|error| format!("Cannot encode auxiliary model hook output: {error}"))?
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ordinary_subagent_model_is_replaced_without_losing_fields() {
        let output = rewrite_agent_input(
            json!({
                "tool_name": "Agent",
                "tool_input": {
                    "description": "Inspect routing",
                    "prompt": "Check the code",
                    "subagent_type": "Explore",
                    "model": "claude-opus-4-8"
                }
            }),
            "sonnet",
        )
        .unwrap();

        let updated = &output["hookSpecificOutput"]["updatedInput"];
        assert_eq!(updated["model"], "sonnet");
        assert_eq!(updated["subagent_type"], "Explore");
        assert_eq!(updated["prompt"], "Check the code");
    }

    #[test]
    fn named_teammate_model_is_replaced_without_losing_identity() {
        let output = rewrite_agent_input(
            json!({
                "tool_name": "Agent",
                "tool_input": {
                    "name": "reviewer",
                    "description": "Review changes",
                    "prompt": "Review independently"
                }
            }),
            "fable",
        )
        .unwrap();

        let updated = &output["hookSpecificOutput"]["updatedInput"];
        assert_eq!(updated["model"], "fable");
        assert_eq!(updated["name"], "reviewer");
        assert_eq!(updated["description"], "Review changes");
    }

    #[test]
    fn non_agent_calls_fail_closed() {
        let error = rewrite_agent_input(
            json!({"tool_name": "Bash", "tool_input": {"command": "true"}}),
            "sonnet",
        )
        .unwrap_err();
        assert!(error.contains("only accepts Agent"));
    }

    #[test]
    fn debug_audit_record_contains_only_routing_metadata() {
        let payload = json!({
            "tool_name": "Agent",
            "tool_input": {
                "prompt": "sensitive test prompt",
                "model": "claude-opus-4-8"
            }
        });
        let record = build_audit_record(&payload, "haiku");
        let encoded = record.to_string();
        assert_eq!(record["toolName"], "Agent");
        assert_eq!(record["requestedModel"], "claude-opus-4-8");
        assert_eq!(record["enforcedModel"], "haiku");
        assert!(!encoded.contains("sensitive test prompt"));
    }

    #[test]
    fn concrete_provider_model_ids_are_rejected_at_the_agent_boundary() {
        let error = rewrite_agent_input(
            json!({
                "tool_name": "Agent",
                "tool_input": {"prompt": "inspect"}
            }),
            "claude-sonnet-5",
        )
        .unwrap_err();
        assert!(error.contains("haiku, sonnet, opus, or fable"));
    }

    #[test]
    fn debug_audit_path_cannot_escape_the_isolated_workspace() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("workspace");
        let outside = temp.path().join("outside");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        assert_eq!(
            validate_audit_path(&root.join("audit.jsonl"), &root).unwrap(),
            root.canonicalize().unwrap().join("audit.jsonl")
        );
        assert!(validate_audit_path(&outside.join("audit.jsonl"), &root).is_err());
    }
}
