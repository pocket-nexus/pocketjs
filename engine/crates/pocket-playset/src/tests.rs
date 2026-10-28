//! End-to-end checks of one Playset: content, a step, a frame.

use crate::model::tests::boxes;
use crate::schema::{
    arch as A, arch_flag as AF, behaviour as L, behaviour_state as H, brain as B, event as EV, event_field as EF, motion as M, rule as R, steer as T,
    steer_when as C, weapon as W,
};
use crate::vec::*;
use crate::Playset;
use alloc::vec;
use alloc::vec::Vec;

fn arch() -> Vec<f32> {
    vec![0.0; crate::schema::ARCH_LENGTH]
}

/// One behaviour state: speed, fire range and cone, FWD, terms
/// (kind, weight, a, b, c, d), transitions (condition, value, next).
struct State {
    speed: f32,
    fire: (f32, f32),
    fwd: Option<f32>,
    terms: Vec<[f32; 6]>,
    next: Vec<[f32; 3]>,
}

fn state(speed: f32, fire: (f32, f32), terms: &[[f32; 6]], next: &[[f32; 3]]) -> State {
    State { speed, fire, fwd: None, terms: terms.to_vec(), next: next.to_vec() }
}

/// A STEER descriptor: `d` followed by its behaviour.
fn steering(mut d: Vec<f32>, states: &[State]) -> Vec<f32> {
    d.truncate(crate::schema::ARCH_LENGTH);
    d[A::BRAIN] = B::STEER as f32;
    let mut b = vec![0.0f32; crate::schema::BEHAVIOUR_LENGTH];
    for (i, st) in states.iter().enumerate() {
        let at = L::HEADER + i * crate::schema::BEHAVIOUR_STATE_LENGTH;
        b[at + H::SPEED] = st.speed;
        b[at + H::FIRE_RANGE] = st.fire.0;
        b[at + H::FIRE_CONE] = st.fire.1;
        if let Some(f) = st.fwd {
            b[at + H::SET_FWD] = 1.0;
            b[at + H::FWD] = f;
        }
        for (k, t) in st.terms.iter().enumerate() {
            let o = at + L::STATE_HEAD + k * L::TERM_LEN;
            b[o..o + 6].copy_from_slice(t);
        }
        for (k, t) in st.next.iter().enumerate() {
            let o = at + L::STATE_HEAD + L::TERMS * L::TERM_LEN + k * L::TRANSITION_LEN;
            b[o..o + 3].copy_from_slice(t);
        }
    }
    d.extend_from_slice(&b);
    d
}

#[test]
fn shooter_kills_target_and_reports_it() {
    let mut ps = Playset::new(64, 64);
    let model = ps.scene.add_model(&boxes(&[(1.0, 1.0, 1.0, [0.0, 0.0, 0.0], 1.0)])).unwrap();
    let mut shot = arch();
    shot[A::MODEL] = (model + 1) as f32;
    shot[A::MOTION] = M::LINEAR as f32;
    shot[A::LAYER] = 2.0;
    shot[A::MASK] = 4.0;
    shot[A::RADIUS] = 0.3;
    shot[A::DAMAGE] = 5.0;
    shot[A::LIFETIME] = 2.0;
    shot[A::FLAGS] = AF::PROJECTILE as f32;
    let shot = ps.world.add_arch(&shot);
    let mut gun = arch();
    gun[A::MODEL] = (model + 1) as f32;
    gun[A::LAYER] = 1.0;
    gun[A::MOTION] = M::TURRET as f32;
    gun[A::MOTION_P] = 10.0;
    gun[A::MOTION_P + 1] = 10.0;
    gun[A::MOTION_P + 2] = -1.0;
    gun[A::MOTION_P + 3] = 1.0;
    gun[A::BRAIN_P] = 1.0;
    gun[A::BRAIN_P + 1] = 4.0;
    gun[A::WEAPON0 + W::PROJECTILE] = (shot + 1) as f32;
    gun[A::WEAPON0 + W::COOLDOWN] = 0.2;
    gun[A::WEAPON0 + W::SPEED] = 30.0;
    let gun = ps.world.add_arch(&steering(gun, &[state(1.0, (50.0, 0.2), &[], &[])]));
    let mut target = arch();
    target[A::MODEL] = (model + 1) as f32;
    target[A::LAYER] = 4.0;
    target[A::RADIUS] = 1.0;
    target[A::HP] = 10.0;
    target[A::VALUE] = 100.0;
    let target = ps.world.add_arch(&target);
    ps.world.add_rule(2, 4, R::DAMAGE_B | R::KILL_A | R::EVENT, 0.0);
    let g = ps.world.spawn(&ps.scene, gun as usize, v3(0.0, 0.0, 0.0), 0.0);
    let t = ps.world.spawn(&ps.scene, target as usize, v3(12.0, 0.0, -5.0), 0.0);
    assert!(g >= 0 && t >= 0);
    let mut hits = 0;
    let mut death = None;
    for _ in 0..240 {
        let n = ps.step(1.0 / 60.0);
        for e in 0..n {
            let r = &ps.world.events[e * 8..e * 8 + 8];
            if r[EF::TYPE] as u32 == EV::HIT {
                hits += 1;
            }
            if r[EF::TYPE] as u32 == EV::DEATH {
                death = Some((r[EF::A] as i32, r[EF::B] as i32, r[EF::VALUE]));
            }
        }
        if death.is_some() {
            break;
        }
    }
    assert_eq!(hits, 2, "two 5-damage shots kill 10 hp");
    let (who, killer, value) = death.expect("target died");
    assert_eq!(who, t);
    assert_eq!(killer, g, "credit goes to the shooter, not the shot");
    assert_eq!(value, 100.0);
    assert!(!ps.world.alive(t as usize));
}

