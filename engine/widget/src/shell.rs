//! The widget window shell: two rates, one clock.
//!
//! The guest ticks at a fixed rate, always — one guest turn per host tick
//! (Law 3), so tapes, goldens and replays hold inside a widget. GPU frames
//! are demand-driven: a frame renders only when the game reports dirt (the
//! embedded UI changed, a part moved, the camera eased). No dirt → no render
//! pass, no present — the compositor retains the last frame and an idle
//! widget costs ticks (microseconds), not frames. macOS occlusion suspends
//! rendering entirely while ticks keep the app live behind other windows.
//!
//! This is a sibling of [`pocket3d::app::run`], not a wrapper: that loop
//! ties simulation to redraws (right for games rendering every frame),
//! while a widget must tick without rendering.
//!
//! Two widget shapes share the governor:
//!
//! - [`WidgetGame`] + [`run`] — the 3D form (a scene, a camera, meshes; the
//!   `ui` surface arrives on a screen mesh via [`crate::embed::EmbeddedUi`]).
//! - [`FlatWidget`] + [`run_flat`] — the 2D form: the window *is* the `ui`
//!   surface, rendered 1:1 by `pocket-ui-wgpu` with no scene pass at all.
//!   The natural shape for text-first widgets (notes, tickers, boards).

use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::Result;
use glam::Vec2;
use pocket_runtime::timing::TickSchedule;
use winit::application::ApplicationHandler;
use winit::event::{ElementState, MouseButton, WindowEvent};
use winit::event_loop::{ActiveEventLoop, ControlFlow, EventLoop};
use winit::window::{Window, WindowId, WindowLevel};

use pocket3d::app::pick_alpha_mode;
use pocket3d::camera::Camera;
use pocket3d::gpu::Gpu;
use pocket3d::hud::Hud;
use pocket3d::input::Input;
use pocket3d::renderer::Renderer;
use pocket3d::scene::Scene;

pub struct WidgetConfig {
    pub title: String,
    /// Initial window size in logical px.
    pub size: (u32, u32),
    /// Fixed simulation rate — the guest cadence (60 = the PSP's).
    pub tick_hz: f32,
    /// Render cap for the active case (eases, drags). The loop sleeps
    /// between frames; dirt reported while pacing is latched, never lost.
    pub max_fps: f32,
    pub transparent: bool,
    pub decorations: bool,
    pub always_on_top: bool,
    /// Live window resizing. Borderless windows keep the `Resizable` style
    /// mask on macOS (edge-drag works without decorations); games can also
    /// claim a grip region via `resize_at` for an explicit affordance.
    pub resizable: bool,
    /// Logical px floor enforced by the OS while `resizable`.
    pub min_size: (u32, u32),
    /// Enable OS text composition (IME). Composition arrives on the input's
    /// `ime_events` stream; the game reports its caret rect through
    /// `ime_cursor_area` so candidate windows dock next to the text.
    pub ime: bool,
}

impl Default for WidgetConfig {
    fn default() -> Self {
        Self {
            title: "Pocket Widget".into(),
            size: (480, 260),
            tick_hz: 60.0,
            max_fps: 60.0,
            transparent: true,
            decorations: false,
            always_on_top: true,
            resizable: false,
            min_size: (160, 120),
            ime: false,
        }
    }
}

