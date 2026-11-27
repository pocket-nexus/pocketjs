//! The guest lifecycle and the generated `ui` namespace on a JavaScriptCore realm.

use std::cell::RefCell;
use std::ffi::c_void;
use std::ptr::{null, null_mut};
use std::rc::Rc;

use pocket_drivers::{
    abi::{
        POCKET_TEXT_COMMIT, POCKET_TEXT_COMPOSITION, POCKET_TEXT_COMPOSITION_END,
        POCKET_TEXT_KEY_DOWN, POCKET_TEXT_KEY_UP,
    },
    MotionState, TextEvent,
};
use pocket_runtime::generated_ops::{
    ArgKind, OpDescriptor, ResultKind, BINDING_GENERATION, OP_DESCRIPTORS,
};
use pocket_runtime::{
    Guest, GuestEnvironment, GuestFrame, OpArg, OpContext, OpResult, RuntimeError,
};

use crate::jsc::*;

/// The realm a [`JscGuest`] runs, shared with the host. It is empty before
/// `initialize` and after `shutdown`; `initialize` replaces it.
#[derive(Clone, Default)]
pub struct Realm(Rc<RefCell<Option<Rc<Context>>>>);

impl Realm {
    /// The current realm's context. The handle is valid until the next
    /// `initialize` or `shutdown` of the guest that owns this realm.
    pub fn ctx(&self) -> Option<Ctx> {
        self.0.borrow().as_ref().map(|context| context.ctx())
    }
}

type Setup = Box<dyn FnMut(Ctx) -> Result<(), String>>;

/// A PocketJS guest on JavaScriptCore. `initialize` creates a global context,
/// mounts the generated `ui` namespace and runs the host's setup (its own
/// namespaces, such as `fetch` or `navigator.gpu`), `evaluate` runs the
/// package's script, and `frame` calls `globalThis.frame` with the canonical
/// eleven arguments. JavaScriptCore drains its microtask queue when the
/// outermost API call returns, so every turn ends with its jobs run.
pub struct JscGuest {
    name: String,
    realm: Realm,
    setup: Option<Setup>,
    last_error: Option<String>,
}

impl JscGuest {
    pub fn new(name: &str) -> Self {
        JscGuest {
            name: name.to_owned(),
            realm: Realm::default(),
            setup: None,
            last_error: None,
        }
    }
    /// Run `setup` on every new realm after `ui` is mounted and before the
    /// package evaluates.
    pub fn with_setup(mut self, setup: impl FnMut(Ctx) -> Result<(), String> + 'static) -> Self {
        self.setup = Some(Box::new(setup));
        self
    }
    pub fn realm(&self) -> Realm {
        self.realm.clone()
    }
    pub fn last_error(&self) -> Option<&str> {
        self.last_error.as_deref()
    }
    fn remember<T>(&mut self, result: Result<T, String>) -> Result<T, RuntimeError> {
        result.map_err(|error| {
            log::error!("{}: {error}", self.name);
            self.last_error = Some(error);
            RuntimeError::Guest
        })
    }
    fn ctx(&self) -> Result<Ctx, RuntimeError> {
        self.realm.ctx().ok_or(RuntimeError::Guest)
    }
}

impl Guest for JscGuest {
    fn initialize(
        &mut self,
        ops: OpContext,
        environment: &GuestEnvironment<'_>,
    ) -> Result<(), RuntimeError> {
        if environment.host_abi != BINDING_GENERATION {
            return self.remember(Err(format!(
                "Unsupported UI binding generation; expected {BINDING_GENERATION}"
            )));
        }
        self.shutdown();
        self.last_error = None;
        let context = Context::new(&self.name);
        let ctx = context.ctx();
        let mounted = mount_ui(ctx, ops, environment);
        self.remember(mounted)?;
        if let Some(setup) = self.setup.as_mut() {
            let result = setup(ctx);
            self.remember(result)?;
        }
        *self.realm.0.borrow_mut() = Some(Rc::new(context));
        Ok(())
    }
    fn evaluate(&mut self, code: &[u8]) -> Result<(), RuntimeError> {
        let ctx = self.ctx()?;
        // Package JS carries one terminal NUL for C consumers.
        let code = code.strip_suffix(&[0]).unwrap_or(code);
        let source = String::from_utf8_lossy(code);
        let result = ctx.eval(&source, &self.name).map(|_| ());
        self.remember(result)
    }
    fn frame(&mut self, frame: &GuestFrame<'_>) -> Result<(), RuntimeError> {
        let ctx = self.ctx()?;
        let result = call_frame(ctx, frame);
        self.remember(result)
    }
    fn shutdown(&mut self) {
        self.realm.0.borrow_mut().take();
    }
}

