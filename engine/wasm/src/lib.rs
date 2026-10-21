//! Instance-owned browser embedding. Guest operations use the canonical
//! dispatcher; the direct-core entry is reserved for compiler and pixel tests.
#![allow(clippy::missing_safety_doc)]

use pocket_drivers::{abi::*, *};
use pocket_runtime::{OpContext, OpResult, Runtime, RuntimeError};
use pocketjs_core::{raster, Ui};
use serde_json::{json, Value};
use std::{
    alloc::{alloc, dealloc, Layout},
    cell::{Cell, RefCell},
    mem::{offset_of, size_of},
    rc::Rc,
};
mod browser;
use browser::Snapshot;

const MAX_BYTES: usize = 128 * 1024 * 1024;
pub struct WasmHost {
    ops: RefCell<OpContext>,
    runtime: RefCell<Option<Runtime>>,
    logical: Cell<[u32; 2]>,
    physical: Rc<Cell<[u32; 2]>>,
    density: Cell<u32>,
    identity: RefCell<(String, u32)>,
    auxiliary: Cell<Option<[u32; 2]>>,
    input: Rc<RefCell<InputFrameBuilder>>,
    snapshot: Rc<Cell<Snapshot>>,
    result: RefCell<Vec<u8>>,
    provider_ops: RefCell<Vec<u16>>,
    provider_result: RefCell<Option<OpResult>>,
    capture: RefCell<Capture>,
    surfaces: RefCell<Vec<Option<pocket_present::compositor::CompositorRaster>>>,
}
#[derive(Default)]
struct Capture {
    opaque: Vec<u8>,
    transparent: Vec<u8>,
    auxiliary: Vec<u8>,
    damage:
        pocket_present::damage::DamageTracker<{ pocket_present::damage::DEFAULT_DAMAGE_REGIONS }>,
}
fn core_context(size: [u32; 2], density: u32, auxiliary: Option<[u32; 2]>) -> OpContext {
    let mut ui = Ui::new_with_raster_density(density);
    ui.set_viewport(size[0] as f32, size[1] as f32);
    if let Some([w, h]) = auxiliary {
        ui.create_auxiliary_surface(w as f32, h as f32);
    }
    let ops = OpContext::from_ui(ui);
    ops.set_compositor_enabled(true).unwrap();
    ops.set_physics_enabled(true).unwrap();
    ops
}
fn checked_size(size: [u32; 2], scale: u32) -> Option<usize> {
    if !(1..=4).contains(&scale) || size.iter().any(|&n| n == 0 || n > 32000) {
        return None;
    }
    (size[0] as usize)
        .checked_mul(size[1] as usize)?
        .checked_mul(scale as usize)?
        .checked_mul(scale as usize)?
        .checked_mul(4)
        .filter(|&n| n <= MAX_BYTES)
}
fn resize(bytes: &mut Vec<u8>, len: usize) -> Result<(), RuntimeError> {
    bytes
        .try_reserve(len.saturating_sub(bytes.len()))
        .map_err(|_| RuntimeError::InvalidArgument)?;
    bytes.resize(len, 0);
    Ok(())
}
unsafe fn bytes<'a>(p: *const u8, n: usize) -> &'a [u8] {
    if n == 0 {
        &[]
    } else {
        std::slice::from_raw_parts(p, n)
    }
}
fn status(host: &WasmHost, result: Result<(), RuntimeError>) -> i32 {
    match result {
        Ok(()) => 0,
        Err(e) => {
            *host.result.borrow_mut() = format!("{e:?}").into_bytes();
            -1
        }
    }
}