/// What the widget loop needs from a 3D product.
pub trait WidgetGame {
    /// Called once after the GPU exists — build assets, boot guests.
    fn init(&mut self, gpu: &Gpu, renderer: &mut Renderer) -> Result<()>;
    /// One fixed-step tick: the guest turn (`frame(buttons, analog)`), the
    /// embedded UI tick, interaction state. Runs whether or not a frame
    /// will render. `window_px` is the surface size in physical pixels —
    /// the space cursor positions live in, for picking. Mark dirt
    /// internally; the shell collects it via [`take_dirty`](Self::take_dirty).
    fn tick(&mut self, dt: f32, input: &Input, window_px: (u32, u32)) -> Result<()>;
    /// Consume the "needs a GPU frame" flag. Latched by the shell until a
    /// frame actually renders, so fps pacing never drops dirt.
    fn take_dirty(&mut self) -> bool;
    /// Record offscreen work that must land before the scene pass samples
    /// it (the embedded UI render). Called only on frames that render.
    fn prepare(&mut self, gpu: &Gpu) -> Result<()>;
    /// Provide the frame to draw. `time` is seconds since launch.
    fn compose(&mut self, time: f32, size: (u32, u32)) -> (&Scene, &Camera, &Hud);
    /// Left-press policy: return true to start an OS window drag at this
    /// cursor position (widget-style move) instead of interacting.
    fn drag_at(&mut self, cursor: Vec2) -> bool {
        let _ = cursor;
        false
    }
    /// Left-press policy: return true to start a window resize drag at this
    /// cursor position (a grip corner). Consulted before `drag_at`.
    fn resize_at(&mut self, cursor: Vec2) -> bool {
        let _ = cursor;
        false
    }
    fn wants_exit(&self) -> bool {
        false
    }
}

/// What the widget loop needs from a 2D (window-is-the-surface) product.
///
/// Same governor, no scene: the game renders whatever it wants straight
/// into the swapchain view — for a PocketJS widget that is one
/// `UiRenderer::render_words` pass over the guest's DrawList.
pub trait FlatWidget {
    /// Called once after the GPU exists. `format` is the swapchain format
    /// the game's pipelines must target.
    fn init(&mut self, gpu: &Gpu, format: wgpu::TextureFormat) -> Result<()>;
    /// One fixed-step tick — the guest turn. `window_px` is the surface
    /// size in physical pixels; `scale` the window's scale factor (cursor
    /// positions and `window_px` are physical — divide by `scale` for
    /// logical px).
    fn tick(&mut self, dt: f32, input: &Input, window_px: (u32, u32), scale: f64) -> Result<()>;
    /// Consume the "needs a GPU frame" flag (latched by the shell).
    fn take_dirty(&mut self) -> bool;
    /// Draw into the swapchain view (submit your own encoder). Called only
    /// on frames that render.
    fn render(&mut self, gpu: &Gpu, view: &wgpu::TextureView, window_px: (u32, u32)) -> Result<()>;
    /// Left-press policy: OS window drag (move) at this cursor position?
    fn drag_at(&mut self, cursor: Vec2) -> bool {
        let _ = cursor;
        false
    }
    /// Left-press policy: window resize drag at this cursor position?
    /// Consulted before `drag_at`. The shell tracks the drag itself
    /// (macOS has no OS resize session for borderless windows).
    fn resize_at(&mut self, cursor: Vec2) -> bool {
        let _ = cursor;
        false
    }
    /// The caret rect in PHYSICAL px (x, y, w, h) — where the OS should
    /// dock IME candidate windows. Polled after ticks; None leaves the
    /// last placement.
    fn ime_cursor_area(&mut self) -> Option<(f32, f32, f32, f32)> {
        None
    }
    fn wants_exit(&self) -> bool {
        false
    }
}

/// Run a 3D widget (scene + camera + demand rendering).
pub fn run(config: WidgetConfig, game: impl WidgetGame) -> Result<()> {
    run_driver(
        config,
        SceneDriver {
            game,
            renderer: None,
        },
    )
}

/// Run a 2D widget (the window is the surface).
pub fn run_flat(config: WidgetConfig, game: impl FlatWidget) -> Result<()> {
    run_driver(config, FlatDriver { game })
}

// ---------------------------------------------------------------------------
// The governor, generic over the two widget shapes.
// ---------------------------------------------------------------------------

