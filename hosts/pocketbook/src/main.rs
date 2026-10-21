//! pocketbook-host — the PocketJS UI runtime on PocketBook e-readers.
//!
//! Reuses the backend-agnostic `ui` surface (`pocket_ui_surface::UiSurface`)
//! and the core's software rasterizer, then blits the frame as RGB24 (inkview
//! converts to gray on grayscale panels, writes RGB on color panels). See
//! `docs/IMPLEMENTATION.md` in this directory for the full design and the
//! ground-truth API notes.
//!
//! Event-loop model (mirrors `inkview-slint`): `iv_main` runs on the main
//! thread forwarding every `Event` into an mpsc channel; a second thread owns
//! the `Screen` and the PocketJS tick/render loop, pulling events with a
//! timeout so it ticks on a fixed cadence even when idle.

mod display;
mod framebuffer;
mod input;
mod refresh;

use std::sync::mpsc;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use inkview::Event;
use pocket_mod::Guest;
use pocket_ui_surface::{ProgramConfig, UiProgram};
use std::{cell::RefCell, rc::Rc};

use framebuffer::DirtyRect;

/// Host platform-contract identity. Must match `pocketbook.hostAbi` in
/// contracts/spec/platforms.ts, or plan-built bundles refuse this host
/// (framework/src/host.ts::assertNativeHostContract).
const HOST_ID: &str = "pocketbook";
const HOST_ABI: u32 = 5;

/// Logical tick cadence. E-ink doesn't need 60 fps; ~30 fps keeps animations
/// smooth while sparing CPU and battery.
const PRESENT_HZ: u32 = 30;

/// Logical viewport the pocketbook target profile bakes bundles for
/// (contracts/spec/platforms.ts). Must match the bundle: the framework lays
/// the app out for this size, so the host presents exactly it.
const LOGICAL_W: u32 = 480;
const LOGICAL_H: u32 = 272;
/// Raster density the target profile bakes font atlases/images at; the host
/// must render at the same density for crisp output. 480×272 also stays
/// ≤511 px/axis, keeping touch coordinates inside the 9-bit wire format
/// (framework/src/touch.ts).
const DENSITY: u32 = 2;

fn main() -> Result<()> {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    // &'static Inkview so both the render thread (Screen::new) and the main
    // thread (iv_main) can reference it — same pattern as the slint demo.
    let iv: &'static inkview::bindings::Inkview = Box::leak(Box::new(inkview::load()));

    let (tx, rx) = mpsc::channel::<Event>();

    let render = std::thread::spawn(move || run(iv, rx));

    // Main thread: the inkview event loop. Forward every event to the render
    // thread; if it has gone away (send fails), ask inkview to close the app.
    inkview::iv_main(iv, move |ev| {
        if tx.send(ev).is_err() {
            // SAFETY: the render thread owns the only other use of `iv` and has
            // dropped its receiver (send failed), so it is quiescent; CloseApp
            // only asks inkview to tear down its main loop. Mirrors the
            // inkview-slint demo's shutdown path.
            unsafe {
                iv.CloseApp();
            }
        }
        Some(())
    });

    render
        .join()
        .map_err(|_| anyhow::anyhow!("render thread panicked"))?
}

