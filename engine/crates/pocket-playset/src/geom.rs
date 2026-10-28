//! Primitive generators with three.js parameter order and orientation.
//!
//! Segment counts are capped by `Lod` (three.js defaults like a 32x16 sphere
//! are a thousand triangles each); the visual reads the same at 400x240.

use crate::fmath::*;
use crate::vec::*;
use alloc::vec::Vec;

/// One vertex as the PICA shader reads it: 20 bytes.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
#[repr(C)]
pub struct GpuVertex {
    pub pos: [f32; 3],
    /// normal x, y, z scaled to [-127, 127] and the bone slot
    pub nb: [i8; 4],
    /// sRGB colour and emissive amount (255 = unlit)
    pub rgba: [u8; 4],
}

pub const VERTEX_BYTES: usize = core::mem::size_of::<GpuVertex>();

#[inline]
pub fn pack_normal(n: Vec3, bone: u8) -> [i8; 4] {
    let q = |v: f32| (clampf(v, -1.0, 1.0) * 127.0 + if v >= 0.0 { 0.5 } else { -0.5 }) as i8;
    [q(n.x), q(n.y), q(n.z), bone as i8]
}

/// Segment caps for the 3DS.
#[derive(Clone, Copy)]
pub struct Lod {
    pub radial: u32,
    pub rings: u32,
    pub tubular: u32,
}

impl Default for Lod {
    fn default() -> Self {
        Lod { radial: 12, rings: 8, tubular: 16 }
    }
}

/// Triangles with positions and normals before colour and placement.
#[derive(Default)]
pub struct Shape {
    pub pos: Vec<Vec3>,
    pub nrm: Vec<Vec3>,
    pub idx: Vec<u32>,
}

impl Shape {
    fn vert(&mut self, p: Vec3, n: Vec3) -> u32 {
        self.pos.push(p);
        self.nrm.push(n);
        (self.pos.len() - 1) as u32
    }
    fn tri(&mut self, a: u32, b: u32, c: u32) {
        self.idx.extend_from_slice(&[a, b, c]);
    }
    fn quad(&mut self, a: u32, b: u32, c: u32, d: u32) {
        // a-b-c-d counter-clockwise
        self.tri(a, b, c);
        self.tri(a, c, d);
    }

    /// Unshare every triangle and give it its face normal.
    pub fn flatten(&mut self) {
        let mut pos = Vec::with_capacity(self.idx.len());
        let mut nrm = Vec::with_capacity(self.idx.len());
        for t in self.idx.chunks_exact(3) {
            let (a, b, c) = (self.pos[t[0] as usize], self.pos[t[1] as usize], self.pos[t[2] as usize]);
            let n = (b - a).cross(c - a).normalized();
            pos.extend_from_slice(&[a, b, c]);
            nrm.extend_from_slice(&[n, n, n]);
        }
        self.idx = (0..pos.len() as u32).collect();
        self.pos = pos;
        self.nrm = nrm;
    }

    /// Displace each distinct position by a hashed offset of up to `amount`
    /// (vertices at one position move together, so the surface stays closed).
    pub fn jitter(&mut self, amount: f32, seed: u32) {
        for p in self.pos.iter_mut() {
            let kx = (p.x * 1000.0) as i32;
            let ky = (p.y * 1000.0) as i32;
            let kz = (p.z * 1000.0) as i32;
            let h = |s: u32| hash2(kx ^ (kz.wrapping_mul(7919)), ky, seed.wrapping_add(s)) * 2.0 - 1.0;
            *p += v3(h(1), h(2), h(3)) * amount;
        }
    }
}

pub fn box_shape(w: f32, h: f32, d: f32) -> Shape {
    let mut s = Shape::default();
    let (x, y, z) = (w * 0.5, h * 0.5, d * 0.5);
    let faces: [(Vec3, [Vec3; 4]); 6] = [
        (v3(1.0, 0.0, 0.0), [v3(x, -y, z), v3(x, -y, -z), v3(x, y, -z), v3(x, y, z)]),
        (v3(-1.0, 0.0, 0.0), [v3(-x, -y, -z), v3(-x, -y, z), v3(-x, y, z), v3(-x, y, -z)]),
        (v3(0.0, 1.0, 0.0), [v3(-x, y, z), v3(x, y, z), v3(x, y, -z), v3(-x, y, -z)]),
        (v3(0.0, -1.0, 0.0), [v3(-x, -y, -z), v3(x, -y, -z), v3(x, -y, z), v3(-x, -y, z)]),
        (v3(0.0, 0.0, 1.0), [v3(-x, -y, z), v3(x, -y, z), v3(x, y, z), v3(-x, y, z)]),
        (v3(0.0, 0.0, -1.0), [v3(x, -y, -z), v3(-x, -y, -z), v3(-x, y, -z), v3(x, y, -z)]),
    ];
    for (n, q) in faces {
        let a = s.vert(q[0], n);
        let b = s.vert(q[1], n);
        let c = s.vert(q[2], n);
        let d = s.vert(q[3], n);
        s.quad(a, b, c, d);
    }
    s
}

