//! Loopback-only provider gateway.
//!
//! Claude Code remains the agent runtime. For configured providers it receives
//! a per-session loopback URL and an ephemeral token; the provider credential
//! stays inside the Black Box backend and is injected only on the upstream hop.

use axum::{
    body::{to_bytes, Body, Bytes},
    extract::State,
    http::{header, HeaderMap, HeaderName, HeaderValue, Request, Response, StatusCode},
    routing::any,
    Router,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use futures_util::StreamExt;
use rand::RngCore;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    convert::Infallible,
    sync::Arc,
};
use tokio::{net::TcpListener, sync::oneshot};

use crate::provider_protocol::{ProviderAuthScheme, ProviderProtocol};

const MAX_REQUEST_BYTES: usize = 128 * 1024 * 1024;

#[derive(Debug, Clone)]
pub(crate) struct ProviderGatewayConfig {
    pub upstream_base_url: String,
    pub upstream_api_key: String,
    pub api_format: String,
    pub auth_scheme: String,
    pub proxy_url: Option<String>,
}

#[derive(Clone)]
struct GatewayState {
    upstream_base_url: String,
    upstream_api_key: String,
    protocol: ProviderProtocol,
    auth_scheme: ProviderAuthScheme,
    session_token: String,
    client: reqwest::Client,
}

/// Owns the loopback server lifetime. Dropping the guard shuts the listener
/// down; no global token registry survives a Claude process.
pub(crate) struct ProviderGatewayGuard {
    base_url: String,
    session_token: String,
    shutdown: Option<oneshot::Sender<()>>,
}

impl ProviderGatewayGuard {
    pub(crate) fn base_url(&self) -> &str {
        &self.base_url
    }

    pub(crate) fn session_token(&self) -> &str {
        &self.session_token
    }
}

impl Drop for ProviderGatewayGuard {
    fn drop(&mut self) {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
    }
}

pub(crate) async fn start(config: ProviderGatewayConfig) -> Result<ProviderGatewayGuard, String> {
    let upstream_base_url = config.upstream_base_url.trim_end_matches('/').to_string();
    if upstream_base_url.is_empty() {
        return Err("Provider gateway requires an upstream base URL".to_string());
    }
    if config.upstream_api_key.trim().is_empty() {
        return Err("Provider gateway requires a provider credential".to_string());
    }
    let protocol = ProviderProtocol::parse(&config.api_format)?;
    let auth_scheme = ProviderAuthScheme::parse(&config.auth_scheme)?;
    if !protocol.accepts_auth_scheme(auth_scheme) {
        return Err(format!(
            "Provider gateway protocol '{}' cannot use '{}' authentication",
            protocol.id(),
            auth_scheme.id()
        ));
    }

    // Reqwest has no whole-request timeout by default, so SSE streams remain
    // open while the provider is generating.
    let mut client_builder =
        reqwest::Client::builder().connect_timeout(std::time::Duration::from_secs(15));
    if let Some(proxy_url) = config
        .proxy_url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let proxy = reqwest::Proxy::all(proxy_url)
            .map_err(|error| format!("Invalid provider proxy URL: {error}"))?;
        client_builder = client_builder.no_proxy().proxy(proxy);
    }
    let client = client_builder
        .build()
        .map_err(|error| format!("Cannot build provider gateway client: {error}"))?;

    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|error| format!("Cannot bind provider gateway: {error}"))?;
    let address = listener
        .local_addr()
        .map_err(|error| format!("Cannot inspect provider gateway address: {error}"))?;
    let session_token = ephemeral_token();
    let state = Arc::new(GatewayState {
        upstream_base_url,
        upstream_api_key: config.upstream_api_key,
        protocol,
        auth_scheme,
        session_token: session_token.clone(),
        client,
    });
    let app = Router::new()
        .route("/", any(forward))
        .route("/{*path}", any(forward))
        .with_state(state);
    let (shutdown_tx, shutdown_rx) = oneshot::channel();

    tokio::spawn(async move {
        let server = axum::serve(listener, app).with_graceful_shutdown(async move {
            let _ = shutdown_rx.await;
        });
        if let Err(error) = server.await {
            eprintln!("[BLACKBOX] provider gateway stopped unexpectedly: {error}");
        }
    });

    Ok(ProviderGatewayGuard {
        base_url: format!("http://{address}"),
        session_token,
        shutdown: Some(shutdown_tx),
    })
}

fn ephemeral_token() -> String {
    let mut random = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut random);
    format!("bbx_{}", URL_SAFE_NO_PAD.encode(random))
}

async fn forward(State(state): State<Arc<GatewayState>>, request: Request<Body>) -> Response<Body> {
    if !valid_session_token(request.headers(), &state.session_token) {
        return text_response(StatusCode::UNAUTHORIZED, "Invalid gateway session token");
    }

    let (parts, body) = request.into_parts();
    let body = match to_bytes(body, MAX_REQUEST_BYTES).await {
        Ok(body) => body,
        Err(error) => {
            return text_response(
                StatusCode::PAYLOAD_TOO_LARGE,
                &format!("Cannot read gateway request: {error}"),
            )
        }
    };
    let path_and_query = parts
        .uri
        .path_and_query()
        .map(|value| value.as_str())
        .unwrap_or("/");
    let mut request_body = body.to_vec();
    let mut response_model = None;
    let mut response_stream = false;
    let upstream_url = match state.protocol {
        ProviderProtocol::AnthropicMessages => {
            format!("{}{}", state.upstream_base_url, path_and_query)
        }
        ProviderProtocol::OpenAiChatCompletions | ProviderProtocol::GeminiGenerateContent => {
            if parts.uri.path().ends_with("/messages/count_tokens") {
                return openai_count_tokens_response(&request_body);
            }
            if !parts.uri.path().ends_with("/messages") {
                return text_response(
                    StatusCode::NOT_FOUND,
                    "The provider translation gateway supports the Anthropic Messages endpoint",
                );
            }
            let anthropic_request: Value = match serde_json::from_slice(&request_body) {
                Ok(value) => value,
                Err(error) => {
                    return text_response(
                        StatusCode::BAD_REQUEST,
                        &format!("Invalid Anthropic request JSON: {error}"),
                    )
                }
            };
            let model = match anthropic_request.get("model").and_then(Value::as_str) {
                Some(model) if !model.trim().is_empty() => model.trim().to_string(),
                _ => {
                    return text_response(StatusCode::BAD_REQUEST, "Anthropic request has no model")
                }
            };
            response_model = Some(model.clone());
            response_stream = anthropic_request
                .get("stream")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let translated = match state.protocol {
                ProviderProtocol::OpenAiChatCompletions => anthropic_to_openai_request(
                    &anthropic_request,
                    is_official_openai_base_url(&state.upstream_base_url),
                ),
                ProviderProtocol::GeminiGenerateContent => {
                    anthropic_to_gemini_request(&anthropic_request)
                }
                ProviderProtocol::AnthropicMessages => unreachable!(),
            };
            let translated = match translated {
                Ok(value) => value,
                Err(error) => return text_response(StatusCode::BAD_REQUEST, &error),
            };
            request_body = match serde_json::to_vec(&translated) {
                Ok(value) => value,
                Err(error) => {
                    return text_response(
                        StatusCode::BAD_REQUEST,
                        &format!("Cannot encode provider request: {error}"),
                    )
                }
            };
            match state.protocol {
                ProviderProtocol::OpenAiChatCompletions => {
                    openai_chat_completions_url(&state.upstream_base_url)
                }
                ProviderProtocol::GeminiGenerateContent => match gemini_generate_content_url(
                    &state.upstream_base_url,
                    &model,
                    response_stream,
                ) {
                    Ok(url) => url,
                    Err(error) => return text_response(StatusCode::BAD_REQUEST, &error),
                },
                ProviderProtocol::AnthropicMessages => unreachable!(),
            }
        }
    };
    let mut upstream = state.client.request(parts.method, upstream_url);
    for (name, value) in &parts.headers {
        if should_forward_request_header(name)
            && !(state.protocol.uses_translation_gateway() && is_anthropic_request_header(name))
        {
            upstream = upstream.header(name, value);
        }
    }
    upstream = match state.auth_scheme {
        ProviderAuthScheme::Bearer => upstream
            .header(
                header::AUTHORIZATION,
                format!("Bearer {}", state.upstream_api_key),
            )
            .header(header::CONTENT_TYPE, "application/json")
            .body(request_body),
        ProviderAuthScheme::XApiKey => upstream
            .header("x-api-key", &state.upstream_api_key)
            .body(request_body),
        ProviderAuthScheme::XGoogApiKey => upstream
            .header("x-goog-api-key", &state.upstream_api_key)
            .header(header::CONTENT_TYPE, "application/json")
            .body(request_body),
    };

    let response = match upstream.send().await {
        Ok(response) => response,
        Err(error) => {
            return text_response(
                StatusCode::BAD_GATEWAY,
                &format!("Provider gateway upstream request failed: {error}"),
            )
        }
    };

    if state.protocol.uses_translation_gateway() {
        if !response.status().is_success() {
            return openai_error_response(response).await;
        }
        let model = response_model.unwrap_or_else(|| "unknown".to_string());
        return match (state.protocol, response_stream) {
            (ProviderProtocol::OpenAiChatCompletions, true) => {
                openai_stream_response(response, model)
            }
            (ProviderProtocol::OpenAiChatCompletions, false) => {
                openai_json_response(response, model).await
            }
            (ProviderProtocol::GeminiGenerateContent, true) => {
                gemini_stream_response(response, model)
            }
            (ProviderProtocol::GeminiGenerateContent, false) => {
                gemini_json_response(response, model).await
            }
            (ProviderProtocol::AnthropicMessages, _) => unreachable!(),
        };
    }

    let status = response.status();
    let mut builder = Response::builder().status(status);
    for (name, value) in response.headers() {
        if should_forward_response_header(name) {
            builder = builder.header(name, value);
        }
    }
    builder
        .body(Body::from_stream(response.bytes_stream()))
        .unwrap_or_else(|error| {
            text_response(
                StatusCode::BAD_GATEWAY,
                &format!("Cannot build gateway response: {error}"),
            )
        })
}

pub(crate) fn openai_chat_completions_url(base_url: &str) -> String {
    let base = base_url.trim().trim_end_matches('/');
    if base.ends_with("/chat/completions") {
        return base.to_string();
    }
    if is_official_openai_base_url(base) {
        if let Ok(parsed) = reqwest::Url::parse(base) {
            if parsed.path().is_empty() || parsed.path() == "/" {
                return format!("{base}/v1/chat/completions");
            }
        }
    }
    format!("{base}/chat/completions")
}

pub(crate) fn gemini_generate_content_url(
    base_url: &str,
    model: &str,
    stream: bool,
) -> Result<String, String> {
    let base = base_url.trim().trim_end_matches('/');
    if base.is_empty() {
        return Err("Gemini provider requires a base URL".to_string());
    }
    let model = model.trim().strip_prefix("models/").unwrap_or(model.trim());
    if model.is_empty()
        || model
            .chars()
            .any(|character| !(character.is_ascii_alphanumeric() || "._-".contains(character)))
    {
        return Err(format!(
            "Gemini model id '{model}' contains unsupported path characters"
        ));
    }
    let method = if stream {
        "streamGenerateContent?alt=sse"
    } else {
        "generateContent"
    };
    let separator = if base.ends_with("/models") {
        "/"
    } else {
        "/models/"
    };
    Ok(format!("{base}{separator}{model}:{method}"))
}

pub(crate) fn openai_uses_max_completion_tokens(base_url: &str, model: &str) -> bool {
    is_official_openai_base_url(base_url) || requires_max_completion_tokens(model)
}

fn is_official_openai_base_url(base_url: &str) -> bool {
    reqwest::Url::parse(base_url)
        .ok()
        .and_then(|url| url.host_str().map(str::to_ascii_lowercase))
        .is_some_and(|host| host == "api.openai.com")
}

fn openai_count_tokens_response(request_body: &[u8]) -> Response<Body> {
    let approximate_tokens = serde_json::from_slice::<Value>(request_body)
        .ok()
        .map(|value| value.to_string().chars().count().div_ceil(4))
        .unwrap_or(0);
    json_response(
        StatusCode::OK,
        json!({ "input_tokens": approximate_tokens }),
    )
}

