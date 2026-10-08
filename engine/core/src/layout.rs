//! taffy integration: resolved styles -> taffy::Style, text measure
//! functions, dirty tracking and rounded layout readback.
//!
//! The projected Taffy tree persists across relayouts. Structural sync keeps
//! unchanged handles, styles and text contexts; Taffy invalidates changed
//! nodes and their ancestors, then reuses cached child layouts during solve.
//!
//! Text nodes: a text ELEMENT becomes a taffy measure leaf over its
//! concatenated inline run; text children of a text element are absorbed into
//! that run (never flex items). Text nodes whose run is EMPTY (Solid `<Show>`
//! markers) are excluded from the taffy tree entirely [R].
//!
//! Three things narrow what one relayout touches:
//!
//! - **Regions** (`Node::region_root`, resolved `contain` Strict or Baked):
//!   the node is a leaf in its parent's projection and its children form a
//!   second taffy root in the same `TaffyTree`, solved with the box the parent
//!   assigned. Structure and style marks route to the nearest region above
//!   the change (`Ui::box_owner`), so a `<Show>` swap inside a region syncs
//!   and solves that region only.
//! - **Static nodes** (`LAYOUT_STATIC`): the rect is assigned by the caller
//!   (the MicroTS compiler's build-time tables) and the subtree has no solver
//!   nodes at all. Marks on them are no-ops.
//! - **Formula nodes** (`LAYOUT_FORMULA`): absolutely positioned leaves whose
//!   rect is recomputed from their own resolved inset and size on every style
//!   change, without a solver pass (`formula_rect`).
//!
//! The solver runs with taffy's rounding disabled. Readback rounds every rect
//! with taffy's own algorithm (`taffy_round` on cumulative unrounded origins),
//! so a region solved as its own root yields the bits the full tree would.

use alloc::string::String;
use alloc::vec::Vec;

use taffy::{AvailableSpace, Size, TaffyTree};

use crate::spec;
use crate::style::{self, Resolved, StyleTable};
use crate::text::Fonts;
use crate::tree::{LayoutRect, Tree, LAYOUT_LIVE};

/// Measure context attached to text leaves (taffy NodeContext).
pub struct MeasureCtx {
    pub text: String,
    pub slot: u8,
    pub tracking: f32,
    /// NAN = atlas default.
    pub line_height: f32,
    /// Shaped size, computed ONCE when the context is (re)built. Text
    /// shaping is the expensive half of layout on the PSP; the taffy
    /// measure closure must never re-shape per solve pass.
    pub size: (f32, f32),
    native: bool,
    environment_epoch: u64,
    /// Replaying an unchanged measurement must preserve the public missing
    /// glyph counter, even though no shaping work is repeated.
    misses: u32,
}

impl MeasureCtx {
    fn matches(
        &self,
        text: &str,
        slot: u8,
        tracking: f32,
        line_height: f32,
        native: bool,
    ) -> bool {
        self.text == text
            && self.slot == slot
            && self.native == native
            && float_key(self.tracking) == float_key(tracking)
            && float_key(self.line_height) == float_key(line_height)
    }

    fn replay_misses(&self, fonts: &Fonts) {
        fonts
            .misses
            .set(fonts.misses.get().wrapping_add(self.misses));
    }

    fn shaped(
        fonts: &Fonts,
        text: String,
        slot: u8,
        tracking: f32,
        line_height: f32,
        native: bool,
    ) -> MeasureCtx {
        let before = fonts.misses.get();
        let size = fonts.measure_run_provider(native, &text, slot, tracking, line_height);
        MeasureCtx {
            text,
            slot,
            tracking,
            line_height,
            size,
            native,
            environment_epoch: 0,
            misses: fonts.misses.get().wrapping_sub(before),
        }
    }
}

fn float_key(value: f32) -> u32 {
    if value.is_nan() {
        f32::NAN.to_bits()
    } else {
        value.to_bits()
    }
}

#[derive(Clone, Copy)]
struct LayoutEntry {
    /// Includes the arena generation: a reused slot is a different node.
    id: i32,
    handle: taffy::NodeId,
    active: bool,
    declares_transform: bool,
}

/// One `contain` subtree (`Node::region_root`): its children form their own
/// taffy root, solved with the box the parent projection assigned to the
/// root node.
pub struct Region {
    /// Generation-tagged id of the region root node.
    pub id: i32,
    /// The region's taffy root: the root node's style with position relative,
    /// no inset, margin or flex factors, and the box as its size. The root
    /// node keeps an ordinary leaf entry in its parent's projection.
    root: Option<taffy::NodeId>,
    /// Reconcile this region's subtree before solving.
    dirty: bool,
    /// Nodes inside this region whose resolved style changed.
    style_dirty: Vec<u32>,
    /// Unrounded box (w, h bits) the region was last solved for.
    solved_box: Option<(u32, u32)>,
    /// Cumulative unrounded origin of the root node in the full tree, from
    /// the parent projection's readback (static roots: their rect chain).
    origin: (f32, f32),
    /// Unrounded box of the root node from the parent projection's readback.
    unrounded_box: (f32, f32),
}

/// The layout engine: one TaffyTree (primary root plus one root per region)
/// and the dirty flags.
pub struct LayoutEngine {
    pub taffy: TaffyTree<MeasureCtx>,
    /// Reconcile the projected structure and resolved styles before solving.
    pub dirty: bool,
    /// STYLE dirty slots: nodes whose resolved style changed but whose place
    /// in the tree did not — relayout restyles just these in the live taffy
    /// tree and lets taffy recompute the affected subtrees (per-frame
    /// keyframe animations of layout props stay incremental instead of
    /// rebuilding ~everything at 60 Hz).
    pub style_dirty: Vec<u32>,
    /// Registered regions, in registration order. `solve_regions` orders
    /// them by depth so a nested region sees its parent region's readback.
    pub regions: Vec<Region>,
    /// True once `relayout` has built a taffy tree for the current structure.
    pub built: bool,
    /// Root taffy node of the built tree.
    pub root: Option<taffy::NodeId>,
    /// Layout viewport in px. Defaults to the PSP screen; desktop hosts set it
    /// through `Ui::set_viewport` (the draw clip stage uses the same bounds).
    pub viewport: (f32, f32),
    entries: Vec<Option<LayoutEntry>>,
    environment_epoch: u64,
    other_output_root: Option<i32>,
    solved_viewport: Option<(u32, u32)>,
    #[cfg(feature = "counters")]
    reference_rebuild: bool,
    #[cfg(feature = "counters")]
    pub counters: crate::counters::LayoutCounters,
}

