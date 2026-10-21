//! note-widget — a markdown sticky note on the desktop.
//!
//! The first *flat* pocket-widget runtime (docs/WIDGET.md): no scene, no camera —
//! the borderless window IS a live PocketJS `ui` surface, rendered by the
//! same DrawList backend as every other host and governed by the shell's
//! demand rendering: the guest ticks at 60 Hz always, a GPU frame renders
//! only when the DrawList hash moves. A settled note costs ticks
//! (microseconds), zero frames.
//!
//!   bun tools/build.ts note-main --density=2
//!   cargo run -p note-widget
//!   cargo run -p note-widget -- --file ~/notes/todo.md --width 380 --height 520
//!
//! The host is the guest's companion process over the spec svc channel
//! (ops 30..32): real keyboard/mouse/wheel/resize go in as JSON lines,
//! save/quit intents come back. Clicks synthesize BTN_CIRCLE, so the
//! framework's hover-focus + onPress pipeline dispatches them — the app
//! never sees a platform event, only spec inputs. Drag the header to move,
//! drag the dotted corner (or any edge, macOS) to resize, ⌘Q/⌘W quits.

mod cjk;

use std::{
    path::{Path, PathBuf},
    rc::Rc,
};

use anyhow::{Context, Result, anyhow};
use glam::Vec2;
use pocket_drivers::InputFrameBuilder;
use pocket_mod::Guest;
use pocket_ui_wgpu::{Blit, ProgramConfig, ProgramOutput, UiProgram, UiSurface};
use pocket_widget::shell::{FlatWidget, WidgetConfig};
use pocket3d::gpu::{Gpu, OFFSCREEN_FORMAT, OffscreenTarget};
use pocket3d::input::{EditKey, ImeInput, Input};
use winit::keyboard::KeyCode;

/// Header strip height in logical px — mirrors HEADER_H in apps/note/app.tsx.
const HEADER_H: f32 = 30.0;
/// Header pixels reserved for the toggle/••• buttons (not a drag region).
const HEADER_BUTTONS_W: f32 = 112.0;
/// Resize grip square in the bottom-right corner, logical px.
const GRIP: f32 = 18.0;
/// The spec CIRCLE bit — the framework's onPress button.
const BTN_CIRCLE: u32 = 0x2000;
/// Ticks a scripted drag takes from press to its final position.
const DRAG_TICKS: u64 = 8;

struct NoteGame {
    surface: UiSurface,
    program: UiProgram,
    bundle: String,
    pak: Vec<u8>,
    output: Option<ProgramOutput>,
    format: wgpu::TextureFormat,
    blit: Option<Blit>,
    output_scale: f32,
    /// Runtime CJK atlas extension (IME input → system-font glyphs).
    atlases: cjk::CjkAtlases,
    /// Caret rect reported by the guest (logical px) — docks the IME
    /// candidate window.
    caret_rect: Option<(f32, f32, f32, f32)>,
    file: PathBuf,
    /// Current logical viewport (the core's), tracked against the window.
    logical: (u32, u32),
    /// DrawList hash and raster revision of the latest tick.
    revision: u64,
    hash: u64,
    dirty: bool,
    exit: bool,
    booted: bool,
    /// Last (x, y, primary-down) sent over svc — mouse lines go out on any
    /// change, including press/release without movement.
    last_mouse: Option<(f32, f32, bool)>,
    /// The guest's ••• menu is up: stop claiming header drags/resizes so
    /// clicks anywhere reach the backdrop and close it.
    guest_menu_open: bool,
    /// Window scale factor from the latest tick (cursor px → logical).
    scale: f64,
    ticks: u64,
    /// Headless scripting (--type/--click/--key events by frame).
    script: Vec<(u64, ScriptEvent)>,
    /// Scripted click: CIRCLE held until this tick.
    script_click_until: u64,
    /// Scripted shift modifier (held while a ShiftClick plays out).
    script_shift: bool,
    /// Scripted drag in flight: (x0, y0, x1, y1, start tick).
    script_drag: Option<(f32, f32, f32, f32, u64)>,
    quit_after: Option<u64>,
}

