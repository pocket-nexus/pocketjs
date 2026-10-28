//! The M5Stack CardputerZero program: one package on the 320x170 panel
//! (fbdev, RGB565) and the keyboard as buttons (evdev). Pocket Companion's
//! own screen (apps/companion-zero) runs on it. The program offers no
//! network: a UI realm has no network namespace, and the worker domain that
//! would carry the screen's control API calls is not on this program yet.
//!
//! `--shot DIR --script "…"` runs the same program on any system without the
//! panel and keyboard: a scripted button source and an in-memory RGB565
//! framebuffer of the panel's geometry, written to DIR/<tick>.rgb565 at each
//! `shot` event (shot.rs).
use pocket_drivers::{Clock, InputClasses};
use pocket_guest_rquickjs::RquickjsGuest;
use pocket_linux_hooks::{FileSource, MonotonicClock};
use pocket_package::source::LoadedPackage;
use pocket_runtime::{timing::TickSchedule, Runtime, RuntimeConfig};
use std::{
    error::Error,
    io,
    path::PathBuf,
    sync::atomic::{AtomicBool, Ordering},
};

mod shot;

#[allow(dead_code)] // The export defines every fact; the program reads some.
mod profile {
    include!(concat!(env!("OUT_DIR"), "/pocket_profile.rs"));
}

const PACKAGE_LIMIT: usize = 16 * 1024 * 1024;
const DEFAULT_PACKAGE: &str = "/usr/share/pocketjs/companion.pocket";

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
    shot: Option<PathBuf>,
    script: Option<String>,
    check: bool,
}

fn options() -> Result<Option<Options>, Box<dyn Error>> {
    let mut output = Options::default();
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--help" => {
                println!("pocket-cardputer-zero [--package app.pocket] [--fb /dev/fb0] [--input /dev/input/eventN] [--check]\n                     [--shot DIR --script \"30:DOWN 45:START 90:shot\"]\nProfile {} is compiled in. Default package: {DEFAULT_PACKAGE}. The program exits on SIGINT, SIGTERM, or after the script's last event.", profile::ID);
                return Ok(None);
            }
            "--check" => output.check = true,
            "--package" | "--fb" | "--input" | "--shot" | "--script" => {
                let value = args.next().ok_or_else(|| error("missing option value"))?;
                match arg.as_str() {
                    "--package" => output.package = Some(value.into()),
                    "--fb" => output.fb = Some(value.into()),
                    "--input" => output.inputs.push(value.into()),
                    "--shot" => output.shot = Some(value.into()),
                    _ => output.script = Some(value),
                }
            }
            _ => return Err(error(format!("unknown option {arg}")).into()),
        }
    }
    Ok(Some(output))
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
    runtime
        .set_guest(Box::new(RquickjsGuest::default()))
        .map_err(error)?;
    runtime.boot().map_err(error)?;
    unsafe {
        libc::signal(libc::SIGINT, stop as *const () as libc::sighandler_t);
        libc::signal(libc::SIGTERM, stop as *const () as libc::sighandler_t);
    }
    let mut clock = MonotonicClock::default();
    let mut schedule = TickSchedule::new(profile.tick_hz, clock.now(), 1).map_err(error)?;
    while !STOP.load(Ordering::Relaxed) {
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
    // (the HDMI CEC keys, the IR receiver) join it.
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
        let device = pocket_linux_evdev::Evdev::open(
            path,
            profile.logical_viewports[0],
            index as u32 * 16,
            16,
        )?;
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
