//! The cooker side: assemble meshes, materials and mipmapped textures into a
//! `.p3sn` byte image.
//!
//! The builder owns the two decisions a cooker should not have to repeat.
//! Quantization: each chunk gets its own origin and scale, so 16-bit positions
//! stay precise regardless of world size, and a chunk is split before its
//! relative indices can overflow `u16`. Mip generation: levels are averaged in
//! linear light with alpha weighting, so foliage cutouts do not grow a halo of
//! transparent-black as they shrink.

use alloc::string::String;
use alloc::vec;
use alloc::vec::Vec;

use glam::Vec3;

use crate::format::{
    ALIGNMENT, CHUNK_RECORD_BYTES, Chunk, HEADER_RECORD_BYTES, MAGIC, MATERIAL_RECORD_BYTES,
    Material, OBJECT_RECORD_BYTES, Object, RIVER_RECORD_BYTES, RiverSample,
    MaterialRole, ROLE_RECORD_BYTES, SCATTER_RECORD_BYTES, Scatter, SceneHeader, TAG_SCHK,
    TAG_SHDR, TAG_SIDX, TAG_SMAT, TAG_SOBJ, TAG_SRIV, TAG_SROL, TAG_SSCT, TAG_STEX, TAG_SVTX,
    TAG_SWAT, TEXTURE_RECORD_BYTES, TextureFormat, VERSION, VERTEX_STRIDE, WaterParams,
    chunk_flags,
};
use crate::light::BakedVertexColor;

/// The largest vertex count a chunk may address with relative `u16` indices.
pub const MAX_CHUNK_VERTICES: usize = 65_536;

