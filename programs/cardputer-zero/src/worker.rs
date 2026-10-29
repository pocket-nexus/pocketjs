//! The package's worker domain: engine/worker's C runner on its own thread
//! (the owner task), with the primitives the runner asks of a platform: a
//! core lock, a wake notification and a monotonic clock. The worker has one
//! node, `http` (http.rs); its request threads queue facts that the owner
//! task emits into the core whenever it waits or finishes a turn.
//!
//! The guest (main.rs) starts the worker before the UI bundle evaluates,
//! attaches the UI realm's channel bridge (`pocket_worker_ui_*`) to the core,
//! latches it before every frame, and detaches it before the worker stops.
use crate::http::{self, Http};
use std::{
    cell::UnsafeCell,
    ffi::{c_char, c_int, c_void, CStr},
    ptr,
    sync::{
        atomic::{AtomicPtr, Ordering},
        mpsc, Arc, Condvar, Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

pub const OK: i32 = 0;
pub const FAILED: i32 = -1;
pub const UNKNOWN: i32 = -3;
pub const BUSY: i32 = -4;
pub const INVALID: i32 = -5;
pub const KIND_HTTP: u32 = 3;
pub const FACT_DATA: u32 = 3;
pub const FACT_HEADERS: u32 = 8;
pub const MAX_PAYLOAD: usize = 1024;

/// `pocket_worker`, the resource core.
#[repr(C)]
pub struct Core {
    _opaque: [u8; 0],
}
#[repr(C)]
struct Runner {
    _opaque: [u8; 0],
}
#[repr(C)]
pub struct Bridge {
    _opaque: [u8; 0],
}

type Callback = unsafe extern "C" fn(*mut c_void);
type Clock = unsafe extern "C" fn(*mut c_void) -> u64;

/// `pocket_worker_driver` (pocket/worker.h).
#[repr(C)]
pub struct Driver {
    pub struct_size: u32,
    pub context: *mut c_void,
    pub open: Option<unsafe extern "C" fn(*mut c_void, *mut Core, u32, *const u8, usize) -> i32>,
    pub start: Option<
        unsafe extern "C" fn(*mut c_void, *mut Core, u32, u32, u32, *const u8, usize, usize) -> i32,
    >,
    pub write: Option<unsafe extern "C" fn(*mut c_void, *mut Core, u32, *const u8, usize) -> i32>,
    pub cancel: Option<unsafe extern "C" fn(*mut c_void, *mut Core, u32, u32)>,
    pub close: Option<unsafe extern "C" fn(*mut c_void, *mut Core, u32) -> i32>,
    pub validate: Option<
        unsafe extern "C" fn(*mut c_void, *mut Core, u32, u32, *const u8, usize, usize) -> i32,
    >,
}
#[repr(C)]
struct Node {
    struct_size: u32,
    kind: u32,
    name: *const c_char,
    driver: *const Driver,
}
#[repr(C)]
struct CoreConfig {
    struct_size: u32,
    generation: u32,
    nodes: *const Node,
    node_count: usize,
    context: *mut c_void,
    lock: Option<Callback>,
    unlock: Option<Callback>,
    wake: Option<Callback>,
    now_micros: Option<Clock>,
}
/// `pocket_worker_quickjs_config` (pocket/worker_quickjs.h).
#[repr(C)]
struct RealmConfig {
    struct_size: u32,
    worker: *mut Core,
    heap_limit: usize,
    stack_limit: usize,
    max_jobs: u32,
    max_facts: u32,
    max_bytes: u32,
    window_micros: u32,
    quota_micros: u32,
    context: *mut c_void,
    now_micros: Option<Clock>,
    mount: Option<unsafe extern "C" fn(*mut c_void, *mut c_void) -> i32>,
    allocator: *const c_void,
    allocator_context: *mut c_void,
}
/// `pocket_worker_runner_config` (pocket/worker_runner.h).
#[repr(C)]
struct RunnerConfig {
    struct_size: u32,
    core: CoreConfig,
    realm: RealmConfig,
    source: *const c_char,
    source_size: usize,
    context: *mut c_void,
    wait: Option<unsafe extern "C" fn(*mut c_void, u64)>,
    after_turn: Option<Callback>,
    start_paused: c_int,
}

extern "C" {
    fn pocket_worker_runner_create(config: *const RunnerConfig) -> *mut Runner;
    fn pocket_worker_runner_run(runner: *mut Runner);
    fn pocket_worker_runner_stop(runner: *mut Runner);
    fn pocket_worker_runner_failed(runner: *const Runner) -> c_int;
    fn pocket_worker_runner_error(runner: *const Runner) -> *const c_char;
    fn pocket_worker_runner_core(runner: *mut Runner) -> *mut Core;
    fn pocket_worker_runner_destroy(runner: *mut Runner);
    pub fn pocket_worker_emit(
        core: *mut Core,
        handle: u32,
        kind: u32,
        status: i32,
        offset: u64,
        data: *const u8,
        length: usize,
    ) -> i32;
    pub fn pocket_worker_finish(
        core: *mut Core,
        handle: u32,
        request: u32,
        status: i32,
        offset: u64,
    ) -> i32;
    pub fn pocket_worker_ui_attach(
        context: *mut rquickjs::qjs::JSContext,
        core: *mut Core,
    ) -> *mut Bridge;
    pub fn pocket_worker_ui_latch(bridge: *mut Bridge) -> i32;
    pub fn pocket_worker_ui_detach(bridge: *mut Bridge);
}

/// The owner task's notification: a wake that arrives while the task runs
/// stays set, so the next wait returns at once.
#[derive(Default)]
pub struct Notify {
    woken: Mutex<bool>,
    signal: Condvar,
}
impl Notify {
    pub fn wake(&self) {
        *self.woken.lock().unwrap() = true;
        self.signal.notify_one();
    }
}

/// What the C callbacks reach through their context pointer.
struct Host {
    /// The core's lock: lock and unlock arrive as separate calls.
    lock: UnsafeCell<libc::pthread_mutex_t>,
    notify: Arc<Notify>,
    epoch: Instant,
    http: Arc<Http>,
    /// Set once bootstrap succeeds; the owner task drains http's facts into it.
    core: AtomicPtr<Core>,
}
unsafe impl Send for Host {}
unsafe impl Sync for Host {}

impl Host {
    fn now(&self) -> u64 {
        self.epoch.elapsed().as_micros() as u64
    }
    fn drain(&self) -> bool {
        let core = self.core.load(Ordering::Acquire);
        !core.is_null() && self.http.drain(core)
    }
}

unsafe extern "C" fn lock(context: *mut c_void) {
    libc::pthread_mutex_lock((*(context as *const Host)).lock.get());
}
unsafe extern "C" fn unlock(context: *mut c_void) {
    libc::pthread_mutex_unlock((*(context as *const Host)).lock.get());
}
unsafe extern "C" fn wake(context: *mut c_void) {
    (*(context as *const Host)).notify.wake();
}
unsafe extern "C" fn now_micros(context: *mut c_void) -> u64 {
    (*(context as *const Host)).now()
}
/// The runner's idle wait. Facts the request threads queued land in the core
/// before the next step: on entry, and after a wake or the deadline.
unsafe extern "C" fn wait(context: *mut c_void, deadline: u64) {
    let host = &*(context as *const Host);
    if host.drain() {
        return;
    }
    let mut woken = host.notify.woken.lock().unwrap();
    while !*woken {
        let now = host.now();
        woken = if deadline == u64::MAX {
            host.notify.signal.wait(woken).unwrap()
        } else if now < deadline {
            host.notify
                .signal
                .wait_timeout(woken, Duration::from_micros(deadline - now))
                .unwrap()
                .0
        } else {
            break;
        };
    }
    *woken = false;
    drop(woken);
    host.drain();
}
unsafe extern "C" fn after_turn(context: *mut c_void) {
    (*(context as *const Host)).drain();
}

struct RunnerHandle(*mut Runner);
unsafe impl Send for RunnerHandle {}

/// A running worker domain. Dropping it ends the owner loop and waits until
/// the core and the realm are gone; detach the UI bridge first.
pub struct Worker {
    runner: *mut Runner,
    thread: Option<JoinHandle<()>>,
}

impl Worker {
    /// Evaluate `source` (section 8, NUL-terminated) on a new owner thread and
    /// return once its bootstrap declared the channels, or with the cause.
    pub fn start(source: &[u8], http: Arc<Http>, notify: Arc<Notify>) -> Result<Self, String> {
        if source.len() < 2 || source.last() != Some(&0) {
            return Err("the worker bundle is not NUL-terminated".into());
        }
        let source = source.to_vec();
        let host = Arc::new(Host {
            lock: UnsafeCell::new(libc::PTHREAD_MUTEX_INITIALIZER),
            notify,
            epoch: Instant::now(),
            http,
            core: AtomicPtr::new(ptr::null_mut()),
        });
        let (booted, boot) = mpsc::sync_channel(1);
        let thread = thread::Builder::new()
            .name("pocket-worker".into())
            .stack_size(1024 * 1024)
            .spawn(move || own(host, source, booted))
            .map_err(|error| error.to_string())?;
        match boot.recv() {
            Ok(Ok(RunnerHandle(runner))) => Ok(Self {
                runner,
                thread: Some(thread),
            }),
            Ok(Err(message)) => {
                let _ = thread.join();
                Err(message)
            }
            Err(_) => Err("the worker thread ended during bootstrap".into()),
        }
    }

    /// The resource core, for the UI bridge; valid until the worker drops.
    pub fn core(&self) -> *mut Core {
        unsafe { pocket_worker_runner_core(self.runner) }
    }

    /// The realm's fault, once it has one.
    pub fn fault(&self) -> Option<String> {
        unsafe {
            (pocket_worker_runner_failed(self.runner) != 0).then(|| {
                CStr::from_ptr(pocket_worker_runner_error(self.runner))
                    .to_string_lossy()
                    .into_owned()
            })
        }
    }
}

impl Drop for Worker {
    fn drop(&mut self) {
        unsafe { pocket_worker_runner_stop(self.runner) };
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

/// The owner thread: bootstrap, the runner's loop until stop, destroy. The
/// node table and the bundle live in this frame until destroy returns.
fn own(host: Arc<Host>, source: Vec<u8>, booted: mpsc::SyncSender<Result<RunnerHandle, String>>) {
    let context = Arc::as_ptr(&host) as *mut c_void;
    let driver = http::driver(&host.http);
    let node = Node {
        struct_size: size_of::<Node>() as u32,
        kind: KIND_HTTP,
        name: c"http".as_ptr(),
        driver: &driver,
    };
    let config = RunnerConfig {
        struct_size: size_of::<RunnerConfig>() as u32,
        core: CoreConfig {
            struct_size: size_of::<CoreConfig>() as u32,
            generation: 1,
            nodes: &node,
            node_count: 1,
            context,
            lock: Some(lock),
            unlock: Some(unlock),
            wake: Some(wake),
            now_micros: Some(now_micros),
        },
        realm: RealmConfig {
            struct_size: size_of::<RealmConfig>() as u32,
            worker: ptr::null_mut(),
            heap_limit: 16 * 1024 * 1024,
            stack_limit: 256 * 1024,
            max_jobs: 0,
            max_facts: 0,
            max_bytes: 0,
            window_micros: 0,
            quota_micros: 0,
            context,
            now_micros: Some(now_micros),
            mount: None,
            allocator: ptr::null(),
            allocator_context: ptr::null_mut(),
        },
        source: source.as_ptr() as *const c_char,
        source_size: source.len() - 1,
        context,
        wait: Some(wait),
        after_turn: Some(after_turn),
        start_paused: 0,
    };
    let runner = unsafe { pocket_worker_runner_create(&config) };
    if runner.is_null() {
        let _ = booted.send(Err("worker runner allocation failed".into()));
        return;
    }
    if unsafe { pocket_worker_runner_failed(runner) } != 0 {
        let message = unsafe { CStr::from_ptr(pocket_worker_runner_error(runner)) }
            .to_string_lossy()
            .into_owned();
        unsafe { pocket_worker_runner_destroy(runner) };
        let _ = booted.send(Err(message));
        return;
    }
    host.core.store(
        unsafe { pocket_worker_runner_core(runner) },
        Ordering::Release,
    );
    if booted.send(Ok(RunnerHandle(runner))).is_err() {
        unsafe { pocket_worker_runner_stop(runner) };
    }
    unsafe {
        pocket_worker_runner_run(runner);
        pocket_worker_runner_destroy(runner);
    }
    host.core.store(ptr::null_mut(), Ordering::Release);
}