enum ScriptEvent {
    Click(f32, f32),
    ShiftClick(f32, f32),
    /// Press at (x0,y0), sweep to (x1,y1) over a few ticks, release.
    Drag(f32, f32, f32, f32),
    Type(String),
    Key(String),
    Paste(String),
    /// Scripted IME composition (cursor at the end).
    Preedit(String),
    Scroll(f32),
}

impl NoteGame {
    fn new(
        program: UiProgram,
        bundle: String,
        pak: Vec<u8>,
        atlases: cjk::CjkAtlases,
        file: PathBuf,
        logical: (u32, u32),
    ) -> Self {
        let surface = program.surface();
        NoteGame {
            surface,
            program,
            bundle,
            pak,
            output: None,
            format: OFFSCREEN_FORMAT,
            blit: None,
            output_scale: 1.,
            atlases,
            caret_rect: None,
            file,
            logical,
            revision: 0,
            hash: 0,
            dirty: true,
            exit: false,
            booted: false,
            last_mouse: None,
            guest_menu_open: false,
            scale: 1.0,
            ticks: 0,
            script: Vec::new(),
            script_click_until: 0,
            script_shift: false,
            script_drag: None,
            quit_after: None,
        }
    }

    fn configure_output(
        &mut self,
        logical: (u32, u32),
        physical: (u32, u32),
        scale: f32,
    ) -> Result<()> {
        let output = self.output.as_ref().expect("init ran");
        if self.logical == logical && output.size() == physical && self.output_scale == scale {
            return Ok(());
        }
        let previous = output.size();
        output.configure(physical, scale)?;
        if let Err(error) = self.program.runtime_mut().resize_embedded_gpu(
            [logical.0 as f32, logical.1 as f32],
            [physical.0, physical.1],
        ) {
            output.configure(previous, self.output_scale)?;
            return Err(anyhow!("note viewport: {error:?}"));
        }
        self.output_scale = scale;
        Ok(())
    }

    fn svc(&self, value: serde_json::Value) {
        self.surface.svc_push(value.to_string());
    }

    /// Rasterize any codepoints `text` needs that the baked atlases lack,
    /// and reload the grown slots — call BEFORE pushing text to the guest
    /// so its very first measure sees real glyphs, never tofu.
    fn ensure_text(&mut self, text: &str) {
        for blob in self.atlases.ensure(text) {
            self.surface.with_ui(|ui| {
                if !ui.load_font_atlas(&blob) {
                    log::warn!("note-widget: extended atlas rejected by the core");
                }
            });
        }
    }

    /// The svc hello: viewport first, then the document (order matters — the
    /// app lays text out against the viewport it was just told about).
    fn send_hello(&mut self) {
        self.svc(serde_json::json!({"t": "hello", "w": self.logical.0, "h": self.logical.1}));
        let text = std::fs::read_to_string(&self.file).unwrap_or_default();
        if !text.is_empty() {
            self.ensure_text(&text);
            self.svc(serde_json::json!({"t": "load", "text": text}));
        }
        log::info!(
            "note-widget: {} ({} bytes)",
            self.file.display(),
            text.len()
        );
    }

    fn save(&self, text: &str) {
        // Atomic-enough: temp in the same directory, then rename.
        let tmp = self.file.with_extension("md.tmp");
        let write = std::fs::write(&tmp, text).and_then(|()| std::fs::rename(&tmp, &self.file));
        match write {
            Ok(()) => log::info!("note-widget: saved {} bytes", text.len()),
            Err(e) => log::warn!("note-widget: save failed: {e}"),
        }
    }

