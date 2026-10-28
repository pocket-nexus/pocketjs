//! Motion kernels: one integrator per genre, selected by the archetype's
//! MOTION id and tuned by its MOTION_P floats. Every kernel reads the slot's
//! INTENT floats (written by its brain or by the guest) and writes position,
//! velocity and attitude back into ENT.
//!
//! Intent signs: X > 0 strafes right, FWD > 0 drives forward, TURN > 0 turns
//! right (clockwise from above), RISE > 0 climbs / pitches up / looks up.

use crate::fmath::*;
use crate::schema::{arch as A, ent as E, event as EV, intent as I, joint_driver as JD, motion as M, state as ST};
use crate::scene::Scene;
use crate::vec::*;
use crate::world::World;

#[inline]
fn p(w: &World, arch: usize, i: usize) -> f32 {
    w.archs[arch][A::MOTION_P + i]
}

/// A tuning float, or its default when the descriptor leaves it at 0.
#[inline]
fn or(v: f32, default: f32) -> f32 {
    if v > 0.0 {
        v
    } else {
        default
    }
}

/// Planar velocity toward `target` at `accel`, decaying by `damping` when
/// the target is zero (GameBlocks' GeneralVehicleMotionController).
fn approach_velocity(v: Vec3, target: Vec3, accel: f32, damping: f32, dt: f32) -> Vec3 {
    if target.len_sq() < 1e-6 {
        return v * expf(-damping * dt);
    }
    let dv = target - v;
    let step = accel * dt;
    let l = dv.len();
    if l <= step {
        target
    } else {
        v + dv * (step / l)
    }
}

pub fn on_spawn(w: &mut World, scene: &Scene, slot: usize, arch: usize) {
    let kind = w.archs[arch][A::MOTION] as u32;
    w.s[slot].k = [0.0; 8];
    match kind {
        M::PATH => {
            let jitter = p(w, arch, 4);
            w.s[slot].k[2] = w.rng.signed() * jitter;
            w.set(slot, E::SPEED, p(w, arch, 0));
        }
        M::RUNNER => {
            let lanes = maxf(p(w, arch, 4), 1.0);
            w.s[slot].k[0] = floorf((lanes - 1.0) * 0.5 + 0.5);
            w.s[slot].k[1] = w.pos(slot).x;
            w.set(slot, E::SPEED, p(w, arch, 0));
        }
        M::PLANE => {
            let s = maxf(p(w, arch, 0), p(w, arch, 0) * 0.5 + p(w, arch, 1) * 0.5);
            w.set(slot, E::SPEED, s);
            // banked mode: k[2] throttle, k[3] boosting, k[4] boost left, k[5] boost held
            w.s[slot].k[2] = clampf(p(w, arch, 19), 0.0, 1.0);
        }
        M::BOAT | M::CAR => {}
        _ => {}
    }
    let lift = w.archs[arch][A::HEIGHT] * 0.5;
    w.s[slot].k[7] = lift;
    let _ = scene;
}

pub fn step(w: &mut World, scene: &Scene, slot: usize, dt: f32) {
    let Some(arch) = w.arch_of(slot) else { return };
    let kind = w.archs[arch][A::MOTION] as u32;
    match kind {
        M::BALLISTIC => ballistic(w, scene, slot, arch, dt),
        M::LINEAR => linear(w, slot, arch, dt),
        M::PLANAR => planar(w, slot, arch, dt),
        M::CHARACTER => character(w, scene, slot, arch, dt),
        M::CAR => car(w, scene, slot, arch, dt),
        M::BOAT => boat(w, scene, slot, arch, dt),
        M::PLANE => plane(w, scene, slot, arch, dt),
        M::HOVER => hover(w, scene, slot, arch, dt),
        M::PATH => path(w, slot, arch, dt),
        M::TURRET => turret(w, slot, arch, dt),
        M::ATTACHED => attached(w, slot, dt),
        M::RUNNER => runner(w, scene, slot, arch, dt),
        // driven by their modules after the world's step (modules/)
        M::SNAKE | M::MARBLE => {}
        _ => {
            // NONE: velocity integrates, nothing steers
            let v = w.vel(slot);
            if v.len_sq() > 0.0 {
                let p0 = w.pos(slot);
                w.set_pos(slot, p0 + v * dt);
            }
        }
    }
    drive_joints(w, slot, arch, dt);
}

fn ballistic(w: &mut World, scene: &Scene, slot: usize, arch: usize, dt: f32) {
    let (gs, drag, bounce, kill, align) = (p(w, arch, 0), p(w, arch, 1), p(w, arch, 2), p(w, arch, 3), p(w, arch, 4));
    if w.s[slot].k[0] > 0.5 {
        return; // stuck in the ground
    }
    let mut v = w.vel(slot);
    v.y -= scene.env.gravity * gs * dt;
    if drag > 0.0 {
        v = v * expf(-drag * dt);
    }
    let mut pos = w.pos(slot) + v * dt;
    let mut floor = scene.ground_height(pos.x, pos.z);
    if scene.water.active {
        floor = maxf(floor, scene.water.height(pos.x, pos.z, w.time));
    }
    if pos.y <= floor && gs > 0.0 {
        pos.y = floor;
        w.emit_event(EV::GROUND, slot as i32, w.s[slot].owner, arch as f32, pos, v.len());
        if kill > 0.5 {
            w.set_pos(slot, pos);
            w.kill(slot, -1, false);
            return;
        }
        if bounce > 0.0 {
            v.y = -v.y * bounce;
            v.x *= 0.8;
            v.z *= 0.8;
            if absf(v.y) < 1.0 {
                v.y = 0.0;
            }
        } else {
            v = Vec3::ZERO;
            w.s[slot].k[0] = 1.0;
        }
    }
    w.set_pos(slot, pos);
    w.set_vel(slot, v);
    if align > 0.5 && v.len_sq() > 0.01 {
        w.set(slot, E::YAW, yaw_of(v.x, v.z));
        w.set(slot, E::PITCH, asinf(v.y / v.len()));
    }
}

