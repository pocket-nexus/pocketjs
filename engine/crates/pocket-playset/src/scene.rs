//! The retained scene: models, nodes, static batches, environment, ground.
//!
//! A STATIC node is baked into world-space geometry grouped by grid cell, so
//! scenery costs one draw per visible cell whatever its node count. A dynamic
//! node keeps its model and matrix and is drawn as an instance.

use crate::fmath::*;
use crate::geom::{GpuVertex, Lod};
use crate::model::{self, Model, ModelError};
use crate::vec::*;
use alloc::vec::Vec;

pub const CELL: f32 = 32.0;
pub const BATCH_VERTICES: usize = 16_000;

#[derive(Clone, Copy, Debug)]
pub struct Node {
    pub model: u32,
    pub m: Mat34,
    pub flags: u32,
    pub alive: bool,
}

#[derive(Default)]
pub struct Batch {
    pub cx: i32,
    pub cz: i32,
    pub verts: Vec<GpuVertex>,
    pub idx: Vec<u16>,
    pub min: Vec3,
    pub max: Vec3,
    pub revision: u32,
    /// Index offsets of axis-facing groups in FACE_GROUPS order, the seventh
    /// the end: when `faces[6] > 0` the renderer skips the groups that face
    /// away from the eye (voxel chunks). Zero = one group.
    pub faces: [u32; 7],
}

/// The direction of each face group (0 +x, 1 -x, 2 +y, 3 -y, 4 +z, 5 -z),
/// ordered so the groups an eye sees are mostly one contiguous range.
pub const FACE_GROUPS: [usize; 6] = [5, 1, 2, 3, 0, 4];

