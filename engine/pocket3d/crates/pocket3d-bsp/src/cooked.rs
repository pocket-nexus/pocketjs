//! The cooked map container (`.p3d`) — a GoldSrc map pre-baked for
//! constrained runtimes, laid out for zero-copy GPU consumption.
//!
//! A `.p3d` embedded in a PSP EBOOT is consumed in place: vertex buffers,
//! u16 index pools, swizzled CLUT8 texel data and palettes are read by the
//! GE directly out of `.rodata` (after one dcache writeback), so a map costs
//! its file size in RAM and nothing more. Small CPU-side structures
//! (collision hulls, PVS, the face table) are parsed into the allocator at
//! load. The writer lives behind the `std` feature (used by `pocket3d-cook`);
//! the reader is no_std.
//!
//! Layout: a 16-byte header (`P3D1`, version, section count), a section
//! table of `(tag, offset, len)` entries, then 16-byte-aligned section
//! payloads. All integers little-endian. Section order is not significant;
//! unknown tags are ignored (the format grows by appending sections).
//!
//! World sections:
//! - `WVTX` — 20 B/vertex, GE component order: `u,v: f32`, `color: u32 ABGR`
//!   (baked lighting), `x,y,z: i16` (Y-up world units), `i16` pad.
//! - `WIDX` — u16 triangle indices, relative to each batch's `vert_base`.
//! - `WBAT` — draw batches keyed by (texture, kind).
//! - `WFAC` — per-BSP-face index runs for PVS splicing (0xffff = not drawn).
//! - `WRUN` — brush-entity runs, drawn every frame (not in any leaf's PVS).
//! - `WTEX` — swizzled CLUT8 textures + RGBA8 palettes + mip chains.
//! - `WVIS` — render BSP nodes/leaves, marksurfaces, compressed PVS.
//! - `WCLP` — plane table, clipnodes, model hulls, solid entity registry.
//! - `WENT` — spawns, sun light, map bounds.

use alloc::string::String;
use alloc::vec;
use alloc::vec::Vec;

use glam::Vec3;

use crate::trace::{MapCollision, ModelHulls, make_hull0_with};
use crate::types::{Leaf, Node, Plane, SpawnPoint, SunLight, SurfaceKind};
use crate::vis::VisData;

pub mod bounds;
pub mod cluster;
pub mod strip;
pub mod texture_cache;

#[cfg(target_endian = "big")]
compile_error!("the .p3d reader assumes a little-endian target");

pub const MAGIC: [u8; 4] = *b"P3D1";
pub const VERSION: u32 = 1;

pub const fn tag(name: &[u8; 4]) -> u32 {
    u32::from_le_bytes(*name)
}

pub const TAG_WVTX: u32 = tag(b"WVTX");
pub const TAG_WIDX: u32 = tag(b"WIDX");
pub const TAG_WBAT: u32 = tag(b"WBAT");
pub const TAG_WFAC: u32 = tag(b"WFAC");
pub const TAG_WRUN: u32 = tag(b"WRUN");
pub const TAG_WTEX: u32 = tag(b"WTEX");
pub const TAG_WVIS: u32 = tag(b"WVIS");
pub const TAG_WCLP: u32 = tag(b"WCLP");
pub const TAG_WENT: u32 = tag(b"WENT");
pub const TAG_WSKY: u32 = tag(b"WSKY");

pub const VERTEX_STRIDE: usize = 20;
/// Batch record size in `WBAT` (after the count word).
pub const BATCH_STRIDE: usize = 20;
/// Face/run record size in `WFAC`/`WRUN` (after the count word).
pub const RUN_STRIDE: usize = 8;
/// Texture blob header size in `WTEX`.
pub const TEX_HEADER: usize = 64;
pub const MAX_MIPS: usize = 8;

/// Row stride in bytes for one mip level of a CLUT8 texture (the GE swizzle
/// block is 16 bytes wide, so narrow mips pad up).
pub fn mip_stride(width: u32, level: u32) -> usize {
    ((width >> level).max(1) as usize).max(16)
}