fn segs(requested: f32, default: u32, min: u32, cap: u32) -> u32 {
    let r = if requested >= 1.0 { requested as u32 } else { default };
    r.clamp(min, cap)
}

/// SphereGeometry(radius, widthSegments, heightSegments, phiStart, phiLength,
/// thetaStart, thetaLength)
pub fn sphere(p: &[f32; 8], lod: &Lod) -> Shape {
    let r = if p[0] > 0.0 { p[0] } else { 1.0 };
    let ws = segs(p[1], 32, 3, lod.radial);
    let hs = segs(p[2], 16, 2, lod.rings);
    let phi_start = p[3];
    let phi_len = if p[4] > 0.0 { p[4] } else { TAU };
    let theta_start = p[5];
    let theta_len = if p[6] > 0.0 { p[6] } else { PI };
    let mut s = Shape::default();
    for iy in 0..=hs {
        let v = iy as f32 / hs as f32;
        let theta = theta_start + v * theta_len;
        for ix in 0..=ws {
            let u = ix as f32 / ws as f32;
            let phi = phi_start + u * phi_len;
            let n = v3(-cosf(phi) * sinf(theta), cosf(theta), sinf(phi) * sinf(theta));
            s.vert(n * r, n);
        }
    }
    let row = ws + 1;
    for iy in 0..hs {
        for ix in 0..ws {
            let a = iy * row + ix + 1;
            let b = iy * row + ix;
            let c = (iy + 1) * row + ix;
            let d = (iy + 1) * row + ix + 1;
            if iy != 0 || theta_start > 0.0 {
                s.tri(a, b, d);
            }
            if iy != hs - 1 || theta_start + theta_len < PI {
                s.tri(b, c, d);
            }
        }
    }
    s
}

/// CylinderGeometry(radiusTop, radiusBottom, height, radialSegments,
/// heightSegments, openEnded, thetaStart, thetaLength)
pub fn cylinder(p: &[f32; 8], lod: &Lod) -> Shape {
    let (rt, rb) = (p[0], p[1]);
    let h = if p[2] > 0.0 { p[2] } else { 1.0 };
    let rs = segs(p[3], 32, 3, lod.radial);
    let hs = segs(p[4], 1, 1, 4);
    let open = p[5] > 0.5;
    let theta_start = p[6];
    let theta_len = if p[7] > 0.0 { p[7] } else { TAU };
    let half = h * 0.5;
    let slope = (rb - rt) / h;
    let mut s = Shape::default();
    for y in 0..=hs {
        let v = y as f32 / hs as f32;
        let radius = v * (rb - rt) + rt;
        for x in 0..=rs {
            let u = x as f32 / rs as f32;
            let theta = u * theta_len + theta_start;
            let (st, ct) = (sinf(theta), cosf(theta));
            let pos = v3(radius * st, -v * h + half, radius * ct);
            let n = v3(st, slope, ct).normalized();
            s.vert(pos, n);
        }
    }
    let row = rs + 1;
    for x in 0..rs {
        for y in 0..hs {
            let a = y * row + x;
            let b = (y + 1) * row + x;
            let c = (y + 1) * row + x + 1;
            let d = y * row + x + 1;
            s.tri(a, b, d);
            s.tri(b, c, d);
        }
    }
    if !open {
        for (top, radius) in [(true, rt), (false, rb)] {
            if radius <= 0.0 {
                continue;
            }
            let sign = if top { 1.0 } else { -1.0 };
            let n = v3(0.0, sign, 0.0);
            let center = s.vert(v3(0.0, half * sign, 0.0), n);
            let first = s.pos.len() as u32;
            for x in 0..=rs {
                let theta = x as f32 / rs as f32 * theta_len + theta_start;
                s.vert(v3(radius * sinf(theta), half * sign, radius * cosf(theta)), n);
            }
            for x in 0..rs {
                if top {
                    s.tri(first + x, first + x + 1, center);
                } else {
                    s.tri(first + x + 1, first + x, center);
                }
            }
        }
    }
    s
}

