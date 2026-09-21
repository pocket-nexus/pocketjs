//! Integration tests against real CS 1.6 maps. These only run when
//! POCKET3D_TEST_MAPS points at a directory containing maps/*.bsp and
//! support/*.wad (map data is copyrighted and not part of this repo).

use std::path::PathBuf;

use glam::Vec3;
use pocket3d_bsp::cook::{CookOptions, cook_map};
use pocket3d_bsp::vis::{Frustum, VisSet};
use pocket3d_bsp::{Hull, cooked, load_map};

fn maps_root() -> Option<PathBuf> {
    let root = PathBuf::from(std::env::var_os("POCKET3D_TEST_MAPS")?);
    root.exists().then_some(root)
}

#[test]
fn dust2_loads_and_traces() {
    let Some(root) = maps_root() else {
        eprintln!("POCKET3D_TEST_MAPS not set; skipping");
        return;
    };
    let map = load_map(&root.join("maps/de_dust2.bsp"), &[root.join("support")]).unwrap();

    // Geometry sanity.
    assert!(
        map.geometry.stats.triangles > 5_000,
        "{:?}",
        map.geometry.stats
    );
    assert!(map.geometry.batches.len() > 20);
    assert!(!map.geometry.lightmap_pages.is_empty());
    assert!(map.textures.len() > 20);
    let placeholders = map
        .textures
        .iter()
        .filter(|t| t.rgba.as_chunks::<4>().0.iter().next() == Some(&[200, 0, 200, 255]))
        .count();
    assert!(
        placeholders * 10 < map.textures.len(),
        "too many unresolved textures: {placeholders}/{}",
        map.textures.len()
    );

    // Spawns for both teams.
    assert!(!map.ct_spawns.is_empty(), "no CT spawns");
    assert!(!map.t_spawns.is_empty(), "no T spawns");

    // Collision: a standing hull at a CT spawn is in open space, and a
    // downward trace lands on ground within a short distance.
    let spawn = map.ct_spawns[0].pos;
    let contents = map.collision.hull_contents(Hull::Stand, spawn);
    assert_eq!(contents, -1, "spawn hull not in empty space: {contents}");
    let tr = map
        .collision
        .trace(Hull::Stand, spawn, spawn - Vec3::Y * 256.0);
    assert!(tr.fraction < 1.0, "no ground under CT spawn");
    assert!(tr.normal.y > 0.7, "ground normal {:?}", tr.normal);
    assert!(!tr.start_solid);

    // A very long horizontal trace must hit something (the map is sealed).
    let eye = tr.end + Vec3::Y * 28.0;
    let hit = map
        .collision
        .trace(Hull::Point, eye, eye + Vec3::X * 100_000.0);
    assert!(hit.fraction < 1.0, "escaped the map along +X");

    // Sun comes from light_environment.
    assert!(map.sun.is_some(), "dust2 should have light_environment");
}