fn linear(w: &mut World, slot: usize, arch: usize, dt: f32) {
    let (speed0, turn, accel, max) = (p(w, arch, 0), p(w, arch, 1), p(w, arch, 2), p(w, arch, 3));
    let mut speed = w.e(slot, E::SPEED);
    if speed <= 0.0 {
        speed = speed0;
    }
    if accel > 0.0 {
        speed = minf(speed + accel * dt, if max > 0.0 { max } else { 1e9 });
    }
    let mut yaw = w.e(slot, E::YAW);
    let mut pitch = w.e(slot, E::PITCH);
    let target = w.e(slot, E::TARGET) as i32;
    if turn > 0.0 && target >= 0 && w.alive(target as usize) {
        let d = w.pos(target as usize) - w.pos(slot);
        yaw = approach_angle(yaw, yaw_of(d.x, d.z), turn * dt);
        let want = atan2f(d.y, d.flat().len());
        pitch = approach_angle(pitch, want, turn * dt);
    }
    let dir = Mat34::from_ypr(Vec3::ZERO, yaw, pitch, 0.0, 1.0).vector(v3(0.0, 0.0, -1.0));
    let v = dir * speed;
    let pos = w.pos(slot) + v * dt;
    w.set_pos(slot, pos);
    w.set_vel(slot, v);
    w.set(slot, E::YAW, yaw);
    w.set(slot, E::PITCH, pitch);
    w.set(slot, E::SPEED, speed);
}

fn planar(w: &mut World, slot: usize, arch: usize, dt: f32) {
    let (accel, max, damping, frame, turn_rate, face, boost, vert) =
        (p(w, arch, 0), p(w, arch, 1), p(w, arch, 2), p(w, arch, 3) as u32, p(w, arch, 4), p(w, arch, 5) as u32, p(w, arch, 6), p(w, arch, 7));
    let mut yaw = w.e(slot, E::YAW);
    let (ix, iz, it, ir) = (w.intent(slot, I::X), w.intent(slot, I::FWD), w.intent(slot, I::TURN), w.intent(slot, I::RISE));
    let dir = match frame {
        1 => right_of(yaw) * ix + forward_of(yaw) * iz,
        2 => {
            yaw -= it * turn_rate * dt;
            forward_of(yaw) * iz
        }
        _ => v3(ix, 0.0, -iz),
    };
    let mag = minf(dir.len(), 1.0);
    let boosted = if w.intent(slot, I::AUX) > 0.5 && boost > 0.0 { boost } else { 1.0 };
    let target = if mag > 1e-3 { dir.normalized() * (max * mag * boosted) } else { Vec3::ZERO };
    let mut v = w.vel(slot);
    let vy = v.y;
    v = approach_velocity(v.flat(), target, accel * boosted, damping, dt);
    v.y = if vert > 0.0 { approach(vy, ir * vert, accel * dt) } else { 0.0 };
    let pos = w.pos(slot) + v * dt;
    match face {
        1 if v.flat().len_sq() > 0.25 => yaw = approach_angle(yaw, yaw_of(v.x, v.z), turn_rate * dt),
        2 => {
            let t = w.e(slot, E::TARGET) as i32;
            if t >= 0 && w.alive(t as usize) {
                let d = w.pos(t as usize) - pos;
                yaw = approach_angle(yaw, yaw_of(d.x, d.z), turn_rate * dt);
            }
        }
        3 if frame != 2 => yaw -= it * turn_rate * dt,
        _ => {}
    }
    // a little bank into the turn, for ships
    let bank = p(w, arch, 8);
    if bank > 0.0 {
        let lateral = v.dot(right_of(yaw)) / maxf(max, 1.0);
        let roll = lerpf(w.e(slot, E::ROLL), -lateral * bank, smoothing(8.0, dt));
        w.set(slot, E::ROLL, roll);
    }
    w.set_pos(slot, pos);
    w.set_vel(slot, v);
    w.set(slot, E::YAW, wrap_angle(yaw));
    w.set(slot, E::SPEED, v.dot(forward_of(yaw)));
}