#[no_mangle]
pub extern "C" fn web_alloc(len: usize) -> *mut u8 {
    Layout::from_size_align(len.max(1), 8)
        .ok()
        .map_or(std::ptr::null_mut(), |layout| unsafe { alloc(layout) })
}
#[no_mangle]
pub unsafe extern "C" fn web_free(p: *mut u8, len: usize) {
    if !p.is_null() {
        dealloc(p, Layout::from_size_align(len.max(1), 8).unwrap());
    }
}
#[no_mangle]
pub extern "C" fn web_create(w: u32, h: u32, density: u32, aw: u32, ah: u32) -> *mut WasmHost {
    let aux = if aw == 0 && ah == 0 {
        None
    } else {
        Some([aw, ah])
    };
    if checked_size([w, h], 1).is_none()
        || !(1..=255).contains(&density)
        || aux.is_some_and(|s| checked_size(s, 1).is_none())
    {
        return std::ptr::null_mut();
    }
    Box::into_raw(Box::new(WasmHost {
        ops: RefCell::new(core_context([w, h], density, aux)),
        runtime: RefCell::new(None),
        logical: Cell::new([w, h]),
        physical: Rc::new(Cell::new([w, h])),
        density: Cell::new(density),
        identity: RefCell::new(("web".into(), 1)),
        auxiliary: Cell::new(aux),
        input: Rc::new(RefCell::new(InputFrameBuilder::new())),
        snapshot: Rc::new(Cell::new(Snapshot::default())),
        result: RefCell::new(Vec::new()),
        provider_ops: RefCell::new(Vec::new()),
        provider_result: RefCell::new(None),
        capture: RefCell::new(Capture::default()),
        surfaces: RefCell::new(Vec::new()),
    }))
}
/// The JS owner invalidates guest references before releasing this handle.
/// Reentrant destruction during guest callbacks returns Busy without freeing it.
#[no_mangle]
pub unsafe extern "C" fn web_destroy(host: *mut WasmHost) -> i32 {
    let h = &*host;
    if h.ops.try_borrow_mut().is_err() {
        return -1;
    }
    let Ok(mut runtime) = h.runtime.try_borrow_mut() else {
        return -1;
    };
    if let Some(r) = runtime.as_mut() {
        if r.shutdown().is_err() {
            return -1;
        }
    }
    runtime.take();
    drop(runtime);
    drop(Box::from_raw(host));
    0
}
#[no_mangle]
pub unsafe extern "C" fn web_reset(h: &WasmHost, density: u32) -> i32 {
    status(
        h,
        (|| {
            if h.ops.try_borrow_mut().is_err() {
                return Err(RuntimeError::Busy);
            }
            if !(1..=255).contains(&density) {
                return Err(RuntimeError::InvalidArgument);
            }
            let mut runtime = h.runtime.try_borrow_mut().map_err(|_| RuntimeError::Busy)?;
            if let Some(r) = runtime.as_mut() {
                r.shutdown()?;
            }
            runtime.take();
            h.provider_ops.borrow_mut().clear();
            h.density.set(density);
            *h.ops.borrow_mut() = core_context(h.logical.get(), density, h.auxiliary.get());
            *h.capture.borrow_mut() = Capture::default();
            h.surfaces.borrow_mut().clear();
            h.snapshot.set(Snapshot::default());
            Ok(())
        })(),
    )
}
#[no_mangle]
pub extern "C" fn web_abi(index: u32) -> usize {
    [
        size_of::<PocketOpArg>(),
        offset_of!(PocketOpArg, tag),
        offset_of!(PocketOpArg, integer),
        offset_of!(PocketOpArg, real),
        offset_of!(PocketOpArg, bytes),
        offset_of!(PocketOpArg, byte_length),
        size_of::<PocketResult>(),
        offset_of!(PocketResult, tag),
        offset_of!(PocketResult, integer),
        offset_of!(PocketResult, real),
        offset_of!(PocketResult, bytes),
        offset_of!(PocketResult, byte_length),
        POCKET_ARG_INTEGER as usize,
        POCKET_ARG_REAL as usize,
        POCKET_ARG_BYTES as usize,
        POCKET_RESULT_NONE as usize,
        POCKET_RESULT_I64 as usize,
        POCKET_RESULT_F64 as usize,
        POCKET_RESULT_BYTES as usize,
    ]
    .get(index as usize)
    .copied()
    .unwrap_or(0)
}
#[no_mangle]
pub extern "C" fn web_supports(h: &WasmHost, op: u16) -> u32 {
    h.ops.borrow().supports_op(op) as u32
}
#[no_mangle]
pub unsafe extern "C" fn web_dispatch(
    h: &WasmHost,
    op: u16,
    args: *const PocketOpArg,
    count: usize,
    out: *mut PocketResult,
) -> i32 {
    status(
        h,
        (|| {
            let args = pocket_runtime_cabi::arguments(args.cast(), count)
                .map_err(|_| RuntimeError::InvalidArgument)?;
            let result = h.ops.borrow().dispatch(op, &args)?;
            let mut record = PocketResult::empty();
            match result {
                OpResult::None => record.tag = POCKET_RESULT_NONE,
                OpResult::Integer(v) => {
                    record.tag = POCKET_RESULT_I64;
                    record.integer = v
                }
                OpResult::Real(v) => {
                    record.tag = POCKET_RESULT_F64;
                    record.real = v
                }
                OpResult::Bytes(v) => {
                    let mut b = h.result.borrow_mut();
                    *b = v;
                    record.tag = POCKET_RESULT_BYTES;
                    record.bytes = b.as_ptr();
                    record.byte_length = b.len();
                }
            }
            out.write(record);
            Ok(())
        })(),
    )
}
#[no_mangle]
pub extern "C" fn web_result_ptr(h: &WasmHost) -> *const u8 {
    h.result.borrow().as_ptr()
}
#[no_mangle]
pub extern "C" fn web_result_len(h: &WasmHost) -> usize {
    h.result.borrow().len()
}
#[no_mangle]
pub extern "C" fn web_tick(h: &WasmHost) -> i32 {
    status(
        h,
        (|| {
            if h.runtime.borrow().is_some() {
                return Err(RuntimeError::InvalidState);
            }
            h.ops.borrow().core_mut()?.tick();
            Ok(())
        })(),
    )
}
#[no_mangle]
pub extern "C" fn web_resize(h: &WasmHost, w: u32, height: u32) -> i32 {
    status(
        h,
        (|| {
            let old = h.logical.get();
            let physical = h.physical.get();
            let scale = physical[0] / old[0];
            checked_size([w, height], scale).ok_or(RuntimeError::InvalidArgument)?;
            let mut runtime = h.runtime.try_borrow_mut().map_err(|_| RuntimeError::Busy)?;
            h.physical.set([w * scale, height * scale]);
            if let Some(r) = runtime.as_mut() {
                if let Err(e) = r.resize_embedded([w, height], [w * scale, height * scale]) {
                    h.physical.set(physical);
                    return Err(e);
                }
            } else {
                h.ops
                    .borrow()
                    .core_mut()?
                    .set_viewport(w as f32, height as f32);
            }
            h.logical.set([w, height]);
            h.capture.borrow_mut().damage.invalidate();
            Ok(())
        })(),
    )
}
#[no_mangle]
pub extern "C" fn web_auxiliary(h: &WasmHost, w: u32, height: u32) -> i32 {
    if h.runtime.borrow().is_some() || checked_size([w, height], 1).is_none() {
        return 0;
    }
    let id = h
        .ops
        .borrow()
        .core_mut()
        .map(|mut c| c.create_auxiliary_surface(w as f32, height as f32))
        .unwrap_or(0);
    if id != 0 {
        h.auxiliary.set(Some([w, height]));
    }
    id
}
#[no_mangle]
pub extern "C" fn web_auxiliary_root(h: &WasmHost) -> i32 {
    h.ops
        .borrow()
        .core()
        .ok()
        .map(|c| c.auxiliary_surface_root())
        .unwrap_or(0)
}
#[no_mangle]
pub extern "C" fn web_focused(h: &WasmHost) -> i32 {
    h.ops.borrow().core().map(|c| c.focused()).unwrap_or(0)
}
#[no_mangle]
pub extern "C" fn web_inspect(h: &WasmHost, id: i32) -> i32 {
    status(
        h,
        (|| {
            let ops = h.ops.borrow();
            let c = ops.core()?;
            let value = match c.node_type(id) {
                Some(t) => {
                    json!({"type":t,"text":c.node_text(id).unwrap_or(""),"children":c.node_children(id),"display":c.resolved_style(id).map(|s|s.display),"style":{"bgColor":c.resolved_style(id).map_or(0,|s|s.bg_color),"textColor":c.resolved_style(id).map_or(0,|s|s.text_color)}})
                }
                None => Value::Null,
            };
            *h.result.borrow_mut() = serde_json::to_vec(&value).unwrap();
            Ok(())
        })(),
    )
}
#[no_mangle]
pub unsafe extern "C" fn web_layout(h: &WasmHost, id: i32, out: *mut f32) -> i32 {
    let ops = h.ops.borrow();
    let Ok(c) = ops.core() else { return 0 };
    let Some((x, y, w, he)) = c.layout_of(id) else {
        return 0;
    };
    let (ux, uy, uw, uh) =
        c.layout_unrounded_of(id)
            .unwrap_or((f32::NAN, f32::NAN, f32::NAN, f32::NAN));
    std::ptr::copy_nonoverlapping([x, y, w, he, ux, uy, uw, uh].as_ptr(), out, 8);
    1
}
#[no_mangle]
pub extern "C" fn web_layout_mode(
    h: &WasmHost,
    id: i32,
    mode: u32,
    x: f32,
    y: f32,
    w: f32,
    height: f32,
) {
    if let Ok(mut c) = h.ops.borrow().core_mut() {
        c.set_layout_mode(id, mode as u8, x, y, w, height)
    }
}
fn hash(words: &[u32]) -> u64 {
    words
        .iter()
        .flat_map(|w| w.to_le_bytes())
        .fold(0xcbf29ce484222325u64, |h, b| {
            (h ^ b as u64).wrapping_mul(0x100000001b3)
        })
}
#[no_mangle]
pub extern "C" fn web_draw_hash(h: &WasmHost, aux: u32) -> u64 {
    let ops = h.ops.borrow();
    let Ok(mut c) = ops.core_mut() else { return 0 };
    if aux != 0 {
        c.draw_auxiliary().map_or(0, |d| hash(&d.words))
    } else {
        hash(&c.draw().words)
    }
}

