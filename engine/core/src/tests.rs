//! Core behavior tests (run with `cargo test` — the dev-dependency
//! self-reference turns the `std` feature on for the harness).

use alloc::vec::Vec;

use crate::{spec, style, Ui};

// ---- binary blob builders (bytes hand-assembled per spec.ts formats) --------

struct StyleSpec {
    base: Vec<(u8, u32)>,
    focus: Vec<(u8, u32)>,
    active: Vec<(u8, u32)>,
    /// (mask, dur_ms, delay_ms, easing)
    transition: Option<(u32, u16, u16, u8)>,
    /// (loop_frames, anim ids)
    animation: Option<(u16, Vec<u16>)>,
}

impl StyleSpec {
    fn new() -> StyleSpec {
        StyleSpec {
            base: Vec::new(),
            focus: Vec::new(),
            active: Vec::new(),
            transition: None,
            animation: None,
        }
    }
}

/// One baked-timeline segment: (t0, t1, from, to, easing, bezier).
struct SegSpec(u16, u16, u32, u32, u8, Option<[f32; 4]>);

/// One ANIM TABLE entry: header + (prop, segments) tracks.
struct AnimSpec {
    delay_frames: u16,
    period_frames: u16,
    iterations: u16,
    fill: u8,
    tracks: Vec<(u8, Vec<SegSpec>)>,
}

fn encode_styles(styles: &[StyleSpec]) -> Vec<u8> {
    encode_styles_with_anims(styles, &[])
}

fn encode_styles_with_anims(styles: &[StyleSpec], anims: &[AnimSpec]) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(&spec::style_table::MAGIC.to_le_bytes());
    out.extend_from_slice(&spec::style_table::VERSION.to_le_bytes());
    out.extend_from_slice(&(styles.len() as u16).to_le_bytes());
    out.extend_from_slice(&(anims.len() as u16).to_le_bytes());
    out.extend_from_slice(&[0, 0]); // reserved
    for s in styles {
        let mut flags = 0u8;
        if !s.base.is_empty() {
            flags |= spec::style_table::VARIANT_BASE;
        }
        if !s.focus.is_empty() {
            flags |= spec::style_table::VARIANT_FOCUS;
        }
        if !s.active.is_empty() {
            flags |= spec::style_table::VARIANT_ACTIVE;
        }
        if s.transition.is_some() {
            flags |= spec::style_table::HAS_TRANSITION;
        }
        if s.animation.is_some() {
            flags |= spec::style_table::HAS_ANIMATION;
        }
        out.push(flags);
        if let Some((mask, dur, delay, easing)) = s.transition {
            out.extend_from_slice(&mask.to_le_bytes());
            out.extend_from_slice(&dur.to_le_bytes());
            out.extend_from_slice(&delay.to_le_bytes());
            out.push(easing);
            out.extend_from_slice(&[0, 0, 0]);
        }
        if let Some((loop_frames, ids)) = &s.animation {
            out.push(ids.len() as u8);
            out.extend_from_slice(&loop_frames.to_le_bytes());
            for id in ids {
                out.extend_from_slice(&id.to_le_bytes());
            }
        }
        for v in [&s.base, &s.focus, &s.active] {
            if v.is_empty() {
                continue;
            }
            out.push(v.len() as u8);
            for &(prop, value) in v {
                out.push(prop);
                out.push(0);
                out.extend_from_slice(&value.to_le_bytes());
            }
        }
    }
    for a in anims {
        out.extend_from_slice(&a.delay_frames.to_le_bytes());
        out.extend_from_slice(&a.period_frames.to_le_bytes());
        out.extend_from_slice(&a.iterations.to_le_bytes());
        out.push(a.fill);
        out.push(a.tracks.len() as u8);
        for (prop, segs) in &a.tracks {
            out.push(*prop);
            out.push(segs.len() as u8);
            for SegSpec(t0, t1, from, to, easing, bezier) in segs {
                out.extend_from_slice(&t0.to_le_bytes());
                out.extend_from_slice(&t1.to_le_bytes());
                out.extend_from_slice(&from.to_le_bytes());
                out.extend_from_slice(&to.to_le_bytes());
                out.push(*easing);
                out.push(0);
                if let Some(bz) = bezier {
                    for v in bz {
                        out.extend_from_slice(&v.to_bits().to_le_bytes());
                    }
                }
            }
        }
    }
    out
}

/// Synthetic font atlas: `glyphs` are (codepoint, gid, advance), sorted by
/// codepoint. Coverage cells are all-zero (metrics are what the tests exercise).
fn encode_atlas(
    slot: u8,
    cell_w: u8,
    cell_h: u8,
    baseline: u8,
    line_height: u8,
    glyph_count: u16,
    glyphs: &[(u32, u16, u8)],
) -> Vec<u8> {
    encode_atlas_version_density(
        spec::font_atlas::VERSION,
        1,
        slot,
        cell_w,
        cell_h,
        baseline,
        line_height,
        glyph_count,
        glyphs,
    )
}

#[allow(clippy::too_many_arguments)]
fn encode_atlas_version_density(
    version: u16,
    raster_density: u8,
    slot: u8,
    cell_w: u8,
    cell_h: u8,
    baseline: u8,
    line_height: u8,
    glyph_count: u16,
    glyphs: &[(u32, u16, u8)],
) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(&spec::font_atlas::MAGIC.to_le_bytes());
    out.extend_from_slice(&version.to_le_bytes());
    out.extend_from_slice(&(glyphs.len() as u16).to_le_bytes());
    out.push(cell_w);
    out.push(cell_h);
    out.push(baseline);
    out.push(line_height);
    out.push(slot);
    out.push(0); // flags
    out.push(raster_density);
    out.push(0); // reserved
    assert_eq!(glyphs.len(), glyph_count as usize, "test blob: glyphCount == cmap entries");
    for &(cp, gid, adv) in glyphs {
        out.extend_from_slice(&cp.to_le_bytes());
        out.extend_from_slice(&gid.to_le_bytes());
        out.push(adv);
        out.push(0);
    }
    let bytes_per_row = cell_w as usize * raster_density.max(1) as usize;
    let coverage_h = cell_h as usize * raster_density.max(1) as usize;
    out.extend_from_slice(&alloc::vec![0u8; glyph_count as usize * coverage_h * bytes_per_row]);
    out
}

fn abgr(r: u8, g: u8, b: u8, a: u8) -> u32 {
    ((a as u32) << 24) | ((b as u32) << 16) | ((g as u32) << 8) | r as u32
}

// ---- DrawList decoding helpers ------------------------------------------------

fn decode_xy(word: u32) -> (i32, i32) {
    ((word & 0xffff) as u16 as i16 as i32, (word >> 16) as u16 as i16 as i32)
}

fn decode_wh(word: u32) -> (i32, i32) {
    ((word & 0xffff) as i32, (word >> 16) as i32)
}

/// Walk a DrawList asserting the pinned CPU-clip invariant: every coordinate
/// in [0, SCREEN_W] x [0, SCREEN_H], rect extents in range, scissors
/// balanced, only known ops. Returns per-op counts (indexed by op code).
fn validate_drawlist(words: &[u32]) -> [u32; 11] {
    let (sw, sh) = (spec::SCREEN_W as i32, spec::SCREEN_H as i32);
    let xy_ok = |w: u32| {
        let (x, y) = decode_xy(w);
        assert!((0..=sw).contains(&x) && (0..=sh).contains(&y), "coord out of range: ({x},{y})");
    };
    let rect_ok = |xyw: u32, whw: u32| {
        xy_ok(xyw);
        let (x, y) = decode_xy(xyw);
        let (w, h) = decode_wh(whw);
        assert!(x + w <= sw && y + h <= sh, "rect exceeds screen: {x},{y} {w}x{h}");
    };
    let mut counts = [0u32; 11];
    let mut depth = 0i32;
    let mut i = 0usize;
    while i < words.len() {
        let op = words[i];
        assert!((op as usize) < counts.len(), "unknown draw op {op} at word {i}");
        counts[op as usize] += 1;
        match op {
            spec::draw_op::RECT => {
                rect_ok(words[i + 1], words[i + 2]);
                i += 4;
            }
            spec::draw_op::GRAD_RECT => {
                rect_ok(words[i + 1], words[i + 2]);
                assert!(words[i + 5] <= 3, "bad GradDir");
                i += 6;
            }
            spec::draw_op::GLYPH_RUN => {
                let n = (words[i + 1] >> 16) as usize;
                assert!(n > 0, "empty glyph run emitted");
                for g in 0..n {
                    xy_ok(words[i + 3 + g * 2]);
                }
                i += 3 + 2 * n;
            }
            spec::draw_op::TEX_QUAD => {
                rect_ok(words[i + 2], words[i + 3]);
                for uv in 4..8 {
                    let f = f32::from_bits(words[i + uv]);
                    assert!((0.0..=1.0).contains(&f), "UV out of range: {f}");
                }
                i += 9;
            }
            spec::draw_op::SURFACE_QUAD => {
                for word in i + 2..i + 6 {
                    assert!(f32::from_bits(words[word]).is_finite());
                }
                rect_ok(words[i + 6], words[i + 7]);
                assert_eq!(words[i + 8] & !1, 0, "unknown surface flags");
                i += 9;
            }
            spec::draw_op::SCISSOR => {
                rect_ok(words[i + 1], words[i + 2]);
                depth += 1;
                i += 3;
            }
            spec::draw_op::SCISSOR_POP => {
                depth -= 1;
                assert!(depth >= 0, "unbalanced SCISSOR_POP");
                i += 1;
            }
            spec::draw_op::TRI => {
                xy_ok(words[i + 1]);
                xy_ok(words[i + 2]);
                xy_ok(words[i + 3]);
                i += 7;
            }
            spec::draw_op::TEX_TRI => {
                for vertex in 0..3 {
                    xy_ok(words[i + 2 + vertex * 3]);
                    for uv in [i + 3 + vertex * 3, i + 4 + vertex * 3] {
                        let f = f32::from_bits(words[uv]);
                        assert!((0.0..=1.0).contains(&f), "UV out of range: {f}");
                    }
                }
                i += 12;
            }
            spec::draw_op::TEXT_RUN => {
                // Native-text op: origin is f32 (exempt from the i16 clip
                // guarantee), box width is finite and non-negative, and the
                // packed payload decodes as valid UTF-8.
                for f in [f32::from_bits(words[i + 2]), f32::from_bits(words[i + 3])] {
                    assert!(f.is_finite(), "TEXT_RUN origin not finite: {f}");
                }
                let box_w = f32::from_bits(words[i + 4]);
                assert!(box_w.is_finite() && box_w >= 0.0, "bad TEXT_RUN boxW: {box_w}");
                let (text, next) = decode_text_run_text(words, i);
                assert!(!text.is_empty(), "TEXT_RUN with empty payload");
                i = next;
            }
            other => panic!("unknown draw op {other} at word {i}"),
        }
    }
    assert_eq!(depth, 0, "unbalanced SCISSOR/SCISSOR_POP");
    counts
}

/// Consecutive TEX_TRI batches exactly as hosts/psp/src/ge.rs sees them.
/// Any different op or texture handle terminates the current run.
fn tex_tri_runs(words: &[u32]) -> Vec<(u32, usize)> {
    let mut runs: Vec<(u32, usize)> = Vec::new();
    let mut previous_was_tex_tri = false;
    let mut i = 0usize;
    while i < words.len() {
        match words[i] {
            spec::draw_op::TEX_TRI => {
                let tex = words[i + 1];
                if previous_was_tex_tri && runs.last().map_or(false, |run| run.0 == tex) {
                    runs.last_mut().unwrap().1 += 1;
                } else {
                    runs.push((tex, 1));
                }
                previous_was_tex_tri = true;
                i += 12;
            }
            spec::draw_op::RECT => { previous_was_tex_tri = false; i += 4; }
            spec::draw_op::GRAD_RECT => { previous_was_tex_tri = false; i += 6; }
            spec::draw_op::GLYPH_RUN => {
                previous_was_tex_tri = false;
                i += 3 + 2 * ((words[i + 1] >> 16) as usize);
            }
            spec::draw_op::TEX_QUAD => { previous_was_tex_tri = false; i += 9; }
            spec::draw_op::SURFACE_QUAD => { previous_was_tex_tri = false; i += 9; }
            spec::draw_op::SCISSOR => { previous_was_tex_tri = false; i += 3; }
            spec::draw_op::SCISSOR_POP => { previous_was_tex_tri = false; i += 1; }
            spec::draw_op::TRI => { previous_was_tex_tri = false; i += 7; }
            spec::draw_op::TEXT_RUN => {
                previous_was_tex_tri = false;
                i += 8 + (words[i + 7] as usize).div_ceil(4);
            }
            other => panic!("unknown draw op {other} at word {i}"),
        }
    }
    runs
}

// ---- tests ---------------------------------------------------------------------

#[test]
fn arena_id_reuse_and_stale_id_noop() {
    let mut ui = Ui::new();
    let a = ui.create_node(spec::NodeType::View as u8);
    assert!(a > 0);
    ui.insert_before(spec::ROOT_ID, a, 0);
    ui.destroy_node(a);
    // Slot is reused with a bumped generation -> different id, same slot.
    let b = ui.create_node(spec::NodeType::View as u8);
    assert_ne!(a, b);
    assert_eq!(a & spec::ID_SLOT_MASK as i32, b & spec::ID_SLOT_MASK as i32);
    // Ops on the stale id are silent no-ops and don't touch the new node.
    ui.set_prop(a, spec::prop::WIDTH, 123.0);
    ui.set_text(a, "stale");
    ui.destroy_node(a);
    assert!(ui.layout_of(a).is_none());
    assert!(ui.layout_of(b).is_some());
    assert_eq!(ui.animate(a, spec::prop::OPACITY, 0.0, 100, 0, 0), -1);
}

#[test]
fn insert_before_dom_move_semantics() {
    let mut ui = Ui::new();
    let mk = |ui: &mut Ui, h: f64| {
        let n = ui.create_node(0);
        ui.set_prop(n, spec::prop::HEIGHT, h);
        ui.insert_before(spec::ROOT_ID, n, 0);
        n
    };
    let a = mk(&mut ui, 10.0);
    let b = mk(&mut ui, 20.0);
    let c = mk(&mut ui, 30.0);
    ui.tick();
    // Column: a@0, b@10, c@30.
    assert_eq!(ui.layout_of(c).unwrap().1, 30.0);
    // Move c before a WITHOUT removing first (DOM move semantics).
    ui.insert_before(spec::ROOT_ID, c, a);
    ui.tick();
    // New order c, a, b: c@0, a@30, b@40.
    assert_eq!(ui.layout_of(c).unwrap().1, 0.0);
    assert_eq!(ui.layout_of(a).unwrap().1, 30.0);
    assert_eq!(ui.layout_of(b).unwrap().1, 40.0);
    // Move across parents: b into a wrapper -> gone from root flow.
    let wrap = ui.create_node(0);
    ui.insert_before(spec::ROOT_ID, wrap, 0);
    ui.insert_before(wrap, b, 0);
    ui.tick();
    assert_eq!(ui.layout_of(b).unwrap().1, 0.0); // now relative to wrap
    // Cycle guard: inserting an ancestor under its descendant is a no-op.
    ui.insert_before(b, wrap, 0);
    ui.tick();
    assert_eq!(ui.layout_of(wrap).unwrap().1, 40.0); // still under root, after c+a
}

#[test]
fn clipped_compositor_surface_keeps_full_geometry_and_shell_z_order() {
    let mut ui = Ui::new();
    let absolute_box = |ui: &mut Ui, node: i32, x: f64, y: f64, w: f64, h: f64, z: f64| {
        ui.set_prop(node, spec::prop::POS_TYPE, spec::PosType::Absolute as u32 as f64);
        ui.set_prop(node, spec::prop::INSET_L, x);
        ui.set_prop(node, spec::prop::INSET_T, y);
        ui.set_prop(node, spec::prop::WIDTH, w);
        ui.set_prop(node, spec::prop::HEIGHT, h);
        ui.set_prop(node, spec::prop::Z_INDEX, z);
    };

    let under = ui.create_node(spec::NodeType::View as u8);
    absolute_box(&mut ui, under, 0.0, 0.0, 200.0, 160.0, 0.0);
    ui.set_prop(under, spec::prop::BG_COLOR, abgr(1, 2, 3, 255) as f64);
    ui.insert_before(spec::ROOT_ID, under, 0);

    let clipper = ui.create_node(spec::NodeType::View as u8);
    absolute_box(&mut ui, clipper, 20.0, 30.0, 80.0, 60.0, 1.0);
    ui.set_prop(
        clipper,
        spec::prop::OVERFLOW,
        spec::Overflow::Hidden as u32 as f64,
    );
    ui.insert_before(spec::ROOT_ID, clipper, 0);

    let surface = ui.create_node(spec::NodeType::Surface as u8);
    absolute_box(&mut ui, surface, 0.0, 0.0, 100.0, 100.0, 0.0);
    ui.set_compositor_surface(surface, 7, true);
    ui.insert_before(clipper, surface, 0);

    let over = ui.create_node(spec::NodeType::View as u8);
    absolute_box(&mut ui, over, 0.0, 0.0, 12.0, 12.0, 2.0);
    ui.set_prop(over, spec::prop::BG_COLOR, abgr(4, 5, 6, 255) as f64);
    ui.insert_before(spec::ROOT_ID, over, 0);

    let words = ui.draw().words.clone();
    validate_drawlist(&words);
    let surface_at = words
        .iter()
        .position(|word| *word == spec::draw_op::SURFACE_QUAD)
        .unwrap();
    let under_at = words
        .windows(4)
        .position(|op| op[0] == spec::draw_op::RECT && op[3] == abgr(1, 2, 3, 255))
        .unwrap();
    let over_at = words
        .windows(4)
        .position(|op| op[0] == spec::draw_op::RECT && op[3] == abgr(4, 5, 6, 255))
        .unwrap();
    assert!(under_at < surface_at && surface_at < over_at);

    let frames = ui.compositor_surface_frames();
    assert_eq!(frames.len(), 1);
    assert_eq!(frames[0].handle, 7);
    assert_eq!(frames[0].full, [20.0, 30.0, 100.0, 100.0]);
    assert_eq!(frames[0].clip, [20.0, 30.0, 80.0, 60.0]);
    assert!(frames[0].focused);
    assert_eq!(ui.compositor_surface_bindings(), vec![(7, true)]);
}

#[test]
fn style_resolution_with_focus_variant() {
    let mut ui = Ui::new();
    let red = abgr(255, 0, 0, 255);
    let green = abgr(0, 255, 0, 255);
    let mut s = StyleSpec::new();
    s.base = alloc::vec![(spec::prop::BG_COLOR, red), (spec::prop::WIDTH, 100f32.to_bits())];
    s.focus = alloc::vec![(spec::prop::BG_COLOR, green)];
    assert!(ui.load_styles(&encode_styles(&[s])));
    let n = ui.create_node(0);
    ui.insert_before(spec::ROOT_ID, n, 0);
    ui.set_style(n, 0);
    assert_eq!(ui.resolved_style(n).unwrap().bg_color, red);
    assert_eq!(ui.resolved_style(n).unwrap().width, 100.0);
    ui.set_focus(n);
    assert_eq!(ui.focused(), n);
    assert_eq!(ui.resolved_style(n).unwrap().bg_color, green);
    ui.set_focus(0);
    assert_eq!(ui.resolved_style(n).unwrap().bg_color, red);
    // Dynamic override sits on top of every variant.
    let blue = abgr(0, 0, 255, 255);
    ui.set_prop(n, spec::prop::BG_COLOR, blue as f64);
    ui.set_focus(n);
    assert_eq!(ui.resolved_style(n).unwrap().bg_color, blue);
    // Destroying the focused node clears focus.
    ui.destroy_node(n);
    assert_eq!(ui.focused(), 0);
}

#[test]
fn set_style_diff_spawns_transition() {
    let mut ui = Ui::new();
    let red = abgr(255, 0, 0, 255);
    let blue = abgr(0, 0, 255, 255);
    let bg_bit = 16; // spec.ts ANIMATABLE order: bgColor = bit 16
    assert_eq!(spec::ANIM_BIT[spec::prop::BG_COLOR as usize], bg_bit as u8);
    let mut s0 = StyleSpec::new();
    s0.base = alloc::vec![(spec::prop::BG_COLOR, red)];
    let mut s1 = StyleSpec::new();
    s1.base = alloc::vec![(spec::prop::BG_COLOR, blue)];
    s1.transition = Some((1 << bg_bit, 300, 0, spec::Easing::Linear as u8)); // 18 frames
    assert!(ui.load_styles(&encode_styles(&[s0, s1])));
    let n = ui.create_node(0);
    ui.insert_before(spec::ROOT_ID, n, 0);
    ui.set_style(n, 0);
    assert_eq!(ui.resolved_style(n).unwrap().bg_color, red);
    ui.set_style(n, 1);
    // Transition holds the OLD value at spawn (from = current appearance).
    assert_eq!(ui.resolved_style(n).unwrap().bg_color, red);
    for _ in 0..9 {
        ui.tick(); // halfway through 18 frames
    }
    let mid = ui.resolved_style(n).unwrap().bg_color;
    assert_ne!(mid, red);
    assert_ne!(mid, blue);
    let midpoint = crate::anim::interp(red, blue, 0.5, true);
    assert_eq!(mid, midpoint);
    for _ in 0..20 {
        ui.tick();
    }
    assert_eq!(ui.resolved_style(n).unwrap().bg_color, blue);
    // Props NOT in the mask never tween: swap back to s0 — bgColor tweens,
    // but a style without a transition block snaps.
    ui.set_style(n, 0);
    ui.tick();
    assert_eq!(ui.resolved_style(n).unwrap().bg_color, red);
}

#[test]
fn first_style_assignment_skips_transition_from_defaults() {
    let mut ui = Ui::new();
    let blue = abgr(0, 0, 255, 255);
    let green = abgr(0, 255, 0, 255);
    let bg_bit = spec::ANIM_BIT[spec::prop::BG_COLOR as usize] as u32;

    let mut s0 = StyleSpec::new();
    s0.base = alloc::vec![(spec::prop::BG_COLOR, blue)];
    s0.transition = Some((1 << bg_bit, 300, 0, spec::Easing::Linear as u8));
    let mut s1 = StyleSpec::new();
    s1.base = alloc::vec![(spec::prop::BG_COLOR, green)];
    s1.transition = Some((1 << bg_bit, 300, 0, spec::Easing::Linear as u8));
    assert!(ui.load_styles(&encode_styles(&[s0, s1])));

    let n = ui.create_node(0);
    ui.insert_before(spec::ROOT_ID, n, 0);
    ui.set_style(n, 0);
    assert_eq!(ui.resolved_style(n).unwrap().bg_color, blue);

    ui.set_style(n, 1);
    assert_eq!(
        ui.resolved_style(n).unwrap().bg_color,
        blue,
        "subsequent style changes still transition from the old appearance",
    );
}

#[test]
fn fixed_dt_animation_is_deterministic() {
    fn run() -> Vec<Vec<u32>> {
        let mut ui = Ui::new();
        let n = ui.create_node(0);
        ui.set_prop(n, spec::prop::WIDTH, 60.0);
        ui.set_prop(n, spec::prop::HEIGHT, 40.0);
        ui.set_prop(n, spec::prop::BG_COLOR, abgr(200, 100, 50, 255) as f64);
        ui.insert_before(spec::ROOT_ID, n, 0);
        ui.animate(n, spec::prop::TRANSLATE_X, 300.0, 500, spec::Easing::OutBack as u8, 32);
        ui.animate(n, spec::prop::ROTATE, 65.0, 400, spec::Easing::Spring as u8, 0);
        ui.animate(n, spec::prop::BG_COLOR, abgr(10, 220, 30, 255) as f64, 250, spec::Easing::EaseInOut as u8, 0);
        let mut frames = Vec::new();
        for _ in 0..70 {
            ui.tick();
            frames.push(ui.draw().words.clone());
        }
        frames
    }
    let a = run();
    let b = run();
    assert_eq!(a, b, "two identical runs must produce byte-equal DrawLists");
    for f in &a {
        validate_drawlist(f);
    }
    // The rotated frames must actually exercise the TRI path.
    let tri_frames = a
        .iter()
        .filter(|f| validate_drawlist(f)[spec::draw_op::TRI as usize] > 0)
        .count();
    assert!(tri_frames > 0, "rotation should emit TRI ops");
}

#[test]
fn gap_column_layout_matches_hand_computed() {
    let mut ui = Ui::new();
    ui.set_prop(spec::ROOT_ID, spec::prop::GAP, 10.0);
    ui.set_prop(spec::ROOT_ID, spec::prop::PADDING_T, 5.0);
    ui.set_prop(spec::ROOT_ID, spec::prop::PADDING_L, 7.0);
    let mut kids = Vec::new();
    for h in [40.0, 50.0, 60.0] {
        let n = ui.create_node(0);
        ui.set_prop(n, spec::prop::WIDTH, 100.0);
        ui.set_prop(n, spec::prop::HEIGHT, h);
        ui.insert_before(spec::ROOT_ID, n, 0);
        kids.push(n);
    }
    ui.tick();
    assert_eq!(ui.layout_of(spec::ROOT_ID).unwrap(), (0.0, 0.0, 480.0, 272.0));
    // Column: y = paddingT + sum(prev heights + gaps), x = paddingL.
    assert_eq!(ui.layout_of(kids[0]).unwrap(), (7.0, 5.0, 100.0, 40.0));
    assert_eq!(ui.layout_of(kids[1]).unwrap(), (7.0, 55.0, 100.0, 50.0));
    assert_eq!(ui.layout_of(kids[2]).unwrap(), (7.0, 115.0, 100.0, 60.0));
}

#[test]
fn absolute_child_does_not_consume_flex_space() {
    let mut ui = Ui::new();
    ui.set_prop(spec::ROOT_ID, spec::prop::FLEX_DIR, spec::FlexDir::Row as u32 as f64);

    let app = ui.create_node(0);
    ui.set_prop(app, spec::prop::WIDTH, 480.0);
    ui.set_prop(app, spec::prop::HEIGHT, 272.0);
    ui.insert_before(spec::ROOT_ID, app, 0);

    let overlay = ui.create_node(0);
    ui.set_prop(overlay, spec::prop::POS_TYPE, spec::PosType::Absolute as u32 as f64);
    ui.set_prop(overlay, spec::prop::INSET_T, 0.0);
    ui.set_prop(overlay, spec::prop::INSET_R, 0.0);
    ui.set_prop(overlay, spec::prop::INSET_B, 0.0);
    ui.set_prop(overlay, spec::prop::INSET_L, 0.0);
    ui.insert_before(spec::ROOT_ID, overlay, 0);

    ui.tick();
    assert_eq!(ui.layout_of(app).unwrap(), (0.0, 0.0, 480.0, 272.0));
    assert_eq!(ui.layout_of(overlay).unwrap(), (0.0, 0.0, 480.0, 272.0));
}

#[test]
fn empty_text_nodes_are_excluded_from_layout() {
    let mut ui = Ui::new();
    assert!(ui.load_font_atlas(&encode_atlas(
        0,
        8,
        8,
        7,
        10,
        3,
        &[(0xfffd, 0, 8), ('A' as u32, 1, 6), ('B' as u32, 2, 5)],
    )));
    ui.set_prop(spec::ROOT_ID, spec::prop::GAP, 10.0);
    // align-items start so the text node keeps its measured width instead of
    // stretching to the column's cross size.
    ui.set_prop(spec::ROOT_ID, spec::prop::ALIGN, spec::Align::Start as u32 as f64);
    let a = ui.create_node(0);
    ui.set_prop(a, spec::prop::HEIGHT, 20.0);
    ui.insert_before(spec::ROOT_ID, a, 0);
    let t = ui.create_node(spec::NodeType::Text as u8); // Solid <Show> marker
    ui.insert_before(spec::ROOT_ID, t, 0);
    let b = ui.create_node(0);
    ui.set_prop(b, spec::prop::HEIGHT, 20.0);
    ui.insert_before(spec::ROOT_ID, b, 0);
    ui.tick();
    // The empty text node consumes NO space and NO gap [R]: b sits at 30.
    assert_eq!(ui.layout_of(b).unwrap().1, 30.0);
    assert_eq!(ui.layout_of(t).unwrap(), (0.0, 0.0, 0.0, 0.0));
    // replace_text makes it participate: one line of "AB" = 11x10.
    ui.replace_text(t, "AB");
    ui.tick();
    let (_, ty, tw, th) = ui.layout_of(t).unwrap();
    assert_eq!((ty, tw, th), (30.0, 11.0, 10.0));
    assert_eq!(ui.layout_of(b).unwrap().1, 50.0);
    // And back to empty -> excluded again.
    ui.replace_text(t, "");
    ui.tick();
    assert_eq!(ui.layout_of(b).unwrap().1, 30.0);
}