    fn forward_edits(&mut self, input: &Input) {
        // Batch runs of typed chars into one line; ⌘-chords are shortcuts,
        // not text.
        let shift = input.key_down(KeyCode::ShiftLeft) || input.key_down(KeyCode::ShiftRight);
        let mut chars = String::new();
        for key in input.edits() {
            let named = match key {
                EditKey::Char(c) => {
                    if !input.super_down() {
                        chars.push(*c);
                    }
                    continue;
                }
                EditKey::Backspace => "Backspace",
                EditKey::Delete => "Delete",
                EditKey::Enter => "Enter",
                EditKey::Tab => "Tab",
                EditKey::Left => "Left",
                EditKey::Right => "Right",
                EditKey::Up => "Up",
                EditKey::Down => "Down",
                EditKey::Home => "Home",
                EditKey::End => "End",
                EditKey::PageUp => "PageUp",
                EditKey::PageDown => "PageDown",
                EditKey::Escape => "Escape",
            };
            if !chars.is_empty() {
                let batch = std::mem::take(&mut chars);
                self.ensure_text(&batch);
                self.svc(serde_json::json!({"t": "ch", "s": batch}));
            }
            self.svc(serde_json::json!({"t": "key", "k": named, "sh": shift}));
        }
        if !chars.is_empty() {
            self.ensure_text(&chars);
            self.svc(serde_json::json!({"t": "ch", "s": chars}));
        }
    }

    /// Forward IME composition: preedit text (with a char-index cursor) and
    /// commits. Plain typing never lands here (winit sends it as KeyEvents
    /// while the IME state is Ground), so there is no double-input path.
    fn forward_ime(&mut self, input: &Input) {
        for ev in input.ime_events().to_vec() {
            match ev {
                ImeInput::Preedit(text, range) => {
                    self.ensure_text(&text);
                    let cursor = range
                        .map(|(lo, _)| text.char_indices().take_while(|(i, _)| *i < lo).count());
                    self.svc(serde_json::json!({"t": "ime", "s": text, "c": cursor}));
                }
                ImeInput::Commit(text) => {
                    self.ensure_text(&text);
                    self.svc(serde_json::json!({"t": "ch", "s": text}));
                }
                ImeInput::Enabled => {}
                ImeInput::Disabled => {
                    self.svc(serde_json::json!({"t": "ime", "s": "", "c": null}));
                }
            }
        }
    }

    fn run_script(&mut self) {
        let due: Vec<usize> = self
            .script
            .iter()
            .enumerate()
            .filter(|(_, (at, _))| *at == self.ticks)
            .map(|(i, _)| i)
            .collect();
        for i in due.into_iter().rev() {
            let (_, ev) = self.script.remove(i);
            match ev {
                ScriptEvent::Click(x, y) => {
                    // Hover first (focuses the target), then hold CIRCLE for
                    // a few ticks — the same order a real pointer produces.
                    self.svc(serde_json::json!({"t": "mouse", "x": x, "y": y, "d": false}));
                    self.script_click_until = self.ticks + 4;
                    self.script_shift = false;
                    self.script_drag = Some((x, y, x, y, self.ticks));
                }
                ScriptEvent::ShiftClick(x, y) => {
                    self.svc(
                        serde_json::json!({"t": "mouse", "x": x, "y": y, "d": false, "sh": true}),
                    );
                    self.script_click_until = self.ticks + 4;
                    self.script_shift = true;
                    self.script_drag = Some((x, y, x, y, self.ticks));
                }
                ScriptEvent::Drag(x0, y0, x1, y1) => {
                    self.svc(serde_json::json!({"t": "mouse", "x": x0, "y": y0, "d": false}));
                    self.script_click_until = self.ticks + DRAG_TICKS + 2;
                    self.script_drag = Some((x0, y0, x1, y1, self.ticks));
                }
                ScriptEvent::Type(s) => {
                    self.ensure_text(&s);
                    self.svc(serde_json::json!({"t": "ch", "s": s}));
                }
                ScriptEvent::Paste(text) => {
                    self.ensure_text(&text);
                    self.svc(serde_json::json!({"t": "paste", "text": text}));
                }
                ScriptEvent::Preedit(text) => {
                    self.ensure_text(&text);
                    let n = text.chars().count();
                    self.svc(serde_json::json!({"t": "ime", "s": text, "c": n}));
                }
                ScriptEvent::Key(k) => self.svc(serde_json::json!({"t": "key", "k": k})),
                ScriptEvent::Scroll(dy) => self.svc(serde_json::json!({"t": "scroll", "dy": dy})),
            }
        }
    }
}

