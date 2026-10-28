//! Render preparation: the frame record a device renderer consumes.
//!
//! Culling, instance grouping, joint palettes, blob shadows, water and
//! particle billboards are computed here, so a renderer only binds buffers,
//! uploads `bones` rows and issues one indexed draw per record.

use crate::fmath::*;
use crate::geom::{pack_normal, GpuVertex};
use crate::model::PALETTE;
use crate::schema::{arch as A, arch_flag as AF, emitter as P, ent as E, node as N, state as ST};
use crate::vec::*;
use crate::Playset;
use alloc::vec::Vec;

pub const SOURCE_MODEL: u8 = 0;
pub const SOURCE_BATCH: u8 = 1;
pub const SOURCE_GROUND: u8 = 2;
pub const SOURCE_DYNAMIC: u8 = 3;

/// Draw flags.
pub const DRAW_CULL: u8 = 1;
/// Vertex alpha is opacity and lighting is off (particles, shadows).
pub const DRAW_VERTEX_ALPHA: u8 = 2;
pub const DRAW_DEPTH_WRITE: u8 = 4;

#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct Draw {
    pub source: u8,
    pub blend: u8,
    pub flags: u8,
    pub pad: u8,
    pub id: u16,
    pub bones: u16,
    pub bone_first: u32,
    pub index_first: u32,
    pub index_count: u32,
    pub opacity: f32,
}

/// One frame for a renderer. Pointers stay valid until the next prepare.
#[repr(C)]
pub struct Frame {
    /// world to view, 3x4 rows; the view looks down -Z
    pub view: [f32; 12],
    pub fov_y: f32,
    pub near: f32,
    pub far: f32,
    pub aspect: f32,
    pub sky_top: [f32; 4],
    pub sky_horizon: [f32; 4],
    pub sky_bottom: [f32; 4],
    /// start, 1 / (end - start), max fog, 0
    pub fog: [f32; 4],
    pub fog_color: [f32; 4],
    /// toward the sun, linear colours below
    pub sun_dir: [f32; 4],
    pub sun_color: [f32; 4],
    pub hemi_sky: [f32; 4],
    pub hemi_ground: [f32; 4],
    pub eye: [f32; 4],
    pub draws: *const Draw,
    pub draw_count: u32,
    /// 16 floats per matrix: three rows, then the tint
    pub bones: *const f32,
    pub bone_count: u32,
    pub dyn_verts: *const GpuVertex,
    pub dyn_vertex_count: u32,
    pub dyn_idx: *const u16,
    pub dyn_index_count: u32,
    pub tris: u32,
    pub culled: u32,
}

impl Default for Frame {
    fn default() -> Self {
        Frame {
            view: [0.0; 12],
            fov_y: 0.0,
            near: 0.0,
            far: 0.0,
            aspect: 0.0,
            sky_top: [0.0; 4],
            sky_horizon: [0.0; 4],
            sky_bottom: [0.0; 4],
            fog: [0.0; 4],
            fog_color: [0.0; 4],
            sun_dir: [0.0; 4],
            sun_color: [0.0; 4],
            hemi_sky: [0.0; 4],
            hemi_ground: [0.0; 4],
            eye: [0.0; 4],
            draws: core::ptr::null(),
            draw_count: 0,
            bones: core::ptr::null(),
            bone_count: 0,
            dyn_verts: core::ptr::null(),
            dyn_vertex_count: 0,
            dyn_idx: core::ptr::null(),
            dyn_index_count: 0,
            tris: 0,
            culled: 0,
        }
    }
}

#[derive(Default)]
pub struct Builder {
    pub frame: Frame,
    pub draws: Vec<Draw>,
    pub bones: Vec<f32>,
    pub dyn_verts: Vec<GpuVertex>,
    pub dyn_idx: Vec<u16>,
    items: Vec<Item>,
    transparent: Vec<(f32, Draw)>,
    /// the water grid's indices for (cells, first vertex): the same every
    /// frame while the grid is the first dynamic geometry
    water_idx: Vec<u16>,
    water_key: (usize, u16),
}

