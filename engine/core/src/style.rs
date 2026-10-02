//! Style table parse + resolve.
//!
//! Parses styles.bin (spec.ts "STYLE TABLE binary format", constants in
//! spec::style_table) with unaligned little-endian reads over `&[u8]`, and
//! resolves a node's effective style: defaults → base variant → focus variant
//! (node focused) → active variant (node active) → dynamic `set_prop`
//! overrides → live animation values.
//!
//! Transition spawning on `set_style`/`set_focus` diffs live in lib.rs (they
//! coordinate the tree, this table and the anim track list).

use alloc::vec::Vec;

use crate::spec;
use crate::tree::Node;

/// Sentinel for "no gradient configured" (GradDir ordinals are 0..=3).
pub const NO_GRADIENT: u32 = 0xffff_ffff;

// ---- unaligned LE readers ---------------------------------------------------

#[inline]
fn rd_u16(b: &[u8], off: usize) -> Option<u16> {
    Some(u16::from_le_bytes([*b.get(off)?, *b.get(off + 1)?]))
}

#[inline]
fn rd_u32(b: &[u8], off: usize) -> Option<u32> {
    Some(u32::from_le_bytes([
        *b.get(off)?,
        *b.get(off + 1)?,
        *b.get(off + 2)?,
        *b.get(off + 3)?,
    ]))
}

// ---- table ------------------------------------------------------------------

/// A style record's transition block.
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Transition {
    /// Anim-bit mask over spec.ts ANIMATABLE order (spec::ANIM_BIT).
    pub mask: u32,
    pub dur_ms: u16,
    pub delay_ms: u16,
    /// spec::Easing ordinal.
    pub easing: u8,
}

/// A style record's animation block: baked timeline refs (ANIM TABLE indices,
/// CSS comma-list order) plus the whole-choreography loop period.
#[derive(Clone, Default)]
pub struct StyleAnimation {
    /// 0 = play once (fills decide the end state).
    pub loop_frames: u16,
    pub anims: Vec<u16>,
}

/// One parsed style record. Variant prop lists are (prop id, raw u32).
#[derive(Clone, Default)]
pub struct StyleRecord {
    pub transition: Option<Transition>,
    pub animation: Option<StyleAnimation>,
    pub base: Vec<(u8, u32)>,
    pub focus: Vec<(u8, u32)>,
    pub active: Vec<(u8, u32)>,
}

/// One baked animation segment: `prop` goes from→to over frames [t0, t1).
#[derive(Clone, Copy, Debug)]
pub struct Segment {
    pub t0: u16,
    pub t1: u16,
    pub from: u32,
    pub to: u32,
    /// spec::Easing ordinal (CubicBezier ⇒ `bezier` params are meaningful).
    pub easing: u8,
    /// cubic-bezier(x1, y1, x2, y2) control values.
    pub bezier: [f32; 4],
}

/// Per-prop segment list of a timeline (sorted by t0, non-overlapping).
#[derive(Clone, Debug)]
pub struct TimelineTrack {
    pub prop: u8,
    pub segments: Vec<Segment>,
}

/// One baked keyframe timeline (one CSS animation shorthand entry).
#[derive(Clone, Debug)]
pub struct Timeline {
    pub delay_frames: u16,
    pub period_frames: u16,
    /// 0 = infinite.
    pub iterations: u16,
    /// spec::style_table::ANIM_FILL_* bits.
    pub fill: u8,
    pub tracks: Vec<TimelineTrack>,
}

/// The whole styles.bin table; styleId = record index, animId = anim index.
#[derive(Default)]
pub struct StyleTable {
    pub records: Vec<StyleRecord>,
    pub anims: Vec<Timeline>,
}

impl StyleTable {
    pub fn new() -> StyleTable {
        StyleTable { records: Vec::new(), anims: Vec::new() }
    }

