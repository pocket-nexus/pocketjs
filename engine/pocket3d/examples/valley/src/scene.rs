//! Assembly: the valley cooked into one `.p3sn`.
//!
//! The ground is a single grid laid out in river space — rows along the
//! current, columns fanning out from the centre line — so the shoreline is
//! resolved where it matters and the far slopes cost almost nothing, with no
//! seam anywhere because every row shares one column table.
//!
//! Vegetation is cooked at three densities against the same LOD bands the
//! runtime culls with: real trees near the camera's stretch of river, crossed
//! billboards through the middle distance, and tree-line cards beyond that.

use std::collections::BTreeMap;

use glam::Vec3;
use pocket3d_scene::build::{BuildError, Mesh, SceneBuilder};
use pocket3d_scene::cull::LOD_ALWAYS;
use pocket3d_scene::format::{
    Material, MaterialKind, MaterialRole, RiverSample, Scatter, ScatterKind, chunk_flags,
    material_flags,
};
use pocket3d_scene::light::{BakeInputs, FogModel, Lighting};
use pocket3d_scene::ride::DriftSettings;

use crate::flora;
use crate::geometry::Baker;
use crate::noise::{Rng, fbm};
use crate::structures::{self, StructureMeshes};
use crate::terrain::{Pad, Valley, WATER_LEVEL, smoothstep};
use crate::textures;

/// The drift these options cook for, which the runtime must ride.
pub fn drift(options: &ValleyOptions) -> DriftSettings {
    DriftSettings {
        near: options.drift_near,
        far: options.drift_far,
        ..DriftSettings::default()
    }
}

/// How the valley is cooked.
#[derive(Clone, Copy, Debug)]
pub struct ValleyOptions {
    pub seed: u32,
    /// Edge length of the tiling albedo maps. Cutouts use half of this.
    pub texture_size: u32,
    /// The corridor's near and far ends, in world z.
    pub corridor_near: f32,
    pub corridor_far: f32,
    /// The stretch of river the camera drifts along. Aerial perspective is
    /// baked from its midpoint, so the scene is honest over this span.
    pub drift_near: f32,
    pub drift_far: f32,
    /// Square metres of bank per full-detail tree near the drift.
    pub near_tree_spacing: f32,
    /// Square metres of bank per billboard through the middle distance.
    pub mid_tree_spacing: f32,
}

impl Default for ValleyOptions {
    fn default() -> Self {
        Self {
            seed: 0x5A11E,
            texture_size: 128,
            corridor_near: 140.0,
            corridor_far: -1000.0,
            drift_near: 60.0,
            drift_far: -180.0,
            near_tree_spacing: 130.0,
            mid_tree_spacing: 130.0,
        }
    }
}

/// What a cook produced, for the build log and the tests.
#[derive(Clone, Copy, Debug, Default)]
pub struct CookReport {
    pub bytes: usize,
    pub vertices: usize,
    pub triangles: usize,
    pub chunks: usize,
    pub materials: usize,
    pub textures: usize,
    pub texture_bytes: usize,
    pub near_trees: usize,
    pub billboards: usize,
}

/// Material indices, resolved once and passed around by name.
struct Palette {
    meadow: u16,
    shore: u16,
    rock: u16,
    pine_bark: u16,
    cherry_bark: u16,
    needles: u16,
    blossom: u16,
    pine_card: u16,
    cherry_card: u16,
    reeds: u16,
    treeline: u16,
    timber: u16,
    lacquer: u16,
    plaster: u16,
    tiles: u16,
    thatch: u16,
    glow: u16,
}

/// Geometry accumulated per spatial cell and material before chunking.
#[derive(Default)]
struct Bins {
    /// `(cell, material, lod)` keeps chunk emission ordered and reproducible.
    meshes: BTreeMap<(i32, i32, u16, u8), Mesh>,
}

impl Bins {
    fn entry(&mut self, cell: (i32, i32), material: u16, lod: u8) -> &mut Mesh {
        self.meshes
            .entry((cell.0, cell.1, material, lod))
            .or_default()
    }

    fn flush(
        self,
        builder: &mut SceneBuilder,
        flags: u8,
    ) -> Result<usize, BuildError> {
        let mut chunks = 0;
        for ((_, _, material, lod), mesh) in self.meshes {
            if mesh.is_empty() {
                continue;
            }
            let range = builder.add_mesh(&mesh, material, lod, flags)?;
            chunks += (range.end - range.start) as usize;
        }
        Ok(chunks)
    }
}

