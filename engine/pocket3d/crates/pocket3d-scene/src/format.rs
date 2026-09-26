//! The `.p3sn` container: a 16-byte header, a section table, and 16-byte
//! aligned payloads. Every integer is little-endian. Unknown section tags are
//! ignored, so the format grows by appending sections.
//!
//! The reader borrows the file bytes and copies only the small CPU-side record
//! tables. Vertex and index payloads stay as byte slices a backend hands
//! straight to the GPU, so an embedded scene costs its file size and nothing
//! more.

use alloc::vec::Vec;

use glam::{Quat, Vec3};

/// `[u: f32][v: f32][lit: u32 ABGR][fog: u32 ABGR][x, y, z: i16][pad: i16]`.
///
/// One stream feeds three passes. A backend points its albedo vertex program
/// at `uv` + `position`, its multiply program at `lit` + `position`, and its
/// additive program at `fog` + `position`, all with this stride.
pub const VERTEX_STRIDE: usize = 24;
pub const VERTEX_UV_OFFSET: usize = 0;
pub const VERTEX_LIT_OFFSET: usize = 8;
pub const VERTEX_FOG_OFFSET: usize = 12;
pub const VERTEX_POSITION_OFFSET: usize = 16;

pub const MAGIC: [u8; 4] = *b"P3SN";
pub const VERSION: u32 = 1;

const HEADER_BYTES: usize = 16;
const SECTION_ENTRY_BYTES: usize = 12;
pub const ALIGNMENT: usize = 16;

pub const fn tag(name: &[u8; 4]) -> u32 {
    u32::from_le_bytes(*name)
}

pub const TAG_SHDR: u32 = tag(b"SHDR");
pub const TAG_SMAT: u32 = tag(b"SMAT");
pub const TAG_STEX: u32 = tag(b"STEX");
pub const TAG_SVTX: u32 = tag(b"SVTX");
pub const TAG_SIDX: u32 = tag(b"SIDX");
pub const TAG_SCHK: u32 = tag(b"SCHK");
pub const TAG_SOBJ: u32 = tag(b"SOBJ");
pub const TAG_SRIV: u32 = tag(b"SRIV");
pub const TAG_SSCT: u32 = tag(b"SSCT");
pub const TAG_SWAT: u32 = tag(b"SWAT");
pub const TAG_SROL: u32 = tag(b"SROL");

