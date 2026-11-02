//! Generated guest and service providers for the PSP runtime instance.
use alloc::{boxed::Box, rc::Rc, string::String};
use core::{
    cell::{Cell, RefCell},
    ffi::{c_void, CStr},
};
use libquickjs_sys::*;
use pocket_drivers::{AxisSample, InputClasses, InputFrameBuilder, InputSource};
use pocket_runtime::{OpArg, OpContext, OpProvider, OpResult, RuntimeError};
use pocket_runtime_cabi::abi::*;

const JS_STRIP_SOURCE: core::ffi::c_int = 1;
extern "C" {
    fn JS_SetStripInfo(rt: *mut libquickjs_sys::JSRuntime, flags: core::ffi::c_int);
}

extern "C" {
    fn JS_SetContextOpaque(context: *mut JSContext, opaque: *mut c_void);
    fn JS_GetContextOpaque(context: *mut JSContext) -> *mut c_void;
    fn JS_IsFunction(context: *mut JSContext, value: JSValue) -> i32;

    fn pocket_guest_quickjs_attach(ctx: *mut JSContext, profile: i32) -> *mut c_void;
    fn pocket_guest_quickjs_vtable() -> *const PocketGuestV1;
    fn pocket_guest_quickjs_destroy(guest: *mut c_void);
    fn pocket_guest_quickjs_error(guest: *const c_void) -> *const i8;
    fn pocket_guest_quickjs_set_phase_hook(
        guest: *mut c_void,
        hook: Option<unsafe extern "C" fn(*mut c_void, i32)>,
        context: *mut c_void,
    ) -> i32;
}
pub(crate) struct Guest {
    pub engine: *mut JSRuntime,
    pub context: *mut JSContext,
    pub global: JSValue,
    adapter: *mut c_void,
    pub ops: OpContext,
    /// A host cadence policy that replaces the runtime's choice when it
    /// divides the package rate (multi-app builds present at 20 Hz).
    fixed_cadence: Option<u32>,
    /// The admitted package's rate and the cadence published as __simHz;
    /// set when the runtime initializes the guest.
    pub tick_hz: Cell<u32>,
    pub sim_hz: Cell<u32>,
    pub code_length: Cell<usize>,
    pub pak_length: Cell<usize>,
    pub eval_begin: Cell<u64>,
    pub eval_end: Cell<u64>,
    last_phase: Cell<i32>,
    pub after_js: Cell<u64>,
    pub after_jobs: Cell<u64>,
}
impl Guest {
    pub unsafe fn new(ops: OpContext, fixed_cadence: Option<u32>) -> Result<Box<Self>, String> {
        let engine = crate::qjs_alloc::new_runtime();
        if engine.is_null() {
            return Err("JS_NewRuntime failed".into());
        }
        // Do not keep each function's source text for toString(): nested functions repeat their parents'
        // text, so a bundle otherwise costs several times its own size in heap on a 32 MB machine.
        JS_SetStripInfo(engine, JS_STRIP_SOURCE);
        let context = JS_NewContext(engine);
        if context.is_null() {
            JS_FreeRuntime(engine);
            return Err("JS_NewContext failed".into());
        }
        let adapter = pocket_guest_quickjs_attach(context, 0);
        if adapter.is_null() {
            JS_FreeContext(context);
            JS_FreeRuntime(engine);
            return Err("QuickJS guest attachment failed".into());
        }
        let global = JS_GetGlobalObject(context);
        let mut guest = Box::new(Self {
            engine,
            context,
            global,
            adapter,
            ops,
            fixed_cadence,
            tick_hz: Cell::new(0),
            sim_hz: Cell::new(0),
            code_length: Cell::new(0),
            pak_length: Cell::new(0),
            eval_begin: Cell::new(0),
            eval_end: Cell::new(0),
            last_phase: Cell::new(0),
            after_js: Cell::new(0),
            after_jobs: Cell::new(0),
        });
        let pointer = (&mut *guest as *mut Self).cast();
        JS_SetContextOpaque(context, pointer);
        pocket_guest_quickjs_set_phase_hook(adapter, Some(phase), pointer);
        Ok(guest)
    }
    pub fn error(&self) -> String {
        unsafe {
            CStr::from_ptr(pocket_guest_quickjs_error(self.adapter))
                .to_string_lossy()
                .into_owned()
        }
    }
}
unsafe extern "C" fn phase(context: *mut c_void, phase: i32) {
    let guest = &*context.cast::<Guest>();
    if phase == 1 {
        guest.eval_begin.set(crate::host::now_us());
    }
    if guest.last_phase.replace(phase) == 1 {
        guest.eval_end.set(crate::host::now_us());
    }
    if phase == 3 {
        guest.after_js.set(crate::host::now_us());
    }
    if phase == 0 {
        guest.after_jobs.set(crate::host::now_us());
    }
}
impl Drop for Guest {
    fn drop(&mut self) {
        unsafe {
            pocket_guest_quickjs_destroy(self.adapter);
            JS_SetContextOpaque(self.context, core::ptr::null_mut());
            JS_FreeValue(self.context, self.global);
            JS_FreeContext(self.context);
            JS_FreeRuntime(self.engine);
        }
    }
}
pub(crate) unsafe fn with_ui<R>(
    context: *mut JSContext,
    callback: impl FnOnce(&mut pocketjs_core::Ui) -> R,
) -> Option<R> {
    let guest = JS_GetContextOpaque(context).cast::<Guest>().as_ref()?;
    let _fpu = crate::host::FpuGuard::masked();
    let mut state = guest.ops.core_mut().ok()?;
    Some(callback(&mut state.ui))
}
unsafe extern "C" fn initialize(
    context: *mut c_void,
    runtime: *mut PocketRuntime,
    environment: *const PocketGuestEnvironment,
) -> i32 {
    let guest = &*context.cast::<Guest>();
    let _fpu = crate::host::FpuGuard::masked();
    let status =
        ((*pocket_guest_quickjs_vtable()).initialize.unwrap())(guest.adapter, runtime, environment);
    if status != 0 {
        return status;
    }
    guest.pak_length.set((*environment).pak_length);
    crate::service_bindings::register_private(guest.context, guest.global);
    let tick_hz = (*environment).tick_hz;
    let sim_hz = match guest.fixed_cadence {
        Some(cadence) if tick_hz % cadence == 0 && tick_hz / cadence <= 60 => cadence,
        _ => (*environment).sim_hz,
    };
    guest.tick_hz.set(tick_hz);
    guest.sim_hz.set(sim_hz);
    if JS_SetPropertyStr(
        guest.context,
        guest.global,
        b"__simHz\0".as_ptr().cast(),
        JS_NewInt32(guest.context, sim_hz as i32),
    ) < 0
    {
        return -1;
    }
    let Ok(mut state) = guest.ops.core_mut() else {
        return -1;
    };
    crate::switch::upload_shot(&mut state.ui);
    0
}
unsafe extern "C" fn evaluate(
    context: *mut c_void,
    runtime: *mut PocketRuntime,
    code: *const u8,
    length: usize,
) -> i32 {
    let guest = &*context.cast::<Guest>();
    let _fpu = crate::host::FpuGuard::masked();
    guest.code_length.set(length.saturating_sub(1));
    let status =
        ((*pocket_guest_quickjs_vtable()).evaluate.unwrap())(guest.adapter, runtime, code, length);
    if status != 0 {
        return status;
    }
    let frame = JS_GetPropertyStr(guest.context, guest.global, b"frame\0".as_ptr().cast());
    let valid = JS_IsFunction(guest.context, frame) != 0;
    JS_FreeValue(guest.context, frame);
    if valid {
        0
    } else {
        -1
    }
}
unsafe extern "C" fn frame(context: *mut c_void, input: *const PocketGuestFrame) -> i32 {
    let guest = &*context.cast::<Guest>();
    let _fpu = crate::host::FpuGuard::masked();
    ((*pocket_guest_quickjs_vtable()).frame.unwrap())(guest.adapter, input)
}
unsafe extern "C" fn collect(context: *mut c_void) -> i32 {
    let guest = &*context.cast::<Guest>();
    let _fpu = crate::host::FpuGuard::masked();
    ((*pocket_guest_quickjs_vtable()).collect.unwrap())(guest.adapter)
}
unsafe extern "C" fn shutdown(context: *mut c_void) {
    let guest = &*context.cast::<Guest>();
    let _fpu = crate::host::FpuGuard::masked();
    ((*pocket_guest_quickjs_vtable()).shutdown.unwrap())(guest.adapter);
}
pub(crate) const GUEST: PocketGuestV1 = PocketGuestV1 {
    struct_size: core::mem::size_of::<PocketGuestV1>(),
    initialize: Some(initialize),
    evaluate: Some(evaluate),
    frame: Some(frame),
    collect: Some(collect),
    shutdown: Some(shutdown),
};
#[derive(Default)]
pub(crate) struct Input {
    pub buttons: u32,
    pub analog: u32,
}
pub(crate) struct InputDriver(pub Rc<RefCell<Input>>);
impl InputSource for InputDriver {
    fn classes(&self) -> InputClasses {
        InputClasses::BUTTONS | InputClasses::AXIS_ABSOLUTE
    }
    fn poll(&mut self, out: &mut InputFrameBuilder) {
        let input = self.0.borrow();
        out.buttons |= input.buttons;
        out.axes.extend([
            AxisSample {
                id: 0,
                value: ((input.analog >> 8) & 255) as f32,
            },
            AxisSample {
                id: 1,
                value: (input.analog & 255) as f32,
            },
        ]);
    }
}
pub(crate) struct Services;
impl OpProvider for Services {
    fn supports_op(&self, op: u16) -> bool {
        matches!(op, 30..=38) || (crate::switch::multi() && matches!(op, 39..=41))
    }
    fn dispatch(
        &mut self,
        ui: &mut pocketjs_core::Ui,
        op: u16,
        args: &[OpArg<'_>],
    ) -> Result<OpResult, RuntimeError> {
        let text = || match args.first() {
            Some(OpArg::Bytes(value)) => {
                core::str::from_utf8(value).map_err(|_| RuntimeError::InvalidArgument)
            }
            _ => Err(RuntimeError::InvalidArgument),
        };
        unsafe {
            Ok(match op {
                30 => OpResult::Integer(i64::from(crate::svc::open(text()?))),
                31 => crate::svc::poll()
                    .map_or(OpResult::None, |value| OpResult::Bytes(value.into_bytes())),
                32 => {
                    crate::svc::send(text()?.as_bytes());
                    OpResult::None
                }
                33 => OpResult::Integer(
                    crate::svc::read_side_file(text()?, pocketjs_core::spec::svc::IMG_MAX_BYTES)
                        .map_or(-1, |blob| ui.upload_img_entry(&blob)) as i64,
                ),
                34 => OpResult::Integer(i64::from(crate::vid::open(ui, text()?))),
                35 => OpResult::Integer(crate::vid::tick(ui) as i64),
                36 => OpResult::Integer(crate::vid::texture() as i64),
                37 => {
                    crate::vid::close(ui);
                    OpResult::None
                }
                38 => OpResult::Bytes(crate::stats::json().into_bytes()),
                39 => OpResult::Bytes(crate::switch::table_json().into_bytes()),
                40 => OpResult::Integer(if let Some(index) = crate::switch::find(text()?) {
                    crate::switch::request_launch(index);
                    1
                } else {
                    0
                }),
                41 => OpResult::Integer(crate::switch::shot_handle() as i64),
                _ => return Err(RuntimeError::UnsupportedOperation),
            })
        }
    }
}
