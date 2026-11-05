//! Retained layout versus a fresh Taffy tree. Every step applies the same
//! mutations to two `Ui`s, rebuilds the second one's solver, and compares
//! layout bits, draw words, pixels, hit tests and focus.
#![cfg(feature = "counters")]

use pocketjs_core::spec::prop::*;
use pocketjs_core::{spec, Ui};

const FILL: u32 = 0xff22_3344;

/// A version-3 atlas for slot 0 that maps 'a' and 'b' to 5x8 cells with a
/// 9 px line height. Every other codepoint is a glyph miss.
fn atlas(advance: u8) -> Vec<u8> {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(&spec::font_atlas::MAGIC.to_le_bytes());
    bytes.extend_from_slice(&spec::font_atlas::VERSION.to_le_bytes());
    bytes.extend_from_slice(&2u16.to_le_bytes());
    // cell 5x8, baseline 6, line height 9, slot 0, flags 0, density 1
    bytes.extend_from_slice(&[5, 8, 6, 9, 0, 0, 1, 0]);
    for (gid, cp) in [b'a', b'b'].into_iter().enumerate() {
        bytes.extend_from_slice(&(cp as u32).to_le_bytes());
        bytes.extend_from_slice(&(gid as u16).to_le_bytes());
        bytes.extend_from_slice(&[advance, 0]);
    }
    bytes.extend_from_slice(&[255; 2 * 5 * 8]);
    bytes
}

fn set(ui: &mut Ui, id: i32, props: &[(u8, f64)]) {
    for &(prop, value) in props {
        ui.set_prop(id, prop, value);
    }
}

/// A column View filled with `FILL`, inserted as the first child of `parent`.
fn view(ui: &mut Ui, parent: i32, width: Option<f64>, height: Option<f64>) -> i32 {
    let id = ui.create_node(spec::NodeType::View as u8);
    set(ui, id, &[(spec::prop::FLEX_DIR, spec::FlexDir::Col as u8 as f64), (spec::prop::BG_COLOR, FILL as f64)]);
    if let Some(width) = width {
        ui.set_prop(id, spec::prop::WIDTH, width);
    }
    if let Some(height) = height {
        ui.set_prop(id, spec::prop::HEIGHT, height);
    }
    ui.insert_before(parent, id, 0);
    id
}

fn text(ui: &mut Ui, parent: i32, run: &str) -> i32 {
    let id = ui.create_node(spec::NodeType::Text as u8);
    ui.set_text(id, run);
    ui.insert_before(parent, id, 0);
    id
}

fn row(ui: &mut Ui, id: i32) {
    ui.set_prop(id, spec::prop::FLEX_DIR, spec::FlexDir::Row as u8 as f64);
}

type Snapshot = Vec<(i32, u8, String, Vec<i32>, [u32; 4])>;

fn snapshot(ui: &Ui, root: i32) -> Snapshot {
    let mut nodes = Vec::new();
    let mut pending = vec![root];
    while let Some(id) = pending.pop() {
        let (x, y, w, h) = ui.layout_of(id).unwrap();
        let children = ui.node_children(id).to_vec();
        pending.extend(children.iter().rev());
        let text = ui.node_text(id).unwrap().to_owned();
        nodes.push((id, ui.node_type(id).unwrap(), text, children, [x, y, w, h].map(f32::to_bits)));
    }
    nodes
}

fn pixels(ui: &Ui, words: &[u32]) -> Vec<u8> {
    let (width, height) = ui.viewport();
    let mut pixels = vec![0; width as usize * height as usize * 4];
    pocket_raster::render(ui, words, &mut pixels);
    pixels
}

/// `live` keeps its retained solver; `fresh` rebuilds it before every check.
struct Pair {
    live: Ui,
    fresh: Ui,
}

impl Pair {
    fn new() -> Self {
        let make = || {
            let mut ui = Ui::new();
            ui.set_viewport(160.0, 120.0);
            assert!(ui.load_font_atlas(&atlas(5)));
            ui
        };
        Self { live: make(), fresh: make() }
    }

    /// Identical mutations allocate identical node IDs on both sides.
    fn edit<T: PartialEq + core::fmt::Debug>(&mut self, mut f: impl FnMut(&mut Ui) -> T) -> T {
        let result = f(&mut self.live);
        assert_eq!(result, f(&mut self.fresh));
        result
    }

