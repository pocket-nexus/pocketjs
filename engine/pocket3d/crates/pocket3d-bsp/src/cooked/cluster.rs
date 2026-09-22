//! Immutable spatial draw groups. A group can overdraw nearby faces but never
//! drops a face from a visible leaf. Its indices are assembled once at load.
use super::{CookedMap, bounds::RunBounds, strip::StripCache};
use alloc::vec::Vec;

pub struct Cluster {
    pub batch: u16,
    pub strip: bool,
    pub start: usize,
    pub count: usize,
    pub triangles: u32,
    pub faces: u32,
    pub bounds: RunBounds,
    pub visible: bool,
    always: bool,
}

pub struct ClusterCache {
    pub indices: Vec<u16>,
    pub groups: Vec<Cluster>,
    face_groups: Vec<u16>,
}

fn spatial_key(p: glam::Vec3) -> u64 {
    let xyz = [p.x, p.y, p.z].map(|v| (v as i32 + 32768).clamp(0, 65535) as u64);
    let mut key = 0;
    for bit in 0..16 {
        for (axis, coordinate) in xyz.iter().enumerate() {
            key |= ((coordinate >> bit) & 1) << (bit * 3 + axis);
        }
    }
    key
}

impl ClusterCache {
    pub fn new(
        map: &CookedMap<'_>,
        strips: Option<&StripCache>,
        bounds: &[RunBounds],
        entity_bounds: &[RunBounds],
    ) -> Option<Self> {
        const MAX_INDICES: usize = 512 * 1024; // one MiB, including connectors
        let count = map.faces.len() + map.always_runs.len();
        if count >= u16::MAX as usize {
            return None;
        }
        let mut order = Vec::new();
        order.try_reserve_exact(count).ok()?;
        let run = |i: usize| {
            if i < map.faces.len() {
                &map.faces[i]
            } else {
                &map.always_runs[i - map.faces.len()]
            }
        };
        let bound = |i: usize| {
            if i < bounds.len() {
                bounds[i]
            } else {
                entity_bounds[i - bounds.len()]
            }
        };
        let source = |i: usize| {
            if let Some(strip) = strips.and_then(|s| s.get(i)) {
                (true, strip)
            } else {
                let r = run(i);
                (
                    false,
                    &map.indices
                        [r.index_base as usize..r.index_base as usize + r.index_count as usize],
                )
            }
        };
        let mut needed = 0;
        for i in 0..count {
            if run(i).batch == u16::MAX {
                continue;
            }
            let b = bound(i);
            let (strip, src) = source(i);
            needed += src.len() + if strip { 2 } else { 0 };
            if needed > MAX_INDICES || src.len() > 32766 {
                return None;
            }
            order.push((
                run(i).batch,
                strip,
                b.orientation(),
                spatial_key(b.center()),
                i,
            ));
        }
        order.sort_unstable();
        let mut cache = Self {
            indices: Vec::new(),
            groups: Vec::new(),
            face_groups: Vec::new(),
        };
        cache.indices.try_reserve_exact(needed).ok()?;
        cache.groups.try_reserve_exact(count.min(4096)).ok()?;
        cache.face_groups.try_reserve_exact(count).ok()?;
        cache.face_groups.resize(count, u16::MAX);
        let mut last_orientation = 255;
        for (batch, strip, orientation, _, id) in order {
            let (_, src) = source(id);
            let new_group = cache.groups.last().is_none_or(|g| {
                g.batch != batch
                    || g.strip != strip
                    || g.always != (id >= map.faces.len())
                    || g.faces >= 8
                    || orientation != last_orientation
                    || g.bounds.center().distance_squared(bound(id).center()) > 256.0 * 256.0
                    || g.count + src.len() + 2 > 2048
            });
            if new_group {
                if cache.groups.len() >= 4096 {
                    return None;
                }
                last_orientation = orientation;
                cache.groups.push(Cluster {
                    batch,
                    strip,
                    start: cache.indices.len(),
                    count: 0,
                    triangles: 0,
                    faces: 0,
                    bounds: RunBounds::empty(),
                    visible: false,
                    always: false,
                });
            }
            let group_id = (cache.groups.len() - 1) as u16;
            let g = cache.groups.last_mut().unwrap();
            if g.count != 0 && strip {
                cache.indices.push(*cache.indices.last().unwrap());
                cache.indices.push(src[0]);
            }
            cache.indices.extend_from_slice(src);
            g.count = cache.indices.len() - g.start;
            g.triangles += run(id).index_count as u32 / 3;
            g.faces += 1;
            g.bounds.union(&bound(id));
            g.always |= id >= map.faces.len();
            cache.face_groups[id] = group_id;
        }
        Some(cache)
    }

    pub fn update_visibility(&mut self, visible_faces: &[u16]) {
        for g in &mut self.groups {
            g.visible = g.always;
        }
        for &face in visible_faces {
            let id = self.face_groups[face as usize];
            if id != u16::MAX {
                self.groups[id as usize].visible = true;
            }
        }
    }
}

