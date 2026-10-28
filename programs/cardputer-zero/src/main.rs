//! The M5Stack CardputerZero program: one package on the 320x170 panel
//! (fbdev, RGB565), the keyboard as buttons and as text keys (evdev, with the
//! Zero's symbol layer from keymap.rs), and the package's worker domain
//! (worker.rs), whose `http` node reaches this machine (http.rs): Pocket
//! Companion's control API, and the device API (device/) under
//! `http://zero/dev/`: sensors, radios, microphone, camera and infrared as
//! JSON. The camera's live picture is the runtime's video plane (video.rs),
//! so its frames never cross JavaScript. Pocket Companion's own screen
//! (apps/companion-zero) and Pocket Tools (pocket-nexus/pocket-zero-tools)
//! run on it.
//!
//! `--shot DIR --script "…"` runs the same program on any system without the
//! panel and keyboard: a scripted button and key source and an in-memory
//! RGB565 framebuffer of the panel's geometry, written to DIR/<tick>.rgb565
//! at each `shot` event (shot.rs). `--mock` answers the device API from
//! synthesized readings (device/mock.rs).
use pocket_drivers::{Clock, InputClasses};
use pocket_guest_rquickjs::RquickjsGuest;
use pocket_linux_hooks::{FileSource, MonotonicClock};
use pocket_package::source::LoadedPackage;
use pocket_runtime::{
    timing::TickSchedule, Guest, GuestEnvironment, GuestFrame, OpContext, Runtime, RuntimeConfig,
    RuntimeError,
};
use std::{
    error::Error,
    io,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

mod device;
mod http;
mod keymap;
mod shot;
mod video;
mod worker;

#[allow(dead_code)] // The export defines every fact; the program reads some.
mod profile {
    include!(concat!(env!("OUT_DIR"), "/pocket_profile.rs"));
}

const PACKAGE_LIMIT: usize = 16 * 1024 * 1024;
const DEFAULT_PACKAGE: &str = "/usr/share/pocketjs/companion.pocket";
const DEFAULT_CONTROL: &str = "/opt/pocket/store/control.json";
/// `auto` picks the codec card by name (device/linux.rs `pcm_device`).
const DEFAULT_AUDIO_DEVICE: &str = "auto";

static STOP: AtomicBool = AtomicBool::new(false);
extern "C" fn stop(_: libc::c_int) {
    STOP.store(true, Ordering::Relaxed);
}
fn error(value: impl std::fmt::Debug) -> io::Error {
    io::Error::other(format!("{value:?}"))
}

#[derive(Default)]
struct Options {
    package: Option<PathBuf>,
    fb: Option<PathBuf>,
    inputs: Vec<PathBuf>,
    control: Option<PathBuf>,
    unit: Option<String>,
    shot: Option<PathBuf>,
    script: Option<String>,
    store: Option<PathBuf>,
    audio_device: Option<String>,
    mock: bool,
    check: bool,
}

/// Where the device layer keeps an application's files (calibration, saved
/// signals, recordings, photos, the guest's store) when `--store` names no
/// directory: `$XDG_CONFIG_HOME` or `~/.config`, then the package file's
/// name without its extension, as the CardputerZero's application guidelines
/// ask (`$HOME/.config/<app>/`).
fn default_store(package: &std::path::Path) -> PathBuf {
    let name = package.file_stem().map(|stem| stem.to_string_lossy().into_owned()).unwrap_or_else(|| "pocket".into());
    let config = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config")));
    match config {
        Some(config) => config.join(name),
        None => PathBuf::from("/tmp").join(name),
    }
}

fn options() -> Result<Option<Options>, Box<dyn Error>> {
    let mut output = Options::default();
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--help" => {
                println!("pocket-cardputer-zero [--package app.pocket] [--fb /dev/fb0] [--input /dev/input/eventN] [--control control.json] [--unit pocket-companion.service]\n                     [--store DIR] [--audio-device NAME] [--mock] [--check]\n                     [--shot DIR --script \"30:DOWN 45:key:Enter 60:type:hello 90:shot\"]\nProfile {} is compiled in. Default package: {DEFAULT_PACKAGE}; default control file: {DEFAULT_CONTROL}; default store: ~/.config/<package name>. The program exits on SIGINT, SIGTERM, when the worker requests http://zero/quit, or after the script's last event.", profile::ID);
                return Ok(None);
            }
            "--check" => output.check = true,
            "--mock" => output.mock = true,
            "--package" | "--fb" | "--input" | "--control" | "--unit" | "--shot" | "--script" | "--store" | "--audio-device" => {
                let value = args.next().ok_or_else(|| error("missing option value"))?;
                match arg.as_str() {
                    "--package" => output.package = Some(value.into()),
                    "--fb" => output.fb = Some(value.into()),
                    "--input" => output.inputs.push(value.into()),
                    "--control" => output.control = Some(value.into()),
                    "--unit" => output.unit = Some(value),
                    "--shot" => output.shot = Some(value.into()),
                    "--store" => output.store = Some(value.into()),
                    "--audio-device" => output.audio_device = Some(value),
                    _ => output.script = Some(value),
                }
            }
            _ => return Err(error(format!("unknown option {arg}")).into()),
        }
    }
    Ok(Some(output))
}