fn character(w: &mut World, scene: &Scene, slot: usize, arch: usize, dt: f32) {
    let (walk, run, accel, air, jump, gs, turn_rate, frame, face, pitch_rate, pitch_max) = (
        p(w, arch, 0),
        p(w, arch, 1),
        p(w, arch, 2),
        p(w, arch, 3),
        p(w, arch, 4),
        p(w, arch, 5),
        p(w, arch, 6),
        p(w, arch, 7) as u32,
        p(w, arch, 8) as u32,
        p(w, arch, 9),
        p(w, arch, 10),
    );
    let mut yaw = w.e(slot, E::YAW);
    let (ix, iz, it, ir) = (w.intent(slot, I::X), w.intent(slot, I::FWD), w.intent(slot, I::TURN), w.intent(slot, I::RISE));
    let grounded = w.state(slot) & ST::GROUNDED != 0;
    let dir = match frame {
        // world cardinal: stick up is -Z
        0 => v3(ix, 0.0, -iz),
        // heading relative / first person: strafe and walk on the facing
        1 | 4 => {
            yaw -= it * turn_rate * dt;
            right_of(yaw) * ix + forward_of(yaw) * iz
        }
        // camera relative: the rig's yaw
        2 => right_of(w.cam_yaw) * ix + forward_of(w.cam_yaw) * iz,
        // tank: turn, then walk forward
        _ => {
            yaw -= it * turn_rate * dt;
            forward_of(yaw) * iz
        }
    };
    if frame == 4 {
        let pitch = clampf(w.e(slot, E::PITCH) + ir * pitch_rate * dt, -pitch_max, pitch_max);
        w.set(slot, E::PITCH, pitch);
    }
    let mag = minf(dir.len(), 1.0);
    let speed = walk * if w.intent(slot, I::AUX) > 0.5 && run > 0.0 { run } else { 1.0 };
    let target = if mag > 1e-3 { dir.normalized() * (speed * mag) } else { Vec3::ZERO };
    let mut v = w.vel(slot);
    let control = if grounded { 1.0 } else { air };
    let flat = approach_velocity(v.flat(), target, accel * control, if grounded { accel / maxf(walk, 0.1) } else { 0.2 }, dt);
    v.x = flat.x;
    v.z = flat.z;
    let jump_now = w.intent(slot, I::JUMP) > 0.5;
    if grounded && jump_now && w.s[slot].k[0] < 0.5 && jump > 0.0 {
        v.y = jump;
        w.set_state_bit(slot, ST::GROUNDED, false);
    }
    w.s[slot].k[0] = if jump_now { 1.0 } else { 0.0 };
    v.y -= scene.env.gravity * gs * dt;
    let pos = w.pos(slot) + v * dt;
    if face == 1 && flat.len_sq() > 0.25 {
        yaw = approach_angle(yaw, yaw_of(flat.x, flat.z), turn_rate * dt);
    }
    // walk cycle phase for SWING joints
    w.s[slot].k[1] += flat.len() * dt;
    w.set_pos(slot, pos);
    w.set_vel(slot, v);
    w.set(slot, E::YAW, wrap_angle(yaw));
    w.set(slot, E::SPEED, flat.len());
}

fn car(w: &mut World, scene: &Scene, slot: usize, arch: usize, dt: f32) {
    let (accel, max, rev, brake, steer_max, steer_rate, grip, drag, drift, wheelbase, gs, boost) = (
        p(w, arch, 0),
        p(w, arch, 1),
        p(w, arch, 2),
        p(w, arch, 3),
        p(w, arch, 4),
        p(w, arch, 5),
        p(w, arch, 6),
        p(w, arch, 7),
        p(w, arch, 8),
        maxf(p(w, arch, 9), 0.5),
        p(w, arch, 10),
        p(w, arch, 11),
    );
    let throttle = clampf(w.intent(slot, I::FWD), -1.0, 1.0);
    let steer_in = clampf(w.intent(slot, I::TURN), -1.0, 1.0);
    let handbrake = w.intent(slot, I::JUMP) > 0.5;
    let boosting = w.intent(slot, I::AUX) > 0.5 && boost > 0.0;
    let mut yaw = w.e(slot, E::YAW);
    let steer = approach(w.s[slot].k[0], steer_in * steer_max, steer_rate * dt);
    w.s[slot].k[0] = steer;
    let mut v = w.vel(slot);
    let f = forward_of(yaw);
    let r = right_of(yaw);
    let mut vf = v.dot(f);
    let mut vr = v.dot(r);
    let top = if boosting { max * or(p(w, arch, 12), 1.25) } else { max };
    if throttle > 0.0 {
        vf += (accel + if boosting { boost } else { 0.0 }) * throttle * dt;
        if vf > top {
            vf = approach(vf, top, accel * 2.0 * dt);
        }
    } else if throttle < 0.0 {
        if vf > 0.5 {
            vf += brake * throttle * dt;
        } else {
            vf = maxf(vf + accel * 0.6 * throttle * dt, -rev);
        }
    }
    vf -= vf * drag * dt;
    // speed-scaled steering so the car does not pivot in place
    let turn = vf / wheelbase * tanf(steer) * clampf(absf(vf) / 4.0, 0.0, 1.0) / maxf(absf(vf), 1e-3) * absf(vf);
    yaw -= turn * dt;
    let g = if handbrake { drift } else { grip };
    vr *= expf(-g * dt);
    let f2 = forward_of(yaw);
    let r2 = right_of(yaw);
    let mut vy = v.y;
    let n = scene.ground_normal(w.pos(slot).x, w.pos(slot).z);
    let slope = v3(n.x, 0.0, n.z) * (scene.env.gravity * gs);
    v = f2 * vf + r2 * vr + slope * dt;
    vy -= scene.env.gravity * gs * dt;
    v.y = vy;
    let pos = w.pos(slot) + v * dt;
    w.s[slot].k[1] = if handbrake && absf(vr) > 2.0 { 1.0 } else { 0.0 };
    w.set_pos(slot, pos);
    w.set_vel(slot, v);
    w.set(slot, E::YAW, wrap_angle(yaw));
    w.set(slot, E::SPEED, vf);
}