impl FlatWidget for NoteGame {
    fn init(&mut self, gpu: &Gpu, format: wgpu::TextureFormat) -> Result<()> {
        let output = ProgramOutput::with_options(
            gpu,
            self.logical,
            1.,
            format,
            wgpu::Color::TRANSPARENT,
            false,
        )?;
        output.register(&mut self.program)?;
        self.program
            .boot(Rc::new(Guest::new()?), "note", &self.bundle, &self.pak)?;
        self.bundle.clear();
        self.pak.clear();
        self.output = Some(output);
        self.format = format;
        Ok(())
    }

    fn tick(&mut self, _dt: f32, input: &Input, window_px: (u32, u32), scale: f64) -> Result<()> {
        self.scale = scale;
        if !self.booted {
            self.booted = true;
            self.send_hello();
        }

        // ⌘Q / ⌘W quit (the widget has no titlebar close button).
        if input.super_down()
            && (input.key_pressed(KeyCode::KeyQ) || input.key_pressed(KeyCode::KeyW))
        {
            self.exit = true;
        }
        // ⌘Z / ⇧⌘Z / ⌘C → guest editing chords (chars are suppressed
        // under ⌘, so chords travel as named keys).
        if input.super_down() && input.key_pressed(KeyCode::KeyZ) {
            let redo = input.key_down(KeyCode::ShiftLeft) || input.key_down(KeyCode::ShiftRight);
            self.svc(serde_json::json!({"t": "key", "k": if redo { "Redo" } else { "Undo" }}));
        }
        if input.super_down() && input.key_pressed(KeyCode::KeyC) {
            self.svc(serde_json::json!({"t": "key", "k": "Copy"}));
        }
        if input.super_down() && input.key_pressed(KeyCode::KeyX) {
            self.svc(serde_json::json!({"t": "key", "k": "Cut"}));
        }
        if input.super_down()
            && input.key_pressed(KeyCode::KeyV)
            && let Some(text) = clipboard_paste()
            && !text.is_empty()
        {
            self.ensure_text(&text);
            self.svc(serde_json::json!({"t": "paste", "text": text}));
        }
        if let Some(limit) = self.quit_after
            && self.ticks >= limit
        {
            self.exit = true;
        }

        // Window → core viewport. Live resizes relayout the core and tell
        // the app (which re-wraps against the new width).
        let logical = (
            ((window_px.0 as f64 / scale).round() as u32).max(1),
            ((window_px.1 as f64 / scale).round() as u32).max(1),
        );
        if logical != self.logical {
            self.configure_output(logical, window_px, scale as f32)?;
            self.logical = logical;
            self.svc(serde_json::json!({"t": "resize", "w": logical.0, "h": logical.1}));
        }

        // Keyboard / wheel / pointer → svc lines (logical px).
        self.forward_edits(input);
        self.forward_ime(input);
        let scroll = input.scroll();
        if scroll.y != 0.0 {
            self.svc(serde_json::json!({"t": "scroll", "dy": scroll.y / scale as f32}));
        }
        // Headless script events (windowed runs have none).
        if !self.script.is_empty() {
            self.run_script();
        }
        let script_down = self.ticks < self.script_click_until;
        // Down-edge OR level: a fast click can press AND release inside one
        // 60 Hz tick — level sampling alone would drop it entirely (the
        // guest would see no press, no CIRCLE, and a stale selection).
        let pressed_edge = input.mouse_button_pressed(winit::event::MouseButton::Left);
        let level_down = input.mouse_button_down(winit::event::MouseButton::Left) || script_down;
        let mouse_down = level_down || pressed_edge;

        // Pointer → svc: one line per (position, button) change, so the
        // guest sees press and release edges even without movement. A
        // release with the cursor gone reuses the last known position.
        let pos = if let Some((x0, y0, x1, y1, start)) = self.script_drag {
            let t = ((self.ticks.saturating_sub(start)) as f32 / DRAG_TICKS as f32).min(1.0);
            if t >= 1.0 && !script_down {
                self.script_drag = None;
                self.script_shift = false;
            }
            Some((x0 + (x1 - x0) * t, y0 + (y1 - y0) * t))
        } else {
            input
                .cursor()
                .map(|c| (c.x / scale as f32, c.y / scale as f32))
                .or(self.last_mouse.map(|(x, y, _)| (x, y)))
        };
        let shift = input.key_down(KeyCode::ShiftLeft)
            || input.key_down(KeyCode::ShiftRight)
            || self.script_shift;
        if let Some((x, y)) = pos {
            if pressed_edge && !level_down {
                // The whole click fit inside this tick: deliver both edges
                // in order so the guest still runs press → release.
                self.svc(serde_json::json!({"t": "mouse", "x": x, "y": y, "d": true, "sh": shift}));
                self.svc(
                    serde_json::json!({"t": "mouse", "x": x, "y": y, "d": false, "sh": shift}),
                );
                self.last_mouse = Some((x, y, false));
            } else {
                let m = (x, y, mouse_down);
                if self.last_mouse != Some(m) {
                    self.last_mouse = Some(m);
                    self.svc(
                        serde_json::json!({"t": "mouse", "x": x, "y": y, "d": mouse_down, "sh": shift}),
                    );
                }
            }
        }

        // The guest turn (Law 3: exactly one per tick). Clicks are CIRCLE —
        // hover already focused what's under the pointer.
        let buttons = if mouse_down { BTN_CIRCLE } else { 0 };
        let mut facts = InputFrameBuilder::new();
        facts.buttons = buttons;
        self.program.set_input(facts);
        self.program.advance()?;

        // Guest → host intents.
        for line in self.surface.svc_drain() {
            match serde_json::from_str::<serde_json::Value>(&line) {
                Ok(v) => match v["t"].as_str() {
                    Some("save") => self.save(v["text"].as_str().unwrap_or_default()),
                    Some("quit") => self.exit = true,
                    Some("menu") => self.guest_menu_open = v["open"].as_bool().unwrap_or(false),
                    Some("copy") => clipboard_copy(v["text"].as_str().unwrap_or_default()),
                    Some("caret") => {
                        self.caret_rect = Some((
                            v["x"].as_f64().unwrap_or(0.0) as f32,
                            v["y"].as_f64().unwrap_or(0.0) as f32,
                            1.0,
                            v["h"].as_f64().unwrap_or(20.0) as f32,
                        ));
                    }
                    other => log::warn!("note-widget: unknown intent {other:?}"),
                },
                Err(e) => log::warn!("note-widget: bad svc line from guest: {e}"),
            }
        }

        // Atlas uploads can change pixels without changing DrawList words.
        let (hash, revision) = self.surface.with_ui(|ui| {
            let hash = fnv1a64(&ui.draw().words);
            (hash, ui.raster_revision())
        });
        if hash != self.hash || revision != self.revision {
            log::debug!("note-widget: pixels changed at tick {}", self.ticks);
            self.hash = hash;
            self.revision = revision;
            self.dirty = true;
        }

        self.ticks += 1;
        Ok(())
    }

