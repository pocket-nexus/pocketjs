//! Raw-GXM 3D pipeline built on vita2d's shader patcher and precompiled
//! shader binaries.
//!
//! vita2d's stock 2D shaders already run a full `mul(float4(pos, 1), wvp)`
//! through the vertex stage. Registering our own copies of those shader
//! binaries lets this backend feed a *perspective* matrix to the same math,
//! so the GPU performs world transform, clipping and depth testing that the
//! bring-up backend previously emulated on the CPU.
//!
//! The `.gxp` binaries under `shaders/` are extracted verbatim from
//! xerpi's MIT-licensed libvita2d (`libvita2d/shader/compiled`); see
//! `shaders/LICENSE.libvita2d` for attribution.

#![cfg(target_os = "vita")]

use core::cell::UnsafeCell;
use core::ffi::c_void;
use core::ptr;

use vita2d_sys as v2d;

#[repr(C, align(16))]
struct AlignedShader<const N: usize>([u8; N]);

// GXM consumes these blobs as `SceGxmProgram` structures. `include_bytes!`
// alone has byte alignment, which is insufficient on ARM and can be rejected
// by the shader patcher even when the payload itself is valid.
static COLOR_V: AlignedShader<344> = AlignedShader(*include_bytes!("../shaders/color_v.gxp"));
static COLOR_F: AlignedShader<216> = AlignedShader(*include_bytes!("../shaders/color_f.gxp"));
static TEXTURE_V: AlignedShader<344> = AlignedShader(*include_bytes!("../shaders/texture_v.gxp"));
static TEXTURE_F: AlignedShader<228> = AlignedShader(*include_bytes!("../shaders/texture_f.gxp"));
static TEXTURE_TINT_F: AlignedShader<296> =
    AlignedShader(*include_bytes!("../shaders/texture_tint_f.gxp"));

/// Identity index buffer entries for drawing CPU-staged triangle lists.
pub const SEQUENTIAL_INDEX_COUNT: usize = 0xffff;

/// Cooked world vertex layout (`pocket3d_bsp::cooked::VERTEX_STRIDE`).
const WORLD_STRIDE: u16 = 20;
const WORLD_UV_OFFSET: u16 = 0;
const WORLD_COLOR_OFFSET: u16 = 8;
const WORLD_POSITION_OFFSET: u16 = 12;

/// Dynamic vertex layout (`mesh::ColorVert`: u32 color then f32 xyz).
const DYN_COLOR_STRIDE: u16 = 16;

/// Authored-scene vertex layout (`pocket3d_scene::format::VERTEX_STRIDE`):
/// `[u, v: f32][lit: u32][fog: u32][x, y, z: i16][pad]`. One resident stream
/// feeds three passes; only the attribute offsets differ.
const SCENE_STRIDE: u16 = 24;
const SCENE_UV_OFFSET: u16 = 0;
const SCENE_LIT_OFFSET: u16 = 8;
const SCENE_FOG_OFFSET: u16 = 12;
const SCENE_POSITION_OFFSET: u16 = 16;

pub struct Pipeline {
    patcher: *mut v2d::SceGxmShaderPatcher,
    registered_ids: [v2d::SceGxmShaderPatcherId; 5],
    world_tex_vp: *mut v2d::SceGxmVertexProgram,
    world_col_vp: *mut v2d::SceGxmVertexProgram,
    dyn_col_vp: *mut v2d::SceGxmVertexProgram,
    scene_tex_vp: *mut v2d::SceGxmVertexProgram,
    scene_lit_vp: *mut v2d::SceGxmVertexProgram,
    scene_fog_vp: *mut v2d::SceGxmVertexProgram,
    tex_opaque_fp: *mut v2d::SceGxmFragmentProgram,
    tex_tint_blend_fp: *mut v2d::SceGxmFragmentProgram,
    col_opaque_fp: *mut v2d::SceGxmFragmentProgram,
    col_multiply_fp: *mut v2d::SceGxmFragmentProgram,
    col_alpha_fp: *mut v2d::SceGxmFragmentProgram,
    col_additive_fp: *mut v2d::SceGxmFragmentProgram,
    tex_wvp: *const v2d::SceGxmProgramParameter,
    col_wvp: *const v2d::SceGxmProgramParameter,
    tint_color: *const v2d::SceGxmProgramParameter,
    /// GPU-visible `0..=0xffff` used to draw non-indexed staged lists.
    sequential_indices: GpuSlab,
}