fn anthropic_to_openai_request(input: &Value, official_openai: bool) -> Result<Value, String> {
    let mut messages = Vec::new();
    if let Some(system) = input.get("system") {
        let text = content_as_text(system);
        if !text.is_empty() {
            let role = if official_openai {
                "developer"
            } else {
                "system"
            };
            messages.push(json!({ "role": role, "content": text }));
        }
    }
    for message in input
        .get("messages")
        .and_then(Value::as_array)
        .ok_or_else(|| "Anthropic request has no messages array".to_string())?
    {
        translate_anthropic_message(message, &mut messages)?;
    }

    let mut output = serde_json::Map::new();
    let model = input
        .get("model")
        .cloned()
        .ok_or_else(|| "Anthropic request has no model".to_string())?;
    output.insert("model".to_string(), model);
    output.insert("messages".to_string(), Value::Array(messages));
    if let Some(value) = input.get("max_tokens") {
        let model = input.get("model").and_then(Value::as_str).unwrap_or("");
        let target = if official_openai || requires_max_completion_tokens(model) {
            "max_completion_tokens"
        } else {
            "max_tokens"
        };
        output.insert(target.to_string(), value.clone());
    }
    for (source, target) in [
        ("temperature", "temperature"),
        ("top_p", "top_p"),
        ("stop_sequences", "stop"),
        ("stream", "stream"),
    ] {
        if let Some(value) = input.get(source) {
            output.insert(target.to_string(), value.clone());
        }
    }
    if official_openai && input.get("stream").and_then(Value::as_bool) == Some(true) {
        output.insert(
            "stream_options".to_string(),
            json!({ "include_usage": true }),
        );
    }
    if let Some(tools) = input.get("tools").and_then(Value::as_array) {
        let tools = tools
            .iter()
            .map(|tool| {
                json!({
                    "type": "function",
                    "function": {
                        "name": tool.get("name").cloned().unwrap_or(Value::String("tool".to_string())),
                        "description": tool.get("description").cloned().unwrap_or(Value::String(String::new())),
                        "parameters": tool.get("input_schema").cloned().unwrap_or_else(|| json!({"type":"object"}))
                    }
                })
            })
            .collect::<Vec<_>>();
        output.insert("tools".to_string(), Value::Array(tools));
    }
    if let Some(choice) = input.get("tool_choice") {
        output.insert("tool_choice".to_string(), translate_tool_choice(choice));
        if let Some(disable_parallel) = choice
            .get("disable_parallel_tool_use")
            .and_then(Value::as_bool)
        {
            output.insert(
                "parallel_tool_calls".to_string(),
                Value::Bool(!disable_parallel),
            );
        }
    }
    let request_model = input.get("model").and_then(Value::as_str).unwrap_or("");
    if requires_max_completion_tokens(request_model) {
        if let Some(effort) = input
            .pointer("/output_config/effort")
            .or_else(|| input.get("effort"))
            .cloned()
        {
            output.insert("reasoning_effort".to_string(), effort);
        }
    }
    if let Some(user) = input.pointer("/metadata/user_id").and_then(Value::as_str) {
        output.insert("user".to_string(), Value::String(user.to_string()));
    }
    Ok(Value::Object(output))
}

fn anthropic_to_gemini_request(input: &Value) -> Result<Value, String> {
    if input
        .pointer("/tool_choice/disable_parallel_tool_use")
        .and_then(Value::as_bool)
        == Some(true)
    {
        return Err(
            "Gemini GenerateContent cannot guarantee disable_parallel_tool_use semantics"
                .to_string(),
        );
    }
    let messages = input
        .get("messages")
        .and_then(Value::as_array)
        .ok_or_else(|| "Anthropic request has no messages array".to_string())?;
    let mut tool_names = HashMap::<String, String>::new();
    let mut contents = Vec::new();

    for message in messages {
        let source_role = message
            .get("role")
            .and_then(Value::as_str)
            .ok_or_else(|| "Anthropic message has no role".to_string())?;
        let role = if source_role == "assistant" {
            "model"
        } else {
            "user"
        };
        let content = message.get("content").unwrap_or(&Value::Null);
        let mut parts = Vec::new();
        if let Some(text) = content.as_str() {
            parts.push(json!({ "text": text }));
        } else if let Some(blocks) = content.as_array() {
            for block in blocks {
                match block.get("type").and_then(Value::as_str) {
                    Some("text") => {
                        if let Some(text) = block.get("text").and_then(Value::as_str) {
                            parts.push(json!({ "text": text }));
                        }
                    }
                    Some("image") => {
                        parts.push(anthropic_image_to_gemini(block)?);
                    }
                    Some("tool_use") if source_role == "assistant" => {
                        let id = block
                            .get("id")
                            .and_then(Value::as_str)
                            .map(str::trim)
                            .filter(|value| !value.is_empty())
                            .ok_or_else(|| "Anthropic tool_use block has no stable id".to_string())?
                            .to_string();
                        let name = block
                            .get("name")
                            .and_then(Value::as_str)
                            .map(str::trim)
                            .filter(|value| !value.is_empty())
                            .ok_or_else(|| "Anthropic tool_use block has no name".to_string())?
                            .to_string();
                        tool_names.insert(id.clone(), name.clone());
                        parts.push(json!({
                            "functionCall": {
                                "id": id,
                                "name": name,
                                "args": block.get("input").cloned().unwrap_or_else(|| json!({}))
                            }
                        }));
                    }
                    Some("tool_result") if source_role == "user" => {
                        let id = block
                            .get("tool_use_id")
                            .and_then(Value::as_str)
                            .map(str::trim)
                            .filter(|value| !value.is_empty())
                            .ok_or_else(|| {
                                "Anthropic tool_result block has no tool_use_id".to_string()
                            })?
                            .to_string();
                        let name = tool_names.get(&id).cloned().ok_or_else(|| {
                            format!("Anthropic tool_result references unknown tool_use id '{id}'")
                        })?;
                        let response = gemini_function_response_payload(block);
                        parts.push(json!({
                            "functionResponse": {
                                "id": id,
                                "name": name,
                                "response": response
                            }
                        }));
                        if let Some(result_blocks) = block.get("content").and_then(Value::as_array)
                        {
                            for result_block in result_blocks {
                                if result_block.get("type").and_then(Value::as_str) == Some("image")
                                {
                                    parts.push(anthropic_image_to_gemini(result_block)?);
                                }
                            }
                        }
                    }
                    Some(kind) => {
                        return Err(format!(
                            "Unsupported Anthropic content block '{kind}' for Gemini"
                        ));
                    }
                    None => {
                        return Err("Anthropic content block has no type".to_string());
                    }
                }
            }
        }
        if parts.is_empty() {
            parts.push(json!({ "text": "" }));
        }
        contents.push(json!({ "role": role, "parts": parts }));
    }

    let mut output = serde_json::Map::new();
    output.insert("contents".to_string(), Value::Array(contents));
    if let Some(system) = input.get("system") {
        let text = content_as_text(system);
        if !text.is_empty() {
            output.insert(
                "systemInstruction".to_string(),
                json!({ "parts": [{ "text": text }] }),
            );
        }
    }

    let mut generation_config = serde_json::Map::new();
    for (source, target) in [
        ("max_tokens", "maxOutputTokens"),
        ("temperature", "temperature"),
        ("top_p", "topP"),
        ("stop_sequences", "stopSequences"),
    ] {
        if let Some(value) = input.get(source) {
            generation_config.insert(target.to_string(), value.clone());
        }
    }
    if !generation_config.is_empty() {
        output.insert(
            "generationConfig".to_string(),
            Value::Object(generation_config),
        );
    }

    if let Some(tools) = input.get("tools").and_then(Value::as_array) {
        let declarations = tools
            .iter()
            .map(|tool| -> Result<Value, String> {
                let name = tool
                    .get("name")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| "Anthropic tool declaration has no name".to_string())?;
                Ok(json!({
                    "name": name,
                    "description": tool.get("description").cloned().unwrap_or(Value::String(String::new())),
                    "parameters": tool.get("input_schema").cloned().unwrap_or_else(|| json!({ "type": "object" }))
                }))
            })
            .collect::<Result<Vec<_>, _>>()?;
        output.insert(
            "tools".to_string(),
            json!([{ "functionDeclarations": declarations }]),
        );
    }
    if let Some(choice) = input.get("tool_choice") {
        let source_type = choice.get("type").and_then(Value::as_str).unwrap_or("auto");
        let mode = match source_type {
            "any" | "tool" => "ANY",
            "none" => "NONE",
            _ => "AUTO",
        };
        let mut function_config = serde_json::Map::new();
        function_config.insert("mode".to_string(), Value::String(mode.to_string()));
        if source_type == "tool" {
            let name = choice
                .get("name")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "Anthropic tool_choice has no tool name".to_string())?;
            function_config.insert("allowedFunctionNames".to_string(), json!([name]));
        }
        output.insert(
            "toolConfig".to_string(),
            json!({ "functionCallingConfig": function_config }),
        );
    }

    Ok(Value::Object(output))
}

fn anthropic_image_to_gemini(block: &Value) -> Result<Value, String> {
    let source = block
        .get("source")
        .ok_or_else(|| "Anthropic image block has no source".to_string())?;
    match source.get("type").and_then(Value::as_str) {
        Some("base64") => {
            let data = source
                .get("data")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "Anthropic base64 image has no data".to_string())?;
            Ok(json!({
                "inlineData": {
                    "mimeType": source
                        .get("media_type")
                        .and_then(Value::as_str)
                        .unwrap_or("image/png"),
                    "data": data
                }
            }))
        }
        Some("url") => Err(
            "Anthropic URL images are not supported by the first native Gemini adapter; use base64"
                .to_string(),
        ),
        Some(kind) => Err(format!("Unsupported Anthropic image source type '{kind}'")),
        None => Err("Anthropic image source has no type".to_string()),
    }
}

fn gemini_function_response_payload(block: &Value) -> Value {
    let content = block.get("content").unwrap_or(&Value::Null);
    let key = if block.get("is_error").and_then(Value::as_bool) == Some(true) {
        "error"
    } else {
        "result"
    };
    // Gemini functionResponse cannot embed Anthropic image blocks. Keep the
    // textual result here; image results are emitted as adjacent inlineData
    // parts by anthropic_to_gemini_request.
    let value = Value::String(content_as_text(content));
    let mut response = serde_json::Map::new();
    response.insert(key.to_string(), value);
    Value::Object(response)
}

fn requires_max_completion_tokens(model: &str) -> bool {
    let model = model
        .rsplit('/')
        .next()
        .unwrap_or(model)
        .to_ascii_lowercase();
    model.starts_with("gpt-5")
        || model.starts_with("o1")
        || model.starts_with("o3")
        || model.starts_with("o4")
}

fn translate_anthropic_message(message: &Value, output: &mut Vec<Value>) -> Result<(), String> {
    let role = message
        .get("role")
        .and_then(Value::as_str)
        .ok_or_else(|| "Anthropic message has no role".to_string())?;
    let content = message.get("content").unwrap_or(&Value::Null);
    if let Some(text) = content.as_str() {
        output.push(json!({ "role": role, "content": text }));
        return Ok(());
    }
    let Some(blocks) = content.as_array() else {
        output.push(json!({ "role": role, "content": "" }));
        return Ok(());
    };

    if role == "assistant" {
        let mut text = String::new();
        let mut tool_calls = Vec::new();
        for block in blocks {
            match block.get("type").and_then(Value::as_str) {
                Some("text") => {
                    if let Some(value) = block.get("text").and_then(Value::as_str) {
                        text.push_str(value);
                    }
                }
                Some("tool_use") => {
                    let arguments = serde_json::to_string(block.get("input").unwrap_or(&json!({})))
                        .map_err(|error| format!("Cannot encode tool input: {error}"))?;
                    tool_calls.push(json!({
                        "id": block.get("id").cloned().unwrap_or_else(|| Value::String(format!("call_{}", uuid::Uuid::new_v4().simple()))),
                        "type": "function",
                        "function": {
                            "name": block.get("name").cloned().unwrap_or(Value::String("tool".to_string())),
                            "arguments": arguments
                        }
                    }));
                }
                _ => {}
            }
        }
        let mut translated = json!({ "role": "assistant", "content": text });
        if !tool_calls.is_empty() {
            translated["tool_calls"] = Value::Array(tool_calls);
        }
        output.push(translated);
        return Ok(());
    }

    let mut user_parts = Vec::new();
    for block in blocks {
        match block.get("type").and_then(Value::as_str) {
            Some("tool_result") => {
                if !user_parts.is_empty() {
                    output.push(json!({ "role": "user", "content": user_parts }));
                    user_parts = Vec::new();
                }
                output.push(json!({
                    "role": "tool",
                    "tool_call_id": block.get("tool_use_id").cloned().unwrap_or(Value::String(String::new())),
                    "content": content_as_text(block.get("content").unwrap_or(&Value::Null))
                }));
                if let Some(result_blocks) = block.get("content").and_then(Value::as_array) {
                    let images = result_blocks
                        .iter()
                        .filter(|result_block| {
                            result_block.get("type").and_then(Value::as_str) == Some("image")
                        })
                        .filter_map(anthropic_image_to_openai)
                        .collect::<Vec<_>>();
                    if !images.is_empty() {
                        // Chat Completions tool messages accept textual content.
                        // Preserve vision input in a following user turn instead
                        // of flattening the image into an unusable JSON string.
                        output.push(json!({ "role": "user", "content": images }));
                    }
                }
            }
            Some("text") => user_parts.push(json!({
                "type": "text",
                "text": block.get("text").cloned().unwrap_or(Value::String(String::new()))
            })),
            Some("image") => {
                if let Some(image) = anthropic_image_to_openai(block) {
                    user_parts.push(image);
                }
            }
            _ => {}
        }
    }
    if !user_parts.is_empty() {
        output.push(json!({ "role": "user", "content": user_parts }));
    }
    Ok(())
}

