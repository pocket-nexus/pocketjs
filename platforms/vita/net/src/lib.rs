#![allow(static_mut_refs)]
//! WiFi transport for the svc mailbox (spec.ts "SVC WIRE protocol").
//!
//! The Vita has no PSPLINK file share, so the mailbox + side files + .pkst
//! stream ride one TCP connection to the companion host, discovered through
//! its UDP beacon (or a `ux0:data/pocketjs/host.txt` override for broadcast-
//! hostile networks — one line, `192.168.x.y:8622`).
//!
//! Thread model — the 60 fps main thread NEVER blocks on the network:
//!
//!   main thread            supervisor thread            tx thread
//!   ───────────            ─────────────────            ─────────
//!   svcOpen  ── spawn once ─▶ discovery loop
//!   svcPoll ◀── line queue ◀─ TCP connect + handshake
//!   svcSend ──▶ tx channel ───────────────────────────▶ write_all frames
//!   loadImgFile ◀ file cache ◀ rx loop: CTRL → queue
//!   videoTick ◀ RamStream  ◀─          FILE → cache
//!                                      SLOT/CHUNK/MARK → RamStream
//!                                      PING → PONG via tx
//!                             on error: teardown, 1 s backoff, rediscover
//!
//! Main-thread ops only pop queues and take short-held mutexes (worst case
//! one ~130 KiB slot memcpy in videoTick). All raw sceNet FFI is confined to
//! `init()`; everything after rides std::net over the newlib socket shims.

use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4, TcpStream, UdpSocket};
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::Mutex;
use std::time::Duration;

use pocket_media::stream_rx::RamStream;
use pocket_media::wire as wirecodec;
use pocket_spec::wire;

pub mod stats;
use pocket_vita_system::vita_log;

/// sceNet internal buffer pool — the homebrew-conventional 1 MiB.
const NET_POOL_BYTES: u32 = 1024 * 1024;
/// Side-file (thumbnail) cache budget.
const FILE_CACHE_BYTES: usize = 6 * 1024 * 1024;
/// Inbound ctrl lines held for svcPoll before the oldest are dropped.
const LINE_QUEUE_CAP: usize = 256;
const HOST_TXT: &str = "ux0:data/pocketjs/host.txt";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);
const READ_TIMEOUT: Duration = Duration::from_millis(250);
const BACKOFF: Duration = Duration::from_secs(1);

// init() outcome: 0 = not tried, 1 = ok, 2 = failed (Vita3K stubs land here —
// svcOpen then stays false forever and the app sits on its connect screen).
static INIT_STATE: AtomicU8 = AtomicU8::new(0);
static SUPERVISOR_UP: AtomicBool = AtomicBool::new(false);
static CONNECTED: AtomicBool = AtomicBool::new(false);
static SHUTDOWN: AtomicBool = AtomicBool::new(false);

static LINES: Mutex<VecDeque<String>> = Mutex::new(VecDeque::new());
static TX: Mutex<Option<Sender<Vec<u8>>>> = Mutex::new(None);
static FILES: Mutex<Option<FileCache>> = Mutex::new(None);
/// The announced stream path + its RAM ring image. Replaced wholesale on
/// every streamOpen; vid.rs binds to it at videoOpen.
static STREAM: Mutex<Option<(String, RamStream)>> = Mutex::new(None);

struct FileCache {
    map: HashMap<String, Vec<u8>>,
    order: VecDeque<String>,
    bytes: usize,
}

impl FileCache {
    fn new() -> Self {
        Self {
            map: HashMap::new(),
            order: VecDeque::new(),
            bytes: 0,
        }
    }

    fn insert(&mut self, path: String, blob: Vec<u8>) {
        if let Some(old) = self.map.remove(&path) {
            self.bytes -= old.len();
            self.order.retain(|p| p != &path);
        }
        self.bytes += blob.len();
        self.order.push_back(path.clone());
        self.map.insert(path, blob);
        while self.bytes > FILE_CACHE_BYTES {
            let Some(oldest) = self.order.pop_front() else {
                break;
            };
            if let Some(gone) = self.map.remove(&oldest) {
                self.bytes -= gone.len();
                stats::FILE_CACHE_EVICTS.fetch_add(1, Ordering::Relaxed);
            }
        }
    }

    fn get(&self, path: &str) -> Option<Vec<u8>> {
        self.map.get(path).cloned()
    }
}

