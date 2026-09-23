//! taffy integration: resolved styles -> taffy::Style, text measure
//! functions, dirty tracking and rounded layout readback.
//!
//! Strategy (v1, documented): the taffy tree is REBUILT from scratch on every
//! relayout instead of incrementally synced. Relayouts only happen when the
//! dirty flag is set (structure/layout-prop mutations, layout-prop animation
//! frames), and UI trees on a 480x272 screen are small, so the rebuild is
//! well inside budget and keeps the sync logic trivially correct.
//!
//! Text nodes: a text ELEMENT becomes a taffy measure leaf over its
//! concatenated inline run; text children of a text element are absorbed into
//! that run (never flex items). Text nodes whose run is EMPTY (Solid `<Show>`
//! markers) are excluded from the taffy tree entirely [R].

use alloc::string::String;
use alloc::vec::Vec;

use taffy::{AvailableSpace, Size, TaffyTree};

use crate::spec;
use crate::style::{self, Resolved, StyleTable};
use crate::text::Fonts;
use crate::tree::{LayoutRect, Tree};

/// Measure context attached to text leaves (taffy NodeContext).
///
/// Deliberately minimal: the solve-time measure closure reads only `size`,
/// and shaping happens once in `MeasureCtx::shaped` (build/restyle) against
/// the freshly collected run — storing slot/tracking/line_height here (or
/// the run itself) would be dead weight duplicated per text node.
pub struct MeasureCtx {
    /// Shaped size, computed ONCE when the context is (re)built. Text
    /// shaping is the expensive half of layout on the PSP; the taffy
    /// measure closure must never re-shape per solve pass.
    pub size: (f32, f32),
}

impl MeasureCtx {
    fn shaped(
        fonts: &Fonts,
        text: &str,
        slot: u8,
        tracking: f32,
        line_height: f32,
        native: bool,
    ) -> MeasureCtx {
        let size = fonts.measure_run_provider(native, text, slot, tracking, line_height);
        MeasureCtx { size }
    }
}

/// The layout engine: one TaffyTree + the dirty flag.
pub struct LayoutEngine {
    pub taffy: TaffyTree<MeasureCtx>,
    /// STRUCTURE dirty: the taffy tree must be rebuilt from scratch (node
    /// inserts/removes/destroys, text content changes, table/font swaps).
    pub dirty: bool,
    /// STYLE dirty slots: nodes whose resolved style changed but whose place
    /// in the tree did not — relayout restyles just these in the live taffy
    /// tree and lets taffy recompute the affected subtrees (per-frame
    /// keyframe animations of layout props stay incremental instead of
    /// rebuilding ~everything at 60 Hz).
    pub style_dirty: Vec<u32>,
    /// True once `relayout` has built a taffy tree for the current structure.
    pub built: bool,
    /// Root taffy node of the built tree.
    pub root: Option<taffy::NodeId>,
    /// Layout viewport in px. Defaults to the PSP screen; desktop hosts set it
    /// through `Ui::set_viewport` (the draw clip stage uses the same bounds).
    pub viewport: (f32, f32),
}

impl Default for LayoutEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl LayoutEngine {
    /// Mark one node style-dirty (cheap; deduped at relayout).
    pub fn mark_style(&mut self, slot: u32) {
        self.style_dirty.push(slot);
    }

    /// Anything for `relayout` to do?
    pub fn needs(&self) -> bool {
        self.dirty || !self.style_dirty.is_empty()
    }

    pub fn new() -> LayoutEngine {
        LayoutEngine {
            taffy: TaffyTree::new(),
            dirty: true,
            style_dirty: Vec::new(),
            built: false,
            root: None,
            viewport: (spec::SCREEN_W as f32, spec::SCREEN_H as f32),
        }
    }
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
fn build(
    tree: &mut Tree,
    styles: &StyleTable,
    fonts: &Fonts,
    taffy: &mut TaffyTree<MeasureCtx>,
    slot: u32,
    in_transform: bool,
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
            &run,
            resolved.font_slot as u8,
            resolved.tracking,
            resolved.line_height,
            native,
        );
        let nid = taffy.new_leaf_with_context(to_taffy(&resolved), ctx).ok()?;
        tree.slots[slot as usize].taffy = Some(nid);
        return Some(nid);
    }
    let child_count = tree.slots[slot as usize].children.len();
    let mut kids: Vec<taffy::NodeId> = Vec::with_capacity(child_count);
    for i in 0..child_count {
        let c = tree.slots[slot as usize].children[i];
        if let Some(cs) = tree.resolve(c) {
            if let Some(k) = build(tree, styles, fonts, taffy, cs, in_transform) {
                kids.push(k);
            }
        }
    }
    let nid = taffy.new_with_children(to_taffy(&resolved), &kids).ok()?;
    tree.slots[slot as usize].taffy = Some(nid);
    Some(nid)
}