#[derive(Clone, Copy, Debug)]
pub struct BuildError(pub &'static str);

/// A mesh under construction, in world space and full precision.
#[derive(Clone, Debug, Default)]
pub struct Mesh {
    pub positions: Vec<Vec3>,
    pub uvs: Vec<[f32; 2]>,
    pub colors: Vec<BakedVertexColor>,
    pub indices: Vec<u32>,
}

impl Mesh {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn vertex_count(&self) -> usize {
        self.positions.len()
    }

    pub fn triangle_count(&self) -> usize {
        self.indices.len() / 3
    }

    pub fn is_empty(&self) -> bool {
        self.indices.is_empty()
    }

    pub fn push_vertex(&mut self, position: Vec3, uv: [f32; 2], color: BakedVertexColor) -> u32 {
        let index = self.positions.len() as u32;
        self.positions.push(position);
        self.uvs.push(uv);
        self.colors.push(color);
        index
    }

    pub fn push_triangle(&mut self, a: u32, b: u32, c: u32) {
        self.indices.extend_from_slice(&[a, b, c]);
    }

    /// Two triangles over four corner indices wound `a b c d`.
    pub fn push_quad(&mut self, a: u32, b: u32, c: u32, d: u32) {
        self.push_triangle(a, b, c);
        self.push_triangle(a, c, d);
    }

    /// Append `other`, rebasing its indices.
    pub fn append(&mut self, other: &Mesh) {
        let base = self.positions.len() as u32;
        self.positions.extend_from_slice(&other.positions);
        self.uvs.extend_from_slice(&other.uvs);
        self.colors.extend_from_slice(&other.colors);
        self.indices
            .extend(other.indices.iter().map(|index| index + base));
    }

    pub fn bounds(&self) -> (Vec3, Vec3) {
        let mut min = Vec3::splat(f32::INFINITY);
        let mut max = Vec3::splat(f32::NEG_INFINITY);
        for &position in &self.positions {
            min = min.min(position);
            max = max.max(position);
        }
        if self.positions.is_empty() {
            (Vec3::ZERO, Vec3::ZERO)
        } else {
            (min, max)
        }
    }
}

/// A texture with its generated mip chain.
#[derive(Clone, Debug)]
pub struct OwnedTexture {
    pub name: String,
    pub width: u16,
    pub height: u16,
    pub levels: u8,
    pub format: TextureFormat,
    pub flags: u8,
    pub data: Vec<u8>,
}

#[derive(Debug)]
pub struct SceneBuilder {
    pub header: SceneHeader,
    pub water: WaterParams,
    materials: Vec<Material>,
    textures: Vec<OwnedTexture>,
    chunks: Vec<Chunk>,
    objects: Vec<Object>,
    river: Vec<RiverSample>,
    scatters: Vec<Scatter>,
    roles: Vec<(MaterialRole, u16)>,
    vertices: Vec<u8>,
    indices: Vec<u8>,
}

impl Default for SceneBuilder {
    fn default() -> Self {
        Self::new()
    }
}

impl SceneBuilder {
    pub fn new() -> Self {
        Self {
            header: SceneHeader::default(),
            water: WaterParams::default(),
            materials: Vec::new(),
            textures: Vec::new(),
            chunks: Vec::new(),
            objects: Vec::new(),
            river: Vec::new(),
            scatters: Vec::new(),
            roles: Vec::new(),
            vertices: Vec::new(),
            indices: Vec::new(),
        }
    }

    pub fn add_material(&mut self, material: Material) -> u16 {
        let index = self.materials.len() as u16;
        self.materials.push(material);
        index
    }

    pub fn materials(&self) -> &[Material] {
        &self.materials
    }

    pub fn chunks(&self) -> &[Chunk] {
        &self.chunks
    }

    pub fn textures(&self) -> &[OwnedTexture] {
        &self.textures
    }

    pub fn vertex_count(&self) -> usize {
        self.vertices.len() / VERTEX_STRIDE
    }

    pub fn triangle_count(&self) -> usize {
        self.indices.len() / 6
    }

    /// Cook one RGBA8 image, generating mips down to 1x1.
    ///
    /// `alpha_weighted` averages colour by coverage, which keeps a cutout's
    /// transparent texels from bleeding into its visible edge as levels shrink.
    pub fn add_texture(
        &mut self,
        name: &str,
        width: u16,
        height: u16,
        rgba: &[u8],
        alpha_weighted: bool,
    ) -> Result<u16, BuildError> {
        if width == 0 || height == 0 {
            return Err(BuildError("texture has a zero dimension"));
        }
        if rgba.len() != width as usize * height as usize * 4 {
            return Err(BuildError("texture payload does not match its dimensions"));
        }
        let mut data = Vec::with_capacity(rgba.len() * 4 / 3 + 4);
        data.extend_from_slice(rgba);
        let mut level_pixels = rgba.to_vec();
        let mut level_width = width as usize;
        let mut level_height = height as usize;
        let mut levels = 1u8;
        while level_width > 1 || level_height > 1 {
            let next_width = (level_width / 2).max(1);
            let next_height = (level_height / 2).max(1);
            let next = downsample(
                &level_pixels,
                level_width,
                level_height,
                next_width,
                next_height,
                alpha_weighted,
            );
            data.extend_from_slice(&next);
            level_pixels = next;
            level_width = next_width;
            level_height = next_height;
            levels += 1;
        }
        let index = self.textures.len() as u16;
        self.textures.push(OwnedTexture {
            name: String::from(name),
            width,
            height,
            levels,
            format: TextureFormat::Rgba8888,
            flags: 0,
            data,
        });
        Ok(index)
    }

    /// Append a mesh as one or more chunks, splitting on the `u16` index limit.
    ///
    /// Returns the range of chunk indices the mesh produced.
    pub fn add_mesh(
        &mut self,
        mesh: &Mesh,
        material: u16,
        lod: u8,
        flags: u8,
    ) -> Result<core::ops::Range<u16>, BuildError> {
        if mesh.positions.len() != mesh.uvs.len() || mesh.positions.len() != mesh.colors.len() {
            return Err(BuildError("mesh attribute arrays disagree in length"));
        }
        if mesh.indices.len() % 3 != 0 {
            return Err(BuildError("mesh index count is not a multiple of three"));
        }
        let first = self.chunks.len() as u16;
        if mesh.is_empty() {
            return Ok(first..first);
        }
        for part in partition(mesh) {
            self.push_chunk(mesh, &part, material, lod, flags)?;
        }
        Ok(first..self.chunks.len() as u16)
    }

    fn push_chunk(
        &mut self,
        mesh: &Mesh,
        triangles: &[u32],
        material: u16,
        lod: u8,
        flags: u8,
    ) -> Result<(), BuildError> {
        // Remap the part's vertices into a dense local block.
        let mut remap = vec![u32::MAX; mesh.positions.len()];
        let mut local: Vec<u32> = Vec::new();
        for &index in triangles {
            let index = index as usize;
            if remap[index] == u32::MAX {
                remap[index] = local.len() as u32;
                local.push(index as u32);
            }
        }
        if local.len() > MAX_CHUNK_VERTICES {
            return Err(BuildError("chunk exceeds the u16 index range"));
        }

        let mut min = Vec3::splat(f32::INFINITY);
        let mut max = Vec3::splat(f32::NEG_INFINITY);
        for &source in &local {
            let position = mesh.positions[source as usize];
            min = min.min(position);
            max = max.max(position);
        }
        let extent = (max - min).max_element().max(1e-4);
        let scale = extent / 32_000.0;
        let center = (min + max) * 0.5;
        let radius = (max - center).length().max(1e-3);

        let vertex_base = (self.vertices.len() / VERTEX_STRIDE) as u32;
        let index_base = (self.indices.len() / 2) as u32;
        self.vertices.reserve(local.len() * VERTEX_STRIDE);
        for &source in &local {
            let source = source as usize;
            let position = mesh.positions[source];
            let offset = (position - min) / scale;
            let quantized = Vec3::new(
                crate::math::roundf(offset.x),
                crate::math::roundf(offset.y),
                crate::math::roundf(offset.z),
            );
            let uv = mesh.uvs[source];
            let color = mesh.colors[source];
            self.vertices.extend_from_slice(&uv[0].to_le_bytes());
            self.vertices.extend_from_slice(&uv[1].to_le_bytes());
            self.vertices.extend_from_slice(&color.lit.to_le_bytes());
            self.vertices.extend_from_slice(&color.fog.to_le_bytes());
            for axis in [quantized.x, quantized.y, quantized.z] {
                let clamped = axis.clamp(i16::MIN as f32, i16::MAX as f32) as i16;
                self.vertices.extend_from_slice(&clamped.to_le_bytes());
            }
            self.vertices.extend_from_slice(&0i16.to_le_bytes());
        }
        self.indices.reserve(triangles.len() * 2);
        for &index in triangles {
            let local_index = remap[index as usize] as u16;
            self.indices.extend_from_slice(&local_index.to_le_bytes());
        }

        self.chunks.push(Chunk {
            origin: min,
            scale,
            center,
            radius,
            vertex_base,
            index_base,
            index_count: triangles.len() as u32,
            material,
            lod,
            flags,
        });
        Ok(())
    }

    pub fn add_object(
        &mut self,
        name: &str,
        chunks: core::ops::Range<u16>,
        pivot: Vec3,
        kind: u16,
        flags: u16,
    ) -> Result<(), BuildError> {
        if name.len() > 12 {
            return Err(BuildError("object name is longer than twelve bytes"));
        }
        let mut bytes = [0u8; 12];
        bytes[..name.len()].copy_from_slice(name.as_bytes());
        self.objects.push(Object {
            name: bytes,
            first_chunk: chunks.start,
            chunk_count: chunks.end - chunks.start,
            pivot,
            kind,
            flags,
        });
        Ok(())
    }

    pub fn set_river(&mut self, samples: Vec<RiverSample>) {
        self.river = samples;
    }

    pub fn add_scatter(&mut self, scatter: Scatter) {
        self.scatters.push(scatter);
    }

    /// Publish the material a runtime-generated surface should draw with.
    pub fn set_role(&mut self, role: MaterialRole, material: u16) {
        self.roles.retain(|(existing, _)| *existing != role);
        self.roles.push((role, material));
    }

    /// Mark every chunk whose fog coverage is too small to be worth a pass.
    ///
    /// The cooker calls this after baking: the additive pass is skipped for a
    /// chunk whose vertices are all close enough to be effectively clear.
    pub fn mark_fogged_chunks(&mut self, epsilon: f32) {
        let threshold = (epsilon.clamp(0.0, 1.0) * 255.0) as u32;
        let total = self.vertices.len() / VERTEX_STRIDE;
        // Chunks are appended in order, so the next chunk's base ends this one.
        let ends: Vec<usize> = self
            .chunks
            .iter()
            .skip(1)
            .map(|chunk| chunk.vertex_base as usize)
            .chain(core::iter::once(total))
            .collect();
        for (chunk, &end) in self.chunks.iter_mut().zip(ends.iter()) {
            let start = chunk.vertex_base as usize;
            let fogged = (start..end.min(total)).any(|vertex| {
                let offset = vertex * VERTEX_STRIDE + crate::format::VERTEX_FOG_OFFSET + 3;
                self.vertices[offset] as u32 > threshold
            });
            if fogged {
                chunk.flags |= chunk_flags::FOGGED;
            } else {
                chunk.flags &= !chunk_flags::FOGGED;
            }
        }
    }

    /// Serialize the scene.
    pub fn finish(&self) -> Result<Vec<u8>, BuildError> {
        if self.materials.is_empty() {
            return Err(BuildError("a scene needs at least one material"));
        }
        if self.materials.len() > u16::MAX as usize {
            return Err(BuildError("too many materials"));
        }
        for material in &self.materials {
            if material.texture != Material::NO_TEXTURE
                && material.texture as usize >= self.textures.len()
            {
                return Err(BuildError("material references a missing texture"));
            }
        }

        let mut sections: Vec<(u32, Vec<u8>)> = Vec::new();
        sections.push((TAG_SHDR, self.header_bytes()));
        sections.push((TAG_SMAT, self.material_bytes()));
        sections.push((TAG_STEX, self.texture_bytes()));
        sections.push((TAG_SVTX, self.vertices.clone()));
        sections.push((TAG_SIDX, self.indices.clone()));
        sections.push((TAG_SCHK, self.chunk_bytes()));
        if !self.objects.is_empty() {
            sections.push((TAG_SOBJ, self.object_bytes()));
        }
        if !self.river.is_empty() {
            sections.push((TAG_SRIV, self.river_bytes()));
        }
        if !self.scatters.is_empty() {
            sections.push((TAG_SSCT, self.scatter_bytes()));
        }
        sections.push((TAG_SWAT, self.water_bytes()));
        if !self.roles.is_empty() {
            sections.push((TAG_SROL, self.role_bytes()));
        }

        let table_bytes = 16 + sections.len() * 12;
        let mut payload_offset = table_bytes.next_multiple_of(ALIGNMENT);
        let mut table = Vec::with_capacity(sections.len());
        for (tag_value, payload) in &sections {
            table.push((*tag_value, payload_offset as u32, payload.len() as u32));
            payload_offset =
                (payload_offset + payload.len()).next_multiple_of(ALIGNMENT);
        }

        let mut out = Vec::with_capacity(payload_offset);
        out.extend_from_slice(&MAGIC);
        out.extend_from_slice(&VERSION.to_le_bytes());
        out.extend_from_slice(&(sections.len() as u32).to_le_bytes());
        out.extend_from_slice(&0u32.to_le_bytes());
        for (tag_value, offset, length) in &table {
            out.extend_from_slice(&tag_value.to_le_bytes());
            out.extend_from_slice(&offset.to_le_bytes());
            out.extend_from_slice(&length.to_le_bytes());
        }
        for ((_, payload), (_, offset, _)) in sections.iter().zip(table.iter()) {
            out.resize(*offset as usize, 0);
            out.extend_from_slice(payload);
        }
        Ok(out)
    }

    fn header_bytes(&self) -> Vec<u8> {
        let header = &self.header;
        let mut out = Vec::with_capacity(HEADER_RECORD_BYTES);
        let vec3 = |value: Vec3, out: &mut Vec<u8>| {
            out.extend_from_slice(&value.x.to_le_bytes());
            out.extend_from_slice(&value.y.to_le_bytes());
            out.extend_from_slice(&value.z.to_le_bytes());
        };
        vec3(header.sun_dir, &mut out);
        vec3(header.sun_color, &mut out);
        vec3(header.sky_zenith, &mut out);
        vec3(header.sky_horizon, &mut out);
        vec3(header.sky_sun_glow, &mut out);
        vec3(header.fog_cool, &mut out);
        vec3(header.fog_warm, &mut out);
        for value in [
            header.fog_density,
            header.fog_height_falloff,
            header.fog_inscatter,
            header.fog_max,
            header.wind_dir[0],
            header.wind_dir[1],
            header.wind_strength,
        ] {
            out.extend_from_slice(&value.to_le_bytes());
        }
        vec3(header.world_min, &mut out);
        vec3(header.world_max, &mut out);
        for value in [
            header.water_level,
            header.camera_fov,
            header.camera_near,
            header.camera_far,
            header.lod_distances[0],
            header.lod_distances[1],
            header.lod_distances[2],
        ] {
            out.extend_from_slice(&value.to_le_bytes());
        }
        debug_assert_eq!(out.len(), HEADER_RECORD_BYTES);
        out
    }

    fn material_bytes(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(4 + self.materials.len() * MATERIAL_RECORD_BYTES);
        out.extend_from_slice(&(self.materials.len() as u32).to_le_bytes());
        for material in &self.materials {
            out.extend_from_slice(&material.texture.to_le_bytes());
            out.push(material.kind.as_u8());
            out.push(material.flags);
            out.extend_from_slice(&material.tint);
            out.extend_from_slice(&material.sort_bias.to_le_bytes());
        }
        out
    }

    fn texture_bytes(&self) -> Vec<u8> {
        let mut descriptors = Vec::with_capacity(4 + self.textures.len() * TEXTURE_RECORD_BYTES);
        descriptors.extend_from_slice(&(self.textures.len() as u32).to_le_bytes());
        let mut blob = Vec::new();
        for texture in &self.textures {
            descriptors.extend_from_slice(&texture.width.to_le_bytes());
            descriptors.extend_from_slice(&texture.height.to_le_bytes());
            descriptors.push(texture.levels);
            descriptors.push(texture.format.as_u8());
            descriptors.push(texture.flags);
            descriptors.push(0);
            descriptors.extend_from_slice(&(blob.len() as u32).to_le_bytes());
            descriptors.extend_from_slice(&(texture.data.len() as u32).to_le_bytes());
            blob.extend_from_slice(&texture.data);
        }
        descriptors.extend_from_slice(&blob);
        descriptors
    }

    fn chunk_bytes(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(4 + self.chunks.len() * CHUNK_RECORD_BYTES);
        out.extend_from_slice(&(self.chunks.len() as u32).to_le_bytes());
        for chunk in &self.chunks {
            for value in [chunk.origin.x, chunk.origin.y, chunk.origin.z, chunk.scale] {
                out.extend_from_slice(&value.to_le_bytes());
            }
            for value in [chunk.center.x, chunk.center.y, chunk.center.z, chunk.radius] {
                out.extend_from_slice(&value.to_le_bytes());
            }
            out.extend_from_slice(&chunk.vertex_base.to_le_bytes());
            out.extend_from_slice(&chunk.index_base.to_le_bytes());
            out.extend_from_slice(&chunk.index_count.to_le_bytes());
            out.extend_from_slice(&chunk.material.to_le_bytes());
            out.push(chunk.lod);
            out.push(chunk.flags);
        }
        out
    }

    fn object_bytes(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(4 + self.objects.len() * OBJECT_RECORD_BYTES);
        out.extend_from_slice(&(self.objects.len() as u32).to_le_bytes());
        for object in &self.objects {
            out.extend_from_slice(&object.name);
            out.extend_from_slice(&object.first_chunk.to_le_bytes());
            out.extend_from_slice(&object.chunk_count.to_le_bytes());
            for value in [object.pivot.x, object.pivot.y, object.pivot.z] {
                out.extend_from_slice(&value.to_le_bytes());
            }
            out.extend_from_slice(&object.kind.to_le_bytes());
            out.extend_from_slice(&object.flags.to_le_bytes());
        }
        out
    }

    fn river_bytes(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(4 + self.river.len() * RIVER_RECORD_BYTES);
        out.extend_from_slice(&(self.river.len() as u32).to_le_bytes());
        for sample in &self.river {
            for value in [sample.z, sample.x, sample.half_width, sample.depth] {
                out.extend_from_slice(&value.to_le_bytes());
            }
        }
        out
    }

    fn scatter_bytes(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(4 + self.scatters.len() * SCATTER_RECORD_BYTES);
        out.extend_from_slice(&(self.scatters.len() as u32).to_le_bytes());
        for scatter in &self.scatters {
            out.extend_from_slice(&scatter.kind.as_u16().to_le_bytes());
            out.extend_from_slice(&scatter.count.to_le_bytes());
            for value in [
                scatter.min.x,
                scatter.min.y,
                scatter.min.z,
                scatter.max.x,
                scatter.max.y,
                scatter.max.z,
                scatter.rate,
            ] {
                out.extend_from_slice(&value.to_le_bytes());
            }
        }
        out
    }

    fn role_bytes(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(4 + self.roles.len() * ROLE_RECORD_BYTES);
        out.extend_from_slice(&(self.roles.len() as u32).to_le_bytes());
        for (role, material) in &self.roles {
            out.extend_from_slice(&role.as_u16().to_le_bytes());
            out.extend_from_slice(&material.to_le_bytes());
        }
        out
    }

    fn water_bytes(&self) -> Vec<u8> {
        let water = &self.water;
        let mut out = Vec::with_capacity(crate::format::WATER_RECORD_BYTES);
        out.extend_from_slice(&water.level.to_le_bytes());
        for color in [water.deep, water.shallow, water.specular] {
            for value in [color.x, color.y, color.z] {
                out.extend_from_slice(&value.to_le_bytes());
            }
        }
        for value in [
            water.wave_amplitude,
            water.wave_length,
            water.wave_speed,
            water.foam_width,
            water.tile,
        ] {
            out.extend_from_slice(&value.to_le_bytes());
        }
        out
    }
}

/// Split a mesh's triangles into groups that each address at most
/// [`MAX_CHUNK_VERTICES`] distinct vertices.
///
/// Triangles keep their authored order, which a generator uses to keep
/// spatially adjacent geometry in one chunk.
fn partition(mesh: &Mesh) -> Vec<Vec<u32>> {
    let mut parts = Vec::new();
    let mut current: Vec<u32> = Vec::new();
    let mut seen = vec![u32::MAX; mesh.positions.len()];
    let mut generation = 0u32;
    let mut distinct = 0usize;
    for triangle in mesh.indices.chunks_exact(3) {
        let new_vertices = triangle
            .iter()
            .filter(|&&index| seen[index as usize] != generation)
            .count();
        if distinct + new_vertices > MAX_CHUNK_VERTICES && !current.is_empty() {
            parts.push(core::mem::take(&mut current));
            generation += 1;
            distinct = 0;
        }
        for &index in triangle {
            if seen[index as usize] != generation {
                seen[index as usize] = generation;
                distinct += 1;
            }
            current.push(index);
        }
    }
    if !current.is_empty() {
        parts.push(current);
    }
    parts
}

/// Box filter one mip level in linear light.
fn downsample(
    source: &[u8],
    width: usize,
    height: usize,
    target_width: usize,
    target_height: usize,
    alpha_weighted: bool,
) -> Vec<u8> {
    let mut out = vec![0u8; target_width * target_height * 4];
    // Integer source spans: a target texel covers ceil-rounded source range.
    for y in 0..target_height {
        for x in 0..target_width {
            let x0 = x * width / target_width;
            let x1 = ((x + 1) * width).div_ceil(target_width).min(width).max(x0 + 1);
            let y0 = y * height / target_height;
            let y1 = ((y + 1) * height).div_ceil(target_height).min(height).max(y0 + 1);
            let mut color = [0.0f32; 3];
            let mut alpha = 0.0f32;
            let mut weight = 0.0f32;
            let mut samples = 0.0f32;
            for sy in y0..y1 {
                for sx in x0..x1 {
                    let offset = (sy * width + sx) * 4;
                    let texel_alpha = source[offset + 3] as f32 / 255.0;
                    let contribution = if alpha_weighted { texel_alpha } else { 1.0 };
                    for channel in 0..3 {
                        let value = source[offset + channel] as f32 / 255.0;
                        color[channel] += srgb_to_linear(value) * contribution;
                    }
                    alpha += texel_alpha;
                    weight += contribution;
                    samples += 1.0;
                }
            }
            let destination = (y * target_width + x) * 4;
            let divisor = if weight > 1e-6 { weight } else { samples.max(1.0) };
            for channel in 0..3 {
                let value = linear_to_srgb(color[channel] / divisor);
                out[destination + channel] = (value.clamp(0.0, 1.0) * 255.0 + 0.5) as u8;
            }
            out[destination + 3] = ((alpha / samples.max(1.0)).clamp(0.0, 1.0) * 255.0 + 0.5) as u8;
        }
    }
    out
}

fn srgb_to_linear(value: f32) -> f32 {
    crate::math::powf(value, 2.2)
}

fn linear_to_srgb(value: f32) -> f32 {
    crate::math::powf(value.max(0.0), 1.0 / 2.2)
}

/// Total bytes a texture's mip chain occupies.
pub fn mip_chain_bytes(width: u16, height: u16) -> usize {
    let mut total = 0usize;
    let mut level_width = width as usize;
    let mut level_height = height as usize;
    loop {
        total += level_width * level_height * 4;
        if level_width == 1 && level_height == 1 {
            break;
        }
        level_width = (level_width / 2).max(1);
        level_height = (level_height / 2).max(1);
    }
    total
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::format::{MaterialKind, Scene, chunk_flags};

    fn white() -> BakedVertexColor {
        BakedVertexColor {
            lit: 0xffff_ffff,
            fog: 0x0000_0000,
        }
    }

    fn quad(offset: Vec3, size: f32) -> Mesh {
        let mut mesh = Mesh::new();
        let a = mesh.push_vertex(offset, [0.0, 0.0], white());
        let b = mesh.push_vertex(offset + Vec3::new(size, 0.0, 0.0), [1.0, 0.0], white());
        let c = mesh.push_vertex(offset + Vec3::new(size, 0.0, size), [1.0, 1.0], white());
        let d = mesh.push_vertex(offset + Vec3::new(0.0, 0.0, size), [0.0, 1.0], white());
        mesh.push_quad(a, b, c, d);
        mesh
    }

    fn minimal() -> SceneBuilder {
        let mut builder = SceneBuilder::new();
        builder.header.lod_distances = [60.0, 250.0, 1200.0];
        builder
            .add_texture("flat", 2, 2, &[255u8; 16], false)
            .unwrap();
        builder.add_material(Material {
            texture: 0,
            kind: MaterialKind::Opaque,
            flags: 0,
            tint: [255; 4],
            sort_bias: 0.0,
        });
        builder
    }

    #[test]
    fn a_built_scene_parses_back_with_its_geometry_intact() {
        let mut builder = minimal();
        builder
            .add_mesh(&quad(Vec3::new(10.0, 0.0, -5.0), 4.0), 0, 0, 0)
            .unwrap();
        let bytes = builder.finish().unwrap();
        let scene = Scene::parse(&bytes).unwrap();
        assert_eq!(scene.chunks.len(), 1);
        assert_eq!(scene.triangle_count(), 2);
        assert_eq!(scene.vertex_count(), 4);
        assert_eq!(scene.materials.len(), 1);
        assert_eq!(scene.textures.len(), 1);
        assert_eq!(scene.textures[0].levels, 2);
    }

    #[test]
    fn quantized_positions_round_trip_within_a_millimetre() {
        let mut builder = minimal();
        let mesh = quad(Vec3::new(-421.5, 12.25, 880.125), 37.5);
        builder.add_mesh(&mesh, 0, 0, 0).unwrap();
        let bytes = builder.finish().unwrap();
        let scene = Scene::parse(&bytes).unwrap();
        let chunk = scene.chunks[0];
        for (index, &expected) in mesh.positions.iter().enumerate() {
            let base = index * VERTEX_STRIDE + crate::format::VERTEX_POSITION_OFFSET;
            let axis = |offset: usize| {
                i16::from_le_bytes([
                    scene.vertices[base + offset * 2],
                    scene.vertices[base + offset * 2 + 1],
                ]) as f32
            };
            let decoded =
                chunk.origin + Vec3::new(axis(0), axis(1), axis(2)) * chunk.scale;
            assert!(
                (decoded - expected).length() < 0.001,
                "{decoded:?} vs {expected:?}"
            );
        }
    }

    #[test]
    fn the_bounding_sphere_contains_every_vertex() {
        let mut builder = minimal();
        let mesh = quad(Vec3::new(3.0, -2.0, 9.0), 25.0);
        builder.add_mesh(&mesh, 0, 0, 0).unwrap();
        let chunk = builder.chunks()[0];
        for &position in &mesh.positions {
            assert!((position - chunk.center).length() <= chunk.radius + 1e-3);
        }
    }

    #[test]
    fn a_mesh_past_the_index_limit_splits_into_several_chunks() {
        let mut builder = minimal();
        let mut mesh = Mesh::new();
        // Every triangle gets its own vertices, so the vertex count is the limit.
        for index in 0..30_000 {
            let base = Vec3::new(index as f32 * 0.01, 0.0, 0.0);
            let a = mesh.push_vertex(base, [0.0, 0.0], white());
            let b = mesh.push_vertex(base + Vec3::X * 0.005, [1.0, 0.0], white());
            let c = mesh.push_vertex(base + Vec3::Z * 0.005, [0.0, 1.0], white());
            mesh.push_triangle(a, b, c);
        }
        let range = builder.add_mesh(&mesh, 0, 0, 0).unwrap();
        assert!(range.end - range.start >= 2);
        let total: u32 = builder
            .chunks()
            .iter()
            .map(|chunk| chunk.index_count)
            .sum();
        assert_eq!(total as usize, mesh.indices.len());
        let bytes = builder.finish().unwrap();
        Scene::parse(&bytes).unwrap();
    }

    #[test]
    fn mark_fogged_chunks_clears_chunks_with_no_coverage() {
        let mut builder = minimal();
        builder
            .add_mesh(&quad(Vec3::ZERO, 1.0), 0, 0, chunk_flags::FOGGED)
            .unwrap();
        builder.mark_fogged_chunks(1.0 / 255.0);
        assert_eq!(builder.chunks()[0].flags & chunk_flags::FOGGED, 0);
    }

    #[test]
    fn alpha_weighted_mips_do_not_darken_a_cutout_edge() {
        let mut builder = minimal();
        // One opaque green texel beside three transparent black ones.
        let rgba = [
            0, 255, 0, 255, //
            0, 0, 0, 0, //
            0, 0, 0, 0, //
            0, 0, 0, 0,
        ];
        let index = builder.add_texture("leaf", 2, 2, &rgba, true).unwrap();
        let texture = &builder.textures()[index as usize];
        let level1 = &texture.data[16..20];
        assert_eq!(level1[1], 255, "colour should come only from covered texels");
        assert_eq!(level1[3], 64, "coverage should still average down");
    }

    #[test]
    fn mip_chain_bytes_matches_the_generated_chain() {
        let mut builder = minimal();
        let rgba = vec![128u8; 8 * 8 * 4];
        let index = builder.add_texture("grid", 8, 8, &rgba, false).unwrap();
        assert_eq!(
            builder.textures()[index as usize].data.len(),
            mip_chain_bytes(8, 8)
        );
    }
}