/// Cook the scene.
pub fn build(options: &ValleyOptions) -> Result<(Vec<u8>, CookReport), BuildError> {
    let mut report = CookReport::default();
    let mut valley = Valley::new(options.seed);

    // Places the scene levels before anything samples the height field.
    let tower_z = -395.0;
    let tower_x = valley.river_x(tower_z) + 132.0;
    let tower_ground = valley.height(tower_x, tower_z).max(9.0);
    valley.add_pad(Pad {
        center: Vec3::new(tower_x, tower_ground, tower_z),
        radius: 26.0,
        falloff: 18.0,
    });
    let bridge_z = -238.0;
    let bridge_x = valley.river_x(bridge_z);
    let bridge_half_span = valley.river_half_width(bridge_z) + 14.0;
    for side in [-1.0f32, 1.0] {
        let x = bridge_x + side * bridge_half_span;
        valley.add_pad(Pad {
            center: Vec3::new(x, 2.5, bridge_z),
            radius: 9.0,
            falloff: 10.0,
        });
    }

    // Late afternoon, sun low and behind the far end of the valley so the
    // river runs towards the light.
    let sun_dir = Vec3::new(0.30, 0.175, -0.94).normalize();
    let lighting = Lighting {
        sun_dir,
        sun_color: Vec3::new(2.35, 1.52, 0.86),
        sky_zenith: Vec3::new(0.14, 0.22, 0.46),
        sky_horizon: Vec3::new(0.50, 0.47, 0.46),
        bounce: Vec3::new(0.15, 0.14, 0.11),
        exposure: 0.92,
    };
    let fog = FogModel {
        cool: Vec3::new(0.30, 0.44, 0.66),
        warm: Vec3::new(1.55, 0.88, 0.40),
        density: 0.0020,
        base_height: WATER_LEVEL,
        falloff: 0.026,
        inscatter: 0.92,
        max: 0.985,
    };
    let eye_z = (options.drift_near + options.drift_far) * 0.5;
    let eye = Vec3::new(valley.river_x(eye_z), WATER_LEVEL + 2.1, eye_z);
    let inputs = BakeInputs {
        lighting,
        fog,
        eye,
        fog_epsilon: 3.0 / 255.0,
    };

    let mut builder = SceneBuilder::new();
    let palette = cook_materials(&mut builder, options)?;

    let baker = Baker {
        inputs,
        valley: &valley,
    };

    report.chunks += cook_ground(&mut builder, &baker, options, &palette)?;
    let (near_trees, billboards, vegetation_chunks) =
        cook_vegetation(&mut builder, &baker, options, &palette)?;
    report.near_trees = near_trees;
    report.billboards = billboards;
    report.chunks += vegetation_chunks;
    report.chunks += cook_structures(
        &mut builder,
        &baker,
        &palette,
        bridge_x,
        bridge_z,
        bridge_half_span,
        tower_x,
        tower_ground,
        tower_z,
    )?;
    report.chunks += cook_boat(&mut builder, &baker, &palette)?;

    // The header carries everything the runtime needs to match the bake.
    builder.header.sun_dir = sun_dir;
    builder.header.sun_color = lighting.sun_color;
    builder.header.sky_zenith = Vec3::new(0.10, 0.20, 0.46);
    builder.header.sky_horizon = Vec3::new(0.92, 0.74, 0.54);
    builder.header.sky_sun_glow = Vec3::new(1.85, 1.02, 0.50);
    builder.header.fog_cool = fog.cool;
    builder.header.fog_warm = fog.warm;
    builder.header.fog_density = fog.density;
    builder.header.fog_height_falloff = fog.falloff;
    builder.header.fog_inscatter = fog.inscatter;
    builder.header.fog_max = fog.max;
    builder.header.wind_dir = [0.72, 0.69];
    builder.header.wind_strength = 1.0;
    builder.header.world_min = Vec3::new(-960.0, -8.0, options.corridor_far - 60.0);
    builder.header.world_max = Vec3::new(960.0, 520.0, options.corridor_near + 60.0);
    builder.header.water_level = WATER_LEVEL;
    builder.header.camera_fov = 46f32.to_radians();
    builder.header.camera_near = 0.35;
    builder.header.camera_far = 2400.0;
    builder.header.lod_distances = [95.0, 340.0, 1250.0];

    builder.water = pocket3d_scene::format::WaterParams {
        level: WATER_LEVEL,
        deep: Vec3::new(0.022, 0.038, 0.052),
        shallow: Vec3::new(0.115, 0.145, 0.135),
        specular: Vec3::new(3.1, 2.05, 1.12),
        wave_amplitude: 0.055,
        wave_length: 7.5,
        wave_speed: 0.9,
        foam_width: 1.6,
        tile: 0.045,
    };

    // The centre line, sampled for the runtime's water mesh and boat drift.
    let mut river = Vec::new();
    let mut z = options.corridor_far;
    while z <= options.corridor_near {
        river.push(RiverSample {
            z,
            x: valley.river_x(z),
            half_width: valley.river_half_width(z),
            depth: valley.river_depth(z),
        });
        z += 10.0;
    }
    builder.set_river(river);

    let petal_low = Vec3::new(eye.x - 70.0, WATER_LEVEL, options.drift_far - 70.0);
    let petal_high = Vec3::new(eye.x + 70.0, WATER_LEVEL + 26.0, options.drift_near + 40.0);
    builder.add_scatter(Scatter {
        kind: ScatterKind::Petal,
        count: 120,
        min: petal_low,
        max: petal_high,
        rate: 0.75,
    });
    builder.add_scatter(Scatter {
        kind: ScatterKind::Mist,
        count: 44,
        min: Vec3::new(eye.x - 150.0, WATER_LEVEL + 0.4, options.corridor_far),
        max: Vec3::new(eye.x + 150.0, WATER_LEVEL + 7.0, options.drift_near + 40.0),
        rate: 0.35,
    });

    // Chunks with no measurable coverage skip the additive pass entirely,
    // which removes it from the whole near half of the corridor.
    builder.mark_fogged_chunks(inputs.fog_epsilon);

    let bytes = builder.finish()?;
    report.bytes = bytes.len();
    report.vertices = builder.vertex_count();
    report.triangles = builder.chunks().iter().map(|c| c.index_count as usize / 3).sum();
    report.materials = builder.materials().len();
    report.textures = builder.textures().len();
    report.texture_bytes = builder.textures().iter().map(|t| t.data.len()).sum();
    report.chunks = builder.chunks().len();
    Ok((bytes, report))
}

