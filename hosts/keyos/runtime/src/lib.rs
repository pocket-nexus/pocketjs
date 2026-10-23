//! pocketjs-keyos-runtime — one PocketJS app as KeyOS presents it.
//!
//! [`Runtime`] owns the QuickJS guest and the retained UI core. Each
//! [`Runtime::step`] runs one guest turn with the latched touch contacts,
//! ticks the core, builds the DrawList and plans its damage against the
//! previous one. [`Runtime::paint_rows`] rasterizes a window of the current
//! DrawList into full-width rows. [`Presenter`] decides which regions a lent
//! framebuffer needs: gui-server rotates buffers, so a lent one can be several
//! frames old. Nothing here depends on the KeyOS SDK, so the preview example
//! runs the same code on the development machine.

mod contacts;
#[cfg(target_os = "xous")]
mod libc;
mod present;

use std::time::{Duration, Instant};

use anyhow::{Context, Result, anyhow, ensure};
use pocket_mod::Guest;
use pocket_ui_surface::UiSurface;
use pocketjs_core::damage::{DamagePolicy, DamageTarget, DamageTracker};
use pocketjs_core::raster;

pub use contacts::{MAX_CONTACTS, Phase};
pub use pocketjs_core;
pub use pocketjs_core::damage::DamageRect;
pub use present::Presenter;

/// Damage rectangles one frame may carry before the planner merges them.
pub const DAMAGE_REGIONS: usize = 16;

/// QuickJS's cycle collector visits every object: about 1.3 s for Pocket
/// Clear's 105,000 objects on Passport Prime. By default it runs whenever the
/// heap grows by half since the last collection, which during boot means a
/// collection at every 1.5x step of a growing heap, and later a stall in
/// the middle of whatever turn crosses the line. Boot runs under this
/// threshold instead; afterwards the guest may grow by `GC_HEADROOM` before a
/// turn collects, and hosts collect while the app is hidden
/// ([`Runtime::collect_garbage`]).
const BOOT_GC_THRESHOLD: usize = 16 << 20;
const GC_HEADROOM: usize = 8 << 20;

/// Damage planning signature of the DrawList snapshot (the pixels themselves
/// live in the buffers gui-server lends).
const DAMAGE_SIGNATURE: u64 = u32::from_be_bytes(*b"KYOS") as u64;

/// Byte order of a 32-bit pixel in the frame.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PixelOrder {
    /// R, G, B, A (the hosted simulator's framebuffer).
    Rgba,
    /// B, G, R, A (Passport Prime's framebuffer).
    Bgra,
}

/// The surface an app is built for: its host contract and geometry.
#[derive(Clone, Copy, Debug)]
pub struct Config<'a> {
    pub host_id: &'a str,
    pub host_abi: u32,
    /// Logical viewport.
    pub width: u32,
    pub height: u32,
    /// Physical pixels per logical pixel.
    pub density: u32,
    /// Virtual-time ticks per second the bundle bakes.
    pub tick_hz: u32,
    pub order: PixelOrder,
}

/// Wall time one [`Runtime::step`] spent in each phase.
#[derive(Clone, Copy, Debug, Default)]
pub struct StepTiming {
    pub guest: Duration,
    pub tick: Duration,
    /// Building the DrawList and planning its damage.
    pub draw: Duration,
}

/// The logical regions one [`Runtime::step`] changed.
#[derive(Clone, Debug, Default)]
pub struct Step {
    pub regions: Vec<DamageRect>,
    pub timing: StepTiming,
}

impl Step {
    pub fn area(&self) -> u64 {
        self.regions.iter().map(|r| r.area()).sum()
    }
}

pub struct Runtime {
    guest: Guest,
    surface: UiSurface,
    contacts: contacts::Contacts,
    touches: Vec<u32>,
    tracker: DamageTracker<DAMAGE_REGIONS>,
    order: PixelOrder,
    width: u32,
    height: u32,
    density: u32,
}

