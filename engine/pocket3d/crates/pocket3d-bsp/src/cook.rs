//! The map cooker: GoldSrc BSP + WADs → the `.p3d` cooked container.
//!
//! What cooking does, beyond re-encoding:
//! - **Bakes lighting into vertex colors.** Faces are grid-subdivided
//!   (GLQuake `SubdividePolygon`, clip planes on world-grid multiples so
//!   neighboring faces split at identical points) and the face lightmap is
//!   sampled bilinearly at every vertex, with the GoldSrc 2x overbright
//!   folded in. One render pass, no lightmap pages.
//! - **Keeps textures paletted.** WAD3 miptex are natively 8-bit indexed;
//!   they ship as swizzled CLUT8 with the mip chain extended below the four
//!   stored levels (box filter + palette requantize).
//! - **Precomputes visibility.** The render BSP, leaf face lists and
//!   compressed PVS ship in `WVIS` for `vis::VisSet` culling.
//! - **Serializes collision.** Plane table, clipnode hulls and the solid
//!   brush-entity registry; hull 0 is re-synthesized at load.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use glam::Vec3;

use crate::cooked::{
    self, P3dWriter, TAG_WBAT, TAG_WCLP, TAG_WENT, TAG_WFAC, TAG_WIDX, TAG_WRUN, TAG_WTEX,
    TAG_WVIS, TAG_WVTX,
};
use crate::entities::{brush_entity_layout, parse_entities, parse_sun};
use crate::mesh::classify;
use crate::raw::{self, RawBsp};
use crate::types::{SpawnPoint, SurfaceKind};
use crate::wad::{IndexedTexture, WadSet, decode_miptex_indexed};

pub struct CookOptions {
    /// Maximum face extent before grid subdivision, in world units.
    pub subdivide: f32,
    /// Diagnostic builds may keep the missing-texture checkerboard.
    pub allow_missing_textures: bool,
}

impl Default for CookOptions {
    fn default() -> Self {
        Self {
            subdivide: 96.0,
            allow_missing_textures: false,
        }
    }
}

#[derive(Debug, Default)]
pub struct CookStats {
    pub faces_drawn: usize,
    pub faces_skipped: usize,
    pub vertices: usize,
    pub triangles: usize,
    pub batches: usize,
    pub textures: usize,
    pub texture_bytes: usize,
    pub vis_bytes: usize,
    pub collision_bytes: usize,
    pub total_bytes: usize,
}

/// Cook a map from disk. WAD resolution mirrors `load_map`: provided dirs
/// plus the map's own directory and conventional siblings.
pub fn cook_map(
    bsp_path: &Path,
    wad_dirs: &[PathBuf],
    opts: &CookOptions,
) -> Result<(Vec<u8>, CookStats)> {
    let data =
        std::fs::read(bsp_path).with_context(|| format!("reading {}", bsp_path.display()))?;
    let name = bsp_path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "map".into());
    let bsp = raw::parse(&data).with_context(|| format!("parsing {}", bsp_path.display()))?;

    let mut wads = WadSet::new();
    let mut dirs = wad_dirs.to_vec();
    if let Some(parent) = bsp_path.parent() {
        dirs.push(parent.to_path_buf());
        if let Some(gp) = parent.parent() {
            dirs.push(gp.join("support"));
            dirs.push(gp.join("wads"));
            dirs.push(gp.to_path_buf());
        }
    }
    wads.add_dirs(&dirs)?;

    cook_parsed(&bsp, &name, &wads, opts)
}