fn cook_materials(
    builder: &mut SceneBuilder,
    options: &ValleyOptions,
) -> Result<Palette, BuildError> {
    let seed = options.seed;
    let ground = options.texture_size * 2;
    let card = options.texture_size;

    let opaque = |builder: &mut SceneBuilder,
                      name: &str,
                      canvas: textures::Canvas|
     -> Result<u16, BuildError> {
        let texture = builder.add_texture(name, canvas.size as u16, canvas.size as u16, &canvas.pixels, false)?;
        Ok(builder.add_material(Material {
            texture,
            kind: MaterialKind::Opaque,
            flags: 0,
            tint: [255; 4],
            sort_bias: 0.0,
        }))
    };

    let meadow = opaque(builder, "meadow", textures::meadow(ground, seed))?;
    let shore = opaque(builder, "shore", textures::gravel(ground, seed ^ 0x11))?;
    let rock = opaque(builder, "rock", textures::rock(ground, seed ^ 0x22))?;
    let pine_bark = opaque(builder, "pine-bark", textures::pine_bark(card, seed ^ 0x33))?;
    let cherry_bark = opaque(builder, "cherry-bark", textures::cherry_bark(card, seed ^ 0x44))?;
    let timber = opaque(builder, "timber", textures::planks(card, seed ^ 0x55))?;
    let lacquer = opaque(builder, "lacquer", textures::lacquer(card, seed ^ 0x66))?;
    let plaster = opaque(builder, "plaster", textures::plaster(card, seed ^ 0x77))?;
    let tiles = opaque(builder, "roof-tiles", textures::roof_tiles(card, seed ^ 0x88))?;
    let thatch = opaque(builder, "thatch", textures::thatch(card, seed ^ 0x99))?;

    let cutout = |builder: &mut SceneBuilder,
                      name: &str,
                      canvas: textures::Canvas,
                      sort_bias: f32|
     -> Result<u16, BuildError> {
        let texture = builder.add_texture(name, canvas.size as u16, canvas.size as u16, &canvas.pixels, true)?;
        Ok(builder.add_material(Material {
            texture,
            kind: MaterialKind::Cutout,
            flags: material_flags::TWO_SIDED,
            tint: [255; 4],
            sort_bias,
        }))
    };
    let needles = cutout(builder, "pine-spray", textures::pine_spray(card, seed ^ 0xa1), 0.0)?;
    let blossom = cutout(builder, "blossom", textures::blossom_cluster(card, seed ^ 0xb2), 0.0)?;
    // Reeds stand in front of the bank they grow on; biasing them nearer keeps
    // them from sorting behind the water they overhang.
    let reeds = cutout(builder, "reeds", textures::reeds(card, seed ^ 0xc3), -2.0)?;
    let treeline = cutout(builder, "treeline", textures::treeline(card, seed ^ 0xd4), 4.0)?;
    // The billboard band gets whole-tree cards, not scaled-up foliage.
    let pine_card = cutout(
        builder,
        "pine-card",
        textures::tree_card(card, seed ^ 0xe1, true),
        1.0,
    )?;
    let cherry_card = cutout(
        builder,
        "cherry-card",
        textures::tree_card(card, seed ^ 0xe2, false),
        1.0,
    )?;
    let petal = cutout(builder, "petal", textures::petal(card / 2, seed ^ 0xe5), 0.0)?;

    let puff_texture = {
        let canvas = textures::puff(card / 2);
        builder.add_texture("puff", canvas.size as u16, canvas.size as u16, &canvas.pixels, true)?
    };
    let puff = builder.add_material(Material {
        texture: puff_texture,
        kind: MaterialKind::Blended,
        flags: material_flags::TWO_SIDED,
        tint: [255; 4],
        sort_bias: 0.0,
    });
    let glow = builder.add_material(Material {
        texture: puff_texture,
        kind: MaterialKind::Additive,
        flags: material_flags::TWO_SIDED,
        tint: [255; 4],
        sort_bias: 0.0,
    });
    let water_texture = {
        let canvas = textures::ripples(ground, seed ^ 0xf6);
        builder.add_texture("ripples", canvas.size as u16, canvas.size as u16, &canvas.pixels, false)?
    };
    let water = builder.add_material(Material {
        texture: water_texture,
        kind: MaterialKind::Opaque,
        flags: 0,
        tint: [255; 4],
        sort_bias: 0.0,
    });
    let cloud_texture = {
        let canvas = textures::clouds(ground, seed ^ 0x07);
        builder.add_texture("clouds", canvas.size as u16, canvas.size as u16, &canvas.pixels, true)?
    };
    let cloud = builder.add_material(Material {
        texture: cloud_texture,
        kind: MaterialKind::Blended,
        flags: material_flags::TWO_SIDED,
        tint: [255; 4],
        sort_bias: 0.0,
    });

    builder.set_role(MaterialRole::Petal, petal);
    builder.set_role(MaterialRole::Puff, puff);
    builder.set_role(MaterialRole::Water, water);
    builder.set_role(MaterialRole::Cloud, cloud);

    Ok(Palette {
        meadow,
        shore,
        rock,
        pine_bark,
        cherry_bark,
        needles,
        blossom,
        pine_card,
        cherry_card,
        reeds,
        treeline,
        timber,
        lacquer,
        plaster,
        tiles,
        thatch,
        glow,
    })
}

