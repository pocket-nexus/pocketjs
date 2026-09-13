//! pocketjs-core — the platform-agnostic retained UI core.
//!
//! One `Ui` instance owns the node tree, style table, taffy layout, font
//! atlases, animation tracks and the per-frame `DrawList`. Hosts (PSP QuickJS
//! FFI, wasm extern "C" mirror) call the op surface below; nothing here knows
//! about sceGu, canvas or QuickJS.
//!
//! Invariants upheld (from docs/DESIGN.md, all [R]):
//!   - Node ids are generation-tagged: (gen << spec::ID_SLOT_BITS) | slot;
//!     ops on stale ids are silent no-ops.
//!   - `insert_before` has DOM move semantics: an attached child is unlinked
//!     from its old parent first. anchor 0 = append.
//!   - `destroy_node` destroys the subtree, frees its anim tracks, and clears
//!     focus if the focused node is inside.
//!   - `tick()` advances EXACTLY one fixed step per call — spec::FIXED_DT
//!     unless `set_tick_rate` declared another rate before the first tick
//!     (frame content is a pure function of frame index — byte-exact
//!     goldens depend on it).
//!   - `draw()` output is fully CPU-clipped: every coordinate in the DrawList
//!     is inside [0, SCREEN_W] x [0, SCREEN_H] (see spec.ts DRAWLIST comment).
//!
//! Animation value plumbing: a running track writes its per-frame value into
//! the node's `anim_values` (applied last in style resolution). On completion
//! a TRANSITION track just removes its entry (the resolved style now equals
//! the target); an EXPLICIT `animate()` track persists its final value as a
//! dynamic override. `cancel_anim` freezes the current value as a dynamic
//! override.

#![cfg_attr(not(feature = "std"), no_std)]

extern crate alloc;

pub mod assets;
mod package_format;
pub mod resources;

use alloc::vec::Vec;

pub mod anim;
pub mod codec;
pub mod damage;
pub mod draw;
pub mod layout;
pub mod package;
pub mod pak;
pub mod raster;
pub mod compositor;
pub mod spec;
pub mod stream;
pub mod stream_rx;
pub mod style;
pub mod text;
pub mod touch;
pub mod tree;
pub mod wire;

pub use draw::DrawList;

/// CLUT byte size: 256 entries x u32 ABGR (the GE CLUT8 palette).
const TEX_PALETTE_BYTES: usize = 1024;

/// Integer form of `spec::FIXED_DT` — the tick rate a realm runs at unless
/// `set_tick_rate` declares another one before the first `tick()`.
const DEFAULT_TICK_HZ: u32 = 60;

/// Highest declarable tick rate. Above this the `ms * hz` intermediate in
/// `ms_to_frames` would overflow its `as u32` narrowing for ordinary
/// durations, and no display drives faster anyway.
pub const MAX_TICK_HZ: u32 = 240;

/// One uploaded texture. Pixels are copied into 16-byte-aligned storage so
/// the PSP GE can sample them directly (the wasm rasterizer reads them via
/// `Ui::texture`).
pub struct Texture {
    /// 16-byte-aligned backing store (`u128` chunks).
    data: Vec<u128>,
    byte_len: usize,
    pub w: u32,
    pub h: u32,
    /// spec::psm::* pixel format.
    pub psm: u32,
    /// CLUT (PSM_T8 only): exactly TEX_PALETTE_BYTES bytes (256 x u32 ABGR)
    /// in a 16-byte-aligned backing like `data`, so the PSP GE can point
    /// sceGuClutLoad at it directly. None for 4444/8888.
    palette: Option<Vec<u128>>,
    /// Sample with bilinear filtering (spec::img::FLAG_LINEAR). Pure sampling
    /// hint for backends — the pixel bytes are identical either way.
    pub linear: bool,
    /// Changes only when this live texture's bytes are overwritten in place.
    ///
    /// Generation-tagged handles catch free/reuse, while this revision lets
    /// GPU backends refresh one still-live binding without retransferring
    /// every other texture.
    revision: u64,
}

impl Texture {
    pub fn pixels(&self) -> &[u8] {
        // Safe: the Vec<u128> owns at least byte_len initialized bytes.
        unsafe { core::slice::from_raw_parts(self.data.as_ptr() as *const u8, self.byte_len) }
    }

    /// The 1024-byte CLUT (256 x u32 ABGR); Some only when psm == PSM_T8.
    pub fn palette(&self) -> Option<&[u8]> {
        // Safe: the palette Vec<u128> is always TEX_PALETTE_BYTES/16 chunks
        // (constructed only by copy_aligned(_, TEX_PALETTE_BYTES)).
        self.palette.as_ref().map(|p| unsafe {
            core::slice::from_raw_parts(p.as_ptr() as *const u8, TEX_PALETTE_BYTES)
        })
    }

    fn view(&self) -> TexView<'_> {
        TexView {
            pixels: self.pixels(),
            w: self.w,
            h: self.h,
            psm: self.psm,
            palette: self.palette(),
            linear: self.linear,
        }
    }
}

/// Borrowed view of one live texture (what backends sample — see
/// `Ui::texture` / `Ui::texture_at`). All byte slices are 16-byte aligned.
#[derive(Clone, Copy)]
pub struct TexView<'a> {
    pub pixels: &'a [u8],
    pub w: u32,
    pub h: u32,
    /// spec::psm::* pixel format.
    pub psm: u32,
    /// 1024-byte CLUT (256 x u32 ABGR) — Some exactly when psm == PSM_T8.
    pub palette: Option<&'a [u8]>,
    /// Bilinear sampling hint (spec::img::FLAG_LINEAR); nearest otherwise.
    pub linear: bool,
}

/// One texture slot. `gen` tags outstanding handles (bumped on free, so a
/// stale handle held by JS or a still-mounted image node resolves to nothing
/// and draws nothing); `tex` is the live texture (None = free slot).
pub struct TexSlot {
    gen: u16,
    tex: Option<Texture>,
}

/// Texture-handle generations live in bits TEX_SLOT_BITS..31 — bit 31 must
/// stay 0 so handles are always non-negative i32s (mirrors tree::GEN_MASK).
/// Generations wrap inside this mask (documented aliasing hazard after 2^11
/// frees of one slot; acceptable for tile-canvas churn).
const TEX_GEN_MASK: u32 = (1u32 << (31 - spec::TEX_SLOT_BITS)) - 1;

/// Build a generation-tagged texture handle from (generation, slot). Unlike
/// node ids, slot 0 is a real texture: slot 0 at gen 0 IS handle 0 (handles
/// are 0-based — existing goldens pin the first upload to 0).
#[inline]
fn make_tex_handle(gen: u16, slot: u32) -> i32 {
    (((gen as u32 & TEX_GEN_MASK) << spec::TEX_SLOT_BITS) | (slot & spec::TEX_SLOT_MASK)) as i32
}

/// Resolve a generation-tagged handle to its slot index; None for negative,
/// stale or freed handles.
pub(crate) fn tex_resolve(slots: &[TexSlot], handle: i32) -> Option<u32> {
    if handle < 0 {
        return None;
    }
    let u = handle as u32;
    let (gen, slot) = (u >> spec::TEX_SLOT_BITS, u & spec::TEX_SLOT_MASK);
    let s = slots.get(slot as usize)?;
    if s.tex.is_some() && (s.gen as u32 & TEX_GEN_MASK) == gen {
        Some(slot)
    } else {
        None
    }
}

/// Store `tex` in a slot (LIFO reuse via `free`, else append) and return its
/// generation-tagged handle, or -1 when the slot space is exhausted.
pub(crate) fn tex_alloc(slots: &mut Vec<TexSlot>, free: &mut Vec<u32>, tex: Texture) -> i32 {
    let slot = match free.pop() {
        Some(s) => s,
        None => {
            if slots.len() as u32 > spec::TEX_SLOT_MASK {
                return -1;
            }
            slots.push(TexSlot { gen: 0, tex: None });
            (slots.len() - 1) as u32
        }
    };
    let s = &mut slots[slot as usize];
    s.tex = Some(tex);
    make_tex_handle(s.gen, slot)
}

/// Copy `byte_len` bytes of `src` (caller guarantees `src.len() >= byte_len`)
/// into a fresh 16-byte-aligned `u128` backing store.
fn copy_aligned(src: &[u8], byte_len: usize) -> Vec<u128> {
    let mut chunks = alloc::vec![0u128; byte_len.div_ceil(16)];
    unsafe {
        core::ptr::copy_nonoverlapping(src.as_ptr(), chunks.as_mut_ptr() as *mut u8, byte_len);
    }
    chunks
}

// ---- unaligned LE readers (asset blob parsing; overflow-proof offsets) ------

#[inline]
pub(crate) fn rd_u16(b: &[u8], off: usize) -> Option<u16> {
    let s = b.get(off..off.checked_add(2)?)?;
    Some(u16::from_le_bytes([s[0], s[1]]))
}

#[inline]
pub(crate) fn rd_u32(b: &[u8], off: usize) -> Option<u32> {
    let s = b.get(off..off.checked_add(4)?)?;
    Some(u32::from_le_bytes([s[0], s[1], s[2], s[3]]))
}