#[test]
fn dust2_cooks_and_reads_back() {
    let Some(root) = maps_root() else {
        eprintln!("POCKET3D_TEST_MAPS not set; skipping");
        return;
    };
    let bsp_path = root.join("maps/de_dust2.bsp");
    let (bytes, stats) =
        cook_map(&bsp_path, &[root.join("support")], &CookOptions::default()).expect("cook failed");
    assert!(stats.triangles > 10_000, "{stats:?}");

    let map = cooked::read(&bytes).expect("cooked read failed");
    assert_eq!(map.name, "de_dust2");
    assert!(map.batches.len() > 20);
    assert_eq!(map.textures.len(), 44);
    assert!(map.vis.num_visleaves > 1_000);
    assert_eq!(map.ct_spawns.len(), 20);
    assert_eq!(map.t_spawns.len(), 20);
    assert!(map.sun.is_some());

    // Every texture decodes with plausible mips (pow2 dims for the GE, all
    // swizzled sizes as promised).
    for t in &map.textures {
        assert!(
            t.width.is_power_of_two() && t.height.is_power_of_two(),
            "{}: non-pow2 {}x{}",
            t.name,
            t.width,
            t.height
        );
        assert!(t.width <= 512 && t.height <= 512, "{}: too large", t.name);
        assert!(t.levels >= 2, "{}: only {} mips", t.name, t.levels);
        assert_eq!(t.palette.len(), 1024);
        for (l, m) in t.mips.iter().enumerate() {
            let expect =
                cooked::mip_stride(t.width, l as u32) * cooked::mip_rows(t.height, l as u32);
            assert_eq!(m.len(), expect, "{} mip {l}", t.name);
        }
    }

    // Vertex positions stay inside the map bounds (with grid slack).
    let (mins, maxs) = map.bounds;
    for v in map.verts.chunks_exact(cooked::VERTEX_STRIDE) {
        let x = i16::from_le_bytes([v[12], v[13]]) as f32;
        let y = i16::from_le_bytes([v[14], v[15]]) as f32;
        let z = i16::from_le_bytes([v[16], v[17]]) as f32;
        let p = Vec3::new(x, y, z);
        assert!(
            p.cmpge(mins - Vec3::splat(2.0)).all() && p.cmple(maxs + Vec3::splat(2.0)).all(),
            "vertex {p} outside bounds {mins}..{maxs}"
        );
    }

    // Cooked collision behaves like the runtime-parsed one.
    let desktop = load_map(&bsp_path, &[root.join("support")]).unwrap();
    let spawn = map.ct_spawns[0].pos;
    assert_eq!(map.collision.hull_contents(Hull::Stand, spawn), -1);
    let a = map
        .collision
        .trace(Hull::Stand, spawn, spawn - Vec3::Y * 256.0);
    let b = desktop
        .collision
        .trace(Hull::Stand, spawn, spawn - Vec3::Y * 256.0);
    assert!((a.fraction - b.fraction).abs() < 1e-6);
    assert_eq!(a.normal, b.normal);

    // PVS: from a spawn eye the visible face set is a real subset of the map.
    let eye = spawn + Vec3::Y * 28.0;
    let planes = map.collision.planes();
    let mut vs = VisSet::new(map.faces.len());
    vs.update(&map.vis, planes, eye);
    assert_ne!(vs.leaf(), 0, "spawn eye resolved to the outside leaf");
    // A generous frustum (everything in front of a straight-ahead camera).
    let view = glam::camera::rh::view::look_to_mat4(eye, Vec3::new(1.0, 0.0, 0.0), Vec3::Y);
    let proj = glam::camera::rh::proj::directx::perspective(2.0, 480.0 / 272.0, 4.0, 8192.0);
    let f = Frustum::from_clip(proj * view, true);
    let mut visible = 0usize;
    let mut spliced_indices = 0usize;
    vs.gather_faces(&map.vis, &f, |face| {
        let run = &map.faces[face as usize];
        if run.batch != 0xffff {
            visible += 1;
            spliced_indices += run.index_count as usize;
        }
    });
    assert!(visible > 50, "implausibly few visible faces: {visible}");
    assert!(
        visible < stats.faces_drawn / 2,
        "PVS+frustum culled nothing: {visible}/{}",
        stats.faces_drawn
    );
    assert!(spliced_indices.is_multiple_of(3) && spliced_indices > 0);

    // All marksurface-referenced faces resolve to valid runs or none.
    for &m in &map.vis.marksurfaces {
        let run = &map.faces[m as usize];
        if run.batch != 0xffff {
            let b = &map.batches[run.batch as usize];
            assert!(
                run.index_base >= b.index_base
                    && run.index_base + run.index_count as u32 <= b.index_base + b.index_count,
                "face run outside its batch"
            );
        }
    }
}

#[test]
fn all_maps_cook() {
    let Some(root) = maps_root() else {
        eprintln!("POCKET3D_TEST_MAPS not set; skipping");
        return;
    };
    let dir = root.join("maps");
    let mut checked = 0;
    for entry in std::fs::read_dir(&dir).unwrap().flatten() {
        let p = entry.path();
        if p.extension().and_then(|e| e.to_str()) != Some("bsp") {
            continue;
        }
        let (bytes, _) = cook_map(&p, &[root.join("support")], &CookOptions::default())
            .unwrap_or_else(|e| panic!("{}: cook failed: {e:#}", p.display()));
        let map = cooked::read(&bytes)
            .unwrap_or_else(|e| panic!("{}: cooked read failed: {e}", p.display()));
        assert!(map.vert_count > 1_000, "{}: too few verts", map.name);
        checked += 1;
    }
    assert!(checked >= 1, "no .bsp files found in {}", dir.display());
}

#[test]
fn all_maps_parse() {
    let Some(root) = maps_root() else {
        eprintln!("POCKET3D_TEST_MAPS not set; skipping");
        return;
    };
    let dir = root.join("maps");
    let mut checked = 0;
    for entry in std::fs::read_dir(&dir).unwrap().flatten() {
        let p = entry.path();
        if p.extension().and_then(|e| e.to_str()) != Some("bsp") {
            continue;
        }
        let map = load_map(&p, &[root.join("support")]).unwrap();
        assert!(
            map.geometry.stats.triangles > 1_000,
            "{}: too few tris",
            map.name
        );
        checked += 1;
    }
    assert!(checked >= 1, "no .bsp files found in {}", dir.display());
}
