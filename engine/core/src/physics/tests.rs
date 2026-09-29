//! Physics tests: the module in isolation and end to end through `Ui`.

use alloc::vec::Vec;

use super::*;


#[test]
fn handles_are_kind_tagged_and_stale_after_removal() {
    let mut p = Physics::new();
    let w = p.create(ps::KIND_WORLD, &[]);
    assert_eq!(split_handle(w).unwrap().0, ps::KIND_WORLD);
    let b = p.create(ps::KIND_BODY, &[ps::KEY_WORLD as f64, w as f64, ps::KEY_SHAPE as f64, 1.0, ps::KEY_RADIUS as f64, 10.0]);
    assert_eq!(split_handle(b).unwrap().0, ps::KIND_BODY);
    assert_eq!(p.create(ps::KIND_BODY, &[ps::KEY_WORLD as f64, (w + 1) as f64]), 0, "a stale world refuses bodies");
    let mut tree = Tree::new();
    p.destroy(w, &mut tree);
    assert!(p.is_idle());
    assert_eq!(p.query(ps::QUERY_X, b, 0.0, 0.0, 0.0, 0.0), 0.0);
}

// -- end to end through Ui ------------------------------------------------

use crate::Ui;

fn abs_box(ui: &mut Ui, parent: i32, x: f64, y: f64, w: f64, h: f64) -> i32 {
    let n = ui.create_node(0);
    ui.set_prop(n, spec::prop::POS_TYPE, spec::PosType::Absolute as u32 as f64);
    ui.set_prop(n, spec::prop::INSET_L, x);
    ui.set_prop(n, spec::prop::INSET_T, y);
    ui.set_prop(n, spec::prop::WIDTH, w);
    ui.set_prop(n, spec::prop::HEIGHT, h);
    ui.insert_before(parent, n, 0);
    n
}

fn kv(pairs: &[(u32, f64)]) -> Vec<f64> {
    pairs.iter().flat_map(|&(k, v)| [k as f64, v]).collect()
}

fn prop(ui: &Ui, node: i32, prop: u8) -> f32 {
    ui.resolved_style(node).map_or(f32::NAN, |r| f32::from_bits(r.get_bits(prop)))
}

fn drain(ui: &mut Ui) -> Vec<[f64; ps::EVENT_WORDS]> {
    let mut out = Vec::new();
    ui.physics_take_events(&mut out);
    out.as_chunks::<{ ps::EVENT_WORDS }>().0.to_vec()
}

/// A jelly letter resting at its layout slot, with the homepage's springs.
fn letter(ui: &mut Ui, world: i32, view: i32, extra: &[(u32, f64)]) -> i32 {
    let mut params = kv(&[
        (ps::KEY_WORLD, world as f64),
        (ps::KEY_VIEW, view as f64),
        (ps::KEY_SHAPE, ps::SHAPE_BOX as f64),
        (ps::KEY_HALF_WIDTH, 20.0),
        (ps::KEY_HALF_HEIGHT, 24.0),
        (ps::KEY_CORNER, 6.0),
        (ps::KEY_DENSITY, 0.2),
        (ps::KEY_ANCHOR, ps::ANCHOR_LAYOUT as f64),
        (ps::KEY_STIFFNESS, 190.0),
        (ps::KEY_DAMPING, 13.0),
        (ps::KEY_SPIN_STIFFNESS, 230.0),
        (ps::KEY_SPIN_DAMPING, 13.0),
        (ps::KEY_AIR_GRAVITY, 836.0),
        (ps::KEY_SQUASH_STIFFNESS, 540.0),
        (ps::KEY_SQUASH_DAMPING, 12.0),
        (ps::KEY_LAND_GAIN, 0.02),
        (ps::KEY_LAND_MIN, 1.4),
        (ps::KEY_LAND_MAX, 6.4),
        (ps::KEY_LAND_SPIN, 9.0),
        (ps::KEY_STRETCH_GAIN, 0.0007),
        (ps::KEY_PIVOT, 21.0),
    ]);
    params.extend(kv(extra));
    ui.physics_create(ps::KIND_BODY, &params)
}

#[test]
fn layout_anchor_rests_the_view_on_its_slot_and_hops_back() {
    let mut ui = Ui::new();
    let view = abs_box(&mut ui, spec::ROOT_ID, 100.0, 60.0, 64.0, 64.0);
    let world = ui.physics_create(ps::KIND_WORLD, &kv(&[(ps::KEY_GRAVITY_Y, 2500.0)]));
    let body = letter(&mut ui, world, view, &[]);
    ui.tick();
    assert_eq!(ui.physics_query(ps::QUERY_X, body, 0.0, 0.0, 0.0, 0.0), 132.0, "snapped to the layout centre");
    assert_eq!(prop(&ui, view, spec::prop::TRANSLATE_X), 0.0);
    assert!((prop(&ui, view, spec::prop::ORIGIN_Y) - 21.0 / 64.0).abs() < 1e-6, "pivot at the foot");

    ui.physics_apply(&[body as f64, ps::CMD_HOP as f64, 3.0, 213.0, 4.0, 80.0]);
    ui.tick();
    assert_eq!(ui.physics_query(ps::QUERY_AIRBORNE, body, 0.0, 0.0, 0.0, 0.0), 1.0);
    assert!(prop(&ui, view, spec::prop::TRANSLATE_Y) < 0.0, "rises");
    assert!(prop(&ui, view, spec::prop::SCALE_Y) > 1.0, "stretches on take-off");
    let mut landed = None;
    for frame in 0..90 {
        ui.tick();
        if let Some(e) = drain(&mut ui).into_iter().find(|e| e[0] as u32 == ps::EVENT_LAND) {
            landed = Some((frame, e));
            break;
        }
    }
    let (_, event) = landed.expect("the hop lands");
    assert_eq!(event[1] as i32, body);
    assert!(event[7] > 100.0, "landing speed");
    for _ in 0..240 {
        ui.tick();
    }
    assert!(prop(&ui, view, spec::prop::TRANSLATE_Y).abs() < 0.05);
    assert!((prop(&ui, view, spec::prop::SCALE_Y) - 1.0).abs() < 0.01, "the squash settles");
}