    fn take_dirty(&mut self) -> bool {
        std::mem::take(&mut self.dirty)
    }

    fn render(&mut self, gpu: &Gpu, view: &wgpu::TextureView, window_px: (u32, u32)) -> Result<()> {
        // Use the OS scale for rasterization, including mid-resize rounding.
        let scale = if self.scale > 0.0 {
            self.scale as f32
        } else {
            1.0
        };
        self.configure_output(self.logical, window_px, scale)?;
        let output = self.output.as_ref().expect("init ran");
        anyhow::ensure!(output.prepare()?, "note output leases exhausted");
        self.program.present()?;
        let target = output
            .last()
            .ok_or_else(|| anyhow!("note produced no target"))?;
        // Copy the premultiplied RGBA target into the transparent swapchain;
        // its alpha mode applies window composition after this submission.
        if let Some(blit) = &mut self.blit {
            blit.set_source(gpu, &target.view);
        } else {
            self.blit = Some(Blit::new(
                gpu,
                &target.view,
                self.format,
                wgpu::FilterMode::Nearest,
                false,
            ));
        }
        let blit = self.blit.as_ref().expect("blit initialized");
        let mut encoder = gpu.device.create_command_encoder(&Default::default());
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("note output"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
            });
            blit.draw(&mut pass);
        }
        gpu.queue.submit([encoder.finish()]);
        Ok(())
    }

    fn drag_at(&mut self, cursor: Vec2) -> bool {
        // The header is the move handle, minus the buttons on its right.
        // While the guest's menu is up, nothing is a drag region — clicks
        // must reach the backdrop so it can close.
        if self.guest_menu_open {
            return false;
        }
        let (x, y) = (cursor.x / self.scale as f32, cursor.y / self.scale as f32);
        y < HEADER_H && x < self.logical.0 as f32 - HEADER_BUTTONS_W
    }

    fn resize_at(&mut self, cursor: Vec2) -> bool {
        if self.guest_menu_open {
            return false;
        }
        let (x, y) = (cursor.x / self.scale as f32, cursor.y / self.scale as f32);
        x > self.logical.0 as f32 - GRIP && y > self.logical.1 as f32 - GRIP
    }

    fn ime_cursor_area(&mut self) -> Option<(f32, f32, f32, f32)> {
        let s = self.scale as f32;
        self.caret_rect
            .map(|(x, y, w, h)| (x * s, y * s, w * s, h * s))
    }

    fn wants_exit(&self) -> bool {
        self.exit
    }
}

