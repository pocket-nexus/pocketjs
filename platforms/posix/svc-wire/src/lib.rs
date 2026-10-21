//! SVC WIRE (PKNT) client for the desktop host — the companion channel over
//! TCP (contracts/spec/spec.ts "SVC WIRE protocol").
//!
//! `programs/desktop` already answers `svcOpen` from an allowlist and moves
//! lines through two in-process queues, which is all the note editor needs
//! because its companion IS the host. An app whose companion is a separate
//! program — Pocket Term, whose daemon holds the PTYs — needs those queues fed
//! from a socket instead. That is this module: the same wire the console
//! speaks (`products/3ds/src/svcwire.c`), the same codec
//! (`pocketjs_core::wire`), so one companion serves a 3DS and a desktop
//! window without knowing which is which.
//!
//! Threading follows `platforms/vita/net/src/lib.rs`: a supervisor thread owns
//! connect/handshake/read and a writer thread owns the socket's send side,
//! so the fixed-step tick on the main thread only ever moves queues. The
//! address is given (`--svc-connect host:port`) rather than discovered — a
//! window opened by the companion already knows where it came from, and UDP
//! discovery is for consoles that do not.

use std::collections::VecDeque;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use pocket_media::wire as codec;
use pocket_spec::wire;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);
const READ_TIMEOUT: Duration = Duration::from_millis(250);
const BACKOFF: Duration = Duration::from_secs(1);
/// Inbound lines held for the guest between ticks. The companion paces its
/// own bulk (font atlases arrive as chunks), so this only has to absorb a
/// burst, not a stream.
const LINE_QUEUE_CAP: usize = 512;
/** How long a writer waits to be woken before re-checking the connection. */
const WRITER_IDLE: Duration = Duration::from_millis(200);

/// Frames waiting to go out, and the signal that wakes the writer.
///
/// A keystroke has to reach the socket the moment it is produced. Parking
/// outgoing frames behind the read loop — which sits in a 250 ms blocking
/// read whenever the terminal is quiet — put an entire read timeout between
/// pressing a key and the character appearing: measured p50 133 ms against
/// a companion whose own round trip is 4.6 ms. The console never had this
/// because its transport pumps send and receive independently every frame
/// (products/3ds/src/svcwire.c); here that separation is a condvar.
#[derive(Default)]
struct Outbox {
    queue: Mutex<VecDeque<Vec<u8>>>,
    woken: Condvar,
}

impl Outbox {
    fn push(&self, frame: Vec<u8>) {
        if let Ok(mut queue) = self.queue.lock() {
            queue.push_back(frame);
            self.woken.notify_one();
        }
    }

    /// Take everything queued, waiting briefly when there is nothing.
    fn take(&self) -> Vec<Vec<u8>> {
        let Ok(queue) = self.queue.lock() else {
            return Vec::new();
        };
        let mut queue = if queue.is_empty() {
            match self.woken.wait_timeout(queue, WRITER_IDLE) {
                Ok((queue, _)) => queue,
                Err(_) => return Vec::new(),
            }
        } else {
            queue
        };
        queue.drain(..).collect()
    }

    fn clear(&self) {
        if let Ok(mut queue) = self.queue.lock() {
            queue.clear();
        }
    }
}

pub struct SvcWire {
    lines: Receiver<String>,
    outbox: Arc<Outbox>,
    shutdown: Arc<AtomicBool>,
    pending: Vec<String>,
}

impl SvcWire {
    /// Start connecting to `addr` as `app`. Returns immediately; the guest's
    /// `svcOpen` probe is answered from the allowlist as before, and the
    /// app's own connect screen covers the time before the first line lands.
    pub fn spawn(addr: String, app: String) -> Self {
        let (line_tx, line_rx) = channel::<String>();
        let outbox = Arc::new(Outbox::default());
        let shutdown = Arc::new(AtomicBool::new(false));
        {
            let outbox = outbox.clone();
            let shutdown = shutdown.clone();
            std::thread::Builder::new()
                .name("pjs-svc-wire".into())
                .spawn(move || supervisor(&addr, &app, &line_tx, &outbox, &shutdown))
                .expect("spawn svc wire thread");
        }
        Self {
            lines: line_rx,
            outbox,
            shutdown,
            pending: Vec::new(),
        }
    }