/// One playing baked-timeline instance: a node's style carries an animation
/// block, so timeline `anim` (styles.bin ANIM TABLE index) runs on `node`.
/// Instances of one style application are pushed contiguously in CSS
/// comma-list order — later instances override earlier ones while both write
/// a prop (retain() keeps the order stable).
struct TimelineInst {
    alive: bool,
    node: i32,
    /// styles.bin ANIM TABLE index.
    anim: u16,
    /// Frames since the style was applied (the node's animation clock).
    clock: u32,
    /// Whole-choreography loop period (style-level `animate-loop-[..]`);
    /// the clock wraps modulo this. 0 = play once.
    loop_frames: u16,
}

struct AuxiliarySurface {
    root: i32,
    layout: layout::LayoutEngine,
    draw_list: DrawList,
    touch_table: touch::HitTable,
    inspect_drawn: Option<(f32, f32, f32, f32)>,
}

/// The retained UI core. One per AppInstance, with an optional independent
/// auxiliary output root sharing the same resources and frame clock.
pub struct Ui {
    tree: tree::Tree,
    styles: style::StyleTable,
    fonts: text::Fonts,
    font_revisions: [u64; spec::MAX_FONT_SLOTS],
    anims: anim::Anims,
    timelines: Vec<TimelineInst>,
    layout: layout::LayoutEngine,
    auxiliary: Option<AuxiliarySurface>,
    /// Generation-tagged texture slots (handles per spec.ts TEX_SLOT_BITS).
    textures: Vec<TexSlot>,
    /// LIFO free list of texture slots (freed most recently, reused first).
    tex_free: Vec<u32>,
    /// Baked rounded-corner disc sprites (see draw::DiscCache).
    discs: draw::DiscCache,
    /// Raster pixels baked for each logical UI pixel. Layout and DrawList
    /// coordinates always remain logical; only core-owned bitmap resources
    /// (currently rounded-corner masks) use this density.
    raster_density: u32,
    /// Changes whenever raster-visible resource bytes or tables change.
    raster_revision: u64,
    focused: i32,
    draw_list: DrawList,
    /// Virtual cursor sprite (spec ops 28/29, input.cursor capability):
    /// texture handle (< 0 = hidden), hotspot offset into the sprite,
    /// logical draw size (0 = the texture's own pixel size), and the
    /// hotspot's screen position. Drawn last by `draw()`; never laid out,
    /// never hit-tested.
    cursor_tex: i32,
    cursor_hot: (f32, f32),
    cursor_size: (f32, f32),
    cursor_pos: (f32, f32),
    /// Per-contact hit-at-down carry (touch hit facts; `touch_hits`).
    touch_table: touch::HitTable,
    /// Frame counter advanced by `tick()` (drives fixed-dt animation).
    frame: u64,
    /// Whether `tick()` has ever run. The `set_tick_rate` gate — `frame`
    /// alone would miss a realm whose every tick was swallowed by
    /// `debug_pause`, leaving the step size mutable mid-run.
    ticked: bool,
    /// Seconds of virtual time one `tick()` advances.
    dt: f32,
    /// The integer rate backing `dt`. Kept alongside it so duration-ms to
    /// frame-count conversions stay exact integer arithmetic (round-tripping
    /// through `1.0 / dt` would perturb byte-exact goldens).
    tick_hz: u32,
    /// DevTools (spec ops 18..22, docs/DEVTOOLS.md). All default-off.
    inspect_id: i32,
    /// World AABB (x, y, w, h) of the inspected node, captured by the last
    /// `draw()` that painted it.
    inspect_rect: Option<(f32, f32, f32, f32)>,
    /// The highlight box as actually drawn last frame — glides toward
    /// `inspect_rect` (draw::build lerps it); purely visual state.
    inspect_drawn: Option<(f32, f32, f32, f32)>,
    paused: bool,
    step_pending: bool,
}

/// One visible application surface in the shell DrawList. `order` is its op
/// offset and therefore its exact position relative to shell text/chrome.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CompositorSurfaceFrame {
    pub handle: u32,
    pub full: [f32; 4],
    pub clip: [f32; 4],
    pub focused: bool,
    pub order: usize,
}

impl Default for Ui {
    fn default() -> Self {
        Self::new()
    }
}

impl Ui {
    /// Create a core with the pre-created root node (`spec::ROOT_ID`,
    /// full-screen flex column) already in the tree.
    pub fn new() -> Self {
        Self::new_with_raster_density(1)
    }

    /// Create a core whose internally baked bitmap resources match the
    /// target's resolved raster density. The value is immutable so one Ui
    /// cannot mix resources produced for different target contracts.
    pub fn new_with_raster_density(raster_density: u32) -> Self {
        assert!(
            (1..=u8::MAX as u32).contains(&raster_density),
            "raster density must be an integer from 1 through 255"
        );
        Ui {
            tree: tree::Tree::new(),
            styles: style::StyleTable::new(),
            fonts: text::Fonts::new(),
            font_revisions: [0; spec::MAX_FONT_SLOTS],
            anims: anim::Anims::new(),
            timelines: Vec::new(),
            layout: layout::LayoutEngine::new(),
            auxiliary: None,
            textures: Vec::new(),
            tex_free: Vec::new(),
            discs: draw::DiscCache::new(),
            raster_density,
            raster_revision: 1,
            focused: 0,
            draw_list: DrawList::new(),
            cursor_tex: -1,
            cursor_hot: (0.0, 0.0),
            cursor_size: (0.0, 0.0),
            cursor_pos: (0.0, 0.0),
            touch_table: touch::HitTable::default(),
            frame: 0,
            ticked: false,
            dt: spec::FIXED_DT,
            tick_hz: DEFAULT_TICK_HZ,
            inspect_id: 0,
            inspect_rect: None,
            inspect_drawn: None,
            paused: false,
            step_pending: false,
        }
    }

    /// Raster pixels per logical UI pixel for core-owned bitmap resources.
    pub fn raster_density(&self) -> u32 {
        self.raster_density
    }

    /// Declare how many `tick()` calls make one second of virtual time
    /// (spec default 60, at most `MAX_TICK_HZ`). Rejected once the first
    /// `tick()` has run — even a `debug_pause`d one: a realm's frame content
    /// is a pure function of its frame index, so the step size has to be
    /// constant for the whole run. Returns whether the rate was applied.
    pub fn set_tick_rate(&mut self, hz: u32) -> bool {
        if hz == 0 || hz > MAX_TICK_HZ || self.ticked {
            return false;
        }
        self.tick_hz = hz;
        self.dt = 1.0 / hz as f32;
        true
    }

    /// Ticks per second of virtual time (see `set_tick_rate`).
    pub fn tick_rate(&self) -> u32 {
        self.tick_hz
    }

    /// Monotonic token for texture/font/style contents consumed by renderers.
    pub fn raster_revision(&self) -> u64 {
        self.raster_revision
    }

    fn bump_raster_revision(&mut self) {
        self.raster_revision = self.raster_revision.wrapping_add(1);
    }

    fn mark_layout_dirty(&mut self) {
        self.layout.dirty = true;
        if let Some(auxiliary) = self.auxiliary.as_mut() {
            auxiliary.layout.dirty = true;
        }
    }

    fn mark_layout_style(&mut self, slot: u32) {
        self.layout.mark_style(slot);
        if let Some(auxiliary) = self.auxiliary.as_mut() {
            auxiliary.layout.mark_style(slot);
        }
    }

    /// Create the fixed auxiliary UI root, or resize the existing one. The
    /// returned generation-tagged node id is a protected native root: callers
    /// may insert children under it but cannot attach or destroy the root.
    pub fn create_auxiliary_surface(&mut self, width: f32, height: f32) -> i32 {
        let width = width.clamp(1.0, 32000.0);
        let height = height.clamp(1.0, 32000.0);
        if self.auxiliary.is_some() {
            let root = self.auxiliary_surface_root();
            if let Some(auxiliary) = self.auxiliary.as_mut() {
                auxiliary.layout.viewport = (width, height);
                auxiliary.layout.dirty = true;
            }
            if let Some(node) = self.tree.get_mut(root) {
                tree::Node::put_entry(&mut node.overrides, spec::prop::WIDTH, width.to_bits());
                tree::Node::put_entry(&mut node.overrides, spec::prop::HEIGHT, height.to_bits());
            }
            return root;
        }
        let root = self.tree.alloc(spec::NodeType::View as u8);
        if root == 0 {
            return 0;
        }
        if let Some(node) = self.tree.get_mut(root) {
            tree::Node::put_entry(&mut node.overrides, spec::prop::WIDTH, width.to_bits());
            tree::Node::put_entry(&mut node.overrides, spec::prop::HEIGHT, height.to_bits());
            tree::Node::put_entry(
                &mut node.overrides,
                spec::prop::FLEX_DIR,
                spec::FlexDir::Col as u32,
            );
        }
        let mut surface_layout = layout::LayoutEngine::new();
        surface_layout.viewport = (width, height);
        self.auxiliary = Some(AuxiliarySurface {
            root,
            layout: surface_layout,
            draw_list: DrawList::new(),
            touch_table: touch::HitTable::default(),
            inspect_drawn: None,
        });
        root
    }

    pub fn auxiliary_surface_root(&self) -> i32 {
        self.auxiliary.as_ref().map_or(0, |surface| surface.root)
    }

    pub fn auxiliary_viewport(&self) -> Option<(f32, f32)> {
        self.auxiliary.as_ref().map(|surface| surface.layout.viewport)
    }

