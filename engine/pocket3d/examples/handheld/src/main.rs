//! pocket-stage — a low-power 3D desktop stage that runs Pocket apps.
//!
//! The first pocket-widget runtime (docs/WIDGET.md): a transparent, undecorated,
//! always-on-top window framing an authored Stage package whose semantic
//! screen is a live PocketJS `ui` surface and whose controls feed real BTN
//! bits to an unmodified app bundle. The same bundle boots on hardware, in
//! uihost, on the Vita — and inside this widget, and cannot tell the
//! difference.
//!
//!   cargo run -p pocket-stage -- --app hero
//!   cargo run -p pocket-stage -- --app im --screenshot out.png --frames 30
//!
//! Interactions: click device controls, circular-drag a declared rotary wheel,
//! drag an analog nub, and two-finger scroll to orbit (or turn a hovered wheel).
//! Double-click the screen to animate to an exact-front focus view, then again
//! to restore the saved
//! desk orbit. Drag the body to move the window; Esc quits. The uihost keyboard
//! map works: arrows =
//! D-pad, Z/Enter = CROSS, X = CIRCLE, A = SQUARE, S = TRIANGLE, Q/W = L/R,
//! Tab = SELECT, Space = START, I/J/K/L = nub.
//!
//! Bundles/paks come from the PocketJS build (`bun tools/build.ts <app>`);
//! the widget looks in `<repo>/dist` (override: POCKETJS_DIST or --js/--pak).

mod device;

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};

use anyhow::{Context, Result, anyhow, ensure};
use glam::{Quat, Vec2, Vec3};
use pocket_mod::Guest;
use pocket_ui_wgpu::UiSurface;
use pocket_widget::embed::EmbeddedUi;
use pocket_widget::parts::{analog_pack, key_button};
use pocket_widget::shell::{WidgetConfig, WidgetGame};
use pocket3d::camera::Camera;
use pocket3d::gpu::{Gpu, OFFSCREEN_FORMAT, OffscreenTarget};
use pocket3d::hud::Hud;
use pocket3d::input::Input;
use pocket3d::renderer::Renderer;
use pocket3d::scene::Scene;
use winit::keyboard::KeyCode;

use device::Device;

/// Keys the widget polls for held state (the shared uihost map + I/J/K/L
/// as a keyboard nub).
const KEYS: [KeyCode; 14] = [
    KeyCode::ArrowUp,
    KeyCode::ArrowDown,
    KeyCode::ArrowLeft,
    KeyCode::ArrowRight,
    KeyCode::KeyZ,
    KeyCode::Enter,
    KeyCode::KeyX,
    KeyCode::Backspace,
    KeyCode::KeyA,
    KeyCode::KeyS,
    KeyCode::KeyQ,
    KeyCode::KeyW,
    KeyCode::Tab,
    KeyCode::Space,
];

/// Camera framings: "desk" shows the whole device; "focus" fills the window
/// with the screen (effectively uihost with a bezel). Double-click the
/// screen to toggle; the camera eases between them.
const ORBIT_YAW_LIMIT: f32 = 0.85;
const ORBIT_PITCH_LIMIT: f32 = 0.50;
const ORBIT_RADIANS_PER_LOGICAL_PIXEL: f32 = 0.006;
/// Enter the exact-front magnetic dead zone within two degrees. Once caught,
/// four degrees of raw intent are required to leave it, which prevents noisy
/// trackpad deltas from toggling the snap every tick.
const FRONT_SNAP_ENTER_RADIUS: f32 = 2.0 * std::f32::consts::PI / 180.0;
const FRONT_SNAP_EXIT_RADIUS: f32 = 4.0 * std::f32::consts::PI / 180.0;
/// Keep the interaction LOD briefly after the last scroll delta. This spans
/// gaps between macOS trackpad/momentum events, then restores one crisp frame.
const SCROLL_LOD_SETTLE_TICKS: u8 = 6;
/// Fallback boundary for mouse wheels that only report `TouchPhase::Moved`.
/// Touchpads normally provide exact Started/Ended markers through `Input`.
const ROTARY_SCROLL_SETTLE_TICKS: u8 = 6;
/// Framing ease duration in ticks (60 Hz).
const FRAMING_TICKS: f32 = 21.0;
/// Double-click window in ticks.
const DOUBLE_CLICK_TICKS: u64 = 21;
const ROTARY_SCROLL_STEP: f32 = 12.0;
const MAX_QUEUED_ROTARY_PULSES: usize = 24;
/// Unknown svc messages are dropped after every registered adapter had a
/// chance to select its namespace. Rate-limit diagnostics for a noisy guest.
const UNKNOWN_SVC_WARN_INTERVAL_TICKS: u64 = 300;

fn logical_pointer_delta(delta: Vec2, window_width: u32, logical_width: u32) -> Vec2 {
    delta * (logical_width as f32 / window_width.max(1) as f32)
}

fn clamp_orbit(orbit: Vec2) -> Vec2 {
    Vec2::new(
        orbit.x.clamp(-ORBIT_YAW_LIMIT, ORBIT_YAW_LIMIT),
        orbit.y.clamp(-ORBIT_PITCH_LIMIT, ORBIT_PITCH_LIMIT),
    )
}

fn orbit_after_delta(orbit: Vec2, logical_delta: Vec2) -> Vec2 {
    clamp_orbit(orbit + logical_delta * ORBIT_RADIANS_PER_LOGICAL_PIXEL)
}

fn smoothstep01(value: f32) -> f32 {
    let value = value.clamp(0.0, 1.0);
    value * value * (3.0 - 2.0 * value)
}

fn register_screen_click(last_click: &mut Option<u64>, tick: u64) -> bool {
    let is_double =
        last_click.is_some_and(|previous| tick.saturating_sub(previous) <= DOUBLE_CLICK_TICKS);
    *last_click = if is_double { None } else { Some(tick) };
    is_double
}

fn advance_framing_blend(blend: f32, focused: bool, dt: f32) -> f32 {
    let target = if focused { 1.0 } else { 0.0 };
    if blend == target {
        return blend;
    }
    let step = dt.max(0.0) * 60.0 / FRAMING_TICKS;
    if blend < target {
        (blend + step).min(target)
    } else {
        (blend - step).max(target)
    }
}

fn advance_scroll_orbit_ticks(current: u8, saw_scroll_delta: bool) -> u8 {
    if saw_scroll_delta {
        SCROLL_LOD_SETTLE_TICKS
    } else {
        current.saturating_sub(1)
    }
}

fn orbit_gesture_active(right_drag_active: bool, scroll_orbit_ticks: u8) -> bool {
    right_drag_active || scroll_orbit_ticks > 0
}

fn unknown_svc_warning_due(last_warning_tick: Option<u64>, tick: u64) -> bool {
    last_warning_tick
        .is_none_or(|last| tick.saturating_sub(last) >= UNKNOWN_SVC_WARN_INTERVAL_TICKS)
}

/// Pure orbit state. `raw` keeps accumulating input while the displayed orbit
/// is held at exact front, so the hysteresis dead zone is easy to enter but
/// still possible to leave with a deliberate gesture.
#[derive(Clone, Copy, Debug, PartialEq)]
struct OrbitState {
    raw: Vec2,
    front_snapped: bool,
}