#[test]
fn frame_groups_instances_into_palette_draws() {
    let mut ps = Playset::new(128, 0);
    let model = ps.scene.add_model(&boxes(&[(1.0, 1.0, 1.0, [0.0, 0.0, 0.0], 1.0)])).unwrap();
    let mut a = arch();
    a[A::MODEL] = (model + 1) as f32;
    let a = ps.world.add_arch(&a);
    for i in 0..45 {
        ps.world.spawn(&ps.scene, a as usize, v3((i % 9) as f32 * 2.0 - 8.0, 0.0, -10.0 - (i / 9) as f32 * 2.0), 0.0);
    }
    let mut cam = [0.0f32; 24];
    cam[crate::schema::camera::EY] = 6.0;
    cam[crate::schema::camera::EZ] = 6.0;
    cam[crate::schema::camera::LZ] = -14.0;
    ps.rig.set(&cam);
    ps.step(1.0 / 60.0);
    let frame = ps.prepare(400.0 / 240.0);
    let f = unsafe { &*frame };
    // 45 boxes at 20 per draw: three draws
    assert_eq!(f.draw_count, 3);
    assert_eq!(f.bone_count, 1 + 45);
    let draws = unsafe { core::slice::from_raw_parts(f.draws, f.draw_count as usize) };
    assert_eq!(draws[0].bones, 20);
    assert_eq!(draws[0].index_count, 36 * 20);
    assert_eq!(draws[2].bones, 5);
}

#[test]
fn static_nodes_bake_into_batches() {
    let mut ps = Playset::new(16, 0);
    let model = ps.scene.add_model(&boxes(&[(1.0, 1.0, 1.0, [0.0, 0.0, 0.0], 1.0)])).unwrap();
    for i in 0..100 {
        let m = Mat34::from_ypr(v3(i as f32 * 1.5, 0.0, -20.0), 0.0, 0.0, 0.0, 1.0);
        ps.scene.add_node(model, m, crate::schema::node::STATIC | crate::schema::node::COLLIDE_BOX);
    }
    ps.prepare(400.0 / 240.0);
    // 150 m of boxes in 32 m cells
    assert_eq!(ps.scene.batches.len(), 5);
    assert_eq!(ps.scene.colliders.len(), 100);
    let total: usize = ps.scene.batches.iter().map(|b| b.idx.len()).sum();
    assert_eq!(total, 3600);
}

