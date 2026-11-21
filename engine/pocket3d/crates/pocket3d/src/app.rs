//! Windowed application loop (winit 0.30) with fixed-step simulation.
//!
//! Games implement [`Game`]; the same object can also be driven headlessly
//! by calling `tick`/`compose` directly (see OpenStrike's script mode).

use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::Result;
use winit::application::ApplicationHandler;
use winit::event::{DeviceEvent, DeviceId, WindowEvent};
use winit::event_loop::{ActiveEventLoop, ControlFlow, EventLoop};
use winit::keyboard::KeyCode;
use winit::window::{CursorGrabMode, Window, WindowId, WindowLevel};

use crate::camera::Camera;
use crate::gpu::Gpu;
use crate::hud::Hud;
use crate::input::Input;
use crate::renderer::Renderer;
use crate::scene::Scene;
use crate::time::FixedTimestep;

pub struct AppConfig {
    pub title: String,
    pub size: (u32, u32),
    pub tick_hz: f32,
    /// Grab + hide the cursor for mouse look (Esc toggles).
    pub capture_mouse: bool,
    /// Alpha-composited window: the surface picks a non-opaque alpha mode
    /// and pixels the scene leaves transparent show the desktop behind the
    /// window. Pair with [`crate::scene::Scene::transparent_clear`].
    pub transparent: bool,
    /// Window chrome (title bar, borders). Off for widget-style windows.
    pub decorations: bool,
    /// Float above normal windows.
    pub always_on_top: bool,
    pub resizable: bool,
    /// Cap the render rate. `None` renders every vsync, which on a 120 Hz
    /// display means 120 fps; long-lived widgets should cap (and the loop
    /// then sleeps between frames instead of spinning on redraws).
    pub max_fps: Option<f32>,
    /// Left-mouse press starts an OS window drag (widget-style move;
    /// the press still reaches [`Input`] first, so clicks keep working).
    pub drag_window: bool,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            title: "Pocket3D".into(),
            size: (1600, 900),
            tick_hz: 64.0,
            capture_mouse: true,
            transparent: false,
            decorations: true,
            always_on_top: false,
            resizable: true,
            max_fps: None,
            drag_window: false,
        }
    }
}

/// Cursor ownership requested by a game or an overlay.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum CursorMode {
    /// Use AppConfig's capture setting and the legacy Escape/click behavior.
    #[default]
    Legacy,
    /// The game owns mouse look; mode changes discard held input.
    Captured,
    /// A UI owns the visible pointer. Clicking never recaptures the mouse.
    Visible,
}

/// What the app loop needs from a game.
pub trait Game {
    /// Called once after the GPU exists — load assets here.
    fn init(&mut self, gpu: &Gpu, renderer: &mut Renderer) -> Result<()>;
    /// Called once per rendered frame before fixed ticks (mouse look etc.).
    fn frame(&mut self, dt: f32, input: &Input);
    /// Fixed-step simulation.
    fn tick(&mut self, dt: f32, input: &Input);
    /// Input ownership requested by the application, applied after frame/tick.
    fn cursor_mode(&self) -> CursorMode {
        CursorMode::Legacy
    }
    /// Physical viewport and OS scale, delivered before input in the new size.
    fn resized(&mut self, _size: (u32, u32), _scale_factor: f64) {}
    /// Provide the frame to draw. `time` is seconds since launch.
    fn compose(&mut self, alpha: f32, time: f32, size: (u32, u32)) -> (&Scene, &Camera, &Hud);
    /// Record extra passes over the finished frame (UI overlays, composite
    /// effects) before present. `format` is the target's texture format.
    /// Default: nothing.
    fn overlay(
        &mut self,
        gpu: &Gpu,
        encoder: &mut wgpu::CommandEncoder,
        view: &wgpu::TextureView,
        format: wgpu::TextureFormat,
        size: (u32, u32),
    ) {
        let (_, _, _, _, _) = (gpu, encoder, view, format, size);
    }
    /// Return true to quit.
    fn wants_exit(&self) -> bool {
        false
    }
}

pub fn run(config: AppConfig, game: impl Game) -> Result<()> {
    let event_loop = EventLoop::new()?;
    let mut app = WinitApp {
        config,
        game,
        state: None,
        error: None,
    };
    event_loop.run_app(&mut app)?;
    match app.error {
        Some(e) => Err(e),
        None => Ok(()),
    }
}

