//! uihost — PocketJS UI demos in a native window.
//!
//! The PSP UI runtime re-hosted on the desktop base (docs/RUNTIMES.md): the same
//! app bundle + pak that boots on PSP hardware runs here in a QuickJS guest
//! (`pocket-mod`), drives the same `pocketjs-core`, and renders through wgpu
//! (`pocket-ui-wgpu`) — 2D and 3D on one foundation.
//!
//!   bun tools/pocket.ts profile export --target macos-embedded --out target/uihost-profile
//!   export POCKETJS_PROFILE_RS=$PWD/target/uihost-profile/pocket_profile.rs
//!   cargo run -p uihost -- --app hero                # window, 2x scale
//!   cargo run -p uihost -- --app music --scale 3
//!   cargo run -p uihost -- --app hero --screenshot out.png --frames 10
//!
//! The exported profile supplies the runtime's identity, tick rate and raster
//! density; it must admit the 480×272 logical viewport.
//!
//! Bundles/paks come from the PocketJS build (`bun tools/build.ts <app>`
//! at the repo root); uihost looks in `<repo>/dist` (override: POCKETJS_DIST
//! or explicit --js/--pak paths).
//!
//! Input map (PSP buttons): arrows = D-pad, Z/Enter = CROSS, X = CIRCLE,
//! A = SQUARE, S = TRIANGLE, Q/W = L/R triggers, Tab = SELECT,
//! Space = START. Analog nub: I/K = Y axis, J/L = X axis (full tilt).

use pocket_runtime::{Profile, timing::TickSchedule};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

use anyhow::{Context, Result, anyhow};
use pocket_drivers::{AxisSample, InputFrameBuilder, abi};
use pocket_mod::Guest;
use pocket_ui_wgpu::{Blit, ProgramConfig, ProgramOutput, UiProgram};
use pocket3d::gpu::Gpu;
use std::rc::Rc;
use winit::application::ApplicationHandler;
use winit::event::{ElementState, WindowEvent};
use winit::event_loop::{ActiveEventLoop, EventLoop};
use winit::keyboard::{KeyCode, PhysicalKey};
use winit::window::{Window, WindowId};

#[allow(dead_code)] // The export defines every fact; uihost reads some.
mod profile {
    include!(concat!(env!("OUT_DIR"), "/pocket_profile.rs"));
}

const UI_W: u32 = 480;
const UI_H: u32 = 272;

// spec BTN bits (contracts/spec/spec.ts).
const BTN_SELECT: u32 = 0x0001;
const BTN_START: u32 = 0x0008;
const BTN_UP: u32 = 0x0010;
const BTN_RIGHT: u32 = 0x0020;
const BTN_DOWN: u32 = 0x0040;
const BTN_LEFT: u32 = 0x0080;
const BTN_LTRIGGER: u32 = 0x0100;
const BTN_RTRIGGER: u32 = 0x0200;
const BTN_TRIANGLE: u32 = 0x1000;
const BTN_CIRCLE: u32 = 0x2000;
const BTN_CROSS: u32 = 0x4000;
const BTN_SQUARE: u32 = 0x8000;

struct Args {
    app: String,
    js: Option<PathBuf>,
    pak: Option<PathBuf>,
    screenshot: Option<PathBuf>,
    frames: u32,
    scale: u32,
    auto_quit: Option<f32>,
}

fn parse_args() -> Result<Args> {
    let mut args = Args {
        app: "hero-main".into(),
        js: None,
        pak: None,
        screenshot: None,
        frames: 8,
        scale: 2,
        auto_quit: None,
    };
    let mut it = std::env::args().skip(1);
    while let Some(a) = it.next() {
        let mut val = |name: &str| -> Result<String> {
            it.next().ok_or_else(|| anyhow!("{name} needs a value"))
        };
        match a.as_str() {
            "--app" => args.app = val("--app")?,
            "--js" => args.js = Some(PathBuf::from(val("--js")?)),
            "--pak" => args.pak = Some(PathBuf::from(val("--pak")?)),
            "--screenshot" => args.screenshot = Some(PathBuf::from(val("--screenshot")?)),
            "--frames" => args.frames = val("--frames")?.parse()?,
            "--scale" => args.scale = val("--scale")?.parse::<u32>()?.clamp(1, 8),
            "--auto-quit" => args.auto_quit = Some(val("--auto-quit")?.parse()?),
            other => return Err(anyhow!("unknown flag {other}")),
        }
    }
    Ok(args)
}