#[test]
fn drawlist_clip_invariant_offscreen_rects() {
    let mut ui = Ui::new();
    // Partially off every edge + fully off + rotated partially off.
    let cases: [(f64, f64, f64); 5] = [
        (450.0, 250.0, 0.0),   // off bottom-right
        (-30.0, -20.0, 0.0),   // off top-left
        (600.0, 10.0, 0.0),    // fully off right
        (400.0, -30.0, 45.0),  // rotated, off top-right
        (-40.0, 240.0, 30.0),  // rotated, off bottom-left
    ];
    for (tx, ty, rot) in cases {
        let n = ui.create_node(0);
        ui.set_prop(n, spec::prop::WIDTH, 100.0);
        ui.set_prop(n, spec::prop::HEIGHT, 60.0);
        ui.set_prop(n, spec::prop::POS_TYPE, spec::PosType::Absolute as u32 as f64);
        ui.set_prop(n, spec::prop::INSET_T, 0.0);
        ui.set_prop(n, spec::prop::INSET_L, 0.0);
        ui.set_prop(n, spec::prop::BG_COLOR, abgr(255, 255, 255, 255) as f64);
        ui.set_prop(n, spec::prop::BORDER_COLOR, abgr(0, 0, 0, 255) as f64);
        ui.set_prop(n, spec::prop::BORDER_WIDTH, 3.0);
        ui.set_prop(n, spec::prop::TRANSLATE_X, tx);
        ui.set_prop(n, spec::prop::TRANSLATE_Y, ty);
        ui.set_prop(n, spec::prop::ROTATE, rot);
        ui.insert_before(spec::ROOT_ID, n, 0);
    }
    // A gradient clipped at the screen edge must re-interpolate, not clamp.
    let g = ui.create_node(0);
    ui.set_prop(g, spec::prop::WIDTH, 200.0);
    ui.set_prop(g, spec::prop::HEIGHT, 40.0);
    ui.set_prop(g, spec::prop::POS_TYPE, spec::PosType::Absolute as u32 as f64);
    ui.set_prop(g, spec::prop::INSET_T, 0.0);
    ui.set_prop(g, spec::prop::INSET_L, 0.0);
    ui.set_prop(g, spec::prop::GRAD_FROM, abgr(0, 0, 0, 255) as f64);
    ui.set_prop(g, spec::prop::GRAD_TO, abgr(200, 200, 200, 255) as f64);
    ui.set_prop(g, spec::prop::GRAD_DIR, spec::GradDir::ToRight as u32 as f64);
    ui.set_prop(g, spec::prop::TRANSLATE_X, 380.0); // visible span = half
    ui.insert_before(spec::ROOT_ID, g, 0);
    ui.tick();
    let words = ui.draw().words.clone();
    let counts = validate_drawlist(&words);
    assert!(counts[spec::draw_op::RECT as usize] > 0);
    assert!(counts[spec::draw_op::TRI as usize] > 0, "rotated offscreen boxes clip into TRIs");
    assert!(counts[spec::draw_op::GRAD_RECT as usize] > 0);
    // Find the gradient and check the endpoint re-interpolation: the rect
    // spans x 380..580, the clip keeps 380..480 = fractions 0.0..0.5, so the
    // from-color is untouched and the to-color becomes lerp(from, to, 0.5).
    let mut i = 0usize;
    let mut found = false;
    while i < words.len() {
        match words[i] {
            spec::draw_op::RECT => i += 4,
            spec::draw_op::GRAD_RECT => {
                let (x, _) = decode_xy(words[i + 1]);
                let (w, _) = decode_wh(words[i + 2]);
                assert_eq!((x, w), (380, 100));
                assert_eq!(words[i + 3], abgr(0, 0, 0, 255)); // from untouched (clip starts at 0.0)
                let expected = crate::anim::interp(abgr(0, 0, 0, 255), abgr(200, 200, 200, 255), 0.5, true);
                assert_eq!(words[i + 4], expected, "gradient to-color re-interpolated over the clip");
                found = true;
                i += 6;
            }
            spec::draw_op::TRI => i += 7,
            spec::draw_op::GLYPH_RUN => i += 3 + 2 * ((words[i + 1] >> 16) as usize),
            spec::draw_op::TEX_QUAD => i += 9,
            spec::draw_op::SCISSOR => i += 3,
            _ => i += 1,
        }
    }
    assert!(found, "gradient rect must survive the clip");
}

#[test]
fn three_stop_gradient_splits_into_clipped_drawlist_segments() {
    let mut ui = Ui::new();
    let n = ui.create_node(0);
    ui.set_prop(n, spec::prop::WIDTH, 100.0);
    ui.set_prop(n, spec::prop::HEIGHT, 20.0);
    ui.set_prop(n, spec::prop::POS_TYPE, spec::PosType::Absolute as u32 as f64);
    ui.set_prop(n, spec::prop::INSET_T, 10.0);
    ui.set_prop(n, spec::prop::INSET_L, -25.0);
    ui.set_prop(n, spec::prop::GRAD_FROM, abgr(0, 0, 0, 255) as f64);
    ui.set_prop(n, spec::prop::GRAD_VIA, abgr(100, 100, 100, 255) as f64);
    ui.set_prop(n, spec::prop::GRAD_VIA_POS, 0.5);
    ui.set_prop(n, spec::prop::GRAD_TO, abgr(200, 200, 200, 255) as f64);
    ui.set_prop(n, spec::prop::GRAD_DIR, spec::GradDir::ToRight as u32 as f64);
    ui.insert_before(spec::ROOT_ID, n, 0);
    ui.tick();

    let words = ui.draw().words.clone();
    validate_drawlist(&words);
    let mut segments = Vec::new();
    let mut i = 0usize;
    while i < words.len() {
        match words[i] {
            spec::draw_op::RECT => i += 4,
            spec::draw_op::GRAD_RECT => {
                let (x, _) = decode_xy(words[i + 1]);
                let (w, _) = decode_wh(words[i + 2]);
                segments.push((x, w, words[i + 3], words[i + 4], words[i + 5]));
                i += 6;
            }
            spec::draw_op::TRI => i += 7,
            spec::draw_op::GLYPH_RUN => i += 3 + 2 * ((words[i + 1] >> 16) as usize),
            spec::draw_op::TEX_QUAD => i += 9,
            spec::draw_op::SCISSOR => i += 3,
            _ => i += 1,
        }
    }
    assert_eq!(segments, vec![
        (0, 25, abgr(50, 50, 50, 255), abgr(100, 100, 100, 255), spec::GradDir::ToRight as u32),
        (25, 50, abgr(100, 100, 100, 255), abgr(200, 200, 200, 255), spec::GradDir::ToRight as u32),
    ]);
}

#[test]
fn rounded_boxes_emit_subpixel_edge_coverage() {
    let mut ui = Ui::new();
    let n = ui.create_node(0);
    ui.set_prop(n, spec::prop::WIDTH, 36.0);
    ui.set_prop(n, spec::prop::HEIGHT, 20.0);
    ui.set_prop(n, spec::prop::POS_TYPE, spec::PosType::Absolute as u32 as f64);
    ui.set_prop(n, spec::prop::INSET_T, 10.5);
    ui.set_prop(n, spec::prop::INSET_L, 10.5);
    ui.set_prop(n, spec::prop::RADIUS, 10.0);
    ui.set_prop(n, spec::prop::BG_COLOR, abgr(37, 99, 235, 255) as f64);
    ui.insert_before(spec::ROOT_ID, n, 0);
    ui.tick();
    let words = ui.draw().words.clone();
    let counts = validate_drawlist(&words);
    assert!(counts[spec::draw_op::RECT as usize] > 0);
    // Flat rounded boxes now render their corners as four baked-disc
    // TEX_QUAD sprites (O(1) per box; the AA lives in the disc texture) +
    // solid RECT bands. Assert the corner sprites and that the baked disc
    // actually carries partial coverage alpha.
    let mut corner_quads = 0usize;
    let mut disc_tex = None;
    let mut i = 0usize;
    while i < words.len() {
        match words[i] {
            spec::draw_op::RECT => i += 4,
            spec::draw_op::GRAD_RECT => i += 6,
            spec::draw_op::TRI => i += 7,
            spec::draw_op::GLYPH_RUN => i += 3 + 2 * ((words[i + 1] >> 16) as usize),
            spec::draw_op::TEX_QUAD => {
                corner_quads += 1;
                disc_tex = Some(words[i + 1] as i32);
                i += 9;
            }
            spec::draw_op::SCISSOR => i += 3,
            _ => i += 1,
        }
    }
    assert_eq!(corner_quads, 4, "four corner sprites per rounded box");
    let view = ui.texture(disc_tex.unwrap()).expect("baked disc texture");
    assert_eq!(view.psm, spec::psm::PSM_8888);
    let mut partial = false;
    for px in view.pixels.chunks_exact(4).take((view.w * view.w) as usize) {
        if px[3] > 0 && px[3] < 255 {
            partial = true;
            break;
        }
    }
    assert!(partial, "the baked disc must carry antialiased coverage alpha");
}

#[test]
fn scaled_flat_rounded_box_has_no_gaps_between_fast_path_pieces() {
    let mut ui = Ui::new_with_raster_density(2);
    let n = ui.create_node(0);
    ui.set_prop(n, spec::prop::WIDTH, 70.0);
    ui.set_prop(n, spec::prop::HEIGHT, 70.0);
    ui.set_prop(n, spec::prop::POS_TYPE, spec::PosType::Absolute as u32 as f64);
    ui.set_prop(n, spec::prop::INSET_T, 20.0);
    ui.set_prop(n, spec::prop::INSET_L, 12.0);
    ui.set_prop(n, spec::prop::RADIUS, 12.0);
    ui.set_prop(n, spec::prop::BG_COLOR, abgr(6, 182, 212, 255) as f64);
    ui.set_prop(n, spec::prop::SCALE_X, 0.96);
    ui.set_prop(n, spec::prop::SCALE_Y, 0.96);
    ui.insert_before(spec::ROOT_ID, n, 0);
    ui.tick();

    let words = ui.draw().words.clone();
    let mut framebuffer = alloc::vec![0u8; spec::SCREEN_W as usize * spec::SCREEN_H as usize * 4];
    crate::raster::render(&ui, &words, &mut framebuffer);

    for &(x, y) in &[(68usize, 25usize), (40usize, 76usize)] {
        let offset = (y * spec::SCREEN_W as usize + x) * 4;
        assert_ne!(
            &framebuffer[offset..offset + 3],
            &[0, 0, 0],
            "rounded-box fast-path pieces left a black gap at ({x},{y})",
        );
    }
}

#[test]
fn rounded_corner_masks_follow_raster_density_without_changing_layout() {
    let mut ui = Ui::new_with_raster_density(2);
    assert_eq!(ui.raster_density(), 2);
    let n = ui.create_node(0);
    ui.set_prop(n, spec::prop::WIDTH, 36.0);
    ui.set_prop(n, spec::prop::HEIGHT, 20.0);
    ui.set_prop(n, spec::prop::POS_TYPE, spec::PosType::Absolute as u32 as f64);
    ui.set_prop(n, spec::prop::INSET_T, 10.0);
    ui.set_prop(n, spec::prop::INSET_L, 10.0);
    ui.set_prop(n, spec::prop::RADIUS, 10.0);
    ui.set_prop(n, spec::prop::BG_COLOR, abgr(37, 99, 235, 255) as f64);
    ui.insert_before(spec::ROOT_ID, n, 0);
    ui.tick();

    let words = ui.draw().words.clone();
    let i = words.iter().position(|&word| word == spec::draw_op::TEX_QUAD).unwrap();
    let view = ui.texture(words[i + 1] as i32).expect("density-scaled disc texture");
    assert_eq!((view.w, view.h), (64, 64), "20px disc at 2x is padded to 64px");
    assert_eq!(decode_wh(words[i + 3]), (10, 10), "DrawList geometry stays logical");
    assert_eq!(f32::from_bits(words[i + 6]), 20.0 / 64.0, "UV selects one 2x quadrant");
}

#[test]
#[should_panic(expected = "raster density must be an integer from 1 through 255")]
fn ui_rejects_zero_raster_density() {
    let _ = Ui::new_with_raster_density(0);
}

#[test]
fn tick_rate_is_fixed_once_the_realm_has_ticked() {
    let mut ui = Ui::new();
    assert_eq!(ui.tick_rate(), 60, "spec default");
    assert!(!ui.set_tick_rate(0), "0 Hz is not a rate");
    assert_eq!(ui.tick_rate(), 60);
    assert!(!ui.set_tick_rate(crate::MAX_TICK_HZ + 1), "above the ceiling");
    assert_eq!(ui.tick_rate(), 60);
    assert!(ui.set_tick_rate(crate::MAX_TICK_HZ), "the ceiling itself is a rate");
    assert!(ui.set_tick_rate(120));
    assert_eq!(ui.tick_rate(), 120);
    ui.tick();
    assert!(!ui.set_tick_rate(60));
    assert_eq!(ui.tick_rate(), 120, "a running realm keeps its step size");
}

#[test]
fn tick_rate_is_fixed_even_when_every_tick_was_paused() {
    let mut ui = Ui::new();
    ui.debug_pause(true);
    ui.tick();
    assert!(
        !ui.set_tick_rate(120),
        "a swallowed tick still starts the run — the frame counter alone would readmit a rate change here"
    );
    assert_eq!(ui.tick_rate(), 60);
}

#[test]
fn a_120_hz_realm_runs_a_tween_over_twice_the_frames() {
    let mut at = |hz: u32| {
        let mut ui = Ui::new();
        ui.set_tick_rate(hz);
        let n = ui.create_node(0);
        ui.insert_before(spec::ROOT_ID, n, 0);
        ui.animate(n, spec::prop::OPACITY, 0.0, 200, 0, 0);
        let mut frames = 0;
        while ui.resolved_style(n).unwrap().opacity > 0.0 && frames < 1000 {
            ui.tick();
            frames += 1;
        }
        frames
    };
    assert_eq!(at(60), 12, "200 ms at 60 Hz");
    assert_eq!(at(120), 24, "the same 200 ms of virtual time");
}

#[test]
fn transparent_rounded_border_draws_an_outline_not_square_strips() {
    let mut ui = Ui::new();
    let blue = abgr(37, 99, 235, 255);
    let n = ui.create_node(0);
    ui.set_prop(n, spec::prop::WIDTH, 20.0);
    ui.set_prop(n, spec::prop::HEIGHT, 12.0);
    ui.set_prop(n, spec::prop::POS_TYPE, spec::PosType::Absolute as u32 as f64);
    ui.set_prop(n, spec::prop::INSET_T, 10.0);
    ui.set_prop(n, spec::prop::INSET_L, 10.0);
    ui.set_prop(n, spec::prop::RADIUS, 6.0);
    ui.set_prop(n, spec::prop::BORDER_COLOR, blue as f64);
    ui.set_prop(n, spec::prop::BORDER_WIDTH, 1.0);
    ui.insert_before(spec::ROOT_ID, n, 0);
    ui.tick();

    let words = ui.draw().words.clone();
    assert_eq!(validate_drawlist(&words)[spec::draw_op::TEX_QUAD as usize], 1);
    let mut pixels = alloc::vec![0; spec::SCREEN_W as usize * spec::SCREEN_H as usize * 4];
    crate::raster::render(&ui, &words, &mut pixels);
    let blue_at = |x: usize, y: usize| pixels[(y * spec::SCREEN_W as usize + x) * 4 + 2] > 0;
    assert!(blue_at(20, 10), "top edge should be present");
    assert!(blue_at(10, 16), "left edge should be present");
    assert!(!blue_at(10, 10), "rounded transparent border must not draw square outer corners");
    assert!(!blue_at(20, 16), "transparent border must not fill the center");
    let handle = words[1] as i32;
    ui.set_prop(n, spec::prop::SCALE, 0.8);
    assert_eq!(ui.draw().words[1] as i32, handle, "scaling reuses the local mask");
    ui.free_texture(handle);
    assert_ne!(ui.draw().words[1] as i32, handle, "a freed texture must not be sampled");

}

#[test]
fn clipped_rounded_shapes_do_not_allocate_masks_until_revealed() {
    for border in [false, true] {
        let mut ui = Ui::new();
        let parent = ui.create_node(0);
        for (p, v) in [(spec::prop::WIDTH, 10.0), (spec::prop::HEIGHT, 24.0),
            (spec::prop::OVERFLOW, spec::Overflow::Hidden as u8 as f64)] { ui.set_prop(parent, p, v); }
        let shape = ui.create_node(0);
        for (p, v) in [(spec::prop::WIDTH, 24.0), (spec::prop::HEIGHT, 24.0),
            (spec::prop::TRANSLATE_X, 12.0), (spec::prop::RADIUS, 8.0)] { ui.set_prop(shape, p, v); }
        if border {
            ui.set_prop(shape, spec::prop::BORDER_WIDTH, 1.0);
            ui.set_prop(shape, spec::prop::BORDER_COLOR, 0xffffffffu32 as f64);
        } else { ui.set_prop(shape, spec::prop::BG_COLOR, 0xffffffffu32 as f64); }
        ui.insert_before(parent, shape, 0); ui.insert_before(spec::ROOT_ID, parent, 0); ui.tick();
        ui.draw();
        assert_eq!(ui.texture_slot_count(), 0, "covered shapes must not allocate masks");
        ui.set_prop(parent, spec::prop::WIDTH, 40.0);
        let words = ui.draw().words.clone();
        assert!(ui.texture_slot_count() > 0, "reveal must still render the shape");
        assert!(validate_drawlist(&words)[spec::draw_op::TEX_QUAD as usize] > 0);
    }
}

#[test]
fn border_masks_are_bounded_and_match_analytic_coverage_at_rest() {
    for border in [0.75, 1.0, 2.0] {
        let mut masked = Ui::new();
        let mut analytic = Ui::new();
        fn shape(ui: &mut Ui, width: f64, border: f64) -> i32 {
            let n = ui.create_node(0);
            for (prop, value) in [(spec::prop::WIDTH, width), (spec::prop::HEIGHT, 24.0),
                (spec::prop::RADIUS, 8.0), (spec::prop::BORDER_WIDTH, border),
                (spec::prop::BORDER_COLOR, 0xffd08742u32 as f64)] { ui.set_prop(n, prop, value); }
            ui.insert_before(spec::ROOT_ID, n, 0);
            ui.tick();
            n
        }
        // Fill the bounded cache with other dimensions. The target must then
        // use the independent analytic fallback, without freeing earlier masks.
        for width in 25..41 {
            let n = shape(&mut analytic, width as f64, border);
            analytic.draw();
            analytic.destroy_node(n);
        }
        assert_eq!(analytic.texture_slot_count(), 16);
        shape(&mut masked, 24.0, border);
        shape(&mut analytic, 24.0, border);
        let a = masked.draw().words.clone();
        let b = analytic.draw().words.clone();
        assert_eq!(validate_drawlist(&a)[spec::draw_op::TEX_QUAD as usize], 1);
        assert_eq!(validate_drawlist(&b)[spec::draw_op::TEX_QUAD as usize], 0);
        assert_eq!(analytic.texture_slot_count(), 16, "cache overflow cannot grow residency");
        let mut ap = alloc::vec![0; spec::SCREEN_W as usize * spec::SCREEN_H as usize * 4];
        let mut bp = ap.clone();
        crate::raster::render(&masked, &a, &mut ap);
        crate::raster::render(&analytic, &b, &mut bp);
        assert_eq!(ap, bp, "baked and analytic borders agree at rest");
    }
}

#[test]
fn rounded_gradients_emit_rect_coverage_spans() {
    let mut ui = Ui::new();
    let from = abgr(251, 191, 36, 255);
    let via = abgr(255, 255, 255, 255);
    let n = ui.create_node(0);
    ui.set_prop(n, spec::prop::WIDTH, 120.0);
    ui.set_prop(n, spec::prop::HEIGHT, 12.0);
    ui.set_prop(n, spec::prop::POS_TYPE, spec::PosType::Absolute as u32 as f64);
    ui.set_prop(n, spec::prop::INSET_T, 20.5);
    ui.set_prop(n, spec::prop::INSET_L, 20.0);
    ui.set_prop(n, spec::prop::RADIUS, 6.0);
    ui.set_prop(n, spec::prop::GRAD_FROM, from as f64);
    ui.set_prop(n, spec::prop::GRAD_VIA, via as f64);
    ui.set_prop(n, spec::prop::GRAD_VIA_POS, 0.5);
    ui.set_prop(n, spec::prop::GRAD_TO, abgr(217, 119, 6, 255) as f64);
    ui.set_prop(n, spec::prop::GRAD_DIR, spec::GradDir::ToBottom as u32 as f64);
    ui.insert_before(spec::ROOT_ID, n, 0);
    ui.tick();
    let words = ui.draw().words.clone();
    let counts = validate_drawlist(&words);
    assert!(counts[spec::draw_op::RECT as usize] > 0);
    assert_eq!(
        counts[spec::draw_op::GRAD_RECT as usize], 0,
        "rounded gradients must not rely on 1px-high GRAD_RECT triangle strips"
    );
    let (_, layout_y, _, layout_h) = ui.layout_of(n).unwrap();
    let target_y = 26;
    let gradient_fraction = (target_y as f32 + 0.5 - layout_y) / layout_h;
    let expected = crate::anim::interp(from, via, gradient_fraction / 0.5, true);
    let mut via_segment = false;
    let mut i = 0usize;
    while i < words.len() {
        match words[i] {
            spec::draw_op::RECT => {
                let (x, y) = decode_xy(words[i + 1]);
                let (w, h) = decode_wh(words[i + 2]);
                via_segment |= x <= 80 && 80 < x + w && y <= target_y && target_y < y + h
                    && words[i + 3] == expected;
                i += 4;
            }
            spec::draw_op::TRI => i += 7,
            spec::draw_op::GLYPH_RUN => i += 3 + 2 * ((words[i + 1] >> 16) as usize),
            spec::draw_op::TEX_QUAD => i += 9,
            spec::draw_op::SCISSOR => i += 3,
            _ => i += 1,
        }
    }
    assert!(via_segment, "the rounded span path must preserve the middle stop");
}

#[test]
fn tall_rounded_gradients_bound_center_geometry_and_preserve_stops() {
    for direction in [spec::GradDir::ToBottom, spec::GradDir::ToTop] {
        let mut counts = Vec::new();
        for height in [100.0, 240.0] {
            let mut ui = Ui::new();
            ui.set_viewport(360.0, 640.0);
            let n = ui.create_node(0);
            for (prop, value) in [(spec::prop::WIDTH, 100.0), (spec::prop::HEIGHT, height),
                (spec::prop::RADIUS, 8.0), (spec::prop::GRAD_FROM, 0xff000000u32 as f64),
                (spec::prop::GRAD_VIA, 0xff808080u32 as f64), (spec::prop::GRAD_VIA_POS, 0.5),
                (spec::prop::GRAD_TO, 0xffffffffu32 as f64), (spec::prop::GRAD_DIR, direction as u32 as f64)] {
                ui.set_prop(n, prop, value);
            }
            ui.insert_before(spec::ROOT_ID, n, 0);
            ui.tick();
            let words = ui.draw().words.clone();
            let ops = validate_drawlist(&words);
            assert_eq!(ops[spec::draw_op::GRAD_RECT as usize], 2, "split the center at the middle stop");
            assert!(ops[spec::draw_op::RECT as usize] <= 48, "only curved rows need coverage spans");
            counts.push(words.len());
        }
        assert_eq!(counts[0], counts[1], "height must not multiply geometry in the straight region");
    }
}

#[test]
fn dense_rounded_gradients_share_smooth_masks_and_preserve_global_stops() {
    for density in [2, 3] {
        for dir in [spec::GradDir::ToBottom, spec::GradDir::ToTop, spec::GradDir::ToRight, spec::GradDir::ToLeft] {
            let mut ui = Ui::new_with_raster_density(density);
            let n = ui.create_node(0);
            let from = abgr(20, 40, 60, 255);
            let via = abgr(240, 230, 220, 255);
            let to = abgr(80, 100, 120, 255);
            for (prop, value) in [(spec::prop::WIDTH, 36.0), (spec::prop::HEIGHT, 20.0),
                (spec::prop::POS_TYPE, spec::PosType::Absolute as u32 as f64),
                (spec::prop::INSET_L, 10.0), (spec::prop::INSET_T, 10.0), (spec::prop::RADIUS, 6.0),
                (spec::prop::GRAD_FROM, from as f64), (spec::prop::GRAD_VIA, via as f64),
                (spec::prop::GRAD_VIA_POS, 0.5), (spec::prop::GRAD_TO, to as f64),
                (spec::prop::GRAD_DIR, dir as u32 as f64)] { ui.set_prop(n, prop, value); }
            ui.insert_before(spec::ROOT_ID, n, 0);
            ui.tick();
            let words = ui.draw().words.clone();
            let counts = validate_drawlist(&words);
            assert_eq!(counts[spec::draw_op::TEX_QUAD as usize], 24, "six strips per corner");
            assert!(counts[spec::draw_op::GRAD_RECT as usize] <= 6, "center geometry must be bounded per box");
            let horizontal = matches!(dir, spec::GradDir::ToRight | spec::GradDir::ToLeft);
            let reverse = matches!(dir, spec::GradDir::ToTop | spec::GradDir::ToLeft);
            let mut texture = None;
            let mut center_started = false;
            let mut i = 0;
            while i < words.len() {
                let (xy, wh, color) = match words[i] {
                    spec::draw_op::GRAD_RECT => {
                        center_started = true;
                        let (x, y) = decode_xy(words[i+1]);
                        let (w, h) = decode_wh(words[i+2]);
                        let (a, b, length) = if horizontal { (x, x+w, 36.0) } else { (y, y+h, 20.0) };
                        for (point, color) in [(a, if reverse { words[i+4] } else { words[i+3] }),
                            (b, if reverse { words[i+3] } else { words[i+4] })] {
                            let t = (point as f32 - 10.0) / length;
                            let t = if reverse { 1.0 - t } else { t };
                            let expected = if t < 0.5 { crate::anim::interp(from, via, t * 2.0, true) }
                                else { crate::anim::interp(via, to, (t - 0.5) * 2.0, true) };
                            assert_eq!(color, expected, "clipped center retains full-box gradient stops");
                        }
                        i += 6; continue;
                    }
                    spec::draw_op::TEX_QUAD => {
                        assert!(!center_started, "mask/solid switches must be bounded per box, not per row");
                        let handle = words[i+1] as i32;
                        assert_eq!(*texture.get_or_insert(handle), handle, "all colors share a mask");
                        let view = ui.texture(handle).unwrap();
                        assert!(view.linear);
                        let dim = (12 * density).next_power_of_two();
                        assert_eq!((view.w, view.h), (dim, dim));
                        assert!(view.pixels.chunks_exact(4).any(|p| p[3] > 0 && p[3] < 255));
                        let data = (words[i+2], words[i+3], words[i+8]); i += 9; data
                    }
                    spec::draw_op::SCISSOR => { i += 3; continue; }
                    _ => { i += 1; continue; }
                };
                let (x, y) = decode_xy(xy);
                let (w, h) = decode_wh(wh);
                let t = if horizontal { assert_eq!(w, 1); (x as f32 + 0.5 - 10.0) / 36.0 }
                    else { assert_eq!(h, 1); (y as f32 + 0.5 - 10.0) / 20.0 };
                let t = if reverse { 1.0 - t } else { t };
                let expected = if t < 0.5 { crate::anim::interp(from, via, t * 2.0, true) }
                    else { crate::anim::interp(via, to, (t - 0.5) * 2.0, true) };
                assert_eq!(color, expected, "corners and center use the same gradient coordinates");
            }
            ui.set_prop(n, spec::prop::GRAD_FROM, to as f64);
            ui.tick();
            let next = ui.draw().words.clone();
            let i = next.iter().position(|&w| w == spec::draw_op::TEX_QUAD).unwrap();
            assert_eq!(Some(next[i+1] as i32), texture, "animated color must not mint textures");
        }
    }
}