/// The render thread: boot the guest, then tick/render until Exit.
fn run(iv: &'static inkview::bindings::Inkview, rx: mpsc::Receiver<Event>) -> Result<()> {
    // inkview delivers Init first; wait for it before touching the framebuffer.
    if rx.recv().context("event channel closed before Init")? != Event::Init {
        anyhow::bail!("expected EVT_INIT first");
    }

    let screen = inkview::screen::Screen::new(iv);
    let phys_w = screen.width();
    let phys_h = screen.height();

    let geo = Geometry::for_panel(phys_w, phys_h);
    log::info!(
        "pocketbook: panel {phys_w}x{phys_h}, logical {}x{} @{}x, render {}x{} → disp {}x{} +({},{})",
        geo.logical_w,
        geo.logical_h,
        geo.density,
        geo.render_w,
        geo.render_h,
        geo.disp_w,
        geo.disp_h,
        geo.ox,
        geo.oy
    );

    // Boot the guest exactly like uihost: feed pak, mount ui, eval bundle.
    let pak = std::fs::read(pak_path()).with_context(|| format!("reading {}", pak_path()))?;
    let bundle =
        std::fs::read_to_string(js_path()).with_context(|| format!("reading {}", js_path()))?;

    let mut program = UiProgram::new(ProgramConfig {
        profile: pocket_ui_surface::program_profile::from_build_inputs(
            option_env!("POCKETJS_PROFILE_JSON"),
            option_env!("POCKETJS_PROFILE_HASH"),
        )
        .map_err(|error| anyhow::anyhow!("profile: {error:?}"))?,
        host: HOST_ID,
        host_abi: HOST_ABI,
        logical: [geo.logical_w as u32, geo.logical_h as u32],
        density: geo.density,
        scale: geo.density,
        tick_hz: 60,
        heap_limit: 64 * 1024 * 1024,
        frame_buffer_budget: geo.render_w * geo.render_h * 4,
    })?;
    let mut input = input::Input::new(
        geo.ox as i32,
        geo.oy as i32,
        geo.logical_w as u32,
        geo.logical_h as u32,
        geo.disp_w as u32,
        geo.disp_h as u32,
    );

    let panel = Rc::new(RefCell::new(display::Panel {
        screen,
        refresh: refresh::Refresh::new(),
        geometry: geo,
        full: true,
        flushes: 0,
    }));
    program.add_display(
        display::Display::new(panel.clone()),
        pocket_runtime::RendererId::SOFTWARE,
    )?;
    program.boot(Rc::new(Guest::new()?), "app", &bundle, &pak)?;
    let started = Instant::now();
    let mut schedule = pocket_runtime::timing::TickSchedule::new(PRESENT_HZ, 0, 1)
        .map_err(|error| anyhow::anyhow!("tick schedule: {error:?}"))?;
    schedule
        .poll(0)
        .map_err(|error| anyhow::anyhow!("tick timing: {error:?}"))?;
    tick(&mut program, &panel, &input, true)?;
    loop {
        // Pull events until the tick deadline, then drain any burst.
        let deadline = started
            + Duration::from_micros(
                schedule
                    .deadline()
                    .map_err(|error| anyhow::anyhow!("tick deadline: {error:?}"))?,
            );
        let mut quit = false;
        let mut full = false;
        loop {
            let now = Instant::now();
            if now >= deadline {
                break;
            }
            match rx.recv_timeout(deadline - now) {
                Ok(ev) => match input.on_event(ev) {
                    input::Outcome::Quit => {
                        quit = true;
                        break;
                    }
                    input::Outcome::FullRedraw => full = true,
                    input::Outcome::Continue => {}
                },
                Err(mpsc::RecvTimeoutError::Timeout) => break,
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    quit = true;
                    break;
                }
            }
        }
        while let Ok(ev) = rx.try_recv() {
            match input.on_event(ev) {
                input::Outcome::Quit => quit = true,
                input::Outcome::FullRedraw => full = true,
                input::Outcome::Continue => {}
            }
        }
        if quit {
            break;
        }

        if schedule
            .poll(started.elapsed().as_micros() as u64)
            .map_err(|error| anyhow::anyhow!("tick timing: {error:?}"))?
            .is_none()
        {
            continue;
        }
        tick(&mut program, &panel, &input, full)?;
    }
    Ok(())
}

/// Submit device facts, let Runtime drive the guest/core, and present through
/// the registered raster/display pair. Idle frames still service e-ink cleanup.
fn tick(
    program: &mut UiProgram,
    panel: &Rc<RefCell<display::Panel>>,
    input: &input::Input,
    full: bool,
) -> Result<()> {
    panel.borrow_mut().full |= full;
    let before = panel.borrow().flushes;
    program.set_input(input.snapshot());
    program.advance()?;
    program.present()?;
    if panel.borrow().flushes == before {
        panel.borrow_mut().idle();
    }
    Ok(())
}

