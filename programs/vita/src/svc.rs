//! Host service channel (spec ops 30..33) over the WiFi transport (net.rs).
//!
//! Same guest-visible semantics as the PSP's usbhostfs mailbox: svcOpen is a
//! non-blocking probe the app retries (the connect-screen pump supplies the
//! cadence), svcPoll drains complete host lines up to the poll buffer,
//! svcSend appends one line, and loadImgFile resolves a side file — here
//! from the RAM cache the host filled with proactive FILE pushes, so the
//! synchronous op never waits on the network. A cache miss returns None and
//! the app's per-frame retry loop absorbs it.

use crate::net;

/// Path validation, verbatim from the PSP transport: svc-relative only.
fn valid_rel(rel: &str) -> bool {
    !rel.is_empty()
        && !rel.starts_with('/')
        && !rel.contains("..")
        && !rel.contains(':')
        && rel.len() <= 160
}

/// spec op 30: kick the transport for `app`, report connection state.
pub fn open(app: &str) -> bool {
    if app.is_empty() || app.len() > 64 {
        return false;
    }
    net::open(app)
}

pub fn active() -> bool {
    net::connected()
}

/// spec op 31: new complete host lines (batched, newline-joined).
pub fn poll() -> Option<String> {
    net::poll_lines()
}

/// spec op 32: append one device line to the outbox.
pub fn send(line: &[u8]) {
    net::send_line(line);
}

/// spec op 33 backing read: a side file from the push cache.
pub fn read_side_file(rel: &str, max: usize) -> Option<Vec<u8>> {
    if !valid_rel(rel) {
        return None;
    }
    net::side_file(rel, max)
}

/// Guest-switch reset (the PSP svc contract).
pub fn reset() {
    net::reset();
}