#[test]
fn launch_arrives_at_the_anchor_on_time_and_hands_over_to_the_springs() {
    let mut ui = Ui::new();
    let view = abs_box(&mut ui, spec::ROOT_ID, 100.0, 40.0, 64.0, 64.0);
    let world = ui.physics_create(ps::KIND_WORLD, &kv(&[]));
    let body = letter(&mut ui, world, view, &[(ps::KEY_ASLEEP, 1.0), (ps::KEY_X, 200.0), (ps::KEY_Y, 420.0)]);
    for _ in 0..10 {
        ui.tick();
    }
    assert_eq!(ui.physics_query(ps::QUERY_Y, body, 0.0, 0.0, 0.0, 0.0), 420.0, "parked bodies stay put");
    ui.physics_apply(&[
        body as f64, ps::CMD_LAUNCH as f64, 10.0,
        200.0, 420.0, f64::NAN, f64::NAN, 0.6, 360.0, 10.0, 300.0, 0.3, 0.0,
    ]);
    let mut land_frame = None;
    let mut apex = f64::MAX;
    for frame in 1..=60 {
        ui.tick();
        apex = apex.min(ui.physics_query(ps::QUERY_Y, body, 0.0, 0.0, 0.0, 0.0));
        if drain(&mut ui).iter().any(|e| e[0] as u32 == ps::EVENT_LAND) {
            land_frame = Some(frame);
            break;
        }
    }
    assert_eq!(land_frame, Some(36), "0.6 s at 60 Hz");
    assert!(apex < 72.0, "the arc overshoots the slot before it drops in");
    assert_eq!(ui.physics_query(ps::QUERY_X, body, 0.0, 0.0, 0.0, 0.0), 132.0);
    assert_eq!(ui.physics_query(ps::QUERY_Y, body, 0.0, 0.0, 0.0, 0.0), 72.0);
    assert!((ui.physics_query(ps::QUERY_ANGLE, body, 0.0, 0.0, 0.0, 0.0) - 10.0).abs() < 0.01);
    assert_eq!(ui.physics_query(ps::QUERY_MODE, body, 0.0, 0.0, 0.0, 0.0), 1.0);
}

fn floor_world(ui: &mut Ui) -> (i32, i32) {
    let world = ui.physics_create(ps::KIND_WORLD, &kv(&[(ps::KEY_GRAVITY_Y, 2500.0), (ps::KEY_SEED, 7.0)]));
    let floor = ui.physics_create(
        ps::KIND_COLLIDER,
        &kv(&[
            (ps::KEY_WORLD, world as f64),
            (ps::KEY_SHAPE, ps::SHAPE_CHAIN as f64),
            (ps::KEY_RADIUS, 2.0),
            (ps::KEY_POINT_X, 0.0),
            (ps::KEY_POINT_Y, 0.0),
            (ps::KEY_POINT_X, 0.0),
            (ps::KEY_POINT_Y, 200.0),
            (ps::KEY_POINT_X, 480.0),
            (ps::KEY_POINT_Y, 200.0),
            (ps::KEY_POINT_X, 480.0),
            (ps::KEY_POINT_Y, 0.0),
        ]),
    );
    assert!(floor > 0);
    (world, floor)
}

fn toy(ui: &mut Ui, world: i32, view: i32, x: f64, y: f64) -> i32 {
    ui.physics_create(
        ps::KIND_BODY,
        &kv(&[
            (ps::KEY_WORLD, world as f64),
            (ps::KEY_VIEW, view as f64),
            (ps::KEY_SHAPE, ps::SHAPE_CIRCLE as f64),
            (ps::KEY_RADIUS, 20.0),
            (ps::KEY_DENSITY, 0.318),
            (ps::KEY_RESTITUTION, 0.5),
            (ps::KEY_FRICTION, 0.35),
            (ps::KEY_HIT_SPEED, 260.0),
            (ps::KEY_PICKABLE, 1.0),
            (ps::KEY_SQUASH_AXIS, ps::SQUASH_AXIS_IMPACT as f64),
            (ps::KEY_SQUASH_STIFFNESS, 900.0),
            (ps::KEY_SQUASH_DAMPING, 20.0),
            (ps::KEY_SQUASH_X, 0.65),
            (ps::KEY_DENT, 1.0 / 3000.0),
            (ps::KEY_X, x),
            (ps::KEY_Y, y),
        ]),
    )
}

