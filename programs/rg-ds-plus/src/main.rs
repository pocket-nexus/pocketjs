//! The Anbernic RG DS Plus program: one package on both 1024x768 DSI panels,
//! rendered by the Mali-G52 (GBM/EGL/GLES on KMS, gpu.rs: DSI-1 is the primary
//! surface on top, DSI-2 the auxiliary surface below), the gamepad and buttons
//! as buttons and the Goodix panel as touch on the lower surface (evdev).
//! Omarchy Pocket's shell runs on it.
//!
//! `--shot DIR --script "…"` runs the package on any system without the panels
//! and inputs, for layout work: scripted buttons and taps, the CPU raster
//! renderer and two in-memory panels written to DIR/<tick>-top.xrgb and
//! DIR/<tick>-bottom.xrgb at each `shot` event (shot.rs). The device itself
//! never renders on the CPU.
use pocket_drivers::{Clock, InputClasses};
use pocket_guest_rquickjs::RquickjsGuest;
use pocket_linux_hooks::{FileSource, MonotonicClock};
use pocket_package::source::LoadedPackage;
use pocket_runtime::{timing::TickSchedule, Profile, Runtime, RuntimeConfig};
use std::{
    error::Error,
    io,
    path::PathBuf,
    sync::atomic::{AtomicBool, Ordering},
};

#[cfg(target_os = "linux")]
mod gpu;
mod shot;

#[allow(dead_code)] // The export defines every fact; the program reads some.
mod profile {
    include!(concat!(env!("OUT_DIR"), "/pocket_profile.rs"));
}

/// The gamepad (`ANBERNIC-rk3568-keys`), measured on the device and matching
/// the stock firmware's SDL mapping: A confirms (CIRCLE, the framework's focus
/// press), B goes back. The D-pad is a hat; the sticks are not mapped yet.
#[cfg(target_os = "linux")]
const GAMEPAD: &[(u16, u32)] = {
    use pocket_spec::btn;
    &[
        (304, btn::CIRCLE),   // A
        (305, btn::CROSS),    // B
        (306, btn::TRIANGLE), // X
        (307, btn::SQUARE),   // Y
        (308, btn::LTRIGGER), // L1
        (309, btn::RTRIGGER), // R1
        (314, btn::ZL),       // L2
        (315, btn::ZR),       // R2
        (310, btn::SELECT),   // Select (SDL's guide)
        (311, btn::START),    // Start
    ]
};
const PACKAGE_LIMIT: usize = 64 * 1024 * 1024;
const DEFAULT_PACKAGE: &str = "/usr/share/pocketjs/omarchy-pocket.pocket";
/// Input classes the evdev drivers deliver here: buttons and touch.
const INPUT_CLASSES: InputClasses =
    InputClasses::from_bits(InputClasses::BUTTONS.bits() | InputClasses::CONTACT.bits());

static STOP: AtomicBool = AtomicBool::new(false);
extern "C" fn stop(_: libc::c_int) {
    STOP.store(true, Ordering::Relaxed);
}
fn error(value: impl std::fmt::Debug) -> io::Error {
    io::Error::other(format!("{value:?}"))
}

struct Options {
    package: Option<PathBuf>,
    card: PathBuf,
    top: String,
    bottom: String,
    inputs: Vec<PathBuf>,
    touch_on_top: bool,
    shot: Option<PathBuf>,
    script: Option<String>,
    check: bool,
}

