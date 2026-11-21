//! GXP programs: aligned storage, shader-patcher registration, parameter
//! lookup and patched vertex/fragment program creation.

use core::ffi::CStr;
use core::ptr;
use std::ffi::CString;

use vita2d_sys as g;

/// Register an aligned, process-lifetime GXP without copying its storage.
/// # Safety
/// `patcher` must be live and confined to the render thread. Release all
/// patched programs before unregistering the returned id.
pub unsafe fn register_static(
    patcher: *mut g::SceGxmShaderPatcher,
    bytes: &'static [u8],
) -> Result<(g::SceGxmShaderPatcherId, *const g::SceGxmProgram), String> {
    let program = validate(bytes)?;
    Ok((register(patcher, program)?, program))
}

unsafe fn validate(bytes: &[u8]) -> Result<*const g::SceGxmProgram, String> {
    // SceGxmProgram is opaque (zero-sized in the bindings). Check the fixed
    // GXP header and its declared size before handing storage to the firmware.
    if bytes.len() < 16 || &bytes[..4] != b"GXP\0" || (bytes.as_ptr() as usize) % 16 != 0 {
        return Err("truncated or unaligned GXP program".into());
    }
    let declared = u32::from_le_bytes(bytes[8..12].try_into().unwrap()) as usize;
    if declared < 16 || declared > bytes.len() {
        return Err("truncated GXP program".into());
    }
    let program = bytes.as_ptr().cast();
    if g::sceGxmProgramCheck(program) < 0 {
        return Err("sceGxmProgramCheck rejected the program".into());
    }
    if g::sceGxmProgramGetSize(program) as usize > bytes.len() {
        return Err("truncated GXP program".into());
    }
    Ok(program)
}

unsafe fn register(
    patcher: *mut g::SceGxmShaderPatcher,
    program: *const g::SceGxmProgram,
) -> Result<g::SceGxmShaderPatcherId, String> {
    let mut id = ptr::null_mut();
    let r = g::sceGxmShaderPatcherRegisterProgram(patcher, program, &mut id);
    if r < 0 {
        return Err(format!("sceGxmShaderPatcherRegisterProgram 0x{r:08x}"));
    }
    Ok(id)
}

/// A GXP binary in 16-byte aligned storage. GXM reads the program in place,
/// so the storage must outlive its registration with the shader patcher.
pub struct Gxp {
    storage: crate::aligned::AlignedBytes,
}

impl Gxp {
    pub fn new(bytes: &[u8]) -> Result<Self, String> {
        let gxp = Self {
            storage: crate::aligned::AlignedBytes::new(bytes),
        };
        unsafe {
            validate(gxp.bytes())?;
        }
        Ok(gxp)
    }

    pub fn program(&self) -> *const g::SceGxmProgram {
        self.bytes().as_ptr().cast()
    }

    pub fn bytes(&self) -> &[u8] {
        self.storage.bytes()
    }
}

/// A program registered with the shader patcher.
pub struct Registered {
    pub gxp: Gxp,
    pub id: g::SceGxmShaderPatcherId,
}

impl Registered {
    /// # Safety
    /// `patcher` must be a live shader patcher; unregister before it is destroyed.
    pub unsafe fn new(patcher: *mut g::SceGxmShaderPatcher, gxp: Gxp) -> Result<Self, String> {
        let id = register(patcher, gxp.program())?;
        Ok(Self { gxp, id })
    }

    pub fn program(&self) -> *const g::SceGxmProgram {
        self.gxp.program()
    }

    /// Named uniform/sampler parameter, or null when the compiler removed it.
    pub fn param(&self, name: &str) -> *const g::SceGxmProgramParameter {
        let c = CString::new(name).unwrap();
        unsafe { g::sceGxmProgramFindParameterByName(self.program(), c.as_ptr()) }
    }

    pub fn attribute_index(&self, name: &str) -> Option<u16> {
        let p = self.param(name);
        if p.is_null() {
            None
        } else {
            Some(unsafe { g::sceGxmProgramParameterGetResourceIndex(p) } as u16)
        }
    }

    pub fn sampler_index(&self, name: &str) -> Option<u32> {
        let p = self.param(name);
        if p.is_null() {
            None
        } else {
            Some(unsafe { g::sceGxmProgramParameterGetResourceIndex(p) })
        }
    }

    /// # Safety
    /// Same patcher as registration.
    pub unsafe fn unregister(self, patcher: *mut g::SceGxmShaderPatcher) {
        g::sceGxmShaderPatcherUnregisterProgram(patcher, self.id);
    }
}