/// Cook an already-parsed BSP (the testable entry point).
pub fn cook_parsed(
    bsp: &RawBsp,
    name: &str,
    wads: &WadSet,
    opts: &CookOptions,
) -> Result<(Vec<u8>, CookStats)> {
    let mut stats = CookStats::default();
    let ents = parse_entities(&bsp.entities_text);
    let (include_models, solid_entities) = brush_entity_layout(&ents, bsp.models.len());

    // ---- Textures --------------------------------------------------------
    let mut textures = Vec::with_capacity(bsp.textures.len());
    let mut unresolved = Vec::with_capacity(bsp.textures.len());
    for entry in &bsp.textures {
        let tex = match &entry.embedded {
            Some(block) => decode_miptex_indexed(block).ok(),
            None => wads
                .find_block(&entry.name)
                .and_then(|b| decode_miptex_indexed(b).ok()),
        };
        unresolved.push(tex.is_none());
        let tex = tex.unwrap_or_else(|| {
            log::warn!(
                "{name}: texture {} unresolved, cooking placeholder",
                entry.name
            );
            placeholder_indexed(&entry.name)
        });
        textures.push(tex);
    }
    stats.textures = textures.len();

    // ---- Geometry --------------------------------------------------------
    let geo = cook_geometry(bsp, &textures, &include_models, opts, &mut stats)?;
    // Sky/tool/unused texture entries do not require pixel data. Only batches
    // that the renderer will draw can make a package incomplete.
    if !opts.allow_missing_textures {
        let mut missing: Vec<_> = geo
            .batches
            .iter()
            .filter(|batch| unresolved[batch.texture as usize])
            .map(|batch| textures[batch.texture as usize].name.as_str())
            .collect();
        missing.sort_unstable();
        missing.dedup();
        if !missing.is_empty() {
            bail!(
                "{name}: {} visible textures unresolved: {}. Supply the map's WAD files with --wads DIR; --allow-missing-textures is for diagnostic builds",
                missing.len(),
                missing.join(", ")
            );
        }
    }

    // ---- Assemble sections ------------------------------------------------
    let mut w = P3dWriter::new();

    let mut vtx = Vec::with_capacity(geo.verts.len() * cooked::VERTEX_STRIDE);
    for v in &geo.verts {
        vtx.extend_from_slice(&v.u.to_le_bytes());
        vtx.extend_from_slice(&v.v.to_le_bytes());
        vtx.extend_from_slice(&v.color.to_le_bytes());
        vtx.extend_from_slice(&v.x.to_le_bytes());
        vtx.extend_from_slice(&v.y.to_le_bytes());
        vtx.extend_from_slice(&v.z.to_le_bytes());
        vtx.extend_from_slice(&0i16.to_le_bytes());
    }
    w.section(TAG_WVTX, vtx);

    let mut idx = Vec::with_capacity(geo.indices.len() * 2);
    for i in &geo.indices {
        idx.extend_from_slice(&i.to_le_bytes());
    }
    w.section(TAG_WIDX, idx);

    let mut bat = Vec::new();
    bat.extend_from_slice(&(geo.batches.len() as u32).to_le_bytes());
    for b in &geo.batches {
        bat.extend_from_slice(&b.texture.to_le_bytes());
        bat.push(b.kind.as_u8());
        bat.push(0);
        bat.extend_from_slice(&b.vert_base.to_le_bytes());
        bat.extend_from_slice(&b.vert_count.to_le_bytes());
        bat.extend_from_slice(&b.index_base.to_le_bytes());
        bat.extend_from_slice(&b.index_count.to_le_bytes());
    }
    w.section(TAG_WBAT, bat);
    stats.batches = geo.batches.len();

    let write_runs = |runs: &[RawRun]| -> Vec<u8> {
        let mut out = Vec::with_capacity(4 + runs.len() * cooked::RUN_STRIDE);
        out.extend_from_slice(&(runs.len() as u32).to_le_bytes());
        for r in runs {
            out.extend_from_slice(&r.batch.to_le_bytes());
            out.extend_from_slice(&r.index_count.to_le_bytes());
            out.extend_from_slice(&r.index_base.to_le_bytes());
        }
        out
    };
    w.section(TAG_WFAC, write_runs(&geo.faces));
    w.section(TAG_WRUN, write_runs(&geo.always_runs));

    let tex_section = cook_textures_section(&textures)?;
    stats.texture_bytes = tex_section.len();
    w.section(TAG_WTEX, tex_section);

    let vis_section = cook_vis_section(bsp);
    stats.vis_bytes = vis_section.len();
    w.section(TAG_WVIS, vis_section);

    let clp_section = cook_collision_section(bsp, &solid_entities);
    stats.collision_bytes = clp_section.len();
    w.section(TAG_WCLP, clp_section);

    w.section(TAG_WENT, cook_entities_section(bsp, &ents, name));

    let out = w.finish();
    stats.total_bytes = out.len();
    Ok((out, stats))
}

// ---- Geometry cooking ------------------------------------------------------

struct CookVert {
    u: f32,
    v: f32,
    color: u32,
    x: i16,
    y: i16,
    z: i16,
}

struct RawRun {
    batch: u16,
    index_count: u16,
    index_base: u32,
}

struct CookedGeometry {
    verts: Vec<CookVert>,
    indices: Vec<u16>,
    batches: Vec<RawBatch>,
    faces: Vec<RawRun>,
    always_runs: Vec<RawRun>,
}

struct RawBatch {
    texture: u16,
    kind: SurfaceKind,
    vert_base: u32,
    vert_count: u32,
    index_base: u32,
    index_count: u32,
}

/// An open (still accumulating) batch.
struct BatchAccum {
    texture: u16,
    kind: SurfaceKind,
    verts: Vec<CookVert>,
    indices: Vec<u16>,
    /// (bsp face id or NONE for entity runs, first index, count)
    runs: Vec<(u32, u32, u16)>,
}

const ENTITY_RUN: u32 = u32::MAX;