impl OrbitState {
    fn new(orbit: Vec2) -> Self {
        let raw = clamp_orbit(orbit);
        Self {
            raw,
            front_snapped: raw.length_squared()
                <= FRONT_SNAP_ENTER_RADIUS * FRONT_SNAP_ENTER_RADIUS,
        }
    }

    fn visible(self) -> Vec2 {
        if self.front_snapped {
            Vec2::ZERO
        } else {
            self.raw
        }
    }

    /// Apply an absolute unsnapped orbit and report whether the camera changed.
    fn apply_raw(&mut self, raw: Vec2) -> bool {
        if !raw.is_finite() {
            return false;
        }
        let previous = self.visible();
        self.raw = clamp_orbit(raw);
        let distance_squared = self.raw.length_squared();
        if self.front_snapped {
            if distance_squared > FRONT_SNAP_EXIT_RADIUS * FRONT_SNAP_EXIT_RADIUS {
                self.front_snapped = false;
            }
        } else if distance_squared <= FRONT_SNAP_ENTER_RADIUS * FRONT_SNAP_ENTER_RADIUS {
            self.front_snapped = true;
        }
        self.visible() != previous
    }

    fn apply_delta(&mut self, logical_delta: Vec2) -> bool {
        self.apply_raw(orbit_after_delta(self.raw, logical_delta))
    }
}

/// Focus owns an exact snapshot of the desk orbit. Camera composition uses the
/// framing blend to animate that snapshot to exact front and back again.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
struct FocusOrbitState {
    focused: bool,
    pre_focus_orbit: Option<OrbitState>,
}

impl FocusOrbitState {
    fn enter(&mut self, orbit: &OrbitState) {
        if !self.focused {
            self.pre_focus_orbit = Some(*orbit);
            self.focused = true;
        }
    }

    fn exit(&mut self, orbit: &mut OrbitState) {
        if self.focused {
            if let Some(saved) = self.pre_focus_orbit.take() {
                *orbit = saved;
            }
            self.focused = false;
        }
    }

    fn toggle(&mut self, orbit: &mut OrbitState) {
        if self.focused {
            self.exit(orbit);
        } else {
            self.enter(orbit);
        }
    }

    fn displayed_orbit(self, orbit: OrbitState, framing_blend: f32) -> Vec2 {
        let desk_orbit = self.pre_focus_orbit.unwrap_or(orbit).visible();
        if framing_blend <= 0.0 {
            desk_orbit
        } else if framing_blend >= 1.0 {
            Vec2::ZERO
        } else {
            desk_orbit * (1.0 - smoothstep01(framing_blend))
        }
    }

    fn orbit_input_enabled(self, framing_blend: f32) -> bool {
        !self.focused && framing_blend <= 0.0
    }
}

fn apply_screen_click(
    last_click: &mut Option<u64>,
    tick: u64,
    focus: &mut FocusOrbitState,
    orbit: &mut OrbitState,
) -> bool {
    if !register_screen_click(last_click, tick) {
        return false;
    }
    focus.toggle(orbit);
    true
}

/// BTN pulses generated by detented controls. A neutral tick is inserted
/// between values so the guest's standard edge detector observes every step,
/// even when a fast circular gesture queues several of them at once.
#[derive(Debug, Default)]
struct ButtonPulseQueue {
    pending: VecDeque<u32>,
    release_tick: bool,
}

impl ButtonPulseQueue {
    fn push(&mut self, buttons: u32) {
        if buttons != 0 && self.pending.len() < MAX_QUEUED_ROTARY_PULSES {
            self.pending.push_back(buttons);
        }
    }

    fn next_mask(&mut self) -> u32 {
        if self.release_tick {
            self.release_tick = false;
            return 0;
        }
        let Some(buttons) = self.pending.pop_front() else {
            return 0;
        };
        self.release_tick = true;
        buttons
    }

    fn clear(&mut self) {
        self.pending.clear();
        self.release_tick = false;
    }
}

#[derive(Clone, Copy, Debug)]
struct RotaryGesture {
    start_angle: f32,
    last_angle: Option<f32>,
    accumulated: f32,
    moved: bool,
    tap_eligible: bool,
}

impl RotaryGesture {
    fn new(angle: f32) -> Self {
        Self {
            start_angle: angle,
            last_angle: Some(angle),
            accumulated: 0.0,
            moved: false,
            tap_eligible: true,
        }
    }

    fn update(
        &mut self,
        angle: Option<f32>,
        step: f32,
        clockwise: u32,
        counterclockwise: u32,
        pulses: &mut ButtonPulseQueue,
    ) {
        let Some(angle) = angle else {
            // The pointer entered the hub/outside the authored wheel. Break
            // angular continuity so crossing the center cannot synthesize a
            // half-turn, and do not bridge partial detents across the gap.
            self.last_angle = None;
            self.accumulated = 0.0;
            self.tap_eligible = false;
            return;
        };
        let Some(previous) = self.last_angle.replace(angle) else {
            // Re-entering the valid ring establishes a fresh anchor. Motion
            // begins with the next valid sample, without a jump.
            return;
        };
        self.accumulated += device::angular_delta(angle, previous);
        while self.accumulated >= step {
            pulses.push(counterclockwise);
            self.accumulated -= step;
            self.moved = true;
        }
        while self.accumulated <= -step {
            pulses.push(clockwise);
            self.accumulated += step;
            self.moved = true;
        }
    }
}

fn rotary_tap(
    grab: RotaryGesture,
    release_angle: Option<f32>,
    rotary: &device::RotaryControl,
    interaction_cancelled: bool,
) -> Option<(String, u32)> {
    if interaction_cancelled || grab.moved || !grab.tap_eligible {
        return None;
    }
    let start = rotary.sector_at(grab.start_angle)?;
    let release = rotary.sector_at(release_angle?)?;
    (start.name == release.name).then(|| (start.name.clone(), start.buttons))
}

#[derive(Debug, Default)]
struct RotaryScrollState {
    remainder: f32,
    settle_ticks: u8,
}

impl RotaryScrollState {
    fn reset(&mut self) {
        self.remainder = 0.0;
        self.settle_ticks = 0;
    }

    #[allow(clippy::too_many_arguments)]
    fn update(
        &mut self,
        over_ring: bool,
        delta: Vec2,
        gesture_started: bool,
        gesture_ended: bool,
        clockwise: u32,
        counterclockwise: u32,
        pulses: &mut ButtonPulseQueue,
    ) -> bool {
        if gesture_started {
            self.reset();
        }
        if !over_ring {
            self.reset();
            return false;
        }

        let saw_delta = delta.is_finite() && delta != Vec2::ZERO;
        if saw_delta {
            self.settle_ticks = ROTARY_SCROLL_SETTLE_TICKS;
            self.remainder += delta.y;
            while self.remainder >= ROTARY_SCROLL_STEP {
                pulses.push(clockwise);
                self.remainder -= ROTARY_SCROLL_STEP;
            }
            while self.remainder <= -ROTARY_SCROLL_STEP {
                pulses.push(counterclockwise);
                self.remainder += ROTARY_SCROLL_STEP;
            }
        } else {
            self.settle_ticks = self.settle_ticks.saturating_sub(1);
            if self.settle_ticks == 0 {
                self.remainder = 0.0;
            }
        }

        if gesture_ended {
            self.reset();
        }
        saw_delta
    }
}

struct StageGame {
    // Boot state (pre-GPU) — consumed by init.
    boot_surface: Option<UiSurface>,
    guest: Guest,
    profile_path: PathBuf,
    settings: device::StageSettings,
    last_unknown_svc_warning_tick: Option<u64>,