    // ---- tree ops ---------------------------------------------------------

    /// Create a detached node of `node_type` (spec::NodeType value).
    /// Returns its generation-tagged id, or 0 on failure.
    pub fn create_node(&mut self, node_type: u8) -> i32 {
        if node_type > spec::NodeType::Surface as u8 {
            return 0;
        }
        self.tree.alloc(node_type)
    }

    /// Destroy `id` and its whole subtree; frees anim tracks; clears focus
    /// if the focused node was inside. Stale/unknown ids are no-ops.
    pub fn destroy_node(&mut self, id: i32) {
        if id == spec::ROOT_ID || id == self.auxiliary_surface_root() || self.tree.resolve(id).is_none() {
            return;
        }
        if self.focused != 0 && self.tree.is_in_subtree(id, self.focused) {
            self.focused = 0;
        }
        self.tree.detach(id);
        let mut slots = Vec::new();
        self.tree.collect_subtree(id, &mut slots);
        for slot in slots {
            let nid = self.tree.slots[slot as usize].id(slot);
            self.anims.kill_node(nid);
            self.tree.free_slot(slot);
        }
        self.mark_layout_dirty();
    }

    /// Insert `child` under `parent` before `anchor` (0 = append). DOM move
    /// semantics: if `child` is attached anywhere it is unlinked first.
    pub fn insert_before(&mut self, parent: i32, child: i32, anchor: i32) {
        if child == self.auxiliary_surface_root() {
            return;
        }
        if self.tree.insert_before(parent, child, anchor) {
            self.mark_layout_dirty();
        }
    }

    /// Detach `child` from `parent`, keeping the node alive (Solid re-inserts
    /// during reorder; the JS renderer sweep destroys still-detached nodes).
    pub fn remove_child(&mut self, parent: i32, child: i32) {
        if self.tree.remove_child(parent, child) {
            self.mark_layout_dirty();
        }
    }

    // ---- styling ----------------------------------------------------------

    /// Apply style-table record `style_id` (spec::STYLE_ID_NONE clears).
    /// Starts transitions for the animatable old→new diff if the node already
    /// had an established style and the new record carries a transition block.
    pub fn set_style(&mut self, id: i32, style_id: i32) {
        let Some(slot) = self.tree.resolve(id) else {
            return;
        };
        let old = style::resolve(&self.tree.slots[slot as usize], &self.styles, true);
        let was_initialized = self.tree.slots[slot as usize].style_initialized;
        {
            let node = &mut self.tree.slots[slot as usize];
            node.style_id = if style_id < 0 {
                spec::STYLE_ID_NONE
            } else {
                style_id
            };
            node.style_initialized = true;
        }
        self.retarget(slot, &old, was_initialized);
        self.restart_timelines(slot);
        self.mark_layout_style(slot);
    }

    /// Set a single dynamic prop. `value` carries the payload per
    /// spec::PROP_VALUE_KIND: f32 props pass the number; color/int props pass
    /// the u32 bits as an integral f64.
    pub fn set_prop(&mut self, id: i32, prop: u8, value: f64) {
        let kind = spec::PROP_VALUE_KIND[prop as usize];
        if kind == 0xff {
            return;
        }
        let Some(slot) = self.tree.resolve(id) else {
            return;
        };
        let bits = prop_bits(kind, value);
        // A direct set wins over any running animation on the same prop.
        let nid = self.tree.slots[slot as usize].id(slot);
        self.anims.kill_for(nid, prop);
        let node = &mut self.tree.slots[slot as usize];
        tree::Node::remove_entry(&mut node.anim_values, prop);
        tree::Node::put_entry(&mut node.overrides, prop, bits);
        if spec::is_layout_dirtying(prop) {
            self.mark_layout_style(slot);
        }
    }

    // ---- text ------------------------------------------------------------

    /// Set the UTF-8 content of a text node. Empty text nodes are excluded
    /// from layout until they become non-empty.
    pub fn set_text(&mut self, id: i32, text: &str) {
        let Some(slot) = self.tree.resolve(id) else {
            return;
        };
        if self.tree.slots[slot as usize].node_type != spec::NodeType::Text as u8
            || self.tree.slots[slot as usize].text == text
        {
            return;
        }
        // Text updates ride the incremental style-dirty path (the restyle
        // branch re-collects the run and re-shapes ONCE). Only an empty <->
        // non-empty flip is structural: empty runs are excluded from the
        // taffy tree entirely, so the leaf has to (dis)appear.
        let root_slot = self.text_layout_root(slot);
        let mut run = alloc::string::String::new();
        self.tree.collect_run(root_slot, &mut run);
        let was_empty = run.is_empty();
        {
            let node = &mut self.tree.slots[slot as usize];
            node.text.clear();
            node.text.push_str(text);
        }
        run.clear();
        self.tree.collect_run(root_slot, &mut run);
        if was_empty != run.is_empty() {
            self.mark_layout_dirty();
        } else if !run.is_empty() {
            // A text swap inside a FIXED cell (definite px width AND height
            // on the layout leaf) cannot move layout — the measure result is
            // ignored on both axes. Skip the relayout entirely; paint reads
            // the tree text directly, and any later relayout re-collects the
            // run from the tree (never from the stale taffy context).
            let r = style::resolve(&self.tree.slots[root_slot as usize], &self.styles, true);
            let fixed =
                r.width.is_finite() && r.width >= 0.0 && r.height.is_finite() && r.height >= 0.0;
            if !fixed {
                self.mark_layout_style(root_slot);
            }
        }
    }

    /// Solid universal calls this on text updates; same semantics as
    /// `set_text`.
    pub fn replace_text(&mut self, id: i32, text: &str) {
        self.set_text(id, text);
    }

    /// Measure `text` at `font_slot` (px width). Layout measures natively;
    /// this is the JS-facing convenience.
    pub fn measure_text(&self, text: &str, font_slot: u8) -> f32 {
        self.fonts.measure_run(text, font_slot, 0.0, f32::NAN).0
    }

    /// Soft-wrap break columns for one line of `text` at `font_slot` under
    /// `max_w` px (OP wrapText): ascending UTF-16 columns, empty when the
    /// line fits. Provider rules in [`text::Fonts::wrap_text`].
    pub fn wrap_text(&self, text: &str, font_slot: u8, max_w: f32) -> Vec<u32> {
        self.fonts.wrap_text(text, font_slot, max_w)
    }

    // ---- assets ----------------------------------------------------------

    /// Upload a texture (raw pixels in `psm` format — spec::psm::*, pow2
    /// dims <= spec::TEX_MAX_DIM). Bytes are copied. Returns the
    /// generation-tagged handle (the first upload into a fresh core is slot 0
    /// at gen 0 == handle 0 — goldens pin this) or -1.
    ///
    /// PSM_T8 (CLUT8) data layout: 1024-byte palette (256 x u32 ABGR), then
    /// w*h index bytes.
    pub fn upload_texture(&mut self, data: &[u8], w: u32, h: u32, psm: u32) -> i32 {
        self.upload_texture_flags(data, w, h, psm, 0)
    }

    /// `upload_texture` honoring spec::img flags: FLAG_RLE marks the pixel
    /// stream (for PSM_T8: the index bytes AFTER the palette — the palette
    /// itself is never compressed) as PackBits-RLE, which must decode to
    /// EXACTLY w*h*bpp bytes; FLAG_LINEAR requests bilinear sampling.
    pub fn upload_texture_flags(
        &mut self,
        data: &[u8],
        w: u32,
        h: u32,
        psm: u32,
        flags: u8,
    ) -> i32 {
        let bpp = match psm {
            spec::psm::PSM_5650 | spec::psm::PSM_4444 => 2usize,
            spec::psm::PSM_8888 => 4usize,
            spec::psm::PSM_T8 => 1usize,
            _ => return -1,
        };
        let pow2 = |v: u32| v > 0 && v <= spec::TEX_MAX_DIM && v & (v - 1) == 0;
        if !pow2(w) || !pow2(h) {
            return -1;
        }
        // PSM_T8 leads with the raw CLUT; the pixel stream follows it.
        let (palette, stream) = if psm == spec::psm::PSM_T8 {
            if data.len() < TEX_PALETTE_BYTES {
                return -1;
            }
            (
                Some(copy_aligned(data, TEX_PALETTE_BYTES)),
                &data[TEX_PALETTE_BYTES..],
            )
        } else {
            (None, data)
        };
        let byte_len = w as usize * h as usize * bpp;
        let chunks = if flags & spec::img::FLAG_RLE != 0 {
            // Decode straight into the aligned backing store. The stream must
            // decode to EXACTLY byte_len bytes (codec contract) — anything
            // else is a malformed asset.
            let mut chunks = alloc::vec![0u128; byte_len.div_ceil(16)];
            let dst = unsafe {
                core::slice::from_raw_parts_mut(chunks.as_mut_ptr() as *mut u8, byte_len)
            };
            if !codec::packbits_decode(stream, dst) {
                return -1;
            }
            chunks
        } else {
            if stream.len() < byte_len {
                return -1;
            }
            copy_aligned(stream, byte_len)
        };
        let tex = Texture {
            data: chunks,
            byte_len,
            w,
            h,
            psm,
            palette,
            linear: flags & spec::img::FLAG_LINEAR != 0,
            revision: 0,
        };
        let handle = tex_alloc(&mut self.textures, &mut self.tex_free, tex);
        if handle >= 0 {
            self.bump_raster_revision();
        }
        handle
    }