#[test]
fn a_toy_falls_bounces_dents_and_comes_to_rest_on_a_chain_floor() {
    let mut ui = Ui::new();
    let view = abs_box(&mut ui, spec::ROOT_ID, 0.0, 0.0, 40.0, 40.0);
    let (world, floor) = floor_world(&mut ui);
    let body = toy(&mut ui, world, view, 240.0, 40.0);
    let mut hits = 0;
    let mut dented = false;
    for _ in 0..240 {
        ui.tick();
        for e in drain(&mut ui) {
            if e[0] as u32 == ps::EVENT_HIT {
                assert_eq!(e[2] as i32, floor);
                assert!(e[6] < -0.99, "the floor normal points up");
                hits += 1;
            }
        }
        let (sx, sy) = (prop(&ui, view, spec::prop::SCALE_X), prop(&ui, view, spec::prop::SCALE_Y));
        dented |= (sx - sy).abs() > 0.05;
    }
    assert!(hits >= 1, "the first impact reports a hit");
    assert!(dented, "impacts squash along the contact normal");
    let y = ui.physics_query(ps::QUERY_Y, body, 0.0, 0.0, 0.0, 0.0);
    assert!((y - 178.0).abs() < 0.5, "rests on the floor: {y}");
    assert!(ui.physics_query(ps::QUERY_SPEED, body, 0.0, 0.0, 0.0, 0.0) < 1.0);
    assert!(ui.physics_query(ps::QUERY_GROUNDED, body, 0.0, 0.0, 0.0, 0.0) >= 0.0);
    // the view follows: its layout centre is (20, 20)
    assert!((prop(&ui, view, spec::prop::TRANSLATE_Y) as f64 - (y - 20.0)).abs() < 1e-3);
}

#[test]
fn toys_knock_an_anchored_letter_which_springs_home() {
    let mut ui = Ui::new();
    let slot = abs_box(&mut ui, spec::ROOT_ID, 208.0, 76.0, 64.0, 64.0);
    let ball = abs_box(&mut ui, spec::ROOT_ID, 0.0, 0.0, 40.0, 40.0);
    let (world, _) = floor_world(&mut ui);
    let body = letter(&mut ui, world, slot, &[(ps::KEY_SQUASH_IMPACT, 0.01), (ps::KEY_LAYER, 2.0), (ps::KEY_MASK, 1.0)]);
    let t = toy(&mut ui, world, ball, 240.0, 10.0);
    let mut disturbed = 0.0f32;
    for _ in 0..180 {
        ui.tick();
        disturbed = disturbed.max(prop(&ui, slot, spec::prop::TRANSLATE_Y).abs());
    }
    assert!(disturbed > 0.5, "the letter gives under the toy: {disturbed}");
    let toy_y = ui.physics_query(ps::QUERY_Y, t, 0.0, 0.0, 0.0, 0.0);
    let sag = prop(&ui, slot, spec::prop::TRANSLATE_Y);
    assert!(toy_y < 100.0, "the toy rests on the letter: {toy_y}");
    assert!(sag > 2.0, "and the letter carries its weight: {sag}");
    ui.physics_destroy(t);
    for _ in 0..600 {
        ui.tick();
    }
    assert_eq!(ui.physics_query(ps::QUERY_MODE, body, 0.0, 0.0, 0.0, 0.0), 1.0);
    assert!(prop(&ui, slot, spec::prop::TRANSLATE_Y).abs() < 0.05, "springs back to its slot");
}

#[test]
fn the_same_commands_give_the_same_bits() {
    let run = || {
        let mut ui = Ui::new();
        let (world, _) = floor_world(&mut ui);
        let mut bodies = Vec::new();
        for k in 0..6 {
            let view = abs_box(&mut ui, spec::ROOT_ID, 0.0, 0.0, 40.0, 40.0);
            bodies.push(toy(&mut ui, world, view, 60.0 + 70.0 * k as f64, 30.0 + 11.0 * k as f64));
        }
        ui.physics_apply(&[bodies[0] as f64, ps::CMD_IMPULSE as f64, 3.0, 900.0, -300.0, 720.0]);
        let mut trace = Vec::new();
        for _ in 0..180 {
            ui.tick();
            for &b in &bodies {
                trace.push(ui.physics_query(ps::QUERY_X, b, 0.0, 0.0, 0.0, 0.0).to_bits());
                trace.push(ui.physics_query(ps::QUERY_ANGLE, b, 0.0, 0.0, 0.0, 0.0).to_bits());
            }
            let mut events = Vec::new();
            ui.physics_take_events(&mut events);
            trace.extend(events.iter().map(|v| v.to_bits()));
        }
        trace
    };
    assert_eq!(run(), run());
}