/// CapsuleGeometry(radius, length, capSegments, radialSegments): a cylinder of
/// `length` with hemispheres on both ends, along +Y.
pub fn capsule(p: &[f32; 8], lod: &Lod) -> Shape {
    let r = if p[0] > 0.0 { p[0] } else { 1.0 };
    let len = p[1];
    let caps = segs(p[2], 4, 1, (lod.rings / 2).max(2));
    let rs = segs(p[3], 8, 3, lod.radial);
    let rings = caps * 2 + 1;
    let mut s = Shape::default();
    for iy in 0..=rings {
        // latitude from +90 to -90 degrees, with the equator duplicated
        let (lat, offset) = if iy <= caps {
            (HALF_PI - iy as f32 / caps as f32 * HALF_PI, len * 0.5)
        } else {
            (-((iy - caps - 1) as f32 / caps as f32) * HALF_PI, -len * 0.5)
        };
        for ix in 0..=rs {
            let phi = ix as f32 / rs as f32 * TAU;
            let n = v3(cosf(lat) * sinf(phi), sinf(lat), cosf(lat) * cosf(phi));
            s.vert(v3(n.x * r, n.y * r + offset, n.z * r), n);
        }
    }
    let row = rs + 1;
    for iy in 0..rings {
        for ix in 0..rs {
            let a = iy * row + ix;
            let b = (iy + 1) * row + ix;
            let c = (iy + 1) * row + ix + 1;
            let d = iy * row + ix + 1;
            s.tri(a, b, d);
            s.tri(b, c, d);
        }
    }
    s
}

/// TorusGeometry(radius, tube, radialSegments, tubularSegments, arc), in the
/// XY plane like three.js.
pub fn torus(p: &[f32; 8], lod: &Lod) -> Shape {
    let r = if p[0] > 0.0 { p[0] } else { 1.0 };
    let tube = if p[1] > 0.0 { p[1] } else { 0.4 };
    let rs = segs(p[2], 12, 3, (lod.radial / 2).max(4));
    let ts = segs(p[3], 48, 3, lod.tubular);
    let arc = if p[4] > 0.0 { p[4] } else { TAU };
    let mut s = Shape::default();
    for j in 0..=rs {
        for i in 0..=ts {
            let u = i as f32 / ts as f32 * arc;
            let v = j as f32 / rs as f32 * TAU;
            let center = v3(r * cosf(u), r * sinf(u), 0.0);
            let pos = v3((r + tube * cosf(v)) * cosf(u), (r + tube * cosf(v)) * sinf(u), tube * sinf(v));
            s.vert(pos, (pos - center).normalized());
        }
    }
    for j in 1..=rs {
        for i in 1..=ts {
            let a = (ts + 1) * j + i - 1;
            let b = (ts + 1) * (j - 1) + i - 1;
            let c = (ts + 1) * (j - 1) + i;
            let d = (ts + 1) * j + i;
            s.tri(a, b, d);
            s.tri(b, c, d);
        }
    }
    s
}

/// PlaneGeometry(width, height, widthSegments, heightSegments) in XY, facing +Z.
pub fn plane(p: &[f32; 8]) -> Shape {
    let w = if p[0] > 0.0 { p[0] } else { 1.0 };
    let h = if p[1] > 0.0 { p[1] } else { 1.0 };
    // at least one segment per 32 units: very large quads are not drawn
    // reliably once they cross far outside the view
    let gx = segs(maxf(p[2], (w / 32.0) as u32 as f32 + 1.0), 1, 1, 32);
    let gy = segs(maxf(p[3], (h / 32.0) as u32 as f32 + 1.0), 1, 1, 32);
    let mut s = Shape::default();
    let n = v3(0.0, 0.0, 1.0);
    for iy in 0..=gy {
        for ix in 0..=gx {
            let x = ix as f32 / gx as f32 * w - w * 0.5;
            let y = h * 0.5 - iy as f32 / gy as f32 * h;
            s.vert(v3(x, y, 0.0), n);
        }
    }
    for iy in 0..gy {
        for ix in 0..gx {
            let a = ix + (gx + 1) * iy;
            let b = ix + (gx + 1) * (iy + 1);
            let c = ix + 1 + (gx + 1) * (iy + 1);
            let d = ix + 1 + (gx + 1) * iy;
            s.tri(a, b, d);
            s.tri(b, c, d);
        }
    }
    s
}