struct Auxiliary<'a>(&'a Ui);
impl RenderResources for Auxiliary<'_> {
    fn viewport(&self) -> (f32, f32) {
        self.0.auxiliary_viewport().unwrap()
    }
    fn raster_revision(&self) -> u64 {
        self.0.raster_revision()
    }
    fn texture(&self, h: i32) -> Option<TexView<'_>> {
        self.0.texture(h)
    }
    fn font_atlas(&self, s: u8) -> Option<FontView<'_>> {
        RenderResources::font_atlas(self.0, s)
    }
}
/// Modes: opaque full, incremental, premultiplied, compositor, auxiliary.
/// Captures use the same retained core as Runtime and keep their own buffers.
#[no_mangle]
pub extern "C" fn web_capture(h: &WasmHost, scale: u32, mode: u32) -> *const u8 {
    let result = (|| {
        let size = if mode == 4 {
            h.auxiliary.get().ok_or(RuntimeError::InvalidArgument)?
        } else {
            h.logical.get()
        };
        let len = checked_size(size, scale).ok_or(RuntimeError::InvalidArgument)?;
        let ops = h.ops.borrow();
        let mut c = ops.core_mut()?;
        let mut capture = h.capture.borrow_mut();
        if mode == 4 {
            c.draw_auxiliary();
            let words = &c
                .current_auxiliary_draw_list()
                .ok_or(RuntimeError::InvalidArgument)?
                .words;
            resize(&mut capture.auxiliary, len)?;
            raster::render_scaled(&Auxiliary(&c.ui), words, &mut capture.auxiliary, scale);
            return Ok(capture.auxiliary.as_ptr());
        }
        c.draw();
        let words = &c.current_draw_list().words;
        if mode == 2 {
            resize(&mut capture.transparent, len)?;
            raster::render_scaled_premultiplied(&c.ui, words, &mut capture.transparent, scale);
            return Ok(capture.transparent.as_ptr());
        }
        resize(&mut capture.opaque, len)?;
        let Capture { opaque, damage, .. } = &mut *capture;
        if mode == 3 {
            pocket_present::compositor::render(&c.ui, words, opaque, scale, &h.surfaces.borrow());
            damage.invalidate();
        } else if mode == 1 {
            if pocket_present::incremental::render_scaled_incremental(
                &c.ui,
                words,
                opaque,
                scale,
                damage,
                pocket_present::damage::DamagePolicy::default(),
            )
            .is_err()
            {
                raster::render_scaled(&c.ui, words, opaque, scale);
                damage.invalidate();
            }
        } else {
            raster::render_scaled(&c.ui, words, opaque, scale);
            damage.invalidate();
        }
        Ok(opaque.as_ptr())
    })();
    match result {
        Ok(p) => p,
        Err(e) => {
            status(h, Err(e));
            std::ptr::null()
        }
    }
}
#[no_mangle]
pub extern "C" fn web_compositor_frames(h: &WasmHost) -> i32 {
    status(
        h,
        (|| {
            let ops = h.ops.borrow();
            let mut c = ops.core_mut()?;
            c.draw();
            let frames = c.compositor_surface_frames();
            *h.result.borrow_mut()=serde_json::to_vec(&frames.iter().enumerate().map(|(order,f)|json!({"handle":f.handle,"full":f.full,"clip":f.clip,"focused":f.focused,"order":order})).collect::<Vec<_>>()).unwrap();
            Ok(())
        })(),
    )
}
#[no_mangle]
pub unsafe extern "C" fn web_upload_surface(
    h: &WasmHost,
    handle: i32,
    p: *const u8,
    n: usize,
    w: u32,
    height: u32,
) -> i32 {
    if checked_size([w, height], 1) != Some(n) {
        return -1;
    }
    let mut surfaces = h.surfaces.borrow_mut();
    let index = if handle < 0 {
        surfaces.len().max(1)
    } else {
        handle as usize
    };
    if index > 65535 {
        return -1;
    }
    if index >= surfaces.len() {
        surfaces.resize_with(index + 1, || None);
    }
    surfaces[index] = Some(pocket_present::compositor::CompositorRaster {
        pixels: bytes(p, n).to_vec(),
        width: w,
        height,
        density: 1,
    });
    index as i32
}
#[no_mangle]
pub extern "C" fn web_free_surface(h: &WasmHost, handle: usize) {
    if let Some(s) = h.surfaces.borrow_mut().get_mut(handle) {
        *s = None
    }
}
