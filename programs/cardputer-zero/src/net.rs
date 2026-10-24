//! `globalThis.net` on the CardputerZero: the NET module's core
//! (`pocket-net`) over a loopback HTTP/1.1 transport.
//!
//! The applet on this program is Pocket Companion's own screen, so the only
//! servers it needs run on this machine. A request for `http://companion/…`
//! goes to the companion's control API: the port and the bearer token come
//! from `control.json` in the companion's store (read again for every request,
//! because a restarted companion has a new port and token), and the guest never
//! sees the token. A request for `http://127.0.0.1:<port>/…` or
//! `http://localhost:<port>/…` goes out as written. The program's own host
//! answers two requests: `http://zero/quit` ends the program after the turn
//! (the app's way back to the Zero's launcher), and `http://zero/restart`
//! restarts the companion's systemd unit, answering 204 once `systemctl`
//! returns. Every other URL fails with `invalid_request`: there is no DNS,
//! TLS or proxy in this transport.
//!
//! Each request runs on its own thread; completions cross into the
//! single-threaded core only at `begin_tick`, as `HttpTransport` requires.

use pocket_net::{HttpRequest, HttpTransport, NetCore, NetFailure, TransportCompletion};
use rquickjs::{ArrayBuffer, Ctx, Function, Object};
use std::{
    cell::RefCell,
    collections::{BTreeMap, HashSet},
    io::{BufRead, BufReader, Read, Write},
    net::{SocketAddr, TcpStream},
    path::PathBuf,
    rc::Rc,
    sync::{Arc, Mutex},
    time::Duration,
};

/// The virtual host that names the companion's control API.
pub const CONTROL_HOST: &str = "companion";
/// The default systemd unit `http://zero/restart` restarts.
pub const COMPANION_UNIT: &str = "pocket-companion.service";
/// Set by `http://zero/quit`; the tick loop ends when it is.
pub static QUIT: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub struct LocalHttp {
    control: PathBuf,
    unit: String,
    done: Arc<Mutex<Vec<TransportCompletion>>>,
    cancelled: Arc<Mutex<HashSet<i32>>>,
}

impl LocalHttp {
    pub fn new(control: PathBuf, unit: String) -> Self {
        Self {
            control,
            unit,
            done: Arc::default(),
            cancelled: Arc::default(),
        }
    }

    /// Run `work` on its own thread and hand its completion to the next tick.
    fn spawn(
        &mut self,
        handle: i32,
        work: impl FnOnce() -> TransportCompletion + Send + 'static,
    ) -> Result<(), NetFailure> {
        self.cancelled.lock().unwrap().remove(&handle);
        let done = self.done.clone();
        let cancelled = self.cancelled.clone();
        std::thread::Builder::new()
            .name("pocket-net".into())
            .stack_size(64 * 1024)
            .spawn(move || {
                let completion = work();
                if !cancelled.lock().unwrap().remove(&handle) {
                    done.lock().unwrap().push(completion);
                }
            })
            .map_err(|error| NetFailure::new("other", error.to_string()))?;
        Ok(())
    }
}

fn answered(handle: i32, url: String, status: u16, body: Vec<u8>) -> TransportCompletion {
    TransportCompletion::Done {
        handle,
        status,
        url,
        headers: BTreeMap::new(),
        body,
    }
}

impl HttpTransport for LocalHttp {
    fn start(&mut self, request: HttpRequest) -> Result<(), NetFailure> {
        let handle = request.handle;
        match request.url.as_str() {
            "http://zero/quit" => {
                QUIT.store(true, std::sync::atomic::Ordering::Relaxed);
                self.done
                    .lock()
                    .unwrap()
                    .push(answered(handle, request.url, 204, Vec::new()));
                return Ok(());
            }
            "http://zero/restart" => {
                let unit = self.unit.clone();
                return self.spawn(handle, move || {
                    match std::process::Command::new("systemctl")
                        .args(["restart", &unit])
                        .output()
                    {
                        Ok(output) if output.status.success() => {
                            answered(handle, request.url, 204, Vec::new())
                        }
                        Ok(output) => answered(handle, request.url, 500, output.stderr),
                        Err(error) => {
                            answered(handle, request.url, 500, error.to_string().into_bytes())
                        }
                    }
                });
            }
            _ => {}
        }
        let target = target(&request.url, &self.control)?;
        self.spawn(handle, move || match exchange(&request, &target) {
            Ok((status, headers, body)) => TransportCompletion::Done {
                handle,
                status,
                url: request.url.clone(),
                headers,
                body,
            },
            Err(failure) => TransportCompletion::Error { handle, failure },
        })
    }

