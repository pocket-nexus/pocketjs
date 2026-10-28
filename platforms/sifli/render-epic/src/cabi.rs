//! C composition bridge: `pocket/render_sifli_epic.h`. The SDK archive
//! contains no device driver; the program passes the executor's ops table.
#![allow(clippy::missing_safety_doc)]
use crate::caps::{Capabilities, Thresholds};
use crate::cmd::{Cmd, Filter, MaskId, TexSrc, TileId};
use crate::executor::{ExecError, Executor, TextureFormat, TextureSource};
use crate::geom::{Point, Rect};
use crate::renderer::{EpicRenderer, RendererConfig, Submission};
use alloc::{boxed::Box, vec::Vec};
use core::{
    cell::RefCell,
    ffi::c_void,
    mem::{align_of, size_of},
    ptr, slice,
};
use pocket_drivers::{abi::*, DeviceTarget, PixelFormat, Rect as Region, RenderError, Renderer};
use pocket_runtime_cabi::adapters::{borrowed, rect, AdapterError, CResources};

pub const POCKET_EPIC_FILL_OPAQUE: u32 = 1 << 0;
pub const POCKET_EPIC_FILL_ALPHA: u32 = 1 << 1;
pub const POCKET_EPIC_A8_BLEND: u32 = 1 << 2;
pub const POCKET_EPIC_GRADIENT: u32 = 1 << 3;
pub const POCKET_EPIC_BLIT: u32 = 1 << 4;
pub const POCKET_EPIC_BLIT_QUAD: u32 = 1 << 5;
pub const POCKET_EPIC_BLIT_MODULATE: u32 = 1 << 6;
pub const POCKET_EPIC_PORTABLE_TEXTURES: u32 = 1 << 7;
pub const POCKET_EPIC_BLIT_MIRROR_Y: u32 = 1 << 8;

const OP_FILL: u32 = 1;
const OP_FILL_ALPHA: u32 = 2;
const OP_BLEND_A8: u32 = 3;
const OP_GRADIENT: u32 = 4;
const OP_BLIT: u32 = 5;
const OP_BLIT_QUAD: u32 = 6;
const OP_TILE_OUT: u32 = 7;
const OP_TILE_IN: u32 = 8;
const OP_FENCE: u32 = 9;
const MIRROR_X: u32 = 1 << 0;
const MIRROR_Y: u32 = 1 << 1;
const LINEAR: u32 = 1 << 2;
const SOURCE_TEXTURE: u32 = 1;
const SOURCE_SOLID: u32 = 2;
const TEXTURE_NATIVE: u32 = 0;
const TEXTURE_PORTABLE: u32 = 1;

#[derive(Clone, Copy, Default)]
#[repr(C)]
pub struct EpicCaps {
    pub struct_size: usize,
    pub flags: u32,
    pub coordinate_limit: u32,
    pub mask_bytes: usize,
    pub tile_pixels: usize,
    pub min_fill: u32,
    pub min_gradient: u32,
    pub min_blend: u32,
    pub min_blit: u32,
}

#[derive(Clone, Copy, Default)]
#[repr(C)]
pub struct EpicRect {
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
}

#[derive(Clone, Copy, Default)]
#[repr(C)]
pub struct EpicPoint {
    pub x: i32,
    pub y: i32,
}

#[derive(Clone, Copy, Default)]
#[repr(C)]
pub struct EpicCmd {
    pub op: u32,
    pub flags: u32,
    pub dst: EpicRect,
    pub clip: EpicRect,
    pub src: EpicRect,
    pub quad: [EpicPoint; 4],
    pub color: u32,
    pub corners: [u32; 4],
    pub source: u32,
    pub texture: u32,
    pub mask: u32,
    pub mask_offset: u32,
    pub mask_stride: u32,
    pub tile: u32,
}

#[derive(Clone, Copy)]
#[repr(C)]
pub struct EpicTexture {
    pub struct_size: usize,
    pub kind: u32,
    pub format: u32,
    pub width: u32,
    pub height: u32,
    pub pixels: *const u8,
    pub pixel_bytes: usize,
    pub palette: *const u8,
}