    fn check(&mut self, step: &str) {
        self.fresh.force_layout_rebuild_for_validation();
        let live = self.live.draw().words.clone();
        let fresh = self.fresh.draw().words.clone();
        assert_eq!(snapshot(&self.live, spec::ROOT_ID), snapshot(&self.fresh, spec::ROOT_ID), "{step}: layout");
        assert_eq!(live, fresh, "{step}: draw words");
        assert_eq!(pixels(&self.live, &live), pixels(&self.fresh, &fresh), "{step}: pixels");
        for (x, y) in [(0.0, 0.0), (7.0, 7.0), (41.0, 17.0), (79.0, 47.0), (159.0, 119.0)] {
            assert_eq!(self.live.hit_test(x, y), self.fresh.hit_test(x, y), "{step}: hit");
            assert_eq!(self.live.hit_test_bounds(x, y), self.fresh.hit_test_bounds(x, y), "{step}: bounds hit");
        }
        assert_eq!(self.live.focused(), self.fresh.focused(), "{step}: focus");
        let auxiliary = self.live.auxiliary_surface_root();
        if auxiliary != 0 {
            let live = self.live.draw_auxiliary().unwrap().words.clone();
            assert_eq!(&live, &self.fresh.draw_auxiliary().unwrap().words, "{step}: auxiliary words");
            assert_eq!(snapshot(&self.live, auxiliary), snapshot(&self.fresh, auxiliary), "{step}: auxiliary layout");
            let hit = self.live.hit_test_bounds_auxiliary(7.0, 7.0);
            assert_eq!(hit, self.fresh.hit_test_bounds_auxiliary(7.0, 7.0), "{step}: auxiliary hit");
        }
    }

    fn width(&self, id: i32) -> f32 {
        self.live.layout_of(id).unwrap().2
    }

    fn height(&self, id: i32) -> f32 {
        self.live.layout_of(id).unwrap().3
    }
}

fn image(ui: &mut Ui, parent: i32, color: u32) -> i32 {
    let id = ui.create_node(spec::NodeType::Image as u8);
    set(ui, id, &[(WIDTH, 32.0), (HEIGHT, 32.0), (BG_COLOR, color as f64)]);
    ui.insert_before(parent, id, 0);
    id
}

#[test]
fn show_swap_reuses_unrelated_solver_nodes_and_text() {
    let mut pair = Pair::new();
    let (container, label, mut shown) = pair.edit(|ui| {
        let outer = view(ui, spec::ROOT_ID, Some(120.0), None);
        row(ui, outer);
        let label = text(ui, outer, "ababab");
        let container = view(ui, outer, Some(32.0), Some(32.0));
        (container, label, image(ui, container, 0))
    });
    pair.check("initial");
    let label_rect = pair.live.layout_of(label);
    let solver_nodes = pair.live.layout_counters().taffy_nodes;
    for phase in 0..8 {
        pair.live.reset_counters();
        pair.fresh.reset_counters();
        shown = pair.edit(|ui| {
            ui.destroy_node(shown); // Show unmounts; the replacement gets a new generation.
            image(ui, container, 0xff00_0010 + phase)
        });
        pair.check(&format!("swap {phase}"));
        let work = pair.live.layout_counters();
        assert_eq!((work.structure_rebuilds, work.structure_syncs, work.layout_passes), (0, 1, 1));
        assert_eq!(work.taffy_nodes_created, 1, "only the new image gets a solver node");
        assert_eq!(work.taffy_nodes, solver_nodes, "the destroyed image leaves no solver node");
        assert_eq!(work.shaping_calls, 0, "the sibling label is not reshaped");
        assert!(work.measure_callbacks < pair.fresh.layout_counters().measure_callbacks);
        assert_eq!(pair.live.layout_of(label), label_rect);
    }
}