impl Runtime {
    /// Boot the guest the way every native host does: feed the pak, mount
    /// `ui`, evaluate the bundle.
    pub fn boot(config: &Config, bundle: &str, pak: &[u8]) -> Result<Runtime> {
        let surface = UiSurface::new_with_density(
            (config.width as f32, config.height as f32),
            config.density,
        );
        surface.set_identity(config.host_id, config.host_abi);
        ensure!(
            surface.set_tick_rate(config.tick_hz),
            "the core rejected tick rate {}",
            config.tick_hz
        );
        surface.feed_pak(pak);
        let guest = Guest::new()?;
        guest.set_gc_threshold(BOOT_GC_THRESHOLD);
        surface.mount(&guest)?;
        guest.eval("app", bundle).context("evaluating the app bundle")?;
        ensure!(guest.has_frame(), "the bundle installed no frame()");
        let heap = guest.memory_usage().malloc_size.max(0) as usize;
        guest.set_gc_threshold(heap + GC_HEADROOM);
        let (pw, ph) = (config.width * config.density, config.height * config.density);
        Ok(Runtime {
            guest,
            surface,
            contacts: contacts::Contacts::default(),
            touches: Vec::with_capacity(MAX_CONTACTS),
            tracker: DamageTracker::new(),
            order: config.order,
            width: pw,
            height: ph,
            density: config.density,
        })
    }

    /// Physical size of the surface.
    pub fn size(&self) -> (u32, u32) {
        (self.width, self.height)
    }

    /// Physical pixels per logical pixel.
    pub fn density(&self) -> u32 {
        self.density
    }

    /// The whole logical surface as a region.
    pub fn bounds(&self) -> DamageRect {
        DamageRect::new(0, 0, (self.width / self.density) as i32, (self.height / self.density) as i32)
    }

    /// Rasterize the logical `window` of the current DrawList into `rows`:
    /// the full-width physical rows the window spans, four bytes per pixel in
    /// the configured order. Columns outside the window keep their bytes.
    pub fn paint_rows(&self, window: DamageRect, rows: &mut [u8]) {
        let (order, scale) = (self.order, self.density);
        self.surface.with_ui(|ui| {
            let words = &ui.current_draw_list().words;
            match order {
                PixelOrder::Rgba => raster::render_scaled_rows(&*ui, words, rows, scale, window),
                PixelOrder::Bgra => raster::render_scaled_argb_rows(&*ui, words, rows, scale, window),
            }
        });
    }

    /// Record a touch event at physical surface coordinates.
    pub fn touch(&mut self, phase: Phase, platform_id: usize, x: i32, y: i32) {
        let d = self.density as i32;
        let (w, h) = ((self.width / self.density) as i32, (self.height / self.density) as i32);
        let (x, y) = (x.div_euclid(d), y.div_euclid(d));
        self.contacts.event(phase, platform_id, x, y, w, h);
    }

    /// Release every contact.
    pub fn cancel_touches(&mut self) {
        self.contacts.cancel();
    }

    /// Run the guest's cycle collector and let the heap grow by
    /// `GC_HEADROOM` from what survives before a turn collects again. Hosts
    /// call it while the app is not visible.
    pub fn collect_garbage(&self) {
        self.guest.collect_garbage();
        let heap = self.guest.memory_usage().malloc_size.max(0) as usize;
        self.guest.set_gc_threshold(heap + GC_HEADROOM);
    }

    /// The guest realm (garbage collection, memory statistics).
    pub fn guest(&self) -> &Guest {
        &self.guest
    }

    /// Borrow the UI core (DrawList, hit testing, resources).
    pub fn with_ui<R>(&self, f: impl FnOnce(&mut pocketjs_core::Ui) -> R) -> R {
        self.surface.with_ui(f)
    }

    /// Repaint the whole frame on the next step.
    pub fn invalidate(&mut self) {
        self.tracker.invalidate();
    }

    /// One fixed-step frame: guest turn, core tick, DrawList and its damage
    /// against the previous step's DrawList.
    pub fn step(&mut self) -> Result<Step> {
        let started = Instant::now();
        self.contacts.sample(&mut self.touches);
        self.guest
            .frame_with_touches(0, pocketjs_core::spec::ANALOG_CENTER, &self.touches)?;
        let guest = started.elapsed();

        let ticked = Instant::now();
        self.surface.tick();
        let tick = ticked.elapsed();

        let drawn = Instant::now();
        let target = DamageTarget::new(self.width, self.height, self.density, DAMAGE_SIGNATURE);
        let tracker = &mut self.tracker;
        let plan = self.surface.with_ui(|ui| {
            ui.draw();
            let words = &ui.current_draw_list().words;
            let plan = tracker
                .prepare(&*ui, words, target)
                .and_then(|plan| plan.with_policy(DamagePolicy::default()));
            if plan.is_ok() {
                tracker.commit(&*ui, words, target);
            }
            plan
        });
        let plan = plan.map_err(|e| anyhow!("damage planning failed: {e:?}"))?;
        Ok(Step {
            regions: plan.regions().to_vec(),
            timing: StepTiming { guest, tick, draw: drawn.elapsed() },
        })
    }
}