/// The rquickjs guest with the package's worker domain: the worker boots
/// after the UI realm and before the UI bundle evaluates, so its channels
/// exist when the bridge attaches; the bridge latches the worker's records
/// before every frame and detaches before the worker stops.
struct ZeroGuest {
    inner: RquickjsGuest,
    http: Arc<http::Http>,
    notify: Arc<worker::Notify>,
    bridge: *mut worker::Bridge,
    worker: Option<worker::Worker>,
}

impl ZeroGuest {
    fn fail(message: impl std::fmt::Display) -> RuntimeError {
        eprintln!("pocket-cardputer-zero: worker: {message}");
        RuntimeError::Guest
    }
    fn detach(&mut self) {
        if !self.bridge.is_null() {
            let bridge = std::mem::replace(&mut self.bridge, std::ptr::null_mut());
            self.inner
                .with(|_| unsafe { worker::pocket_worker_ui_detach(bridge) });
        }
    }
}

impl Guest for ZeroGuest {
    fn initialize(
        &mut self,
        ops: OpContext,
        environment: &GuestEnvironment<'_>,
    ) -> Result<(), RuntimeError> {
        self.shutdown();
        self.inner.initialize(ops, environment)?;
        if environment.worker_javascript.is_empty() {
            return Ok(());
        }
        let worker = worker::Worker::start(
            environment.worker_javascript,
            self.http.clone(),
            self.notify.clone(),
        )
        .map_err(Self::fail)?;
        let core = worker.core();
        self.worker = Some(worker);
        self.bridge = self
            .inner
            .with(|ctx| unsafe { worker::pocket_worker_ui_attach(ctx.as_raw().as_ptr(), core) })
            .unwrap_or(std::ptr::null_mut());
        if self.bridge.is_null() {
            return Err(Self::fail("channel bridge attachment failed"));
        }
        Ok(())
    }
    fn evaluate(&mut self, code: &[u8]) -> Result<(), RuntimeError> {
        self.inner.evaluate(code)
    }
    fn frame(&mut self, frame: &GuestFrame<'_>) -> Result<(), RuntimeError> {
        if let Some(fault) = self.worker.as_ref().and_then(worker::Worker::fault) {
            return Err(Self::fail(fault));
        }
        if !self.bridge.is_null() {
            let bridge = self.bridge;
            let latched = self.inner.with(|ctx| {
                if unsafe { worker::pocket_worker_ui_latch(bridge) } >= 0 {
                    return Ok(());
                }
                let thrown = ctx.catch();
                Err(thrown
                    .as_exception()
                    .and_then(|exception| exception.message())
                    .unwrap_or_else(|| "channel latch failed".into()))
            });
            if let Some(Err(message)) = latched {
                return Err(Self::fail(message));
            }
        }
        self.inner.frame(frame)
    }
    fn collect(&mut self) -> Result<(), RuntimeError> {
        self.inner.collect()
    }
    fn shutdown(&mut self) {
        self.detach();
        self.worker = None;
        self.inner.shutdown()
    }
}

