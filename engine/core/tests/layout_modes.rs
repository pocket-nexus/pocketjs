//! Regions, static nodes and formula nodes against the full-tree oracle
//! (`Ui::layout_mismatches`): every mode must produce the bits one fresh
//! solve of the whole tree produces, while touching only its own subtree.
#![cfg(feature = "counters")]

use pocketjs_core::spec::{self, prop};
use pocketjs_core::tree::{LAYOUT_FORMULA, LAYOUT_LIVE, LAYOUT_STATIC};
use pocketjs_core::Ui;

/// A version-3 atlas for slot 0 that maps 'a' and 'b' to 5x8 cells with a
/// 9 px line height.
fn atlas(advance: u8) -> Vec<u8> {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(&spec::font_atlas::MAGIC.to_le_bytes());
    bytes.extend_from_slice(&spec::font_atlas::VERSION.to_le_bytes());
    bytes.extend_from_slice(&2u16.to_le_bytes());
    bytes.extend_from_slice(&[5, 8, 6, 9, 0, 0, 1, 0]);
    for (gid, cp) in b"ab".iter().enumerate() {
        bytes.extend_from_slice(&(*cp as u32).to_le_bytes());
        bytes.extend_from_slice(&(gid as u16).to_le_bytes());
        bytes.extend_from_slice(&[advance, 0]);
    }
    bytes.extend_from_slice(&[255; 2 * 5 * 8]);
    bytes
}

fn ui() -> Ui {
    let mut ui = Ui::new();
    ui.set_viewport(240.0, 160.0);
    assert!(ui.load_font_atlas(&atlas(5)));
    ui
}

fn set(ui: &mut Ui, id: i32, props: &[(u8, f64)]) {
    for &(prop, value) in props {
        ui.set_prop(id, prop, value);
    }
}

/// A view appended under `parent` with the given props.
fn view(ui: &mut Ui, parent: i32, props: &[(u8, f64)]) -> i32 {
    let id = ui.create_node(spec::NodeType::View as u8);
    set(ui, id, props);
    ui.insert_before(parent, id, 0);
    id
}

fn text(ui: &mut Ui, parent: i32, run: &str) -> i32 {
    let id = ui.create_node(spec::NodeType::Text as u8);
    ui.set_text(id, run);
    ui.insert_before(parent, id, 0);
    id
}

fn rect(ui: &Ui, id: i32) -> (f32, f32, f32, f32) {
    ui.layout_of(id).unwrap()
}

fn solved(ui: &mut Ui) {
    ui.tick();
    let mismatches = ui.layout_mismatches();
    assert!(
        mismatches.is_empty(),
        "layout differs from the full tree: {mismatches:?}"
    );
}

const ABS: f64 = spec::PosType::Absolute as u8 as f64;
const ROW: f64 = spec::FlexDir::Row as u8 as f64;
const STRICT: f64 = spec::Contain::Strict as u8 as f64;
const NONE: f64 = spec::Contain::None as u8 as f64;