/// Internal adapter: what the event loop actually drives. Both public
/// traits funnel into this so the governor exists exactly once.
trait Driver {
    fn init(&mut self, gpu: &Gpu, format: wgpu::TextureFormat) -> Result<()>;
    fn tick(&mut self, dt: f32, input: &Input, window_px: (u32, u32), scale: f64) -> Result<()>;
    fn take_dirty(&mut self) -> bool;
    fn render(
        &mut self,
        gpu: &Gpu,
        view: &wgpu::TextureView,
        window_px: (u32, u32),
        time: f32,
    ) -> Result<()>;
    fn drag_at(&mut self, cursor: Vec2) -> bool;
    fn resize_at(&mut self, cursor: Vec2) -> bool;
    fn ime_cursor_area(&mut self) -> Option<(f32, f32, f32, f32)>;
    fn wants_exit(&self) -> bool;
}

struct SceneDriver<G: WidgetGame> {
    game: G,
    renderer: Option<Renderer>,
}

impl<G: WidgetGame> Driver for SceneDriver<G> {
    fn init(&mut self, gpu: &Gpu, format: wgpu::TextureFormat) -> Result<()> {
        let mut renderer = Renderer::new(gpu, format)?;
        self.game.init(gpu, &mut renderer)?;
        self.renderer = Some(renderer);
        Ok(())
    }
    fn tick(&mut self, dt: f32, input: &Input, window_px: (u32, u32), _scale: f64) -> Result<()> {
        self.game.tick(dt, input, window_px)
    }
    fn take_dirty(&mut self) -> bool {
        self.game.take_dirty()
    }
    fn render(
        &mut self,
        gpu: &Gpu,
        view: &wgpu::TextureView,
        window_px: (u32, u32),
        time: f32,
    ) -> Result<()> {
        self.game.prepare(gpu)?;
        let (scene, camera, hud) = self.game.compose(time, window_px);
        let renderer = self.renderer.as_mut().expect("init ran");
        renderer.render(gpu, view, window_px, scene, camera, hud);
        Ok(())
    }
    fn drag_at(&mut self, cursor: Vec2) -> bool {
        self.game.drag_at(cursor)
    }
    fn resize_at(&mut self, cursor: Vec2) -> bool {
        self.game.resize_at(cursor)
    }
    fn ime_cursor_area(&mut self) -> Option<(f32, f32, f32, f32)> {
        None
    }
    fn wants_exit(&self) -> bool {
        self.game.wants_exit()
    }
}

struct FlatDriver<G: FlatWidget> {
    game: G,
}

impl<G: FlatWidget> Driver for FlatDriver<G> {
    fn init(&mut self, gpu: &Gpu, format: wgpu::TextureFormat) -> Result<()> {
        self.game.init(gpu, format)
    }
    fn tick(&mut self, dt: f32, input: &Input, window_px: (u32, u32), scale: f64) -> Result<()> {
        self.game.tick(dt, input, window_px, scale)
    }
    fn take_dirty(&mut self) -> bool {
        self.game.take_dirty()
    }
    fn render(
        &mut self,
        gpu: &Gpu,
        view: &wgpu::TextureView,
        window_px: (u32, u32),
        _time: f32,
    ) -> Result<()> {
        self.game.render(gpu, view, window_px)
    }
    fn drag_at(&mut self, cursor: Vec2) -> bool {
        self.game.drag_at(cursor)
    }
    fn resize_at(&mut self, cursor: Vec2) -> bool {
        self.game.resize_at(cursor)
    }
    fn ime_cursor_area(&mut self) -> Option<(f32, f32, f32, f32)> {
        self.game.ime_cursor_area()
    }
    fn wants_exit(&self) -> bool {
        self.game.wants_exit()
    }
}