#[test]
fn overflow_hidden_emits_balanced_intersected_scissors() {
    let mut ui = Ui::new();
    let outer = ui.create_node(0);
    ui.set_prop(outer, spec::prop::WIDTH, 100.0);
    ui.set_prop(outer, spec::prop::HEIGHT, 80.0);
    ui.set_prop(outer, spec::prop::OVERFLOW, spec::Overflow::Hidden as u32 as f64);
    ui.insert_before(spec::ROOT_ID, outer, 0);
    let inner = ui.create_node(0);
    ui.set_prop(inner, spec::prop::WIDTH, 300.0); // overflows outer
    ui.set_prop(inner, spec::prop::HEIGHT, 300.0);
    ui.set_prop(inner, spec::prop::OVERFLOW, spec::Overflow::Hidden as u32 as f64);
    ui.set_prop(inner, spec::prop::SHRINK, 0.0);
    ui.insert_before(outer, inner, 0);
    let leaf = ui.create_node(0);
    ui.set_prop(leaf, spec::prop::WIDTH, 500.0);
    ui.set_prop(leaf, spec::prop::HEIGHT, 500.0);
    ui.set_prop(leaf, spec::prop::SHRINK, 0.0);
    ui.set_prop(leaf, spec::prop::BG_COLOR, abgr(9, 9, 9, 255) as f64);
    ui.insert_before(inner, leaf, 0);
    ui.tick();
    let words = ui.draw().words.clone();
    let counts = validate_drawlist(&words);
    assert_eq!(counts[spec::draw_op::SCISSOR as usize], 2);
    assert_eq!(counts[spec::draw_op::SCISSOR_POP as usize], 2);
    // Every scissor rect is pre-intersected with the enclosing ones: the
    // inner scissor must equal the outer 100x80 (300x300 ∩ 100x80).
    let mut rects = Vec::new();
    let mut i = 0usize;
    while i < words.len() {
        match words[i] {
            spec::draw_op::SCISSOR => {
                rects.push((decode_xy(words[i + 1]), decode_wh(words[i + 2])));
                i += 3;
            }
            spec::draw_op::RECT => i += 4,
            spec::draw_op::GRAD_RECT => i += 6,
            spec::draw_op::TRI => i += 7,
            spec::draw_op::GLYPH_RUN => i += 3 + 2 * ((words[i + 1] >> 16) as usize),
            spec::draw_op::TEX_QUAD => i += 9,
            _ => i += 1,
        }
    }
    assert_eq!(rects, alloc::vec![((0, 0), (100, 80)), ((0, 0), (100, 80))]);
    // The leaf rect is clipped inside them.
    // (validate_drawlist already guarantees range; check tighter bound:)
    let mut i = 0usize;
    let mut depth = 0;
    while i < words.len() {
        match words[i] {
            spec::draw_op::SCISSOR => {
                depth += 1;
                i += 3;
            }
            spec::draw_op::SCISSOR_POP => {
                depth -= 1;
                i += 1;
            }
            spec::draw_op::RECT => {
                if depth == 2 {
                    let (x, y) = decode_xy(words[i + 1]);
                    let (w, h) = decode_wh(words[i + 2]);
                    assert!(x + w <= 100 && y + h <= 80, "leaf rect not clipped to scissor");
                }
                i += 4;
            }
            spec::draw_op::GRAD_RECT => i += 6,
            spec::draw_op::TRI => i += 7,
            spec::draw_op::GLYPH_RUN => i += 3 + 2 * ((words[i + 1] >> 16) as usize),
            spec::draw_op::TEX_QUAD => i += 9,
            _ => i += 1,
        }
    }
}

#[test]
fn wrap_text_greedy_breaks_and_native_override() {
    let mut ui = Ui::new();
    // A=6, B=5, space=4 (synthetic atlas, slot 2).
    let blob = encode_atlas(
        2,
        8,
        8,
        7,
        10,
        4,
        &[
            (' ' as u32, 3, 4),
            ('A' as u32, 1, 6),
            ('B' as u32, 2, 5),
            (0xfffd, 0, 8),
        ],
    );
    assert!(ui.load_font_atlas(&blob));
    // Fits (or empty): no breaks.
    assert!(ui.wrap_text("AA AA", 2, 100.0).is_empty());
    assert!(ui.wrap_text("", 2, 30.0).is_empty());
    // Greedy: "AA AA " = 28px + hanging space, third word overflows 30px →
    // break BEFORE it (col 6); the trailing space stays on the upper row.
    assert_eq!(ui.wrap_text("AA AA AA", 2, 30.0), alloc::vec![6]);
    // A word wider than a whole row splits at character level.
    assert_eq!(ui.wrap_text("AAAAA", 2, 13.0), alloc::vec![2, 4]);
    // A native wrapper overrides the greedy path; clearing restores it.
    ui.set_text_wrap(Some(alloc::boxed::Box::new(|_t: &str, _s: u8, _w: f32| {
        alloc::vec![7, 9]
    })));
    assert_eq!(ui.wrap_text("AA AA AA", 2, 30.0), alloc::vec![7, 9]);
    ui.set_text_wrap(None);
    assert_eq!(ui.wrap_text("AA AA AA", 2, 30.0), alloc::vec![6]);
}

#[test]
fn text_measurement_against_synthetic_atlas() {
    let mut ui = Ui::new();
    let blob = encode_atlas(
        2,
        8,
        8,
        7,
        10,
        3,
        &[(0xfffd, 0, 8), ('A' as u32, 1, 6), ('B' as u32, 2, 5)],
    );
    assert!(ui.load_font_atlas(&blob));
    // Bad blobs are rejected.
    assert!(!ui.load_font_atlas(&blob[..10]));
    assert!(!ui.load_font_atlas(&[0u8; 64]));
    assert_eq!(ui.measure_text("AB", 2), 11.0);
    assert_eq!(ui.measure_text("ABA", 2), 17.0);
    assert_eq!(ui.measure_text("AB\nA", 2), 11.0); // max line
    assert_eq!(ui.measure_text("", 2), 0.0);
    assert_eq!(ui.measure_text("A", 0), 0.0); // unregistered slot
    // cmap miss -> tofu (gid 0) + miss counter, advance = cell width.
    assert_eq!(ui.glyph_misses(), 0);
    assert_eq!(ui.measure_text("Z", 2), 8.0);
    assert_eq!(ui.glyph_misses(), 1);
    // Atlas accessor exposes glyph bitmaps for the backends.
    let atlas = ui.font_atlas(2).unwrap();
    assert_eq!(atlas.lookup('B' as u32), Some((2, 5)));
    assert_eq!(atlas.glyph_rows(1).len(), 64); // cellH * cellW coverage bytes
}

#[test]
fn font_atlas_v3_scales_coverage_without_scaling_layout_metrics() {
    let glyphs = &[(0xfffd, 0, 8), ('A' as u32, 1, 6), ('B' as u32, 2, 5)];
    let mut ui = Ui::new();
    let mut hd = encode_atlas_version_density(
        spec::font_atlas::VERSION,
        2,
        2,
        8,
        8,
        7,
        10,
        3,
        glyphs,
    );
    // gid 1, logical pixel (0,0): four density-2 samples reduce to their
    // rounded mean, not the top-left sample.
    let bitmap_off = spec::font_atlas::HEADER_SIZE
        + glyphs.len() * spec::font_atlas::CMAP_ENTRY_SIZE;
    let coverage_w = 16usize;
    let coverage_h = 16usize;
    let gid_1 = bitmap_off + coverage_w * coverage_h;
    hd[gid_1] = 0;
    hd[gid_1 + 1] = 64;
    hd[gid_1 + coverage_w] = 128;
    hd[gid_1 + coverage_w + 1] = 255;
    assert!(ui.load_font_atlas(&hd));
    let atlas = ui.font_atlas(2).unwrap();
    assert_eq!(atlas.raster_density, 2);
    assert_eq!((atlas.cell_w, atlas.cell_h), (8, 8));
    assert_eq!((atlas.coverage_width(), atlas.coverage_height()), (16, 16));
    assert_eq!(atlas.bytes_per_row(), 16);
    assert_eq!(atlas.glyph_rows(1).len(), 16 * 16);
    assert_eq!(atlas.logical_coverage(1, 0, 0), 112);
    assert_eq!(atlas.logical_coverage(1, 8, 0), 0, "out-of-range is transparent");
    // Advances, line height, and therefore app layout stay in logical px.
    assert_eq!(ui.measure_text("AB", 2), 11.0);

    // v2 used header bytes 14..15 as zeroed reserved bytes. New cores load it
    // as density 1 so already-built packs remain compatible.
    let mut legacy = encode_atlas_version_density(2, 0, 3, 8, 8, 7, 10, 3, glyphs);
    let legacy_gid_1 = bitmap_off + 8 * 8;
    legacy[legacy_gid_1] = 173;
    assert!(ui.load_font_atlas(&legacy));
    let legacy_atlas = ui.font_atlas(3).unwrap();
    assert_eq!(legacy_atlas.raster_density, 1);
    assert_eq!((legacy_atlas.coverage_width(), legacy_atlas.coverage_height()), (8, 8));
    assert_eq!(legacy_atlas.glyph_rows(1).len(), 8 * 8);
    assert_eq!(legacy_atlas.logical_coverage(1, 0, 0), 173);
    assert_eq!(ui.measure_text("AB", 3), 11.0);

    // Density zero has no meaning in v3, and truncation is checked against
    // density-scaled coverage rather than only logical cell dimensions.
    let invalid_density = encode_atlas_version_density(
        spec::font_atlas::VERSION,
        0,
        4,
        8,
        8,
        7,
        10,
        3,
        glyphs,
    );
    assert!(!ui.load_font_atlas(&invalid_density));
    assert!(!ui.load_font_atlas(&hd[..hd.len() - 1]));
}

#[test]
fn glyph_runs_render_with_alignment_and_color() {
    let mut ui = Ui::new();
    ui.load_font_atlas(&encode_atlas(
        0,
        8,
        8,
        7,
        10,
        3,
        &[(0xfffd, 0, 8), ('A' as u32, 1, 6), ('B' as u32, 2, 5)],
    ));
    let color = abgr(10, 20, 30, 255);
    let t = ui.create_node(spec::NodeType::Text as u8);
    ui.set_prop(t, spec::prop::WIDTH, 51.0);
    ui.set_prop(t, spec::prop::TEXT_COLOR, color as f64);
    ui.set_prop(t, spec::prop::TEXT_ALIGN, spec::TextAlign::Right as u32 as f64);
    // Mixed run: element text + text-node child concatenate.
    ui.set_text(t, "A");
    let child = ui.create_node(spec::NodeType::Text as u8);
    ui.set_text(child, "B");
    ui.insert_before(t, child, 0);
    ui.insert_before(spec::ROOT_ID, t, 0);
    ui.tick();
    let words = ui.draw().words.clone();
    validate_drawlist(&words);
    // One run, 2 glyphs, right-aligned in 51px: line w = 11 -> x0 = 40.
    let i = words.iter().position(|&w| w == spec::draw_op::GLYPH_RUN).unwrap();
    assert_eq!(words[i + 1], 2 << 16); // slot 0, n = 2
    assert_eq!(words[i + 2], color);
    assert_eq!(decode_xy(words[i + 3]), (40, 1)); // y: (10 - 8) / 2 = 1
    assert_eq!(words[i + 4], 1); // gid 'A'
    assert_eq!(decode_xy(words[i + 5]), (46, 1));
    assert_eq!(words[i + 6], 2); // gid 'B'
}

#[test]
fn explicit_animate_lifecycle() {
    let mut ui = Ui::new();
    let n = ui.create_node(0);
    ui.set_prop(n, spec::prop::WIDTH, 100.0);
    ui.insert_before(spec::ROOT_ID, n, 0);
    // 10 frames linear 100 -> 200 (layout-dirtying: width relayouts).
    let aid = ui.animate(n, spec::prop::WIDTH, 200.0, 167, spec::Easing::Linear as u8, 0);
    assert!(aid > 0);
    for _ in 0..5 {
        ui.tick();
    }
    let mid = ui.resolved_style(n).unwrap().width;
    assert!(mid > 100.0 && mid < 200.0);
    assert_eq!(ui.layout_of(n).unwrap().2, crate::layout::roundf(mid)); // relayouted this frame
    // Cancel freezes the current value (as a dynamic override).
    ui.cancel_anim(aid);
    let frozen = ui.resolved_style(n).unwrap().width;
    assert_eq!(frozen, mid);
    for _ in 0..10 {
        ui.tick();
    }
    assert_eq!(ui.resolved_style(n).unwrap().width, frozen);
    // Stale anim id: no-op.
    ui.cancel_anim(aid);
    // Run one to completion: final value persists as an override.
    let aid2 = ui.animate(n, spec::prop::WIDTH, 300.0, 100, spec::Easing::EaseOut as u8, 0);
    assert!(aid2 > 0);
    for _ in 0..20 {
        ui.tick();
    }
    assert_eq!(ui.resolved_style(n).unwrap().width, 300.0);
    assert_eq!(ui.layout_of(n).unwrap().2, 300.0);
    // Non-animatable prop is rejected.
    assert_eq!(ui.animate(n, spec::prop::FLEX_DIR, 1.0, 100, 0, 0), -1);
}

#[test]
fn explicit_animate_retargets_same_prop_from_current_value() {
    let mut ui = Ui::new();
    let n = ui.create_node(0);
    ui.set_prop(n, spec::prop::WIDTH, 0.0);
    ui.insert_before(spec::ROOT_ID, n, 0);

    let first = ui.animate(n, spec::prop::WIDTH, 100.0, 600, spec::Easing::Linear as u8, 0);
    assert!(first > 0);
    for _ in 0..9 {
        ui.tick();
    }
    let mid = ui.resolved_style(n).unwrap().width;
    assert_eq!(mid, 25.0);

    let second = ui.animate(n, spec::prop::WIDTH, 200.0, 600, spec::Easing::Linear as u8, 0);
    assert!(second > 0);
    assert_eq!(ui.resolved_style(n).unwrap().width, mid);
    ui.cancel_anim(first); // stale id: the second animation killed the first.

    for _ in 0..18 {
        ui.tick();
    }
    let retargeted_mid = ui.resolved_style(n).unwrap().width;
    assert!(
        (retargeted_mid - 112.5).abs() < 0.001,
        "second animation must start from the interrupted value, got {retargeted_mid}",
    );
}

#[test]
fn destroy_subtree_frees_anims_and_slots() {
    let mut ui = Ui::new();
    let parent = ui.create_node(0);
    let child = ui.create_node(0);
    ui.insert_before(spec::ROOT_ID, parent, 0);
    ui.insert_before(parent, child, 0);
    ui.set_focus(child);
    let aid = ui.animate(child, spec::prop::OPACITY, 0.0, 1000, 0, 0);
    assert!(aid > 0);
    ui.destroy_node(parent);
    assert_eq!(ui.focused(), 0);
    assert!(ui.layout_of(parent).is_none());
    assert!(ui.layout_of(child).is_none());
    // The track died with the subtree: cancel is a no-op, ticks don't panic.
    ui.cancel_anim(aid);
    for _ in 0..3 {
        ui.tick();
        validate_drawlist(&ui.draw().words.clone());
    }
}

#[test]
fn opacity_multiplies_down_the_subtree() {
    let mut ui = Ui::new();
    let outer = ui.create_node(0);
    ui.set_prop(outer, spec::prop::WIDTH, 100.0);
    ui.set_prop(outer, spec::prop::HEIGHT, 100.0);
    ui.set_prop(outer, spec::prop::OPACITY, 0.5);
    ui.insert_before(spec::ROOT_ID, outer, 0);
    let inner = ui.create_node(0);
    ui.set_prop(inner, spec::prop::WIDTH, 50.0);
    ui.set_prop(inner, spec::prop::HEIGHT, 50.0);
    ui.set_prop(inner, spec::prop::OPACITY, 0.5);
    ui.set_prop(inner, spec::prop::BG_COLOR, abgr(100, 100, 100, 255) as f64);
    ui.insert_before(outer, inner, 0);
    ui.tick();
    let words = ui.draw().words.clone();
    validate_drawlist(&words);
    let i = words.iter().position(|&w| w == spec::draw_op::RECT).unwrap();
    let a = words[i + 3] >> 24;
    // 255 * 0.5 * 0.5 ≈ 64 (rounding via +0.5 in scale_alpha).
    assert_eq!(a, 64);
}

#[test]
fn zindex_orders_siblings_stably() {
    let mut ui = Ui::new();
    let mk = |ui: &mut Ui, z: f64, r: u8| {
        let n = ui.create_node(0);
        ui.set_prop(n, spec::prop::WIDTH, 10.0);
        ui.set_prop(n, spec::prop::HEIGHT, 10.0);
        ui.set_prop(n, spec::prop::POS_TYPE, spec::PosType::Absolute as u32 as f64);
        ui.set_prop(n, spec::prop::INSET_T, 0.0);
        ui.set_prop(n, spec::prop::INSET_L, 0.0);
        ui.set_prop(n, spec::prop::Z_INDEX, z);
        ui.set_prop(n, spec::prop::BG_COLOR, abgr(r, 0, 0, 255) as f64);
        ui.insert_before(spec::ROOT_ID, n, 0);
    };
    mk(&mut ui, 1.0, 1); // insertion order 1, z 1
    mk(&mut ui, 0.0, 2); // insertion order 2, z 0
    mk(&mut ui, 0.0, 3); // insertion order 3, z 0 (stable after r=2)
    mk(&mut ui, -1.0, 4); // negative z paints first
    ui.tick();
    let words = ui.draw().words.clone();
    validate_drawlist(&words);
    let mut reds = Vec::new();
    let mut i = 0usize;
    while i < words.len() {
        match words[i] {
            spec::draw_op::RECT => {
                reds.push((words[i + 3] & 0xff) as u8);
                i += 4;
            }
            spec::draw_op::GRAD_RECT => i += 6,
            spec::draw_op::TRI => i += 7,
            spec::draw_op::GLYPH_RUN => i += 3 + 2 * ((words[i + 1] >> 16) as usize),
            spec::draw_op::TEX_QUAD => i += 9,
            _ => i += 1,
        }
    }
    assert_eq!(reds, alloc::vec![4, 2, 3, 1]);
}

#[test]
fn image_tex_quad_clips_with_uv_reinterpolation() {
    let mut ui = Ui::new();
    let pixels = alloc::vec![0xffu8; 16 * 16 * 4];
    let tex = ui.upload_texture(&pixels, 16, 16, spec::psm::PSM_8888);
    assert_eq!(tex, 0);
    // Validation failures.
    assert_eq!(ui.upload_texture(&pixels, 17, 16, spec::psm::PSM_8888), -1);
    assert_eq!(ui.upload_texture(&pixels, 1024, 16, spec::psm::PSM_8888), -1);
    assert_eq!(ui.upload_texture(&pixels[..8], 16, 16, spec::psm::PSM_8888), -1);
    assert_eq!(ui.upload_texture(&pixels, 16, 16, 99), -1);
    let view = ui.texture(tex).unwrap();
    assert_eq!(
        (view.pixels.len(), view.w, view.h, view.psm),
        (1024, 16, 16, spec::psm::PSM_8888)
    );
    assert!(view.palette.is_none() && !view.linear);
    assert_eq!(view.pixels.as_ptr() as usize % 16, 0, "texture pixels must be 16-byte aligned");

    let img = ui.create_node(spec::NodeType::Image as u8);
    ui.set_prop(img, spec::prop::WIDTH, 100.0);
    ui.set_prop(img, spec::prop::HEIGHT, 100.0);
    ui.set_prop(img, spec::prop::POS_TYPE, spec::PosType::Absolute as u32 as f64);
    ui.set_prop(img, spec::prop::INSET_T, 0.0);
    ui.set_prop(img, spec::prop::INSET_L, 0.0);
    ui.set_prop(img, spec::prop::TRANSLATE_X, 430.0); // half off right: u1 = 0.5
    ui.set_image(img, tex);
    ui.insert_before(spec::ROOT_ID, img, 0);
    ui.tick();
    let words = ui.draw().words.clone();
    validate_drawlist(&words);
    let i = words.iter().position(|&w| w == spec::draw_op::TEX_QUAD).unwrap();
    assert_eq!(words[i + 1], tex as u32);
    assert_eq!(decode_xy(words[i + 2]), (430, 0));
    assert_eq!(decode_wh(words[i + 3]), (50, 100));
    assert_eq!(f32::from_bits(words[i + 4]), 0.0); // u0
    assert_eq!(f32::from_bits(words[i + 6]), 0.5); // u1
    assert_eq!(f32::from_bits(words[i + 7]), 1.0); // v1
}

#[test]
fn root_is_a_full_screen_flex_column() {
    let mut ui = Ui::new();
    ui.tick();
    assert_eq!(ui.layout_of(spec::ROOT_ID).unwrap(), (0.0, 0.0, 480.0, 272.0));
    let r = ui.resolved_style(spec::ROOT_ID).unwrap();
    assert_eq!(r.flex_dir, spec::FlexDir::Col as u8);
    // Root cannot be destroyed.
    ui.destroy_node(spec::ROOT_ID);
    assert!(ui.layout_of(spec::ROOT_ID).is_some());
}

#[test]
fn full_percent_sentinel_maps_to_100_percent() {
    let mut ui = Ui::new();
    let n = ui.create_node(0);
    ui.set_prop(n, spec::prop::WIDTH, -1.0); // w-full
    ui.set_prop(n, spec::prop::HEIGHT, 40.0);
    ui.insert_before(spec::ROOT_ID, n, 0);
    ui.tick();
    assert_eq!(ui.layout_of(n).unwrap(), (0.0, 0.0, 480.0, 40.0));
}

#[test]
fn style_table_parse_rejects_garbage() {
    let mut ui = Ui::new();
    assert!(!ui.load_styles(&[1, 2, 3]));
    assert!(!ui.load_styles(&[0u8; 32]));
    let good = encode_styles(&[StyleSpec::new()]);
    assert!(ui.load_styles(&good));
    assert!(!ui.load_styles(&good[..good.len() - 1 + 0][..6])); // truncated header
    // A record with a style id past the table resolves as unstyled.
    // (Compare via raw prop bits — Resolved holds NANs, so PartialEq lies.)
    let n = ui.create_node(0);
    ui.set_style(n, 99);
    let r = ui.resolved_style(n).unwrap();
    let d = style::Resolved::default();
    for prop in 0u16..=255 {
        assert_eq!(r.get_bits(prop as u8), d.get_bits(prop as u8), "prop {prop}");
    }
}

#[test]
fn scale_only_transform_stays_axis_aligned() {
    let mut ui = Ui::new();
    let n = ui.create_node(0);
    ui.set_prop(n, spec::prop::WIDTH, 100.0);
    ui.set_prop(n, spec::prop::HEIGHT, 50.0);
    ui.set_prop(n, spec::prop::BG_COLOR, abgr(1, 2, 3, 255) as f64);
    ui.set_prop(n, spec::prop::SCALE, 0.5);
    ui.insert_before(spec::ROOT_ID, n, 0);
    ui.tick();
    let words = ui.draw().words.clone();
    let counts = validate_drawlist(&words);
    assert_eq!(counts[spec::draw_op::TRI as usize], 0);
    let i = words.iter().position(|&w| w == spec::draw_op::RECT).unwrap();
    // Scaled 0.5 about center: 100x50 -> 50x25 at (25, 12.5->13 rounded).
    assert_eq!(decode_xy(words[i + 1]), (25, 13));
    assert_eq!(decode_wh(words[i + 2]), (50, 25));
}

#[test]
fn scale_x_transform_is_paint_only_and_can_anchor_left() {
    let mut ui = Ui::new();
    let n = ui.create_node(0);
    ui.set_prop(n, spec::prop::WIDTH, 100.0);
    ui.set_prop(n, spec::prop::HEIGHT, 20.0);
    ui.set_prop(n, spec::prop::BG_COLOR, abgr(1, 2, 3, 255) as f64);
    ui.set_prop(n, spec::prop::SCALE_X, 0.5);
    // Scaling is about center. Offset left by half the lost width to keep the
    // progress fill anchored at x=0 while the right edge moves.
    ui.set_prop(n, spec::prop::TRANSLATE_X, -25.0);
    ui.insert_before(spec::ROOT_ID, n, 0);
    ui.tick();
    assert_eq!(ui.layout_of(n).unwrap().2, 100.0);

    let words = ui.draw().words.clone();
    let counts = validate_drawlist(&words);
    assert_eq!(counts[spec::draw_op::TRI as usize], 0);
    let i = words.iter().position(|&w| w == spec::draw_op::RECT).unwrap();
    assert_eq!(decode_xy(words[i + 1]), (0, 0));
    assert_eq!(decode_wh(words[i + 2]), (50, 20));
}

#[test]
fn scaled_glyph_cells_follow_the_window_at_both_raster_densities() {
    for density in [1, 2] {
        let mut ui = Ui::new_with_raster_density(density);
        let mut blob = encode_atlas_version_density(spec::font_atlas::VERSION, density as u8,
            0, 8, 8, 7, 8, 1, &[('A' as u32, 0, 8)]);
        blob[24..].fill(255);
        assert!(ui.load_font_atlas(&blob));
        let text = ui.create_node(spec::NodeType::Text as u8);
        ui.set_text(text, "AA");
        for (p, v) in [(spec::prop::WIDTH, 16.0), (spec::prop::HEIGHT, 8.0),
            (spec::prop::SCALE_X, 0.5), (spec::prop::SCALE_Y, 0.75),
            (spec::prop::ORIGIN_X, -0.5), (spec::prop::ORIGIN_Y, -0.5),
            (spec::prop::TEXT_COLOR, abgr(60, 120, 180, 255) as f64)] { ui.set_prop(text, p, v); }
        ui.insert_before(spec::ROOT_ID, text, 0);
        ui.tick();
        let words = ui.draw().words.clone();
        assert_eq!(validate_drawlist(&words)[spec::draw_op::TEX_QUAD as usize], 2);
        assert_eq!(decode_xy(words[2]), (0, 0));
        assert_eq!(decode_xy(words[11]), (4, 0));
        assert_eq!(decode_wh(words[3]), (4, 6));
        assert_eq!(decode_wh(words[12]), (4, 6));
        assert_eq!(words[1], words[10], "glyphs and runs reuse the font page");
        let texture = ui.texture(words[1] as i32).unwrap();
        assert!(texture.linear);
        let mut frame = alloc::vec![0; spec::SCREEN_W as usize * spec::SCREEN_H as usize * 4];
        crate::raster::render(&ui, &words, &mut frame);
        let at = (2 * spec::SCREEN_W as usize + 2) * 4;
        assert_eq!(&frame[at..at + 3], &[60, 120, 180]);
        // The same page survives a new scale, but must not survive a font
        // replacement with the same dimensions and glyph count.
        let handle = words[1] as i32;
        ui.set_prop(text, spec::prop::SCALE_X, 0.75);
        assert_eq!(ui.draw().words[1] as i32, handle);
        blob[24..].fill(0);
        assert!(ui.load_font_atlas(&blob));
        let replaced = ui.draw().words.clone();
        assert_ne!(replaced[1] as i32, handle);
        assert!(ui.texture(handle).is_none());
        let blank = ui.texture(replaced[1] as i32).unwrap();
        // Padding may contain the guarded solid-fill patch. Glyph coverage
        // and its one-texel gutter must be empty after this replacement.
        for y in 0..8 * density + 2 {
            let start = (y * blank.w) as usize;
            assert!(blank.pixels[start..start + (8 * density + 2) as usize].iter().all(|&b| b == 0));
        }
        assert_eq!(ui.texture_slot_count(), 1, "replacement reuses storage without stale handles");
    }
}

#[test]
fn static_glyph_warmup_respects_budget_and_skips_multi_page_fonts() {
    let mut ui = Ui::new();
    for slot in [0, 1] {
        assert!(ui.load_font_atlas(&encode_atlas(slot, 8, 8, 7, 8, 1, &[('A' as u32, 0, 8)])));
    }
    let glyphs: Vec<_> = (0..50u16).map(|gid| ('A' as u32 + gid as u32, gid, 64)).collect();
    assert!(ui.load_font_atlas(&encode_atlas(2, 64, 64, 60, 64, 50, &glyphs)));
    assert_eq!(ui.warm_static_glyph_pages(255), 0);
    assert_eq!(ui.texture_slot_count(), 0);
    assert_eq!(ui.warm_static_glyph_pages(256), 256);
    assert_eq!(ui.texture_slot_count(), 1);
    let first = ui.prepare_glyph_page(0, 0).unwrap().handle;
    assert_eq!(ui.warm_static_glyph_pages(1024 * 1024), 512);
    assert_eq!(ui.texture_slot_count(), 2, "multi-page fonts are not prefetched");
    assert_eq!(ui.prepare_glyph_page(0, 0).unwrap().handle, first, "warming reuses existing pages");
    assert!(ui.prepare_glyph_page(0, 1).is_none(), "invalid glyph ids cannot underflow page size");
}