pub const HEADER_RECORD_BYTES: usize = 164;
pub const MATERIAL_RECORD_BYTES: usize = 12;
pub const TEXTURE_RECORD_BYTES: usize = 16;
pub const CHUNK_RECORD_BYTES: usize = 48;
pub const OBJECT_RECORD_BYTES: usize = 32;
pub const RIVER_RECORD_BYTES: usize = 16;
pub const SCATTER_RECORD_BYTES: usize = 32;
pub const WATER_RECORD_BYTES: usize = 60;
pub const ROLE_RECORD_BYTES: usize = 4;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SceneError {
    TooSmall,
    BadMagic,
    UnsupportedVersion,
    BadSectionTable,
    SectionOutOfRange,
    TruncatedSection(u32),
    MissingSection(u32),
    ChunkOutOfRange(u32),
    MaterialOutOfRange(u32),
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct SceneHeader {
    pub sun_dir: Vec3,
    pub sun_color: Vec3,
    pub sky_zenith: Vec3,
    pub sky_horizon: Vec3,
    pub sky_sun_glow: Vec3,
    pub fog_cool: Vec3,
    pub fog_warm: Vec3,
    /// Fog density at `world_min.y`, per world unit.
    pub fog_density: f32,
    /// Reciprocal scale height: density falls as `exp(-height * falloff)`.
    pub fog_height_falloff: f32,
    /// How strongly the sun tints fog that lies along the view ray.
    pub fog_inscatter: f32,
    /// Saturation ceiling, so distant geometry never fully disappears.
    pub fog_max: f32,
    pub wind_dir: [f32; 2],
    pub wind_strength: f32,
    pub world_min: Vec3,
    pub world_max: Vec3,
    pub water_level: f32,
    pub camera_fov: f32,
    pub camera_near: f32,
    pub camera_far: f32,
    /// Distance at which LOD 1 and LOD 2 take over, then the cull distance.
    pub lod_distances: [f32; 3],
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MaterialKind {
    /// Depth-written, no blending.
    Opaque,
    /// Alpha-blended and depth-tested, sorted back to front. Backends without
    /// a fragment discard use this for foliage cutouts.
    Cutout,
    /// Alpha-blended, no depth write.
    Blended,
    /// Additive, no depth write.
    Additive,
}

impl MaterialKind {
    pub fn from_u8(value: u8) -> Self {
        match value {
            1 => Self::Cutout,
            2 => Self::Blended,
            3 => Self::Additive,
            _ => Self::Opaque,
        }
    }

    pub fn as_u8(self) -> u8 {
        match self {
            Self::Opaque => 0,
            Self::Cutout => 1,
            Self::Blended => 2,
            Self::Additive => 3,
        }
    }
}

pub mod material_flags {
    /// Draw both faces (the backend disables backface culling).
    pub const TWO_SIDED: u8 = 1 << 0;
    /// Sample without a mip bias; used by surfaces that must stay crisp.
    pub const SHARP: u8 = 1 << 1;
    /// Clamp instead of repeat.
    pub const CLAMP: u8 = 1 << 2;
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Material {
    /// Index into the texture table, or `u16::MAX` for untextured geometry.
    pub texture: u16,
    pub kind: MaterialKind,
    pub flags: u8,
    pub tint: [u8; 4],
    /// Added to the camera distance when sorting translucent draws.
    pub sort_bias: f32,
}

impl Material {
    pub const NO_TEXTURE: u16 = u16::MAX;

    pub fn is_two_sided(&self) -> bool {
        self.flags & material_flags::TWO_SIDED != 0
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TextureFormat {
    /// Tightly packed RGBA8888, level 0 first, each level half the previous.
    Rgba8888,
}

impl TextureFormat {
    pub fn from_u8(value: u8) -> Self {
        let _ = value;
        Self::Rgba8888
    }

    pub fn as_u8(self) -> u8 {
        0
    }

    pub fn bytes_per_pixel(self) -> usize {
        4
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Texture<'a> {
    pub width: u16,
    pub height: u16,
    /// Mip levels present, at least 1.
    pub levels: u8,
    pub format: TextureFormat,
    pub flags: u8,
    /// The whole mip chain, level 0 first.
    pub data: &'a [u8],
}

impl Texture<'_> {
    /// Byte offset and length of one mip level inside [`Self::data`].
    pub fn level(&self, level: u8) -> Option<(usize, usize, u32, u32)> {
        if level >= self.levels {
            return None;
        }
        let bytes_per_pixel = self.format.bytes_per_pixel();
        let mut offset = 0usize;
        for index in 0..=level {
            let width = (self.width as u32 >> index).max(1);
            let height = (self.height as u32 >> index).max(1);
            let size = width as usize * height as usize * bytes_per_pixel;
            if index == level {
                return if offset + size <= self.data.len() {
                    Some((offset, size, width, height))
                } else {
                    None
                };
            }
            offset += size;
        }
        None
    }
}

pub mod chunk_flags {
    /// The chunk's fog term is large enough to be worth an additive pass.
    pub const FOGGED: u8 = 1 << 0;
    /// Belongs to a movable object; the runtime supplies its transform.
    pub const DYNAMIC: u8 = 1 << 1;
    /// Vegetation: the runtime may sway it with the scene wind.
    pub const FOLIAGE: u8 = 1 << 2;
    /// Drawn without a depth write, after the opaque set.
    pub const TRANSLUCENT: u8 = 1 << 3;
}

/// One draw-sized run of geometry with its own 16-bit quantization frame.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Chunk {
    /// World position of quantized origin `(0, 0, 0)`.
    pub origin: Vec3,
    /// World units per quantization step.
    pub scale: f32,
    /// Bounding sphere in world space, for culling and sorting.
    pub center: Vec3,
    pub radius: f32,
    /// First vertex of this chunk inside the vertex slab. Indices are relative
    /// to it, so a backend can rebase the stream instead of the indices.
    pub vertex_base: u32,
    pub index_base: u32,
    pub index_count: u32,
    pub material: u16,
    /// 0 is the highest detail. A chunk is drawn when the camera distance
    /// falls inside its level's band.
    pub lod: u8,
    pub flags: u8,
}

impl Chunk {
    pub fn is_fogged(&self) -> bool {
        self.flags & chunk_flags::FOGGED != 0
    }

    pub fn is_dynamic(&self) -> bool {
        self.flags & chunk_flags::DYNAMIC != 0
    }

    /// Dequantization transform: `world = origin + quantized * scale`.
    pub fn dequantize(&self) -> glam::Mat4 {
        glam::Mat4::from_scale_rotation_translation(
            Vec3::splat(self.scale),
            Quat::IDENTITY,
            self.origin,
        )
    }
}

pub type ChunkFlags = u8;

/// A named run of chunks the runtime places itself (the boat, its lantern).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Object {
    pub name: [u8; 12],
    pub first_chunk: u16,
    pub chunk_count: u16,
    /// The point the runtime rotates the object around, in world space.
    pub pivot: Vec3,
    pub kind: u16,
    pub flags: u16,
}

impl Object {
    pub fn name_str(&self) -> &str {
        let end = self.name.iter().position(|&b| b == 0).unwrap_or(12);
        core::str::from_utf8(&self.name[..end]).unwrap_or("")
    }
}

/// One sample of the river centre line, ordered by increasing `z`.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct RiverSample {
    pub z: f32,
    pub x: f32,
    pub half_width: f32,
    pub depth: f32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ScatterKind {
    Petal,
    Mist,
    Firefly,
    Bird,
}

impl ScatterKind {
    pub fn from_u16(value: u16) -> Self {
        match value {
            1 => Self::Mist,
            2 => Self::Firefly,
            3 => Self::Bird,
            _ => Self::Petal,
        }
    }

    pub fn as_u16(self) -> u16 {
        match self {
            Self::Petal => 0,
            Self::Mist => 1,
            Self::Firefly => 2,
            Self::Bird => 3,
        }
    }
}

/// A volume the runtime fills with camera-facing quads.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Scatter {
    pub kind: ScatterKind,
    pub count: u16,
    pub min: Vec3,
    pub max: Vec3,
    /// Kind-specific: fall speed for petals, drift speed for mist.
    pub rate: f32,
}

/// A material the runtime needs by name rather than by chunk: the surfaces it
/// generates itself.
///
/// Geometry for water, particles and the sky is produced per frame from the
/// camera, so it has no cooked chunk to carry a material index. The role table
/// is how the cooker hands those materials over.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MaterialRole {
    /// Falling blossom, drawn as camera-facing quads.
    Petal,
    /// Soft round puff for mist banks and the sun's bloom.
    Puff,
    /// The animated river surface.
    Water,
    /// The cloud band on the sky dome.
    Cloud,
}

impl MaterialRole {
    pub fn from_u16(value: u16) -> Option<Self> {
        match value {
            0 => Some(Self::Petal),
            1 => Some(Self::Puff),
            2 => Some(Self::Water),
            3 => Some(Self::Cloud),
            _ => None,
        }
    }

    pub fn as_u16(self) -> u16 {
        match self {
            Self::Petal => 0,
            Self::Puff => 1,
            Self::Water => 2,
            Self::Cloud => 3,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct WaterParams {
    pub level: f32,
    pub deep: Vec3,
    pub shallow: Vec3,
    pub specular: Vec3,
    pub wave_amplitude: f32,
    pub wave_length: f32,
    pub wave_speed: f32,
    pub foam_width: f32,
    pub tile: f32,
}

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

/// A parsed `.p3sn` borrowing its backing bytes.
pub struct Scene<'a> {
    pub header: SceneHeader,
    pub materials: Vec<Material>,
    pub textures: Vec<Texture<'a>>,
    pub chunks: Vec<Chunk>,
    pub objects: Vec<Object>,
    pub river: Vec<RiverSample>,
    pub scatters: Vec<Scatter>,
    pub water: WaterParams,
    /// Materials the runtime looks up by role, ordered as written.
    pub roles: Vec<(MaterialRole, u16)>,
    /// Raw 24-byte vertices, ready for a GPU upload.
    pub vertices: &'a [u8],
    /// Raw u16 indices, relative to each chunk's `vertex_base`.
    pub indices: &'a [u8],
}

struct Reader<'a> {
    bytes: &'a [u8],
    offset: usize,
}

impl<'a> Reader<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, offset: 0 }
    }

    fn u8(&mut self) -> u8 {
        let value = self.bytes[self.offset];
        self.offset += 1;
        value
    }

    fn u16(&mut self) -> u16 {
        let value = u16::from_le_bytes([self.bytes[self.offset], self.bytes[self.offset + 1]]);
        self.offset += 2;
        value
    }

    fn u32(&mut self) -> u32 {
        let value = u32::from_le_bytes([
            self.bytes[self.offset],
            self.bytes[self.offset + 1],
            self.bytes[self.offset + 2],
            self.bytes[self.offset + 3],
        ]);
        self.offset += 4;
        value
    }

    fn f32(&mut self) -> f32 {
        f32::from_bits(self.u32())
    }

    fn vec3(&mut self) -> Vec3 {
        Vec3::new(self.f32(), self.f32(), self.f32())
    }

    fn skip(&mut self, bytes: usize) {
        self.offset += bytes;
    }
}

