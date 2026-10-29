//! The camera rig: fixed, follow (yaw-relative or full-attitude chase), orbit
//! and first person, smoothed per frame. The guest changes the descriptor;
//! the rig tracks its target natively every step.

use crate::fmath::*;
use crate::schema::{camera as C, camera_field as CF, camera_mode as CM, ent as E};
use crate::vec::*;
use crate::world::World;

pub struct Rig {
    pub d: [f32; 24],
    pub eye: Vec3,
    pub look: Vec3,
    pub up: Vec3,
    pub fov: f32,
    pub near: f32,
    pub far: f32,
    pub shake: f32,
    snapped: bool,
}

impl Default for Rig {
    fn default() -> Self {
        let mut d = [0.0f32; 24];
        d[C::FOV] = 55.0;
        d[C::NEAR] = 0.5;
        d[C::FAR] = 200.0;
        d[C::EY] = 10.0;
        d[C::EZ] = 20.0;
        Rig {
            d,
            eye: v3(0.0, 10.0, 20.0),
            look: Vec3::ZERO,
            up: Vec3::UP,
            fov: 55.0,
            near: 0.5,
            far: 200.0,
            shake: 0.0,
            snapped: false,
        }
    }
}

impl Rig {
    pub fn set(&mut self, d: &[f32]) {
        let n = d.len().min(24);
        let old_target = self.d[C::TARGET];
        let old_mode = self.d[C::MODE];
        self.d[..n].copy_from_slice(&d[..n]);
        if self.d[C::FOV] <= 0.0 {
            self.d[C::FOV] = 55.0;
        }
        if self.d[C::NEAR] <= 0.0 {
            self.d[C::NEAR] = 0.5;
        }
        if self.d[C::FAR] <= self.d[C::NEAR] {
            self.d[C::FAR] = 200.0;
        }
        self.shake += self.d[C::SHAKE];
        self.d[C::SHAKE] = 0.0;
        if old_target != self.d[C::TARGET] || old_mode != self.d[C::MODE] {
            self.snapped = false;
        }
    }

    /// Where the rig wants to be this frame.
    fn wanted(&self, w: &World) -> (Vec3, Vec3, Vec3) {
        let d = &self.d;
        let mode = d[C::MODE] as u32;
        let t = d[C::TARGET] as i32;
        let has = t >= 0 && (t as usize) < w.cap && w.ent[crate::world::eidx(t as usize, E::ARCH)] >= 1.0;
        if mode == CM::FIXED || !has {
            return (v3(d[C::EX], d[C::EY], d[C::EZ]), v3(d[C::LX], d[C::LY], d[C::LZ]), Vec3::UP);
        }
        let t = t as usize;
        let p = w.pos(t);
        let yaw = w.e(t, E::YAW);
        match mode {
            CM::ORBIT => {
                // EX yaw, EY pitch, OZ distance around the target
                let (oy, op) = (d[C::EX], d[C::EY]);
                let dist = if d[C::OZ] > 0.0 { d[C::OZ] } else { 12.0 };
                let back = v3(sinf(oy) * cosf(op), sinf(op), cosf(oy) * cosf(op));
                let look = p + v3(0.0, d[C::LOOK_UP], 0.0);
                (look + back * dist, look, Vec3::UP)
            }
            CM::FIRST_PERSON => {
                let pitch = w.e(t, E::PITCH);
                let eye = p + v3(0.0, d[C::OY], 0.0);
                let f = Mat34::from_ypr(Vec3::ZERO, yaw, pitch, 0.0, 1.0).vector(v3(0.0, 0.0, -1.0));
                (eye, eye + f * 10.0, Vec3::UP)
            }
            _ => {
                if d[C::ROLL] > 0.5 {
                    // chase with the target's whole attitude (flight)
                    let m = Mat34::from_ypr(Vec3::ZERO, yaw, w.e(t, E::PITCH), w.e(t, E::ROLL), 1.0);
                    let off = m.vector(v3(d[C::OX], d[C::OY], d[C::OZ]));
                    let f = m.vector(v3(0.0, 0.0, -1.0));
                    let up = m.vector(Vec3::UP);
                    let look = p + f * d[C::LOOK_AHEAD] + up * d[C::LOOK_UP];
                    return (p + off, look, up.lerp(Vec3::UP, 0.5).normalized());
                }
                let (r, f) = if d[C::HEADING] > 0.5 { (right_of(yaw), forward_of(yaw)) } else { (v3(1.0, 0.0, 0.0), v3(0.0, 0.0, -1.0)) };
                let eye = p + r * d[C::OX] + Vec3::UP * d[C::OY] - f * d[C::OZ];
                let look = p + f * d[C::LOOK_AHEAD] + Vec3::UP * d[C::LOOK_UP];
                (eye, look, Vec3::UP)
            }
        }
    }

    pub fn step(&mut self, w: &mut World, dt: f32) {
        let (eye, look, up) = self.wanted(w);
        let mode = self.d[C::MODE] as u32;
        if !self.snapped || mode == CM::FIRST_PERSON {
            self.eye = eye;
            self.look = look;
            self.up = up;
            self.snapped = true;
        } else {
            let kp = smoothing(if self.d[C::SMOOTH] > 0.0 { self.d[C::SMOOTH] } else { 8.0 }, dt);
            let kl = smoothing(if self.d[C::SMOOTH_LOOK] > 0.0 { self.d[C::SMOOTH_LOOK] } else { 12.0 }, dt);
            self.eye = self.eye.lerp(eye, kp);
            self.look = self.look.lerp(look, kl);
            self.up = self.up.lerp(up, kl).normalized();
        }
        self.fov = self.d[C::FOV];
        self.near = self.d[C::NEAR];
        self.far = self.d[C::FAR];
        self.shake = maxf(self.shake - dt * 2.0, 0.0);
        let f = (self.look - self.eye).normalized();
        w.cam_yaw = yaw_of(f.x, f.z);
    }

    /// Eye, forward, up for this frame, with shake applied.
    pub fn basis(&self, t: f32) -> (Vec3, Vec3, Vec3) {
        let mut eye = self.eye;
        if self.shake > 0.0 {
            let s = minf(self.shake, 1.0) * 0.6;
            eye += v3(sinf(t * 53.0) * s, sinf(t * 41.0 + 1.3) * s, sinf(t * 37.0 + 2.1) * s);
        }
        let f = (self.look - eye).normalized();
        let f = if f.len_sq() < 0.5 { v3(0.0, 0.0, -1.0) } else { f };
        let mut r = f.cross(self.up).normalized();
        if r.len_sq() < 0.5 {
            r = v3(1.0, 0.0, 0.0);
        }
        let u = r.cross(f);
        (eye, f, u)
    }

    pub fn publish(&self, out: &mut [f32; 16], t: f32, aspect: f32) {
        let (e, f, u) = self.basis(t);
        out[CF::EX] = e.x;
        out[CF::EY] = e.y;
        out[CF::EZ] = e.z;
        out[CF::FX] = f.x;
        out[CF::FY] = f.y;
        out[CF::FZ] = f.z;
        out[CF::UX] = u.x;
        out[CF::UY] = u.y;
        out[CF::UZ] = u.z;
        out[CF::FOV] = self.fov;
        out[CF::NEAR] = self.near;
        out[CF::FAR] = self.far;
        out[CF::ASPECT] = aspect;
    }
}