impl Default for LayoutEngine {
    fn default() -> Self {
        Self::new()
    }
}

/// A solver tree with taffy's rounding off: readback rounds (`rounded_rect`).
fn new_taffy() -> TaffyTree<MeasureCtx> {
    let mut taffy = TaffyTree::new();
    taffy.disable_rounding();
    taffy
}

impl LayoutEngine {
    /// Structure changes retain existing nodes and their measurement caches.
    pub fn mark_structure(&mut self) {
        self.dirty = true;
    }

    /// Structure changed under the root of region `id` (primary when unknown).
    pub fn mark_region_structure(&mut self, id: i32) {
        match self.region_index(id) {
            Some(index) => self.regions[index].dirty = true,
            None => self.dirty = true,
        }
    }

    /// Font tables and provider functions can change without changing text.
    pub fn invalidate_measurements(&mut self) {
        self.environment_epoch = self.environment_epoch.wrapping_add(1);
        self.dirty = true;
        for region in &mut self.regions {
            region.dirty = true;
        }
    }

    /// The other output shares the arena but owns its own projected graph.
    /// A detached subtree has no output root and can keep its cached handles.
    pub(crate) fn set_other_output_root(&mut self, root: i32) {
        self.other_output_root = Some(root);
        self.dirty = true;
    }

    /// Differential-test oracle: drop the retained tree and rebuild it with
    /// the original recursive builder on the next relayout.
    #[cfg(feature = "counters")]
    pub fn force_rebuild_for_validation(&mut self) {
        self.taffy = new_taffy();
        self.entries.clear();
        self.style_dirty.clear();
        for region in &mut self.regions {
            region.root = None;
            region.dirty = true;
            region.style_dirty.clear();
            region.solved_box = None;
        }
        self.root = None;
        self.built = false;
        self.dirty = true;
        self.solved_viewport = None;
        self.counters.taffy_nodes = 0;
        self.reference_rebuild = true;
    }

    /// Mark one node style-dirty (cheap; deduped at relayout).
    pub fn mark_style(&mut self, slot: u32) {
        self.style_dirty.push(slot);
    }

    /// Mark one node inside region `id` style-dirty (primary when unknown).
    pub fn mark_region_style(&mut self, id: i32, slot: u32) {
        match self.region_index(id) {
            Some(index) => self.regions[index].style_dirty.push(slot),
            None => self.style_dirty.push(slot),
        }
    }

    pub fn region_index(&self, id: i32) -> Option<usize> {
        self.regions.iter().position(|region| region.id == id)
    }

    pub fn is_region(&self, id: i32) -> bool {
        self.region_index(id).is_some()
    }

    /// Start solving node `id`'s children as their own root. The caller marks
    /// the projection that held them.
    pub fn register_region(&mut self, id: i32) {
        if self.region_index(id).is_none() {
            self.regions.push(Region {
                id,
                root: None,
                dirty: true,
                style_dirty: Vec::new(),
                solved_box: None,
                origin: (0.0, 0.0),
                unrounded_box: (0.0, 0.0),
            });
        }
    }

    /// Drop region `id`; its children's entries survive until the projection
    /// that takes them over syncs.
    pub fn unregister_region(&mut self, id: i32) {
        if let Some(index) = self.region_index(id) {
            let region = self.regions.remove(index);
            if let Some(root) = region.root {
                let _ = self.taffy.set_children(root, &[]);
                let _ = self.taffy.remove(root);
            }
        }
    }

    /// Anything for `relayout` to do?
    pub fn needs(&self) -> bool {
        self.dirty
            || !self.style_dirty.is_empty()
            || self
                .regions
                .iter()
                .any(|region| region.dirty || !region.style_dirty.is_empty())
    }

    pub fn new() -> LayoutEngine {
        LayoutEngine {
            taffy: new_taffy(),
            dirty: true,
            style_dirty: Vec::new(),
            regions: Vec::new(),
            built: false,
            root: None,
            viewport: (spec::SCREEN_W as f32, spec::SCREEN_H as f32),
            entries: Vec::new(),
            environment_epoch: 0,
            other_output_root: None,
            solved_viewport: None,
            #[cfg(feature = "counters")]
            reference_rebuild: false,
            #[cfg(feature = "counters")]
            counters: crate::counters::LayoutCounters::default(),
        }
    }
}

/// taffy's own `round` (its no_std polyfill): nearest integer, halves away
/// from zero. The solver runs with rounding disabled; readback applies this
/// to cumulative unrounded positions exactly as taffy's `round_layout` does.
pub fn taffy_round(value: f32) -> f32 {
    let f = if value == 0.0 { 0.0 } else { value % 1.0 };
    if f.is_nan() || f == 0.0 {
        value
    } else if value > 0.0 {
        if f < 0.5 {
            value - f
        } else {
            value - f + 1.0
        }
    } else if -f < 0.5 {
        value - f
    } else {
        value - f - 1.0
    }
}

/// Round one unrounded layout placed at the parent's cumulative unrounded
/// origin `cum`; returns the rect and this node's cumulative origin.
pub fn rounded_rect(
    location: (f32, f32),
    size: (f32, f32),
    cum: (f32, f32),
) -> (LayoutRect, (f32, f32)) {
    let cx = cum.0 + location.0;
    let cy = cum.1 + location.1;
    let rect = LayoutRect {
        x: taffy_round(location.0),
        y: taffy_round(location.1),
        w: taffy_round(cx + size.0) - taffy_round(cx),
        h: taffy_round(cy + size.1) - taffy_round(cy),
    };
    (rect, (cx, cy))
}

/// Rect of an absolutely positioned leaf from its own resolved style, as the
/// flexbox solver places it: inset against the parent's box (this core has no
/// layout border), definite or 100% size, no margin, rounded at the parent's
/// cumulative origin. `display: none` is the hidden zero layout.
pub fn formula_rect(r: &Resolved, parent: (f32, f32), origin: (f32, f32)) -> LayoutRect {
    if r.display == spec::Display::None as u8 {
        return LayoutRect::default();
    }
    let size = |v: f32, full: f32| {
        if v.is_nan() {
            0.0
        } else if v < 0.0 {
            full
        } else {
            v
        }
    };
    let w = size(r.width, parent.0);
    let h = size(r.height, parent.1);
    let x = if r.inset[3].is_finite() {
        r.inset[3]
    } else if r.inset[1].is_finite() {
        parent.0 - r.inset[1] - w
    } else {
        0.0
    };
    let y = if r.inset[0].is_finite() {
        r.inset[0]
    } else if r.inset[2].is_finite() {
        parent.1 - r.inset[2] - h
    } else {
        0.0
    };
    rounded_rect((x, y), (w, h), origin).0
}