#[test]
fn views_on_two_surfaces_share_one_world() {
    let mut ui = Ui::new();
    ui.set_viewport(400.0, 240.0);
    let aux = ui.create_auxiliary_surface(320.0, 240.0);
    let top = abs_box(&mut ui, spec::ROOT_ID, 0.0, 0.0, 20.0, 20.0);
    let bottom = abs_box(&mut ui, aux, 0.0, 0.0, 20.0, 20.0);
    let world = ui.physics_create(
        ps::KIND_WORLD,
        &kv(&[(ps::KEY_GRAVITY_Y, 0.0), (ps::KEY_AUXILIARY_X, 40.0), (ps::KEY_AUXILIARY_Y, 296.0)]),
    );
    let body = ui.physics_create(
        ps::KIND_BODY,
        &kv(&[
            (ps::KEY_WORLD, world as f64),
            (ps::KEY_VIEW, top as f64),
            (ps::KEY_VIEW, bottom as f64),
            (ps::KEY_SHAPE, ps::SHAPE_CIRCLE as f64),
            (ps::KEY_RADIUS, 10.0),
            (ps::KEY_X, 200.0),
            (ps::KEY_Y, 400.0),
            (ps::KEY_PICKABLE, 1.0),
        ]),
    );
    ui.tick();
    assert_eq!(prop(&ui, top, spec::prop::TRANSLATE_Y), 390.0, "below the top screen");
    assert_eq!(prop(&ui, bottom, spec::prop::TRANSLATE_X), 150.0);
    assert_eq!(prop(&ui, bottom, spec::prop::TRANSLATE_Y), 94.0, "inside the bottom screen");
    assert_eq!(ui.physics_query(ps::QUERY_PICK, world, 160.0, 104.0, 1.0, 0.0) as i32, body);
    assert_eq!(ui.physics_query(ps::QUERY_PICK, world, 160.0, 104.0, 0.0, 0.0), 0.0);

    // a stylus carry moves it; release throws it
    ui.physics_apply(&[body as f64, ps::CMD_GRAB as f64, 5.0, 160.0, 104.0, 1.0, ps::GRAB_CARRY as f64, 0.0]);
    for k in 1..=5 {
        ui.physics_apply(&[body as f64, ps::CMD_DRAG as f64, 3.0, 160.0, 104.0 - 8.0 * k as f64, 1.0]);
        ui.tick();
    }
    assert_eq!(ui.physics_query(ps::QUERY_Y, body, 0.0, 0.0, 0.0, 0.0), 360.0);
    ui.physics_apply(&[body as f64, ps::CMD_RELEASE as f64, 0.0]);
    assert!(ui.physics_query(ps::QUERY_VY, body, 0.0, 0.0, 0.0, 0.0) < -300.0, "thrown upward");
}

#[test]
fn zones_report_enter_and_leave() {
    let mut ui = Ui::new();
    let world = ui.physics_create(ps::KIND_WORLD, &kv(&[(ps::KEY_GRAVITY_Y, 0.0)]));
    let zone = ui.physics_create(
        ps::KIND_ZONE,
        &kv(&[(ps::KEY_WORLD, world as f64), (ps::KEY_SHAPE, ps::SHAPE_BOX as f64), (ps::KEY_X, 100.0), (ps::KEY_Y, 100.0), (ps::KEY_HALF_WIDTH, 20.0), (ps::KEY_HALF_HEIGHT, 20.0)]),
    );
    let body = ui.physics_create(
        ps::KIND_BODY,
        &kv(&[(ps::KEY_WORLD, world as f64), (ps::KEY_SHAPE, ps::SHAPE_CIRCLE as f64), (ps::KEY_RADIUS, 5.0), (ps::KEY_X, 40.0), (ps::KEY_Y, 100.0), (ps::KEY_VX, 1200.0), (ps::KEY_LINEAR_DAMPING, 0.0)]),
    );
    let mut seen = Vec::new();
    for _ in 0..12 {
        ui.tick();
        for e in drain(&mut ui) {
            assert_eq!(e[1] as i32, zone);
            assert_eq!(e[2] as i32, body);
            seen.push(e[0] as u32);
        }
    }
    assert_eq!(seen, [ps::EVENT_ENTER, ps::EVENT_LEAVE]);
}

#[test]
fn an_emitter_bursts_into_its_pool_and_hides_spent_particles() {
    let mut ui = Ui::new();
    let world = ui.physics_create(ps::KIND_WORLD, &kv(&[]));
    let mut params = kv(&[(ps::KEY_WORLD, world as f64), (ps::KEY_LIFE_MIN, 0.2), (ps::KEY_LIFE_MAX, 0.3), (ps::KEY_SCALE_CURVE, ps::SCALE_CURVE_POP as f64)]);
    let mut pool = Vec::new();
    for _ in 0..6 {
        let node = ui.create_node(2);
        ui.set_prop(node, spec::prop::WIDTH, 8.0);
        ui.set_prop(node, spec::prop::HEIGHT, 8.0);
        ui.set_prop(node, spec::prop::POS_TYPE, spec::PosType::Absolute as u32 as f64);
        ui.insert_before(spec::ROOT_ID, node, 0);
        params.extend([ps::KEY_VIEW as f64, node as f64]);
        pool.push(node);
    }
    let emitter = ui.physics_create(ps::KIND_EMITTER, &params);
    ui.tick();
    assert!(pool.iter().all(|&n| prop(&ui, n, spec::prop::OPACITY) == 0.0), "an idle pool is invisible");
    ui.physics_apply(&[emitter as f64, ps::CMD_BURST as f64, 6.0, 100.0, 100.0, 4.0, 0.0, 360.0, 1.0]);
    ui.tick();
    assert_eq!(ui.physics_query(ps::QUERY_PARTICLES, emitter, 0.0, 0.0, 0.0, 0.0), 4.0);
    assert_eq!(pool.iter().filter(|&&n| prop(&ui, n, spec::prop::OPACITY) > 0.0).count(), 4);
    for _ in 0..30 {
        ui.tick();
    }
    assert_eq!(ui.physics_query(ps::QUERY_PARTICLES, emitter, 0.0, 0.0, 0.0, 0.0), 0.0);
    ui.physics_destroy(emitter);
    assert!(pool.iter().all(|&n| prop(&ui, n, spec::prop::OPACITY) == 1.0), "destroy hands the views back");
}