#[test]
fn scaled_glyph_run_crosses_pages_and_returns_to_the_first_page() {
    let mut ui = Ui::new();
    // 64 px cells plus the two-texel gutter fit 7 x 7 glyphs per page.
    let glyphs: Vec<_> = (0..50u16).map(|gid| ('A' as u32 + gid as u32, gid, 64)).collect();
    assert!(ui.load_font_atlas(&encode_atlas(0, 64, 64, 60, 64, 50, &glyphs)));
    let text = ui.create_node(spec::NodeType::Text as u8);
    ui.set_text(text, "ArA");
    for (p, v) in [(spec::prop::WIDTH, 192.0), (spec::prop::HEIGHT, 64.0),
        (spec::prop::SCALE, 0.5), (spec::prop::ORIGIN_X, -0.5), (spec::prop::ORIGIN_Y, -0.5)] {
        ui.set_prop(text, p, v);
    }
    ui.insert_before(spec::ROOT_ID, text, 0);
    ui.tick();
    let words = ui.draw().words.clone();
    assert_eq!(validate_drawlist(&words)[spec::draw_op::TEX_QUAD as usize], 3);
    assert_ne!(words[1], words[10]);
    assert_eq!(words[1], words[19]);
    assert_eq!(&words[4..8], &words[22..26]);
    for at in [0, 9, 18] {
        let texture = ui.texture(words[at + 1] as i32).unwrap();
        assert_eq!(f32::from_bits(words[at + 4]) * texture.w as f32, 1.0);
        assert_eq!(f32::from_bits(words[at + 6]) * texture.w as f32, 65.0);
    }
    assert_eq!(ui.texture_slot_count(), 2);
    let first = ui.prepare_glyph_page(0, 0).unwrap();
    let last = ui.prepare_glyph_page(0, 49).unwrap();
    assert!(first.contains(0) && first.contains(48));
    assert!(!first.contains(49));
    assert!(last.contains(49));
    assert!(!last.contains(48) && !last.contains(50), "partial pages must not advertise unallocated glyphs");
}

#[test]
fn moving_inner_clip_does_not_resample_visible_scaled_glyph_ink() {
    for density in [1, 2] { for scale in [0.585, 0.64, 0.75] {
        let mut ui = Ui::new_with_raster_density(density);
        let mut atlas = encode_atlas_version_density(spec::font_atlas::VERSION, density as u8,
            0, 8, 8, 7, 8, 1, &[('A' as u32, 0, 8)]);
        for (i, coverage) in atlas[24..].iter_mut().enumerate() { *coverage = (i % 8 * 31) as u8; }
        assert!(ui.load_font_atlas(&atlas));
        let parent = ui.create_node(0);
        for (p, v) in [(spec::prop::WIDTH, 11.0), (spec::prop::HEIGHT, 8.0)] { ui.set_prop(parent, p, v); }
        let text = ui.create_node(spec::NodeType::Text as u8);
        ui.set_text(text, "AA");
        for (p, v) in [(spec::prop::WIDTH, 16.0), (spec::prop::HEIGHT, 8.0),
            (spec::prop::SCALE, scale), (spec::prop::ORIGIN_X, -0.5), (spec::prop::ORIGIN_Y, -0.5),
            (spec::prop::TRANSLATE_X, 7.37)] { ui.set_prop(text, p, v); }
        ui.insert_before(parent, text, 0); ui.insert_before(spec::ROOT_ID, parent, 0); ui.tick();
        let mut reference = alloc::vec![0; spec::SCREEN_W as usize * spec::SCREEN_H as usize * 4];
        let full = ui.draw().words.clone(); crate::raster::render(&ui, &full, &mut reference);
        assert!(reference.chunks_exact(4).any(|pixel| pixel != &reference[..4]));
        ui.set_prop(parent, spec::prop::OVERFLOW, spec::Overflow::Hidden as u8 as f64);
        for width in [8, 9, 10, 11, 12] {
            ui.set_prop(parent, spec::prop::WIDTH, width as f64);
            let clipped = ui.draw().words.clone(); validate_drawlist(&clipped);
            let mut pixels = alloc::vec![0; reference.len()]; crate::raster::render(&ui, &clipped, &mut pixels);
            for y in 0..8 { for x in 0..width {
                let at = (y * spec::SCREEN_W as usize + x) * 4;
                assert_eq!(&pixels[at..at + 4], &reference[at..at + 4], "density={density} scale={scale} clip={width} pixel={x},{y}");
            }}
            for y in 0..8 { for x in width..24 {
                let at = (y * spec::SCREEN_W as usize + x) * 4;
                assert_eq!(&pixels[at..at + 4], &reference[..4]);
            }}
        }
    }}
}

#[test]
fn scaled_glyph_crossing_viewport_is_uv_clipped_instead_of_dropped() {
    let mut ui = Ui::new();
    ui.load_font_atlas(&encode_atlas(0, 8, 8, 7, 8, 1, &[('A' as u32, 0, 8)]));
    let text = ui.create_node(spec::NodeType::Text as u8);
    ui.set_text(text, "A");
    for (p, v) in [(spec::prop::WIDTH, 8.0), (spec::prop::HEIGHT, 8.0),
        (spec::prop::SCALE, 0.5), (spec::prop::ORIGIN_X, -0.5), (spec::prop::ORIGIN_Y, -0.5),
        (spec::prop::TRANSLATE_X, -2.0)] { ui.set_prop(text, p, v); }
    ui.insert_before(spec::ROOT_ID, text, 0);
    ui.tick();
    let words = ui.draw().words.clone();
    assert_eq!(validate_drawlist(&words)[spec::draw_op::TEX_QUAD as usize], 1);
    assert_eq!(decode_xy(words[2]), (0, 0));
    assert_eq!(decode_wh(words[3]), (2, 4));
    let texture = ui.texture(words[1] as i32).unwrap();
    let u0 = f32::from_bits(words[4]) * texture.w as f32;
    let u1 = f32::from_bits(words[6]) * texture.w as f32;
    assert_eq!((u0, u1), (5.0, 9.0), "half-cell clip preserves its coverage coordinates");
    ui.free_texture(words[1] as i32);
    let rebaked = ui.draw().words.clone();
    assert_ne!(rebaked[1], words[1]);
    assert!(ui.texture(rebaked[1] as i32).is_some());
}

#[test]
fn root_cannot_be_reparented_under_a_detached_node() {
    let mut ui = Ui::new();
    // A DETACHED parent defeats the ancestor-walk cycle guard; the explicit
    // root-as-child reject must keep slot 1 alive forever.
    let x = ui.create_node(0);
    ui.insert_before(x, spec::ROOT_ID, 0);
    ui.destroy_node(x);
    ui.tick();
    assert!(ui.layout_of(spec::ROOT_ID).is_some(), "root died");
    // The core still works: a new child under the root lays out.
    let n = ui.create_node(0);
    ui.set_prop(n, spec::prop::HEIGHT, 40.0);
    ui.insert_before(spec::ROOT_ID, n, 0);
    ui.tick();
    assert_eq!(ui.layout_of(n).unwrap(), (0.0, 0.0, 480.0, 40.0));
    // Also via an ATTACHED parent (plain cycle guard case).
    ui.insert_before(n, spec::ROOT_ID, 0);
    ui.tick();
    assert_eq!(ui.layout_of(spec::ROOT_ID).unwrap(), (0.0, 0.0, 480.0, 272.0));
}

#[test]
fn any_negative_size_is_the_size_full_sentinel() {
    // spec.ts: "Any negative width/height value is treated as this sentinel".
    let mut ui = Ui::new();
    let n = ui.create_node(0);
    ui.set_prop(n, spec::prop::WIDTH, -2.0);
    ui.set_prop(n, spec::prop::HEIGHT, 40.0);
    ui.insert_before(spec::ROOT_ID, n, 0);
    ui.tick();
    assert_eq!(ui.layout_of(n).unwrap(), (0.0, 0.0, 480.0, 40.0));
    ui.set_prop(n, spec::prop::HEIGHT, -0.5);
    ui.tick();
    assert_eq!(ui.layout_of(n).unwrap(), (0.0, 0.0, 480.0, 272.0));
}

#[test]
fn size_full_sentinel_is_not_animatable() {
    let mut ui = Ui::new();
    let n = ui.create_node(0);
    ui.set_prop(n, spec::prop::WIDTH, 200.0);
    ui.set_prop(n, spec::prop::HEIGHT, 40.0);
    ui.insert_before(spec::ROOT_ID, n, 0);
    ui.tick();
    // animate() TO the sentinel: no-op, returns -1, width stays put.
    assert_eq!(ui.animate(n, spec::prop::WIDTH, -1.0, 500, spec::Easing::Linear as u8, 0), -1);
    for _ in 0..5 {
        ui.tick();
    }
    assert_eq!(ui.layout_of(n).unwrap().2, 200.0);
    // animate() FROM the sentinel: also a no-op.
    ui.set_prop(n, spec::prop::WIDTH, -1.0);
    assert_eq!(ui.animate(n, spec::prop::WIDTH, 100.0, 500, spec::Easing::Linear as u8, 0), -1);
    ui.tick();
    assert_eq!(ui.layout_of(n).unwrap().2, 480.0);
    // Style transitions between a pixel width and w-full spawn NO width
    // track: the variant swap snaps.
    let mut s0 = StyleSpec::new();
    s0.base = alloc::vec![(spec::prop::WIDTH, 160f32.to_bits())];
    let mut s1 = StyleSpec::new();
    s1.base = alloc::vec![(spec::prop::WIDTH, (-1f32).to_bits())];
    s1.transition = Some((0xffff_ffff, 300, 0, spec::Easing::Linear as u8));
    assert!(ui.load_styles(&encode_styles(&[s0, s1])));
    let m = ui.create_node(0);
    ui.set_prop(m, spec::prop::HEIGHT, 10.0);
    ui.insert_before(spec::ROOT_ID, m, 0);
    ui.set_style(m, 0);
    ui.tick();
    assert_eq!(ui.layout_of(m).unwrap().2, 160.0);
    ui.set_style(m, 1);
    assert_eq!(ui.resolved_style(m).unwrap().width, -1.0, "snap, not a tween");
    ui.tick();
    assert_eq!(ui.layout_of(m).unwrap().2, 480.0);
}

#[test]
fn huge_durations_do_not_overflow() {
    assert!(crate::anim::ms_to_frames(u32::MAX, 60) >= 1); // would panic pre-fix
    assert!(crate::anim::ms_to_frames(u32::MAX, 240) >= 1);
    assert_eq!(crate::anim::ms_to_frames(100_000_000, 60), 6_000_000);
    let mut ui = Ui::new();
    let n = ui.create_node(0);
    ui.insert_before(spec::ROOT_ID, n, 0);
    let aid = ui.animate(n, spec::prop::OPACITY, 0.0, u32::MAX, 0, u32::MAX);
    assert!(aid > 0);
    for _ in 0..3 {
        ui.tick();
    }
}

#[test]
fn auto_endpoints_snap_instead_of_tweening_nan() {
    let mut ui = Ui::new();
    // Transition from an AUTO (NaN) width to a pixel width: browsers snap;
    // pre-fix the tween held NaN for the whole duration.
    let mut s = StyleSpec::new();
    s.base = alloc::vec![(spec::prop::WIDTH, 200f32.to_bits())];
    s.transition = Some((0xffff_ffff, 300, 0, spec::Easing::Linear as u8));
    assert!(ui.load_styles(&encode_styles(&[s])));
    let n = ui.create_node(0);
    ui.set_prop(n, spec::prop::HEIGHT, 20.0);
    ui.insert_before(spec::ROOT_ID, n, 0);
    ui.tick();
    assert_eq!(ui.layout_of(n).unwrap().2, 480.0); // stretched auto width
    ui.set_style(n, 0);
    let w = ui.resolved_style(n).unwrap().width;
    assert_eq!(w, 200.0, "snap to target, no NaN mid-flight (got {w})");
    ui.tick();
    assert_eq!(ui.layout_of(n).unwrap().2, 200.0);
    // Explicit animate() from auto: no track, target written as an override.
    let m = ui.create_node(0);
    ui.insert_before(spec::ROOT_ID, m, 0);
    assert_eq!(ui.animate(m, spec::prop::HEIGHT, 50.0, 300, spec::Easing::Linear as u8, 0), -1);
    ui.tick();
    assert_eq!(ui.layout_of(m).unwrap().3, 50.0);
}

#[test]
fn insert_past_max_tree_depth_is_a_noop() {
    // Tree-level: the over-limit insert returns false.
    let mut t = crate::tree::Tree::new();
    let mut parent = spec::ROOT_ID;
    for depth in 1..=spec::MAX_TREE_DEPTH {
        let n = t.alloc(0);
        assert!(t.insert_before(parent, n, 0), "insert at depth {depth} must succeed");
        parent = n;
    }
    let over = t.alloc(0);
    assert!(!t.insert_before(parent, over, 0), "insert past MAX_TREE_DEPTH must no-op");
    // Ui-level smoke: the capped chain still ticks/draws safely.
    let mut ui = Ui::new();
    let mut parent = spec::ROOT_ID;
    for _ in 1..=spec::MAX_TREE_DEPTH {
        let n = ui.create_node(0);
        ui.set_prop(n, spec::prop::BG_COLOR, abgr(8, 8, 8, 255) as f64);
        ui.insert_before(parent, n, 0);
        parent = n;
    }
    let over = ui.create_node(0);
    ui.insert_before(parent, over, 0); // silent no-op
    ui.tick();
    validate_drawlist(&ui.draw().words.clone());
    assert!(ui.layout_of(parent).is_some());
}

#[test]
fn set_image_negative_clears_the_binding() {
    let mut ui = Ui::new();
    let pixels = alloc::vec![0xffu8; 16 * 16 * 4];
    let tex = ui.upload_texture(&pixels, 16, 16, spec::psm::PSM_8888);
    assert_eq!(tex, 0, "texture handles are 0-based");
    let img = ui.create_node(spec::NodeType::Image as u8);
    ui.set_prop(img, spec::prop::WIDTH, 32.0);
    ui.set_prop(img, spec::prop::HEIGHT, 32.0);
    ui.insert_before(spec::ROOT_ID, img, 0);
    ui.set_image(img, tex);
    ui.tick();
    let counts = validate_drawlist(&ui.draw().words.clone());
    assert_eq!(counts[spec::draw_op::TEX_QUAD as usize], 1);
    // Unknown positive handles are still ignored (binding kept)...
    ui.set_image(img, 99);
    let counts = validate_drawlist(&ui.draw().words.clone());
    assert_eq!(counts[spec::draw_op::TEX_QUAD as usize], 1);
    // ...but any negative handle CLEARS (renderer.ts sends -1 for src="").
    ui.set_image(img, -1);
    let counts = validate_drawlist(&ui.draw().words.clone());
    assert_eq!(counts[spec::draw_op::TEX_QUAD as usize], 0);
}

#[test]
fn cmap_xoff_shifts_glyph_cells_left() {
    // A synthetic atlas whose 'A' carries xoff=2 (negative-LSB bake shift):
    // the emitted cell must sit at pen - 2 while advances are unaffected.
    let mut blob = encode_atlas(
        0,
        8,
        8,
        7,
        10,
        3,
        &[(0xfffd, 0, 8), ('A' as u32, 1, 6), ('B' as u32, 2, 5)],
    );
    // Patch cmap byte +7 (xoff) of the 'A' entry (entry index 1: sorted by
    // codepoint 'A' < 'B' < 0xfffd).
    let a_entry = spec::font_atlas::HEADER_SIZE + spec::font_atlas::CMAP_ENTRY_SIZE;
    blob[a_entry + 7] = 2;
    let mut ui = Ui::new();
    assert!(ui.load_font_atlas(&blob));
    assert_eq!(ui.measure_text("AB", 0), 11.0, "xoff must not change advances");
    ui.set_prop(spec::ROOT_ID, spec::prop::PADDING_L, 10.0);
    let t = ui.create_node(spec::NodeType::Text as u8);
    ui.set_prop(t, spec::prop::TEXT_COLOR, abgr(255, 255, 255, 255) as f64);
    ui.set_text(t, "AB");
    ui.insert_before(spec::ROOT_ID, t, 0);
    ui.tick();
    let words = ui.draw().words.clone();
    validate_drawlist(&words);
    let i = words.iter().position(|&w| w == spec::draw_op::GLYPH_RUN).unwrap();
    assert_eq!(decode_xy(words[i + 3]).0, 10 - 2, "'A' cell shifted left by its xoff");
    assert_eq!(decode_xy(words[i + 5]).0, 10 + 6, "'B' (xoff 0) at the plain pen position");
}

/// Two runs of a whole interaction script (styles, focus transitions,
/// springs, text edits) must be byte-identical — the golden-test bedrock.
#[test]
fn end_to_end_determinism_script() {
    fn run() -> Vec<u32> {
        let mut ui = Ui::new();
        let mut s0 = StyleSpec::new();
        s0.base = alloc::vec![
            (spec::prop::WIDTH, 80f32.to_bits()),
            (spec::prop::HEIGHT, 30f32.to_bits()),
            (spec::prop::BG_COLOR, abgr(30, 41, 59, 255)),
        ];
        s0.focus = alloc::vec![(spec::prop::BG_COLOR, abgr(129, 140, 248, 255))];
        s0.transition = Some((0xffff_ffff, 150, 0, spec::Easing::SpringBouncy as u8));
        ui.load_styles(&encode_styles(&[s0]));
        ui.load_font_atlas(&encode_atlas(
            0,
            8,
            8,
            7,
            10,
            3,
            &[(0xfffd, 0, 8), ('A' as u32, 1, 6), ('B' as u32, 2, 5)],
        ));
        let card = ui.create_node(0);
        ui.set_style(card, 0);
        ui.insert_before(spec::ROOT_ID, card, 0);
        let label = ui.create_node(spec::NodeType::Text as u8);
        ui.set_text(label, "AB");
        ui.insert_before(card, label, 0);
        let mut all = Vec::new();
        for f in 0..40u32 {
            if f == 5 {
                ui.set_focus(card);
            }
            if f == 20 {
                ui.set_focus(0);
            }
            if f == 25 {
                ui.replace_text(label, "BA\nA");
            }
            ui.tick();
            all.extend_from_slice(&ui.draw().words);
        }
        all
    }
    let a = run();
    assert!(!a.is_empty());
    assert_eq!(a, run());
}

// ---- baked keyframe timelines ------------------------------------------------

/// translateX 0 -> 60 px over 60 frames (linear), 30-frame delay, fill both.
fn slide_anim() -> AnimSpec {
    AnimSpec {
        delay_frames: 30,
        period_frames: 60,
        iterations: 1,
        fill: spec::style_table::ANIM_FILL_BACKWARDS | spec::style_table::ANIM_FILL_FORWARDS,
        tracks: alloc::vec![(
            spec::prop::TRANSLATE_X,
            alloc::vec![SegSpec(0, 60, 0f32.to_bits(), 60f32.to_bits(), spec::Easing::Linear as u8, None)],
        )],
    }
}

#[test]
fn baked_timeline_plays_delays_and_fills() {
    let mut ui = Ui::new();
    let mut s = StyleSpec::new();
    s.base = alloc::vec![(spec::prop::WIDTH, 10f32.to_bits())];
    s.animation = Some((0, alloc::vec![0]));
    assert!(ui.load_styles(&encode_styles_with_anims(&[s], &[slide_anim()])));
    let n = ui.create_node(0);
    ui.insert_before(spec::ROOT_ID, n, 0);
    ui.set_style(n, 0);
    // t = 0 (during the delay): backwards fill pins the first-frame value.
    ui.tick();
    assert_eq!(ui.resolved_style(n).unwrap().translate_x, 0.0);
    // t = 60 = delay + 30: halfway through the 60-frame linear segment.
    for _ in 0..60 {
        ui.tick();
    }
    assert_eq!(ui.resolved_style(n).unwrap().translate_x, 30.0);
    // Way past the end: forwards fill holds the final value.
    for _ in 0..120 {
        ui.tick();
    }
    assert_eq!(ui.resolved_style(n).unwrap().translate_x, 60.0);
}

#[test]
fn timeline_loop_restarts_the_choreography() {
    let mut ui = Ui::new();
    let mut s = StyleSpec::new();
    s.animation = Some((120, alloc::vec![0])); // loop every 120 frames
    assert!(ui.load_styles(&encode_styles_with_anims(&[s], &[slide_anim()])));
    let n = ui.create_node(0);
    ui.insert_before(spec::ROOT_ID, n, 0);
    ui.set_style(n, 0);
    for _ in 0..100 {
        ui.tick(); // t = 99: finished (delay 30 + period 60), forwards-filled
    }
    assert_eq!(ui.resolved_style(n).unwrap().translate_x, 60.0);
    for _ in 0..22 {
        ui.tick(); // t = 121 -> wrapped clock t = 1: back in the delay phase
    }
    assert_eq!(ui.resolved_style(n).unwrap().translate_x, 0.0);
    for _ in 0..59 {
        ui.tick(); // last eval at wrapped t = 60: halfway through the segment again
    }
    assert_eq!(ui.resolved_style(n).unwrap().translate_x, 30.0);
}

#[test]
fn timeline_list_precedence_matches_css() {
    // A: opacity 0 -> 1 over frames 0..30 (fill both).
    // B: opacity 1 -> 0 over 30 frames, delayed 60, fill forwards only.
    let fade_in = AnimSpec {
        delay_frames: 0,
        period_frames: 30,
        iterations: 1,
        fill: spec::style_table::ANIM_FILL_BACKWARDS | spec::style_table::ANIM_FILL_FORWARDS,
        tracks: alloc::vec![(
            spec::prop::OPACITY,
            alloc::vec![SegSpec(0, 30, 0f32.to_bits(), 1f32.to_bits(), spec::Easing::Linear as u8, None)],
        )],
    };
    let fade_out = AnimSpec {
        delay_frames: 60,
        period_frames: 30,
        iterations: 1,
        fill: spec::style_table::ANIM_FILL_FORWARDS,
        tracks: alloc::vec![(
            spec::prop::OPACITY,
            alloc::vec![SegSpec(0, 30, 1f32.to_bits(), 0f32.to_bits(), spec::Easing::Linear as u8, None)],
        )],
    };
    let mut s = StyleSpec::new();
    s.animation = Some((0, alloc::vec![0, 1]));
    let mut ui = Ui::new();
    assert!(ui.load_styles(&encode_styles_with_anims(&[s], &[fade_in, fade_out])));
    let n = ui.create_node(0);
    ui.insert_before(spec::ROOT_ID, n, 0);
    ui.set_style(n, 0);
    // t = 15: A halfway (0.5); B inactive (delay, no backwards fill) -> A wins.
    for _ in 0..16 {
        ui.tick();
    }
    assert_eq!(ui.resolved_style(n).unwrap().opacity, 0.5);
    // t = 45: A finished (fill 1.0); B still inactive -> A's fill shows.
    for _ in 0..30 {
        ui.tick();
    }
    assert_eq!(ui.resolved_style(n).unwrap().opacity, 1.0);
    // t = 75: B halfway (0.5) and later in the list -> B wins over A's fill.
    for _ in 0..30 {
        ui.tick();
    }
    assert_eq!(ui.resolved_style(n).unwrap().opacity, 0.5);
    // t = 120: both filled -> the later entry (B, 0.0) wins.
    for _ in 0..45 {
        ui.tick();
    }
    assert_eq!(ui.resolved_style(n).unwrap().opacity, 0.0);
}

#[test]
fn set_style_restarts_timelines() {
    let mut ui = Ui::new();
    let mut s = StyleSpec::new();
    s.animation = Some((0, alloc::vec![0]));
    assert!(ui.load_styles(&encode_styles_with_anims(&[s], &[slide_anim()])));
    let n = ui.create_node(0);
    ui.insert_before(spec::ROOT_ID, n, 0);
    ui.set_style(n, 0);
    for _ in 0..70 {
        ui.tick();
    }
    assert!(ui.resolved_style(n).unwrap().translate_x > 0.0);
    // Re-applying the style restarts the choreography from frame 0.
    ui.set_style(n, 0);
    ui.tick();
    assert_eq!(ui.resolved_style(n).unwrap().translate_x, 0.0);
}

#[test]
fn cubic_bezier_is_sane() {
    use crate::anim::cubic_bezier;
    assert_eq!(cubic_bezier(0.42, 0.0, 0.58, 1.0, 0.0), 0.0);
    assert_eq!(cubic_bezier(0.42, 0.0, 0.58, 1.0, 1.0), 1.0);
    // ease-in-out is symmetric: y(0.5) = 0.5.
    let mid = cubic_bezier(0.42, 0.0, 0.58, 1.0, 0.5);
    assert!((mid - 0.5).abs() < 1e-3, "mid = {mid}");
    // Monotonic over a coarse sweep.
    let mut prev = 0.0f32;
    for i in 0..=20 {
        let y = cubic_bezier(0.25, 0.1, 0.25, 1.0, i as f32 / 20.0);
        assert!(y >= prev - 1e-4, "not monotonic at {i}: {y} < {prev}");
        prev = y;
    }
}

#[test]
fn negative_insets_are_offsets_not_size_full() {
    // inset: -10 on an auto-sized absolute child must OUTSET the parent box
    // by 10px per side (CSS stretch), not resolve to the SIZE_FULL sentinel.
    let mut ui = Ui::new();
    let mut wrapper = StyleSpec::new();
    wrapper.base = alloc::vec![
        (spec::prop::POS_TYPE, spec::PosType::Absolute as u32),
        (spec::prop::INSET_L, 130f32.to_bits()),
        (spec::prop::INSET_T, 50f32.to_bits()),
        (spec::prop::WIDTH, 60f32.to_bits()),
        (spec::prop::HEIGHT, 60f32.to_bits()),
    ];
    let mut pulse = StyleSpec::new();
    pulse.base = alloc::vec![
        (spec::prop::POS_TYPE, spec::PosType::Absolute as u32),
        (spec::prop::INSET_T, (-10f32).to_bits()),
        (spec::prop::INSET_R, (-10f32).to_bits()),
        (spec::prop::INSET_B, (-10f32).to_bits()),
        (spec::prop::INSET_L, (-10f32).to_bits()),
    ];
    let mut mark = StyleSpec::new();
    mark.base = alloc::vec![
        (spec::prop::POS_TYPE, spec::PosType::Absolute as u32),
        (spec::prop::INSET_R, 0f32.to_bits()),
        (spec::prop::INSET_T, 0f32.to_bits()),
        (spec::prop::WIDTH, 20f32.to_bits()),
        (spec::prop::HEIGHT, 10f32.to_bits()),
    ];
    assert!(ui.load_styles(&encode_styles(&[wrapper, pulse, mark])));
    let w = ui.create_node(0);
    let p = ui.create_node(0);
    let m = ui.create_node(0);
    ui.insert_before(spec::ROOT_ID, w, 0);
    ui.insert_before(w, p, 0);
    ui.insert_before(p, m, 0);
    ui.set_style(w, 0);
    ui.set_style(p, 1);
    ui.set_style(m, 2);
    ui.tick();
    assert_eq!(ui.layout_of(w).unwrap(), (130.0, 50.0, 60.0, 60.0));
    // stretched: 60 + 10px outset per side, positioned at (-10, -10)
    assert_eq!(ui.layout_of(p).unwrap(), (-10.0, -10.0, 80.0, 80.0));
    // right-anchored mark: x = 80 - 20
    assert_eq!(ui.layout_of(m).unwrap(), (60.0, 0.0, 20.0, 10.0));
}

// ---- 3D + arc rendering smoke tests --------------------------------------------