#[cfg(all(test, feature = "std"))]
mod tests {
    use super::*;
    use crate::{
        cook::{CookOptions, cook_parsed},
        raw,
        types::*,
        wad::WadSet,
    };
    use alloc::vec;
    use glam::Vec3;
    fn fixture() -> Vec<u8> {
        let mut header = vec![0u8; 4 + 15 * 8];
        header[..4].copy_from_slice(&30i32.to_le_bytes());
        let mut bsp = raw::parse(&header).unwrap();
        bsp.planes.push(Plane {
            normal: Vec3::Y,
            dist: 0.0,
        });
        bsp.textures.push(raw::MipTexEntry {
            name: "fixture".into(),
            width: 16,
            height: 16,
            embedded: None,
        });
        bsp.texinfos.push(raw::TexInfo {
            s: Vec3::X,
            s_shift: 0.0,
            t: Vec3::Z,
            t_shift: 0.0,
            miptex: 0,
            flags: 0,
        });
        for i in 0..24 {
            let x = (i % 6) as f32 * 80.0;
            let z = (i / 6) as f32 * 80.0;
            let base = bsp.vertices.len() as u16;
            let edge = bsp.edges.len() as i32;
            let first_edge = bsp.surfedges.len() as u32;
            bsp.vertices.extend([
                Vec3::new(x, 0.0, z),
                Vec3::new(x + 64.0, 0.0, z),
                Vec3::new(x + 64.0, 0.0, z + 64.0),
                Vec3::new(x, 0.0, z + 64.0),
            ]);
            bsp.edges.extend([
                [base, base + 1],
                [base + 1, base + 2],
                [base + 2, base + 3],
                [base + 3, base],
            ]);
            bsp.surfedges.extend([edge, edge + 1, edge + 2, edge + 3]);
            bsp.faces.push(raw::Face {
                plane: 0,
                plane_side: 0,
                first_edge,
                num_edges: 4,
                texinfo: 0,
                styles: [255; 4],
                lightmap_offset: -1,
            });
        }
        bsp.leaves.push(Leaf {
            contents: -1,
            vis_offset: -1,
            mins: Vec3::ZERO,
            maxs: Vec3::splat(1000.0),
            first_marksurface: 0,
            num_marksurfaces: 0,
        });
        bsp.models.push(Model {
            mins: Vec3::ZERO,
            maxs: Vec3::splat(1000.0),
            origin: Vec3::ZERO,
            headnodes: [-1; 4],
            visleafs: 0,
            first_face: 0,
            num_faces: 24,
        });
        cook_parsed(
            &bsp,
            "clusters",
            &WadSet::new(),
            &CookOptions {
                subdivide: 16.0,
                allow_missing_textures: true,
            },
        )
        .unwrap()
        .0
    }
    fn triangle(mut vertices: [u16; 3]) -> [u16; 3] {
        vertices.sort_unstable();
        vertices
    }
    #[test]
    fn cached_draws_preserve_every_triangle_and_pvs_coverage() {
        let bytes = fixture();
        let map = super::super::read(&bytes).unwrap();
        let bounds: Vec<_> = map.faces.iter().map(|&r| RunBounds::new(&map, r)).collect();
        for use_strips in [false, true] {
            let strips = use_strips.then(|| StripCache::new(&map).unwrap());
            let mut cache = ClusterCache::new(&map, strips.as_ref(), &bounds, &[]).unwrap();
            let mut expected: Vec<_> = map
                .indices
                .chunks_exact(3)
                .map(|t| triangle([t[0], t[1], t[2]]))
                .collect();
            let mut actual = Vec::new();
            for g in &cache.groups {
                let indices = &cache.indices[g.start..g.start + g.count];
                if g.strip {
                    for t in indices.windows(3) {
                        if t[0] != t[1] && t[1] != t[2] && t[0] != t[2] {
                            actual.push(triangle([t[0], t[1], t[2]]));
                        }
                    }
                } else {
                    actual.extend(
                        indices
                            .chunks_exact(3)
                            .map(|t| triangle([t[0], t[1], t[2]])),
                    );
                }
            }
            expected.sort_unstable();
            actual.sort_unstable();
            assert_eq!(expected, actual);
            for face in 0..map.faces.len() {
                cache.update_visibility(&[face as u16]);
                assert!(cache.groups[cache.face_groups[face] as usize].visible);
                for (id, g) in cache.groups.iter().enumerate() {
                    assert_eq!(g.visible, id == cache.face_groups[face] as usize);
                }
            }
            cache.update_visibility(&[]);
            assert!(cache.groups.iter().all(|g| !g.visible));
        }
    }
    #[test]
    fn oversized_run_keeps_the_bounded_original_draw_path() {
        let bytes = fixture();
        let mut map = super::super::read(&bytes).unwrap();
        let indices = vec![0u16; 32769];
        map.indices = &indices;
        map.faces.truncate(1);
        map.faces[0].index_base = 0;
        map.faces[0].index_count = 32769;
        let bounds = [RunBounds::new(&map, map.faces[0])];
        assert!(ClusterCache::new(&map, None, &bounds, &[]).is_none());
    }
}
