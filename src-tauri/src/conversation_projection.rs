//! Product projections never retain provider-private reasoning. Durable CLI
//! transcripts remain intact for native resume and signature verification.
use serde_json::Value;
use std::collections::HashMap;

pub fn without_thinking(mut value: Value) -> Value {
    fn visit(value: &mut Value) {
        match value {
            Value::Array(items) => {
                items.retain(|item| {
                    !matches!(
                        item["type"].as_str(),
                        Some("thinking" | "redacted_thinking")
                    )
                });
                for item in items {
                    visit(item);
                }
            }
            Value::Object(object) => {
                let kind = object
                    .get("type")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                if matches!(
                    kind.as_str(),
                    "thinking" | "redacted_thinking" | "thinking_delta" | "signature_delta"
                ) {
                    // Retain the event kind so activity/timing can still advance.
                    object.retain(|key, _| key == "type");
                    return;
                }
                // Do not traverse user tool inputs or alter ordinary text.
                for key in [
                    "message",
                    "content",
                    "event",
                    "delta",
                    "content_block",
                    "data",
                    "messages",
                ] {
                    if let Some(child) = object.get_mut(key) {
                        visit(child);
                    }
                }
            }
            _ => {}
        }
    }
    visit(&mut value);
    value
}

/// The stdout reader owns this ledger, so sequences survive UI suspension and
/// routing between tabs. Repeated receipts retain their original execution.
pub struct ExecutionProjection {
    generation: String,
    turn: u64,
    sequence: u64,
    owners: HashMap<String, u64>,
}

impl ExecutionProjection {
    pub fn new(generation: String) -> Self {
        Self {
            generation,
            turn: 1,
            sequence: 0,
            owners: HashMap::new(),
        }
    }
    pub fn annotate(&mut self, value: &mut Value) {
        if !value.is_object() {
            return;
        }
        self.sequence += 1;
        let root_result = value["type"] == "result" && value["parent_tool_use_id"].is_null();
        let id = value["message"]["id"]
            .as_str()
            .or_else(|| value["event"]["message"]["id"].as_str())
            .or_else(|| {
                if root_result {
                    value["uuid"].as_str()
                } else {
                    None
                }
            })
            .map(str::to_owned);
        let existing = id.as_ref().and_then(|id| self.owners.get(id)).copied();
        let turn = existing.unwrap_or(self.turn);
        if let Some(id) = id {
            self.owners.insert(id, turn);
        }
        value["__executionId"] = format!("{}:{turn}", self.generation).into();
        value["__processGeneration"] = self.generation.clone().into();
        value["__sequence"] = self.sequence.into();
        if root_result && existing.is_none() {
            self.turn += 1;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn sentinel_does_not_cross_product_projection() {
        let raw = json!({"type":"assistant","message":{"id":"m","stop_reason":"end_turn","content":[
            {"type":"thinking","thinking":"PRIVATE_SENTINEL","signature":"PRIVATE_SIGNATURE"},
            {"type":"redacted_thinking","data":"PRIVATE_SENTINEL"},
            {"type":"text","text":"public answer"},
            {"type":"tool_use","input":{"thinking":"user field preserved"}}
        ]}});
        let projected = without_thinking(raw.clone());
        assert!(!projected.to_string().contains("PRIVATE_"));
        assert_eq!(projected["message"]["stop_reason"], "end_turn");
        assert!(projected.to_string().contains("user field preserved"));
        assert!(raw.to_string().contains("PRIVATE_SENTINEL"));
        let delta = without_thinking(
            json!({"event":{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"PRIVATE_SENTINEL"}}}),
        );
        assert!(!delta.to_string().contains("PRIVATE_SENTINEL"));
        assert_eq!(delta["event"]["delta"]["type"], "thinking_delta");
    }
    #[test]
    fn delayed_receipts_and_final_supplements_keep_execution_identity() {
        let mut ledger = ExecutionProjection::new("process-a".into());
        let mut answer = json!({"type":"assistant","message":{"id":"answer-1"}});
        ledger.annotate(&mut answer);
        let mut receipt = json!({"type":"result","uuid":"receipt-1"});
        ledger.annotate(&mut receipt);
        let mut next = json!({"type":"assistant","message":{"id":"answer-2"}});
        ledger.annotate(&mut next);
        let mut late =
            json!({"type":"assistant","message":{"id":"answer-1","stop_reason":"end_turn"}});
        ledger.annotate(&mut late);
        let mut duplicate = json!({"type":"result","uuid":"receipt-1"});
        ledger.annotate(&mut duplicate);
        assert_eq!(answer["__executionId"], late["__executionId"]);
        assert_eq!(receipt["__executionId"], duplicate["__executionId"]);
        assert_ne!(next["__executionId"], duplicate["__executionId"]);
    }

    #[tokio::test]
    async fn disk_reload_export_and_search_exclude_private_sentinel() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("conversation.jsonl");
        let json_export = dir.path().join("public.json");
        let markdown_export = dir.path().join("public.md");
        let raw = json!({"type":"assistant","message":{"id":"m1","role":"assistant","stop_reason":"end_turn","content":[
            {"type":"thinking","thinking":"PRIVATE_SENTINEL_53","signature":"PRIVATE_SIGNATURE_53"},
            {"type":"text","text":"Public final answer"}
        ]}}).to_string();
        std::fs::write(&source, format!("{raw}\n")).unwrap();
        let loaded = crate::load_session(source.to_string_lossy().into_owned())
            .await
            .unwrap();
        assert!(!serde_json::to_string(&loaded).unwrap().contains("PRIVATE_"));
        crate::export_session_json(
            source.to_string_lossy().into_owned(),
            json_export.to_string_lossy().into_owned(),
        )
        .await
        .unwrap();
        crate::export_session_markdown(
            source.to_string_lossy().into_owned(),
            markdown_export.to_string_lossy().into_owned(),
            false,
        )
        .await
        .unwrap();
        for file in [json_export, markdown_export] {
            let text = std::fs::read_to_string(file).unwrap();
            assert!(text.contains("Public final answer"));
            assert!(!text.contains("PRIVATE_"));
        }
        assert!(crate::search_session_file(&source, "private_sentinel_53").is_none());
        assert!(crate::search_session_file(&source, "public final").is_some());
        assert_eq!(std::fs::read_to_string(source).unwrap(), format!("{raw}\n"));
    }
}