/// Lateral offsets from the centre line, shared by every row.
///
/// Inside the channel the columns are a fraction of the local half width, so
/// the water's edge always lands on a column no matter how the river widens.
/// Outside it they step away geometrically: metre-scale at the shore,
/// hundred-metre-scale at the ridge.
fn column_table() -> (Vec<f32>, usize) {
    let outside = [
        1.6f32, 3.4, 5.8, 8.8, 12.6, 17.5, 23.8, 32.0, 42.5, 56.0, 73.0, 95.0, 123.0, 158.0,
        202.0, 258.0, 330.0, 420.0, 535.0, 680.0, 860.0,
    ];
    let inside = [-1.0f32, -0.75, -0.5, -0.25, 0.0, 0.25, 0.5, 0.75, 1.0];
    let mut columns = Vec::with_capacity(outside.len() * 2 + inside.len());
    for &offset in outside.iter().rev() {
        columns.push(-offset);
    }
    let inside_start = columns.len();
    for &t in &inside {
        columns.push(t);
    }
    for &offset in &outside {
        columns.push(offset);
    }
    (columns, inside_start)
}

/// Rows along the current: dense over the drift, coarser towards the horizon.
fn row_table(options: &ValleyOptions) -> Vec<f32> {
    let mut rows = Vec::new();
    let mut z = options.corridor_far;
    while z <= options.corridor_near {
        rows.push(z);
        z += if z > -320.0 {
            6.0
        } else if z > -640.0 {
            11.0
        } else {
            19.0
        };
    }
    rows.push(options.corridor_near);
    rows.dedup_by(|a, b| (*a - *b).abs() < 0.5);
    rows
}

/// World position of one grid node.
fn node(valley: &Valley, z: f32, column: f32, inside: bool) -> Vec3 {
    let center = valley.river_x(z);
    let x = if inside {
        center + column * valley.river_half_width(z)
    } else {
        center + column
    };
    Vec3::new(x, valley.height(x, z), z)
}

fn cook_ground(
    builder: &mut SceneBuilder,
    baker: &Baker<'_>,
    options: &ValleyOptions,
    palette: &Palette,
) -> Result<usize, BuildError> {
    let valley = baker.valley;
    let (columns, inside_start) = column_table();
    let inside_end = inside_start + 9;
    let rows = row_table(options);

    // Resolve every node once; the grid is shared by all three materials.
    let mut positions = Vec::with_capacity(rows.len() * columns.len());
    for &z in &rows {
        for (index, &column) in columns.iter().enumerate() {
            let inside = index >= inside_start && index < inside_end;
            positions.push(node(valley, z, column, inside));
        }
    }
    let stride = columns.len();
    let at = |row: usize, column: usize| positions[row * stride + column];

    let mut bins = Bins::default();
    const ROWS_PER_CELL: usize = 12;
    const COLUMNS_PER_CELL: usize = 6;

    for row in 0..rows.len() - 1 {
        for column in 0..columns.len() - 1 {
            let corners = [
                at(row, column),
                at(row, column + 1),
                at(row + 1, column + 1),
                at(row + 1, column),
            ];
            let center = (corners[0] + corners[1] + corners[2] + corners[3]) * 0.25;
            let normal = valley.normal(center.x, center.z);
            let shore = valley.shore_distance(center.x, center.z);

            // Gravel from the channel out to the top of the beach, rock on
            // anything too steep or too high to hold soil, meadow otherwise.
            let material = if shore < 9.0 || center.y < WATER_LEVEL + 1.1 {
                palette.shore
            } else if normal.y < 0.70 || center.y > 165.0 {
                palette.rock
            } else {
                palette.meadow
            };
            let tint = ground_tint(valley, center, normal, material == palette.shore);

            let cell = (
                (row / ROWS_PER_CELL) as i32,
                (column / COLUMNS_PER_CELL) as i32,
            );
            let mesh = bins.entry(cell, material, LOD_ALWAYS);
            let first = mesh.vertex_count() as u32;
            // Texture scale in metres per tile; the shore reads finer.
            let scale = if material == palette.shore { 0.22 } else { 0.11 };
            for corner in corners {
                let corner_normal = valley.normal(corner.x, corner.z);
                let color = baker.ground(corner, corner_normal, tint);
                mesh.push_vertex(corner, [corner.x * scale, corner.z * scale], color);
            }
            mesh.push_quad(first, first + 1, first + 2, first + 3);
        }
    }
    bins.flush(builder, 0)
}