pub type EpicCapsFn = unsafe extern "C" fn(*mut c_void, *mut EpicCaps) -> i32;
pub type EpicBeginFn = unsafe extern "C" fn(*mut c_void, u64, u32, u32) -> i32;
pub type EpicSubmitFn = unsafe extern "C" fn(*mut c_void, *const EpicCmd, usize) -> i32;
pub type EpicStatusFn = unsafe extern "C" fn(*mut c_void) -> i32;
pub type EpicMaskFn = unsafe extern "C" fn(*mut c_void, u32, *mut usize) -> *mut u8;
pub type EpicTileFn = unsafe extern "C" fn(*mut c_void, u32, *mut usize) -> *mut u16;
pub type EpicRegisterFn = unsafe extern "C" fn(*mut c_void, *const EpicTexture, *mut u32) -> i32;
pub type EpicReleaseFn = unsafe extern "C" fn(*mut c_void, u32);

#[derive(Clone, Copy)]
#[repr(C)]
pub struct EpicOpsV1 {
    pub struct_size: usize,
    pub context: *mut c_void,
    pub caps: Option<EpicCapsFn>,
    pub begin: Option<EpicBeginFn>,
    pub submit: Option<EpicSubmitFn>,
    pub fence: Option<EpicStatusFn>,
    pub end: Option<EpicStatusFn>,
    pub mask: Option<EpicMaskFn>,
    pub tile: Option<EpicTileFn>,
    pub register_texture: Option<EpicRegisterFn>,
    pub release_texture: Option<EpicReleaseFn>,
}

#[derive(Clone, Copy)]
#[repr(C)]
pub struct EpicConfig {
    pub struct_size: usize,
    pub scale: u32,
    pub native_textures: *const u8,
    pub native_texture_bytes: usize,
    pub max_textures: u32,
}

fn status(value: i32) -> Result<(), ExecError> {
    match value {
        POCKET_STATUS_OK => Ok(()),
        POCKET_STATUS_UNSUPPORTED | POCKET_STATUS_INVALID => Err(ExecError::Unsupported),
        _ => Err(ExecError::Failed),
    }
}

fn epic_rect(r: Rect) -> EpicRect {
    EpicRect {
        x: r.x,
        y: r.y,
        w: r.w,
        h: r.h,
    }
}

fn epic_point(p: Point) -> EpicPoint {
    EpicPoint { x: p.x, y: p.y }
}

fn source(cmd: &mut EpicCmd, src: TexSrc) {
    match src {
        TexSrc::Texture { id } => {
            cmd.source = SOURCE_TEXTURE;
            cmd.texture = id;
        }
        TexSrc::Solid { abgr } => {
            cmd.source = SOURCE_SOLID;
            cmd.texture = abgr;
        }
    }
}

fn rgb(color: [u8; 3], alpha: u8) -> u32 {
    color[0] as u32 | (color[1] as u32) << 8 | (color[2] as u32) << 16 | (alpha as u32) << 24
}