fn cook_geometry(
    bsp: &RawBsp,
    textures: &[IndexedTexture],
    include_models: &[(usize, Vec3)],
    opts: &CookOptions,
    stats: &mut CookStats,
) -> Result<CookedGeometry> {
    // Open batches by (texture, kind); sealed ones accumulate in `sealed`.
    let mut open: HashMap<(u16, SurfaceKind), BatchAccum> = HashMap::new();
    let mut sealed: Vec<BatchAccum> = Vec::new();

    for &(model_idx, offset) in include_models {
        let Some(model) = bsp.models.get(model_idx) else {
            continue;
        };
        let is_world = model_idx == 0;
        for face_idx in model.first_face..model.first_face + model.num_faces {
            let Some(face) = bsp.faces.get(face_idx) else {
                continue;
            };
            let ti = &bsp.texinfos[face.texinfo as usize];
            let tex_idx = ti.miptex.min(textures.len().saturating_sub(1));
            let tex = &textures[tex_idx];
            let kind = classify(&tex.name).filter(|k| *k != SurfaceKind::Sky);
            let Some(kind) = kind else {
                stats.faces_skipped += 1;
                continue;
            };

            let n = face.num_edges as usize;
            if n < 3 {
                continue;
            }
            let mut poly: Vec<Vec3> = Vec::with_capacity(n);
            for i in 0..n {
                let se = bsp.surfedges[face.first_edge as usize + i];
                let vi = if se >= 0 {
                    bsp.edges[se as usize][0]
                } else {
                    bsp.edges[(-se) as usize][1]
                };
                poly.push(bsp.vertices[vi as usize] + offset);
            }

            // Lightmap block extents from the *full* face (the luxel grid
            // belongs to the face, not to subdivided pieces).
            let st = |p: Vec3| (p.dot(ti.s) + ti.s_shift, p.dot(ti.t) + ti.t_shift);
            let (mut min_s, mut max_s) = (f32::MAX, f32::MIN);
            let (mut min_t, mut max_t) = (f32::MAX, f32::MIN);
            for &p in &poly {
                let (s, t) = st(p);
                min_s = min_s.min(s);
                max_s = max_s.max(s);
                min_t = min_t.min(t);
                max_t = max_t.max(t);
            }
            let bs = (min_s / 16.0).floor();
            let bt = (min_t / 16.0).floor();
            let lw = (((max_s / 16.0).ceil() - bs) as u32 + 1).clamp(1, 256);
            let lh = (((max_t / 16.0).ceil() - bt) as u32 + 1).clamp(1, 256);
            let samples = (lw * lh) as usize;
            let lit = face.lightmap_offset >= 0
                && face.styles[0] != 255
                && (face.lightmap_offset as usize + samples * 3) <= bsp.lighting.len();
            let block = lit.then(|| {
                let o = face.lightmap_offset as usize;
                &bsp.lighting[o..o + samples * 3]
            });

            // Subdivide on the world grid, then triangulate.
            let mut pieces = Vec::new();
            subdivide_poly(poly, opts.subdivide, &mut pieces);

            let (tw, th) = (tex.width.max(1) as f32, tex.height.max(1) as f32);
            let mut local: HashMap<(i16, i16, i16), u16> = HashMap::new();
            let mut tri_indices: Vec<u16> = Vec::new();
            let mut face_verts: Vec<CookVert> = Vec::new();
            for piece in &pieces {
                if piece.len() < 3 {
                    continue;
                }
                let mut piece_idx: Vec<u16> = Vec::with_capacity(piece.len());
                for &p in piece {
                    let q = (round_i16(p.x), round_i16(p.y), round_i16(p.z));
                    let next = (face_verts.len()) as u16;
                    let id = *local.entry(q).or_insert_with(|| {
                        let pr = Vec3::new(q.0 as f32, q.1 as f32, q.2 as f32);
                        let (s, t) = st(pr);
                        let color = sample_light(block, lw, lh, s / 16.0 - bs, t / 16.0 - bt);
                        face_verts.push(CookVert {
                            u: s / tw,
                            v: t / th,
                            color,
                            x: q.0,
                            y: q.1,
                            z: q.2,
                        });
                        next
                    });
                    piece_idx.push(id);
                }
                // Fan-triangulate the (convex) piece, dropping degenerates
                // produced by i16 snapping.
                for i in 1..piece_idx.len() - 1 {
                    let (a, b, c) = (piece_idx[0], piece_idx[i], piece_idx[i + 1]);
                    if a != b && b != c && a != c {
                        tri_indices.extend_from_slice(&[a, b, c]);
                    }
                }
            }
            if tri_indices.is_empty() {
                stats.faces_skipped += 1;
                continue;
            }

            // Append to the open batch for this key, sealing on u16 overflow.
            let key = (tex_idx as u16, kind);
            if let Some(b) = open.get(&key)
                && b.verts.len() + face_verts.len() > u16::MAX as usize
            {
                sealed.push(open.remove(&key).unwrap());
            }
            let b = open.entry(key).or_insert_with(|| BatchAccum {
                texture: tex_idx as u16,
                kind,
                verts: Vec::new(),
                indices: Vec::new(),
                runs: Vec::new(),
            });
            let vbase = b.verts.len() as u16;
            let ibase = b.indices.len() as u32;
            b.verts.extend(face_verts);
            b.indices.extend(tri_indices.iter().map(|i| i + vbase));
            let run_id = if is_world {
                face_idx as u32
            } else {
                ENTITY_RUN
            };
            b.runs.push((run_id, ibase, tri_indices.len() as u16));

            stats.faces_drawn += 1;
            stats.triangles += tri_indices.len() / 3;
        }
    }

    // Seal remaining batches in a deterministic order.
    let mut rest: Vec<BatchAccum> = open.into_values().collect();
    rest.sort_by_key(|b| (b.kind, b.texture));
    sealed.extend(rest);
    sealed.sort_by_key(|b| (b.kind, b.texture));

    // Flatten into the global arrays.
    let mut geo = CookedGeometry {
        verts: Vec::new(),
        indices: Vec::new(),
        batches: Vec::new(),
        faces: (0..bsp.faces.len())
            .map(|_| RawRun {
                batch: 0xffff,
                index_count: 0,
                index_base: 0,
            })
            .collect(),
        always_runs: Vec::new(),
    };
    for b in sealed {
        let batch_id = geo.batches.len() as u16;
        let vert_base = geo.verts.len() as u32;
        let index_base = geo.indices.len() as u32;
        for (face_id, run_base, run_count) in &b.runs {
            let run = RawRun {
                batch: batch_id,
                index_count: *run_count,
                index_base: index_base + run_base,
            };
            if *face_id == ENTITY_RUN {
                geo.always_runs.push(run);
            } else {
                geo.faces[*face_id as usize] = run;
            }
        }
        geo.batches.push(RawBatch {
            texture: b.texture,
            kind: b.kind,
            vert_base,
            vert_count: b.verts.len() as u32,
            index_base,
            index_count: b.indices.len() as u32,
        });
        geo.verts.extend(b.verts);
        geo.indices.extend(b.indices);
    }
    stats.vertices = geo.verts.len();
    Ok(geo)
}

fn round_i16(v: f32) -> i16 {
    v.round().clamp(i16::MIN as f32, i16::MAX as f32) as i16
}

