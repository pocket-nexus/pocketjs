//! Models: parts assembled from primitives, merged into one vertex buffer.
//!
//! Every part keeps its joint's index as the vertex bone, so one draw takes a
//! palette of joint matrices. A model with few joints and few vertices is
//! replicated in its buffer (copy k uses bones k*joints..), and one draw then
//! carries up to `PALETTE / joints` instances of it.

use crate::fmath::*;
use crate::geom::{self, GpuVertex, Lod, Shape};
use crate::schema::{blend, geom as g, model as md, part};
use crate::vec::*;
use alloc::vec::Vec;

/// Matrices one draw can carry (the shader's `bones` uniform array).
pub const PALETTE: usize = 20;
/// A replicated buffer stays under this many vertices.
pub const REPLICA_VERTICES: usize = 6000;

#[derive(Clone, Copy, Debug, Default)]
pub struct Joint {
    pub parent: i32,
    pub pivot: Vec3,
}

/// A contiguous index range drawn with one blend state. `count` is the index
/// count of ONE copy; copy k follows copy k-1.
#[derive(Clone, Copy, Debug, Default)]
pub struct Pass {
    pub first: u32,
    pub count: u32,
    pub blend: u8,
    pub opacity: f32,
}

#[derive(Default)]
pub struct Model {
    pub verts: Vec<GpuVertex>,
    pub idx: Vec<u16>,
    pub passes: Vec<Pass>,
    pub joints: Vec<Joint>,
    /// copies of the geometry in the buffer
    pub copies: u32,
    pub vertex_count: u32,
    pub center: Vec3,
    pub radius: f32,
    pub min: Vec3,
    pub max: Vec3,
    pub tris: u32,
    /// a GPU copy exists; bumped when the data changes
    pub revision: u32,
}

impl Model {
    pub fn joint_count(&self) -> usize {
        self.joints.len().max(1)
    }
    /// Instances one draw of this model can carry.
    pub fn per_draw(&self) -> usize {
        (self.copies as usize).max(1)
    }
}

#[derive(Debug, PartialEq)]
pub enum ModelError {
    Header,
    Version,
    Truncated,
    TooLarge,
}

fn color_byte(c: f32) -> u8 {
    (clampf(c, 0.0, 1.0) * 255.0 + 0.5) as u8
}

fn shape_for(geom: u32, p: &[f32; 8], raw: &[f32], lod: &Lod) -> Option<Shape> {
    Some(match geom {
        g::BOX => geom::box_shape(
            if p[0] > 0.0 { p[0] } else { 1.0 },
            if p[1] > 0.0 { p[1] } else { 1.0 },
            if p[2] > 0.0 { p[2] } else { 1.0 },
        ),
        g::SPHERE => geom::sphere(p, lod),
        g::CYLINDER => geom::cylinder(p, lod),
        g::CAPSULE => geom::capsule(p, lod),
        g::TORUS => geom::torus(p, lod),
        g::PLANE => geom::plane(p),
        g::CIRCLE => geom::ring(0.0, if p[0] > 0.0 { p[0] } else { 1.0 }, p[1], p[2], p[3], lod),
        g::RING => geom::ring(p[0], p[1], p[2], p[3], p[4], lod),
        g::ICOSAHEDRON => geom::icosahedron(if p[0] > 0.0 { p[0] } else { 1.0 }, p[1] as u32),
        g::OCTAHEDRON => geom::octahedron(if p[0] > 0.0 { p[0] } else { 1.0 }, p[1] as u32),
        g::DODECAHEDRON => geom::dodecahedron(if p[0] > 0.0 { p[0] } else { 1.0 }, p[1] as u32),
        g::TETRAHEDRON => geom::tetrahedron(if p[0] > 0.0 { p[0] } else { 1.0 }, p[1] as u32),
        g::RAW => {
            let start = p[0] as usize;
            let count = p[1] as usize;
            let end = start.checked_add(count.checked_mul(3)?)?;
            if end > raw.len() {
                return None;
            }
            geom::raw(&raw[start..end])
        }
        _ => return None,
    })
}

struct Built {
    pos: Vec3,
    nrm: Vec3,
    rgba: [u8; 4],
    joint: u8,
}