#[test]
fn perspective_subtree_emits_depth_sorted_tris() {
    let mut ui = Ui::new();
    let mut root = StyleSpec::new();
    root.base = alloc::vec![
        (spec::prop::POS_TYPE, spec::PosType::Absolute as u32),
        (spec::prop::WIDTH, 100f32.to_bits()),
        (spec::prop::HEIGHT, 100f32.to_bits()),
        (spec::prop::PERSPECTIVE, 200f32.to_bits()),
    ];
    let mut face = StyleSpec::new();
    face.base = alloc::vec![
        (spec::prop::POS_TYPE, spec::PosType::Absolute as u32),
        (spec::prop::WIDTH, 50f32.to_bits()),
        (spec::prop::HEIGHT, 50f32.to_bits()),
        (spec::prop::INSET_L, 25f32.to_bits()),
        (spec::prop::INSET_T, 25f32.to_bits()),
        (spec::prop::BG_COLOR, 0xff88_8888u32),
        (spec::prop::ROTATE_Y, 45f32.to_bits()),
    ];
    assert!(ui.load_styles(&encode_styles(&[root, face])));
    let r = ui.create_node(0);
    let f = ui.create_node(0);
    ui.insert_before(spec::ROOT_ID, r, 0);
    ui.insert_before(r, f, 0);
    ui.set_style(r, 0);
    ui.set_style(f, 1);
    ui.tick();
    let words = ui.draw().words.clone();
    // A rotateY'd face must land on the TRI path (perspective projection).
    let mut i = 0;
    let mut tris = 0;
    while i < words.len() {
        let op = words[i];
        i += match op {
            x if x == spec::draw_op::RECT => 4,
            x if x == spec::draw_op::GRAD_RECT => 6,
            x if x == spec::draw_op::TRI => {
                tris += 1;
                7
            }
            x if x == spec::draw_op::GLYPH_RUN => {
                let n = (words[i + 1] >> 16) as usize;
                3 + 2 * n
            }
            x if x == spec::draw_op::TEX_QUAD => 9,
            x if x == spec::draw_op::SCISSOR => 3,
            _ => 1, // SCISSOR_POP
        };
    }
    assert!(tris >= 2, "expected projected face triangles, got {tris}");
}

#[test]
fn perspective_subdivided_images_form_one_texture_run_per_image() {
    let mut ui = Ui::new();
    let pixels = alloc::vec![0xffu8; 8 * 8 * 4];
    let cover_tex = ui.upload_texture(&pixels, 8, 8, spec::psm::PSM_8888);
    let reflection_tex = ui.upload_texture(&pixels, 8, 8, spec::psm::PSM_8888);
    assert!(cover_tex >= 0 && reflection_tex >= 0);
    assert_ne!(cover_tex, reflection_tex);

    let place = |ui: &mut Ui, node: i32, x: f64, y: f64, w: f64, h: f64| {
        ui.set_prop(node, spec::prop::POS_TYPE, spec::PosType::Absolute as u32 as f64);
        ui.set_prop(node, spec::prop::INSET_L, x);
        ui.set_prop(node, spec::prop::INSET_T, y);
        ui.set_prop(node, spec::prop::WIDTH, w);
        ui.set_prop(node, spec::prop::HEIGHT, h);
    };

    let stage = ui.create_node(spec::NodeType::View as u8);
    place(&mut ui, stage, 0.0, 0.0, 480.0, 272.0);
    ui.set_prop(stage, spec::prop::PERSPECTIVE, 620.0);
    ui.insert_before(spec::ROOT_ID, stage, 0);

    let card = ui.create_node(spec::NodeType::View as u8);
    place(&mut ui, card, 144.0, 27.0, 192.0, 218.0);
    ui.set_prop(card, spec::prop::ROTATE_Y, 55.0);
    ui.insert_before(stage, card, 0);

    let cover = ui.create_node(spec::NodeType::Image as u8);
    place(&mut ui, cover, 0.0, 0.0, 192.0, 109.0);
    ui.set_image(cover, cover_tex);
    ui.insert_before(card, cover, 0);

    let reflection = ui.create_node(spec::NodeType::Image as u8);
    place(&mut ui, reflection, 0.0, 109.0, 192.0, 109.0);
    ui.set_image(reflection, reflection_tex);
    ui.insert_before(card, reflection, 0);

    ui.tick();
    let words = ui.draw().words.clone();
    let counts = validate_drawlist(&words);
    let tri_count = counts[spec::draw_op::TEX_TRI as usize] as usize;
    assert!(tri_count > 4, "images must retain perspective subdivision");

    let runs = tex_tri_runs(&words);
    assert_eq!(
        runs,
        alloc::vec![(cover_tex as u32, tri_count / 2), (reflection_tex as u32, tri_count / 2)],
        "each image must be one consecutive PSP texture batch",
    );
}

#[test]
fn arc_primitive_emits_coverage_rects() {
    let mut ui = Ui::new();
    let mut arc = StyleSpec::new();
    arc.base = alloc::vec![
        (spec::prop::POS_TYPE, spec::PosType::Absolute as u32),
        (spec::prop::WIDTH, 40f32.to_bits()),
        (spec::prop::HEIGHT, 40f32.to_bits()),
        (spec::prop::INSET_L, 10f32.to_bits()),
        (spec::prop::INSET_T, 10f32.to_bits()),
        (spec::prop::BG_COLOR, 0xffff_ffffu32),
        (spec::prop::ARC_START, 45f32.to_bits()),
        (spec::prop::ARC_SWEEP, 180f32.to_bits()),
        (spec::prop::ARC_WIDTH, 5f32.to_bits()),
    ];
    assert!(ui.load_styles(&encode_styles(&[arc])));
    let n = ui.create_node(0);
    ui.insert_before(spec::ROOT_ID, n, 0);
    ui.set_style(n, 0);
    ui.tick();
    let words = ui.draw().words.clone();
    let mut rects = 0;
    let mut i = 0;
    while i < words.len() {
        let op = words[i];
        i += match op {
            x if x == spec::draw_op::RECT => {
                rects += 1;
                4
            }
            x if x == spec::draw_op::GRAD_RECT => 6,
            x if x == spec::draw_op::TRI => 7,
            x if x == spec::draw_op::GLYPH_RUN => {
                let c = (words[i + 1] >> 16) as usize;
                3 + 2 * c
            }
            x if x == spec::draw_op::TEX_QUAD => 9,
            x if x == spec::draw_op::SCISSOR => 3,
            _ => 1,
        };
    }
    // The half-ring rasterizes into many small coverage runs (not one box).
    assert!(rects > 20, "expected arc coverage runs, got {rects}");
}

// ---- DevTools ops (spec ops 18..22, docs/DEVTOOLS.md) ----------------------------

#[test]
fn debug_pause_freezes_and_step_advances_one_frame() {
    let mut ui = Ui::new();
    let mut s = StyleSpec::new();
    s.base = alloc::vec![
        (spec::prop::WIDTH, 40f32.to_bits()),
        (spec::prop::HEIGHT, 40f32.to_bits()),
    ];
    assert!(ui.load_styles(&encode_styles(&[s])));
    let n = ui.create_node(0);
    ui.insert_before(spec::ROOT_ID, n, 0);
    ui.set_style(n, 0);
    ui.tick();
    // 600 ms linear width anim: ~4.4 px per 1/60 frame — visible per tick.
    assert!(ui.animate(n, spec::prop::WIDTH, 200.0, 600, spec::Easing::Linear as u8, 0) >= 0);
    ui.tick();
    ui.draw();
    let w1 = ui.layout_of(n).unwrap().2;
    assert!(w1 > 40.0, "anim should have started, got {w1}");

    ui.debug_pause(true);
    assert!(ui.debug_paused());
    for _ in 0..5 {
        ui.tick();
    }
    ui.draw();
    assert_eq!(ui.layout_of(n).unwrap().2, w1, "paused world must hold");

    ui.debug_step();
    ui.tick(); // armed: advances exactly one frame
    ui.tick(); // not armed: no-op again
    ui.draw();
    let w2 = ui.layout_of(n).unwrap().2;
    assert!(w2 > w1, "step must advance one frame");

    ui.debug_pause(false);
    ui.tick();
    ui.draw();
    assert!(ui.layout_of(n).unwrap().2 > w2, "resume must run again");
}

#[test]
fn debug_inspect_overlays_and_reports_world_rect() {
    let mut ui = Ui::new();
    let mut s = StyleSpec::new();
    s.base = alloc::vec![
        (spec::prop::POS_TYPE, spec::PosType::Absolute as u32),
        (spec::prop::WIDTH, 40f32.to_bits()),
        (spec::prop::HEIGHT, 40f32.to_bits()),
        (spec::prop::INSET_L, 10f32.to_bits()),
        (spec::prop::INSET_T, 10f32.to_bits()),
        (spec::prop::BG_COLOR, 0xff20_4060u32),
    ];
    assert!(ui.load_styles(&encode_styles(&[s])));
    let n = ui.create_node(0);
    ui.insert_before(spec::ROOT_ID, n, 0);
    ui.set_style(n, 0);
    ui.tick();
    let baseline = ui.draw().words.len();
    assert_eq!(ui.debug_rect_xy(), -1, "no inspect target yet");

    ui.debug_inspect(n);
    assert_eq!(ui.debug_rect_xy(), -1, "rect only captured by draw()");
    let overlaid = ui.draw().words.len();
    // Overlay = translucent fill + 4 edge rects = 5 RECT ops = 20 words.
    assert_eq!(overlaid, baseline + 20, "highlight overlay must be appended");
    assert_eq!(ui.debug_rect_xy(), 10 | (10 << 16));
    assert_eq!(ui.debug_rect_wh(), 40 | (40 << 16));

    ui.debug_inspect(0);
    assert_eq!(ui.draw().words.len(), baseline, "overlay must clear");
    assert_eq!(ui.debug_rect_xy(), -1);
    assert_eq!(ui.debug_rect_wh(), -1);
}

#[test]
fn debug_inspect_glides_between_targets() {
    let mut ui = Ui::new();
    let mk = |x: f32| {
        let mut s = StyleSpec::new();
        s.base = alloc::vec![
            (spec::prop::POS_TYPE, spec::PosType::Absolute as u32),
            (spec::prop::WIDTH, 40f32.to_bits()),
            (spec::prop::HEIGHT, 40f32.to_bits()),
            (spec::prop::INSET_L, x.to_bits()),
            (spec::prop::INSET_T, 10f32.to_bits()),
            (spec::prop::BG_COLOR, 0xff20_4060u32),
        ];
        s
    };
    assert!(ui.load_styles(&encode_styles(&[mk(10.0), mk(200.0)])));
    let a = ui.create_node(0);
    let b = ui.create_node(0);
    ui.insert_before(spec::ROOT_ID, a, 0);
    ui.insert_before(spec::ROOT_ID, b, 0);
    ui.set_style(a, 0);
    ui.set_style(b, 1);
    ui.tick();

    // Decode the fill rect (first overlay op) X from the appended words.
    let overlay_x = |ui: &mut Ui, baseline: usize| -> i32 {
        let words = &ui.draw().words;
        assert!(words.len() > baseline, "overlay must be present");
        let xy = words[baseline + 1]; // [RECT, xy, wh, color]
        ((xy & 0xffff) as u16) as i16 as i32
    };
    let baseline = ui.draw().words.len();

    ui.debug_inspect(a);
    assert_eq!(overlay_x(&mut ui, baseline), 10, "first appearance is instant");

    ui.debug_inspect(b);
    let x1 = overlay_x(&mut ui, baseline);
    assert!(x1 > 10 && x1 < 200, "glide starts between the boxes, got {x1}");
    let x2 = overlay_x(&mut ui, baseline);
    assert!(x2 > x1, "glide advances every draw, got {x1} -> {x2}");
    for _ in 0..30 {
        ui.draw();
    }
    assert_eq!(overlay_x(&mut ui, baseline), 200, "glide converges exactly");
    assert_eq!(ui.debug_rect_xy(), 200 | (10 << 16), "readback is the target, not the animation");

    ui.debug_inspect(0);
    assert_eq!(ui.draw().words.len(), baseline, "clear hides the overlay");
}

/// set_text rides the incremental style path — and skips relayout entirely
/// inside a FIXED cell (definite px width AND height), where the measure
/// result cannot move layout. Empty <-> non-empty stays structural (the
/// taffy leaf has to (dis)appear).
#[test]
fn set_text_relayout_scope() {
    let mut ui = Ui::new();
    assert!(ui.load_font_atlas(&encode_atlas(
        0,
        8,
        8,
        7,
        10,
        3,
        &[(0xfffd, 0, 8), ('A' as u32, 1, 6), ('B' as u32, 2, 5)],
    )));
    let auto_t = ui.create_node(spec::NodeType::Text as u8);
    ui.set_text(auto_t, "A");
    ui.insert_before(spec::ROOT_ID, auto_t, 0);
    let fixed_t = ui.create_node(spec::NodeType::Text as u8);
    ui.set_prop(fixed_t, spec::prop::WIDTH, 40.0);
    ui.set_prop(fixed_t, spec::prop::HEIGHT, 12.0);
    ui.set_text(fixed_t, "A");
    ui.insert_before(spec::ROOT_ID, fixed_t, 1);
    ui.tick();
    assert!(!ui.layout.needs(), "clean after tick");

    // Auto-sized: a size-changing swap must schedule (incremental) relayout.
    ui.set_text(auto_t, "AB");
    assert!(ui.layout.needs(), "auto cell swap relayouts");
    assert!(!ui.layout.dirty, "…but incrementally, not a full rebuild");
    ui.tick();

    // Fixed cell: the swap must NOT schedule any layout work…
    ui.set_text(fixed_t, "AB");
    assert!(!ui.layout.needs(), "fixed cell swap skips relayout");
    ui.tick();
    // …and paint still shows the new text (reads the tree, not the ctx).
    let words = ui.draw().words.clone();
    validate_drawlist(&words);
    let runs = words.iter().filter(|&&w| w == spec::draw_op::GLYPH_RUN).count();
    assert_eq!(runs, 2, "both texts painted");

    // Empty <-> non-empty flips are structural (full rebuild).
    ui.set_text(fixed_t, "");
    assert!(ui.layout.dirty, "non-empty -> empty is structural");
    ui.tick();
    ui.set_text(fixed_t, "A");
    assert!(ui.layout.dirty, "empty -> non-empty is structural");
    ui.tick();
}

// ---- streamed textures: PackBits codec, CLUT8, IMG/TILESET entries, slots --

/// Test-local mirror of spec.ts packbitsEncode (runs >= 2 become run records
/// capped at 129; literal stretches break before the next run of >= 3).
fn packbits_encode(src: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut i = 0usize;
    while i < src.len() {
        let mut run = 1usize;
        while run < 129 && i + run < src.len() && src[i + run] == src[i] {
            run += 1;
        }
        if run >= 2 {
            out.push((126 + run) as u8);
            out.push(src[i]);
            i += run;
            continue;
        }
        let mut end = i + 1;
        while end < src.len() && end - i < 128 {
            let mut r = 1usize;
            while r < 3 && end + r < src.len() && src[end + r] == src[end] {
                r += 1;
            }
            if r >= 3 {
                break;
            }
            end += 1;
        }
        out.push((end - i - 1) as u8);
        out.extend_from_slice(&src[i..end]);
        i = end;
    }
    out
}

#[test]
fn packbits_decodes_hand_built_spec_vectors() {
    use crate::codec::packbits_decode;
    // Each vector is the exact spec.ts packbitsEncode output for its plain text.
    let mut one = [0u8; 1];
    assert!(packbits_decode(&[0, 5], &mut one)); // single literal
    assert_eq!(one, [5]);
    let mut run3 = [0u8; 3];
    assert!(packbits_decode(&[129, 7], &mut run3)); // run of 3
    assert_eq!(run3, [7, 7, 7]);
    let mut lits = [0u8; 3];
    assert!(packbits_decode(&[2, 1, 2, 3], &mut lits)); // 3-literal stretch
    assert_eq!(lits, [1, 2, 3]);
    // 2-runs stay literal (spec.ts: "2-runs are cheaper literal").
    let mut two_run = [0u8; 4];
    assert!(packbits_decode(&[3, 1, 2, 2, 3], &mut two_run));
    assert_eq!(two_run, [1, 2, 2, 3]);
    // Run capped at 129, then the leftover byte as a literal.
    let mut long = [0u8; 130];
    assert!(packbits_decode(&[255, 9, 0, 9], &mut long));
    assert!(long.iter().all(|&b| b == 9));
    // Mixed run + literal tail.
    let mut mixed = [0u8; 6];
    assert!(packbits_decode(&[130, 1, 1, 2, 3], &mut mixed));
    assert_eq!(mixed, [1, 1, 1, 1, 2, 3]);
    // Empty stream <-> empty output.
    assert!(packbits_decode(&[], &mut []));
    assert!(!packbits_decode(&[], &mut one));
}

#[test]
fn packbits_round_trips_against_the_encoder_mirror() {
    use crate::codec::packbits_decode;
    // Deterministic LCG pixel-ish data: long runs + noise, both paths hit.
    let mut src = Vec::new();
    let mut state = 0x1234_5678u32;
    while src.len() < 4096 {
        state = state.wrapping_mul(1664525).wrapping_add(1013904223);
        let b = (state >> 24) as u8;
        let n = if state & 7 == 0 { (state >> 16 & 0xff) as usize + 1 } else { 1 };
        for _ in 0..n {
            src.push(b);
        }
    }
    src.truncate(4096);
    // Sanity-check the mirror against one spec.ts hand vector.
    assert_eq!(packbits_encode(&[1, 1, 1, 1, 2, 3]), alloc::vec![130, 1, 1, 2, 3]);
    let enc = packbits_encode(&src);
    assert!(enc.len() < src.len(), "the vector must actually compress");
    let mut dec = alloc::vec![0u8; src.len()];
    assert!(packbits_decode(&enc, &mut dec));
    assert_eq!(dec, src);
}

#[test]
fn packbits_rejects_malformed_streams_without_panicking() {
    use crate::codec::packbits_decode;
    let mut out = [0u8; 4];
    assert!(!packbits_decode(&[3, 1, 2], &mut out), "truncated literal payload");
    assert!(!packbits_decode(&[130], &mut out), "run without a value byte");
    assert!(!packbits_decode(&[255, 1], &mut out), "run overruns dst");
    assert!(!packbits_decode(&[5, 1, 2, 3, 4, 5, 6], &mut out), "literal overruns dst");
    assert!(!packbits_decode(&[128, 1], &mut out), "src exhausted before dst full");
    let mut two = [0u8; 2];
    assert!(!packbits_decode(&[128, 5, 0, 1], &mut two), "trailing bytes after exact fit");
    assert!(packbits_decode(&[128, 5], &mut two));
    assert_eq!(two, [5, 5]);
}

#[test]
fn t8_upload_carries_an_aligned_palette_and_raw_indices() {
    let mut ui = Ui::new();
    let mut data = Vec::new();
    let mut palette = [0u8; 1024];
    for i in 0..256 {
        palette[i * 4] = i as u8; // r = index
        palette[i * 4 + 3] = 255;
    }
    data.extend_from_slice(&palette);
    let indices: Vec<u8> = (0..64u32).map(|i| (i * 3 % 256) as u8).collect(); // 8x8
    data.extend_from_slice(&indices);
    let tex = ui.upload_texture(&data, 8, 8, spec::psm::PSM_T8);
    assert_eq!(tex, 0, "first slot at gen 0 is handle 0");
    let view = ui.texture(tex).unwrap();
    assert_eq!((view.w, view.h, view.psm, view.linear), (8, 8, spec::psm::PSM_T8, false));
    assert_eq!(view.pixels, &indices[..]);
    assert_eq!(view.pixels.as_ptr() as usize % 16, 0, "indices must be 16-byte aligned");
    let pal = view.palette.expect("T8 textures carry a palette");
    assert_eq!(pal.len(), 1024);
    assert_eq!(pal.as_ptr() as usize % 16, 0, "palette must be 16-byte aligned");
    assert_eq!((pal[4], pal[7]), (1, 255));
    // Undersized: palette alone, or palette + short index stream.
    assert_eq!(ui.upload_texture(&data[..1023], 8, 8, spec::psm::PSM_T8), -1);
    assert_eq!(ui.upload_texture(&data[..1024 + 63], 8, 8, spec::psm::PSM_T8), -1);
}

#[test]
fn upload_texture_flags_decodes_rle_and_marks_linear() {
    let mut ui = Ui::new();
    // T8: raw palette + RLE index stream (16 x byte 7 -> [140, 7]).
    let indices = [7u8; 16];
    let mut data = alloc::vec![0u8; 1024];
    data.extend_from_slice(&packbits_encode(&indices));
    let flags = spec::img::FLAG_RLE | spec::img::FLAG_LINEAR;
    let tex = ui.upload_texture_flags(&data, 4, 4, spec::psm::PSM_T8, flags);
    assert!(tex >= 0);
    let view = ui.texture(tex).unwrap();
    assert!(view.linear);
    assert_eq!(view.pixels, &indices[..]);
    // Truncated RLE stream -> -1 (must decode to EXACTLY w*h bytes).
    assert_eq!(
        ui.upload_texture_flags(&data[..1025], 4, 4, spec::psm::PSM_T8, spec::img::FLAG_RLE),
        -1
    );
    // Non-T8 RLE: the whole payload is the compressed pixel stream.
    let px8888 = [0xabu8; 2 * 2 * 4];
    let enc = packbits_encode(&px8888);
    let tex2 = ui.upload_texture_flags(&enc, 2, 2, spec::psm::PSM_8888, spec::img::FLAG_RLE);
    assert!(tex2 >= 0);
    let view2 = ui.texture(tex2).unwrap();
    assert_eq!(view2.pixels, &px8888[..]);
    assert!(view2.palette.is_none() && !view2.linear);
}

#[test]
fn img_entry_uploads_v1_and_v2_blobs_and_rejects_malformed() {
    let mut ui = Ui::new();
    // v2 T8 entry: header (w, h, psm, flags, reserved) + palette + RLE stream.
    let mut blob = Vec::new();
    blob.extend_from_slice(&4u16.to_le_bytes());
    blob.extend_from_slice(&4u16.to_le_bytes());
    blob.push(spec::psm::PSM_T8 as u8);
    blob.push(spec::img::FLAG_RLE);
    blob.extend_from_slice(&[0, 0]); // reserved
    blob.extend_from_slice(&[0u8; 1024]); // palette (never compressed)
    blob.extend_from_slice(&[142, 3]); // run of 16 x index 3
    let tex = ui.upload_img_entry(&blob);
    assert!(tex >= 0);
    let view = ui.texture(tex).unwrap();
    assert_eq!((view.w, view.h, view.psm), (4, 4, spec::psm::PSM_T8));
    assert_eq!(view.pixels, &[3u8; 16][..]);
    assert!(!view.linear);
    // v1 8888 entry (flags byte was reserved/0) still decodes identically.
    let mut v1 = Vec::new();
    v1.extend_from_slice(&2u16.to_le_bytes());
    v1.extend_from_slice(&2u16.to_le_bytes());
    v1.push(spec::psm::PSM_8888 as u8);
    v1.push(0);
    v1.extend_from_slice(&[0, 0]);
    v1.extend_from_slice(&[0xcdu8; 16]);
    let tex1 = ui.upload_img_entry(&v1);
    assert!(tex1 >= 0);
    assert_eq!(ui.texture(tex1).unwrap().pixels, &[0xcdu8; 16][..]);
    // Malformed: short header, truncated payload, bogus psm.
    assert_eq!(ui.upload_img_entry(&v1[..7]), -1);
    assert_eq!(ui.upload_img_entry(&v1[..20]), -1);
    let mut bad = v1.clone();
    bad[4] = 99;
    assert_eq!(ui.upload_img_entry(&bad), -1);
}

/// Build a tiny 2x2-tile TILESET blob (4x4 CLUT8 tiles, RLE + linear):
/// tile 0 = stream of index 5, tile 1 = ABSENT, tile 2 = SOLID(index 9),
/// tile 3 = stream of index 6.
fn tiny_tileset() -> Vec<u8> {
    use spec::tileset as ts;
    let mut blob = Vec::new();
    blob.extend_from_slice(&ts::MAGIC.to_le_bytes());
    blob.extend_from_slice(&ts::VERSION.to_le_bytes());
    blob.extend_from_slice(&(ts::FLAG_RLE | ts::FLAG_LINEAR).to_le_bytes());
    blob.extend_from_slice(&4u16.to_le_bytes()); // tileW
    blob.extend_from_slice(&4u16.to_le_bytes()); // tileH
    blob.extend_from_slice(&2u16.to_le_bytes()); // cols
    blob.extend_from_slice(&2u16.to_le_bytes()); // rows
    let palette_off = ts::HEADER_SIZE as u32;
    let dir_off = palette_off + 1024;
    let data_off = dir_off + 4 * ts::DIR_ENTRY_SIZE as u32;
    blob.extend_from_slice(&palette_off.to_le_bytes());
    blob.extend_from_slice(&dir_off.to_le_bytes());
    blob.extend_from_slice(&data_off.to_le_bytes());
    blob.extend_from_slice(&0u32.to_le_bytes()); // reserved
    assert_eq!(blob.len(), ts::HEADER_SIZE);
    let mut palette = [0u8; 1024];
    palette[5 * 4] = 0xaa; // distinctive red channel at index 5
    blob.extend_from_slice(&palette);
    for (off, len) in [(0u32, 2u32), (ts::ABSENT, 0), (9, 0), (2, 2)] {
        blob.extend_from_slice(&off.to_le_bytes());
        blob.extend_from_slice(&len.to_le_bytes());
    }
    blob.extend_from_slice(&[142, 5, 142, 6]); // two RLE streams: 16 x 5, 16 x 6
    blob
}

#[test]
fn tileset_tile_materializes_pixel_stream_tiles_only() {
    let mut ui = Ui::new();
    let blob = tiny_tileset();
    let t0 = ui.upload_tileset_tile(&blob, 0);
    assert!(t0 >= 0);
    let view = ui.texture(t0).unwrap();
    assert_eq!((view.w, view.h, view.psm), (4, 4, spec::psm::PSM_T8));
    assert!(view.linear, "tileset flags bit 1 maps to bilinear sampling");
    assert_eq!(view.pixels, &[5u8; 16][..]);
    assert_eq!(view.palette.unwrap()[5 * 4], 0xaa, "shared entry palette rides along");
    // ABSENT and SOLID tiles are the host's job (drawn as background/RECTs).
    assert_eq!(ui.upload_tileset_tile(&blob, 1), -1);
    assert_eq!(ui.upload_tileset_tile(&blob, 2), -1);
    let t3 = ui.upload_tileset_tile(&blob, 3);
    assert_eq!(ui.texture(t3).unwrap().pixels, &[6u8; 16][..]);
    assert_ne!(t0, t3, "each tile is its own slot");
}

#[test]
fn tileset_tile_rejects_malformed_blobs_without_panicking() {
    use spec::tileset as ts;
    let mut ui = Ui::new();
    let blob = tiny_tileset();
    assert_eq!(ui.upload_tileset_tile(&blob, 4), -1, "index out of range");
    assert_eq!(ui.upload_tileset_tile(&blob, u32::MAX), -1);
    assert_eq!(ui.upload_tileset_tile(&blob[..blob.len() - 1], 3), -1, "truncated stream");
    assert_eq!(ui.upload_tileset_tile(&blob[..ts::HEADER_SIZE], 0), -1, "header only");
    assert_eq!(ui.upload_tileset_tile(&[], 0), -1);
    let mut bad_magic = blob.clone();
    bad_magic[0] ^= 0xff;
    assert_eq!(ui.upload_tileset_tile(&bad_magic, 0), -1);
    let mut bad_version = blob.clone();
    bad_version[4] = 99;
    assert_eq!(ui.upload_tileset_tile(&bad_version, 0), -1);
    // Hostile offsets must be caught by bounds checks, not wrap/panic.
    let mut bad_pal = blob.clone();
    bad_pal[16..20].copy_from_slice(&u32::MAX.to_le_bytes()); // paletteOff
    assert_eq!(ui.upload_tileset_tile(&bad_pal, 0), -1);
    let mut bad_dir = blob.clone();
    bad_dir[20..24].copy_from_slice(&u32::MAX.to_le_bytes()); // dirOff
    assert_eq!(ui.upload_tileset_tile(&bad_dir, 0), -1);
    let mut bad_data = blob.clone();
    bad_data[24..28].copy_from_slice(&u32::MAX.to_le_bytes()); // dataOff
    assert_eq!(ui.upload_tileset_tile(&bad_data, 0), -1);
}