/// Copy rounded layout output back into the node tree (flat pass — layouts
/// are parent-relative, so order does not matter; no per-node allocations).
fn readback(tree: &mut Tree, taffy: &TaffyTree<MeasureCtx>, root_id: i32) {
    let mut slots = Vec::new();
    tree.collect_subtree(root_id, &mut slots);
    for slot in slots {
        let node = &mut tree.slots[slot as usize];
        match node.taffy {
            Some(nid) => {
                if let Ok(l) = taffy.layout(nid) {
                    node.layout = LayoutRect {
                        x: roundf(l.location.x),
                        y: roundf(l.location.y),
                        w: roundf(l.size.width),
                        h: roundf(l.size.height),
                    };
                }
            }
            None => node.layout = LayoutRect::default(),
        }
    }
}

fn compute(
    tree: &mut Tree,
    _fonts: &Fonts,
    eng: &mut LayoutEngine,
    root_id: i32,
    root_nid: taffy::NodeId,
) {
    let _ = eng.taffy.compute_layout_with_measure(
        root_nid,
        Size {
            width: AvailableSpace::Definite(eng.viewport.0),
            height: AvailableSpace::Definite(eng.viewport.1),
        },
        |known, _available, _id, ctx, _style| -> Size<f32> {
            match ctx {
                Some(m) => Size {
                    width: known.width.unwrap_or(m.size.0),
                    height: known.height.unwrap_or(m.size.1),
                },
                None => Size { width: 0.0, height: 0.0 },
            }
        },
    );
    readback(tree, &eng.taffy, root_id);
}

/// Relayout. STYLE-only dirt restyles the dirty nodes in the LIVE taffy tree
/// (taffy recomputes just the affected subtrees — this is what keeps
/// layout-prop keyframe animations 60 Hz on the PSP); STRUCTURE dirt rebuilds
/// the tree from scratch.
pub fn relayout(tree: &mut Tree, styles: &StyleTable, fonts: &Fonts, eng: &mut LayoutEngine) {
    relayout_root(tree, styles, fonts, eng, spec::ROOT_ID);
}

/// Relayout one independent output root. Auxiliary roots share the arena and
/// resource tables with the primary tree, but keep separate taffy state and
/// viewport bounds.
pub fn relayout_root(
    tree: &mut Tree,
    styles: &StyleTable,
    fonts: &Fonts,
    eng: &mut LayoutEngine,
    root_id: i32,
) {
    if !eng.dirty && eng.built {
        if eng.style_dirty.is_empty() {
            return;
        }
        eng.style_dirty.sort_unstable();
        eng.style_dirty.dedup();
        let dirty = core::mem::take(&mut eng.style_dirty);
        for &slot in &dirty {
            if !tree.slots[slot as usize].alive {
                continue;
            }
            let node_id = tree.slots[slot as usize].id(slot);
            if !tree.is_in_subtree(root_id, node_id) {
                continue;
            }
            let Some(nid) = tree.slots[slot as usize].taffy else {
                // Not part of the built tree: detached subtrees relayout on
                // re-insert (structure dirty), and excluded empty text runs
                // only re-enter through set_text (also structure dirty).
                continue;
            };
            let resolved = style::resolve(&tree.slots[slot as usize], styles, true);
            if tree.slots[slot as usize].node_type == spec::NodeType::Text as u8 {
                let mut run = String::new();
                tree.collect_run(slot, &mut run);
                // A restyle keeps the RECORDED provider (it has no ancestor
                // context to re-derive the transform gate); only a node-local
                // tracking change can flip the record — to the baked pair,
                // which handles tracking (native shaping does not).
                let native = tree.slots[slot as usize].text_native && resolved.tracking == 0.0;
                tree.slots[slot as usize].text_native = native;
                let ctx = MeasureCtx::shaped(
                    fonts,
                    &run,
                    resolved.font_slot as u8,
                    resolved.tracking,
                    resolved.line_height,
                    native,
                );
                let _ = eng.taffy.set_node_context(nid, Some(ctx));
            }
            let _ = eng.taffy.set_style(nid, to_taffy(&resolved));
        }
        if let Some(root_nid) = eng.root {
            compute(tree, fonts, eng, root_id, root_nid);
            return;
        }
        eng.dirty = true; // no built root (should not happen) — full rebuild
    }
    eng.taffy.clear();
    eng.style_dirty.clear();
    let mut surface_slots = Vec::new();
    tree.collect_subtree(root_id, &mut surface_slots);
    for &slot in &surface_slots {
        tree.slots[slot as usize].taffy = None;
    }
    let Some(root_slot) = tree.resolve(root_id) else {
        eng.dirty = false;
        eng.built = false;
        eng.root = None;
        return;
    };
    let Some(root_nid) = build(tree, styles, fonts, &mut eng.taffy, root_slot, false) else {
        eng.dirty = false;
        eng.built = false;
        eng.root = None;
        return;
    };
    eng.root = Some(root_nid);
    eng.built = true;
    eng.dirty = false;
    compute(tree, fonts, eng, root_id, root_nid);
}

/// Smoke helper proving the pinned taffy feature set
/// (alloc + taffy_tree + flexbox + content_size, no default features)
/// actually resolves and compiles for every target.
pub fn taffy_smoke() -> taffy::TaffyTree<()> {
    taffy::TaffyTree::new()
}