struct PipelineCell(UnsafeCell<Option<Result<Pipeline, &'static str>>>);

// All access is confined to the Vita render thread by the public unsafe API.
unsafe impl Sync for PipelineCell {}

static PIPELINE: PipelineCell = PipelineCell(UnsafeCell::new(None));

/// One GPU-mapped uncached allocation. Freeing is deliberately manual: the
/// caller must guarantee no in-flight GPU work references the range.
pub struct GpuSlab {
    uid: v2d::SceUID,
    base: *mut c_void,
    len: usize,
}

impl GpuSlab {
    /// Allocate `len` bytes of uncached, GXM-mapped memory.
    pub unsafe fn alloc(len: usize) -> Result<Self, &'static str> {
        let size = len.max(4096).next_multiple_of(4096);
        let uid = v2d::sceKernelAllocMemBlock(
            c"pocket3d-vita".as_ptr(),
            v2d::SCE_KERNEL_MEMBLOCK_TYPE_USER_RW_UNCACHE,
            size as v2d::SceSize,
            ptr::null_mut(),
        );
        if uid < 0 {
            return Err("sceKernelAllocMemBlock failed");
        }
        let mut base: *mut c_void = ptr::null_mut();
        if v2d::sceKernelGetMemBlockBase(uid, &mut base) < 0 || base.is_null() {
            v2d::sceKernelFreeMemBlock(uid);
            return Err("sceKernelGetMemBlockBase failed");
        }
        if v2d::sceGxmMapMemory(
            base,
            size as v2d::SceSize,
            v2d::SceGxmMemoryAttribFlags_SCE_GXM_MEMORY_ATTRIB_READ,
        ) < 0
        {
            v2d::sceKernelFreeMemBlock(uid);
            return Err("sceGxmMapMemory failed");
        }
        Ok(Self {
            uid,
            base,
            len: size,
        })
    }

    pub fn as_ptr(&self) -> *mut u8 {
        self.base.cast()
    }

    pub fn len(&self) -> usize {
        self.len
    }

    /// Unmap and free.
    ///
    /// # Safety
    ///
    /// No queued or in-flight GXM work may reference this allocation.
    pub unsafe fn free(self) {
        v2d::sceGxmUnmapMemory(self.base);
        v2d::sceKernelFreeMemBlock(self.uid);
    }
}

fn blend_info(
    color_src: v2d::SceGxmBlendFactor,
    color_dst: v2d::SceGxmBlendFactor,
    alpha_src: v2d::SceGxmBlendFactor,
    alpha_dst: v2d::SceGxmBlendFactor,
) -> v2d::SceGxmBlendInfo {
    let mut info = v2d::SceGxmBlendInfo {
        colorMask: v2d::SceGxmColorMask_SCE_GXM_COLOR_MASK_ALL as u8,
        _bitfield_align_1: [],
        _bitfield_1: Default::default(),
    };
    info.set_colorFunc(v2d::SceGxmBlendFunc_SCE_GXM_BLEND_FUNC_ADD as u8);
    info.set_alphaFunc(v2d::SceGxmBlendFunc_SCE_GXM_BLEND_FUNC_ADD as u8);
    info.set_colorSrc(color_src as u8);
    info.set_colorDst(color_dst as u8);
    info.set_alphaSrc(alpha_src as u8);
    info.set_alphaDst(alpha_dst as u8);
    info
}

unsafe fn register(
    patcher: *mut v2d::SceGxmShaderPatcher,
    blob: &'static [u8],
) -> Result<(v2d::SceGxmShaderPatcherId, *const v2d::SceGxmProgram), &'static str> {
    let program = blob.as_ptr().cast::<v2d::SceGxmProgram>();
    if v2d::sceGxmProgramCheck(program) < 0 {
        return Err("sceGxmProgramCheck failed");
    }
    if v2d::sceGxmProgramGetSize(program) as usize > blob.len() {
        return Err("truncated GXM shader program");
    }
    let mut id: v2d::SceGxmShaderPatcherId = ptr::null_mut();
    if v2d::sceGxmShaderPatcherRegisterProgram(patcher, program, &mut id) < 0 {
        return Err("sceGxmShaderPatcherRegisterProgram failed");
    }
    Ok((id, program))
}

unsafe fn parameter(
    program: *const v2d::SceGxmProgram,
    name: &'static core::ffi::CStr,
) -> Result<*const v2d::SceGxmProgramParameter, &'static str> {
    let parameter = v2d::sceGxmProgramFindParameterByName(program, name.as_ptr());
    if parameter.is_null() {
        return Err("shader parameter not found");
    }
    Ok(parameter)
}

