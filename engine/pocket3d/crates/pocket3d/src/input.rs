//! Keyboard/mouse state, fed by winit events or injected synthetically
//! (headless tests drive the same struct).

use std::collections::HashSet;

use glam::Vec2;
use winit::event::{
    DeviceEvent, ElementState, Ime, MouseButton, MouseScrollDelta, TouchPhase, WindowEvent,
};
use winit::keyboard::{Key, KeyCode, NamedKey, PhysicalKey};

/// One IME event, in arrival order — the composition stream a text-editing
/// widget consumes alongside [`Input::edits`]. Mirrors winit's `Ime` with
/// owned strings (events outlive the borrow).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ImeInput {
    Enabled,
    /// Composition text + optional cursor byte range within it.
    Preedit(String, Option<(usize, usize)>),
    /// Finished text to insert (plain typing never produces this — with IME
    /// enabled, composed input commits here and fires NO KeyboardInput).
    Commit(String),
    Disabled,
}

/// One text-editing keystroke, in press order, key repeats included. The
/// per-frame stream a text-editing widget consumes ([`Input::edits`]) —
/// distinct from the held-state model (`key_down`/`key_pressed`), which
/// ignores repeats on purpose.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EditKey {
    /// A typed character (winit's logical `KeyEvent::text`, so shift and
    /// layout are already applied). Control characters never appear here.
    Char(char),
    Backspace,
    Delete,
    Enter,
    Tab,
    Left,
    Right,
    Up,
    Down,
    Home,
    End,
    PageUp,
    PageDown,
    Escape,
}

/// Ordered pointer events in physical window pixels. Keep edges even when a
/// complete click arrives between rendered frames.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum PointerEvent {
    Move(Option<Vec2>),
    Button {
        position: Option<Vec2>,
        button: MouseButton,
        down: bool,
    },
    Cancel,
}

#[derive(Default)]
pub struct Input {
    pointer_events: Vec<PointerEvent>,
    down: HashSet<KeyCode>,
    pressed: HashSet<KeyCode>,
    mouse_down: HashSet<u8>,
    mouse_pressed: HashSet<u8>,
    mouse_delta: Vec2,
    cursor: Option<Vec2>,
    edits: Vec<EditKey>,
    ime: Vec<ImeInput>,
    scroll: Vec2,
    /// Edge markers for touchpad scroll gestures. Traditional mouse wheels
    /// may only report `Moved`, so consumers should retain a short idle
    /// fallback in addition to observing these exact boundaries.
    scroll_started: bool,
    scroll_ended: bool,
    /// One-turn cancellation edge raised by focus loss or an explicit input
    /// reset. This is distinct from a normal button release.
    interaction_cancelled: bool,
    /// A super/command chord is held — edit consumers usually skip
    /// `Char` events while true (they are shortcuts, not typing).
    super_down: bool,
}

fn button_id(b: MouseButton) -> u8 {
    match b {
        MouseButton::Left => 0,
        MouseButton::Right => 1,
        MouseButton::Middle => 2,
        MouseButton::Back => 3,
        MouseButton::Forward => 4,
        MouseButton::Other(n) => (5 + (n % 250)) as u8,
    }
}