fn run_driver(config: WidgetConfig, driver: impl Driver) -> Result<()> {
    let event_loop = EventLoop::new()?;
    let mut app = WidgetApp {
        config,
        driver,
        state: None,
        error: None,
        ticks: 0,
        frames: 0,
        arms: ArmCounts::default(),
    };
    event_loop.run_app(&mut app)?;
    // The governor's receipt: how many fixed ticks ran vs. GPU frames
    // actually rendered. A settled widget should show frames ≪ ticks.
    log::info!(
        "pocket-widget: {} ticks, {} frames rendered ({:.1}%) — armed by dirt {}, resize {}, occlusion {}, scale {}; {} unarmed OS redraws skipped",
        app.ticks,
        app.frames,
        100.0 * app.frames as f64 / app.ticks.max(1) as f64,
        app.arms.dirty,
        app.arms.resized,
        app.arms.occlusion,
        app.arms.scale,
        app.arms.unarmed_redraws
    );
    match app.error {
        Some(e) => Err(e),
        None => Ok(()),
    }
}

/// Why frames were armed — logged with the exit receipt so a hot widget
/// explains itself (dirt is the only healthy steady-state source).
#[derive(Default)]
struct ArmCounts {
    dirty: u64,
    resized: u64,
    occlusion: u64,
    scale: u64,
    /// OS-initiated RedrawRequested with nothing pending (skipped).
    unarmed_redraws: u64,
}

struct WindowState {
    window: Arc<Window>,
    surface: wgpu::Surface<'static>,
    surface_config: wgpu::SurfaceConfiguration,
    gpu: Gpu,
    input: Input,
    start: Instant,
    schedule: TickSchedule,
    last_render: Instant,
    /// Dirt latched from the game, waiting for a paced render.
    render_pending: bool,
    occluded: bool,
    /// Last IME caret rect handed to the OS (dedupe).
    ime_area: Option<(f32, f32, f32, f32)>,
    /// Live grip resize: (cursor at press, window physical size at press).
    /// The shell tracks the drag itself — macOS offers no OS resize
    /// session for borderless windows.
    resizing: Option<(Vec2, (u32, u32))>,
}

struct WidgetApp<D: Driver> {
    config: WidgetConfig,
    driver: D,
    state: Option<WindowState>,
    error: Option<anyhow::Error>,
    ticks: u64,
    frames: u64,
    arms: ArmCounts,
}

impl<D: Driver> WidgetApp<D> {
    fn init_state(&mut self, event_loop: &ActiveEventLoop) -> Result<WindowState> {
        let mut attrs = Window::default_attributes()
            .with_title(self.config.title.clone())
            .with_inner_size(winit::dpi::LogicalSize::new(
                self.config.size.0,
                self.config.size.1,
            ))
            .with_transparent(self.config.transparent)
            .with_decorations(self.config.decorations)
            .with_resizable(self.config.resizable)
            .with_window_level(if self.config.always_on_top {
                WindowLevel::AlwaysOnTop
            } else {
                WindowLevel::Normal
            });
        if self.config.resizable {
            attrs = attrs.with_min_inner_size(winit::dpi::LogicalSize::new(
                self.config.min_size.0,
                self.config.min_size.1,
            ));
        }
        let window = Arc::new(event_loop.create_window(attrs)?);
        if self.config.ime {
            window.set_ime_allowed(true);
        }
        let instance = Gpu::new_instance();
        let surface = instance.create_surface(window.clone())?;
        let gpu = Gpu::from_instance_for_surface_with_power_preference(
            instance,
            &surface,
            wgpu::PowerPreference::LowPower,
        )?;

        let px = window.inner_size();
        let mut surface_config = surface
            .get_default_config(&gpu.adapter, px.width.max(1), px.height.max(1))
            .ok_or_else(|| anyhow::anyhow!("surface not supported by adapter"))?;
        surface_config.present_mode = wgpu::PresentMode::AutoVsync;
        if self.config.transparent {
            surface_config.alpha_mode = pick_alpha_mode(&surface, &gpu.adapter)?;
        }
        surface.configure(&gpu.device, &surface_config);

        self.driver.init(&gpu, surface_config.format)?;

        anyhow::ensure!(
            self.config.tick_hz.is_finite() && self.config.tick_hz.fract() == 0.,
            "tick rate must be an integer"
        );
        let schedule = TickSchedule::new(self.config.tick_hz as u32, 0, 1)
            .map_err(|error| anyhow::anyhow!("widget timing: {error:?}"))?;
        let now = Instant::now();
        Ok(WindowState {
            window,
            surface,
            surface_config,
            gpu,
            input: Input::default(),
            start: now,
            schedule,
            last_render: now - Duration::from_secs(1),
            render_pending: true, // first frame
            occluded: false,
            ime_area: None,
            resizing: None,
        })
    }

