//! MicroTS Hero running in the retained PocketJS core on Nintendo DS ARM9.
#![no_std]
#![feature(alloc_error_handler)]

extern crate alloc;

mod allocator;

use alloc::{boxed::Box, vec, vec::Vec};
use microts::{Host, Input, NodeId, Ui};
use pocketjs_core::{
    damage::{DamagePolicy, DamageTracker},
    pak, raster, spec,
};

include!(concat!(env!("OUT_DIR"), "/guest.rs"));

pub const WIDTH: usize = 256;
pub const HEIGHT: usize = 192;
pub const TICK_HZ: u32 = 30;

extern "C" {
    fn pocket_nds_clock_ticks() -> u32;
}

fn clock_ticks() -> u32 {
    unsafe { pocket_nds_clock_ticks() }
}

pub struct NdsHost(Ui);
impl Host for NdsHost {
    fn ui(&self) -> &Ui {
        &self.0
    }
    fn ui_mut(&mut self) -> &mut Ui {
        &mut self.0
    }
    fn into_ui(self) -> Ui {
        self.0
    }
}
macro_rules! button_support {
    ($($button:ident),+ $(,)?) => {
        $(impl microts::HasButton<{ spec::btn::$button }> for NdsHost {})+
    };
}
button_support!(
    CIRCLE, CROSS, TRIANGLE, SQUARE, SELECT, START, UP, DOWN, LEFT, RIGHT, LTRIGGER, RTRIGGER,
);
impl microts::HasButtons for NdsHost {}
impl microts::HasTouch for NdsHost {}

/// ABI shared with include/pocket_nds.h; all counts are 32-bit on every host.
#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct FrameStats {
    pub frames: u32,
    pub draw_words: u32,
    pub focused: i32,
    pub counter: u32,
    pub damage_pixels: u32,
    pub damage_regions: u32,
    pub update_ticks: u32,
    pub draw_ticks: u32,
    pub raster_ticks: u32,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct DamageRect {
    pub x0: u16,
    pub y0: u16,
    pub x1: u16,
    pub y1: u16,
}

pub struct NdsApp {
    app: generated::AppApp<generated::AppModel, NdsHost>,
    pixels: Vec<u16>,
    damage: DamageTracker<8>,
    damage_rects: [DamageRect; 8],
    counter_text: i32,
    touch_down: bool,
    touch_target: NodeId,
    stats: FrameStats,
}

impl NdsApp {
    pub fn new() -> Option<Self> {
        let mut ui = Ui::new();
        if !ui.core_mut().set_tick_rate(TICK_HZ) {
            return None;
        }
        ui.core_mut().set_viewport(WIDTH as f32, HEIGHT as f32);
        if !ui.load_styles(STYLES) {
            return None;
        }
        let mut fonts = 0;
        for entry in pak::entries(ASSETS) {
            if entry.key.starts_with("ui:font.") {
                if !ui.core_mut().load_font_atlas(entry.blob) {
                    return None;
                }
                fonts += 1;
            } else if let Some(name) = entry.key.strip_prefix("ui:img.") {
                let texture = ui.core_mut().upload_img_entry(entry.blob);
                if texture < 0 {
                    return None;
                }
                ui.register_image(name, texture);
            }
        }
        if fonts == 0 {
            return None;
        }
        let app = generated::AppApp::new(
            NdsHost(ui),
            generated::AppProps {},
            generated::AppModel::default(),
        );
        Some(Self {
            app,
            pixels: vec![0; WIDTH * HEIGHT],
            damage: DamageTracker::new(),
            damage_rects: [DamageRect::default(); 8],
            counter_text: -1,
            touch_down: false,
            touch_target: NodeId::NONE,
            stats: FrameStats::default(),
        })
    }

