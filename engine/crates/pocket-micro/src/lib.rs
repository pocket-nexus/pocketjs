//! Pocket Micro runtime: what a compiled Micro TS component links against.
//!
//! The compiler (micro/compiler) turns one Solid component module into a
//! Rust `struct App` that implements [`App`]. Everything that the Solid
//! runtime did generically at run time — the root layers `render()` creates,
//! the document-order focus list, CIRCLE press dispatch, texture and sprite
//! name lookup — lives here once, so generated code only issues typed calls
//! against [`Runtime`].
//!
//! Frame contract (identical to framework/src/index.ts on the JS side):
//! once per virtual frame the host calls [`Runtime::frame`] with the PSP
//! button mask. The runtime detects edges, moves focus, dispatches the press
//! handler, then runs the app's flush loop so every binding that depends on
//! a written signal is re-applied before the host ticks the core.
#![no_std]

extern crate alloc;

pub mod fmt;
pub mod focus;
pub mod pak;
pub mod tape;

use alloc::string::String;
use alloc::vec::Vec;

pub use pocketjs_core;
pub use pocketjs_core::spec;
pub use pocketjs_core::Ui;

/// A generation-tagged core node id. `NONE` is the append anchor and the
/// "no focus" value, exactly as in the `ui.*` op contract.
#[repr(transparent)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct NodeId(pub i32);

impl NodeId {
    pub const NONE: NodeId = NodeId(0);
    pub const ROOT: NodeId = NodeId(spec::ROOT_ID);
    pub const fn is_none(self) -> bool {
        self.0 == 0
    }
}

/// A record index into the styles.bin table the compiler emitted with the app.
#[repr(transparent)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StyleId(pub i32);

/// One pak image: `ui:img.<name>` uploaded to the core at boot.
pub struct Texture {
    pub name: String,
    pub handle: i32,
}

/// One pak sprite atlas: `ui:sprite.<name>` plus its animation metadata.
pub struct SpriteAtlas {
    pub name: String,
    pub handle: i32,
    pub frames: u16,
    pub cols: u16,
    pub step: u16,
}

/// Everything the pak feeder registered by name.
#[derive(Default)]
pub struct Assets {
    pub textures: Vec<Texture>,
    pub sprites: Vec<SpriteAtlas>,
}

/// The contract a compiled component implements.
pub trait App {
    /// Build the static tree under `rt.app_root()`, apply initial bindings,
    /// register focusables, run effects and mount hooks once.
    fn mount(&mut self, rt: &mut Runtime);
    /// Run the press handler with compiler-assigned index `handler`.
    fn press(&mut self, rt: &mut Runtime, handler: u16);
    /// Re-apply every binding whose signal was written since the last flush.
    fn flush(&mut self, rt: &mut Runtime);
    /// Append the signal values as one JSON object (device receipts, tests).
    fn state(&self, out: &mut String);
}

/// Counters the host reads for receipts; a native host counts instead of
/// throwing, as the non-strict QuickJS host does.
#[derive(Clone, Copy, Debug, Default)]
pub struct Misses {
    pub unknown_texture: u32,
    pub unknown_sprite: u32,
}

/// The mounted runtime: the core plus the state the Solid runtime kept in JS.
pub struct Runtime {
    pub ui: Ui,
    assets: Assets,
    focus: focus::Focus,
    prev_buttons: u32,
    app_root: NodeId,
    overlay_root: NodeId,
    frame: u64,
    misses: Misses,
}

impl Runtime {
    /// Wrap a fed core. Creates the app and overlay layers exactly as
    /// framework/src/index.ts `render()` does, so layout and paint order
    /// match the JS runtime byte for byte.
    pub fn new(mut ui: Ui, assets: Assets) -> Self {
        let (w, h) = ui.viewport();
        let app_root = ui.create_node(spec::NodeType::View as u8);
        ui.set_prop(app_root, spec::prop::WIDTH, w as f64);
        ui.set_prop(app_root, spec::prop::HEIGHT, h as f64);
        ui.set_prop(
            app_root,
            spec::prop::OVERFLOW,
            spec::Overflow::Hidden as u8 as f64,
        );
        let overlay_root = ui.create_node(spec::NodeType::View as u8);
        ui.set_prop(overlay_root, spec::prop::WIDTH, w as f64);
        ui.set_prop(overlay_root, spec::prop::HEIGHT, h as f64);
        ui.set_prop(
            overlay_root,
            spec::prop::POS_TYPE,
            spec::PosType::Absolute as u8 as f64,
        );
        ui.set_prop(overlay_root, spec::prop::INSET_T, 0.0);
        ui.set_prop(overlay_root, spec::prop::INSET_R, 0.0);
        ui.set_prop(overlay_root, spec::prop::INSET_B, 0.0);
        ui.set_prop(overlay_root, spec::prop::INSET_L, 0.0);
        ui.set_prop(overlay_root, spec::prop::Z_INDEX, 1000.0);
        ui.set_prop(overlay_root, spec::prop::HIT_PASS, 1.0);
        ui.insert_before(spec::ROOT_ID, app_root, 0);
        ui.insert_before(spec::ROOT_ID, overlay_root, 0);
        Runtime {
            ui,
            assets,
            focus: focus::Focus::new(),
            prev_buttons: 0,
            app_root: NodeId(app_root),
            overlay_root: NodeId(overlay_root),
            frame: 0,
            misses: Misses::default(),
        }
    }

    pub fn app_root(&self) -> NodeId {
        self.app_root
    }

    pub fn overlay_root(&self) -> NodeId {
        self.overlay_root
    }

    pub fn assets(&self) -> &Assets {
        &self.assets
    }

    pub fn misses(&self) -> Misses {
        self.misses
    }