#[test]
fn static_subtrees_have_no_solver_nodes_and_ignore_layout_marks() {
    let mut ui = ui();
    let page = view(
        &mut ui,
        spec::ROOT_ID,
        &[(prop::WIDTH, -1.0), (prop::HEIGHT, -1.0)],
    );
    ui.set_layout_mode(page, LAYOUT_STATIC, 0.0, 0.0, 240.0, 160.0);
    let card = view(
        &mut ui,
        page,
        &[
            (prop::POS_TYPE, ABS),
            (prop::INSET_L, 8.0),
            (prop::INSET_T, 8.0),
            (prop::WIDTH, 24.0),
            (prop::HEIGHT, 24.0),
        ],
    );
    ui.set_layout_mode(card, LAYOUT_STATIC, 8.0, 8.0, 24.0, 24.0);
    let label = text(&mut ui, card, "ab");
    ui.set_layout_mode(label, LAYOUT_STATIC, 0.0, 0.0, 10.0, 24.0);
    solved(&mut ui);
    assert_eq!(
        ui.layout_counters().taffy_nodes,
        1,
        "only the output root is a solver node"
    );
    assert_eq!(rect(&ui, card), (8.0, 8.0, 24.0, 24.0));
    assert_eq!(rect(&ui, label), (0.0, 0.0, 10.0, 24.0));
    assert_eq!(ui.layout_mode(card), Some(LAYOUT_STATIC));

    // Marks on static nodes and structure under them cost no solver work.
    ui.reset_counters();
    ui.set_prop(card, prop::WIDTH, 99.0);
    ui.set_text(label, "b");
    let extra = ui.create_node(spec::NodeType::View as u8);
    ui.set_layout_mode(extra, LAYOUT_STATIC, 1.0, 2.0, 3.0, 4.0);
    ui.insert_before(card, extra, 0);
    ui.set_prop(extra, prop::HEIGHT, 50.0);
    ui.tick();
    let work = ui.layout_counters();
    assert_eq!(
        (work.layout_passes, work.structure_syncs, work.style_updates),
        (0, 0, 0)
    );
    assert_eq!(rect(&ui, card), (8.0, 8.0, 24.0, 24.0));
    assert_eq!(rect(&ui, extra), (1.0, 2.0, 3.0, 4.0));
    ui.destroy_node(extra);
    ui.tick();
    assert_eq!(ui.layout_counters().layout_passes, 0);

    // Back to live: the subtree re-enters the projection and the solver agrees
    // with the rects the compiler assigned.
    ui.set_prop(card, prop::WIDTH, 24.0);
    ui.set_text(label, "ab");
    for id in [page, card, label] {
        ui.set_layout_mode(id, LAYOUT_LIVE, 0.0, 0.0, 0.0, 0.0);
    }
    solved(&mut ui);
    assert_eq!(rect(&ui, card), (8.0, 8.0, 24.0, 24.0));
    assert_eq!(rect(&ui, label), (0.0, 0.0, 10.0, 24.0));
    assert!(ui.layout_counters().taffy_nodes > 1);
}

#[test]
fn formula_leaves_follow_inset_and_size_like_the_solver() {
    let mut ui = ui();
    let page = view(
        &mut ui,
        spec::ROOT_ID,
        &[(prop::WIDTH, -1.0), (prop::HEIGHT, -1.0)],
    );
    ui.set_layout_mode(page, LAYOUT_STATIC, 0.0, 0.0, 240.0, 160.0);
    let underline = view(
        &mut ui,
        page,
        &[
            (prop::POS_TYPE, ABS),
            (prop::INSET_L, 8.0),
            (prop::INSET_T, 87.0),
            (prop::WIDTH, 0.0),
            (prop::HEIGHT, 3.0),
        ],
    );
    ui.set_layout_mode(underline, LAYOUT_FORMULA, 0.0, 0.0, 0.0, 0.0);
    let badge = view(
        &mut ui,
        page,
        &[
            (prop::POS_TYPE, ABS),
            (prop::INSET_R, 8.0),
            (prop::INSET_B, 5.0),
            (prop::WIDTH, 20.0),
            (prop::HEIGHT, 10.0),
        ],
    );
    ui.set_layout_mode(badge, LAYOUT_FORMULA, 0.0, 0.0, 0.0, 0.0);
    let full = view(
        &mut ui,
        page,
        &[
            (prop::POS_TYPE, ABS),
            (prop::INSET_L, 0.0),
            (prop::INSET_T, 0.0),
            (prop::WIDTH, -1.0),
            (prop::HEIGHT, 12.5),
        ],
    );
    ui.set_layout_mode(full, LAYOUT_FORMULA, 0.0, 0.0, 0.0, 0.0);
    solved(&mut ui);
    assert_eq!(rect(&ui, underline), (8.0, 87.0, 0.0, 3.0));
    assert_eq!(rect(&ui, badge), (212.0, 145.0, 20.0, 10.0));
    assert_eq!(rect(&ui, full), (0.0, 0.0, 240.0, 13.0));
    assert_eq!(ui.layout_counters().taffy_nodes, 1);

    // Each width step recomputes only the formula, with the solver's rounding.
    for step in 0..=144 {
        let width = step as f64 * 0.37;
        ui.set_prop(underline, prop::WIDTH, width);
        ui.set_prop(badge, prop::WIDTH, 20.0 + width);
        ui.reset_counters();
        solved(&mut ui);
        assert_eq!(ui.layout_counters().layout_passes, 0);
    }
    assert_eq!(rect(&ui, underline), (8.0, 87.0, 53.0, 3.0));
    assert_eq!(rect(&ui, badge).0, 240.0 - 8.0 - rect(&ui, badge).2);

    // The animation path drives the same formula.
    assert!(
        ui.animate(
            underline,
            prop::WIDTH,
            0.0,
            300,
            0,
            spec::Easing::Linear as u32
        ) >= 0
    );
    for _ in 0..30 {
        solved(&mut ui);
    }
    assert_eq!(rect(&ui, underline).2, 0.0);
    ui.set_prop(underline, prop::DISPLAY, spec::Display::None as u8 as f64);
    solved(&mut ui);
    assert_eq!(rect(&ui, underline), (0.0, 0.0, 0.0, 0.0));
}

