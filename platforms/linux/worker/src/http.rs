//! The worker's `http` node: the resources `io.http(...)` opens, their facts,
//! and the driver the C core calls. Where a request goes is the program's
//! [`Exchange`]: the one in Pocket Hub's CardputerZero program reaches
//! loopback servers, Omarchy Pocket's hands it to its daemon.
//!
//! Open parses the descriptor (framework/src/io.ts), bounded as
//! contracts/spec/net.ts bounds it with the node's response limit (the
//! program's host contract, `worker.http.responseBytes`), and asks the
//! exchange whether the program can reach the URL; start hands the exchange a
//! [`Call`]. The call is answered once, from any thread, and its answer
//! becomes facts: HEADERS, DATA in blocks of at most 1 KiB, END. The worker's
//! owner task emits them into the core when it waits or finishes a turn
//! (runner.rs). An answer never touches the core, so close returns at once and
//! a late answer is dropped.
use crate::runner::{
    pocket_worker_emit, pocket_worker_finish, Core, Driver, Notify, BUSY, FACT_DATA, FACT_HEADERS,
    FAILED, INVALID, MAX_PAYLOAD, OK, UNKNOWN,
};
use std::{
    collections::{BTreeMap, HashMap, VecDeque},
    ffi::c_void,
    sync::{Arc, Mutex},
    time::Duration,
};

/// contracts/spec/net.ts.
pub const METHODS: [&str; 7] = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
pub const DEFAULT_TIMEOUT_MS: u64 = 30_000;
pub const MAX_TIMEOUT_MS: u64 = 120_000;
pub const DEFAULT_RESPONSE_BYTES: usize = 128 * 1024;
/// The response limit of a host contract that states none.
pub const MAX_RESPONSE_BYTES: usize = 256 * 1024;

/// The response limit a host contract (`pocket.host.json`) states in
/// `worker.http.responseBytes`, or MAX_RESPONSE_BYTES when it states none.
pub fn contract_response_bytes(contract: &str) -> usize {
    serde_json::from_str::<serde_json::Value>(contract)
        .ok()
        .and_then(|value| value["worker"]["http"]["responseBytes"].as_u64())
        .map_or(MAX_RESPONSE_BYTES, |bytes| {
            (bytes as usize).max(MAX_RESPONSE_BYTES)
        })
}

/// An opened resource's request, parsed from its descriptor. Header names are
/// lower case.
#[derive(Clone, Debug, PartialEq)]
pub struct Request {
    pub url: String,
    pub method: String,
    pub headers: BTreeMap<String, String>,
    pub body: Vec<u8>,
    pub timeout: Duration,
    pub max_bytes: usize,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Response {
    pub status: u16,
    /// Lower-case names.
    pub headers: BTreeMap<String, String>,
    pub body: Vec<u8>,
}

/// Why an exchange produced no response, and whether the request may have
/// reached its server (UNKNOWN to the worker) or surely did not (FAILED).
#[derive(Clone, Debug, PartialEq)]
pub struct Failure {
    pub reached: bool,
    pub message: String,
}

/// Where a program's requests go.
pub trait Exchange: Send + Sync + 'static {
    /// Whether this program can reach `request`'s URL; open refuses the rest.
    fn admits(&self, _request: &Request) -> bool {
        true
    }
    /// Perform `call`'s request and answer it once, from any thread. Called on
    /// the worker's owner thread: hand the work elsewhere and return.
    fn start(&self, call: Call);
}

/// One started request, to be answered.
pub struct Call {
    node: Arc<HttpNode>,
    handle: u32,
    request: u32,
    job: Request,
}

impl Call {
    pub fn request(&self) -> &Request {
        &self.job
    }
    /// The worker cancelled or closed it meanwhile.
    pub fn abandoned(&self) -> bool {
        let state = self.node.state.lock().unwrap();
        !matches!(state.resources.get(&self.handle), Some(resource) if resource.started == Some(self.request) && !resource.cancelled)
    }
    pub fn answer(self, answer: Result<Response, Failure>) {
        self.node
            .answer(self.handle, self.request, answer, &self.job.url);
    }
}

enum Fact {
    Headers {
        handle: u32,
        bytes: Vec<u8>,
    },
    Data {
        handle: u32,
        offset: u64,
        bytes: Vec<u8>,
    },
    End {
        handle: u32,
        request: u32,
        status: i32,
        offset: u64,
    },
}
impl Fact {
    fn handle(&self) -> u32 {
        match self {
            Fact::Headers { handle, .. } | Fact::Data { handle, .. } | Fact::End { handle, .. } => {
                *handle
            }
        }
    }
}