fn section<'a>(
    bytes: &'a [u8],
    table: &[(u32, u32, u32)],
    wanted: u32,
) -> Result<Option<&'a [u8]>, SceneError> {
    let Some(&(_, offset, length)) = table.iter().find(|entry| entry.0 == wanted) else {
        return Ok(None);
    };
    let start = offset as usize;
    let end = start
        .checked_add(length as usize)
        .ok_or(SceneError::SectionOutOfRange)?;
    if end > bytes.len() {
        return Err(SceneError::SectionOutOfRange);
    }
    Ok(Some(&bytes[start..end]))
}

fn required<'a>(
    bytes: &'a [u8],
    table: &[(u32, u32, u32)],
    wanted: u32,
) -> Result<&'a [u8], SceneError> {
    section(bytes, table, wanted)?.ok_or(SceneError::MissingSection(wanted))
}

/// Parse `count` fixed-size records out of a counted section.
fn counted(payload: &[u8], record: usize, tag_value: u32) -> Result<(usize, usize), SceneError> {
    if payload.len() < 4 {
        return Err(SceneError::TruncatedSection(tag_value));
    }
    let count = u32::from_le_bytes([payload[0], payload[1], payload[2], payload[3]]) as usize;
    let needed = count
        .checked_mul(record)
        .and_then(|size| size.checked_add(4))
        .ok_or(SceneError::TruncatedSection(tag_value))?;
    if payload.len() < needed {
        return Err(SceneError::TruncatedSection(tag_value));
    }
    Ok((count, 4))
}