#[test]
fn freed_handles_go_stale_and_slots_reuse_under_a_new_generation() {
    let mut ui = Ui::new();
    let px = alloc::vec![0xffu8; 8 * 8 * 4];
    let a = ui.upload_texture(&px, 8, 8, spec::psm::PSM_8888);
    let b = ui.upload_texture(&px, 8, 8, spec::psm::PSM_8888);
    assert_eq!((a, b), (0, 1), "sequential uploads keep the old 0-based numbering");
    ui.free_texture(a);
    assert!(ui.texture(a).is_none(), "freed handle resolves to None");
    ui.free_texture(a); // double free: silent no-op
    assert!(ui.texture(b).is_some(), "other slots unaffected");
    // LIFO reuse of slot 0 under generation 1 -> a DIFFERENT handle.
    let c = ui.upload_texture(&px, 8, 8, spec::psm::PSM_8888);
    assert_ne!(c, a, "reused slot must not resurrect the old handle");
    assert!(c > 0, "handles stay positive (bit 31 clear)");
    assert_eq!(c as u32 & spec::TEX_SLOT_MASK, 0, "slot 0 reused LIFO");
    assert_eq!(c as u32 >> spec::TEX_SLOT_BITS, 1, "generation bumped");
    assert!(ui.texture(a).is_none(), "the stale handle stays dead after reuse");
    assert!(ui.texture(c).is_some());
    // set_image ignores the stale handle but honors the live one.
    let img = ui.create_node(spec::NodeType::Image as u8);
    ui.set_image(img, a);
    ui.set_image(img, c);
    // The wgpu sync walk sees live slots under their CURRENT handles.
    assert_eq!(ui.texture_slot_count(), 2);
    let (h0, _) = ui.texture_at(0).unwrap();
    assert_eq!(h0, c);
    let (h1, _) = ui.texture_at(1).unwrap();
    assert_eq!(h1, b);
    ui.free_texture(c);
    assert!(ui.texture_at(0).is_none(), "free slots are skipped by the walk");
    assert_eq!(ui.texture_slot_count(), 2, "slot storage never shrinks");
    assert!(ui.texture_at(2).is_none());
}

#[test]
fn disc_cache_survives_js_freeing_its_texture() {
    let mut ui = Ui::new();
    let n = ui.create_node(0);
    ui.set_prop(n, spec::prop::WIDTH, 36.0);
    ui.set_prop(n, spec::prop::HEIGHT, 20.0);
    ui.set_prop(n, spec::prop::RADIUS, 8.0);
    ui.set_prop(n, spec::prop::BG_COLOR, abgr(255, 0, 0, 255) as f64);
    ui.insert_before(spec::ROOT_ID, n, 0);
    ui.tick();
    let find_disc = |words: &[u32]| -> i32 {
        let i = words.iter().position(|&w| w == spec::draw_op::TEX_QUAD).unwrap();
        words[i + 1] as i32
    };
    let disc = find_disc(&ui.draw().words.clone());
    assert!(ui.texture(disc).is_some(), "corner disc is a live texture");
    // JS misuse: freeTexture on the internal disc slot. Must not panic; the
    // next draw re-validates, re-bakes, and emits a live handle again.
    ui.free_texture(disc);
    let disc2 = find_disc(&ui.draw().words.clone());
    assert_ne!(disc2, disc, "rebaked disc lives under a new generation");
    assert!(ui.texture(disc2).is_some());
    assert!(ui.texture(disc).is_none());
    // Steady state: the rebaked handle is reused, not rebaked per frame.
    assert_eq!(find_disc(&ui.draw().words.clone()), disc2);
    assert_eq!(ui.texture_slot_count(), 1, "the freed slot was reused LIFO");
}

// ---- virtual cursor (spec ops 27..29) -----------------------------------------

/// A detached-from-flow PAINTED box at (x, y) sized w x h under `parent`
/// (hit tests only consider nodes that paint — see draw::claims_hit).
fn abs_box(ui: &mut Ui, parent: i32, x: f64, y: f64, w: f64, h: f64) -> i32 {
    let n = ui.create_node(0);
    ui.set_prop(n, spec::prop::POS_TYPE, spec::PosType::Absolute as u32 as f64);
    ui.set_prop(n, spec::prop::INSET_L, x);
    ui.set_prop(n, spec::prop::INSET_T, y);
    ui.set_prop(n, spec::prop::WIDTH, w);
    ui.set_prop(n, spec::prop::HEIGHT, h);
    ui.set_prop(n, spec::prop::BG_COLOR, abgr(40, 40, 40, 255) as f64);
    ui.insert_before(parent, n, 0);
    n
}

#[test]
fn hit_test_topmost_wins_and_containers_pass_through() {
    let mut ui = Ui::new();
    let panel = abs_box(&mut ui, spec::ROOT_ID, 10.0, 10.0, 100.0, 50.0);
    let inner = abs_box(&mut ui, panel, 5.0, 5.0, 20.0, 20.0);
    ui.tick();
    // Inside the child: the deepest painted node wins over its ancestors.
    assert_eq!(ui.hit_test(20.0, 20.0), inner);
    // Inside the panel but not the child.
    assert_eq!(ui.hit_test(90.0, 40.0), panel);
    // The unstyled root paints nothing: empty space hits NOTHING — pure
    // layout containers (e.g. the framework's full-screen overlay layer)
    // are hit-transparent even though their box contains the point.
    assert_eq!(ui.hit_test(400.0, 200.0), 0);
    // A transparent full-screen wrapper OVER the panel does not occlude it,
    // but its own painted children do.
    let wrapper = ui.create_node(0);
    ui.set_prop(wrapper, spec::prop::POS_TYPE, spec::PosType::Absolute as u32 as f64);
    ui.set_prop(wrapper, spec::prop::INSET_L, 0.0);
    ui.set_prop(wrapper, spec::prop::INSET_T, 0.0);
    ui.set_prop(wrapper, spec::prop::WIDTH, 480.0);
    ui.set_prop(wrapper, spec::prop::HEIGHT, 272.0);
    ui.insert_before(spec::ROOT_ID, wrapper, 0);
    ui.tick();
    assert_eq!(ui.hit_test(90.0, 40.0), panel, "overlay layer passes hits through");
    let toast = abs_box(&mut ui, wrapper, 80.0, 30.0, 40.0, 20.0);
    assert_eq!(ui.hit_test(90.0, 40.0), toast, "painted overlay content claims");
    // Outside the viewport (half-open edges): nothing.
    assert_eq!(ui.hit_test(480.0, 100.0), 0);
    assert_eq!(ui.hit_test(-1.0, 100.0), 0);
    // Layout need not be ticked first: hit_test relayouts a dirty tree.
    let fresh = abs_box(&mut ui, spec::ROOT_ID, 300.0, 100.0, 10.0, 10.0);
    assert_eq!(ui.hit_test(305.0, 105.0), fresh);
}

#[test]
fn hit_test_paint_order_and_z_index() {
    let mut ui = Ui::new();
    // Two overlapping siblings: the later one paints on top.
    let below = abs_box(&mut ui, spec::ROOT_ID, 10.0, 10.0, 40.0, 40.0);
    let above = abs_box(&mut ui, spec::ROOT_ID, 30.0, 10.0, 40.0, 40.0);
    ui.tick();
    assert_eq!(ui.hit_test(35.0, 20.0), above, "document order: later sibling on top");
    assert_eq!(ui.hit_test(15.0, 20.0), below, "non-overlapped area still hits the first");
    // z-index beats document order (mirrors the paint sort).
    ui.set_prop(below, spec::prop::Z_INDEX, 5.0);
    assert_eq!(ui.hit_test(35.0, 20.0), below, "z-index raises the earlier sibling");
}

#[test]
fn hit_test_display_none_overflow_and_transforms() {
    let mut ui = Ui::new();
    let clipper = abs_box(&mut ui, spec::ROOT_ID, 10.0, 10.0, 30.0, 30.0);
    ui.set_prop(clipper, spec::prop::OVERFLOW, spec::Overflow::Hidden as u32 as f64);
    let wide = abs_box(&mut ui, clipper, 0.0, 0.0, 200.0, 20.0);
    ui.tick();
    assert_eq!(ui.hit_test(20.0, 15.0), wide, "inside the clip the child hits");
    assert_eq!(
        ui.hit_test(100.0, 15.0),
        0,
        "outside the overflow-hidden box the child's box is clipped away"
    );
    // display:none removes the whole subtree from hit testing.
    ui.set_prop(clipper, spec::prop::DISPLAY, spec::Display::None as u32 as f64);
    assert_eq!(ui.hit_test(20.0, 15.0), 0);
    ui.set_prop(clipper, spec::prop::DISPLAY, spec::Display::Flex as u32 as f64);
    // Translate moves the hit box with the paint box.
    let mover = abs_box(&mut ui, spec::ROOT_ID, 100.0, 100.0, 20.0, 20.0);
    ui.set_prop(mover, spec::prop::TRANSLATE_X, 50.0);
    ui.tick();
    assert_eq!(ui.hit_test(110.0, 110.0), 0, "old spot is empty");
    assert_eq!(ui.hit_test(160.0, 110.0), mover, "translated spot hits");
    // A 45-degree rotation rejects the now-outside corner but keeps the center.
    ui.set_prop(mover, spec::prop::ROTATE, 45.0);
    assert_eq!(ui.hit_test(160.0, 110.0), mover, "center survives rotation");
    assert_eq!(ui.hit_test(151.5, 101.5), 0, "corner rotated away");
    // Effective opacity 0 is culled exactly like paint culls it (a faded-out
    // toast must not eat hits); partial transparency still claims.
    let ghost = abs_box(&mut ui, spec::ROOT_ID, 200.0, 200.0, 20.0, 20.0);
    let ghost_child = abs_box(&mut ui, ghost, 0.0, 0.0, 20.0, 20.0);
    ui.set_prop(ghost, spec::prop::OPACITY, 0.0);
    ui.tick();
    assert_eq!(ui.hit_test(210.0, 210.0), 0, "invisible subtree hits nothing");
    ui.set_prop(ghost, spec::prop::OPACITY, 0.5);
    assert_eq!(ui.hit_test(210.0, 210.0), ghost_child, "faded still claims");
}

#[test]
fn hit_test_variant_styled_hotspots_and_perspective_roots_claim() {
    let mut ui = Ui::new();
    // A record whose BASE paints nothing but whose focus: variant does — the
    // hotspot must be reachable BEFORE it is hovered, with no hysteresis.
    let mut hotspot_style = StyleSpec::new();
    hotspot_style.focus = alloc::vec![(spec::prop::BG_COLOR, abgr(255, 255, 255, 32))];
    let mut plain_style = StyleSpec::new();
    plain_style.base = alloc::vec![(spec::prop::WIDTH, 10f32.to_bits())];
    assert!(ui.load_styles(&encode_styles(&[hotspot_style, plain_style])));
    let hotspot = ui.create_node(0);
    ui.set_prop(hotspot, spec::prop::POS_TYPE, spec::PosType::Absolute as u32 as f64);
    ui.set_prop(hotspot, spec::prop::INSET_L, 30.0);
    ui.set_prop(hotspot, spec::prop::INSET_T, 30.0);
    ui.set_prop(hotspot, spec::prop::WIDTH, 40.0);
    ui.set_prop(hotspot, spec::prop::HEIGHT, 40.0);
    ui.set_style(hotspot, 0);
    ui.insert_before(spec::ROOT_ID, hotspot, 0);
    ui.tick();
    assert_eq!(ui.hit_test(40.0, 40.0), hotspot, "focus:-styled hotspot claims unfocused");
    // A plain-styled unpainted box still passes through (record present, but
    // no paint in any variant).
    let wrapper = ui.create_node(0);
    ui.set_prop(wrapper, spec::prop::POS_TYPE, spec::PosType::Absolute as u32 as f64);
    ui.set_prop(wrapper, spec::prop::INSET_L, 30.0);
    ui.set_prop(wrapper, spec::prop::INSET_T, 30.0);
    ui.set_prop(wrapper, spec::prop::WIDTH, 40.0);
    ui.set_prop(wrapper, spec::prop::HEIGHT, 40.0);
    ui.set_style(wrapper, 1);
    ui.insert_before(spec::ROOT_ID, wrapper, 0);
    ui.tick();
    assert_eq!(ui.hit_test(40.0, 40.0), hotspot, "styled-but-unpainted wrapper passes through");
    // A perspective context root claims its own box: a click on visible 3D
    // content must never fall through to what is painted behind it.
    let stage = abs_box(&mut ui, spec::ROOT_ID, 100.0, 100.0, 60.0, 60.0);
    ui.set_prop(stage, spec::prop::PERSPECTIVE, 300.0);
    let card = abs_box(&mut ui, stage, 10.0, 10.0, 40.0, 40.0);
    ui.tick();
    let _ = card;
    assert_eq!(ui.hit_test(130.0, 130.0), stage, "3D context root claims, children untestable");
}

#[test]
fn cursor_sprite_draws_last_hides_and_survives_free() {
    let mut ui = Ui::new();
    let n = abs_box(&mut ui, spec::ROOT_ID, 0.0, 0.0, 100.0, 100.0);
    ui.set_prop(n, spec::prop::BG_COLOR, abgr(20, 20, 20, 255) as f64);
    let tex = ui.upload_texture(&[0xffu8; 8 * 8 * 4], 8, 8, spec::psm::PSM_8888);
    assert!(tex >= 0);
    ui.tick();

    // No cursor bound: no TEX_QUAD at all.
    let words = ui.draw().words.clone();
    assert_eq!(validate_drawlist(&words)[spec::draw_op::TEX_QUAD as usize], 0);

    // Bound: exactly one TEX_QUAD, as the LAST op, offset by the hotspot.
    ui.set_cursor(tex, 2.0, 3.0, 0.0, 0.0);
    ui.set_cursor_pos(100.0, 50.0);
    let words = ui.draw().words.clone();
    assert_eq!(validate_drawlist(&words)[spec::draw_op::TEX_QUAD as usize], 1);
    let i = words.iter().position(|&w| w == spec::draw_op::TEX_QUAD).unwrap();
    assert_eq!(i + 9, words.len(), "cursor is the final DrawList entry");
    assert_eq!(words[i + 1], tex as u32);
    assert_eq!(decode_xy(words[i + 2]), (98, 47), "hotspot offsets the sprite");
    assert_eq!(decode_wh(words[i + 3]), (8, 8), "size defaults to the texture");

    // Explicit logical size overrides the texture dimensions.
    ui.set_cursor(tex, 0.0, 0.0, 16.0, 12.0);
    let words = ui.draw().words.clone();
    let i = words.iter().position(|&w| w == spec::draw_op::TEX_QUAD).unwrap();
    assert_eq!(decode_wh(words[i + 3]), (16, 12));

    // The viewport edge clips the sprite instead of wrapping i16 coords.
    ui.set_cursor_pos(476.0, 268.0);
    let words = ui.draw().words.clone();
    let i = words.iter().position(|&w| w == spec::draw_op::TEX_QUAD).unwrap();
    assert_eq!(decode_wh(words[i + 3]), (4, 4), "clipped at the screen edge");

    // Freeing the bound texture hides the cursor (stale handles draw nothing).
    ui.free_texture(tex);
    let words = ui.draw().words.clone();
    assert_eq!(validate_drawlist(&words)[spec::draw_op::TEX_QUAD as usize], 0);

    // Unbinding via tex < 0 also hides it.
    let tex2 = ui.upload_texture(&[0x80u8; 8 * 8 * 4], 8, 8, spec::psm::PSM_8888);
    ui.set_cursor(tex2, 0.0, 0.0, 0.0, 0.0);
    ui.set_cursor(-1, 0.0, 0.0, 0.0, 0.0);
    let words = ui.draw().words.clone();
    assert_eq!(validate_drawlist(&words)[spec::draw_op::TEX_QUAD as usize], 0);
}

#[test]
fn hit_test_never_sees_the_cursor_sprite() {
    let mut ui = Ui::new();
    let under = abs_box(&mut ui, spec::ROOT_ID, 50.0, 50.0, 30.0, 30.0);
    let tex = ui.upload_texture(&[0xffu8; 8 * 8 * 4], 8, 8, spec::psm::PSM_8888);
    ui.set_cursor(tex, 0.0, 0.0, 0.0, 0.0);
    ui.set_cursor_pos(60.0, 60.0);
    ui.tick();
    ui.draw();
    assert_eq!(ui.hit_test(60.0, 60.0), under, "the sprite never occludes the tree");
}

#[test]
fn hit_test_frame_edge_overlay_claims_only_its_band() {
    let mut ui = Ui::new();
    // A pressable row under an inset-0 bevel-ring frame overlay painted
    // LAST (the classic-chrome window edge): the overlay claims its 2px
    // edge band and nothing else.
    let row = abs_box(&mut ui, spec::ROOT_ID, 20.0, 20.0, 100.0, 20.0);
    let edge = ui.create_node(0);
    ui.set_prop(edge, spec::prop::POS_TYPE, spec::PosType::Absolute as u32 as f64);
    ui.set_prop(edge, spec::prop::INSET_L, 0.0);
    ui.set_prop(edge, spec::prop::INSET_T, 0.0);
    ui.set_prop(edge, spec::prop::WIDTH, 480.0);
    ui.set_prop(edge, spec::prop::HEIGHT, 272.0);
    ui.set_prop(edge, spec::prop::BEVEL_OUTER_LIGHT, abgr(255, 255, 255, 255) as f64);
    ui.set_prop(edge, spec::prop::BEVEL_OUTER_DARK, abgr(0, 0, 0, 255) as f64);
    ui.insert_before(spec::ROOT_ID, edge, 0);
    ui.tick();
    assert_eq!(ui.hit_test(50.0, 30.0), row, "the overlay's transparent center passes through");
    assert_eq!(ui.hit_test(1.0, 100.0), edge, "the painted ring band claims");
    assert_eq!(ui.hit_test(479.0, 100.0), edge, "right band too");
    // A border-only well behaves the same: band claims, interior passes.
    let well = ui.create_node(0);
    ui.set_prop(well, spec::prop::POS_TYPE, spec::PosType::Absolute as u32 as f64);
    ui.set_prop(well, spec::prop::INSET_L, 20.0);
    ui.set_prop(well, spec::prop::INSET_T, 15.0);
    ui.set_prop(well, spec::prop::WIDTH, 200.0);
    ui.set_prop(well, spec::prop::HEIGHT, 40.0);
    ui.set_prop(well, spec::prop::BORDER_COLOR, abgr(0, 0, 0, 255) as f64);
    ui.set_prop(well, spec::prop::BORDER_WIDTH, 3.0);
    ui.insert_before(spec::ROOT_ID, well, 0);
    ui.tick();
    assert_eq!(ui.hit_test(21.0, 30.0), well, "border band claims");
    assert_eq!(ui.hit_test(50.0, 30.0), row, "border interior passes through");
}

// ---- STREAM container (.pkst) — stream.rs readers + the video plane ---------

/// Hand-assemble a valid 96-byte header block (spec.ts "STREAM container").
#[allow(clippy::too_many_arguments)]
fn stream_header_block(
    epoch: u32,
    flags: u16,
    w: u16,
    h: u16,
    slot_count: u32,
    v_latest: u32,
    chunk_frames: u32,
    chunk_count: u32,
    a_latest: u32,
) -> Vec<u8> {
    let slot_size =
        (spec::stream::SLOT_HEADER_SIZE as u32 + 1024 + w as u32 * h as u32).next_multiple_of(16);
    let mut b = alloc::vec![0u8; spec::stream::HEADER_BLOCK_SIZE];
    b[0..4].copy_from_slice(&spec::stream::MAGIC.to_le_bytes());
    b[4..6].copy_from_slice(&spec::stream::VERSION.to_le_bytes());
    b[6..8].copy_from_slice(&flags.to_le_bytes());
    b[8..12].copy_from_slice(&epoch.to_le_bytes());
    b[12..16].copy_from_slice(&(spec::stream::HEADER_BLOCK_SIZE as u32).to_le_bytes());
    let audio_off = spec::stream::HEADER_BLOCK_SIZE as u32 + slot_count * slot_size;
    b[16..20].copy_from_slice(&audio_off.to_le_bytes());
    let v = spec::stream::VRING_OFF;
    b[v..v + 4].copy_from_slice(&spec::stream::VRING_MAGIC.to_le_bytes());
    b[v + 4..v + 6].copy_from_slice(&w.to_le_bytes());
    b[v + 6..v + 8].copy_from_slice(&h.to_le_bytes());
    b[v + 8..v + 10].copy_from_slice(&15u16.to_le_bytes());
    b[v + 10..v + 12].copy_from_slice(&1u16.to_le_bytes());
    b[v + 12..v + 16].copy_from_slice(&slot_count.to_le_bytes());
    b[v + 16..v + 20].copy_from_slice(&slot_size.to_le_bytes());
    b[v + 20..v + 24].copy_from_slice(&v_latest.to_le_bytes());
    b[v + 24..v + 28].copy_from_slice(&900u32.to_le_bytes());
    let a = spec::stream::ARING_OFF;
    b[a..a + 4].copy_from_slice(&spec::stream::ARING_MAGIC.to_le_bytes());
    b[a + 4..a + 8].copy_from_slice(&22050u32.to_le_bytes());
    b[a + 8..a + 10].copy_from_slice(&2u16.to_le_bytes());
    b[a + 12..a + 16].copy_from_slice(&chunk_frames.to_le_bytes());
    b[a + 16..a + 20].copy_from_slice(&chunk_count.to_le_bytes());
    b[a + 20..a + 24].copy_from_slice(&a_latest.to_le_bytes());
    b
}

#[test]
fn stream_header_block_round_trips() {
    let b = stream_header_block(3, spec::stream::FLAG_ENDED, 256, 128, 8, 42, 2048, 64, 17);
    let h = crate::stream::parse_header_block(&b).expect("valid header block");
    assert_eq!(h.epoch, 3);
    assert!(h.ended);
    assert_eq!((h.video.w, h.video.h), (256, 128));
    assert_eq!((h.video.fps_num, h.video.fps_den), (15, 1));
    assert_eq!((h.video.slot_count, h.video.latest_seq), (8, 42));
    assert_eq!(h.video.total_frames, 900);
    assert_eq!(h.video.slot_size, (32 + 1024 + 256 * 128u32).next_multiple_of(16));
    assert_eq!((h.audio.sample_rate, h.audio.channels), (22050, 2));
    assert_eq!((h.audio.chunk_frames, h.audio.chunk_count, h.audio.latest_seq), (2048, 64, 17));
    // Ring offsets: seq 1 sits at the ring base; seqs wrap modulo the count.
    assert_eq!(crate::stream::slot_offset(&h, 1), Some(h.video_off));
    assert_eq!(crate::stream::slot_offset(&h, 9), Some(h.video_off));
    assert_eq!(crate::stream::slot_offset(&h, 2), Some(h.video_off + h.video.slot_size));
    assert_eq!(crate::stream::slot_offset(&h, 0), None, "seqs start at 1");
    let chunk = crate::stream::chunk_size(2048, 2).unwrap();
    assert_eq!(chunk, 16 + 2048 * 2 * 2);
    assert_eq!(crate::stream::chunk_offset(&h, 65), Some(h.audio_off));
}

#[test]
fn stream_header_block_refuses_malformed() {
    use crate::stream::parse_header_block;
    let ok = stream_header_block(0, 0, 256, 128, 8, 0, 2048, 64, 0);
    assert!(parse_header_block(&ok).is_some());
    assert!(parse_header_block(&ok[..95]).is_none(), "short block");
    let mut bad = ok.clone();
    bad[0] = 0; // stream magic
    assert!(parse_header_block(&bad).is_none());
    let mut bad = ok.clone();
    bad[4] = 99; // version
    assert!(parse_header_block(&bad).is_none());
    let mut bad = ok.clone();
    bad[spec::stream::VRING_OFF] = 0; // vring magic
    assert!(parse_header_block(&bad).is_none());
    let mut bad = ok.clone();
    bad[spec::stream::ARING_OFF] = 0; // aring magic
    assert!(parse_header_block(&bad).is_none());
    // Non-pow2 plane (240 wide) — the plane texture must be uploadable.
    assert!(parse_header_block(&stream_header_block(0, 0, 240, 128, 8, 0, 2048, 64, 0)).is_none());
    // A slot too small to carry palette + w*h pixels.
    let mut bad = ok.clone();
    let v = spec::stream::VRING_OFF;
    bad[v + 16..v + 20].copy_from_slice(&64u32.to_le_bytes());
    assert!(parse_header_block(&bad).is_none());
    // Zero rings / bad PCM shapes.
    assert!(parse_header_block(&stream_header_block(0, 0, 256, 128, 0, 0, 2048, 64, 0)).is_none());
    assert!(parse_header_block(&stream_header_block(0, 0, 256, 128, 8, 0, 0, 64, 0)).is_none());
    let mut bad = ok.clone();
    let a = spec::stream::ARING_OFF;
    bad[a + 8..a + 10].copy_from_slice(&3u16.to_le_bytes()); // channels
    assert!(parse_header_block(&bad).is_none());
    // Ring larger than a u32 file offset can address.
    let mut bad = ok;
    bad[v + 12..v + 16].copy_from_slice(&u32::MAX.to_le_bytes());
    assert!(parse_header_block(&bad).is_none());
}

#[test]
fn stream_slot_and_chunk_headers_validate() {
    let b = stream_header_block(0, 0, 256, 128, 8, 1, 2048, 64, 1);
    let h = crate::stream::parse_header_block(&b).unwrap();
    let mut slot = alloc::vec![0u8; spec::stream::SLOT_HEADER_SIZE];
    slot[0..4].copy_from_slice(&7u32.to_le_bytes());
    slot[4..8].copy_from_slice(&123u32.to_le_bytes());
    slot[8..10].copy_from_slice(&256u16.to_le_bytes());
    slot[10..12].copy_from_slice(&128u16.to_le_bytes());
    let sh = crate::stream::parse_slot_header(&slot, &h.video).expect("valid slot");
    assert_eq!((sh.seq, sh.frame_index, sh.w, sh.h), (7, 123, 256, 128));
    // Dim disagreement with the ring header = torn/malformed, refuse.
    slot[8..10].copy_from_slice(&64u16.to_le_bytes());
    assert!(crate::stream::parse_slot_header(&slot, &h.video).is_none());
    slot[8..10].copy_from_slice(&256u16.to_le_bytes()); // dims valid again…
    slot[0..4].copy_from_slice(&0u32.to_le_bytes()); // …but seq 0 = never written
    assert!(crate::stream::parse_slot_header(&slot, &h.video).is_none());

    let mut chunk = alloc::vec![0u8; spec::stream::CHUNK_HEADER_SIZE];
    chunk[0..4].copy_from_slice(&5u32.to_le_bytes());
    chunk[4..8].copy_from_slice(&40960u32.to_le_bytes());
    let ch = crate::stream::parse_chunk_header(&chunk).expect("valid chunk");
    assert_eq!((ch.seq, ch.start_frame), (5, 40960));
    chunk[0..4].copy_from_slice(&0u32.to_le_bytes());
    assert!(crate::stream::parse_chunk_header(&chunk).is_none(), "seq 0 = never written");
    assert!(crate::stream::parse_chunk_header(&chunk[..8]).is_none(), "short header");
}

#[test]
fn update_texture_t8_overwrites_in_place() {
    let mut ui = Ui::new();
    // 4x4 T8 plane: palette entry 1 = red, all pixels index 1.
    let mut data = alloc::vec![0u8; 1024 + 16];
    data[4..8].copy_from_slice(&abgr(255, 0, 0, 255).to_le_bytes());
    data[1024..].fill(1);
    let plane = ui.upload_texture(&data, 4, 4, spec::psm::PSM_T8);
    assert!(plane >= 0);
    assert_eq!(ui.texture_revision(plane), Some(0));

    // Overwrite with palette entry 1 = green, pixels still index 1.
    let mut pal = alloc::vec![0u8; 1024];
    pal[4..8].copy_from_slice(&abgr(0, 255, 0, 255).to_le_bytes());
    let px = alloc::vec![1u8; 16];
    assert!(ui.update_texture_t8(plane, &pal, &px));
    let view = ui.texture(plane).expect("plane still live");
    assert_eq!(view.palette.unwrap()[4..8], abgr(0, 255, 0, 255).to_le_bytes());
    assert_eq!(view.pixels, &px[..]);
    assert_eq!(ui.texture_revision(plane), Some(1));

    // Size/format/liveness misuse changes nothing and reports false.
    assert!(!ui.update_texture_t8(plane, &pal[..100], &px), "short palette");
    assert!(!ui.update_texture_t8(plane, &pal, &px[..8]), "wrong pixel count");
    assert_eq!(ui.texture_revision(plane), Some(1));
    let rgba = ui.upload_texture(&[0u8; 4 * 4 * 4], 4, 4, spec::psm::PSM_8888);
    assert!(!ui.update_texture_t8(rgba, &pal, &px), "non-T8 texture");
    ui.free_texture(plane);
    assert!(!ui.update_texture_t8(plane, &pal, &px), "stale handle");
}