fn encode(cmd: &Cmd) -> EpicCmd {
    let mut out = EpicCmd::default();
    match *cmd {
        Cmd::Fill { dst, color } => {
            out.op = OP_FILL;
            out.dst = epic_rect(dst);
            out.color = rgb(color, 255);
        }
        Cmd::FillAlpha { dst, color, alpha } => {
            out.op = OP_FILL_ALPHA;
            out.dst = epic_rect(dst);
            out.color = rgb(color, alpha);
        }
        Cmd::BlendA8 {
            dst,
            mask,
            color,
            alpha,
        } => {
            out.op = OP_BLEND_A8;
            out.dst = epic_rect(dst);
            out.color = rgb(color, alpha);
            out.mask = mask.mask.0 as u32;
            out.mask_offset = mask.offset;
            out.mask_stride = mask.stride;
        }
        Cmd::Gradient { dst, corners } => {
            out.op = OP_GRADIENT;
            out.dst = epic_rect(dst);
            out.corners = [
                corners.top_left,
                corners.top_right,
                corners.bottom_left,
                corners.bottom_right,
            ];
        }
        Cmd::Blit {
            src,
            src_rect,
            dst,
            clip,
            mirror,
            modulate,
            filter,
        } => {
            out.op = OP_BLIT;
            out.dst = epic_rect(dst);
            out.clip = epic_rect(clip);
            out.src = epic_rect(src_rect);
            out.color = modulate;
            out.flags = (mirror.x as u32 * MIRROR_X)
                | (mirror.y as u32 * MIRROR_Y)
                | ((filter == Filter::Linear) as u32 * LINEAR);
            source(&mut out, src);
        }
        Cmd::BlitQuad {
            src,
            src_rect,
            quad,
            clip,
            modulate,
            filter,
        } => {
            out.op = OP_BLIT_QUAD;
            out.clip = epic_rect(clip);
            out.src = epic_rect(src_rect);
            out.quad = quad.map(epic_point);
            out.color = modulate;
            out.flags = (filter == Filter::Linear) as u32 * LINEAR;
            source(&mut out, src);
        }
        Cmd::TileOut { tile, src } => {
            out.op = OP_TILE_OUT;
            out.clip = epic_rect(src);
            out.tile = tile.0 as u32;
        }
        Cmd::TileIn { tile, dst } => {
            out.op = OP_TILE_IN;
            out.dst = epic_rect(dst);
            out.tile = tile.0 as u32;
        }
        Cmd::Fence => out.op = OP_FENCE,
    }
    out
}

/// The program's executor behind the C ops table.
pub struct COps {
    ops: EpicOpsV1,
    caps: Capabilities,
    encoded: Vec<EpicCmd>,
}

impl COps {
    unsafe fn new(ops: EpicOpsV1) -> Option<Self> {
        if ops.begin.is_none()
            || ops.submit.is_none()
            || ops.fence.is_none()
            || ops.end.is_none()
            || ops.mask.is_none()
            || ops.tile.is_none()
        {
            return None;
        }
        let mut raw = EpicCaps {
            struct_size: size_of::<EpicCaps>(),
            ..EpicCaps::default()
        };
        status(unsafe { ops.caps?(ops.context, &mut raw) }).ok()?;
        let flag = |bit: u32| raw.flags & bit != 0;
        let registers = ops.register_texture.is_some() && ops.release_texture.is_some();
        let caps = Capabilities {
            fill_opaque: flag(POCKET_EPIC_FILL_OPAQUE),
            fill_alpha: flag(POCKET_EPIC_FILL_ALPHA),
            a8_blend: flag(POCKET_EPIC_A8_BLEND),
            gradient: flag(POCKET_EPIC_GRADIENT),
            blit: registers && flag(POCKET_EPIC_BLIT),
            blit_mirror_y: flag(POCKET_EPIC_BLIT_MIRROR_Y),
            blit_quad: flag(POCKET_EPIC_BLIT_QUAD),
            blit_modulate: flag(POCKET_EPIC_BLIT_MODULATE),
            portable_textures: registers && flag(POCKET_EPIC_PORTABLE_TEXTURES),
            coordinate_limit: raw.coordinate_limit,
            mask_bytes: raw.mask_bytes.min(u32::MAX as usize) as u32,
            tile_pixels: raw.tile_pixels.min(u32::MAX as usize) as u32,
            thresholds: Thresholds {
                min_fill: raw.min_fill,
                min_gradient: raw.min_gradient,
                min_blend: raw.min_blend,
                min_blit: raw.min_blit,
            },
        };
        Some(Self {
            ops,
            caps,
            encoded: Vec::new(),
        })
    }
}

impl Executor for COps {
    fn caps(&self) -> Capabilities {
        self.caps
    }

    fn begin(&mut self, target: u64, width: u32, height: u32) -> Result<(), ExecError> {
        status(unsafe { self.ops.begin.unwrap()(self.ops.context, target, width, height) })
    }