    embedded: Option<EmbeddedUi>,
    dev: Option<Device>,
    scene: Scene,
    camera: Camera,
    hud: Hud,

    window_px: (u32, u32),
    ticks: u64,
    /// Part index held by the mouse (its BTN bits stay down until release).
    mouse_part: Option<usize>,
    /// Last ray-picked part, retained for headless acceptance assertions.
    last_pressed_part: Option<String>,
    /// Cursor position where the nub was grabbed.
    nub_grab: Option<Vec2>,
    /// Nub deflection, −1..1 per axis (x right, y down).
    nub: Vec2,
    /// Captured click-wheel gesture. A tap becomes its angular sector's BTN;
    /// a circular drag becomes a detented UP/DOWN pulse stream.
    rotary_grab: Option<RotaryGesture>,
    rotary_scroll: RotaryScrollState,
    pulses: ButtonPulseQueue,
    /// Camera orbit plus exact-front magnetic snap state.
    orbit: OrbitState,
    /// Cursor + raw angle snapshot at the start of a right-drag.
    orbit_grab: Option<(Vec2, Vec2)>,
    /// Ticks remaining before a completed wheel/trackpad gesture returns to
    /// the settled visual LOD.
    scroll_orbit_ticks: u8,
    /// Desk/focus state plus the exact orbit snapshot restored on exit.
    focus: FocusOrbitState,
    blend: f32,
    last_screen_click: Option<u64>,
    /// Extra BTN bits held for the whole run (headless --hold).
    hold_mask: u32,
    /// Exit after this many ticks (--auto-quit smoke tests).
    quit_after: Option<u64>,
    dirty: bool,
    exit: bool,
}

impl StageGame {
    fn new(
        guest: Guest,
        surface: UiSurface,
        hold_mask: u32,
        profile_path: PathBuf,
        settings: device::StageSettings,
    ) -> Self {
        let initial_window = settings.window_size;
        let scene = Scene {
            transparent_clear: true,
            ..Default::default()
        };
        let mut camera = Camera {
            pos: settings.view.desk_position,
            fov_y: settings.view.fov_y,
            znear: 10.0,
            zfar: 2000.0,
            ..Default::default()
        };
        camera.look_at(settings.view.desk_target);
        Self {
            boot_surface: Some(surface),
            guest,
            profile_path,
            settings,
            last_unknown_svc_warning_tick: None,
            embedded: None,
            dev: None,
            scene,
            camera,
            hud: Hud::default(),
            window_px: initial_window,
            ticks: 0,
            mouse_part: None,
            last_pressed_part: None,
            nub_grab: None,
            nub: Vec2::ZERO,
            rotary_grab: None,
            rotary_scroll: RotaryScrollState::default(),
            pulses: ButtonPulseQueue::default(),
            orbit: OrbitState::new(Vec2::ZERO),
            orbit_grab: None,
            scroll_orbit_ticks: 0,
            focus: FocusOrbitState::default(),
            blend: 0.0,
            last_screen_click: None,
            hold_mask,
            quit_after: None,
            dirty: true,
            exit: false,
        }
    }

    fn pick(&self, cursor: Vec2) -> Option<usize> {
        let dev = self.dev.as_ref()?;
        let (origin, dir) = self
            .camera
            .screen_ray(cursor, (self.window_px.0 as f32, self.window_px.1 as f32));
        dev.map.pick(origin, dir).map(|(i, _)| i)
    }

    fn rotary_angle(&self, cursor: Vec2, require_ring: bool) -> Option<f32> {
        let dev = self.dev.as_ref()?;
        let rotary = dev.rotary.as_ref()?;
        let (origin, dir) = self
            .camera
            .screen_ray(cursor, (self.window_px.0 as f32, self.window_px.1 as f32));
        rotary.angle_from_ray(origin, dir, require_ring)
    }

    fn cancel_pointer_gestures(&mut self) {
        let had_active_gesture = self.mouse_part.is_some()
            || self.nub_grab.is_some()
            || self.rotary_grab.is_some()
            || self.orbit_grab.is_some();
        self.mouse_part = None;
        self.nub_grab = None;
        self.nub = Vec2::ZERO;
        self.rotary_grab = None;
        self.rotary_scroll.reset();
        self.pulses.clear();
        self.orbit_grab = None;
        self.scroll_orbit_ticks = 0;
        self.last_screen_click = None;
        if had_active_gesture {
            self.dirty = true;
        }
    }
}

impl WidgetGame for StageGame {
    fn init(&mut self, gpu: &Gpu, renderer: &mut Renderer) -> Result<()> {
        let surface = self.boot_surface.take().expect("init runs once");
        let embedded = EmbeddedUi::new_with_scale(
            gpu,
            surface,
            self.settings.physical_size,
            self.settings.raster_density as f32,
        );
        self.dev = Some(device::build(
            gpu,
            renderer,
            &mut self.scene,
            embedded.view(),
            &self.profile_path,
        )?);
        self.embedded = Some(embedded);
        Ok(())
    }