unsafe fn resource_index(
    program: *const v2d::SceGxmProgram,
    name: &'static core::ffi::CStr,
) -> Result<u16, &'static str> {
    Ok(v2d::sceGxmProgramParameterGetResourceIndex(parameter(program, name)?) as u16)
}

unsafe fn vertex_program(
    patcher: *mut v2d::SceGxmShaderPatcher,
    id: v2d::SceGxmShaderPatcherId,
    attributes: &[v2d::SceGxmVertexAttribute],
    stride: u16,
) -> Result<*mut v2d::SceGxmVertexProgram, &'static str> {
    let stream = v2d::SceGxmVertexStream {
        stride,
        indexSource: v2d::SceGxmIndexSource_SCE_GXM_INDEX_SOURCE_INDEX_16BIT as u16,
    };
    let mut program: *mut v2d::SceGxmVertexProgram = ptr::null_mut();
    if v2d::sceGxmShaderPatcherCreateVertexProgram(
        patcher,
        id,
        attributes.as_ptr(),
        attributes.len() as u32,
        &stream,
        1,
        &mut program,
    ) < 0
    {
        return Err("sceGxmShaderPatcherCreateVertexProgram failed");
    }
    Ok(program)
}

unsafe fn fragment_program(
    patcher: *mut v2d::SceGxmShaderPatcher,
    id: v2d::SceGxmShaderPatcherId,
    blend: Option<&v2d::SceGxmBlendInfo>,
    linked_vertex: *const v2d::SceGxmProgram,
) -> Result<*mut v2d::SceGxmFragmentProgram, &'static str> {
    let mut program: *mut v2d::SceGxmFragmentProgram = ptr::null_mut();
    if v2d::sceGxmShaderPatcherCreateFragmentProgram(
        patcher,
        id,
        v2d::SceGxmOutputRegisterFormat_SCE_GXM_OUTPUT_REGISTER_FORMAT_UCHAR4,
        v2d::SceGxmMultisampleMode_SCE_GXM_MULTISAMPLE_NONE,
        blend.map_or(ptr::null(), |blend| blend as *const _),
        linked_vertex,
        &mut program,
    ) < 0
    {
        return Err("sceGxmShaderPatcherCreateFragmentProgram failed");
    }
    Ok(program)
}

/// Releases every patcher object accumulated if pipeline construction exits
/// early. Successful construction disarms the guard and transfers ownership
/// to [`Pipeline`].
struct BuildGuard {
    patcher: *mut v2d::SceGxmShaderPatcher,
    ids: Vec<v2d::SceGxmShaderPatcherId>,
    vertex_programs: Vec<*mut v2d::SceGxmVertexProgram>,
    fragment_programs: Vec<*mut v2d::SceGxmFragmentProgram>,
    armed: bool,
}

impl BuildGuard {
    fn new(patcher: *mut v2d::SceGxmShaderPatcher) -> Self {
        Self {
            patcher,
            ids: Vec::with_capacity(5),
            vertex_programs: Vec::with_capacity(6),
            fragment_programs: Vec::with_capacity(6),
            armed: true,
        }
    }

    unsafe fn register(
        &mut self,
        blob: &'static [u8],
    ) -> Result<(v2d::SceGxmShaderPatcherId, *const v2d::SceGxmProgram), &'static str> {
        let registered = register(self.patcher, blob)?;
        self.ids.push(registered.0);
        Ok(registered)
    }

    unsafe fn vertex(
        &mut self,
        id: v2d::SceGxmShaderPatcherId,
        attributes: &[v2d::SceGxmVertexAttribute],
        stride: u16,
    ) -> Result<*mut v2d::SceGxmVertexProgram, &'static str> {
        let program = vertex_program(self.patcher, id, attributes, stride)?;
        self.vertex_programs.push(program);
        Ok(program)
    }

    unsafe fn fragment(
        &mut self,
        id: v2d::SceGxmShaderPatcherId,
        blend: Option<&v2d::SceGxmBlendInfo>,
        linked_vertex: *const v2d::SceGxmProgram,
    ) -> Result<*mut v2d::SceGxmFragmentProgram, &'static str> {
        let program = fragment_program(self.patcher, id, blend, linked_vertex)?;
        self.fragment_programs.push(program);
        Ok(program)
    }

    fn finish(mut self) -> [v2d::SceGxmShaderPatcherId; 5] {
        debug_assert_eq!(self.ids.len(), 5);
        let ids = [
            self.ids[0],
            self.ids[1],
            self.ids[2],
            self.ids[3],
            self.ids[4],
        ];
        self.armed = false;
        ids
    }
}