fn anthropic_image_to_openai(block: &Value) -> Option<Value> {
    let source = block.get("source")?;
    let url = match source.get("type").and_then(Value::as_str) {
        Some("base64") => format!(
            "data:{};base64,{}",
            source
                .get("media_type")
                .and_then(Value::as_str)
                .unwrap_or("image/png"),
            source.get("data").and_then(Value::as_str).unwrap_or("")
        ),
        Some("url") => source.get("url")?.as_str()?.to_string(),
        _ => return None,
    };
    Some(json!({ "type": "image_url", "image_url": { "url": url } }))
}

fn content_as_text(content: &Value) -> String {
    if let Some(text) = content.as_str() {
        return text.to_string();
    }
    content
        .as_array()
        .map(|blocks| {
            blocks
                .iter()
                .filter_map(|block| block.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_else(|| {
            if content.is_null() {
                String::new()
            } else {
                content.to_string()
            }
        })
}

fn translate_tool_choice(choice: &Value) -> Value {
    match choice.get("type").and_then(Value::as_str) {
        Some("any") => Value::String("required".to_string()),
        Some("tool") => json!({
            "type": "function",
            "function": { "name": choice.get("name").cloned().unwrap_or(Value::String("tool".to_string())) }
        }),
        Some("none") => Value::String("none".to_string()),
        _ => Value::String("auto".to_string()),
    }
}

async fn openai_json_response(
    response: reqwest::Response,
    fallback_model: String,
) -> Response<Body> {
    let status = response.status();
    let payload: Value = match response.json().await {
        Ok(value) => value,
        Err(error) => {
            return text_response(
                StatusCode::BAD_GATEWAY,
                &format!("Cannot parse OpenAI response: {error}"),
            )
        }
    };
    match openai_to_anthropic_message(&payload, &fallback_model) {
        Ok(value) => json_response(status, value),
        Err(error) => text_response(StatusCode::BAD_GATEWAY, &error),
    }
}

async fn openai_error_response(response: reqwest::Response) -> Response<Body> {
    let status = response.status();
    let headers = response.headers().clone();
    let request_id = headers
        .get("x-request-id")
        .or_else(|| headers.get("request-id"))
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let retry_after = headers.get(header::RETRY_AFTER).cloned();
    let bytes = match response.bytes().await {
        Ok(bytes) => bytes,
        Err(error) => {
            return text_response(
                StatusCode::BAD_GATEWAY,
                &format!("Cannot read OpenAI error response: {error}"),
            )
        }
    };
    let payload = serde_json::from_slice::<Value>(&bytes).unwrap_or_else(|_| {
        let message = String::from_utf8_lossy(&bytes)
            .chars()
            .take(4096)
            .collect::<String>();
        json!({ "error": { "message": message } })
    });
    let mut translated = anthropic_error_payload(&payload, Some(status));
    if let (Some(request_id), Some(object)) = (request_id, translated.as_object_mut()) {
        object.insert("request_id".to_string(), Value::String(request_id));
    }
    let mut builder = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/json");
    if let Some(retry_after) = retry_after {
        builder = builder.header(header::RETRY_AFTER, retry_after);
    }
    builder
        .body(Body::from(translated.to_string()))
        .unwrap_or_else(|_| Response::new(Body::empty()))
}

fn anthropic_error_payload(payload: &Value, status: Option<StatusCode>) -> Value {
    let upstream_error = payload.get("error").unwrap_or(payload);
    let message = upstream_error
        .get("message")
        .and_then(Value::as_str)
        .or_else(|| payload.get("message").and_then(Value::as_str))
        .unwrap_or("Provider returned an error");
    let upstream_type = upstream_error
        .get("type")
        .or_else(|| upstream_error.get("status"))
        .and_then(Value::as_str);
    let error_type = match status {
        Some(StatusCode::UNAUTHORIZED) => "authentication_error",
        Some(StatusCode::FORBIDDEN) => "permission_error",
        Some(StatusCode::TOO_MANY_REQUESTS) => "rate_limit_error",
        Some(value) if value.is_client_error() => "invalid_request_error",
        Some(value) if value.is_server_error() => "api_error",
        _ => match upstream_type {
            Some("authentication_error") | Some("invalid_api_key") | Some("UNAUTHENTICATED") => {
                "authentication_error"
            }
            Some("permission_error") | Some("insufficient_quota") | Some("PERMISSION_DENIED") => {
                "permission_error"
            }
            Some("rate_limit_error") | Some("RESOURCE_EXHAUSTED") => "rate_limit_error",
            Some("invalid_request_error")
            | Some("INVALID_ARGUMENT")
            | Some("FAILED_PRECONDITION")
            | Some("NOT_FOUND") => "invalid_request_error",
            _ => "api_error",
        },
    };
    json!({
        "type": "error",
        "error": {
            "type": error_type,
            "message": message
        }
    })
}

fn openai_to_anthropic_message(payload: &Value, fallback_model: &str) -> Result<Value, String> {
    let choice = payload
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .ok_or_else(|| "OpenAI response has no choices".to_string())?;
    let message = choice
        .get("message")
        .ok_or_else(|| "OpenAI response choice has no message".to_string())?;
    let mut content = Vec::new();
    if let Some(text) = message.get("content").and_then(Value::as_str) {
        if !text.is_empty() {
            content.push(json!({ "type": "text", "text": text }));
        }
    }
    if let Some(tool_calls) = message.get("tool_calls").and_then(Value::as_array) {
        for call in tool_calls {
            let arguments = call
                .pointer("/function/arguments")
                .and_then(Value::as_str)
                .and_then(|value| serde_json::from_str(value).ok())
                .unwrap_or_else(|| json!({}));
            content.push(json!({
                "type": "tool_use",
                "id": call.get("id").cloned().unwrap_or_else(|| Value::String(format!("call_{}", uuid::Uuid::new_v4().simple()))),
                "name": call.pointer("/function/name").cloned().unwrap_or(Value::String("tool".to_string())),
                "input": arguments
            }));
        }
    }
    let usage = payload.get("usage").cloned().unwrap_or_else(|| json!({}));
    Ok(json!({
        "id": payload.get("id").cloned().unwrap_or_else(|| Value::String(format!("msg_{}", uuid::Uuid::new_v4().simple()))),
        "type": "message",
        "role": "assistant",
        "content": content,
        "model": payload.get("model").cloned().unwrap_or(Value::String(fallback_model.to_string())),
        "stop_reason": map_finish_reason(choice.get("finish_reason").and_then(Value::as_str)),
        "stop_sequence": Value::Null,
        "usage": {
            "input_tokens": usage.get("prompt_tokens").cloned().unwrap_or(Value::from(0)),
            "output_tokens": usage.get("completion_tokens").cloned().unwrap_or(Value::from(0))
        }
    }))
}

async fn gemini_json_response(
    response: reqwest::Response,
    fallback_model: String,
) -> Response<Body> {
    let status = response.status();
    let payload: Value = match response.json().await {
        Ok(value) => value,
        Err(error) => {
            return text_response(
                StatusCode::BAD_GATEWAY,
                &format!("Cannot parse Gemini response: {error}"),
            )
        }
    };
    match gemini_to_anthropic_message(&payload, &fallback_model) {
        Ok(value) => json_response(status, value),
        Err(error) => json_response(
            StatusCode::BAD_GATEWAY,
            json!({
                "type": "error",
                "error": { "type": "api_error", "message": error }
            }),
        ),
    }
}

fn gemini_to_anthropic_message(payload: &Value, fallback_model: &str) -> Result<Value, String> {
    let candidate = payload
        .get("candidates")
        .and_then(Value::as_array)
        .and_then(|candidates| candidates.first())
        .ok_or_else(|| {
            payload
                .pointer("/promptFeedback/blockReason")
                .and_then(Value::as_str)
                .map(|reason| format!("Gemini blocked the prompt: {reason}"))
                .unwrap_or_else(|| "Gemini response has no candidates".to_string())
        })?;
    if let Some(error) = gemini_finish_error(candidate.get("finishReason").and_then(Value::as_str))
    {
        return Err(error);
    }
    let parts = candidate
        .pointer("/content/parts")
        .and_then(Value::as_array)
        .ok_or_else(|| "Gemini response candidate has no content parts".to_string())?;
    let message_id = format!("msg_{}", uuid::Uuid::new_v4().simple());
    let mut content = Vec::new();
    let mut has_tool_use = false;
    let mut seen_tool_ids = HashSet::new();
    for (part_index, part) in parts.iter().enumerate() {
        if let Some(text) = part.get("text").and_then(Value::as_str) {
            if !text.is_empty() {
                content.push(json!({ "type": "text", "text": text }));
            }
        }
        if let Some(call) = part.get("functionCall") {
            let name = call
                .get("name")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "Gemini functionCall has no name".to_string())?;
            let input = call.get("args").cloned().unwrap_or_else(|| json!({}));
            if !input.is_object() {
                return Err(format!(
                    "Gemini functionCall '{name}' has non-object arguments"
                ));
            }
            let id = call
                .get("id")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| {
                    format!(
                        "call_{}_{}",
                        message_id.trim_start_matches("msg_"),
                        part_index
                    )
                });
            if !seen_tool_ids.insert(id.clone()) {
                return Err(format!("Gemini reused functionCall id '{id}'"));
            }
            has_tool_use = true;
            content.push(json!({
                "type": "tool_use",
                "id": id,
                "name": name,
                "input": input
            }));
        }
    }
    let usage = payload
        .get("usageMetadata")
        .cloned()
        .unwrap_or_else(|| json!({}));
    Ok(json!({
        "id": message_id,
        "type": "message",
        "role": "assistant",
        "content": content,
        "model": payload
            .get("modelVersion")
            .cloned()
            .unwrap_or(Value::String(fallback_model.to_string())),
        "stop_reason": map_gemini_finish_reason(
            candidate.get("finishReason").and_then(Value::as_str),
            has_tool_use,
        ),
        "stop_sequence": Value::Null,
        "usage": {
            "input_tokens": usage
                .get("promptTokenCount")
                .cloned()
                .unwrap_or(Value::from(0)),
            "output_tokens": usage
                .get("candidatesTokenCount")
                .cloned()
                .unwrap_or(Value::from(0))
        }
    }))
}

fn map_gemini_finish_reason(reason: Option<&str>, has_tool_use: bool) -> &'static str {
    if has_tool_use {
        return "tool_use";
    }
    match reason {
        Some("MAX_TOKENS") => "max_tokens",
        _ => "end_turn",
    }
}

fn gemini_finish_error(reason: Option<&str>) -> Option<String> {
    match reason {
        Some(
            reason @ ("SAFETY"
            | "RECITATION"
            | "LANGUAGE"
            | "BLOCKLIST"
            | "PROHIBITED_CONTENT"
            | "SPII"
            | "MALFORMED_FUNCTION_CALL"
            | "IMAGE_SAFETY"
            | "UNEXPECTED_TOOL_CALL"),
        ) => Some(format!("Gemini stopped the response because of {reason}")),
        _ => None,
    }
}

struct GeminiStreamState {
    message_id: String,
    model: String,
    started: bool,
    finished: bool,
    failed: bool,
    saw_candidate: bool,
    active_block: Option<GeminiActiveBlock>,
    completed_tool_ids: HashMap<String, (String, String)>,
    next_content_index: u64,
    input_tokens: u64,
    output_tokens: u64,
    finish_reason: Option<String>,
    has_tool_use: bool,
}

enum GeminiActiveBlock {
    Text {
        index: u64,
    },
    Tool {
        index: u64,
        id: String,
        name: String,
        arguments: String,
    },
}

impl GeminiStreamState {
    fn new(model: String) -> Self {
        Self {
            message_id: format!("msg_{}", uuid::Uuid::new_v4().simple()),
            model,
            started: false,
            finished: false,
            failed: false,
            saw_candidate: false,
            active_block: None,
            completed_tool_ids: HashMap::new(),
            next_content_index: 0,
            input_tokens: 0,
            output_tokens: 0,
            finish_reason: None,
            has_tool_use: false,
        }
    }

