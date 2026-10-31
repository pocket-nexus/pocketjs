//! Low-poly primitives with flat normals: position + normal, u16 indices.
use crate::math::{cross, normalize, sub, Vec3};

#[derive(Default, Clone)]
pub struct Shape {
    /// x, y, z, nx, ny, nz per vertex.
    pub vertices: Vec<f32>,
    pub indices: Vec<u16>,
}

impl Shape {
    fn triangle(&mut self, a: Vec3, b: Vec3, c: Vec3) {
        let normal = normalize(cross(sub(b, a), sub(c, a)));
        let base = (self.vertices.len() / 6) as u16;
        for p in [a, b, c] {
            self.vertices
                .extend_from_slice(&[p[0], p[1], p[2], normal[0], normal[1], normal[2]]);
        }
        self.indices.extend_from_slice(&[base, base + 1, base + 2]);
    }
    fn quad(&mut self, a: Vec3, b: Vec3, c: Vec3, d: Vec3) {
        self.triangle(a, b, c);
        self.triangle(a, c, d);
    }
}

/// Unit cube centered at the origin (edge length 1).
pub fn cube() -> Shape {
    let mut s = Shape::default();
    let h = 0.5;
    let p = |x: f32, y: f32, z: f32| [x * h, y * h, z * h];
    s.quad(
        p(-1., -1., 1.),
        p(1., -1., 1.),
        p(1., 1., 1.),
        p(-1., 1., 1.),
    );
    s.quad(
        p(1., -1., -1.),
        p(-1., -1., -1.),
        p(-1., 1., -1.),
        p(1., 1., -1.),
    );
    s.quad(
        p(1., -1., 1.),
        p(1., -1., -1.),
        p(1., 1., -1.),
        p(1., 1., 1.),
    );
    s.quad(
        p(-1., -1., -1.),
        p(-1., -1., 1.),
        p(-1., 1., 1.),
        p(-1., 1., -1.),
    );
    s.quad(
        p(-1., 1., 1.),
        p(1., 1., 1.),
        p(1., 1., -1.),
        p(-1., 1., -1.),
    );
    s.quad(
        p(-1., -1., -1.),
        p(1., -1., -1.),
        p(1., -1., 1.),
        p(-1., -1., 1.),
    );
    s
}

/// A unit plane on y = 0 facing +y (edge length 1).
pub fn plane() -> Shape {
    let mut s = Shape::default();
    s.quad(
        [-0.5, 0.0, 0.5],
        [0.5, 0.0, 0.5],
        [0.5, 0.0, -0.5],
        [-0.5, 0.0, -0.5],
    );
    s
}

/// Diameter 1 UV sphere.
pub fn sphere(segments: usize, rings: usize) -> Shape {
    let mut s = Shape::default();
    let at = |ring: usize, segment: usize| {
        let polar = std::f32::consts::PI * ring as f32 / rings as f32;
        let azimuth = std::f32::consts::TAU * segment as f32 / segments as f32;
        [
            0.5 * polar.sin() * azimuth.sin(),
            0.5 * polar.cos(),
            0.5 * polar.sin() * azimuth.cos(),
        ]
    };
    for ring in 0..rings {
        for segment in 0..segments {
            let (a, b, c, d) = (
                at(ring, segment),
                at(ring + 1, segment),
                at(ring + 1, segment + 1),
                at(ring, segment + 1),
            );
            if ring == 0 {
                s.triangle(a, b, c);
            } else if ring == rings - 1 {
                s.triangle(a, b, d);
            } else {
                s.quad(a, b, c, d);
            }
        }
    }
    s
}

/// Height 1, diameter 1 along y; `top` scales the upper radius (0 makes a cone).
pub fn cylinder(segments: usize, top: f32) -> Shape {
    let mut s = Shape::default();
    let at = |segment: usize, y: f32, radius: f32| {
        let azimuth = std::f32::consts::TAU * segment as f32 / segments as f32;
        [radius * azimuth.sin(), y, radius * azimuth.cos()]
    };
    for segment in 0..segments {
        let (a, b) = (at(segment, -0.5, 0.5), at(segment + 1, -0.5, 0.5));
        let (c, d) = (at(segment + 1, 0.5, 0.5 * top), at(segment, 0.5, 0.5 * top));
        if top > 0.0 {
            s.quad(a, b, c, d);
            s.triangle([0.0, 0.5, 0.0], d, c);
        } else {
            s.triangle(a, b, c);
        }
        s.triangle([0.0, -0.5, 0.0], b, a);
    }
    s
}

/// Major radius 0.35, minor radius 0.15 in the XZ plane.
pub fn torus(segments: usize, sides: usize) -> Shape {
    let mut s = Shape::default();
    let at = |segment: usize, side: usize| {
        let u = std::f32::consts::TAU * segment as f32 / segments as f32;
        let v = std::f32::consts::TAU * side as f32 / sides as f32;
        let r = 0.35 + 0.15 * v.cos();
        [r * u.sin(), 0.15 * v.sin(), r * u.cos()]
    };
    for segment in 0..segments {
        for side in 0..sides {
            s.quad(
                at(segment, side),
                at(segment + 1, side),
                at(segment + 1, side + 1),
                at(segment, side + 1),
            );
        }
    }
    s
}

/// The shapes every game starts with, in the order the TypeScript SDK names them.
pub fn builtin() -> Vec<(&'static str, Shape)> {
    vec![
        ("box", cube()),
        ("plane", plane()),
        ("sphere", sphere(12, 8)),
        ("cylinder", cylinder(12, 1.0)),
        ("cone", cylinder(12, 0.0)),
        ("torus", torus(16, 8)),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shapes_have_outward_normals() {
        for (name, shape) in builtin() {
            assert!(!shape.indices.is_empty(), "{name}");
            if name == "plane" || name == "torus" {
                continue;
            }
            // Each triangle's normal points away from the shape's center.
            let mut outward = 0;
            let total = shape.vertices.len() / 6;
            for v in shape.vertices.chunks(6) {
                if v[0] * v[3] + v[1] * v[4] + v[2] * v[5] > -1e-4 {
                    outward += 1;
                }
            }
            assert!(
                outward * 10 >= total * 9,
                "{name}: {outward}/{total} outward"
            );
        }
    }
}