/// Sum of the rounded rects of `slot` and its ancestors: the cumulative origin
/// of a node whose chain is externally placed (static rects are integers, so
/// rounded and unrounded origins agree).
pub fn absolute_origin(tree: &Tree, slot: u32) -> (f32, f32) {
    let mut origin = (0.0, 0.0);
    let mut current = Some(slot);
    while let Some(s) = current {
        let node = &tree.slots[s as usize];
        origin.0 += node.layout.x;
        origin.1 += node.layout.y;
        current = tree.resolve(node.parent);
    }
    origin
}

/// floor() without std (coordinates are far from i32 limits).
#[inline]
pub fn floorf(x: f32) -> f32 {
    let t = x as i32 as f32; // trunc toward zero
    if x < t {
        t - 1.0
    } else {
        t
    }
}

/// round-half-up without std.
#[inline]
pub fn roundf(x: f32) -> f32 {
    floorf(x + 0.5)
}

/// Map an f32 dimension prop to taffy: NAN = auto, ANY negative = 100%
/// (the SIZE_FULL sentinel — spec.ts pins "any negative value is treated as
/// this sentinel"; "-full" is the only percentage v1 supports), else px.
fn dim(v: f32) -> taffy::Dimension {
    if v.is_nan() {
        taffy::Dimension::auto()
    } else if v < 0.0 {
        taffy::Dimension::percent(1.0)
    } else {
        taffy::Dimension::length(v)
    }
}

/// margin/inset value: NAN = auto, else px. Unlike `dim`, negatives are REAL
/// offsets (CSS negative margins / `inset-[-10]` outsets), not the SIZE_FULL
/// sentinel — that sentinel is pinned to width/height only (spec.ts).
fn lpa(v: f32) -> taffy::LengthPercentageAuto {
    if v.is_nan() {
        taffy::LengthPercentageAuto::auto()
    } else {
        taffy::LengthPercentageAuto::length(v)
    }
}

fn lp(v: f32) -> taffy::LengthPercentage {
    if v.is_nan() {
        taffy::LengthPercentage::length(0.0)
    } else {
        taffy::LengthPercentage::length(v)
    }
}

/// Map a resolved style onto taffy::Style (spec prop groups -> flexbox).
pub fn to_taffy(r: &Resolved) -> taffy::Style {
    let mut s = taffy::Style::default();
    s.display = if r.display == spec::Display::None as u8 {
        taffy::Display::None
    } else {
        taffy::Display::Flex
    };
    s.position = if r.pos_type == spec::PosType::Absolute as u8 {
        taffy::Position::Absolute
    } else {
        taffy::Position::Relative
    };
    s.overflow = taffy::Point {
        x: if r.overflow == spec::Overflow::Hidden as u8 {
            taffy::Overflow::Hidden
        } else {
            taffy::Overflow::Visible
        },
        y: if r.overflow == spec::Overflow::Hidden as u8 {
            taffy::Overflow::Hidden
        } else {
            taffy::Overflow::Visible
        },
    };
    s.flex_direction = if r.flex_dir == spec::FlexDir::Col as u8 {
        taffy::FlexDirection::Column
    } else {
        taffy::FlexDirection::Row
    };
    s.flex_wrap = if r.flex_wrap != 0 {
        taffy::FlexWrap::Wrap
    } else {
        taffy::FlexWrap::NoWrap
    };
    s.justify_content = Some(match r.justify {
        j if j == spec::Justify::Center as u8 => taffy::JustifyContent::CENTER,
        j if j == spec::Justify::End as u8 => taffy::JustifyContent::FLEX_END,
        j if j == spec::Justify::Between as u8 => taffy::JustifyContent::SPACE_BETWEEN,
        j if j == spec::Justify::Around as u8 => taffy::JustifyContent::SPACE_AROUND,
        _ => taffy::JustifyContent::FLEX_START,
    });
    s.align_items = Some(match r.align {
        a if a == spec::Align::Start as u8 => taffy::AlignItems::FLEX_START,
        a if a == spec::Align::Center as u8 => taffy::AlignItems::CENTER,
        a if a == spec::Align::End as u8 => taffy::AlignItems::FLEX_END,
        _ => taffy::AlignItems::STRETCH,
    });
    s.flex_grow = r.grow;
    s.flex_shrink = r.shrink;
    s.flex_basis = dim(r.basis);
    s.gap = Size {
        width: lp(r.gap),
        height: lp(r.gap),
    };
    s.size = Size {
        width: dim(r.width),
        height: dim(r.height),
    };
    s.min_size = Size {
        width: dim(r.min_w),
        height: dim(r.min_h),
    };
    s.max_size = Size {
        width: dim(r.max_w),
        height: dim(r.max_h),
    };
    // padding/margin/inset arrays are [t, r, b, l].
    s.padding = taffy::Rect {
        top: lp(r.padding[0]),
        right: lp(r.padding[1]),
        bottom: lp(r.padding[2]),
        left: lp(r.padding[3]),
    };
    s.margin = taffy::Rect {
        top: lpa(r.margin[0]),
        right: lpa(r.margin[1]),
        bottom: lpa(r.margin[2]),
        left: lpa(r.margin[3]),
    };
    s.inset = taffy::Rect {
        top: lpa(r.inset[0]),
        right: lpa(r.inset[1]),
        bottom: lpa(r.inset[2]),
        left: lpa(r.inset[3]),
    };
    s
}