impl<'a> Scene<'a> {
    pub fn parse(bytes: &'a [u8]) -> Result<Self, SceneError> {
        if bytes.len() < HEADER_BYTES {
            return Err(SceneError::TooSmall);
        }
        if bytes[..4] != MAGIC {
            return Err(SceneError::BadMagic);
        }
        let version = u32::from_le_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]);
        if version != VERSION {
            return Err(SceneError::UnsupportedVersion);
        }
        let count = u32::from_le_bytes([bytes[8], bytes[9], bytes[10], bytes[11]]) as usize;
        let table_end = HEADER_BYTES
            .checked_add(count.checked_mul(SECTION_ENTRY_BYTES).ok_or(SceneError::BadSectionTable)?)
            .ok_or(SceneError::BadSectionTable)?;
        if table_end > bytes.len() {
            return Err(SceneError::BadSectionTable);
        }
        let mut table = Vec::with_capacity(count);
        let mut reader = Reader::new(bytes);
        reader.skip(HEADER_BYTES);
        for _ in 0..count {
            table.push((reader.u32(), reader.u32(), reader.u32()));
        }

        let header = parse_header(required(bytes, &table, TAG_SHDR)?)?;
        let materials = parse_materials(required(bytes, &table, TAG_SMAT)?)?;
        let textures = parse_textures(required(bytes, &table, TAG_STEX)?)?;
        let chunks = parse_chunks(required(bytes, &table, TAG_SCHK)?)?;
        let objects = match section(bytes, &table, TAG_SOBJ)? {
            Some(payload) => parse_objects(payload)?,
            None => Vec::new(),
        };
        let river = match section(bytes, &table, TAG_SRIV)? {
            Some(payload) => parse_river(payload)?,
            None => Vec::new(),
        };
        let scatters = match section(bytes, &table, TAG_SSCT)? {
            Some(payload) => parse_scatters(payload)?,
            None => Vec::new(),
        };
        let water = match section(bytes, &table, TAG_SWAT)? {
            Some(payload) => parse_water(payload)?,
            None => WaterParams::default(),
        };
        let roles = match section(bytes, &table, TAG_SROL)? {
            Some(payload) => parse_roles(payload)?,
            None => Vec::new(),
        };
        let vertices = required(bytes, &table, TAG_SVTX)?;
        let indices = required(bytes, &table, TAG_SIDX)?;

        let vertex_count = vertices.len() / VERTEX_STRIDE;
        let index_count = indices.len() / 2;
        for chunk in &chunks {
            let last_index = chunk
                .index_base
                .checked_add(chunk.index_count)
                .ok_or(SceneError::ChunkOutOfRange(chunk.index_base))?;
            if last_index as usize > index_count || chunk.vertex_base as usize > vertex_count {
                return Err(SceneError::ChunkOutOfRange(chunk.index_base));
            }
            if chunk.material as usize >= materials.len() {
                return Err(SceneError::MaterialOutOfRange(chunk.material as u32));
            }
        }
        for material in &materials {
            if material.texture != Material::NO_TEXTURE
                && material.texture as usize >= textures.len()
            {
                return Err(SceneError::MaterialOutOfRange(material.texture as u32));
            }
        }

        Ok(Self {
            header,
            materials,
            textures,
            chunks,
            objects,
            river,
            scatters,
            water,
            roles,
            vertices,
            indices,
        })
    }

    pub fn vertex_count(&self) -> usize {
        self.vertices.len() / VERTEX_STRIDE
    }

    pub fn index_count(&self) -> usize {
        self.indices.len() / 2
    }

    pub fn triangle_count(&self) -> usize {
        self.chunks
            .iter()
            .map(|chunk| chunk.index_count as usize / 3)
            .sum()
    }

    /// The material a runtime-generated surface should draw with.
    pub fn role_material(&self, role: MaterialRole) -> Option<u16> {
        self.roles
            .iter()
            .find(|(candidate, _)| *candidate == role)
            .map(|(_, material)| *material)
    }

    pub fn object(&self, name: &str) -> Option<&Object> {
        self.objects.iter().find(|object| object.name_str() == name)
    }

    /// Interpolate the river centre line at `z`. Returns `(x, half_width)`.
    pub fn river_at(&self, z: f32) -> (f32, f32) {
        if self.river.is_empty() {
            return (0.0, 0.0);
        }
        let first = self.river[0];
        if z <= first.z {
            return (first.x, first.half_width);
        }
        for pair in self.river.windows(2) {
            let (low, high) = (pair[0], pair[1]);
            if z <= high.z {
                let span = high.z - low.z;
                let amount = if span > 1e-6 { (z - low.z) / span } else { 0.0 };
                return (
                    low.x + (high.x - low.x) * amount,
                    low.half_width + (high.half_width - low.half_width) * amount,
                );
            }
        }
        let last = self.river[self.river.len() - 1];
        (last.x, last.half_width)
    }
}