    /// Take everything the companion has said since the last tick. The app
    /// reads the channel's state from its own protocol — a replica is "live"
    /// once a grid has arrived, not when a socket happens to be open.
    pub fn drain(&mut self) -> Vec<String> {
        let mut out = std::mem::take(&mut self.pending);
        while let Ok(line) = self.lines.try_recv() {
            out.push(line);
        }
        out
    }

    pub fn send(&self, line: String) {
        if let Some(frame) = ctrl_frame(wire::MSG_CTRL, line.as_bytes()) {
            self.outbox.push(frame);
        }
    }
}

impl Drop for SvcWire {
    fn drop(&mut self) {
        self.shutdown.store(true, Ordering::Release);
    }
}

fn supervisor(
    addr: &str,
    app: &str,
    lines: &Sender<String>,
    outbox: &Arc<Outbox>,
    shutdown: &Arc<AtomicBool>,
) {
    while !shutdown.load(Ordering::Acquire) {
        match connect(addr, app) {
            Ok(stream) => {
                log::info!("pocket-desktop-host: svc wire connected to {addr}");
                // Whatever piled up while disconnected is stale input, and a
                // shell should not receive a keystroke from a minute ago.
                outbox.clear();
                let why = serve(stream, lines, outbox, shutdown);
                log::info!("pocket-desktop-host: svc wire disconnected: {why}");
            }
            Err(error) => log::debug!("pocket-desktop-host: svc wire connect {addr}: {error}"),
        }
        std::thread::sleep(BACKOFF);
    }
}

fn connect(addr: &str, app: &str) -> std::io::Result<TcpStream> {
    let target = addr
        .parse()
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidInput, "host:port"))?;
    let stream = TcpStream::connect_timeout(&target, CONNECT_TIMEOUT)?;
    stream.set_nodelay(true)?;
    stream.set_read_timeout(Some(READ_TIMEOUT))?;
    let mut hello = [0u8; 80];
    let n = codec::encode_hello(app, &mut hello)
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "app id"))?;
    (&stream).write_all(&hello[..n])?;
    let mut ack = [0u8; 8];
    read_full(&stream, &mut ack, &AtomicBool::new(false))?;
    if codec::parse_hello_ack(&ack) != Some(wire::VERSION) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "handshake",
        ));
    }
    Ok(stream)
}

/// read_exact across read-timeout ticks, re-checking shutdown between them.
fn read_full(mut stream: &TcpStream, buf: &mut [u8], shutdown: &AtomicBool) -> std::io::Result<()> {
    let mut got = 0usize;
    while got < buf.len() {
        if shutdown.load(Ordering::Acquire) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::Interrupted,
                "shutdown",
            ));
        }
        match stream.read(&mut buf[got..]) {
            Ok(0) => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::UnexpectedEof,
                    "eof",
                ));
            }
            Ok(n) => got += n,
            Err(e)
                if e.kind() == std::io::ErrorKind::WouldBlock
                    || e.kind() == std::io::ErrorKind::TimedOut => {}
            Err(e) => return Err(e),
        }
    }
    Ok(())
}