/// Load the net modules and bring up sceNet/sceNetCtl. Once. Failure is
/// remembered and final (graceful: emulators without a stack keep the app on
/// its connect screen instead of crashing).
fn init() -> bool {
    match INIT_STATE.load(Ordering::Acquire) {
        1 => return true,
        2 => return false,
        _ => {}
    }
    let ok = unsafe { init_scenet() };
    INIT_STATE.store(if ok { 1 } else { 2 }, Ordering::Release);
    if !ok {
        vita_log(format_args!(
            "[PocketJS net] sceNet init failed — svc stays offline"
        ));
    }
    ok
}

unsafe fn init_scenet() -> bool {
    use vitasdk_sys::*;
    // Static pool: sceNet keeps referencing it for the process lifetime.
    static mut NET_POOL: [u8; NET_POOL_BYTES as usize] = [0; NET_POOL_BYTES as usize];
    let loaded = sceSysmoduleLoadModule(SCE_SYSMODULE_NET as _);
    // 0 = ok; already-loaded is fine too (the error code differs per fw).
    if loaded < 0 && sceSysmoduleIsLoaded(SCE_SYSMODULE_NET as _) != 0 {
        return false;
    }
    let mut init = SceNetInitParam {
        memory: NET_POOL.as_mut_ptr() as *mut core::ffi::c_void,
        size: NET_POOL_BYTES as i32,
        flags: 0,
    };
    let rc = sceNetInit(&mut init);
    // Already-initialized is success for our purposes.
    if rc < 0 && rc != SCE_NET_ERROR_EBUSY as i32 {
        return false;
    }
    // vitasdk-sys exports no NetCtl error constants; this is the documented
    // SCE_NET_CTL_ERROR_NOT_TERMINATED ("already initialized") code.
    const NETCTL_NOT_TERMINATED: u32 = 0x8041_2102;
    let rc = sceNetCtlInit();
    if rc < 0 && rc as u32 != NETCTL_NOT_TERMINATED {
        return false;
    }
    true
}

/// Ensure the transport is coming up for `app`; report the live state.
/// Non-blocking — the app's connect-screen retry loop supplies the cadence.
pub fn open(app: &str) -> bool {
    if !init() {
        return false;
    }
    if !SUPERVISOR_UP.swap(true, Ordering::AcqRel) {
        let app = app.to_owned();
        if std::thread::Builder::new()
            .name("pjs-net".into())
            .stack_size(64 * 1024)
            .spawn(move || supervisor(&app))
            .is_err()
        {
            SUPERVISOR_UP.store(false, Ordering::Release);
            return false;
        }
    }
    CONNECTED.load(Ordering::Acquire)
}

pub fn connected() -> bool {
    CONNECTED.load(Ordering::Acquire)
}

/// Pop queued host→device lines, joined with trailing newlines, capped at
/// the svc poll buffer (the PSP batching contract).
pub fn poll_lines() -> Option<String> {
    let mut q = LINES.lock().ok()?;
    if q.is_empty() {
        return None;
    }
    let mut out = String::new();
    while let Some(front) = q.front() {
        if !out.is_empty() && out.len() + front.len() + 1 > pocket_spec::svc::POLL_BUF {
            break;
        }
        let line = q.pop_front().expect("front checked");
        out.push_str(&line);
        out.push('\n');
    }
    Some(out)
}

/// Queue one device→host ctrl line. Silently dropped while disconnected
/// (the PSP transport's inactive no-op contract).
pub fn send_line(line: &[u8]) {
    if line.len() > wire::MAX_PAYLOAD {
        return;
    }
    let mut frame = vec![0u8; wire::HEADER_SIZE + line.len()];
    if !wirecodec::encode_frame_header(wire::MSG_CTRL, 0, line.len() as u32, &mut frame) {
        return;
    }
    frame[wire::HEADER_SIZE..].copy_from_slice(line);
    if let Ok(tx) = TX.lock() {
        if let Some(tx) = tx.as_ref() {
            let _ = tx.send(frame);
            stats::NET_TX_BYTES
                .fetch_add((wire::HEADER_SIZE + line.len()) as u32, Ordering::Relaxed);
        }
    }
}

/// Side-file lookup (loadImgFile): pushed FILE payloads, LRU-bounded.
pub fn side_file(path: &str, max: usize) -> Option<Vec<u8>> {
    let files = FILES.lock().ok()?;
    let blob = files.as_ref()?.get(path)?;
    if blob.len() > max {
        return None;
    }
    Some(blob)
}

/// Run `f` over the current stream (path, ring) if one is open.
pub fn with_stream<R>(f: impl FnOnce(&str, &RamStream) -> R) -> Option<R> {
    let guard = STREAM.lock().ok()?;
    let (path, ram) = guard.as_ref()?;
    Some(f(path, ram))
}