/// Build the taffy node for `slot`'s subtree. Returns None for excluded
/// nodes (empty text runs). `in_transform` accumulates declared transforms
/// down the tree: text under one keeps the baked measurement pair, and the
/// choice is RECORDED on the node (`Node::text_native`) so paint follows
/// the provider that sized the box — never a mid-frame re-decision.
/// Ignores layout modes and regions: the full-tree oracle.
#[cfg(feature = "counters")]
fn build(
    tree: &mut Tree,
    styles: &StyleTable,
    fonts: &Fonts,
    taffy: &mut TaffyTree<MeasureCtx>,
    slot: u32,
    in_transform: bool,
    counters: &mut crate::counters::LayoutCounters,
) -> Option<taffy::NodeId> {
    let resolved = style::resolve(&tree.slots[slot as usize], styles, true);
    let in_transform = in_transform || resolved.declares_transform();
    let node_type = tree.slots[slot as usize].node_type;
    if node_type == spec::NodeType::Text as u8 {
        let mut run = String::new();
        tree.collect_run(slot, &mut run);
        if run.is_empty() {
            tree.slots[slot as usize].taffy = None;
            tree.slots[slot as usize].text_native = false;
            return None; // empty text nodes never consume gap/flex space [R]
        }
        let native = fonts.native_active() && resolved.tracking == 0.0 && !in_transform;
        tree.slots[slot as usize].text_native = native;
        let ctx = MeasureCtx::shaped(
            fonts,
            run,
            resolved.font_slot as u8,
            resolved.tracking,
            resolved.line_height,
            native,
        );
        counters.shaping_calls = counters.shaping_calls.saturating_add(1);
        let nid = taffy.new_leaf_with_context(to_taffy(&resolved), ctx).ok()?;
        counters.taffy_nodes_created = counters.taffy_nodes_created.saturating_add(1);
        counters.taffy_nodes += 1;
        tree.slots[slot as usize].taffy = Some(nid);
        return Some(nid);
    }
    let children = tree.slots[slot as usize].children.clone();
    let mut kids: Vec<taffy::NodeId> = Vec::with_capacity(children.len());
    for c in children {
        if let Some(cs) = tree.resolve(c) {
            if let Some(k) = build(tree, styles, fonts, taffy, cs, in_transform, counters) {
                kids.push(k);
            }
        }
    }
    let nid = taffy.new_with_children(to_taffy(&resolved), &kids).ok()?;
    counters.taffy_nodes_created = counters.taffy_nodes_created.saturating_add(1);
    counters.taffy_nodes += 1;
    tree.slots[slot as usize].taffy = Some(nid);
    Some(nid)
}

/// Compare the normalized layout projection, excluding paint-only fields.
/// Defaults such as auto/NaN are normalized by `to_taffy`; the two plain
/// floating-point flex factors need an explicit NaN-stable comparison.
fn styles_match(a: &taffy::Style, b: &taffy::Style) -> bool {
    if float_key(a.flex_grow) != float_key(b.flex_grow)
        || float_key(a.flex_shrink) != float_key(b.flex_shrink)
    {
        return false;
    }
    if !a.flex_grow.is_nan() && !a.flex_shrink.is_nan() {
        return a == b;
    }
    let mut a = a.clone();
    let mut b = b.clone();
    a.flex_grow = 0.0;
    a.flex_shrink = 0.0;
    b.flex_grow = 0.0;
    b.flex_shrink = 0.0;
    a == b
}

fn entry(eng: &LayoutEngine, tree: &Tree, slot: u32) -> Option<LayoutEntry> {
    let node = tree.slots.get(slot as usize)?;
    eng.entries
        .get(slot as usize)
        .copied()
        .flatten()
        .filter(|entry| node.alive && entry.id == node.id(slot))
}

fn update_style(eng: &mut LayoutEngine, handle: taffy::NodeId, resolved: &Resolved) {
    let next = to_taffy(resolved);
    if eng
        .taffy
        .style(handle)
        .is_ok_and(|old| styles_match(old, &next))
    {
        return;
    }
    let _ = eng.taffy.set_style(handle, next);
    #[cfg(feature = "counters")]
    {
        eng.counters.style_updates = eng.counters.style_updates.saturating_add(1);
    }
}

fn update_measure(
    eng: &mut LayoutEngine,
    fonts: &Fonts,
    handle: taffy::NodeId,
    run: String,
    resolved: &Resolved,
    native: bool,
    replay_misses: bool,
) {
    if let Some(context) = eng.taffy.get_node_context(handle) {
        if context.environment_epoch == eng.environment_epoch {
            if context.matches(
                &run,
                resolved.font_slot as u8,
                resolved.tracking,
                resolved.line_height,
                native,
            ) {
                if replay_misses {
                    context.replay_misses(fonts);
                }
                return;
            }
        }
    }
    let mut context = MeasureCtx::shaped(
        fonts,
        run,
        resolved.font_slot as u8,
        resolved.tracking,
        resolved.line_height,
        native,
    );
    context.environment_epoch = eng.environment_epoch;
    #[cfg(feature = "counters")]
    {
        eng.counters.shaping_calls = eng.counters.shaping_calls.saturating_add(1);
    }
    let _ = eng.taffy.set_node_context(handle, Some(context));
}

/// Taffy's remove() does not release its secondary context map or dirty the
/// former parent. Do both explicitly before removing a destroyed generation.
fn retire_dead(tree: &Tree, eng: &mut LayoutEngine) {
    for slot in 0..eng.entries.len() {
        let Some(old) = eng.entries[slot] else {
            continue;
        };
        if tree.resolve(old.id).is_some() {
            continue;
        }
        retire_entry(eng, slot, old);
    }
}

fn retire_entry(eng: &mut LayoutEngine, slot: usize, old: LayoutEntry) {
    let _ = eng.taffy.set_node_context(old.handle, None);
    let _ = eng.taffy.set_children(old.handle, &[]);
    let _ = eng.taffy.remove(old.handle);
    eng.entries[slot] = None;
    #[cfg(feature = "counters")]
    {
        eng.counters.taffy_nodes = eng.counters.taffy_nodes.saturating_sub(1);
    }
}

fn retire_unprojected(tree: &Tree, eng: &mut LayoutEngine, root_id: i32) {
    for slot in 0..eng.entries.len() {
        let Some(old) = eng.entries[slot] else {
            continue;
        };
        if !old.active
            && (tree.is_in_subtree(root_id, old.id)
                || eng
                    .other_output_root
                    .is_some_and(|other| tree.is_in_subtree(other, old.id)))
        {
            retire_entry(eng, slot, old);
        }
    }
}