/// Padded row count for one mip level (swizzle blocks are 8 rows tall).
pub fn mip_rows(height: u32, level: u32) -> usize {
    ((height >> level).max(1) as usize).div_ceil(8) * 8
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TextureDecodeError {
    MissingLevelZero,
    TruncatedSwizzle,
    TruncatedPalette,
    SizeOverflow,
}

/// Unswizzle and palette-expand a cooked texture's first mip into RGBA8.
///
/// The `.p3d` texture layout is shared by every constrained backend, so this
/// format operation lives next to the reader rather than in a specific GPU
/// implementation. Transparent palette entries have RGB cleared to prevent
/// bilinear filtering from bleeding arbitrary cutout colors into their edge.
pub fn expand_level0_rgba(texture: &CookedTexture<'_>) -> Result<Vec<u8>, TextureDecodeError> {
    let source = texture
        .mips
        .first()
        .copied()
        .ok_or(TextureDecodeError::MissingLevelZero)?;
    if texture.palette.len() < 256 * 4 {
        return Err(TextureDecodeError::TruncatedPalette);
    }

    let width = texture.width.max(1) as usize;
    let height = texture.height.max(1) as usize;
    let stride = mip_stride(texture.width.max(1), 0);
    let rows = mip_rows(texture.height.max(1), 0);
    let expected = stride
        .checked_mul(rows)
        .ok_or(TextureDecodeError::SizeOverflow)?;
    if source.len() < expected {
        return Err(TextureDecodeError::TruncatedSwizzle);
    }
    let pixel_count = width
        .checked_mul(height)
        .ok_or(TextureDecodeError::SizeOverflow)?;
    let mut rgba = vec![
        0u8;
        pixel_count
            .checked_mul(4)
            .ok_or(TextureDecodeError::SizeOverflow)?
    ];

    let mut source_offset = 0usize;
    for block_y in 0..rows / 8 {
        for block_x in 0..stride / 16 {
            for row in 0..8 {
                let y = block_y * 8 + row;
                for column in 0..16 {
                    let x = block_x * 16 + column;
                    let palette_index = source[source_offset + column] as usize;
                    if x < width && y < height {
                        let palette = &texture.palette[palette_index * 4..palette_index * 4 + 4];
                        let destination = (y * width + x) * 4;
                        rgba[destination..destination + 4].copy_from_slice(palette);
                        if palette[3] == 0 {
                            rgba[destination..destination + 3].fill(0);
                        }
                    }
                }
                source_offset += 16;
            }
        }
    }
    Ok(rgba)
}

#[derive(Clone, Copy, Debug)]
pub struct BatchDesc {
    pub texture: u16,
    pub kind: SurfaceKind,
    /// First vertex of this batch in `WVTX`; indices are relative to it.
    pub vert_base: u32,
    pub vert_count: u32,
    /// This batch's contiguous region of `WIDX` (validation / whole-batch draws).
    pub index_base: u32,
    pub index_count: u32,
}

/// One face's (or entity run's) triangles: a contiguous u16 index range.
#[derive(Clone, Copy, Debug)]
pub struct FaceRun {
    /// Batch index, or `0xffff` when the face isn't drawn (sky, tool faces).
    pub batch: u16,
    pub index_count: u16,
    pub index_base: u32,
}

pub struct CookedTexture<'a> {
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub levels: u32,
    /// Palette index 255 is transparent (alpha-tested `{` textures).
    pub masked: bool,
    /// 256 RGBA8 entries in GE CLUT order (1 KB).
    pub palette: &'a [u8],
    /// Swizzled CLUT8 texel data per mip level.
    pub mips: Vec<&'a [u8]>,
}

/// A parsed cooked map. Bulk GPU data borrows from the source bytes;
/// CPU-side structures are owned.
pub struct CookedMap<'a> {
    pub name: String,
    pub verts: &'a [u8],
    pub vert_count: u32,
    pub indices: &'a [u16],
    pub batches: Vec<BatchDesc>,
    /// Indexed by BSP face id (parallel to `vis` marksurface values).
    pub faces: Vec<FaceRun>,
    /// Brush-entity geometry, drawn unconditionally.
    pub always_runs: Vec<FaceRun>,
    pub textures: Vec<CookedTexture<'a>>,
    pub vis: VisData,
    pub collision: MapCollision,
    pub ct_spawns: Vec<SpawnPoint>,
    pub t_spawns: Vec<SpawnPoint>,
    pub sun: Option<SunLight>,
    pub sky: Option<crate::types::SkyColors>,
    pub bounds: (Vec3, Vec3),
}