    fn submit(&mut self, cmds: &[Cmd]) -> Result<(), ExecError> {
        self.encoded.clear();
        self.encoded
            .try_reserve(cmds.len())
            .map_err(|_| ExecError::Failed)?;
        self.encoded.extend(cmds.iter().map(encode));
        let result = status(unsafe {
            self.ops.submit.unwrap()(self.ops.context, self.encoded.as_ptr(), self.encoded.len())
        });
        // The planner never submits what the capabilities exclude.
        result.map_err(|_| ExecError::Failed)
    }

    fn fence(&mut self) -> Result<(), ExecError> {
        status(unsafe { self.ops.fence.unwrap()(self.ops.context) })
    }

    fn end(&mut self) -> Result<(), ExecError> {
        status(unsafe { self.ops.end.unwrap()(self.ops.context) })
    }

    fn mask_mut(&mut self, mask: MaskId) -> &mut [u8] {
        let mut length = 0;
        let pointer =
            unsafe { self.ops.mask.unwrap()(self.ops.context, mask.0 as u32, &mut length) };
        if pointer.is_null() || length > isize::MAX as usize {
            return &mut [];
        }
        // SAFETY: the ops contract lends this SRAM plane to the renderer
        // until it next submits a command that reads it.
        unsafe { slice::from_raw_parts_mut(pointer, length) }
    }

    fn tile_mut(&mut self, tile: TileId) -> &mut [u16] {
        let mut length = 0;
        let pointer =
            unsafe { self.ops.tile.unwrap()(self.ops.context, tile.0 as u32, &mut length) };
        if pointer.is_null()
            || !(pointer as usize).is_multiple_of(align_of::<u16>())
            || length > isize::MAX as usize / 2
        {
            return &mut [];
        }
        // SAFETY: as for mask_mut.
        unsafe { slice::from_raw_parts_mut(pointer, length) }
    }

    unsafe fn register_texture(&mut self, source: &TextureSource<'_>) -> Result<u32, ExecError> {
        let (kind, format) = match source.format {
            TextureFormat::Native(format) => (TEXTURE_NATIVE, format as u32),
            TextureFormat::Portable(psm) => (TEXTURE_PORTABLE, psm),
        };
        let texture = EpicTexture {
            struct_size: size_of::<EpicTexture>(),
            kind,
            format,
            width: source.width,
            height: source.height,
            pixels: source.pixels.as_ptr(),
            pixel_bytes: source.pixels.len(),
            palette: source.palette.map_or(ptr::null(), <[u8]>::as_ptr),
        };
        let register = self.ops.register_texture.ok_or(ExecError::Unsupported)?;
        let mut id = 0;
        status(unsafe { register(self.ops.context, &texture, &mut id) })?;
        Ok(id)
    }

    fn release_texture(&mut self, id: u32) {
        if let Some(release) = self.ops.release_texture {
            unsafe { release(self.ops.context, id) };
        }
    }
}

struct Instance {
    renderer: EpicRenderer<COps>,
    next: u64,
    live: Vec<(u64, Submission)>,
    damage: Vec<Region>,
}

pub struct NativeEpicRenderer(RefCell<Instance>);

unsafe fn full_prefix<T: Copy>(pointer: *const T) -> Option<T> {
    if pointer.is_null() {
        return None;
    }
    let size = unsafe { pointer.cast::<usize>().read_unaligned() };
    if size < size_of::<T>() || size > isize::MAX as usize {
        return None;
    }
    Some(unsafe { pointer.read_unaligned() })
}

