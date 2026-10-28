//! The voxel module: a chunked block world drawn as `scene.ground` tiles.
//!
//! Blocks are one byte each (0 = air, 1..15 = palette types) over a fixed
//! box of `sx * sy * sz` blocks whose first block sits at the world block
//! coordinate `origin`; block (x, y, z) fills [x, x+1] x [y, y+1] x [z, z+1]
//! in world metres. The world is cut into chunks of 8 x 16 x 8 blocks (a
//! narrow footprint culls tighter against a short view), one ground tile
//! each, appended to `scene.ground` at INIT. A chunk is meshed with its
//! hidden faces culled, four shared vertices per face, corner occlusion baked
//! into the vertex colours, and coplanar faces of one type merged into larger
//! quads along the directions their occlusion does not change, so a merged
//! quad interpolates the light of the faces it replaces. Types marked flat
//! take no occlusion and merge freely (foliage). The tile's indices are
//! grouped by face direction (`Batch::faces`), and the renderer skips the
//! groups that face away from the eye. An edit marks the chunks whose faces
//! or occlusion it changes; the per-step hook rebuilds at most `budget` of
//! them and bumps their tile revision, so the 3DS renderer re-uploads only
//! those tiles.
//!
//! Bodies are slots the step hook collides with the blocks after the world's
//! step: an axis-aligned box (radius, height) moved from its last resolved
//! position to where its kernel put it, axis by axis (x, z, then y), each
//! axis kept only if the box stays clear; a blocked axis zeroes that
//! velocity, and a blocked fall sets GROUNDED. Outside the box the world is
//! solid at the sides and below, open above.
//!
//! Ops (`playset.call(MODULE.VOXEL, op, args, out)`; the TS wrapper is
//! framework/src/playset/voxel.ts):
//!
//! | op | args | returns, out |
//! | --- | --- | --- |
//! | INIT | sx, sy, sz, ox, oy, oz | tile count |
//! | PALETTE | type, r, g, b, glow (sRGB 0..1), flat (1 = no occlusion) | 0 |
//! | SHADE | +x, -x, +y, -y, +z, -z, ao | 0 |
//! | GET | x, y, z | type, -1 outside |
//! | SET | x, y, z, type | previous type |
//! | SET_LIST | (x, y, z, type)... | blocks changed |
//! | FILL | x0, y0, z0, x1, y1, z1, type (inclusive) | blocks changed |
//! | COLUMNS | x0, z0, w, d, base, top, depth, heights[w*d] | blocks set |
//! | HEIGHT | x, z | y of the first air above the column's top block |
//! | RAYCAST | ox, oy, oz, dx, dy, dz, max | type hit (0 = none); out bx, by, bz, nx, ny, nz, dist |
//! | BODY | slot, radius, height, max fall | body count; radius <= 0 removes |
//! | BUILD | | chunks rebuilt now |
//! | BUDGET | chunks per step | 0 |
//! | SNAPSHOT | | 0 |
//! | RESTORE | | chunks changed |
//! | STATS | | out faces, vertices, dirty chunks, rebuilt last step |
//! | COUNT | type | blocks of that type |

use crate::geom::{pack_normal, GpuVertex};
use crate::scene::{Batch, Scene};
use crate::schema::{ent as E, state as ST};
use crate::vec::*;
use crate::world::World;
use alloc::vec;
use alloc::vec::Vec;

pub mod op {
    pub const INIT: u32 = 1;
    pub const PALETTE: u32 = 2;
    pub const SHADE: u32 = 3;
    pub const GET: u32 = 4;
    pub const SET: u32 = 5;
    pub const SET_LIST: u32 = 6;
    pub const FILL: u32 = 7;
    pub const COLUMNS: u32 = 8;
    pub const HEIGHT: u32 = 9;
    pub const RAYCAST: u32 = 10;
    pub const BODY: u32 = 11;
    pub const BUILD: u32 = 12;
    pub const BUDGET: u32 = 13;
    pub const SNAPSHOT: u32 = 14;
    pub const RESTORE: u32 = 15;
    pub const STATS: u32 = 16;
    pub const COUNT: u32 = 17;
}

/// Chunk size in blocks along x, y, z: narrow footprints cull tighter
/// against a short view distance.
pub const CHUNK: [usize; 3] = [8, 16, 8];
/// The padded chunk (a one-block border).
const PX: usize = CHUNK[0] + 2;
const PY: usize = CHUNK[1] + 2;
const PZ: usize = CHUNK[2] + 2;
const MASK: usize = 256;
/// Marks a block below the world in a padded chunk: solid, never meshed.
const BEDROCK: u8 = 255;
pub const TYPES: usize = 16;
/// Linear light kept at a vertex with 0..3 occluders (corner AO).
const AO_LINEAR: [f32; 4] = [1.0, 0.76, 0.6, 0.46];

#[derive(Clone, Copy)]
pub struct Body {
    pub slot: i32,
    pub radius: f32,
    pub height: f32,
    pub max_fall: f32,
    pub prev: Vec3,
    pub fresh: bool,
}

pub struct Voxels {
    pub active: bool,
    pub size: [usize; 3],
    pub origin: [i32; 3],
    pub blocks: Vec<u8>,
    snapshot: Vec<u8>,
    /// chunks along x, y, z
    pub chunks: [usize; 3],
    pub tile_base: usize,
    dirty: Vec<bool>,
    dirty_count: usize,
    pub budget: usize,
    revision: u32,
    /// sRGB colour and emissive amount per type
    pub palette: [[f32; 4]; TYPES],
    /// linear light per face direction: +x, -x, +y, -y, +z, -z
    pub shade: [f32; 6],
    pub ao: f32,
    /// types whose faces take no corner occlusion (bit per type): their
    /// faces merge freely, for foliage and other many-sided shapes
    pub flat: u16,
    pub bodies: Vec<Body>,
    pub rebuilt_last_step: usize,
    // meshing scratch, kept between rebuilds
    pad: Vec<u8>,
    /// per face: type in the low byte, the four corner occlusion levels above
    mask: Vec<u16>,
}