#[test]
fn a_collider_owner_absorbs_impacts_as_wobble() {
    let mut ui = Ui::new();
    let (world, _) = floor_world(&mut ui);
    let pocket = ui.physics_create(
        ps::KIND_BODY,
        &kv(&[
            (ps::KEY_WORLD, world as f64),
            (ps::KEY_MASS, 0.0),
            (ps::KEY_ANCHOR, ps::ANCHOR_POINT as f64),
            (ps::KEY_ANCHOR_X, 240.0),
            (ps::KEY_ANCHOR_Y, 190.0),
            (ps::KEY_SPIN_STIFFNESS, 170.0),
            (ps::KEY_SPIN_DAMPING, 5.0),
            (ps::KEY_SQUASH_STIFFNESS, 560.0),
            (ps::KEY_SQUASH_DAMPING, 15.0),
            (ps::KEY_SQUASH_LIMIT, 2.0),
        ]),
    );
    ui.physics_create(
        ps::KIND_COLLIDER,
        &kv(&[
            (ps::KEY_WORLD, world as f64),
            (ps::KEY_SHAPE, ps::SHAPE_BOX as f64),
            (ps::KEY_X, 240.0),
            (ps::KEY_Y, 170.0),
            (ps::KEY_HALF_WIDTH, 50.0),
            (ps::KEY_HALF_HEIGHT, 20.0),
            (ps::KEY_OWNER, pocket as f64),
            (ps::KEY_OWNER_SQUASH, 1.0 / 900.0),
            (ps::KEY_OWNER_SPIN, 20.0 / 2600.0 * 57.3),
        ]),
    );
    let view = abs_box(&mut ui, spec::ROOT_ID, 0.0, 0.0, 40.0, 40.0);
    toy(&mut ui, world, view, 270.0, 20.0);
    let mut max_spin = 0.0f64;
    for _ in 0..60 {
        ui.tick();
        max_spin = max_spin.max(ui.physics_query(ps::QUERY_ANGLE, pocket, 0.0, 0.0, 0.0, 0.0).abs());
    }
    assert!(max_spin > 0.1, "a hit off-centre tips the owner: {max_spin}");
    assert_eq!(ui.physics_query(ps::QUERY_X, pocket, 0.0, 0.0, 0.0, 0.0), 240.0, "an immovable owner stays put");
}

// -- regressions ------------------------------------------------------------

fn box_body(ui: &mut Ui, world: i32, x: f64, y: f64, extra: &[(u32, f64)]) -> i32 {
    let mut params = kv(&[
        (ps::KEY_WORLD, world as f64),
        (ps::KEY_SHAPE, ps::SHAPE_BOX as f64),
        (ps::KEY_HALF_WIDTH, 10.0),
        (ps::KEY_HALF_HEIGHT, 10.0),
        (ps::KEY_CORNER, 2.0),
        (ps::KEY_X, x),
        (ps::KEY_Y, y),
    ]);
    params.extend(kv(extra));
    ui.physics_create(ps::KIND_BODY, &params)
}

#[test]
fn a_box_lands_flat_on_a_box_without_hovering() {
    // every bottom sample touches at once; each must see the correction the
    // earlier ones applied
    let mut ui = Ui::new();
    let world = ui.physics_create(ps::KIND_WORLD, &kv(&[(ps::KEY_GRAVITY_Y, 2500.0)]));
    ui.physics_create(
        ps::KIND_COLLIDER,
        &kv(&[(ps::KEY_WORLD, world as f64), (ps::KEY_SHAPE, ps::SHAPE_BOX as f64), (ps::KEY_X, 100.0), (ps::KEY_Y, 220.0), (ps::KEY_HALF_WIDTH, 100.0), (ps::KEY_HALF_HEIGHT, 20.0)]),
    );
    let body = box_body(&mut ui, world, 100.0, 100.0, &[(ps::KEY_VY, 1200.0)]);
    for _ in 0..240 {
        ui.tick();
    }
    let y = ui.physics_query(ps::QUERY_Y, body, 0.0, 0.0, 0.0, 0.0);
    assert!((y - 190.0).abs() < 0.6, "rests on the top face at 190: {y}");
}

#[test]
fn a_box_lands_on_a_box_body_without_a_gap() {
    // while the top box sits on the bottom one their faces touch; the solver
    // makes no promise that a stack stays up
    let mut ui = Ui::new();
    let world = ui.physics_create(ps::KIND_WORLD, &kv(&[(ps::KEY_GRAVITY_Y, 2500.0)]));
    ui.physics_create(
        ps::KIND_COLLIDER,
        &kv(&[(ps::KEY_WORLD, world as f64), (ps::KEY_SHAPE, ps::SHAPE_BOX as f64), (ps::KEY_X, 100.0), (ps::KEY_Y, 220.0), (ps::KEY_HALF_WIDTH, 100.0), (ps::KEY_HALF_HEIGHT, 20.0)]),
    );
    let low = box_body(&mut ui, world, 100.0, 185.0, &[]);
    let high = box_body(&mut ui, world, 100.0, 120.0, &[]);
    for _ in 0..40 {
        ui.tick();
    }
    let q = |b: i32, w: u32| ui.physics_query(w, b, 0.0, 0.0, 0.0, 0.0);
    assert!((q(high, ps::QUERY_X) - q(low, ps::QUERY_X)).abs() < 5.0, "still stacked");
    let gap = q(low, ps::QUERY_Y) - q(high, ps::QUERY_Y);
    assert!((gap - 20.0).abs() < 1.0, "stacked boxes touch: centre gap {gap}");
}