/// Cross-language contract: the committed .pkst golden is WRITTEN by the TS
/// stream writer (now in pocket-stack/pocket-youtube, host/ring.ts;
/// regenerated there by UPDATE=1 bun test tests/host.test.ts and copied here)
/// and PARSED by this crate — if either side's byte layout drifts, one of
/// the two suites breaks. The fixture is frozen alongside the spec.
#[test]
fn stream_golden_fixture_parses() {
    let bytes: &[u8] = include_bytes!("../../../tests/fixtures/youtube-golden.pkst");
    let h = crate::stream::parse_header_block(bytes).expect("TS-written header parses");
    assert_eq!(h.epoch, 0);
    assert!(!h.ended);
    assert_eq!((h.video.w, h.video.h), (16, 16));
    assert_eq!((h.video.fps_num, h.video.fps_den), (15, 1));
    assert_eq!((h.video.slot_count, h.video.latest_seq, h.video.total_frames), (4, 2, 30));
    assert_eq!((h.audio.sample_rate, h.audio.channels), (22050, 2));
    assert_eq!((h.audio.chunk_frames, h.audio.chunk_count, h.audio.latest_seq), (64, 4, 1));

    // Frame 2 (seq 2): palette bytes are (i + 2) & 255, indices (i * 3) & 255.
    let off = crate::stream::slot_offset(&h, 2).unwrap() as usize;
    let slot = &bytes[off..off + h.video.slot_size as usize];
    let sh = crate::stream::parse_slot_header(slot, &h.video).expect("slot 2 parses");
    assert_eq!((sh.seq, sh.frame_index), (2, 1));
    let pal = &slot[spec::stream::SLOT_HEADER_SIZE..spec::stream::SLOT_HEADER_SIZE + 1024];
    assert!(pal.iter().enumerate().all(|(i, &b)| b == ((i + 2) & 255) as u8));
    let px = &slot[spec::stream::SLOT_HEADER_SIZE + 1024..spec::stream::SLOT_HEADER_SIZE + 1024 + 256];
    assert!(px.iter().enumerate().all(|(i, &b)| b == ((i * 3) & 255) as u8));

    // Audio chunk 1: s16 LE samples i * 3 - 64.
    let coff = crate::stream::chunk_offset(&h, 1).unwrap() as usize;
    let chunk = &bytes[coff..];
    let ch = crate::stream::parse_chunk_header(chunk).expect("chunk 1 parses");
    assert_eq!((ch.seq, ch.start_frame), (1, 0));
    let pcm = &chunk[spec::stream::CHUNK_HEADER_SIZE..];
    for i in 0..(64 * 2usize) {
        let v = i16::from_le_bytes([pcm[i * 2], pcm[i * 2 + 1]]);
        assert_eq!(v as i32, i as i32 * 3 - 64);
    }

    // And the frame is presentable: a fresh core accepts it as a plane update.
    let mut ui = Ui::new();
    let mut init = alloc::vec![0u8; 1024 + 256];
    init[3] = 0xff;
    let plane = ui.upload_texture(&init, 16, 16, spec::psm::PSM_T8);
    assert!(ui.update_texture_t8(plane, pal, px));
}

// ---- SVC WIRE (PKNT) — wire.rs codec + stream_rx.rs RAM ring ---------------

#[test]
fn wire_frame_header_round_trips_and_rejects_oversize() {
    use crate::wire::{encode_frame_header, parse_frame_header};
    let mut out = [0u8; 8];
    assert!(encode_frame_header(spec::wire::MSG_VIDEO_SLOT, 1, 1040, &mut out));
    let h = parse_frame_header(&out).expect("round trip");
    assert_eq!((h.kind, h.flags, h.len), (spec::wire::MSG_VIDEO_SLOT, 1, 1040));
    assert!(parse_frame_header(&out[..7]).is_none(), "short header");
    assert!(
        !encode_frame_header(0x10, 0, spec::wire::MAX_PAYLOAD as u32 + 1, &mut out),
        "oversize refused at encode"
    );
    out[4..8].copy_from_slice(&(spec::wire::MAX_PAYLOAD as u32 + 1).to_le_bytes());
    assert!(parse_frame_header(&out).is_none(), "oversize refused at parse");
}

#[test]
fn wire_hello_and_beacon_parse() {
    use crate::wire::{encode_hello, parse_beacon, parse_hello_ack};
    let mut out = [0u8; 80];
    let n = encode_hello("youtube", &mut out).expect("encodes");
    assert_eq!(n, 7 + 7);
    assert_eq!(&out[0..4], &spec::wire::MAGIC.to_le_bytes());
    assert_eq!(out[4], spec::wire::VERSION);
    assert_eq!(out[6] as usize, 7);
    assert_eq!(&out[7..14], b"youtube");
    assert!(encode_hello("", &mut out).is_none());

    let mut ack = [0u8; 8];
    ack[0..4].copy_from_slice(&spec::wire::MAGIC.to_le_bytes());
    ack[4] = 1;
    assert_eq!(parse_hello_ack(&ack), Some(1));
    ack[0] = 0;
    assert_eq!(parse_hello_ack(&ack), None);

    let mut beacon = Vec::new();
    beacon.extend_from_slice(&spec::wire::BEACON_MAGIC.to_le_bytes());
    beacon.push(spec::wire::VERSION);
    beacon.push(0);
    beacon.extend_from_slice(&spec::wire::PORT.to_le_bytes());
    beacon.push(7);
    beacon.extend_from_slice(b"youtube");
    beacon.push(3);
    beacon.extend_from_slice(b"Mac");
    let (port, app, name) = parse_beacon(&beacon).expect("beacon parses");
    assert_eq!((port, app, name), (spec::wire::PORT, "youtube", "Mac"));
    // Truncations must fail cleanly at every length.
    for cut in 0..beacon.len() {
        assert!(parse_beacon(&beacon[..cut]).is_none(), "cut at {cut}");
    }
}

#[test]
fn wire_payload_parsers_validate_and_survive_truncation() {
    use crate::wire::{
        parse_audio_chunk, parse_file, parse_stream_mark, parse_stream_open, parse_video_slot,
    };

    // file: pathLen · path · blob
    let mut file = Vec::new();
    file.extend_from_slice(&9u16.to_le_bytes());
    file.extend_from_slice(b"thumbs/a0");
    file.extend_from_slice(&[1, 2, 3, 4]);
    let (path, blob) = parse_file(&file).expect("file parses");
    assert_eq!((path, blob), ("thumbs/a0", &[1u8, 2, 3, 4][..]));
    for cut in 0..11 {
        assert!(parse_file(&file[..cut]).is_none(), "cut at {cut}");
    }

    // streamOpen requires exactly a 96-byte header block after the path.
    let block = stream_header_block(0, 0, 32, 16, 2, 0, 64, 4, 0);
    let mut open = Vec::new();
    open.extend_from_slice(&7u16.to_le_bytes());
    open.extend_from_slice(b"media/v");
    open.extend_from_slice(&block);
    let (path, got) = parse_stream_open(&open).expect("streamOpen parses");
    assert_eq!(path, "media/v");
    assert_eq!(got, &block[..]);
    assert!(parse_stream_open(&open[..open.len() - 1]).is_none(), "short block refused");

    // videoSlot: header · palette · indices.
    let mut slot = Vec::new();
    slot.extend_from_slice(&2u32.to_le_bytes()); // seq
    slot.extend_from_slice(&7u32.to_le_bytes()); // frameIndex
    slot.extend_from_slice(&32u16.to_le_bytes());
    slot.extend_from_slice(&16u16.to_le_bytes());
    slot.extend_from_slice(&0u16.to_le_bytes()); // flags
    slot.extend_from_slice(&0u16.to_le_bytes());
    slot.extend_from_slice(&[9u8; 1024]);
    slot.extend_from_slice(&[5u8; 32 * 16]);
    let msg = parse_video_slot(&slot).expect("slot parses");
    assert_eq!((msg.seq, msg.frame_index, msg.w, msg.h, msg.rle), (2, 7, 32, 16, false));
    assert_eq!(msg.palette.len(), 1024);
    assert_eq!(msg.indices.len(), 32 * 16);
    assert!(parse_video_slot(&slot[..1039]).is_none(), "short slot refused");
    let mut zero_seq = slot.clone();
    zero_seq[0..4].copy_from_slice(&0u32.to_le_bytes());
    assert!(parse_video_slot(&zero_seq).is_none(), "seq 0 refused");

    // audioChunk + streamMark.
    let mut chunk = Vec::new();
    chunk.extend_from_slice(&1u32.to_le_bytes());
    chunk.extend_from_slice(&2048u32.to_le_bytes());
    chunk.extend_from_slice(&[0u8; 64 * 2 * 2]);
    let msg = parse_audio_chunk(&chunk).expect("chunk parses");
    assert_eq!((msg.seq, msg.start_frame, msg.pcm.len()), (1, 2048, 64 * 2 * 2));
    assert!(parse_audio_chunk(&chunk[..7]).is_none());

    let mut mark = Vec::new();
    mark.extend_from_slice(&3u32.to_le_bytes());
    mark.extend_from_slice(&spec::wire::MARK_FLAG_ENDED.to_le_bytes());
    mark.extend_from_slice(&0u16.to_le_bytes());
    let msg = parse_stream_mark(&mark).expect("mark parses");
    assert!(msg.ended);
    assert_eq!(msg.epoch, 3);
    assert!(parse_stream_mark(&mark[..7]).is_none());
}

/// Independent reference writer: build the .pkst image with direct byte
/// writes straight off the spec.ts layout comment — a different code path
/// from RamStream, so equality below is a real check, not a tautology.
fn reference_write_slot(
    buf: &mut [u8],
    h: &crate::stream::StreamHeaders,
    seq: u32,
    frame_index: u32,
    palette: &[u8],
    indices: &[u8],
) {
    let off = (h.video_off + ((seq - 1) % h.video.slot_count) * h.video.slot_size) as usize;
    buf[off..off + 4].copy_from_slice(&seq.to_le_bytes());
    buf[off + 4..off + 8].copy_from_slice(&frame_index.to_le_bytes());
    buf[off + 8..off + 10].copy_from_slice(&(h.video.w as u16).to_le_bytes());
    buf[off + 10..off + 12].copy_from_slice(&(h.video.h as u16).to_le_bytes());
    for b in &mut buf[off + 12..off + 32] {
        *b = 0;
    }
    buf[off + 32..off + 32 + 1024].copy_from_slice(palette);
    buf[off + 1056..off + 1056 + indices.len()].copy_from_slice(indices);
    let v = spec::stream::VRING_OFF;
    buf[v + 20..v + 24].copy_from_slice(&seq.to_le_bytes());
}

fn reference_write_chunk(
    buf: &mut [u8],
    h: &crate::stream::StreamHeaders,
    seq: u32,
    start_frame: u32,
    pcm: &[u8],
) {
    let size = crate::stream::chunk_size(h.audio.chunk_frames, h.audio.channels).unwrap();
    let off = (h.audio_off + ((seq - 1) % h.audio.chunk_count) * size) as usize;
    buf[off..off + 4].copy_from_slice(&seq.to_le_bytes());
    buf[off + 4..off + 8].copy_from_slice(&start_frame.to_le_bytes());
    for b in &mut buf[off + 8..off + 16] {
        *b = 0;
    }
    buf[off + 16..off + 16 + pcm.len()].copy_from_slice(pcm);
    let a = spec::stream::ARING_OFF;
    buf[a + 20..a + 24].copy_from_slice(&seq.to_le_bytes());
}

#[test]
fn ram_stream_image_equals_the_reference_file_writer() {
    use crate::wire::{AudioChunkMsg, StreamMarkMsg, VideoSlotMsg};

    let block = stream_header_block(0, 0, 32, 16, 2, 0, 64, 2, 0);
    let h = crate::stream::parse_header_block(&block).unwrap();
    let chunk_size = crate::stream::chunk_size(h.audio.chunk_frames, h.audio.channels).unwrap();
    let total = (h.audio_off + h.audio.chunk_count * chunk_size) as usize;

    // Reference image: header block + direct writes (3 slots so seq 3 laps
    // slot 1's position, 2 chunks) + an epoch/ended mark.
    let mut reference = alloc::vec![0u8; total];
    reference[..96].copy_from_slice(&block);
    let pal = |seed: u8| -> Vec<u8> { (0..1024).map(|i| (i as u8).wrapping_add(seed)).collect() };
    let px = |seed: u8| -> Vec<u8> { (0..32 * 16).map(|i| (i as u8).wrapping_mul(seed)).collect() };
    let pcm = |seed: u8| -> Vec<u8> { (0..64 * 2 * 2).map(|i| (i as u8) ^ seed).collect() };
    for seq in 1..=3u32 {
        reference_write_slot(&mut reference, &h, seq, seq * 2, &pal(seq as u8), &px(seq as u8));
    }
    for seq in 1..=2u32 {
        reference_write_chunk(&mut reference, &h, seq, seq * 64, &pcm(seq as u8));
    }
    reference[8..12].copy_from_slice(&5u32.to_le_bytes()); // epoch
    reference[6..8].copy_from_slice(&spec::stream::FLAG_ENDED.to_le_bytes());

    // RamStream fed the same content as WIRE messages.
    let mut ram = crate::stream_rx::RamStream::open(&block).expect("opens");
    for seq in 1..=3u32 {
        let palette = pal(seq as u8);
        let indices = px(seq as u8);
        assert!(ram.apply_slot(&VideoSlotMsg {
            seq,
            frame_index: seq * 2,
            w: 32,
            h: 16,
            rle: false,
            palette: &palette,
            indices: &indices,
        }));
    }
    for seq in 1..=2u32 {
        let bytes = pcm(seq as u8);
        assert!(ram.apply_chunk(&AudioChunkMsg { seq, start_frame: seq * 64, pcm: &bytes }));
    }
    ram.apply_mark(&StreamMarkMsg { epoch: 5, ended: true });

    assert_eq!(ram.buf().len(), reference.len());
    assert_eq!(ram.buf(), &reference[..], "RAM ring == file ring, byte for byte");

    // And the shared readers see the expected world.
    let live = crate::stream::parse_header_block(ram.buf()).unwrap();
    assert_eq!((live.epoch, live.ended), (5, true));
    assert_eq!(live.video.latest_seq, 3);
    assert_eq!(live.audio.latest_seq, 2);
    let off = crate::stream::slot_offset(&live, 3).unwrap() as usize;
    let sh = crate::stream::parse_slot_header(&ram.buf()[off..], &live.video).unwrap();
    assert_eq!((sh.seq, sh.frame_index), (3, 6));
}

#[test]
fn ram_stream_decodes_rle_slots_and_rejects_bad_geometry() {
    use crate::wire::VideoSlotMsg;
    let block = stream_header_block(0, 0, 32, 16, 2, 0, 64, 2, 0);
    let mut ram = crate::stream_rx::RamStream::open(&block).unwrap();

    let raw: Vec<u8> = (0..32 * 16).map(|i| if i < 300 { 7 } else { (i % 5) as u8 }).collect();
    let rle = packbits_encode(&raw);
    assert!(rle.len() < raw.len(), "fixture should actually compress");
    let palette = alloc::vec![1u8; 1024];
    assert!(ram.apply_slot(&VideoSlotMsg {
        seq: 1,
        frame_index: 0,
        w: 32,
        h: 16,
        rle: true,
        palette: &palette,
        indices: &rle,
    }));
    let h = crate::stream::parse_header_block(ram.buf()).unwrap();
    let off = crate::stream::slot_offset(&h, 1).unwrap() as usize;
    assert_eq!(&ram.buf()[off + 1056..off + 1056 + raw.len()], &raw[..]);

    // Wrong plane, wrong palette size, wrong index count, truncated RLE.
    assert!(!ram.apply_slot(&VideoSlotMsg {
        seq: 2, frame_index: 1, w: 16, h: 16, rle: false, palette: &palette, indices: &raw,
    }));
    assert!(!ram.apply_slot(&VideoSlotMsg {
        seq: 2, frame_index: 1, w: 32, h: 16, rle: false, palette: &palette[..512], indices: &raw,
    }));
    assert!(!ram.apply_slot(&VideoSlotMsg {
        seq: 2, frame_index: 1, w: 32, h: 16, rle: false, palette: &palette, indices: &raw[..100],
    }));
    assert!(!ram.apply_slot(&VideoSlotMsg {
        seq: 2, frame_index: 1, w: 32, h: 16, rle: true, palette: &palette, indices: &rle[..rle.len() / 2],
    }));
    // Failures must not publish a cursor.
    let h = crate::stream::parse_header_block(ram.buf()).unwrap();
    assert_eq!(h.video.latest_seq, 1);
}

/// Cross-language: rebuild the committed TS-written .pkst golden through
/// RamStream (slots/chunks re-fed as WIRE messages) and require the byte-
/// identical file image — the socket transport IS the file transport.
#[test]
fn ram_stream_reconstructs_the_committed_golden() {
    use crate::wire::{AudioChunkMsg, StreamMarkMsg, VideoSlotMsg};
    let golden: &[u8] = include_bytes!("../../../tests/fixtures/youtube-golden.pkst");
    let h = crate::stream::parse_header_block(golden).expect("golden parses");

    // Open from a PRISTINE header (cursors zeroed, epoch 0, flags 0) — the
    // exact block a streamOpen would carry before any writes.
    let mut pristine = golden[..96].to_vec();
    pristine[6..8].copy_from_slice(&0u16.to_le_bytes());
    pristine[8..12].copy_from_slice(&0u32.to_le_bytes());
    let v = spec::stream::VRING_OFF;
    let a = spec::stream::ARING_OFF;
    pristine[v + 20..v + 24].copy_from_slice(&0u32.to_le_bytes());
    pristine[a + 20..a + 24].copy_from_slice(&0u32.to_le_bytes());
    let mut ram = crate::stream_rx::RamStream::open(&pristine).expect("opens");

    // Re-feed every RESIDENT slot/chunk in seq order (the ring holds the
    // last slot_count/chunk_count writes; lapped history is gone by design).
    let mut slots: Vec<(u32, usize)> = Vec::new();
    for idx in 0..h.video.slot_count {
        let off = (h.video_off + idx * h.video.slot_size) as usize;
        if let Some(sh) = crate::stream::parse_slot_header(&golden[off..], &h.video) {
            slots.push((sh.seq, off));
        }
    }
    slots.sort();
    for (seq, off) in slots {
        let sh = crate::stream::parse_slot_header(&golden[off..], &h.video).unwrap();
        let pal = &golden[off + 32..off + 32 + 1024];
        let px = &golden[off + 1056..off + 1056 + (h.video.w * h.video.h) as usize];
        assert!(ram.apply_slot(&VideoSlotMsg {
            seq,
            frame_index: sh.frame_index,
            w: h.video.w,
            h: h.video.h,
            rle: false,
            palette: pal,
            indices: px,
        }));
    }
    let chunk_size = crate::stream::chunk_size(h.audio.chunk_frames, h.audio.channels).unwrap();
    let pcm_bytes = (h.audio.chunk_frames * h.audio.channels * 2) as usize;
    let mut chunks: Vec<(u32, usize)> = Vec::new();
    for idx in 0..h.audio.chunk_count {
        let off = (h.audio_off + idx * chunk_size) as usize;
        if let Some(ch) = crate::stream::parse_chunk_header(&golden[off..]) {
            chunks.push((ch.seq, off));
        }
    }
    chunks.sort();
    for (seq, off) in chunks {
        let ch = crate::stream::parse_chunk_header(&golden[off..]).unwrap();
        assert!(ram.apply_chunk(&AudioChunkMsg {
            seq,
            start_frame: ch.start_frame,
            pcm: &golden[off + 16..off + 16 + pcm_bytes],
        }));
    }
    ram.apply_mark(&StreamMarkMsg { epoch: h.epoch, ended: h.ended });
    // Restore the golden's final cursors exactly (a lapped ring's latest may
    // exceed the highest resident seq; apply_* published the resident max).
    let final_v = h.video.latest_seq;
    let final_a = h.audio.latest_seq;
    let buf_len = ram.buf().len();
    assert_eq!(buf_len, golden.len(), "same preallocated image size");
    let mut image = ram.buf().to_vec();
    image[v + 20..v + 24].copy_from_slice(&final_v.to_le_bytes());
    image[a + 20..a + 24].copy_from_slice(&final_a.to_le_bytes());
    assert_eq!(&image[..], golden, "socket-fed RAM ring == TS-written file, byte for byte");
}

// ---------------------------------------------------------------------------
// touch hit facts (spec op hitTestBounds + Ui::touch_hits; docs/TOUCH.md)
// ---------------------------------------------------------------------------

#[test]
fn hit_test_bounds_claims_pure_layout_containers() {
    let mut ui = Ui::new();
    // An unstyled container (a list viewport): ink-transparent, bounds-solid.
    let viewport = ui.create_node(0);
    ui.set_prop(viewport, spec::prop::POS_TYPE, spec::PosType::Absolute as u32 as f64);
    ui.set_prop(viewport, spec::prop::INSET_L, 10.0);
    ui.set_prop(viewport, spec::prop::INSET_T, 10.0);
    ui.set_prop(viewport, spec::prop::WIDTH, 100.0);
    ui.set_prop(viewport, spec::prop::HEIGHT, 100.0);
    ui.insert_before(spec::ROOT_ID, viewport, 0);
    let row = abs_box(&mut ui, viewport, 0.0, 0.0, 100.0, 20.0);
    ui.tick();
    // On the painted row both modes agree (paint order, depth, clips shared).
    assert_eq!(ui.hit_test(20.0, 15.0), row);
    assert_eq!(ui.hit_test_bounds(20.0, 15.0), row);
    // In the row gap: ink misses, bounds resolves to the container's box —
    // the property that lets a list own its whole viewport without painted
    // rows under every finger (the touchRect workaround this replaces).
    assert_eq!(ui.hit_test(20.0, 80.0), 0, "ink: nothing painted in the gap");
    assert_eq!(ui.hit_test_bounds(20.0, 80.0), viewport, "bounds: the gap is the viewport's box");
}

#[test]
fn touch_hit_facts_carry_from_the_down_frame() {
    let mut ui = Ui::new();
    let a = abs_box(&mut ui, spec::ROOT_ID, 0.0, 0.0, 50.0, 50.0);
    let b = abs_box(&mut ui, spec::ROOT_ID, 100.0, 0.0, 50.0, 50.0);
    ui.tick();
    let pack = |id: u32, x: u32, y: u32| (id << 18) | (y << 9) | x;
    let mut out = [0i32; 8];
    // Down on A.
    assert_eq!(ui.touch_hits(&[pack(3, 20, 20)], &mut out), 1);
    assert_eq!(out[0], a);
    // Drag over B: the down hit is CARRIED, never re-resolved (implicit capture).
    assert_eq!(ui.touch_hits(&[pack(3, 120, 20)], &mut out), 1);
    assert_eq!(out[0], a, "capture: the hit stays the down-frame hit");
    // Lift, then a NEW id lands on B: fresh resolve.
    assert_eq!(ui.touch_hits(&[], &mut out), 0);
    assert_eq!(ui.touch_hits(&[pack(4, 120, 20)], &mut out), 1);
    assert_eq!(out[0], b);
    // Two simultaneous contacts resolve independently, in wire order.
    ui.touch_hits(&[], &mut out);
    let n = ui.touch_hits(&[pack(1, 20, 20), pack(2, 120, 20)], &mut out);
    assert_eq!((n, out[0], out[1]), (2, a, b));
}

#[test]
fn auxiliary_surface_isolates_layout_draw_and_touch_domains() {
    let mut ui = Ui::new();
    ui.set_viewport(400.0, 240.0);
    let auxiliary_root = ui.create_auxiliary_surface(320.0, 240.0);
    assert!(auxiliary_root > spec::ROOT_ID);
    assert_eq!(ui.auxiliary_surface_root(), auxiliary_root);
    assert_eq!(ui.auxiliary_viewport(), Some((320.0, 240.0)));

    let primary = abs_box(&mut ui, spec::ROOT_ID, 10.0, 12.0, 80.0, 40.0);
    let auxiliary = abs_box(&mut ui, auxiliary_root, 10.0, 12.0, 80.0, 40.0);
    let red = abgr(220, 30, 20, 255);
    let blue = abgr(20, 30, 220, 255);
    ui.set_prop(primary, spec::prop::BG_COLOR, red as f64);
    ui.set_prop(auxiliary, spec::prop::BG_COLOR, blue as f64);

    let primary_words = ui.draw().words.clone();
    let auxiliary_words = ui.draw_auxiliary().unwrap().words.clone();
    validate_drawlist(&primary_words);
    validate_drawlist(&auxiliary_words);
    assert!(primary_words.contains(&red));
    assert!(!primary_words.contains(&blue));
    assert!(auxiliary_words.contains(&blue));
    assert!(!auxiliary_words.contains(&red));

    assert_eq!(ui.hit_test_bounds(20.0, 20.0), primary);
    assert_eq!(ui.hit_test_bounds_auxiliary(20.0, 20.0), auxiliary);

    let packed = [(3 << 18) | (20 << 9) | 20];
    let mut primary_hits = [0i32; 8];
    let mut auxiliary_hits = [0i32; 8];
    assert_eq!(ui.touch_hits(&packed, &mut primary_hits), 1);
    assert_eq!(ui.touch_hits_auxiliary(&packed, &mut auxiliary_hits), 1);
    assert_eq!(primary_hits[0], primary);
    assert_eq!(auxiliary_hits[0], auxiliary);

    // Both native roots are permanent members of one tree but cannot be
    // destroyed or nested into application content.
    ui.destroy_node(auxiliary_root);
    ui.insert_before(primary, auxiliary_root, 0);
    assert_eq!(ui.auxiliary_surface_root(), auxiliary_root);
    assert_eq!(ui.hit_test_bounds_auxiliary(20.0, 20.0), auxiliary);
}

#[test]
fn touch_decode_reads_both_packings() {
    assert_eq!(crate::touch::decode((7 << 18) | (200 << 9) | 300), (7, 300.0, 200.0));
    assert_eq!(
        crate::touch::decode(0x8000_0000 | (9 << 20) | (600 << 10) | 700),
        (9, 700.0, 600.0)
    );
}

#[test]
fn hit_pass_layers_never_swallow_bounds_hits() {
    let mut ui = Ui::new();
    let content = abs_box(&mut ui, spec::ROOT_ID, 10.0, 10.0, 100.0, 50.0);
    // A full-screen overlay layer ABOVE the content (the framework's portal
    // root): hitPass makes its own box hit-transparent in BOTH walks, while
    // its children still claim.
    let overlay = ui.create_node(0);
    ui.set_prop(overlay, spec::prop::POS_TYPE, spec::PosType::Absolute as u32 as f64);
    ui.set_prop(overlay, spec::prop::INSET_L, 0.0);
    ui.set_prop(overlay, spec::prop::INSET_T, 0.0);
    ui.set_prop(overlay, spec::prop::WIDTH, 480.0);
    ui.set_prop(overlay, spec::prop::HEIGHT, 272.0);
    ui.set_prop(overlay, spec::prop::HIT_PASS, 1.0);
    ui.insert_before(spec::ROOT_ID, overlay, 0);
    ui.tick();
    assert_eq!(
        ui.hit_test_bounds(20.0, 20.0),
        content,
        "bounds facts resolve through the empty overlay to the content"
    );
    // A toast INSIDE the overlay claims over the content beneath it.
    let toast = abs_box(&mut ui, overlay, 15.0, 15.0, 30.0, 20.0);
    assert_eq!(ui.hit_test_bounds(20.0, 20.0), toast);
    assert_eq!(ui.hit_test(20.0, 20.0), toast, "ink walk honors overlay content too");
}

// ---- native text (TEXT_RUN, docs/BACKENDS.md) -----------------------------------

/// Decode a TEXT_RUN's packed UTF-8 payload at op index `i`; returns the
/// string and the index past the op (spec.ts word format).
fn decode_text_run_text(words: &[u32], i: usize) -> (alloc::string::String, usize) {
    let len = words[i + 7] as usize;
    let mut bytes = Vec::with_capacity(len);
    for w in &words[i + 8..i + 8 + len.div_ceil(4)] {
        bytes.extend_from_slice(&w.to_le_bytes());
    }
    bytes.truncate(len);
    (
        alloc::string::String::from_utf8(bytes).expect("TEXT_RUN payload is UTF-8"),
        i + 8 + len.div_ceil(4),
    )
}