/// Per-quad colour modulation, which is what makes one albedo map read as
/// meadow, shingle and wet stone.
fn ground_tint(valley: &Valley, center: Vec3, normal: Vec3, shore: bool) -> Vec3 {
    let meadow = valley.meadow(center.x, center.z);
    let wet = valley.wetness(center.x, center.z);
    let mut tint = if shore {
        // Wet shingle darkens and cools towards the water.
        Vec3::new(1.0, 1.0, 1.0).lerp(Vec3::new(0.42, 0.47, 0.52), wet * 0.85)
    } else {
        // Dry ground warms on the slopes and greens in the hollows.
        let green = Vec3::new(0.80, 1.06, 0.72);
        let stone = Vec3::new(0.94, 0.92, 0.88);
        stone.lerp(green, meadow)
    };
    // Steep faces lose their cover whatever else is true of them.
    tint = tint.lerp(Vec3::new(0.88, 0.86, 0.84), smoothstep(0.78, 0.5, normal.y));
    tint * (0.92 + 0.16 * fbm(center.x * 0.0032, center.z * 0.0032, 3, valley.seed ^ 0x5151))
}

#[allow(clippy::type_complexity)]
fn cook_vegetation(
    builder: &mut SceneBuilder,
    baker: &Baker<'_>,
    options: &ValleyOptions,
    palette: &Palette,
) -> Result<(usize, usize, usize), BuildError> {
    let valley = baker.valley;
    let mut near = Bins::default();
    let mut mid = Bins::default();
    let mut far = Bins::default();
    let mut near_count = 0usize;
    let mut billboard_count = 0usize;

    // The drift line, used to decide which trees deserve real geometry.
    let drift_near = options.drift_near;
    let drift_far = options.drift_far;
    let distance_to_drift = |point: Vec3| -> f32 {
        let z = point.z.clamp(drift_far, drift_near);
        let x = valley.river_x(z);
        ((point.x - x).powi(2) + (point.z - z).powi(2)).sqrt()
    };

    // One jittered candidate per cell of a grid over the corridor.
    let cell_size = 9.0f32;
    let z_start = options.corridor_far;
    let z_end = options.corridor_near;
    let mut z = z_start;
    while z < z_end {
        let center_x = valley.river_x(z);
        let mut offset = -760.0f32;
        while offset < 760.0 {
            let mut rng = Rng::new(
                crate::noise::hash2((z * 0.37) as i32, (offset * 0.41) as i32, options.seed),
            );
            let x = center_x + offset + rng.range(-cell_size * 0.5, cell_size * 0.5);
            let sample_z = z + rng.range(-cell_size * 0.5, cell_size * 0.5);
            offset += cell_size;

            let shore = valley.shore_distance(x, sample_z);
            if shore < 3.0 {
                continue;
            }
            let height = valley.height(x, sample_z);
            if height < WATER_LEVEL + 0.5 || height > 330.0 {
                continue;
            }
            let normal = valley.normal(x, sample_z);
            // Conifers hold on to slopes far steeper than meadow will; only
            // a near-cliff is left bare.
            if normal.y < 0.42 {
                continue;
            }
            // Forest density: thickest on the lower slopes, thinning towards
            // the ridge line and opening into meadow on the flood plain.
            let slope_band = smoothstep(4.0, 40.0, shore) * (1.0 - smoothstep(230.0, 330.0, height));
            let clumping = fbm(x * 0.0042, sample_z * 0.0042, 4, options.seed ^ 0x9f0);
            let density = (slope_band * (0.45 + 1.35 * clumping)).clamp(0.0, 1.0);
            let base = Vec3::new(x, height, sample_z);
            let spacing = if distance_to_drift(base) < 130.0 {
                options.near_tree_spacing
            } else {
                options.mid_tree_spacing
            };
            if !rng.chance(density * cell_size * cell_size / spacing) {
                continue;
            }

            let is_pine = fbm(x * 0.0018, sample_z * 0.0018, 3, options.seed ^ 0x3c1) > 0.46;
            let tree_seed = rng.next_u32();
            let cell = ((sample_z / 64.0) as i32, ((x - center_x) / 64.0) as i32);
            let drift_distance = distance_to_drift(base);

            if drift_distance < 130.0 {
                let trunk_material = if is_pine {
                    palette.pine_bark
                } else {
                    palette.cherry_bark
                };
                let canopy_material = if is_pine {
                    palette.needles
                } else {
                    palette.blossom
                };
                let height_m = if is_pine {
                    rng.range(13.0, 22.0)
                } else {
                    rng.range(6.5, 11.0)
                };
                let mut trunk = Mesh::new();
                let mut canopy = Mesh::new();
                if is_pine {
                    flora::pine(&mut trunk, &mut canopy, baker, base, height_m, tree_seed);
                } else {
                    flora::cherry(&mut trunk, &mut canopy, baker, base, height_m, tree_seed);
                }
                near.entry(cell, trunk_material, 0).append(&trunk);
                near.entry(cell, canopy_material, 0).append(&canopy);
                near_count += 1;

                // The same tree also exists as a billboard for the next band.
                let mut billboard = Mesh::new();
                flora::billboard_tree(
                    &mut billboard,
                    baker,
                    base,
                    height_m,
                    height_m * if is_pine { 0.68 } else { 0.95 },
                    tree_seed,
                );
                let card_material = if is_pine {
                    palette.pine_card
                } else {
                    palette.cherry_card
                };
                mid.entry(cell, card_material, 1).append(&billboard);
                billboard_count += 1;
            } else if drift_distance < 430.0 {
                let card_material = if is_pine {
                    palette.pine_card
                } else {
                    palette.cherry_card
                };
                let height_m = if is_pine {
                    rng.range(13.0, 22.0)
                } else {
                    rng.range(6.5, 11.0)
                };
                let mut billboard = Mesh::new();
                flora::billboard_tree(
                    &mut billboard,
                    baker,
                    base,
                    height_m,
                    height_m * if is_pine { 0.68 } else { 0.95 },
                    tree_seed,
                );
                mid.entry(cell, card_material, 1).append(&billboard);
                billboard_count += 1;
            } else {
                // Beyond the billboard band one card stands for a stand of
                // trees, which is all the silhouette the fog leaves visible.
                let mut mass = Mesh::new();
                let width = rng.range(26.0, 44.0);
                let mass_height = rng.range(16.0, 26.0);
                crate::geometry::card(
                    &mut mass,
                    base + Vec3::Y * mass_height * 0.5,
                    Vec3::new(1.0, 0.0, 0.0) * width * 0.5,
                    Vec3::Y * mass_height * 0.5,
                    |position, _| {
                        let up = ((position.y - base.y) / mass_height).clamp(0.0, 1.0);
                        baker.standing(base, position, Vec3::Y, 0.5 + 0.4 * up, Vec3::splat(0.85))
                    },
                );
                far.entry(
                    ((sample_z / 220.0) as i32, ((x - center_x) / 220.0) as i32),
                    palette.treeline,
                    2,
                )
                .append(&mass);
            }
        }
        z += cell_size;
    }

    // Reeds hug the waterline all the way along the drift.
    let mut reeds = Bins::default();
    let mut z = drift_far - 140.0;
    while z < drift_near + 60.0 {
        for side in [-1.0f32, 1.0] {
            let half_width = valley.river_half_width(z);
            let center_x = valley.river_x(z);
            let mut rng = Rng::new(crate::noise::hash2(
                (z * 2.3) as i32,
                side as i32,
                options.seed ^ 0x7ee,
            ));
            let clumps = 3;
            for _ in 0..clumps {
                let offset = half_width + rng.range(-1.0, 6.5);
                let x = center_x + side * offset;
                let sample_z = z + rng.range(-1.6, 1.6);
                let height = valley.height(x, sample_z);
                if height < WATER_LEVEL - 0.55 || height > WATER_LEVEL + 1.35 {
                    continue;
                }
                let base = Vec3::new(x, height, sample_z);
                let mut mesh = Mesh::new();
                flora::reed_clump(&mut mesh, baker, base, rng.range(1.5, 2.6), rng.next_u32());
                reeds
                    .entry(((sample_z / 48.0) as i32, side as i32), palette.reeds, 0)
                    .append(&mesh);
            }
        }
        z += 3.2;
    }

    // Boulders at the water's edge, where the current would have left them.
    let mut rocks = Bins::default();
    let mut z = drift_far - 200.0;
    while z < drift_near + 60.0 {
        for side in [-1.0f32, 1.0] {
            let mut rng = Rng::new(crate::noise::hash2(
                (z * 0.7) as i32,
                side as i32 * 31,
                options.seed ^ 0x1a3,
            ));
            if !rng.chance(0.22) {
                continue;
            }
            let half_width = valley.river_half_width(z);
            let x = valley.river_x(z) + side * (half_width + rng.range(-3.0, 7.0));
            let height = valley.height(x, z);
            if height > WATER_LEVEL + 2.0 {
                continue;
            }
            let base = Vec3::new(x, height, z);
            let size = rng.range(0.7, 2.3);
            let mut mesh = Mesh::new();
            flora::rock(
                &mut mesh,
                baker,
                base,
                Vec3::new(size, size * rng.range(0.5, 0.85), size * rng.range(0.7, 1.2)),
                rng.next_u32(),
            );
            rocks
                .entry(((z / 64.0) as i32, side as i32), palette.rock, 0)
                .append(&mesh);
        }
        z += 7.0;
    }

    let mut chunks = 0;
    chunks += near.flush(builder, chunk_flags::FOLIAGE)?;
    chunks += mid.flush(builder, chunk_flags::FOLIAGE)?;
    chunks += far.flush(builder, chunk_flags::FOLIAGE)?;
    chunks += reeds.flush(builder, chunk_flags::FOLIAGE)?;
    chunks += rocks.flush(builder, 0)?;
    Ok((near_count, billboard_count, chunks))
}