impl Input {
    pub fn on_window_event(&mut self, event: &WindowEvent) {
        match event {
            WindowEvent::KeyboardInput { event, .. } => {
                if let PhysicalKey::Code(code) = event.physical_key {
                    match event.state {
                        ElementState::Pressed => {
                            if !event.repeat && self.down.insert(code) {
                                self.pressed.insert(code);
                            }
                        }
                        ElementState::Released => {
                            self.down.remove(&code);
                        }
                    }
                }
                // The edit stream: logical keys, repeats included.
                if event.state == ElementState::Pressed {
                    let named = match &event.logical_key {
                        Key::Named(NamedKey::Backspace) => Some(EditKey::Backspace),
                        Key::Named(NamedKey::Delete) => Some(EditKey::Delete),
                        Key::Named(NamedKey::Enter) => Some(EditKey::Enter),
                        Key::Named(NamedKey::Tab) => Some(EditKey::Tab),
                        Key::Named(NamedKey::ArrowLeft) => Some(EditKey::Left),
                        Key::Named(NamedKey::ArrowRight) => Some(EditKey::Right),
                        Key::Named(NamedKey::ArrowUp) => Some(EditKey::Up),
                        Key::Named(NamedKey::ArrowDown) => Some(EditKey::Down),
                        Key::Named(NamedKey::Home) => Some(EditKey::Home),
                        Key::Named(NamedKey::End) => Some(EditKey::End),
                        Key::Named(NamedKey::PageUp) => Some(EditKey::PageUp),
                        Key::Named(NamedKey::PageDown) => Some(EditKey::PageDown),
                        Key::Named(NamedKey::Escape) => Some(EditKey::Escape),
                        Key::Named(NamedKey::Super) => {
                            self.super_down = true;
                            None
                        }
                        _ => None,
                    };
                    if let Some(k) = named {
                        self.edits.push(k);
                    } else if let Some(text) = &event.text {
                        self.edits
                            .extend(text.chars().filter(|c| !c.is_control()).map(EditKey::Char));
                    }
                } else if matches!(&event.logical_key, Key::Named(NamedKey::Super)) {
                    self.super_down = false;
                }
            }
            WindowEvent::Ime(ime) => {
                self.ime.push(match ime {
                    Ime::Enabled => ImeInput::Enabled,
                    Ime::Preedit(text, range) => ImeInput::Preedit(text.clone(), *range),
                    Ime::Commit(text) => ImeInput::Commit(text.clone()),
                    Ime::Disabled => ImeInput::Disabled,
                });
            }
            WindowEvent::MouseWheel { delta, phase, .. } => {
                // Normalize to logical px; a line is worth ~20.
                self.scroll += match delta {
                    MouseScrollDelta::LineDelta(x, y) => Vec2::new(x * 20.0, y * 20.0),
                    MouseScrollDelta::PixelDelta(p) => Vec2::new(p.x as f32, p.y as f32),
                };
                match phase {
                    TouchPhase::Started => self.scroll_started = true,
                    TouchPhase::Ended | TouchPhase::Cancelled => self.scroll_ended = true,
                    TouchPhase::Moved => {}
                }
            }
            WindowEvent::MouseInput { state, button, .. } => {
                self.pointer_events.push(PointerEvent::Button {
                    position: self.cursor,
                    button: *button,
                    down: state.is_pressed(),
                });
                let id = button_id(*button);
                match state {
                    ElementState::Pressed => {
                        if self.mouse_down.insert(id) {
                            self.mouse_pressed.insert(id);
                        }
                    }
                    ElementState::Released => {
                        self.mouse_down.remove(&id);
                    }
                }
            }
            WindowEvent::CursorMoved { position, .. } => {
                self.cursor = Some(Vec2::new(position.x as f32, position.y as f32));
                self.pointer_events.push(PointerEvent::Move(self.cursor));
            }
            WindowEvent::CursorLeft { .. } => {
                self.cursor = None;
                self.pointer_events.push(PointerEvent::Move(None));
            }
            WindowEvent::Focused(false) => self.clear(),
            _ => {}
        }
    }

    /// Cursor position in window pixels, `None` while outside the window.
    pub fn cursor(&self) -> Option<Vec2> {
        self.cursor
    }

    pub fn on_device_event(&mut self, event: &DeviceEvent) {
        if let DeviceEvent::MouseMotion { delta } = event {
            self.mouse_delta += Vec2::new(delta.0 as f32, delta.1 as f32);
        }
    }

    /// Forget everything held (focus loss, mode switches).
    pub fn clear(&mut self) {
        self.pointer_events.clear();
        self.pointer_events.push(PointerEvent::Cancel);
        self.down.clear();
        self.pressed.clear();
        self.mouse_down.clear();
        self.mouse_pressed.clear();
        self.mouse_delta = Vec2::ZERO;
        self.edits.clear();
        self.ime.clear();
        self.scroll = Vec2::ZERO;
        self.scroll_started = false;
        self.scroll_ended = true;
        self.interaction_cancelled = true;
        self.super_down = false;
    }