#[no_mangle]
pub unsafe extern "C" fn pocket_render_sifli_epic_create(
    config: *const EpicConfig,
    ops: *const EpicOpsV1,
) -> *mut NativeEpicRenderer {
    let (Some(config), Some(ops)) = (unsafe { full_prefix(config) }, unsafe { full_prefix(ops) })
    else {
        return ptr::null_mut();
    };
    // SAFETY: the header requires the table to outlive the renderer.
    let native = if config.native_texture_bytes == 0 {
        None
    } else {
        match unsafe { borrowed(config.native_textures, config.native_texture_bytes) } {
            Ok(bytes) => Some(unsafe { slice::from_raw_parts(bytes.as_ptr(), bytes.len()) }),
            Err(_) => return ptr::null_mut(),
        }
    };
    let Some(executor) = (unsafe { COps::new(ops) }) else {
        return ptr::null_mut();
    };
    let Ok(renderer) = EpicRenderer::new(
        RendererConfig {
            scale: config.scale,
            max_textures: config.max_textures as usize,
        },
        native,
        executor,
    ) else {
        return ptr::null_mut();
    };
    Box::into_raw(Box::new(NativeEpicRenderer(RefCell::new(Instance {
        renderer,
        next: 0,
        live: Vec::new(),
        damage: Vec::new(),
    }))))
}

#[no_mangle]
pub unsafe extern "C" fn pocket_render_sifli_epic_destroy(renderer: *mut NativeEpicRenderer) {
    if renderer.is_null() {
        return;
    }
    // Reentrant destruction from an executor callback cannot free the active borrow.
    if unsafe { &*renderer }.0.try_borrow_mut().is_err() {
        return;
    }
    unsafe {
        drop(Box::from_raw(renderer));
    }
}

/// Packed damage records advance by their own struct_size. Empty records
/// carry nothing and are skipped; `out` keeps its capacity across frames.
unsafe fn collect_damage(
    pointer: *const PocketRect,
    count: usize,
    out: &mut Vec<Region>,
) -> Result<(), AdapterError> {
    out.clear();
    if count == 0 {
        return Ok(());
    }
    if pointer.is_null() || !(pointer as usize).is_multiple_of(align_of::<PocketRect>()) {
        return Err(AdapterError::Invalid);
    }
    out.try_reserve(count).map_err(|_| AdapterError::Failed)?;
    let mut cursor = pointer.cast::<u8>();
    for _ in 0..count {
        let record =
            unsafe { PocketRect::read_prefix(cursor.cast()) }.ok_or(AdapterError::Invalid)?;
        if !record.struct_size.is_multiple_of(align_of::<PocketRect>())
            || record.x.checked_add(record.width).is_none()
            || record.y.checked_add(record.height).is_none()
        {
            return Err(AdapterError::Invalid);
        }
        if record.width != 0 && record.height != 0 {
            out.push(Region::new(record.x, record.y, record.width, record.height));
        }
        cursor = cursor.wrapping_add(record.struct_size);
    }
    Ok(())
}

static FORMATS: [u32; 1] = [POCKET_PIXEL_FORMAT_RGB565];

unsafe extern "C" fn descriptor(context: *mut c_void, out: *mut PocketRendererDescriptor) -> i32 {
    if context.is_null() || out.is_null() {
        return POCKET_STATUS_INVALID;
    }
    let value = PocketRendererDescriptor {
        pixel_formats: FORMATS.as_ptr(),
        pixel_format_count: 1,
        target_kind: POCKET_TARGET_DEVICE_OWNED,
        synchronization: POCKET_SYNC_DEFERRED,
        draw_list_version: pocket_spec::DRAW_LIST_VERSION,
        ..PocketRendererDescriptor::empty()
    };
    if unsafe { value.write_prefix(out) } {
        POCKET_STATUS_OK
    } else {
        POCKET_STATUS_INVALID
    }
}

fn error_status(error: RenderError) -> i32 {
    match error {
        RenderError::InvalidFrame => POCKET_STATUS_INVALID,
        RenderError::Unsupported => POCKET_STATUS_UNSUPPORTED,
        _ => POCKET_STATUS_FAILED,
    }
}