    fn tick(&mut self, dt: f32, input: &Input, window_px: (u32, u32)) -> Result<()> {
        self.window_px = window_px;
        let interaction_cancelled = input.interaction_cancelled();
        if interaction_cancelled {
            // Focus loss/reset is a cancellation, never an intentional mouse
            // release. In particular it must not commit a click-wheel sector.
            self.cancel_pointer_gestures();
        }
        if input.key_pressed(KeyCode::Escape)
            || self.quit_after.is_some_and(|limit| self.ticks >= limit)
        {
            self.exit = true;
        }

        // --- keyboard: held BTN bits + I/J/K/L nub ------------------------
        let mut buttons = self.hold_mask;
        for code in KEYS {
            if input.key_down(code)
                && let Some(bit) = key_button(code)
            {
                buttons |= bit;
            }
        }
        let key_axis = |neg: KeyCode, pos: KeyCode| {
            (input.key_down(pos) as i32 - input.key_down(neg) as i32) as f32
        };
        let key_nub = Vec2::new(
            key_axis(KeyCode::KeyJ, KeyCode::KeyL),
            key_axis(KeyCode::KeyI, KeyCode::KeyK),
        );

        // --- mouse: press, rotary drag, nub drag --------------------------
        let cursor = input.cursor();
        if let Some(c) = cursor {
            if input.mouse_button_pressed(winit::event::MouseButton::Left) {
                if let Some(angle) = self.rotary_angle(c, true) {
                    let name = self
                        .dev
                        .as_ref()
                        .and_then(|dev| dev.rotary.as_ref())
                        .map(|rotary| rotary.name.clone())
                        .unwrap_or_else(|| "rotary".into());
                    self.last_pressed_part = Some(name.clone());
                    self.rotary_grab = Some(RotaryGesture::new(angle));
                    log::debug!("press at {c:?}: {name}");
                } else {
                    let hit = self.pick(c).map(|i| {
                        let p = &self.dev.as_ref().unwrap().parts[i];
                        (i, p.name.clone(), p.buttons)
                    });
                    self.last_pressed_part = hit.as_ref().map(|(_, name, _)| name.clone());
                    log::debug!(
                        "press at {c:?}: {}",
                        hit.as_ref().map_or("nothing", |(_, name, _)| name.as_str())
                    );
                    match hit {
                        Some((i, name, _)) if name == "nub" => {
                            let _ = i;
                            self.nub_grab = Some(c);
                        }
                        Some((_, name, _)) if name == "screen" => {
                            if apply_screen_click(
                                &mut self.last_screen_click,
                                self.ticks,
                                &mut self.focus,
                                &mut self.orbit,
                            ) {
                                // A framing mode switch consumes any in-flight
                                // orbit gesture. Focus remains exactly front and
                                // exit restores the untouched desk snapshot.
                                self.orbit_grab = None;
                                self.scroll_orbit_ticks = 0;
                                self.dirty = true;
                            }
                        }
                        Some((i, _, bits)) if bits != 0 => {
                            self.mouse_part = Some(i);
                        }
                        _ => {}
                    }
                }
            }
            if self.focus.orbit_input_enabled(self.blend)
                && input.mouse_button_pressed(winit::event::MouseButton::Right)
            {
                self.orbit_grab = Some((c, self.orbit.raw));
            }
            if let Some((grab_cursor, grab_orbit)) = self.orbit_grab {
                let delta = logical_pointer_delta(
                    c - grab_cursor,
                    self.window_px.0,
                    self.settings.window_size.0,
                );
                let raw = orbit_after_delta(grab_orbit, delta);
                if self.orbit.apply_raw(raw) {
                    self.dirty = true;
                }
            }
            if let Some(grab) = self.nub_grab {
                // Full tilt at 30 logical px of drag (scaled to physical).
                let full = 30.0 * self.window_px.0 as f32 / self.settings.window_size.0 as f32;
                let mut v = (c - grab) / full;
                if v.length() > 1.0 {
                    v = v.normalize();
                }
                if v != self.nub {
                    self.nub = v;
                    self.dirty = true;
                }
            }
        }
        if self.rotary_grab.is_some() {
            // Every sample after capture must remain in the authored annulus.
            // An invalid sample suspends/re-anchors the gesture rather than
            // computing an angle through the wheel's singular center.
            let angle = cursor.and_then(|position| self.rotary_angle(position, true));
            if let Some((step, clockwise, counterclockwise)) = self
                .dev
                .as_ref()
                .and_then(|dev| dev.rotary.as_ref())
                .map(|rotary| {
                    (
                        rotary.step_radians,
                        rotary.clockwise_buttons,
                        rotary.counterclockwise_buttons,
                    )
                })
                && let Some(grab) = self.rotary_grab.as_mut()
            {
                grab.update(angle, step, clockwise, counterclockwise, &mut self.pulses);
            }
        }

        // macOS delivers a two-finger trackpad gesture as precise, two-axis
        // MouseWheel pixel deltas. Discrete wheels use the same path after the
        // input layer normalizes line steps to pixel-like units. It does not
        // require a cursor position, so the gesture remains reliable across a
        // CursorLeft event at the window edge.
        let scroll = logical_pointer_delta(
            input.scroll(),
            self.window_px.0,
            self.settings.window_size.0,
        );
        let scroll_over_rotary = cursor
            .and_then(|position| self.rotary_angle(position, true))
            .is_some();
        let rotary_scroll_consumed = self
            .dev
            .as_ref()
            .and_then(|dev| dev.rotary.as_ref())
            .map(|rotary| (rotary.clockwise_buttons, rotary.counterclockwise_buttons))
            .is_some_and(|(clockwise, counterclockwise)| {
                self.rotary_scroll.update(
                    scroll_over_rotary,
                    scroll,
                    input.scroll_gesture_started(),
                    input.scroll_gesture_ended(),
                    clockwise,
                    counterclockwise,
                    &mut self.pulses,
                )
            });
        let saw_scroll_delta = !rotary_scroll_consumed
            && self.focus.orbit_input_enabled(self.blend)
            && self.orbit_grab.is_none()
            && scroll.is_finite()
            && scroll != Vec2::ZERO;
        self.scroll_orbit_ticks =
            advance_scroll_orbit_ticks(self.scroll_orbit_ticks, saw_scroll_delta);
        if saw_scroll_delta && self.orbit.apply_delta(scroll) {
            self.dirty = true;
        }
        if !input.mouse_button_down(winit::event::MouseButton::Left) {
            let release_angle = cursor.and_then(|position| self.rotary_angle(position, true));
            if let Some(grab) = self.rotary_grab.take()
                && let Some(rotary) = self.dev.as_ref().and_then(|dev| dev.rotary.as_ref())
                && let Some((name, buttons)) =
                    rotary_tap(grab, release_angle, rotary, interaction_cancelled)
            {
                self.last_pressed_part = Some(name);
                self.pulses.push(buttons);
            }
            if self.mouse_part.take().is_some() {
                self.dirty = true;
            }
            if self.nub_grab.take().is_some() {
                self.nub = Vec2::ZERO;
                self.dirty = true;
            }
        }
        if !input.mouse_button_down(winit::event::MouseButton::Right) {
            self.orbit_grab.take();
        }
        let orbiting = orbit_gesture_active(self.orbit_grab.is_some(), self.scroll_orbit_ticks);
        if self
            .dev
            .as_mut()
            .is_some_and(|dev| dev.set_orbit_lod(&mut self.scene, orbiting))
        {
            self.dirty = true;
        }
        if let Some(i) = self.mouse_part {
            buttons |= self.dev.as_ref().unwrap().parts[i].buttons;
        }
        buttons |= self.pulses.next_mask();

        // --- the guest turn (Law 3: exactly one per tick) ------------------
        let nub = if self.nub_grab.is_some() {
            self.nub
        } else {
            key_nub
        };
        let analog = analog_pack(nub.x, nub.y);
        self.guest.frame_with_analog(buttons, analog)?;
        if let Some(embedded) = self.embedded.as_mut()
            && embedded.tick()
        {
            self.dirty = true;
        }
        if let Some(embedded) = self.embedded.as_ref() {
            let surface = embedded.surface();
            // Stage packages register no svc adapters; a future adapter
            // selects its namespace with `svc_drain_matching` before this
            // drain. Dropping here bounds a malformed or noisy guest.
            let unknown = surface.svc_drain();
            if !unknown.is_empty()
                && unknown_svc_warning_due(self.last_unknown_svc_warning_tick, self.ticks)
            {
                log::warn!(
                    "pocket-stage: dropped {} unhandled guest svc message(s)",
                    unknown.len()
                );
                self.last_unknown_svc_warning_tick = Some(self.ticks);
            }
        }

        // --- camera framing ease ------------------------------------------
        let next_blend = advance_framing_blend(self.blend, self.focus.focused, dt);
        if next_blend != self.blend {
            self.blend = next_blend;
            self.dirty = true;
        }

        self.ticks += 1;
        Ok(())
    }

    fn take_dirty(&mut self) -> bool {
        std::mem::take(&mut self.dirty)
    }

    fn prepare(&mut self, gpu: &Gpu) -> Result<()> {
        if let Some(embedded) = self.embedded.as_mut() {
            embedded.render_if_dirty(gpu)?;
        }
        Ok(())
    }