    fn accept(&mut self, payload: &Value) -> Vec<Bytes> {
        if payload.get("error").is_some() {
            self.failed = true;
            self.finished = true;
            return vec![sse_event("error", anthropic_error_payload(payload, None))];
        }
        if let Some(reason) = payload
            .pointer("/promptFeedback/blockReason")
            .and_then(Value::as_str)
        {
            return self.fail(format!("Gemini blocked the prompt because of {reason}"));
        }
        if let Some(model) = payload.get("modelVersion").and_then(Value::as_str) {
            self.model = model.to_string();
        }
        if let Some(usage) = payload.get("usageMetadata") {
            self.input_tokens = usage
                .get("promptTokenCount")
                .and_then(Value::as_u64)
                .unwrap_or(self.input_tokens);
            self.output_tokens = usage
                .get("candidatesTokenCount")
                .and_then(Value::as_u64)
                .unwrap_or(self.output_tokens);
        }

        let Some(candidate) = payload
            .get("candidates")
            .and_then(Value::as_array)
            .and_then(|candidates| candidates.first())
        else {
            return Vec::new();
        };
        self.saw_candidate = true;
        if let Some(reason) = candidate.get("finishReason").and_then(Value::as_str) {
            if let Some(error) = gemini_finish_error(Some(reason)) {
                return self.fail(error);
            }
            self.finish_reason = Some(reason.to_string());
        }
        let mut events = Vec::new();
        self.ensure_started(&mut events);
        let Some(parts) = candidate
            .pointer("/content/parts")
            .and_then(Value::as_array)
        else {
            return events;
        };
        let mut payload_tool_ids = HashSet::new();
        for (part_index, part) in parts.iter().enumerate() {
            if let Some(text) = part
                .get("text")
                .and_then(Value::as_str)
                .filter(|text| !text.is_empty())
            {
                let index = match self.active_block.as_ref() {
                    Some(GeminiActiveBlock::Text { index }) => *index,
                    _ => {
                        self.finish_active_block(&mut events);
                        let index = self.allocate_block_index();
                        self.active_block = Some(GeminiActiveBlock::Text { index });
                        events.push(sse_event(
                            "content_block_start",
                            json!({
                                "type": "content_block_start",
                                "index": index,
                                "content_block": { "type": "text", "text": "" }
                            }),
                        ));
                        index
                    }
                };
                events.push(sse_event(
                    "content_block_delta",
                    json!({
                        "type": "content_block_delta",
                        "index": index,
                        "delta": { "type": "text_delta", "text": text }
                    }),
                ));
            }
            if let Some(call) = part.get("functionCall") {
                let name = match call
                    .get("name")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                {
                    Some(name) => name.to_string(),
                    None => return self.fail("Gemini functionCall has no name".to_string()),
                };
                let call_arguments = call.get("args").cloned().unwrap_or_else(|| json!({}));
                if !call_arguments.is_object() {
                    return self.fail(format!(
                        "Gemini functionCall '{name}' has non-object arguments"
                    ));
                }
                let id = call
                    .get("id")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string)
                    .unwrap_or_else(|| {
                        format!(
                            "call_{}_{}",
                            self.message_id.trim_start_matches("msg_"),
                            part_index
                        )
                    });
                if !payload_tool_ids.insert(id.clone()) {
                    return self.fail(format!(
                        "Gemini repeated function call '{id}' in one stream payload"
                    ));
                }
                let arguments = match serde_json::to_string(&call_arguments) {
                    Ok(arguments) => arguments,
                    Err(error) => {
                        return self.fail(format!(
                            "Cannot encode Gemini functionCall '{name}' arguments: {error}"
                        ))
                    }
                };
                if self.completed_tool_ids.contains_key(&id) {
                    return self.fail(format!(
                        "Gemini reused completed function call '{id}' ambiguously"
                    ));
                }
                if let Some(GeminiActiveBlock::Tool {
                    id: active_id,
                    name: active_name,
                    ..
                }) = self.active_block.as_ref()
                {
                    if active_id == &id && active_name != &name {
                        return self.fail(format!(
                            "Gemini changed the name of active function call '{id}'"
                        ));
                    }
                }
                self.has_tool_use = true;
                match self.active_block.as_mut() {
                    Some(GeminiActiveBlock::Tool {
                        id: active_id,
                        arguments: active_arguments,
                        ..
                    }) if *active_id == id => {
                        *active_arguments = arguments;
                    }
                    _ => {
                        self.finish_active_block(&mut events);
                        let index = self.allocate_block_index();
                        events.push(sse_event(
                            "content_block_start",
                            json!({
                                "type": "content_block_start",
                                "index": index,
                                "content_block": {
                                    "type": "tool_use",
                                    "id": id,
                                    "name": name,
                                    "input": {}
                                }
                            }),
                        ));
                        self.active_block = Some(GeminiActiveBlock::Tool {
                            index,
                            id,
                            name,
                            arguments,
                        });
                    }
                }
            }
        }
        events
    }

    fn fail(&mut self, message: String) -> Vec<Bytes> {
        self.failed = true;
        self.finished = true;
        vec![sse_event(
            "error",
            json!({
                "type": "error",
                "error": { "type": "api_error", "message": message }
            }),
        )]
    }

    fn ensure_started(&mut self, events: &mut Vec<Bytes>) {
        if self.started {
            return;
        }
        self.started = true;
        events.push(sse_event(
            "message_start",
            json!({
                "type": "message_start",
                "message": {
                    "id": self.message_id,
                    "type": "message",
                    "role": "assistant",
                    "content": [],
                    "model": self.model,
                    "stop_reason": Value::Null,
                    "stop_sequence": Value::Null,
                    "usage": { "input_tokens": self.input_tokens, "output_tokens": 0 }
                }
            }),
        ));
    }

    fn allocate_block_index(&mut self) -> u64 {
        let index = self.next_content_index;
        self.next_content_index += 1;
        index
    }

    fn finish_active_block(&mut self, events: &mut Vec<Bytes>) {
        let Some(active) = self.active_block.take() else {
            return;
        };
        match active {
            GeminiActiveBlock::Text { index } => {
                events.push(sse_event(
                    "content_block_stop",
                    json!({ "type": "content_block_stop", "index": index }),
                ));
            }
            GeminiActiveBlock::Tool {
                index,
                id,
                name,
                arguments,
            } => {
                events.push(sse_event(
                    "content_block_delta",
                    json!({
                        "type": "content_block_delta",
                        "index": index,
                        "delta": {
                            "type": "input_json_delta",
                            "partial_json": arguments
                        }
                    }),
                ));
                events.push(sse_event(
                    "content_block_stop",
                    json!({ "type": "content_block_stop", "index": index }),
                ));
                self.completed_tool_ids.insert(id, (name, arguments));
            }
        }
    }

    fn finish(&mut self) -> Vec<Bytes> {
        if self.finished || self.failed {
            return Vec::new();
        }
        if !self.saw_candidate {
            return self.fail("Gemini stream ended without a response candidate".to_string());
        }
        self.finished = true;
        let mut events = Vec::new();
        self.ensure_started(&mut events);
        self.finish_active_block(&mut events);
        events.push(sse_event(
            "message_delta",
            json!({
                "type": "message_delta",
                "delta": {
                    "stop_reason": map_gemini_finish_reason(
                        self.finish_reason.as_deref(),
                        self.has_tool_use,
                    ),
                    "stop_sequence": Value::Null
                },
                "usage": { "output_tokens": self.output_tokens }
            }),
        ));
        events.push(sse_event("message_stop", json!({ "type": "message_stop" })));
        events
    }
}

fn drain_gemini_sse_payloads(
    buffer: &mut Vec<u8>,
    frame_data: &mut String,
    end_of_stream: bool,
) -> Result<Vec<Value>, String> {
    let mut payloads = Vec::new();
    while let Some(position) = buffer.iter().position(|byte| *byte == b'\n') {
        let line = buffer.drain(..=position).collect::<Vec<_>>();
        accept_gemini_sse_line(&line, frame_data, &mut payloads)?;
    }
    if end_of_stream && !buffer.is_empty() {
        let line = std::mem::take(buffer);
        accept_gemini_sse_line(&line, frame_data, &mut payloads)?;
    }
    if end_of_stream {
        flush_gemini_sse_frame(frame_data, &mut payloads)?;
    }
    Ok(payloads)
}

fn accept_gemini_sse_line(
    line: &[u8],
    frame_data: &mut String,
    payloads: &mut Vec<Value>,
) -> Result<(), String> {
    let line = std::str::from_utf8(line)
        .map_err(|error| format!("Gemini SSE contains invalid UTF-8: {error}"))?;
    let line = line.trim_end_matches(['\n', '\r']);
    if line.is_empty() {
        return flush_gemini_sse_frame(frame_data, payloads);
    }
    let Some(data) = line.strip_prefix("data:").map(str::trim_start) else {
        return Ok(());
    };
    if !frame_data.is_empty() {
        frame_data.push('\n');
    }
    frame_data.push_str(data);
    Ok(())
}

fn flush_gemini_sse_frame(
    frame_data: &mut String,
    payloads: &mut Vec<Value>,
) -> Result<(), String> {
    if frame_data.is_empty() {
        return Ok(());
    }
    let data = std::mem::take(frame_data);
    let payload = serde_json::from_str::<Value>(&data)
        .map_err(|error| format!("Gemini SSE contains invalid JSON: {error}"))?;
    payloads.push(payload);
    Ok(())
}

fn gemini_stream_response(response: reqwest::Response, fallback_model: String) -> Response<Body> {
    let status = response.status();
    let mut upstream = response.bytes_stream();
    let stream = async_stream::stream! {
        let mut buffer = Vec::<u8>::new();
        let mut frame_data = String::new();
        let mut state = GeminiStreamState::new(fallback_model);
        while let Some(chunk) = upstream.next().await {
            match chunk {
                Ok(chunk) => buffer.extend_from_slice(&chunk),
                Err(error) => {
                    yield Ok::<Bytes, Infallible>(sse_event("error", json!({
                        "type": "error",
                        "error": { "type": "api_error", "message": error.to_string() }
                    })));
                    state.failed = true;
                    break;
                }
            }
            let payloads = match drain_gemini_sse_payloads(&mut buffer, &mut frame_data, false) {
                Ok(payloads) => payloads,
                Err(error) => {
                    yield Ok::<Bytes, Infallible>(sse_event("error", json!({
                        "type": "error",
                        "error": { "type": "api_error", "message": error }
                    })));
                    state.failed = true;
                    break;
                }
            };
            for payload in payloads {
                for event in state.accept(&payload) {
                    yield Ok::<Bytes, Infallible>(event);
                }
                if state.failed {
                    break;
                }
            }
            if state.failed {
                break;
            }
        }
        if !state.failed {
            match drain_gemini_sse_payloads(&mut buffer, &mut frame_data, true) {
                Ok(payloads) => {
                    for payload in payloads {
                        for event in state.accept(&payload) {
                            yield Ok::<Bytes, Infallible>(event);
                        }
                        if state.failed {
                            break;
                        }
                    }
                }
                Err(error) => {
                    yield Ok::<Bytes, Infallible>(sse_event("error", json!({
                        "type": "error",
                        "error": { "type": "api_error", "message": error }
                    })));
                    state.failed = true;
                }
            }
        }
        if !state.failed {
            for event in state.finish() {
                yield Ok::<Bytes, Infallible>(event);
            }
        }
    };
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/event-stream")
        .header(header::CACHE_CONTROL, "no-cache")
        .body(Body::from_stream(stream))
        .unwrap_or_else(|error| {
            text_response(
                StatusCode::BAD_GATEWAY,
                &format!("Cannot build Gemini stream response: {error}"),
            )
        })
}

fn map_finish_reason(reason: Option<&str>) -> &'static str {
    match reason {
        Some("tool_calls") | Some("function_call") => "tool_use",
        Some("length") => "max_tokens",
        Some("stop") => "end_turn",
        _ => "end_turn",
    }
}

struct OpenAiStreamState {
    message_id: String,
    model: String,
    started: bool,
    finished: bool,
    failed: bool,
    text_index: Option<u64>,
    tool_indexes: HashMap<u64, u64>,
    open_blocks: Vec<u64>,
    next_content_index: u64,
    input_tokens: u64,
    output_tokens: u64,
    finish_reason: Option<String>,
}

impl OpenAiStreamState {
    fn new(model: String) -> Self {
        Self {
            message_id: format!("msg_{}", uuid::Uuid::new_v4().simple()),
            model,
            started: false,
            finished: false,
            failed: false,
            text_index: None,
            tool_indexes: HashMap::new(),
            open_blocks: Vec::new(),
            next_content_index: 0,
            input_tokens: 0,
            output_tokens: 0,
            finish_reason: None,
        }
    }