#[test]
fn regions_solve_only_their_subtree_and_round_like_the_full_tree() {
    let mut ui = ui();
    // A fractional sibling height puts the region root at a fractional origin.
    let spacer = view(
        &mut ui,
        spec::ROOT_ID,
        &[(prop::WIDTH, 40.0), (prop::HEIGHT, 10.5)],
    );
    let region = view(
        &mut ui,
        spec::ROOT_ID,
        &[
            (prop::WIDTH, 100.0),
            (prop::HEIGHT, 50.0),
            (prop::FLEX_DIR, ROW),
            (prop::PADDING_L, 2.5),
            (prop::CONTAIN, STRICT),
        ],
    );
    ui.insert_before(spec::ROOT_ID, region, 0);
    let a = view(
        &mut ui,
        region,
        &[(prop::WIDTH, 30.3), (prop::HEIGHT, 20.0)],
    );
    let label = text(&mut ui, region, "ab");
    let after = view(
        &mut ui,
        spec::ROOT_ID,
        &[(prop::WIDTH, 40.0), (prop::HEIGHT, 7.0)],
    );
    solved(&mut ui);
    assert_eq!(rect(&ui, spacer).3, 11.0);
    assert_eq!(rect(&ui, region).1, 11.0);
    assert_eq!(rect(&ui, a).0, 3.0);
    assert_eq!(rect(&ui, label).2, 10.0);
    assert_eq!(rect(&ui, after).1, 61.0);

    // A swap inside the region syncs and solves the region alone.
    ui.reset_counters();
    ui.destroy_node(a);
    let b = view(
        &mut ui,
        region,
        &[(prop::WIDTH, 25.0), (prop::HEIGHT, 20.0)],
    );
    solved(&mut ui);
    let work = ui.layout_counters();
    assert_eq!(
        (work.structure_syncs, work.layout_passes, work.shaping_calls),
        (1, 1, 0)
    );
    assert_eq!(work.taffy_nodes_created, 1);
    assert_eq!(rect(&ui, label).0, 3.0);
    assert_eq!(rect(&ui, b).0, 13.0);

    // The root's own box is the parent's business; the region re-solves for it.
    ui.set_prop(region, prop::WIDTH, 60.0);
    ui.set_prop(region, prop::FLEX_DIR, spec::FlexDir::Col as u8 as f64);
    solved(&mut ui);
    assert_eq!(rect(&ui, region).2, 60.0);
    assert_eq!(rect(&ui, b).1, 9.0, "stacked under the label in the column");

    // Moving the origin re-rounds the children without re-solving them.
    ui.set_prop(spacer, prop::HEIGHT, 11.25);
    ui.reset_counters();
    solved(&mut ui);
    assert_eq!(ui.layout_counters().layout_passes, 1, "primary only");
    assert_eq!(rect(&ui, region).1, 11.0);

    // Text swaps and style changes inside the region stay inside it.
    ui.reset_counters();
    ui.set_text(label, "a");
    ui.set_prop(b, prop::HEIGHT, 21.0);
    solved(&mut ui);
    let work = ui.layout_counters();
    assert_eq!((work.structure_syncs, work.layout_passes), (0, 1));
    assert_eq!(rect(&ui, label).3, 9.0, "one line of the atlas");
    assert_eq!(rect(&ui, b).3, 21.0);

    // Dropping containment folds the children back into the primary tree.
    ui.set_prop(region, prop::CONTAIN, NONE);
    solved(&mut ui);
    ui.set_prop(region, prop::CONTAIN, STRICT);
    solved(&mut ui);
    ui.destroy_node(region);
    solved(&mut ui);
    assert_eq!(rect(&ui, after).1, 11.0);
}