    /// The governor: run due fixed ticks, collect dirt, schedule the next
    /// wake at whichever comes first — the next tick or a due render.
    fn pump(&mut self, event_loop: &ActiveEventLoop) {
        let Some(state) = self.state.as_mut() else {
            return;
        };
        let tick_dt = 1.0 / self.config.tick_hz.max(1.0);
        let now = Instant::now();
        let window_px = (state.surface_config.width, state.surface_config.height);
        let scale = state.window.scale_factor();
        let timing = state.schedule.poll(
            now.duration_since(state.start)
                .as_micros()
                .min(u64::MAX as u128) as u64,
        );
        let due = match timing {
            Ok(value) => value.is_some(),
            Err(error) => {
                self.error = Some(anyhow::anyhow!("widget timing: {error:?}"));
                event_loop.exit();
                return;
            }
        };
        if due {
            if let Err(e) = self.driver.tick(tick_dt, &state.input, window_px, scale) {
                self.error = Some(e);
                event_loop.exit();
                return;
            }
            // Device edges belong to the one runtime turn reserved above.
            state.input.end_frame();
            self.ticks += 1;
        }
        if self.driver.wants_exit() {
            event_loop.exit();
            return;
        }

        if self.driver.take_dirty() {
            state.render_pending = true;
            self.arms.dirty += 1;
        }

        if self.config.ime {
            let area = self.driver.ime_cursor_area();
            if let Some((x, y, w, h)) = area
                && area != state.ime_area
            {
                state.ime_area = area;
                state.window.set_ime_cursor_area(
                    winit::dpi::PhysicalPosition::new(x, y),
                    winit::dpi::PhysicalSize::new(w, h),
                );
            }
        }

        let frame_interval = Duration::from_secs_f32(1.0 / self.config.max_fps.max(1.0));
        let mut wake = match state.schedule.deadline() {
            Ok(deadline) => state.start + Duration::from_micros(deadline),
            Err(error) => {
                self.error = Some(anyhow::anyhow!("widget timing: {error:?}"));
                event_loop.exit();
                return;
            }
        };
        if state.render_pending && !state.occluded {
            let due = state.last_render + frame_interval;
            if now >= due {
                state.window.request_redraw();
            } else {
                wake = wake.min(due);
            }
        }
        event_loop.set_control_flow(ControlFlow::WaitUntil(wake));
    }

    fn redraw(&mut self) -> Result<()> {
        let Some(state) = self.state.as_mut() else {
            return Ok(());
        };
        // Only render when the governor armed a frame. macOS occasionally
        // streams RedrawRequested on its own (compositor moods); honoring
        // those would turn a settled widget into a 40 fps space heater.
        // Every event that genuinely needs pixels (resize, scale change,
        // un-occlusion, first show) sets render_pending — the compositor
        // retains the last frame for everything else.
        if !state.render_pending {
            self.arms.unarmed_redraws += 1;
            return Ok(());
        }
        let frame = match state.surface.get_current_texture() {
            Ok(f) => f,
            Err(wgpu::SurfaceError::Lost | wgpu::SurfaceError::Outdated) => {
                state
                    .surface
                    .configure(&state.gpu.device, &state.surface_config);
                return Ok(()); // render_pending stays latched; next wake retries
            }
            Err(e) => return Err(anyhow::anyhow!("surface error: {e}")),
        };
        let view = frame
            .texture
            .create_view(&wgpu::TextureViewDescriptor::default());
        let size = (state.surface_config.width, state.surface_config.height);
        self.driver
            .render(&state.gpu, &view, size, state.start.elapsed().as_secs_f32())?;
        state.window.pre_present_notify();
        frame.present();

        state.render_pending = false;
        state.last_render = Instant::now();
        self.frames += 1;
        Ok(())
    }
}