/// Reconcile the projected tree while preserving every unchanged Taffy node.
/// Text elements terminate traversal: their inline descendants belong to a
/// single measurement leaf, and empty runs occupy no flex item or gap.
fn sync_node(
    tree: &mut Tree,
    styles: &StyleTable,
    fonts: &Fonts,
    eng: &mut LayoutEngine,
    slot: u32,
    in_transform: bool,
    replay_all_misses: bool,
    style_dirty: &[u32],
) -> Option<taffy::NodeId> {
    if tree.slots[slot as usize].layout_mode != LAYOUT_LIVE {
        return None; // externally placed: the subtree has no solver nodes
    }
    let resolved = style::resolve(&tree.slots[slot as usize], styles, true);
    let declares_transform = resolved.declares_transform();
    let in_transform = in_transform || declares_transform;
    let is_text = tree.slots[slot as usize].node_type == spec::NodeType::Text as u8;
    let mut run = String::new();
    if is_text {
        tree.collect_run(slot, &mut run);
        if run.is_empty() {
            return None;
        }
    }
    let native = is_text && fonts.native_active() && resolved.tracking == 0.0 && !in_transform;
    let old = entry(eng, tree, slot);
    let handle = if let Some(old) = old {
        update_style(eng, old.handle, &resolved);
        if is_text {
            update_measure(
                eng,
                fonts,
                old.handle,
                run,
                &resolved,
                native,
                replay_all_misses || style_dirty.binary_search(&slot).is_ok(),
            );
        }
        old.handle
    } else {
        let handle = if is_text {
            let mut context = MeasureCtx::shaped(
                fonts,
                run,
                resolved.font_slot as u8,
                resolved.tracking,
                resolved.line_height,
                native,
            );
            context.environment_epoch = eng.environment_epoch;
            #[cfg(feature = "counters")]
            {
                eng.counters.shaping_calls = eng.counters.shaping_calls.saturating_add(1);
            }
            eng.taffy
                .new_leaf_with_context(to_taffy(&resolved), context)
                .ok()?
        } else {
            eng.taffy.new_leaf(to_taffy(&resolved)).ok()?
        };
        #[cfg(feature = "counters")]
        {
            eng.counters.taffy_nodes_created = eng.counters.taffy_nodes_created.saturating_add(1);
            eng.counters.taffy_nodes = eng.counters.taffy_nodes.saturating_add(1);
        }
        handle
    };
    eng.entries[slot as usize] = Some(LayoutEntry {
        id: tree.slots[slot as usize].id(slot),
        handle,
        active: true,
        declares_transform,
    });
    if is_text {
        tree.slots[slot as usize].text_native = native;
    } else if tree.slots[slot as usize].region_root {
        // A leaf in this projection: the region's own root holds the children
        // (`sync_region`).
        if eng.taffy.children(handle).is_ok_and(|old| !old.is_empty()) {
            let _ = eng.taffy.set_children(handle, &[]);
            invalidate_ancestors(&mut eng.taffy, handle);
        }
    } else {
        let children = tree.slots[slot as usize].children.clone();
        let mut projected = Vec::with_capacity(children.len());
        for child in children {
            if let Some(child_slot) = tree.resolve(child) {
                if let Some(child_handle) = sync_node(
                    tree,
                    styles,
                    fonts,
                    eng,
                    child_slot,
                    in_transform,
                    replay_all_misses,
                    style_dirty,
                ) {
                    projected.push(child_handle);
                }
            }
        }
        // set_children also detaches moves from their old parent and dirties
        // both ancestor chains. Calling it for an unchanged list loses cache.
        if !eng.taffy.children(handle).is_ok_and(|old| old == projected) {
            let _ = eng.taffy.set_children(handle, &projected);
            invalidate_ancestors(&mut eng.taffy, handle);
        }
    }
    Some(handle)
}

/// Taffy stops dirty propagation at a node whose cache is already empty and
/// assumes its ancestors are dirty. Hidden layout breaks that assumption: it
/// empties every cache below a display:none node but keeps that node's own
/// result, so a node attached below it would keep its previous layout.
/// Marking each ancestor reaches the display:none node.
fn invalidate_ancestors(taffy: &mut TaffyTree<MeasureCtx>, node: taffy::NodeId) {
    let mut current = taffy.parent(node);
    while let Some(ancestor) = current {
        let _ = taffy.mark_dirty(ancestor);
        current = taffy.parent(ancestor);
    }
}

fn in_transform(tree: &Tree, styles: &StyleTable, slot: u32, root_id: i32) -> bool {
    let mut current = Some(slot);
    while let Some(slot) = current {
        let node = &tree.slots[slot as usize];
        if style::resolve(node, styles, true).declares_transform() {
            return true;
        }
        if node.id(slot) == root_id {
            break;
        }
        current = tree.resolve(node.parent);
    }
    false
}

/// Assign `slot`'s rounded rect from its active solver node (the zero rect
/// without one) and return its cumulative unrounded origin and box.
/// Node::taffy remains a compatibility view, never an input to another output.
fn assign_rect(
    tree: &mut Tree,
    eng: &LayoutEngine,
    slot: u32,
    cum: (f32, f32),
) -> ((f32, f32), (f32, f32)) {
    let handle = entry(eng, tree, slot)
        .filter(|entry| entry.active)
        .map(|entry| entry.handle);
    let (rect, child_cum, size) = match handle {
        Some(handle) => {
            let layout = eng.taffy.unrounded_layout(handle);
            let location = (layout.location.x, layout.location.y);
            let size = (layout.size.width, layout.size.height);
            let (rect, child_cum) = rounded_rect(location, size, cum);
            (rect, child_cum, size)
        }
        None => (LayoutRect::default(), cum, (0.0, 0.0)),
    };
    let node = &mut tree.slots[slot as usize];
    node.taffy = handle;
    node.layout = rect;
    if node.node_type == spec::NodeType::Text as u8 {
        node.text_native = handle
            .and_then(|handle| eng.taffy.get_node_context(handle))
            .is_some_and(|context| context.native);
    }
    (child_cum, size)
}

/// Copy rounded layout output for the live nodes one projection owns: `slot`
/// itself when `assign_root`, then its descendants until a static node (its
/// subtree is placed externally) or a region root (a leaf here; its region
/// reads back the children and takes its origin and box from this pass).
fn readback_scope(
    tree: &mut Tree,
    eng: &mut LayoutEngine,
    slot: u32,
    assign_root: bool,
    cum: (f32, f32),
) {
    let cum = if assign_root {
        assign_rect(tree, eng, slot, cum).0
    } else {
        cum
    };
    let children = tree.slots[slot as usize].children.clone();
    for child in children {
        let Some(child_slot) = tree.resolve(child) else {
            continue;
        };
        if tree.slots[child_slot as usize].layout_mode != LAYOUT_LIVE {
            continue;
        }
        let (child_cum, size) = assign_rect(tree, eng, child_slot, cum);
        if tree.slots[child_slot as usize].region_root {
            if let Some(index) = eng.region_index(child) {
                eng.regions[index].origin = child_cum;
                eng.regions[index].unrounded_box = size;
            }
            continue;
        }
        readback_scope(tree, eng, child_slot, false, child_cum);
    }
}