    /// Upload a self-contained IMG pak entry (spec op uploadImgEntry;
    /// framework/compiler/pak.ts layout: u16 w, u16 h, u8 psm, u8 flags, u16 reserved,
    /// then the payload — for PSM_T8 a 1024-byte palette then the pixel
    /// stream). Returns the texture handle, or -1 on malformed blobs.
    pub fn upload_img_entry(&mut self, blob: &[u8]) -> i32 {
        let Some((w, h, psm, flags)) = parse_img_header(blob) else {
            return -1;
        };
        self.upload_texture_flags(&blob[8..], w, h, psm, flags)
    }

    /// Decode ONE tile of a TILESET pak entry (spec op loadTileTexture; blob
    /// layout in spec.ts "TILESET pak entry") and upload it as a PSM_T8
    /// texture sharing the entry's palette. Returns the handle, or -1 for
    /// ABSENT tiles, SOLID tiles (the host reads the directory itself and
    /// draws those as plain RECTs — this op only materializes pixel-stream
    /// tiles), out-of-range indices and malformed blobs. Every offset/length
    /// read is bounds-checked: malformed blobs return -1, never panic.
    pub fn upload_tileset_tile(&mut self, blob: &[u8], index: u32) -> i32 {
        let Some(tile) = parse_tileset_tile(blob, index) else {
            return -1;
        };
        // Reassemble the upload_texture_flags PSM_T8 layout (palette, then
        // pixel stream) — palette and stream live at unrelated offsets in
        // the entry.
        let mut data = Vec::with_capacity(TEX_PALETTE_BYTES + tile.stream.len());
        data.extend_from_slice(tile.palette);
        data.extend_from_slice(tile.stream);
        let mut img_flags = 0u8;
        if tile.flags & spec::tileset::FLAG_RLE != 0 {
            img_flags |= spec::img::FLAG_RLE;
        }
        if tile.flags & spec::tileset::FLAG_LINEAR != 0 {
            img_flags |= spec::img::FLAG_LINEAR;
        }
        self.upload_texture_flags(
            &data,
            tile.tile_w,
            tile.tile_h,
            spec::psm::PSM_T8,
            img_flags,
        )
    }

    /// Overwrite a live PSM_T8 texture's palette + pixels IN PLACE (the video
    /// plane's per-frame path: one texture for the whole session, so image
    /// bindings and the GE's texture pointer stay stable while the bytes
    /// change under them). `palette` must be exactly the 1024-byte CLUT and
    /// `pixels` exactly w*h index bytes for the texture's own dimensions —
    /// this never resizes or re-formats a slot. Returns false (and changes
    /// nothing) on stale handles, non-T8 textures, or size mismatches.
    /// Callers on the PSP must writeback the texture after (the GE samples
    /// RAM, not the dcache).
    pub fn update_texture_t8(&mut self, handle: i32, palette: &[u8], pixels: &[u8]) -> bool {
        let Some(slot) = tex_resolve(&self.textures, handle) else {
            return false;
        };
        let Some(tex) = self.textures[slot as usize].tex.as_mut() else {
            return false;
        };
        if tex.psm != spec::psm::PSM_T8 || palette.len() != TEX_PALETTE_BYTES {
            return false;
        }
        if pixels.len() != tex.byte_len {
            return false;
        }
        let Some(pal) = tex.palette.as_mut() else {
            return false;
        };
        unsafe {
            core::ptr::copy_nonoverlapping(
                palette.as_ptr(),
                pal.as_mut_ptr() as *mut u8,
                TEX_PALETTE_BYTES,
            );
            core::ptr::copy_nonoverlapping(
                pixels.as_ptr(),
                tex.data.as_mut_ptr() as *mut u8,
                tex.byte_len,
            );
        }
        tex.revision = tex.revision.wrapping_add(1);
        self.bump_raster_revision();
        true
    }

    /// Release a texture slot (spec op freeTexture): drop the pixels, bump
    /// the slot's generation so every outstanding copy of the handle goes
    /// stale (resolves to nothing, draws nothing), and push the slot on the
    /// LIFO free list. Stale/unknown handles are silent no-ops. Freeing a
    /// core-internal texture (a baked corner disc) is safe: the DiscCache
    /// re-validates its handles each use and re-bakes dead ones.
    pub fn free_texture(&mut self, handle: i32) {
        let Some(slot) = tex_resolve(&self.textures, handle) else {
            return;
        };
        let s = &mut self.textures[slot as usize];
        s.tex = None;
        s.gen = ((s.gen as u32 + 1) & TEX_GEN_MASK) as u16;
        self.tex_free.push(slot);
        self.bump_raster_revision();
    }

    /// Bind an uploaded texture to an image node. Handles are 0-based, so
    /// tex < 0 CLEARS the binding (node.tex = -1, the "none" sentinel);
    /// unknown/stale positive handles are ignored.
    pub fn set_image(&mut self, id: i32, tex: i32) {
        if tex >= 0 && tex_resolve(&self.textures, tex).is_none() {
            return;
        }
        let Some(slot) = self.tree.resolve(id) else {
            return;
        };
        let node = &mut self.tree.slots[slot as usize];
        if node.node_type == spec::NodeType::Image as u8 {
            node.tex = if tex < 0 { -1 } else { tex };
            node.sprite_frames = 0; // set_image reverts a sprite to a static image
        }
    }

    /// Bind a Pocket System package surface to a compositor-surface node.
    /// Handles belong to the native compositor, not the texture table;
    /// the core only retains the handle and emits its geometry in painter order.
    pub fn set_compositor_surface(&mut self, id: i32, surface: i32, focused: bool) {
        let Some(slot) = self.tree.resolve(id) else {
            return;
        };
        let node = &mut self.tree.slots[slot as usize];
        if node.node_type != spec::NodeType::Surface as u8 {
            return;
        }
        node.compositor_surface = surface.max(-1);
        node.compositor_focused = focused;
    }

    /// All live bindings, including surfaces hidden by opacity/display. The
    /// AppSupervisor uses this lifecycle view to distinguish minimize from close.
    pub fn compositor_surface_bindings(&self) -> Vec<(u32, bool)> {
        self.tree
            .slots
            .iter()
            .filter(|node| {
                node.alive
                    && node.node_type == spec::NodeType::Surface as u8
                    && node.compositor_surface >= 0
            })
            .map(|node| (node.compositor_surface as u32, node.compositor_focused))
            .collect()
    }

    /// Visible compositor instructions in exact DrawList order. Full bounds
    /// preserve the child coordinate origin; clip bounds are the shell-visible
    /// destination after overflow and viewport clipping.
    pub fn compositor_surface_frames(&mut self) -> Vec<CompositorSurfaceFrame> {
        let words = &self.draw().words;
        let mut frames = Vec::new();
        let mut i = 0usize;
        while i < words.len() {
            let Some(op) = words.get(i).copied() else {
                break;
            };
            let len = match op {
                x if x == spec::draw_op::RECT => 4,
                x if x == spec::draw_op::GRAD_RECT => 6,
                x if x == spec::draw_op::GLYPH_RUN => {
                    let Some(meta) = words.get(i + 1) else { break };
                    3 + 2 * ((*meta >> 16) as usize)
                }
                x if x == spec::draw_op::TEX_QUAD => 9,
                x if x == spec::draw_op::SCISSOR => 3,
                x if x == spec::draw_op::SCISSOR_POP => 1,
                x if x == spec::draw_op::TRI => 7,
                x if x == spec::draw_op::TEX_TRI => 12,
                x if x == spec::draw_op::TEXT_RUN => {
                    let Some(bytes) = words.get(i + 7) else { break };
                    8 + (*bytes as usize).div_ceil(4)
                }
                x if x == spec::draw_op::SURFACE_QUAD => 9,
                _ => break,
            };
            let Some(end) = i.checked_add(len) else { break };
            if end > words.len() {
                break;
            }
            if op == spec::draw_op::SURFACE_QUAD {
                let xy = words[i + 6];
                let wh = words[i + 7];
                frames.push(CompositorSurfaceFrame {
                    handle: words[i + 1],
                    full: [
                        f32::from_bits(words[i + 2]),
                        f32::from_bits(words[i + 3]),
                        f32::from_bits(words[i + 4]),
                        f32::from_bits(words[i + 5]),
                    ],
                    clip: [
                        (xy as u16 as i16) as f32,
                        ((xy >> 16) as u16 as i16) as f32,
                        (wh & 0xffff) as f32,
                        (wh >> 16) as f32,
                    ],
                    focused: words[i + 8] & 1 != 0,
                    order: i,
                });
            }
            i = end;
        }
        frames
    }