fn parse_header(payload: &[u8]) -> Result<SceneHeader, SceneError> {
    if payload.len() < HEADER_RECORD_BYTES {
        return Err(SceneError::TruncatedSection(TAG_SHDR));
    }
    let mut reader = Reader::new(payload);
    Ok(SceneHeader {
        sun_dir: reader.vec3(),
        sun_color: reader.vec3(),
        sky_zenith: reader.vec3(),
        sky_horizon: reader.vec3(),
        sky_sun_glow: reader.vec3(),
        fog_cool: reader.vec3(),
        fog_warm: reader.vec3(),
        fog_density: reader.f32(),
        fog_height_falloff: reader.f32(),
        fog_inscatter: reader.f32(),
        fog_max: reader.f32(),
        wind_dir: [reader.f32(), reader.f32()],
        wind_strength: reader.f32(),
        world_min: reader.vec3(),
        world_max: reader.vec3(),
        water_level: reader.f32(),
        camera_fov: reader.f32(),
        camera_near: reader.f32(),
        camera_far: reader.f32(),
        lod_distances: [reader.f32(), reader.f32(), reader.f32()],
    })
}

fn parse_materials(payload: &[u8]) -> Result<Vec<Material>, SceneError> {
    let (count, mut offset) = counted(payload, MATERIAL_RECORD_BYTES, TAG_SMAT)?;
    let mut materials = Vec::with_capacity(count);
    for _ in 0..count {
        let mut reader = Reader::new(&payload[offset..]);
        let texture = reader.u16();
        let kind = MaterialKind::from_u8(reader.u8());
        let flags = reader.u8();
        let tint = [reader.u8(), reader.u8(), reader.u8(), reader.u8()];
        let sort_bias = reader.f32();
        materials.push(Material {
            texture,
            kind,
            flags,
            tint,
            sort_bias,
        });
        offset += MATERIAL_RECORD_BYTES;
    }
    Ok(materials)
}