pub type ReadError = &'static str;

struct Rd<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> Rd<'a> {
    fn new(data: &'a [u8]) -> Self {
        Self { data, pos: 0 }
    }
    fn bytes(&mut self, n: usize) -> Result<&'a [u8], ReadError> {
        let end = self.pos.checked_add(n).ok_or("overflow")?;
        let s = self.data.get(self.pos..end).ok_or("truncated section")?;
        self.pos = end;
        Ok(s)
    }
    fn u8v(&mut self) -> Result<u8, ReadError> {
        Ok(self.bytes(1)?[0])
    }
    fn u16v(&mut self) -> Result<u16, ReadError> {
        Ok(u16::from_le_bytes(self.bytes(2)?.try_into().unwrap()))
    }
    fn i16v(&mut self) -> Result<i16, ReadError> {
        Ok(i16::from_le_bytes(self.bytes(2)?.try_into().unwrap()))
    }
    fn u32v(&mut self) -> Result<u32, ReadError> {
        Ok(u32::from_le_bytes(self.bytes(4)?.try_into().unwrap()))
    }
    fn i32v(&mut self) -> Result<i32, ReadError> {
        Ok(i32::from_le_bytes(self.bytes(4)?.try_into().unwrap()))
    }
    fn f32v(&mut self) -> Result<f32, ReadError> {
        Ok(f32::from_le_bytes(self.bytes(4)?.try_into().unwrap()))
    }
    fn vec3(&mut self) -> Result<Vec3, ReadError> {
        Ok(Vec3::new(self.f32v()?, self.f32v()?, self.f32v()?))
    }
}

fn u16_slice(bytes: &[u8]) -> Result<&[u16], ReadError> {
    if !(bytes.as_ptr() as usize).is_multiple_of(2) {
        return Err("unaligned u16 section");
    }
    if !bytes.len().is_multiple_of(2) {
        return Err("odd-length u16 section");
    }
    // Safety: alignment and length checked; u16 has no invalid bit patterns;
    // the target is little-endian (compile-checked above).
    Ok(unsafe { core::slice::from_raw_parts(bytes.as_ptr() as *const u16, bytes.len() / 2) })
}

fn trimmed_name(raw: &[u8]) -> String {
    let end = raw.iter().position(|&c| c == 0).unwrap_or(raw.len());
    String::from_utf8_lossy(&raw[..end]).into_owned()
}