/// Bilinear lightmap sample at luxel-space coordinates, with the GoldSrc
/// 2x overbright folded in. `None` block = fullbright (matches the desktop
/// renderer's treatment of unlit faces).
fn sample_light(block: Option<&[u8]>, w: u32, h: u32, u: f32, v: f32) -> u32 {
    let Some(block) = block else {
        return 0xffff_ffff;
    };
    let texel = |x: u32, y: u32| -> [f32; 3] {
        let i = ((y.min(h - 1) * w + x.min(w - 1)) * 3) as usize;
        [block[i] as f32, block[i + 1] as f32, block[i + 2] as f32]
    };
    let x0 = u.floor().clamp(0.0, (w - 1) as f32);
    let y0 = v.floor().clamp(0.0, (h - 1) as f32);
    let fx = (u - x0).clamp(0.0, 1.0);
    let fy = (v - y0).clamp(0.0, 1.0);
    let (x0, y0) = (x0 as u32, y0 as u32);
    let (a, b) = (texel(x0, y0), texel(x0 + 1, y0));
    let (c, d) = (texel(x0, y0 + 1), texel(x0 + 1, y0 + 1));
    let mut rgb = [0u32; 3];
    for i in 0..3 {
        let top = a[i] + (b[i] - a[i]) * fx;
        let bot = c[i] + (d[i] - c[i]) * fx;
        let val = (top + (bot - top) * fy) * 2.0; // overbright
        rgb[i] = (val.round() as u32).min(255);
    }
    0xff00_0000 | (rgb[2] << 16) | (rgb[1] << 8) | rgb[0]
}

/// GLQuake-style grid subdivision: recursively clip the polygon at world-grid
/// multiples of `size`, so faces sharing an edge split it at identical points
/// (no T-junction cracks after i16 snapping).
fn subdivide_poly(poly: Vec<Vec3>, size: f32, out: &mut Vec<Vec<Vec3>>) {
    const EPS: f32 = 1.0;
    let mut mins = Vec3::splat(f32::MAX);
    let mut maxs = Vec3::splat(f32::MIN);
    for &p in &poly {
        mins = mins.min(p);
        maxs = maxs.max(p);
    }
    for axis in 0..3 {
        if maxs[axis] - mins[axis] <= size {
            continue;
        }
        let mid = (mins[axis] + maxs[axis]) * 0.5;
        let m = size * (mid / size).round();
        if m <= mins[axis] + EPS || m >= maxs[axis] - EPS {
            continue;
        }
        let (front, back) = clip_axis(&poly, axis, m);
        if front.len() >= 3 {
            subdivide_poly(front, size, out);
        }
        if back.len() >= 3 {
            subdivide_poly(back, size, out);
        }
        return;
    }
    out.push(poly);
}

/// Split a convex polygon by the plane `p[axis] = m` (Sutherland-Hodgman,
/// both sides kept; points on the plane go to both).
fn clip_axis(poly: &[Vec3], axis: usize, m: f32) -> (Vec<Vec3>, Vec<Vec3>) {
    let mut front = Vec::with_capacity(poly.len() + 1);
    let mut back = Vec::with_capacity(poly.len() + 1);
    for i in 0..poly.len() {
        let a = poly[i];
        let b = poly[(i + 1) % poly.len()];
        let da = a[axis] - m;
        let db = b[axis] - m;
        if da >= 0.0 {
            front.push(a);
        }
        if da <= 0.0 {
            back.push(a);
        }
        if (da > 0.0 && db < 0.0) || (da < 0.0 && db > 0.0) {
            let t = da / (da - db);
            let p = a + (b - a) * t;
            front.push(p);
            back.push(p);
        }
    }
    (front, back)
}

// ---- Texture cooking -------------------------------------------------------

fn placeholder_indexed(name: &str) -> IndexedTexture {
    let (w, h) = (16u32, 16u32);
    let mut palette = vec![0u8; 768];
    palette[0..3].copy_from_slice(&[200, 0, 200]);
    palette[3..6].copy_from_slice(&[20, 20, 20]);
    let mut mips = Vec::new();
    for level in 0..4u32 {
        let (mw, mh) = ((w >> level).max(1), (h >> level).max(1));
        let mut m = vec![0u8; (mw * mh) as usize];
        for y in 0..mh {
            for x in 0..mw {
                let scale = 8 >> level.min(3);
                let on = ((x / scale.max(1)) + (y / scale.max(1))) % 2 == 0;
                m[(y * mw + x) as usize] = if on { 0 } else { 1 };
            }
        }
        mips.push(m);
    }
    IndexedTexture {
        name: name.to_string(),
        width: w,
        height: h,
        mips,
        palette,
        masked: false,
    }
}

/// Reject the cooker's exact legacy checkerboard in a pre-cooked package.
/// Comparing the entire mip and palette avoids treating arbitrary magenta
/// artwork as a missing texture. Unreferenced texture entries are allowed.
pub fn verify_cooked_textures(map: &cooked::CookedMap<'_>) -> Result<()> {
    let placeholder = placeholder_indexed("");
    let palette: Vec<u8> = placeholder
        .palette
        .chunks_exact(3)
        .flat_map(|rgb| [rgb[0], rgb[1], rgb[2], 255])
        .collect();
    let mips: Vec<_> = placeholder
        .mips
        .iter()
        .enumerate()
        .map(|(level, mip)| swizzle8(mip, 16 >> level, 16 >> level))
        .collect();
    for batch in &map.batches {
        let tex = &map.textures[batch.texture as usize];
        if tex.width == 16
            && tex.height == 16
            && !tex.masked
            && tex.palette == palette
            && tex.mips.len() == mips.len()
            && tex
                .mips
                .iter()
                .zip(&mips)
                .all(|(actual, expected)| *actual == expected)
        {
            bail!(
                "{}: cooked map contains a missing-texture placeholder ({}). Re-cook with complete WAD inputs",
                map.name,
                tex.name
            );
        }
    }
    Ok(())
}