#[test]
fn inserted_siblings_and_viewport_resizes_propagate_flex_constraints() {
    let mut pair = Pair::new();
    let (parent, left, right, label) = pair.edit(|ui| {
        let parent = view(ui, spec::ROOT_ID, Some(100.0), None);
        row(ui, parent);
        let left = view(ui, parent, Some(80.0), None);
        let right = view(ui, parent, Some(80.0), None);
        let label = text(ui, left, "ab");
        text(ui, right, "ba");
        (parent, left, right, label)
    });
    pair.check("two columns shrink to fit");
    assert_eq!((pair.width(left), pair.width(right)), (50.0, 50.0));
    let third = pair.edit(|ui| view(ui, parent, Some(80.0), Some(17.0)));
    pair.check("third column");
    assert!(pair.width(left) < 50.0);
    assert_eq!(pair.height(parent), 17.0);
    pair.edit(|ui| {
        ui.set_text(label, "abababababab");
        ui.set_prop(right, MIN_W, 27.25);
        set(ui, parent, &[(WIDTH, 99.5), (PADDING_L, 0.25)]);
    });
    pair.check("intrinsic minimum and fractional constraints");
    pair.edit(|ui| ui.destroy_node(third));
    pair.check("auto height shrinks after deletion");
    for width in [80.0, 160.0, 121.0] {
        pair.edit(|ui| {
            ui.set_prop(parent, WIDTH, -1.0); // 100% of the viewport
            ui.set_viewport(width, 120.0);
        });
        pair.check("viewport resize");
    }
}

#[test]
fn inline_text_runs_and_empty_text_match_fresh_collection() {
    let mut pair = Pair::new();
    let (first, second, inline) = pair.edit(|ui| {
        let parent = view(ui, spec::ROOT_ID, None, None);
        row(ui, parent);
        let first = text(ui, parent, "a");
        let inline = text(ui, first, "b");
        (first, text(ui, parent, ""), inline)
    });
    pair.check("inline run beside an empty text");
    assert_eq!(pair.width(first), 10.0);
    for run in ["", "abba", "a"] {
        pair.edit(|ui| ui.set_text(inline, run));
        pair.check("inline content changes");
    }
    pair.edit(|ui| ui.insert_before(second, inline, 0));
    pair.check("inline moves into the empty text");
    pair.edit(|ui| ui.set_text(first, ""));
    pair.check("top-level text becomes empty");
    assert_eq!(pair.width(first), 0.0);
    let nested = pair.edit(|ui| text(ui, inline, "bab"));
    pair.check("nested inline insertion");
    pair.edit(|ui| ui.destroy_node(nested));
    pair.check("nested inline deletion");
    pair.edit(|ui| ui.remove_child(second, inline));
    pair.check("last inline removed");
    pair.edit(|ui| {
        ui.set_text(inline, "abab");
        ui.insert_before(first, inline, 0);
    });
    pair.check("detached inline edited and reattached");
}

#[test]
fn moves_detached_edits_and_reused_slots_match() {
    let mut pair = Pair::new();
    let (left, right, moving, label, anchor) = pair.edit(|ui| {
        let left = view(ui, spec::ROOT_ID, Some(70.0), None);
        let right = view(ui, spec::ROOT_ID, Some(95.0), None);
        let moving = view(ui, left, None, None);
        let label = text(ui, moving, "ab");
        (left, right, moving, label, view(ui, right, Some(20.0), Some(11.0)))
    });
    pair.check("initial");
    pair.edit(|ui| ui.insert_before(right, moving, anchor));
    pair.check("move before a sibling in another parent");
    pair.edit(|ui| ui.insert_before(right, moving, 0));
    pair.check("reorder within the parent");
    pair.edit(|ui| ui.remove_child(right, moving));
    pair.check("detached subtree leaves the solver");
    pair.edit(|ui| {
        ui.set_text(label, "abababab");
        ui.set_prop(moving, PADDING_T, 3.5);
        ui.insert_before(left, moving, 0);
        ui.set_focus(label);
    });
    pair.check("edited while detached, then reattached");
    pair.edit(|ui| ui.destroy_node(moving));
    pair.check("focused subtree destroyed");
    assert_eq!(pair.live.focused(), 0);
    let replacement = pair.edit(|ui| text(ui, right, "b"));
    let slot = |id: i32| id as u32 & spec::ID_SLOT_MASK;
    assert!(![moving, label].contains(&replacement));
    assert!([moving, label].map(slot).contains(&slot(replacement)), "must reuse a freed slot");
    pair.edit(|ui| {
        ui.set_text(label, "stale generation");
        ui.insert_before(left, moving, 0);
    });
    pair.check("stale IDs for a reused slot are ignored");
}