fn run(options: Options) -> Result<(), Box<dyn Error>> {
    let profile = profile::profile().ok_or_else(|| error("missing exported profile"))?;
    if profile.dynamic_viewport.is_some()
        || profile.auxiliary.is_some()
        || !InputClasses::BUTTONS.contains(profile.required_inputs)
    {
        return Err(error("profile promises facts this program cannot honor").into());
    }
    let size = profile.viewport;
    let path = options.package.unwrap_or_else(|| DEFAULT_PACKAGE.into());
    let mut source = FileSource::open(&path)?;
    if options.check {
        LoadedPackage::load(
            &mut source,
            profile::ID,
            profile::HOST_ABI,
            &profile::PROFILE_HASH,
            PACKAGE_LIMIT,
        )
        .map_err(error)?;
        println!("package admitted: {} ({})", path.display(), profile.id);
        return Ok(());
    }
    if pocket_drivers::PackageSource::length(&source).map_err(error)? > PACKAGE_LIMIT {
        return Err(error("package exceeds 16 MiB").into());
    }
    let mut runtime = Runtime::new(RuntimeConfig {
        profile_hash: profile::PROFILE_HASH,
        host_abi: profile::HOST_ABI,
        heap_limit: 24 * 1024 * 1024,
        frame_buffer_budget: size[0] as usize * size[1] as usize * 8,
        profile: profile.clone(),
    })
    .map_err(error)?;
    let renderer = runtime
        .add_renderer(pocket_raster::RasterRenderer::new(profile.density).map_err(error)?)
        .map_err(error)?;
    let headless = options.shot.is_some();
    let mut shot = match options.shot {
        Some(directory) => Some(shot::attach(
            &mut runtime,
            renderer,
            size,
            directory,
            options.script.as_deref().unwrap_or(""),
        )?),
        None => {
            attach_devices(&mut runtime, renderer, &profile, options.fb, options.inputs)?;
            None
        }
    };
    runtime
        .set_package_source(Box::new(source))
        .map_err(error)?;
    // The device layer runs when the program has the hardware (a Linux
    // machine, with or without the panel) or stands in for it with --mock;
    // a shot elsewhere keeps the API absent.
    let device = if options.mock || !headless || cfg!(target_os = "linux") {
        Some(device::Device::new(
            options.store.unwrap_or_else(|| default_store(&path)),
            options.mock,
            options.audio_device.unwrap_or_else(|| DEFAULT_AUDIO_DEVICE.into()),
        ))
    } else {
        None
    };
    if let Some(device) = &device {
        runtime.add_provider(Box::new(video::CameraPlane::new(device.clone()))).map_err(error)?;
    }
    let notify = Arc::new(worker::Notify::default());
    let http = Arc::new(http::Http::new(
        options.control.unwrap_or_else(|| DEFAULT_CONTROL.into()),
        options.unit.unwrap_or_else(|| http::COMPANION_UNIT.into()),
        notify.clone(),
        device.clone(),
    ));
    runtime
        .set_guest(Box::new(ZeroGuest {
            inner: RquickjsGuest::default(),
            http,
            notify,
            bridge: std::ptr::null_mut(),
            worker: None,
        }))
        .map_err(error)?;
    runtime.boot().map_err(error)?;
    unsafe {
        libc::signal(libc::SIGINT, stop as *const () as libc::sighandler_t);
        libc::signal(libc::SIGTERM, stop as *const () as libc::sighandler_t);
    }
    let mut clock = MonotonicClock::default();
    let mut schedule = TickSchedule::new(profile.tick_hz, clock.now(), 1).map_err(error)?;
    while !STOP.load(Ordering::Relaxed) && !http::QUIT.load(Ordering::Relaxed) {
        schedule.wait_next(&mut clock).map_err(error)?;
        if let Some(shot) = shot.as_mut() {
            if !shot.before_tick() {
                break;
            }
        }
        runtime.tick().map_err(error)?;
        if let Some(shot) = shot.as_mut() {
            shot.after_tick()?;
        }
    }
    runtime.shutdown().map_err(error)?;
    // A microphone capture, a camera stream and a raised preamplifier must
    // not outlive the program.
    if let Some(device) = device {
        device.stop();
    }
    Ok(())
}

/// The panel and the keyboard. Linux only: on another system the program
/// builds for its unit tests and refuses to run.
#[cfg(target_os = "linux")]
fn attach_devices(
    runtime: &mut Runtime,
    renderer: pocket_runtime::RendererId,
    profile: &pocket_runtime::Profile,
    fb: Option<PathBuf>,
    inputs: Vec<PathBuf>,
) -> Result<(), Box<dyn Error>> {
    let size = profile.viewport;
    let mut display = pocket_linux_fbdev::open(fb.unwrap_or_else(|| "/dev/fb0".into()))?;
    // The panel is this program's while it runs: frames redraw what changed.
    display.set_partial_refresh(true);
    let descriptor = pocket_drivers::DisplayOutput::descriptor(&display);
    if [descriptor.width, descriptor.height] != size {
        return Err(error(format!(
            "the framebuffer is {}x{}, the profile {}x{}",
            descriptor.width, descriptor.height, size[0], size[1]
        ))
        .into());
    }
    runtime.add_display(display, renderer).map_err(error)?;
    // The keyboard is the tca8418 matrix; other devices that report buttons
    // (the HDMI CEC keys, the IR receiver) join it. Text keys name the symbol
    // layer from the vendor's key codes (keymap.rs).
    let symbols = keymap::load();
    let mut inputs = inputs;
    if inputs.is_empty() {
        if let Ok(entries) = std::fs::read_dir("/dev/input") {
            inputs = entries
                .filter_map(Result::ok)
                .map(|entry| entry.path())
                .filter(|path| {
                    path.file_name()
                        .is_some_and(|name| name.to_string_lossy().starts_with("event"))
                })
                .collect();
            inputs.sort();
        }
    }
    for (index, path) in inputs.iter().take(16).enumerate() {
        let mut device = pocket_linux_evdev::Evdev::open(
            path,
            profile.logical_viewports[0],
            index as u32 * 16,
            16,
        )?;
        device.set_symbols(symbols.clone());
        runtime.add_input_source(Box::new(device)).map_err(error)?;
    }
    Ok(())
}

#[cfg(not(target_os = "linux"))]
fn attach_devices(
    _: &mut Runtime,
    _: pocket_runtime::RendererId,
    _: &pocket_runtime::Profile,
    _: Option<PathBuf>,
    _: Vec<PathBuf>,
) -> Result<(), Box<dyn Error>> {
    Err(error("the panel and keyboard drivers require Linux").into())
}

fn main() {
    match options().and_then(|options| match options {
        Some(options) => run(options),
        None => Ok(()),
    }) {
        Ok(()) => {}
        Err(error) => {
            eprintln!("pocket-cardputer-zero: {error}");
            std::process::exit(1);
        }
    }
}