/// Extend the 4 stored mips down to 8x8 (box filter in RGB, requantized to
/// the texture's own palette), swizzle every level, and serialize `WTEX`.
///
/// The GE requires power-of-two dimensions; non-pow2 WAD textures (96x96,
/// 240x240, ...) are resampled to the nearest pow2 (capped at 512) and their
/// mip chain regenerated. UVs are normalized against the *original* dims at
/// geometry time, so the resample is invisible to sampling.
fn cook_textures_section(textures: &[IndexedTexture]) -> Result<Vec<u8>> {
    let mut blobs = Vec::with_capacity(textures.len());
    for tex in textures {
        let (pw, ph) = (nearest_pow2(tex.width), nearest_pow2(tex.height));
        let mut mips: Vec<Vec<u8>> = Vec::new();
        if (pw, ph) == (tex.width, tex.height) {
            for (level, m) in tex.mips.iter().enumerate() {
                let (w, h) = (
                    (tex.width >> level).max(1) as usize,
                    (tex.height >> level).max(1) as usize,
                );
                if m.len() == w * h {
                    mips.push(m.clone());
                }
            }
        } else if tex.mips[0].len() == (tex.width * tex.height) as usize {
            mips.push(resample_indexed(
                &tex.mips[0],
                tex.width as usize,
                tex.height as usize,
                pw as usize,
                ph as usize,
                &tex.palette,
                tex.masked,
            ));
        }
        if mips.is_empty() {
            anyhow::bail!("texture {} has no usable mips", tex.name);
        }
        // Extend the chain (or regenerate it, in the resampled case) while
        // both dims stay >= 8.
        while mips.len() < cooked::MAX_MIPS {
            let level = mips.len() as u32;
            let (w, h) = (pw >> level, ph >> level);
            if w < 8 || h < 8 {
                break;
            }
            let prev = &mips[mips.len() - 1];
            let (lw, lh) = ((pw >> (level - 1)) as usize, (ph >> (level - 1)) as usize);
            mips.push(downsample_indexed(prev, lw, lh, &tex.palette, tex.masked));
        }

        let levels = mips.len();
        let mut blob = Vec::new();
        // Header (64 B).
        let mut name16 = [0u8; 16];
        let nb = tex.name.as_bytes();
        name16[..nb.len().min(16)].copy_from_slice(&nb[..nb.len().min(16)]);
        blob.extend_from_slice(&name16);
        blob.extend_from_slice(&(pw as u16).to_le_bytes());
        blob.extend_from_slice(&(ph as u16).to_le_bytes());
        blob.extend_from_slice(&(levels as u16).to_le_bytes());
        blob.push(u8::from(tex.masked));
        blob.push(0);
        let pal_off_pos = blob.len();
        blob.extend_from_slice(&[0u8; 4]); // pal_off placeholder
        let mip_off_pos = blob.len();
        blob.extend_from_slice(&[0u8; 4 * cooked::MAX_MIPS]);
        blob.extend_from_slice(&[0u8; 4]); // pad to 64
        assert_eq!(blob.len(), cooked::TEX_HEADER);

        // Palette: 256 x RGBA8 in GE CLUT order.
        let pal_off = blob.len() as u32;
        for i in 0..256 {
            let p = i * 3;
            let alpha = if tex.masked && i == 255 { 0u8 } else { 255 };
            blob.extend_from_slice(&[
                tex.palette[p],
                tex.palette[p + 1],
                tex.palette[p + 2],
                alpha,
            ]);
        }
        blob[pal_off_pos..pal_off_pos + 4].copy_from_slice(&pal_off.to_le_bytes());

        // Swizzled mips, each 16-aligned within the blob.
        for (level, m) in mips.iter().enumerate() {
            while blob.len() % 16 != 0 {
                blob.push(0);
            }
            let off = blob.len() as u32;
            blob[mip_off_pos + level * 4..mip_off_pos + level * 4 + 4]
                .copy_from_slice(&off.to_le_bytes());
            let (w, h) = ((pw >> level).max(1) as usize, (ph >> level).max(1) as usize);
            blob.extend_from_slice(&swizzle8(m, w, h));
        }
        blobs.push(blob);
    }

    // Section: count, pad, offset table, 16-aligned blobs.
    let mut out = Vec::new();
    out.extend_from_slice(&(blobs.len() as u32).to_le_bytes());
    out.extend_from_slice(&[0u8; 12]);
    let table_pos = out.len();
    out.extend_from_slice(&vec![0u8; blobs.len() * 4]);
    for (i, blob) in blobs.iter().enumerate() {
        while out.len() % 16 != 0 {
            out.push(0);
        }
        let off = out.len() as u32;
        out[table_pos + i * 4..table_pos + i * 4 + 4].copy_from_slice(&off.to_le_bytes());
        out.extend_from_slice(blob);
    }
    Ok(out)
}

/// Power-of-two policy: always round UP (clamped to the GE's 512 limit) —
/// pow2 conversion must never discard native texel detail. Memory is not
/// the constraint (textures ship as 8-bit CLUT).
fn nearest_pow2(dim: u32) -> u32 {
    dim.clamp(1, 512).next_power_of_two().min(512)
}