#[test]
fn planar_player_slides_along_a_wall() {
    let mut ps = Playset::new(16, 0);
    let mut a = arch();
    a[A::MOTION] = M::PLANAR as f32;
    a[A::MOTION_P] = 100.0;
    a[A::MOTION_P + 1] = 10.0;
    a[A::MOTION_P + 2] = 8.0;
    a[A::RADIUS] = 0.5;
    a[A::LAYER] = 1.0;
    let a = ps.world.add_arch(&a);
    ps.scene.colliders.push(crate::scene::Collider::Box { c: v3(0.0, 0.0, -5.0), half: v3(10.0, 2.0, 0.5), yaw: 0.0 });
    let s = ps.world.spawn(&ps.scene, a as usize, v3(0.0, 0.0, 0.0), 0.0) as usize;
    for _ in 0..120 {
        ps.world.set_intent(s, crate::schema::intent::FWD, 1.0);
        ps.world.set_intent(s, crate::schema::intent::X, 0.5);
        ps.step(1.0 / 60.0);
    }
    let p = ps.world.pos(s);
    assert!(p.z > -4.6 && p.z < -3.9, "stopped at the wall face, z = {}", p.z);
    assert!(p.x > 3.0, "kept sliding sideways, x = {}", p.x);
}

#[test]
fn a_leading_turret_targets_the_creep_furthest_along_its_path() {
    let mut ps = Playset::new(32, 0);
    let path = ps.world.add_path(&[-20.0, 0.0, 0.0, 20.0, 0.0, 0.0]);
    let mut creep = arch();
    creep[A::MOTION] = M::PATH as f32;
    creep[A::MOTION_P] = 1.0;
    creep[A::MOTION_P + 1] = path as f32;
    creep[A::LAYER] = 4.0;
    creep[A::RADIUS] = 0.5;
    let creep = ps.world.add_arch(&creep);
    let mut tower = arch();
    tower[A::BRAIN_P] = 4.0;
    tower[A::BRAIN_P + 1] = 4.0;
    tower[A::BRAIN_P + 5] = 30.0;
    tower[A::BRAIN_P + 8] = 0.05;
    let tower = ps.world.add_arch(&steering(tower, &[state(1.0, (0.0, 0.0), &[], &[])]));
    let t = ps.world.spawn(&ps.scene, tower as usize, v3(0.0, 0.0, 5.0), 0.0) as usize;
    // the first creep starts sooner and stays ahead; the second is nearer the tower
    let first = ps.world.spawn(&ps.scene, creep as usize, v3(-20.0, 0.0, 0.0), 0.0);
    for _ in 0..240 {
        ps.step(1.0 / 60.0);
    }
    let second = ps.world.spawn(&ps.scene, creep as usize, v3(-20.0, 0.0, 0.0), 0.0);
    ps.world.set(second as usize, crate::schema::ent::SPEED, 0.5);
    for _ in 0..60 {
        ps.step(1.0 / 60.0);
    }
    assert!(ps.world.pos(first as usize).x > ps.world.pos(second as usize).x);
    assert_eq!(ps.world.e(t, crate::schema::ent::TARGET) as i32, first);
    // nearest picks the other one when the tower stands by it
    ps.world.archs[tower as usize][A::BRAIN_P] = 1.0;
    let near = ps.world.pos(second as usize);
    ps.world.set_pos(t, v3(near.x, 0.0, 1.0));
    for _ in 0..10 {
        ps.step(1.0 / 60.0);
    }
    assert_eq!(ps.world.e(t, crate::schema::ent::TARGET) as i32, second);
}

/// A banked plane (GameBlocks' AirplaneMotionController) with its demo tuning.
fn banked_plane(ps: &mut Playset, floor: f32) -> usize {
    let mut a = arch();
    a[A::MOTION] = M::PLANE as f32;
    let p = [8.8, 26.0, 0.0, 1.35, 0.0, 0.78, 0.56, 0.0, 0.0, 2.0, 1.0, 0.55, 0.56, 0.26, 1.1868, 0.21, 0.9774, 1.7, 1.28, 0.55, floor, 0.08];
    a[A::MOTION_P..A::MOTION_P + p.len()].copy_from_slice(&p);
    a[A::LAYER] = 1.0;
    a[A::RADIUS] = 3.0;
    ps.world.add_arch(&a) as usize
}