/// A blob shadow's rim: cos and sin of k * tau / 8.
const OCTAGON: [(f32, f32); 8] = [
    (1.0, 0.0),
    (core::f32::consts::FRAC_1_SQRT_2, core::f32::consts::FRAC_1_SQRT_2),
    (0.0, 1.0),
    (-core::f32::consts::FRAC_1_SQRT_2, core::f32::consts::FRAC_1_SQRT_2),
    (-1.0, 0.0),
    (-core::f32::consts::FRAC_1_SQRT_2, -core::f32::consts::FRAC_1_SQRT_2),
    (0.0, -1.0),
    (core::f32::consts::FRAC_1_SQRT_2, -core::f32::consts::FRAC_1_SQRT_2),
];

/// A visible instance: an entity slot or a dynamic node.
#[derive(Clone, Copy)]
struct Item {
    model: u16,
    /// slot when >= 0, else -(node + 1)
    who: i32,
    m: Mat34,
    dist: f32,
    tint: [f32; 4],
}

struct Cull {
    eye: Vec3,
    f: Vec3,
    r: Vec3,
    u: Vec3,
    tx: f32,
    ty: f32,
    kx: f32,
    ky: f32,
    near: f32,
    far: f32,
}

impl Cull {
    /// Forward distance when the sphere can be on screen.
    #[inline]
    fn sphere(&self, c: Vec3, rad: f32) -> Option<f32> {
        let d = c - self.eye;
        let z = d.dot(self.f);
        if z + rad < self.near || z - rad > self.far {
            return None;
        }
        let x = absf(d.dot(self.r));
        if x - rad * self.kx > z * self.tx {
            return None;
        }
        let y = absf(d.dot(self.u));
        if y - rad * self.ky > z * self.ty {
            return None;
        }
        Some(z)
    }
}

fn lin(c: Vec3, k: f32) -> [f32; 4] {
    [c.x * c.x * k, c.y * c.y * k, c.z * c.z * k, 0.0]
}

fn rgb4(c: Vec3) -> [f32; 4] {
    [c.x, c.y, c.z, 1.0]
}

const IDENTITY_BONE: [f32; 16] = [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 1.0, 1.0, 1.0, 1.0];

impl Builder {
    fn push_bone(&mut self, m: &Mat34, tint: [f32; 4]) {
        self.bones.extend_from_slice(&m.0);
        self.bones.extend_from_slice(&tint);
    }
}

/// Joint matrices for one instance into `out` (root first).
fn joint_palette(ps: &Playset, model: usize, slot: i32, out: &mut [Mat34; PALETTE]) -> usize {
    let md = &ps.scene.models[model];
    let n = md.joint_count();
    for o in out.iter_mut().take(n) {
        *o = Mat34::IDENTITY;
    }
    if slot < 0 || md.joints.is_empty() {
        return n;
    }
    let slot = slot as usize;
    let Some(arch) = ps.world.arch_of(slot) else { return n };
    let d = &ps.world.archs[arch];
    for (j, joint) in md.joints.iter().enumerate() {
        let mut local = Mat34::IDENTITY;
        for k in 0..4 {
            let base = A::JOINTS + k * 4;
            if d[base + 1] as u32 == 0 || d[base] as usize != j {
                continue;
            }
            let axis = match d[base + 2] as u32 {
                0 => v3(1.0, 0.0, 0.0),
                2 => v3(0.0, 0.0, 1.0),
                _ => Vec3::UP,
            };
            let angle = ps.world.s[slot].jangle[k];
            if d[base + 1] as u32 == crate::schema::joint_driver::BOB {
                let mut t = Mat34::IDENTITY;
                t.0[3] = axis.x * angle;
                t.0[7] = axis.y * angle;
                t.0[11] = axis.z * angle;
                local = local.mul(&t);
            } else {
                local = local.mul(&Mat34::rotation_about(axis, angle, joint.pivot));
            }
        }
        out[j] = if joint.parent >= 0 { out[joint.parent as usize].mul(&local) } else { local };
    }
    n
}

