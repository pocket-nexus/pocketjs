//! Vectors and 3x4 affine matrices. Right-handed, +Y up, -Z forward (the
//! three.js default and GameBlocks' WorldBasis): yaw 0 faces -Z and a positive
//! yaw turns toward -X (counter-clockwise seen from above).

use crate::fmath::*;
use core::ops::{Add, AddAssign, Mul, Neg, Sub, SubAssign};

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Vec3 {
    pub x: f32,
    pub y: f32,
    pub z: f32,
}

#[inline]
pub const fn v3(x: f32, y: f32, z: f32) -> Vec3 {
    Vec3 { x, y, z }
}

impl Vec3 {
    pub const ZERO: Vec3 = v3(0.0, 0.0, 0.0);
    pub const UP: Vec3 = v3(0.0, 1.0, 0.0);
    #[inline]
    pub fn dot(self, o: Vec3) -> f32 {
        self.x * o.x + self.y * o.y + self.z * o.z
    }
    #[inline]
    pub fn cross(self, o: Vec3) -> Vec3 {
        v3(self.y * o.z - self.z * o.y, self.z * o.x - self.x * o.z, self.x * o.y - self.y * o.x)
    }
    #[inline]
    pub fn len_sq(self) -> f32 {
        self.dot(self)
    }
    #[inline]
    pub fn len(self) -> f32 {
        sqrtf(self.len_sq())
    }
    #[inline]
    pub fn normalized(self) -> Vec3 {
        let l = self.len_sq();
        if l < 1e-12 {
            Vec3::ZERO
        } else {
            self * rsqrtf(l)
        }
    }
    #[inline]
    pub fn flat(self) -> Vec3 {
        v3(self.x, 0.0, self.z)
    }
    #[inline]
    pub fn lerp(self, o: Vec3, t: f32) -> Vec3 {
        self + (o - self) * t
    }
    #[inline]
    pub fn dist_sq(self, o: Vec3) -> f32 {
        (self - o).len_sq()
    }
    #[inline]
    pub fn dist_xz_sq(self, o: Vec3) -> f32 {
        let dx = self.x - o.x;
        let dz = self.z - o.z;
        dx * dx + dz * dz
    }
}

impl Add for Vec3 {
    type Output = Vec3;
    #[inline]
    fn add(self, o: Vec3) -> Vec3 {
        v3(self.x + o.x, self.y + o.y, self.z + o.z)
    }
}
impl Sub for Vec3 {
    type Output = Vec3;
    #[inline]
    fn sub(self, o: Vec3) -> Vec3 {
        v3(self.x - o.x, self.y - o.y, self.z - o.z)
    }
}
impl Mul<f32> for Vec3 {
    type Output = Vec3;
    #[inline]
    fn mul(self, s: f32) -> Vec3 {
        v3(self.x * s, self.y * s, self.z * s)
    }
}
impl Neg for Vec3 {
    type Output = Vec3;
    #[inline]
    fn neg(self) -> Vec3 {
        v3(-self.x, -self.y, -self.z)
    }
}
impl AddAssign for Vec3 {
    #[inline]
    fn add_assign(&mut self, o: Vec3) {
        self.x += o.x;
        self.y += o.y;
        self.z += o.z;
    }
}
impl SubAssign for Vec3 {
    #[inline]
    fn sub_assign(&mut self, o: Vec3) {
        self.x -= o.x;
        self.y -= o.y;
        self.z -= o.z;
    }
}

/// Unit forward on the ground plane for a yaw.
#[inline]
pub fn forward_of(yaw: f32) -> Vec3 {
    v3(-sinf(yaw), 0.0, -cosf(yaw))
}

/// Unit right on the ground plane for a yaw.
#[inline]
pub fn right_of(yaw: f32) -> Vec3 {
    v3(cosf(yaw), 0.0, -sinf(yaw))
}

/// The yaw whose forward points along (dx, dz).
#[inline]
pub fn yaw_of(dx: f32, dz: f32) -> f32 {
    atan2f(-dx, -dz)
}

/// Row-major 3x4: [r00 r01 r02 tx, r10 r11 r12 ty, r20 r21 r22 tz]. The
/// shader reads the same three rows.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Mat34(pub [f32; 12]);

impl Default for Mat34 {
    fn default() -> Self {
        Mat34::IDENTITY
    }
}

impl Mat34 {
    pub const IDENTITY: Mat34 = Mat34([1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0]);

