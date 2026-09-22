//! Cooked-world rendering: PVS + frustum culling via `pocket3d_bsp::vis`,
//! then per-batch indexed draws over the `.p3d`'s in-place vertex data.

use alloc::vec::Vec;
use core::ffi::c_void;

use pocket3d_bsp::cooked::bounds::RunBounds;
use pocket3d_bsp::cooked::cluster::ClusterCache;
use pocket3d_bsp::cooked::strip::{StripCache, draw_chunks};
use pocket3d_bsp::cooked::{CookedMap, VERTEX_STRIDE};
use pocket3d_bsp::types::SurfaceKind;
use pocket3d_bsp::vis::VisSet;
use psp::sys::{self, AlphaFunc, GuPrimitive, GuState, VertexType};

use crate::camera::Camera3d;
use crate::pool::FramePool;
use crate::texture;

/// World vertex flags: `u,v: f32`, `color: u32`, `x,y,z: i16` (matches
/// `cooked::VERTEX_STRIDE`), drawn indexed.
const WORLD_VTYPE: VertexType = VertexType::from_bits_truncate(
    VertexType::TEXTURE_32BITF.bits()
        | VertexType::COLOR_8888.bits()
        | VertexType::VERTEX_16BIT.bits()
        | VertexType::INDEX_16BIT.bits()
        | VertexType::TRANSFORM_3D.bits(),
);

pub struct WorldRenderer<'a> {
    map: CookedMap<'a>,
    pub texture_memory_bytes: usize,
    pub geometry_memory_bytes: usize,
    cached_indices: Option<&'a [u16]>,
    vis: VisSet,
    /// Per-batch face IDs gathered this frame (entities follow world faces).
    runs: Vec<Vec<usize>>,
    strips: Option<StripCache>,
    clusters: Option<ClusterCache>,
    face_bounds: Vec<RunBounds>,
    entity_bounds: Vec<RunBounds>,
    /// Stats from the last `draw` (visible faces, triangles drawn).
    pub last_faces: u32,
    pub last_tris: u32,
    /// GE indices, including strip connectors and chunk overlap.
    pub last_indices: u32,
    pub last_visibility_us: u32,
    pub last_submission_us: u32,
}

impl<'a> WorldRenderer<'a> {
    pub fn new(map: CookedMap<'a>) -> Self {
        let mut runs = Vec::new();
        runs.resize_with(map.batches.len(), Vec::new);
        let vis = VisSet::new(map.faces.len());
        let face_bounds: Vec<_> = map
            .faces
            .iter()
            .map(|&run| RunBounds::new(&map, run))
            .collect();
        let entity_bounds: Vec<_> = map
            .always_runs
            .iter()
            .map(|&run| RunBounds::new(&map, run))
            .collect();
        let strips = StripCache::new(&map);
        let clusters = ClusterCache::new(&map, strips.as_ref(), &face_bounds, &entity_bounds);
        if let Some(cache) = &clusters {
            unsafe {
                sys::sceKernelDcacheWritebackRange(
                    cache.indices.as_ptr().cast(),
                    (cache.indices.len() * 2) as u32,
                );
            }
        }
        Self {
            texture_memory_bytes: 0,
            geometry_memory_bytes: 0,
            cached_indices: None,
            clusters,
            map,
            vis,
            runs,
            strips,
            face_bounds,
            entity_bounds,
            last_faces: 0,
            last_tris: 0,
            last_indices: 0,
            last_visibility_us: 0,
            last_submission_us: 0,
        }
    }

    /// Copy complete texture mip chains into caller-owned, bounded memory.
    /// On PSP this can be the composition's unused VRAM. Oversized textures
    /// continue using their original storage; no residency changes occur per frame.
    pub fn new_cached(mut map: CookedMap<'a>, storage: &'a mut [u8]) -> Self {
        let base = storage.as_ptr();
        let (used, mut memory) = pocket3d_bsp::cooked::texture_cache::relocate(&mut map, storage);
        let mut result = Self::new(map);
        result.texture_memory_bytes = used;
        // Static geometry can use the remainder as well. Keep main-memory
        // fallback for maps larger than VRAM; never replace only part of a buffer.
        let vertices = result.map.verts.len();
        let aligned = (vertices + 15) & !15;
        if vertices != 0 && memory.as_ptr().align_offset(16) == 0 && aligned <= memory.len() {
            let (dest, rest) = memory.split_at_mut(aligned);
            dest[..vertices].copy_from_slice(result.map.verts);
            result.map.verts = &dest[..vertices];
            result.geometry_memory_bytes += aligned;
            memory = rest;
        }
        if let Some(cache) = &result.clusters {
            let bytes = cache.indices.len() * 2;
            let aligned = (bytes + 15) & !15;
            if bytes != 0 && memory.as_ptr().align_offset(16) == 0 && aligned <= memory.len() {
                let (dest, _) = memory.split_at_mut(aligned);
                // The texture relocation API returns a 16-byte aligned tail.
                unsafe {
                    core::ptr::copy_nonoverlapping(
                        cache.indices.as_ptr().cast::<u8>(),
                        dest.as_mut_ptr(),
                        bytes,
                    );
                    result.cached_indices = Some(core::slice::from_raw_parts(
                        dest.as_ptr().cast::<u16>(),
                        cache.indices.len(),
                    ));
                }
                result.geometry_memory_bytes += aligned;
            }
        }
        let resident = used + result.geometry_memory_bytes;
        if resident != 0 {
            unsafe {
                sys::sceKernelDcacheWritebackRange(base.cast(), resident as u32);
            }
        }

        result
    }