    /// Call once per simulation turn, after game logic consumed edge state.
    pub fn end_frame(&mut self) {
        self.pointer_events.clear();
        self.pressed.clear();
        self.mouse_pressed.clear();
        self.mouse_delta = Vec2::ZERO;
        self.edits.clear();
        self.ime.clear();
        self.scroll = Vec2::ZERO;
        self.scroll_started = false;
        self.scroll_ended = false;
        self.interaction_cancelled = false;
    }

    /// This frame's text-editing keystrokes, in press order (repeats
    /// included). Cleared by `end_frame`.
    pub fn edits(&self) -> &[EditKey] {
        &self.edits
    }

    /// This frame's IME composition events, in arrival order. Cleared by
    /// `end_frame`.
    pub fn ime_events(&self) -> &[ImeInput] {
        &self.ime
    }

    /// This frame's accumulated scroll-wheel delta in logical px
    /// (y positive = content up, winit convention). Cleared by `end_frame`.
    pub fn scroll(&self) -> Vec2 {
        self.scroll
    }

    /// True during the simulation turn that received a touchpad scroll start.
    pub fn scroll_gesture_started(&self) -> bool {
        self.scroll_started
    }

    /// True during the simulation turn that received a touchpad scroll end or
    /// cancellation. Mouse wheels that do not publish phases leave this false.
    pub fn scroll_gesture_ended(&self) -> bool {
        self.scroll_ended
    }

    /// True for one simulation turn after focus loss or [`Input::clear`].
    /// Pointer consumers use this to cancel captures without mistaking the
    /// reset for an intentional button release.
    pub fn interaction_cancelled(&self) -> bool {
        self.interaction_cancelled
    }

    /// A super/command key is currently held.
    pub fn super_down(&self) -> bool {
        self.super_down
    }

    pub fn key_down(&self, code: KeyCode) -> bool {
        self.down.contains(&code)
    }
    /// True only on the frame the key went down.
    pub fn key_pressed(&self, code: KeyCode) -> bool {
        self.pressed.contains(&code)
    }
    pub fn mouse_button_down(&self, button: MouseButton) -> bool {
        self.mouse_down.contains(&button_id(button))
    }
    pub fn mouse_button_pressed(&self, button: MouseButton) -> bool {
        self.mouse_pressed.contains(&button_id(button))
    }
    pub fn mouse_delta(&self) -> Vec2 {
        self.mouse_delta
    }

    pub fn pointer_events(&self) -> &[PointerEvent] {
        &self.pointer_events
    }
    // --- synthetic injection (headless scripting/tests) -------------------

    pub fn inject_key(&mut self, code: KeyCode, down: bool) {
        if down {
            if self.down.insert(code) {
                self.pressed.insert(code);
            }
        } else {
            self.down.remove(&code);
        }
    }

    pub fn inject_mouse_button(&mut self, button: MouseButton, down: bool) {
        self.pointer_events.push(PointerEvent::Button {
            position: self.cursor,
            button,
            down,
        });
        let id = button_id(button);
        if down {
            if self.mouse_down.insert(id) {
                self.mouse_pressed.insert(id);
            }
        } else {
            self.mouse_down.remove(&id);
        }
    }

    pub fn inject_mouse_delta(&mut self, dx: f32, dy: f32) {
        self.mouse_delta += Vec2::new(dx, dy);
    }

    /// Place the cursor at a window-pixel position (scripted picking).
    pub fn inject_cursor(&mut self, x: f32, y: f32) {
        self.cursor = Some(Vec2::new(x, y));
        self.pointer_events.push(PointerEvent::Move(self.cursor));
    }

    /// Append a text-editing keystroke (scripted typing).
    pub fn inject_edit(&mut self, key: EditKey) {
        self.edits.push(key);
    }

    /// Append an IME event (scripted composition).
    pub fn inject_ime(&mut self, ime: ImeInput) {
        self.ime.push(ime);
    }