pub fn param_name(p: *const g::SceGxmProgramParameter) -> String {
    if p.is_null() {
        return String::new();
    }
    unsafe {
        let n = g::sceGxmProgramParameterGetName(p);
        if n.is_null() {
            String::new()
        } else {
            CStr::from_ptr(n).to_string_lossy().into_owned()
        }
    }
}

#[derive(Clone, Copy)]
pub struct Attr {
    pub reg: u16,
    pub offset: u16,
    pub format: u32,
    pub count: u8,
    pub stream: u16,
}

pub const F32: u32 = g::SceGxmAttributeFormat_SCE_GXM_ATTRIBUTE_FORMAT_F32 as u32;
pub const F16: u32 = g::SceGxmAttributeFormat_SCE_GXM_ATTRIBUTE_FORMAT_F16 as u32;
pub const S16N: u32 = g::SceGxmAttributeFormat_SCE_GXM_ATTRIBUTE_FORMAT_S16N as u32;
pub const U16N: u32 = g::SceGxmAttributeFormat_SCE_GXM_ATTRIBUTE_FORMAT_U16N as u32;
pub const S16: u32 = g::SceGxmAttributeFormat_SCE_GXM_ATTRIBUTE_FORMAT_S16 as u32;
pub const S8N: u32 = g::SceGxmAttributeFormat_SCE_GXM_ATTRIBUTE_FORMAT_S8N as u32;
pub const U8N: u32 = g::SceGxmAttributeFormat_SCE_GXM_ATTRIBUTE_FORMAT_U8N as u32;
pub const U8: u32 = g::SceGxmAttributeFormat_SCE_GXM_ATTRIBUTE_FORMAT_U8 as u32;

