//! Explicit PPA composition bridge. The default SDK contains no device driver.
#![allow(clippy::missing_safety_doc)]
use crate::{Painter, PpaError, PpaOps, QuarterTurn, Rect, RendererConfig, SrmTransform};
use alloc::{boxed::Box, vec::Vec};
use core::{cell::RefCell, ffi::c_void, mem::size_of, ptr};
use pocket_drivers::{abi::*, RenderError, Surface};
use pocket_runtime_cabi::adapters::{
    borrowed, pixel_format, rect, writable, AdapterError, CResources,
};

pub type PpaFillFn =
    unsafe extern "C" fn(*mut c_void, *mut u16, usize, u32, u32, PocketRect, u16) -> i32;
pub type PpaBlendFn = unsafe extern "C" fn(
    *mut c_void,
    *mut u16,
    usize,
    u32,
    u32,
    *const u8,
    usize,
    PocketRect,
    u8,
    u8,
    u8,
    u8,
) -> i32;
pub type PpaSrmFn = unsafe extern "C" fn(
    *mut c_void,
    *mut u16,
    usize,
    u32,
    u32,
    *const u8,
    usize,
    u32,
    u32,
    PocketRect,
    PocketRect,
    u32,
    bool,
    bool,
) -> i32;

#[derive(Clone, Copy)]
#[repr(C)]
pub struct PpaOpsV1 {
    pub struct_size: usize,
    pub context: *mut c_void,
    pub fill: Option<PpaFillFn>,
    pub blend: Option<PpaBlendFn>,
    pub srm: Option<PpaSrmFn>,
}
#[derive(Clone, Copy)]
#[repr(C)]
pub struct PpaConfig {
    pub struct_size: usize,
    pub scale: u32,
    pub min_fill_pixels: u32,
    pub min_blend_pixels: u32,
    pub min_srm_pixels: u32,
    pub mask_budget: usize,
}
fn rectangle(r: Rect) -> PocketRect {
    PocketRect {
        x: r.x,
        y: r.y,
        width: r.w,
        height: r.h,
        ..PocketRect::empty()
    }
}
fn status(value: i32) -> Result<(), PpaError> {
    match value {
        POCKET_STATUS_OK => Ok(()),
        POCKET_STATUS_UNSUPPORTED => Err(PpaError::Unsupported),
        _ => Err(PpaError::Failed),
    }
}
impl PpaOps for PpaOpsV1 {
    fn fill_rgb565(
        &mut self,
        d: &mut [u16],
        w: u32,
        h: u32,
        r: Rect,
        c: u16,
    ) -> Result<(), PpaError> {
        let Some(call) = self.fill else {
            return Err(PpaError::Unsupported);
        };
        status(unsafe { call(self.context, d.as_mut_ptr(), d.len(), w, h, rectangle(r), c) })
    }
    fn blend_a8_rgb565(
        &mut self,
        d: &mut [u16],
        w: u32,
        h: u32,
        m: &[u8],
        r: Rect,
        c: [u8; 3],
        a: u8,
    ) -> Result<(), PpaError> {
        let Some(call) = self.blend else {
            return Err(PpaError::Unsupported);
        };
        status(unsafe {
            call(
                self.context,
                d.as_mut_ptr(),
                d.len(),
                w,
                h,
                m.as_ptr(),
                m.len(),
                rectangle(r),
                c[0],
                c[1],
                c[2],
                a,
            )
        })
    }
    fn srm_psm5650_to_rgb565(
        &mut self,
        d: &mut [u16],
        w: u32,
        h: u32,
        s: &[u8],
        sw: u32,
        sh: u32,
        sr: Rect,
        dr: Rect,
        t: SrmTransform,
    ) -> Result<(), PpaError> {
        let Some(call) = self.srm else {
            return Err(PpaError::Unsupported);
        };
        let rotation = match t.rotation {
            QuarterTurn::None => 0,
            QuarterTurn::Ccw90 => 1,
            QuarterTurn::Ccw180 => 2,
            QuarterTurn::Ccw270 => 3,
        };
        status(unsafe {
            call(
                self.context,
                d.as_mut_ptr(),
                d.len(),
                w,
                h,
                s.as_ptr(),
                s.len(),
                sw,
                sh,
                rectangle(sr),
                rectangle(dr),
                rotation,
                t.mirror_x,
                t.mirror_y,
            )
        })
    }
}
struct Instance {
    painter: Painter,
    device: PpaOpsV1,
    next: u64,
    live: Vec<u64>,
}
pub struct NativePpaRenderer(RefCell<Instance>);
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
pub unsafe extern "C" fn pocket_render_esp_ppa_create(
    config: *const PpaConfig,
    ops: *const PpaOpsV1,
) -> *mut NativePpaRenderer {
    let (Some(config), Some(ops)) = (unsafe { full_prefix(config) }, unsafe { full_prefix(ops) })
    else {
        return ptr::null_mut();
    };
    let Ok(painter) = Painter::new(
        RendererConfig {
            scale: config.scale,
            min_fill_pixels: config.min_fill_pixels,
            min_blend_pixels: config.min_blend_pixels,
            min_srm_pixels: config.min_srm_pixels,
        },
        config.mask_budget,
    ) else {
        return ptr::null_mut();
    };
    Box::into_raw(Box::new(NativePpaRenderer(RefCell::new(Instance {
        painter,
        device: ops,
        next: 0,
        live: Vec::new(),
    }))))
}
#[no_mangle]
pub unsafe extern "C" fn pocket_render_esp_ppa_destroy(renderer: *mut NativePpaRenderer) {
    if renderer.is_null() {
        return;
    }
    // Reentrant destruction from a device callback cannot free the active borrow.
    if unsafe { &*renderer }.0.try_borrow_mut().is_err() {
        return;
    }
    unsafe {
        drop(Box::from_raw(renderer));
    }
}
static FORMATS: [u32; 1] = [POCKET_PIXEL_FORMAT_RGB565];
unsafe extern "C" fn descriptor(context: *mut c_void, out: *mut PocketRendererDescriptor) -> i32 {
    if context.is_null() || out.is_null() {
        return POCKET_STATUS_INVALID;
    }
    let value = PocketRendererDescriptor {
        pixel_formats: FORMATS.as_ptr(),
        pixel_format_count: 1,
        target_kind: POCKET_TARGET_CPU_VISIBLE,
        synchronization: POCKET_SYNC_IMMEDIATE,
        draw_list_version: pocket_spec::DRAW_LIST_VERSION,
        ..PocketRendererDescriptor::empty()
    };
    if unsafe { value.write_prefix(out) } {
        POCKET_STATUS_OK
    } else {
        POCKET_STATUS_INVALID
    }
}
unsafe fn render_inner(
    context: *mut c_void,
    input: *const PocketFrameInput,
    token: *mut u64,
) -> Result<(), AdapterError> {
    let handle =
        unsafe { (context as *const NativePpaRenderer).as_ref() }.ok_or(AdapterError::Invalid)?;
    let mut instance = handle
        .0
        .try_borrow_mut()
        .map_err(|_| AdapterError::Failed)?;
    if token.is_null() {
        return Err(AdapterError::Invalid);
    }
    let frame = unsafe { PocketFrameInput::read_prefix(input) }.ok_or(AdapterError::Invalid)?;
    let list = unsafe { PocketDrawList::read_prefix(frame.list) }.ok_or(AdapterError::Invalid)?;
    if list.version != pocket_spec::DRAW_LIST_VERSION {
        return Err(AdapterError::Unsupported);
    }
    let target = unsafe { PocketTarget::read_prefix(frame.target) }.ok_or(AdapterError::Invalid)?;
    if target.kind != POCKET_TARGET_CPU_VISIBLE || target.pixel_format != POCKET_PIXEL_FORMAT_RGB565
    {
        return Err(AdapterError::Unsupported);
    }
    let raw = unsafe { PocketSurface::read_prefix(target.surface) }.ok_or(AdapterError::Invalid)?;
    let region = unsafe { rect(raw.region) }?;
    if region != unsafe { rect(target.region) }? || raw.pixel_format != target.pixel_format {
        return Err(AdapterError::Invalid);
    }
    let mut surface = Surface::new(
        unsafe { writable(raw.pixels, raw.byte_length) }?,
        region,
        raw.stride_bytes,
        pixel_format(raw.pixel_format)?,
    )
    .map_err(|_| AdapterError::Invalid)?;
    let resources = unsafe { CResources::new(frame.resources) }?;
    let words = unsafe { borrowed(list.words, list.word_count) }?;
    instance
        .live
        .try_reserve(1)
        .map_err(|_| AdapterError::Failed)?;
    let Instance {
        painter, device, ..
    } = &mut *instance;
    painter
        .render(&resources, words, &mut surface, device)
        .map_err(|e| match e {
            RenderError::Unsupported => AdapterError::Unsupported,
            RenderError::InvalidFrame => AdapterError::Invalid,
            _ => AdapterError::Failed,
        })?;
    instance.next = instance.next.checked_add(1).ok_or(AdapterError::Failed)?;
    let id = instance.next;
    instance.live.push(id);
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
        .unwrap_or_else(AdapterError::status)
}
unsafe extern "C" fn wait(context: *mut c_void, token: u64) -> i32 {
    let Some(handle) = (unsafe { (context as *const NativePpaRenderer).as_ref() }) else {
        return POCKET_STATUS_INVALID;
    };
    let Ok(instance) = handle.0.try_borrow() else {
        return POCKET_STATUS_FAILED;
    };
    if instance.live.contains(&token) {
        POCKET_STATUS_OK
    } else {
        POCKET_STATUS_INVALID
    }
}
unsafe extern "C" fn retire(context: *mut c_void, token: u64) {
    let Some(handle) = (unsafe { (context as *const NativePpaRenderer).as_ref() }) else {
        return;
    };
    let Ok(mut instance) = handle.0.try_borrow_mut() else {
        return;
    };
    if let Some(at) = instance.live.iter().position(|&id| id == token) {
        instance.live.swap_remove(at);
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
pub extern "C" fn pocket_render_esp_ppa_vtable() -> *const PocketRendererV1 {
    &VTABLE
}

#[cfg(test)]
mod tests {
    use super::*;
    struct State {
        renderer: *mut NativePpaRenderer,
        calls: usize,
        fail: bool,
        reenter: bool,
    }
    unsafe extern "C" fn fill(
        context: *mut c_void,
        pixels: *mut u16,
        len: usize,
        _: u32,
        _: u32,
        _: PocketRect,
        _: u16,
    ) -> i32 {
        let state = unsafe { &mut *(context as *mut State) };
        state.calls += 1;
        if state.reenter {
            let mut token = 0;
            assert_eq!(
                unsafe { render(state.renderer.cast(), ptr::null(), &mut token) },
                POCKET_STATUS_FAILED
            );
            unsafe { pocket_render_esp_ppa_destroy(state.renderer) };
        }
        if state.fail {
            assert!(len > 0);
            unsafe { pixels.write(0x1234) };
            POCKET_STATUS_FAILED
        } else {
            POCKET_STATUS_UNSUPPORTED
        }
    }
    fn config() -> PpaConfig {
        PpaConfig {
            struct_size: size_of::<PpaConfig>(),
            scale: 1,
            min_fill_pixels: 1,
            min_blend_pixels: 1,
            min_srm_pixels: 1,
            mask_budget: 0,
        }
    }
    #[test]
    fn prefix_validation_and_descriptor_capacity() {
        unsafe {
            let mut ops = PpaOpsV1 {
                struct_size: size_of::<PpaOpsV1>(),
                context: ptr::null_mut(),
                fill: None,
                blend: None,
                srm: None,
            };
            let mut config = config();
            config.struct_size = size_of::<usize>();
            assert!(pocket_render_esp_ppa_create(&config, &ops).is_null());
            config.struct_size = size_of::<PpaConfig>();
            ops.struct_size = size_of::<usize>();
            assert!(pocket_render_esp_ppa_create(&config, &ops).is_null());
            ops.struct_size = size_of::<PpaOpsV1>();
            let p = pocket_render_esp_ppa_create(&config, &ops);
            assert!(!p.is_null());
            let mut out = [0usize, 0x1234];
            assert_eq!(
                descriptor(p.cast(), out.as_mut_ptr().cast()),
                POCKET_STATUS_INVALID
            );
            assert_eq!(out[1], 0x1234);
            out[0] = size_of::<usize>();
            assert_eq!(
                descriptor(p.cast(), out.as_mut_ptr().cast()),
                POCKET_STATUS_OK
            );
            assert_eq!(out[1], 0x1234);
            pocket_render_esp_ppa_destroy(p);
        }
    }
    #[test]
    fn tokens_out_of_order_and_reentrant_calls_remain_safe() {
        unsafe {
            let mut state = State {
                renderer: ptr::null_mut(),
                calls: 0,
                fail: false,
                reenter: true,
            };
            let ops = PpaOpsV1 {
                struct_size: size_of::<PpaOpsV1>(),
                context: (&mut state as *mut State).cast(),
                fill: Some(fill),
                blend: None,
                srm: None,
            };
            let p = pocket_render_esp_ppa_create(&config(), &ops);
            state.renderer = p;
            let region = PocketRect {
                x: 0,
                y: 0,
                width: 2,
                height: 1,
                ..PocketRect::empty()
            };
            let mut pixels = [0u16; 2];
            let mut surface = PocketSurface {
                pixels: pixels.as_mut_ptr().cast(),
                byte_length: 4,
                region: &region,
                stride_bytes: 4,
                pixel_format: POCKET_PIXEL_FORMAT_RGB565,
                ..PocketSurface::empty()
            };
            let target = PocketTarget {
                kind: POCKET_TARGET_CPU_VISIBLE,
                surface: &mut surface,
                region: &region,
                pixel_format: POCKET_PIXEL_FORMAT_RGB565,
                ..PocketTarget::empty()
            };
            let list = PocketDrawList {
                version: pocket_spec::DRAW_LIST_VERSION,
                ..PocketDrawList::empty()
            };
            let resources = PocketRenderResources {
                viewport_width: 2.,
                viewport_height: 1.,
                ..PocketRenderResources::empty()
            };
            let frame = PocketFrameInput {
                list: &list,
                resources: &resources,
                target: &target,
                ..PocketFrameInput::empty()
            };
            let mut a = 0;
            let mut b = 0;
            assert_eq!(render(p.cast(), &frame, &mut a), POCKET_STATUS_OK);
            assert_eq!(render(p.cast(), &frame, &mut b), POCKET_STATUS_OK);
            assert_ne!(a, b);
            assert_eq!(wait(p.cast(), b), POCKET_STATUS_OK);
            retire(p.cast(), b);
            assert_eq!(wait(p.cast(), b), POCKET_STATUS_INVALID);
            assert_eq!(wait(p.cast(), a), POCKET_STATUS_OK);
            retire(p.cast(), a);
            retire(p.cast(), a);
            state.fail = true;
            let mut failed = 0;
            assert_eq!(render(p.cast(), &frame, &mut failed), POCKET_STATUS_FAILED);
            assert_eq!(failed, 0);
            assert_eq!(pixels[0], 0x1234);
            assert_eq!(state.calls, 3);
            state.fail = false;
            assert!(!state.fail);
            assert_eq!(render(p.cast(), &frame, &mut a), POCKET_STATUS_OK);
            retire(p.cast(), a);
            pocket_render_esp_ppa_destroy(p);
        }
    }
}