    /// Parse a styles.bin blob. `None` on bad magic/version/truncation.
    pub fn parse(bytes: &[u8]) -> Option<StyleTable> {
        use spec::style_table as st;
        if rd_u32(bytes, 0)? != st::MAGIC || rd_u16(bytes, 4)? != st::VERSION {
            return None;
        }
        let count = rd_u16(bytes, 6)? as usize;
        let anim_count = rd_u16(bytes, 8)? as usize;
        let mut records = Vec::with_capacity(count);
        let mut o = st::HEADER_SIZE;
        for _ in 0..count {
            let flags = *bytes.get(o)?;
            o += 1;
            let mut rec = StyleRecord::default();
            if flags & st::HAS_TRANSITION != 0 {
                rec.transition = Some(Transition {
                    mask: rd_u32(bytes, o)?,
                    dur_ms: rd_u16(bytes, o + 4)?,
                    delay_ms: rd_u16(bytes, o + 6)?,
                    easing: *bytes.get(o + 8)?,
                });
                o += st::TRANSITION_SIZE;
            }
            if flags & st::HAS_ANIMATION != 0 {
                let n = *bytes.get(o)? as usize;
                let loop_frames = rd_u16(bytes, o + 1)?;
                o += 3;
                let mut anims = Vec::with_capacity(n);
                for _ in 0..n {
                    let id = rd_u16(bytes, o)?;
                    if id as usize >= anim_count {
                        return None;
                    }
                    anims.push(id);
                    o += 2;
                }
                rec.animation = Some(StyleAnimation { loop_frames, anims });
            }
            for v in 0..3u8 {
                let bit = match v {
                    0 => st::VARIANT_BASE,
                    1 => st::VARIANT_FOCUS,
                    _ => st::VARIANT_ACTIVE,
                };
                if flags & bit == 0 {
                    continue;
                }
                let n = *bytes.get(o)? as usize;
                o += 1;
                let mut props = Vec::with_capacity(n);
                for _ in 0..n {
                    let prop = *bytes.get(o)?;
                    let value = rd_u32(bytes, o + 2)?;
                    props.push((prop, value));
                    o += st::PROP_RECORD_SIZE;
                }
                match v {
                    0 => rec.base = props,
                    1 => rec.focus = props,
                    _ => rec.active = props,
                }
            }
            records.push(rec);
        }
        let mut anims = Vec::with_capacity(anim_count);
        for _ in 0..anim_count {
            let delay_frames = rd_u16(bytes, o)?;
            let period_frames = rd_u16(bytes, o + 2)?.max(1);
            let iterations = rd_u16(bytes, o + 4)?;
            let fill = *bytes.get(o + 6)?;
            let track_count = *bytes.get(o + 7)? as usize;
            o += st::ANIM_ENTRY_HEADER_SIZE;
            let mut tracks = Vec::with_capacity(track_count);
            for _ in 0..track_count {
                let prop = *bytes.get(o)?;
                let seg_count = *bytes.get(o + 1)? as usize;
                o += 2;
                if seg_count == 0 || !spec::is_animatable(prop) {
                    return None;
                }
                let mut segments = Vec::with_capacity(seg_count);
                for _ in 0..seg_count {
                    let easing = *bytes.get(o + 12)?;
                    let mut seg = Segment {
                        t0: rd_u16(bytes, o)?,
                        t1: rd_u16(bytes, o + 2)?,
                        from: rd_u32(bytes, o + 4)?,
                        to: rd_u32(bytes, o + 8)?,
                        easing,
                        bezier: [0.0; 4],
                    };
                    o += st::ANIM_SEGMENT_SIZE;
                    if easing == spec::Easing::CubicBezier as u8 {
                        for i in 0..4 {
                            seg.bezier[i] = f32::from_bits(rd_u32(bytes, o + i * 4)?);
                        }
                        o += st::ANIM_BEZIER_EXTRA_SIZE;
                    }
                    segments.push(seg);
                }
                tracks.push(TimelineTrack { prop, segments });
            }
            anims.push(Timeline { delay_frames, period_frames, iterations, fill, tracks });
        }
        Some(StyleTable { records, anims })
    }

    /// Record for a style id (STYLE_ID_NONE / out-of-range → None).
    #[inline]
    pub fn record(&self, style_id: i32) -> Option<&StyleRecord> {
        if style_id < 0 {
            None
        } else {
            self.records.get(style_id as usize)
        }
    }
}

// ---- resolved style ----------------------------------------------------------