struct Resource {
    request: Request,
    /// The submitted request id; one per resource.
    started: Option<u32>,
    /// The worker cancelled the request; its answer is dropped.
    cancelled: bool,
    /// Body bytes emitted into the core.
    delivered: u64,
}

#[derive(Default)]
struct State {
    resources: HashMap<u32, Resource>,
    facts: VecDeque<Fact>,
}

pub struct HttpNode {
    exchange: Box<dyn Exchange>,
    notify: Arc<Notify>,
    /// The largest `maxBytes` a descriptor may ask for.
    response_bytes: usize,
    state: Mutex<State>,
}

impl HttpNode {
    pub fn new(
        exchange: Box<dyn Exchange>,
        notify: Arc<Notify>,
        response_bytes: usize,
    ) -> Arc<Self> {
        Arc::new(Self {
            exchange,
            notify,
            response_bytes,
            state: Mutex::default(),
        })
    }

    /// The node's driver; its context is `node`, which outlives the core.
    pub fn driver(node: &Arc<Self>) -> Driver {
        Driver {
            struct_size: size_of::<Driver>() as u32,
            context: Arc::as_ptr(node) as *mut c_void,
            open: Some(open),
            start: Some(start),
            write: None,
            cancel: Some(cancel),
            close: Some(close),
            validate: None,
        }
    }

    /// Owner task: emit queued facts until the core's event slots are full.
    /// True when the core took any.
    pub fn drain(&self, core: *mut Core) -> bool {
        let mut state = self.state.lock().unwrap();
        let mut took = false;
        while let Some(fact) = state.facts.front() {
            let status = unsafe {
                match fact {
                    Fact::Headers { handle, bytes } => pocket_worker_emit(
                        core,
                        *handle,
                        FACT_HEADERS,
                        OK,
                        0,
                        bytes.as_ptr(),
                        bytes.len(),
                    ),
                    Fact::Data {
                        handle,
                        offset,
                        bytes,
                    } => pocket_worker_emit(
                        core,
                        *handle,
                        FACT_DATA,
                        OK,
                        *offset,
                        bytes.as_ptr(),
                        bytes.len(),
                    ),
                    Fact::End {
                        handle,
                        request,
                        status,
                        offset,
                    } => pocket_worker_finish(core, *handle, *request, *status, *offset),
                }
            };
            if status == BUSY {
                break;
            }
            let delivered = match (status, fact) {
                (
                    OK,
                    Fact::Data {
                        handle,
                        offset,
                        bytes,
                    },
                ) => Some((*handle, offset + bytes.len() as u64)),
                _ => None,
            };
            took |= status == OK;
            state.facts.pop_front();
            if let Some((handle, end)) = delivered {
                if let Some(resource) = state.resources.get_mut(&handle) {
                    resource.delivered = end;
                }
            }
        }
        took
    }

    /// An answer becomes facts, unless its resource closed or cancelled the
    /// request meanwhile.
    fn answer(&self, handle: u32, request: u32, answer: Result<Response, Failure>, url: &str) {
        let mut state = self.state.lock().unwrap();
        match state.resources.get(&handle) {
            Some(resource) if resource.started == Some(request) && !resource.cancelled => {}
            _ => return,
        }
        let end = |status, offset| Fact::End {
            handle,
            request,
            status,
            offset,
        };
        match answer {
            Ok(response) => {
                let head = head(response.status, url, &response.headers);
                if head.len() > MAX_PAYLOAD {
                    state.facts.push_back(end(FAILED, 0));
                } else {
                    state.facts.push_back(Fact::Headers {
                        handle,
                        bytes: head,
                    });
                    for (index, block) in response.body.chunks(MAX_PAYLOAD).enumerate() {
                        state.facts.push_back(Fact::Data {
                            handle,
                            offset: (index * MAX_PAYLOAD) as u64,
                            bytes: block.to_vec(),
                        });
                    }
                    state.facts.push_back(end(OK, response.body.len() as u64));
                }
            }
            Err(failure) => state
                .facts
                .push_back(end(if failure.reached { UNKNOWN } else { FAILED }, 0)),
        }
        drop(state);
        self.notify.wake();
    }
}

/// Headers an app reads first: the body's type, the cache validators, the
/// next page, a redirect and the rate limit.
const KEPT_FIRST: [&str; 10] = [
    "content-type",
    "etag",
    "last-modified",
    "link",
    "location",
    "retry-after",
    "x-ratelimit-remaining",
    "x-ratelimit-reset",
    "content-encoding",
    "cache-control",
];