    fn cancel(&mut self, handle: i32) {
        self.cancelled.lock().unwrap().insert(handle);
    }

    fn drain(&mut self, completions: &mut Vec<TransportCompletion>) {
        completions.append(&mut self.done.lock().unwrap());
    }
}

/// Where a request goes: a loopback address, the path and query, and the
/// headers the transport adds.
struct Target {
    address: SocketAddr,
    host: String,
    path: String,
    authorization: Option<String>,
}

fn unsupported(message: impl Into<String>) -> NetFailure {
    NetFailure::new("invalid_request", message)
}

fn target(url: &str, control: &PathBuf) -> Result<Target, NetFailure> {
    let rest = url
        .strip_prefix("http://")
        .ok_or_else(|| unsupported("this program reaches http:// on this machine only"))?;
    let (authority, path) = match rest.find('/') {
        Some(at) => (&rest[..at], &rest[at..]),
        None => (rest, "/"),
    };
    if authority == CONTROL_HOST {
        let (port, token) = control_info(control)?;
        return Ok(Target {
            address: SocketAddr::from(([127, 0, 0, 1], port)),
            host: format!("127.0.0.1:{port}"),
            path: path.to_string(),
            authorization: Some(format!("Bearer {token}")),
        });
    }
    let (name, port) = authority
        .rsplit_once(':')
        .ok_or_else(|| unsupported("a loopback URL names its port"))?;
    if name != "127.0.0.1" && name != "localhost" {
        return Err(unsupported(format!("{name} is not this machine")));
    }
    let port: u16 = port
        .parse()
        .map_err(|_| NetFailure::new("invalid_request", "bad port"))?;
    Ok(Target {
        address: SocketAddr::from(([127, 0, 0, 1], port)),
        host: authority.to_string(),
        path: path.to_string(),
        authorization: None,
    })
}

/// `{port, token}` from the companion's control.json.
fn control_info(path: &PathBuf) -> Result<(u16, String), NetFailure> {
    let unavailable = |message: String| NetFailure::new("unavailable", message);
    let text = std::fs::read_to_string(path).map_err(|error| {
        unavailable(format!(
            "Pocket Companion is not running ({}: {error})",
            path.display()
        ))
    })?;
    let value: serde_json::Value =
        serde_json::from_str(&text).map_err(|_| unavailable("control.json is not JSON".into()))?;
    let port = value["port"]
        .as_u64()
        .filter(|port| (1..=65535).contains(port));
    let token = value["token"].as_str().filter(|token| !token.is_empty());
    match (port, token) {
        (Some(port), Some(token)) => Ok((port as u16, token.to_string())),
        _ => Err(unavailable("control.json names no port and token".into())),
    }
}

