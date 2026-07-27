//! SDK Control Protocol types for bidirectional communication with Claude CLI.
//!
//! When launched with `--permission-prompt-tool stdio`, the CLI sends structured
//! `control_request` messages on stdout instead of interactive permission prompts
//! on stderr. BLACKBOX responds via stdin with `control_response` messages.
//!
//! Note: Permission responses (BLACKBOX → CLI) are built as raw `serde_json::json!`
//! in lib.rs for precise field control. The typed structs below are kept only for
//! unit tests that validate protocol wire format.
//!
//! Reference: Claude Agent SDK v0.2.62 NDJSON protocol

use serde::{Deserialize, Serialize};
use serde_json::Value;

// ─── CLI → BLACKBOX (stdout) ──────────────────────────────────────────────

/// Top-level discriminator for stdout NDJSON lines (used in unit tests for protocol validation).
/// Production code uses Value-based parsing for robustness against field name variations.
#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
#[allow(dead_code)]
pub enum StdoutMessage {
    #[serde(rename = "control_request")]
    ControlRequest {
        request_id: String,
        request: ControlRequestPayload,
    },
    #[serde(rename = "control_cancel_request")]
    ControlCancelRequest {
        request_id: String,
        #[serde(default)]
        reason: Option<String>,
    },
    /// Any other message type — pass through to frontend
    #[serde(other)]
    Other,
}

/// Payload of a `control_request` from CLI (used in unit tests for protocol validation).
#[derive(Debug, Deserialize)]
#[serde(tag = "subtype")]
#[allow(dead_code)]
pub enum ControlRequestPayload {
    #[serde(rename = "can_use_tool")]
    CanUseTool {
        tool_name: String,
        #[serde(default)]
        input: Value,
        #[serde(default)]
        description: Option<String>,
        #[serde(default)]
        tool_use_id: Option<String>,
        #[serde(default)]
        agent_id: Option<String>,
        #[serde(default)]
        permission_suggestions: Option<Value>,
        #[serde(default)]
        blocked_path: Option<String>,
        #[serde(default)]
        decision_reason: Option<String>,
    },
    #[serde(rename = "hook_callback")]
    HookCallback {
        callback_id: String,
        #[serde(default)]
        input: Value,
        #[serde(default)]
        tool_use_id: Option<String>,
    },
    #[serde(other)]
    Unknown,
}

// ─── BLACKBOX → CLI: SDK control requests (stdin) ─────────────────────────

/// Control request envelope for runtime commands sent to CLI stdin.
#[derive(Debug, Serialize)]
pub struct ControlRequest {
    pub r#type: &'static str, // always "control_request"
    pub request_id: String,
    pub request: SdkControlRequestPayload,
}

/// SDK control request subtypes that BLACKBOX can send to CLI.
#[derive(Debug, Serialize)]
#[serde(tag = "subtype")]
pub enum SdkControlRequestPayload {
    #[serde(rename = "interrupt")]
    Interrupt,
    #[serde(rename = "set_permission_mode")]
    SetPermissionMode { mode: String },
    #[serde(rename = "set_model")]
    SetModel {
        #[serde(skip_serializing_if = "Option::is_none")]
        model: Option<String>,
    },
    #[serde(rename = "rewind_files")]
    RewindFiles { user_message_id: String },
}

impl ControlRequest {
    /// Generate a random request ID (alphanumeric, ~13 chars).
    fn random_id() -> String {
        use rand::Rng;
        let mut rng = rand::thread_rng();
        let id: u64 = rng.gen();
        format!("{:x}", id)
    }

    pub fn interrupt() -> Self {
        Self {
            r#type: "control_request",
            request_id: Self::random_id(),
            request: SdkControlRequestPayload::Interrupt,
        }
    }

    pub fn set_permission_mode(mode: String) -> Self {
        Self {
            r#type: "control_request",
            request_id: Self::random_id(),
            request: SdkControlRequestPayload::SetPermissionMode { mode },
        }
    }