impl Batch {
    fn grow(&mut self, p: Vec3) {
        if self.verts.is_empty() {
            self.min = p;
            self.max = p;
        }
        self.min = v3(minf(self.min.x, p.x), minf(self.min.y, p.y), minf(self.min.z, p.z));
        self.max = v3(maxf(self.max.x, p.x), maxf(self.max.y, p.y), maxf(self.max.z, p.z));
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Env {
    pub sky_top: Vec3,
    pub sky_horizon: Vec3,
    pub sky_bottom: Vec3,
    pub fog_color: Vec3,
    pub fog_start: f32,
    pub fog_end: f32,
    pub fog_max: f32,
    pub sun_dir: Vec3,
    pub sun_color: Vec3,
    pub hemi_sky: Vec3,
    pub hemi_ground: Vec3,
    pub gravity: f32,
    pub bounds_min: Vec3,
    pub bounds_max: Vec3,
    pub has_bounds: bool,
}

impl Default for Env {
    fn default() -> Self {
        Env {
            sky_top: v3(0.36, 0.56, 0.86),
            sky_horizon: v3(0.75, 0.84, 0.93),
            sky_bottom: v3(0.75, 0.84, 0.93),
            fog_color: v3(0.75, 0.84, 0.93),
            fog_start: 60.0,
            fog_end: 160.0,
            fog_max: 0.0,
            sun_dir: v3(0.4, 0.8, 0.35).normalized(),
            sun_color: v3(1.0, 0.96, 0.9),
            hemi_sky: v3(0.55, 0.6, 0.7),
            hemi_ground: v3(0.3, 0.27, 0.24),
            gravity: 24.0,
            bounds_min: v3(-1e6, -1e6, -1e6),
            bounds_max: v3(1e6, 1e6, 1e6),
            has_bounds: false,
        }
    }
}

/// A sampled height grid: `w` x `h` samples, `cell` apart, centred on the
/// origin unless `origin` says otherwise. Row 0 is at -Z.
#[derive(Default)]
pub struct Heightfield {
    pub w: usize,
    pub h: usize,
    pub cell: f32,
    pub origin: Vec3,
    pub heights: Vec<f32>,
}

impl Heightfield {
    pub fn active(&self) -> bool {
        self.w > 1 && self.h > 1
    }
    #[inline]
    fn at(&self, x: usize, z: usize) -> f32 {
        self.heights[z.min(self.h - 1) * self.w + x.min(self.w - 1)]
    }
    /// Bilinear height; outside the grid the edge sample.
    pub fn height(&self, x: f32, z: f32) -> f32 {
        let fx = clampf((x - self.origin.x) / self.cell, 0.0, (self.w - 1) as f32);
        let fz = clampf((z - self.origin.z) / self.cell, 0.0, (self.h - 1) as f32);
        let (ix, iz) = (fx as usize, fz as usize);
        let (tx, tz) = (fx - ix as f32, fz - iz as f32);
        let a = self.at(ix, iz);
        let b = self.at(ix + 1, iz);
        let c = self.at(ix, iz + 1);
        let d = self.at(ix + 1, iz + 1);
        self.origin.y + lerpf(lerpf(a, b, tx), lerpf(c, d, tx), tz)
    }
    pub fn normal(&self, x: f32, z: f32) -> Vec3 {
        let e = self.cell * 0.5;
        let hx = self.height(x + e, z) - self.height(x - e, z);
        let hz = self.height(x, z + e) - self.height(x, z - e);
        v3(-hx, 2.0 * e, -hz).normalized()
    }
}

/// Animated water: a sum of two sines, sampled the same way by boats and by
/// the mesh.
#[derive(Clone, Copy, Default)]
pub struct Water {
    pub active: bool,
    pub level: f32,
    pub amplitude: f32,
    pub wavelength: f32,
    pub speed: f32,
    pub half: f32,
    pub cells: u32,
    pub color: Vec3,
    pub deep: Vec3,
}

impl Water {
    pub fn height(&self, x: f32, z: f32, t: f32) -> f32 {
        if !self.active {
            return self.level;
        }
        let k = TAU / maxf(self.wavelength, 0.1);
        let w = t * self.speed * k;
        self.level
            + self.amplitude * (0.6 * sinf(x * k + w) + 0.4 * sinf((x * 0.6 + z * 0.8) * k * 1.3 + w * 1.2))
    }
    pub fn normal(&self, x: f32, z: f32, t: f32) -> Vec3 {
        let e = 0.5;
        let hx = self.height(x + e, z, t) - self.height(x - e, z, t);
        let hz = self.height(x, z + e, t) - self.height(x, z - e, t);
        v3(-hx, 2.0 * e, -hz).normalized()
    }
}

/// Static colliders the movers slide against.
#[derive(Clone, Copy, Debug)]
pub enum Collider {
    /// axis-aligned after rotating by -yaw about the centre
    Box { c: Vec3, half: Vec3, yaw: f32 },
    Cylinder { c: Vec3, r: f32, half_h: f32 },
}

pub struct Scene {
    pub lod: Lod,
    pub models: Vec<Model>,
    pub nodes: Vec<Node>,
    pub batches: Vec<Batch>,
    pub batches_dirty: bool,
    pub batch_revision: u32,
    pub env: Env,
    pub terrain: Heightfield,
    pub water: Water,
    pub colliders: Vec<Collider>,
    /// ground and terrain tiles, built when set (shared vertices per tile)
    pub ground: Vec<Batch>,
    pub flat_y: f32,
}

impl Default for Scene {
    fn default() -> Self {
        Scene {
            lod: Lod::default(),
            models: Vec::new(),
            nodes: Vec::new(),
            batches: Vec::new(),
            batches_dirty: false,
            batch_revision: 0,
            env: Env::default(),
            terrain: Heightfield::default(),
            water: Water::default(),
            colliders: Vec::new(),
            ground: Vec::new(),
            flat_y: 0.0,
        }
    }
}

fn srgb(r: f32, g: f32, b: f32) -> [u8; 3] {
    let q = |c: f32| (clampf(c, 0.0, 1.0) * 255.0 + 0.5) as u8;
    [q(r), q(g), q(b)]
}

impl Scene {
    pub fn add_model(&mut self, desc: &[f32]) -> Result<u32, ModelError> {
        let m = model::build(desc, &self.lod)?;
        self.models.push(m);
        Ok((self.models.len() - 1) as u32)
    }

    pub fn add_node(&mut self, model: u32, m: Mat34, flags: u32) -> i32 {
        if model as usize >= self.models.len() {
            return -1;
        }
        let md = &self.models[model as usize];
        if flags & crate::schema::node::COLLIDE_BOX != 0 || flags & crate::schema::node::COLLIDE_CYL != 0 {
            let s = m.max_scale();
            let c = m.point(md.center);
            let half = (md.max - md.min) * (0.5 * s);
            if flags & crate::schema::node::COLLIDE_BOX != 0 {
                let yaw = atan2f(-m.0[8], m.0[0]);
                self.colliders.push(Collider::Box { c, half, yaw: -yaw });
            } else {
                self.colliders.push(Collider::Cylinder { c, r: maxf(half.x, half.z), half_h: half.y });
            }
        }
        let static_node = flags & crate::schema::node::STATIC != 0;
        // Transparent parts cannot be baked: the node stays an instance.
        let bakeable = md.passes.iter().all(|p| p.blend == 0);
        let flags = if static_node && !bakeable { flags & !crate::schema::node::STATIC } else { flags };
        self.nodes.push(Node { model, m, flags, alive: true });
        if flags & crate::schema::node::STATIC != 0 {
            self.batches_dirty = true;
        }
        (self.nodes.len() - 1) as i32
    }

    pub fn set_node(&mut self, node: usize, m: Mat34, flags: u32) {
        if let Some(n) = self.nodes.get_mut(node) {
            if n.flags & crate::schema::node::STATIC != 0 {
                return;
            }
            n.m = m;
            n.flags = (n.flags & crate::schema::node::STATIC) | (flags & !crate::schema::node::STATIC);
        }
    }

    pub fn remove_node(&mut self, node: usize) {
        if let Some(n) = self.nodes.get_mut(node) {
            if n.flags & crate::schema::node::STATIC != 0 {
                self.batches_dirty = true;
            }
            n.alive = false;
        }
    }

    pub fn ground_height(&self, x: f32, z: f32) -> f32 {
        if self.terrain.active() {
            self.terrain.height(x, z)
        } else {
            self.flat_y
        }
    }

    pub fn ground_normal(&self, x: f32, z: f32) -> Vec3 {
        if self.terrain.active() {
            self.terrain.normal(x, z)
        } else {
            Vec3::UP
        }
    }

    /// A flat checkered ground of `half` metres around the origin, one tile
    /// per 16x16 cells.
    pub fn flat_ground(&mut self, y: f32, half: f32, a: [f32; 3], b: [f32; 3], cell: f32) {
        self.flat_y = y;
        self.ground.clear();
        let cell = if cell > 0.5 { cell } else { 4.0 };
        let n = ((half * 2.0 / cell) as i32).clamp(1, 128);
        let step = half * 2.0 / n as f32;
        let ca = srgb(a[0], a[1], a[2]);
        let cb = srgb(b[0], b[1], b[2]);
        let nb = crate::geom::pack_normal(Vec3::UP, 0);
        self.batch_revision = self.batch_revision.wrapping_add(1);
        let mut tz = 0;
        while tz < n {
            let mut tx = 0;
            while tx < n {
                let mut tile = Batch { revision: self.batch_revision, ..Batch::default() };
                for iz in tz..(tz + 16).min(n) {
                    for ix in tx..(tx + 16).min(n) {
                        let x0 = -half + ix as f32 * step;
                        let z0 = -half + iz as f32 * step;
                        let c = if (ix + iz) % 2 == 0 { ca } else { cb };
                        let base = tile.verts.len() as u16;
                        for p in [v3(x0, y, z0 + step), v3(x0 + step, y, z0 + step), v3(x0 + step, y, z0), v3(x0, y, z0)] {
                            tile.grow(p);
                            tile.verts.push(GpuVertex { pos: [p.x, p.y, p.z], nb, rgba: [c[0], c[1], c[2], 0] });
                        }
                        tile.idx.extend_from_slice(&[base, base + 1, base + 2, base, base + 2, base + 3]);
                    }
                }
                self.ground.push(tile);
                tx += 16;
            }
            tz += 16;
        }
    }

    /// Heights from the guest (row-major, row 0 at -Z), coloured by height
    /// bands: `bands` holds (height, r, g, b) stops in rising order.
    pub fn set_terrain(&mut self, w: usize, h: usize, cell: f32, origin: Vec3, heights: &[f32], bands: &[f32]) {
        if w < 2 || h < 2 || heights.len() < w * h {
            return;
        }
        self.terrain = Heightfield {
            w,
            h,
            cell,
            origin: v3(origin.x - (w - 1) as f32 * cell * 0.5, origin.y, origin.z - (h - 1) as f32 * cell * 0.5),
            heights: heights[..w * h].to_vec(),
        };
        let stops: Vec<(f32, Vec3)> = bands.chunks_exact(4).map(|s| (s[0], v3(s[1], s[2], s[3]))).collect();
        let color_at = |y: f32, slope: f32| -> [u8; 3] {
            let mut c = if let Some(first) = stops.first() { first.1 } else { v3(0.4, 0.6, 0.3) };
            for i in 0..stops.len() {
                if y >= stops[i].0 {
                    c = stops[i].1;
                    if i + 1 < stops.len() && y < stops[i + 1].0 {
                        let t = (y - stops[i].0) / maxf(stops[i + 1].0 - stops[i].0, 1e-3);
                        c = stops[i].1.lerp(stops[i + 1].1, t);
                    }
                }
            }
            // steep faces darken toward rock
            let k = clampf(1.0 - slope * 0.35, 0.65, 1.0);
            srgb(c.x * k, c.y * k, c.z * k)
        };
        let t = &self.terrain;
        let mut verts = Vec::with_capacity(w * h);
        for z in 0..h {
            for x in 0..w {
                let px = t.origin.x + x as f32 * cell;
                let pz = t.origin.z + z as f32 * cell;
                let y = t.origin.y + t.heights[z * w + x];
                let n = t.normal(px, pz);
                let c = color_at(y - t.origin.y, 1.0 - n.y);
                verts.push(GpuVertex { pos: [px, y, pz], nb: crate::geom::pack_normal(n, 0), rgba: [c[0], c[1], c[2], 0] });
            }
        }
        // tiles of 16x16 quads sharing their vertices; neighbours share an edge
        self.ground.clear();
        self.batch_revision = self.batch_revision.wrapping_add(1);
        let mut tz = 0;
        while tz + 1 < h {
            let mut tx = 0;
            while tx + 1 < w {
                let x1 = (tx + 16).min(w - 1);
                let z1 = (tz + 16).min(h - 1);
                let mut tile = Batch { revision: self.batch_revision, ..Batch::default() };
                let tw = x1 - tx + 1;
                for z in tz..=z1 {
                    for x in tx..=x1 {
                        let v = verts[z * w + x];
                        tile.grow(v3(v.pos[0], v.pos[1], v.pos[2]));
                        tile.verts.push(v);
                    }
                }
                for z in 0..z1 - tz {
                    for x in 0..x1 - tx {
                        let a = (z * tw + x) as u16;
                        let b = a + 1;
                        let c = a + tw as u16;
                        let d = c + 1;
                        // counter-clockwise seen from above (+Y)
                        tile.idx.extend_from_slice(&[a, c, d, a, d, b]);
                    }
                }
                self.ground.push(tile);
                tx = x1;
            }
            tz = z1_of(tz, h);
        }
    }

    /// Re-bake every static node and the ground into per-cell batches.
    pub fn rebuild_batches(&mut self) {
        self.batches.clear();
        self.batch_revision = self.batch_revision.wrapping_add(1);
        let rev = self.batch_revision;
        fn batch_for(batches: &mut Vec<Batch>, cx: i32, cz: i32, need: usize, rev: u32) -> usize {
            if let Some(i) = batches
                .iter()
                .rposition(|b| b.cx == cx && b.cz == cz && b.verts.len() + need <= BATCH_VERTICES)
            {
                return i;
            }
            batches.push(Batch { cx, cz, revision: rev, ..Batch::default() });
            batches.len() - 1
        }
        let cell_of = |p: Vec3| ((floorf(p.x / CELL)) as i32, (floorf(p.z / CELL)) as i32);
        for n in self.nodes.iter() {
            if !n.alive || n.flags & crate::schema::node::STATIC == 0 || n.flags & crate::schema::node::HIDDEN != 0 {
                continue;
            }
            let md = &self.models[n.model as usize];
            let count = md.vertex_count as usize;
            if count == 0 {
                continue;
            }
            let (cx, cz) = cell_of(n.m.translation());
            let bi = batch_for(&mut self.batches, cx, cz, count, rev);
            let b = &mut self.batches[bi];
            let base = b.verts.len() as u32;
            for v in md.verts[..count].iter() {
                let p = n.m.point(v3(v.pos[0], v.pos[1], v.pos[2]));
                let nn = n.m.vector(v3(v.nb[0] as f32, v.nb[1] as f32, v.nb[2] as f32)).normalized();
                b.grow(p);
                b.verts.push(GpuVertex { pos: [p.x, p.y, p.z], nb: crate::geom::pack_normal(nn, 0), rgba: v.rgba });
            }
            // copy 0 of every opaque pass
            for pass in md.passes.iter() {
                for &i in md.idx[pass.first as usize..(pass.first + pass.count) as usize].iter() {
                    b.idx.push((base + i as u32) as u16);
                }
            }
        }
        self.batches.retain(|b| !b.idx.is_empty());
        self.batches_dirty = false;
    }
}

fn z1_of(tz: usize, h: usize) -> usize {
    (tz + 16).min(h - 1)
}