/// A node's fully-resolved effective style. Dimension-like f32 fields use NAN
/// for "auto/unset"; -1.0 encodes 100% ("-full", the only percent in v1).
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Resolved {
    pub width: f32,
    pub height: f32,
    pub min_w: f32,
    pub min_h: f32,
    pub max_w: f32,
    pub max_h: f32,
    /// t, r, b, l
    pub padding: [f32; 4],
    /// t, r, b, l
    pub margin: [f32; 4],
    pub gap: f32,
    pub flex_dir: u8,
    pub justify: u8,
    pub align: u8,
    pub grow: f32,
    pub shrink: f32,
    pub basis: f32,
    pub flex_wrap: u8,
    pub pos_type: u8,
    /// t, r, b, l (NAN = auto)
    pub inset: [f32; 4],
    pub display: u8,
    pub overflow: u8,
    pub hit_pass: u8,
    pub z_index: i32,
    pub bg_color: u32,
    pub grad_from: u32,
    pub grad_to: u32,
    pub grad_via: u32,
    /// Middle-stop position along the from-to direction; NAN disables it.
    pub grad_via_pos: f32,
    /// spec::GradDir ordinal, or NO_GRADIENT.
    pub grad_dir: u32,
    pub radius: f32,
    pub opacity: f32,
    pub border_color: u32,
    pub border_width: f32,
    pub shadow: u32,
    /// Bevel rings (see spec.ts PROP.bevelOuterLight..bevelWidth): up to two
    /// nested inset rings; light = top+left strips, dark = bottom+right.
    pub bevel_outer_light: u32,
    pub bevel_outer_dark: u32,
    pub bevel_inner_light: u32,
    pub bevel_inner_dark: u32,
    pub bevel_width: f32,
    pub text_color: u32,
    pub font_slot: u32,
    pub text_align: u8,
    /// NAN = use the atlas default.
    pub line_height: f32,
    pub tracking: f32,
    pub translate_x: f32,
    pub translate_y: f32,
    pub scale: f32,
    pub rotate: f32,
    pub scale_x: f32,
    pub scale_y: f32,
    /// Transform origin as fractions of node size from the center
    /// (-0.5 = left/top edge, 0 = center, +0.5 = right/bottom edge).
    pub origin_x: f32,
    pub origin_y: f32,
    /// 3D transform (degrees / px; meaningful under a perspective root).
    pub rotate_x: f32,
    pub rotate_y: f32,
    pub translate_z: f32,
    /// > 0 makes this node a 3D context root (see spec.ts PROP.perspective).
    pub perspective: f32,
    /// Arc primitive (annular sector; see spec.ts PROP.arcStart/Sweep/Width).
    pub arc_start: f32,
    pub arc_sweep: f32,
    pub arc_width: f32,
    /// Horizontal shear in degrees about the transform origin, composed
    /// between rotate and scale (spec.ts PROP.skewX).
    pub skew_x: f32,
    /// Explicit animated-sprite reference clock for this subtree. u32::MAX
    /// means inherit, or use the legacy host-vblank clock at the root.
    pub sprite_clock: u32,
}

impl Default for Resolved {
    fn default() -> Resolved {
        Resolved {
            width: f32::NAN,
            height: f32::NAN,
            min_w: f32::NAN,
            min_h: f32::NAN,
            max_w: f32::NAN,
            max_h: f32::NAN,
            padding: [0.0; 4],
            margin: [0.0; 4],
            gap: 0.0,
            flex_dir: spec::FlexDir::Row as u8,
            justify: spec::Justify::Start as u8,
            align: spec::Align::Stretch as u8,
            grow: 0.0,
            shrink: 1.0,
            basis: f32::NAN,
            flex_wrap: 0,
            pos_type: spec::PosType::Relative as u8,
            inset: [f32::NAN; 4],
            display: spec::Display::Flex as u8,
            overflow: spec::Overflow::Visible as u8,
            hit_pass: 0,
            z_index: 0,
            bg_color: 0,
            grad_from: 0,
            grad_to: 0,
            grad_via: 0,
            grad_via_pos: f32::NAN,
            grad_dir: NO_GRADIENT,
            radius: 0.0,
            opacity: 1.0,
            border_color: 0,
            border_width: 0.0,
            shadow: 0,
            bevel_outer_light: 0,
            bevel_outer_dark: 0,
            bevel_inner_light: 0,
            bevel_inner_dark: 0,
            bevel_width: 1.0,
            text_color: 0xffff_ffff,
            font_slot: 0,
            text_align: spec::TextAlign::Left as u8,
            line_height: f32::NAN,
            tracking: 0.0,
            translate_x: 0.0,
            translate_y: 0.0,
            scale: 1.0,
            rotate: 0.0,
            scale_x: 1.0,
            scale_y: 1.0,
            origin_x: 0.0,
            origin_y: 0.0,
            rotate_x: 0.0,
            rotate_y: 0.0,
            translate_z: 0.0,
            perspective: 0.0,
            arc_start: 0.0,
            arc_sweep: 0.0,
            arc_width: 0.0,
            skew_x: 0.0,
            sprite_clock: u32::MAX,
        }
    }
}