#[allow(clippy::too_many_arguments)]
fn cook_structures(
    builder: &mut SceneBuilder,
    baker: &Baker<'_>,
    palette: &Palette,
    bridge_x: f32,
    bridge_z: f32,
    bridge_half_span: f32,
    tower_x: f32,
    tower_ground: f32,
    tower_z: f32,
) -> Result<usize, BuildError> {
    let mut meshes = StructureMeshes::default();
    structures::arched_bridge(
        &mut meshes,
        baker,
        Vec3::new(bridge_x, 2.6, bridge_z),
        core::f32::consts::FRAC_PI_2,
        bridge_half_span * 2.0,
        4.6,
        3.4,
    );
    structures::tiered_tower(
        &mut meshes,
        baker,
        Vec3::new(tower_x, tower_ground, tower_z),
        5,
        5.4,
        6.2,
    );

    // Lanterns along the near bank, marking the drift.
    let valley = baker.valley;
    for step in 0..7 {
        let z = 30.0 - step as f32 * 46.0;
        let half_width = valley.river_half_width(z);
        let x = valley.river_x(z) + half_width + 5.0;
        let base = Vec3::new(x, valley.height(x, z), z);
        structures::bank_lantern(&mut meshes, baker, base, 2.4);
    }

    let mut chunks = 0;
    for (mesh, material) in [
        (&meshes.timber, palette.timber),
        (&meshes.lacquer, palette.lacquer),
        (&meshes.plaster, palette.plaster),
        (&meshes.tiles, palette.tiles),
        (&meshes.thatch, palette.thatch),
    ] {
        if mesh.is_empty() {
            continue;
        }
        let range = builder.add_mesh(mesh, material, LOD_ALWAYS, 0)?;
        chunks += (range.end - range.start) as usize;
    }
    if !meshes.glow.is_empty() {
        let range = builder.add_mesh(&meshes.glow, palette.glow, LOD_ALWAYS, 0)?;
        chunks += (range.end - range.start) as usize;
    }
    Ok(chunks)
}