/// Bilinear resample of indexed texels (pow2 conversion): sample in RGB
/// space through the palette, requantize to the nearest palette entry.
/// Nearest-neighbor here produced visible duplicated-texel banding on every
/// non-pow2 WAD texture (96x96, 240x240, ...).
fn resample_indexed(
    src: &[u8],
    sw: usize,
    sh: usize,
    dw: usize,
    dh: usize,
    palette: &[u8],
    masked: bool,
) -> Vec<u8> {
    let texel = |x: usize, y: usize| -> (u8, [f32; 3]) {
        let idx = src[y.min(sh - 1) * sw + x.min(sw - 1)];
        let p = idx as usize * 3;
        (
            idx,
            [
                palette[p] as f32,
                palette[p + 1] as f32,
                palette[p + 2] as f32,
            ],
        )
    };
    let mut out = vec![0u8; dw * dh];
    for y in 0..dh {
        for x in 0..dw {
            // Destination texel center mapped into source texel space.
            let su = ((x as f32 + 0.5) * sw as f32 / dw as f32 - 0.5).max(0.0);
            let sv = ((y as f32 + 0.5) * sh as f32 / dh as f32 - 0.5).max(0.0);
            let (x0, y0) = (su as usize, sv as usize);
            let (fx, fy) = (su - x0 as f32, sv - y0 as f32);
            let taps = [
                (texel(x0, y0), (1.0 - fx) * (1.0 - fy)),
                (texel(x0 + 1, y0), fx * (1.0 - fy)),
                (texel(x0, y0 + 1), (1.0 - fx) * fy),
                (texel(x0 + 1, y0 + 1), fx * fy),
            ];
            // Masked textures: transparency wins where it dominates the taps;
            // otherwise blend only the opaque taps.
            let transparent: f32 = taps
                .iter()
                .filter(|((idx, _), _)| masked && *idx == 255)
                .map(|(_, w)| w)
                .sum();
            out[y * dw + x] = if transparent >= 0.5 {
                255
            } else {
                let mut rgb = [0f32; 3];
                let mut total = 0f32;
                for ((idx, c), w) in &taps {
                    if masked && *idx == 255 {
                        continue;
                    }
                    for i in 0..3 {
                        rgb[i] += c[i] * w;
                    }
                    total += w;
                }
                let t = total.max(1e-6);
                nearest_palette(
                    palette,
                    [
                        (rgb[0] / t) as i32,
                        (rgb[1] / t) as i32,
                        (rgb[2] / t) as i32,
                    ],
                    masked,
                )
            };
        }
    }
    out
}

/// 2x2 box downsample of indexed texels via the palette, requantized to the
/// nearest palette entry. Transparent texels (index 255 on masked textures)
/// stay transparent when they dominate the box.
fn downsample_indexed(prev: &[u8], pw: usize, ph: usize, palette: &[u8], masked: bool) -> Vec<u8> {
    let (w, h) = ((pw / 2).max(1), (ph / 2).max(1));
    let mut out = vec![0u8; w * h];
    for y in 0..h {
        for x in 0..w {
            let mut rgb = [0u32; 3];
            let mut opaque = 0u32;
            let mut transparent = 0u32;
            for (dy, dx) in [(0, 0), (0, 1), (1, 0), (1, 1)] {
                let sx = (x * 2 + dx).min(pw - 1);
                let sy = (y * 2 + dy).min(ph - 1);
                let idx = prev[sy * pw + sx] as usize;
                if masked && idx == 255 {
                    transparent += 1;
                    continue;
                }
                opaque += 1;
                rgb[0] += palette[idx * 3] as u32;
                rgb[1] += palette[idx * 3 + 1] as u32;
                rgb[2] += palette[idx * 3 + 2] as u32;
            }
            out[y * w + x] = if transparent >= 2 || opaque == 0 {
                255
            } else {
                let target = [
                    (rgb[0] / opaque) as i32,
                    (rgb[1] / opaque) as i32,
                    (rgb[2] / opaque) as i32,
                ];
                nearest_palette(palette, target, masked)
            };
        }
    }
    out
}

fn nearest_palette(palette: &[u8], target: [i32; 3], masked: bool) -> u8 {
    let mut best = 0u8;
    let mut best_d = i32::MAX;
    let last = if masked { 255 } else { 256 };
    for i in 0..last {
        let dr = palette[i * 3] as i32 - target[0];
        let dg = palette[i * 3 + 1] as i32 - target[1];
        let db = palette[i * 3 + 2] as i32 - target[2];
        let d = dr * dr + dg * dg + db * db;
        if d < best_d {
            best_d = d;
            best = i as u8;
        }
    }
    best
}

/// Swizzle 8bpp texel data into the GE's 16-byte x 8-row block layout,
/// padding stride to 16 bytes and height to a multiple of 8 rows.
pub fn swizzle8(indices: &[u8], w: usize, h: usize) -> Vec<u8> {
    let stride = w.max(16);
    let rows = h.div_ceil(8) * 8;
    let mut linear = vec![0u8; stride * rows];
    for y in 0..h {
        linear[y * stride..y * stride + w].copy_from_slice(&indices[y * w..y * w + w]);
    }
    let mut out = vec![0u8; stride * rows];
    let mut o = 0;
    for by in 0..rows / 8 {
        for bx in 0..stride / 16 {
            for y in 0..8 {
                let s = (by * 8 + y) * stride + bx * 16;
                out[o..o + 16].copy_from_slice(&linear[s..s + 16]);
                o += 16;
            }
        }
    }
    out
}

// ---- Vis / collision / entity sections --------------------------------------