/// `<repo>/dist` — relative to this crate in the source tree, or
/// POCKETJS_DIST, or ./dist for standalone binaries.
fn dist_dir() -> Option<PathBuf> {
    if let Ok(d) = std::env::var("POCKETJS_DIST") {
        return Some(PathBuf::from(d));
    }
    let from_manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../dist")
        .canonicalize()
        .ok();
    from_manifest.or_else(|| {
        let cwd = PathBuf::from("dist");
        cwd.is_dir().then_some(cwd)
    })
}

fn resolve_asset(explicit: Option<PathBuf>, app: &str, ext: &str) -> Result<PathBuf> {
    if let Some(p) = explicit {
        return p
            .canonicalize()
            .with_context(|| format!("missing {}", p.display()));
    }
    let dist =
        dist_dir().ok_or_else(|| anyhow!("cannot find PocketJS dist/ (set POCKETJS_DIST)"))?;
    // Accept both `hero` and `hero-main` names; prefer the mounted -main entry.
    let candidates = [format!("{app}.{ext}"), format!("{app}-main.{ext}")];
    for c in &candidates {
        let p = dist.join(c);
        if p.is_file() {
            return Ok(p);
        }
    }
    Err(anyhow!(
        "no {ext} for app '{app}' in {} — build it first: bun tools/build.ts {app}",
        dist.display()
    ))
}

/// The profile exported into this build; uihost has no `pocket build` recipe.
fn exported_profile() -> Result<Profile> {
    profile::profile().ok_or_else(|| {
        anyhow!(
            "uihost was built without an exported profile; run `bun tools/pocket.ts profile export --target macos-embedded --out DIR` and build with POCKETJS_PROFILE_RS=DIR/pocket_profile.rs"
        )
    })
}

/// Boot the guest: feed the pak, mount `ui`, eval the bundle.
fn boot(args: &Args, profile: Profile, gpu: &Gpu) -> Result<(UiProgram, ProgramOutput)> {
    let js_path = resolve_asset(args.js.clone(), &args.app, "js")?;
    let pak_path = resolve_asset(args.pak.clone(), &args.app, "pak")?;
    let bundle = std::fs::read_to_string(&js_path)
        .with_context(|| format!("reading {}", js_path.display()))?;
    let pak =
        std::fs::read(&pak_path).with_context(|| format!("reading {}", pak_path.display()))?;

    let mut program = UiProgram::new(ProgramConfig {
        profile,
        profile_hash: profile::PROFILE_HASH,
        // The bundle's baked rate; its plan's profile.tickHz.
        tick_hz: 60,
        host_abi: profile::HOST_ABI,
        logical: [UI_W, UI_H],
        heap_limit: 64 * 1024 * 1024,
        frame_buffer_budget: 128 * 1024 * 1024,
    })?;
    let output = ProgramOutput::with_options(
        gpu,
        (UI_W, UI_H),
        1.,
        pocket3d::gpu::OFFSCREEN_FORMAT,
        wgpu::Color::BLACK,
        true,
    )?;
    output.register(&mut program)?;
    program.boot(Rc::new(Guest::new()?), &args.app, &bundle, &pak)?;
    log::info!(
        "uihost: booted {} ({} bytes js, {} bytes pak)",
        args.app,
        bundle.len(),
        pak.len()
    );
    Ok((program, output))
}

fn main() -> Result<()> {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    let args = parse_args()?;
    let profile = exported_profile()?;
    if args.screenshot.is_some() {
        headless(&args, profile)
    } else {
        windowed(args, profile)
    }
}

// ---------------------------------------------------------------------------
// headless: N guest frames, then one PNG
// ---------------------------------------------------------------------------