#[test]
fn an_owner_turns_away_from_the_side_that_was_struck() {
    let run = |x: f64| {
        let mut ui = Ui::new();
        let world = ui.physics_create(ps::KIND_WORLD, &kv(&[(ps::KEY_GRAVITY_Y, 2500.0)]));
        let owner = ui.physics_create(
            ps::KIND_BODY,
            &kv(&[
                (ps::KEY_WORLD, world as f64),
                (ps::KEY_MASS, 0.0),
                (ps::KEY_ANCHOR, ps::ANCHOR_POINT as f64),
                (ps::KEY_ANCHOR_X, 200.0),
                (ps::KEY_ANCHOR_Y, 200.0),
                (ps::KEY_SPIN_STIFFNESS, 170.0),
                (ps::KEY_SPIN_DAMPING, 5.0),
            ]),
        );
        // a U-shaped chain, the pocket's profile
        let mut chain = kv(&[
            (ps::KEY_WORLD, world as f64),
            (ps::KEY_SHAPE, ps::SHAPE_CHAIN as f64),
            (ps::KEY_RADIUS, 4.0),
            (ps::KEY_OWNER, owner as f64),
            (ps::KEY_OWNER_SPIN, 2.0),
        ]);
        for (px, py) in [(150.0, 150.0), (150.0, 220.0), (250.0, 220.0), (250.0, 150.0)] {
            chain.extend(kv(&[(ps::KEY_POINT_X, px), (ps::KEY_POINT_Y, py)]));
        }
        ui.physics_create(ps::KIND_COLLIDER, &chain);
        ui.physics_create(ps::KIND_BODY, &kv(&[(ps::KEY_WORLD, world as f64), (ps::KEY_SHAPE, ps::SHAPE_CIRCLE as f64), (ps::KEY_RADIUS, 8.0), (ps::KEY_X, x), (ps::KEY_Y, 60.0)]));
        let mut peak = 0.0f64;
        for _ in 0..40 {
            ui.tick();
            let angle = ui.physics_query(ps::QUERY_ANGLE, owner, 0.0, 0.0, 0.0, 0.0);
            if angle.abs() > peak.abs() {
                peak = angle;
            }
        }
        peak
    };
    let (left, right) = (run(150.0), run(250.0));
    assert!(left.abs() > 0.05 && right.abs() > 0.05, "both rims tip the owner: {left} {right}");
    assert!(left.signum() != right.signum(), "opposite rims tip it opposite ways: {left} {right}");
}

#[test]
fn non_finite_input_is_refused_and_never_spreads() {
    let mut ui = Ui::new();
    let world = ui.physics_create(ps::KIND_WORLD, &kv(&[(ps::KEY_GRAVITY_Y, 0.0)]));
    let a = ui.physics_create(ps::KIND_BODY, &kv(&[(ps::KEY_WORLD, world as f64), (ps::KEY_SHAPE, 1.0), (ps::KEY_RADIUS, 10.0), (ps::KEY_X, 100.0), (ps::KEY_Y, 100.0)]));
    let b = ui.physics_create(ps::KIND_BODY, &kv(&[(ps::KEY_WORLD, world as f64), (ps::KEY_SHAPE, 1.0), (ps::KEY_RADIUS, 10.0), (ps::KEY_X, 115.0), (ps::KEY_Y, 100.0)]));
    ui.physics_apply(&[a as f64, ps::CMD_IMPULSE as f64, 3.0, f64::NAN, 0.0, 0.0]);
    ui.physics_apply(&[a as f64, ps::CMD_VELOCITY as f64, 3.0, f64::INFINITY, 0.0, 0.0]);
    let c = ui.physics_create(ps::KIND_BODY, &kv(&[(ps::KEY_WORLD, world as f64), (ps::KEY_SHAPE, 1.0), (ps::KEY_RADIUS, f64::NAN), (ps::KEY_X, 200.0)]));
    for _ in 0..10 {
        ui.tick();
    }
    for body in [a, b, c] {
        assert!(ui.physics_query(ps::QUERY_X, body, 0.0, 0.0, 0.0, 0.0).is_finite());
    }
}

#[test]
fn a_huge_stream_rate_is_bounded_by_the_pool() {
    let mut ui = Ui::new();
    let world = ui.physics_create(ps::KIND_WORLD, &[]);
    let mut params = kv(&[(ps::KEY_WORLD, world as f64)]);
    for _ in 0..4 {
        let node = ui.create_node(2);
        ui.insert_before(spec::ROOT_ID, node, 0);
        params.extend([ps::KEY_VIEW as f64, node as f64]);
    }
    let emitter = ui.physics_create(ps::KIND_EMITTER, &params);
    ui.physics_apply(&[emitter as f64, ps::CMD_STREAM as f64, 5.0, 3e9, 0.0, 0.0, 10.0, 10.0]);
    ui.tick();
    assert_eq!(ui.physics_query(ps::QUERY_PARTICLES, emitter, 0.0, 0.0, 0.0, 0.0), 4.0);
    ui.physics_apply(&[emitter as f64, ps::CMD_STREAM as f64, 5.0, f64::INFINITY, 0.0, 0.0, 10.0, 10.0]);
    ui.tick();
}