impl Default for Voxels {
    fn default() -> Self {
        let mut palette = [[0.7, 0.7, 0.7, 0.0]; TYPES];
        palette[0] = [0.0; 4];
        Voxels {
            active: false,
            size: [0; 3],
            origin: [0; 3],
            blocks: Vec::new(),
            snapshot: Vec::new(),
            chunks: [0; 3],
            tile_base: 0,
            dirty: Vec::new(),
            dirty_count: 0,
            budget: 2,
            revision: 1 << 24,
            palette,
            // GameBlocks voxel-survival's face shades
            shade: [0.9, 0.9, 1.16, 0.62, 0.78, 0.78],
            ao: 1.0,
            flat: 0,
            bodies: Vec::new(),
            rebuilt_last_step: 0,
            pad: vec![0; PX * PY * PZ],
            mask: vec![0; MASK],
        }
    }
}

#[inline]
fn arg(a: &[f32], i: usize) -> f32 {
    a.get(i).copied().unwrap_or(0.0)
}

#[inline]
fn ifloor(v: f32) -> i32 {
    let t = v as i32;
    if (t as f32) > v {
        t - 1
    } else {
        t
    }
}

impl Voxels {
    /// Index of a world block coordinate inside the box.
    #[inline]
    fn index(&self, x: i32, y: i32, z: i32) -> Option<usize> {
        let lx = x - self.origin[0];
        let ly = y - self.origin[1];
        let lz = z - self.origin[2];
        if lx < 0 || ly < 0 || lz < 0 {
            return None;
        }
        let (lx, ly, lz) = (lx as usize, ly as usize, lz as usize);
        if lx >= self.size[0] || ly >= self.size[1] || lz >= self.size[2] {
            return None;
        }
        Some((ly * self.size[2] + lz) * self.size[0] + lx)
    }

    /// The block type, 0 outside the box.
    #[inline]
    pub fn get(&self, x: i32, y: i32, z: i32) -> u8 {
        match self.index(x, y, z) {
            Some(i) => self.blocks[i],
            None => 0,
        }
    }

    /// Collision: solid blocks, and everything beside or below the box.
    #[inline]
    pub fn solid(&self, x: i32, y: i32, z: i32) -> bool {
        match self.index(x, y, z) {
            Some(i) => self.blocks[i] != 0,
            None => y < self.origin[1] + self.size[1] as i32,
        }
    }

    pub fn init(&mut self, scene: &mut Scene, sx: usize, sy: usize, sz: usize, origin: [i32; 3]) -> usize {
        let sx = sx.clamp(1, 1024);
        let sy = sy.clamp(1, 256);
        let sz = sz.clamp(1, 1024);
        // a second INIT replaces this module's tiles, not the others'
        if self.active && self.tile_base <= scene.ground.len() {
            scene.ground.truncate(self.tile_base);
        }
        self.size = [sx, sy, sz];
        self.origin = origin;
        self.blocks = vec![0; sx * sy * sz];
        self.snapshot.clear();
        self.chunks = [sx.div_ceil(CHUNK[0]), sy.div_ceil(CHUNK[1]), sz.div_ceil(CHUNK[2])];
        let n = self.chunks[0] * self.chunks[1] * self.chunks[2];
        self.tile_base = scene.ground.len();
        for _ in 0..n {
            scene.ground.push(Batch::default());
        }
        self.dirty = vec![true; n];
        self.dirty_count = n;
        self.bodies.clear();
        self.active = true;
        n
    }

    #[inline]
    fn chunk_index(&self, cx: usize, cy: usize, cz: usize) -> usize {
        (cy * self.chunks[2] + cz) * self.chunks[0] + cx
    }

    fn mark(&mut self, ci: usize) {
        if !self.dirty[ci] {
            self.dirty[ci] = true;
            self.dirty_count += 1;
        }
    }

    /// Mark the chunk holding a block, and the neighbours whose faces or
    /// occlusion read it (a block on a chunk's edge).
    fn touch(&mut self, x: i32, y: i32, z: i32) {
        let l = [x - self.origin[0], y - self.origin[1], z - self.origin[2]];
        let mut lo = [0usize; 3];
        let mut hi = [0usize; 3];
        for a in 0..3 {
            if l[a] < 0 || l[a] as usize >= self.size[a] {
                return;
            }
            let c = l[a] as usize / CHUNK[a];
            let r = l[a] as usize % CHUNK[a];
            lo[a] = if r == 0 && c > 0 { c - 1 } else { c };
            hi[a] = if r == CHUNK[a] - 1 && c + 1 < self.chunks[a] { c + 1 } else { c };
        }
        for cy in lo[1]..=hi[1] {
            for cz in lo[2]..=hi[2] {
                for cx in lo[0]..=hi[0] {
                    let ci = self.chunk_index(cx, cy, cz);
                    self.mark(ci);
                }
            }
        }
    }

    pub fn set(&mut self, x: i32, y: i32, z: i32, t: u8) -> i32 {
        let Some(i) = self.index(x, y, z) else { return -1 };
        let old = self.blocks[i];
        if old != t {
            self.blocks[i] = t;
            self.touch(x, y, z);
        }
        old as i32
    }