fn headless(args: &Args, profile: Profile) -> Result<()> {
    let gpu = Gpu::new_headless()?;
    let (mut program, output) = boot(args, profile, &gpu)?;
    for _ in 0..args.frames {
        program.advance()?;
    }
    output.prepare()?;
    program.present()?;
    let target = output.last().ok_or_else(|| anyhow!("no runtime output"))?;
    let out = args.screenshot.clone().unwrap();
    target.save_png(&gpu, &out)?;
    println!(
        "uihost: wrote {} after {} frames",
        out.display(),
        args.frames
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// windowed: winit shell + nearest-neighbor integer upscale
// ---------------------------------------------------------------------------

fn windowed(args: Args, profile: Profile) -> Result<()> {
    let event_loop = EventLoop::new()?;
    let mut app = App {
        args,
        profile,
        state: None,
        error: None,
        started: Instant::now(),
    };
    event_loop.run_app(&mut app)?;
    match app.error {
        Some(e) => Err(e),
        None => Ok(()),
    }
}

/// Analog-nub keys currently held (uihost has no real stick: a held key is
/// full tilt, opposing keys cancel to center).
#[derive(Default)]
struct Nub {
    up: bool,
    down: bool,
    left: bool,
    right: bool,
}

impl Nub {
    /// The held-flag a nub key drives (I/K = Y axis, J/L = X axis), if any.
    fn key(&mut self, key: KeyCode) -> Option<&mut bool> {
        Some(match key {
            KeyCode::KeyI => &mut self.up,
            KeyCode::KeyK => &mut self.down,
            KeyCode::KeyJ => &mut self.left,
            KeyCode::KeyL => &mut self.right,
            _ => return None,
        })
    }
}

struct State {
    window: Arc<Window>,
    surface: wgpu::Surface<'static>,
    surface_config: wgpu::SurfaceConfiguration,
    gpu: Gpu,
    program: UiProgram,
    output: ProgramOutput,
    blit: Blit,
    buttons: u32,
    nub: Nub,
    clock: Instant,
    schedule: TickSchedule,
}

struct App {
    args: Args,
    profile: Profile,
    state: Option<State>,
    error: Option<anyhow::Error>,
    started: Instant,
}

impl App {
    fn init_state(&mut self, event_loop: &ActiveEventLoop) -> Result<State> {
        let attrs = Window::default_attributes()
            .with_title(format!("PocketJS — {}", self.args.app))
            .with_inner_size(winit::dpi::LogicalSize::new(
                UI_W * self.args.scale,
                UI_H * self.args.scale,
            ));
        let window = Arc::new(event_loop.create_window(attrs)?);
        let instance = Gpu::new_instance();
        let surface = instance.create_surface(window.clone())?;
        let gpu = Gpu::from_instance_for_surface(instance, &surface)?;
        let px = window.inner_size();
        let mut surface_config = surface
            .get_default_config(&gpu.adapter, px.width.max(1), px.height.max(1))
            .ok_or_else(|| anyhow!("surface not supported"))?;
        surface_config.present_mode = wgpu::PresentMode::AutoVsync;
        surface.configure(&gpu.device, &surface_config);

        let (program, output) = boot(&self.args, self.profile.clone(), &gpu)?;
        // The booted package's rate presented at the profile cadence.
        let cadence = program
            .timing()
            .ok_or_else(|| anyhow!("uihost: the package did not boot"))?
            .cadence_hz;
        let target = output
            .first()
            .ok_or_else(|| anyhow!("missing output target"))?;
        let blit = Blit::new(
            &gpu,
            &target.view,
            surface_config.format,
            wgpu::FilterMode::Nearest,
            false,
        );
        Ok(State {
            window,
            surface,
            surface_config,
            gpu,
            program,
            output,
            blit,
            buttons: 0,
            nub: Nub::default(),
            clock: Instant::now(),
            schedule: TickSchedule::new(cadence, 0, 1)
                .map_err(|error| anyhow!("uihost timing: {error:?}"))?,
        })
    }

    fn redraw(&mut self) -> Result<()> {
        let Some(s) = self.state.as_mut() else {
            return Ok(());
        };
        // Vsync can exceed 60 Hz. Reserve simulation slots with Runtime's
        // monotonic schedule; missed wall slots do not replay guest turns.
        if s.schedule
            .poll(s.clock.elapsed().as_micros().min(u64::MAX as u128) as u64)
            .map_err(|error| anyhow!("uihost timing: {error:?}"))?
            .is_some()
        {
            let mut facts = InputFrameBuilder::new();
            facts.buttons = s.buttons;
            let axis = |neg: bool, pos: bool| 128. + (pos as i32 - neg as i32) as f32 * 127.;
            facts.axes.push(AxisSample {
                id: abi::POCKET_AXIS_LEFT_X,
                value: axis(s.nub.left, s.nub.right),
            });
            facts.axes.push(AxisSample {
                id: abi::POCKET_AXIS_LEFT_Y,
                value: axis(s.nub.up, s.nub.down),
            });
            s.program.set_input(facts);
            s.program.advance()?;
            s.output.prepare()?;
            s.program.present()?;
        }

        let frame = match s.surface.get_current_texture() {
            Ok(f) => f,
            Err(wgpu::SurfaceError::Lost | wgpu::SurfaceError::Outdated) => {
                s.surface.configure(&s.gpu.device, &s.surface_config);
                return Ok(());
            }
            Err(e) => return Err(anyhow!("surface: {e}")),
        };
        let view = frame.texture.create_view(&Default::default());
        let mut encoder = s.gpu.device.create_command_encoder(&Default::default());
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("uihost blit pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
            });
            // Integer scale, centered (letterboxed).
            let (sw, sh) = (s.surface_config.width, s.surface_config.height);
            let scale = (sw / UI_W).min(sh / UI_H).max(1);
            let (vw, vh) = (UI_W * scale, UI_H * scale);
            let (vx, vy) = (sw.saturating_sub(vw) / 2, sh.saturating_sub(vh) / 2);
            pass.set_viewport(vx as f32, vy as f32, vw as f32, vh as f32, 0.0, 1.0);
            s.blit.draw(&mut pass);
        }
        s.gpu.queue.submit([encoder.finish()]);
        s.window.pre_present_notify();
        frame.present();
        s.window.request_redraw();
        Ok(())
    }
}