/// Put text on the system clipboard. pbcopy is the zero-dependency macOS
/// road; other platforms just log (the widget shell is macOS-first).
fn clipboard_copy(text: &str) {
    if text.is_empty() {
        return;
    }
    #[cfg(target_os = "macos")]
    {
        use std::io::Write;
        use std::process::{Command, Stdio};
        let child = Command::new("pbcopy").stdin(Stdio::piped()).spawn();
        match child {
            Ok(mut child) => {
                if let Some(stdin) = child.stdin.as_mut() {
                    let _ = stdin.write_all(text.as_bytes());
                }
                let _ = child.wait();
                log::info!("note-widget: copied {} bytes", text.len());
            }
            Err(e) => log::warn!("note-widget: pbcopy failed: {e}"),
        }
    }
    #[cfg(not(target_os = "macos"))]
    log::warn!("note-widget: clipboard copy unsupported on this platform");
}

/// Read the system clipboard (pbpaste — the macOS counterpart of copy).
fn clipboard_paste() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        match std::process::Command::new("pbpaste").output() {
            Ok(out) => Some(String::from_utf8_lossy(&out.stdout).into_owned()),
            Err(e) => {
                log::warn!("note-widget: pbpaste failed: {e}");
                None
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        log::warn!("note-widget: clipboard paste unsupported on this platform");
        None
    }
}

/// FNV-1a 64 over the DrawList words (embed.rs's dirty signal).
fn fnv1a64(words: &[u32]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for w in words {
        for b in w.to_le_bytes() {
            h ^= b as u64;
            h = h.wrapping_mul(0x0000_0100_0000_01b3);
        }
    }
    h
}