fn cook_vis_section(bsp: &RawBsp) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(&(bsp.nodes.len() as u32).to_le_bytes());
    out.extend_from_slice(&(bsp.leaves.len() as u32).to_le_bytes());
    out.extend_from_slice(&(bsp.marksurfaces.len() as u32).to_le_bytes());
    out.extend_from_slice(&(bsp.visibility.len() as u32).to_le_bytes());
    let visleafs = bsp.models.first().map(|m| m.visleafs).unwrap_or(0) as u32;
    out.extend_from_slice(&visleafs.to_le_bytes());
    out.extend_from_slice(&(bsp.faces.len() as u32).to_le_bytes());
    out.extend_from_slice(&[0u8; 8]);
    for n in &bsp.nodes {
        out.extend_from_slice(&n.plane.to_le_bytes());
        out.extend_from_slice(&n.children[0].to_le_bytes());
        out.extend_from_slice(&n.children[1].to_le_bytes());
    }
    for l in &bsp.leaves {
        out.extend_from_slice(&l.contents.to_le_bytes());
        out.extend_from_slice(&l.vis_offset.to_le_bytes());
        for v in [l.mins, l.maxs] {
            out.extend_from_slice(&round_i16(v.x).to_le_bytes());
            out.extend_from_slice(&round_i16(v.y).to_le_bytes());
            out.extend_from_slice(&round_i16(v.z).to_le_bytes());
        }
        out.extend_from_slice(&l.first_marksurface.to_le_bytes());
        out.extend_from_slice(&l.num_marksurfaces.to_le_bytes());
    }
    for m in &bsp.marksurfaces {
        out.extend_from_slice(&m.to_le_bytes());
    }
    out.extend_from_slice(&bsp.visibility);
    out
}

fn cook_collision_section(bsp: &RawBsp, solids: &[(usize, Vec3)]) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(&(bsp.planes.len() as u32).to_le_bytes());
    out.extend_from_slice(&(bsp.clipnodes.len() as u32).to_le_bytes());
    out.extend_from_slice(&(bsp.models.len() as u32).to_le_bytes());
    out.extend_from_slice(&(solids.len() as u32).to_le_bytes());
    for p in &bsp.planes {
        for f in [p.normal.x, p.normal.y, p.normal.z, p.dist] {
            out.extend_from_slice(&f.to_le_bytes());
        }
    }
    for c in &bsp.clipnodes {
        out.extend_from_slice(&c.plane.to_le_bytes());
        out.extend_from_slice(&c.children[0].to_le_bytes());
        out.extend_from_slice(&c.children[1].to_le_bytes());
    }
    for m in &bsp.models {
        for f in [m.origin.x, m.origin.y, m.origin.z] {
            out.extend_from_slice(&f.to_le_bytes());
        }
        for h in m.headnodes {
            out.extend_from_slice(&h.to_le_bytes());
        }
        out.extend_from_slice(&[0u8; 4]);
    }
    for &(model, offset) in solids {
        out.extend_from_slice(&(model as u32).to_le_bytes());
        for f in [offset.x, offset.y, offset.z] {
            out.extend_from_slice(&f.to_le_bytes());
        }
    }
    out
}