fn boat(w: &mut World, scene: &Scene, slot: usize, arch: usize, dt: f32) {
    let (accel, max, turn_rate, drag, lateral, bob, roll_k, pitch_k) =
        (p(w, arch, 0), p(w, arch, 1), p(w, arch, 2), p(w, arch, 3), p(w, arch, 4), p(w, arch, 5), p(w, arch, 6), p(w, arch, 7));
    let throttle = clampf(w.intent(slot, I::FWD), -0.5, 1.0);
    let steer = clampf(w.intent(slot, I::TURN), -1.0, 1.0);
    let mut yaw = w.e(slot, E::YAW);
    let mut v = w.vel(slot);
    let mut vf = v.dot(forward_of(yaw));
    let mut vr = v.dot(right_of(yaw));
    vf += throttle * accel * dt;
    vf = clampf(vf, -max * 0.4, max);
    vf -= vf * drag * dt;
    vr *= expf(-lateral * dt);
    let authority = clampf(absf(vf) / maxf(max * 0.3, 0.1), 0.25, 1.0);
    yaw -= steer * turn_rate * authority * dt;
    v = forward_of(yaw) * vf + right_of(yaw) * vr;
    let mut pos = w.pos(slot) + v * dt;
    let offset = w.archs[arch][A::GROUND_OFFSET];
    let t = w.time;
    pos.y = scene.water.height(pos.x, pos.z, t) + offset + bob * sinf(t * 1.7 + slot as f32);
    let n = scene.water.normal(pos.x, pos.z, t);
    let target_pitch = asinf(-(n.dot(forward_of(yaw)))) * pitch_k;
    let target_roll = asinf(n.dot(right_of(yaw))) * pitch_k - steer * roll_k * (vf / maxf(max, 0.1));
    let k = smoothing(4.0, dt);
    w.set(slot, E::PITCH, lerpf(w.e(slot, E::PITCH), target_pitch, k));
    w.set(slot, E::ROLL, lerpf(w.e(slot, E::ROLL), target_roll, k));
    w.set_state_bit(slot, ST::IN_WATER, true);
    w.set_pos(slot, pos);
    w.set_vel(slot, v);
    w.set(slot, E::YAW, wrap_angle(yaw));
    w.set(slot, E::SPEED, vf);
}

/// `1 - e^(-dt / lag)`: GameBlocks' smoothingAlpha.
#[inline]
fn lag_alpha(lag: f32, dt: f32) -> f32 {
    if lag <= 0.0 {
        1.0
    } else {
        1.0 - expf(-dt / lag)
    }
}

/// The banked plane (MOTION_P 10 = 1): GameBlocks' AirplaneMotionController.
/// TURN holds a bank angle and the bank turns the heading; RISE pitches the
/// flight path; X yaws directly (a rudder); FWD moves a throttle that sets
/// the cruise speed; AUX starts a boost on its press.
///
/// MOTION_P: 0 min speed, 1 max speed, 3 pitch rate, 5 rudder yaw rate,
/// 6 bank turn rate, 9 clearance over the ground, 11 throttle rate, 12 speed
/// lag, 13 boost speed lag, 14 max bank, 15 bank lag, 16 bank turn reference
/// roll, 17 boost seconds, 18 boost multiplier, 19 initial throttle, 20 floor
/// height (0 = none), 21 least pitch on the floor.
fn plane_banked(w: &mut World, scene: &Scene, slot: usize, arch: usize, dt: f32) {
    let (min_s, max_s, pitch_rate, yaw_rate, bank_turn, clearance) = (p(w, arch, 0), p(w, arch, 1), p(w, arch, 3), p(w, arch, 5), p(w, arch, 6), p(w, arch, 9));
    let throttle_rate = or(p(w, arch, 11), 0.42);
    let speed_lag = or(p(w, arch, 12), 0.56);
    let boost_lag = or(p(w, arch, 13), 0.26);
    let max_bank = or(p(w, arch, 14), 1.1868);
    let bank_lag = or(p(w, arch, 15), 0.21);
    let turn_ref = or(p(w, arch, 16), 0.9774);
    let boost_time = or(p(w, arch, 17), 1.7);
    let boost_mult = or(p(w, arch, 18), 1.28);
    let (floor_abs, floor_pitch) = (p(w, arch, 20), p(w, arch, 21));
    let pitch_in = clampf(w.intent(slot, I::RISE), -1.0, 1.0);
    let bank_in = clampf(w.intent(slot, I::TURN), -1.0, 1.0);
    let rudder = clampf(w.intent(slot, I::X), -1.0, 1.0);
    let throttle_in = w.intent(slot, I::FWD);
    let boost_held = w.intent(slot, I::AUX) > 0.5;
    let k = &mut w.s[slot].k;
    if throttle_in > 0.0 {
        k[2] = minf(1.0, k[2] + throttle_rate * dt);
    } else if throttle_in < 0.0 {
        k[2] = maxf(0.0, k[2] - throttle_rate * dt);
    }
    if k[4] > 0.0 {
        k[4] -= dt;
        if k[4] <= 0.0 {
            k[4] = 0.0;
            k[3] = 0.0;
        }
    }
    if boost_held {
        if k[5] < 0.5 && k[3] < 0.5 {
            k[3] = 1.0;
            k[4] = boost_time;
        }
        k[5] = 1.0;
    } else {
        k[5] = 0.0;
    }
    let boosting = k[3] > 0.5;
    let cruise = min_s + k[2] * (max_s - min_s);
    let target = if boosting { max_s * boost_mult } else { cruise };
    let mut speed = w.e(slot, E::SPEED);
    speed += (target - speed) * lag_alpha(if boosting { boost_lag } else { speed_lag }, dt);
    let effect = if speed > min_s || min_s <= 0.0 { 1.0 } else { speed / min_s };
    let mut pitch = w.e(slot, E::PITCH) + pitch_in * pitch_rate * dt * effect;
    // the controller's roll is positive to the right; ENT.ROLL is positive to the left
    let mut bank = clampf(-w.e(slot, E::ROLL), -max_bank, max_bank);
    bank += (bank_in * max_bank - bank) * lag_alpha(bank_lag, dt);
    let mut yaw = w.e(slot, E::YAW);
    yaw += clampf(-bank / turn_ref, -1.0, 1.0) * bank_turn * dt * effect;
    yaw -= rudder * yaw_rate * dt;
    let fwd = Mat34::from_ypr(Vec3::ZERO, yaw, pitch, 0.0, 1.0).vector(v3(0.0, 0.0, -1.0));
    let mut pos = w.pos(slot) + fwd * (speed * dt);
    let mut floor = scene.ground_height(pos.x, pos.z) + clearance;
    if floor_abs != 0.0 {
        floor = maxf(floor, floor_abs);
    }
    if pos.y < floor {
        pos.y = floor;
        pitch = maxf(pitch, floor_pitch);
    }
    let pitch = wrap_angle(pitch);
    let yaw = wrap_angle(yaw);
    w.s[slot].quat = Quat::from_ypr(yaw, pitch, -bank);
    w.set_pos(slot, pos);
    w.set_vel(slot, fwd * speed);
    w.set(slot, E::YAW, yaw);
    w.set(slot, E::PITCH, pitch);
    w.set(slot, E::ROLL, -bank);
    w.set(slot, E::SPEED, speed);
}