#[test]
fn auxiliary_moves_resizes_and_font_replacement_update_both_solvers() {
    let mut pair = Pair::new();
    let (main, auxiliary, side, label, side_label) = pair.edit(|ui| {
        let main = view(ui, spec::ROOT_ID, None, None);
        let auxiliary = ui.create_auxiliary_surface(71.0, 43.0);
        let side = view(ui, auxiliary, None, None);
        row(ui, main);
        row(ui, side);
        let label = text(ui, main, "ababa");
        (main, auxiliary, side, label, text(ui, side, "bb"))
    });
    pair.check("two output roots");
    for destination in [side, main, side, main] {
        pair.edit(|ui| ui.insert_before(destination, label, 0));
        pair.check("text moves between outputs");
    }
    pair.edit(|ui| {
        ui.set_viewport(123.0, 97.0);
        assert_eq!(ui.create_auxiliary_surface(53.0, 39.0), auxiliary);
    });
    pair.check("independent viewport resizes");
    pair.edit(|ui| assert!(ui.load_font_atlas(&atlas(7))));
    pair.check("font replacement");
    assert_eq!((pair.width(label), pair.width(side_label)), (35.0, 14.0));
    pair.edit(|ui| {
        use pocketjs_core::assets::{AssetInput, AssetKind};
        let mut handles = [123];
        let font = atlas(3);
        let assets = [AssetInput { kind: AssetKind::Font, bytes: &font }];
        ui.load_assets(&assets, &mut handles).unwrap();
        assert_eq!(handles, [-1]);
    });
    pair.check("atomic asset replacement");
    assert_eq!((pair.width(label), pair.width(side_label)), (15.0, 6.0));
    pair.edit(|ui| {
        ui.set_prop(side, DISPLAY, spec::Display::None as u8 as f64);
        text(ui, side, "abab");
    });
    pair.check("hidden auxiliary subtree gains text");
    pair.edit(|ui| ui.set_prop(side, DISPLAY, spec::Display::Flex as u8 as f64));
    pair.check("auxiliary subtree becomes visible");
}

#[test]
fn nodes_moved_into_a_hidden_subtree_take_the_hidden_layout() {
    // Taffy lays out display:none subtrees without caching them, so a retained
    // node attached there must still invalidate the hidden ancestor.
    let mut pair = Pair::new();
    let (hidden, inner, moving) = pair.edit(|ui| {
        let hidden = view(ui, spec::ROOT_ID, None, None);
        ui.set_prop(hidden, DISPLAY, spec::Display::None as u8 as f64);
        let inner = view(ui, hidden, None, None);
        (hidden, inner, view(ui, spec::ROOT_ID, Some(20.0), Some(20.0)))
    });
    pair.check("visible sibling");
    pair.edit(|ui| ui.remove_child(spec::ROOT_ID, moving));
    pair.check("detached");
    pair.edit(|ui| ui.insert_before(inner, moving, 0));
    pair.check("reattached inside the hidden subtree");
    assert_eq!(pair.live.layout_of(moving), Some((0.0, 0.0, 0.0, 0.0)));
    pair.edit(|ui| ui.insert_before(spec::ROOT_ID, moving, 0));
    pair.check("moved back out");
    assert_eq!(pair.width(moving), 20.0);
    pair.edit(|ui| ui.insert_before(inner, moving, 0));
    pair.check("moved into the hidden subtree in one flush");
    pair.edit(|ui| ui.set_prop(hidden, DISPLAY, spec::Display::Flex as u8 as f64));
    pair.check("hidden subtree shown");
}

/// A native text provider: `char_width` per character, 12 px lines.
fn measure(char_width: f32) -> pocketjs_core::text::MeasureFn {
    Box::new(move |text, _, _, line_height| {
        let height = if line_height.is_nan() { 12.0 } else { line_height };
        (text.chars().count() as f32 * char_width, height)
    })
}

