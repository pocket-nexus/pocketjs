//! Vita program composition: canonical runtime instance, sampled input and
//! private platform providers. Core operations use the generated dispatcher.
use libquickjs_sys::*;
use pocket_drivers::{AxisSample, Contact, InputClasses, InputFrameBuilder, InputSource};
use pocket_runtime::{OpArg, OpProvider, OpResult, RuntimeError};
use pocket_runtime_cabi::abi::*;
use std::{
    cell::RefCell,
    ffi::{c_void, CStr},
    rc::Rc,
    time::{Duration, Instant},
};

extern "C" {
    fn JS_SetMemoryLimit(runtime: *mut JSRuntime, limit: usize);
    fn pocket_guest_quickjs_attach(ctx: *mut JSContext, profile: i32) -> *mut c_void;
    fn pocket_guest_quickjs_vtable() -> *const PocketGuestV1;
    fn pocket_guest_quickjs_destroy(guest: *mut c_void);
    fn pocket_guest_quickjs_error(guest: *const c_void) -> *const i8;
    fn JS_SetInterruptHandler(
        rt: *mut JSRuntime,
        callback: Option<unsafe extern "C" fn(*mut JSRuntime, *mut c_void) -> i32>,
        opaque: *mut c_void,
    );
}
pub(crate) struct Guest {
    pub engine: *mut JSRuntime,
    pub context: *mut JSContext,
    pub global: JSValue,
    adapter: *mut c_void,
    deadline: Box<Instant>,
    pub ops: pocket_runtime::OpContext,
}
impl Guest {
    pub unsafe fn new(ops: pocket_runtime::OpContext) -> Result<Box<Self>, String> {
        let engine = JS_NewRuntime();
        if engine.is_null() {
            return Err("JS_NewRuntime failed".into());
        }
        JS_SetMemoryLimit(engine, 128 * 1024 * 1024);
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
            deadline: Box::new(Instant::now() + Duration::from_secs(5)),
            ops,
        });
        if cfg!(feature = "usb-debug") {
            JS_SetInterruptHandler(
                engine,
                Some(interrupt),
                (&mut *guest.deadline as *mut Instant).cast(),
            );
        }
        Ok(guest)
    }
    pub fn error(&self) -> String {
        unsafe {
            CStr::from_ptr(pocket_guest_quickjs_error(self.adapter))
                .to_string_lossy()
                .into_owned()
        }
    }
    pub fn budget(&mut self, duration: Duration) {
        *self.deadline = Instant::now() + duration;
    }
}
unsafe extern "C" fn interrupt(_: *mut JSRuntime, opaque: *mut c_void) -> i32 {
    (Instant::now() > *opaque.cast::<Instant>()) as i32
}
impl Drop for Guest {
    fn drop(&mut self) {
        unsafe {
            pocket_guest_quickjs_destroy(self.adapter);
            JS_FreeValue(self.context, self.global);
            JS_FreeContext(self.context);
            JS_FreeRuntime(self.engine);
        }
    }
}
unsafe fn guest<'a>(context: *mut c_void) -> &'a mut Guest {
    &mut *context.cast::<Guest>()
}
unsafe extern "C" fn initialize(
    context: *mut c_void,
    runtime: *mut PocketRuntime,
    environment: *const PocketGuestEnvironment,
) -> i32 {
    let guest = guest(context);
    guest.budget(Duration::from_secs(5));
    let status =
        ((*pocket_guest_quickjs_vtable()).initialize.unwrap())(guest.adapter, runtime, environment);
    if status != 0 {
        return status;
    }
    crate::ffi::register_private(guest.context, guest.global);
    if let Ok(mut state) = guest.ops.core_mut() {
        crate::switch::upload_shot(&mut state.ui);
    } else {
        return -1;
    }
    0
}
unsafe extern "C" fn evaluate(
    context: *mut c_void,
    runtime: *mut PocketRuntime,
    code: *const u8,
    length: usize,
) -> i32 {
    let guest = guest(context);
    guest.budget(Duration::from_secs(5));
    ((*pocket_guest_quickjs_vtable()).evaluate.unwrap())(guest.adapter, runtime, code, length)
}
unsafe extern "C" fn frame(context: *mut c_void, input: *const PocketGuestFrame) -> i32 {
    let guest = guest(context);
    guest.budget(Duration::from_millis(250));
    ((*pocket_guest_quickjs_vtable()).frame.unwrap())(guest.adapter, input)
}
unsafe extern "C" fn collect(context: *mut c_void) -> i32 {
    let guest = guest(context);
    ((*pocket_guest_quickjs_vtable()).collect.unwrap())(guest.adapter)
}
unsafe extern "C" fn shutdown(context: *mut c_void) {
    let guest = guest(context);
    ((*pocket_guest_quickjs_vtable()).shutdown.unwrap())(guest.adapter)
}
pub(crate) const GUEST: PocketGuestV1 = PocketGuestV1 {
    struct_size: std::mem::size_of::<PocketGuestV1>(),
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
    pub contacts: Vec<Contact>,
}
pub(crate) struct InputDriver(pub Rc<RefCell<Input>>);
impl InputSource for InputDriver {
    fn classes(&self) -> InputClasses {
        InputClasses::BUTTONS | InputClasses::AXIS_ABSOLUTE | InputClasses::CONTACT
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
        out.contacts.extend_from_slice(&input.contacts);
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
                std::str::from_utf8(value).map_err(|_| RuntimeError::InvalidArgument)
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
pub(crate) fn build_profile(
) -> Result<Option<pocket_package::profile::BuildProfile<'static>>, String> {
    pocket_package::profile::from_build_inputs(
        option_env!("POCKETJS_PROFILE_JSON"),
        option_env!("POCKETJS_PROFILE_HASH"),
    )
    .map_err(|error| format!("profile build inputs: {error:?}"))
}
pub(crate) fn profile() -> Result<Vec<u8>, String> {
    if let Some(profile) = build_profile()? {
        return Ok(profile.json.to_vec());
    }
    Ok(serde_json::to_vec(&serde_json::json!({"id":"vita","platform":"vita","form":"handheld","tickHz":60,"display":{"physicalViewport":[960,544],"logicalViewports":[[480,272]],"rasterDensity":2},"capabilities":["input.buttons","input.analog.left","input.touch","text.glyphs.baked"],"roleCapabilities":{}})).unwrap())
}

pub(crate) fn package(code: &[u8], pak: &[u8]) -> Result<Vec<u8>, String> {
    let identity = pocket_package::embedded::identity(
        "embedded",
        "dev.pocketjs.vita.embedded",
        "Vita embedded guest",
    )
    .map_err(|e| format!("{e:?}"))?;
    pocket_package::embedded::encode(pocket_package::embedded::EmbeddedPackage{target:"vita",host_abi:pocket_spec::BINDING_GENERATION,profile_hash:pocket_package::sha256::sha256(&profile()?),identity:&identity,plan:br#"{"viewport":{"logical":[480,272],"rasterDensity":2},"features":{"input.buttons":true,"input.analog.left":true,"input.touch":true,"text.glyphs.baked":true}}"#,code,pak}).map_err(|e|format!("{e:?}"))
}

/// Preserve the supplied package as the source for canonical admission. This
/// path is shared by catalog packages, runtime files and USB replacements.
pub(crate) unsafe fn boot_package(
    runtime: *mut PocketRuntime,
    bytes: impl AsRef<[u8]> + 'static,
) -> i32 {
    let status = pocket_runtime_cabi::embedding::set_package_source(
        runtime,
        Box::new(pocket_package::source::MemorySource(bytes)),
    );
    if status != 0 {
        return status;
    }
    pocket_runtime_cabi::embedding::boot_deferred(runtime)
}