fn options() -> Result<Option<Options>, Box<dyn Error>> {
    let mut output = Options {
        package: None,
        card: "/dev/dri/card0".into(),
        top: "DSI-1".into(),
        bottom: "DSI-2".into(),
        inputs: Vec::new(),
        touch_on_top: false,
        shot: None,
        script: None,
        check: false,
    };
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--help" => {
                println!("pocket-rg-ds-plus [--package app.pocket] [--card /dev/dri/card0] [--top DSI-1] [--bottom DSI-2]\n                  [--input /dev/input/eventN]... [--touch-on-top] [--check]\n                  [--shot DIR --script \"30:DOWN 45:tap@256,190 90:shot\"]\nProfile {} is compiled in. Default package: {DEFAULT_PACKAGE}. Touch lands on the lower panel unless --touch-on-top. The program exits on SIGINT, SIGTERM, or after the script's last event.", profile::ID);
                return Ok(None);
            }
            "--check" => output.check = true,
            "--touch-on-top" => output.touch_on_top = true,
            "--package" | "--card" | "--top" | "--bottom" | "--input" | "--shot" | "--script" => {
                let value = args.next().ok_or_else(|| error("missing option value"))?;
                match arg.as_str() {
                    "--package" => output.package = Some(value.into()),
                    "--card" => output.card = value.into(),
                    "--top" => output.top = value,
                    "--bottom" => output.bottom = value,
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

/// Reject display and input facts these drivers cannot honor: two fixed
/// panels, buttons and touch.
fn supported(profile: Profile) -> Result<Profile, Box<dyn Error>> {
    if profile.dynamic_viewport.is_some()
        || profile.auxiliary.is_none()
        || !INPUT_CLASSES.contains(profile.required_inputs)
    {
        return Err(error("profile promises facts this program cannot honor").into());
    }
    Ok(profile)
}

fn run(options: Options) -> Result<(), Box<dyn Error>> {
    let profile = supported(profile::profile().ok_or_else(|| error("missing exported profile"))?)?;
    let top = profile.viewport;
    let bottom = profile.auxiliary.unwrap();
    let path = options
        .package
        .clone()
        .unwrap_or_else(|| DEFAULT_PACKAGE.into());
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
        return Err(error("package exceeds 64 MiB").into());
    }
    let pixels = top[0] as usize * top[1] as usize + bottom[0] as usize * bottom[1] as usize;
    let mut runtime = Runtime::new(RuntimeConfig {
        profile_hash: profile::PROFILE_HASH,
        host_abi: profile::HOST_ABI,
        heap_limit: 48 * 1024 * 1024,
        frame_buffer_budget: pixels * 8,
        profile: profile.clone(),
    })
    .map_err(error)?;
    let mut shot = match options.shot.clone() {
        Some(directory) => {
            let renderer = runtime
                .add_renderer(pocket_raster::RasterRenderer::new(profile.density).map_err(error)?)
                .map_err(error)?;
            Some(shot::attach(
                &mut runtime,
                renderer,
                [top, bottom],
                profile.auxiliary_logical[0],
                directory,
                options.script.as_deref().unwrap_or(""),
            )?)
        }
        None => {
            attach_devices(&mut runtime, &profile, &options)?;
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

/// Both panels on the GPU and every evdev device. Linux only: on another
/// system the program builds for --shot and its unit tests.
#[cfg(target_os = "linux")]
fn attach_devices(
    runtime: &mut Runtime,
    profile: &Profile,
    options: &Options,
) -> Result<(), Box<dyn Error>> {
    use gpu::PanelSpec;
    use pocket_drivers::{DisplayRole, InputSource};
    let (renderer, displays) = gpu::open(
        &options.card,
        &[
            PanelSpec {
                connector: &options.top,
                size: profile.viewport,
                role: DisplayRole::Primary,
            },
            PanelSpec {
                connector: &options.bottom,
                size: profile.auxiliary.unwrap(),
                role: DisplayRole::Auxiliary,
            },
        ],
    )?;
    let renderer = runtime.add_renderer(renderer).map_err(error)?;
    for display in displays {
        runtime.add_display(display, renderer).map_err(error)?;
    }
    let mut inputs = options.inputs.clone();
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
    let (touch_surface, touch_extent) = if options.touch_on_top {
        (0, profile.logical_viewports[0])
    } else {
        (1, profile.auxiliary_logical[0])
    };
    for (index, path) in inputs.iter().take(16).enumerate() {
        let mut device = pocket_linux_evdev::Evdev::open(
            path,
            profile.logical_viewports[0],
            index as u32 * 16,
            16,
        )?;
        if device.classes().contains(InputClasses::CONTACT) {
            device.set_surface(touch_surface, touch_extent)?;
        }
        let name = path.file_name().and_then(|event| {
            std::fs::read_to_string(format!(
                "/sys/class/input/{}/device/name",
                event.to_string_lossy()
            ))
            .ok()
        });
        if name.as_deref().map(str::trim) == Some("ANBERNIC-rk3568-keys") {
            device.set_keymap(GAMEPAD);
        }
        runtime.add_input_source(Box::new(device)).map_err(error)?;
    }
    Ok(())
}

#[cfg(not(target_os = "linux"))]
fn attach_devices(_: &mut Runtime, _: &Profile, _: &Options) -> Result<(), Box<dyn Error>> {
    Err(error("the panel and input drivers require Linux; use --shot").into())
}

fn main() {
    match options().and_then(|options| match options {
        Some(options) => run(options),
        None => Ok(()),
    }) {
        Ok(()) => {}
        Err(error) => {
            eprintln!("pocket-rg-ds-plus: {error}");
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn drivers_reject_facts_they_cannot_honor() {
        let exported = profile::profile().unwrap();
        assert!(supported(exported.clone()).is_ok());
        let mut single = exported.clone();
        single.auxiliary = None;
        let mut text = exported;
        text.required_inputs |= InputClasses::TEXT;
        for profile in [single, text] {
            assert!(supported(profile).is_err());
        }
    }
}
