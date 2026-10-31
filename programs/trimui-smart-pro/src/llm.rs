//! The Responses endpoint behind a ChatGPT sign-in, streamed over rustls straight
//! from this process. SSE parsing keeps only the final items: deltas go to the
//! caller and are dropped, so a long reply costs no JavaScript heap.
use crate::auth::Auth;
use anyhow::{anyhow, bail, Context, Result};
use base64::Engine;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::BufRead,
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};

const DEFAULT_BASE: &str = "https://chatgpt.com/backend-api/codex";

#[derive(Clone, Debug)]
pub struct Config {
    pub model: String,
    pub effort: String,
    pub base_url: String,
    pub proxy: Option<String>,
}

impl Config {
    pub fn load(path: &Path) -> Self {
        let file: Value = std::fs::read_to_string(path)
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or(Value::Null);
        let text = |key: &str| {
            file[key]
                .as_str()
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
        };
        Self {
            model: text("model").unwrap_or_else(|| "gpt-6-astra".to_owned()),
            effort: text("effort").unwrap_or_else(|| "medium".to_owned()),
            base_url: text("base_url").unwrap_or_else(|| DEFAULT_BASE.to_owned()),
            proxy: text("proxy").or_else(|| std::env::var("POCKET_STUDIO_PROXY").ok()),
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Delta {
    Text(String),
    Thinking(String),
    ToolArguments(usize),
}

#[derive(Debug, Default)]
pub struct Reply {
    pub items: Vec<Value>,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cached_tokens: u64,
}

pub struct Llm {
    agent: ureq::Agent,
    auth: Auth,
    pub config: Config,
    session: String,
    images: HashMap<String, Vec<u8>>,
}

fn agent(config: &Config) -> Result<ureq::Agent> {
    let mut builder = ureq::Agent::config_builder()
        .timeout_connect(Some(Duration::from_secs(20)))
        .timeout_recv_response(Some(Duration::from_secs(180)))
        .timeout_recv_body(Some(Duration::from_secs(300)))
        .http_status_as_error(false)
        .user_agent("pocket-studio-handheld/0.1");
    if let Some(proxy) = &config.proxy {
        builder = builder.proxy(Some(
            ureq::Proxy::new(proxy).with_context(|| format!("proxy {proxy}"))?,
        ));
    } else {
        builder = builder.proxy(None);
    }
    Ok(builder.build().new_agent())
}

/// Feed SSE lines; returns the event's JSON at each blank line.
#[derive(Default)]
pub struct SseLines {
    data: String,
}

impl SseLines {
    pub fn push(&mut self, line: &str) -> Option<String> {
        let line = line.trim_end_matches(['\r', '\n']);
        if line.is_empty() {
            return (!self.data.is_empty()).then(|| std::mem::take(&mut self.data));
        }
        if let Some(data) = line.strip_prefix("data:") {
            if !self.data.is_empty() {
                self.data.push('\n');
            }
            self.data.push_str(data.strip_prefix(' ').unwrap_or(data));
        }
        None
    }
}

/// Apply one stream event to `reply`; returns a delta to show. `Err` carries a
/// server-reported failure.
pub fn apply_event(event: &Value, reply: &mut Reply) -> Result<Option<Delta>> {
    match event["type"].as_str().unwrap_or("") {
        "response.output_text.delta" => Ok(event["delta"]
            .as_str()
            .map(|text| Delta::Text(text.to_owned()))),
        "response.reasoning_summary_text.delta" => Ok(event["delta"]
            .as_str()
            .map(|text| Delta::Thinking(text.to_owned()))),
        "response.function_call_arguments.delta" => Ok(event["delta"]
            .as_str()
            .map(|text| Delta::ToolArguments(text.len()))),
        "response.output_item.done" => {
            let item = &event["item"];
            if matches!(item["type"].as_str(), Some("message" | "function_call")) {
                reply.items.push(item.clone());
            }
            Ok(None)
        }
        "response.completed" | "response.incomplete" => {
            let usage = &event["response"]["usage"];
            reply.input_tokens = usage["input_tokens"].as_u64().unwrap_or(0);
            reply.output_tokens = usage["output_tokens"].as_u64().unwrap_or(0);
            reply.cached_tokens = usage["input_tokens_details"]["cached_tokens"]
                .as_u64()
                .unwrap_or(0);
            Ok(None)
        }
        "response.failed" => bail!("model failed: {}", event["response"]["error"]),
        "error" => bail!("model error: {}", event["error"]),
        _ => Ok(None),
    }
}

/// The server's own sentence from an error body, or the body's beginning.
pub fn error_message(body: &str) -> String {
    let parsed = serde_json::from_str::<Value>(body).ok();
    let message = parsed.as_ref().and_then(|value| {
        value["error"]["message"]
            .as_str()
            .or(value["detail"].as_str())
    });
    message.unwrap_or(body).chars().take(300).collect()
}

impl Llm {
    pub fn new(data: &Path) -> Result<Self> {
        let config = Config::load(&data.join("config.json"));
        let auth = Auth::load(&data.join("auth.json"))?;
        let agent = agent(&config)?;
        let session = format!("pocket-studio-{}", std::process::id());
        Ok(Self {
            agent,
            auth,
            config,
            session,
            images: HashMap::new(),
        })
    }

    pub fn seconds_left(&self) -> Option<i64> {
        self.auth.seconds_left()
    }

    pub fn store_image(&mut self, id: String, png: Vec<u8>) {
        self.images.insert(id, png);
    }

    pub fn forget_image(&mut self, id: &str) {
        self.images.remove(id);
    }

    /// `{"image_ref": id}` content parts become data URLs at send time, so the
    /// JavaScript side only ever holds short names.
    fn inline_images(&self, value: &mut Value) {
        match value {
            Value::Array(items) => items.iter_mut().for_each(|item| self.inline_images(item)),
            Value::Object(map) => {
                if let Some(id) = map
                    .get("image_ref")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                {
                    map.remove("image_ref");
                    map.insert("type".into(), json!("input_image"));
                    let data = self
                        .images
                        .get(&id)
                        .map(|png| base64::engine::general_purpose::STANDARD.encode(png))
                        .unwrap_or_default();
                    map.insert(
                        "image_url".into(),
                        json!(format!("data:image/png;base64,{data}")),
                    );
                } else {
                    map.values_mut().for_each(|item| self.inline_images(item));
                }
            }
            _ => {}
        }
    }

    /// One model turn, retried on rate limits and dropped connections.
    pub fn respond(
        &mut self,
        mut request: Value,
        cancel: &AtomicBool,
        on_delta: &mut dyn FnMut(Delta),
    ) -> Result<Reply> {
        self.inline_images(&mut request);
        request["model"] = json!(self.config.model);
        request["reasoning"] = json!({ "effort": self.config.effort, "summary": "auto" });
        request["store"] = json!(false);
        request["stream"] = json!(true);
        request["prompt_cache_key"] = json!(self.session);
        let body = request.to_string();
        drop(request);
        let mut last = anyhow!("no attempt");
        for attempt in 0..4u32 {
            if attempt > 0 {
                let wait = 2u64.pow(attempt);
                on_delta(Delta::Thinking(format!(
                    "\n(retrying in {wait}s: {last})\n"
                )));
                for _ in 0..wait * 10 {
                    if cancel.load(Ordering::Relaxed) {
                        bail!("cancelled");
                    }
                    std::thread::sleep(Duration::from_millis(100));
                }
            }
            match self.attempt(&body, cancel, on_delta) {
                Ok(reply) => return Ok(reply),
                Err(error) => {
                    let text = error.to_string();
                    if text == "cancelled" || text.starts_with("permanent:") {
                        return Err(error);
                    }
                    last = error;
                }
            }
        }
        Err(last)
    }

    fn attempt(
        &mut self,
        body: &str,
        cancel: &AtomicBool,
        on_delta: &mut dyn FnMut(Delta),
    ) -> Result<Reply> {
        if self.auth.needs_refresh() {
            self.auth.refresh(&self.agent)?;
        }
        let url = format!("{}/responses", self.config.base_url.trim_end_matches('/'));
        let mut response = self
            .agent
            .post(&url)
            .header("content-type", "application/json")
            .header("accept", "text/event-stream")
            .header("authorization", &format!("Bearer {}", self.auth.access()))
            .header("chatgpt-account-id", self.auth.account())
            .header("originator", "pocket_studio_handheld")
            .send(body)
            .map_err(|error| anyhow!("connect {url}: {error}"))?;
        let status = response.status().as_u16();
        if status == 401 {
            self.auth.refresh(&self.agent)?;
            bail!("signed-in token rejected, refreshed");
        }
        if status != 200 {
            let text = response.body_mut().read_to_string().unwrap_or_default();
            let excerpt = error_message(&text);
            if status == 400 || status == 403 || status == 404 {
                bail!("permanent: HTTP {status}: {excerpt}");
            }
            bail!("HTTP {status}: {excerpt}");
        }
        let mut reader =
            std::io::BufReader::with_capacity(16 * 1024, response.into_body().into_reader());
        let mut lines = SseLines::default();
        let mut reply = Reply::default();
        let mut line = String::new();
        loop {
            if cancel.load(Ordering::Relaxed) {
                bail!("cancelled");
            }
            line.clear();
            if reader.read_line(&mut line).context("stream")? == 0 {
                break;
            }
            let Some(data) = lines.push(&line) else {
                continue;
            };
            if data == "[DONE]" {
                break;
            }
            let Ok(event) = serde_json::from_str::<Value>(&data) else {
                continue;
            };
            if let Some(delta) = apply_event(&event, &mut reply)? {
                on_delta(delta);
            }
            if matches!(
                event["type"].as_str(),
                Some("response.completed" | "response.incomplete")
            ) {
                return Ok(reply);
            }
        }
        bail!("stream ended before the response completed")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn assembles_events_across_data_lines() {
        let mut lines = SseLines::default();
        assert_eq!(lines.push("event: response.created\n"), None);
        assert_eq!(lines.push("data: {\"a\":\n"), None);
        assert_eq!(lines.push("data: 1}\n"), None);
        assert_eq!(lines.push("\r\n").as_deref(), Some("{\"a\":\n1}"));
        assert_eq!(lines.push("\n"), None);
    }

    #[test]
    fn errors_read_as_sentences() {
        assert_eq!(
            error_message(r#"{"error":{"message":"bad image"}}"#),
            "bad image"
        );
        assert_eq!(error_message(r#"{"detail":"nope"}"#), "nope");
        assert_eq!(error_message("<html>"), "<html>");
    }

    #[test]
    fn keeps_final_items_and_usage() {
        let mut reply = Reply::default();
        let delta = apply_event(
            &json!({ "type": "response.output_text.delta", "delta": "hi" }),
            &mut reply,
        )
        .unwrap();
        assert_eq!(delta, Some(Delta::Text("hi".into())));
        apply_event(&json!({ "type": "response.output_item.done", "item": { "type": "reasoning", "id": "r" } }), &mut reply).unwrap();
        apply_event(&json!({ "type": "response.output_item.done", "item": { "type": "function_call", "name": "x", "call_id": "c", "arguments": "{}" } }), &mut reply).unwrap();
        apply_event(&json!({ "type": "response.completed", "response": { "usage": { "input_tokens": 5, "output_tokens": 2, "input_tokens_details": { "cached_tokens": 1 } } } }), &mut reply).unwrap();
        assert_eq!(reply.items.len(), 1);
        assert_eq!(
            (reply.input_tokens, reply.output_tokens, reply.cached_tokens),
            (5, 2, 1)
        );
        assert!(apply_event(
            &json!({ "type": "response.failed", "response": { "error": { "message": "x" } } }),
            &mut reply
        )
        .is_err());
    }
}