#[test]
fn banked_plane_turns_toward_its_bank_and_settles_on_cruise() {
    use crate::schema::{ent as E, intent as I};
    let mut ps = Playset::new(16, 0);
    let a = banked_plane(&mut ps, 0.0);
    let s = ps.world.spawn(&ps.scene, a, v3(0.0, 50.0, 0.0), 0.0) as usize;
    ps.world.set(s, E::SPEED, 15.0);
    for _ in 0..60 {
        ps.world.set_intent(s, I::TURN, 1.0);
        ps.step(1.0 / 60.0);
    }
    // right bank: ENT.ROLL negative (right wing down), heading clockwise
    assert!(ps.world.e(s, E::ROLL) < -0.9, "banked right, roll = {}", ps.world.e(s, E::ROLL));
    assert!(ps.world.e(s, E::YAW) < -0.2, "turned right, yaw = {}", ps.world.e(s, E::YAW));
    assert!(ps.world.pos(s).x > 1.0, "moved right of its start");
    for _ in 0..600 {
        ps.world.set_intent(s, I::TURN, 0.0);
        ps.step(1.0 / 60.0);
    }
    // the throttle holds 0.55: cruise = 8.8 + 0.55 * (26 - 8.8)
    let cruise = 8.8 + 0.55 * (26.0 - 8.8);
    assert!((ps.world.e(s, E::SPEED) - cruise).abs() < 0.2, "cruise speed {}", ps.world.e(s, E::SPEED));
    assert!(ps.world.e(s, E::ROLL).abs() < 0.05, "levelled out");
}

#[test]
fn banked_plane_holds_its_floor_and_pursue_breaks_away() {
    use crate::schema::{ent as E, intent as I};
    let mut ps = Playset::new(16, 0);
    let a = banked_plane(&mut ps, 7.0);
    let s = ps.world.spawn(&ps.scene, a, v3(0.0, 20.0, 0.0), 0.0) as usize;
    for _ in 0..240 {
        ps.world.set_intent(s, I::RISE, -1.0);
        ps.step(1.0 / 60.0);
    }
    assert!(ps.world.pos(s).y >= 7.0 - 1e-3, "stopped at the floor, y = {}", ps.world.pos(s).y);
    // a pursuer inside its breakaway distance turns away from the target
    // (the brain.pursue preset with breakaway 70 and throttleDistance 90)
    let mut hunter = ps.world.archs[a].to_vec();
    hunter[A::BRAIN_P] = 1.0;
    hunter[A::BRAIN_P + 1] = 1.0;
    hunter[A::LAYER] = 2.0;
    let seek = [T::SEEK as f32, 1.0, 0.0, 0.0, 0.0, 0.0];
    let flee = [T::FLEE as f32, 1.0, 0.0, 0.0, 0.0, 0.0];
    let (near, breakaway, far) = (C::NEAR as f32, C::NEAR as f32, C::FAR as f32);
    let mut states = vec![
        state(1.0, (50.0, 0.3), &[seek], &[[breakaway, 70.0, 2.0], [near, 90.0, 1.0]]),
        state(1.0, (50.0, 0.3), &[seek], &[[breakaway, 70.0, 2.0], [far, 90.0, 0.0]]),
        state(1.0, (0.0, 0.0), &[flee], &[[far, 70.0, 1.0]]),
    ];
    states[0].fwd = Some(1.0);
    states[1].fwd = Some(-0.25);
    states[2].fwd = Some(-0.25);
    let hunter = ps.world.add_arch(&steering(hunter, &states)) as usize;
    let at = ps.world.pos(s) + v3(30.0, 10.0, 0.0);
    let h = ps.world.spawn(&ps.scene, hunter, at, 0.0) as usize;
    ps.step(1.0 / 60.0);
    // the target is to its left (-X): breaking away banks it right, throttle eased
    assert!(ps.world.intent(h, I::TURN) > 0.5, "banks away, turn = {}", ps.world.intent(h, I::TURN));
    assert!(ps.world.intent(h, I::FWD) < 0.0, "eases the throttle inside the throttle distance");
    assert!(ps.world.intent(h, I::FIRE) < 0.5, "holds fire while breaking away");
}