/// Render-buffer rects → screen rects via the geometry mapping.
fn offset_rects(rects: &[DirtyRect], geo: &Geometry) -> Vec<DirtyRect> {
    rects
        .iter()
        .map(|r| {
            let (sx, sy, sw, sh) = geo.render_rect_to_screen(r.x, r.y, r.w, r.h);
            DirtyRect {
                x: sx,
                y: sy,
                w: sw,
                h: sh,
            }
        })
        .collect()
}

/// Logical-viewport / raster-density geometry for the current panel.
struct Geometry {
    logical_w: usize,
    logical_h: usize,
    density: u32,
    render_w: usize,
    render_h: usize,
    /// Displayed width on the panel after scale-to-fit (≤ render_w).
    disp_w: usize,
    /// Displayed height on the panel after scale-to-fit (≤ render_h).
    disp_h: usize,
    /// Horizontal centering offset on the panel.
    ox: usize,
    /// Vertical centering offset on the panel.
    oy: usize,
}

impl Geometry {
    /// Present the bundle's fixed 480×272 @2x surface (a 960×544 render) on
    /// the actual panel. When the render fits, it is integer-centered. When it
    /// doesn't (e.g. a 960-wide render on a 758-wide portrait panel like the
    /// Verse), it is nearest-neighbor scaled down to fit and then centered.
    /// The logical viewport and density are fixed to match the pocketbook
    /// target profile (and stay ≤511/axis, so touch coordinates fit the 9-bit
    /// wire format).
    fn for_panel(phys_w: usize, phys_h: usize) -> Self {
        let logical_w = LOGICAL_W as usize;
        let logical_h = LOGICAL_H as usize;
        let render_w = logical_w * DENSITY as usize;
        let render_h = logical_h * DENSITY as usize;

        let (disp_w, disp_h) = if render_w <= phys_w && render_h <= phys_h {
            (render_w, render_h)
        } else {
            // Scale down to fit: pick the binding axis.
            // Compare phys_w/render_w vs phys_h/render_h without floats:
            //   phys_w * render_h < phys_h * render_w  →  width binds
            if phys_w * render_h < phys_h * render_w {
                let dw = phys_w;
                let dh = (render_h * phys_w) / render_w;
                (dw, dh.max(1))
            } else {
                let dh = phys_h;
                let dw = (render_w * phys_h) / render_h;
                (dw.max(1), dh)
            }
        };

        let ox = phys_w.saturating_sub(disp_w) / 2;
        let oy = phys_h.saturating_sub(disp_h) / 2;
        Self {
            logical_w,
            logical_h,
            density: DENSITY,
            render_w,
            render_h,
            disp_w,
            disp_h,
            ox,
            oy,
        }
    }

    /// Map a panel x coordinate back to a render-buffer x coordinate.
    #[inline]
    fn screen_to_render_x(&self, sx: usize) -> usize {
        (sx.saturating_sub(self.ox)) * self.render_w / self.disp_w
    }

    /// Map a panel y coordinate back to a render-buffer y coordinate.
    #[inline]
    fn screen_to_render_y(&self, sy: usize) -> usize {
        (sy.saturating_sub(self.oy)) * self.render_h / self.disp_h
    }

    /// Conservatively map a render-buffer rect to the screen rect that covers
    /// every panel pixel sampling from within it.
    fn render_rect_to_screen(
        &self,
        rx: usize,
        ry: usize,
        rw: usize,
        rh: usize,
    ) -> (usize, usize, usize, usize) {
        let sx_min = (rx * self.disp_w).div_ceil(self.render_w) + self.ox;
        let sy_min = (ry * self.disp_h).div_ceil(self.render_h) + self.oy;
        let sx_max = ((rx + rw) * self.disp_w - 1) / self.render_w + self.ox;
        let sy_max = ((ry + rh) * self.disp_h - 1) / self.render_h + self.oy;
        (sx_min, sy_min, sx_max - sx_min + 1, sy_max - sy_min + 1)
    }
}

fn pak_path() -> String {
    std::env::var("POCKET_PAK").unwrap_or_else(|_| "app.pak".into())
}

fn js_path() -> String {
    std::env::var("POCKET_JS").unwrap_or_else(|_| "app.js".into())
}