impl Resolved {
    /// True when this style declares any non-translation transform — THE
    /// text-provider gate, shared verbatim by layout build (recording) and
    /// the draw walk (divergence detection), so the two sides can never
    /// disagree on what a subtree's transforms call for. Pure translations
    /// don't count: TEXT_RUN places its box exactly under them.
    pub fn declares_transform(&self) -> bool {
        self.rotate != 0.0
            || self.skew_x != 0.0
            || self.scale != 1.0
            || self.scale_x != 1.0
            || self.scale_y != 1.0
            || self.rotate_x != 0.0
            || self.rotate_y != 0.0
            || self.perspective > 0.0
    }

    /// Apply one (prop id, raw u32 payload). Unknown props are ignored.
    pub fn apply(&mut self, prop: u8, bits: u32) {
        use spec::prop as p;
        let f = f32::from_bits(bits);
        match prop {
            p::WIDTH => self.width = f,
            p::HEIGHT => self.height = f,
            p::MIN_W => self.min_w = f,
            p::MIN_H => self.min_h = f,
            p::MAX_W => self.max_w = f,
            p::MAX_H => self.max_h = f,
            p::PADDING_T => self.padding[0] = f,
            p::PADDING_R => self.padding[1] = f,
            p::PADDING_B => self.padding[2] = f,
            p::PADDING_L => self.padding[3] = f,
            p::MARGIN_T => self.margin[0] = f,
            p::MARGIN_R => self.margin[1] = f,
            p::MARGIN_B => self.margin[2] = f,
            p::MARGIN_L => self.margin[3] = f,
            p::GAP => self.gap = f,
            p::FLEX_DIR => self.flex_dir = bits as u8,
            p::JUSTIFY => self.justify = bits as u8,
            p::ALIGN => self.align = bits as u8,
            p::GROW => self.grow = f,
            p::SHRINK => self.shrink = f,
            p::BASIS => self.basis = f,
            p::FLEX_WRAP => self.flex_wrap = bits as u8,
            p::POS_TYPE => self.pos_type = bits as u8,
            p::INSET_T => self.inset[0] = f,
            p::INSET_R => self.inset[1] = f,
            p::INSET_B => self.inset[2] = f,
            p::INSET_L => self.inset[3] = f,
            p::DISPLAY => self.display = bits as u8,
            p::OVERFLOW => self.overflow = bits as u8,
            p::HIT_PASS => self.hit_pass = bits as u8,
            p::Z_INDEX => self.z_index = bits as i32,
            p::BG_COLOR => self.bg_color = bits,
            p::GRAD_FROM => self.grad_from = bits,
            p::GRAD_TO => self.grad_to = bits,
            p::GRAD_VIA => self.grad_via = bits,
            p::GRAD_VIA_POS => self.grad_via_pos = f,
            p::GRAD_DIR => self.grad_dir = bits,
            p::RADIUS => self.radius = f,
            p::OPACITY => self.opacity = f,
            p::BORDER_COLOR => self.border_color = bits,
            p::BORDER_WIDTH => self.border_width = f,
            p::SHADOW => self.shadow = bits,
            p::BEVEL_OUTER_LIGHT => self.bevel_outer_light = bits,
            p::BEVEL_OUTER_DARK => self.bevel_outer_dark = bits,
            p::BEVEL_INNER_LIGHT => self.bevel_inner_light = bits,
            p::BEVEL_INNER_DARK => self.bevel_inner_dark = bits,
            p::BEVEL_WIDTH => self.bevel_width = f,
            p::TEXT_COLOR => self.text_color = bits,
            p::FONT_SLOT => self.font_slot = bits,
            p::TEXT_ALIGN => self.text_align = bits as u8,
            p::LINE_HEIGHT => self.line_height = f,
            p::TRACKING => self.tracking = f,
            p::TRANSLATE_X => self.translate_x = f,
            p::TRANSLATE_Y => self.translate_y = f,
            p::SCALE => self.scale = f,
            p::ROTATE => self.rotate = f,
            p::SCALE_X => self.scale_x = f,
            p::SCALE_Y => self.scale_y = f,
            p::ORIGIN_X => self.origin_x = f,
            p::ORIGIN_Y => self.origin_y = f,
            p::ROTATE_X => self.rotate_x = f,
            p::ROTATE_Y => self.rotate_y = f,
            p::TRANSLATE_Z => self.translate_z = f,
            p::PERSPECTIVE => self.perspective = f,
            p::ARC_START => self.arc_start = f,
            p::ARC_SWEEP => self.arc_sweep = f,
            p::ARC_WIDTH => self.arc_width = f,
            p::SKEW_X => self.skew_x = f,
            p::SPRITE_CLOCK => self.sprite_clock = bits,
            _ => {}
        }
    }