/// Parse a model description (contracts/spec/playset.ts PLAYSET_MODEL).
pub fn build(desc: &[f32], lod: &Lod) -> Result<Model, ModelError> {
    if desc.len() < md::HEADER {
        return Err(ModelError::Header);
    }
    if desc[0] as usize != md::VERSION {
        return Err(ModelError::Version);
    }
    let parts = desc[1] as usize;
    let joints = desc[2] as usize;
    let raw_len = desc[3] as usize;
    let joint_at = md::HEADER;
    let part_at = joint_at + joints * md::JOINT_STRIDE;
    let raw_at = part_at + parts * md::PART_STRIDE;
    if joints > PALETTE || raw_at + raw_len > desc.len() {
        return Err(ModelError::Truncated);
    }
    let raw = &desc[raw_at..raw_at + raw_len];
    let mut model = Model::default();
    for j in 0..joints {
        let r = &desc[joint_at + j * md::JOINT_STRIDE..];
        let parent = r[0] as i32;
        model.joints.push(Joint {
            parent: if parent >= 0 && (parent as usize) < j { parent } else { -1 },
            pivot: v3(r[1], r[2], r[3]),
        });
    }
    // Per pass key: (blend, opacity in 1/64ths), opaque first.
    let mut groups: Vec<((u8, u8), Vec<Built>, Vec<u32>)> = Vec::new();
    let mut bmin = v3(f32::MAX, f32::MAX, f32::MAX);
    let mut bmax = v3(-f32::MAX, -f32::MAX, -f32::MAX);
    for i in 0..parts {
        let r = &desc[part_at + i * md::PART_STRIDE..part_at + (i + 1) * md::PART_STRIDE];
        let mut p = [0.0f32; 8];
        p.copy_from_slice(&r[part::P0..part::P0 + 8]);
        let Some(mut shape) = shape_for(r[part::GEOM] as u32, &p, raw, lod) else {
            continue;
        };
        if r[part::JITTER] > 0.0 {
            shape.jitter(r[part::JITTER], r[part::SEED] as u32);
            shape.flatten();
        } else if r[part::FLAT] > 0.5 {
            shape.flatten();
        }
        let mut m = [0.0f32; 12];
        m.copy_from_slice(&r[part::M..part::M + 12]);
        let m = Mat34(m);
        let joint = (r[part::JOINT] as i32).clamp(0, joints.max(1) as i32 - 1) as u8;
        let opacity = clampf(if r[part::OPACITY] > 0.0 { r[part::OPACITY] } else { 1.0 }, 0.0, 1.0);
        let mut b = r[part::BLEND] as u8;
        if b == blend::OPAQUE as u8 && opacity < 0.99 {
            b = blend::ALPHA as u8;
        }
        let key = (b, if b == blend::OPAQUE as u8 { 64 } else { (opacity * 64.0) as u8 });
        let rgba = [
            color_byte(r[part::R]),
            color_byte(r[part::G]),
            color_byte(r[part::B]),
            color_byte(r[part::EMISSIVE]),
        ];
        let gi = match groups.iter().position(|(k, _, _)| *k == key) {
            Some(i) => i,
            None => {
                groups.push((key, Vec::new(), Vec::new()));
                groups.len() - 1
            }
        };
        let (_, verts, idx) = &mut groups[gi];
        let base = verts.len() as u32;
        for (pos, nrm) in shape.pos.iter().zip(shape.nrm.iter()) {
            verts.push(Built { pos: m.point(*pos), nrm: m.vector(*nrm).normalized(), rgba, joint });
        }
        for t in shape.idx {
            idx.push(base + t);
        }
        if r[part::NO_BOUNDS] < 0.5 {
            for pos in shape.pos.iter() {
                let w = m.point(*pos);
                bmin = v3(minf(bmin.x, w.x), minf(bmin.y, w.y), minf(bmin.z, w.z));
                bmax = v3(maxf(bmax.x, w.x), maxf(bmax.y, w.y), maxf(bmax.z, w.z));
            }
        }
    }
    groups.sort_by_key(|((b, o), _, _)| (*b, core::cmp::Reverse(*o)));
    let total: usize = groups.iter().map(|(_, v, _)| v.len()).sum();
    if total > 65_535 {
        return Err(ModelError::TooLarge);
    }
    let jc = joints.max(1);
    let mut copies = (PALETTE / jc).max(1);
    if total > 0 {
        copies = copies.min((REPLICA_VERTICES / total).max(1)).min(65_535 / total.max(1));
    }
    model.copies = copies as u32;
    model.vertex_count = total as u32;
    // Vertices: copy k of every group, groups back to back inside a copy.
    let mut group_base = Vec::with_capacity(groups.len());
    let mut acc = 0u32;
    for (_, v, _) in groups.iter() {
        group_base.push(acc);
        acc += v.len() as u32;
    }
    for k in 0..copies {
        for (_, verts, _) in groups.iter() {
            for v in verts.iter() {
                model.verts.push(GpuVertex {
                    pos: [v.pos.x, v.pos.y, v.pos.z],
                    nb: geom::pack_normal(v.nrm, (k * jc) as u8 + v.joint),
                    rgba: v.rgba,
                });
            }
        }
    }
    let mut tris = 0;
    for (gi, ((b, o), _, idx)) in groups.iter().enumerate() {
        let first = model.idx.len() as u32;
        for k in 0..copies as u32 {
            let shift = k * total as u32 + group_base[gi];
            model.idx.extend(idx.iter().map(|i| (shift + i) as u16));
        }
        tris += idx.len() as u32 / 3;
        model.passes.push(Pass {
            first,
            count: idx.len() as u32,
            blend: *b,
            opacity: if *b == blend::OPAQUE as u8 { 1.0 } else { *o as f32 / 64.0 },
        });
    }
    model.tris = tris;
    if bmin.x > bmax.x {
        bmin = Vec3::ZERO;
        bmax = Vec3::ZERO;
    }
    model.min = bmin;
    model.max = bmax;
    model.center = (model.min + model.max) * 0.5;
    model.radius = (model.max - model.min).len() * 0.5;
    model.revision = 1;
    Ok(model)
}