/// Measure closure shared by every solve: a text leaf answers with its shaped
/// size on the axes the solver left open.
fn measure_leaf(
    known: Size<Option<f32>>,
    ctx: Option<&mut MeasureCtx>,
) -> Size<f32> {
    match ctx {
        Some(m) => Size {
            width: known.width.unwrap_or(m.size.0),
            height: known.height.unwrap_or(m.size.1),
        },
        None => Size {
            width: 0.0,
            height: 0.0,
        },
    }
}

fn compute(tree: &mut Tree, eng: &mut LayoutEngine, root_slot: u32, root_nid: taffy::NodeId) {
    #[cfg(feature = "counters")]
    {
        eng.counters.layout_passes = eng.counters.layout_passes.saturating_add(1);
    }
    #[cfg(feature = "counters")]
    let mut callbacks = 0u64;
    let _ = eng.taffy.compute_layout_with_measure(
        root_nid,
        Size {
            width: AvailableSpace::Definite(eng.viewport.0),
            height: AvailableSpace::Definite(eng.viewport.1),
        },
        |known, _available, _id, ctx, _style| -> Size<f32> {
            #[cfg(feature = "counters")]
            {
                callbacks = callbacks.saturating_add(1);
            }
            measure_leaf(known, ctx)
        },
    );
    #[cfg(feature = "counters")]
    {
        eng.counters.measure_callbacks = eng.counters.measure_callbacks.saturating_add(callbacks);
    }
    eng.solved_viewport = Some((eng.viewport.0.to_bits(), eng.viewport.1.to_bits()));
    // Rounding is cumulative: a cached child's pixel rounding can change when
    // an ancestor moves, so every owned node reads back.
    readback_scope(tree, eng, root_slot, true, (0.0, 0.0));
}

pub fn relayout(tree: &mut Tree, styles: &StyleTable, fonts: &Fonts, eng: &mut LayoutEngine) {
    relayout_root(tree, styles, fonts, eng, spec::ROOT_ID);
}

/// Relayout one independent output root. Ordinary structure changes reconcile
/// the projection; style-only changes touch their existing nodes. Both paths
/// compute from the root so Taffy's constraint-keyed cache remains authoritative.
/// Regions reconcile and solve after their parent projection.
pub fn relayout_root(
    tree: &mut Tree,
    styles: &StyleTable,
    fonts: &Fonts,
    eng: &mut LayoutEngine,
    root_id: i32,
) {
    if !eng.needs() && eng.built {
        return;
    }
    #[cfg(feature = "counters")]
    if eng.reference_rebuild {
        eng.reference_rebuild = false;
        reference_rebuild(tree, styles, fonts, eng, root_id);
        return;
    }
    let mut dirty = core::mem::take(&mut eng.style_dirty);
    let replay_all_misses = eng.dirty || !eng.built;
    eng.entries.resize(tree.slots.len(), None);
    // Regions whose root node is gone release their solver root.
    let mut index = 0;
    while index < eng.regions.len() {
        if tree.resolve(eng.regions[index].id).is_none() {
            let id = eng.regions[index].id;
            eng.unregister_region(id);
        } else {
            index += 1;
        }
    }
    // An ancestor's transform changes the text measurement provider. Revisit
    // that projection even when its own normalized flex style is unchanged.
    let transform_changed = |dirty: &[u32], eng: &LayoutEngine| {
        dirty.iter().any(|&slot| {
            entry(eng, tree, slot).is_some_and(|old| {
                old.active
                    && old.declares_transform
                        != style::resolve(&tree.slots[slot as usize], styles, true)
                            .declares_transform()
            })
        })
    };
    let full = eng.dirty
        || !eng.built
        || transform_changed(&dirty, eng)
        || eng
            .regions
            .iter()
            .any(|region| transform_changed(&region.style_dirty, eng));
    if full {
        #[cfg(feature = "counters")]
        {
            eng.counters.structure_syncs = eng.counters.structure_syncs.saturating_add(1);
            if !eng.built {
                eng.counters.structure_rebuilds = eng.counters.structure_rebuilds.saturating_add(1);
            }
        }
        for region in &mut eng.regions {
            dirty.append(&mut region.style_dirty);
        }
        dirty.sort_unstable();
        dirty.dedup();
        retire_dead(tree, eng);
        for item in eng.entries.iter_mut().flatten() {
            item.active = false;
        }
        eng.root = tree.resolve(root_id).and_then(|slot| {
            sync_node(
                tree,
                styles,
                fonts,
                eng,
                slot,
                false,
                replay_all_misses,
                &dirty,
            )
        });
        for index in 0..eng.regions.len() {
            sync_region(tree, styles, fonts, eng, index, root_id, replay_all_misses, &dirty);
        }
        retire_unprojected(tree, eng, root_id);
        if let Some(handle) = eng.root {
            if let Some(parent) = eng.taffy.parent(handle) {
                let _ = eng.taffy.remove_child(parent, handle);
            }
        }
        eng.built = true;
        eng.dirty = false;
    } else {
        dirty.sort_unstable();
        dirty.dedup();
        restyle(tree, styles, fonts, eng, root_id, &dirty);
        for index in 0..eng.regions.len() {
            if eng.regions[index].dirty {
                #[cfg(feature = "counters")]
                {
                    eng.counters.structure_syncs = eng.counters.structure_syncs.saturating_add(1);
                }
                let mut region_dirty = core::mem::take(&mut eng.regions[index].style_dirty);
                region_dirty.sort_unstable();
                region_dirty.dedup();
                retire_dead(tree, eng);
                let Some(root_slot) = tree.resolve(eng.regions[index].id) else {
                    continue;
                };
                let mut owned = Vec::new();
                collect_owned(tree, root_slot, &mut owned);
                for &slot in &owned {
                    if let Some(item) = eng.entries[slot as usize].as_mut() {
                        item.active = false;
                    }
                }
                sync_region(tree, styles, fonts, eng, index, root_id, replay_all_misses, &region_dirty);
                for slot in owned {
                    if let Some(old) = eng.entries[slot as usize] {
                        if !old.active {
                            retire_entry(eng, slot as usize, old);
                        }
                    }
                }
            } else if !eng.regions[index].style_dirty.is_empty() {
                let mut region_dirty = core::mem::take(&mut eng.regions[index].style_dirty);
                region_dirty.sort_unstable();
                region_dirty.dedup();
                restyle(tree, styles, fonts, eng, root_id, &region_dirty);
            }
        }
    }
    if let Some(root_slot) = tree.resolve(root_id) {
        match eng.root {
            Some(root) => {
                if eng.taffy.dirty(root).unwrap_or(true)
                    || eng.solved_viewport != Some((eng.viewport.0.to_bits(), eng.viewport.1.to_bits()))
                {
                    compute(tree, eng, root_slot, root);
                } else {
                    readback_scope(tree, eng, root_slot, true, (0.0, 0.0));
                }
            }
            None => readback_scope(tree, eng, root_slot, true, (0.0, 0.0)),
        }
    }
    solve_regions(tree, eng);
}