    pub fn set_model(model: Option<String>) -> Self {
        Self {
            r#type: "control_request",
            request_id: Self::random_id(),
            request: SdkControlRequestPayload::SetModel { model },
        }
    }

    pub fn rewind_files(user_message_id: String) -> Self {
        Self {
            r#type: "control_request",
            request_id: Self::random_id(),
            request: SdkControlRequestPayload::RewindFiles { user_message_id },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_can_use_tool() {
        let json = r#"{
            "type": "control_request",
            "request_id": "abc123",
            "request": {
                "subtype": "can_use_tool",
                "tool_name": "Bash",
                "input": {"command": "ls -la"},
                "description": "List files",
                "tool_use_id": "tu_001",
                "permission_suggestions": [{
                    "type": "addRules",
                    "rules": [{"toolName": "Bash", "ruleContent": "ls:*"}],
                    "behavior": "allow",
                    "destination": "session"
                }],
                "blocked_path": "/tmp/example",
                "decision_reason": "Default mode asks before Bash"
            }
        }"#;
        let msg: StdoutMessage = serde_json::from_str(json).unwrap();
        match msg {
            StdoutMessage::ControlRequest {
                request_id,
                request,
            } => {
                assert_eq!(request_id, "abc123");
                match request {
                    ControlRequestPayload::CanUseTool {
                        tool_name,
                        description,
                        permission_suggestions,
                        blocked_path,
                        decision_reason,
                        ..
                    } => {
                        assert_eq!(tool_name, "Bash");
                        assert_eq!(description.unwrap(), "List files");
                        assert_eq!(permission_suggestions.unwrap()[0]["destination"], "session");
                        assert_eq!(blocked_path.unwrap(), "/tmp/example");
                        assert_eq!(decision_reason.unwrap(), "Default mode asks before Bash");
                    }
                    _ => panic!("Expected CanUseTool"),
                }
            }
            _ => panic!("Expected ControlRequest"),
        }
    }

    #[test]
    fn test_parse_other_message() {
        let json = r#"{"type": "assistant", "message": {}, "uuid": "x", "session_id": "y"}"#;
        let msg: StdoutMessage = serde_json::from_str(json).unwrap();
        assert!(matches!(msg, StdoutMessage::Other));
    }

    #[test]
    fn test_parse_control_cancel_request() {
        let json = r#"{
            "type": "control_cancel_request",
            "request_id": "abc123",
            "reason": "interrupted"
        }"#;
        let msg: StdoutMessage = serde_json::from_str(json).unwrap();
        match msg {
            StdoutMessage::ControlCancelRequest { request_id, reason } => {
                assert_eq!(request_id, "abc123");
                assert_eq!(reason.as_deref(), Some("interrupted"));
            }
            _ => panic!("Expected ControlCancelRequest"),
        }
    }

    #[test]
    fn test_serialize_interrupt() {
        let req = ControlRequest::interrupt();
        let json = serde_json::to_string(&req).unwrap();
        assert!(json.contains(r#""type":"control_request""#));
        assert!(json.contains(r#""subtype":"interrupt""#));
    }

    #[test]
    fn test_serialize_set_model() {
        let req = ControlRequest::set_model(Some("claude-opus-4-8".to_string()));
        let json = serde_json::to_string(&req).unwrap();
        assert!(json.contains(r#""subtype":"set_model""#));
        assert!(json.contains(r#""model":"claude-opus-4-8""#));
    }

    #[test]
    fn test_serialize_set_permission_mode() {
        let req = ControlRequest::set_permission_mode("acceptEdits".to_string());
        let json = serde_json::to_string(&req).unwrap();
        assert!(json.contains(r#""subtype":"set_permission_mode""#));
        assert!(json.contains(r#""mode":"acceptEdits""#));
    }
}