/// One HTTP/1.1 exchange with `Connection: close`.
fn exchange(
    request: &HttpRequest,
    target: &Target,
) -> Result<(u16, BTreeMap<String, String>, Vec<u8>), NetFailure> {
    let timeout = Duration::from_millis(u64::from(request.timeout_ms.max(1)));
    let lost = |error: std::io::Error| match error.kind() {
        std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock => {
            NetFailure::new("timeout", "the request timed out")
        }
        std::io::ErrorKind::ConnectionRefused => {
            NetFailure::new("connect", "nothing answers on this machine's port")
        }
        _ => NetFailure::new("other", error.to_string()),
    };
    let mut stream = TcpStream::connect_timeout(&target.address, timeout).map_err(lost)?;
    stream.set_read_timeout(Some(timeout)).map_err(lost)?;
    stream.set_write_timeout(Some(timeout)).map_err(lost)?;
    let mut head = format!(
        "{} {} HTTP/1.1\r\nHost: {}\r\nConnection: close\r\nContent-Length: {}\r\n",
        request.method,
        target.path,
        target.host,
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
    if let Some(authorization) = &target.authorization {
        head.push_str(&format!("Authorization: {authorization}\r\n"));
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
        .ok_or_else(|| NetFailure::new("protocol", "not an HTTP response"))?;
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
    let too_large = || NetFailure::new("response_too_large", "the response is over maxBytes");
    let mut body = Vec::new();
    if headers
        .get("transfer-encoding")
        .is_some_and(|value| value.eq_ignore_ascii_case("chunked"))
    {
        loop {
            line.clear();
            reader.read_line(&mut line).map_err(lost)?;
            let size = usize::from_str_radix(line.trim().split(';').next().unwrap_or(""), 16)
                .map_err(|_| NetFailure::new("protocol", "bad chunk"))?;
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
    Ok((status, headers, body))
}

/// The NET core this program's guest calls, shared with the tick loop.
pub type Net = Rc<RefCell<NetCore<LocalHttp>>>;

/// Install the five NET ops (`contracts/spec/net.ts`) as `globalThis.net`.
pub fn mount(ctx: &Ctx<'_>, core: &Net) -> rquickjs::Result<()> {
    let net = Object::new(ctx.clone())?;
    let start = core.clone();
    net.set(
        "start",
        Function::new(
            ctx.clone(),
            move |meta: String, body: ArrayBuffer| match body.as_bytes() {
                Some(bytes) => start.borrow_mut().start(&meta, bytes),
                None => start.borrow_mut().start(&meta, &[]),
            },
        )?,
    )?;
    let take = core.clone();
    net.set(
        "take",
        Function::new(ctx.clone(), move |handle: i32, into: ArrayBuffer| {
            let Some(raw) = into.as_raw() else {
                return -1;
            };
            // QuickJS owns this ArrayBuffer for the synchronous call.
            let bytes = unsafe { std::slice::from_raw_parts_mut(raw.ptr.as_ptr(), raw.len) };
            take.borrow_mut().take_into(handle, bytes)
        })?,
    )?;
    let cancel = core.clone();
    net.set(
        "cancel",
        Function::new(ctx.clone(), move |handle: i32| {
            cancel.borrow_mut().cancel(handle)
        })?,
    )?;
    let poll = core.clone();
    net.set(
        "poll",
        Function::new(ctx.clone(), move || poll.borrow_mut().poll())?,
    )?;
    let error = core.clone();
    net.set(
        "lastError",
        Function::new(ctx.clone(), move || error.borrow().last_error().to_string())?,
    )?;
    ctx.globals().set("net", net)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    fn request(url: String) -> HttpRequest {
        HttpRequest {
            handle: 1,
            url,
            method: "GET".into(),
            headers: BTreeMap::new(),
            body: Vec::new(),
            timeout_ms: 2000,
            max_bytes: 1024,
            max_redirects: 0,
        }
    }

    #[test]
    fn the_companion_host_carries_the_control_token_and_other_hosts_are_refused() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let dir = std::env::temp_dir().join(format!("pocket-zero-net-{port}"));
        std::fs::create_dir_all(&dir).unwrap();
        let control = dir.join("control.json");
        std::fs::write(
            &control,
            format!("{{\"port\":{port},\"token\":\"t0k\",\"pid\":1}}"),
        )
        .unwrap();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut seen = Vec::new();
            let mut buffer = [0u8; 1024];
            loop {
                let n = socket.read(&mut buffer).unwrap();
                seen.extend_from_slice(&buffer[..n]);
                if seen.windows(4).any(|w| w == b"\r\n\r\n") {
                    break;
                }
            }
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n2\r\n{}\r\n0\r\n\r\n")
                .unwrap();
            String::from_utf8(seen).unwrap()
        });
        let to = target("http://companion/status", &control).unwrap();
        let (status, headers, body) =
            exchange(&request("http://companion/status".into()), &to).unwrap();
        let sent = server.join().unwrap();
        assert!(sent.starts_with("GET /status HTTP/1.1\r\n"));
        assert!(sent.contains("Authorization: Bearer t0k\r\n"));
        assert_eq!((status, body.as_slice()), (200, &b"{}"[..]));
        assert_eq!(
            headers.get("content-type").map(String::as_str),
            Some("application/json")
        );
        assert!(!headers.contains_key("transfer-encoding"));
        for url in [
            "https://companion/status",
            "http://example.com:80/",
            "http://10.0.0.1:80/",
        ] {
            assert_eq!(target(url, &control).err().unwrap().code, "invalid_request");
        }
        std::fs::remove_file(&control).unwrap();
        assert_eq!(
            target("http://companion/status", &control)
                .err()
                .unwrap()
                .code,
            "unavailable"
        );
    }
}