    /// Raw u32 payload of a prop's current value (inverse of `apply`; used
    /// for old/new diffing and animation "from = current"). 0 for unknown.
    pub fn get_bits(&self, prop: u8) -> u32 {
        use spec::prop as p;
        match prop {
            p::WIDTH => self.width.to_bits(),
            p::HEIGHT => self.height.to_bits(),
            p::MIN_W => self.min_w.to_bits(),
            p::MIN_H => self.min_h.to_bits(),
            p::MAX_W => self.max_w.to_bits(),
            p::MAX_H => self.max_h.to_bits(),
            p::PADDING_T => self.padding[0].to_bits(),
            p::PADDING_R => self.padding[1].to_bits(),
            p::PADDING_B => self.padding[2].to_bits(),
            p::PADDING_L => self.padding[3].to_bits(),
            p::MARGIN_T => self.margin[0].to_bits(),
            p::MARGIN_R => self.margin[1].to_bits(),
            p::MARGIN_B => self.margin[2].to_bits(),
            p::MARGIN_L => self.margin[3].to_bits(),
            p::GAP => self.gap.to_bits(),
            p::FLEX_DIR => self.flex_dir as u32,
            p::JUSTIFY => self.justify as u32,
            p::ALIGN => self.align as u32,
            p::GROW => self.grow.to_bits(),
            p::SHRINK => self.shrink.to_bits(),
            p::BASIS => self.basis.to_bits(),
            p::FLEX_WRAP => self.flex_wrap as u32,
            p::POS_TYPE => self.pos_type as u32,
            p::INSET_T => self.inset[0].to_bits(),
            p::INSET_R => self.inset[1].to_bits(),
            p::INSET_B => self.inset[2].to_bits(),
            p::INSET_L => self.inset[3].to_bits(),
            p::DISPLAY => self.display as u32,
            p::OVERFLOW => self.overflow as u32,
            p::HIT_PASS => self.hit_pass as u32,
            p::Z_INDEX => self.z_index as u32,
            p::BG_COLOR => self.bg_color,
            p::GRAD_FROM => self.grad_from,
            p::GRAD_TO => self.grad_to,
            p::GRAD_VIA => self.grad_via,
            p::GRAD_VIA_POS => self.grad_via_pos.to_bits(),
            p::GRAD_DIR => self.grad_dir,
            p::RADIUS => self.radius.to_bits(),
            p::OPACITY => self.opacity.to_bits(),
            p::BORDER_COLOR => self.border_color,
            p::BORDER_WIDTH => self.border_width.to_bits(),
            p::SHADOW => self.shadow,
            p::BEVEL_OUTER_LIGHT => self.bevel_outer_light,
            p::BEVEL_OUTER_DARK => self.bevel_outer_dark,
            p::BEVEL_INNER_LIGHT => self.bevel_inner_light,
            p::BEVEL_INNER_DARK => self.bevel_inner_dark,
            p::BEVEL_WIDTH => self.bevel_width.to_bits(),
            p::TEXT_COLOR => self.text_color,
            p::FONT_SLOT => self.font_slot,
            p::TEXT_ALIGN => self.text_align as u32,
            p::LINE_HEIGHT => self.line_height.to_bits(),
            p::TRACKING => self.tracking.to_bits(),
            p::TRANSLATE_X => self.translate_x.to_bits(),
            p::TRANSLATE_Y => self.translate_y.to_bits(),
            p::SCALE => self.scale.to_bits(),
            p::ROTATE => self.rotate.to_bits(),
            p::SCALE_X => self.scale_x.to_bits(),
            p::SCALE_Y => self.scale_y.to_bits(),
            p::ORIGIN_X => self.origin_x.to_bits(),
            p::ORIGIN_Y => self.origin_y.to_bits(),
            p::ROTATE_X => self.rotate_x.to_bits(),
            p::ROTATE_Y => self.rotate_y.to_bits(),
            p::TRANSLATE_Z => self.translate_z.to_bits(),
            p::PERSPECTIVE => self.perspective.to_bits(),
            p::ARC_START => self.arc_start.to_bits(),
            p::ARC_SWEEP => self.arc_sweep.to_bits(),
            p::ARC_WIDTH => self.arc_width.to_bits(),
            p::SKEW_X => self.skew_x.to_bits(),
            p::SPRITE_CLOCK => self.sprite_clock,
            _ => 0,
        }
    }
}