fn plane(w: &mut World, scene: &Scene, slot: usize, arch: usize, dt: f32) {
    if p(w, arch, 10) > 0.5 {
        return plane_banked(w, scene, slot, arch, dt);
    }
    let (min_s, max_s, accel, pitch_rate, roll_rate, yaw_rate, bank_turn, level, gfx, min_alt) = (
        p(w, arch, 0),
        p(w, arch, 1),
        p(w, arch, 2),
        p(w, arch, 3),
        p(w, arch, 4),
        p(w, arch, 5),
        p(w, arch, 6),
        p(w, arch, 7),
        p(w, arch, 8),
        p(w, arch, 9),
    );
    let pitch_in = clampf(w.intent(slot, I::RISE), -1.0, 1.0);
    let roll_in = clampf(w.intent(slot, I::TURN), -1.0, 1.0);
    let yaw_in = clampf(w.intent(slot, I::X), -1.0, 1.0);
    let throttle = clampf(w.intent(slot, I::FWD), -1.0, 1.0);
    let mut q = w.s[slot].quat;
    // local axes
    q = q.mul(Quat::axis_angle(v3(1.0, 0.0, 0.0), pitch_in * pitch_rate * dt));
    q = q.mul(Quat::axis_angle(v3(0.0, 0.0, -1.0), roll_in * roll_rate * dt));
    q = q.mul(Quat::axis_angle(Vec3::UP, -yaw_in * yaw_rate * dt));
    let (_, _, roll) = q.to_ypr();
    // banked flight turns the heading about world up
    q = Quat::axis_angle(Vec3::UP, -sinf(roll) * bank_turn * dt).mul(q);
    if absf(roll_in) < 0.1 && level > 0.0 {
        q = q.mul(Quat::axis_angle(v3(0.0, 0.0, -1.0), clampf(roll, -1.0, 1.0) * level * dt));
    }
    q = q.normalized();
    let fwd = q.rotate(v3(0.0, 0.0, -1.0));
    let mut speed = w.e(slot, E::SPEED);
    speed += throttle * accel * dt - fwd.y * scene.env.gravity * gfx * dt;
    speed = clampf(speed, min_s, max_s);
    let v = fwd * speed;
    let mut pos = w.pos(slot) + v * dt;
    let floor = scene.ground_height(pos.x, pos.z) + min_alt;
    if pos.y < floor {
        pos.y = floor;
        // pull the nose up over terrain
        if fwd.y < 0.0 {
            q = q.mul(Quat::axis_angle(v3(1.0, 0.0, 0.0), -fwd.y * 2.0 * dt)).normalized();
        }
    }
    w.s[slot].quat = q;
    let (yaw, pitch, roll) = q.to_ypr();
    w.set_pos(slot, pos);
    w.set_vel(slot, v);
    w.set(slot, E::YAW, yaw);
    w.set(slot, E::PITCH, pitch);
    w.set(slot, E::ROLL, roll);
    w.set(slot, E::SPEED, speed);
}