    /// Frames driven so far.
    pub fn frame_index(&self) -> u64 {
        self.frame
    }

    pub fn focused(&self) -> NodeId {
        self.focus.focused()
    }

    /// Mount the app: build its tree, then flush once so signals written by
    /// effects during mount reach their bindings before frame 0.
    pub fn mount<A: App>(&mut self, app: &mut A) {
        app.mount(self);
        app.flush(self);
    }

    /// One virtual frame of input: edge detection, d-pad focus traversal,
    /// CIRCLE press with the `active:` variant held, then the flush loop.
    /// Mirrors framework/src/input.ts `handleFrame` for the classic model.
    pub fn frame<A: App>(&mut self, app: &mut A, buttons: u32) {
        let pressed = buttons & !self.prev_buttons;
        let released = self.prev_buttons & !buttons;
        self.prev_buttons = buttons;
        if released & spec::btn::CIRCLE != 0 {
            self.set_pressed(NodeId::NONE);
        }
        if pressed != 0 {
            if pressed & spec::btn::DOWN != 0 {
                self.move_focus(1);
            }
            if pressed & spec::btn::RIGHT != 0 {
                self.move_focus(1);
            }
            if pressed & spec::btn::UP != 0 {
                self.move_focus(-1);
            }
            if pressed & spec::btn::LEFT != 0 {
                self.move_focus(-1);
            }
            if pressed & spec::btn::CIRCLE != 0 {
                let focused = self.focus.focused();
                self.set_pressed(focused);
                if let Some(handler) = self.focus.handler_of(focused) {
                    app.press(self, handler);
                }
            }
        }
        app.flush(self);
        self.frame = self.frame.wrapping_add(1);
    }

    // ---- focus -----------------------------------------------------------

    /// Register a focusable node at its document-order key. `handler` is the
    /// press handler of the node or of its nearest ancestor with one — the
    /// compiler resolves the bubbling walk statically.
    pub fn register_focusable(&mut self, node: NodeId, order: u32, handler: Option<u16>) {
        self.focus.register(node, order, handler);
    }

    /// Forget a focusable before its subtree is destroyed. A focused node
    /// hands focus to the next focusable in document order, else the
    /// previous one, else none.
    pub fn unregister_focusable(&mut self, node: NodeId) {
        if let Some(next) = self.focus.unregister(node) {
            self.focus_node(next);
        }
    }

    pub fn focus_node(&mut self, node: NodeId) {
        let pressed = self.focus.pressed();
        if !pressed.is_none() && pressed != node {
            self.set_pressed(NodeId::NONE);
        }
        self.focus.set_focused(node);
        self.ui.set_focus(node.0);
    }

    fn set_pressed(&mut self, node: NodeId) {
        let current = self.focus.pressed();
        if current == node {
            return;
        }
        if !current.is_none() {
            self.ui.set_active(current.0, false);
        }
        self.focus.set_pressed(node);
        if !node.is_none() {
            self.ui.set_active(node.0, true);
        }
    }

    fn move_focus(&mut self, dir: i32) {
        match self.focus.linear_target(dir) {
            focus::Move::Clear => {
                if !self.focus.focused().is_none() {
                    self.focus_node(NodeId::NONE);
                }
            }
            focus::Move::To(node) => self.focus_node(node),
            focus::Move::Stay => {}
        }
    }

    // ---- tree ops --------------------------------------------------------

    /// Create a node and insert it under `parent` before `anchor`
    /// (`NodeId::NONE` appends).
    pub fn create(&mut self, node_type: u8, parent: NodeId, anchor: NodeId) -> NodeId {
        let id = self.ui.create_node(node_type);
        self.ui.insert_before(parent.0, id, anchor.0);
        NodeId(id)
    }

    /// Destroy a subtree. Callers unregister its focusables first.
    pub fn destroy(&mut self, node: NodeId) {
        self.ui.destroy_node(node.0);
    }

    pub fn set_style(&mut self, node: NodeId, style: StyleId) {
        self.ui.set_style(node.0, style.0);
    }

    pub fn set_prop(&mut self, node: NodeId, prop: u8, value: f64) {
        self.ui.set_prop(node.0, prop, value);
    }

    pub fn set_text(&mut self, node: NodeId, text: &str) {
        self.ui.set_text(node.0, text);
    }

    /// `src="<name>"`: bind a pak image by its bare name.
    pub fn set_image(&mut self, node: NodeId, name: &str) {
        match self.assets.textures.iter().find(|t| t.name == name) {
            Some(t) => self.ui.set_image(node.0, t.handle),
            None => self.misses.unknown_texture = self.misses.unknown_texture.wrapping_add(1),
        }
    }

    /// `sprite="<name>"`: bind an auto-playing atlas; `frame_step` overrides
    /// the manifest step when the component passes one.
    pub fn set_sprite(&mut self, node: NodeId, name: &str, frame_step: Option<u16>) {
        match self.assets.sprites.iter().find(|s| s.name == name) {
            Some(s) => {
                let step = frame_step.unwrap_or(s.step).max(1);
                self.ui.set_sprite(
                    node.0,
                    s.handle,
                    s.frames as u32,
                    s.cols as u32,
                    step as u32,
                );
            }
            None => self.misses.unknown_sprite = self.misses.unknown_sprite.wrapping_add(1),
        }
    }

    /// `animate(node, prop, to, { dur, easing, delay })`.
    pub fn animate(
        &mut self,
        node: NodeId,
        prop: u8,
        to: f64,
        dur_ms: u32,
        easing: u8,
        delay_ms: u32,
    ) -> i32 {
        self.ui.animate(node.0, prop, to, dur_ms, easing, delay_ms)
    }

    pub fn cancel_anim(&mut self, anim: i32) {
        self.ui.cancel_anim(anim);
    }
}