fn parse_textures(payload: &[u8]) -> Result<Vec<Texture<'_>>, SceneError> {
    let (count, mut offset) = counted(payload, TEXTURE_RECORD_BYTES, TAG_STEX)?;
    let blob_start = 4 + count * TEXTURE_RECORD_BYTES;
    let mut textures = Vec::with_capacity(count);
    for _ in 0..count {
        let mut reader = Reader::new(&payload[offset..]);
        let width = reader.u16();
        let height = reader.u16();
        let levels = reader.u8().max(1);
        let format = TextureFormat::from_u8(reader.u8());
        let flags = reader.u8();
        let _reserved = reader.u8();
        let data_offset = reader.u32() as usize;
        let data_length = reader.u32() as usize;
        let start = blob_start
            .checked_add(data_offset)
            .ok_or(SceneError::TruncatedSection(TAG_STEX))?;
        let end = start
            .checked_add(data_length)
            .ok_or(SceneError::TruncatedSection(TAG_STEX))?;
        if end > payload.len() {
            return Err(SceneError::TruncatedSection(TAG_STEX));
        }
        textures.push(Texture {
            width,
            height,
            levels,
            format,
            flags,
            data: &payload[start..end],
        });
        offset += TEXTURE_RECORD_BYTES;
    }
    Ok(textures)
}

fn parse_chunks(payload: &[u8]) -> Result<Vec<Chunk>, SceneError> {
    let (count, mut offset) = counted(payload, CHUNK_RECORD_BYTES, TAG_SCHK)?;
    let mut chunks = Vec::with_capacity(count);
    for _ in 0..count {
        let mut reader = Reader::new(&payload[offset..]);
        chunks.push(Chunk {
            origin: reader.vec3(),
            scale: reader.f32(),
            center: reader.vec3(),
            radius: reader.f32(),
            vertex_base: reader.u32(),
            index_base: reader.u32(),
            index_count: reader.u32(),
            material: reader.u16(),
            lod: reader.u8(),
            flags: reader.u8(),
        });
        offset += CHUNK_RECORD_BYTES;
    }
    Ok(chunks)
}