    fn compose(&mut self, time: f32, _size: (u32, u32)) -> (&Scene, &Camera, &Hud) {
        let t = smoothstep01(self.blend);
        // Before the device package finishes loading there is nothing to
        // frame; the origin keeps the camera math finite until init.
        let screen_center = self
            .dev
            .as_ref()
            .map(|dev| dev.screen_center)
            .unwrap_or(Vec3::ZERO);
        let focus_pos = screen_center + Vec3::Z * self.settings.view.focus_distance;
        let target = self.settings.view.desk_target.lerp(screen_center, t);
        let base_pos = self.settings.view.desk_position.lerp(focus_pos, t);
        let displayed_orbit = self.focus.displayed_orbit(self.orbit, self.blend);
        let rotation =
            Quat::from_rotation_y(displayed_orbit.x) * Quat::from_rotation_x(displayed_orbit.y);
        self.camera.pos = target + rotation * (base_pos - target);
        self.camera.look_at(target);
        self.scene.time = time;
        (&self.scene, &self.camera, &self.hud)
    }

    fn drag_at(&mut self, cursor: Vec2) -> bool {
        // Dragging anything inert moves the window — the pocket-character
        // "drag anywhere" feel, minus the interactive parts.
        if self.rotary_angle(cursor, true).is_some() {
            return false;
        }
        match self.pick(cursor) {
            None => true,
            Some(i) => {
                let p = &self.dev.as_ref().unwrap().parts[i];
                p.buttons == 0 && !matches!(p.name.as_str(), "nub" | "screen")
            }
        }
    }

    fn wants_exit(&self) -> bool {
        self.exit || SIGNAL_EXIT.load(Ordering::Relaxed)
    }
}

/// Terminal signals exit through the event loop so every Drop runs.
static SIGNAL_EXIT: AtomicBool = AtomicBool::new(false);

extern "C" fn request_exit_on_signal(_signal: libc::c_int) {
    SIGNAL_EXIT.store(true, Ordering::Relaxed);
}

fn install_signal_handlers() {
    let handler = request_exit_on_signal as extern "C" fn(libc::c_int) as *const ()
        as libc::sighandler_t;
    // SAFETY: the handler only stores to a static atomic, which is
    // async-signal-safe; registration happens before any thread observes it.
    unsafe {
        libc::signal(libc::SIGINT, handler);
        libc::signal(libc::SIGTERM, handler);
    }
}

// ---------------------------------------------------------------------------
// boot + CLI
// ---------------------------------------------------------------------------

struct Args {
    app: String,
    js: Option<PathBuf>,
    pak: Option<PathBuf>,
    screenshot: Option<PathBuf>,
    frames: u32,
    hold: u32,
    /// Headless: click this window pixel (press mid-run, release at 2/3).
    click: Option<(f32, f32)>,
    /// Headless: drag from x0,y0 to x1,y1 over the middle third.
    drag: Option<(Vec2, Vec2)>,
    /// Headless: fail unless the scripted cursor press ray-picks this part.
    expect_hit: Option<String>,
    /// Headless: fail unless the final PocketJS DrawList has this hash.
    expect_ui_hash: Option<u64>,
    /// Headless: (BTN bits, frame) taps — held for 6 ticks from that frame.
    taps: Vec<(u32, u32)>,
    /// Start in the screen-filling focus framing.
    focus: bool,
    /// Windowed smoke test: quit after this many seconds.
    auto_quit: Option<f32>,
    /// Authored shell profile. Model-specific data stays outside the runtime.
    profile: PathBuf,
    /// Initial camera yaw,pitch in degrees (headless QA and saved framings).
    orbit: Vec2,
    /// Active render cap; guest ticks remain 60 Hz.
    max_fps: f32,
}

fn parse_args() -> Result<Args> {
    let mut args = Args {
        app: "hero-main".into(),
        js: None,
        pak: None,
        screenshot: None,
        frames: 30,
        hold: 0,
        click: None,
        drag: None,
        expect_hit: None,
        expect_ui_hash: None,
        taps: Vec::new(),
        focus: false,
        auto_quit: None,
        profile: device::default_profile_path(),
        orbit: Vec2::ZERO,
        max_fps: 60.0,
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
            "--hold" => {
                for name in val("--hold")?.split(',') {
                    args.hold |= hold_bit(name)?;
                }
            }
            "--click" => {
                let v = val("--click")?;
                let (x, y) = v
                    .split_once(',')
                    .ok_or_else(|| anyhow!("--click wants x,y"))?;
                args.click = Some((x.trim().parse()?, y.trim().parse()?));
            }
            "--drag" => {
                let value = val("--drag")?;
                let values = value
                    .split(',')
                    .map(str::trim)
                    .map(str::parse::<f32>)
                    .collect::<std::result::Result<Vec<_>, _>>()?;
                ensure!(values.len() == 4, "--drag wants x0,y0,x1,y1");
                args.drag = Some((
                    Vec2::new(values[0], values[1]),
                    Vec2::new(values[2], values[3]),
                ));
            }
            "--expect-hit" => args.expect_hit = Some(val("--expect-hit")?),
            "--expect-ui-hash" => {
                let value = val("--expect-ui-hash")?;
                let digits = value.strip_prefix("0x").unwrap_or(&value);
                args.expect_ui_hash = Some(u64::from_str_radix(digits, 16)?);
            }
            "--tap" => {
                let v = val("--tap")?;
                let (name, frame) = v
                    .split_once('@')
                    .ok_or_else(|| anyhow!("--tap wants name@frame"))?;
                args.taps.push((hold_bit(name)?, frame.parse()?));
            }
            "--focus" => args.focus = true,
            "--auto-quit" => args.auto_quit = Some(val("--auto-quit")?.parse()?),
            "--profile" => args.profile = PathBuf::from(val("--profile")?),
            "--orbit" => {
                let value = val("--orbit")?;
                let (yaw, pitch) = value
                    .split_once(',')
                    .ok_or_else(|| anyhow!("--orbit wants yaw,pitch in degrees"))?;
                args.orbit = Vec2::new(yaw.trim().parse()?, pitch.trim().parse()?);
            }
            "--max-fps" => args.max_fps = val("--max-fps")?.parse()?,
            other => return Err(anyhow!("unknown flag {other}")),
        }
    }
    Ok(args)
}

fn hold_bit(name: &str) -> Result<u32> {
    device::button_bits(Some(name))
}