/// CircleGeometry(radius, segments, thetaStart, thetaLength) and
/// RingGeometry(innerRadius, outerRadius, thetaSegments) in XY, facing +Z.
pub fn ring(inner: f32, outer: f32, segments: f32, start: f32, length: f32, lod: &Lod) -> Shape {
    let n_seg = segs(segments, 32, 3, lod.radial.max(16));
    let len = if length > 0.0 { length } else { TAU };
    let mut s = Shape::default();
    let n = v3(0.0, 0.0, 1.0);
    if inner <= 0.0 {
        let c = s.vert(Vec3::ZERO, n);
        for i in 0..=n_seg {
            let t = start + i as f32 / n_seg as f32 * len;
            s.vert(v3(outer * cosf(t), outer * sinf(t), 0.0), n);
        }
        for i in 1..=n_seg {
            s.tri(i, i + 1, c);
        }
        return s;
    }
    for i in 0..=n_seg {
        let t = start + i as f32 / n_seg as f32 * len;
        s.vert(v3(inner * cosf(t), inner * sinf(t), 0.0), n);
        s.vert(v3(outer * cosf(t), outer * sinf(t), 0.0), n);
    }
    for i in 0..n_seg {
        let (a, b, c, d) = (i * 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
        s.tri(a, b, c);
        s.tri(a, c, d);
    }
    s
}

fn polyhedron(verts: &[[f32; 3]], faces: &[[u32; 3]], radius: f32, detail: u32) -> Shape {
    let mut s = Shape::default();
    let base: Vec<Vec3> = verts.iter().map(|v| v3(v[0], v[1], v[2]).normalized()).collect();
    let div = detail.min(2) + 1;
    for f in faces {
        let (a, b, c) = (base[f[0] as usize], base[f[1] as usize], base[f[2] as usize]);
        // subdivide the face into div^2 triangles on the sphere
        let point = |i: u32, j: u32| -> Vec3 {
            let fi = i as f32 / div as f32;
            let fj = j as f32 / div as f32;
            (a * (1.0 - fi - fj) + b * fi + c * fj).normalized() * radius
        };
        for i in 0..div {
            for j in 0..div - i {
                let p0 = point(i, j);
                let p1 = point(i + 1, j);
                let p2 = point(i, j + 1);
                let i0 = s.vert(p0, Vec3::UP);
                let i1 = s.vert(p1, Vec3::UP);
                let i2 = s.vert(p2, Vec3::UP);
                s.tri(i0, i1, i2);
                if i + j + 1 < div {
                    let p3 = point(i + 1, j + 1);
                    let i3 = s.vert(p3, Vec3::UP);
                    s.tri(i1, i3, i2);
                }
            }
        }
    }
    s.flatten();
    s
}

pub fn icosahedron(radius: f32, detail: u32) -> Shape {
    let t = (1.0 + sqrtf(5.0)) / 2.0;
    let v = [
        [-1.0, t, 0.0], [1.0, t, 0.0], [-1.0, -t, 0.0], [1.0, -t, 0.0],
        [0.0, -1.0, t], [0.0, 1.0, t], [0.0, -1.0, -t], [0.0, 1.0, -t],
        [t, 0.0, -1.0], [t, 0.0, 1.0], [-t, 0.0, -1.0], [-t, 0.0, 1.0],
    ];
    let f = [
        [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
        [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
        [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
        [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
    ];
    polyhedron(&v, &f, radius, detail)
}

pub fn octahedron(radius: f32, detail: u32) -> Shape {
    let v = [[1.0, 0.0, 0.0], [-1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, -1.0, 0.0], [0.0, 0.0, 1.0], [0.0, 0.0, -1.0]];
    let f = [[0, 2, 4], [0, 4, 3], [0, 3, 5], [0, 5, 2], [1, 2, 5], [1, 5, 3], [1, 3, 4], [1, 4, 2]];
    polyhedron(&v, &f, radius, detail)
}

pub fn tetrahedron(radius: f32, detail: u32) -> Shape {
    let v = [[1.0, 1.0, 1.0], [-1.0, -1.0, 1.0], [-1.0, 1.0, -1.0], [1.0, -1.0, -1.0]];
    let f = [[2, 1, 0], [0, 3, 2], [1, 3, 0], [2, 3, 1]];
    polyhedron(&v, &f, radius, detail)
}

pub fn dodecahedron(radius: f32, detail: u32) -> Shape {
    let t = (1.0 + sqrtf(5.0)) / 2.0;
    let r = 1.0 / t;
    let v = [
        [-1.0, -1.0, -1.0], [-1.0, -1.0, 1.0], [-1.0, 1.0, -1.0], [-1.0, 1.0, 1.0],
        [1.0, -1.0, -1.0], [1.0, -1.0, 1.0], [1.0, 1.0, -1.0], [1.0, 1.0, 1.0],
        [0.0, -r, -t], [0.0, -r, t], [0.0, r, -t], [0.0, r, t],
        [-r, -t, 0.0], [-r, t, 0.0], [r, -t, 0.0], [r, t, 0.0],
        [-t, 0.0, -r], [t, 0.0, -r], [-t, 0.0, r], [t, 0.0, r],
    ];
    let f = [
        [3, 11, 7], [3, 7, 15], [3, 15, 13], [7, 19, 17], [7, 17, 6], [7, 6, 15],
        [17, 4, 8], [17, 8, 10], [17, 10, 6], [8, 0, 16], [8, 16, 2], [8, 2, 10],
        [0, 12, 1], [0, 1, 18], [0, 18, 16], [6, 10, 2], [6, 2, 13], [6, 13, 15],
        [2, 16, 18], [2, 18, 3], [2, 3, 13], [18, 1, 9], [18, 9, 11], [18, 11, 3],
        [4, 14, 12], [4, 12, 0], [4, 0, 8], [11, 9, 5], [11, 5, 19], [11, 19, 7],
        [19, 5, 14], [19, 14, 4], [19, 4, 17], [1, 12, 14], [1, 14, 5], [1, 5, 9],
    ];
    polyhedron(&v, &f, radius, detail)
}

/// Triangles from raw positions (three per triangle, counter-clockwise).
pub fn raw(positions: &[f32]) -> Shape {
    let mut s = Shape::default();
    for t in positions.chunks_exact(9) {
        let a = v3(t[0], t[1], t[2]);
        let b = v3(t[3], t[4], t[5]);
        let c = v3(t[6], t[7], t[8]);
        let n = (b - a).cross(c - a).normalized();
        let i = s.vert(a, n);
        s.vert(b, n);
        s.vert(c, n);
        s.tri(i, i + 1, i + 2);
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    fn outward(s: &Shape) -> bool {
        // every triangle's winding agrees with its stored normals
        s.idx.chunks_exact(3).all(|t| {
            let (a, b, c) = (s.pos[t[0] as usize], s.pos[t[1] as usize], s.pos[t[2] as usize]);
            let face = (b - a).cross(c - a);
            let n = s.nrm[t[0] as usize] + s.nrm[t[1] as usize] + s.nrm[t[2] as usize];
            face.len_sq() < 1e-12 || face.dot(n) > 0.0
        })
    }

    #[test]
    fn windings_face_out() {
        let lod = Lod::default();
        assert!(outward(&box_shape(1.0, 2.0, 3.0)));
        assert!(outward(&sphere(&[1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0], &lod)));
        assert!(outward(&cylinder(&[0.5, 1.0, 2.0, 8.0, 1.0, 0.0, 0.0, 0.0], &lod)));
        assert!(outward(&cylinder(&[0.0, 1.0, 2.0, 4.0, 1.0, 0.0, 0.0, 0.0], &lod)));
        assert!(outward(&capsule(&[0.5, 1.0, 3.0, 8.0, 0.0, 0.0, 0.0, 0.0], &lod)));
        assert!(outward(&torus(&[1.0, 0.3, 6.0, 12.0, 0.0, 0.0, 0.0, 0.0], &lod)));
        assert!(outward(&icosahedron(1.0, 0)));
        assert!(outward(&dodecahedron(1.0, 0)));
        assert!(outward(&octahedron(1.0, 1)));
        assert!(outward(&tetrahedron(1.0, 0)));
        assert!(outward(&plane(&[2.0, 2.0, 2.0, 2.0, 0.0, 0.0, 0.0, 0.0])));
        assert!(outward(&ring(0.0, 1.0, 12.0, 0.0, 0.0, &lod)));
        assert!(outward(&ring(0.5, 1.0, 12.0, 0.0, 0.0, &lod)));
    }

    #[test]
    fn caps_hold() {
        let lod = Lod::default();
        let s = sphere(&[1.0, 64.0, 64.0, 0.0, 0.0, 0.0, 0.0, 0.0], &lod);
        assert!(s.idx.len() / 3 <= (lod.radial * lod.rings * 2) as usize);
    }
}
