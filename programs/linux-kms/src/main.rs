//! File-package Linux program. Device selection is program composition; the
//! software renderer and runtime contain no DRM/fbdev/evdev choices.
use pocket_drivers::{Clock, DisplayOutput, InputClasses, InputFrameBuilder, InputSource};
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
#[allow(dead_code)] // The export defines every fact; the program reads some.
mod profile {
    include!(concat!(env!("OUT_DIR"), "/pocket_profile.rs"));
}
const PACKAGE_LIMIT: usize = 64 * 1024 * 1024;
/// Input classes the evdev drivers deliver: buttons, pointer and touch.
const INPUT_CLASSES: InputClasses = InputClasses::from_bits(
    InputClasses::BUTTONS.bits() | InputClasses::POINTER.bits() | InputClasses::CONTACT.bits(),
);
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
    card: Option<PathBuf>,
    fb: Option<PathBuf>,
    inputs: Vec<PathBuf>,
    frames: Option<u64>,
    headless: bool,
    check: bool,
    pcm_test: Option<String>,
}
fn options() -> Result<Option<Options>, Box<dyn Error>> {
    let mut output = Options::default();
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--help" => {
                println!("pocket-linux-kms [--package app.pocket] [--card /dev/dri/card0] [--fb /dev/fb0] [--input /dev/input/eventN] [--frames N] [--check | --headless]\nHost contract {} is compiled in from the build's host export. Default package: /usr/share/pocketjs/app.pocket. DRM falls back to fbdev; --headless is an explicit diagnostic output. With --features alsa, --pcm-test DEVICE writes a silent PCM diagnostic.", profile::ID);
                return Ok(None);
            }
            "--headless" => output.headless = true,
            "--check" => output.check = true,
            "--package" | "--card" | "--fb" | "--input" | "--frames" | "--pcm-test" => {
                let value = args.next().ok_or_else(|| error("missing option value"))?;
                match arg.as_str() {
                    "--package" => output.package = Some(value.into()),
                    "--card" => output.card = Some(value.into()),
                    "--fb" => output.fb = Some(value.into()),
                    "--input" => output.inputs.push(value.into()),
                    "--pcm-test" => output.pcm_test = Some(value),
                    _ => output.frames = Some(value.parse()?),
                }
            }
            _ => return Err(error(format!("unknown option {arg}")).into()),
        }
    }
    Ok(Some(output))
}
/// Reject display and input facts these drivers cannot honor: one fixed
/// display and the evdev input classes. The host config rejects promised
/// services this program does not compose before the build.
fn supported(profile: Profile) -> Result<Profile, Box<dyn Error>> {
    if profile.dynamic_viewport.is_some()
        || profile.auxiliary.is_some()
        || !INPUT_CLASSES.contains(profile.required_inputs)
    {
        return Err(error("profile promises capabilities absent from this Linux program").into());
    }
    Ok(profile)
}
struct DiagnosticInput;
impl InputSource for DiagnosticInput {
    fn classes(&self) -> InputClasses {
        INPUT_CLASSES
    }
    fn poll(&mut self, _: &mut InputFrameBuilder) {}
}
fn register<D: DisplayOutput + 'static>(
    runtime: &mut Runtime,
    display: D,
    size: [u32; 2],
    renderer: pocket_runtime::RendererId,
) -> Result<(), Box<dyn Error>> {
    let descriptor = display.descriptor();
    if [descriptor.width, descriptor.height] != size {
        return Err(error("display geometry does not match profile").into());
    }
    runtime.add_display(display, renderer).map_err(error)?;
    Ok(())
}
fn run(options: Options) -> Result<(), Box<dyn Error>> {
    if let Some(device) = &options.pcm_test {
        #[cfg(all(feature = "alsa", target_os = "linux"))]
        {
            let mut pcm = pocket_linux_alsa::Pcm::open(
                device,
                pocket_linux_alsa::Format {
                    sample_rate: 44100,
                    channels: 2,
                },
            )?;
            pcm.write(&[0; 1024])?;
            pcm.drain()?;
            println!("PCM diagnostic: 512 stereo frames accepted by {device}");
            return Ok(());
        }
        #[cfg(not(all(feature = "alsa", target_os = "linux")))]
        return Err(error(format!(
            "PCM diagnostic for {device} requires Linux and the alsa feature"
        ))
        .into());
    }

    let profile = supported(profile::profile().ok_or_else(|| error("missing exported profile"))?)?;
    let size = profile.viewport;
    let budget = (size[0] as usize)
        .checked_mul(size[1] as usize)
        .and_then(|n| n.checked_mul(8))
        .filter(|n| *n <= 256 * 1024 * 1024)
        .ok_or_else(|| error("framebuffer budget exceeds 256 MiB"))?;
    let mut runtime = Runtime::new(RuntimeConfig {
        profile_hash: profile::PROFILE_HASH,
        host_abi: profile::HOST_ABI,
        heap_limit: 32 * 1024 * 1024,
        frame_buffer_budget: budget,
        profile: profile.clone(),
    })
    .map_err(error)?;
    let path = options
        .package
        .unwrap_or_else(|| "/usr/share/pocketjs/app.pocket".into());
    let mut source = FileSource::open(&path)?;
    if options.check {
        let package = LoadedPackage::load(
            &mut source,
            &profile.host_facts(profile::HOST_ABI, profile::PROFILE_HASH),
            PACKAGE_LIMIT,
        )
        .map_err(error)?;
        println!(
            "package admitted: {} ({}, {} Hz at {} Hz)",
            path.display(),
            profile.id,
            package.timing.tick_hz,
            package.timing.cadence_hz
        );
        return Ok(());
    }
    // Guard resource allocation before the runtime copies the file.
    if pocket_drivers::PackageSource::length(&source).map_err(error)? > PACKAGE_LIMIT {
        return Err(error("package exceeds 64 MiB").into());
    }
    let renderer = runtime
        .add_renderer(pocket_raster::RasterRenderer::new(profile.density).map_err(error)?)
        .map_err(error)?;
    if options.headless {
        let geometry = pocket_linux_fbdev::Geometry {
            width: size[0],
            height: size[1],
            x_offset: 0,
            y_offset: 0,
            stride: size[0] as usize * 4,
            mapping_bytes: budget / 2,
            bits_per_pixel: 32,
            red: pocket_linux_fbdev::Channel {
                offset: 16,
                bits: 8,
            },
            green: pocket_linux_fbdev::Channel { offset: 8, bits: 8 },
            blue: pocket_linux_fbdev::Channel { offset: 0, bits: 8 },
            alpha: pocket_linux_fbdev::Channel {
                offset: 24,
                bits: 8,
            },
        };
        register(
            &mut runtime,
            pocket_linux_fbdev::Framebuffer::new(vec![0; budget / 2], geometry)?,
            size,
            renderer,
        )?;
        runtime
            .add_input_source(Box::new(DiagnosticInput))
            .map_err(error)?;
    } else {
        #[cfg(target_os = "linux")]
        {
            match pocket_linux_drm::open(
                options.card.unwrap_or_else(|| "/dev/dri/card0".into()),
                size,
            ) {
                Ok(display) => {
                    register(&mut runtime, display, size, renderer)?;
                    eprintln!("display: DRM/KMS");
                }
                Err(drm) => {
                    eprintln!("DRM unavailable ({drm}); trying framebuffer");
                    let display =
                        pocket_linux_fbdev::open(options.fb.unwrap_or_else(|| "/dev/fb0".into()))?;
                    register(&mut runtime, display, size, renderer)?;
                    eprintln!("display: fbdev (timer pacing)");
                }
            }
            let mut inputs = options.inputs;
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
            if inputs.len() > 16 {
                return Err(error("at most 16 evdev sources are supported").into());
            }
            for (index, path) in inputs.iter().enumerate() {
                let device = pocket_linux_evdev::Evdev::open(
                    path,
                    profile.logical_viewports[0],
                    index as u32 * 16,
                    16,
                )?;
                runtime.add_input_source(Box::new(device)).map_err(error)?;
            }
        }
        #[cfg(not(target_os = "linux"))]
        return Err(error("DRM/fbdev require Linux; use --headless for diagnostics").into());
    }
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
    // One frame per cadence period; each advances the package rate divided by
    // the cadence in core ticks.
    let cadence_hz = runtime
        .timing()
        .ok_or_else(|| error("the package did not boot"))?
        .cadence_hz;
    let mut schedule = TickSchedule::new(cadence_hz, clock.now(), 1).map_err(error)?;
    let mut frames = 0u64;
    while !STOP.load(Ordering::Relaxed) && options.frames.is_none_or(|limit| frames < limit) {
        schedule.wait_next(&mut clock).map_err(error)?;
        runtime.tick().map_err(error)?;
        frames += 1;
    }
    runtime.shutdown().map_err(error)?;
    println!(
        "completed {frames} logical ticks; {}x{}; {}",
        size[0], size[1], profile.id
    );
    Ok(())
}
fn main() {
    match options().and_then(|options| match options {
        Some(options) => run(options),
        None => Ok(()),
    }) {
        Ok(()) => {}
        Err(error) => {
            eprintln!("pocket-linux-kms: {error}");
            std::process::exit(1);
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn drivers_reject_display_and_input_facts_they_cannot_honor() {
        let exported = profile::profile().unwrap();
        assert!(supported(exported.clone()).is_ok());
        let mut dynamic = exported.clone();
        dynamic.dynamic_viewport = Some([[240, 180], [1920, 1080]]);
        let mut auxiliary = exported.clone();
        auxiliary.auxiliary = Some([320, 240]);
        auxiliary.auxiliary_logical = std::borrow::Cow::Borrowed(&[[320, 240]]);
        let mut text = exported;
        text.required_inputs |= InputClasses::TEXT;
        for profile in [dynamic, auxiliary, text] {
            assert!(supported(profile).is_err());
        }
    }
}