    fn accept(&mut self, payload: &Value) -> Vec<Bytes> {
        if payload.get("error").is_some() {
            self.failed = true;
            self.finished = true;
            return vec![sse_event("error", anthropic_error_payload(payload, None))];
        }
        if let Some(id) = payload.get("id").and_then(Value::as_str) {
            self.message_id = id.to_string();
        }
        if let Some(model) = payload.get("model").and_then(Value::as_str) {
            self.model = model.to_string();
        }
        if let Some(usage) = payload.get("usage") {
            self.input_tokens = usage
                .get("prompt_tokens")
                .and_then(Value::as_u64)
                .unwrap_or(self.input_tokens);
            self.output_tokens = usage
                .get("completion_tokens")
                .and_then(Value::as_u64)
                .unwrap_or(self.output_tokens);
        }

        let mut events = Vec::new();
        self.ensure_started(&mut events);
        let Some(choice) = payload
            .get("choices")
            .and_then(Value::as_array)
            .and_then(|choices| choices.first())
        else {
            return events;
        };
        let delta = choice.get("delta").unwrap_or(&Value::Null);
        if let Some(text) = delta.get("content").and_then(Value::as_str) {
            if !text.is_empty() {
                let index = match self.text_index {
                    Some(index) => index,
                    None => {
                        let index = self.allocate_block();
                        self.text_index = Some(index);
                        events.push(sse_event(
                            "content_block_start",
                            json!({
                                "type": "content_block_start",
                                "index": index,
                                "content_block": { "type": "text", "text": "" }
                            }),
                        ));
                        index
                    }
                };
                events.push(sse_event(
                    "content_block_delta",
                    json!({
                        "type": "content_block_delta",
                        "index": index,
                        "delta": { "type": "text_delta", "text": text }
                    }),
                ));
            }
        }
        if let Some(tool_calls) = delta.get("tool_calls").and_then(Value::as_array) {
            for call in tool_calls {
                let source_index = call.get("index").and_then(Value::as_u64).unwrap_or(0);
                let content_index = match self.tool_indexes.get(&source_index).copied() {
                    Some(index) => index,
                    None => {
                        let index = self.allocate_block();
                        self.tool_indexes.insert(source_index, index);
                        let id = call
                            .get("id")
                            .and_then(Value::as_str)
                            .map(str::to_string)
                            .unwrap_or_else(|| format!("call_{}", uuid::Uuid::new_v4().simple()));
                        let name = call
                            .pointer("/function/name")
                            .and_then(Value::as_str)
                            .unwrap_or("tool");
                        events.push(sse_event(
                            "content_block_start",
                            json!({
                                "type": "content_block_start",
                                "index": index,
                                "content_block": {
                                    "type": "tool_use",
                                    "id": id,
                                    "name": name,
                                    "input": {}
                                }
                            }),
                        ));
                        index
                    }
                };
                if let Some(arguments) = call
                    .pointer("/function/arguments")
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty())
                {
                    events.push(sse_event(
                        "content_block_delta",
                        json!({
                            "type": "content_block_delta",
                            "index": content_index,
                            "delta": {
                                "type": "input_json_delta",
                                "partial_json": arguments
                            }
                        }),
                    ));
                }
            }
        }
        if let Some(reason) = choice.get("finish_reason").and_then(Value::as_str) {
            self.finish_reason = Some(reason.to_string());
        }
        events
    }

    fn ensure_started(&mut self, events: &mut Vec<Bytes>) {
        if self.started {
            return;
        }
        self.started = true;
        events.push(sse_event(
            "message_start",
            json!({
                "type": "message_start",
                "message": {
                    "id": self.message_id,
                    "type": "message",
                    "role": "assistant",
                    "content": [],
                    "model": self.model,
                    "stop_reason": Value::Null,
                    "stop_sequence": Value::Null,
                    "usage": { "input_tokens": self.input_tokens, "output_tokens": 0 }
                }
            }),
        ));
    }

    fn allocate_block(&mut self) -> u64 {
        let index = self.next_content_index;
        self.next_content_index += 1;
        self.open_blocks.push(index);
        index
    }

    fn finish(&mut self) -> Vec<Bytes> {
        if self.finished || self.failed {
            return Vec::new();
        }
        self.finished = true;
        let mut events = Vec::new();
        self.ensure_started(&mut events);
        self.open_blocks.sort_unstable();
        self.open_blocks.dedup();
        for index in &self.open_blocks {
            events.push(sse_event(
                "content_block_stop",
                json!({ "type": "content_block_stop", "index": index }),
            ));
        }
        events.push(sse_event(
            "message_delta",
            json!({
                "type": "message_delta",
                "delta": {
                    "stop_reason": map_finish_reason(self.finish_reason.as_deref()),
                    "stop_sequence": Value::Null
                },
                "usage": { "output_tokens": self.output_tokens }
            }),
        ));
        events.push(sse_event("message_stop", json!({ "type": "message_stop" })));
        events
    }
}

fn openai_stream_response(response: reqwest::Response, fallback_model: String) -> Response<Body> {
    let status = response.status();
    let mut upstream = response.bytes_stream();
    let stream = async_stream::stream! {
        let mut buffer = Vec::<u8>::new();
        let mut state = OpenAiStreamState::new(fallback_model);
        let mut saw_done = false;
        while let Some(chunk) = upstream.next().await {
            match chunk {
                Ok(chunk) => buffer.extend_from_slice(&chunk),
                Err(error) => {
                    let event = sse_event("error", json!({
                        "type": "error",
                        "error": { "type": "api_error", "message": error.to_string() }
                    }));
                    yield Ok::<Bytes, Infallible>(event);
                    saw_done = true;
                    break;
                }
            }
            while let Some(position) = buffer.iter().position(|byte| *byte == b'\n') {
                let mut line = buffer.drain(..=position).collect::<Vec<_>>();
                while matches!(line.last(), Some(b'\n' | b'\r')) {
                    line.pop();
                }
                let Ok(line) = std::str::from_utf8(&line) else {
                    continue;
                };
                let Some(data) = line.strip_prefix("data:").map(str::trim) else {
                    continue;
                };
                if data == "[DONE]" {
                    for event in state.finish() {
                        yield Ok::<Bytes, Infallible>(event);
                    }
                    saw_done = true;
                    break;
                }
                if let Ok(payload) = serde_json::from_str::<Value>(data) {
                    for event in state.accept(&payload) {
                        yield Ok::<Bytes, Infallible>(event);
                    }
                    if state.failed {
                        saw_done = true;
                        break;
                    }
                }
            }
            if saw_done {
                break;
            }
        }
        if !saw_done {
            for event in state.finish() {
                yield Ok::<Bytes, Infallible>(event);
            }
        }
    };
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/event-stream")
        .header(header::CACHE_CONTROL, "no-cache")
        .body(Body::from_stream(stream))
        .unwrap_or_else(|error| {
            text_response(
                StatusCode::BAD_GATEWAY,
                &format!("Cannot build OpenAI stream response: {error}"),
            )
        })
}

fn sse_event(event: &str, payload: Value) -> Bytes {
    Bytes::from(format!("event: {event}\ndata: {payload}\n\n"))
}

fn json_response(status: StatusCode, payload: Value) -> Response<Body> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(payload.to_string()))
        .unwrap_or_else(|_| Response::new(Body::empty()))
}

fn valid_session_token(headers: &HeaderMap, expected: &str) -> bool {
    let x_api_key = headers
        .get("x-api-key")
        .and_then(|value| value.to_str().ok());
    let bearer = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "));
    x_api_key
        .or(bearer)
        .is_some_and(|provided| token_digest(provided) == token_digest(expected))
}

fn token_digest(value: &str) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    Sha256::digest(value.as_bytes()).into()
}

fn should_forward_request_header(name: &HeaderName) -> bool {
    !matches!(
        name.as_str().to_ascii_lowercase().as_str(),
        "authorization"
            | "x-api-key"
            | "x-goog-api-key"
            | "host"
            | "connection"
            | "content-length"
            | "transfer-encoding"
            | "proxy-authorization"
    )
}

fn is_anthropic_request_header(name: &HeaderName) -> bool {
    matches!(
        name.as_str().to_ascii_lowercase().as_str(),
        "anthropic-version" | "anthropic-beta"
    )
}

fn should_forward_response_header(name: &HeaderName) -> bool {
    !matches!(
        name.as_str().to_ascii_lowercase().as_str(),
        "connection" | "content-length" | "transfer-encoding"
    )
}