#[test]
fn bursts_draw_from_the_emitter_not_the_world() {
    // the landing wobble's side comes from the world generator; a burst in
    // between must not change it
    let run = |burst: bool| {
        let mut ui = Ui::new();
        let view = abs_box(&mut ui, spec::ROOT_ID, 100.0, 60.0, 64.0, 64.0);
        let world = ui.physics_create(ps::KIND_WORLD, &kv(&[(ps::KEY_SEED, 9.0)]));
        let node = ui.create_node(2);
        ui.insert_before(spec::ROOT_ID, node, 0);
        let emitter = ui.physics_create(ps::KIND_EMITTER, &kv(&[(ps::KEY_WORLD, world as f64), (ps::KEY_VIEW, node as f64)]));
        let body = letter(&mut ui, world, view, &[]);
        ui.tick();
        if burst {
            ui.physics_apply(&[emitter as f64, ps::CMD_BURST as f64, 6.0, 0.0, 0.0, 1.0, 0.0, 360.0, 1.0]);
        }
        ui.physics_apply(&[body as f64, ps::CMD_HOP as f64, 3.0, 213.0, 4.0, 0.0]);
        let mut spins = Vec::new();
        for _ in 0..60 {
            ui.tick();
            spins.push(ui.physics_query(ps::QUERY_SPIN, body, 0.0, 0.0, 0.0, 0.0).to_bits());
        }
        spins
    };
    assert_eq!(run(false), run(true));
}

#[test]
fn a_silent_world_records_nothing_and_a_flood_reports_overflow() {
    let mut ui = Ui::new();
    let world = ui.physics_create(ps::KIND_WORLD, &kv(&[(ps::KEY_GRAVITY_Y, 0.0)]));
    let zone = ui.physics_create(
        ps::KIND_ZONE,
        &kv(&[(ps::KEY_WORLD, world as f64), (ps::KEY_SHAPE, ps::SHAPE_BOX as f64), (ps::KEY_X, 100.0), (ps::KEY_Y, 100.0), (ps::KEY_HALF_WIDTH, 50.0), (ps::KEY_HALF_HEIGHT, 50.0)]),
    );
    assert!(zone > 0);
    ui.physics_apply(&[world as f64, ps::CMD_LISTEN as f64, 1.0, 0.0]);
    for k in 0..(ps::EVENT_MAX + 10) {
        ui.physics_create(ps::KIND_BODY, &kv(&[(ps::KEY_WORLD, world as f64), (ps::KEY_X, 60.0 + (k % 80) as f64), (ps::KEY_Y, 100.0)]));
    }
    ui.tick();
    assert!(drain(&mut ui).is_empty(), "a world that does not listen records nothing");
    ui.physics_apply(&[world as f64, ps::CMD_LISTEN as f64, 1.0, 1.0]);
    ui.physics_destroy(zone);
    let zone = ui.physics_create(
        ps::KIND_ZONE,
        &kv(&[(ps::KEY_WORLD, world as f64), (ps::KEY_SHAPE, ps::SHAPE_BOX as f64), (ps::KEY_X, 100.0), (ps::KEY_Y, 100.0), (ps::KEY_HALF_WIDTH, 50.0), (ps::KEY_HALF_HEIGHT, 50.0)]),
    );
    assert!(zone > 0);
    ui.tick();
    let events = drain(&mut ui);
    assert_eq!(events.iter().filter(|e| e[0] as u32 == ps::EVENT_ENTER).count(), ps::EVENT_MAX);
    let overflow = events.last().unwrap();
    assert_eq!(overflow[0] as u32, ps::EVENT_OVERFLOW);
    assert_eq!(overflow[7], 10.0);
}

#[test]
fn the_physics_layer_is_not_the_animation_layer() {
    let mut ui = Ui::new();
    let view = abs_box(&mut ui, spec::ROOT_ID, 0.0, 0.0, 20.0, 20.0);
    let world = ui.physics_create(ps::KIND_WORLD, &kv(&[(ps::KEY_GRAVITY_Y, 0.0)]));
    let body = ui.physics_create(ps::KIND_BODY, &kv(&[(ps::KEY_WORLD, world as f64), (ps::KEY_VIEW, view as f64), (ps::KEY_X, 110.0), (ps::KEY_Y, 10.0)]));
    ui.tick();
    assert_eq!(prop(&ui, view, spec::prop::TRANSLATE_X), 100.0);
    // an animation on the same prop starts, is cancelled, and freezes nothing
    let anim = ui.animate(view, spec::prop::TRANSLATE_X, 40.0, 1000, 0, 0);
    ui.tick();
    ui.cancel_anim(anim);
    assert_eq!(prop(&ui, view, spec::prop::TRANSLATE_X), 100.0, "the body still owns the pose");
    ui.physics_destroy(body);
    let styled = prop(&ui, view, spec::prop::TRANSLATE_X);
    assert!(styled < 40.0, "after destroy the view shows its own value: {styled}");
}

