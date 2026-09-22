//! Default USB developer host. Only the worker touches host0: or storage.
//! The render thread owns QuickJS/GXM and exchanges bounded messages with it.
use crate::dev_protocol::{self as wire, Bundle, Command, Op, Session};
use serde_json::{json, Value};
use std::{
    fs,
    io::{Read, Write},
    sync::{
        atomic::{AtomicBool, AtomicI32, AtomicU32, Ordering},
        mpsc::{self, Receiver, SyncSender},
        Arc, Mutex, OnceLock,
    },
    time::{Duration, Instant},
};

include!(concat!(env!("OUT_DIR"), "/dev_identity.rs"));

#[derive(Default)]
struct Link {
    driver: AtomicI32,
    last_ms: AtomicU32,
    diagnostic: Mutex<String>,
    telemetry: Mutex<Value>,
}
fn clock_ms() -> u32 {
    unsafe { (vitasdk_sys::sceKernelGetProcessTimeWide() / 1000) as u32 }
}

pub struct Request {
    pub command: Command,
    pub bundle: Option<Bundle>,
    pub native_path: Option<String>,
    pub reply: SyncSender<Reply>,
    pub expires: Instant,
}

pub struct Reply {
    pub result: Result<Value, String>,
    pub pixels: Option<Vec<u8>>,
}

impl Request {
    pub fn finish(self, result: Result<Value, String>) {
        let _ = self.reply.try_send(Reply {
            result,
            pixels: None,
        });
    }
}

pub struct Host {
    requests: Receiver<Request>,
    shared: Arc<Mutex<Value>>,
    pub menu: crate::devmenu::Menu,
    pub generation: u32,
    pub active_hash: String,
    pub error: String,
    pub notice: String,
    boot: String,
    native_slot: &'static str,
    captures: SyncSender<Reply>,
    link: Arc<Link>,
}

impl Host {
    pub fn new() -> Self {
        let (tx, rx) = mpsc::sync_channel(1);
        let (capture_tx, capture_rx) = mpsc::sync_channel(1);
        let boot = format!("{:016x}", unsafe {
            vitasdk_sys::sceKernelGetProcessTimeWide()
        });
        let shared = Arc::new(Mutex::new(json!({})));
        let link = Arc::new(Link::default());
        #[cfg(feature = "usb-debug")]
        if !TITLE_ID.is_empty() {
            let state = shared.clone();
            let worker_link = link.clone();
            if let Err(error) = std::thread::Builder::new()
                .name("pocket-vita-usb".into())
                .stack_size(512 * 1024)
                .spawn(move || worker(tx, capture_rx, state, worker_link))
            {
                *link.diagnostic.lock().unwrap() = format!("worker start: {error}");
            }
        }
        Self {
            requests: rx,
            shared,
            menu: Default::default(),
            generation: 0,
            active_hash: env!("POCKETJS_BUNDLE_HASH").into(),
            error: String::new(),
            notice: "USB commands: status / push / native / capture".into(),
            boot,
            native_slot: current_native_slot(),
            captures: capture_tx,
            link,
        }
    }

    pub fn poll(&self) -> Option<Request> {
        let request = self.requests.try_recv().ok()?;
        if Instant::now() >= request.expires {
            request.finish(Err("command expired before a frame boundary".into()));
            None
        } else {
            Some(request)
        }
    }

    pub unsafe fn capture_from_menu(&mut self, frame: u32) {
        self.notice = if self.captures.try_send(self.capture(frame)).is_ok() {
            "Frame queued for USB: menu-capture.rgba / menu-capture.json".into()
        } else {
            "Capture pending; start vita:dev serve on the computer".into()
        };
    }

    pub fn publish(&self, frame: u32, app: &str) {
        if let Ok(mut state) = self.shared.try_lock() {
            *state = self.status(frame, app);
        }
    }

    pub fn status(&self, frame: u32, app: &str) -> Value {
        json!({"version":wire::VERSION,"transport":"usb-hostfs", "titleId":TITLE_ID,
            "nativeBuild":NATIVE_BUILD,"nativeSlot":self.native_slot,"nativePath":current_native_path(),"boot":self.boot,"frame":frame,"app":app,
            "generation":self.generation,"bundle":self.active_hash,"error":self.error,
            "menu":self.menu.visible,"usbEnabled":cfg!(feature="usb-debug"),
            "driverResult":self.link.driver.load(Ordering::Relaxed),
            "telemetry":self.link.telemetry.try_lock().map(|v|v.clone()).unwrap_or(Value::Null),
            "usbDiagnostic":self.link.diagnostic.try_lock().map(|s|s.clone()).unwrap_or_default()})
    }