struct WindowState {
    window: Arc<Window>,
    surface: wgpu::Surface<'static>,
    surface_config: wgpu::SurfaceConfiguration,
    gpu: Gpu,
    renderer: Renderer,
    input: Input,
    timestep: FixedTimestep,
    start: Instant,
    last_frame: Instant,
    mouse_captured: bool,
    cursor_mode: CursorMode,
    focused: bool,
}

struct WinitApp<G: Game> {
    config: AppConfig,
    game: G,
    state: Option<WindowState>,
    error: Option<anyhow::Error>,
}

impl<G: Game> WinitApp<G> {
    fn init_state(&mut self, event_loop: &ActiveEventLoop) -> Result<WindowState> {
        let attrs = Window::default_attributes()
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
        let window = Arc::new(event_loop.create_window(attrs)?);
        let instance = Gpu::new_instance();
        let surface = instance.create_surface(window.clone())?;
        let gpu = Gpu::from_instance_for_surface(instance, &surface)?;

        let px = window.inner_size();
        let mut surface_config = surface
            .get_default_config(&gpu.adapter, px.width.max(1), px.height.max(1))
            .ok_or_else(|| anyhow::anyhow!("surface not supported by adapter"))?;
        surface_config.present_mode = wgpu::PresentMode::AutoVsync;
        if self.config.transparent {
            surface_config.alpha_mode = pick_alpha_mode(&surface, &gpu.adapter)?;
        }
        surface.configure(&gpu.device, &surface_config);

        let mut renderer = Renderer::new(&gpu, surface_config.format)?;
        self.game.init(&gpu, &mut renderer)?;
        self.game
            .resized((px.width, px.height), window.scale_factor());

        let mut state = WindowState {
            window,
            surface,
            surface_config,
            gpu,
            renderer,
            input: Input::default(),
            timestep: FixedTimestep::new(self.config.tick_hz),
            start: Instant::now(),
            last_frame: Instant::now(),
            mouse_captured: false,
            cursor_mode: self.game.cursor_mode(),
            focused: true,
        };
        if wants_capture(state.cursor_mode, self.config.capture_mouse) {
            set_mouse_capture(&mut state, true);
        }
        Ok(state)
    }

    fn redraw(&mut self, event_loop: &ActiveEventLoop) {
        let Some(state) = self.state.as_mut() else {
            return;
        };

        let now = Instant::now();
        let dt = (now - state.last_frame).as_secs_f32();
        state.last_frame = now;

        self.game.frame(dt, &state.input);
        sync_cursor_mode(state, self.game.cursor_mode(), self.config.capture_mouse);
        let ticks = state.timestep.advance(dt);
        for _ in 0..ticks {
            self.game.tick(state.timestep.step, &state.input);
            sync_cursor_mode(state, self.game.cursor_mode(), self.config.capture_mouse);
        }
        state.input.end_frame();

        if self.game.wants_exit() {
            event_loop.exit();
            return;
        }

        let frame = match state.surface.get_current_texture() {
            Ok(f) => f,
            Err(wgpu::SurfaceError::Lost | wgpu::SurfaceError::Outdated) => {
                state
                    .surface
                    .configure(&state.gpu.device, &state.surface_config);
                return;
            }
            Err(e) => {
                log::error!("surface error: {e}");
                return;
            }
        };
        let view = frame
            .texture
            .create_view(&wgpu::TextureViewDescriptor::default());
        let size = (state.surface_config.width, state.surface_config.height);
        let (scene, camera, hud) = self.game.compose(
            state.timestep.alpha(),
            state.start.elapsed().as_secs_f32(),
            size,
        );
        state
            .renderer
            .render(&state.gpu, &view, size, scene, camera, hud);
        let mut encoder =
            state
                .gpu
                .device
                .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                    label: Some("overlay"),
                });
        self.game.overlay(
            &state.gpu,
            &mut encoder,
            &view,
            state.surface_config.format,
            size,
        );
        state.gpu.queue.submit([encoder.finish()]);
        state.window.pre_present_notify();
        frame.present();
    }
}

/// The scene pass writes premultiplied-style output (opaque pixels carry
/// their own alpha, transparent clear is all-zero), so prefer PreMultiplied
/// and fall back to PostMultiplied — at alpha 0 and 1 they agree. Public so
/// alternative shells (pocket-widget) configure transparent surfaces the
/// same way.
pub fn pick_alpha_mode(
    surface: &wgpu::Surface<'_>,
    adapter: &wgpu::Adapter,
) -> Result<wgpu::CompositeAlphaMode> {
    let caps = surface.get_capabilities(adapter);
    for want in [
        wgpu::CompositeAlphaMode::PreMultiplied,
        wgpu::CompositeAlphaMode::PostMultiplied,
        wgpu::CompositeAlphaMode::Inherit,
    ] {
        if caps.alpha_modes.contains(&want) {
            return Ok(want);
        }
    }
    anyhow::bail!(
        "transparent window requested but surface only supports {:?}",
        caps.alpha_modes
    )
}

