//! Cooked-world planning and GLES2 submission.

use alloc::vec::Vec;
#[cfg(any(target_os = "none", test))]
use core::mem::size_of;

use pocket3d_bsp::cooked::CookedMap;
#[cfg(any(target_os = "none", test))]
use pocket3d_bsp::cooked::VERTEX_STRIDE;
use pocket3d_bsp::vis::VisSet;

use crate::Camera3d;
use crate::texture::TextureDecodeError;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Viewport {
    /// GLES viewport origin, measured from the framebuffer's left edge.
    pub x: i32,
    /// GLES viewport origin, measured from the framebuffer's bottom edge.
    /// Qt top-origin rectangles must be converted by the host.
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

impl Viewport {
    pub const fn new(x: i32, y: i32, width: u32, height: u32) -> Self {
        Self {
            x,
            y,
            width,
            height,
        }
    }

    pub(crate) fn valid(self) -> bool {
        self.width > 0
            && self.height > 0
            && self.width <= i32::MAX as u32
            && self.height <= i32::MAX as u32
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FrameOptions {
    pub viewport: Viewport,
    /// Clear the color surface before drawing. `None` leaves it untouched.
    pub clear_color: Option<[f32; 4]>,
    pub clear_depth: bool,
}

impl FrameOptions {
    pub const fn new(viewport: Viewport) -> Self {
        Self {
            viewport,
            clear_color: Some([0.0, 0.0, 0.0, 1.0]),
            clear_depth: true,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct WorldCounters {
    /// PVS/frustum-visible BSP face runs (not including brush entities).
    pub visible_faces: u32,
    /// Brush-entity runs submitted independently of the world PVS.
    pub always_runs: u32,
    /// Triangles in the gathered plan, whether or not their texture is ready.
    pub triangles: u32,
    pub planned_draw_calls: u32,
    pub submitted_triangles: u32,
    pub submitted_draw_calls: u32,
    pub skipped_draw_calls: u32,
    pub textures_resident: u32,
    pub textures_total: u32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TextureUpload {
    Uploaded {
        texture: usize,
        resident: usize,
        total: usize,
    },
    Complete {
        resident: usize,
        total: usize,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RenderError {
    UnsupportedHost,
    NotInitialized,
    InvalidViewport,
    InvalidVertexData,
    InvalidTriangleList,
    ShaderCompile,
    ProgramLink,
    MissingUniform,
    BufferAllocation,
    TextureAllocation {
        texture: usize,
    },
    TextureTooLarge {
        texture: usize,
        width: u32,
        height: u32,
        maximum: u32,
    },
    TextureDecode {
        texture: usize,
        kind: TextureDecodeError,
    },
    Gl(u32),
}

/// GLES-safe expansion of the packed 20-byte `WVTX` record.
///
/// The cooked numeric color is ABGR (`0xAABBGGRR`); on little-endian targets
/// its bytes are already the normalized RGBA order GLES expects.
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq)]
#[cfg(any(target_os = "none", test))]
pub(crate) struct GlesWorldVertex {
    uv: [f32; 2],
    color: [u8; 4],
    position: [f32; 3],
}

#[cfg(any(target_os = "none", test))]
pub(crate) const GLES_WORLD_VERTEX_STRIDE: usize = 24;

#[cfg(any(target_os = "none", test))]
const _: () = assert!(size_of::<GlesWorldVertex>() == GLES_WORLD_VERTEX_STRIDE);
#[cfg(any(target_os = "none", test))]
const _: () = assert!(core::mem::align_of::<GlesWorldVertex>() <= 8);

#[cfg(any(target_os = "none", test))]
pub(crate) fn vertex_buffer_offset(vert_base: u32) -> Option<usize> {
    (vert_base as usize).checked_mul(GLES_WORLD_VERTEX_STRIDE)
}

#[cfg(any(target_os = "none", test))]
pub(crate) fn index_buffer_offset(index_base: u32) -> Option<usize> {
    (index_base as usize).checked_mul(size_of::<u16>())
}

#[cfg(any(target_os = "none", test))]
fn read_f32(bytes: &[u8], offset: usize) -> f32 {
    f32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap())
}

#[cfg(any(target_os = "none", test))]
fn read_i16(bytes: &[u8], offset: usize) -> i16 {
    i16::from_le_bytes(bytes[offset..offset + 2].try_into().unwrap())
}

#[cfg(any(target_os = "none", test))]
fn decode_vertex(bytes: &[u8], index: usize) -> GlesWorldVertex {
    let start = index * VERTEX_STRIDE;
    let vertex = &bytes[start..start + VERTEX_STRIDE];
    GlesWorldVertex {
        uv: [read_f32(vertex, 0), read_f32(vertex, 4)],
        color: [vertex[8], vertex[9], vertex[10], vertex[11]],
        position: [
            read_i16(vertex, 12) as f32,
            read_i16(vertex, 14) as f32,
            read_i16(vertex, 16) as f32,
        ],
    }
}

#[cfg(any(target_os = "none", test))]
fn convert_vertices(bytes: &[u8]) -> Result<Vec<GlesWorldVertex>, RenderError> {
    if !bytes.len().is_multiple_of(VERTEX_STRIDE) {
        return Err(RenderError::InvalidVertexData);
    }
    let count = bytes.len() / VERTEX_STRIDE;
    let mut vertices = Vec::with_capacity(count);
    for index in 0..count {
        vertices.push(decode_vertex(bytes, index));
    }
    Ok(vertices)
}

/// Merge adjacent index ranges after sorting. Each caller supplies ranges
/// from only one batch, so the batch-relative indices remain valid.
fn merge_runs(ranges: &mut Vec<(u32, u32)>) {
    if ranges.len() < 2 {
        return;
    }
    ranges.sort_unstable();
    let mut write = 0usize;
    for read in 1..ranges.len() {
        let next = ranges[read];
        let current = &mut ranges[write];
        if current.0.checked_add(current.1) == Some(next.0) {
            current.1 += next.1;
        } else {
            write += 1;
            ranges[write] = next;
        }
    }
    ranges.truncate(write + 1);
}

/// A cooked world whose CPU visibility planner is available on every target.
///
/// On Symbian, [`initialize_gpu`](Self::initialize_gpu) copies the converted
/// vertices and borrowed indices into one immutable VBO/IBO pair. Textures
/// remain explicit progressive uploads so a loading screen can yield between
/// maps instead of expanding the full texture set at once. A live context must
/// call [`shutdown_gpu`](Self::shutdown_gpu) before dropping the renderer;
/// after an externally destroyed context, call
/// [`abandon_lost_context`](Self::abandon_lost_context) instead.
pub struct WorldRenderer<'a> {
    map: CookedMap<'a>,
    vis: VisSet,
    runs: Vec<Vec<(u32, u32)>>,
    counters: WorldCounters,
    #[cfg(target_os = "none")]
    next_texture: usize,
    last_gl_error: Option<u32>,
    #[cfg(target_os = "none")]
    gpu: Option<crate::gl::GpuWorld>,
}

impl<'a> WorldRenderer<'a> {
    pub fn new(map: CookedMap<'a>) -> Self {
        let mut runs = Vec::new();
        runs.resize_with(map.batches.len(), Vec::new);
        let counters = WorldCounters {
            textures_total: map.textures.len() as u32,
            ..WorldCounters::default()
        };
        Self {
            vis: VisSet::new(map.faces.len()),
            map,
            runs,
            counters,
            #[cfg(target_os = "none")]
            next_texture: 0,
            last_gl_error: None,
            #[cfg(target_os = "none")]
            gpu: None,
        }
    }

    pub fn map(&self) -> &CookedMap<'a> {
        &self.map
    }

    pub fn counters(&self) -> WorldCounters {
        self.counters
    }

    /// Last non-zero raw `glGetError` result observed by this renderer.
    pub fn last_gl_error(&self) -> Option<u32> {
        self.last_gl_error
    }

    pub fn gpu_geometry_resident(&self) -> bool {
        #[cfg(target_os = "none")]
        {
            self.gpu.is_some()
        }
        #[cfg(not(target_os = "none"))]
        {
            false
        }
    }

    /// Forget handles after the EGL/GL context was destroyed externally.
    ///
    /// This deliberately makes no GL calls: objects from a lost context
    /// cannot be deleted through a new one. CPU map/PVS state stays intact,
    /// and a later [`initialize_gpu`](Self::initialize_gpu) recreates every
    /// GPU resource from the borrowed `.p3d`.
    pub fn abandon_lost_context(&mut self) {
        #[cfg(target_os = "none")]
        {
            let _ = self.gpu.take();
            self.next_texture = 0;
        }
        self.counters.textures_resident = 0;
        self.counters.submitted_triangles = 0;
        self.counters.submitted_draw_calls = 0;
        self.counters.skipped_draw_calls = 0;
        self.last_gl_error = None;
    }

    /// Gather and merge PVS/frustum-visible index ranges without touching GL.
    ///
    /// This is useful for deterministic tests and for preparing counters
    /// before a context exists.
    pub fn gather(&mut self, camera: &Camera3d) -> WorldCounters {
        let frustum = camera.frustum();
        self.vis
            .update(&self.map.vis, self.map.collision.planes(), camera.pos);
        for ranges in &mut self.runs {
            ranges.clear();
        }

        let mut visible_faces = 0u32;
        let runs = &mut self.runs;
        self.vis
            .gather_faces(&self.map.vis, &frustum, |face_index| {
                let run = &self.map.faces[face_index as usize];
                if run.batch == 0xffff || run.index_count == 0 {
                    return;
                }
                runs[run.batch as usize].push((run.index_base, run.index_count as u32));
                visible_faces += 1;
            });

        let mut always_runs = 0u32;
        for run in &self.map.always_runs {
            if run.batch == 0xffff || run.index_count == 0 {
                continue;
            }
            self.runs[run.batch as usize].push((run.index_base, run.index_count as u32));
            always_runs += 1;
        }
        for ranges in &mut self.runs {
            merge_runs(ranges);
        }

        self.counters.visible_faces = visible_faces;
        self.counters.always_runs = always_runs;
        self.counters.triangles = self.runs.iter().flatten().map(|(_, count)| count / 3).sum();
        self.counters.planned_draw_calls = self.runs.iter().map(|ranges| ranges.len() as u32).sum();
        self.counters.submitted_triangles = 0;
        self.counters.submitted_draw_calls = 0;
        self.counters.skipped_draw_calls = 0;
        self.counters
    }

    /// Create shaders and upload the immutable geometry slab.
    ///
    /// # Safety
    ///
    /// The caller must make the intended GLES2 context current and serialize
    /// all calls on its render thread.
    pub unsafe fn initialize_gpu(&mut self) -> Result<(), RenderError> {
        #[cfg(target_os = "none")]
        {
            if self.gpu.is_some() {
                return Ok(());
            }
            let vertices = convert_vertices(self.map.verts)?;
            match crate::gl::GpuWorld::new(&vertices, self.map.indices, self.map.textures.len()) {
                Ok(gpu) => {
                    self.gpu = Some(gpu);
                    self.last_gl_error = None;
                    Ok(())
                }
                Err(error) => {
                    self.capture_error(error);
                    Err(error)
                }
            }
        }
        #[cfg(not(target_os = "none"))]
        {
            Err(RenderError::UnsupportedHost)
        }
    }

    /// Expand and upload at most one map texture.
    ///
    /// # Safety
    ///
    /// The same context used by [`initialize_gpu`](Self::initialize_gpu)
    /// must be current.
    pub unsafe fn upload_next_texture(&mut self) -> Result<TextureUpload, RenderError> {
        #[cfg(target_os = "none")]
        {
            let Some(gpu) = self.gpu.as_mut() else {
                return Err(RenderError::NotInitialized);
            };
            while self.next_texture < self.map.textures.len()
                && gpu.texture_resident(self.next_texture)
            {
                self.next_texture += 1;
            }
            let total = self.map.textures.len();
            if self.next_texture == total {
                let resident = gpu.texture_count();
                self.counters.textures_resident = resident as u32;
                return Ok(TextureUpload::Complete { resident, total });
            }

            let texture_index = self.next_texture;
            let texture = &self.map.textures[texture_index];
            let rgba = crate::texture::expand_level0_rgba(texture).map_err(|kind| {
                RenderError::TextureDecode {
                    texture: texture_index,
                    kind,
                }
            })?;
            match gpu.upload_texture(
                texture_index,
                texture.width.max(1),
                texture.height.max(1),
                &rgba,
            ) {
                Ok(()) => {
                    self.next_texture += 1;
                    let resident = gpu.texture_count();
                    self.counters.textures_resident = resident as u32;
                    self.last_gl_error = None;
                    Ok(TextureUpload::Uploaded {
                        texture: texture_index,
                        resident,
                        total,
                    })
                }
                Err(error) => {
                    self.capture_error(error);
                    Err(error)
                }
            }
        }
        #[cfg(not(target_os = "none"))]
        {
            Err(RenderError::UnsupportedHost)
        }
    }

    /// Submit the currently resident portion of the world.
    ///
    /// Missing textures skip their merged draw runs and are reflected in the
    /// counters, allowing the host to render during progressive loading.
    ///
    /// # Safety
    ///
    /// The renderer's GLES2 context must be current on this thread.
    pub unsafe fn render(
        &mut self,
        camera: &Camera3d,
        options: FrameOptions,
    ) -> Result<WorldCounters, RenderError> {
        self.gather(camera);
        if !options.viewport.valid() {
            return Err(RenderError::InvalidViewport);
        }

        #[cfg(target_os = "none")]
        {
            let Some(gpu) = self.gpu.as_mut() else {
                return Err(RenderError::NotInitialized);
            };
            match gpu.draw(
                &self.map,
                &self.runs,
                &camera.view_proj().to_cols_array(),
                options,
                &mut self.counters,
            ) {
                Ok(()) => {
                    self.counters.textures_resident = gpu.texture_count() as u32;
                    self.last_gl_error = None;
                    Ok(self.counters)
                }
                Err(error) => {
                    self.capture_error(error);
                    Err(error)
                }
            }
        }
        #[cfg(not(target_os = "none"))]
        {
            Err(RenderError::UnsupportedHost)
        }
    }

    /// Delete GL resources while the owning context is current.
    ///
    /// # Safety
    ///
    /// No queued draw may still reference the resources, and the renderer's
    /// original GLES2 context must be current.
    pub unsafe fn shutdown_gpu(&mut self) -> Result<(), RenderError> {
        #[cfg(target_os = "none")]
        {
            if let Some(gpu) = self.gpu.take() {
                gpu.destroy();
            }
            self.next_texture = 0;
            self.counters.textures_resident = 0;
            Ok(())
        }
        #[cfg(not(target_os = "none"))]
        {
            Err(RenderError::UnsupportedHost)
        }
    }

    #[cfg(target_os = "none")]
    fn capture_error(&mut self, error: RenderError) {
        if let RenderError::Gl(code) = error {
            self.last_gl_error = Some(code);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::string::String;
    use alloc::vec;
    use glam::{Vec2, Vec3};
    use pocket3d_bsp::cooked::{BatchDesc, CookedTexture, FaceRun};
    use pocket3d_bsp::trace::MapCollision;
    use pocket3d_bsp::types::{CONTENTS_EMPTY, CONTENTS_SOLID, Leaf, Node, Plane, SurfaceKind};
    use pocket3d_bsp::vis::VisData;

    fn packed_vertex(uv: Vec2, color: u32, position: [i16; 3]) -> Vec<u8> {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&uv.x.to_le_bytes());
        bytes.extend_from_slice(&uv.y.to_le_bytes());
        bytes.extend_from_slice(&color.to_le_bytes());
        for value in position {
            bytes.extend_from_slice(&value.to_le_bytes());
        }
        bytes.extend_from_slice(&0i16.to_le_bytes());
        bytes
    }

    fn fixture_map<'a>(
        verts: &'a [u8],
        indices: &'a [u16],
        palette: &'a [u8],
        mip: &'a [u8],
    ) -> CookedMap<'a> {
        let planes = vec![Plane {
            normal: Vec3::X,
            dist: 0.0,
        }];
        CookedMap {
            sky: None,
            name: String::from("fixture"),
            verts,
            vert_count: (verts.len() / VERTEX_STRIDE) as u32,
            indices,
            batches: vec![BatchDesc {
                texture: 0,
                kind: SurfaceKind::Opaque,
                vert_base: 0,
                vert_count: 3,
                index_base: 0,
                index_count: 6,
            }],
            faces: vec![
                FaceRun {
                    batch: 0,
                    index_count: 3,
                    index_base: 3,
                },
                FaceRun {
                    batch: 0,
                    index_count: 3,
                    index_base: 0,
                },
            ],
            always_runs: Vec::new(),
            textures: vec![CookedTexture {
                name: String::from("fixture"),
                width: 1,
                height: 1,
                levels: 1,
                masked: false,
                palette,
                mips: vec![mip],
            }],
            vis: VisData {
                nodes: vec![Node {
                    plane: 0,
                    children: [-2, -2],
                }],
                leaves: vec![
                    Leaf {
                        contents: CONTENTS_SOLID,
                        vis_offset: -1,
                        mins: Vec3::ZERO,
                        maxs: Vec3::ZERO,
                        first_marksurface: 0,
                        num_marksurfaces: 0,
                    },
                    Leaf {
                        contents: CONTENTS_EMPTY,
                        vis_offset: 0,
                        mins: Vec3::new(-2.0, -2.0, -20.0),
                        maxs: Vec3::new(2.0, 2.0, -5.0),
                        first_marksurface: 0,
                        num_marksurfaces: 2,
                    },
                ],
                marksurfaces: vec![0, 1],
                visibility: vec![1],
                num_visleaves: 1,
            },
            collision: MapCollision::from_parts(
                planes,
                Vec::new(),
                Vec::new(),
                Vec::new(),
                Vec::new(),
            ),
            ct_spawns: Vec::new(),
            t_spawns: Vec::new(),
            sun: None,
            bounds: (Vec3::new(-2.0, -2.0, -20.0), Vec3::new(2.0, 2.0, -5.0)),
        }
    }

    #[test]
    fn converts_packed_wvtx_to_aligned_gles_layout() {
        let bytes = packed_vertex(Vec2::new(0.25, 0.75), 0xff11_2233, [-12, 34, -56]);
        let vertices = convert_vertices(&bytes).unwrap();
        assert_eq!(
            vertices,
            [GlesWorldVertex {
                uv: [0.25, 0.75],
                color: [0x33, 0x22, 0x11, 0xff],
                position: [-12.0, 34.0, -56.0],
            }]
        );
        assert_eq!(size_of::<GlesWorldVertex>(), 24);

        let vertex = &vertices[0];
        let base = vertex as *const GlesWorldVertex as usize;
        assert_eq!((&vertex.uv as *const [f32; 2] as usize) - base, 0);
        assert_eq!((&vertex.color as *const [u8; 4] as usize) - base, 8);
        assert_eq!((&vertex.position as *const [f32; 3] as usize) - base, 12);
    }

    #[test]
    fn pvs_gather_merges_adjacent_face_runs() {
        let mut verts = Vec::new();
        verts.extend_from_slice(&packed_vertex(Vec2::ZERO, 0xffff_ffff, [-1, -1, -10]));
        verts.extend_from_slice(&packed_vertex(Vec2::X, 0xffff_ffff, [1, -1, -10]));
        verts.extend_from_slice(&packed_vertex(Vec2::Y, 0xffff_ffff, [0, 1, -10]));
        let indices = [0u16, 1, 2, 0, 2, 1];
        let palette = [0u8; 1024];
        let mip = [0u8; 128];
        let map = fixture_map(&verts, &indices, &palette, &mip);
        let mut renderer = WorldRenderer::new(map);

        let counters = renderer.gather(&Camera3d::default());
        assert_eq!(counters.visible_faces, 2);
        assert_eq!(counters.triangles, 2);
        assert_eq!(counters.planned_draw_calls, 1);
        assert_eq!(renderer.runs[0], [(0, 6)]);
    }

    #[test]
    fn merge_runs_sorts_and_preserves_gaps() {
        let mut runs = vec![(9, 3), (0, 3), (3, 6), (15, 3)];
        merge_runs(&mut runs);
        assert_eq!(runs, [(0, 12), (15, 3)]);
    }

    #[test]
    fn computes_nonzero_batch_vertex_and_index_offsets() {
        assert_eq!(vertex_buffer_offset(7), Some(168));
        assert_eq!(index_buffer_offset(11), Some(22));
    }

    #[cfg(not(target_os = "none"))]
    #[test]
    fn host_gpu_path_is_explicitly_unsupported_without_linking_gl() {
        let mut verts = Vec::new();
        verts.extend_from_slice(&packed_vertex(Vec2::ZERO, 0xffff_ffff, [-1, -1, -10]));
        verts.extend_from_slice(&packed_vertex(Vec2::X, 0xffff_ffff, [1, -1, -10]));
        verts.extend_from_slice(&packed_vertex(Vec2::Y, 0xffff_ffff, [0, 1, -10]));
        let indices = [0u16, 1, 2, 0, 2, 1];
        let palette = [0u8; 1024];
        let mip = [0u8; 128];
        let map = fixture_map(&verts, &indices, &palette, &mip);
        let mut renderer = WorldRenderer::new(map);

        assert_eq!(
            unsafe { renderer.initialize_gpu() },
            Err(RenderError::UnsupportedHost)
        );
        let options = FrameOptions::new(Viewport::new(0, 0, 640, 360));
        assert_eq!(
            unsafe { renderer.render(&Camera3d::default(), options) },
            Err(RenderError::UnsupportedHost)
        );
        assert_eq!(renderer.counters().visible_faces, 2);
        assert_eq!(renderer.counters().planned_draw_calls, 1);
        assert!(!renderer.gpu_geometry_resident());
        assert_eq!(renderer.last_gl_error(), None);
    }
}