    pub unsafe fn overlay(&self) {
        if !self.menu.visible {
            return;
        }
        crate::devmenu::draw(&[
            "Pocket Runtime / PS Vita".into(),
            {
                let last = self.link.last_ms.load(Ordering::Relaxed);
                let driver = self.link.driver.load(Ordering::Relaxed);
                let state = if !cfg!(feature = "usb-debug") {
                    "disabled".into()
                } else if last != 0 && clock_ms().wrapping_sub(last) < 3000 {
                    "connected".into()
                } else if driver < 0 {
                    format!("waiting / driver 0x{:08x}", driver as u32)
                } else {
                    "waiting for computer".into()
                };
                format!("USB {state}   /   {TITLE_ID}")
            },
            format!("Native {}", NATIVE_BUILD),
            format!(
                "Guest {}   /   generation {}",
                self.active_hash, self.generation
            ),
            self.notice.chars().take(76).collect(),
            if self.error.is_empty() {
                "Guest running".into()
            } else {
                format!("Error: {}", self.error.chars().take(65).collect::<String>())
            },
            self.link
                .diagnostic
                .try_lock()
                .map(|s| {
                    if s.is_empty() {
                        "Computer: bun run vita:dev serve".into()
                    } else {
                        s.chars().take(80).collect()
                    }
                })
                .unwrap_or_default(),
            self.link
                .telemetry
                .try_lock()
                .ok()
                .and_then(|v| {
                    v["batteryPercent"].as_i64().map(|percent| {
                        format!(
                            "Battery {percent}% / {}",
                            if v["charging"].as_bool() == Some(true) {
                                "charging"
                            } else {
                                "not charging"
                            }
                        )
                    })
                })
                .unwrap_or_else(|| "Battery status pending".into()),
            "L + R + SELECT    Open / close this menu".into(),
            "Cross    Reload guest".into(),
            "Square   Capture GXM frame over USB".into(),
            "Triangle Reset to bundled guest".into(),
            "Circle   Resume".into(),
        ]);
    }

    pub unsafe fn capture(&self, frame: u32) -> Reply {
        let framebuffer = vita2d_sys::vita2d_get_current_fb().cast::<u8>();
        if framebuffer.is_null() {
            return Reply {
                result: Err("GXM framebuffer unavailable".into()),
                pixels: None,
            };
        }
        vita2d_sys::vita2d_wait_rendering_done();
        // Copy GPU memory on its owning thread. The worker never reads a live framebuffer.
        let pixels = std::slice::from_raw_parts(framebuffer, 960 * 544 * 4).to_vec();
        Reply {
            result: Ok(json!({"frame":frame,"width":960,"height":544,"stride":960,
            "format":"RGBA8","source":"GXM","generation":self.generation,"bundle":self.active_hash,
            "nativeBuild":NATIVE_BUILD})),
            pixels: Some(pixels),
        }
    }
}