impl Drop for BuildGuard {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        unsafe {
            for &program in self.fragment_programs.iter().rev() {
                v2d::sceGxmShaderPatcherReleaseFragmentProgram(self.patcher, program);
            }
            for &program in self.vertex_programs.iter().rev() {
                v2d::sceGxmShaderPatcherReleaseVertexProgram(self.patcher, program);
            }
            for &id in self.ids.iter().rev() {
                v2d::sceGxmShaderPatcherUnregisterProgram(self.patcher, id);
            }
        }
    }
}

unsafe fn build() -> Result<Pipeline, &'static str> {
    let patcher = v2d::vita2d_get_shader_patcher();
    if patcher.is_null() {
        return Err("vita2d is not initialized (no shader patcher)");
    }

    let mut guard = BuildGuard::new(patcher);
    let (color_v_id, color_v) = guard.register(&COLOR_V.0)?;
    let (color_f_id, _) = guard.register(&COLOR_F.0)?;
    let (texture_v_id, texture_v) = guard.register(&TEXTURE_V.0)?;
    let (texture_f_id, _) = guard.register(&TEXTURE_F.0)?;
    let (texture_tint_f_id, texture_tint_f) = guard.register(&TEXTURE_TINT_F.0)?;

    let col_position = resource_index(color_v, c"aPosition")?;
    let col_color = resource_index(color_v, c"aColor")?;
    let tex_position = resource_index(texture_v, c"aPosition")?;
    let tex_texcoord = resource_index(texture_v, c"aTexcoord")?;
    let col_wvp = parameter(color_v, c"wvp")?;
    let tex_wvp = parameter(texture_v, c"wvp")?;
    let tint_color = parameter(texture_tint_f, c"uTintColor")?;

    let attribute = |offset: u16, format: v2d::SceGxmAttributeFormat, count: u8, reg: u16| {
        v2d::SceGxmVertexAttribute {
            streamIndex: 0,
            offset,
            format: format as u8,
            componentCount: count,
            regIndex: reg,
        }
    };
    let s16 = v2d::SceGxmAttributeFormat_SCE_GXM_ATTRIBUTE_FORMAT_S16;
    let u8n = v2d::SceGxmAttributeFormat_SCE_GXM_ATTRIBUTE_FORMAT_U8N;
    let f32a = v2d::SceGxmAttributeFormat_SCE_GXM_ATTRIBUTE_FORMAT_F32;

    let world_tex_vp = guard.vertex(
        texture_v_id,
        &[
            attribute(WORLD_POSITION_OFFSET, s16, 3, tex_position),
            attribute(WORLD_UV_OFFSET, f32a, 2, tex_texcoord),
        ],
        WORLD_STRIDE,
    )?;
    let world_col_vp = guard.vertex(
        color_v_id,
        &[
            attribute(WORLD_POSITION_OFFSET, s16, 3, col_position),
            attribute(WORLD_COLOR_OFFSET, u8n, 4, col_color),
        ],
        WORLD_STRIDE,
    )?;
    let dyn_col_vp = guard.vertex(
        color_v_id,
        &[
            attribute(4, f32a, 3, col_position),
            attribute(0, u8n, 4, col_color),
        ],
        DYN_COLOR_STRIDE,
    )?;
    let scene_tex_vp = guard.vertex(
        texture_v_id,
        &[
            attribute(SCENE_POSITION_OFFSET, s16, 3, tex_position),
            attribute(SCENE_UV_OFFSET, f32a, 2, tex_texcoord),
        ],
        SCENE_STRIDE,
    )?;
    let scene_lit_vp = guard.vertex(
        color_v_id,
        &[
            attribute(SCENE_POSITION_OFFSET, s16, 3, col_position),
            attribute(SCENE_LIT_OFFSET, u8n, 4, col_color),
        ],
        SCENE_STRIDE,
    )?;
    let scene_fog_vp = guard.vertex(
        color_v_id,
        &[
            attribute(SCENE_POSITION_OFFSET, s16, 3, col_position),
            attribute(SCENE_FOG_OFFSET, u8n, 4, col_color),
        ],
        SCENE_STRIDE,
    )?;

    let src_alpha = v2d::SceGxmBlendFactor_SCE_GXM_BLEND_FACTOR_SRC_ALPHA;
    let inv_src_alpha = v2d::SceGxmBlendFactor_SCE_GXM_BLEND_FACTOR_ONE_MINUS_SRC_ALPHA;
    let one = v2d::SceGxmBlendFactor_SCE_GXM_BLEND_FACTOR_ONE;
    let zero = v2d::SceGxmBlendFactor_SCE_GXM_BLEND_FACTOR_ZERO;
    let dst_color = v2d::SceGxmBlendFactor_SCE_GXM_BLEND_FACTOR_DST_COLOR;
    let alpha = blend_info(src_alpha, inv_src_alpha, one, inv_src_alpha);
    let additive = blend_info(src_alpha, one, one, one);
    let multiply = blend_info(dst_color, zero, zero, one);

    let tex_opaque_fp = guard.fragment(texture_f_id, None, texture_v)?;
    let tex_tint_blend_fp = guard.fragment(texture_tint_f_id, Some(&alpha), texture_v)?;
    let col_opaque_fp = guard.fragment(color_f_id, None, color_v)?;
    let col_multiply_fp = guard.fragment(color_f_id, Some(&multiply), color_v)?;
    let col_alpha_fp = guard.fragment(color_f_id, Some(&alpha), color_v)?;
    let col_additive_fp = guard.fragment(color_f_id, Some(&additive), color_v)?;

    let indices = GpuSlab::alloc(SEQUENTIAL_INDEX_COUNT * 2)?;
    let sequential = indices.as_ptr().cast::<u16>();
    for value in 0..SEQUENTIAL_INDEX_COUNT {
        sequential.add(value).write(value as u16);
    }
    let registered_ids = guard.finish();

    Ok(Pipeline {
        patcher,
        registered_ids,
        world_tex_vp,
        world_col_vp,
        dyn_col_vp,
        scene_tex_vp,
        scene_lit_vp,
        scene_fog_vp,
        tex_opaque_fp,
        tex_tint_blend_fp,
        col_opaque_fp,
        col_multiply_fp,
        col_alpha_fp,
        col_additive_fp,
        tex_wvp,
        col_wvp,
        tint_color,
        sequential_indices: indices,
    })
}