impl<D: Driver> ApplicationHandler for WidgetApp<D> {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        if self.state.is_none() {
            match self.init_state(event_loop) {
                Ok(s) => self.state = Some(s),
                Err(e) => {
                    self.error = Some(e);
                    event_loop.exit();
                }
            }
        }
    }

    fn window_event(
        &mut self,
        event_loop: &ActiveEventLoop,
        _window_id: WindowId,
        event: WindowEvent,
    ) {
        let Some(state) = self.state.as_mut() else {
            return;
        };
        state.input.on_window_event(&event);
        match event {
            WindowEvent::CloseRequested => event_loop.exit(),
            WindowEvent::Resized(size) => {
                log::debug!("pocket-widget: Resized {size:?}");
                state.surface_config.width = size.width.max(1);
                state.surface_config.height = size.height.max(1);
                state
                    .surface
                    .configure(&state.gpu.device, &state.surface_config);
                state.render_pending = true;
                self.arms.resized += 1;
            }
            WindowEvent::ScaleFactorChanged { scale_factor, .. } => {
                log::debug!("pocket-widget: ScaleFactorChanged({scale_factor})");
                state.render_pending = true;
                self.arms.scale += 1;
            }
            WindowEvent::Occluded(occluded) => {
                log::debug!("pocket-widget: Occluded({occluded})");
                state.occluded = occluded;
                if !occluded {
                    state.render_pending = true; // repaint on reveal
                    self.arms.occlusion += 1;
                }
            }
            WindowEvent::MouseInput {
                state: elem_state,
                button: MouseButton::Left,
                ..
            } => match elem_state {
                ElementState::Pressed => {
                    if let Some(cursor) = state.input.cursor() {
                        if self.config.resizable && self.driver.resize_at(cursor) {
                            let size = (state.surface_config.width, state.surface_config.height);
                            state.resizing = Some((cursor, size));
                            // The grip press is a window gesture, not app
                            // input — take the button back.
                            state.input.inject_mouse_button(MouseButton::Left, false);
                        } else if self.driver.drag_at(cursor) {
                            let _ = state.window.drag_window();
                            // macOS swallows the release once the OS drag
                            // session starts; clear the button so the next
                            // press edges.
                            state.input.inject_mouse_button(MouseButton::Left, false);
                        }
                    }
                }
                ElementState::Released => {
                    state.resizing = None;
                }
            },
            WindowEvent::CursorMoved { position, .. } => {
                if let Some((grab, size0)) = state.resizing {
                    let scale = state.window.scale_factor();
                    let min_w = (self.config.min_size.0 as f64 * scale) as i64;
                    let min_h = (self.config.min_size.1 as f64 * scale) as i64;
                    let w = (size0.0 as i64 + (position.x - grab.x as f64) as i64).max(min_w);
                    let h = (size0.1 as i64 + (position.y - grab.y as f64) as i64).max(min_h);
                    let _ = state
                        .window
                        .request_inner_size(winit::dpi::PhysicalSize::new(w as u32, h as u32));
                }
            }
            WindowEvent::RedrawRequested => {
                // Ignore redraws while occluded. Unsolicited OS redraws while
                // the retained frame is current are rejected and counted by
                // `redraw`; resize/reveal and game dirt arm real frames.
                if state.occluded {
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

    fn about_to_wait(&mut self, event_loop: &ActiveEventLoop) {
        self.pump(event_loop);
    }
}