    /// R = Ry(yaw) * Rx(pitch) * Rz(roll), then a uniform scale, then the
    /// translation (three.js Euler order "YXZ").
    pub fn from_ypr(pos: Vec3, yaw: f32, pitch: f32, roll: f32, scale: f32) -> Mat34 {
        let (sy, cy) = (sinf(yaw), cosf(yaw));
        let (sp, cp) = (sinf(pitch), cosf(pitch));
        let (sr, cr) = (sinf(roll), cosf(roll));
        // columns of Ry*Rx*Rz
        let r00 = cy * cr + sy * sp * sr;
        let r01 = -cy * sr + sy * sp * cr;
        let r02 = sy * cp;
        let r10 = cp * sr;
        let r11 = cp * cr;
        let r12 = -sp;
        let r20 = -sy * cr + cy * sp * sr;
        let r21 = sy * sr + cy * sp * cr;
        let r22 = cy * cp;
        Mat34([
            r00 * scale, r01 * scale, r02 * scale, pos.x,
            r10 * scale, r11 * scale, r12 * scale, pos.y,
            r20 * scale, r21 * scale, r22 * scale, pos.z,
        ])
    }

    /// Axis basis (right, up, back = -forward) at a position, scaled.
    pub fn from_basis(pos: Vec3, right: Vec3, up: Vec3, back: Vec3, scale: f32) -> Mat34 {
        Mat34([
            right.x * scale, up.x * scale, back.x * scale, pos.x,
            right.y * scale, up.y * scale, back.y * scale, pos.y,
            right.z * scale, up.z * scale, back.z * scale, pos.z,
        ])
    }

    /// Rotation by `angle` about a unit axis through `pivot`.
    pub fn rotation_about(axis: Vec3, angle: f32, pivot: Vec3) -> Mat34 {
        let (s, c) = (sinf(angle), cosf(angle));
        let t = 1.0 - c;
        let (x, y, z) = (axis.x, axis.y, axis.z);
        let r = [
            t * x * x + c, t * x * y - s * z, t * x * z + s * y,
            t * x * y + s * z, t * y * y + c, t * y * z - s * x,
            t * x * z - s * y, t * y * z + s * x, t * z * z + c,
        ];
        // p' = R (p - pivot) + pivot
        let tx = pivot.x - (r[0] * pivot.x + r[1] * pivot.y + r[2] * pivot.z);
        let ty = pivot.y - (r[3] * pivot.x + r[4] * pivot.y + r[5] * pivot.z);
        let tz = pivot.z - (r[6] * pivot.x + r[7] * pivot.y + r[8] * pivot.z);
        Mat34([r[0], r[1], r[2], tx, r[3], r[4], r[5], ty, r[6], r[7], r[8], tz])
    }

    #[inline]
    pub fn translation(&self) -> Vec3 {
        v3(self.0[3], self.0[7], self.0[11])
    }

    #[inline]
    pub fn point(&self, p: Vec3) -> Vec3 {
        let m = &self.0;
        v3(
            m[0] * p.x + m[1] * p.y + m[2] * p.z + m[3],
            m[4] * p.x + m[5] * p.y + m[6] * p.z + m[7],
            m[8] * p.x + m[9] * p.y + m[10] * p.z + m[11],
        )
    }

    #[inline]
    pub fn vector(&self, p: Vec3) -> Vec3 {
        let m = &self.0;
        v3(
            m[0] * p.x + m[1] * p.y + m[2] * p.z,
            m[4] * p.x + m[5] * p.y + m[6] * p.z,
            m[8] * p.x + m[9] * p.y + m[10] * p.z,
        )
    }

    /// self * o (o applied first).
    pub fn mul(&self, o: &Mat34) -> Mat34 {
        let a = &self.0;
        let b = &o.0;
        let mut r = [0.0f32; 12];
        for row in 0..3 {
            let (a0, a1, a2, a3) = (a[row * 4], a[row * 4 + 1], a[row * 4 + 2], a[row * 4 + 3]);
            r[row * 4] = a0 * b[0] + a1 * b[4] + a2 * b[8];
            r[row * 4 + 1] = a0 * b[1] + a1 * b[5] + a2 * b[9];
            r[row * 4 + 2] = a0 * b[2] + a1 * b[6] + a2 * b[10];
            r[row * 4 + 3] = a0 * b[3] + a1 * b[7] + a2 * b[11] + a3;
        }
        Mat34(r)
    }