/// A deterministic fake native measurer: 7 px per char, 12 px default lines.
fn fake_native_measure() -> crate::text::MeasureFn {
    alloc::boxed::Box::new(|text: &str, _slot, _tracking, line_h| {
        let lines = text.split('\n').count() as f32;
        let w = text
            .split('\n')
            .map(|l| l.chars().count())
            .max()
            .unwrap_or(0) as f32
            * 7.0;
        let lh = if line_h.is_nan() { 12.0 } else { line_h };
        (w, lines * lh)
    })
}

#[test]
fn native_measure_routes_layout_and_emits_text_run() {
    let mut ui = Ui::new();
    // Atlas registered so the BAKED path would measure differently (A=6, B=5).
    ui.load_font_atlas(&encode_atlas(
        0,
        8,
        8,
        7,
        10,
        3,
        &[(0xfffd, 0, 8), ('A' as u32, 1, 6), ('B' as u32, 2, 5)],
    ));
    ui.set_text_measure(Some(fake_native_measure()));
    // The JS-facing measureText op routes to the same provider as layout.
    assert_eq!(ui.measure_text("AB", 0), 14.0);
    let color = abgr(10, 20, 30, 255);
    let t = ui.create_node(spec::NodeType::Text as u8);
    ui.set_prop(t, spec::prop::WIDTH, 30.0);
    ui.set_prop(t, spec::prop::TEXT_COLOR, color as f64);
    ui.set_text(t, "AB");
    ui.insert_before(spec::ROOT_ID, t, 0);
    ui.tick();
    let words = ui.draw().words.clone();
    let counts = validate_drawlist(&words);
    assert_eq!(counts[spec::draw_op::TEXT_RUN as usize], 1);
    assert_eq!(counts[spec::draw_op::GLYPH_RUN as usize], 0);
    let i = words.iter().position(|&w| w == spec::draw_op::TEXT_RUN).unwrap();
    assert_eq!(words[i + 1], 0, "slot 0, left align");
    assert_eq!(f32::from_bits(words[i + 2]), 0.0);
    assert_eq!(f32::from_bits(words[i + 3]), 0.0);
    assert_eq!(f32::from_bits(words[i + 4]), 30.0, "boxW = laid-out box width");
    assert!(f32::from_bits(words[i + 5]).is_nan(), "lineHeight NaN = slot default");
    assert_eq!(words[i + 6], color);
    // The run string rides IN the words — the DrawList is the complete
    // pixel truth, no side table.
    let (text, _) = decode_text_run_text(&words, i);
    assert_eq!(text, "AB");
    // taffy sized the leaf's main axis from the native metrics (12 px line),
    // not the atlas (10 px line).
    let l = ui.layout_of(t).unwrap();
    assert_eq!((l.2, l.3), (30.0, 12.0));
}

#[test]
fn tracked_and_transformed_runs_use_the_baked_pair_on_both_sides() {
    let mut ui = Ui::new();
    ui.load_font_atlas(&encode_atlas(
        0,
        8,
        8,
        7,
        10,
        3,
        &[(0xfffd, 0, 8), ('A' as u32, 1, 6), ('B' as u32, 2, 5)],
    ));
    ui.set_text_measure(Some(fake_native_measure()));
    // Tracked run: baked measurement AND baked glyphs (consistent pair).
    let tracked = ui.create_node(spec::NodeType::Text as u8);
    ui.set_prop(tracked, spec::prop::TRACKING, 2.0);
    ui.set_text(tracked, "AB");
    ui.insert_before(spec::ROOT_ID, tracked, 0);
    // Rotated run: ONE provider on both sides — layout records the baked
    // pair (transformed subtree), so the box AND the glyphs are atlas
    // metrics. Never native box + baked glyphs.
    let rotated = ui.create_node(spec::NodeType::Text as u8);
    // Small explicit width keeps the rotated cells on-screen (off-screen
    // cells are dropped, which would empty the run).
    ui.set_prop(rotated, spec::prop::WIDTH, 20.0);
    ui.set_prop(rotated, spec::prop::ROTATE, 45.0);
    ui.set_text(rotated, "AB");
    ui.insert_before(spec::ROOT_ID, rotated, 0);
    // Text under a transformed ANCESTOR takes the baked pair too. (Scale
    // DOWN so the transformed glyph anchors stay on-screen — off-screen
    // cells are dropped, which would empty the run.)
    let wrap = ui.create_node(spec::NodeType::View as u8);
    ui.set_prop(wrap, spec::prop::SCALE, 0.5);
    let nested = ui.create_node(spec::NodeType::Text as u8);
    ui.set_text(nested, "A");
    ui.insert_before(wrap, nested, 0);
    ui.insert_before(spec::ROOT_ID, wrap, 0);
    ui.tick();
    let words = ui.draw().words.clone();
    let counts = validate_drawlist(&words);
    assert_eq!(counts[spec::draw_op::TEXT_RUN as usize], 0);
    assert_eq!(counts[spec::draw_op::GLYPH_RUN as usize], 2);
    assert_eq!(counts[spec::draw_op::TEX_QUAD as usize], 1, "scaled baked glyph uses a textured cell");
    // Column layout: width cross-stretches, so the measurement provider is
    // observable through the main-axis HEIGHT. All three leaves measured
    // with the atlas (10 px line), matching their painted glyphs.
    assert_eq!(ui.layout_of(tracked).unwrap().3, 10.0);
    assert_eq!(ui.layout_of(rotated).unwrap().3, 10.0);
    assert_eq!(ui.layout_of(nested).unwrap().3, 10.0);
}

#[test]
fn clipped_text_run_is_scissor_bracketed() {
    let mut ui = Ui::new();
    ui.set_text_measure(Some(fake_native_measure()));
    // overflow-hidden 20x10 box; the run measures 28 px -> exceeds the clip.
    let mut s = StyleSpec::new();
    s.base = alloc::vec![(spec::prop::OVERFLOW, spec::Overflow::Hidden as u32)];
    assert!(ui.load_styles(&encode_styles(&[s])));
    let wrap = ui.create_node(spec::NodeType::View as u8);
    ui.set_style(wrap, 0);
    ui.set_prop(wrap, spec::prop::WIDTH, 20.0);
    ui.set_prop(wrap, spec::prop::HEIGHT, 10.0);
    let t = ui.create_node(spec::NodeType::Text as u8);
    ui.set_text(t, "AAAA");
    ui.insert_before(wrap, t, 0);
    ui.insert_before(spec::ROOT_ID, wrap, 0);
    ui.tick();
    let words = ui.draw().words.clone();
    validate_drawlist(&words);
    let i = words.iter().position(|&w| w == spec::draw_op::TEXT_RUN).unwrap();
    assert_eq!(words[i - 3], spec::draw_op::SCISSOR, "run bracketed by its own scissor");
    assert_eq!(decode_xy(words[i - 2]), (0, 0));
    assert_eq!(decode_wh(words[i - 1]), (20, 10), "scissor = current clip");
    let (_, end) = decode_text_run_text(&words, i);
    assert_eq!(words[end], spec::draw_op::SCISSOR_POP);
}

#[test]
fn provider_re_decides_within_the_same_draw_after_a_paint_only_transform() {
    // rotate/scale are paint-only (no relayout), so a transform set after
    // layout leaves the recorded provider stale. The draw walk detects the
    // divergence and Ui::draw re-decides + REPAINTS before returning: every
    // frame that leaves draw() is provider-correct, in both directions —
    // zero stale frames.
    let mut ui = Ui::new();
    ui.load_font_atlas(&encode_atlas(
        0,
        8,
        8,
        7,
        10,
        3,
        &[(0xfffd, 0, 8), ('A' as u32, 1, 6), ('B' as u32, 2, 5)],
    ));
    ui.set_text_measure(Some(fake_native_measure()));
    let t = ui.create_node(spec::NodeType::Text as u8);
    ui.set_prop(t, spec::prop::WIDTH, 20.0);
    ui.set_text(t, "AB");
    ui.insert_before(spec::ROOT_ID, t, 0);
    ui.tick();
    let counts = validate_drawlist(&ui.draw().words.clone());
    assert_eq!(counts[spec::draw_op::TEXT_RUN as usize], 1);
    assert_eq!(ui.layout_of(t).unwrap().3, 12.0, "native line height sized the box");

    // Into the transform: the VERY NEXT draw is already the baked pair.
    ui.set_prop(t, spec::prop::ROTATE, 30.0);
    ui.tick();
    let counts = validate_drawlist(&ui.draw().words.clone());
    assert_eq!(counts[spec::draw_op::TEXT_RUN as usize], 0);
    assert_eq!(counts[spec::draw_op::GLYPH_RUN as usize], 1);
    assert_eq!(ui.layout_of(t).unwrap().3, 10.0, "box re-measured with the atlas");

    // Out of the transform: same, back to the native pair immediately.
    ui.set_prop(t, spec::prop::ROTATE, 0.0);
    ui.tick();
    let counts = validate_drawlist(&ui.draw().words.clone());
    assert_eq!(counts[spec::draw_op::TEXT_RUN as usize], 1);
    assert_eq!(counts[spec::draw_op::GLYPH_RUN as usize], 0);
    assert_eq!(ui.layout_of(t).unwrap().3, 12.0, "box re-measured natively");
}

#[test]
fn canceling_transforms_do_not_oscillate_the_provider() {
    // Parent scale 0.5, child text scale 2.0: the composed world matrix is
    // numerically a translation again, but BOTH the layout build and the
    // draw walk gate on the same declared-transform path predicate — the
    // node stays on the baked pair with no divergence flag, so repeated
    // draws never schedule spurious relayouts.
    let mut ui = Ui::new();
    ui.load_font_atlas(&encode_atlas(
        0,
        8,
        8,
        7,
        10,
        3,
        &[(0xfffd, 0, 8), ('A' as u32, 1, 6), ('B' as u32, 2, 5)],
    ));
    ui.set_text_measure(Some(fake_native_measure()));
    let wrap = ui.create_node(spec::NodeType::View as u8);
    ui.set_prop(wrap, spec::prop::WIDTH, 40.0);
    ui.set_prop(wrap, spec::prop::SCALE, 0.5);
    let t = ui.create_node(spec::NodeType::Text as u8);
    ui.set_prop(t, spec::prop::SCALE, 2.0);
    ui.set_text(t, "AB");
    ui.insert_before(wrap, t, 0);
    ui.insert_before(spec::ROOT_ID, wrap, 0);
    ui.tick();
    let counts = validate_drawlist(&ui.draw().words.clone());
    assert_eq!(counts[spec::draw_op::TEXT_RUN as usize], 0, "declared path wins");
    assert_eq!(counts[spec::draw_op::GLYPH_RUN as usize], 1);
    assert_eq!(ui.layout_of(t).unwrap().3, 10.0, "baked metrics sized the box");
    // The killer assertion: a second and third draw must not have been
    // dirtied by a provider oscillation.
    let _ = ui.draw();
    assert!(!ui.layout.needs(), "no spurious relayout scheduled");
    let _ = ui.draw();
    assert!(!ui.layout.needs());
}

#[test]
fn text_run_words_are_the_complete_pixel_truth() {
    let mut ui = Ui::new();
    ui.set_text_measure(Some(fake_native_measure()));
    let t = ui.create_node(spec::NodeType::Text as u8);
    ui.set_text(t, "AB");
    ui.insert_before(spec::ROOT_ID, t, 0);
    ui.tick();
    let words_ab = ui.draw().words.clone();
    let i = words_ab.iter().position(|&w| w == spec::draw_op::TEXT_RUN).unwrap();
    // Same length, same geometry, different content: the word stream MUST
    // differ — the run bytes ride in the words, so a demand-render hash or
    // a damage word-diff can never miss a text change (no hash collisions
    // possible: the comparison is exact bytes, not a digest).
    ui.set_text(t, "BA");
    ui.tick();
    let words_ba = ui.draw().words.clone();
    let j = words_ba.iter().position(|&w| w == spec::draw_op::TEXT_RUN).unwrap();
    assert_eq!(i, j);
    assert_eq!(words_ab[i + 4], words_ba[j + 4], "geometry unchanged");
    assert_ne!(words_ab, words_ba, "the payload words track the run string");
    assert_eq!(decode_text_run_text(&words_ab, i).0, "AB");
    assert_eq!(decode_text_run_text(&words_ba, j).0, "BA");
    // Multi-word payload packs little-endian, zero-padded.
    ui.set_text(t, "hello 中文");
    ui.tick();
    let words = ui.draw().words.clone();
    let k = words.iter().position(|&w| w == spec::draw_op::TEXT_RUN).unwrap();
    assert_eq!(decode_text_run_text(&words, k).0, "hello 中文");
    validate_drawlist(&words);
}

#[test]
fn clearing_native_measure_restores_baked_goldens_path() {
    let mut ui = Ui::new();
    ui.load_font_atlas(&encode_atlas(
        0,
        8,
        8,
        7,
        10,
        3,
        &[(0xfffd, 0, 8), ('A' as u32, 1, 6), ('B' as u32, 2, 5)],
    ));
    ui.set_text_measure(Some(fake_native_measure()));
    assert_eq!(ui.measure_text("AB", 0), 14.0);
    ui.set_text_measure(None);
    assert_eq!(ui.measure_text("AB", 0), 11.0);
    let t = ui.create_node(spec::NodeType::Text as u8);
    ui.set_text(t, "AB");
    ui.insert_before(spec::ROOT_ID, t, 0);
    ui.tick();
    let counts = validate_drawlist(&ui.draw().words.clone());
    assert_eq!(counts[spec::draw_op::TEXT_RUN as usize], 0);
    assert_eq!(counts[spec::draw_op::GLYPH_RUN as usize], 1);
}

#[test]
fn font_revision_changes_only_after_successful_load_and_is_slot_local() {
    let mut ui = Ui::new();
    let atlas = encode_atlas(3, 2, 2, 1, 2, 1, &[(65, 0, 2)]);
    assert_eq!(ui.font_atlas_revision(3), 0);
    assert!(ui.load_font_atlas(&atlas));
    assert_eq!(ui.font_atlas_revision(3), 1);
    assert!(!ui.load_font_atlas(&atlas[..10]));
    assert_eq!(ui.font_atlas_revision(3), 1);
    let mut replacement = atlas.clone();
    *replacement.last_mut().unwrap() = 255;
    assert!(ui.load_font_atlas(&replacement));
    assert_eq!(ui.font_atlas_revision(3), 2);
    assert_eq!(ui.font_atlas_revision(0), 0);
    assert_eq!(ui.font_atlas_revision(255), 0);
}

fn stream_config(generation: u32, capacity: u16) -> [u8; 20] {
    let mut b = [0; 20];
    b[..4].copy_from_slice(&crate::font_stream::CONFIG_MAGIC.to_le_bytes());
    b[4..8].copy_from_slice(&generation.to_le_bytes());
    b[8..15].copy_from_slice(&[2, 8, 8, 7, 10, 8, 1]);
    b[16..18].copy_from_slice(&capacity.to_le_bytes());
    b
}
fn stream_batch(generation: u32, cp: u32, coverage: u8) -> Vec<u8> {
    let mut b = alloc::vec![0;36];
    b[..4].copy_from_slice(&crate::font_stream::GLYPH_MAGIC.to_le_bytes());
    b[4..8].copy_from_slice(&generation.to_le_bytes());
    b[8..12].copy_from_slice(&[2, 1, 8, 8]);
    b[12..16].copy_from_slice(&cp.to_le_bytes());
    b[16] = 8;
    b[18] = 1;
    b[20..].fill(coverage);
    b
}
fn streamed_ui(capacity: u16) -> (Ui, i32) {
    streamed_ui_at_rate(capacity, 60)
}
fn streamed_ui_at_rate(capacity: u16, hz: u32) -> (Ui, i32) {
    let mut ui = Ui::new();
    assert!(ui.set_tick_rate(hz));
    assert!(ui.load_font_atlas(&encode_atlas(
        2,
        8,
        8,
        7,
        10,
        2,
        &[(65, 1, 6), (0xfffd, 0, 8)]
    )));
    assert!(ui.font_stream_configure(&stream_config(1, capacity)));
    let text = ui.create_node(1);
    ui.insert_before(spec::ROOT_ID, text, 0);
    ui.set_prop(text, spec::prop::FONT_SLOT, 2.0);
    ui.set_text(text, "你好");
    ui.tick();
    ui.draw();
    (ui, text)
}
fn lease(generation: u32, slot: u8, id: u32, action: u8, text: &str) -> Vec<u8> {
    let mut b = alloc::vec![0; 16];
    b[..4].copy_from_slice(&crate::font_stream::BATCH_MAGIC.to_le_bytes());
    b[4..8].copy_from_slice(&generation.to_le_bytes());
    b[8] = slot;
    b[9] = action;
    b[12..16].copy_from_slice(&id.to_le_bytes());
    for cp in text.chars() {
        b.extend_from_slice(&(cp as u32).to_le_bytes());
    }
    b
}
#[test]
fn streamed_batches_reserve_union_before_io_and_pin_until_release() {
    for capacity in [2, 4] {
        let (mut ui, text) = streamed_ui(capacity);
        assert_eq!(
            ui.font_stream_requests(),
            "[]",
            "drawing must not submit demand"
        );
        assert_eq!(ui.font_stream_batch(&lease(1, 2, 1, 0, "A你你好")), 0);
        assert_eq!(ui.font_stream_batch(&lease(1, 2, 2, 0, "你")), 0);
        let excess = if capacity == 2 {
            "世界"
        } else {
            "世界文字"
        };
        assert_eq!(ui.font_stream_batch(&lease(1, 2, 3, 0, excess)), -2);
        assert!(!ui.font_stream_requests().contains("19990"));
        assert_eq!(ui.font_stream_commit(&stream_batch(1, '你' as u32, 255)), 1);
        assert_eq!(ui.font_stream_batch(&lease(1, 2, 1, 1, "")), 0);
        assert_eq!(ui.font_stream_batch(&lease(1, 2, 2, 1, "")), 1);
        ui.set_text(text, "A");
        ui.tick();
        ui.draw();
        assert_eq!(ui.font_stream_commit(&stream_batch(1, '好' as u32, 170)), 1);
        assert_eq!(ui.font_stream_batch(&lease(1, 2, 1, 1, "")), 1);
        assert_eq!(ui.font_stream_batch(&lease(1, 2, 1, 2, "")), 1);
        assert_eq!(
            ui.font_stream_batch(&lease(
                1,
                2,
                3,
                0,
                if capacity == 2 { "世" } else { "世界文" }
            )),
            0
        );
        assert_eq!(ui.font_stream_commit(&stream_batch(1, '世' as u32, 85)), 1);
        assert!(
            ui.font_atlas(2).unwrap().lookup('你' as u32).is_some(),
            "overlapping lease keeps its pin"
        );
        assert_eq!(ui.font_stream_batch(&lease(1, 2, 2, 1, "")), 1);
        assert_eq!(ui.measure_text("A世", 2), 14.0);
    }
}
#[test]
fn streamed_batches_reject_stale_corrupt_cancelled_and_unsupported_glyphs() {
    let (mut ui, _) = streamed_ui(4);
    assert_eq!(ui.font_stream_batch(&lease(1, 2, 1, 0, "你好")), 0);
    assert_eq!(ui.font_stream_commit(&stream_batch(2, '你' as u32, 255)), 0);
    let mut invalid = stream_batch(1, '你' as u32, 255);
    invalid[18] = 2;
    assert_eq!(ui.font_stream_commit(&invalid), 0);
    for n in 0..36 {
        assert_eq!(ui.font_stream_commit(&invalid[..n]), 0);
    }
    let mut absent = stream_batch(1, '你' as u32, 0);
    absent[18] = 0;
    ui.font_stream_commit(&absent);
    assert_eq!(ui.font_stream_batch(&lease(1, 2, 1, 1, "")), -1);
    assert!(!ui.font_stream_requests().contains("20320"));
    assert_eq!(ui.font_stream_batch(&lease(1, 2, 1, 2, "")), 1);
    assert_eq!(ui.font_stream_commit(&stream_batch(1, '好' as u32, 255)), 0);
    assert_eq!(ui.font_stream_requests(), "[]");
    assert!(ui.font_stream_configure(&stream_config(2, 4)));
    assert_eq!(ui.font_stream_batch(&lease(1, 2, 1, 1, "")), -3);
    assert_eq!(ui.font_stream_batch(&lease(2, 2, 1, 0, "你")), 0);
    assert!(ui.font_stream_requests().contains("20320"));
    assert!(ui.font_stream_configure(&stream_config(0, 0)));
    assert_eq!(ui.font_atlas(2).unwrap().glyph_count, 2);
    assert!(ui.font_atlas(2).unwrap().lookup(65).is_some());
}
#[test]
fn streamed_batches_validate_bounds_and_share_request_slots() {
    let (mut ui, _) = streamed_ui(128);
    assert!(ui.load_font_atlas(&encode_atlas(
        3,
        8,
        8,
        7,
        10,
        2,
        &[(0xfffd, 0, 8), (65, 1, 6)]
    )));
    let mut config = stream_config(1, 128);
    config[8] = 3;
    assert!(ui.font_stream_configure(&config));
    let text: String = (0x4e00..0x4e64)
        .map(|cp| char::from_u32(cp).unwrap())
        .collect();
    for slot in [2, 3] {
        assert_eq!(ui.font_stream_batch(&lease(1, slot, 1, 0, &text)), 0);
    }
    let first = ui.font_stream_requests();
    let second = ui.font_stream_requests();
    assert!(first.contains("[1,2,19968]"));
    assert!(first.contains("[1,3,19968]"));
    assert!(!second.contains("19968"));
    assert!(second.contains("[1,2,19984]"));
    let valid = lease(1, 2, 2, 0, "A");
    for n in 0..16 {
        assert_eq!(ui.font_stream_batch(&valid[..n]), -3);
    }
    assert_eq!(ui.font_stream_batch(&lease(1, 2, 0, 0, "A")), -3);
    assert_eq!(ui.font_stream_batch(&lease(1, 2, 1, 0, "A")), -3);
    config[18] = 1;
    assert!(!ui.font_stream_configure(&config));
}

#[test]
fn streamed_detach_reclaims_capacity_and_restores_baked_cells_across_slots() {
    let mut ui = Ui::new();
    for slot in 0..4 {
        let mut atlas = encode_atlas(
            slot,
            8,
            8,
            7,
            10,
            2,
            &[(65, 1, 6), (0xfffd, 0, 8)]
        );
        for (i, pixel) in atlas[32..].iter_mut().enumerate() {
            *pixel = (i + 1) as u8;
        }
        assert!(ui.load_font_atlas(&atlas));
    }
    let baked = ui.font_atlas(0).unwrap().bitmap.clone();
    let baseline: usize = (0..4)
        .map(|s| ui.font_atlas(s).unwrap().bitmap.capacity())
        .sum();
    for generation in 1..=3 {
        for slot in 0..4 {
            let mut config = stream_config(generation, 4096);
            config[8] = slot;
            config[9] = 32;
            config[10] = 16;
            assert!(ui.font_stream_configure(&config));
            // Reopening the same slot must remember the original baked geometry.
            config[4..8].copy_from_slice(&(generation + 10).to_le_bytes());
            assert!(ui.font_stream_configure(&config));
            config[4..8].fill(0);
            config[16..18].fill(0);
            assert!(ui.font_stream_configure(&config));
            let actual: usize = (0..4)
                .map(|s| ui.font_atlas(s).unwrap().bitmap.capacity())
                .sum();
            assert_eq!(
                actual, baseline,
                "released slots must not hide retained bitmap allocations"
            );
            let atlas = ui.font_atlas(slot).unwrap();
            assert_eq!((atlas.cell_w, atlas.cell_h), (8, 8));
            assert_eq!(atlas.bitmap, baked);
            assert_eq!(atlas.cmap.capacity(), atlas.cmap.len());
            assert!(ui.font_stream_stats().contains("\"bytes\":0"));
            assert_eq!(ui.measure_text("AA", slot), 12.0);
        }
    }
}

#[test]
fn cached_text_layout_tracks_all_placement_inputs_and_nested_text() {
    let mut ui = Ui::new();
    for slot in [0, 1] {
        assert!(ui.load_font_atlas(&encode_atlas(slot, 8, 8, 7, 10, 2,
            &[('A' as u32, 0, 6 + slot), ('B' as u32, 1, 5)])));
    }
    let text = ui.create_node(spec::NodeType::Text as u8);
    let child = ui.create_node(spec::NodeType::Text as u8);
    ui.set_text(text, "AB"); ui.set_text(child, "BA");
    ui.insert_before(text, child, 0); ui.insert_before(spec::ROOT_ID, text, 0);
    ui.set_prop(text, spec::prop::WIDTH, 100.0);
    ui.set_prop(text, spec::prop::HEIGHT, 50.0);
    ui.tick(); ui.draw();
    fn compare(ui: &mut Ui) {
        let cached = ui.draw().words.clone();
        ui.paint_cache.clear_text_layouts();
        assert_eq!(ui.draw().words, cached);
        assert!(ui.paint_cache.text_layout_usage().0 > 0);
    }
    compare(&mut ui);
    for (p, v) in [(spec::prop::TEXT_ALIGN, spec::TextAlign::Center as u8 as f64),
        (spec::prop::WIDTH, 140.0), (spec::prop::TRACKING, 2.0),
        (spec::prop::LINE_HEIGHT, 18.0), (spec::prop::FONT_SLOT, 1.0),
        (spec::prop::SCALE, 0.7), (spec::prop::TRANSLATE_X, 22.0)] {
        ui.set_prop(text, p, v); ui.tick(); compare(&mut ui);
    }
    ui.set_text(child, "A\nB"); ui.tick(); compare(&mut ui);
    assert!(ui.load_font_atlas(&encode_atlas(1, 8, 8, 7, 10, 2,
        &[('A' as u32, 0, 3), ('B' as u32, 1, 7)])));
    ui.tick(); compare(&mut ui);
}

#[test]
fn text_layout_cache_is_bounded_and_preserves_missing_glyph_counts() {
    let mut ui = Ui::new();
    assert!(ui.load_font_atlas(&encode_atlas(0, 8, 8, 7, 10, 1, &[('A' as u32, 0, 6)])));
    let text = ui.create_node(spec::NodeType::Text as u8);
    ui.set_prop(text, spec::prop::WIDTH, 480.0);
    ui.insert_before(spec::ROOT_ID, text, 0);
    for count in 1..200 {
        ui.set_text(text, &"A".repeat(count)); ui.tick(); ui.draw();
        let (entries, glyphs, bytes) = ui.paint_cache.text_layout_usage();
        assert!(entries > 0 && entries <= 256 && glyphs <= 16384 && bytes <= 256 * 256);
    }
    ui.set_text(text, "AZ"); ui.tick();
    let before = ui.glyph_misses(); ui.draw();
    let after = ui.glyph_misses(); ui.draw();
    assert_eq!(after - before, 1);
    assert_eq!(ui.glyph_misses() - after, 1);
}

#[test]
fn indexed_text_layout_cache_evicts_and_revalidates_recycled_nodes() {
    let mut ui = Ui::new();
    assert!(ui.load_font_atlas(&encode_atlas(0, 8, 8, 7, 10, 2,
        &[('A' as u32, 0, 6), ('B' as u32, 1, 7)])));
    let mut nodes = Vec::new();
    for i in 0..300 {
        let text = ui.create_node(spec::NodeType::Text as u8);
        ui.set_text(text, &"A".repeat(40 + i % 100));
        ui.set_prop(text, spec::prop::WIDTH, 480.0);
        ui.set_prop(text, spec::prop::HEIGHT, 10.0);
        ui.set_prop(text, spec::prop::POS_TYPE, spec::PosType::Absolute as u32 as f64);
        ui.insert_before(spec::ROOT_ID, text, 0);
        nodes.push(text);
    }
    ui.tick();
    let before = ui.draw().words.clone();
    let (entries, glyphs, bytes) = ui.paint_cache.text_layout_usage();
    assert!(entries > 0 && entries <= 256);
    assert!(glyphs <= 16_384 && bytes <= 256 * 256);
    assert_eq!(ui.draw().words, before, "eviction does not change placements");
    for node in nodes { ui.destroy_node(node); }
    let replacement = ui.create_node(spec::NodeType::Text as u8);
    ui.set_text(replacement, "BABA");
    ui.insert_before(spec::ROOT_ID, replacement, 0);
    ui.tick();
    let recycled = ui.draw().words.clone();
    ui.paint_cache.clear_text_layouts();
    assert_eq!(ui.draw().words, recycled, "recycled slots validate text and layout inputs");
}