/// The headless composite renders at 2×. A profile with an absurd window size
/// must fail with this diagnostic instead of an arithmetic overflow.
fn headless_frame_size(window_size: (u32, u32)) -> Result<(u32, u32)> {
    let double = |side: u32, axis: &str| {
        side.checked_mul(2)
            .ok_or_else(|| anyhow!("window {axis} overflows the 2x headless frame"))
    };
    Ok((
        double(window_size.0, "width")?,
        double(window_size.1, "height")?,
    ))
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

/// Boot the guest: feed the pak, mount `ui`, eval the bundle.
fn boot(args: &Args, settings: &device::StageSettings) -> Result<(Guest, UiSurface)> {
    let js_path = resolve_asset(args.js.clone(), &args.app, "js")?;
    let pak_path = resolve_asset(args.pak.clone(), &args.app, "pak")?;
    let bundle = std::fs::read_to_string(&js_path)
        .with_context(|| format!("reading {}", js_path.display()))?;
    let pak =
        std::fs::read(&pak_path).with_context(|| format!("reading {}", pak_path.display()))?;

    let surface = UiSurface::new_with_density(
        (
            settings.logical_size.0 as f32,
            settings.logical_size.1 as f32,
        ),
        settings.raster_density,
    );
    // tools/widget.ts resolves plan-built guests against this custom-host
    // profile. The outer OS window is widget-shaped; the mounted screen is a
    // fixed embedded target (contracts/spec/platforms.ts), so macos-widget is wrong.
    surface.set_identity("macos-embedded", 3);
    surface.feed_pak(&pak);
    let guest = Guest::new()?;
    surface.mount(&guest)?;
    guest.eval(&args.app, &bundle)?;
    if !guest.has_frame() {
        return Err(anyhow!(
            "bundle evaluated but installed no frame() — is this a PocketJS app?"
        ));
    }
    log::info!(
        "pocket-stage: booted {} ({} bytes js, {} bytes pak)",
        args.app,
        bundle.len(),
        pak.len()
    );
    Ok((guest, surface))
}

fn main() -> Result<()> {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    install_signal_handlers();
    let args = parse_args()?;
    let settings = device::load_settings(&args.profile)?;
    if !(1.0..=240.0).contains(&args.max_fps) {
        return Err(anyhow!("--max-fps must be between 1 and 240"));
    }
    ensure!(args.frames > 0, "--frames must be positive");
    ensure!(
        args.orbit.is_finite()
            && args.orbit.x.to_radians().abs() <= ORBIT_YAW_LIMIT
            && args.orbit.y.to_radians().abs() <= ORBIT_PITCH_LIMIT,
        "--orbit must be finite and within yaw ±{:.1}°, pitch ±{:.1}°",
        ORBIT_YAW_LIMIT.to_degrees(),
        ORBIT_PITCH_LIMIT.to_degrees()
    );
    if let Some(seconds) = args.auto_quit {
        ensure!(
            seconds.is_finite() && seconds > 0.0,
            "--auto-quit must be a positive finite number"
        );
    }
    if let Some((x, y)) = args.click {
        let headless_size = headless_frame_size(settings.window_size)?;
        ensure!(
            x.is_finite()
                && y.is_finite()
                && (0.0..headless_size.0 as f32).contains(&x)
                && (0.0..headless_size.1 as f32).contains(&y),
            "--click must be a finite pixel inside the {}x{} headless frame",
            headless_size.0,
            headless_size.1,
        );
    }
    ensure!(
        args.click.is_none() || args.drag.is_none(),
        "--click and --drag are mutually exclusive"
    );
    if let Some((from, to)) = args.drag {
        let frame = headless_frame_size(settings.window_size)?;
        let headless_size = Vec2::new(frame.0 as f32, frame.1 as f32);
        ensure!(
            from.is_finite()
                && to.is_finite()
                && from.cmpge(Vec2::ZERO).all()
                && to.cmpge(Vec2::ZERO).all()
                && from.cmplt(headless_size).all()
                && to.cmplt(headless_size).all(),
            "--drag endpoints must be inside the headless frame"
        );
    }
    if args.expect_hit.is_some() {
        ensure!(
            args.screenshot.is_some() && (args.click.is_some() || args.drag.is_some()),
            "--expect-hit requires --screenshot and --click/--drag"
        );
    }
    if args.expect_ui_hash.is_some() {
        ensure!(
            args.screenshot.is_some(),
            "--expect-ui-hash requires --screenshot"
        );
    }
    let (guest, surface) = boot(&args, &settings)?;
    let mut game = StageGame::new(
        guest,
        surface,
        args.hold,
        args.profile.clone(),
        settings.clone(),
    );
    game.orbit = OrbitState::new(args.orbit.map(f32::to_radians));
    game.quit_after = args.auto_quit.map(|s| (s * 60.0) as u64);
    if args.focus {
        game.focus.enter(&game.orbit);
        game.blend = 1.0;
    }
    if let Some(out) = args.screenshot.clone() {
        headless(game, &args, &out)
    } else {
        pocket_widget::run(
            WidgetConfig {
                title: "Pocket Stage".into(),
                size: settings.window_size,
                max_fps: args.max_fps,
                ..Default::default()
            },
            game,
        )
    }
}

/// Headless: N fixed ticks, then one composite PNG at 2× (its alpha channel
/// is the actual window transparency). `--click x,y` scripts a cursor press
/// on that pixel for the middle third of the run — the full pick → part →
/// BTN → guest path, no window required.
fn headless(mut game: StageGame, args: &Args, out: &std::path::Path) -> Result<()> {
    let (w, h) = headless_frame_size(game.settings.window_size)?;
    let gpu = Gpu::new_headless()?;
    let mut renderer = Renderer::new(&gpu, OFFSCREEN_FORMAT)?;
    game.init(&gpu, &mut renderer)?;

    let mut input = Input::default();
    let base_hold = args.hold;
    let (press_at, release_at) = (args.frames / 3, args.frames * 2 / 3);
    for frame in 0..args.frames {
        if SIGNAL_EXIT.load(Ordering::Relaxed) {
            return Err(anyhow!("interrupted before the acceptance run finished"));
        }
        game.hold_mask = base_hold
            | args
                .taps
                .iter()
                .filter(|&&(_, at)| (at..at + 6).contains(&frame))
                .fold(0, |acc, &(bits, _)| acc | bits);
        if let Some((x, y)) = args.click {
            input.inject_cursor(x, y);
            if frame == press_at {
                input.inject_mouse_button(winit::event::MouseButton::Left, true);
            }
            if frame == release_at {
                input.inject_mouse_button(winit::event::MouseButton::Left, false);
            }
        }
        if let Some((from, to)) = args.drag {
            let span = release_at.saturating_sub(press_at).max(1);
            let progress = frame.saturating_sub(press_at).min(span) as f32 / span as f32;
            let cursor = from.lerp(to, progress);
            input.inject_cursor(cursor.x, cursor.y);
            if frame == press_at {
                input.inject_mouse_button(winit::event::MouseButton::Left, true);
            }
            if frame == release_at {
                input.inject_mouse_button(winit::event::MouseButton::Left, false);
            }
        }
        game.tick(1.0 / 60.0, &input, (w, h))?;
        input.end_frame();
    }
    if let Some(expected) = args.expect_hit.as_deref() {
        ensure!(
            game.last_pressed_part.as_deref() == Some(expected),
            "expected cursor ray to hit {expected:?}, hit {:?}",
            game.last_pressed_part.as_deref().unwrap_or("nothing")
        );
    }
    let ui_hash = game
        .embedded
        .as_ref()
        .expect("headless game initialized its embedded UI")
        .content_hash();
    if let Some(expected) = args.expect_ui_hash {
        ensure!(
            ui_hash == expected,
            "expected UI DrawList hash {expected:#018x}, got {ui_hash:#018x}"
        );
    }
    game.take_dirty();
    game.prepare(&gpu)?;
    let target = OffscreenTarget::new(&gpu, w, h);
    let (scene, camera, hud) = game.compose(args.frames as f32 / 60.0, (w, h));
    renderer.render(&gpu, &target.view, (w, h), scene, camera, hud);
    target.save_png(&gpu, out)?;
    println!(
        "pocket-stage: wrote {} after {} frames (app {}, hold {:#06x}, ui hash {ui_hash:#018x})",
        out.display(),
        args.frames,
        args.app,
        args.hold
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use pocket_widget::parts::btn;

    #[test]
    fn pointer_deltas_are_density_independent() {
        assert_eq!(
            logical_pointer_delta(Vec2::new(20.0, -12.0), 960, 480),
            Vec2::new(10.0, -6.0)
        );
        assert_eq!(
            logical_pointer_delta(Vec2::new(10.0, -6.0), 480, 480),
            Vec2::new(10.0, -6.0)
        );
    }

    #[test]
    fn rotary_pulses_always_insert_a_neutral_guest_tick() {
        let mut pulses = ButtonPulseQueue::default();
        pulses.push(btn::DOWN);
        pulses.push(btn::DOWN);
        assert_eq!(pulses.next_mask(), btn::DOWN);
        assert_eq!(pulses.next_mask(), 0);
        assert_eq!(pulses.next_mask(), btn::DOWN);
        assert_eq!(pulses.next_mask(), 0);
        assert_eq!(pulses.next_mask(), 0);
    }

    #[test]
    fn rotary_gesture_unwraps_pi_and_emits_detents() {
        let mut gesture = RotaryGesture::new(170.0_f32.to_radians());
        let mut pulses = ButtonPulseQueue::default();
        gesture.update(
            Some((-170.0_f32).to_radians()),
            12.0_f32.to_radians(),
            btn::DOWN,
            btn::UP,
            &mut pulses,
        );
        assert!(gesture.moved);
        assert_eq!(pulses.next_mask(), btn::UP);
        assert_eq!(pulses.next_mask(), 0);
    }

    fn test_rotary() -> device::RotaryControl {
        device::RotaryControl {
            name: "wheel".into(),
            center: Vec3::ZERO,
            inner_radius: 5.0,
            outer_radius: 20.0,
            step_radians: 12.0_f32.to_radians(),
            clockwise_buttons: btn::DOWN,
            counterclockwise_buttons: btn::UP,
            sectors: vec![device::RotarySector {
                name: "menu".into(),
                center_radians: 0.0,
                half_width_radians: 30.0_f32.to_radians(),
                buttons: btn::LEFT,
            }],
        }
    }

    #[test]
    fn rotary_center_crossing_suspends_and_reanchors_without_fake_detents() {
        let mut gesture = RotaryGesture::new(0.0);
        let mut pulses = ButtonPulseQueue::default();
        let step = 12.0_f32.to_radians();

        gesture.update(
            Some(5.0_f32.to_radians()),
            step,
            btn::DOWN,
            btn::UP,
            &mut pulses,
        );
        gesture.update(None, step, btn::DOWN, btn::UP, &mut pulses);
        gesture.update(
            Some(175.0_f32.to_radians()),
            step,
            btn::DOWN,
            btn::UP,
            &mut pulses,
        );
        assert!(pulses.pending.is_empty());

        // Only valid motion after the fresh anchor may emit a detent.
        gesture.update(
            Some((-170.0_f32).to_radians()),
            step,
            btn::DOWN,
            btn::UP,
            &mut pulses,
        );
        assert_eq!(pulses.next_mask(), btn::UP);
        assert!(!gesture.tap_eligible);
    }

    #[test]
    fn rotary_tap_requires_uncancelled_same_sector_ring_release() {
        let rotary = test_rotary();
        let grab = RotaryGesture::new(0.0);
        assert_eq!(
            rotary_tap(grab, Some(10.0_f32.to_radians()), &rotary, false),
            Some(("menu".into(), btn::LEFT))
        );
        assert_eq!(rotary_tap(grab, Some(0.0), &rotary, true), None);
        assert_eq!(rotary_tap(grab, None, &rotary, false), None);

        let mut left_ring = grab;
        left_ring.update(
            None,
            rotary.step_radians,
            rotary.clockwise_buttons,
            rotary.counterclockwise_buttons,
            &mut ButtonPulseQueue::default(),
        );
        assert_eq!(rotary_tap(left_ring, Some(0.0), &rotary, false), None);
    }

    #[test]
    fn rotary_scroll_remainder_does_not_cross_gestures_or_ring_boundary() {
        let mut scroll = RotaryScrollState::default();
        let mut pulses = ButtonPulseQueue::default();

        assert!(scroll.update(
            true,
            Vec2::new(0.0, 7.0),
            true,
            true,
            btn::DOWN,
            btn::UP,
            &mut pulses,
        ));
        assert_eq!(scroll.remainder, 0.0);
        assert!(scroll.update(
            true,
            Vec2::new(0.0, 7.0),
            true,
            true,
            btn::DOWN,
            btn::UP,
            &mut pulses,
        ));
        assert!(pulses.pending.is_empty());

        assert!(scroll.update(
            true,
            Vec2::new(0.0, 7.0),
            false,
            false,
            btn::DOWN,
            btn::UP,
            &mut pulses,
        ));
        assert!(!scroll.update(
            false,
            Vec2::ZERO,
            false,
            false,
            btn::DOWN,
            btn::UP,
            &mut pulses,
        ));
        assert!(scroll.update(
            true,
            Vec2::new(0.0, 7.0),
            false,
            false,
            btn::DOWN,
            btn::UP,
            &mut pulses,
        ));
        assert!(pulses.pending.is_empty());
    }

    #[test]
    fn scroll_and_drag_deltas_share_axis_mapping_and_limits() {
        let orbit = orbit_after_delta(Vec2::ZERO, Vec2::new(10.0, -20.0));
        assert!((orbit.x - 0.06).abs() < 1e-6);
        assert!((orbit.y + 0.12).abs() < 1e-6);

        let clamped = orbit_after_delta(Vec2::ZERO, Vec2::splat(10_000.0));
        assert_eq!(clamped, Vec2::new(ORBIT_YAW_LIMIT, ORBIT_PITCH_LIMIT));
    }

    #[test]
    fn focus_animates_to_exact_front_and_restores_the_full_orbit_state() {
        let original = OrbitState::new(Vec2::new(0.37, -0.19));
        let mut orbit = original;
        let mut focus = FocusOrbitState::default();

        focus.enter(&orbit);
        assert!(focus.focused);
        assert_eq!(focus.displayed_orbit(orbit, 0.0), original.visible());
        assert_eq!(focus.displayed_orbit(orbit, 1.0), Vec2::ZERO);

        // Even an accidental mutation while focus is active cannot corrupt
        // the desk view: exit restores the exact raw + snap snapshot.
        orbit.apply_raw(Vec2::new(-0.22, 0.14));
        focus.exit(&mut orbit);
        assert!(!focus.focused);
        assert_eq!(orbit, original);
        assert_eq!(focus.displayed_orbit(orbit, 1.0), Vec2::ZERO);
        assert_eq!(focus.displayed_orbit(orbit, 0.0), original.visible());
    }

    #[test]
    fn focus_reversals_and_repeated_cycles_keep_the_same_desk_orbit() {
        let original = OrbitState::new(Vec2::new(-0.31, 0.17));
        let mut orbit = original;
        let mut focus = FocusOrbitState::default();

        for _ in 0..4 {
            focus.toggle(&mut orbit);
            let entering = focus.displayed_orbit(orbit, 0.43);
            focus.toggle(&mut orbit);
            let exiting = focus.displayed_orbit(orbit, 0.43);
            assert_eq!(entering, exiting, "reversing mid-animation must not jump");
            assert_eq!(orbit, original);
        }
    }

    #[test]
    fn double_click_pairs_drive_focus_and_restore_the_original_orbit() {
        let original = OrbitState::new(Vec2::new(0.28, -0.13));
        let mut orbit = original;
        let mut focus = FocusOrbitState::default();
        let mut last_click = None;

        assert!(!apply_screen_click(
            &mut last_click,
            100,
            &mut focus,
            &mut orbit
        ));
        assert!(apply_screen_click(
            &mut last_click,
            110,
            &mut focus,
            &mut orbit
        ));
        assert!(focus.focused);
        assert_eq!(focus.displayed_orbit(orbit, 1.0), Vec2::ZERO);

        assert!(!apply_screen_click(
            &mut last_click,
            200,
            &mut focus,
            &mut orbit
        ));
        assert!(apply_screen_click(
            &mut last_click,
            210,
            &mut focus,
            &mut orbit
        ));
        assert!(!focus.focused);
        assert_eq!(focus.pre_focus_orbit, None);
        assert_eq!(orbit, original);
    }

    #[test]
    fn framing_blend_reverses_direction_and_reaches_exact_endpoints() {
        let dt = 1.0 / 60.0;
        let entering = advance_framing_blend(0.43, true, dt);
        assert!(entering > 0.43);
        let exiting = advance_framing_blend(entering, false, dt);
        assert!(exiting < entering);

        let mut blend = 0.2;
        while blend < 1.0 {
            blend = advance_framing_blend(blend, true, dt);
        }
        assert_eq!(blend, 1.0);
        while blend > 0.0 {
            blend = advance_framing_blend(blend, false, dt);
        }
        assert_eq!(blend, 0.0);
    }

    #[test]
    fn front_snap_has_a_dead_zone_and_hysteresis() {
        let mut orbit = OrbitState::new(Vec2::new(0.2, 0.0));

        assert!(orbit.apply_raw(Vec2::new(FRONT_SNAP_ENTER_RADIUS * 0.9, 0.0)));
        assert!(orbit.front_snapped);
        assert_eq!(orbit.visible(), Vec2::ZERO);

        // Raw input moves inside the dead zone, but the camera stays exactly
        // front until the wider exit radius is crossed.
        assert!(!orbit.apply_raw(Vec2::new(FRONT_SNAP_ENTER_RADIUS * 1.5, 0.0)));
        assert!(orbit.front_snapped);
        assert_eq!(orbit.visible(), Vec2::ZERO);

        let outside = Vec2::new(FRONT_SNAP_EXIT_RADIUS * 1.01, 0.0);
        assert!(orbit.apply_raw(outside));
        assert!(!orbit.front_snapped);
        assert_eq!(orbit.visible(), outside);

        // Returning to the band between thresholds does not immediately
        // re-snap, which prevents noisy input from oscillating at the edge.
        let hysteresis_band = Vec2::new(FRONT_SNAP_ENTER_RADIUS * 1.5, 0.0);
        assert!(orbit.apply_raw(hysteresis_band));
        assert!(!orbit.front_snapped);
        assert_eq!(orbit.visible(), hysteresis_band);

        assert!(orbit.apply_raw(Vec2::new(FRONT_SNAP_ENTER_RADIUS * 0.5, 0.0)));
        assert!(orbit.front_snapped);
        assert_eq!(orbit.visible(), Vec2::ZERO);
    }

    #[test]
    fn initial_orbit_inside_the_capture_radius_starts_at_exact_front() {
        let orbit = OrbitState::new(Vec2::new(FRONT_SNAP_ENTER_RADIUS * 0.5, 0.0));
        assert!(orbit.front_snapped);
        assert_eq!(orbit.visible(), Vec2::ZERO);
        assert_eq!(orbit.raw.x, FRONT_SNAP_ENTER_RADIUS * 0.5);
    }

    #[test]
    fn snapped_trackpad_deltas_accumulate_until_the_user_can_leave_front() {
        let mut orbit = OrbitState::new(Vec2::ZERO);
        let one_logical_pixel = Vec2::X;

        assert!(!orbit.apply_delta(one_logical_pixel));
        assert!(orbit.front_snapped);
        assert_eq!(orbit.visible(), Vec2::ZERO);

        let mut camera_changed = false;
        for _ in 0..20 {
            camera_changed |= orbit.apply_delta(one_logical_pixel);
            if !orbit.front_snapped {
                break;
            }
        }
        assert!(camera_changed);
        assert!(!orbit.front_snapped);
        assert!(orbit.visible().x > FRONT_SNAP_EXIT_RADIUS);
    }

    #[test]
    fn snapped_right_drag_uses_the_raw_grab_angle_without_frame_accumulation() {
        let mut orbit = OrbitState::new(Vec2::new(0.2, 0.0));
        orbit.apply_raw(Vec2::new(FRONT_SNAP_ENTER_RADIUS * 0.75, 0.0));
        assert!(orbit.front_snapped);
        let grab_raw = orbit.raw;

        let small_delta = Vec2::X;
        let small_raw = orbit_after_delta(grab_raw, small_delta);
        assert!(!orbit.apply_raw(small_raw));
        assert_eq!(orbit.visible(), Vec2::ZERO);

        let large_delta = Vec2::new(12.0, 0.0);
        let expected = orbit_after_delta(grab_raw, large_delta);
        assert!(orbit.apply_raw(expected));
        assert_eq!(orbit.visible(), expected);

        // A stationary next frame recomputes from the grab snapshot; it does
        // not add the same total pointer displacement a second time.
        assert!(!orbit.apply_raw(orbit_after_delta(grab_raw, large_delta)));
        assert_eq!(orbit.visible(), expected);
    }

    #[test]
    fn scroll_and_drag_activity_hold_and_release_the_orbit_lod_lease() {
        let mut ticks = advance_scroll_orbit_ticks(0, true);
        assert_eq!(ticks, SCROLL_LOD_SETTLE_TICKS);
        assert!(orbit_gesture_active(false, ticks));

        // More deltas renew the full lease instead of shortening it.
        ticks = advance_scroll_orbit_ticks(ticks.saturating_sub(2), true);
        assert_eq!(ticks, SCROLL_LOD_SETTLE_TICKS);
        for quiet_tick in 1..=SCROLL_LOD_SETTLE_TICKS {
            ticks = advance_scroll_orbit_ticks(ticks, false);
            assert_eq!(
                orbit_gesture_active(false, ticks),
                quiet_tick < SCROLL_LOD_SETTLE_TICKS
            );
        }

        assert!(orbit_gesture_active(true, 0));
        assert!(!orbit_gesture_active(false, 0));
    }

    #[test]
    fn unknown_svc_warning_is_immediate_then_rate_limited() {
        assert!(unknown_svc_warning_due(None, 0));
        assert!(!unknown_svc_warning_due(Some(10), 11));
        assert!(!unknown_svc_warning_due(
            Some(10),
            10 + UNKNOWN_SVC_WARN_INTERVAL_TICKS - 1
        ));
        assert!(unknown_svc_warning_due(
            Some(10),
            10 + UNKNOWN_SVC_WARN_INTERVAL_TICKS
        ));
    }

    #[test]
    fn recognized_double_clicks_are_consumed_in_non_overlapping_pairs() {
        let mut last = None;
        assert!(!register_screen_click(&mut last, 100));
        assert!(register_screen_click(&mut last, 110));
        assert_eq!(last, None);

        // This is a fresh first click, not an overlapping pair with tick 110.
        assert!(!register_screen_click(&mut last, 111));
        assert!(register_screen_click(&mut last, 120));
        assert_eq!(last, None);

        assert!(!register_screen_click(&mut last, 200));
        assert!(!register_screen_click(
            &mut last,
            200 + DOUBLE_CLICK_TICKS + 1
        ));
    }
}