// ---------------------------------------------------------------------------
// boot + CLI
// ---------------------------------------------------------------------------

struct Args {
    app: String,
    js: Option<PathBuf>,
    pak: Option<PathBuf>,
    file: Option<PathBuf>,
    size: (u32, u32),
    density: u32,
    screenshot: Option<PathBuf>,
    frames: u64,
    script: Vec<(u64, ScriptEvent)>,
    auto_quit: Option<f32>,
}

fn parse_args() -> Result<Args> {
    let mut args = Args {
        app: "note-main".into(),
        js: None,
        pak: None,
        file: None,
        size: (420, 560),
        density: 2,
        screenshot: None,
        frames: 40,
        script: Vec::new(),
        auto_quit: None,
    };
    let mut it = std::env::args().skip(1);
    while let Some(a) = it.next() {
        let mut val = |name: &str| -> Result<String> {
            it.next().ok_or_else(|| anyhow!("{name} needs a value"))
        };
        /// `spec@frame` → (frame, spec).
        fn at(v: &str, flag: &str) -> Result<(u64, String)> {
            let (spec, frame) = v
                .rsplit_once('@')
                .ok_or_else(|| anyhow!("{flag} wants value@frame"))?;
            Ok((frame.parse()?, spec.to_string()))
        }
        match a.as_str() {
            "--app" => args.app = val("--app")?,
            "--js" => args.js = Some(PathBuf::from(val("--js")?)),
            "--pak" => args.pak = Some(PathBuf::from(val("--pak")?)),
            "--file" => args.file = Some(PathBuf::from(val("--file")?)),
            "--width" => args.size.0 = val("--width")?.parse()?,
            "--height" => args.size.1 = val("--height")?.parse()?,
            "--density" => args.density = val("--density")?.parse()?,
            "--screenshot" => args.screenshot = Some(PathBuf::from(val("--screenshot")?)),
            "--frames" => args.frames = val("--frames")?.parse()?,
            "--click" => {
                let (frame, spec) = at(&val("--click")?, "--click")?;
                let (x, y) = spec
                    .split_once(',')
                    .ok_or_else(|| anyhow!("--click wants x,y@frame"))?;
                args.script.push((
                    frame,
                    ScriptEvent::Click(x.trim().parse()?, y.trim().parse()?),
                ));
            }
            "--shift-click" => {
                let (frame, spec) = at(&val("--shift-click")?, "--shift-click")?;
                let (x, y) = spec
                    .split_once(',')
                    .ok_or_else(|| anyhow!("--shift-click wants x,y@frame"))?;
                args.script.push((
                    frame,
                    ScriptEvent::ShiftClick(x.trim().parse()?, y.trim().parse()?),
                ));
            }
            "--drag" => {
                let (frame, spec) = at(&val("--drag")?, "--drag")?;
                let (from, to) = spec
                    .split_once('-')
                    .ok_or_else(|| anyhow!("--drag wants x0,y0-x1,y1@frame"))?;
                let (x0, y0) = from
                    .split_once(',')
                    .ok_or_else(|| anyhow!("--drag wants x0,y0-x1,y1@frame"))?;
                let (x1, y1) = to
                    .split_once(',')
                    .ok_or_else(|| anyhow!("--drag wants x0,y0-x1,y1@frame"))?;
                args.script.push((
                    frame,
                    ScriptEvent::Drag(
                        x0.trim().parse()?,
                        y0.trim().parse()?,
                        x1.trim().parse()?,
                        y1.trim().parse()?,
                    ),
                ));
            }
            "--type" => {
                let (frame, s) = at(&val("--type")?, "--type")?;
                args.script.push((frame, ScriptEvent::Type(s)));
            }
            "--key" => {
                let (frame, k) = at(&val("--key")?, "--key")?;
                args.script.push((frame, ScriptEvent::Key(k)));
            }
            "--paste" => {
                let (frame, text) = at(&val("--paste")?, "--paste")?;
                args.script.push((frame, ScriptEvent::Paste(text)));
            }
            "--preedit" => {
                let (frame, text) = at(&val("--preedit")?, "--preedit")?;
                args.script.push((frame, ScriptEvent::Preedit(text)));
            }
            "--scroll" => {
                let (frame, dy) = at(&val("--scroll")?, "--scroll")?;
                args.script.push((frame, ScriptEvent::Scroll(dy.parse()?)));
            }
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
    let candidates = [format!("{app}.{ext}"), format!("{app}-main.{ext}")];
    for c in &candidates {
        let p = dist.join(c);
        if p.is_file() {
            return Ok(p);
        }
    }
    Err(anyhow!(
        "no {ext} for app '{app}' in {} — build it first: bun tools/build.ts {app} --density=2",
        dist.display()
    ))
}

fn note_file(explicit: Option<PathBuf>) -> PathBuf {
    explicit.unwrap_or_else(|| {
        let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
        Path::new(&home).join(".pocket-note.md")
    })
}

/// Stage raw inputs; init registers the display before runtime boot.
fn boot(args: &Args) -> Result<(UiProgram, String, Vec<u8>)> {
    let js_path = resolve_asset(args.js.clone(), &args.app, "js")?;
    let pak_path = resolve_asset(args.pak.clone(), &args.app, "pak")?;
    let bundle = std::fs::read_to_string(&js_path)
        .with_context(|| format!("reading {}", js_path.display()))?;
    let pak =
        std::fs::read(&pak_path).with_context(|| format!("reading {}", pak_path.display()))?;

    let program = UiProgram::new(ProgramConfig {
        host: "macos-widget",
        host_abi: 3,
        logical: [args.size.0, args.size.1],
        density: args.density,
        scale: 1,
        tick_hz: 60,
        heap_limit: 64 * 1024 * 1024,
        frame_buffer_budget: 128 * 1024 * 1024,
    })?;
    program.surface().set_svc_allowlist(["note"]);
    Ok((program, bundle, pak))
}

fn main() -> Result<()> {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    let mut args = parse_args()?;
    let (program, bundle, pak) = boot(&args)?;
    let atlases = cjk::CjkAtlases::from_pak(&pak);
    let mut game = NoteGame::new(
        program,
        bundle,
        pak,
        atlases,
        note_file(args.file.clone()),
        args.size,
    );
    game.script = std::mem::take(&mut args.script);
    game.quit_after = args.auto_quit.map(|s| (s * 60.0) as u64);

    if let Some(out) = args.screenshot.clone() {
        headless(game, args, &out)
    } else {
        pocket_widget::run_flat(
            WidgetConfig {
                title: "Pocket Note".into(),
                size: args.size,
                resizable: true,
                min_size: (240, 180),
                ime: true,
                ..Default::default()
            },
            game,
        )
    }
}

/// Headless: N fixed ticks at 1x scale (logical == physical), scripted svc
/// events, then one PNG at density scale. No window required.
fn headless(mut game: NoteGame, args: Args, out: &std::path::Path) -> Result<()> {
    let gpu = Gpu::new_headless()?;
    game.init(&gpu, OFFSCREEN_FORMAT)?;
    let mut input = Input::default();
    let px = (args.size.0, args.size.1);
    for _ in 0..args.frames {
        game.tick(1.0 / 60.0, &input, px, 1.0)?;
        input.end_frame();
    }
    let scale = args.density.max(1);
    let (w, h) = (args.size.0 * scale, args.size.1 * scale);
    let target = OffscreenTarget::new(&gpu, w, h);
    game.take_dirty();
    game.scale = scale as f64;
    game.render(&gpu, &target.view, (w, h))?;
    target.save_png(&gpu, out)?;
    println!(
        "note-widget: wrote {} after {} frames ({}x{} @{}x)",
        out.display(),
        args.frames,
        w,
        h,
        scale
    );
    Ok(())
}
