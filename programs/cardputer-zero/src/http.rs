//! The worker's `http` exchange on the CardputerZero: `io.http` requests over
//! loopback HTTP/1.1 (the node itself is pocket-linux-worker's).
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
//! unit, answering 204 once `systemctl` returns. The node refuses every other
//! URL at open: there is no DNS, TLS or proxy here. Each request runs on its
//! own thread.
use pocket_linux_worker::{Call, Exchange, Failure, Request, Response};
use std::{
    collections::BTreeMap,
    io::{BufRead, BufReader, Read, Write},
    net::{SocketAddr, TcpStream},
    path::PathBuf,
    sync::atomic::{AtomicBool, Ordering},
};

/// The virtual host that names the companion's control API.
const CONTROL_HOST: &str = "companion";
/// The default systemd unit `http://zero/restart` restarts.
pub const COMPANION_UNIT: &str = "pocket-companion.service";
/// Set by `http://zero/quit`; the tick loop ends when it is.
pub static QUIT: AtomicBool = AtomicBool::new(false);

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

/// The program's exchange: the companion's control file and unit.
pub struct ZeroExchange {
    control: PathBuf,
    unit: String,
}

impl ZeroExchange {
    pub fn new(control: PathBuf, unit: String) -> Self {
        Self { control, unit }
    }
}

impl Exchange for ZeroExchange {
    fn admits(&self, request: &Request) -> bool {
        route(&request.url).is_some()
    }
    fn start(&self, call: Call) {
        let Some(route) = route(&call.request().url) else {
            return call.answer(Err(Failure {
                reached: false,
                message: "unreachable URL".into(),
            }));
        };
        if matches!(route, Route::Quit) {
            QUIT.store(true, Ordering::Relaxed);
            return call.answer(Ok(no_content()));
        }
        let (control, unit) = (self.control.clone(), self.unit.clone());
        let spawned = std::thread::Builder::new()
            .name("pocket-http".into())
            .stack_size(64 * 1024)
            .spawn(move || {
                let answer = perform(call.request(), &route, &control, &unit);
                call.answer(answer);
            });
        if let Err(error) = spawned {
            eprintln!("pocket-cardputer-zero: http thread: {error}");
        }
    }
}

fn no_content() -> Response {
    Response {
        status: 204,
        headers: BTreeMap::new(),
        body: Vec::new(),
    }
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

fn perform(
    request: &Request,
    route: &Route,
    control: &PathBuf,
    unit: &str,
) -> Result<Response, Failure> {
    match route {
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