fn read_bounded(path: &str, cap: usize) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    fs::File::open(path)
        .map_err(|e| e.to_string())?
        .take((cap + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > cap {
        return Err("file exceeds protocol limit".into());
    }
    Ok(bytes)
}

fn atomic_write(path: &str, bytes: &[u8]) -> Result<(), String> {
    let temp = format!("{path}.tmp");
    let mut file = fs::File::create(&temp).map_err(|e| e.to_string())?;
    file.write_all(bytes).map_err(|e| e.to_string())?;
    drop(file);
    match fs::rename(&temp, path) {
        Ok(()) => Ok(()),
        Err(_) if path.starts_with("ux0:/") && fs::metadata(path).is_ok() => {
            // Vita's local rename does not replace an existing destination.
            // These are only our diagnostic files or the INACTIVE native slot;
            // the installed eboot and the running slot never enter this helper.
            fs::remove_file(path).map_err(|e| e.to_string())?;
            fs::rename(temp, path).map_err(|e| e.to_string())
        }
        Err(error) => Err(error.to_string()),
    }
}

#[cfg(feature = "usb-debug")]
unsafe fn start_driver(diagnostic: &str) -> i32 {
    #[repr(C)]
    struct Args {
        size: u32,
        pid: i32,
        args: u32,
        argp: *mut std::ffi::c_void,
        flags: i32,
    }
    extern "C" {
        fn taiLoadStartKernelModuleForUser(path: *const i8, args: *mut Args) -> i32;
        fn _vshKernelSearchModuleByName(name: *const i8, buffer: *mut u32) -> i32;
    }
    // A native replacement retains the kernel driver. Loading a second copy
    // would retake UDCD and install another set of global I/O hooks. Query the
    // kernel module namespace, as VitaShell does for its resident modules.
    let mut search = [0_u32; 2];
    let resident = _vshKernelSearchModuleByName(c"usbhostfs".as_ptr(), search.as_mut_ptr());
    if resident >= 0 {
        return resident;
    }
    let diagnostic = std::ffi::CString::new(diagnostic).unwrap();
    let mut args = Args {
        size: std::mem::size_of::<Args>() as u32,
        pid: 0x10005,
        args: diagnostic.as_bytes_with_nul().len() as u32,
        argp: diagnostic.as_ptr().cast_mut().cast(),
        flags: 0,
    };
    // Kernel module loading uses the physical application path; app0: belongs
    // to the user process's mount namespace.
    let path =
        std::ffi::CString::new(format!("ux0:/app/{TITLE_ID}/pocket-usbhostfs.skprx")).unwrap();
    taiLoadStartKernelModuleForUser(path.as_ptr(), &mut args)
}

fn current_native_path() -> &'static str {
    static PATH: OnceLock<String> = OnceLock::new();
    PATH.get_or_init(|| unsafe {
        // Rust's Vita target has no std::env::args support. Ask the module
        // manager for the loaded image instead of trusting launch arguments.
        let id =
            vitasdk_sys::sceKernelGetModuleIdByAddr(current_native_path as *const () as *mut _);
        let mut info: vitasdk_sys::SceKernelModuleInfo = std::mem::zeroed();
        info.size = std::mem::size_of_val(&info) as u32;
        if id < 0 || vitasdk_sys::sceKernelGetModuleInfo(id, &mut info) < 0 {
            return String::new();
        }
        let bytes: Vec<u8> = info
            .path
            .iter()
            .take_while(|&&b| b != 0)
            .map(|&b| b as u8)
            .collect();
        String::from_utf8(bytes).unwrap_or_default()
    })
}

fn current_native_slot() -> &'static str {
    match current_native_path().rsplit('/').next() {
        Some("pocket-dev-a.self") => "a",
        Some("pocket-dev-b.self") => "b",
        Some("eboot.bin") => "installed",
        _ => "unknown",
    }
}

fn allow_native_slot_write() -> Result<(), String> {
    static UNMOUNTED: AtomicBool = AtomicBool::new(false);
    if !UNMOUNTED.load(Ordering::Relaxed) {
        extern "C" {
            fn sceAppMgrUmount(mount: *const i8) -> i32;
        }
        // The app0: PFS mount makes ux0:/app/TITLE read-only, including for
        // unsafe homebrew. As in VitaShell, release it before self-updating.
        // All guest JS/PAK is embedded or memory-owned. LoadExec resolves
        // app0: through AppMgr's application identity and mounts the new process.
        let code = unsafe { sceAppMgrUmount(c"app0:".as_ptr()) };
        if code < 0 {
            return Err(format!(
                "unmount app0 for native slot: 0x{:08x}",
                code as u32
            ));
        }
        UNMOUNTED.store(true, Ordering::Relaxed);
    }
    Ok(())
}

fn prepare(
    command: &Command,
    root: &str,
    local: &str,
) -> Result<(Option<Bundle>, Option<String>), String> {
    if !matches!(command.op, Op::Push | Op::Native) {
        return Ok((None, None));
    }
    let cap = if command.op == Op::Native {
        wire::MAX_NATIVE
    } else {
        wire::MAX_PACKAGE
    };
    let bytes = read_bounded(&format!("{root}/{}.payload", command.id), cap)?;
    command.check_payload(&bytes)?;
    if command.op == Op::Push {
        let plan: Value = serde_json::from_str(PLAN).map_err(|e| e.to_string())?;
        return Ok((Some(wire::admit(&bytes, &plan)?), None));
    }
    if command.title_id != TITLE_ID || bytes.get(..4) != Some(b"SCE\0") {
        return Err("native update must be a Vita SELF for this title".into());
    }
    let slot = match current_native_slot() {
        "a" => "b",
        "b" | "installed" => "a",
        _ => return Err("cannot identify the running SELF; native slots left untouched".into()),
    };
    let path = format!("ux0:/app/{TITLE_ID}/pocket-dev-{slot}.self");
    allow_native_slot_write()?;
    atomic_write(&path, &bytes).map_err(|e| format!("write native slot {slot}: {e}"))?;
    drop(bytes);
    let installed =
        read_bounded(&path, cap).map_err(|e| format!("read back native slot {slot}: {e}"))?;
    command.check_payload(&installed)?;
    drop(installed);
    // Stock eboot.bin is never replaced. Reopening the LiveArea bubble is recovery.
    atomic_write(
        &format!("{local}/native-pending.json"),
        &serde_json::to_vec(command).unwrap(),
    )?;
    Ok((None, Some(format!("app0:/pocket-dev-{slot}.self"))))
}