/// The boat is cooked in its own space and placed by the runtime.
///
/// Its aerial perspective is baked against the camera's seat on the boat, not
/// against the world eye: the hull is always a few metres away, so baking it
/// with the fog of wherever the origin happens to sit would haze the one
/// object that should stay crisp.
fn cook_boat(
    builder: &mut SceneBuilder,
    world_baker: &Baker<'_>,
    palette: &Palette,
) -> Result<usize, BuildError> {
    let baker = &Baker {
        inputs: BakeInputs {
            eye: Vec3::new(0.0, 2.6, 7.5),
            ..world_baker.inputs
        },
        valley: world_baker.valley,
    };
    let mut meshes = StructureMeshes::default();
    structures::river_boat(&mut meshes, baker, 9.2, 2.7);
    structures::boat_lantern(&mut meshes, baker, Vec3::new(0.0, 0.55, -3.9), 1.35);

    let mut first = u16::MAX;
    let mut last = 0u16;
    let mut chunks = 0;
    for (mesh, material) in [
        (&meshes.timber, palette.timber),
        (&meshes.thatch, palette.thatch),
        (&meshes.glow, palette.glow),
    ] {
        if mesh.is_empty() {
            continue;
        }
        let range = builder.add_mesh(mesh, material, LOD_ALWAYS, chunk_flags::DYNAMIC)?;
        first = first.min(range.start);
        last = last.max(range.end);
        chunks += (range.end - range.start) as usize;
    }
    if chunks > 0 {
        builder.add_object("boat", first..last, Vec3::ZERO, 0, 0)?;
    }
    Ok(chunks)
}

#[cfg(test)]
mod tests {
    use super::*;
    use pocket3d_scene::format::Scene;