#[test]
fn nested_and_static_region_roots_take_their_box_from_the_chain() {
    let mut ui = ui();
    let page = view(
        &mut ui,
        spec::ROOT_ID,
        &[(prop::WIDTH, -1.0), (prop::HEIGHT, -1.0)],
    );
    ui.set_layout_mode(page, LAYOUT_STATIC, 0.0, 0.0, 240.0, 160.0);
    // A static region root: the box and origin come from the assigned rects.
    let panel = view(
        &mut ui,
        page,
        &[
            (prop::POS_TYPE, ABS),
            (prop::INSET_L, 20.0),
            (prop::INSET_T, 30.0),
            (prop::WIDTH, 100.0),
            (prop::HEIGHT, 60.0),
            (prop::FLEX_DIR, ROW),
            (prop::CONTAIN, STRICT),
        ],
    );
    ui.set_layout_mode(panel, LAYOUT_STATIC, 20.0, 30.0, 100.0, 60.0);
    let left = view(&mut ui, panel, &[(prop::WIDTH, 30.0), (prop::HEIGHT, 20.0)]);
    let inner = view(
        &mut ui,
        panel,
        &[
            (prop::WIDTH, 50.0),
            (prop::HEIGHT, 20.5),
            (prop::FLEX_DIR, spec::FlexDir::Col as u8 as f64),
            (prop::CONTAIN, STRICT),
        ],
    );
    let deep = view(&mut ui, inner, &[(prop::WIDTH, 10.0), (prop::HEIGHT, 5.5)]);
    let deeper = view(&mut ui, inner, &[(prop::WIDTH, 10.0), (prop::HEIGHT, 5.5)]);
    solved(&mut ui);
    assert_eq!(rect(&ui, left), (0.0, 0.0, 30.0, 20.0));
    assert_eq!(rect(&ui, inner), (30.0, 0.0, 50.0, 21.0));
    assert_eq!(rect(&ui, deep).3 + rect(&ui, deeper).3, 11.0);

    // A swap in the innermost region solves that region only.
    ui.reset_counters();
    ui.destroy_node(deep);
    view(&mut ui, inner, &[(prop::WIDTH, 12.0), (prop::HEIGHT, 5.5)]);
    solved(&mut ui);
    let work = ui.layout_counters();
    assert_eq!((work.structure_syncs, work.layout_passes), (1, 1));
    assert_eq!(rect(&ui, left), (0.0, 0.0, 30.0, 20.0));

    // A text leaf inside the static region root measures with the atlas.
    let label = text(&mut ui, panel, "ab");
    solved(&mut ui);
    assert_eq!(rect(&ui, label), (80.0, 0.0, 10.0, 60.0));
}