/// Parse a `.p3d`. `data` must stay alive as long as the map (GPU sections
/// are borrowed, not copied) and should be 16-byte aligned so vertex/index
/// pointers meet GE alignment requirements.
pub fn read(data: &[u8]) -> Result<CookedMap<'_>, ReadError> {
    let mut r = Rd::new(data);
    if r.bytes(4)? != MAGIC {
        return Err("not a .p3d file (bad magic)");
    }
    if r.u32v()? != VERSION {
        return Err("unsupported .p3d version");
    }
    let section_count = r.u32v()? as usize;
    let _pad = r.u32v()?;
    let section = |want: u32| -> Result<Option<&[u8]>, ReadError> {
        let mut tr = Rd::new(data);
        tr.pos = 16;
        for _ in 0..section_count {
            let t = tr.u32v()?;
            let off = tr.u32v()? as usize;
            let len = tr.u32v()? as usize;
            let _ = tr.u32v()?;
            if t == want {
                let end = off.checked_add(len).ok_or("overflow")?;
                return Ok(Some(data.get(off..end).ok_or("section out of range")?));
            }
        }
        Ok(None)
    };
    fn need(s: Option<&[u8]>) -> Result<&[u8], ReadError> {
        s.ok_or("missing required section")
    }

    // WVTX / WIDX — borrowed in place.
    let verts = need(section(TAG_WVTX)?)?;
    if verts.len() % VERTEX_STRIDE != 0 {
        return Err("WVTX size not a multiple of the vertex stride");
    }
    let vert_count = (verts.len() / VERTEX_STRIDE) as u32;
    let indices = u16_slice(need(section(TAG_WIDX)?)?)?;

    // WBAT.
    let mut batches = Vec::new();
    {
        let mut r = Rd::new(need(section(TAG_WBAT)?)?);
        let n = r.u32v()? as usize;
        for _ in 0..n {
            let texture = r.u16v()?;
            let kind = SurfaceKind::from_u8(r.u8v()?).ok_or("bad surface kind")?;
            let _pad = r.u8v()?;
            let vert_base = r.u32v()?;
            let vert_count_b = r.u32v()?;
            let index_base = r.u32v()?;
            let index_count = r.u32v()?;
            let vert_end = vert_base
                .checked_add(vert_count_b)
                .ok_or("batch vertex range overflow")?;
            if vert_end > vert_count {
                return Err("batch vertex range out of bounds");
            }
            let index_end = index_base
                .checked_add(index_count)
                .ok_or("batch index range overflow")?;
            if index_count % 3 != 0 {
                return Err("batch index count is not a triangle list");
            }
            if index_end as usize > indices.len() {
                return Err("batch index range out of bounds");
            }
            if indices[index_base as usize..index_end as usize]
                .iter()
                .any(|&index| index as u32 >= vert_count_b)
            {
                return Err("batch index references a vertex out of bounds");
            }
            batches.push(BatchDesc {
                texture,
                kind,
                vert_base,
                vert_count: vert_count_b,
                index_base,
                index_count,
            });
        }
    }

    let read_runs = |bytes: &[u8]| -> Result<Vec<FaceRun>, ReadError> {
        let mut r = Rd::new(bytes);
        let n = r.u32v()? as usize;
        let mut out = Vec::with_capacity(n);
        for _ in 0..n {
            let batch = r.u16v()?;
            let index_count = r.u16v()?;
            let index_base = r.u32v()?;
            if batch != 0xffff {
                if batch as usize >= batches.len() {
                    return Err("run references missing batch");
                }
                let batch_desc = &batches[batch as usize];
                let index_end = index_base
                    .checked_add(index_count as u32)
                    .ok_or("run index range overflow")?;
                let batch_index_end = batch_desc
                    .index_base
                    .checked_add(batch_desc.index_count)
                    .ok_or("batch index range overflow")?;
                if index_count % 3 != 0 {
                    return Err("run index count is not a triangle list");
                }
                if index_base < batch_desc.index_base || index_end > batch_index_end {
                    return Err("run index range escapes its batch");
                }
                if index_end as usize > indices.len() {
                    return Err("run index range out of bounds");
                }
            }
            out.push(FaceRun {
                batch,
                index_count,
                index_base,
            });
        }
        Ok(out)
    };
    let faces = read_runs(need(section(TAG_WFAC)?)?)?;
    let always_runs = read_runs(need(section(TAG_WRUN)?)?)?;

    // WTEX.
    let mut textures = Vec::new();
    {
        let sect = need(section(TAG_WTEX)?)?;
        let mut r = Rd::new(sect);
        let n = r.u32v()? as usize;
        let _pad = r.bytes(12)?;
        let mut offsets = Vec::with_capacity(n);
        for _ in 0..n {
            offsets.push(r.u32v()? as usize);
        }
        for off in offsets {
            let blob = sect.get(off..).ok_or("texture blob out of range")?;
            let mut h = Rd::new(blob);
            let name = trimmed_name(h.bytes(16)?);
            let width = h.u16v()? as u32;
            let height = h.u16v()? as u32;
            let levels = h.u16v()? as u32;
            let flags = h.u8v()?;
            let _pad = h.u8v()?;
            let pal_off = h.u32v()? as usize;
            let mut mip_off = [0usize; MAX_MIPS];
            for m in &mut mip_off {
                *m = h.u32v()? as usize;
            }
            if levels == 0 || levels as usize > MAX_MIPS {
                return Err("bad texture mip count");
            }
            let palette = blob.get(pal_off..pal_off + 1024).ok_or("palette range")?;
            let mut mips = Vec::with_capacity(levels as usize);
            for l in 0..levels {
                let size = mip_stride(width, l) * mip_rows(height, l);
                let o = mip_off[l as usize];
                mips.push(blob.get(o..o + size).ok_or("mip range")?);
            }
            textures.push(CookedTexture {
                name,
                width,
                height,
                levels,
                masked: flags & 1 != 0,
                palette,
                mips,
            });
        }
    }
    for b in &batches {
        if b.texture as usize >= textures.len() {
            return Err("batch references missing texture");
        }
    }

    // WVIS.
    let (vis, leaf_contents);
    {
        let mut r = Rd::new(need(section(TAG_WVIS)?)?);
        let node_count = r.u32v()? as usize;
        let leaf_count = r.u32v()? as usize;
        let mark_count = r.u32v()? as usize;
        let vis_len = r.u32v()? as usize;
        let num_visleaves = r.u32v()? as usize;
        let face_count = r.u32v()? as usize;
        let _pad = r.bytes(8)?;
        if face_count != faces.len() {
            return Err("WVIS face count disagrees with WFAC");
        }
        let mut nodes = Vec::with_capacity(node_count);
        for _ in 0..node_count {
            let plane = r.u32v()?;
            let children = [r.i16v()?, r.i16v()?];
            nodes.push(Node { plane, children });
        }
        let mut leaves = Vec::with_capacity(leaf_count);
        for _ in 0..leaf_count {
            let contents = r.i32v()?;
            let vis_offset = r.i32v()?;
            let mins = Vec3::new(r.i16v()? as f32, r.i16v()? as f32, r.i16v()? as f32);
            let maxs = Vec3::new(r.i16v()? as f32, r.i16v()? as f32, r.i16v()? as f32);
            let first_marksurface = r.u16v()?;
            let num_marksurfaces = r.u16v()?;
            leaves.push(Leaf {
                contents,
                vis_offset,
                mins,
                maxs,
                first_marksurface,
                num_marksurfaces,
            });
        }
        let mut marksurfaces = Vec::with_capacity(mark_count);
        for _ in 0..mark_count {
            let f = r.u16v()?;
            if f as usize >= faces.len() {
                return Err("marksurface out of face range");
            }
            marksurfaces.push(f);
        }
        let visibility = r.bytes(vis_len)?.to_vec();
        leaf_contents = leaves.iter().map(|l| l.contents).collect::<Vec<_>>();
        vis = VisData {
            nodes,
            leaves,
            marksurfaces,
            visibility,
            num_visleaves,
        };
    }

    // WCLP → MapCollision (hull 0 synthesized from the render tree).
    let collision;
    {
        let mut r = Rd::new(need(section(TAG_WCLP)?)?);
        let plane_count = r.u32v()? as usize;
        let clipnode_count = r.u32v()? as usize;
        let model_count = r.u32v()? as usize;
        let solid_count = r.u32v()? as usize;
        let mut planes = Vec::with_capacity(plane_count);
        for _ in 0..plane_count {
            let normal = r.vec3()?;
            let dist = r.f32v()?;
            planes.push(Plane { normal, dist });
        }
        let mut clipnodes = Vec::with_capacity(clipnode_count);
        for _ in 0..clipnode_count {
            let plane = r.u32v()?;
            let children = [r.i32v()?, r.i32v()?];
            clipnodes.push(crate::types::ClipNode { plane, children });
        }
        let mut models = Vec::with_capacity(model_count);
        for _ in 0..model_count {
            let origin = r.vec3()?;
            let headnodes = [r.i32v()?, r.i32v()?, r.i32v()?, r.i32v()?];
            let _pad = r.u32v()?;
            models.push(ModelHulls { headnodes, origin });
        }
        let mut solids = Vec::with_capacity(solid_count);
        for _ in 0..solid_count {
            let model = r.u32v()? as usize;
            let offset = r.vec3()?;
            solids.push((model, offset));
        }
        let hull0 = make_hull0_with(&vis.nodes, |i| {
            leaf_contents
                .get(i)
                .copied()
                .unwrap_or(crate::types::CONTENTS_SOLID)
        });
        collision = MapCollision::from_parts(planes, hull0, clipnodes, models, solids);
    }

    // WENT.
    let mut ct_spawns = Vec::new();
    let mut t_spawns = Vec::new();
    let sun;
    let bounds;
    let name;
    {
        let mut r = Rd::new(need(section(TAG_WENT)?)?);
        let ct = r.u32v()? as usize;
        let t = r.u32v()? as usize;
        let flags = r.u32v()?;
        let _pad = r.u32v()?;
        let sun_dir = r.vec3()?;
        let _ = r.f32v()?;
        let sun_color = r.vec3()?;
        let _ = r.f32v()?;
        let mins = r.vec3()?;
        let _ = r.f32v()?;
        let maxs = r.vec3()?;
        let _ = r.f32v()?;
        name = trimmed_name(r.bytes(16)?);
        bounds = (mins, maxs);
        sun = (flags & 1 != 0).then_some(SunLight {
            dir: sun_dir,
            color: sun_color,
        });
        for _ in 0..ct {
            let pos = r.vec3()?;
            let yaw = r.f32v()?;
            ct_spawns.push(SpawnPoint { pos, yaw });
        }
        for _ in 0..t {
            let pos = r.vec3()?;
            let yaw = r.f32v()?;
            t_spawns.push(SpawnPoint { pos, yaw });
        }
    }

    let sky = if let Some(bytes) = section(TAG_WSKY)? {
        if bytes.len() != 24 {
            return Err("invalid sky section length");
        }
        let mut r = Rd::new(bytes);
        let zenith = r.vec3()?;
        let horizon = r.vec3()?;
        for value in [
            zenith.x, zenith.y, zenith.z, horizon.x, horizon.y, horizon.z,
        ] {
            if !value.is_finite() || !(0.0..=1.0).contains(&value) {
                return Err("invalid sky color");
            }
        }
        Some(crate::types::SkyColors { zenith, horizon })
    } else {
        None
    };
    Ok(CookedMap {
        sky,
        name,
        verts,
        vert_count,
        indices,
        batches,
        faces,
        always_runs,
        textures,
        vis,
        collision,
        ct_spawns,
        t_spawns,
        sun,
        bounds,
    })
}