    /// The largest axis scale, for bounding spheres.
    pub fn max_scale(&self) -> f32 {
        let m = &self.0;
        let sx = m[0] * m[0] + m[4] * m[4] + m[8] * m[8];
        let sy = m[1] * m[1] + m[5] * m[5] + m[9] * m[9];
        let sz = m[2] * m[2] + m[6] * m[6] + m[10] * m[10];
        sqrtf(maxf(sx, maxf(sy, sz)))
    }
}

/// Unit quaternion for flight attitude.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Quat {
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub w: f32,
}

impl Default for Quat {
    fn default() -> Self {
        Quat::IDENTITY
    }
}

impl Quat {
    pub const IDENTITY: Quat = Quat { x: 0.0, y: 0.0, z: 0.0, w: 1.0 };

    pub fn axis_angle(axis: Vec3, angle: f32) -> Quat {
        let h = angle * 0.5;
        let s = sinf(h);
        Quat { x: axis.x * s, y: axis.y * s, z: axis.z * s, w: cosf(h) }
    }

    pub fn from_ypr(yaw: f32, pitch: f32, roll: f32) -> Quat {
        Quat::axis_angle(Vec3::UP, yaw)
            .mul(Quat::axis_angle(v3(1.0, 0.0, 0.0), pitch))
            .mul(Quat::axis_angle(v3(0.0, 0.0, 1.0), roll))
    }

    pub fn mul(self, b: Quat) -> Quat {
        let a = self;
        Quat {
            x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
            y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
            z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
            w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
        }
    }

    pub fn normalized(self) -> Quat {
        let l = self.x * self.x + self.y * self.y + self.z * self.z + self.w * self.w;
        let r = rsqrtf(l);
        Quat { x: self.x * r, y: self.y * r, z: self.z * r, w: self.w * r }
    }

    pub fn rotate(self, v: Vec3) -> Vec3 {
        let q = v3(self.x, self.y, self.z);
        let t = q.cross(v) * 2.0;
        v + t * self.w + q.cross(t)
    }

    /// yaw, pitch, roll in the YXZ order of `from_ypr`.
    pub fn to_ypr(self) -> (f32, f32, f32) {
        let f = self.rotate(v3(0.0, 0.0, -1.0));
        let u = self.rotate(Vec3::UP);
        let yaw = yaw_of(f.x, f.z);
        let pitch = asinf(f.y);
        let r = right_of(yaw);
        // r x f is the up vector of the same yaw and pitch with no roll.
        let level_up = r.cross(f).normalized();
        let roll = atan2f(-u.dot(r), u.dot(level_up));
        (yaw, pitch, roll)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: Vec3, b: Vec3) -> bool {
        (a - b).len() < 1e-4
    }

    #[test]
    fn yaw_conventions() {
        assert!(close(forward_of(0.0), v3(0.0, 0.0, -1.0)));
        assert!(close(forward_of(HALF_PI), v3(-1.0, 0.0, 0.0)));
        assert!(close(right_of(0.0), v3(1.0, 0.0, 0.0)));
        let m = Mat34::from_ypr(Vec3::ZERO, 0.7, 0.0, 0.0, 1.0);
        assert!(close(m.vector(v3(0.0, 0.0, -1.0)), forward_of(0.7)));
        assert!((yaw_of(forward_of(1.1).x, forward_of(1.1).z) - 1.1).abs() < 1e-4);
    }

    #[test]
    fn ypr_matches_quat() {
        let (y, p, r) = (0.4, -0.3, 0.9);
        let m = Mat34::from_ypr(Vec3::ZERO, y, p, r, 1.0);
        let q = Quat::from_ypr(y, p, r);
        for v in [v3(1.0, 0.0, 0.0), v3(0.0, 1.0, 0.0), v3(0.0, 0.0, 1.0)] {
            assert!(close(m.vector(v), q.rotate(v)));
        }
        let (y2, p2, r2) = q.to_ypr();
        assert!((y - y2).abs() < 1e-3 && (p - p2).abs() < 1e-3 && (r - r2).abs() < 1e-3, "{y2} {p2} {r2}");
    }

    #[test]
    fn rotation_about_pivot() {
        let m = Mat34::rotation_about(Vec3::UP, HALF_PI, v3(1.0, 0.0, 0.0));
        assert!(close(m.point(v3(2.0, 0.0, 0.0)), v3(1.0, 0.0, -1.0)));
    }
}