    /// Bind an ANIMATED SPRITE to an image node: `atlas` is an uploaded texture
    /// holding a `cols`-wide grid of `frames` cells; the core auto-plays it,
    /// advancing one cell every `step` vblanks (drawn as a UV sub-rect of the
    /// atlas). `frames == 0` clears the sprite (back to a plain/no image). The
    /// animation is deterministic — frame = (Ui.frame - start) / step % frames —
    /// and starts at frame 0 the moment the node is displayed.
    pub fn set_sprite(&mut self, id: i32, atlas: i32, frames: u32, cols: u32, step: u32) {
        if atlas >= 0 && tex_resolve(&self.textures, atlas).is_none() {
            return;
        }
        let frame = self.frame;
        let Some(slot) = self.tree.resolve(id) else {
            return;
        };
        let node = &mut self.tree.slots[slot as usize];
        if node.node_type != spec::NodeType::Image as u8 {
            return;
        }
        if frames == 0 || atlas < 0 {
            node.sprite_frames = 0;
            node.tex = -1;
            return;
        }
        node.tex = atlas;
        node.sprite_frames = frames.min(u16::MAX as u32) as u16;
        node.sprite_cols = cols.clamp(1, u16::MAX as u32) as u16;
        node.sprite_step = step.clamp(1, u16::MAX as u32) as u16;
        node.sprite_start = frame;
    }

    /// Parse a styles.bin blob (spec.ts STYLE TABLE format). Replaces the
    /// current table. Returns false on bad magic/version.
    pub fn load_styles(&mut self, bytes: &[u8]) -> bool {
        match style::StyleTable::parse(bytes) {
            Some(t) => {
                self.styles = t;
                self.mark_layout_dirty();
                self.bump_raster_revision();
                true
            }
            None => false,
        }
    }

    /// Parse a font-atlas blob (spec.ts FONT ATLAS format) and register it at
    /// the slot in its header. Returns false on bad magic/version.
    pub fn load_font_atlas(&mut self, bytes: &[u8]) -> bool {
        let ok = self.fonts.load(bytes);
        if ok {
            let slot = bytes[12] as usize;
            self.font_revisions[slot] = self.font_revisions[slot].wrapping_add(1);
            self.mark_layout_dirty();
            self.bump_raster_revision();
        }
        ok
    }

    // ---- animation ---------------------------------------------------------

    /// Start a tween/spring on an animatable prop; `from` = current value.
    /// `easing` is a spec::Easing ordinal. Returns anim id, or -1 if the prop
    /// is not animatable. Layout-dirtying props relayout each animated frame.
    pub fn animate(
        &mut self,
        id: i32,
        prop: u8,
        to: f64,
        dur_ms: u32,
        easing: u8,
        delay_ms: u32,
    ) -> i32 {
        if !spec::is_animatable(prop) || easing > spec::Easing::SpringBouncy as u8 {
            return -1;
        }
        let Some(slot) = self.tree.resolve(id) else {
            return -1;
        };
        let kind = spec::PROP_VALUE_KIND[prop as usize];
        let is_color = kind == spec::value_kind::COLOR;
        let from =
            style::resolve(&self.tree.slots[slot as usize], &self.styles, true).get_bits(prop);
        let to_bits = prop_bits(kind, to);
        let nid = self.tree.slots[slot as usize].id(slot);
        if !is_color {
            let (f, t) = (f32::from_bits(from), f32::from_bits(to_bits));
            // SIZE_FULL sentinel (any negative width/height) is NOT animatable
            // per spec.ts: animate() to/from it is a no-op.
            if (prop == spec::prop::WIDTH || prop == spec::prop::HEIGHT) && (f < 0.0 || t < 0.0) {
                return -1;
            }
            // NaN endpoints (auto/unset) cannot tween — interp would hold NaN
            // for the whole duration. Snap: write the target directly as a
            // dynamic override (browser-style "transition from auto" snap).
            if f.is_nan() || t.is_nan() {
                self.anims.kill_for(nid, prop);
                let node = &mut self.tree.slots[slot as usize];
                tree::Node::remove_entry(&mut node.anim_values, prop);
                tree::Node::put_entry(&mut node.overrides, prop, to_bits);
                if spec::is_layout_dirtying(prop) {
                    self.mark_layout_style(slot);
                }
                return -1;
            }
        }
        let anim_id = self.anims.spawn(
            nid,
            prop,
            is_color,
            anim::TrackKind::Explicit,
            from,
            to_bits,
            dur_ms,
            easing,
            delay_ms,
            self.tick_hz,
        );
        if anim_id > 0 {
            let node = &mut self.tree.slots[slot as usize];
            tree::Node::put_entry(&mut node.anim_values, prop, from);
        }
        anim_id
    }

    /// Cancel a running animation (leaves the prop at its current value, as a
    /// dynamic override).
    pub fn cancel_anim(&mut self, anim_id: i32) {
        let Some(tslot) = self.anims.resolve(anim_id) else {
            return;
        };
        let (node_id, prop) = {
            let t = &self.anims.tracks[tslot as usize];
            (t.node, t.prop)
        };
        if let Some(slot) = self.tree.resolve(node_id) {
            let node = &mut self.tree.slots[slot as usize];
            if let Some(cur) = tree::Node::find_entry(&node.anim_values, prop) {
                tree::Node::put_entry(&mut node.overrides, prop, cur);
                tree::Node::remove_entry(&mut node.anim_values, prop);
            }
        }
        self.anims.kill(tslot);
    }

    // ---- focus -------------------------------------------------------------

    /// Move focus to `id` (0 clears). Applies the `focus:` style variant
    /// natively — zero JS runs on focus change. Variant swaps run through the
    /// record's transition block like `set_style`.
    pub fn set_focus(&mut self, id: i32) {
        let target = if id == 0 {
            0
        } else if self.tree.resolve(id).is_some() {
            id
        } else {
            return;
        };
        if target == self.focused {
            return;
        }
        let old_focused = self.focused;
        self.focused = target;
        if let Some(slot) = self.tree.resolve(old_focused) {
            let old = style::resolve(&self.tree.slots[slot as usize], &self.styles, true);
            self.tree.slots[slot as usize].focused = false;
            self.retarget(slot, &old, true);
            self.mark_layout_style(slot);
        }
        if let Some(slot) = self.tree.resolve(target) {
            let old = style::resolve(&self.tree.slots[slot as usize], &self.styles, true);
            self.tree.slots[slot as usize].focused = true;
            self.retarget(slot, &old, true);
            self.mark_layout_style(slot);
        }
    }

    /// Set the `active:` pressed state (same native variant machinery as
    /// focus; spec op 26 — the JS input layer holds it while the press
    /// button is down).
    pub fn set_active(&mut self, id: i32, active: bool) {
        let Some(slot) = self.tree.resolve(id) else {
            return;
        };
        if self.tree.slots[slot as usize].active == active {
            return;
        }
        // A record without an `active:` variant cannot change the resolved
        // style — flip the flag without retargeting, so a press/release never
        // restarts in-flight transitions (CSS :active semantics).
        let has_active = self
            .styles
            .record(self.tree.slots[slot as usize].style_id)
            .is_some_and(|r| !r.active.is_empty());
        if !has_active {
            self.tree.slots[slot as usize].active = active;
            return;
        }
        let old = style::resolve(&self.tree.slots[slot as usize], &self.styles, true);
        self.tree.slots[slot as usize].active = active;
        self.retarget(slot, &old, true);
        self.mark_layout_style(slot);
    }

    // ---- virtual cursor (spec ops 27..29, input.cursor capability) ---------

    /// Topmost node at a logical point (spec op hitTest; see draw::hit_test
    /// for the exact semantics — layout boxes, paint order, clips). Returns
    /// the generation-tagged id, or 0. Relayouts first if dirty so mid-frame
    /// queries (the cursor moves before this frame's mutations settle) see
    /// current geometry — layout is a pure function of the tree, so running
    /// it early never changes what the next `draw()` shows.
    pub fn hit_test(&mut self, x: f32, y: f32) -> i32 {
        if self.layout.needs() {
            layout::relayout(&mut self.tree, &self.styles, &self.fonts, &mut self.layout);
        }
        draw::hit_test(&self.tree, &self.styles, self.layout.viewport, x, y)
    }

    /// `hit_test`'s bounds-only twin (spec op hitTestBounds): pure layout
    /// containers claim their box — the touch hit FACT resolver (see
    /// draw::hit_test_bounds). Same relayout-if-dirty rule.
    pub fn hit_test_bounds(&mut self, x: f32, y: f32) -> i32 {
        if self.layout.needs() {
            layout::relayout(&mut self.tree, &self.styles, &self.fonts, &mut self.layout);
        }
        draw::hit_test_bounds(&self.tree, &self.styles, self.layout.viewport, x, y)
    }

    pub fn hit_test_auxiliary(&mut self, x: f32, y: f32) -> i32 {
        let Some(auxiliary) = self.auxiliary.as_mut() else { return 0 };
        if auxiliary.layout.needs() {
            layout::relayout_root(
                &mut self.tree,
                &self.styles,
                &self.fonts,
                &mut auxiliary.layout,
                auxiliary.root,
            );
        }
        draw::hit_test_root(
            &self.tree,
            &self.styles,
            auxiliary.root,
            auxiliary.layout.viewport,
            x,
            y,
        )
    }

    pub fn hit_test_bounds_auxiliary(&mut self, x: f32, y: f32) -> i32 {
        let Some(auxiliary) = self.auxiliary.as_mut() else { return 0 };
        if auxiliary.layout.needs() {
            layout::relayout_root(
                &mut self.tree,
                &self.styles,
                &self.fonts,
                &mut auxiliary.layout,
                auxiliary.root,
            );
        }
        draw::hit_test_bounds_root(
            &self.tree,
            &self.styles,
            auxiliary.root,
            auxiliary.layout.viewport,
            x,
            y,
        )
    }