    /// Add scroll-wheel delta in logical px (scripted scrolling).
    pub fn inject_scroll(&mut self, dx: f32, dy: f32) {
        self.scroll += Vec2::new(dx, dy);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pointer_stream_keeps_fast_clicks_and_cancels_held_input() {
        let mut input = Input::default();
        input.inject_cursor(12.0, 34.0);
        input.inject_mouse_button(MouseButton::Left, true);
        input.inject_mouse_button(MouseButton::Left, false);
        assert_eq!(input.pointer_events().len(), 3);
        assert!(!input.mouse_button_down(MouseButton::Left));
        input.end_frame();
        assert!(input.pointer_events().is_empty());
        input.inject_key(KeyCode::KeyW, true);
        input.inject_mouse_delta(20.0, 10.0);
        input.clear();
        assert_eq!(input.pointer_events(), &[PointerEvent::Cancel]);
        assert!(!input.key_down(KeyCode::KeyW));
        assert_eq!(input.mouse_delta(), Vec2::ZERO);
    }

    #[test]
    fn end_frame_consumes_edges_but_preserves_held_state() {
        let mut input = Input::default();
        input.inject_key(KeyCode::KeyX, true);
        input.inject_mouse_button(MouseButton::Left, true);
        assert!(input.key_pressed(KeyCode::KeyX));
        assert!(input.mouse_button_pressed(MouseButton::Left));

        input.end_frame();
        assert!(!input.key_pressed(KeyCode::KeyX));
        assert!(!input.mouse_button_pressed(MouseButton::Left));
        assert!(input.key_down(KeyCode::KeyX));
        assert!(input.mouse_button_down(MouseButton::Left));
    }

    #[test]
    fn scroll_normalizes_lines_and_preserves_precise_pixels() {
        let mut input = Input::default();
        input.on_window_event(&WindowEvent::MouseWheel {
            device_id: winit::event::DeviceId::dummy(),
            delta: MouseScrollDelta::LineDelta(1.5, -2.0),
            phase: winit::event::TouchPhase::Moved,
        });
        input.on_window_event(&WindowEvent::MouseWheel {
            device_id: winit::event::DeviceId::dummy(),
            delta: MouseScrollDelta::PixelDelta(winit::dpi::PhysicalPosition::new(3.25, -7.5)),
            phase: winit::event::TouchPhase::Moved,
        });
        assert_eq!(input.scroll(), Vec2::new(33.25, -47.5));
    }

    #[test]
    fn wheel_events_accumulate_until_the_simulation_turn_is_consumed() {
        let mut input = Input::default();
        input.on_window_event(&WindowEvent::MouseWheel {
            device_id: winit::event::DeviceId::dummy(),
            delta: MouseScrollDelta::PixelDelta(winit::dpi::PhysicalPosition::new(2.0, -3.0)),
            phase: winit::event::TouchPhase::Moved,
        });
        input.on_window_event(&WindowEvent::MouseWheel {
            device_id: winit::event::DeviceId::dummy(),
            delta: MouseScrollDelta::PixelDelta(winit::dpi::PhysicalPosition::new(4.0, 1.0)),
            phase: winit::event::TouchPhase::Moved,
        });
        assert_eq!(input.scroll(), Vec2::new(6.0, -2.0));

        input.end_frame();
        assert_eq!(input.scroll(), Vec2::ZERO);
    }

    #[test]
    fn scroll_phases_and_interaction_cancellation_are_one_turn_edges() {
        let mut input = Input::default();
        input.on_window_event(&WindowEvent::MouseWheel {
            device_id: winit::event::DeviceId::dummy(),
            delta: MouseScrollDelta::PixelDelta(winit::dpi::PhysicalPosition::new(0.0, 1.0)),
            phase: TouchPhase::Started,
        });
        input.on_window_event(&WindowEvent::MouseWheel {
            device_id: winit::event::DeviceId::dummy(),
            delta: MouseScrollDelta::PixelDelta(winit::dpi::PhysicalPosition::new(0.0, 2.0)),
            phase: TouchPhase::Ended,
        });
        assert!(input.scroll_gesture_started());
        assert!(input.scroll_gesture_ended());
        assert!(!input.interaction_cancelled());

        input.end_frame();
        assert!(!input.scroll_gesture_started());
        assert!(!input.scroll_gesture_ended());

        input.inject_mouse_button(MouseButton::Left, true);
        input.on_window_event(&WindowEvent::Focused(false));
        assert!(!input.mouse_button_down(MouseButton::Left));
        assert!(input.scroll_gesture_ended());
        assert!(input.interaction_cancelled());

        input.end_frame();
        assert!(!input.scroll_gesture_ended());
        assert!(!input.interaction_cancelled());
    }
}