pub fn prepare(ps: &mut Playset, aspect: f32) -> *const Frame {
    let mut b = core::mem::take(&mut ps.render);
    b.draws.clear();
    b.bones.clear();
    b.dyn_verts.clear();
    b.dyn_idx.clear();
    b.items.clear();
    b.transparent.clear();
    b.bones.extend_from_slice(&IDENTITY_BONE);
    if ps.scene.batches_dirty {
        ps.scene.rebuild_batches();
    }
    let t = ps.world.time;
    let rig = &ps.rig;
    let (eye, f, u) = rig.basis(t);
    let r = f.cross(u).normalized();
    let ty = tanf(rig.fov * (PI / 360.0));
    let tx = ty * aspect;
    let cull = Cull { eye, f, r, u, tx, ty, kx: sqrtf(1.0 + tx * tx), ky: sqrtf(1.0 + ty * ty), near: rig.near, far: rig.far };
    let env = ps.scene.env;
    let fr = &mut b.frame;
    fr.view = [r.x, r.y, r.z, -r.dot(eye), u.x, u.y, u.z, -u.dot(eye), -f.x, -f.y, -f.z, f.dot(eye)];
    fr.fov_y = rig.fov;
    fr.near = rig.near;
    fr.far = rig.far;
    fr.aspect = aspect;
    fr.sky_top = rgb4(env.sky_top);
    fr.sky_horizon = rgb4(env.sky_horizon);
    fr.sky_bottom = rgb4(env.sky_bottom);
    let span = maxf(env.fog_end - env.fog_start, 0.01);
    fr.fog = [env.fog_start, 1.0 / span, clampf(env.fog_max, 0.0, 1.0), 0.0];
    fr.fog_color = rgb4(env.fog_color);
    let sd = env.sun_dir.normalized();
    fr.sun_dir = [sd.x, sd.y, sd.z, 0.0];
    fr.sun_color = lin(env.sun_color, 1.0);
    fr.hemi_sky = lin(env.hemi_sky, 1.0);
    fr.hemi_ground = lin(env.hemi_ground, 1.0);
    fr.eye = [eye.x, eye.y, eye.z, 1.0];
    let mut tris = 0u32;
    let mut culled = 0u32;
    // ground tiles and static batches
    for (list, source) in [(&ps.scene.ground, SOURCE_GROUND), (&ps.scene.batches, SOURCE_BATCH)] {
        for (i, bt) in list.iter().enumerate() {
            // an empty tile (a voxel chunk of air) is no draw
            if bt.idx.is_empty() {
                continue;
            }
            let c = (bt.min + bt.max) * 0.5;
            let rad = (bt.max - bt.min).len() * 0.5;
            if cull.sphere(c, rad).is_none() {
                culled += 1;
                continue;
            }
            let tile = |first: u32, count: u32| Draw {
                source,
                blend: 0,
                flags: DRAW_CULL | DRAW_DEPTH_WRITE,
                pad: 0,
                id: i as u16,
                bones: 1,
                bone_first: 0,
                index_first: first,
                index_count: count,
                opacity: 1.0,
            };
            let g = &bt.faces;
            if g[6] == 0 {
                tris += bt.idx.len() as u32 / 3;
                b.draws.push(tile(0, bt.idx.len() as u32));
                continue;
            }
            // axis-facing groups: a group whose every plane is behind the eye
            // is skipped, and neighbouring kept groups share one draw
            let facing = [eye.x > bt.min.x, eye.x < bt.max.x, eye.y > bt.min.y, eye.y < bt.max.y, eye.z > bt.min.z, eye.z < bt.max.z];
            let mut keep = [false; 6];
            for (k, &dir) in crate::scene::FACE_GROUPS.iter().enumerate() {
                keep[k] = facing[dir];
            }
            let mut d = 0;
            while d < 6 {
                if !keep[d] || g[d + 1] == g[d] {
                    d += 1;
                    continue;
                }
                let first = g[d];
                let mut end = g[d + 1];
                let mut e = d + 1;
                while e < 6 && (keep[e] || g[e + 1] == g[e]) {
                    end = g[e + 1];
                    e += 1;
                }
                tris += (end - first) / 3;
                b.draws.push(tile(first, end - first));
                d = e;
            }
        }
    }
    // entities
    let w = &ps.world;
    for &s in w.live.iter() {
        let s = s as usize;
        let st = w.state(s);
        if st & (ST::HIDDEN | ST::DEAD) != 0 {
            continue;
        }
        let Some(arch) = w.arch_of(s) else { continue };
        let d = &w.archs[arch];
        if d[A::FLAGS] as u32 & AF::NO_RENDER != 0 || d[A::MODEL] < 1.0 {
            continue;
        }
        let model = d[A::MODEL] as usize - 1;
        let Some(md) = ps.scene.models.get(model) else { continue };
        let scale = w.look[s * 4];
        let m = Mat34::from_ypr(w.pos(s), w.e(s, E::YAW), w.e(s, E::PITCH), w.e(s, E::ROLL), scale);
        let Some(dist) = cull.sphere(m.point(md.center), md.radius * absf(scale) * 1.15) else {
            culled += 1;
            continue;
        };
        let flash = w.s[s].flash;
        let fl = if flash > 0.0 && d[A::FLASH] > 0.0 { 1.0 + 2.5 * flash / d[A::FLASH] } else { 1.0 };
        let tint = [w.look[s * 4 + 1] * fl, w.look[s * 4 + 2] * fl, w.look[s * 4 + 3] * fl, 1.0];
        b.items.push(Item { model: model as u16, who: s as i32, m, dist, tint });
    }
    // dynamic nodes
    for (i, n) in ps.scene.nodes.iter().enumerate() {
        if !n.alive || n.flags & (N::STATIC | N::HIDDEN) != 0 {
            continue;
        }
        let Some(md) = ps.scene.models.get(n.model as usize) else { continue };
        let Some(dist) = cull.sphere(n.m.point(md.center), md.radius * n.m.max_scale()) else {
            culled += 1;
            continue;
        };
        b.items.push(Item { model: n.model as u16, who: -(i as i32) - 1, m: n.m, dist, tint: [1.0; 4] });
    }
    b.items.sort_by_key(|it| it.model);
    let mut palette = [Mat34::IDENTITY; PALETTE];
    let mut i = 0;
    while i < b.items.len() {
        let model = b.items[i].model as usize;
        let mut j = i;
        while j < b.items.len() && b.items[j].model as usize == model {
            j += 1;
        }
        let md = &ps.scene.models[model];
        let per = md.per_draw();
        let jc = md.joint_count();
        let mut k = i;
        while k < j {
            let end = (k + per).min(j);
            let n = end - k;
            let bone_first = (b.bones.len() / 16) as u32;
            let mut far = 0.0f32;
            for it in k..end {
                let item = b.items[it];
                far = maxf(far, item.dist);
                if jc > 1 || !md.joints.is_empty() {
                    let count = joint_palette(ps, model, item.who, &mut palette);
                    for p in palette.iter().take(count) {
                        let m = item.m.mul(p);
                        b.push_bone(&m, item.tint);
                    }
                } else {
                    b.push_bone(&item.m, item.tint);
                }
            }
            for pass in md.passes.iter() {
                let draw = Draw {
                    source: SOURCE_MODEL,
                    blend: pass.blend,
                    flags: if pass.blend == 0 { DRAW_CULL | DRAW_DEPTH_WRITE } else { DRAW_CULL },
                    pad: 0,
                    id: model as u16,
                    bones: (n * jc) as u16,
                    bone_first,
                    index_first: pass.first,
                    index_count: pass.count * n as u32,
                    opacity: pass.opacity,
                };
                tris += pass.count * n as u32 / 3;
                if pass.blend == 0 {
                    b.draws.push(draw);
                } else {
                    b.transparent.push((far, draw));
                }
            }
            k = end;
        }
        i = j;
    }
    // water: a lit grid around the eye
    let water = ps.scene.water;
    if water.active {
        let cells = water.cells.clamp(4, 40) as usize;
        let half = water.half;
        let step = half * 2.0 / cells as f32;
        // snap to the grid so the waves do not swim with the camera
        let ox = floorf(eye.x / step) * step;
        let oz = floorf(eye.z / step) * step;
        let base = b.dyn_verts.len() as u16;
        let first = b.dyn_idx.len() as u32;
        // Every value below is in range by construction (|h - level| <=
        // amplitude, a unit normal), so the loop has no float comparison:
        // on the ARM11 each one stalls to move the flags to the core.
        let inv_amp = 0.5 / maxf(water.amplitude, 0.01);
        let lo = water.deep * 255.0 + v3(0.5, 0.5, 0.5);
        let span = (water.color - water.deep) * 255.0;
        let verts = &mut b.dyn_verts;
        verts.reserve((cells + 1) * (cells + 1));
        water.grid(ox - half, oz - half, step, cells + 1, t, |_, px, pz, h, n| {
            let k = (h - water.level) * inv_amp + 0.5;
            let nb = [(n.x * 127.0) as i32 as i8, (n.y * 127.0) as i32 as i8, (n.z * 127.0) as i32 as i8, 0];
            let rgba = [(lo.x + span.x * k) as i32 as u8, (lo.y + span.y * k) as i32 as u8, (lo.z + span.z * k) as i32 as u8, 0];
            verts.push(GpuVertex { pos: [px, h, pz], nb, rgba });
        });
        if b.water_key != (cells, base) {
            b.water_idx.clear();
            let row = cells as u16 + 1;
            for z in 0..cells as u16 {
                for x in 0..cells as u16 {
                    let a = base + z * row + x;
                    let bb = a + 1;
                    let c = a + row;
                    let d = c + 1;
                    b.water_idx.extend_from_slice(&[a, c, d, a, d, bb]);
                }
            }
            b.water_key = (cells, base);
        }
        b.dyn_idx.extend_from_slice(&b.water_idx);
        let count = b.dyn_idx.len() as u32 - first;
        tris += count / 3;
        b.draws.push(Draw {
            source: SOURCE_DYNAMIC,
            blend: 0,
            flags: DRAW_DEPTH_WRITE,
            pad: 0,
            id: 0,
            bones: 1,
            bone_first: 0,
            index_first: first,
            index_count: count,
            opacity: 1.0,
        });
    }
    // blob shadows
    let first = b.dyn_idx.len() as u32;
    for &s in w.live.iter() {
        let s = s as usize;
        if w.state(s) & (ST::HIDDEN | ST::DEAD) != 0 {
            continue;
        }
        let Some(arch) = w.arch_of(s) else { continue };
        let sr = w.archs[arch][A::SHADOW];
        if sr <= 0.0 {
            continue;
        }
        let p = w.pos(s);
        let gy = if water.active { maxf(ps.scene.ground_height(p.x, p.z), water.height(p.x, p.z, t)) } else { ps.scene.ground_height(p.x, p.z) };
        let height = p.y - gy;
        let rad = sr * w.look[s * 4] / w.archs[arch][A::SCALE];
        if cull.sphere(v3(p.x, gy, p.z), rad).is_none() || b.dyn_verts.len() + 9 > 60_000 {
            continue;
        }
        let alpha = clampf(0.45 - height * 0.04, 0.0, 0.45);
        if alpha <= 0.01 {
            continue;
        }
        let base = b.dyn_verts.len() as u16;
        let up = pack_normal(Vec3::UP, 0);
        let y = gy + 0.04;
        b.dyn_verts.push(GpuVertex { pos: [p.x, y, p.z], nb: up, rgba: [0, 0, 0, (alpha * 255.0) as u8] });
        for (c, s) in OCTAGON {
            b.dyn_verts.push(GpuVertex { pos: [p.x + c * rad, y, p.z - s * rad], nb: up, rgba: [0, 0, 0, 0] });
        }
        for k in 0..8u16 {
            b.dyn_idx.extend_from_slice(&[base, base + 1 + k, base + 1 + (k + 1) % 8]);
        }
    }
    let count = b.dyn_idx.len() as u32 - first;
    if count > 0 {
        b.draws.push(Draw {
            source: SOURCE_DYNAMIC,
            blend: 1,
            flags: DRAW_VERTEX_ALPHA,
            pad: 0,
            id: 0,
            bones: 1,
            bone_first: 0,
            index_first: first,
            index_count: count,
            opacity: 1.0,
        });
    }
    // transparent instances, far to near
    b.transparent.sort_by(|a, c| c.0.partial_cmp(&a.0).unwrap_or(core::cmp::Ordering::Equal));
    for (_, d) in b.transparent.iter() {
        b.draws.push(*d);
    }
    // particles: alpha first, then additive. Colours lerp between the
    // emitter's ends and the u8 casts saturate: no clamp per channel.
    let facing = pack_normal(-f, 0);
    for blend in [1u8, 2u8] {
        let first = b.dyn_idx.len() as u32;
        for p in w.fx.pool.iter() {
            let e = &w.fx.emitters[p.emitter as usize];
            let pb = if e[P::BLEND] as u8 == 2 { 2 } else { 1 };
            if pb != blend || b.dyn_verts.len() + 4 > 64_000 {
                continue;
            }
            let k = 1.0 - p.life / maxf(p.max_life, 1e-3);
            let size = lerpf(e[P::SIZE], e[P::SIZE_END], k);
            if cull.sphere(p.pos, size).is_none() {
                continue;
            }
            let q = |v: f32| (v * 255.0 + 0.5) as u8;
            let col = [
                q(lerpf(e[P::R], e[P::R2], k)),
                q(lerpf(e[P::G], e[P::G2], k)),
                q(lerpf(e[P::B], e[P::B2], k)),
                q(lerpf(e[P::A], e[P::A2], k)),
            ];
            let rr = r * size;
            let uu = u * size;
            let nb = facing;
            let base = b.dyn_verts.len() as u16;
            for c in [p.pos - rr - uu, p.pos + rr - uu, p.pos + rr + uu, p.pos - rr + uu] {
                b.dyn_verts.push(GpuVertex { pos: [c.x, c.y, c.z], nb, rgba: col });
            }
            b.dyn_idx.extend_from_slice(&[base, base + 1, base + 2, base, base + 2, base + 3]);
        }
        let count = b.dyn_idx.len() as u32 - first;
        if count > 0 {
            tris += count / 3;
            b.draws.push(Draw {
                source: SOURCE_DYNAMIC,
                blend,
                flags: DRAW_VERTEX_ALPHA,
                pad: 0,
                id: 0,
                bones: 1,
                bone_first: 0,
                index_first: first,
                index_count: count,
                opacity: 1.0,
            });
        }
    }
    let fr = &mut b.frame;
    fr.draws = b.draws.as_ptr();
    fr.draw_count = b.draws.len() as u32;
    fr.bones = b.bones.as_ptr();
    fr.bone_count = (b.bones.len() / 16) as u32;
    fr.dyn_verts = b.dyn_verts.as_ptr();
    fr.dyn_vertex_count = b.dyn_verts.len() as u32;
    fr.dyn_idx = b.dyn_idx.as_ptr();
    fr.dyn_index_count = b.dyn_idx.len() as u32;
    fr.tris = tris;
    fr.culled = culled;
    ps.render = b;
    &ps.render.frame as *const Frame
}
