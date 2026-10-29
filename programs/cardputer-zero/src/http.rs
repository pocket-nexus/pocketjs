//! The worker's `http` node on the CardputerZero: `io.http` requests over
//! loopback HTTP/1.1.
//!
//! The screen on this program is Pocket Companion's, so the servers it needs
//! run on this machine. `http://companion/…` goes to the companion's control
//! API: the port and the bearer token come from `control.json` in the
//! companion's store, read again for every request because a restarted
//! companion has a new port and token, and the worker never sees the token.
//! This host answers as a gateway: 503 when no companion runs and 502 when
//! its port does not answer, each with `{"error": …}`.
//! `http://127.0.0.1:<port>/…` and `http://localhost:<port>/…` go out as
//! written. The program's own host answers two requests: `http://zero/quit`
//! ends the program after the turn (the screen's way back to the Zero's
//! launcher), and `http://zero/restart` restarts the companion's systemd
//! unit, answering 204 once `systemctl` returns. Open refuses every other
//! URL: there is no DNS, TLS or proxy here.
//!
//! Each request runs on its own thread and queues its facts: HEADERS, DATA in
//! blocks of at most 1 KiB, END. The worker's owner task emits them into the
//! core when it waits or finishes a turn (worker.rs). A request thread never
//! touches the core, so close returns at once and a late answer is dropped.
use crate::worker::{
    pocket_worker_emit, pocket_worker_finish, Core, Driver, Notify, BUSY, FACT_DATA, FACT_HEADERS,
    FAILED, INVALID, MAX_PAYLOAD, OK, UNKNOWN,
};
use std::{
    collections::{BTreeMap, HashMap, VecDeque},
    ffi::c_void,
    io::{BufRead, BufReader, Read, Write},
    net::{SocketAddr, TcpStream},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

/// The virtual host that names the companion's control API.
const CONTROL_HOST: &str = "companion";
/// The default systemd unit `http://zero/restart` restarts.
pub const COMPANION_UNIT: &str = "pocket-companion.service";
/// Set by `http://zero/quit`; the tick loop ends when it is.
pub static QUIT: AtomicBool = AtomicBool::new(false);

/// contracts/spec/net.ts.
const METHODS: [&str; 7] = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
const DEFAULT_TIMEOUT_MS: u64 = 30_000;
const MAX_TIMEOUT_MS: u64 = 120_000;
const DEFAULT_RESPONSE_BYTES: usize = 128 * 1024;
const MAX_RESPONSE_BYTES: usize = 256 * 1024;

/// Where a request goes.
#[derive(Clone)]
enum Route {
    Quit,
    Restart,
    Companion {
        path: String,
    },
    Loopback {
        port: u16,
        host: String,
        path: String,
    },
}

/// An opened resource's request, parsed from its descriptor.
#[derive(Clone)]
struct Request {
    url: String,
    method: String,
    headers: BTreeMap<String, String>,
    body: Vec<u8>,
    timeout: Duration,
    max_bytes: usize,
    route: Route,
}

struct Response {
    status: u16,
    headers: BTreeMap<String, String>,
    body: Vec<u8>,
}

/// Why an exchange produced no response, and whether the request may have
/// reached its server.
struct Failure {
    reached: bool,
    message: String,
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
    /// The worker cancelled the request; its thread's answer is dropped.
    cancelled: bool,
    /// Body bytes emitted into the core.
    delivered: u64,
}

#[derive(Default)]
struct State {
    resources: HashMap<u32, Resource>,
    facts: VecDeque<Fact>,
}

pub struct Http {
    control: PathBuf,
    unit: String,
    notify: Arc<Notify>,
    state: Mutex<State>,
}

impl Http {
    pub fn new(control: PathBuf, unit: String, notify: Arc<Notify>) -> Self {
        Self {
            control,
            unit,
            notify,
            state: Mutex::default(),
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

    /// A request thread's answer becomes facts, unless its resource closed
    /// or cancelled the request meanwhile.
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
                let head = serde_json::json!({
                    "status": response.status, "url": url, "headers": response.headers,
                })
                .to_string()
                .into_bytes();
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

/// The node's driver; its context is `http`, which outlives the core.
pub fn driver(http: &Arc<Http>) -> Driver {
    Driver {
        struct_size: size_of::<Driver>() as u32,
        context: Arc::as_ptr(http) as *mut c_void,
        open: Some(open),
        start: Some(start),
        write: None,
        cancel: Some(cancel),
        close: Some(close),
        validate: None,
    }
}

unsafe extern "C" fn open(
    context: *mut c_void,
    _: *mut Core,
    handle: u32,
    config: *const u8,
    length: usize,
) -> i32 {
    let http = &*(context as *const Http);
    let descriptor = if length == 0 {
        &[][..]
    } else {
        std::slice::from_raw_parts(config, length)
    };
    let Some(request) = parse(descriptor) else {
        return INVALID;
    };
    http.state.lock().unwrap().resources.insert(
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
    let http = &*(context as *const Http);
    let job = {
        let mut state = http.state.lock().unwrap();
        let Some(resource) = state.resources.get_mut(&handle) else {
            return INVALID;
        };
        if opcode != 1 || length != 0 || resource.started.is_some() {
            return INVALID;
        }
        resource.started = Some(request);
        resource.request.clone()
    };
    if matches!(job.route, Route::Quit) {
        QUIT.store(true, Ordering::Relaxed);
        http.answer(handle, request, Ok(no_content()), &job.url);
        return OK;
    }
    // The context is the Arc driver() was given; each thread holds its own.
    Arc::increment_strong_count(context as *const Http);
    let owned = Arc::from_raw(context as *const Http);
    let spawned = std::thread::Builder::new()
        .name("pocket-http".into())
        .stack_size(64 * 1024)
        .spawn(move || {
            let answer = perform(&job, &owned.control, &owned.unit);
            owned.answer(handle, request, answer, &job.url);
        });
    if spawned.is_ok() {
        OK
    } else {
        FAILED
    }
}

/// The core reports the request UNKNOWN; its stream ends where delivery
/// stopped, and the thread's answer is dropped.
unsafe extern "C" fn cancel(context: *mut c_void, core: *mut Core, handle: u32, request: u32) {
    let http = &*(context as *const Http);
    let mut state = http.state.lock().unwrap();
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
    let http = &*(context as *const Http);
    let mut state = http.state.lock().unwrap();
    state.resources.remove(&handle);
    state.facts.retain(|fact| fact.handle() != handle);
    OK
}

fn no_content() -> Response {
    Response {
        status: 204,
        headers: BTreeMap::new(),
        body: Vec::new(),
    }
}

/// The descriptor `io.http(...).open` encodes (framework/src/io.ts), bounded
/// as contracts/spec/net.ts bounds it, with a URL this program can reach.
fn parse(descriptor: &[u8]) -> Option<Request> {
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
            .filter(|bytes| (1..=MAX_RESPONSE_BYTES as u64).contains(bytes))?
            as usize,
        None => DEFAULT_RESPONSE_BYTES,
    };
    let route = route(&url)?;
    Some(Request {
        url,
        method,
        headers,
        body,
        timeout: Duration::from_millis(timeout),
        max_bytes,
        route,
    })
}

fn route(url: &str) -> Option<Route> {
    match url {
        "http://zero/quit" => return Some(Route::Quit),
        "http://zero/restart" => return Some(Route::Restart),
        _ => {}
    }
    let rest = url.strip_prefix("http://")?;
    let (authority, path) = match rest.find('/') {
        Some(at) => (&rest[..at], &rest[at..]),
        None => (rest, "/"),
    };
    if path.contains([' ', '\r', '\n']) {
        return None;
    }
    if authority == CONTROL_HOST {
        return Some(Route::Companion { path: path.into() });
    }
    let (name, port) = authority.rsplit_once(':')?;
    if name != "127.0.0.1" && name != "localhost" {
        return None;
    }
    Some(Route::Loopback {
        port: port.parse().ok()?,
        host: authority.into(),
        path: path.into(),
    })
}

fn perform(request: &Request, control: &PathBuf, unit: &str) -> Result<Response, Failure> {
    match &request.route {
        Route::Quit => Ok(no_content()),
        Route::Restart => Ok(restart(unit)),
        Route::Loopback { port, host, path } => exchange(request, *port, host, path, None),
        Route::Companion { path } => Ok(match control_info(control) {
            Err(message) => gateway(503, message),
            Ok((port, token)) => {
                let host = format!("127.0.0.1:{port}");
                exchange(request, port, &host, path, Some(&token))
                    .unwrap_or_else(|failure| gateway(502, failure.message))
            }
        }),
    }
}

fn gateway(status: u16, message: String) -> Response {
    Response {
        status,
        headers: BTreeMap::from([("content-type".into(), "application/json".into())]),
        body: serde_json::to_vec(&serde_json::json!({ "error": message })).unwrap_or_default(),
    }
}

fn restart(unit: &str) -> Response {
    match std::process::Command::new("systemctl")
        .args(["restart", unit])
        .output()
    {
        Ok(output) if output.status.success() => no_content(),
        Ok(output) => Response {
            status: 500,
            headers: BTreeMap::new(),
            body: output.stderr,
        },
        Err(error) => Response {
            status: 500,
            headers: BTreeMap::new(),
            body: error.to_string().into_bytes(),
        },
    }
}

/// `{port, token}` from the companion's control.json.
fn control_info(path: &PathBuf) -> Result<(u16, String), String> {
    let text = std::fs::read_to_string(path).map_err(|error| {
        format!(
            "Pocket Companion is not running ({}: {error})",
            path.display()
        )
    })?;
    let value: serde_json::Value =
        serde_json::from_str(&text).map_err(|_| "control.json is not JSON".to_string())?;
    let port = value["port"]
        .as_u64()
        .filter(|port| (1..=65535).contains(port));
    let token = value["token"].as_str().filter(|token| !token.is_empty());
    match (port, token) {
        (Some(port), Some(token)) => Ok((port as u16, token.to_string())),
        _ => Err("control.json names no port and token".into()),
    }
}

/// One HTTP/1.1 exchange with `Connection: close`.
fn exchange(
    request: &Request,
    port: u16,
    host: &str,
    path: &str,
    token: Option<&str>,
) -> Result<Response, Failure> {
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let connect = |error: std::io::Error| Failure {
        reached: false,
        message: match error.kind() {
            std::io::ErrorKind::ConnectionRefused => {
                "nothing answers on this machine's port".into()
            }
            _ => error.to_string(),
        },
    };
    let lost = |error: std::io::Error| Failure {
        reached: true,
        message: match error.kind() {
            std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock => {
                "the request timed out".into()
            }
            _ => error.to_string(),
        },
    };
    let protocol = |message: &str| Failure {
        reached: true,
        message: message.into(),
    };
    let mut stream = TcpStream::connect_timeout(&address, request.timeout).map_err(connect)?;
    stream
        .set_read_timeout(Some(request.timeout))
        .map_err(lost)?;
    stream
        .set_write_timeout(Some(request.timeout))
        .map_err(lost)?;
    let mut head = format!(
        "{} {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\nContent-Length: {}\r\n",
        request.method,
        request.body.len()
    );
    for (name, value) in &request.headers {
        if !matches!(
            name.as_str(),
            "host" | "connection" | "content-length" | "authorization"
        ) {
            head.push_str(&format!("{name}: {value}\r\n"));
        }
    }
    if let Some(token) = token {
        head.push_str(&format!("Authorization: Bearer {token}\r\n"));
    }
    head.push_str("\r\n");
    stream.write_all(head.as_bytes()).map_err(lost)?;
    stream.write_all(&request.body).map_err(lost)?;

    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    reader.read_line(&mut line).map_err(lost)?;
    let status: u16 = line
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse().ok())
        .ok_or_else(|| protocol("not an HTTP response"))?;
    let mut headers = BTreeMap::new();
    loop {
        line.clear();
        if reader.read_line(&mut line).map_err(lost)? == 0 {
            break;
        }
        let field = line.trim_end();
        if field.is_empty() {
            break;
        }
        if let Some((name, value)) = field.split_once(':') {
            let name = name.trim().to_ascii_lowercase();
            let value = value.trim().to_string();
            headers
                .entry(name)
                .and_modify(|joined: &mut String| {
                    joined.push_str(", ");
                    joined.push_str(&value);
                })
                .or_insert(value);
        }
    }
    let too_large = || protocol("the response is over maxBytes");
    let mut body = Vec::new();
    if headers
        .get("transfer-encoding")
        .is_some_and(|value| value.eq_ignore_ascii_case("chunked"))
    {
        loop {
            line.clear();
            reader.read_line(&mut line).map_err(lost)?;
            let size = usize::from_str_radix(line.trim().split(';').next().unwrap_or(""), 16)
                .map_err(|_| protocol("bad chunk"))?;
            if size == 0 {
                break;
            }
            if body.len() + size > request.max_bytes {
                return Err(too_large());
            }
            let start = body.len();
            body.resize(start + size, 0);
            reader.read_exact(&mut body[start..]).map_err(lost)?;
            line.clear();
            reader.read_line(&mut line).map_err(lost)?;
        }
    } else {
        let limit = request.max_bytes as u64 + 1;
        reader.take(limit).read_to_end(&mut body).map_err(lost)?;
        if body.len() > request.max_bytes {
            return Err(too_large());
        }
    }
    headers.remove("transfer-encoding");
    Ok(Response {
        status,
        headers,
        body,
    })
}