#[test]
fn a_yawed_box_node_collides_where_it_is_drawn() {
    let mut ps = Playset::new(16, 0);
    // a 10 x 2 wall turned 90 degrees: it runs along Z through the origin
    let wall = ps.scene.add_model(&boxes(&[(10.0, 2.0, 2.0, [0.0, 0.0, 0.0], 1.0)])).unwrap();
    let m = Mat34::from_ypr(Vec3::ZERO, core::f32::consts::FRAC_PI_2, 0.0, 0.0, 1.0);
    ps.scene.add_node(wall, m, crate::schema::node::STATIC | crate::schema::node::COLLIDE_BOX);
    let mut a = arch();
    a[A::RADIUS] = 0.5;
    a[A::LAYER] = 1.0;
    let a = ps.world.add_arch(&a) as usize;
    // a body 3 m down the wall's length is inside it and gets pushed out sideways
    let s = ps.world.spawn(&ps.scene, a, v3(0.3, 0.0, 3.0), 0.0) as usize;
    ps.step(1.0 / 60.0);
    let p = ps.world.pos(s);
    assert!(p.x > 1.4, "pushed out of the wall's side, x = {}", p.x);
    assert!((p.z - 3.0).abs() < 1e-3, "not along its length, z = {}", p.z);
}

#[test]
fn seek_scales_its_speed_inside_near() {
    let mut ps = Playset::new(16, 0);
    let mut prey = arch();
    prey[A::LAYER] = 1.0;
    prey[A::RADIUS] = 0.5;
    let prey = ps.world.add_arch(&prey);
    let mut hunter = arch();
    hunter[A::MOTION] = M::PLANAR as f32;
    hunter[A::MOTION_P] = 1000.0;
    hunter[A::MOTION_P + 1] = 10.0;
    hunter[A::BRAIN_P] = 1.0;
    hunter[A::BRAIN_P + 1] = 1.0;
    // the brain.seek preset with speed 0.5, near 20 and nearSpeed 2
    let seek = [T::SEEK as f32, 1.0, 0.0, 0.0, 0.0, 0.0];
    let hunter = ps.world.add_arch(&steering(
        hunter,
        &[state(0.5, (0.0, 0.0), &[seek], &[[C::NEAR as f32, 20.0, 1.0]]), state(1.0, (0.0, 0.0), &[seek], &[[C::FAR as f32, 20.0, 0.0]])],
    ));
    ps.world.spawn(&ps.scene, prey as usize, v3(0.0, 0.0, 0.0), 0.0);
    let far = ps.world.spawn(&ps.scene, hunter as usize, v3(50.0, 0.0, 0.0), 0.0) as usize;
    let near = ps.world.spawn(&ps.scene, hunter as usize, v3(0.0, 0.0, 10.0), 0.0) as usize;
    for _ in 0..3 {
        ps.step(1.0 / 60.0);
    }
    let (vf, vn) = (ps.world.vel(far).len(), ps.world.vel(near).len());
    assert!((vf - 5.0).abs() < 0.1, "outside near: half speed, {vf}");
    assert!((vn - 10.0).abs() < 0.1, "inside near: twice that, {vn}");
}

#[test]
fn a_kill_between_steps_reports_its_death_in_the_next_step() {
    let mut ps = Playset::new(16, 0);
    let mut a = arch();
    a[A::HP] = 5.0;
    let a = ps.world.add_arch(&a);
    let s = ps.world.spawn(&ps.scene, a as usize, Vec3::ZERO, 0.0) as usize;
    ps.step(1.0 / 60.0);
    // what a guest's play.kill(slot, "event") does after reading the step
    ps.world.kill_mode(s, -1, crate::world::KILL_EVENT);
    let n = ps.step(1.0 / 60.0);
    let deaths = (0..n).filter(|&e| ps.world.events[e * 8 + EF::TYPE] as u32 == EV::DEATH && ps.world.events[e * 8 + EF::A] as usize == s).count();
    assert_eq!(deaths, 1);
    let n = ps.step(1.0 / 60.0);
    assert_eq!((0..n).filter(|&e| ps.world.events[e * 8 + EF::TYPE] as u32 == EV::DEATH).count(), 0, "reported once");
}

#[test]
fn the_water_grid_matches_height_and_normal() {
    let w = crate::scene::Water { active: true, level: 0.3, amplitude: 0.7, wavelength: 48.0, speed: 5.0, half: 230.0, cells: 32, ..Default::default() };
    let t = 12.34;
    let mut worst = (0.0f32, 0.0f32);
    w.grid(-230.0, -230.0, 460.0 / 32.0, 33, t, |_, x, z, h, n| {
        worst.0 = worst.0.max((h - w.height(x, z, t)).abs());
        worst.1 = worst.1.max((n - w.normal(x, z, t)).len());
    });
    assert!(worst.0 < 1e-3, "height off by {}", worst.0);
    assert!(worst.1 < 2e-3, "normal off by {}", worst.1);
}