fn button_for(key: KeyCode) -> Option<u32> {
    Some(match key {
        KeyCode::ArrowUp => BTN_UP,
        KeyCode::ArrowDown => BTN_DOWN,
        KeyCode::ArrowLeft => BTN_LEFT,
        KeyCode::ArrowRight => BTN_RIGHT,
        KeyCode::KeyZ | KeyCode::Enter => BTN_CROSS,
        KeyCode::KeyX | KeyCode::Backspace => BTN_CIRCLE,
        KeyCode::KeyA => BTN_SQUARE,
        KeyCode::KeyS => BTN_TRIANGLE,
        KeyCode::KeyQ => BTN_LTRIGGER,
        KeyCode::KeyW => BTN_RTRIGGER,
        KeyCode::Tab => BTN_SELECT,
        KeyCode::Space => BTN_START,
        _ => return None,
    })
}

impl ApplicationHandler for App {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        if self.state.is_none() {
            match self.init_state(event_loop) {
                Ok(s) => {
                    s.window.request_redraw();
                    self.state = Some(s);
                }
                Err(e) => {
                    self.error = Some(e);
                    event_loop.exit();
                }
            }
        }
    }

    fn window_event(&mut self, event_loop: &ActiveEventLoop, _id: WindowId, event: WindowEvent) {
        match event {
            WindowEvent::CloseRequested => event_loop.exit(),
            WindowEvent::Resized(px) => {
                if let Some(s) = self.state.as_mut() {
                    s.surface_config.width = px.width.max(1);
                    s.surface_config.height = px.height.max(1);
                    s.surface.configure(&s.gpu.device, &s.surface_config);
                }
            }
            WindowEvent::Focused(false) => {
                if let Some(state) = self.state.as_mut() {
                    state.buttons = 0;
                    state.nub = Nub::default();
                }
            }
            WindowEvent::KeyboardInput { event, .. } => {
                if let PhysicalKey::Code(code) = event.physical_key {
                    if code == KeyCode::Escape {
                        event_loop.exit();
                        return;
                    }
                    if let Some(s) = self.state.as_mut() {
                        let held = event.state == ElementState::Pressed;
                        if let Some(bit) = button_for(code) {
                            if held {
                                s.buttons |= bit;
                            } else {
                                s.buttons &= !bit;
                            }
                        } else if let Some(k) = s.nub.key(code) {
                            *k = held;
                        }
                    }
                }
            }
            WindowEvent::RedrawRequested => {
                if let Some(limit) = self.args.auto_quit
                    && self.started.elapsed().as_secs_f32() > limit
                {
                    event_loop.exit();
                    return;
                }
                if let Err(e) = self.redraw() {
                    self.error = Some(e);
                    event_loop.exit();
                }
            }
            _ => {}
        }
    }
}
