//! End-to-end checks of one Playset: content, a step, a frame.

use crate::model::tests::boxes;
use crate::schema::{arch as A, arch_flag as AF, brain as B, event as EV, event_field as EF, motion as M, rule as R, weapon as W};
use crate::vec::*;
use crate::Playset;
use alloc::vec;
use alloc::vec::Vec;

fn arch() -> Vec<f32> {
    vec![0.0; crate::schema::ARCH_LENGTH]
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
    gun[A::BRAIN] = B::TURRET as f32;
    gun[A::MOTION] = M::TURRET as f32;
    gun[A::MOTION_P] = 10.0;
    gun[A::MOTION_P + 1] = 10.0;
    gun[A::MOTION_P + 2] = -1.0;
    gun[A::MOTION_P + 3] = 1.0;
    gun[A::BRAIN_P] = 1.0;
    gun[A::BRAIN_P + 1] = 4.0;
    gun[A::BRAIN_P + 6] = 50.0;
    gun[A::BRAIN_P + 7] = 0.2;
    gun[A::WEAPON0 + W::PROJECTILE] = (shot + 1) as f32;
    gun[A::WEAPON0 + W::COOLDOWN] = 0.2;
    gun[A::WEAPON0 + W::SPEED] = 30.0;
    let gun = ps.world.add_arch(&gun);
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