/// The headers fact `{status, url, headers}`, within the core's 1 KiB payload:
/// when every header does not fit, KEPT_FIRST go in first, then the rest from
/// the shortest, while they fit.
fn head(status: u16, url: &str, headers: &BTreeMap<String, String>) -> Vec<u8> {
    let encode = |kept: &BTreeMap<String, String>| {
        serde_json::json!({ "status": status, "url": url, "headers": kept })
            .to_string()
            .into_bytes()
    };
    let whole = encode(headers);
    if whole.len() <= MAX_PAYLOAD {
        return whole;
    }
    let mut order: Vec<(&String, &String)> = headers.iter().collect();
    order.sort_by_key(|(name, value)| {
        (
            KEPT_FIRST
                .iter()
                .position(|kept| kept == name)
                .unwrap_or(KEPT_FIRST.len()),
            name.len() + value.len(),
        )
    });
    let mut kept = BTreeMap::new();
    for (name, value) in order {
        kept.insert(name.clone(), value.clone());
        if encode(&kept).len() > MAX_PAYLOAD {
            kept.remove(name);
        }
    }
    encode(&kept)
}

unsafe extern "C" fn open(
    context: *mut c_void,
    _: *mut Core,
    handle: u32,
    config: *const u8,
    length: usize,
) -> i32 {
    let node = &*(context as *const HttpNode);
    let descriptor = if length == 0 {
        &[][..]
    } else {
        std::slice::from_raw_parts(config, length)
    };
    let Some(request) =
        parse(descriptor, node.response_bytes).filter(|request| node.exchange.admits(request))
    else {
        return INVALID;
    };
    node.state.lock().unwrap().resources.insert(
        handle,
        Resource {
            request,
            started: None,
            cancelled: false,
            delivered: 0,
        },
    );
    OK
}

#[allow(clippy::too_many_arguments)]
unsafe extern "C" fn start(
    context: *mut c_void,
    _: *mut Core,
    handle: u32,
    request: u32,
    opcode: u32,
    _: *const u8,
    length: usize,
    _: usize,
) -> i32 {
    let job = {
        let node = &*(context as *const HttpNode);
        let mut state = node.state.lock().unwrap();
        let Some(resource) = state.resources.get_mut(&handle) else {
            return INVALID;
        };
        if opcode != 1 || length != 0 || resource.started.is_some() {
            return INVALID;
        }
        resource.started = Some(request);
        resource.request.clone()
    };
    // The context is the Arc driver() was given; each call holds its own.
    Arc::increment_strong_count(context as *const HttpNode);
    let node = Arc::from_raw(context as *const HttpNode);
    node.clone().exchange.start(Call {
        node,
        handle,
        request,
        job,
    });
    OK
}

/// The core reports the request UNKNOWN; its stream ends where delivery
/// stopped, and the call's answer is dropped.
unsafe extern "C" fn cancel(context: *mut c_void, core: *mut Core, handle: u32, request: u32) {
    let node = &*(context as *const HttpNode);
    let mut state = node.state.lock().unwrap();
    let Some(resource) = state.resources.get_mut(&handle) else {
        return;
    };
    if resource.started != Some(request) || resource.cancelled {
        return;
    }
    resource.cancelled = true;
    let delivered = resource.delivered;
    state.facts.retain(|fact| fact.handle() != handle);
    pocket_worker_finish(core, handle, request, UNKNOWN, delivered);
}

unsafe extern "C" fn close(context: *mut c_void, _: *mut Core, handle: u32) -> i32 {
    let node = &*(context as *const HttpNode);
    let mut state = node.state.lock().unwrap();
    state.resources.remove(&handle);
    state.facts.retain(|fact| fact.handle() != handle);
    OK
}