    /// Touch coordinates below zero mean no contact. A contact captures its
    /// containing action at the down edge; dragging never repeats activation.
    pub fn frame(&mut self, buttons: u32, touch_x: i32, touch_y: i32) -> bool {
        let start = clock_ticks();
        let touching =
            (0..WIDTH as i32).contains(&touch_x) && (0..HEIGHT as i32).contains(&touch_y);
        let mut input = Input::buttons(buttons);
        if touching && !self.touch_down {
            self.touch_target = self
                .app
                .ui_mut()
                .touch_target(touch_x as f32, touch_y as f32);
            if self.touch_target != NodeId::NONE {
                self.app.ui_mut().set_focus(self.touch_target);
                input.target = self.touch_target;
            }
        }
        // CIRCLE holds the same active style for touch and the physical A key.
        if touching && self.touch_target != NodeId::NONE {
            input.buttons |= spec::btn::CIRCLE;
        }
        if !touching {
            self.touch_target = NodeId::NONE;
        }
        self.touch_down = touching;
        self.app.frame(&input);
        let updated = clock_ticks();
        let ui = self.app.ui_mut().core_mut();
        ui.draw();
        let drawn = clock_ticks();
        let words = &ui.current_draw_list().words;
        let Ok(plan) = raster::render_scaled_rgb565_incremental(
            ui,
            words,
            &mut self.pixels,
            1,
            &mut self.damage,
            DamagePolicy::default(),
        ) else {
            return false;
        };
        let rasterized = clock_ticks();
        self.stats.frames = self.stats.frames.wrapping_add(1);
        self.stats.draw_words = words.len() as u32;
        self.stats.focused = ui.focused();
        self.stats.damage_pixels = plan.regions().iter().map(|rect| rect.area() as u32).sum();
        self.stats.damage_regions = plan.region_count() as u32;
        for (target, source) in self.damage_rects.iter_mut().zip(plan.regions()) {
            *target = DamageRect {
                x0: source.x0 as u16,
                y0: source.y0 as u16,
                x1: source.x1 as u16,
                y1: source.y1 as u16,
            };
        }
        self.stats.update_ticks = updated.wrapping_sub(start);
        self.stats.draw_ticks = drawn.wrapping_sub(updated);
        self.stats.raster_ticks = rasterized.wrapping_sub(drawn);
        self.stats.counter = self.counter();
        true
    }

    /// Read the rendered counter, so emulator diagnostics verify the view as
    /// well as the model dispatch. The guest marks this text with a debug name.
    fn counter(&mut self) -> u32 {
        fn counter_text(ui: &Ui, node: i32) -> Option<i32> {
            if ui
                .core()
                .node_text(node)
                .and_then(|text| text.strip_prefix("Count: "))
                .is_some()
            {
                return Some(node);
            }
            ui.core()
                .node_children(node)
                .iter()
                .find_map(|child| counter_text(ui, *child))
        }
        fn visit(ui: &Ui, node: i32) -> Option<i32> {
            if ui.debug_name(NodeId(node)) == Some("HeroCounter") {
                return counter_text(ui, node);
            }
            ui.core()
                .node_children(node)
                .iter()
                .find_map(|child| visit(ui, *child))
        }
        if self.counter_text < 0 {
            self.counter_text = visit(self.app.ui(), NodeId::ROOT.0).unwrap_or(-1);
        }
        self.app
            .ui()
            .core()
            .node_text(self.counter_text)
            .and_then(|text| text.strip_prefix("Count: "))
            .and_then(|value| value.parse().ok())
            .unwrap_or(0)
    }
}

#[no_mangle]
pub extern "C" fn pocket_nds_create() -> *mut NdsApp {
    NdsApp::new()
        .map(|app| Box::into_raw(Box::new(app)))
        .unwrap_or(core::ptr::null_mut())
}

/// `app` must be a live pointer returned by pocket_nds_create on this thread.
#[no_mangle]
pub unsafe extern "C" fn pocket_nds_frame(app: *mut NdsApp, buttons: u32, x: i32, y: i32) -> i32 {
    app.as_mut()
        .map(|app| i32::from(app.frame(buttons, x, y)))
        .unwrap_or(0)
}

#[no_mangle]
pub unsafe extern "C" fn pocket_nds_pixels(app: *const NdsApp) -> *const u16 {
    app.as_ref()
        .map(|app| app.pixels.as_ptr())
        .unwrap_or(core::ptr::null())
}

#[no_mangle]
pub unsafe extern "C" fn pocket_nds_damage(app: *const NdsApp) -> *const DamageRect {
    app.as_ref()
        .map(|app| app.damage_rects.as_ptr())
        .unwrap_or(core::ptr::null())
}

#[no_mangle]
pub unsafe extern "C" fn pocket_nds_stats(app: *const NdsApp, output: *mut FrameStats) {
    if let (Some(app), Some(output)) = (app.as_ref(), output.as_mut()) {
        *output = app.stats;
    }
}

#[no_mangle]
pub unsafe extern "C" fn pocket_nds_destroy(app: *mut NdsApp) {
    if !app.is_null() {
        drop(Box::from_raw(app));
    }
}