/// Drop guest-visible transport state on app switch (svc reset contract).
pub fn reset() {
    if let Ok(mut q) = LINES.lock() {
        q.clear();
    }
    if let Ok(mut files) = FILES.lock() {
        *files = None;
    }
    if let Ok(mut stream) = STREAM.lock() {
        *stream = None;
    }
}

// ---------------------------------------------------------------------------
// supervisor
// ---------------------------------------------------------------------------

fn supervisor(app: &str) {
    // host.txt failures round-robin into beacon discovery: a STALE override
    // (the Mac's DHCP lease moved — observed on first hardware bring-up)
    // must degrade to broadcast discovery, never wedge the transport.
    let mut skip_host_txt = false;
    while !SHUTDOWN.load(Ordering::Acquire) {
        let Some(target) = discover(app, skip_host_txt) else {
            skip_host_txt = false;
            std::thread::sleep(BACKOFF);
            continue;
        };
        match connect(app, target) {
            Ok(stream) => {
                vita_log(format_args!("[PocketJS net] connected to {target}"));
                CONNECTED.store(true, Ordering::Release);
                let why = serve(stream);
                CONNECTED.store(false, Ordering::Release);
                *TX.lock().unwrap_or_else(|e| e.into_inner()) = None;
                stats::NET_RECONNECTS.fetch_add(1, Ordering::Relaxed);
                vita_log(format_args!("[PocketJS net] disconnected: {why}"));
                // A dead transport must not keep presenting a "live" stream.
                if let Ok(mut guard) = STREAM.lock() {
                    if let Some((_, ram)) = guard.as_mut() {
                        ram.apply_mark(&wirecodec::StreamMarkMsg {
                            epoch: u32::MAX,
                            ended: true,
                        });
                    }
                }
            }
            Err(err) => {
                vita_log(format_args!("[PocketJS net] connect {target}: {err}"));
                // If that came from host.txt, try the beacon next round.
                skip_host_txt = !skip_host_txt;
            }
        }
        std::thread::sleep(BACKOFF);
    }
}

/// `host.txt` override first (unless the last override attempt failed to
/// connect), then one beacon-listen window.
fn discover(app: &str, skip_host_txt: bool) -> Option<SocketAddr> {
    if !skip_host_txt {
        if let Ok(text) = std::fs::read_to_string(HOST_TXT) {
            if let Ok(addr) = text.trim().parse::<SocketAddr>() {
                return Some(addr);
            }
        }
    }
    let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, wire::BEACON_PORT)).ok()?;
    socket.set_read_timeout(Some(Duration::from_secs(2))).ok()?;
    let mut datagram = [0u8; 128];
    let deadline = std::time::Instant::now() + Duration::from_secs(4);
    while std::time::Instant::now() < deadline {
        let Ok((len, from)) = socket.recv_from(&mut datagram) else {
            continue;
        };
        let Some((port, beacon_app, _name)) = wirecodec::parse_beacon(&datagram[..len]) else {
            continue;
        };
        if beacon_app == app {
            return Some(SocketAddr::new(from.ip(), port));
        }
    }
    None
}

fn connect(app: &str, target: SocketAddr) -> std::io::Result<TcpStream> {
    let SocketAddr::V4(v4) = target else {
        return Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "ipv4 only",
        ));
    };
    let stream = TcpStream::connect_timeout(
        &SocketAddr::V4(SocketAddrV4::new(*v4.ip(), v4.port())),
        CONNECT_TIMEOUT,
    )?;
    stream.set_nodelay(true)?;
    stream.set_read_timeout(Some(READ_TIMEOUT))?;
    let mut hello = [0u8; 80];
    let n = wirecodec::encode_hello(app, &mut hello)
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "app id"))?;
    let mut w = &stream;
    w.write_all(&hello[..n])?;
    let mut ack = [0u8; 8];
    read_full(&stream, &mut ack)?;
    if wirecodec::parse_hello_ack(&ack) != Some(wire::VERSION) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "handshake",
        ));
    }
    Ok(stream)
}

/// read_exact across read-timeout ticks (each tick re-checks shutdown).
fn read_full(mut stream: &TcpStream, buf: &mut [u8]) -> std::io::Result<()> {
    let mut got = 0usize;
    while got < buf.len() {
        if SHUTDOWN.load(Ordering::Acquire) {
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
                ))
            }
            Ok(n) => got += n,
            Err(e)
                if e.kind() == std::io::ErrorKind::WouldBlock
                    || e.kind() == std::io::ErrorKind::TimedOut =>
            {
                continue;
            }
            Err(e) => return Err(e),
        }
    }
    stats::NET_RX_BYTES.fetch_add(buf.len() as u32, Ordering::Relaxed);
    Ok(())
}