/// Section-table writer for the cooker.
#[cfg(feature = "std")]
pub struct P3dWriter {
    sections: Vec<(u32, Vec<u8>)>,
}

#[cfg(feature = "std")]
impl P3dWriter {
    pub fn new() -> Self {
        Self {
            sections: Vec::new(),
        }
    }

    pub fn section(&mut self, tag: u32, payload: Vec<u8>) {
        self.sections.push((tag, payload));
    }

    pub fn finish(self) -> Vec<u8> {
        let table_end = 16 + self.sections.len() * 16;
        let mut out = Vec::new();
        out.extend_from_slice(&MAGIC);
        out.extend_from_slice(&VERSION.to_le_bytes());
        out.extend_from_slice(&(self.sections.len() as u32).to_le_bytes());
        out.extend_from_slice(&0u32.to_le_bytes());

        // Lay out payload offsets (16-aligned), then write the table.
        let mut offset = table_end.div_ceil(16) * 16;
        for (tag, payload) in &self.sections {
            out.extend_from_slice(&tag.to_le_bytes());
            out.extend_from_slice(&(offset as u32).to_le_bytes());
            out.extend_from_slice(&(payload.len() as u32).to_le_bytes());
            out.extend_from_slice(&0u32.to_le_bytes());
            offset += payload.len().div_ceil(16) * 16;
        }
        for (_, payload) in &self.sections {
            while out.len() % 16 != 0 {
                out.push(0);
            }
            out.extend_from_slice(payload);
        }
        while out.len() % 16 != 0 {
            out.push(0);
        }
        out
    }
}

#[cfg(feature = "std")]
impl Default for P3dWriter {
    fn default() -> Self {
        Self::new()
    }
}