fn serve(
    stream: TcpStream,
    lines: &Sender<String>,
    outbox: &Arc<Outbox>,
    shutdown: &Arc<AtomicBool>,
) -> String {
    let writer = match stream.try_clone() {
        Ok(writer) => writer,
        Err(e) => return format!("clone: {e}"),
    };
    // The writer owns the outbox: a frame queued by the tick thread or by the
    // reader goes out as soon as it is queued, never at the mercy of a
    // blocking read on the other half of the socket.
    let live = Arc::new(AtomicBool::new(true));
    let tx_thread = {
        let outbox = outbox.clone();
        let live = live.clone();
        let shutdown = shutdown.clone();
        std::thread::Builder::new()
            .name("pjs-svc-wire-tx".into())
            .spawn(move || {
                let mut writer = writer;
                while live.load(Ordering::Acquire) && !shutdown.load(Ordering::Acquire) {
                    for frame in outbox.take() {
                        if writer.write_all(&frame).is_err() {
                            return;
                        }
                    }
                }
            })
    };

    let why = rx_loop(&stream, lines, outbox, shutdown);
    live.store(false, Ordering::Release);
    // Wake the writer out of its wait so the thread can retire.
    outbox.push(Vec::new());
    if let Ok(handle) = tx_thread {
        let _ = handle.join();
    }
    outbox.clear();
    why
}

fn ctrl_frame(kind: u8, payload: &[u8]) -> Option<Vec<u8>> {
    let mut frame = vec![0u8; wire::HEADER_SIZE + payload.len()];
    if !codec::encode_frame_header(kind, 0, payload.len() as u32, &mut frame) {
        return None;
    }
    frame[wire::HEADER_SIZE..].copy_from_slice(payload);
    Some(frame)
}

fn rx_loop(
    stream: &TcpStream,
    lines: &Sender<String>,
    outbox: &Arc<Outbox>,
    shutdown: &Arc<AtomicBool>,
) -> String {
    let mut header = [0u8; wire::HEADER_SIZE];
    let mut payload: Vec<u8> = Vec::new();
    let mut queued = 0usize;
    loop {
        match read_header(stream, &mut header, shutdown) {
            Ok(false) => continue, // timed out with nothing pending; poll again
            Ok(true) => {}
            Err(e) => return format!("header: {e}"),
        }
        let Some(frame) = codec::parse_frame_header(&header) else {
            return "bad frame header".into();
        };
        payload.resize(frame.len as usize, 0);
        if let Err(e) = read_full(stream, &mut payload, shutdown) {
            return format!("payload: {e}");
        }
        match frame.kind {
            wire::MSG_PING => {
                if let Some(pong) = ctrl_frame(wire::MSG_PONG, &payload) {
                    outbox.push(pong);
                }
            }
            wire::MSG_CTRL => {
                if let Ok(line) = core::str::from_utf8(&payload)
                    && queued < LINE_QUEUE_CAP
                {
                    queued += 1;
                    if lines.send(line.to_owned()).is_err() {
                        return "guest gone".into();
                    }
                }
                // The tick drains everything each frame; the cap only guards
                // a stalled main thread, and it re-arms as soon as one lands.
                queued = queued.saturating_sub(1);
            }
            _ => {} // forward-compatible: file/stream types are not used here
        }
    }
}

/// One header read that tolerates the read timeout: `Ok(false)` means the
/// socket was merely idle, which is the loop's chance to flush the outbox.
fn read_header(
    mut stream: &TcpStream,
    header: &mut [u8; wire::HEADER_SIZE],
    shutdown: &Arc<AtomicBool>,
) -> std::io::Result<bool> {
    let mut got = 0usize;
    while got < header.len() {
        if shutdown.load(Ordering::Acquire) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::Interrupted,
                "shutdown",
            ));
        }
        match stream.read(&mut header[got..]) {
            Ok(0) => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::UnexpectedEof,
                    "eof",
                ));
            }
            Ok(n) => got += n,
            Err(e)
                if e.kind() == std::io::ErrorKind::WouldBlock
                    || e.kind() == std::io::ErrorKind::TimedOut =>
            {
                if got == 0 {
                    return Ok(false);
                }
            }
            Err(e) => return Err(e),
        }
    }
    Ok(true)
}