fn parse_objects(payload: &[u8]) -> Result<Vec<Object>, SceneError> {
    let (count, mut offset) = counted(payload, OBJECT_RECORD_BYTES, TAG_SOBJ)?;
    let mut objects = Vec::with_capacity(count);
    for _ in 0..count {
        let record = &payload[offset..offset + OBJECT_RECORD_BYTES];
        let mut name = [0u8; 12];
        name.copy_from_slice(&record[..12]);
        let mut reader = Reader::new(&record[12..]);
        objects.push(Object {
            name,
            first_chunk: reader.u16(),
            chunk_count: reader.u16(),
            pivot: reader.vec3(),
            kind: reader.u16(),
            flags: reader.u16(),
        });
        offset += OBJECT_RECORD_BYTES;
    }
    Ok(objects)
}

fn parse_river(payload: &[u8]) -> Result<Vec<RiverSample>, SceneError> {
    let (count, mut offset) = counted(payload, RIVER_RECORD_BYTES, TAG_SRIV)?;
    let mut samples = Vec::with_capacity(count);
    for _ in 0..count {
        let mut reader = Reader::new(&payload[offset..]);
        samples.push(RiverSample {
            z: reader.f32(),
            x: reader.f32(),
            half_width: reader.f32(),
            depth: reader.f32(),
        });
        offset += RIVER_RECORD_BYTES;
    }
    Ok(samples)
}

fn parse_scatters(payload: &[u8]) -> Result<Vec<Scatter>, SceneError> {
    let (count, mut offset) = counted(payload, SCATTER_RECORD_BYTES, TAG_SSCT)?;
    let mut scatters = Vec::with_capacity(count);
    for _ in 0..count {
        let mut reader = Reader::new(&payload[offset..]);
        scatters.push(Scatter {
            kind: ScatterKind::from_u16(reader.u16()),
            count: reader.u16(),
            min: reader.vec3(),
            max: reader.vec3(),
            rate: reader.f32(),
        });
        offset += SCATTER_RECORD_BYTES;
    }
    Ok(scatters)
}

fn parse_roles(payload: &[u8]) -> Result<Vec<(MaterialRole, u16)>, SceneError> {
    let (count, mut offset) = counted(payload, ROLE_RECORD_BYTES, TAG_SROL)?;
    let mut roles = Vec::with_capacity(count);
    for _ in 0..count {
        let mut reader = Reader::new(&payload[offset..]);
        let role = reader.u16();
        let material = reader.u16();
        if let Some(role) = MaterialRole::from_u16(role) {
            roles.push((role, material));
        }
        offset += ROLE_RECORD_BYTES;
    }
    Ok(roles)
}

fn parse_water(payload: &[u8]) -> Result<WaterParams, SceneError> {
    if payload.len() < WATER_RECORD_BYTES {
        return Err(SceneError::TruncatedSection(TAG_SWAT));
    }
    let mut reader = Reader::new(payload);
    Ok(WaterParams {
        level: reader.f32(),
        deep: reader.vec3(),
        shallow: reader.vec3(),
        specular: reader.vec3(),
        wave_amplitude: reader.f32(),
        wave_length: reader.f32(),
        wave_speed: reader.f32(),
        foam_width: reader.f32(),
        tile: reader.f32(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn texture_level_offsets_walk_the_mip_chain() {
        let data = alloc::vec![0u8; (16 * 16 + 8 * 8 + 4 * 4) * 4];
        let texture = Texture {
            width: 16,
            height: 16,
            levels: 3,
            format: TextureFormat::Rgba8888,
            flags: 0,
            data: &data,
        };
        assert_eq!(texture.level(0), Some((0, 16 * 16 * 4, 16, 16)));
        assert_eq!(texture.level(1), Some((16 * 16 * 4, 8 * 8 * 4, 8, 8)));
        assert_eq!(
            texture.level(2),
            Some(((16 * 16 + 8 * 8) * 4, 4 * 4 * 4, 4, 4))
        );
        assert_eq!(texture.level(3), None);
    }

    #[test]
    fn object_names_stop_at_the_first_nul() {
        let mut name = [0u8; 12];
        name[..4].copy_from_slice(b"boat");
        let object = Object {
            name,
            first_chunk: 0,
            chunk_count: 1,
            pivot: Vec3::ZERO,
            kind: 0,
            flags: 0,
        };
        assert_eq!(object.name_str(), "boat");
    }
}