unsafe fn render_inner(
    context: *mut c_void,
    input: *const PocketFrameInput,
    token: *mut u64,
) -> Result<(), i32> {
    let handle =
        unsafe { (context as *const NativeEpicRenderer).as_ref() }.ok_or(POCKET_STATUS_INVALID)?;
    let mut instance = handle
        .0
        .try_borrow_mut()
        .map_err(|_| POCKET_STATUS_FAILED)?;
    if token.is_null() {
        return Err(POCKET_STATUS_INVALID);
    }
    let invalid = |error: AdapterError| error.status();
    let frame = unsafe { PocketFrameInput::read_prefix(input) }.ok_or(POCKET_STATUS_INVALID)?;
    let list = unsafe { PocketDrawList::read_prefix(frame.list) }.ok_or(POCKET_STATUS_INVALID)?;
    if list.version != pocket_spec::DRAW_LIST_VERSION {
        return Err(POCKET_STATUS_UNSUPPORTED);
    }
    let target = unsafe { PocketTarget::read_prefix(frame.target) }.ok_or(POCKET_STATUS_INVALID)?;
    if target.kind != POCKET_TARGET_DEVICE_OWNED
        || target.pixel_format != POCKET_PIXEL_FORMAT_RGB565
    {
        return Err(POCKET_STATUS_UNSUPPORTED);
    }
    let region = unsafe { rect(target.region) }.map_err(invalid)?;
    let target = DeviceTarget::new(target.device_handle, region, PixelFormat::Rgb565);
    let resources = unsafe { CResources::new(frame.resources) }.map_err(invalid)?;
    let words = unsafe { borrowed(list.words, list.word_count) }.map_err(invalid)?;
    instance
        .live
        .try_reserve(1)
        .map_err(|_| POCKET_STATUS_FAILED)?;
    let Instance {
        renderer, damage, ..
    } = &mut *instance;
    unsafe { collect_damage(frame.damage, frame.damage_count, damage) }.map_err(invalid)?;
    let submission = renderer
        .render_parts(words, &resources, damage, &target)
        .map_err(error_status)?;
    instance.next = instance.next.wrapping_add(1).max(1);
    let id = instance.next;
    instance.live.push((id, submission));
    unsafe {
        *token = id;
    }
    Ok(())
}

unsafe extern "C" fn render(
    context: *mut c_void,
    frame: *const PocketFrameInput,
    token: *mut u64,
) -> i32 {
    unsafe { render_inner(context, frame, token) }
        .map(|_| POCKET_STATUS_OK)
        .unwrap_or_else(|status| status)
}

unsafe extern "C" fn wait(context: *mut c_void, token: u64) -> i32 {
    let Some(handle) = (unsafe { (context as *const NativeEpicRenderer).as_ref() }) else {
        return POCKET_STATUS_INVALID;
    };
    let Ok(mut instance) = handle.0.try_borrow_mut() else {
        return POCKET_STATUS_FAILED;
    };
    let Instance { renderer, live, .. } = &mut *instance;
    let Some((_, submission)) = live.iter().find(|(id, _)| *id == token) else {
        return POCKET_STATUS_INVALID;
    };
    renderer
        .wait(submission)
        .map(|_| POCKET_STATUS_OK)
        .unwrap_or_else(error_status)
}

unsafe extern "C" fn retire(context: *mut c_void, token: u64) {
    let Some(handle) = (unsafe { (context as *const NativeEpicRenderer).as_ref() }) else {
        return;
    };
    let Ok(mut instance) = handle.0.try_borrow_mut() else {
        return;
    };
    if let Some(at) = instance.live.iter().position(|(id, _)| *id == token) {
        let (_, submission) = instance.live.swap_remove(at);
        instance.renderer.retire(submission);
    }
}

static VTABLE: PocketRendererV1 = PocketRendererV1 {
    struct_size: size_of::<PocketRendererV1>(),
    descriptor: Some(descriptor),
    render: Some(render),
    wait: Some(wait),
    retire: Some(retire),
    render_zero_copy: None,
};

#[no_mangle]
pub extern "C" fn pocket_render_sifli_epic_vtable() -> *const PocketRendererV1 {
    &VTABLE
}