const ATTR_READ_ONLY: u32 = 1 << 1;
const ATTR_DONT_ENUM: u32 = 1 << 2;

fn define(ctx: Ctx, object: Value, name: &str, value: Value, attributes: u32) {
    let name = JsString::new(name);
    unsafe {
        JSObjectSetProperty(
            ctx.0,
            object.0 as JSObjectRef,
            name.0,
            value.0,
            attributes,
            null_mut(),
        )
    }
}

fn has(ctx: Ctx, object: Value, name: &str) -> bool {
    !object.get(ctx, name).is_undefined(ctx)
}

fn null_prototype_object(ctx: Ctx) -> Value {
    let object = ctx.object();
    unsafe { JSObjectSetPrototype(ctx.0, object.0 as JSObjectRef, JSValueMakeNull(ctx.0)) };
    object
}

/// Mount the generated UI contract into a host-owned realm: `globalThis.ui`
/// with one function per operation the context supports, its metadata
/// (`__host`, `__hostAbi`, `__tickHz`, `__viewport`, registered assets), and
/// `__pak`/`__simHz`. A `console` is installed when the realm has none. The
/// host keeps `ops` alive for every call into this realm.
pub fn mount_ui(
    ctx: Ctx,
    ops: OpContext,
    environment: &GuestEnvironment<'_>,
) -> Result<(), String> {
    if environment.host_abi != BINDING_GENERATION {
        return Err(format!(
            "Unsupported UI binding generation; expected {BINDING_GENERATION}"
        ));
    }
    let globals = ctx.global();
    if has(ctx, globals, "ui") {
        return Err("ui is already mounted".into());
    }
    if !environment.pak.is_empty() && has(ctx, globals, "__pak") {
        return Err("__pak is already mounted".into());
    }
    if !has(ctx, globals, "console") {
        let console = ctx.object();
        for level in ["log", "info", "warn", "error", "debug"] {
            let function = ctx.function(move |ctx, _, args| {
                let line = args
                    .iter()
                    .map(|value| value.to_string(ctx))
                    .collect::<Vec<_>>()
                    .join(" ");
                match level {
                    "warn" => log::warn!("{line}"),
                    "error" => log::error!("{line}"),
                    "debug" => log::debug!("{line}"),
                    _ => log::info!("{line}"),
                }
                Ok(ctx.undefined())
            });
            console.set(ctx, level, function);
        }
        globals.set(ctx, "console", console);
    }
    let ui = ctx.object();
    let shared = Rc::new(ops);
    for descriptor in OP_DESCRIPTORS {
        if !shared.supports_op(descriptor.id) {
            continue;
        }
        let function = op_function(ctx, shared.clone(), descriptor);
        ui.set(ctx, descriptor.name, function);
    }
    ui.set(ctx, "__host", ctx.str(environment.host));
    ui.set(ctx, "__hostAbi", ctx.num(environment.host_abi as f64));
    ui.set(ctx, "__tickHz", ctx.num(environment.tick_hz as f64));
    let viewport = ctx.object();
    viewport.set(ctx, "w", ctx.num(environment.viewport[0] as f64));
    viewport.set(ctx, "h", ctx.num(environment.viewport[1] as f64));
    ui.set(ctx, "__viewport", viewport);
    if let Some(assets) = environment.assets {
        let textures = null_prototype_object(ctx);
        for item in &assets.textures {
            textures.set(ctx, &item.name, ctx.num(item.handle as f64));
        }
        let sprites = null_prototype_object(ctx);
        for item in &assets.sprites {
            let sprite = ctx.object();
            sprite.set(ctx, "handle", ctx.num(item.handle as f64));
            sprite.set(ctx, "frames", ctx.num(item.frames as f64));
            sprite.set(ctx, "cols", ctx.num(item.columns as f64));
            sprite.set(ctx, "step", ctx.num(item.step as f64));
            sprites.set(ctx, &item.name, sprite);
        }
        ui.set(ctx, "__textures", textures);
        ui.set(ctx, "__sprites", sprites);
    }
    if let Some(viewport) = environment.auxiliary_viewport {
        let auxiliary = ctx.object();
        auxiliary.set(ctx, "root", ctx.num(environment.auxiliary_root as f64));
        auxiliary.set(ctx, "w", ctx.num(viewport[0] as f64));
        auxiliary.set(ctx, "h", ctx.num(viewport[1] as f64));
        ui.set(ctx, "__auxiliarySurface", auxiliary);
    }
    if !environment.pak.is_empty() {
        globals.set(ctx, "__pak", ctx.array_buffer(environment.pak.to_vec()));
    }
    // Guest frames per second: the framework clock latches it, so `after(seconds)`
    // counts frames at this rate.
    if environment.sim_hz != 0 {
        globals.set(ctx, "__simHz", ctx.num(environment.sim_hz as f64));
    }
    globals.set(ctx, "ui", ui);
    Ok(())
}