fn cook_entities_section(bsp: &RawBsp, ents: &[crate::entities::Entity], name: &str) -> Vec<u8> {
    let mut ct = Vec::new();
    let mut t = Vec::new();
    for e in ents {
        let list = match e.classname() {
            "info_player_start" => &mut ct,
            "info_player_deathmatch" => &mut t,
            _ => continue,
        };
        if let Some(pos) = e.origin() {
            list.push(SpawnPoint {
                pos,
                yaw: e.yaw().unwrap_or(0.0),
            });
        }
    }
    let sun = ents
        .iter()
        .find(|e| e.classname() == "light_environment")
        .and_then(parse_sun);
    let bounds = bsp
        .models
        .first()
        .map(|m| (m.mins, m.maxs))
        .unwrap_or((Vec3::splat(-4096.0), Vec3::splat(4096.0)));

    let mut out = Vec::new();
    out.extend_from_slice(&(ct.len() as u32).to_le_bytes());
    out.extend_from_slice(&(t.len() as u32).to_le_bytes());
    out.extend_from_slice(&u32::from(sun.is_some()).to_le_bytes());
    out.extend_from_slice(&[0u8; 4]);
    let sun_dir = sun.map(|s| s.dir).unwrap_or(Vec3::Y);
    let sun_color = sun.map(|s| s.color).unwrap_or(Vec3::ONE);
    for v in [sun_dir, sun_color, bounds.0, bounds.1] {
        for f in [v.x, v.y, v.z, 0.0f32] {
            out.extend_from_slice(&f.to_le_bytes());
        }
    }
    let mut name16 = [0u8; 16];
    let nb = name.as_bytes();
    name16[..nb.len().min(16)].copy_from_slice(&nb[..nb.len().min(16)]);
    out.extend_from_slice(&name16);
    for s in ct.iter().chain(t.iter()) {
        for f in [s.pos.x, s.pos.y, s.pos.z, s.yaw] {
            out.extend_from_slice(&f.to_le_bytes());
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn texture_fixture(name: &str) -> RawBsp {
        let mut header = vec![0; 4 + 15 * 8];
        header[..4].copy_from_slice(&30i32.to_le_bytes());
        let mut bsp = raw::parse(&header).unwrap();
        bsp.planes.push(crate::types::Plane {
            normal: Vec3::Y,
            dist: 0.0,
        });
        bsp.textures.push(raw::MipTexEntry {
            name: name.into(),
            width: 16,
            height: 16,
            embedded: None,
        });
        bsp.vertices = vec![Vec3::ZERO, Vec3::X * 16.0, Vec3::Z * 16.0];
        bsp.edges = vec![[0, 1], [1, 2], [2, 0]];
        bsp.surfedges = vec![0, 1, 2];
        bsp.texinfos.push(raw::TexInfo {
            s: Vec3::X,
            s_shift: 0.0,
            t: Vec3::Z,
            t_shift: 0.0,
            miptex: 0,
            flags: 0,
        });
        bsp.faces.push(raw::Face {
            plane: 0,
            plane_side: 0,
            first_edge: 0,
            num_edges: 3,
            texinfo: 0,
            styles: [255; 4],
            lightmap_offset: -1,
        });
        bsp.leaves.push(crate::types::Leaf {
            contents: -1,
            vis_offset: -1,
            mins: Vec3::ZERO,
            maxs: Vec3::splat(16.0),
            first_marksurface: 0,
            num_marksurfaces: 0,
        });
        bsp.models.push(crate::types::Model {
            mins: Vec3::ZERO,
            maxs: Vec3::splat(16.0),
            origin: Vec3::ZERO,
            headnodes: [-1; 4],
            visleafs: 0,
            first_face: 0,
            num_faces: 1,
        });
        bsp
    }

    #[test]
    fn missing_visible_texture_fails_cooking_and_legacy_package_verification() {
        let bsp = texture_fixture("warehouse");
        let err =
            cook_parsed(&bsp, "fixture", &WadSet::new(), &CookOptions::default()).unwrap_err();
        assert!(err.to_string().contains("warehouse"));
        assert!(err.to_string().contains("--wads"));
        let opts = CookOptions {
            allow_missing_textures: true,
            ..CookOptions::default()
        };
        let (bytes, _) = cook_parsed(&bsp, "fixture", &WadSet::new(), &opts).unwrap();
        let mut map = cooked::read(&bytes).unwrap();
        assert!(verify_cooked_textures(&map).is_err());
        // A real magenta texture is not rejected just because of its color.
        let mut palette = map.textures[0].palette.to_vec();
        palette[8] = 42;
        map.textures[0].palette = &palette;
        assert!(verify_cooked_textures(&map).is_ok());
    }

    #[test]
    fn tool_sky_and_unused_textures_do_not_require_wads() {
        for name in ["sky", "clip", "aaatrigger"] {
            let bsp = texture_fixture(name);
            let (bytes, _) =
                cook_parsed(&bsp, "fixture", &WadSet::new(), &CookOptions::default()).unwrap();
            assert!(verify_cooked_textures(&cooked::read(&bytes).unwrap()).is_ok());
        }
        let mut bsp = texture_fixture("unused");
        bsp.models[0].num_faces = 0;
        assert!(cook_parsed(&bsp, "fixture", &WadSet::new(), &CookOptions::default()).is_ok());
    }

    #[test]
    fn swizzle_roundtrip_block_layout() {
        // 32x8: two 16-byte-wide blocks side by side.
        let (w, h) = (32usize, 8usize);
        let src: Vec<u8> = (0..w * h).map(|i| (i % 256) as u8).collect();
        let sw = swizzle8(&src, w, h);
        assert_eq!(sw.len(), 32 * 8);
        // First block = left 16 columns of all 8 rows, row-major.
        for y in 0..8 {
            assert_eq!(&sw[y * 16..y * 16 + 16], &src[y * 32..y * 32 + 16]);
        }
        // Second block follows with the right 16 columns.
        for y in 0..8 {
            assert_eq!(
                &sw[128 + y * 16..128 + y * 16 + 16],
                &src[y * 32 + 16..y * 32 + 32]
            );
        }
    }

    #[test]
    fn swizzle_pads_narrow_and_short() {
        // 8x4 pads to 16-byte stride, 8 rows.
        let sw = swizzle8(&[7u8; 32], 8, 4);
        assert_eq!(sw.len(), 16 * 8);
        assert_eq!(sw[0], 7);
        assert_eq!(sw[8], 0); // padding column
    }

    #[test]
    fn subdivision_shares_grid_planes() {
        // Two rectangles meeting at x=100 must both split at x=96 (the
        // grid multiple), producing identical edge points.
        let left = vec![
            Vec3::new(0.0, 0.0, 0.0),
            Vec3::new(100.0, 0.0, 0.0),
            Vec3::new(100.0, 0.0, 50.0),
            Vec3::new(0.0, 0.0, 50.0),
        ];
        let right = vec![
            Vec3::new(100.0, 0.0, 0.0),
            Vec3::new(220.0, 0.0, 0.0),
            Vec3::new(220.0, 0.0, 50.0),
            Vec3::new(100.0, 0.0, 50.0),
        ];
        let mut l_pieces = Vec::new();
        let mut r_pieces = Vec::new();
        subdivide_poly(left, 96.0, &mut l_pieces);
        subdivide_poly(right, 96.0, &mut r_pieces);
        let on_plane = |pieces: &[Vec<Vec3>], x: f32| -> Vec<(i32, i32)> {
            let mut pts: Vec<(i32, i32)> = pieces
                .iter()
                .flatten()
                .filter(|p| (p.x - x).abs() < 1e-3)
                .map(|p| (p.y.round() as i32, p.z.round() as i32))
                .collect();
            pts.sort();
            pts.dedup();
            pts
        };
        // Left rect got split at 96 (its extent is 100 > 96).
        assert!(!on_plane(&l_pieces, 96.0).is_empty());
        // The right rect splits at 192 but must NOT introduce points on the
        // shared boundary x=100 beyond its own corners.
        let shared = on_plane(&r_pieces, 100.0);
        assert_eq!(shared, vec![(0, 0), (0, 50)]);
    }

    #[test]
    fn sample_light_bilinear_and_overbright() {
        // 2x1 block: 60 and 120 -> doubled to 120 and 240.
        let data: Vec<u8> = vec![60, 60, 60, 120, 120, 120];
        let c0 = sample_light(Some(&data), 2, 1, 0.0, 0.0);
        assert_eq!(c0 & 0xff, 120);
        let mid = sample_light(Some(&data), 2, 1, 0.5, 0.0);
        assert_eq!(mid & 0xff, 180);
        assert_eq!(sample_light(None, 2, 1, 0.0, 0.0), 0xffff_ffff);
    }
}