/// The descriptor `io.http(...).open` encodes (framework/src/io.ts), bounded
/// as contracts/spec/net.ts bounds it, with `maxBytes` at most
/// `response_bytes`.
pub fn parse(descriptor: &[u8], response_bytes: usize) -> Option<Request> {
    let value: serde_json::Value = serde_json::from_slice(descriptor).ok()?;
    let url = value.get("url")?.as_str()?.to_string();
    let method = match value.get("method") {
        Some(method) => method.as_str()?.to_string(),
        None => "GET".into(),
    };
    if !METHODS.contains(&method.as_str()) {
        return None;
    }
    let mut headers = BTreeMap::new();
    if let Some(fields) = value.get("headers") {
        for (name, value) in fields.as_object()? {
            let value = value.as_str()?;
            if name.contains(['\r', '\n', ':']) || value.contains(['\r', '\n']) {
                return None;
            }
            headers.insert(name.to_ascii_lowercase(), value.to_string());
        }
    }
    let body = match value.get("body") {
        Some(body) => body.as_str()?.as_bytes().to_vec(),
        None => Vec::new(),
    };
    let timeout = match value.get("timeoutMs") {
        Some(timeout) => timeout
            .as_u64()
            .filter(|ms| (1..=MAX_TIMEOUT_MS).contains(ms))?,
        None => DEFAULT_TIMEOUT_MS,
    };
    let max_bytes = match value.get("maxBytes") {
        Some(limit) => limit
            .as_u64()
            .filter(|bytes| (1..=response_bytes as u64).contains(bytes))?
            as usize,
        None => DEFAULT_RESPONSE_BYTES,
    };
    Some(Request {
        url,
        method,
        headers,
        body,
        timeout: Duration::from_millis(timeout),
        max_bytes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_long_head_keeps_what_an_app_reads_first() {
        let mut headers = BTreeMap::new();
        headers.insert("content-type".to_string(), "application/json".to_string());
        headers.insert("etag".to_string(), "W/\"abc\"".to_string());
        headers.insert(
            "link".to_string(),
            "<https://api.test/x?page=2>; rel=\"next\"".to_string(),
        );
        for i in 0..40 {
            headers.insert(format!("x-noise-{i}"), "n".repeat(40));
        }
        let bytes = head(200, "https://api.test/x", &headers);
        assert!(bytes.len() <= MAX_PAYLOAD);
        let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        for name in ["content-type", "etag", "link"] {
            assert!(value["headers"].get(name).is_some(), "{name}");
        }
        assert_eq!(value["status"], 200);
    }

    #[test]
    fn a_descriptor_parses_within_the_net_bounds() {
        let request = parse(br#"{"url":"https://a.test/x","method":"POST","headers":{"X-Key":"v"},"body":"hi","timeoutMs":5000,"maxBytes":1024}"#, MAX_RESPONSE_BYTES).unwrap();
        assert_eq!(request.method, "POST");
        assert_eq!(request.headers.get("x-key").map(String::as_str), Some("v"));
        assert_eq!(request.body, b"hi");
        assert_eq!(request.timeout, Duration::from_millis(5000));
        assert_eq!(request.max_bytes, 1024);
        let plain = parse(br#"{"url":"https://a.test/"}"#, MAX_RESPONSE_BYTES).unwrap();
        assert_eq!(
            (plain.method.as_str(), plain.max_bytes),
            ("GET", DEFAULT_RESPONSE_BYTES)
        );
        assert!(parse(
            br#"{"url":"https://a.test/","method":"FETCH"}"#,
            MAX_RESPONSE_BYTES
        )
        .is_none());
        assert!(parse(
            br#"{"url":"https://a.test/","headers":{"a:b":"c"}}"#,
            MAX_RESPONSE_BYTES
        )
        .is_none());
        assert!(parse(
            br#"{"url":"https://a.test/","headers":{"a":"b\nc"}}"#,
            MAX_RESPONSE_BYTES
        )
        .is_none());
        assert!(parse(
            br#"{"url":"https://a.test/","maxBytes":999999999}"#,
            MAX_RESPONSE_BYTES
        )
        .is_none());
        assert!(parse(
            br#"{"url":"https://a.test/","timeoutMs":0}"#,
            MAX_RESPONSE_BYTES
        )
        .is_none());
        assert!(parse(b"not json", MAX_RESPONSE_BYTES).is_none());
        // A host contract's larger limit admits a larger maxBytes.
        let large = br#"{"url":"https://a.test/","maxBytes":1048576}"#;
        assert!(parse(large, MAX_RESPONSE_BYTES).is_none());
        assert_eq!(parse(large, 4 << 20).unwrap().max_bytes, 1 << 20);
    }

    #[test]
    fn the_response_limit_is_the_host_contracts() {
        assert_eq!(
            contract_response_bytes(
                r#"{"worker":{"nodes":{"http":1},"http":{"responseBytes":4194304}}}"#
            ),
            4 << 20
        );
        assert_eq!(
            contract_response_bytes(r#"{"worker":{"nodes":{"http":1}}}"#),
            MAX_RESPONSE_BYTES
        );
        assert_eq!(contract_response_bytes("{}"), MAX_RESPONSE_BYTES);
    }
}