/// One generated operation bound to the context that dispatches it.
struct Op {
    ops: Rc<OpContext>,
    descriptor: &'static OpDescriptor,
}

static mut OP_CLASS: JSClassRef = null_mut();

fn op_class() -> JSClassRef {
    unsafe extern "C" fn finalize(object: JSObjectRef) {
        unsafe {
            let op = JSObjectGetPrivate(object) as *mut Op;
            if !op.is_null() {
                drop(Box::from_raw(op));
            }
        }
    }
    unsafe extern "C" fn call(
        ctx: JSContextRef,
        function: JSObjectRef,
        _this: JSObjectRef,
        argc: usize,
        argv: *const JSValueRef,
        exception: *mut JSValueRef,
    ) -> JSValueRef {
        unsafe {
            let op = &*(JSObjectGetPrivate(function) as *const Op);
            let args = if argc == 0 {
                &[][..]
            } else {
                std::slice::from_raw_parts(argv as *const Value, argc)
            };
            let c = Ctx(ctx);
            match invoke(c, &op.ops, op.descriptor, args) {
                Ok(value) => value.0,
                Err(thrown) => {
                    *exception = thrown.into_value(c).0;
                    JSValueMakeUndefined(ctx)
                }
            }
        }
    }
    // SAFETY: the class is created once on the thread that runs every realm.
    unsafe {
        if OP_CLASS.is_null() {
            let definition = JSClassDefinition {
                version: 0,
                attributes: 0,
                class_name: c"UiOperation".as_ptr(),
                parent_class: null_mut(),
                static_values: null(),
                static_functions: null(),
                initialize: null(),
                finalize: Some(finalize),
                has_property: null(),
                get_property: null(),
                set_property: null(),
                delete_property: null(),
                get_property_names: null(),
                call_as_function: Some(call),
                call_as_constructor: null(),
                has_instance: null(),
                convert_to_type: null(),
            };
            OP_CLASS = JSClassCreate(&definition);
        }
        OP_CLASS
    }
}

fn op_function(ctx: Ctx, ops: Rc<OpContext>, descriptor: &'static OpDescriptor) -> Value {
    let op = Box::into_raw(Box::new(Op { ops, descriptor }));
    let object = Value(unsafe { JSObjectMake(ctx.0, op_class(), op as *mut c_void) } as JSValueRef);
    // Own `name`/`length` first: Function.prototype's are read-only and would block the assignment.
    define(
        ctx,
        object,
        "name",
        ctx.str(descriptor.name),
        ATTR_READ_ONLY | ATTR_DONT_ENUM,
    );
    define(
        ctx,
        object,
        "length",
        ctx.num(descriptor.args.len() as f64),
        ATTR_READ_ONLY | ATTR_DONT_ENUM,
    );
    let prototype = ctx.global().get(ctx, "Function").get(ctx, "prototype");
    unsafe { JSObjectSetPrototype(ctx.0, object.0 as JSObjectRef, prototype.0) };
    object
}