#[cfg(feature = "usb-debug")]
fn sample_telemetry() -> Value {
    unsafe {
        let mut memory: vitasdk_sys::SceKernelFreeMemorySizeInfo = std::mem::zeroed();
        memory.size = std::mem::size_of_val(&memory) as i32;
        let memory_result = vitasdk_sys::sceKernelGetFreeMemorySize(&mut memory);
        let percent = vitasdk_sys::scePowerGetBatteryLifePercent();
        json!({
            "sampledAtProcessMs":clock_ms(),
            "batteryPercent":(0..=100).contains(&percent).then_some(percent),
            "charging":vitasdk_sys::scePowerIsBatteryCharging() != 0,
            "externalPower":vitasdk_sys::scePowerIsPowerOnline() != 0,
            "lowBattery":vitasdk_sys::scePowerIsLowBattery() != 0,
            "batteryTempCentiC":vitasdk_sys::scePowerGetBatteryTemp(),
            "freeMemoryResult":memory_result,
            "freeMemoryBytes":if memory_result >= 0 { json!({
                "user":memory.size_user,"cdram":memory.size_cdram,"phycont":memory.size_phycont
            }) } else { Value::Null }
        })
    }
}

#[cfg(feature = "usb-debug")]
fn worker(
    tx: SyncSender<Request>,
    captures: Receiver<Reply>,
    shared: Arc<Mutex<Value>>,
    link: Arc<Link>,
) {
    let local = format!("ux0:/data/pocketjs-dev/{TITLE_ID}");
    let _ = fs::create_dir_all(&local);
    let diagnostic = format!("{local}/driver.json");
    let driver = unsafe { start_driver(&diagnostic) };
    link.driver.store(driver, Ordering::Relaxed);
    let _ = atomic_write(&format!("{local}/startup.json"), &serde_json::to_vec(&json!({
        "titleId":TITLE_ID,"nativeBuild":NATIVE_BUILD,"driverResult":driver,"driverResultHex":format!("{:08x}",driver),
        "transport":"usb-hostfs","usbPid":"054c:0f01"
    })).unwrap());
    let root = format!("host0:/pocket-vita/{TITLE_ID}");
    let plan: Value = serde_json::from_str(PLAN).unwrap_or(Value::Null);
    // A native restart must not execute the same command a second time.
    let mut last = read_bounded(&format!("{local}/native-pending.json"), wire::MAX_CONTROL)
        .ok()
        .and_then(|b| serde_json::from_slice::<Command>(&b).ok())
        .map(|c| (c.session, c.id));
    let mut pending_capture: Option<Reply> = None;
    let mut pending_reply = None;
    let mut last_sample: Option<Instant> = None;
    let mut last_snapshot: Option<Instant> = None;
    loop {
        let started = Instant::now();
        if last_sample.is_none_or(|at| at.elapsed() >= Duration::from_secs(1)) {
            let telemetry = sample_telemetry();
            if let Ok(mut value) = link.telemetry.lock() {
                *value = telemetry.clone();
            }
            last_sample = Some(started);
            if last_snapshot.is_none_or(|at| at.elapsed() >= Duration::from_secs(5)) {
                let mut snapshot = shared
                    .lock()
                    .map(|v| v.clone())
                    .unwrap_or_else(|_| json!({}));
                snapshot["nativeBuild"] = json!(NATIVE_BUILD);
                snapshot["titleId"] = json!(TITLE_ID);
                snapshot["telemetry"] = telemetry;
                let _ = atomic_write(
                    &format!("{local}/health.json"),
                    &serde_json::to_vec(&snapshot).unwrap(),
                );
                last_snapshot = Some(started);
            }
        }
        // A driver loaded by an older runtime wrote to the common path and can
        // survive this process replacement. Keep its startup result visible.
        if let Ok(bytes) = read_bounded(&diagnostic, wire::MAX_CONTROL)
            .or_else(|_| read_bounded("ux0:/data/pocketjs-dev/usb-driver.json", wire::MAX_CONTROL))
        {
            if let Ok(value) = serde_json::from_slice::<Value>(&bytes) {
                let stage = value["stage"].as_str().unwrap_or("unknown");
                let hex = value["hex"].as_str().unwrap_or("unknown");
                if let Ok(mut text) = link.diagnostic.lock() {
                    *text = format!("Driver {stage}: 0x{hex}");
                }
            }
        }
        let _ = exchange(
            &root,
            &local,
            driver,
            &plan,
            &tx,
            &shared,
            &mut last,
            &link,
            &mut pending_reply,
        );
        if pending_capture.is_none() {
            pending_capture = captures.try_recv().ok();
        }
        if let Some(Reply {
            result: Ok(data),
            pixels: Some(pixels),
        }) = pending_capture.as_ref()
        {
            if atomic_write(&format!("{root}/menu-capture.rgba"), pixels).is_ok()
                && atomic_write(
                    &format!("{root}/menu-capture.json"),
                    &serde_json::to_vec(data).unwrap(),
                )
                .is_ok()
            {
                pending_capture = None;
            }
        }
        if let Some(delay) = Duration::from_millis(150).checked_sub(started.elapsed()) {
            std::thread::sleep(delay);
        }
    }
}