    /// y of the first air above the column's highest block; the box floor
    /// when the column is empty.
    pub fn height(&self, x: i32, z: i32) -> i32 {
        let base = self.origin[1];
        let top = base + self.size[1] as i32;
        let mut y = top - 1;
        while y >= base {
            if self.get(x, y, z) != 0 {
                return y + 1;
            }
            y -= 1;
        }
        if self.index(x, base, z).is_none() {
            return top;
        }
        base
    }

    /// The first block along a ray (Amanatides and Woo): (type, block,
    /// normal of the face entered, distance).
    pub fn raycast(&self, o: Vec3, d: Vec3, max: f32) -> Option<(u8, [i32; 3], [i32; 3], f32)> {
        let len = d.len();
        if len < 1e-6 {
            return None;
        }
        let d = d * (1.0 / len);
        let max = crate::fmath::minf(max, 1024.0);
        let mut c = [ifloor(o.x), ifloor(o.y), ifloor(o.z)];
        let started_inside = self.index(c[0], c[1], c[2]).is_some();
        let t0 = self.get(c[0], c[1], c[2]);
        let dv = [d.x, d.y, d.z];
        let ov = [o.x, o.y, o.z];
        if t0 != 0 {
            // inside a block: the face against the ray
            let mut n = [0i32; 3];
            let mut big = 0;
            for a in 1..3 {
                if crate::fmath::absf(dv[a]) > crate::fmath::absf(dv[big]) {
                    big = a;
                }
            }
            n[big] = if dv[big] > 0.0 { -1 } else { 1 };
            return Some((t0, c, n, 0.0));
        }
        let mut step = [0i32; 3];
        let mut next = [f32::MAX; 3];
        let mut delta = [f32::MAX; 3];
        for a in 0..3 {
            if dv[a] > 0.0 {
                step[a] = 1;
                delta[a] = 1.0 / dv[a];
                next[a] = (c[a] as f32 + 1.0 - ov[a]) * delta[a];
            } else if dv[a] < 0.0 {
                step[a] = -1;
                delta[a] = -1.0 / dv[a];
                next[a] = (ov[a] - c[a] as f32) * delta[a];
            }
        }
        loop {
            let mut a = 0;
            if next[1] < next[a] {
                a = 1;
            }
            if next[2] < next[a] {
                a = 2;
            }
            let t = next[a];
            if t > max {
                return None;
            }
            c[a] += step[a];
            next[a] += delta[a];
            if self.index(c[0], c[1], c[2]).is_none() {
                // a ray from inside ends where it leaves the box
                if started_inside {
                    return None;
                }
                continue;
            }
            let ty = self.get(c[0], c[1], c[2]);
            if ty != 0 {
                let mut n = [0i32; 3];
                n[a] = -step[a];
                return Some((ty, c, n, t));
            }
        }
    }

    fn clear_box(&self, p: Vec3, r: f32, h: f32) -> bool {
        let x0 = ifloor(p.x - r);
        let x1 = ifloor(p.x + r);
        let y0 = ifloor(p.y);
        let y1 = ifloor(p.y + h);
        let z0 = ifloor(p.z - r);
        let z1 = ifloor(p.z + r);
        for y in y0..=y1 {
            for z in z0..=z1 {
                for x in x0..=x1 {
                    if self.solid(x, y, z) {
                        return false;
                    }
                }
            }
        }
        true
    }

    fn collide_bodies(&mut self, w: &mut World) {
        for i in 0..self.bodies.len() {
            let mut b = self.bodies[i];
            if b.slot < 0 || !w.alive(b.slot as usize) {
                continue;
            }
            let s = b.slot as usize;
            let cur = w.pos(s);
            if b.fresh || (cur - b.prev).len_sq() > 9.0 {
                // registered or teleported since the last step: taken as given
                b.prev = cur;
                b.fresh = false;
                self.bodies[i] = b;
                continue;
            }
            let mut v = w.vel(s);
            if b.max_fall > 0.0 && v.y < -b.max_fall {
                v.y = -b.max_fall;
            }
            let mut p = b.prev;
            let mut grounded = w.state(s) & ST::GROUNDED != 0;
            // x, z, then y, as GameBlocks' voxel-survival moves its player
            let try_x = v3(cur.x, p.y, p.z);
            if self.clear_box(try_x, b.radius, b.height) {
                p = try_x;
            } else {
                v.x = 0.0;
            }
            let try_z = v3(p.x, p.y, cur.z);
            if self.clear_box(try_z, b.radius, b.height) {
                p = try_z;
            } else {
                v.z = 0.0;
            }
            let try_y = v3(p.x, cur.y, p.z);
            if self.clear_box(try_y, b.radius, b.height) {
                p = try_y;
                grounded = false;
            } else {
                if v.y <= 0.0 {
                    grounded = true;
                }
                v.y = 0.0;
            }
            w.set_pos(s, p);
            w.set_vel(s, v);
            w.set_state_bit(s, ST::GROUNDED, grounded);
            w.set(s, E::SPEED, v.flat().len());
            b.prev = p;
            self.bodies[i] = b;
        }
    }