#[cfg(test)]
pub mod tests {
    use super::*;

    /// A description with `parts` boxes on joint 0, for tests.
    pub fn boxes(parts: &[(f32, f32, f32, [f32; 3], f32)]) -> Vec<f32> {
        let mut d = alloc::vec![md::VERSION as f32, parts.len() as f32, 0.0, 0.0];
        for &(w, h, dd, pos, opacity) in parts {
            let mut r = [0.0f32; md::PART_STRIDE];
            r[part::GEOM] = g::BOX as f32;
            r[part::P0] = w;
            r[part::P1] = h;
            r[part::P2] = dd;
            r[part::R] = 1.0;
            r[part::OPACITY] = opacity;
            let m = [1.0, 0.0, 0.0, pos[0], 0.0, 1.0, 0.0, pos[1], 0.0, 0.0, 1.0, pos[2]];
            r[part::M..part::M + 12].copy_from_slice(&m);
            d.extend_from_slice(&r);
        }
        d
    }

    #[test]
    fn replicates_small_models() {
        let d = boxes(&[(1.0, 1.0, 1.0, [0.0, 0.0, 0.0], 1.0)]);
        let m = build(&d, &Lod::default()).unwrap();
        assert_eq!(m.copies as usize, PALETTE);
        assert_eq!(m.vertex_count, 24);
        assert_eq!(m.verts.len(), 24 * PALETTE);
        assert_eq!(m.passes.len(), 1);
        assert_eq!(m.passes[0].count, 36);
        // copy 3 uses bone 3
        assert_eq!(m.verts[24 * 3].nb[3], 3);
        assert!((m.radius - 0.866).abs() < 0.01);
    }

    #[test]
    fn transparent_parts_get_their_own_pass() {
        let d = boxes(&[(1.0, 1.0, 1.0, [0.0, 0.0, 0.0], 1.0), (2.0, 2.0, 2.0, [0.0, 1.0, 0.0], 0.25)]);
        let m = build(&d, &Lod::default()).unwrap();
        assert_eq!(m.passes.len(), 2);
        assert_eq!(m.passes[0].blend, blend::OPAQUE as u8);
        assert_eq!(m.passes[1].blend, blend::ALPHA as u8);
        assert!((m.passes[1].opacity - 0.25).abs() < 0.02);
        // the transparent pass indexes the second group of copy 0
        let first = m.idx[m.passes[1].first as usize];
        assert_eq!(first, 24);
    }
}