fn hover(w: &mut World, scene: &Scene, slot: usize, arch: usize, dt: f32) {
    let (accel, max, damping, vaccel, vmax, turn_rate, tilt, gs, min_y, max_y, frame) = (
        p(w, arch, 0),
        p(w, arch, 1),
        p(w, arch, 2),
        p(w, arch, 3),
        p(w, arch, 4),
        p(w, arch, 5),
        p(w, arch, 6),
        p(w, arch, 7),
        p(w, arch, 8),
        p(w, arch, 9),
        p(w, arch, 10) as u32,
    );
    let mut yaw = w.e(slot, E::YAW);
    let (ix, iz, it, ir) = (w.intent(slot, I::X), w.intent(slot, I::FWD), w.intent(slot, I::TURN), w.intent(slot, I::RISE));
    yaw -= it * turn_rate * dt;
    let dir = match frame {
        1 => v3(ix, 0.0, -iz),
        2 => right_of(w.cam_yaw) * ix + forward_of(w.cam_yaw) * iz,
        _ => right_of(yaw) * ix + forward_of(yaw) * iz,
    };
    let mag = minf(dir.len(), 1.0);
    let boosted = if w.intent(slot, I::AUX) > 0.5 { or(p(w, arch, 11), 1.6) } else { 1.0 };
    let lean = or(p(w, arch, 12), 0.5);
    let target = if mag > 1e-3 { dir.normalized() * (max * mag * boosted) } else { Vec3::ZERO };
    let v0 = w.vel(slot);
    let flat = approach_velocity(v0.flat(), target, accel, damping, dt);
    let mut vy = v0.y + ir * vaccel * dt - scene.env.gravity * gs * dt;
    if absf(ir) < 0.05 {
        vy *= expf(-damping * dt);
    }
    vy = clampf(vy, -vmax, vmax);
    let v = v3(flat.x, vy, flat.z);
    let mut pos = w.pos(slot) + v * dt;
    let floor = scene.ground_height(pos.x, pos.z) + min_y;
    if pos.y < floor {
        pos.y = floor;
    }
    if max_y > 0.0 && pos.y > max_y {
        pos.y = max_y;
    }
    // lean into the acceleration
    let acc = (flat - v0.flat()) * (1.0 / maxf(dt, 1e-4));
    let k = smoothing(6.0, dt);
    let want_pitch = -clampf(acc.dot(forward_of(yaw)) * tilt * 0.01, -lean, lean);
    let want_roll = -clampf(acc.dot(right_of(yaw)) * tilt * 0.01, -lean, lean);
    w.set(slot, E::PITCH, lerpf(w.e(slot, E::PITCH), want_pitch, k));
    w.set(slot, E::ROLL, lerpf(w.e(slot, E::ROLL), want_roll, k));
    w.set_pos(slot, pos);
    w.set_vel(slot, v);
    w.set(slot, E::YAW, wrap_angle(yaw));
    w.set(slot, E::SPEED, flat.len());
}

fn path(w: &mut World, slot: usize, arch: usize, dt: f32) {
    let (path_id, looping, turn_rate) = (p(w, arch, 1) as usize, p(w, arch, 2) > 0.5, p(w, arch, 3));
    let Some(points) = w.paths.get(path_id) else { return };
    let count = points.len();
    if count < 2 || w.s[slot].k[3] > 0.5 {
        return;
    }
    let speed = w.e(slot, E::SPEED);
    let mut seg = w.s[slot].k[0] as usize;
    let mut along = w.s[slot].k[1] + speed * dt;
    let lateral = w.s[slot].k[2];
    let mut ended = false;
    loop {
        let a = points[seg.min(count - 1)];
        let b = points[(seg + 1).min(count - 1)];
        let len = (b - a).flat().len();
        if along < len || len < 1e-4 && seg + 1 >= count - 1 {
            break;
        }
        along -= len;
        seg += 1;
        if seg + 1 >= count {
            if looping {
                seg = 0;
            } else {
                seg = count - 2;
                along = (points[count - 1] - points[count - 2]).flat().len();
                ended = true;
                break;
            }
        }
    }
    let a = points[seg];
    let b = points[seg + 1];
    let d = b - a;
    let len = maxf(d.flat().len(), 1e-4);
    let t = clampf(along / len, 0.0, 1.0);
    let dir = d.flat() * (1.0 / len);
    let right = v3(-dir.z, 0.0, dir.x);
    let old = w.pos(slot);
    let mut pos = a.lerp(b, t) + right * lateral;
    pos.y = old.y.max(pos.y);
    let target_yaw = yaw_of(dir.x, dir.z);
    let yaw = if turn_rate > 0.0 { approach_angle(w.e(slot, E::YAW), target_yaw, turn_rate * dt) } else { target_yaw };
    w.s[slot].k[0] = seg as f32;
    w.s[slot].k[1] = along;
    w.set_vel(slot, dir * speed);
    w.set_pos(slot, v3(pos.x, a.y + (b.y - a.y) * t, pos.z));
    w.set(slot, E::YAW, yaw);
    if ended {
        w.s[slot].k[3] = 1.0;
        let p = w.pos(slot);
        w.emit_event(EV::ARRIVE, slot as i32, -1, -1.0, p, 0.0);
    }
}

fn turret(w: &mut World, slot: usize, arch: usize, dt: f32) {
    let (yaw_rate, pitch_rate, min_p, max_p) = (p(w, arch, 0), p(w, arch, 1), p(w, arch, 2), p(w, arch, 3));
    let mut yaw = w.e(slot, E::YAW);
    let mut pitch = w.e(slot, E::PITCH);
    let t = w.e(slot, E::TARGET) as i32;
    if t >= 0 && w.alive(t as usize) {
        let d = w.pos(t as usize) - w.pos(slot);
        yaw = approach_angle(yaw, yaw_of(d.x, d.z), yaw_rate * dt);
        let want = atan2f(d.y, d.flat().len());
        pitch = approach_angle(pitch, clampf(want, min_p, max_p), pitch_rate * dt);
    } else {
        yaw -= w.intent(slot, I::TURN) * yaw_rate * dt;
        pitch = clampf(pitch + w.intent(slot, I::RISE) * pitch_rate * dt, min_p, max_p);
    }
    w.set(slot, E::YAW, wrap_angle(yaw));
    w.set(slot, E::PITCH, pitch);
}

fn attached(w: &mut World, slot: usize, _dt: f32) {
    let parent = w.s[slot].parent;
    if parent < 0 || !w.alive(parent as usize) {
        w.kill(slot, -1, false);
        return;
    }
    let pp = parent as usize;
    let m = Mat34::from_ypr(w.pos(pp), w.e(pp, E::YAW), w.e(pp, E::PITCH), w.e(pp, E::ROLL), 1.0);
    let k = w.s[slot].k;
    let pos = m.point(v3(k[0], k[1], k[2]));
    w.set_pos(slot, pos);
    w.set_vel(slot, w.vel(pp));
    if k[4] > 0.5 {
        // follows the parent's heading plus its own offset
        let yaw = w.e(pp, E::YAW) + k[3];
        w.set(slot, E::YAW, yaw);
        w.set(slot, E::PITCH, w.e(pp, E::PITCH));
        w.set(slot, E::ROLL, w.e(pp, E::ROLL));
    }
}