    /// Resolve the touch hit facts for this frame's packed contacts (frame()
    /// argument 4; docs/TOUCH.md). A NEW contact id is bounds-hit ONCE
    /// against the committed layout and the node id is carried until the id
    /// lifts — hosts call this right before the guest frame, so the guest
    /// never issues a hit query on the touch path. Returns the number of
    /// entries written to `out` (parallel to `packed`, capped at 8).
    pub fn touch_hits(&mut self, packed: &[u32], out: &mut [i32; 8]) -> usize {
        if self.layout.needs() {
            layout::relayout(&mut self.tree, &self.styles, &self.fonts, &mut self.layout);
        }
        let screen = self.layout.viewport;
        let tree = &self.tree;
        let styles = &self.styles;
        self.touch_table.resolve(packed, out, |x, y| {
            draw::hit_test_bounds(tree, styles, screen, x, y)
        })
    }

    pub fn touch_hits_auxiliary(&mut self, packed: &[u32], out: &mut [i32; 8]) -> usize {
        let Some(auxiliary) = self.auxiliary.as_mut() else { return 0 };
        if auxiliary.layout.needs() {
            layout::relayout_root(
                &mut self.tree,
                &self.styles,
                &self.fonts,
                &mut auxiliary.layout,
                auxiliary.root,
            );
        }
        let root = auxiliary.root;
        let screen = auxiliary.layout.viewport;
        let tree = &self.tree;
        let styles = &self.styles;
        auxiliary.touch_table.resolve(packed, out, |x, y| {
            draw::hit_test_bounds_root(tree, styles, root, screen, x, y)
        })
    }

    /// Bind the virtual cursor sprite (spec op setCursor): an uploaded
    /// texture drawn last every frame at the cursor position, offset by
    /// (hot_x, hot_y). tex < 0 or a stale handle hides the cursor; w/h <= 0
    /// draw at the texture's own pixel size.
    pub fn set_cursor(&mut self, tex: i32, hot_x: f32, hot_y: f32, w: f32, h: f32) {
        self.cursor_tex = if tex >= 0 && tex_resolve(&self.textures, tex).is_some() {
            tex
        } else {
            -1
        };
        self.cursor_hot = (hot_x, hot_y);
        self.cursor_size = (w.max(0.0), h.max(0.0));
    }

    /// Move the cursor hotspot (spec op setCursorPos), logical px. Clamped
    /// to the DrawList's i16-safe coordinate range.
    pub fn set_cursor_pos(&mut self, x: f32, y: f32) {
        self.cursor_pos = (x.clamp(-32000.0, 32000.0), y.clamp(-32000.0, 32000.0));
    }

    // ---- frame -------------------------------------------------------------

    /// Advance one frame: tick animations by exactly one `set_tick_rate`
    /// step, then re-run layout if dirty. Call once per vblank, BEFORE
    /// `draw()`.
    pub fn tick(&mut self) {
        self.ticked = true;
        if self.paused {
            if !self.step_pending {
                return;
            }
            self.step_pending = false;
        }
        self.frame = self.frame.wrapping_add(1);
        // Advance every live track (index loop: tracks may be killed inside).
        for tslot in 0..self.anims.tracks.len() as u32 {
            if !self.anims.tracks[tslot as usize].alive {
                continue;
            }
            let (value, done) = self.anims.tracks[tslot as usize].step(self.dt);
            let (node_id, prop, kind, to) = {
                let t = &self.anims.tracks[tslot as usize];
                (t.node, t.prop, t.kind, t.to)
            };
            let Some(slot) = self.tree.resolve(node_id) else {
                self.anims.kill(tslot);
                continue;
            };
            let node = &mut self.tree.slots[slot as usize];
            if done {
                match kind {
                    // Transition target == the new resolved value: drop the
                    // anim entry and the style shows through seamlessly.
                    anim::TrackKind::Transition => {
                        tree::Node::remove_entry(&mut node.anim_values, prop)
                    }
                    // Explicit animate(): the final value persists as a
                    // dynamic override.
                    anim::TrackKind::Explicit => {
                        tree::Node::remove_entry(&mut node.anim_values, prop);
                        tree::Node::put_entry(&mut node.overrides, prop, to);
                    }
                }
                self.anims.kill(tslot);
            } else {
                tree::Node::put_entry(&mut node.anim_values, prop, value);
            }
            if spec::is_layout_dirtying(prop) {
                self.mark_layout_style(slot);
            }
        }
        self.tick_timelines();
        if self.layout.needs() {
            layout::relayout(&mut self.tree, &self.styles, &self.fonts, &mut self.layout);
        }
    }

    /// Advance every playing baked timeline one frame and write the sampled
    /// values into the nodes' `anim_values`. Instances of one node are
    /// processed as one contiguous batch so CSS comma-list precedence holds:
    /// the LAST animation currently writing a prop wins; an animation that is
    /// not applying (delay without backwards fill / finished without forwards
    /// fill) yields to earlier list entries, and the prop entry is dropped
    /// when nothing writes it.
    fn tick_timelines(&mut self) {
        use spec::style_table as st;
        // (prop, Some(bits) = write | None = drop) fold buffer, list order.
        let mut writes: Vec<(u8, Option<u32>)> = Vec::new();
        let mut i = 0usize;
        while i < self.timelines.len() {
            if !self.timelines[i].alive {
                i += 1;
                continue;
            }
            let node_id = self.timelines[i].node;
            let mut end = i;
            while end < self.timelines.len() && self.timelines[end].node == node_id {
                end += 1;
            }
            let Some(slot) = self.tree.resolve(node_id) else {
                for inst in &mut self.timelines[i..end] {
                    inst.alive = false;
                }
                i = end;
                continue;
            };
            writes.clear();
            for j in i..end {
                let inst = &mut self.timelines[j];
                if !inst.alive {
                    continue;
                }
                let Some(tl) = self.styles.anims.get(inst.anim as usize) else {
                    inst.alive = false;
                    continue;
                };
                let t_abs = if inst.loop_frames > 0 {
                    inst.clock % inst.loop_frames as u32
                } else {
                    inst.clock
                };
                inst.clock = inst.clock.wrapping_add(1);
                let rel = t_abs as i64 - tl.delay_frames as i64;
                let total = tl.period_frames as i64 * tl.iterations as i64; // 0 = infinite
                for track in &tl.tracks {
                    let is_color =
                        spec::PROP_VALUE_KIND[track.prop as usize] == spec::value_kind::COLOR;
                    let value: Option<u32> = if rel < 0 {
                        (tl.fill & st::ANIM_FILL_BACKWARDS != 0)
                            .then(|| anim::sample_track(track, 0, is_color))
                    } else if tl.iterations != 0 && rel >= total {
                        (tl.fill & st::ANIM_FILL_FORWARDS != 0)
                            .then(|| anim::sample_track(track, tl.period_frames as u32, is_color))
                    } else {
                        let lt = (rel % tl.period_frames as i64) as u32;
                        Some(anim::sample_track(track, lt, is_color))
                    };
                    match writes.iter_mut().find(|(p, _)| *p == track.prop) {
                        // Later list entries override — but only while writing.
                        Some(entry) => {
                            if value.is_some() {
                                entry.1 = value;
                            }
                        }
                        None => writes.push((track.prop, value)),
                    }
                }
            }
            let mut layout_changed = false;
            {
                let node = &mut self.tree.slots[slot as usize];
                for &(prop, value) in &writes {
                    let prev = tree::Node::find_entry(&node.anim_values, prop);
                    match value {
                        Some(bits) => {
                            if prev != Some(bits) {
                                tree::Node::put_entry(&mut node.anim_values, prop, bits);
                                layout_changed |= spec::is_layout_dirtying(prop);
                            }
                        }
                        None => {
                            if prev.is_some() {
                                tree::Node::remove_entry(&mut node.anim_values, prop);
                                layout_changed |= spec::is_layout_dirtying(prop);
                            }
                        }
                    }
                }
            }
            if layout_changed {
                self.mark_layout_style(slot);
            }
            i = end;
        }
        self.timelines.retain(|t| t.alive);
    }

    /// After a style application on `slot`: stop the node's playing timelines
    /// and start the new record's animation block (if any) from frame 0.
    fn restart_timelines(&mut self, slot: u32) {
        let node_id = self.tree.slots[slot as usize].id(slot);
        for inst in self.timelines.iter_mut() {
            if inst.alive && inst.node == node_id {
                inst.alive = false;
            }
        }
        let style_id = self.tree.slots[slot as usize].style_id;
        let Some(animation) = self
            .styles
            .record(style_id)
            .and_then(|r| r.animation.clone())
        else {
            return;
        };
        for &aid in &animation.anims {
            if (aid as usize) < self.styles.anims.len() {
                self.timelines.push(TimelineInst {
                    alive: true,
                    node: node_id,
                    anim: aid,
                    clock: 0,
                    loop_frames: animation.loop_frames,
                });
            }
        }
    }