#[cfg(feature = "usb-debug")]
fn exchange(
    root: &str,
    local: &str,
    driver: i32,
    plan: &Value,
    tx: &SyncSender<Request>,
    shared: &Mutex<Value>,
    last: &mut Option<(String, String)>,
    link: &Link,
    pending: &mut Option<crate::dev_delivery::PendingReply>,
) -> Result<(), String> {
    let session: Session = serde_json::from_slice(&read_bounded(
        &format!("{root}/session.json"),
        wire::MAX_CONTROL,
    )?)
    .map_err(|e| e.to_string())?;
    if session.version != wire::VERSION || !wire::hex_id(&session.session) {
        return Err("invalid session".into());
    }
    let mut status = shared.lock().map_err(|_| "status lock")?.clone();
    status["session"] = json!(session.session);
    status["driverResult"] = json!(driver);
    status["plan"] = plan.clone();
    atomic_write(
        &format!("{root}/status.json"),
        &serde_json::to_vec(&status).unwrap(),
    )?;
    link.last_ms.store(clock_ms(), Ordering::Relaxed);
    // Keep an active wired debug session awake. Manual suspend is still owned
    // by the user, and disconnected applications retain normal idle behavior.
    unsafe {
        extern "C" {
            fn sceKernelPowerTick(kind: u32) -> i32;
        }
        sceKernelPowerTick(0);
    }
    if let Some(reply) = pending.as_mut() {
        reply.deliver(root, atomic_write)?;
        *pending = None;
    }
    let bytes = read_bounded(&format!("{root}/request.json"), wire::MAX_CONTROL)?;
    let command: Command = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    command.validate(&session)?;
    let key = (command.session.clone(), command.id.clone());
    if last.as_ref() == Some(&key) {
        return Ok(());
    }
    *last = Some(key);
    let path = format!("{root}/{}.json", command.id);
    let result = (|| {
        let (bundle, native_path) = prepare(&command, root, local)?;
        if command.op == Op::Native {
            atomic_write(
                &path,
                &serde_json::to_vec(
                    &json!({"id":command.id,"session":session.session,"phase":"staged"}),
                )
                .unwrap(),
            )?;
        }
        let (reply, rx) = mpsc::sync_channel(1);
        tx.try_send(Request {
            command: command.clone(),
            bundle,
            native_path,
            reply,
            expires: Instant::now() + Duration::from_secs(25),
        })
        .map_err(|_| "runtime busy")?;
        let reply = rx
            .recv_timeout(Duration::from_secs(30))
            .map_err(|_| "runtime did not reach a frame boundary")?;
        Ok::<_, String>((reply.result?, reply.pixels))
    })();
    let (response, pixels) = match result {
        Ok((data, pixels)) => (
            json!({"id":command.id,"session":session.session,"phase":"complete","ok":true,"data":data}),
            pixels,
        ),
        Err(error) => (
            json!({"id":command.id,"session":session.session,"phase":"complete","ok":false,"error":error}),
            None,
        ),
    };
    *pending = Some(crate::dev_delivery::PendingReply {
        id: command.id,
        receipt: serde_json::to_vec(&response).unwrap(),
        pixels,
    });
    pending.as_mut().unwrap().deliver(root, atomic_write)?;
    *pending = None;
    Ok(())
}

pub unsafe fn exec_native(path: &str) -> Result<(), String> {
    extern "C" {
        fn sceAppMgrLoadExec(
            path: *const i8,
            argv: *const *const i8,
            opt: *const std::ffi::c_void,
        ) -> i32;
    }
    let path = std::ffi::CString::new(path).map_err(|_| "bad native path")?;
    let code = sceAppMgrLoadExec(path.as_ptr(), std::ptr::null(), std::ptr::null());
    Err(format!("sceAppMgrLoadExec returned 0x{:08x}", code as u32))
}