/// z-index only, WITHOUT building a full `Resolved` — the paint walk asks
/// for every child's z each frame, and a full resolve there doubled the
/// per-node style work (measured: the largest single cost in `draw` on PSP).
pub fn resolve_z(node: &Node, table: &StyleTable) -> i32 {
    last_entry(node, table, Layers::Styled, spec::prop::Z_INDEX).map_or(0, |v| v as i32)
}

/// Resolve a node's effective style. `with_anim` controls whether live
/// animation values and the physics layer participate (they do for layout,
/// painting and hit testing; they don't when computing a transition's
/// target). Animation start values use `resolve_animated`, which leaves the
/// physics layer out.
pub fn resolve(node: &Node, table: &StyleTable, with_anim: bool) -> Resolved {
    resolve_layers(node, table, if with_anim { Layers::Posed } else { Layers::Styled })
}

/// The opacity `resolve(node, table, true)` would produce, from the same
/// layers in the same order without building a `Resolved`. The draw walk uses
/// it to cull a transparent subtree before resolving the whole style.
pub fn resolve_opacity(node: &Node, table: &StyleTable) -> f32 {
    last_entry(node, table, Layers::Posed, spec::prop::OPACITY).map_or(Resolved::default().opacity, f32::from_bits)
}

/// Style, overrides and (with `with_anim`) animation tracks, without the
/// physics layer: the values animations and transitions start from, so a
/// body's pose never leaks into a view's own animation state.
pub fn resolve_animated(node: &Node, table: &StyleTable, with_anim: bool) -> Resolved {
    resolve_layers(node, table, if with_anim { Layers::Animated } else { Layers::Styled })
}

/// How far down the layer stack a resolve reads. Each layer applies over the
/// ones before it.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Layers {
    /// The style record (base, then the focus and active variants) and the
    /// dynamic overrides.
    Styled,
    /// Plus live animation tracks.
    Animated,
    /// Plus physics poses.
    Posed,
}

fn resolve_layers(node: &Node, table: &StyleTable, layers: Layers) -> Resolved {
    let mut r = Resolved::default();
    for_each_entry(node, table, layers, |p, v| r.apply(p, v));
    r
}

/// The raw payload of the last entry for `prop` within `layers`: the value
/// that wins when every entry is applied in order.
fn last_entry(node: &Node, table: &StyleTable, layers: Layers, prop: u8) -> Option<u32> {
    let mut last = None;
    for_each_entry(node, table, layers, |p, v| {
        if p == prop {
            last = Some(v);
        }
    });
    last
}

/// Every (prop, payload) entry that shapes `node`, in application order. All
/// resolvers read the layer stack through here, so they cannot disagree on
/// its order.
fn for_each_entry(node: &Node, table: &StyleTable, layers: Layers, mut apply: impl FnMut(u8, u32)) {
    if let Some(rec) = table.record(node.style_id) {
        for &(p, v) in &rec.base {
            apply(p, v);
        }
        if node.focused {
            for &(p, v) in &rec.focus {
                apply(p, v);
            }
        }
        if node.active {
            for &(p, v) in &rec.active {
                apply(p, v);
            }
        }
    }
    for &(p, v) in &node.overrides {
        apply(p, v);
    }
    if layers >= Layers::Animated {
        for &(p, v) in &node.anim_values {
            apply(p, v);
        }
    }
    if layers >= Layers::Posed {
        for &(p, v) in &node.physics_values {
            apply(p, v);
        }
    }
}