    /// Walk the tree into the DrawList (spec.ts DRAWLIST format) and return
    /// it. Output is valid until the next mutating call.
    pub fn draw(&mut self) -> &DrawList {
        if self.layout.needs() {
            layout::relayout(&mut self.tree, &self.styles, &self.fonts, &mut self.layout);
        }
        // Cursor sprite quad: resolved here so a texture freed after
        // set_cursor simply stops drawing (generation-tagged handles).
        let cursor = if self.cursor_tex >= 0 {
            tex_resolve(&self.textures, self.cursor_tex)
                .and_then(|slot| self.textures[slot as usize].tex.as_ref())
                .map(|t| {
                    let w = if self.cursor_size.0 > 0.0 {
                        self.cursor_size.0
                    } else {
                        t.w as f32
                    };
                    let h = if self.cursor_size.1 > 0.0 {
                        self.cursor_size.1
                    } else {
                        t.h as f32
                    };
                    (
                        self.cursor_tex as u32,
                        self.cursor_pos.0 - self.cursor_hot.0,
                        self.cursor_pos.1 - self.cursor_hot.1,
                        w,
                        h,
                    )
                })
        } else {
            None
        };
        let (target, drawn, provider_stale) = draw::build(
            &self.tree,
            &self.styles,
            &self.fonts,
            self.frame,
            self.layout.viewport,
            &mut self.textures,
            &mut self.tex_free,
            &mut self.discs,
            self.raster_density,
            &mut self.draw_list,
            self.inspect_id,
            self.inspect_drawn,
            cursor,
        );
        let (mut target, mut drawn) = (target, drawn);
        if provider_stale {
            // A paint-only transform change (rotate/scale never relayout)
            // left some text node's recorded provider stale. Re-decide and
            // REPAINT within this same draw — the frame that leaves here is
            // always provider-correct. One retry suffices: the draw walk
            // and layout build share one gate (Resolved::declares_transform
            // accumulated down identical recursions), so the rebuilt record
            // matches the repaint's expectation by construction.
            self.mark_layout_dirty();
            layout::relayout(&mut self.tree, &self.styles, &self.fonts, &mut self.layout);
            let retry = draw::build(
                &self.tree,
                &self.styles,
                &self.fonts,
                self.frame,
                self.layout.viewport,
                &mut self.textures,
                &mut self.tex_free,
                &mut self.discs,
                self.raster_density,
                &mut self.draw_list,
                self.inspect_id,
                self.inspect_drawn,
                cursor,
            );
            target = retry.0;
            drawn = retry.1;
            debug_assert!(!retry.2, "provider gate must be stable after re-decision");
        }
        self.inspect_drawn = drawn;
        if self.inspect_id != 0 {
            self.inspect_rect = target;
        }
        &self.draw_list
    }

    /// Return the DrawList most recently produced by [`draw`](Self::draw)
    /// without rebuilding it. Transactional render hosts use this to replay
    /// several dirty strips from one stable frame snapshot.
    pub fn current_draw_list(&self) -> &DrawList {
        &self.draw_list
    }

    /// Build the auxiliary output DrawList for the current frame. Returns
    /// None until the host creates the auxiliary surface before guest mount.
    pub fn draw_auxiliary(&mut self) -> Option<&DrawList> {
        let auxiliary = self.auxiliary.as_mut()?;
        if auxiliary.layout.needs() {
            layout::relayout_root(
                &mut self.tree,
                &self.styles,
                &self.fonts,
                &mut auxiliary.layout,
                auxiliary.root,
            );
        }
        let (target, drawn, provider_stale) = draw::build_root(
            &self.tree,
            &self.styles,
            &self.fonts,
            self.frame,
            auxiliary.root,
            auxiliary.layout.viewport,
            &mut self.textures,
            &mut self.tex_free,
            &mut self.discs,
            self.raster_density,
            &mut auxiliary.draw_list,
            self.inspect_id,
            auxiliary.inspect_drawn,
            None,
        );
        let (mut target, mut drawn) = (target, drawn);
        if provider_stale {
            auxiliary.layout.dirty = true;
            layout::relayout_root(
                &mut self.tree,
                &self.styles,
                &self.fonts,
                &mut auxiliary.layout,
                auxiliary.root,
            );
            let retry = draw::build_root(
                &self.tree,
                &self.styles,
                &self.fonts,
                self.frame,
                auxiliary.root,
                auxiliary.layout.viewport,
                &mut self.textures,
                &mut self.tex_free,
                &mut self.discs,
                self.raster_density,
                &mut auxiliary.draw_list,
                self.inspect_id,
                auxiliary.inspect_drawn,
                None,
            );
            target = retry.0;
            drawn = retry.1;
            debug_assert!(!retry.2, "provider gate must be stable after re-decision");
        }
        auxiliary.inspect_drawn = drawn;
        if target.is_some() {
            self.inspect_rect = target;
        }
        Some(&auxiliary.draw_list)
    }

    pub fn current_auxiliary_draw_list(&self) -> Option<&DrawList> {
        self.auxiliary.as_ref().map(|surface| &surface.draw_list)
    }

    /// Install (or clear) a native text measurer (text::MeasureFn). Native-
    /// text backends (docs/BACKENDS.md) call this BEFORE the guest mounts:
    /// every text leaf's metrics change provider, so the layout tree is
    /// rebuilt. Fixed-function hosts never call this, so goldens are
    /// unaffected.
    pub fn set_text_measure(&mut self, f: Option<text::MeasureFn>) {
        self.fonts.set_native_measure(f);
        self.mark_layout_dirty();
    }

    /// Install (or clear) a native line wrapper (text::WrapFn) next to the
    /// measurer — OP wrapText then returns the host's break positions.
    /// A pure query: no layout state depends on it.
    pub fn set_text_wrap(&mut self, f: Option<text::WrapFn>) {
        self.fonts.set_native_wrap(f);
    }

    /// Resize the logical viewport (root node + layout bounds + draw clip).
    /// Defaults to the PSP's 480x272; desktop hosts call this with their
    /// surface size. Values are clamped to the DrawList's i16 coordinate
    /// range. PSP/wasm hosts never call this, so goldens are unaffected.
    pub fn set_viewport(&mut self, w: f32, h: f32) {
        let w = w.clamp(1.0, 32000.0);
        let h = h.clamp(1.0, 32000.0);
        if self.layout.viewport == (w, h) {
            return;
        }
        self.layout.viewport = (w, h);
        self.set_prop(spec::ROOT_ID, spec::prop::WIDTH, w as f64);
        self.set_prop(spec::ROOT_ID, spec::prop::HEIGHT, h as f64);
    }

    /// The current logical viewport (w, h) in px.
    pub fn viewport(&self) -> (f32, f32) {
        self.layout.viewport
    }

    // ---- introspection (hosts/backends/tests; not spec ops) -----------------

    /// Currently focused node id (0 = none).
    pub fn focused(&self) -> i32 {
        self.focused
    }

    /// cmap-miss count (unmapped codepoints rendered as tofu).
    pub fn glyph_misses(&self) -> u32 {
        self.fonts.misses.get()
    }

    // ---- DevTools ops (spec ops 18..22, docs/DEVTOOLS.md) ------------------------

    /// Set (0 = clear) the inspected node. The next `draw()` that paints it
    /// captures its world AABB and appends the highlight overlay on top.
    pub fn debug_inspect(&mut self, id: i32) {
        self.inspect_id = id;
        self.inspect_rect = None;
        // Keep inspect_drawn: switching targets glides the box from the old
        // node to the new one. Clearing (id 0) hides it via the draw path.
        if id == 0 {
            self.inspect_drawn = None;
        }
    }

    /// Packed `x | y << 16` (i16 halves) of the inspected node's last-drawn
    /// world AABB; -1 if it hasn't been painted since `debug_inspect`.
    pub fn debug_rect_xy(&self) -> i32 {
        match self.inspect_rect {
            Some((x, y, _, _)) => (x as i32 & 0xffff) | ((y as i32) << 16),
            None => -1,
        }
    }

    /// Packed `w | h << 16` of the same AABB; -1 if none.
    pub fn debug_rect_wh(&self) -> i32 {
        match self.inspect_rect {
            Some((_, _, w, h)) => (w as i32 & 0xffff) | ((h as i32) << 16),
            None => -1,
        }
    }

    /// Freeze (or resume) the world: while paused `tick()` is a no-op — the
    /// frame counter, tracks, timelines and sprite clocks all hold. `draw()`
    /// still runs so the highlight overlay stays live.
    pub fn debug_pause(&mut self, on: bool) {
        self.paused = on;
        if !on {
            self.step_pending = false;
        }
    }

    /// Arm exactly one `tick()` while paused (no-op when running).
    pub fn debug_step(&mut self) {
        if self.paused {
            self.step_pending = true;
        }
    }

    /// Whether the world is frozen by `debug_pause`.
    pub fn debug_paused(&self) -> bool {
        self.paused
    }

    /// Rounded layout rect of a node, relative to its parent: (x, y, w, h).
    pub fn layout_of(&self, id: i32) -> Option<(f32, f32, f32, f32)> {
        let n = self.tree.get(id)?;
        Some((n.layout.x, n.layout.y, n.layout.w, n.layout.h))
    }

    /// The fully-resolved style of a node (variants + overrides + anims).
    pub fn resolved_style(&self, id: i32) -> Option<style::Resolved> {
        let n = self.tree.get(id)?;
        Some(style::resolve(n, &self.styles, true))
    }