/// # Safety
/// Live patcher and registered program.
pub unsafe fn vertex_program(
    patcher: *mut g::SceGxmShaderPatcher,
    program: &Registered,
    attrs: &[Attr],
    strides: &[u16],
) -> Result<*mut g::SceGxmVertexProgram, String> {
    let attributes: Vec<g::SceGxmVertexAttribute> = attrs
        .iter()
        .map(|a| g::SceGxmVertexAttribute {
            streamIndex: a.stream,
            offset: a.offset,
            format: a.format as u8,
            componentCount: a.count,
            regIndex: a.reg,
        })
        .collect();
    let streams: Vec<g::SceGxmVertexStream> = strides
        .iter()
        .map(|&stride| g::SceGxmVertexStream {
            stride,
            indexSource: g::SceGxmIndexSource_SCE_GXM_INDEX_SOURCE_INDEX_16BIT as u16,
        })
        .collect();
    let mut out: *mut g::SceGxmVertexProgram = ptr::null_mut();
    let r = g::sceGxmShaderPatcherCreateVertexProgram(
        patcher,
        program.id,
        attributes.as_ptr(),
        attributes.len() as u32,
        streams.as_ptr(),
        streams.len() as u32,
        &mut out,
    );
    if r < 0 {
        return Err(format!(
            "sceGxmShaderPatcherCreateVertexProgram 0x{:08x}",
            r as u32
        ));
    }
    Ok(out)
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Blend {
    Opaque,
    Alpha,
    /// Premultiplied alpha (`src + dst * (1 - srcA)`).
    Premultiplied,
    Additive,
    Multiply,
}

fn blend_info(blend: Blend) -> Option<g::SceGxmBlendInfo> {
    use g::*;
    let (cs, cd, as_, ad) = match blend {
        Blend::Opaque => return None,
        Blend::Alpha => (
            SceGxmBlendFactor_SCE_GXM_BLEND_FACTOR_SRC_ALPHA,
            SceGxmBlendFactor_SCE_GXM_BLEND_FACTOR_ONE_MINUS_SRC_ALPHA,
            SceGxmBlendFactor_SCE_GXM_BLEND_FACTOR_ZERO,
            SceGxmBlendFactor_SCE_GXM_BLEND_FACTOR_ONE,
        ),
        Blend::Premultiplied => (
            SceGxmBlendFactor_SCE_GXM_BLEND_FACTOR_ONE,
            SceGxmBlendFactor_SCE_GXM_BLEND_FACTOR_ONE_MINUS_SRC_ALPHA,
            SceGxmBlendFactor_SCE_GXM_BLEND_FACTOR_ZERO,
            SceGxmBlendFactor_SCE_GXM_BLEND_FACTOR_ONE,
        ),
        Blend::Additive => (
            SceGxmBlendFactor_SCE_GXM_BLEND_FACTOR_ONE,
            SceGxmBlendFactor_SCE_GXM_BLEND_FACTOR_ONE,
            SceGxmBlendFactor_SCE_GXM_BLEND_FACTOR_ZERO,
            SceGxmBlendFactor_SCE_GXM_BLEND_FACTOR_ONE,
        ),
        Blend::Multiply => (
            SceGxmBlendFactor_SCE_GXM_BLEND_FACTOR_DST_COLOR,
            SceGxmBlendFactor_SCE_GXM_BLEND_FACTOR_ZERO,
            SceGxmBlendFactor_SCE_GXM_BLEND_FACTOR_ZERO,
            SceGxmBlendFactor_SCE_GXM_BLEND_FACTOR_ONE,
        ),
    };
    let mut info = SceGxmBlendInfo {
        colorMask: SceGxmColorMask_SCE_GXM_COLOR_MASK_ALL as u8,
        _bitfield_align_1: [],
        _bitfield_1: Default::default(),
    };
    info.set_colorFunc(SceGxmBlendFunc_SCE_GXM_BLEND_FUNC_ADD as u8);
    info.set_alphaFunc(SceGxmBlendFunc_SCE_GXM_BLEND_FUNC_ADD as u8);
    info.set_colorSrc(cs as u8);
    info.set_colorDst(cd as u8);
    info.set_alphaSrc(as_ as u8);
    info.set_alphaDst(ad as u8);
    Some(info)
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Output {
    /// 8-bit RGBA targets (the display buffer).
    Uchar4,
    /// 4×F16 (64-bit) targets.
    Half4,
    /// Packed 32-bit float formats (F11F11F10, SE5M9M9M9) are written through
    /// half registers and packed by the output unit.
    Half2,
    /// Single-channel F32 (32-bit) targets. This selects output conversion;
    /// it does not increase the precision of arithmetic compiled into GXP.
    Float,
    /// Two unsigned-normalized 16-bit channels in one 32-bit register.
    /// Return float4 COLOR with R/G in [0, 1], not integer-valued floats in
    /// [0, 65535]. Use float4 even when only two components are stored.
    /// For data targets, avoid half intermediates and disable blending and
    /// dithering; output conversion cannot recover precision lost earlier.
    Ushort2,
}

/// # Safety
/// Live patcher; `linked_vertex` is the vertex program that feeds this stage.
pub unsafe fn fragment_program(
    patcher: *mut g::SceGxmShaderPatcher,
    program: &Registered,
    output: Output,
    msaa: u32,
    blend: Blend,
    linked_vertex: *const g::SceGxmProgram,
) -> Result<*mut g::SceGxmFragmentProgram, String> {
    let info = blend_info(blend);
    let format = match output {
        Output::Uchar4 => g::SceGxmOutputRegisterFormat_SCE_GXM_OUTPUT_REGISTER_FORMAT_UCHAR4,
        Output::Half4 => g::SceGxmOutputRegisterFormat_SCE_GXM_OUTPUT_REGISTER_FORMAT_HALF4,
        Output::Half2 => g::SceGxmOutputRegisterFormat_SCE_GXM_OUTPUT_REGISTER_FORMAT_HALF2,
        Output::Float => g::SceGxmOutputRegisterFormat_SCE_GXM_OUTPUT_REGISTER_FORMAT_FLOAT,
        Output::Ushort2 => g::SceGxmOutputRegisterFormat_SCE_GXM_OUTPUT_REGISTER_FORMAT_USHORT2,
    };
    let mut out: *mut g::SceGxmFragmentProgram = ptr::null_mut();
    let r = g::sceGxmShaderPatcherCreateFragmentProgram(
        patcher,
        program.id,
        format,
        msaa as _,
        info.as_ref().map_or(ptr::null(), |b| b as *const _),
        linked_vertex,
        &mut out,
    );
    if r < 0 {
        return Err(format!(
            "sceGxmShaderPatcherCreateFragmentProgram 0x{:08x}",
            r as u32
        ));
    }
    Ok(out)
}

/// Writes `values` to a uniform in the default uniform buffer `buffer`.
///
/// # Safety
/// `buffer` comes from sceGxmReserve*DefaultUniformBuffer for the current draw.
#[inline]
pub unsafe fn set_uniform(
    buffer: *mut core::ffi::c_void,
    param: *const g::SceGxmProgramParameter,
    values: &[f32],
) {
    if !param.is_null() && !buffer.is_null() {
        g::sceGxmSetUniformDataF(buffer, param, 0, values.len() as u32, values.as_ptr());
    }
}
