use chrono::Local;
use serde_json::{json, Value};
use std::io::{self, Read};

const MAX_HOOK_INPUT_BYTES: u64 = 256 * 1024;

fn local_timezone_name() -> String {
    if let Ok(value) = std::env::var("TZ") {
        let value = value.trim();
        if !value.is_empty() && value.len() <= 128 && !value.chars().any(char::is_control) {
            return value.to_string();
        }
    }

    #[cfg(unix)]
    if let Ok(path) = std::fs::read_link("/etc/localtime") {
        let rendered = path.to_string_lossy();
        if let Some((_, zone)) = rendered.split_once("zoneinfo/") {
            if !zone.trim().is_empty() {
                return zone.trim().to_string();
            }
        }
    }

    "local".to_string()
}

fn time_context_output(timestamp: &str, timezone: &str) -> Value {
    json!({
        "continue": true,
        "suppressOutput": true,
        "hookSpecificOutput": {
            "hookEventName": "UserPromptSubmit",
            "additionalContext": format!(
                "Black Box live time context: the computer's current local time is {timestamp}; timezone is {timezone}. Treat this timestamp as authoritative for time-sensitive reasoning. Calculate elapsed intervals from explicit timestamps and never invent how much time has passed."
            )
        }
    })
}

fn build_output(payload: &Value) -> Result<Value, String> {
    if let Some(event) = payload.get("hook_event_name").and_then(Value::as_str) {
        if event != "UserPromptSubmit" {
            return Err("Time context hook only accepts UserPromptSubmit events".to_string());
        }
    }

    let now = Local::now();
    Ok(time_context_output(
        &now.format("%Y-%m-%d %H:%M:%S %:z").to_string(),
        &local_timezone_name(),
    ))
}

pub fn run() -> Result<(), String> {
    let mut input = String::new();
    io::stdin()
        .take(MAX_HOOK_INPUT_BYTES)
        .read_to_string(&mut input)
        .map_err(|error| format!("Cannot read time context hook input: {error}"))?;
    let payload: Value = serde_json::from_str(&input)
        .map_err(|error| format!("Invalid time context hook JSON: {error}"))?;
    let output = build_output(&payload)?;
    println!(
        "{}",
        serde_json::to_string(&output)
            .map_err(|error| format!("Cannot encode time context hook output: {error}"))?
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn output_adds_context_without_echoing_the_prompt() {
        let output = time_context_output("2026-07-15 23:10:00 +08:00", "Asia/Shanghai");
        assert_eq!(output["continue"], true);
        assert_eq!(output["suppressOutput"], true);
        assert_eq!(
            output["hookSpecificOutput"]["hookEventName"],
            "UserPromptSubmit"
        );
        let context = output["hookSpecificOutput"]["additionalContext"]
            .as_str()
            .unwrap();
        assert!(context.contains("2026-07-15 23:10:00 +08:00"));
        assert!(context.contains("Asia/Shanghai"));
    }

    #[test]
    fn other_hook_events_fail_closed() {
        let error = build_output(&json!({"hook_event_name": "PreToolUse"})).unwrap_err();
        assert!(error.contains("only accepts UserPromptSubmit"));
    }
}