fn runner(w: &mut World, scene: &Scene, slot: usize, arch: usize, dt: f32) {
    let (accel, max, lane_w, lanes, lane_rate, jump, gs, slide_time) =
        (p(w, arch, 1), p(w, arch, 2), p(w, arch, 3), maxf(p(w, arch, 4), 1.0), p(w, arch, 5), p(w, arch, 6), p(w, arch, 7), p(w, arch, 8));
    let mut speed = w.e(slot, E::SPEED);
    speed = minf(speed + accel * dt, max);
    let ix = w.intent(slot, I::X);
    let k = &mut w.s[slot].k;
    // lane changes on the press edge
    let was = k[3];
    let now = if ix > 0.5 { 1.0 } else if ix < -0.5 { -1.0 } else { 0.0 };
    if now != 0.0 && was == 0.0 {
        k[0] = clampf(k[0] + now, 0.0, lanes - 1.0);
    }
    k[3] = now;
    let target_x = (k[0] - (lanes - 1.0) * 0.5) * lane_w;
    k[1] = approach(k[1], target_x, lane_rate * dt);
    let x = k[1];
    let jump_now = w.intent(slot, I::JUMP) > 0.5 || w.intent(slot, I::RISE) > 0.5;
    let slide_now = w.intent(slot, I::RISE) < -0.5;
    let grounded = w.state(slot) & ST::GROUNDED != 0;
    let mut v = w.vel(slot);
    let k = &mut w.s[slot].k;
    if grounded && jump_now && k[4] < 0.5 {
        v.y = jump;
        k[2] = 0.0;
    }
    if slide_now && k[5] < 0.5 {
        k[2] = slide_time;
        if !grounded {
            v.y = minf(v.y, -jump);
        }
    }
    k[4] = if jump_now { 1.0 } else { 0.0 };
    k[5] = if slide_now { 1.0 } else { 0.0 };
    k[2] = maxf(k[2] - dt, 0.0);
    let sliding = k[2] > 0.0;
    let height = w.archs[arch][A::HEIGHT];
    w.s[slot].k[7] = if sliding { height * 0.2 } else { height * 0.5 };
    v.y -= scene.env.gravity * gs * dt;
    let old = w.pos(slot);
    let pos = v3(x, old.y + v.y * dt, old.z - speed * dt);
    v.x = (x - old.x) / maxf(dt, 1e-4);
    v.z = -speed;
    let slide_lean = or(p(w, arch, 9), 1.1);
    w.set(slot, E::PITCH, lerpf(w.e(slot, E::PITCH), if sliding { -slide_lean } else { 0.0 }, smoothing(14.0, dt)));
    w.set_pos(slot, pos);
    w.set_vel(slot, v);
    w.set(slot, E::SPEED, speed);
    w.set(slot, E::YAW, 0.0);
}

/// The gravity scale a weapon's arc aim solves for: a ballistic body's own,
/// 0 for kernels that fly straight.
pub fn gravity_scale(w: &World, arch: usize) -> f32 {
    if w.archs[arch][A::MOTION] as u32 == M::BALLISTIC {
        maxf(p(w, arch, 0), 0.0)
    } else {
        0.0
    }
}

/// How far along its path a slot is, for targets picked by progress; slots
/// on other kernels count as at the start.
pub fn progress(w: &World, slot: usize) -> f32 {
    match w.arch_of(slot) {
        Some(a) if w.archs[a][A::MOTION] as u32 == M::PATH => w.s[slot].k[0] * 1.0e4 + w.s[slot].k[1],
        _ => 0.0,
    }
}

/// The cosine between the slot's aim and the unit direction `d` to a target:
/// a plane aims along its nose, everything else on the ground plane.
pub fn aim_cos(w: &World, slot: usize, arch: usize, d: Vec3) -> f32 {
    let yaw = w.e(slot, E::YAW);
    if w.archs[arch][A::MOTION] as u32 == M::PLANE {
        Mat34::from_ypr(Vec3::ZERO, yaw, w.e(slot, E::PITCH), 0.0, 1.0).vector(v3(0.0, 0.0, -1.0)).dot(d)
    } else {
        forward_of(yaw).dot(d.flat().normalized())
    }
}