fn text_response(status: StatusCode, message: &str) -> Response<Body> {
    Response::builder()
        .status(status)
        .header(
            header::CONTENT_TYPE,
            HeaderValue::from_static("text/plain; charset=utf-8"),
        )
        .body(Body::from(message.to_string()))
        .unwrap_or_else(|_| Response::new(Body::empty()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::extract::State;
    use std::{
        net::SocketAddr,
        sync::{
            atomic::{AtomicUsize, Ordering},
            Mutex,
        },
    };

    #[derive(Clone, Default)]
    struct UpstreamCapture {
        requests: Arc<AtomicUsize>,
        api_key: Arc<Mutex<Option<String>>>,
        goog_api_key: Arc<Mutex<Option<String>>>,
        authorization: Arc<Mutex<Option<String>>>,
        path: Arc<Mutex<Option<String>>>,
        body: Arc<Mutex<Option<Value>>>,
    }

    async fn upstream(
        State(capture): State<UpstreamCapture>,
        request: Request<Body>,
    ) -> Response<Body> {
        capture.requests.fetch_add(1, Ordering::SeqCst);
        *capture.api_key.lock().unwrap() = request
            .headers()
            .get("x-api-key")
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        *capture.goog_api_key.lock().unwrap() = request
            .headers()
            .get("x-goog-api-key")
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        *capture.authorization.lock().unwrap() = request
            .headers()
            .get(header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        let path = request.uri().to_string();
        *capture.path.lock().unwrap() = Some(path.clone());
        let bytes = to_bytes(request.into_body(), MAX_REQUEST_BYTES)
            .await
            .unwrap();
        let parsed_body = serde_json::from_slice::<Value>(&bytes).ok();
        *capture.body.lock().unwrap() = parsed_body.clone();
        if path.contains("blocked-stream:streamGenerateContent") {
            return Response::builder()
                .header(header::CONTENT_TYPE, "text/event-stream")
                .body(Body::from(
                    "data: {\"promptFeedback\":{\"blockReason\":\"SAFETY\"}}\n\n",
                ))
                .unwrap();
        }
        if path.contains("malformed-sse:streamGenerateContent") {
            return Response::builder()
                .header(header::CONTENT_TYPE, "text/event-stream")
                .body(Body::from("data: {not-json}\n\n"))
                .unwrap();
        }
        if path.contains(":streamGenerateContent") {
            return Response::builder()
                .header(header::CONTENT_TYPE, "text/event-stream")
                .body(Body::from(concat!(
                    "data: {\"modelVersion\":\"gemini-test\",\"candidates\":[{\"content\":{\"role\":\"model\",\"parts\":[{\"functionCall\":{\"id\":\"call_gemini_1\",\"name\":\"Read\",\"args\":{\"path\":\"/tmp/a\"}}}]},\"finishReason\":\"STOP\"}],\"usageMetadata\":{\"promptTokenCount\":11,\"candidatesTokenCount\":5}}\n\n"
                )))
                .unwrap();
        }
        if path.contains("blocked-json:generateContent") {
            return Response::builder()
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({ "promptFeedback": { "blockReason": "SAFETY" } }).to_string(),
                ))
                .unwrap();
        }
        if path.contains(":generateContent") {
            return Response::builder()
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({
                        "modelVersion": "gemini-test",
                        "candidates": [{
                            "content": { "role": "model", "parts": [{ "text": "hello" }] },
                            "finishReason": "STOP"
                        }],
                        "usageMetadata": { "promptTokenCount": 4, "candidatesTokenCount": 1 }
                    })
                    .to_string(),
                ))
                .unwrap();
        }
        if path.ends_with("/chat/completions") {
            let model = parsed_body
                .as_ref()
                .and_then(|body| body.get("model"))
                .and_then(Value::as_str);
            if model == Some("force-error") {
                return Response::builder()
                    .status(StatusCode::TOO_MANY_REQUESTS)
                    .header("x-request-id", "req_rate_limit")
                    .header(header::RETRY_AFTER, "3")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        json!({
                            "error": {
                                "message": "Rate limit reached",
                                "type": "rate_limit_error",
                                "code": "rate_limit_exceeded"
                            }
                        })
                        .to_string(),
                    ))
                    .unwrap();
            }
            if model == Some("stream-error") {
                return Response::builder()
                    .header(header::CONTENT_TYPE, "text/event-stream")
                    .body(Body::from(concat!(
                        "data: {\"id\":\"chatcmpl_error\",\"model\":\"stream-error\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"partial\"},\"finish_reason\":null}]}\n\n",
                        "data: {\"error\":{\"message\":\"upstream stream failed\",\"type\":\"api_error\"}}\n\n"
                    )))
                    .unwrap();
            }
            let stream = concat!(
                "data: {\"id\":\"chatcmpl_1\",\"model\":\"gpt-test\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"type\":\"function\",\"function\":{\"name\":\"Read\",\"arguments\":\"{\\\"path\\\":\"}}]},\"finish_reason\":null}]}\n\n",
                "data: {\"id\":\"chatcmpl_1\",\"model\":\"gpt-test\",\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"/tmp/a\\\"}\"}}]},\"finish_reason\":null}]}\n\n",
                "data: {\"id\":\"chatcmpl_1\",\"model\":\"gpt-test\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n",
                "data: {\"id\":\"chatcmpl_1\",\"model\":\"gpt-test\",\"choices\":[],\"usage\":{\"prompt_tokens\":12,\"completion_tokens\":7}}\n\n",
                "data: [DONE]\n\n"
            );
            return Response::builder()
                .header(header::CONTENT_TYPE, "text/event-stream")
                .body(Body::from(stream))
                .unwrap();
        }
        Response::builder()
            .header(header::CONTENT_TYPE, "text/event-stream")
            .body(Body::from("event: message\ndata: {\"ok\":true}\n\n"))
            .unwrap()
    }

    async fn start_upstream() -> (SocketAddr, UpstreamCapture, oneshot::Sender<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let capture = UpstreamCapture::default();
        let app = Router::new()
            .route("/{*path}", any(upstream))
            .with_state(capture.clone());
        let (shutdown_tx, shutdown_rx) = oneshot::channel();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app)
                .with_graceful_shutdown(async move {
                    let _ = shutdown_rx.await;
                })
                .await;
        });
        (address, capture, shutdown_tx)
    }

    #[tokio::test]
    async fn replaces_ephemeral_auth_and_preserves_anthropic_path_and_sse() {
        let (upstream_address, capture, upstream_shutdown) = start_upstream().await;
        let gateway = start(ProviderGatewayConfig {
            upstream_base_url: format!("http://{upstream_address}/anthropic"),
            upstream_api_key: "synthetic-real-key".to_string(),
            api_format: "anthropic".to_string(),
            auth_scheme: "x-api-key".to_string(),
            proxy_url: None,
        })
        .await
        .unwrap();

        let response = reqwest::Client::new()
            .post(format!("{}/v1/messages?beta=1", gateway.base_url()))
            .header("x-api-key", gateway.session_token())
            .body("{}")
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers().get(header::CONTENT_TYPE).unwrap(),
            "text/event-stream"
        );
        assert_eq!(
            response.text().await.unwrap(),
            "event: message\ndata: {\"ok\":true}\n\n"
        );
        assert_eq!(capture.requests.load(Ordering::SeqCst), 1);
        assert_eq!(
            capture.api_key.lock().unwrap().as_deref(),
            Some("synthetic-real-key")
        );
        assert_eq!(
            capture.path.lock().unwrap().as_deref(),
            Some("/anthropic/v1/messages?beta=1")
        );
        let _ = upstream_shutdown.send(());
    }

    #[tokio::test]
    async fn anthropic_gateway_supports_bearer_upstream_auth() {
        let (upstream_address, capture, upstream_shutdown) = start_upstream().await;
        let gateway = start(ProviderGatewayConfig {
            upstream_base_url: format!("http://{upstream_address}/anthropic"),
            upstream_api_key: "synthetic-bearer-key".to_string(),
            api_format: "anthropic".to_string(),
            auth_scheme: "bearer".to_string(),
            proxy_url: None,
        })
        .await
        .unwrap();

        let response = reqwest::Client::new()
            .post(format!("{}/v1/messages", gateway.base_url()))
            .header("x-api-key", gateway.session_token())
            .header("anthropic-version", "2023-06-01")
            .body("{}")
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            capture.authorization.lock().unwrap().as_deref(),
            Some("Bearer synthetic-bearer-key")
        );
        assert!(capture.api_key.lock().unwrap().is_none());
        let _ = upstream_shutdown.send(());
    }

    #[tokio::test]
    async fn fixed_provider_catalog_routes_every_transport_and_haiku_mapping() {
        let providers = crate::provider_catalog::entries().unwrap();
        assert_eq!(providers.len(), 9);

        for provider in providers {
            let (upstream_address, capture, upstream_shutdown) = start_upstream().await;
            let official_url = reqwest::Url::parse(&provider.base_url).unwrap();
            let compatibility_path = official_url.path().trim_end_matches('/');
            let upstream_base_url = format!("http://{upstream_address}{compatibility_path}");
            let upstream_key = format!("synthetic-{}-key", provider.id);
            let gateway = start(ProviderGatewayConfig {
                upstream_base_url: upstream_base_url.clone(),
                upstream_api_key: upstream_key.clone(),
                api_format: provider.api_format.clone(),
                auth_scheme: provider.auth_scheme.clone(),
                proxy_url: None,
            })
            .await
            .unwrap();
            let haiku_model = provider.default_models.get("haiku").unwrap();
            let request = json!({
                "model": haiku_model,
                "max_tokens": 128,
                "stream": true,
                "messages": [{"role":"user","content":"Use one tool"}],
                "tools": [{"name":"Read","description":"Read","input_schema":{"type":"object"}}]
            });
            let response = reqwest::Client::new()
                .post(format!("{}/v1/messages", gateway.base_url()))
                .header("x-api-key", gateway.session_token())
                .json(&request)
                .send()
                .await
                .unwrap();
            assert_eq!(
                response.status(),
                StatusCode::OK,
                "{} transport failed",
                provider.name
            );
            let response_body = response.text().await.unwrap();
            if matches!(provider.api_format.as_str(), "openai" | "gemini") {
                assert!(
                    response_body.contains("event: message_start")
                        && response_body.contains("\"type\":\"tool_use\""),
                    "{} did not translate provider tool-use SSE",
                    provider.name
                );
            } else {
                assert!(
                    response_body.contains("event: message"),
                    "{} did not preserve Anthropic SSE",
                    provider.name
                );
            }

            let expected_path = match provider.api_format.as_str() {
                "openai" => reqwest::Url::parse(&openai_chat_completions_url(&upstream_base_url))
                    .unwrap()
                    .path()
                    .to_string(),
                "gemini" => format!(
                    "{compatibility_path}/models/{haiku_model}:streamGenerateContent?alt=sse"
                ),
                _ => format!("{compatibility_path}/v1/messages"),
            };
            assert_eq!(
                capture.path.lock().unwrap().as_deref(),
                Some(expected_path.as_str()),
                "{} used the wrong compatibility path",
                provider.name
            );
            match provider.auth_scheme.as_str() {
                "bearer" => {
                    assert_eq!(
                        capture.authorization.lock().unwrap().as_deref(),
                        Some(format!("Bearer {upstream_key}").as_str()),
                        "{} used the wrong bearer credential",
                        provider.name
                    );
                    assert!(capture.api_key.lock().unwrap().is_none());
                    assert!(capture.goog_api_key.lock().unwrap().is_none());
                }
                "x-goog-api-key" => {
                    assert_eq!(
                        capture.goog_api_key.lock().unwrap().as_deref(),
                        Some(upstream_key.as_str()),
                        "{} used the wrong Google API credential",
                        provider.name
                    );
                    assert!(capture.api_key.lock().unwrap().is_none());
                    assert!(capture.authorization.lock().unwrap().is_none());
                }
                _ => {
                    assert_eq!(
                        capture.api_key.lock().unwrap().as_deref(),
                        Some(upstream_key.as_str()),
                        "{} used the wrong x-api-key credential",
                        provider.name
                    );
                    assert!(capture.authorization.lock().unwrap().is_none());
                    assert!(capture.goog_api_key.lock().unwrap().is_none());
                }
            }
            let upstream_body = capture.body.lock().unwrap().clone().unwrap();
            if provider.api_format == "gemini" {
                assert_eq!(
                    upstream_body.pointer("/contents/0/parts/0/text"),
                    Some(&json!("Use one tool")),
                    "{} used the wrong Gemini message mapping",
                    provider.name
                );
                assert_eq!(
                    upstream_body.pointer("/tools/0/functionDeclarations/0/name"),
                    Some(&json!("Read")),
                    "{} used the wrong Gemini tool mapping",
                    provider.name
                );
                assert!(upstream_body.get("model").is_none());
            } else {
                assert_eq!(
                    upstream_body.get("model").and_then(Value::as_str),
                    Some(haiku_model.as_str()),
                    "{} used the wrong Haiku mapping",
                    provider.name
                );
            }
            let _ = upstream_shutdown.send(());
        }
    }

    #[tokio::test]
    async fn rejects_requests_without_the_session_token_before_upstream() {
        let (upstream_address, capture, upstream_shutdown) = start_upstream().await;
        let gateway = start(ProviderGatewayConfig {
            upstream_base_url: format!("http://{upstream_address}"),
            upstream_api_key: "synthetic-real-key".to_string(),
            api_format: "anthropic".to_string(),
            auth_scheme: "x-api-key".to_string(),
            proxy_url: None,
        })
        .await
        .unwrap();

        let response = reqwest::Client::new()
            .post(format!("{}/v1/messages", gateway.base_url()))
            .header("x-api-key", "wrong-token")
            .body("{}")
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(capture.requests.load(Ordering::SeqCst), 0);
        let _ = upstream_shutdown.send(());
    }

    #[test]
    fn converts_anthropic_tools_and_tool_results_to_openai_messages() {
        let request = json!({
            "model": "gpt-test",
            "max_tokens": 512,
            "system": [{"type":"text","text":"You are an agent"}],
            "messages": [
                {"role":"user","content":[{"type":"text","text":"Read it"}]},
                {"role":"assistant","content":[{
                    "type":"tool_use","id":"call_1","name":"Read","input":{"path":"/tmp/a"}
                }]},
                {"role":"user","content":[{
                    "type":"tool_result","tool_use_id":"call_1","content":"hello"
                }]}
            ],
            "tools": [{"name":"Read","description":"Read a file","input_schema":{"type":"object"}}]
        });
        let converted = anthropic_to_openai_request(&request, false).unwrap();
        assert_eq!(
            converted.pointer("/messages/0/role"),
            Some(&json!("system"))
        );
        assert_eq!(
            converted.pointer("/messages/2/tool_calls/0/function/name"),
            Some(&json!("Read"))
        );
        assert_eq!(converted.pointer("/messages/3/role"), Some(&json!("tool")));
        assert_eq!(
            converted.pointer("/messages/3/tool_call_id"),
            Some(&json!("call_1"))
        );
        assert_eq!(
            converted.pointer("/tools/0/function/parameters/type"),
            Some(&json!("object"))
        );
    }

    #[test]
    fn preserves_tool_result_images_for_openai_compatible_providers() {
        let request = json!({
            "model": "gpt-vision",
            "messages": [
                {"role":"assistant","content":[{
                    "type":"tool_use","id":"call_image","name":"Read","input":{"path":"/tmp/a.png"}
                }]},
                {"role":"user","content":[{
                    "type":"tool_result",
                    "tool_use_id":"call_image",
                    "content":[
                        {"type":"text","text":"Image Size: 1x1."},
                        {"type":"image","source":{"type":"base64","media_type":"image/png","data":"AAAA"}}
                    ]
                }]}
            ]
        });
        let converted = anthropic_to_openai_request(&request, false).unwrap();
        assert_eq!(
            converted.pointer("/messages/2/content/0/type"),
            Some(&json!("image_url"))
        );
        assert_eq!(
            converted.pointer("/messages/2/content/0/image_url/url"),
            Some(&json!("data:image/png;base64,AAAA"))
        );
    }

    #[test]
    fn official_openai_uses_current_developer_role_and_token_limit_field() {
        let converted = anthropic_to_openai_request(
            &json!({
                "model":"gpt-5.4",
                "max_tokens":512,
                "stream":true,
                "output_config":{"effort":"medium"},
                "system":"Act as an agent",
                "messages":[{"role":"user","content":"Hi"}]
            }),
            true,
        )
        .unwrap();
        assert_eq!(
            converted.pointer("/messages/0/role"),
            Some(&json!("developer"))
        );
        assert_eq!(converted.get("max_completion_tokens"), Some(&json!(512)));
        assert!(converted.get("max_tokens").is_none());
        assert_eq!(
            converted.pointer("/stream_options/include_usage"),
            Some(&json!(true))
        );
        assert_eq!(converted.get("reasoning_effort"), Some(&json!("medium")));

        let generic = anthropic_to_openai_request(
            &json!({
                "model":"google/gemini-2.5-pro",
                "output_config":{"effort":"medium"},
                "messages":[{"role":"user","content":"Hi"}]
            }),
            false,
        )
        .unwrap();
        assert!(generic.get("reasoning_effort").is_none());
    }

    #[test]
    fn normalizes_openai_root_versioned_and_complete_endpoints() {
        assert_eq!(
            openai_chat_completions_url("https://api.openai.com"),
            "https://api.openai.com/v1/chat/completions"
        );
        assert_eq!(
            openai_chat_completions_url("https://api.openai.com/v1/"),
            "https://api.openai.com/v1/chat/completions"
        );
        assert_eq!(
            openai_chat_completions_url("https://gateway.example/v1/chat/completions/"),
            "https://gateway.example/v1/chat/completions"
        );
        assert_eq!(
            openai_chat_completions_url("https://gateway.example/openai/v1"),
            "https://gateway.example/openai/v1/chat/completions"
        );
        assert!(!is_official_openai_base_url(
            "https://api.openai.com.attacker.example/v1"
        ));
        assert!(openai_uses_max_completion_tokens(
            "https://api.openai.com/v1",
            "gpt-4o"
        ));
        assert!(openai_uses_max_completion_tokens(
            "https://gateway.example/v1",
            "o3-mini"
        ));
        assert!(!openai_uses_max_completion_tokens(
            "https://gateway.example/v1",
            "deepseek-chat"
        ));
    }

    #[test]
    fn translates_anthropic_parallel_tool_choice() {
        let converted = anthropic_to_openai_request(
            &json!({
                "model":"gpt-test",
                "messages":[{"role":"user","content":"Use one tool"}],
                "tool_choice":{"type":"auto","disable_parallel_tool_use":true}
            }),
            false,
        )
        .unwrap();
        assert_eq!(converted.get("tool_choice"), Some(&json!("auto")));
        assert_eq!(converted.get("parallel_tool_calls"), Some(&json!(false)));
    }

    #[test]
    fn converts_openai_json_tool_call_to_anthropic_message() {
        let response = json!({
            "id":"chatcmpl_1",
            "model":"gpt-test",
            "choices":[{
                "message":{"role":"assistant","content":null,"tool_calls":[{
                    "id":"call_1","type":"function","function":{"name":"Read","arguments":"{\"path\":\"/tmp/a\"}"}
                }]},
                "finish_reason":"tool_calls"
            }],
            "usage":{"prompt_tokens":12,"completion_tokens":7}
        });
        let converted = openai_to_anthropic_message(&response, "fallback").unwrap();
        assert_eq!(
            converted.pointer("/content/0/type"),
            Some(&json!("tool_use"))
        );
        assert_eq!(converted.pointer("/content/0/name"), Some(&json!("Read")));
        assert_eq!(
            converted.pointer("/content/0/input/path"),
            Some(&json!("/tmp/a"))
        );
        assert_eq!(converted.get("stop_reason"), Some(&json!("tool_use")));
    }

    #[test]
    fn converts_anthropic_messages_tools_and_config_to_native_gemini() {
        let request = json!({
            "model": "gemini-2.5-flash",
            "max_tokens": 512,
            "temperature": 0.2,
            "top_p": 0.8,
            "stop_sequences": ["END"],
            "system": [{"type":"text","text":"Act as an agent"}],
            "messages": [
                {"role":"user","content":[{"type":"text","text":"Read it"}]},
                {"role":"assistant","content":[{
                    "type":"tool_use","id":"call_1","name":"Read","input":{"path":"/tmp/a"}
                }]},
                {"role":"user","content":[{
                    "type":"tool_result","tool_use_id":"call_1","content":"hello"
                }]}
            ],
            "tools": [{"name":"Read","description":"Read a file","input_schema":{"type":"object"}}],
            "tool_choice": {"type":"tool","name":"Read"}
        });
        let converted = anthropic_to_gemini_request(&request).unwrap();
        assert_eq!(
            converted.pointer("/systemInstruction/parts/0/text"),
            Some(&json!("Act as an agent"))
        );
        assert_eq!(converted.pointer("/contents/1/role"), Some(&json!("model")));
        assert_eq!(
            converted.pointer("/contents/1/parts/0/functionCall/args/path"),
            Some(&json!("/tmp/a"))
        );
        assert_eq!(
            converted.pointer("/contents/2/parts/0/functionResponse/name"),
            Some(&json!("Read"))
        );
        assert_eq!(
            converted.pointer("/contents/2/parts/0/functionResponse/response/result"),
            Some(&json!("hello"))
        );
        assert_eq!(
            converted.pointer("/generationConfig/maxOutputTokens"),
            Some(&json!(512))
        );
        assert_eq!(
            converted.pointer("/tools/0/functionDeclarations/0/parameters/type"),
            Some(&json!("object"))
        );
        assert_eq!(
            converted.pointer("/toolConfig/functionCallingConfig/mode"),
            Some(&json!("ANY"))
        );
        assert_eq!(
            converted.pointer("/toolConfig/functionCallingConfig/allowedFunctionNames/0"),
            Some(&json!("Read"))
        );
        assert!(converted.get("model").is_none());
    }

    #[test]
    fn preserves_tool_result_images_for_native_gemini() {
        let request = json!({
            "messages": [
                {"role":"assistant","content":[{
                    "type":"tool_use","id":"call_image","name":"Read","input":{"path":"/tmp/a.png"}
                }]},
                {"role":"user","content":[{
                    "type":"tool_result",
                    "tool_use_id":"call_image",
                    "content":[
                        {"type":"text","text":"Image Size: 1x1."},
                        {"type":"image","source":{"type":"base64","media_type":"image/png","data":"AAAA"}}
                    ]
                }]}
            ]
        });
        let converted = anthropic_to_gemini_request(&request).unwrap();
        assert_eq!(
            converted.pointer("/contents/1/parts/1/inlineData/data"),
            Some(&json!("AAAA"))
        );
        assert_eq!(
            converted.pointer("/contents/1/parts/0/functionResponse/response/result"),
            Some(&json!("Image Size: 1x1."))
        );
    }

    #[test]
    fn native_gemini_translation_fails_closed_for_ambiguous_tool_and_image_blocks() {
        let cases = [
            (
                json!({
                    "messages": [{"role":"user","content":"Use one tool"}],
                    "tool_choice":{"type":"auto","disable_parallel_tool_use":true}
                }),
                "cannot guarantee disable_parallel_tool_use",
            ),
            (
                json!({
                    "messages": [{"role":"assistant","content":[{
                        "type":"tool_use","name":"Read","input":{}
                    }]}]
                }),
                "stable id",
            ),
            (
                json!({
                    "messages": [{"role":"assistant","content":[{
                        "type":"tool_use","id":"call_1","input":{}
                    }]}]
                }),
                "no name",
            ),
            (
                json!({
                    "messages": [{"role":"user","content":[{
                        "type":"tool_result","tool_use_id":"missing","content":"result"
                    }]}]
                }),
                "unknown tool_use id",
            ),
            (
                json!({
                    "messages": [{"role":"user","content":[{
                        "type":"image","source":{"type":"url","url":"https://example.com/a.png"}
                    }]}]
                }),
                "URL images are not supported",
            ),
            (
                json!({
                    "messages": [{"role":"assistant","content":[{
                        "type":"thinking","thinking":"hidden"
                    }]}]
                }),
                "Unsupported Anthropic content block",
            ),
        ];
        for (request, expected) in cases {
            let error = anthropic_to_gemini_request(&request).unwrap_err();
            assert!(error.contains(expected), "unexpected error: {error}");
        }

        let inline = anthropic_to_gemini_request(&json!({
            "messages": [{"role":"user","content":[{
                "type":"image","source":{"type":"base64","media_type":"image/png","data":"AAAA"}
            }]}]
        }))
        .unwrap();
        assert_eq!(
            inline.pointer("/contents/0/parts/0/inlineData/data"),
            Some(&json!("AAAA"))
        );
    }

    #[test]
    fn normalizes_native_gemini_generate_content_endpoints() {
        assert_eq!(
            gemini_generate_content_url(
                "https://generativelanguage.googleapis.com/v1beta",
                "models/gemini-2.5-flash",
                false,
            )
            .unwrap(),
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent"
        );
        assert_eq!(
            gemini_generate_content_url(
                "https://generativelanguage.googleapis.com/v1beta/models/",
                "gemini-2.5-flash",
                true,
            )
            .unwrap(),
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse"
        );
        assert!(gemini_generate_content_url(
            "https://generativelanguage.googleapis.com/v1beta",
            "../../other",
            false,
        )
        .is_err());
    }

    #[test]
    fn converts_native_gemini_json_tool_call_to_anthropic_message() {
        let response = json!({
            "modelVersion": "gemini-test",
            "candidates": [{
                "content": {"role":"model","parts":[
                    {"text":"checking"},
                    {"functionCall":{"id":"call_1","name":"Read","args":{"path":"/tmp/a"}}}
                ]},
                "finishReason": "STOP"
            }],
            "usageMetadata": {"promptTokenCount": 12, "candidatesTokenCount": 7}
        });
        let converted = gemini_to_anthropic_message(&response, "fallback").unwrap();
        assert_eq!(
            converted.pointer("/content/0/text"),
            Some(&json!("checking"))
        );
        assert_eq!(
            converted.pointer("/content/1/type"),
            Some(&json!("tool_use"))
        );
        assert_eq!(
            converted.pointer("/content/1/input/path"),
            Some(&json!("/tmp/a"))
        );
        assert_eq!(converted.get("stop_reason"), Some(&json!("tool_use")));
        assert_eq!(converted.pointer("/usage/input_tokens"), Some(&json!(12)));
        assert_eq!(converted.pointer("/usage/output_tokens"), Some(&json!(7)));
    }

    #[test]
    fn native_gemini_json_tool_calls_require_names_and_object_arguments() {
        let missing_name = gemini_to_anthropic_message(
            &json!({
                "candidates":[{"content":{"parts":[{"functionCall":{"args":{}}}]}}]
            }),
            "fallback",
        )
        .unwrap_err();
        assert!(missing_name.contains("no name"));

        let invalid_arguments = gemini_to_anthropic_message(
            &json!({
                "candidates":[{"content":{"parts":[{"functionCall":{
                    "name":"Read","args":"/tmp/a"
                }}]}}]
            }),
            "fallback",
        )
        .unwrap_err();
        assert!(invalid_arguments.contains("non-object arguments"));

        let synthesized = gemini_to_anthropic_message(
            &json!({
                "candidates":[{"content":{"parts":[
                    {"functionCall":{"name":"Read","args":{}}},
                    {"functionCall":{"name":"Write","args":{}}}
                ]}}]
            }),
            "fallback",
        )
        .unwrap();
        let first = synthesized
            .pointer("/content/0/id")
            .and_then(Value::as_str)
            .unwrap();
        let second = synthesized
            .pointer("/content/1/id")
            .and_then(Value::as_str)
            .unwrap();
        assert_ne!(first, second);

        let reused_id = gemini_to_anthropic_message(
            &json!({
                "candidates":[{"content":{"parts":[
                    {"functionCall":{"id":"call_1","name":"Read","args":{}}},
                    {"functionCall":{"id":"call_1","name":"Write","args":{}}}
                ]}}]
            }),
            "fallback",
        )
        .unwrap_err();
        assert!(reused_id.contains("reused functionCall id 'call_1'"));
    }

    #[test]
    fn native_gemini_json_reports_blocked_and_safety_finishes_as_errors() {
        let blocked = gemini_to_anthropic_message(
            &json!({"promptFeedback":{"blockReason":"SAFETY"}}),
            "fallback",
        )
        .unwrap_err();
        assert!(blocked.contains("blocked"));

        let safety = gemini_to_anthropic_message(
            &json!({
                "candidates":[{
                    "content":{"parts":[]},
                    "finishReason":"SAFETY"
                }]
            }),
            "fallback",
        )
        .unwrap_err();
        assert!(safety.contains("SAFETY"));

        let resource_exhausted = anthropic_error_payload(
            &json!({"error":{"status":"RESOURCE_EXHAUSTED","message":"quota"}}),
            None,
        );
        assert_eq!(
            resource_exhausted.pointer("/error/type"),
            Some(&json!("rate_limit_error"))
        );
    }

    #[test]
    fn gemini_stream_keeps_block_order_and_uses_latest_function_arguments() {
        let mut state = GeminiStreamState::new("fallback".to_string());
        let mut events = Vec::new();
        events.extend(state.accept(&json!({
            "candidates": [{"content":{"parts":[{"text":"before"}]}}]
        })));
        events.extend(state.accept(&json!({
            "candidates": [{"content":{"parts":[{"functionCall":{
                "id":"call_1","name":"Read","args":{"path":"/tmp"}
            }}]}}]
        })));
        events.extend(state.accept(&json!({
            "candidates": [{"content":{"parts":[{"functionCall":{
                "id":"call_1","name":"Read","args":{"path":"/tmp/a"}
            }}]}}]
        })));
        events.extend(state.accept(&json!({
            "candidates": [{"content":{"parts":[{"text":"after"}]},"finishReason":"STOP"}],
            "usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":4}
        })));
        events.extend(state.finish());
        let stream = events
            .iter()
            .map(|event| String::from_utf8_lossy(event).to_string())
            .collect::<String>();
        assert_eq!(stream.matches("partial_json").count(), 1);
        assert!(stream.contains("{\\\"path\\\":\\\"/tmp/a\\\"}"));
        let first_stop = stream.find("\"index\":0").unwrap();
        let tool_start = stream.find("\"index\":1").unwrap();
        let final_text = stream.find("\"index\":2").unwrap();
        assert!(first_stop < tool_start && tool_start < final_text);
        assert!(stream.contains("\"stop_reason\":\"tool_use\""));
        assert!(stream.contains("\"output_tokens\":4"));
    }

    #[test]
    fn gemini_stream_rejects_ambiguous_synthetic_function_call_reuse() {
        let mut state = GeminiStreamState::new("fallback".to_string());
        let first = state.accept(&json!({
            "candidates": [{"content":{"parts":[{"functionCall":{
                "name":"Read","args":{"path":"/tmp/a"}
            }}]}}]
        }));
        assert!(first
            .iter()
            .all(|event| !String::from_utf8_lossy(event).contains("event: error")));

        let conflicting = state.accept(&json!({
            "candidates": [{"content":{"parts":[{"functionCall":{
                "name":"Write","args":{"path":"/tmp/b"}
            }}]}}]
        }));
        let stream = conflicting
            .iter()
            .map(|event| String::from_utf8_lossy(event).to_string())
            .collect::<String>();
        assert!(stream.contains("event: error"));
        assert!(stream.contains("changed the name"));
        assert!(state.finish().is_empty());
    }

    #[test]
    fn gemini_stream_rejects_replayed_completed_function_call_ids() {
        let mut state = GeminiStreamState::new("fallback".to_string());
        let first = state.accept(&json!({
            "candidates": [{"content":{"parts":[{"functionCall":{
                "id":"call_1","name":"Read","args":{"path":"/tmp/a"}
            }}]}}]
        }));
        assert!(first
            .iter()
            .all(|event| !String::from_utf8_lossy(event).contains("event: error")));

        let separator = state.accept(&json!({
            "candidates": [{"content":{"parts":[{"text":"after tool"}]}}]
        }));
        assert!(separator
            .iter()
            .all(|event| !String::from_utf8_lossy(event).contains("event: error")));

        let replayed = state.accept(&json!({
            "candidates": [{"content":{"parts":[{"functionCall":{
                "id":"call_1","name":"Read","args":{"path":"/tmp/a"}
            }}]}}]
        }));
        let stream = replayed
            .iter()
            .map(|event| String::from_utf8_lossy(event).to_string())
            .collect::<String>();
        assert!(stream.contains("event: error"));
        assert!(stream.contains("reused completed function call 'call_1' ambiguously"));
        assert!(state.finish().is_empty());
    }

    #[test]
    fn gemini_stream_rejects_duplicate_function_call_ids_in_one_payload() {
        let mut state = GeminiStreamState::new("fallback".to_string());
        let events = state.accept(&json!({
            "candidates": [{"content":{"parts":[
                {"functionCall":{
                    "id":"call_1","name":"Read","args":{"path":"/tmp/a"}
                }},
                {"functionCall":{
                    "id":"call_1","name":"Read","args":{"path":"/tmp/b"}
                }}
            ]}}]
        }));
        let stream = events
            .iter()
            .map(|event| String::from_utf8_lossy(event).to_string())
            .collect::<String>();
        assert!(stream.contains("event: error"));
        assert!(stream.contains("repeated function call 'call_1' in one stream payload"));
        assert!(state.finish().is_empty());
    }

    #[test]
    fn gemini_stream_never_turns_blocked_or_empty_payloads_into_success() {
        let mut blocked = GeminiStreamState::new("fallback".to_string());
        let blocked_events = blocked.accept(&json!({
            "promptFeedback":{"blockReason":"SAFETY"}
        }));
        let blocked_stream = blocked_events
            .iter()
            .map(|event| String::from_utf8_lossy(event).to_string())
            .collect::<String>();
        assert!(blocked_stream.contains("event: error"));
        assert!(!blocked_stream.contains("event: message_stop"));
        assert!(blocked.finish().is_empty());

        let mut empty = GeminiStreamState::new("fallback".to_string());
        assert!(empty
            .accept(&json!({"usageMetadata":{"promptTokenCount":2}}))
            .is_empty());
        let empty_stream = empty
            .finish()
            .iter()
            .map(|event| String::from_utf8_lossy(event).to_string())
            .collect::<String>();
        assert!(empty_stream.contains("event: error"));
        assert!(empty_stream.contains("without a response candidate"));
        assert!(!empty_stream.contains("event: message_stop"));
    }

    #[test]
    fn gemini_sse_parser_accepts_multiline_and_unterminated_final_frames() {
        let mut buffer = concat!(
            "data: {\"candidates\":\n",
            "data: [{\"finishReason\":\"STOP\"}]}\n\n",
            "data: {\"usageMetadata\":{\"promptTokenCount\":2}}"
        )
        .as_bytes()
        .to_vec();
        let mut frame = String::new();
        let payloads = drain_gemini_sse_payloads(&mut buffer, &mut frame, true).unwrap();
        assert_eq!(payloads.len(), 2);
        assert_eq!(
            payloads[0].pointer("/candidates/0/finishReason"),
            Some(&json!("STOP"))
        );
        assert_eq!(
            payloads[1].pointer("/usageMetadata/promptTokenCount"),
            Some(&json!(2))
        );

        let mut invalid_json = b"data: {not-json}\n\n".to_vec();
        let mut invalid_frame = String::new();
        assert!(drain_gemini_sse_payloads(&mut invalid_json, &mut invalid_frame, true).is_err());

        let mut invalid_utf8 = vec![b'd', b'a', b't', b'a', b':', b' ', 0xff, b'\n', b'\n'];
        let mut invalid_frame = String::new();
        assert!(drain_gemini_sse_payloads(&mut invalid_utf8, &mut invalid_frame, true).is_err());
    }

    #[tokio::test]
    async fn gemini_gateway_uses_native_path_auth_body_and_translates_stream() {
        let (upstream_address, capture, upstream_shutdown) = start_upstream().await;
        let gateway = start(ProviderGatewayConfig {
            upstream_base_url: format!("http://{upstream_address}/v1beta"),
            upstream_api_key: "synthetic-gemini-key".to_string(),
            api_format: "gemini".to_string(),
            auth_scheme: "x-goog-api-key".to_string(),
            proxy_url: None,
        })
        .await
        .unwrap();
        let response = reqwest::Client::new()
            .post(format!("{}/v1/messages", gateway.base_url()))
            .header("x-api-key", gateway.session_token())
            .json(&json!({
                "model":"gemini-2.5-flash",
                "max_tokens":256,
                "stream":true,
                "messages":[{"role":"user","content":"Read /tmp/a"}],
                "tools":[{"name":"Read","description":"Read","input_schema":{"type":"object"}}]
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = response.text().await.unwrap();
        assert!(body.contains("event: message_start"));
        assert!(body.contains("\"type\":\"tool_use\""));
        assert!(body.contains("{\\\"path\\\":\\\"/tmp/a\\\"}"));
        assert!(body.contains("\"stop_reason\":\"tool_use\""));
        assert!(body.contains("\"output_tokens\":5"));
        assert_eq!(
            capture.goog_api_key.lock().unwrap().as_deref(),
            Some("synthetic-gemini-key")
        );
        assert!(capture.api_key.lock().unwrap().is_none());
        assert!(capture.authorization.lock().unwrap().is_none());
        assert_eq!(
            capture.path.lock().unwrap().as_deref(),
            Some("/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse")
        );
        let upstream_body = capture.body.lock().unwrap().clone().unwrap();
        assert_eq!(
            upstream_body.pointer("/contents/0/parts/0/text"),
            Some(&json!("Read /tmp/a"))
        );
        assert_eq!(
            upstream_body.pointer("/tools/0/functionDeclarations/0/name"),
            Some(&json!("Read"))
        );
        assert!(upstream_body.get("model").is_none());
        let _ = upstream_shutdown.send(());
    }

    #[tokio::test]
    async fn gemini_gateway_exposes_blocked_and_malformed_responses_as_anthropic_errors() {
        let (upstream_address, _capture, upstream_shutdown) = start_upstream().await;
        let gateway = start(ProviderGatewayConfig {
            upstream_base_url: format!("http://{upstream_address}/v1beta"),
            upstream_api_key: "synthetic-gemini-key".to_string(),
            api_format: "gemini".to_string(),
            auth_scheme: "x-goog-api-key".to_string(),
            proxy_url: None,
        })
        .await
        .unwrap();
        let client = reqwest::Client::new();

        let response = client
            .post(format!("{}/v1/messages", gateway.base_url()))
            .header("x-api-key", gateway.session_token())
            .json(&json!({
                "model":"blocked-json",
                "stream":false,
                "messages":[{"role":"user","content":"hi"}]
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
        let payload = response.json::<Value>().await.unwrap();
        assert_eq!(payload.get("type"), Some(&json!("error")));
        assert!(payload
            .pointer("/error/message")
            .and_then(Value::as_str)
            .unwrap()
            .contains("blocked"));

        for model in ["blocked-stream", "malformed-sse"] {
            let response = client
                .post(format!("{}/v1/messages", gateway.base_url()))
                .header("x-api-key", gateway.session_token())
                .json(&json!({
                    "model":model,
                    "stream":true,
                    "messages":[{"role":"user","content":"hi"}]
                }))
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            let stream = response.text().await.unwrap();
            assert!(stream.contains("event: error"), "{model} was hidden");
            assert!(
                !stream.contains("event: message_stop"),
                "{model} faked success"
            );
        }
        let _ = upstream_shutdown.send(());
    }

    #[tokio::test]
    async fn openai_gateway_translates_request_auth_and_streamed_tool_use() {
        let (upstream_address, capture, upstream_shutdown) = start_upstream().await;
        let gateway = start(ProviderGatewayConfig {
            upstream_base_url: format!("http://{upstream_address}/v1"),
            upstream_api_key: "synthetic-openai-key".to_string(),
            api_format: "openai".to_string(),
            auth_scheme: "bearer".to_string(),
            proxy_url: None,
        })
        .await
        .unwrap();
        let request = json!({
            "model":"gpt-test",
            "max_tokens":256,
            "stream":true,
            "messages":[{"role":"user","content":"Read /tmp/a"}],
            "tools":[{"name":"Read","description":"Read","input_schema":{"type":"object"}}]
        });
        let response = reqwest::Client::new()
            .post(format!("{}/v1/messages", gateway.base_url()))
            .header("x-api-key", gateway.session_token())
            .json(&request)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = response.text().await.unwrap();
        assert!(body.contains("event: message_start"));
        assert!(body.contains("\"type\":\"tool_use\""));
        assert!(body.contains("\"partial_json\":\"{\\\"path\\\":\""));
        assert!(body.contains("\"partial_json\":\"/tmp/a\\\"}\""));
        assert!(body.contains("\"stop_reason\":\"tool_use\""));
        assert!(body.contains("\"output_tokens\":7"));
        assert_eq!(
            capture.authorization.lock().unwrap().as_deref(),
            Some("Bearer synthetic-openai-key")
        );
        assert!(capture.api_key.lock().unwrap().is_none());
        assert_eq!(
            capture.path.lock().unwrap().as_deref(),
            Some("/v1/chat/completions")
        );
        let upstream_body = capture.body.lock().unwrap().clone().unwrap();
        assert_eq!(
            upstream_body.pointer("/tools/0/function/name"),
            Some(&json!("Read"))
        );
        assert_eq!(upstream_body.get("stream"), Some(&json!(true)));
        let _ = upstream_shutdown.send(());
    }

    #[tokio::test]
    async fn openai_gateway_translates_http_and_stream_errors() {
        let (upstream_address, _capture, upstream_shutdown) = start_upstream().await;
        let gateway = start(ProviderGatewayConfig {
            upstream_base_url: format!("http://{upstream_address}/v1/chat/completions"),
            upstream_api_key: "synthetic-openai-key".to_string(),
            api_format: "openai".to_string(),
            auth_scheme: "bearer".to_string(),
            proxy_url: None,
        })
        .await
        .unwrap();
        let client = reqwest::Client::new();

        let response = client
            .post(format!("{}/v1/messages", gateway.base_url()))
            .header("x-api-key", gateway.session_token())
            .json(&json!({
                "model":"force-error",
                "stream":false,
                "messages":[{"role":"user","content":"hi"}]
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(response.headers().get(header::RETRY_AFTER).unwrap(), "3");
        let payload = response.json::<Value>().await.unwrap();
        assert_eq!(payload.get("type"), Some(&json!("error")));
        assert_eq!(
            payload.pointer("/error/type"),
            Some(&json!("rate_limit_error"))
        );
        assert_eq!(payload.get("request_id"), Some(&json!("req_rate_limit")));

        let response = client
            .post(format!("{}/v1/messages", gateway.base_url()))
            .header("x-api-key", gateway.session_token())
            .json(&json!({
                "model":"stream-error",
                "stream":true,
                "messages":[{"role":"user","content":"hi"}]
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let stream = response.text().await.unwrap();
        assert!(stream.contains("event: error"));
        assert!(stream.contains("upstream stream failed"));
        assert!(!stream.contains("event: message_stop"));
        let _ = upstream_shutdown.send(());
    }
}