/// Initialize (once) and fetch the pipeline. vita2d must be initialized.
///
/// # Safety
///
/// Render-thread only, after vita2d init.
pub unsafe fn pipeline() -> Result<&'static Pipeline, &'static str> {
    let slot = PIPELINE.0.get();
    if (*slot).is_none() {
        // One render-thread-only initialization. After this write the option
        // is immutable, so returned shared references cannot be invalidated by
        // later calls.
        slot.write(Some(build()));
    }
    (*slot).as_ref().unwrap().as_ref().map_err(|error| *error)
}

/// The initialization error, if pipeline construction failed.
///
/// # Safety
///
/// Render-thread only.
pub unsafe fn init_error() -> Option<&'static str> {
    match &*PIPELINE.0.get() {
        Some(Err(error)) => Some(error),
        _ => None,
    }
}

/// Release every pipeline-owned shader patcher object and GPU slab, allowing
/// a later vita2d initialization to rebuild the backend cleanly.
///
/// # Safety
///
/// Render-thread only, outside an open scene, with no retained pipeline
/// references. Call before `vita2d_fini`.
pub unsafe fn shutdown() {
    let slot = &mut *PIPELINE.0.get();
    let Some(state) = slot.take() else {
        return;
    };
    if let Ok(pipeline) = state {
        v2d::vita2d_wait_rendering_done();
        pipeline.destroy();
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum DepthMode {
    /// Depth-tested and depth-written opaque geometry.
    Opaque,
    /// Depth-tested translucency that leaves the depth buffer untouched.
    TestOnly,
    /// Unconditional overlay (view models, HUD hand-off).
    Overlay,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum ColorMode {
    Opaque,
    Alpha,
    Additive,
}

/// Apply one of the backend's depth configurations.
///
/// # Safety
///
/// Render-thread only, inside an open vita2d scene.
pub unsafe fn set_depth(mode: DepthMode) {
    let context = v2d::vita2d_get_context();
    let (function, write) = match mode {
        DepthMode::Opaque => (
            v2d::SceGxmDepthFunc_SCE_GXM_DEPTH_FUNC_LESS_EQUAL,
            v2d::SceGxmDepthWriteMode_SCE_GXM_DEPTH_WRITE_ENABLED,
        ),
        DepthMode::TestOnly => (
            v2d::SceGxmDepthFunc_SCE_GXM_DEPTH_FUNC_LESS_EQUAL,
            v2d::SceGxmDepthWriteMode_SCE_GXM_DEPTH_WRITE_DISABLED,
        ),
        DepthMode::Overlay => (
            v2d::SceGxmDepthFunc_SCE_GXM_DEPTH_FUNC_ALWAYS,
            v2d::SceGxmDepthWriteMode_SCE_GXM_DEPTH_WRITE_DISABLED,
        ),
    };
    v2d::sceGxmSetFrontDepthFunc(context, function);
    v2d::sceGxmSetBackDepthFunc(context, function);
    v2d::sceGxmSetFrontDepthWriteEnable(context, write);
    v2d::sceGxmSetBackDepthWriteEnable(context, write);
}

impl Pipeline {
    unsafe fn destroy(self) {
        for program in [
            self.col_additive_fp,
            self.col_alpha_fp,
            self.col_multiply_fp,
            self.col_opaque_fp,
            self.tex_tint_blend_fp,
            self.tex_opaque_fp,
        ] {
            v2d::sceGxmShaderPatcherReleaseFragmentProgram(self.patcher, program);
        }
        for program in [
            self.scene_fog_vp,
            self.scene_lit_vp,
            self.scene_tex_vp,
            self.dyn_col_vp,
            self.world_col_vp,
            self.world_tex_vp,
        ] {
            v2d::sceGxmShaderPatcherReleaseVertexProgram(self.patcher, program);
        }
        for id in self.registered_ids.into_iter().rev() {
            v2d::sceGxmShaderPatcherUnregisterProgram(self.patcher, id);
        }
        self.sequential_indices.free();
    }

    unsafe fn set_wvp(
        &self,
        parameter: *const v2d::SceGxmProgramParameter,
        wvp: &[f32; 16],
    ) -> bool {
        let context = v2d::vita2d_get_context();
        let mut buffer: *mut c_void = ptr::null_mut();
        if v2d::sceGxmReserveVertexDefaultUniformBuffer(context, &mut buffer) < 0 {
            return false;
        }
        v2d::sceGxmSetUniformDataF(buffer, parameter, 0, 16, wvp.as_ptr()) >= 0
    }

    /// Bind the world textured pass (cooked stream + texture fragment).
    pub unsafe fn bind_world_textured(&self, wvp: &[f32; 16]) -> bool {
        let context = v2d::vita2d_get_context();
        v2d::sceGxmSetVertexProgram(context, self.world_tex_vp);
        v2d::sceGxmSetFragmentProgram(context, self.tex_opaque_fp);
        self.set_wvp(self.tex_wvp, wvp)
    }

    /// Bind the world baked-light multiply pass over the same stream.
    pub unsafe fn bind_world_light(&self, wvp: &[f32; 16]) -> bool {
        let context = v2d::vita2d_get_context();
        v2d::sceGxmSetVertexProgram(context, self.world_col_vp);
        v2d::sceGxmSetFragmentProgram(context, self.col_multiply_fp);
        self.set_wvp(self.col_wvp, wvp)
    }

    /// Bind the world gouraud fallback (texture upload failed).
    pub unsafe fn bind_world_gouraud(&self, wvp: &[f32; 16]) -> bool {
        let context = v2d::vita2d_get_context();
        v2d::sceGxmSetVertexProgram(context, self.world_col_vp);
        v2d::sceGxmSetFragmentProgram(context, self.col_opaque_fp);
        self.set_wvp(self.col_wvp, wvp)
    }

    /// Bind staged color-vertex drawing with the requested blend equation.
    pub unsafe fn bind_dynamic_color(&self, wvp: &[f32; 16], mode: ColorMode) -> bool {
        let context = v2d::vita2d_get_context();
        v2d::sceGxmSetVertexProgram(context, self.dyn_col_vp);
        v2d::sceGxmSetFragmentProgram(
            context,
            match mode {
                ColorMode::Opaque => self.col_opaque_fp,
                ColorMode::Alpha => self.col_alpha_fp,
                ColorMode::Additive => self.col_additive_fp,
            },
        );
        self.set_wvp(self.col_wvp, wvp)
    }

    /// Bind resident world-textured drawing with alpha blending and one flat
    /// tint (used for masked "cutout" world surfaces).
    pub unsafe fn bind_world_masked(&self, wvp: &[f32; 16]) -> bool {
        let context = v2d::vita2d_get_context();
        v2d::sceGxmSetVertexProgram(context, self.world_tex_vp);
        v2d::sceGxmSetFragmentProgram(context, self.tex_tint_blend_fp);
        self.set_wvp(self.tex_wvp, wvp)
    }

    /// Set the flat tint for [`Self::bind_world_masked`] submissions.
    pub unsafe fn set_tint(&self, rgba: [f32; 4]) -> bool {
        let context = v2d::vita2d_get_context();
        let mut buffer: *mut c_void = ptr::null_mut();
        if v2d::sceGxmReserveFragmentDefaultUniformBuffer(context, &mut buffer) < 0 {
            return false;
        }
        v2d::sceGxmSetUniformDataF(buffer, self.tint_color, 0, 4, rgba.as_ptr()) >= 0
    }

    /// Bind `texture` (a vita2d texture) to fragment unit 0.
    pub unsafe fn set_texture(&self, texture: *const v2d::vita2d_texture) -> bool {
        if texture.is_null() {
            return false;
        }
        let context = v2d::vita2d_get_context();
        v2d::sceGxmSetFragmentTexture(context, 0, &(*texture).gxm_tex) >= 0
    }

    /// Point stream 0 at `vertices` (GPU-visible memory).
    pub unsafe fn set_stream(&self, vertices: *const c_void) -> bool {
        v2d::sceGxmSetVertexStream(v2d::vita2d_get_context(), 0, vertices) >= 0
    }

    /// Issue one indexed triangle-list draw from GPU-visible `indices`.
    pub unsafe fn draw_indexed(&self, indices: *const u16, count: u32) -> bool {
        v2d::sceGxmDraw(
            v2d::vita2d_get_context(),
            v2d::SceGxmPrimitiveType_SCE_GXM_PRIMITIVE_TRIANGLES,
            v2d::SceGxmIndexFormat_SCE_GXM_INDEX_FORMAT_U16,
            indices.cast(),
            count,
        ) >= 0
    }

    /// Draw `count` sequential vertices (identity index buffer).
    pub unsafe fn draw_sequential(&self, count: u32) -> bool {
        debug_assert!(count as usize <= SEQUENTIAL_INDEX_COUNT);
        self.draw_indexed(self.sequential_indices.as_ptr().cast(), count)
    }
}

// ---------------------------------------------------------------------------
// Authored-scene pipeline
// ---------------------------------------------------------------------------

/// Which of the three scene passes a bind or uniform update addresses.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum ScenePass {
    /// Texture only, depth-written. The first pass over opaque geometry.
    Albedo,
    /// Multiplies the baked `lit` colour over the albedo already in the tile.
    Light,
    /// Adds the baked fog colour scaled by its coverage.
    Fog,
    /// One-pass alpha-blended cutout: texture times a flat per-chunk tint.
    Cutout,
}

/// Face culling for the scene passes. Foliage cards are drawn from both sides.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum CullMode {
    Back,
    None,
}

/// Apply a face-culling mode.
///
/// # Safety
///
/// Render-thread only, inside an open vita2d scene.
pub unsafe fn set_cull(mode: CullMode) {
    let context = v2d::vita2d_get_context();
    let value = match mode {
        CullMode::Back => v2d::SceGxmCullMode_SCE_GXM_CULL_CCW,
        CullMode::None => v2d::SceGxmCullMode_SCE_GXM_CULL_NONE,
    };
    v2d::sceGxmSetCullMode(context, value);
}

/// A GPU-resident texture with its own mip chain.
///
/// vita2d's texture helper allocates one linear level; a forest at 960x544
/// needs the chain, so this owns its memory and builds a swizzled GXM texture
/// over it. The embedded `vita2d_texture` exists so the value can be handed to
/// [`Pipeline::set_texture`] like any other; it is never freed by vita2d.
pub struct MipTexture {
    slab: GpuSlab,
    handle: v2d::vita2d_texture,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TextureError {
    NotPowerOfTwoSquare,
    TooManyLevels,
    TruncatedLevels,
    OutOfMemory,
    InitFailed,
}

/// Interleave `x` into the even bits and `y` into the odd bits.
fn morton(x: u32, y: u32) -> u32 {
    fn spread(mut value: u32) -> u32 {
        value &= 0x0000_ffff;
        value = (value | (value << 8)) & 0x00ff_00ff;
        value = (value | (value << 4)) & 0x0f0f_0f0f;
        value = (value | (value << 2)) & 0x3333_3333;
        (value | (value << 1)) & 0x5555_5555
    }
    spread(x) | (spread(y) << 1)
}

impl MipTexture {
    /// Upload a square power-of-two RGBA8 mip chain, level 0 first.
    ///
    /// # Safety
    ///
    /// Render-thread only, after vita2d initialization.
    pub unsafe fn upload(size: u32, levels: u8, chain: &[u8]) -> Result<Self, TextureError> {
        if size == 0 || !size.is_power_of_two() {
            return Err(TextureError::NotPowerOfTwoSquare);
        }
        if levels == 0 || levels as u32 > size.trailing_zeros() + 1 {
            return Err(TextureError::TooManyLevels);
        }
        let mut total = 0usize;
        for level in 0..levels as u32 {
            let extent = (size >> level).max(1) as usize;
            total += extent * extent * 4;
        }
        if chain.len() < total {
            return Err(TextureError::TruncatedLevels);
        }

        let slab = GpuSlab::alloc(total).map_err(|_| TextureError::OutOfMemory)?;
        let base = slab.as_ptr();
        let mut offset = 0usize;
        for level in 0..levels as u32 {
            let extent = (size >> level).max(1) as usize;
            let source = &chain[offset..offset + extent * extent * 4];
            let destination = base.add(offset).cast::<u32>();
            for y in 0..extent {
                for x in 0..extent {
                    let texel = u32::from_le_bytes([
                        source[(y * extent + x) * 4],
                        source[(y * extent + x) * 4 + 1],
                        source[(y * extent + x) * 4 + 2],
                        source[(y * extent + x) * 4 + 3],
                    ]);
                    destination
                        .add(morton(x as u32, y as u32) as usize)
                        .write(texel);
                }
            }
            offset += extent * extent * 4;
        }

        let mut handle: v2d::vita2d_texture = core::mem::zeroed();
        if v2d::sceGxmTextureInitSwizzled(
            &mut handle.gxm_tex,
            base.cast(),
            v2d::SceGxmTextureFormat_SCE_GXM_TEXTURE_FORMAT_A8B8G8R8,
            size,
            size,
            levels as u32,
        ) < 0
        {
            slab.free();
            return Err(TextureError::InitFailed);
        }
        handle.data_UID = -1;
        handle.palette_UID = -1;
        v2d::sceGxmTextureSetMinFilter(
            &mut handle.gxm_tex,
            v2d::SceGxmTextureFilter_SCE_GXM_TEXTURE_FILTER_LINEAR,
        );
        v2d::sceGxmTextureSetMagFilter(
            &mut handle.gxm_tex,
            v2d::SceGxmTextureFilter_SCE_GXM_TEXTURE_FILTER_LINEAR,
        );
        v2d::sceGxmTextureSetMipFilter(
            &mut handle.gxm_tex,
            v2d::SceGxmTextureMipFilter_SCE_GXM_TEXTURE_MIP_FILTER_ENABLED,
        );
        v2d::sceGxmTextureSetMipmapCount(&mut handle.gxm_tex, levels as u32);
        Ok(Self { slab, handle })
    }

    pub fn set_repeat(&mut self, repeat: bool) {
        let mode = if repeat {
            v2d::SceGxmTextureAddrMode_SCE_GXM_TEXTURE_ADDR_REPEAT
        } else {
            v2d::SceGxmTextureAddrMode_SCE_GXM_TEXTURE_ADDR_CLAMP
        };
        unsafe {
            v2d::sceGxmTextureSetUAddrMode(&mut self.handle.gxm_tex, mode);
            v2d::sceGxmTextureSetVAddrMode(&mut self.handle.gxm_tex, mode);
        }
    }

    pub fn handle(&self) -> *const v2d::vita2d_texture {
        &self.handle
    }

    /// Release the GPU allocation.
    ///
    /// # Safety
    ///
    /// No queued or in-flight GXM work may sample this texture.
    pub unsafe fn free(self) {
        self.slab.free();
    }
}

impl Pipeline {
    /// Bind the programs for one scene pass. `set_scene_transform` then
    /// supplies each chunk's own matrix without rebinding.
    pub unsafe fn bind_scene(&self, pass: ScenePass) -> bool {
        let context = v2d::vita2d_get_context();
        let (vertex, fragment) = match pass {
            ScenePass::Albedo => (self.scene_tex_vp, self.tex_opaque_fp),
            ScenePass::Light => (self.scene_lit_vp, self.col_multiply_fp),
            ScenePass::Fog => (self.scene_fog_vp, self.col_additive_fp),
            ScenePass::Cutout => (self.scene_tex_vp, self.tex_tint_blend_fp),
        };
        v2d::sceGxmSetVertexProgram(context, vertex);
        v2d::sceGxmSetFragmentProgram(context, fragment);
        true
    }

    /// Upload one chunk's `view_proj * dequantize` matrix.
    pub unsafe fn set_scene_transform(&self, pass: ScenePass, wvp: &[f32; 16]) -> bool {
        let parameter = match pass {
            ScenePass::Albedo | ScenePass::Cutout => self.tex_wvp,
            ScenePass::Light | ScenePass::Fog => self.col_wvp,
        };
        self.set_wvp(parameter, wvp)
    }
}