fn set_mouse_capture(state: &mut WindowState, captured: bool) {
    if captured {
        let grabbed = state
            .window
            .set_cursor_grab(CursorGrabMode::Locked)
            .or_else(|_| state.window.set_cursor_grab(CursorGrabMode::Confined))
            .is_ok();
        state.window.set_cursor_visible(!grabbed);
        state.mouse_captured = grabbed;
    } else {
        let _ = state.window.set_cursor_grab(CursorGrabMode::None);
        state.window.set_cursor_visible(true);
        state.mouse_captured = false;
        state.input.clear();
    }
}

fn wants_capture(mode: CursorMode, legacy: bool) -> bool {
    match mode {
        CursorMode::Legacy => legacy,
        CursorMode::Captured => true,
        CursorMode::Visible => false,
    }
}

fn sync_cursor_mode(state: &mut WindowState, mode: CursorMode, legacy: bool) {
    if state.cursor_mode == mode {
        return;
    }
    state.cursor_mode = mode;
    state.input.clear();
    set_mouse_capture(state, state.focused && wants_capture(mode, legacy));
}

impl<G: Game> ApplicationHandler for WinitApp<G> {
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
                state.surface_config.width = size.width.max(1);
                state.surface_config.height = size.height.max(1);
                state
                    .surface
                    .configure(&state.gpu.device, &state.surface_config);
                self.game.resized(
                    (size.width.max(1), size.height.max(1)),
                    state.window.scale_factor(),
                );
            }
            WindowEvent::ScaleFactorChanged { scale_factor, .. } => {
                let size = state.window.inner_size();
                self.game
                    .resized((size.width.max(1), size.height.max(1)), scale_factor);
            }
            WindowEvent::KeyboardInput { .. } => {
                if state.cursor_mode == CursorMode::Legacy
                    && self.config.capture_mouse
                    && state.input.key_pressed(KeyCode::Escape)
                {
                    let captured = !state.mouse_captured;
                    set_mouse_capture(state, captured);
                }
            }
            WindowEvent::MouseInput {
                state: elem_state,
                button,
                ..
            } => {
                // Clicking back into the window recaptures the mouse.
                if state.focused
                    && wants_capture(state.cursor_mode, self.config.capture_mouse)
                    && !state.mouse_captured
                    && elem_state.is_pressed()
                {
                    set_mouse_capture(state, true);
                    if state.cursor_mode != CursorMode::Legacy {
                        state.input.clear();
                    }
                }
                if self.config.drag_window
                    && button == winit::event::MouseButton::Left
                    && elem_state.is_pressed()
                {
                    let _ = state.window.drag_window();
                }
            }
            WindowEvent::Focused(focused) => {
                state.focused = focused;
                if !focused {
                    set_mouse_capture(state, false);
                }
            }
            WindowEvent::RedrawRequested => self.redraw(event_loop),
            _ => {}
        }
    }

    fn device_event(
        &mut self,
        _event_loop: &ActiveEventLoop,
        _device_id: DeviceId,
        event: DeviceEvent,
    ) {
        if let Some(state) = self.state.as_mut()
            && state.mouse_captured
        {
            state.input.on_device_event(&event);
        }
    }

    fn about_to_wait(&mut self, event_loop: &ActiveEventLoop) {
        let Some(state) = &self.state else { return };
        let Some(max_fps) = self.config.max_fps else {
            state.window.request_redraw();
            return;
        };
        // Frame-paced mode: sleep until the next frame is due instead of
        // redrawing every time the loop wakes.
        let interval = Duration::from_secs_f32(1.0 / max_fps.max(1.0));
        let due = state.last_frame + interval;
        if Instant::now() >= due {
            state.window.request_redraw();
        } else {
            event_loop.set_control_flow(ControlFlow::WaitUntil(due));
        }
    }
}

#[cfg(test)]
mod cursor_tests {
    use super::*;
    #[test]
    fn explicit_pointer_ownership_overrides_legacy_capture_settings() {
        for legacy in [true, false] {
            assert!(!wants_capture(CursorMode::Visible, legacy));
            assert!(wants_capture(CursorMode::Captured, legacy));
            assert_eq!(wants_capture(CursorMode::Legacy, legacy), legacy);
        }
    }
}