/// What an operation throws: a value the guest's own code threw while its
/// arguments were coerced, or a new TypeError / Error.
enum Thrown {
    Value(Value),
    Type(&'static str),
    Error(&'static str),
}

impl Thrown {
    fn into_value(self, ctx: Ctx) -> Value {
        let (constructor, message) = match self {
            Thrown::Value(value) => return value,
            Thrown::Type(message) => ("TypeError", message),
            Thrown::Error(message) => ("Error", message),
        };
        let constructor = ctx.global().get(ctx, constructor);
        let message = ctx.str(message);
        let mut exception: JSValueRef = null();
        let error = unsafe {
            JSObjectCallAsConstructor(
                ctx.0,
                constructor.0 as JSObjectRef,
                1,
                &message.0,
                &mut exception,
            )
        };
        if error.is_null() {
            ctx.error("UI operation failed")
        } else {
            Value(error as JSValueRef)
        }
    }
}

fn number(ctx: Ctx, value: Value) -> Result<f64, Thrown> {
    let mut exception: JSValueRef = null();
    let number = unsafe { JSValueToNumber(ctx.0, value.0, &mut exception) };
    if exception.is_null() {
        Ok(number)
    } else {
        Err(Thrown::Value(Value(exception)))
    }
}

fn string(ctx: Ctx, value: Value) -> Result<String, Thrown> {
    let mut exception: JSValueRef = null();
    let string = unsafe { JSValueToStringCopy(ctx.0, value.0, &mut exception) };
    if !exception.is_null() {
        return Err(Thrown::Value(Value(exception)));
    }
    Ok(JsString(string).to_string_wtf8_lossy())
}

enum Prepared {
    Integer(i64),
    Real(f64),
    String(String),
    Bytes,
}

fn invoke(
    ctx: Ctx,
    ops: &OpContext,
    descriptor: &OpDescriptor,
    values: &[Value],
) -> Result<Value, Thrown> {
    let mut prepared: Vec<Prepared> = (0..descriptor.args.len())
        .map(|_| Prepared::Bytes)
        .collect();
    // Convert scalars, then strings, before borrowing any backing store:
    // user-defined valueOf/toString may reenter a UI operation.
    for pass in 0..2 {
        for (index, arg) in descriptor.args.iter().enumerate() {
            if (arg.kind == ArgKind::String) != (pass == 1) || arg.kind == ArgKind::Bytes {
                continue;
            }
            let value = values.get(index).copied();
            let missing = value.is_none();
            let value = value.unwrap_or_else(|| ctx.undefined());
            let optional = arg.optional && (missing || value.is_undefined(ctx));
            if missing && !arg.optional {
                return Err(Thrown::Type("missing UI argument"));
            }
            prepared[index] = match arg.kind {
                ArgKind::Bytes => Prepared::Bytes,
                ArgKind::String => Prepared::String(string(ctx, value)?),
                ArgKind::Real => Prepared::Real(if optional || missing {
                    0.0
                } else {
                    number(ctx, value)?
                }),
                ArgKind::I32 | ArgKind::U32 | ArgKind::Boolean => {
                    let integer = if missing {
                        0
                    } else {
                        to_int32(number(ctx, value)?)
                    };
                    Prepared::Integer(if arg.kind == ArgKind::U32 {
                        integer as u32 as i64
                    } else {
                        integer as i64
                    })
                }
                ArgKind::Nonnegative => Prepared::Integer(if missing {
                    0
                } else {
                    number(ctx, value)?.clamp(0.0, u32::MAX as f64) as u32 as i64
                }),
            };
        }
    }
    // Borrow byte views last; nothing below runs guest code until dispatch returns.
    let mut views: Vec<(usize, &[u8])> = Vec::new();
    for (index, arg) in descriptor.args.iter().enumerate() {
        if arg.kind == ArgKind::Bytes {
            let value = values
                .get(index)
                .ok_or(Thrown::Type("missing UI bytes argument"))?;
            let bytes = value
                .bytes(ctx)
                .ok_or(Thrown::Type("expected an ArrayBuffer or a typed array"))?;
            views.push((index, bytes));
        }
    }
    let args: Vec<OpArg<'_>> = prepared
        .iter()
        .enumerate()
        .map(|(index, value)| match value {
            Prepared::Integer(value) => OpArg::Integer(*value),
            Prepared::Real(value) => OpArg::Real(*value),
            Prepared::String(value) => OpArg::Bytes(value.as_bytes()),
            Prepared::Bytes => OpArg::Bytes(
                views
                    .iter()
                    .find(|(i, _)| *i == index)
                    .map_or(&[][..], |(_, bytes)| *bytes),
            ),
        })
        .collect();
    let result = ops.dispatch(descriptor.id, &args);
    drop(args);
    let result = result.map_err(|_| Thrown::Error("UI operation failed"))?;
    result_value(ctx, descriptor.result, result)
}

fn result_value(ctx: Ctx, kind: ResultKind, result: OpResult) -> Result<Value, Thrown> {
    Ok(match (kind, result) {
        (ResultKind::None, _)
        | (ResultKind::OptionalString | ResultKind::OptionalBytes, OpResult::None) => {
            ctx.undefined()
        }
        (ResultKind::Boolean, OpResult::Integer(value)) => ctx.bool(value != 0),
        (ResultKind::Integer, OpResult::Integer(value)) => ctx.num(value as f64),
        (ResultKind::Real, OpResult::Real(value)) => ctx.num(value),
        (ResultKind::String | ResultKind::OptionalString, OpResult::Bytes(bytes)) => ctx
            .str(core::str::from_utf8(&bytes).map_err(|_| Thrown::Error("invalid string result"))?),
        (ResultKind::U32Array, OpResult::Bytes(bytes)) => {
            if bytes.len() % 4 != 0 {
                return Err(Thrown::Error("invalid array result"));
            }
            let items: Vec<Value> = bytes
                .as_chunks::<4>()
                .0
                .iter()
                .map(|word| ctx.num(u32::from_le_bytes(*word) as f64))
                .collect();
            ctx.array(&items)
        }
        (ResultKind::Bytes | ResultKind::OptionalBytes, OpResult::Bytes(bytes)) => {
            ctx.array_buffer(bytes)
        }
        _ => return Err(Thrown::Error("invalid UI result")),
    })
}

/// Call `globalThis.frame` with the canonical frame facts, shaped as the
/// QuickJS guests shape them: buttons, analog, touches, hits, touch surfaces,
/// right analog, axis deltas, motion, text events, pointer, touch positions.
pub fn call_frame(ctx: Ctx, frame: &GuestFrame<'_>) -> Result<(), String> {
    let function = ctx.global().get(ctx, "frame");
    if function.is_undefined(ctx) {
        return Ok(());
    }
    if !function.is_function(ctx) {
        return Err("frame is not a function".into());
    }
    let numbers = |items: &mut dyn Iterator<Item = f64>| -> Value {
        let values: Vec<Value> = items.map(|n| ctx.num(n)).collect();
        ctx.array(&values)
    };
    let touches = numbers(&mut frame.touches.iter().map(|v| *v as f64));
    let hits = numbers(&mut frame.hits.iter().map(|v| *v as f64));
    let surfaces = numbers(&mut frame.touch_surfaces.iter().map(|v| *v as f64));
    let deltas: Vec<Value> = frame
        .axis_deltas
        .iter()
        .map(|delta| {
            let entry = ctx.object();
            entry.set(ctx, "axis", ctx.num(delta.id as f64));
            entry.set(ctx, "delta", ctx.num(delta.delta as f64));
            entry
        })
        .collect();
    let deltas = ctx.array(&deltas);
    let motion = motion_value(ctx, frame.motion);
    let mut text = Vec::new();
    for event in frame.text {
        let (kind, payload, start, end, repeat) = match event {
            TextEvent::Key {
                key,
                pressed,
                repeat,
            } => (
                if *pressed {
                    POCKET_TEXT_KEY_DOWN
                } else {
                    POCKET_TEXT_KEY_UP
                },
                key.as_str(),
                0,
                0,
                *repeat,
            ),
            TextEvent::Commit(payload) => (POCKET_TEXT_COMMIT, payload.as_str(), 0, 0, false),
            TextEvent::Composition {
                text,
                selection_start,
                selection_end,
            } => (
                POCKET_TEXT_COMPOSITION,
                text.as_str(),
                *selection_start,
                *selection_end,
                false,
            ),
            TextEvent::CompositionEnd => (POCKET_TEXT_COMPOSITION_END, "", 0, 0, false),
            #[allow(unreachable_patterns)]
            _ => continue,
        };
        let entry = ctx.object();
        entry.set(ctx, "kind", ctx.num(kind as f64));
        entry.set(ctx, "text", ctx.str(payload));
        entry.set(ctx, "selectionStart", ctx.num(start as f64));
        entry.set(ctx, "selectionEnd", ctx.num(end as f64));
        entry.set(ctx, "repeat", ctx.bool(repeat));
        text.push(entry);
    }
    let text = ctx.array(&text);
    let pointer = match frame.pointer {
        Some(pointer) => {
            let entry = ctx.object();
            entry.set(ctx, "surface", ctx.num(pointer.surface as f64));
            entry.set(ctx, "x", ctx.num(pointer.x as f64));
            entry.set(ctx, "y", ctx.num(pointer.y as f64));
            entry.set(ctx, "buttons", ctx.num(pointer.buttons as f64));
            entry.set(ctx, "scrollX", ctx.num(frame.scroll[0] as f64));
            entry.set(ctx, "scrollY", ctx.num(frame.scroll[1] as f64));
            entry
        }
        None => ctx.null(),
    };
    let positions = numbers(&mut frame.touch_positions.iter().map(|v| *v as f64));
    let args = [
        ctx.num(frame.buttons as f64),
        ctx.num(frame.analog as f64),
        touches,
        hits,
        surfaces,
        ctx.num(frame.right_analog as f64),
        deltas,
        motion,
        text,
        pointer,
        positions,
    ];
    ctx.call(function, None, &args).map(|_| ())
}

fn motion_value(ctx: Ctx, motion: Option<&MotionState>) -> Value {
    let Some(motion) = motion else {
        return ctx.null();
    };
    let object = ctx.object();
    object.set(ctx, "timestamp", ctx.num(motion.timestamp as f64));
    let vector = |values: &[f32]| -> Value {
        let items: Vec<Value> = values.iter().map(|v| ctx.num(*v as f64)).collect();
        ctx.array(&items)
    };
    macro_rules! vector {
        ($field:ident, $name:literal $(, $extra:ident => $key:literal)*) => {
            if let Some(value) = &motion.$field {
                let estimate = ctx.object();
                estimate.set(ctx, "value", vector(&value.value[..]));
                estimate.set(ctx, "quality", ctx.num(value.quality as f64));
                $(estimate.set(ctx, $key, ctx.num(value.$extra as f64));)*
                object.set(ctx, $name, estimate);
            }
        };
    }
    macro_rules! scalar {
        ($field:ident, $name:literal) => {
            if let Some(value) = &motion.$field {
                let estimate = ctx.object();
                estimate.set(ctx, "value", ctx.num(value.value[0] as f64));
                estimate.set(ctx, "quality", ctx.num(value.quality as f64));
                object.set(ctx, $name, estimate);
            }
        };
    }
    vector!(gravity_direction, "gravityDirection");
    scalar!(inclination, "inclination");
    vector!(linear_acceleration, "linearAcceleration");
    vector!(rotation_rate, "rotationRate");
    vector!(orientation, "orientation", reference_frame => "referenceFrame", epoch => "epoch");
    scalar!(screen_rotation, "screenRotation");
    vector!(tilt, "tilt");
    vector!(angles, "angles", reference_frame => "referenceFrame", epoch => "epoch");
    if let Some(value) = &motion.heading {
        let estimate = ctx.object();
        estimate.set(ctx, "value", ctx.num(value.value[0] as f64));
        estimate.set(ctx, "accuracy", ctx.num(value.value[1] as f64));
        estimate.set(ctx, "quality", ctx.num(value.quality as f64));
        estimate.set(ctx, "referenceFrame", ctx.num(value.reference_frame as f64));
        object.set(ctx, "heading", estimate);
    }
    object
}