    /// Rebuild one chunk into its tile: hidden faces culled, corner
    /// occlusion in the colours, and faces of one type merged along the
    /// directions their occlusion does not change (so a merged quad
    /// interpolates the same light as the faces it replaces).
    fn mesh(&mut self, ci: usize, tile: &mut Batch) {
        let (ncx, ncz) = (self.chunks[0], self.chunks[2]);
        let c = [ci % ncx, ci / (ncx * ncz), (ci / ncx) % ncz];
        let base = [
            self.origin[0] + (c[0] * CHUNK[0]) as i32,
            self.origin[1] + (c[1] * CHUNK[1]) as i32,
            self.origin[2] + (c[2] * CHUNK[2]) as i32,
        ];
        tile.verts.clear();
        tile.idx.clear();
        tile.faces = [0; 7];
        // the chunk and a one-block border, so every lookup is an offset
        let floor = self.origin[1];
        let mut solid = 0usize;
        for py in 0..PY {
            let y = base[1] + py as i32 - 1;
            for pz in 0..PZ {
                let z = base[2] + pz as i32 - 1;
                let row = (py * PZ + pz) * PX;
                for px in 0..PX {
                    let x = base[0] + px as i32 - 1;
                    let v = match self.index(x, y, z) {
                        Some(i) => self.blocks[i],
                        None => {
                            if y < floor {
                                BEDROCK
                            } else {
                                0
                            }
                        }
                    };
                    self.pad[row + px] = v;
                    if v != 0 && v != BEDROCK && (1..=CHUNK[0]).contains(&px) && (1..=CHUNK[1]).contains(&py) && (1..=CHUNK[2]).contains(&pz) {
                        solid += 1;
                    }
                }
            }
        }
        let mut min = v3(f32::MAX, f32::MAX, f32::MAX);
        let mut max = v3(-f32::MAX, -f32::MAX, -f32::MAX);
        let use_ao = self.ao > 0.0;
        if solid > 0 {
            let stride = [1isize, (PX * PZ) as isize, PX as isize];
            for (group, &dir) in crate::scene::FACE_GROUPS.iter().enumerate() {
                // faces go out grouped by direction, for the renderer's facing test
                tile.faces[group] = tile.idx.len() as u32;
                let a = dir / 2;
                let sign: isize = if dir % 2 == 0 { 1 } else { -1 };
                let ua = (a + 1) % 3;
                let va = (a + 2) % 3;
                let (nu, nv) = (CHUNK[ua], CHUNK[va]);
                let (su, sv) = (stride[ua], stride[va]);
                let off = sign * stride[a];
                for s in 0..CHUNK[a] {
                    let mut count = 0;
                    for v in 0..nv {
                        for u in 0..nu {
                            let mut l = [0usize; 3];
                            l[a] = s;
                            l[ua] = u;
                            l[va] = v;
                            let pi = (((l[1] + 1) * PZ + l[2] + 1) * PX + l[0] + 1) as isize;
                            let m = v * nu + u;
                            let t = self.pad[pi as usize];
                            let ni = pi + off;
                            if t == 0 || t == BEDROCK || self.pad[ni as usize] != 0 {
                                self.mask[m] = 0;
                                continue;
                            }
                            count += 1;
                            if !use_ao || (self.flat >> t) & 1 != 0 {
                                self.mask[m] = t as u16;
                                continue;
                            }
                            let pad = &self.pad;
                            let occ = |i: isize| (pad[i as usize] != 0) as u8;
                            let lvl = |s1: u8, s2: u8, c: u8| if s1 == 1 && s2 == 1 { 3 } else { s1 + s2 + c };
                            let (um, up, vm, vp) = (occ(ni - su), occ(ni + su), occ(ni - sv), occ(ni + sv));
                            let l0 = lvl(um, vm, occ(ni - su - sv));
                            let l1 = lvl(up, vm, occ(ni + su - sv));
                            let l2 = lvl(up, vp, occ(ni + su + sv));
                            let l3 = lvl(um, vp, occ(ni - su + sv));
                            self.mask[m] = t as u16 | ((l0 | l1 << 2 | l2 << 4 | l3 << 6) as u16) << 8;
                        }
                    }
                    if count == 0 {
                        continue;
                    }
                    for v in 0..nv {
                        let mut u = 0;
                        while u < nu {
                            let key = self.mask[v * nu + u];
                            if key == 0 {
                                u += 1;
                                continue;
                            }
                            let t = (key & 0xff) as u8;
                            let ao = (key >> 8) as u8;
                            let lv = [ao & 3, (ao >> 2) & 3, (ao >> 4) & 3, (ao >> 6) & 3];
                            // light constant along u: corners 0 = 1 and 3 = 2; along v: 0 = 3 and 1 = 2
                            let along_u = lv[0] == lv[1] && lv[3] == lv[2];
                            let along_v = lv[0] == lv[3] && lv[1] == lv[2];
                            let mut w = 1;
                            if along_u {
                                while u + w < nu && self.mask[v * nu + u + w] == key {
                                    w += 1;
                                }
                            }
                            let mut h = 1;
                            if along_v {
                                'rows: while v + h < nv {
                                    for k in 0..w {
                                        if self.mask[(v + h) * nu + u + k] != key {
                                            break 'rows;
                                        }
                                    }
                                    h += 1;
                                }
                            }
                            for r in 0..h {
                                for k in 0..w {
                                    self.mask[(v + r) * nu + u + k] = 0;
                                }
                            }
                            self.quad(tile, &mut min, &mut max, base, dir, s, u, v, w, h, t, lv);
                            u += w;
                        }
                    }
                }
            }
            tile.faces[6] = tile.idx.len() as u32;
        }
        if tile.verts.is_empty() {
            tile.min = Vec3::ZERO;
            tile.max = Vec3::ZERO;
        } else {
            tile.min = min;
            tile.max = max;
        }
        self.revision = self.revision.wrapping_add(1);
        tile.revision = self.revision;
    }

    /// One quad of `w` x `h` faces in direction `dir` on slice `s`.
    #[allow(clippy::too_many_arguments)]
    fn quad(&self, tile: &mut Batch, min: &mut Vec3, max: &mut Vec3, base: [i32; 3], dir: usize, s: usize, u: usize, v: usize, w: usize, h: usize, t: u8, lv: [u8; 4]) {
        if tile.verts.len() + 4 > u16::MAX as usize {
            return;
        }
        let a = dir / 2;
        let positive = dir % 2 == 0;
        let ua = (a + 1) % 3;
        let va = (a + 2) % 3;
        let plane = s + positive as usize;
        let mut n = [0.0f32; 3];
        n[a] = if positive { 1.0 } else { -1.0 };
        let nb = pack_normal(v3(n[0], n[1], n[2]), 0);
        let c = self.palette[t as usize & (TYPES - 1)];
        let glow = (crate::fmath::clampf(c[3], 0.0, 1.0) * 255.0 + 0.5) as u8;
        let corners = [(u, v), (u + w, v), (u + w, v + h), (u, v + h)];
        let order: [usize; 4] = if positive { [0, 1, 2, 3] } else { [0, 3, 2, 1] };
        let first = tile.verts.len() as u16;
        let mut lq = [0u8; 4];
        for (k, &ci) in order.iter().enumerate() {
            let (cu, cv) = corners[ci];
            let mut p = [0.0f32; 3];
            p[a] = (base[a] + plane as i32) as f32;
            p[ua] = (base[ua] + cu as i32) as f32;
            p[va] = (base[va] + cv as i32) as f32;
            let level = lv[ci] as usize;
            lq[k] = lv[ci];
            let light = self.shade[dir] * (1.0 - self.ao * (1.0 - AO_LINEAR[level.min(3)]));
            // vertex colours are sRGB under a gamma-2 shader: light scales by its root
            let k_srgb = crate::fmath::sqrtf(crate::fmath::maxf(light, 0.0));
            let q = |x: f32| (crate::fmath::clampf(x * k_srgb, 0.0, 1.0) * 255.0 + 0.5) as u8;
            let pos = v3(p[0], p[1], p[2]);
            *min = v3(crate::fmath::minf(min.x, pos.x), crate::fmath::minf(min.y, pos.y), crate::fmath::minf(min.z, pos.z));
            *max = v3(crate::fmath::maxf(max.x, pos.x), crate::fmath::maxf(max.y, pos.y), crate::fmath::maxf(max.z, pos.z));
            tile.verts.push(GpuVertex { pos: p, nb, rgba: [q(c[0]), q(c[1]), q(c[2]), glow] });
        }
        // split along the diagonal between the brighter corners
        if lq[0] + lq[2] > lq[1] + lq[3] {
            tile.idx.extend_from_slice(&[first, first + 1, first + 3, first + 1, first + 2, first + 3]);
        } else {
            tile.idx.extend_from_slice(&[first, first + 1, first + 2, first, first + 2, first + 3]);
        }
    }

    /// Rebuild up to `limit` dirty chunks; the count rebuilt.
    pub fn rebuild(&mut self, scene: &mut Scene, limit: usize) -> usize {
        if !self.active || self.dirty_count == 0 {
            return 0;
        }
        let base = self.tile_base;
        if base + self.dirty.len() > scene.ground.len() {
            // the ground list was replaced under the module (play.ground/terrain)
            return 0;
        }
        let mut done = 0;
        for ci in 0..self.dirty.len() {
            if done >= limit {
                break;
            }
            if !self.dirty[ci] {
                continue;
            }
            self.dirty[ci] = false;
            self.dirty_count -= 1;
            let mut tile = core::mem::take(&mut scene.ground[base + ci]);
            self.mesh(ci, &mut tile);
            scene.ground[base + ci] = tile;
            done += 1;
        }
        done
    }

    pub fn step(&mut self, w: &mut World, scene: &mut Scene, _dt: f32) {
        if !self.active {
            return;
        }
        self.collide_bodies(w);
        self.rebuilt_last_step = self.rebuild(scene, self.budget);
    }

    fn mark_all(&mut self) {
        for ci in 0..self.dirty.len() {
            self.mark(ci);
        }
    }

    pub fn call(&mut self, w: &mut World, scene: &mut Scene, op: u32, a: &[f32], out: &mut [f32]) -> f32 {
        let i = |k: usize| ifloor(arg(a, k));
        if op != op::INIT && !self.active {
            return -1.0;
        }
        match op {
            op::INIT => self.init(scene, i(0).max(1) as usize, i(1).max(1) as usize, i(2).max(1) as usize, [i(3), i(4), i(5)]) as f32,
            op::PALETTE => {
                let t = i(0);
                if (1..TYPES as i32).contains(&t) {
                    self.palette[t as usize] = [arg(a, 1), arg(a, 2), arg(a, 3), arg(a, 4)];
                    // a sixth argument of 1: this type's faces skip corner occlusion
                    if arg(a, 5) > 0.5 {
                        self.flat |= 1 << t;
                    } else {
                        self.flat &= !(1 << t);
                    }
                    // colours show at the next rebuild of every chunk
                    self.mark_all();
                }
                0.0
            }
            op::SHADE => {
                for k in 0..6 {
                    if a.len() > k {
                        self.shade[k] = a[k];
                    }
                }
                if a.len() > 6 {
                    self.ao = crate::fmath::clampf(a[6], 0.0, 1.0);
                }
                self.mark_all();
                0.0
            }
            op::GET => match self.index(i(0), i(1), i(2)) {
                Some(k) => self.blocks[k] as f32,
                None => -1.0,
            },
            op::SET => self.set(i(0), i(1), i(2), (i(3).clamp(0, TYPES as i32 - 1)) as u8) as f32,
            op::SET_LIST => {
                let mut n = 0;
                for r in a.chunks_exact(4) {
                    let t = (ifloor(r[3]).clamp(0, TYPES as i32 - 1)) as u8;
                    let old = self.set(ifloor(r[0]), ifloor(r[1]), ifloor(r[2]), t);
                    if old >= 0 && old as u8 != t {
                        n += 1;
                    }
                }
                n as f32
            }
            op::FILL => {
                let (x0, x1) = (i(0).min(i(3)), i(0).max(i(3)));
                let (y0, y1) = (i(1).min(i(4)), i(1).max(i(4)));
                let (z0, z1) = (i(2).min(i(5)), i(2).max(i(5)));
                let t = (i(6).clamp(0, TYPES as i32 - 1)) as u8;
                let mut n = 0;
                for y in y0..=y1 {
                    for z in z0..=z1 {
                        for x in x0..=x1 {
                            let old = self.set(x, y, z, t);
                            if old >= 0 && old as u8 != t {
                                n += 1;
                            }
                        }
                    }
                }
                n as f32
            }
            op::COLUMNS => {
                let (x0, z0) = (i(0), i(1));
                let (cw, cd) = (i(2).max(0) as usize, i(3).max(0) as usize);
                let (bottom, top, depth) = (i(4).clamp(0, 15) as u8, i(5).clamp(0, 15) as u8, i(6));
                let heights = if a.len() > 7 { &a[7..] } else { &[][..] };
                let floor = self.origin[1];
                let mut n = 0;
                for j in 0..cd {
                    for k in 0..cw {
                        let Some(&hv) = heights.get(j * cw + k) else { break };
                        let h = ifloor(hv);
                        let (x, z) = (x0 + k as i32, z0 + j as i32);
                        let mut y = floor;
                        while y <= h {
                            if let Some(bi) = self.index(x, y, z) {
                                self.blocks[bi] = if y > h - depth { top } else { bottom };
                                n += 1;
                            }
                            y += 1;
                        }
                    }
                }
                // the chunks under the area, and their edge neighbours
                if cw > 0 && cd > 0 {
                    let lo = [x0 - 1 - self.origin[0], z0 - 1 - self.origin[2]];
                    let hi = [x0 + cw as i32 - self.origin[0], z0 + cd as i32 - self.origin[2]];
                    let cx0 = (lo[0].max(0) as usize) / CHUNK[0];
                    let cz0 = (lo[1].max(0) as usize) / CHUNK[2];
                    let cx1 = ((hi[0].max(0) as usize) / CHUNK[0]).min(self.chunks[0] - 1);
                    let cz1 = ((hi[1].max(0) as usize) / CHUNK[2]).min(self.chunks[2] - 1);
                    for cy in 0..self.chunks[1] {
                        for cz in cz0..=cz1 {
                            for cx in cx0..=cx1 {
                                let ci = self.chunk_index(cx, cy, cz);
                                self.mark(ci);
                            }
                        }
                    }
                }
                n as f32
            }
            op::HEIGHT => self.height(i(0), i(1)) as f32,
            op::RAYCAST => {
                let o = v3(arg(a, 0), arg(a, 1), arg(a, 2));
                let d = v3(arg(a, 3), arg(a, 4), arg(a, 5));
                match self.raycast(o, d, arg(a, 6)) {
                    Some((t, b, n, dist)) => {
                        let vals = [b[0] as f32, b[1] as f32, b[2] as f32, n[0] as f32, n[1] as f32, n[2] as f32, dist];
                        for (k, v) in vals.iter().enumerate() {
                            if k < out.len() {
                                out[k] = *v;
                            }
                        }
                        t as f32
                    }
                    None => 0.0,
                }
            }
            op::BODY => {
                let slot = i(0);
                let radius = arg(a, 1);
                self.bodies.retain(|b| b.slot != slot);
                if radius > 0.0 && slot >= 0 && (slot as usize) < w.cap {
                    let p = w.pos(slot as usize);
                    self.bodies.push(Body { slot, radius, height: arg(a, 2), max_fall: arg(a, 3), prev: p, fresh: false });
                }
                self.bodies.len() as f32
            }
            op::BUILD => {
                let n = self.dirty.len();
                self.rebuild(scene, n) as f32
            }
            op::BUDGET => {
                self.budget = i(0).max(1) as usize;
                0.0
            }
            op::SNAPSHOT => {
                self.snapshot.clear();
                self.snapshot.extend_from_slice(&self.blocks);
                0.0
            }
            op::RESTORE => {
                if self.snapshot.len() != self.blocks.len() {
                    return -1.0;
                }
                let before = self.dirty_count;
                let (sx, sz) = (self.size[0], self.size[2]);
                for k in 0..self.blocks.len() {
                    if self.blocks[k] != self.snapshot[k] {
                        self.blocks[k] = self.snapshot[k];
                        let x = (k % sx) as i32 + self.origin[0];
                        let z = ((k / sx) % sz) as i32 + self.origin[2];
                        let y = (k / (sx * sz)) as i32 + self.origin[1];
                        self.touch(x, y, z);
                    }
                }
                (self.dirty_count - before) as f32
            }
            op::STATS => {
                let mut faces = 0usize;
                let mut verts = 0usize;
                let end = (self.tile_base + self.dirty.len()).min(scene.ground.len());
                for t in &scene.ground[self.tile_base.min(end)..end] {
                    faces += t.idx.len() / 6;
                    verts += t.verts.len();
                }
                let vals = [faces as f32, verts as f32, self.dirty_count as f32, self.rebuilt_last_step as f32];
                for (k, v) in vals.iter().enumerate() {
                    if k < out.len() {
                        out[k] = *v;
                    }
                }
                faces as f32
            }
            op::COUNT => {
                let t = i(0);
                self.blocks.iter().filter(|&&b| b as i32 == t).count() as f32
            }
            _ => -1.0,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Playset;

    fn world(ps: &mut Playset, sx: f32, sy: f32, sz: f32, o: [f32; 3]) {
        let n = ps.modules.voxel.call(&mut ps.world, &mut ps.scene, op::INIT, &[sx, sy, sz, o[0], o[1], o[2]], &mut []);
        assert!(n > 0.0);
    }

    fn call(ps: &mut Playset, o: u32, a: &[f32]) -> f32 {
        ps.modules.voxel.call(&mut ps.world, &mut ps.scene, o, a, &mut [])
    }

    fn tiles(ps: &Playset) -> (usize, usize) {
        let v = &ps.modules.voxel;
        let ts = &ps.scene.ground[v.tile_base..v.tile_base + v.dirty.len()];
        (ts.iter().map(|t| t.idx.len() / 6).sum(), ts.iter().map(|t| t.verts.len()).sum())
    }

    #[test]
    fn one_block_is_six_faces_and_two_merge() {
        let mut ps = Playset::new(32, 16);
        world(&mut ps, 32.0, 16.0, 32.0, [-16.0, 0.0, -16.0]);
        call(&mut ps, op::SET, &[2.0, 4.0, 3.0, 1.0]);
        call(&mut ps, op::BUILD, &[]);
        assert_eq!(tiles(&ps), (6, 24), "a lone block: six faces of four shared vertices");
        // a neighbour on +x: the shared faces vanish and the even faces merge
        call(&mut ps, op::SET, &[3.0, 4.0, 3.0, 1.0]);
        call(&mut ps, op::BUILD, &[]);
        assert_eq!(tiles(&ps).0, 6, "two blocks in a row read as one box");
        // a different type next to it does not merge
        call(&mut ps, op::SET, &[4.0, 4.0, 3.0, 2.0]);
        call(&mut ps, op::BUILD, &[]);
        assert_eq!(tiles(&ps).0, 10);
    }

    #[test]
    fn faces_turned_away_are_not_drawn() {
        use crate::schema::{camera as C, camera_mode as CM};
        let mut ps = Playset::new(32, 16);
        world(&mut ps, 16.0, 16.0, 16.0, [0.0, 0.0, 0.0]);
        call(&mut ps, op::SET, &[2.0, 2.0, 2.0, 1.0]);
        call(&mut ps, op::BUILD, &[]);
        // the eye on the +x side, level with the block: its -x face is turned away
        let mut d = [0.0f32; 24];
        d[C::MODE] = CM::FIXED as f32;
        d[C::TARGET] = -1.0;
        d[C::FOV] = 60.0;
        d[C::NEAR] = 0.1;
        d[C::FAR] = 100.0;
        d[C::EX] = 12.0;
        d[C::EY] = 2.5;
        d[C::EZ] = 2.5;
        d[C::LX] = 2.5;
        d[C::LY] = 2.5;
        d[C::LZ] = 2.5;
        ps.rig.set(&d);
        ps.step(1.0 / 60.0);
        ps.prepare(400.0 / 240.0);
        assert_eq!(ps.render.frame.tris, 10, "five of six faces");
        // from above and beyond the corner (+x, +y, +z): three faces
        d[C::EX] = 9.0;
        d[C::EY] = 9.0;
        d[C::EZ] = 9.0;
        ps.rig.set(&d);
        ps.step(1.0 / 60.0);
        ps.prepare(400.0 / 240.0);
        assert_eq!(ps.render.frame.tris, 6);
        assert!(ps.render.frame.draw_count <= 2, "the kept groups share draws");
    }

    #[test]
    fn faces_wind_outward() {
        let mut ps = Playset::new(32, 16);
        world(&mut ps, 16.0, 16.0, 16.0, [0.0, 0.0, 0.0]);
        call(&mut ps, op::SET, &[5.0, 5.0, 5.0, 1.0]);
        call(&mut ps, op::BUILD, &[]);
        let t = &ps.scene.ground[ps.modules.voxel.tile_base];
        let c = v3(5.5, 5.5, 5.5);
        for tri in t.idx.chunks_exact(3) {
            let p = |i: u16| {
                let v = t.verts[i as usize].pos;
                v3(v[0], v[1], v[2])
            };
            let (a, b, d) = (p(tri[0]), p(tri[1]), p(tri[2]));
            let n = (b - a).cross(d - a);
            let mid = (a + b + d) * (1.0 / 3.0);
            assert!(n.dot(mid - c) > 0.0, "counter-clockwise seen from outside");
        }
    }

    #[test]
    fn an_edit_rebuilds_only_its_chunks() {
        let mut ps = Playset::new(32, 16);
        world(&mut ps, 64.0, 16.0, 64.0, [0.0, 0.0, 0.0]);
        let heights = vec![4.0f32; 64 * 64];
        let mut a = vec![0.0, 0.0, 64.0, 64.0, 2.0, 1.0, 2.0];
        a.extend_from_slice(&heights);
        assert_eq!(call(&mut ps, op::COLUMNS, &a), (64 * 64 * 5) as f32);
        call(&mut ps, op::BUILD, &[]);
        let revs: Vec<u32> = ps.scene.ground.iter().map(|t| t.revision).collect();
        // inside one chunk: one tile
        call(&mut ps, op::SET, &[20.0, 4.0, 20.0, 0.0]);
        assert_eq!(ps.modules.voxel.dirty_count, 1);
        ps.step(1.0 / 60.0);
        let changed = ps.scene.ground.iter().zip(revs.iter()).filter(|(t, r)| t.revision != **r).count();
        assert_eq!(changed, 1);
        // a block on a chunk corner touches four columns of chunks
        call(&mut ps, op::SET, &[16.0, 4.0, 16.0, 0.0]);
        assert_eq!(ps.modules.voxel.dirty_count, 4);
        assert_eq!(call(&mut ps, op::HEIGHT, &[16.0, 16.0]), 4.0);
        assert_eq!(call(&mut ps, op::HEIGHT, &[17.0, 16.0]), 5.0);
    }

    #[test]
    fn raycast_finds_the_face() {
        let mut ps = Playset::new(32, 16);
        world(&mut ps, 32.0, 16.0, 32.0, [-16.0, 0.0, -16.0]);
        call(&mut ps, op::SET, &[0.0, 2.0, -5.0, 3.0]);
        let mut out = [0.0f32; 7];
        let t = ps.modules.voxel.call(&mut ps.world, &mut ps.scene, op::RAYCAST, &[0.5, 2.5, 0.5, 0.0, 0.0, -1.0, 8.0], &mut out);
        assert_eq!(t, 3.0);
        assert_eq!(&out[..6], &[0.0, 2.0, -5.0, 0.0, 0.0, 1.0]);
        assert!((out[6] - 4.5).abs() < 1e-4);
        // out of reach
        let t = ps.modules.voxel.call(&mut ps.world, &mut ps.scene, op::RAYCAST, &[0.5, 2.5, 0.5, 0.0, 0.0, -1.0, 4.0], &mut out);
        assert_eq!(t, 0.0);
        // from above, onto the top face
        let t = ps.modules.voxel.call(&mut ps.world, &mut ps.scene, op::RAYCAST, &[0.5, 9.0, -4.5, 0.0, -1.0, 0.0, 20.0], &mut out);
        assert_eq!(t, 3.0);
        assert_eq!(&out[3..6], &[0.0, 1.0, 0.0]);
    }

    #[test]
    fn a_body_lands_walks_into_a_wall_and_climbs_a_step() {
        use crate::schema::{arch as A, motion as M};
        let mut ps = Playset::new(32, 16);
        world(&mut ps, 32.0, 16.0, 32.0, [-16.0, 0.0, -16.0]);
        call(&mut ps, op::FILL, &[-16.0, 0.0, -16.0, 15.0, 3.0, 15.0, 1.0]);
        // a wall at x = 3
        call(&mut ps, op::FILL, &[3.0, 4.0, -16.0, 3.0, 8.0, 15.0, 2.0]);
        let mut d = vec![0.0f32; crate::schema::ARCH_LENGTH];
        d[A::MOTION] = M::NONE as f32;
        let arch = ps.world.add_arch(&d) as usize;
        let s = ps.world.spawn(&ps.scene, arch, v3(0.5, 7.0, 0.5), 0.0) as usize;
        call(&mut ps, op::BODY, &[s as f32, 0.34, 1.78, 28.0]);
        for _ in 0..90 {
            // the guest's gravity, as the port applies it
            let vy = ps.world.e(s, E::VY) - 22.0 / 60.0;
            ps.world.set(s, E::VY, vy);
            ps.step(1.0 / 60.0);
        }
        assert!((ps.world.pos(s).y - 4.0).abs() < 0.05, "stands on the floor: {}", ps.world.pos(s).y);
        assert!(ps.world.state(s) & ST::GROUNDED != 0);
        for _ in 0..120 {
            ps.world.set(s, E::VX, 5.0);
            let vy = ps.world.e(s, E::VY) - 22.0 / 60.0;
            ps.world.set(s, E::VY, vy);
            ps.step(1.0 / 60.0);
        }
        let x = ps.world.pos(s).x;
        assert!(x < 3.0 - 0.33 && x > 2.5, "stopped by the wall at {x}");
        // a one-block step on -x, climbed with a jump
        call(&mut ps, op::FILL, &[-3.0, 4.0, -16.0, -3.0, 4.0, 15.0, 2.0]);
        let mut top = 0.0f32;
        for f in 0..120 {
            ps.world.set(s, E::VX, -5.0);
            let grounded = ps.world.state(s) & ST::GROUNDED != 0;
            let mut vy = ps.world.e(s, E::VY) - 22.0 / 60.0;
            if f % 30 == 0 && grounded {
                vy = 7.1;
            }
            ps.world.set(s, E::VY, vy);
            ps.step(1.0 / 60.0);
            top = top.max(ps.world.pos(s).y);
        }
        assert!(ps.world.pos(s).x < -3.0, "crossed the step: {}", ps.world.pos(s).x);
        assert!(top > 5.0);
    }

    #[test]
    fn restore_brings_back_the_snapshot() {
        let mut ps = Playset::new(32, 16);
        world(&mut ps, 32.0, 16.0, 32.0, [0.0, 0.0, 0.0]);
        call(&mut ps, op::FILL, &[0.0, 0.0, 0.0, 31.0, 2.0, 31.0, 1.0]);
        call(&mut ps, op::SNAPSHOT, &[]);
        call(&mut ps, op::BUILD, &[]);
        call(&mut ps, op::SET, &[5.0, 2.0, 5.0, 0.0]);
        call(&mut ps, op::SET, &[6.0, 3.0, 5.0, 4.0]);
        call(&mut ps, op::BUILD, &[]);
        assert!(call(&mut ps, op::RESTORE, &[]) >= 1.0);
        assert_eq!(call(&mut ps, op::GET, &[5.0, 2.0, 5.0]), 1.0);
        assert_eq!(call(&mut ps, op::GET, &[6.0, 3.0, 5.0]), 0.0);
        assert_eq!(call(&mut ps, op::COUNT, &[4.0]), 0.0);
    }
}