#[test]
fn transformed_ancestors_and_provider_replacement_select_the_measurer() {
    // The native provider measures 12 px lines; transformed text uses the 9 px atlas.
    let mut pair = Pair::new();
    let (plain, transformed, label) = pair.edit(|ui| {
        ui.set_text_measure(Some(measure(7.0)));
        let plain = view(ui, spec::ROOT_ID, None, None);
        let transformed = view(ui, spec::ROOT_ID, None, None);
        ui.set_prop(transformed, SCALE, 0.75);
        (plain, transformed, text(ui, plain, "ab"))
    });
    pair.check("native provider");
    assert_eq!(pair.height(label), 12.0);
    pair.edit(|ui| ui.insert_before(transformed, label, 0));
    pair.check("moved beneath a transform");
    assert_eq!(pair.height(label), 9.0);
    pair.edit(|ui| ui.insert_before(plain, label, 0));
    pair.check("moved back");
    for angle in [25.0, 0.0, -15.0, 0.0] {
        pair.edit(|ui| ui.set_prop(plain, ROTATE, angle));
        pair.check("ancestor rotation");
        assert_eq!(pair.height(label), if angle == 0.0 { 12.0 } else { 9.0 });
    }
    pair.edit(|ui| ui.set_text_measure(Some(measure(11.0))));
    pair.check("provider replaced");
    pair.edit(|ui| ui.set_text_measure(None));
    pair.check("provider removed");
    assert_eq!(pair.height(label), 9.0);
}

/// Two styles whose base, focus and active variants differ only in color.
fn paint_styles() -> Vec<u8> {
    use spec::style_table::*;
    let mut bytes = Vec::new();
    bytes.extend_from_slice(&MAGIC.to_le_bytes());
    bytes.extend_from_slice(&VERSION.to_le_bytes());
    bytes.extend_from_slice(&2u16.to_le_bytes());
    bytes.extend_from_slice(&[0; 4]); // no animations; reserved
    for base in [0xff00_00ffu32, 0xffff_0000] {
        bytes.push(VARIANT_BASE | VARIANT_FOCUS | VARIANT_ACTIVE);
        for color in [base, 0xff00_ff00, 0xffff_ffff] {
            bytes.extend_from_slice(&[1, BG_COLOR, 0]);
            bytes.extend_from_slice(&color.to_le_bytes());
        }
    }
    bytes
}

#[test]
fn paint_only_changes_skip_the_solver_and_text_measurement() {
    let mut pair = Pair::new();
    let label = pair.edit(|ui| {
        assert!(ui.load_styles(&paint_styles()));
        let label = text(ui, spec::ROOT_ID, "ababa");
        ui.set_style(label, 0);
        label
    });
    pair.check("base style");
    let layout = snapshot(&pair.live, spec::ROOT_ID);
    for step in 0..6 {
        pair.live.reset_counters();
        pair.edit(|ui| match step {
            0 => ui.set_focus(label),
            1 => ui.set_active(label, true),
            2 => ui.set_active(label, false),
            3 => ui.set_focus(0),
            4 => ui.set_style(label, 1),
            _ => ui.set_prop(label, TEXT_COLOR, 0xff11_2233u32 as f64),
        });
        pair.check("paint-only change");
        assert_eq!(snapshot(&pair.live, spec::ROOT_ID), layout);
        let work = pair.live.layout_counters();
        let solver_work = [work.structure_rebuilds, work.style_updates, work.taffy_nodes_created, work.layout_passes];
        assert_eq!((solver_work, work.shaping_calls), ([0; 4], 0), "step {step}");
    }
}

#[test]
fn retained_measurements_keep_glyph_miss_counts() {
    let mut pair = Pair::new();
    let container = pair.edit(|ui| {
        text(ui, spec::ROOT_ID, "a?a"); // '?' is not in the atlas
        view(ui, spec::ROOT_ID, Some(32.0), Some(32.0))
    });
    pair.check("initial");
    assert!(pair.live.glyph_misses() > 0);
    for _ in 0..4 {
        let child = pair.edit(|ui| view(ui, container, Some(10.0), Some(10.0)));
        pair.check("unrelated insertion");
        assert_eq!(pair.live.glyph_misses(), pair.fresh.glyph_misses());
        pair.edit(|ui| ui.destroy_node(child));
        pair.check("unrelated deletion");
        assert_eq!(pair.live.glyph_misses(), pair.fresh.glyph_misses());
    }
}