    pub fn map(&self) -> &CookedMap<'a> {
        &self.map
    }

    /// Record the world into the open display list. The camera position
    /// drives PVS (use the eye position); state comes from `begin_3d`.
    pub unsafe fn draw(&mut self, pool: &mut FramePool, cam: &Camera3d) {
        let profile_start = profile_now();
        let map = &self.map;
        let frustum = cam.frustum();
        let changed = self.vis.update(&map.vis, map.collision.planes(), cam.pos);
        if let Some(cache) = &mut self.clusters {
            if changed {
                cache.update_visibility(self.vis.pvs_faces());
            }
            sys::sceGuSetMatrix(
                sys::MatrixMode::Model,
                &crate::to_psp_matrix(glam::Mat4::from_scale(glam::Vec3::splat(32768.0))),
            );
            let mut active_batch = u16::MAX;
            let mut alpha_test = false;
            let mut faces = 0;
            let mut tris = 0;
            let mut indices = 0;
            let index_data = self.cached_indices.unwrap_or(&cache.indices);
            for group in &cache.groups {
                let batch = &map.batches[group.batch as usize];
                if !group.visible
                    || (matches!(batch.kind, SurfaceKind::Opaque | SurfaceKind::AlphaTest)
                        && !group.bounds.facing(cam.pos))
                    || !group.bounds.visible(&frustum)
                {
                    continue;
                }
                if active_batch != group.batch {
                    active_batch = group.batch;
                    let want_alpha = batch.kind == SurfaceKind::AlphaTest;
                    if want_alpha != alpha_test {
                        if want_alpha {
                            sys::sceGuEnable(GuState::AlphaTest);
                            sys::sceGuAlphaFunc(AlphaFunc::Greater, 0x40, 0xff);
                        } else {
                            sys::sceGuDisable(GuState::AlphaTest);
                        }
                        alpha_test = want_alpha;
                    }
                    texture::bind(&map.textures[batch.texture as usize]);
                }
                sys::sceGuDrawArray(
                    if group.strip {
                        GuPrimitive::TriangleStrip
                    } else {
                        GuPrimitive::Triangles
                    },
                    WORLD_VTYPE,
                    group.count as i32,
                    index_data.as_ptr().add(group.start).cast(),
                    map.verts
                        .as_ptr()
                        .add(batch.vert_base as usize * VERTEX_STRIDE)
                        .cast(),
                );
                faces += group.faces;
                tris += group.triangles;
                indices += group.count as u32;
            }
            if alpha_test {
                sys::sceGuDisable(GuState::AlphaTest);
            }
            sys::sceGuSetMatrix(
                sys::MatrixMode::Model,
                &crate::to_psp_matrix(glam::Mat4::IDENTITY),
            );
            self.last_faces = faces;
            self.last_tris = tris;
            self.last_indices = indices;
            self.last_visibility_us = 0;
            self.last_submission_us = (profile_now() - profile_start) as u32;
            return;
        }

        for r in &mut self.runs {
            r.clear();
        }
        let runs = &mut self.runs;
        let mut faces = 0u32;
        let mut tris = 0u32;
        for &face in self.vis.pvs_faces() {
            let run = &map.faces[face as usize];
            if run.batch != 0xffff
                && (!matches!(
                    map.batches[run.batch as usize].kind,
                    SurfaceKind::Opaque | SurfaceKind::AlphaTest
                ) || self.face_bounds[face as usize].facing(cam.pos))
                && self.face_bounds[face as usize].visible(&frustum)
            {
                runs[run.batch as usize].push(face as usize);
                tris += run.index_count as u32 / 3;
                faces += 1;
            }
        }
        // Brush entities are outside the PVS, but still obey the camera frustum.
        for (i, (run, bounds)) in map.always_runs.iter().zip(&self.entity_bounds).enumerate() {
            if run.batch != 0xffff && bounds.visible(&frustum) {
                runs[run.batch as usize].push(map.faces.len() + i);
                tris += run.index_count as u32 / 3;
            }
        }

        let profile_visible = profile_now();
        // The GE normalizes 16-bit positions to [-1,1) in 3D mode (÷32768);
        // scale back up in the model matrix so i16 world units come out 1:1.
        sys::sceGuSetMatrix(
            sys::MatrixMode::Model,
            &crate::to_psp_matrix(glam::Mat4::from_scale(glam::Vec3::splat(32768.0))),
        );

        let mut indices = 0u32;
        let mut alpha_test = false;
        for (bi, batch) in map.batches.iter().enumerate() {
            let batch_runs = &runs[bi];
            if batch_runs.is_empty() {
                continue;
            }
            let want_alpha = batch.kind == SurfaceKind::AlphaTest;
            if want_alpha != alpha_test {
                if want_alpha {
                    sys::sceGuEnable(GuState::AlphaTest);
                    sys::sceGuAlphaFunc(AlphaFunc::Greater, 0x40, 0xff);
                } else {
                    sys::sceGuDisable(GuState::AlphaTest);
                }
                alpha_test = want_alpha;
            }
            texture::bind(&map.textures[batch.texture as usize]);

            let verts = map
                .verts
                .as_ptr()
                .add(batch.vert_base as usize * VERTEX_STRIDE);
            for strip in [false, true] {
                let source = |&id: &usize| -> Option<&[u16]> {
                    let cached = self.strips.as_ref().and_then(|cache| cache.get(id));
                    if strip {
                        return cached;
                    }
                    if cached.is_some() {
                        return None;
                    }
                    let run = if id < map.faces.len() {
                        &map.faces[id]
                    } else {
                        &map.always_runs[id - map.faces.len()]
                    };
                    Some(
                        &map.indices[run.index_base as usize
                            ..run.index_base as usize + run.index_count as usize],
                    )
                };
                let selected = || {
                    batch_runs
                        .iter()
                        .filter_map(source)
                        .filter(|s| !s.is_empty())
                };
                let (len, count) = selected().fold((0usize, 0usize), |(len, count), s| {
                    (len + s.len(), count + 1)
                });
                let total = len
                    + if strip {
                        count.saturating_sub(1) * 2
                    } else {
                        0
                    };
                if total == 0 {
                    continue;
                }
                let primitive = if strip {
                    GuPrimitive::TriangleStrip
                } else {
                    GuPrimitive::Triangles
                };
                if total <= 32766 {
                    // Ordinary frames retain one draw per primitive/material.
                    let dst = pool.alloc(total * 2) as *mut u16;
                    let mut off = 0;
                    for src in selected() {
                        if strip && off > 0 {
                            *dst.add(off) = *dst.add(off - 1);
                            *dst.add(off + 1) = src[0];
                            off += 2;
                        }
                        core::ptr::copy_nonoverlapping(src.as_ptr(), dst.add(off), src.len());
                        off += src.len();
                    }
                    draw_indices(primitive, dst, total, verts);
                    indices += total as u32;
                } else {
                    // A large material group must not exceed the frame pool's
                    // single-allocation limit. Each strip continues with two
                    // overlapping vertices; triangle lists split on triples.
                    for src in selected() {
                        for range in draw_chunks(src.len(), strip) {
                            let chunk = &src[range];
                            let dst = pool.alloc(chunk.len() * 2) as *mut u16;
                            core::ptr::copy_nonoverlapping(chunk.as_ptr(), dst, chunk.len());
                            draw_indices(primitive, dst, chunk.len(), verts);
                            indices += chunk.len() as u32;
                        }
                    }
                }
            }
        }
        if alpha_test {
            sys::sceGuDisable(GuState::AlphaTest);
        }
        sys::sceGuSetMatrix(
            sys::MatrixMode::Model,
            &crate::to_psp_matrix(glam::Mat4::IDENTITY),
        );
        self.last_faces = faces;
        self.last_tris = tris;
        self.last_indices = indices;
        self.last_visibility_us = (profile_visible - profile_start) as u32;
        self.last_submission_us = (profile_now() - profile_visible) as u32;
    }
}

unsafe fn draw_indices(
    primitive: GuPrimitive,
    indices: *const u16,
    count: usize,
    verts: *const u8,
) {
    sys::sceKernelDcacheWritebackRange(indices as *const c_void, (count * 2) as u32);
    sys::sceGuDrawArray(
        primitive,
        WORLD_VTYPE,
        count as i32,
        indices as *const c_void,
        verts as *const c_void,
    );
}

#[inline]
fn profile_now() -> u64 {
    #[cfg(feature = "profile")]
    {
        unsafe { sys::sceKernelGetSystemTimeWide() as u64 }
    }
    #[cfg(not(feature = "profile"))]
    {
        0
    }
}