/// Apply changed resolved styles (and text runs) to existing solver nodes.
fn restyle(
    tree: &mut Tree,
    styles: &StyleTable,
    fonts: &Fonts,
    eng: &mut LayoutEngine,
    root_id: i32,
    dirty: &[u32],
) {
    for &slot in dirty {
        let Some(old) = entry(eng, tree, slot).filter(|entry| entry.active) else {
            continue;
        };
        let resolved = style::resolve(&tree.slots[slot as usize], styles, true);
        update_style(eng, old.handle, &resolved);
        if tree.slots[slot as usize].node_type == spec::NodeType::Text as u8 {
            let mut run = String::new();
            tree.collect_run(slot, &mut run);
            let native = fonts.native_active()
                && resolved.tracking == 0.0
                && !in_transform(tree, styles, slot, root_id);
            update_measure(eng, fonts, old.handle, run, &resolved, native, true);
        } else if tree.slots[slot as usize].region_root {
            // The region's own root carries the structural half of this style.
            let id = tree.slots[slot as usize].id(slot);
            if let Some(region_root) = eng.region_index(id).and_then(|index| eng.regions[index].root) {
                let next = region_root_style(&resolved, eng.taffy.style(region_root).map_or((0.0, 0.0), style_size));
                if !eng.taffy.style(region_root).is_ok_and(|old| styles_match(old, &next)) {
                    let _ = eng.taffy.set_style(region_root, next);
                }
            }
        }
    }
}

/// The definite size a region root style carries, as plain px.
fn style_size(style: &taffy::Style) -> (f32, f32) {
    let px = |d: taffy::Dimension| d.into_raw().value();
    (px(style.size.width), px(style.size.height))
}

/// A region's solver root: the root node's layout style with the box as a
/// definite size and no placement of its own (the parent projection places
/// the node). Flex factors and min/max are dropped: the box is final.
fn region_root_style(resolved: &Resolved, size: (f32, f32)) -> taffy::Style {
    let mut style = to_taffy(resolved);
    style.position = taffy::Position::Relative;
    style.inset = taffy::Rect::auto();
    style.margin = taffy::Rect::zero();
    style.flex_grow = 0.0;
    style.flex_shrink = 0.0;
    style.flex_basis = taffy::Dimension::auto();
    style.min_size = Size::auto();
    style.max_size = Size::auto();
    style.size = Size {
        width: taffy::Dimension::length(size.0),
        height: taffy::Dimension::length(size.1),
    };
    style
}

/// Reconcile one region: its solver root and the projection of its children.
fn sync_region(
    tree: &mut Tree,
    styles: &StyleTable,
    fonts: &Fonts,
    eng: &mut LayoutEngine,
    index: usize,
    root_id: i32,
    replay_all_misses: bool,
    style_dirty: &[u32],
) {
    let id = eng.regions[index].id;
    let Some(slot) = tree.resolve(id) else {
        return;
    };
    let resolved = style::resolve(&tree.slots[slot as usize], styles, true);
    let next = region_root_style(&resolved, eng.regions[index].unrounded_box);
    let region_root = match eng.regions[index].root {
        Some(root) => {
            if !eng.taffy.style(root).is_ok_and(|old| styles_match(old, &next)) {
                let _ = eng.taffy.set_style(root, next);
            }
            root
        }
        None => {
            let Ok(root) = eng.taffy.new_leaf(next) else {
                return;
            };
            eng.regions[index].root = Some(root);
            root
        }
    };
    let in_transform = in_transform(tree, styles, slot, root_id);
    let children = tree.slots[slot as usize].children.clone();
    let mut projected = Vec::with_capacity(children.len());
    for child in children {
        if let Some(child_slot) = tree.resolve(child) {
            if let Some(handle) = sync_node(
                tree,
                styles,
                fonts,
                eng,
                child_slot,
                in_transform,
                replay_all_misses,
                style_dirty,
            ) {
                projected.push(handle);
            }
        }
    }
    if !eng.taffy.children(region_root).is_ok_and(|old| old == projected) {
        let _ = eng.taffy.set_children(region_root, &projected);
        let _ = eng.taffy.mark_dirty(region_root);
    }
    eng.regions[index].dirty = false;
}

/// Solve every region whose box or structure changed, outer regions first,
/// and read back their children.
fn solve_regions(tree: &mut Tree, eng: &mut LayoutEngine) {
    if eng.regions.is_empty() {
        return;
    }
    let mut order: Vec<usize> = (0..eng.regions.len()).collect();
    if order.len() > 1 {
        order.sort_by_key(|&index| depth(tree, eng.regions[index].id));
    }
    for index in order {
        let Some(slot) = tree.resolve(eng.regions[index].id) else {
            continue;
        };
        let Some(region_root) = eng.regions[index].root else {
            continue;
        };
        if tree.slots[slot as usize].layout_mode != LAYOUT_LIVE {
            // A static root: box and origin come from the assigned rect chain.
            let rect = tree.slots[slot as usize].layout;
            eng.regions[index].unrounded_box = (rect.w, rect.h);
            eng.regions[index].origin = absolute_origin(tree, slot);
        }
        let size = eng.regions[index].unrounded_box;
        let key = (size.0.to_bits(), size.1.to_bits());
        let box_changed = eng.regions[index].solved_box != Some(key);
        if box_changed {
            if let Ok(style) = eng.taffy.style(region_root) {
                let mut style = style.clone();
                style.size = Size {
                    width: taffy::Dimension::length(size.0),
                    height: taffy::Dimension::length(size.1),
                };
                let _ = eng.taffy.set_style(region_root, style);
            }
        }
        let origin = eng.regions[index].origin;
        if box_changed || eng.taffy.dirty(region_root).unwrap_or(true) {
            #[cfg(feature = "counters")]
            {
                eng.counters.layout_passes = eng.counters.layout_passes.saturating_add(1);
            }
            #[cfg(feature = "counters")]
            let mut callbacks = 0u64;
            let _ = eng.taffy.compute_layout_with_measure(
                region_root,
                Size {
                    width: AvailableSpace::Definite(size.0),
                    height: AvailableSpace::Definite(size.1),
                },
                |known, _available, _id, ctx, _style| -> Size<f32> {
                    #[cfg(feature = "counters")]
                    {
                        callbacks = callbacks.saturating_add(1);
                    }
                    measure_leaf(known, ctx)
                },
            );
            #[cfg(feature = "counters")]
            {
                eng.counters.measure_callbacks = eng.counters.measure_callbacks.saturating_add(callbacks);
            }
            eng.regions[index].solved_box = Some(key);
        }
        readback_scope(tree, eng, slot, false, origin);
    }
}