    /// Pixels + metadata of a live texture (backends sample through this;
    /// byte slices are 16-byte aligned). Stale/freed handles resolve to None
    /// — a freed texture "draws nothing" through exactly this path.
    pub fn texture(&self, handle: i32) -> Option<TexView<'_>> {
        let slot = tex_resolve(&self.textures, handle)?;
        self.textures[slot as usize].tex.as_ref().map(Texture::view)
    }

    /// Content revision of a live texture. Generation-tagged handles catch
    /// free/reuse; this value changes when the bytes behind one still-live
    /// handle are overwritten in place.
    pub fn texture_revision(&self, handle: i32) -> Option<u64> {
        let slot = tex_resolve(&self.textures, handle)?;
        self.textures[slot as usize]
            .tex
            .as_ref()
            .map(|texture| texture.revision)
    }

    /// Number of texture slots ever allocated (live or free) — the walk
    /// bound for `texture_at` (the wgpu backend's texture-sync sweep).
    pub fn texture_slot_count(&self) -> usize {
        self.textures.len()
    }

    /// The live texture in `slot` plus its CURRENT generation-tagged handle
    /// (the value draw-list words reference right now). None for free slots.
    pub fn texture_at(&self, slot: u32) -> Option<(i32, TexView<'_>)> {
        let s = self.textures.get(slot as usize)?;
        let t = s.tex.as_ref()?;
        Some((make_tex_handle(s.gen, slot), t.view()))
    }

    /// Versioned texture-slot walk for GPU caches. This is additive to the
    /// long-standing `texture_at`/`TexView` API so downstream struct literals
    /// and exhaustive patterns do not break merely to support cache refresh.
    pub fn texture_at_versioned(&self, slot: u32) -> Option<(i32, u64, TexView<'_>)> {
        let s = self.textures.get(slot as usize)?;
        let t = s.tex.as_ref()?;
        Some((make_tex_handle(s.gen, slot), t.revision, t.view()))
    }

    /// A registered font atlas (backends read glyph bitmaps through this).
    pub fn font_atlas(&self, slot: u8) -> Option<&text::Atlas> {
        self.fonts.atlas(slot)
    }

    /// Per-slot GPU cache invalidation, including same-count atlas replacements.
    pub fn font_atlas_revision(&self, slot: u8) -> u64 {
        self.font_revisions.get(slot as usize).copied().unwrap_or(0)
    }

    // ---- internals -----------------------------------------------------------

    /// The taffy leaf affected by a text-node content update. Text children
    /// are absorbed into the nearest top-level text ancestor instead of being
    /// laid out independently.
    fn text_layout_root(&self, mut slot: u32) -> u32 {
        loop {
            let parent = self.tree.slots[slot as usize].parent;
            let Some(parent_slot) = self.tree.resolve(parent) else {
                return slot;
            };
            if self.tree.slots[parent_slot as usize].node_type != spec::NodeType::Text as u8 {
                return slot;
            }
            slot = parent_slot;
        }
    }

    /// After a style/variant mutation on `slot`: spawn transition tweens for
    /// the masked animatable props that changed (from = `old` appearance,
    /// to = the new resolved target sans animation values), and drop stale
    /// anim values so the new style shows through.
    fn retarget(&mut self, slot: u32, old: &style::Resolved, allow_transition: bool) {
        let node_id = self.tree.slots[slot as usize].id(slot);
        let target = style::resolve(&self.tree.slots[slot as usize], &self.styles, false);
        let transition = self
            .styles
            .record(self.tree.slots[slot as usize].style_id)
            .and_then(|r| r.transition);
        // Which props spawn tweens?
        let mut spawned: [bool; 256] = [false; 256];
        if allow_transition {
            if let Some(tr) = transition {
                for prop in 0u16..=255 {
                    let prop = prop as u8;
                    let bit = spec::ANIM_BIT[prop as usize];
                    // bits >= 32 are timeline/animate()-only (beyond the u32
                    // transition mask — see spec.ts ANIMATABLE).
                    if bit >= 32 || tr.mask & (1u32 << bit) == 0 {
                        continue;
                    }
                    let from = old.get_bits(prop);
                    let to = target.get_bits(prop);
                    if from == to {
                        continue;
                    }
                    let is_color = spec::PROP_VALUE_KIND[prop as usize] == spec::value_kind::COLOR;
                    if !is_color {
                        let (f, t) = (f32::from_bits(from), f32::from_bits(to));
                        // SIZE_FULL (any negative width/height) is NOT animatable
                        // (spec.ts), and NaN (auto) endpoints cannot tween: spawn
                        // nothing — the new resolved style shows through
                        // immediately (snap), matching browser transitions.
                        let sentinel = (prop == spec::prop::WIDTH || prop == spec::prop::HEIGHT)
                            && (f < 0.0 || t < 0.0);
                        if sentinel || f.is_nan() || t.is_nan() {
                            continue;
                        }
                    }
                    let aid = self.anims.spawn(
                        node_id,
                        prop,
                        is_color,
                        anim::TrackKind::Transition,
                        from,
                        to,
                        tr.dur_ms as u32,
                        tr.easing,
                        tr.delay_ms as u32,
                        self.tick_hz,
                    );
                    if aid > 0 {
                        spawned[prop as usize] = true;
                        let node = &mut self.tree.slots[slot as usize];
                        tree::Node::put_entry(&mut node.anim_values, prop, from);
                    }
                }
            }
        }
        // Drop anim values that no live track backs (stale completions from a
        // previous style) so the new resolved style isn't masked. Props we
        // just spawned keep their entry; other live tracks keep theirs.
        let anims = &self.anims;
        let node = &mut self.tree.slots[slot as usize];
        node.anim_values
            .retain(|&(p, _)| spawned[p as usize] || anims.has_live(node_id, p));
    }
}

/// Bounds-checked IMG entry header read (framework/compiler/pak.ts layout): returns
/// (w, h, psm, flags); None when the blob is shorter than the 8-byte header
/// (which also guarantees `blob[8..]` — the payload — is indexable).
fn parse_img_header(blob: &[u8]) -> Option<(u32, u32, u32, u8)> {
    let w = rd_u16(blob, 0)? as u32;
    let h = rd_u16(blob, 2)? as u32;
    let psm = *blob.get(4)? as u32;
    let flags = *blob.get(5)?;
    rd_u16(blob, 6)?; // reserved — read keeps the payload offset in bounds
    Some((w, h, psm, flags))
}

/// One decoded pixel-stream tile of a TILESET entry (borrowed from the blob).
struct TilesetTile<'a> {
    tile_w: u32,
    tile_h: u32,
    /// Entry-level flags (spec::tileset::FLAG_*; shared by every tile).
    flags: u16,
    /// The entry's shared 1024-byte CLUT.
    palette: &'a [u8],
    /// This tile's pixel stream (raw or RLE per `flags` bit 0).
    stream: &'a [u8],
}

/// Bounds-checked TILESET reader (spec.ts "TILESET pak entry"): header +
/// directory entry `index`. Returns the tile for a pixel-stream tile; None
/// for ABSENT tiles, SOLID tiles (len == 0: `off` holds the palette index —
/// the host's job), out-of-range indices and malformed blobs.
/// checked_add/checked_mul keep hostile offsets from overflowing 32-bit
/// usize (wasm).
fn parse_tileset_tile(blob: &[u8], index: u32) -> Option<TilesetTile<'_>> {
    use spec::tileset as ts;
    if rd_u32(blob, 0)? != ts::MAGIC || rd_u16(blob, 4)? != ts::VERSION {
        return None;
    }
    let flags = rd_u16(blob, 6)?;
    let tile_w = rd_u16(blob, 8)? as u32;
    let tile_h = rd_u16(blob, 10)? as u32;
    let cols = rd_u16(blob, 12)? as u32;
    let rows = rd_u16(blob, 14)? as u32;
    let palette_off = rd_u32(blob, 16)? as usize;
    let dir_off = rd_u32(blob, 20)? as usize;
    let data_off = rd_u32(blob, 24)? as usize;
    if index >= cols.checked_mul(rows)? {
        return None;
    }
    let entry = dir_off.checked_add((index as usize).checked_mul(ts::DIR_ENTRY_SIZE)?)?;
    let off = rd_u32(blob, entry)?;
    let len = rd_u32(blob, entry.checked_add(4)?)? as usize;
    // ABSENT (transparent) and SOLID (uniform-color) tiles carry no pixel
    // stream; the framework reads the directory itself and draws them as
    // background/plain RECTs — this op only materializes pixel-stream tiles.
    if off == ts::ABSENT || len == 0 {
        return None;
    }
    let palette = blob.get(palette_off..palette_off.checked_add(TEX_PALETTE_BYTES)?)?;
    let start = data_off.checked_add(off as usize)?;
    let stream = blob.get(start..start.checked_add(len)?)?;
    Some(TilesetTile {
        tile_w,
        tile_h,
        flags,
        palette,
        stream,
    })
}

/// Convert a `set_prop`/`animate` f64 payload to raw u32 prop bits per its
/// VALUE_KIND (f32 props carry the number; color/int carry integral bits).
fn prop_bits(kind: u8, value: f64) -> u32 {
    if kind == spec::value_kind::F32 {
        (value as f32).to_bits()
    } else {
        // i64 route so negative ints (e.g. zIndex -1) wrap to their two's
        // complement u32 instead of saturating to 0.
        value as i64 as u32
    }
}

#[cfg(test)]
mod tests;