/// One connection's lifetime: spawn the tx thread, then run the rx loop
/// until an error. Returns the reason for the log.
fn serve(stream: TcpStream) -> String {
    let (tx, rx): (Sender<Vec<u8>>, Receiver<Vec<u8>>) = channel();
    *TX.lock().unwrap_or_else(|e| e.into_inner()) = Some(tx.clone());
    if let Ok(mut files) = FILES.lock() {
        *files = Some(FileCache::new());
    }
    let writer = match stream.try_clone() {
        Ok(w) => w,
        Err(e) => return format!("clone: {e}"),
    };
    let tx_thread = std::thread::Builder::new()
        .name("pjs-net-tx".into())
        .stack_size(32 * 1024)
        .spawn(move || {
            let mut writer = writer;
            // Sender dropped (disconnect) ends the loop.
            while let Ok(frame) = rx.recv() {
                if writer.write_all(&frame).is_err() {
                    break;
                }
            }
        });

    let why = rx_loop(&stream, &tx);
    // Dropping the TX sender ends the tx thread's recv loop.
    *TX.lock().unwrap_or_else(|e| e.into_inner()) = None;
    drop(tx);
    if let Ok(handle) = tx_thread {
        let _ = handle.join();
    }
    why
}

fn rx_loop(stream: &TcpStream, tx: &Sender<Vec<u8>>) -> String {
    let mut header = [0u8; wire::HEADER_SIZE];
    let mut payload: Vec<u8> = Vec::new();
    loop {
        if let Err(e) = read_full(stream, &mut header) {
            return format!("header: {e}");
        }
        let Some(frame) = wirecodec::parse_frame_header(&header) else {
            return "bad frame header".into();
        };
        payload.resize(frame.len as usize, 0);
        if let Err(e) = read_full(stream, &mut payload) {
            return format!("payload: {e}");
        }
        match frame.kind {
            wire::MSG_PING => {
                let mut pong = vec![0u8; wire::HEADER_SIZE + payload.len()];
                if wirecodec::encode_frame_header(
                    wire::MSG_PONG,
                    0,
                    payload.len() as u32,
                    &mut pong,
                ) {
                    pong[wire::HEADER_SIZE..].copy_from_slice(&payload);
                    let _ = tx.send(pong);
                }
            }
            wire::MSG_CTRL => {
                if let Ok(line) = core::str::from_utf8(&payload) {
                    if let Ok(mut q) = LINES.lock() {
                        if q.len() >= LINE_QUEUE_CAP {
                            q.pop_front();
                        }
                        q.push_back(line.to_owned());
                    }
                }
            }
            wire::MSG_FILE => {
                if let Some((path, blob)) = wirecodec::parse_file(&payload) {
                    if let Ok(mut files) = FILES.lock() {
                        if let Some(cache) = files.as_mut() {
                            cache.insert(path.to_owned(), blob.to_vec());
                        }
                    }
                }
            }
            wire::MSG_STREAM_OPEN => {
                if let Some((path, block)) = wirecodec::parse_stream_open(&payload) {
                    if let Some(ram) = RamStream::open(block) {
                        if let Ok(mut stream_slot) = STREAM.lock() {
                            *stream_slot = Some((path.to_owned(), ram));
                        }
                    }
                }
            }
            wire::MSG_STREAM_CLOSE => {
                if let Ok(mut stream_slot) = STREAM.lock() {
                    *stream_slot = None;
                }
            }
            wire::MSG_VIDEO_SLOT => {
                if let Some(msg) = wirecodec::parse_video_slot(&payload) {
                    if let Ok(mut stream_slot) = STREAM.lock() {
                        if let Some((_, ram)) = stream_slot.as_mut() {
                            if ram.apply_slot(&msg) {
                                stats::NET_SLOTS_RX.fetch_add(1, Ordering::Relaxed);
                            }
                        }
                    }
                }
            }
            wire::MSG_AUDIO_CHUNK => {
                if let Some(msg) = wirecodec::parse_audio_chunk(&payload) {
                    if let Ok(mut stream_slot) = STREAM.lock() {
                        if let Some((_, ram)) = stream_slot.as_mut() {
                            ram.apply_chunk(&msg);
                        }
                    }
                }
            }
            wire::MSG_STREAM_MARK => {
                if let Some(msg) = wirecodec::parse_stream_mark(&payload) {
                    if let Ok(mut stream_slot) = STREAM.lock() {
                        if let Some((_, ram)) = stream_slot.as_mut() {
                            ram.apply_mark(&msg);
                        }
                    }
                }
            }
            _ => {} // forward-compatible: skip unknown types
        }
    }
}