/// Slots whose solver entries belong to region root `slot`'s projection: its
/// descendants, stopping at static subtrees and below nested region roots
/// (the nested root's leaf entry is included, its children are not).
fn collect_owned(tree: &Tree, slot: u32, out: &mut Vec<u32>) {
    for &child in &tree.slots[slot as usize].children {
        let Some(child_slot) = tree.resolve(child) else {
            continue;
        };
        let node = &tree.slots[child_slot as usize];
        if node.layout_mode != LAYOUT_LIVE {
            continue;
        }
        out.push(child_slot);
        if !node.region_root {
            collect_owned(tree, child_slot, out);
        }
    }
}

/// Number of ancestors of node `id`.
fn depth(tree: &Tree, id: i32) -> usize {
    let mut depth = 0;
    let mut current = tree.get(id).map(|node| node.parent).unwrap_or(0);
    while let Some(slot) = tree.resolve(current) {
        depth += 1;
        current = tree.slots[slot as usize].parent;
    }
    depth
}

/// Unrounded solver output of a live node: (x, y, w, h) relative to its
/// parent, or None for nodes without a solver node.
pub fn unrounded_of(eng: &LayoutEngine, tree: &Tree, slot: u32) -> Option<(f32, f32, f32, f32)> {
    let entry = entry(eng, tree, slot).filter(|entry| entry.active)?;
    let layout = eng.taffy.unrounded_layout(entry.handle);
    Some((layout.location.x, layout.location.y, layout.size.width, layout.size.height))
}

/// Full-tree oracle for regions, static and formula nodes: solve every
/// attached node under `root_id` in one fresh tree, ignoring every mode, and
/// return each live node whose rounded rect differs from `Node::layout` as
/// (id, expected, actual).
#[cfg(feature = "counters")]
pub fn reference_mismatches(
    tree: &mut Tree,
    styles: &StyleTable,
    fonts: &Fonts,
    viewport: (f32, f32),
    root_id: i32,
) -> Vec<(i32, LayoutRect, LayoutRect)> {
    let saved: Vec<(Option<taffy::NodeId>, bool)> = tree
        .slots
        .iter()
        .map(|node| (node.taffy, node.text_native))
        .collect();
    let mut counters = crate::counters::LayoutCounters::default();
    let mut taffy = new_taffy();
    let mut out = Vec::new();
    if let Some(root_slot) = tree.resolve(root_id) {
        if let Some(root) = build(tree, styles, fonts, &mut taffy, root_slot, false, &mut counters) {
            let _ = taffy.compute_layout_with_measure(
                root,
                Size {
                    width: AvailableSpace::Definite(viewport.0),
                    height: AvailableSpace::Definite(viewport.1),
                },
                |known, _available, _id, ctx, _style| -> Size<f32> { measure_leaf(known, ctx) },
            );
            compare_reference(tree, &taffy, root_slot, (0.0, 0.0), &mut out);
        }
    }
    for (slot, node) in tree.slots.iter_mut().enumerate() {
        node.taffy = saved[slot].0;
        node.text_native = saved[slot].1;
    }
    out
}

#[cfg(feature = "counters")]
fn compare_reference(
    tree: &Tree,
    taffy: &TaffyTree<MeasureCtx>,
    slot: u32,
    cum: (f32, f32),
    out: &mut Vec<(i32, LayoutRect, LayoutRect)>,
) {
    let node = &tree.slots[slot as usize];
    let (expected, cum) = match node.taffy {
        Some(handle) => {
            let layout = taffy.unrounded_layout(handle);
            rounded_rect(
                (layout.location.x, layout.location.y),
                (layout.size.width, layout.size.height),
                cum,
            )
        }
        None => (LayoutRect::default(), cum),
    };
    if expected != node.layout {
        out.push((node.id(slot), expected, node.layout));
    }
    for &child in &node.children {
        if let Some(child_slot) = tree.resolve(child) {
            compare_reference(tree, taffy, child_slot, cum, out);
        }
    }
}

/// Original recursive builder retained as an independent projection oracle.
#[cfg(feature = "counters")]
fn reference_rebuild(
    tree: &mut Tree,
    styles: &StyleTable,
    fonts: &Fonts,
    eng: &mut LayoutEngine,
    root_id: i32,
) {
    eng.counters.structure_rebuilds = eng.counters.structure_rebuilds.saturating_add(1);
    let mut slots = Vec::new();
    tree.collect_subtree(root_id, &mut slots);
    for &slot in &slots {
        tree.slots[slot as usize].taffy = None;
    }
    eng.root = tree.resolve(root_id).and_then(|slot| {
        build(
            tree,
            styles,
            fonts,
            &mut eng.taffy,
            slot,
            false,
            &mut eng.counters,
        )
    });
    eng.entries.resize(tree.slots.len(), None);
    for slot in slots {
        let node = &tree.slots[slot as usize];
        if let Some(handle) = node.taffy {
            eng.entries[slot as usize] = Some(LayoutEntry {
                id: node.id(slot),
                handle,
                active: true,
                declares_transform: style::resolve(node, styles, true).declares_transform(),
            });
        }
    }
    eng.built = true;
    eng.dirty = false;
    for region in &mut eng.regions {
        region.root = None;
        region.dirty = true;
        region.solved_box = None;
    }
    if let (Some(root), Some(root_slot)) = (eng.root, tree.resolve(root_id)) {
        compute(tree, eng, root_slot, root);
    }
}

/// Smoke helper proving the pinned taffy feature set
/// (alloc + taffy_tree + flexbox + content_size, no default features)
/// actually resolves and compiles for every target.
pub fn taffy_smoke() -> taffy::TaffyTree<()> {
    taffy::TaffyTree::new()
}