#[test]
fn contacts_lean_letters_the_homepage_way_and_toys_squash_vertically() {
    // a toy thrown at a letter from the left leans it positive
    let mut ui = Ui::new();
    let slot = abs_box(&mut ui, spec::ROOT_ID, 208.0, 76.0, 64.0, 64.0);
    let world = ui.physics_create(ps::KIND_WORLD, &kv(&[(ps::KEY_GRAVITY_Y, 0.0)]));
    letter(&mut ui, world, slot, &[(ps::KEY_LEAN_STIFFNESS, 320.0), (ps::KEY_LEAN_DAMPING, 11.0), (ps::KEY_LEAN_IMPACT, 30.0)]);
    ui.physics_create(ps::KIND_BODY, &kv(&[(ps::KEY_WORLD, world as f64), (ps::KEY_SHAPE, 1.0), (ps::KEY_RADIUS, 12.0), (ps::KEY_X, 150.0), (ps::KEY_Y, 108.0), (ps::KEY_VX, 900.0)]));
    let mut peak = 0.0f32;
    for _ in 0..20 {
        ui.tick();
        let skew = prop(&ui, slot, spec::prop::SKEW_X);
        if skew.abs() > peak.abs() {
            peak = skew;
        }
    }
    assert!(peak > 0.5, "leans away from the push: {peak}");

    // a fresh impact-axis body kicked squashes wide and short
    let view = abs_box(&mut ui, spec::ROOT_ID, 0.0, 0.0, 20.0, 20.0);
    let toy = ui.physics_create(
        ps::KIND_BODY,
        &kv(&[
            (ps::KEY_WORLD, world as f64),
            (ps::KEY_VIEW, view as f64),
            (ps::KEY_X, 300.0),
            (ps::KEY_Y, 200.0),
            (ps::KEY_SQUASH_AXIS, ps::SQUASH_AXIS_IMPACT as f64),
            (ps::KEY_SQUASH_STIFFNESS, 900.0),
            (ps::KEY_SQUASH_DAMPING, 20.0),
        ]),
    );
    ui.physics_apply(&[toy as f64, ps::CMD_KICK as f64, 1.0, 8.0]);
    ui.tick();
    ui.tick();
    assert!(prop(&ui, view, spec::prop::SCALE_X) > 1.0 && prop(&ui, view, spec::prop::SCALE_Y) < 1.0);
}

#[test]
fn a_body_anchored_only_in_angle_launches_from_where_it_is() {
    let mut ui = Ui::new();
    let world = ui.physics_create(ps::KIND_WORLD, &kv(&[(ps::KEY_GRAVITY_Y, 0.0)]));
    let body = ui.physics_create(
        ps::KIND_BODY,
        &kv(&[
            (ps::KEY_WORLD, world as f64),
            (ps::KEY_X, 100.0),
            (ps::KEY_Y, 100.0),
            (ps::KEY_ANGLE, 30.0),
            (ps::KEY_ANCHOR, ps::ANCHOR_POINT as f64),
            (ps::KEY_ANCHOR_AXES, ps::AXIS_ANGLE as f64),
            (ps::KEY_SPIN_STIFFNESS, 16.0),
        ]),
    );
    ui.physics_apply(&[body as f64, ps::CMD_LAUNCH as f64, 10.0, 100.0, 100.0, 100.0, 150.0, 0.4, 90.0, 0.0, 0.0, 0.0, 0.0]);
    ui.tick();
    let angle = ui.physics_query(ps::QUERY_ANGLE, body, 0.0, 0.0, 0.0, 0.0);
    assert!((angle - 30.0).abs() < 5.0, "no snap to the rest angle at take-off: {angle}");
}

#[test]
fn a_flight_passes_through_bodies_unless_solid() {
    let run = |solid: f64| {
        let mut ui = Ui::new();
        let world = ui.physics_create(ps::KIND_WORLD, &kv(&[(ps::KEY_GRAVITY_Y, 0.0)]));
        let flyer = ui.physics_create(ps::KIND_BODY, &kv(&[(ps::KEY_WORLD, world as f64), (ps::KEY_SHAPE, 1.0), (ps::KEY_RADIUS, 10.0), (ps::KEY_X, 0.0), (ps::KEY_Y, 100.0)]));
        let resting = ui.physics_create(ps::KIND_BODY, &kv(&[(ps::KEY_WORLD, world as f64), (ps::KEY_SHAPE, 1.0), (ps::KEY_RADIUS, 10.0), (ps::KEY_X, 100.0), (ps::KEY_Y, 100.0)]));
        ui.physics_apply(&[flyer as f64, ps::CMD_LAUNCH as f64, 11.0, 0.0, 100.0, 200.0, 100.0, 0.5, 0.0, 0.0, 0.0, 0.0, 0.0, solid]);
        for _ in 0..40 {
            ui.tick();
        }
        ui.physics_query(ps::QUERY_SPEED, resting, 0.0, 0.0, 0.0, 0.0)
    };
    assert_eq!(run(0.0), 0.0, "a plain flight passes through");
    assert!(run(1.0) > 10.0, "a solid flight shoves");
}

#[test]
fn destroying_a_body_inside_a_zone_reports_leave() {
    let mut ui = Ui::new();
    let world = ui.physics_create(ps::KIND_WORLD, &kv(&[(ps::KEY_GRAVITY_Y, 0.0)]));
    let zone = ui.physics_create(
        ps::KIND_ZONE,
        &kv(&[(ps::KEY_WORLD, world as f64), (ps::KEY_SHAPE, ps::SHAPE_CIRCLE as f64), (ps::KEY_X, 0.0), (ps::KEY_Y, 0.0), (ps::KEY_RADIUS, 50.0)]),
    );
    let body = ui.physics_create(ps::KIND_BODY, &kv(&[(ps::KEY_WORLD, world as f64), (ps::KEY_X, 1.0), (ps::KEY_Y, 1.0)]));
    ui.tick();
    assert_eq!(drain(&mut ui)[0][0] as u32, ps::EVENT_ENTER);
    ui.physics_destroy(body);
    ui.tick();
    let events = drain(&mut ui);
    assert_eq!((events[0][0] as u32, events[0][1] as i32, events[0][2] as i32), (ps::EVENT_LEAVE, zone, body));
}