    fn small() -> ValleyOptions {
        ValleyOptions {
            texture_size: 32,
            corridor_near: 80.0,
            corridor_far: -420.0,
            drift_near: 40.0,
            drift_far: -60.0,
            near_tree_spacing: 900.0,
            mid_tree_spacing: 1600.0,
            ..ValleyOptions::default()
        }
    }

    #[test]
    fn a_cooked_valley_parses_and_carries_every_section() {
        let (bytes, report) = build(&small()).unwrap();
        let scene = Scene::parse(&bytes).unwrap();
        assert!(scene.chunks.len() > 20, "{}", scene.chunks.len());
        assert!(scene.triangle_count() > 2_000);
        assert!(scene.materials.len() >= 15);
        assert!(scene.textures.len() >= 15);
        assert!(!scene.river.is_empty());
        assert_eq!(scene.scatters.len(), 2);
        assert!(scene.object("boat").is_some());
        assert_eq!(report.triangles, scene.triangle_count());
        for role in [
            MaterialRole::Petal,
            MaterialRole::Puff,
            MaterialRole::Water,
            MaterialRole::Cloud,
        ] {
            assert!(scene.role_material(role).is_some(), "{role:?}");
        }
    }

    #[test]
    fn cooking_the_same_options_twice_produces_the_same_bytes() {
        let (first, _) = build(&small()).unwrap();
        let (second, _) = build(&small()).unwrap();
        assert_eq!(first, second);
    }

    #[test]
    fn the_column_table_is_sorted_and_symmetric() {
        let (columns, inside_start) = column_table();
        assert!(columns.windows(2).all(|pair| pair[0] < pair[1]));
        assert_eq!(columns[inside_start], -1.0);
        assert_eq!(columns[inside_start + 8], 1.0);
    }

    #[test]
    fn every_chunk_sits_inside_the_declared_world_bounds() {
        let (bytes, _) = build(&small()).unwrap();
        let scene = Scene::parse(&bytes).unwrap();
        for chunk in &scene.chunks {
            if chunk.is_dynamic() {
                continue;
            }
            let low = chunk.center - Vec3::splat(chunk.radius);
            let high = chunk.center + Vec3::splat(chunk.radius);
            assert!(
                high.x >= scene.header.world_min.x && low.x <= scene.header.world_max.x,
                "{chunk:?}"
            );
        }
    }

    /// Largest fog coverage stored on any vertex of a chunk, in `0..1`.
    fn chunk_coverage(scene: &Scene<'_>, index: usize) -> f32 {
        let stride = pocket3d_scene::format::VERTEX_STRIDE;
        let total = scene.vertices.len() / stride;
        let start = scene.chunks[index].vertex_base as usize;
        let end = scene
            .chunks
            .get(index + 1)
            .map(|next| next.vertex_base as usize)
            .unwrap_or(total)
            .min(total);
        (start..end)
            .map(|vertex| {
                scene.vertices
                    [vertex * stride + pocket3d_scene::format::VERTEX_FOG_OFFSET + 3]
                    as f32
                    / 255.0
            })
            .fold(0.0f32, f32::max)
    }

    #[test]
    fn every_distant_chunk_carries_the_fog_pass() {
        let (bytes, _) = build(&small()).unwrap();
        let scene = Scene::parse(&bytes).unwrap();
        let eye = Vec3::new(scene.river_at(-10.0).0, 2.0, -10.0);
        let missing = scene
            .chunks
            .iter()
            .filter(|chunk| !chunk.is_dynamic())
            .filter(|chunk| (chunk.center - eye).length() > 400.0 && !chunk.is_fogged())
            .count();
        assert_eq!(missing, 0, "a distant chunk would draw with no aerial perspective");
    }

    #[test]
    fn the_boat_is_baked_against_its_own_viewing_distance() {
        let (bytes, _) = build(&small()).unwrap();
        let scene = Scene::parse(&bytes).unwrap();
        let boat = scene.object("boat").expect("the boat should be cooked");
        let boat_coverage = (boat.first_chunk as usize
            ..boat.first_chunk as usize + boat.chunk_count as usize)
            .map(|index| chunk_coverage(&scene, index))
            .fold(0.0f32, f32::max);
        let world_coverage = (0..scene.chunks.len())
            .filter(|index| !scene.chunks[*index].is_dynamic())
            .map(|index| chunk_coverage(&scene, index))
            .fold(0.0f32, f32::max);
        assert!(boat_coverage < 0.06, "the hull hazed over at {boat_coverage}");
        assert!(
            world_coverage > boat_coverage * 6.0,
            "the world ({world_coverage}) should be far hazier than the hull ({boat_coverage})"
        );
    }

    #[test]
    fn the_cooked_drift_matches_the_stretch_the_fog_was_baked_for() {
        let options = small();
        let settings = drift(&options);
        assert_eq!(settings.near, options.drift_near);
        assert_eq!(settings.far, options.drift_far);
    }
}