#[test]
fn detached_text_is_remeasured_after_environment_changes() {
    let mut pair = Pair::new();
    let (parent, label) = pair.edit(|ui| {
        let parent = view(ui, spec::ROOT_ID, None, None);
        row(ui, parent);
        (parent, text(ui, parent, "ab"))
    });
    pair.check("initial");
    assert_eq!(pair.width(label), 10.0);
    for (phase, expected) in [14.0, 22.0, 26.0].into_iter().enumerate() {
        pair.edit(|ui| ui.remove_child(parent, label));
        pair.check("detached");
        pair.edit(|ui| match phase {
            0 => assert!(ui.load_font_atlas(&atlas(7))),
            1 => ui.set_text_measure(Some(measure(11.0))),
            _ => ui.set_text_measure(Some(measure(13.0))),
        });
        pair.check("environment changed while detached");
        pair.edit(|ui| ui.insert_before(parent, label, 0));
        pair.check("reattached");
        assert_eq!(pair.width(label), expected);
    }
}

#[test]
fn swapping_parent_and_child_in_one_flush_leaves_no_solver_cycle() {
    let mut pair = Pair::new();
    let (mut parent, mut child) = pair.edit(|ui| {
        let parent = view(ui, spec::ROOT_ID, None, None);
        let child = view(ui, parent, None, None);
        text(ui, child, "abab");
        (parent, child)
    });
    pair.check("initial");
    for _ in 0..8 {
        pair.edit(|ui| {
            ui.insert_before(spec::ROOT_ID, child, 0);
            ui.insert_before(child, parent, 0);
        });
        pair.check("former parent moved below its former child");
        core::mem::swap(&mut parent, &mut child);
    }
}

#[test]
fn seeded_mixed_mutations_match_a_fresh_solver_every_frame() {
    let mut pair = Pair::new();
    let (parents, mut leaves) = pair.edit(|ui| {
        ui.set_text_measure(Some(measure(7.0)));
        let parent = view(ui, spec::ROOT_ID, None, None);
        row(ui, parent);
        let left = view(ui, parent, Some(75.5), None);
        let right = view(ui, parent, Some(90.25), None);
        let parents = [left, right, text(ui, left, "a"), text(ui, right, "b")];
        let leaves: Vec<i32> = (0..6).map(|i| text(ui, parents[i % 4], "ab")).collect();
        (parents, leaves)
    });
    pair.check("initial");
    let mut seed = 0x6a09_e667u32;
    for step in 0..96 {
        seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        let pick = (seed >> 16) as usize;
        let index = pick % leaves.len();
        let leaf = leaves[index];
        let destination = parents[(pick / 7) % parents.len()];
        let view_parent = parents[pick % 2];
        let even_round = (step / 12) % 2 == 0;
        match step % 12 {
            0 => pair.edit(|ui| ui.set_text(leaf, ["", "a", "abababab", "ab\nba"][pick % 4])),
            1 => pair.edit(|ui| ui.insert_before(destination, leaf, 0)),
            2 => pair.edit(|ui| match ui.node_parent(leaf) {
                0 => {}
                parent => ui.remove_child(parent, leaf),
            }),
            3 => {
                leaves[index] = pair.edit(|ui| {
                    ui.destroy_node(leaf);
                    let replacement = text(ui, destination, "baba");
                    ui.set_text(leaf, "ignored stale generation");
                    replacement
                })
            }
            4 => pair.edit(|ui| ui.set_prop(view_parent, WIDTH, 42.25 + (pick % 45) as f64)),
            5 => pair.edit(|ui| {
                let display = if even_round { spec::Display::None } else { spec::Display::Flex };
                ui.set_prop(view_parent, DISPLAY, display as u8 as f64)
            }),
            6 => pair.edit(|ui| ui.set_prop(view_parent, ROTATE, if even_round { 17.0 } else { 0.0 })),
            7 => pair.edit(|ui| ui.set_viewport(100.0 + (pick % 61) as f32, 120.0)),
            8 => pair.edit(|ui| ui.set_prop(leaf, TRACKING, (pick % 3) as f64)),
            9 => pair.edit(|ui| assert!(ui.load_font_atlas(&atlas(4 + (pick % 4) as u8)))),
            10 => pair.edit(|ui| {
                let children = ui.node_children(destination);
                let anchor = children.iter().copied().find(|id| *id != leaf).unwrap_or(0);
                ui.insert_before(destination, leaf, anchor);
            }),
            _ => pair.edit(|ui| {
                let provider = (!even_round).then(|| measure(6.0 + (pick % 4) as f32));
                ui.set_text_measure(provider)
            }),
        }
        pair.check(&format!("step {step}, seed {seed:08x}"));
    }
}
