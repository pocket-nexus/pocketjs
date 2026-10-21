//! File-package Linux program. Device selection is program composition; the
//! software renderer and runtime contain no DRM/fbdev/evdev choices.
use pocket_drivers::{Clock, DisplayOutput, InputClasses, InputFrameBuilder, InputSource};
use pocket_guest_rquickjs::RquickjsGuest;
use pocket_linux_hooks::{FileSource, MonotonicClock};
use pocket_package::{profile::from_build_inputs, source::LoadedPackage};
use pocket_runtime::{timing::TickSchedule, Runtime, RuntimeConfig};
use std::{
    error::Error,
    io,
    path::PathBuf,
    sync::atomic::{AtomicBool, Ordering},
};
const PACKAGE_LIMIT: usize = 64 * 1024 * 1024;
static STOP: AtomicBool = AtomicBool::new(false);
extern "C" fn stop(_: libc::c_int) {
    STOP.store(true, Ordering::Relaxed);
}
fn error(value: impl std::fmt::Debug) -> io::Error {
    io::Error::other(format!("{value:?}"))
}
#[derive(Default)]
struct Options {
    profile: Option<PathBuf>,
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
                println!("pocket-linux-kms [--package app.pocket] [--profile pocket-profile.json] [--card /dev/dri/card0] [--fb /dev/fb0] [--input /dev/input/eventN] [--frames N] [--check | --headless]\nProfile export is an independent trusted deployment input. Default package: /usr/share/pocketjs/app.pocket. DRM falls back to fbdev; --headless is an explicit diagnostic output. With --features alsa, --pcm-test DEVICE writes a silent PCM diagnostic.");
                return Ok(None);
            }
            "--headless" => output.headless = true,
            "--check" => output.check = true,
            "--profile" | "--package" | "--card" | "--fb" | "--input" | "--frames"
            | "--pcm-test" => {
                let value = args.next().ok_or_else(|| error("missing option value"))?;
                match arg.as_str() {
                    "--profile" => output.profile = Some(value.into()),
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
struct Identity {
    json: String,
    hash: [u8; 32],
    id: String,
    size: [u32; 2],
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    logical: [u32; 2],
    density: u32,
    tick_hz: u32,
}
fn identity(path: Option<&std::path::Path>) -> Result<Identity, Box<dyn Error>> {
    let (json, hash) = if let Some(path) = path {
        use std::io::Read;
        let mut bytes = Vec::new();
        std::fs::File::open(path)?
            .take(1024 * 1024 + 1)
            .read_to_end(&mut bytes)?;
        if bytes.len() > 1024 * 1024 {
            return Err(error("profile export too large").into());
        }
        let sidecar: serde_json::Value = serde_json::from_slice(&bytes)?;
        if sidecar["format"] != "pocket-profile/1"
            || sidecar["hostAbi"] != pocket_spec::BINDING_GENERATION
        {
            return Err(error("unsupported profile export").into());
        }
        let json = sidecar["canonicalProfileJson"]
            .as_str()
            .ok_or_else(|| error("missing canonical profile"))?
            .to_owned();
        let hash = sidecar["profileHash"]
            .as_str()
            .ok_or_else(|| error("missing profile hash"))?
            .to_owned();
        (json, hash)
    } else {
        (
            option_env!("POCKETJS_PROFILE_JSON")
                .ok_or_else(|| error("supply --profile or build with exported profile inputs"))?
                .to_owned(),
            option_env!("POCKETJS_PROFILE_HASH")
                .ok_or_else(|| error("missing build profile hash"))?
                .to_owned(),
        )
    };
    let hash = from_build_inputs(Some(&json), Some(&hash))
        .map_err(error)?
        .ok_or_else(|| error("missing profile"))?
        .hash;
    let value: serde_json::Value = serde_json::from_str(&json)?;
    let dimension = |value: &serde_json::Value| -> Result<u32, io::Error> {
        value
            .as_u64()
            .filter(|n| *n > 0 && *n <= 65535)
            .map(|n| n as u32)
            .ok_or_else(|| error("invalid profile dimension"))
    };
    let supported = [
        "input.buttons",
        "input.pointer",
        "input.touch",
        "text.glyphs.baked",
    ];
    let capabilities = value["capabilities"]
        .as_array()
        .ok_or_else(|| error("invalid capabilities"))?;
    if capabilities
        .iter()
        .any(|cap| cap.as_str().is_none_or(|cap| !supported.contains(&cap)))
        || value["roleCapabilities"].as_object().is_none_or(|roles| {
            roles
                .values()
                .any(|caps| caps.as_array().is_none_or(|caps| !caps.is_empty()))
        })
        || value["display"].get("dynamicViewport").is_some()
        || value["display"].get("auxiliary").is_some()
    {
        return Err(error("profile promises capabilities absent from this Linux program").into());
    }
    let size = [
        dimension(&value["display"]["physicalViewport"][0])?,
        dimension(&value["display"]["physicalViewport"][1])?,
    ];
    let logical = [
        dimension(&value["display"]["logicalViewports"][0][0])?,
        dimension(&value["display"]["logicalViewports"][0][1])?,
    ];
    let density = dimension(&value["display"]["rasterDensity"])?;
    let tick_hz = dimension(&value["tickHz"])?;
    let id = value["id"]
        .as_str()
        .ok_or_else(|| error("missing profile id"))?
        .to_owned();
    Ok(Identity {
        json,
        hash,
        id,
        size,
        logical,
        density,
        tick_hz,
    })
}
struct DiagnosticInput;
impl InputSource for DiagnosticInput {
    fn classes(&self) -> InputClasses {
        InputClasses::BUTTONS | InputClasses::POINTER | InputClasses::CONTACT
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

    let profile = identity(options.profile.as_deref())?;
    let budget = (profile.size[0] as usize)
        .checked_mul(profile.size[1] as usize)
        .and_then(|n| n.checked_mul(8))
        .filter(|n| *n <= 256 * 1024 * 1024)
        .ok_or_else(|| error("framebuffer budget exceeds 256 MiB"))?;
    let mut runtime = Runtime::new(RuntimeConfig {
        profile_hash: profile.hash,
        host_abi: pocket_spec::BINDING_GENERATION,
        tick_hz: profile.tick_hz,
        heap_limit: 32 * 1024 * 1024,
        frame_buffer_budget: budget,
        profile_json: profile.json.as_bytes().to_vec(),
    })
    .map_err(error)?;
    let path = options
        .package
        .unwrap_or_else(|| "/usr/share/pocketjs/app.pocket".into());
    let mut source = FileSource::open(&path)?;
    if options.check {
        let _package = LoadedPackage::load(
            &mut source,
            &profile.id,
            pocket_spec::BINDING_GENERATION,
            &profile.hash,
            PACKAGE_LIMIT,
        )
        .map_err(error)?;
        println!("package admitted: {} ({})", path.display(), profile.id);
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
            width: profile.size[0],
            height: profile.size[1],
            x_offset: 0,
            y_offset: 0,
            stride: profile.size[0] as usize * 4,
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
            profile.size,
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
                profile.size,
            ) {
                Ok(display) => {
                    register(&mut runtime, display, profile.size, renderer)?;
                    eprintln!("display: DRM/KMS");
                }
                Err(drm) => {
                    eprintln!("DRM unavailable ({drm}); trying framebuffer");
                    let display =
                        pocket_linux_fbdev::open(options.fb.unwrap_or_else(|| "/dev/fb0".into()))?;
                    register(&mut runtime, display, profile.size, renderer)?;
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
                let device =
                    pocket_linux_evdev::Evdev::open(path, profile.logical, index as u32 * 16, 16)?;
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
    let mut schedule = TickSchedule::new(profile.tick_hz, clock.now(), 1).map_err(error)?;
    let mut frames = 0u64;
    while !STOP.load(Ordering::Relaxed) && options.frames.is_none_or(|limit| frames < limit) {
        schedule.wait_next(&mut clock).map_err(error)?;
        runtime.tick().map_err(error)?;
        frames += 1;
    }
    runtime.shutdown().map_err(error)?;
    println!(
        "completed {frames} logical ticks; {}x{}; {}",
        profile.size[0], profile.size[1], profile.id
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
    fn missing_compiled_identity_is_not_inferred_from_package() {
        if option_env!("POCKETJS_PROFILE_JSON").is_none() {
            assert!(identity(None).is_err());
        }
    }
}