/// A brain's wanted world direction (magnitude 0..1) as this kernel's
/// intents: the stick a player would hold to go that way. `face` is a point
/// to turn toward; `fwd` replaces the FWD intent (a plane's throttle).
pub fn drive(w: &mut World, slot: usize, arch: usize, want: Vec3, face: Option<Vec3>, fwd: Option<f32>) {
    let kind = w.archs[arch][A::MOTION] as u32;
    let frame = p(w, arch, 3) as u32;
    let yaw = w.e(slot, E::YAW);
    let f = forward_of(yaw);
    let r = right_of(yaw);
    let flat = want.flat();
    let m = minf(flat.len(), 1.0);
    let dir = flat.normalized();
    let pos = w.pos(slot);
    // TURN toward a heading: proportional, saturating at 0.6 rad
    let turn_to = |target_yaw: f32| -> f32 { clampf(-wrap_angle(target_yaw - yaw) / 0.6, -1.0, 1.0) };
    let face_yaw = match face {
        Some(t) => {
            let d = t - pos;
            Some(yaw_of(d.x, d.z))
        }
        None if m > 0.05 => Some(yaw_of(dir.x, dir.z)),
        None => None,
    };
    if kind == M::TURRET {
        return;
    }
    let (mut ix, mut it, mut ir) = (0.0, 0.0, 0.0);
    let iz;
    match kind {
        M::PLANAR => match frame {
            1 => {
                ix = dir.dot(r) * m;
                iz = dir.dot(f) * m;
                if let Some(y) = face_yaw {
                    it = turn_to(y);
                }
            }
            2 => {
                if let Some(y) = face_yaw {
                    it = turn_to(y);
                }
                iz = m * clampf(dir.dot(f) * 1.5, 0.0, 1.0);
            }
            _ => {
                ix = dir.x * m;
                iz = -dir.z * m;
                if let Some(y) = face_yaw {
                    it = turn_to(y);
                }
            }
        },
        M::CHARACTER => {
            // the character kernel's frame is MOTION_P 7
            match p(w, arch, 7) as u32 {
                0 | 2 => {
                    ix = dir.x * m;
                    iz = -dir.z * m;
                }
                1 | 4 => {
                    ix = dir.dot(r) * m;
                    iz = dir.dot(f) * m;
                    if let Some(y) = face_yaw {
                        it = turn_to(y);
                    }
                }
                _ => {
                    if let Some(y) = face_yaw {
                        it = turn_to(y);
                    }
                    iz = m * clampf(dir.dot(f) * 1.5, 0.0, 1.0);
                }
            }
        }
        M::HOVER => {
            ix = dir.dot(r) * m;
            iz = dir.dot(f) * m;
            if let Some(y) = face_yaw {
                it = turn_to(y);
            }
            ir = clampf(want.y, -1.0, 1.0);
        }
        M::CAR | M::BOAT => {
            if let Some(y) = face_yaw {
                it = turn_to(y);
            }
            // slow for sharp corners
            iz = m * clampf(1.2 - absf(it) * 0.6, 0.3, 1.0);
        }
        M::PLANE if p(w, arch, 10) > 0.5 => {
            // the banked plane flies by world yaw and pitch errors, as
            // GameBlocks' jet-dogfight steers its fighters: bank and pitch
            // past a deadband, the rudder in proportion
            let d = want.normalized();
            let yaw_error = wrap_angle(yaw_of(d.x, d.z) - yaw);
            let pitch_error = clampf(asinf(clampf(d.y, -0.85, 0.85)) - w.e(slot, E::PITCH), -1.0, 1.0);
            it = if yaw_error > 0.08 { -1.0 } else if yaw_error < -0.08 { 1.0 } else { 0.0 };
            ix = -clampf(yaw_error / 0.85, -1.0, 1.0);
            ir = if pitch_error > 0.04 { 1.0 } else if pitch_error < -0.04 { -1.0 } else { 0.0 };
            iz = 0.6;
        }
        M::PLANE => {
            // steer the nose at the wanted direction in the body frame
            let q = w.s[slot].quat;
            let inv = Quat { x: -q.x, y: -q.y, z: -q.z, w: q.w };
            let local = inv.rotate(want.normalized());
            it = clampf(local.x * 3.0, -1.0, 1.0);
            ir = clampf(local.y * 3.0, -1.0, 1.0);
            iz = 0.6;
            if local.z > 0.0 {
                // behind: hard roll and pull
                ir = 1.0;
            }
        }
        _ => {
            ix = dir.x * m;
            iz = -dir.z * m;
        }
    }
    w.set_intent(slot, I::X, ix);
    w.set_intent(slot, I::FWD, fwd.unwrap_or(iz));
    w.set_intent(slot, I::TURN, it);
    if kind == M::HOVER || kind == M::PLANE {
        w.set_intent(slot, I::RISE, ir);
    }
}

/// Joint angles from the archetype's drivers, read by the renderer.
fn drive_joints(w: &mut World, slot: usize, arch: usize, dt: f32) {
    for d in 0..4 {
        let base = A::JOINTS + d * 4;
        let kind = w.archs[arch][base + 1] as u32;
        if kind == JD::NONE {
            continue;
        }
        let rate = w.archs[arch][base + 3];
        let a = w.s[slot].jangle[d];
        let next = match kind {
            JD::SPIN => a + rate * dt,
            JD::ROLL => a - w.e(slot, E::SPEED) * rate * dt,
            JD::STEER => -w.s[slot].k[0] * if rate > 0.0 { rate } else { 1.0 },
            JD::SWING => sinf(w.s[slot].k[1] * 2.6) * rate * clampf(w.e(slot, E::SPEED), 0.0, 1.0),
            JD::SCRIPT => w.joint[slot * 4 + d],
            JD::BOB => sinf(w.time * TAU * 2.0 + slot as f32) * rate,
            JD::AIM_YAW | JD::AIM_PITCH => {
                let t = w.e(slot, E::TARGET) as i32;
                if t >= 0 && w.alive(t as usize) {
                    let dv = w.pos(t as usize) - w.pos(slot);
                    if kind == JD::AIM_YAW {
                        let want = wrap_angle(yaw_of(dv.x, dv.z) - w.e(slot, E::YAW));
                        approach_angle(a, want, 3.0 * dt)
                    } else {
                        let want = atan2f(dv.y, dv.flat().len());
                        approach_angle(a, want, 2.0 * dt)
                    }
                } else {
                    approach_angle(a, 0.0, 1.0 * dt)
                }
            }
            _ => a,
        };
        w.s[slot].jangle[d] = if kind == JD::SPIN || kind == JD::ROLL { wrap_angle(next) } else { next };
    }
}
