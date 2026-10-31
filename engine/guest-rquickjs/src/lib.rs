//! A QuickJS realm whose UI calls dispatch through the runtime's generated contract.
use pocket_runtime::generated_ops::{
    ArgKind, OpDescriptor, ResultKind, BINDING_GENERATION, IDF_OPS, LEGACY_C_OPS, OP_DESCRIPTORS,
};
use pocket_drivers::{
    abi::{
        POCKET_TEXT_COMMIT, POCKET_TEXT_COMPOSITION, POCKET_TEXT_COMPOSITION_END,
        POCKET_TEXT_KEY_DOWN, POCKET_TEXT_KEY_UP,
    },
    TextEvent,
};
use pocket_runtime::{
    Guest, GuestEnvironment, GuestFrame, OpArg, OpContext, OpResult, RuntimeError,
};
use rquickjs::{
    function::Rest, Array, ArrayBuffer, Coerced, Context, Ctx, Exception, FromJs, Function, IntoJs,
    Object, Runtime, Value,
};

/// The canonical profile has required numeric arguments, JS integer coercion,
/// nonnegative duration clamping, lossy UTF-8, and borrowed ArrayBuffer/views.
/// Compatibility profiles retain the older namespace and coercion policies.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum BindingProfile {
    #[default]
    Canonical,
    LegacyC,
    Idf,
}

pub struct RquickjsGuest {
    context: Option<Context>,
    runtime: Option<Runtime>,
    profile: BindingProfile,
    last_error: Option<String>,
}
impl Default for RquickjsGuest {
    fn default() -> Self {
        Self::new(BindingProfile::Canonical)
    }
}
impl RquickjsGuest {
    pub fn new(profile: BindingProfile) -> Self {
        Self {
            context: None,
            runtime: None,
            profile,
            last_error: None,
        }
    }
    pub fn last_error(&self) -> Option<&str> {
        self.last_error.as_deref()
    }
    pub fn with<R>(&self, f: impl for<'js> FnOnce(Ctx<'js>) -> R) -> Option<R> {
        self.context.as_ref().map(|ctx| ctx.with(f))
    }
    fn remember<T, E: std::fmt::Display>(
        &mut self,
        result: Result<T, E>,
    ) -> Result<T, RuntimeError> {
        result.map_err(|error| {
            self.last_error = Some(error.to_string());
            RuntimeError::Guest
        })
    }
}
impl Guest for RquickjsGuest {
    fn initialize(
        &mut self,
        ops: OpContext,
        environment: &GuestEnvironment<'_>,
    ) -> Result<(), RuntimeError> {
        if environment.host_abi != BINDING_GENERATION {
            self.last_error = Some(format!(
                "Unsupported UI binding generation; expected {BINDING_GENERATION}"
            ));
            return Err(RuntimeError::Guest);
        }
        self.shutdown();
        self.last_error = None;
        let runtime = self.remember(Runtime::new())?;
        if environment.heap_limit != 0 {
            runtime.set_memory_limit(environment.heap_limit);
        }
        let context = self.remember(Context::full(&runtime))?;
        let result = context.with(|ctx| mount_ui(&ctx, ops, environment, self.profile));
        self.remember(result)?;
        self.context = Some(context);
        self.runtime = Some(runtime);
        Ok(())
    }
    fn evaluate(&mut self, code: &[u8]) -> Result<(), RuntimeError> {
        let context = self.context.as_ref().ok_or(RuntimeError::Guest)?;
        // Package JS includes one terminal NUL for C consumers. The rquickjs
        // evaluator appends its own terminator and expects a source-only span.
        let code = code.strip_suffix(&[0]).unwrap_or(code);
        let result = context.with(|ctx| {
            ctx.eval::<(), _>(code)
                .map_err(|error| engine_error(&ctx, error))
        });
        self.remember(result)?;
        self.collect()
    }
    fn frame(&mut self, frame: &GuestFrame<'_>) -> Result<(), RuntimeError> {
        let context = self.context.as_ref().ok_or(RuntimeError::Guest)?;
        let result = context.with(|ctx| call_frame(&ctx, frame).map_err(|error| engine_error(&ctx, error)));
        self.remember(result)?;
        self.collect()
    }
    fn collect(&mut self) -> Result<(), RuntimeError> {
        if let Some(runtime) = &self.runtime {
            while runtime.is_job_pending() {
                if let Err(error) = runtime.execute_pending_job() {
                    self.last_error = Some(error.to_string());
                    return Err(RuntimeError::Guest);
                }
            }
        }
        Ok(())
    }
    fn shutdown(&mut self) {
        self.context = None;
        self.runtime = None;
    }
}

/// Encode the canonical frame facts into a host-owned QuickJS realm.
/// The owner drains its job queue before returning from the guest turn.
pub fn call_frame(ctx: &Ctx<'_>, frame: &GuestFrame<'_>) -> rquickjs::Result<()> {
    let value: Value = ctx.globals().get("frame")?;
    if value.is_undefined() {
        return Ok(());
    }
    let function = Function::from_js(ctx, value)?;
    let touches = Array::new(ctx.clone())?;
    let hits = Array::new(ctx.clone())?;
    let surfaces = Array::new(ctx.clone())?;
    for (i, value) in frame.touches.iter().enumerate() {
        touches.set(i, *value)?;
    }
    for (i, value) in frame.hits.iter().enumerate() {
        hits.set(i, *value)?;
    }
    for (i, value) in frame.touch_surfaces.iter().enumerate() {
        surfaces.set(i, *value)?;
    }
    let deltas = Array::new(ctx.clone())?;
    for (i, delta) in frame.axis_deltas.iter().enumerate() {
        let entry = Object::new(ctx.clone())?;
        entry.set("axis", delta.id)?;
        entry.set("delta", delta.delta)?;
        deltas.set(i, entry)?;
    }
    let motion = motion_value(ctx, frame.motion)?;
    // The frame's text events, the ninth argument, as the QuickJS C guest
    // shapes them: {kind, text, selectionStart, selectionEnd, repeat}.
    let text = Array::new(ctx.clone())?;
    let mut count = 0;
    for event in frame.text.iter() {
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
            _ => continue,
        };
        let entry = Object::new(ctx.clone())?;
        entry.set("kind", kind)?;
        entry.set("text", payload)?;
        entry.set("selectionStart", start)?;
        entry.set("selectionEnd", end)?;
        entry.set("repeat", repeat)?;
        text.set(count, entry)?;
        count += 1;
    }
    function.call::<_, ()>((Rest(vec![
        frame.buttons.into_js(ctx)?,
        frame.analog.into_js(ctx)?,
        touches.into_value(),
        hits.into_value(),
        surfaces.into_value(),
        frame.right_analog.into_js(ctx)?,
        deltas.into_value(),
        motion,
        text.into_value(),
    ]),))
}

/// The text of a guest failure: a thrown Error's message and stack (the
/// frame function, a job), or the thrown value coerced to a string.
fn engine_error(ctx: &Ctx<'_>, error: rquickjs::Error) -> String {
    if matches!(error, rquickjs::Error::Exception) {
        let value = ctx.catch();
        if let Some(exception) = value.as_exception() {
            let message = exception.message().unwrap_or_default();
            return match exception.stack() {
                Some(stack) if !stack.is_empty() => format!("{message}\n{stack}"),
                _ => message,
            };
        }
        return Coerced::<String>::from_js(ctx, value)
            .map(|value| value.0)
            .unwrap_or_else(|_| error.to_string());
    }
    error.to_string()
}
fn permitted(profile: BindingProfile, op: u16) -> bool {
    match profile {
        BindingProfile::Canonical => true,
        BindingProfile::LegacyC => {
            LEGACY_C_OPS.contains(&op) || (30..=32).contains(&op) || (52..=56).contains(&op)
        }
        BindingProfile::Idf => IDF_OPS.contains(&op),
    }
}
/// Mount the generated UI contract into a host-owned realm. The host owns its
/// job loop and keeps the OpContext alive for every callback in this realm.
pub fn mount_ui<'js>(
    ctx: &Ctx<'js>,
    ops: OpContext,
    environment: &GuestEnvironment<'_>,
    profile: BindingProfile,
) -> rquickjs::Result<()> {
    if environment.host_abi != BINDING_GENERATION {
        return Err(Exception::throw_type(
            ctx,
            &format!("Unsupported UI binding generation; expected {BINDING_GENERATION}"),
        ));
    }
    let globals = ctx.globals();
    if globals.contains_key("ui")? {
        return Err(Exception::throw_type(ctx, "ui is already mounted"));
    }
    if !globals.contains_key("console")? {
        let console = Object::new(ctx.clone())?;
        for level in ["log", "info", "warn", "error", "debug"] {
            console.set(
                level,
                Function::new(
                    ctx.clone(),
                    |ctx: Ctx<'js>, Rest(values): Rest<Value<'js>>| -> rquickjs::Result<()> {
                        let mut line = String::new();
                        for value in values {
                            if !line.is_empty() {
                                line.push(' ');
                            }
                            line.push_str(&string_value(&ctx, value, BindingProfile::Canonical)?);
                        }
                        eprintln!("{line}");
                        Ok(())
                    },
                )?,
            )?;
        }
        globals.set("console", console)?;
    }
    let ui = Object::new(ctx.clone())?;
    for descriptor in OP_DESCRIPTORS {
        if !permitted(profile, descriptor.id) || !ops.supports_op(descriptor.id) {
            continue;
        }
        let dispatcher = ops.clone();
        let function = Function::new(
            ctx.clone(),
            move |ctx: Ctx<'js>, Rest(values): Rest<Value<'js>>| {
                invoke(&ctx, &dispatcher, descriptor, values, profile)
            },
        )?;
        function.set_name(descriptor.name)?;
        function.set_length(descriptor.args.len())?;
        ui.set(descriptor.name, function)?;
    }
    ui.set("__host", environment.host)?;
    ui.set("__hostAbi", environment.host_abi)?;
    if profile != BindingProfile::LegacyC {
        ui.set("__tickHz", environment.tick_hz)?;
    }
    let viewport = Object::new(ctx.clone())?;
    viewport.set("w", environment.viewport[0])?;
    viewport.set("h", environment.viewport[1])?;
    ui.set("__viewport", viewport)?;
    if let Some(assets) = environment.assets {
        let textures = Object::new_proto(ctx.clone(), None)?;
        for item in &assets.textures {
            textures.set(item.name.as_str(), item.handle)?;
        }
        let sprites = Object::new_proto(ctx.clone(), None)?;
        for item in &assets.sprites {
            let sprite = Object::new(ctx.clone())?;
            sprite.set("handle", item.handle)?;
            sprite.set("frames", item.frames)?;
            sprite.set("cols", item.columns)?;
            sprite.set("step", item.step)?;
            sprites.set(item.name.as_str(), sprite)?;
        }
        ui.set("__textures", textures)?;
        ui.set("__sprites", sprites)?;
        ui.set("__surfaces", Object::new(ctx.clone())?)?;
    }
    if let Some(viewport) = environment.auxiliary_viewport {
        let auxiliary = Object::new(ctx.clone())?;
        auxiliary.set("root", environment.auxiliary_root)?;
        auxiliary.set("w", viewport[0])?;
        auxiliary.set("h", viewport[1])?;
        ui.set("__auxiliarySurface", auxiliary)?;
    }
    // Own this copy because an rquickjs ArrayBuffer can outlive a mount call.
    // The runtime retains its independent package source for native lookups.
    if !environment.pak.is_empty() {
        if globals.contains_key("__pak")? {
            return Err(Exception::throw_type(ctx, "__pak is already mounted"));
        }
        let pak = ArrayBuffer::new_copy(ctx.clone(), environment.pak)?;
        if profile != BindingProfile::LegacyC {
            unsafe {
                rquickjs::qjs::JS_SetImmutableArrayBuffer(pak.as_value().as_raw(), true);
            }
        }
        globals.set("__pak", pak)?;
    }
    if profile == BindingProfile::LegacyC {
        globals.set("__simHz", 60)?;
    }
    globals.set("ui", ui)
}

enum Prepared {
    Integer(i64),
    Real(f64),
    String(String),
    Bytes,
}
struct BorrowedBytes<'js> {
    buffer: ArrayBuffer<'js>,
    offset: usize,
    length: usize,
}
impl BorrowedBytes<'_> {
    fn bytes(&self) -> rquickjs::Result<&[u8]> {
        self.buffer
            .as_bytes()
            .and_then(|bytes| bytes.get(self.offset..self.offset + self.length))
            .ok_or(rquickjs::Error::new_from_js("detached buffer", "bytes"))
    }
}
fn byte_view<'js>(
    ctx: &Ctx<'js>,
    value: Value<'js>,
    profile: BindingProfile,
) -> rquickjs::Result<BorrowedBytes<'js>> {
    if profile == BindingProfile::Idf
        && !value
            .as_object()
            .is_some_and(|object| object.is_typed_array::<u8>())
    {
        return Err(Exception::throw_type(ctx, "expected Uint8Array"));
    }
    if let Ok(buffer) = ArrayBuffer::from_js(ctx, value.clone()) {
        let length = buffer.len();
        return Ok(BorrowedBytes {
            buffer,
            offset: 0,
            length,
        });
    }
    let mut offset = 0;
    let mut length = 0;
    let mut element = 0;
    let raw = unsafe {
        rquickjs::qjs::JS_GetTypedArrayBuffer(
            ctx.as_raw().as_ptr(),
            value.as_raw(),
            &mut offset,
            &mut length,
            &mut element,
        )
    };
    let buffer = unsafe { Value::from_raw(ctx.clone(), raw) };
    if buffer.is_exception() {
        return Err(rquickjs::Error::Exception);
    }
    let buffer = ArrayBuffer::from_js(ctx, buffer)?;
    let offset =
        usize::try_from(offset).map_err(|_| Exception::throw_type(ctx, "invalid byte offset"))?;
    let length =
        usize::try_from(length).map_err(|_| Exception::throw_type(ctx, "invalid byte length"))?;
    if offset > buffer.len() || length > buffer.len() - offset {
        return Err(Exception::throw_type(ctx, "invalid byte view"));
    }
    Ok(BorrowedBytes {
        buffer,
        offset,
        length,
    })
}
fn string_value<'js>(
    ctx: &Ctx<'js>,
    value: Value<'js>,
    profile: BindingProfile,
) -> rquickjs::Result<String> {
    let string = Coerced::<rquickjs::String>::from_js(ctx, value)?.0;
    let raw = string.to_cstring()?;
    let bytes = unsafe { std::slice::from_raw_parts(raw.as_ptr().cast::<u8>(), raw.len()) };
    match profile {
        BindingProfile::Canonical => Ok(String::from_utf8_lossy(bytes).into_owned()),
        BindingProfile::LegacyC => Ok(std::str::from_utf8(bytes).unwrap_or("").to_owned()),
        BindingProfile::Idf => std::str::from_utf8(bytes)
            .map(str::to_owned)
            .map_err(|_| Exception::throw_internal(ctx, "invalid UTF-8")),
    }
}
fn invoke<'js>(
    ctx: &Ctx<'js>,
    ops: &OpContext,
    descriptor: &OpDescriptor,
    values: Vec<Value<'js>>,
    profile: BindingProfile,
) -> rquickjs::Result<Value<'js>> {
    // IDF's text query wrappers return an empty answer before string coercion
    // when the old call omitted its text/width arguments.
    if profile == BindingProfile::Idf
        && ((descriptor.id == 16 && values.is_empty()) || (descriptor.id == 43 && values.len() < 3))
    {
        if let Some(value) = values.get(1) {
            let _ = Coerced::<i32>::from_js(ctx, value.clone())?;
        }
        return if descriptor.id == 16 {
            0.0.into_js(ctx)
        } else {
            Ok(Array::new(ctx.clone())?.into_value())
        };
    }
    let mut prepared: Vec<Prepared> = (0..descriptor.args.len())
        .map(|_| Prepared::Bytes)
        .collect();
    // Convert all scalars and strings before borrowing any JS backing storage.
    // User-defined valueOf/toString may reenter a UI operation here.
    for pass in 0..2 {
        for (index, arg) in descriptor.args.iter().enumerate() {
            if (arg.kind == ArgKind::String) != (pass == 1) || arg.kind == ArgKind::Bytes {
                continue;
            }
            let missing = index >= values.len();
            let value = values
                .get(index)
                .cloned()
                .unwrap_or_else(|| Value::new_undefined(ctx.clone()));
            let optional = arg.optional && (missing || value.is_undefined());
            if missing
                && !arg.optional
                && !(profile == BindingProfile::Idf
                    && !matches!(arg.kind, ArgKind::String | ArgKind::Bytes))
            {
                return Err(Exception::throw_type(ctx, "missing UI argument"));
            }
            prepared[index] = match arg.kind {
                ArgKind::Bytes => Prepared::Bytes,
                ArgKind::String => Prepared::String(string_value(
                    ctx,
                    value,
                    if profile == BindingProfile::Idf && matches!(descriptor.id, 16 | 43) {
                        BindingProfile::LegacyC
                    } else {
                        profile
                    },
                )?),
                ArgKind::Real => Prepared::Real(if optional || missing {
                    0.0
                } else {
                    Coerced::<f64>::from_js(ctx, value)?.0
                }),
                ArgKind::I32 | ArgKind::U32 | ArgKind::Boolean => {
                    let value = if missing {
                        0
                    } else {
                        Coerced::<i32>::from_js(ctx, value)?.0
                    };
                    Prepared::Integer(if arg.kind == ArgKind::U32 {
                        value as u32 as i64
                    } else {
                        value as i64
                    })
                }
                ArgKind::Nonnegative => Prepared::Integer(if missing {
                    0
                } else if profile == BindingProfile::Idf {
                    Coerced::<i32>::from_js(ctx, value)?.0 as u32 as i64
                } else {
                    Coerced::<f64>::from_js(ctx, value)?
                        .0
                        .max(0.0)
                        .min(u32::MAX as f64) as u32 as i64
                }),
            };
        }
    }
    let mut buffers = Vec::new();
    for (index, arg) in descriptor.args.iter().enumerate() {
        if arg.kind == ArgKind::Bytes {
            let value = values
                .get(index)
                .ok_or_else(|| Exception::throw_type(ctx, "missing UI bytes argument"))?;
            buffers.push((index, byte_view(ctx, value.clone(), profile)?));
        }
    }
    let mut args = Vec::with_capacity(prepared.len());
    for (index, value) in prepared.iter().enumerate() {
        args.push(match value {
            Prepared::Integer(value) => OpArg::Integer(*value),
            Prepared::Real(value) => OpArg::Real(*value),
            Prepared::String(value) => OpArg::Bytes(value.as_bytes()),
            Prepared::Bytes => OpArg::Bytes(
                buffers
                    .iter()
                    .find(|(i, _)| *i == index)
                    .unwrap()
                    .1
                    .bytes()?,
            ),
        });
    }
    let result = ops
        .dispatch(descriptor.id, &args)
        .map_err(|_| Exception::throw_internal(ctx, "UI operation failed"))?;
    result_value(ctx, descriptor.result, result)
}
fn result_value<'js>(
    ctx: &Ctx<'js>,
    kind: ResultKind,
    result: OpResult,
) -> rquickjs::Result<Value<'js>> {
    match (kind, result) {
        (ResultKind::None, _)
        | (ResultKind::OptionalString | ResultKind::OptionalBytes, OpResult::None) => {
            Ok(Value::new_undefined(ctx.clone()))
        }
        (ResultKind::Boolean, OpResult::Integer(value)) => (value != 0).into_js(ctx),
        (ResultKind::Integer, OpResult::Integer(value)) => value.into_js(ctx),
        (ResultKind::Real, OpResult::Real(value)) => value.into_js(ctx),
        (ResultKind::String | ResultKind::OptionalString, OpResult::Bytes(bytes)) => {
            std::str::from_utf8(&bytes)
                .map_err(|_| Exception::throw_internal(ctx, "invalid string result"))?
                .into_js(ctx)
        }
        (ResultKind::U32Array, OpResult::Bytes(bytes)) => {
            if bytes.len() % 4 != 0 {
                return Err(Exception::throw_internal(ctx, "invalid array result"));
            }
            let array = Array::new(ctx.clone())?;
            for (index, value) in bytes.as_chunks::<4>().0.iter().enumerate() {
                array.set(index, u32::from_le_bytes(*value))?;
            }
            Ok(array.into_value())
        }
        (ResultKind::Bytes | ResultKind::OptionalBytes, OpResult::Bytes(bytes)) => {
            Ok(ArrayBuffer::new(ctx.clone(), bytes)?.into_value())
        }
        _ => Err(Exception::throw_internal(ctx, "invalid UI result")),
    }
}
fn motion_value<'js>(
    ctx: &Ctx<'js>,
    motion: Option<&pocket_drivers::MotionState>,
) -> rquickjs::Result<Value<'js>> {
    let Some(motion) = motion else {
        return Ok(Value::new_null(ctx.clone()));
    };
    let object = Object::new(ctx.clone())?;
    object.set("timestamp", motion.timestamp)?;
    macro_rules! vector { ($field:ident,$name:literal $(,$extra:ident=>$key:literal)*) => { if let Some(value)=&motion.$field { let estimate=Object::new(ctx.clone())?; let array=Array::new(ctx.clone())?; for (i,item) in value.value.iter().enumerate() {array.set(i,*item)?;} estimate.set("value",array)?; estimate.set("quality",value.quality)?; $(estimate.set($key,value.$extra)?;)* object.set($name,estimate)?; } }; }
    macro_rules! scalar {
        ($field:ident,$name:literal) => {
            if let Some(value) = &motion.$field {
                let estimate = Object::new(ctx.clone())?;
                estimate.set("value", value.value[0])?;
                estimate.set("quality", value.quality)?;
                object.set($name, estimate)?;
            }
        };
    }
    vector!(gravity_direction, "gravityDirection");
    scalar!(inclination, "inclination");
    vector!(linear_acceleration, "linearAcceleration");
    vector!(rotation_rate, "rotationRate");
    vector!(orientation,"orientation",reference_frame=>"referenceFrame",epoch=>"epoch");
    scalar!(screen_rotation, "screenRotation");
    vector!(tilt, "tilt");
    vector!(angles,"angles",reference_frame=>"referenceFrame",epoch=>"epoch");
    if let Some(value) = &motion.heading {
        let estimate = Object::new(ctx.clone())?;
        estimate.set("value", value.value[0])?;
        estimate.set("accuracy", value.value[1])?;
        estimate.set("quality", value.quality)?;
        estimate.set("referenceFrame", value.reference_frame)?;
        object.set("heading", estimate)?;
    }
    Ok(object.into_value())
}

#[cfg(test)]
mod tests {
    use super::*;
    use pocket_runtime::AssetRegistry;
    fn environment(assets: Option<&AssetRegistry>) -> GuestEnvironment<'_> {
        GuestEnvironment {
            host: "binding-test",
            host_abi: BINDING_GENERATION,
            tick_hz: 60,
            viewport: [480, 272],
            auxiliary_viewport: None,
            auxiliary_root: 0,
            raster_density: 1,
            heap_limit: 0,
            pak: &[],
            assets,
        }
    }
    fn guest(profile: BindingProfile) -> (RquickjsGuest, OpContext) {
        let ops = OpContext::from_ui(pocketjs_core::Ui::new());
        let mut guest = RquickjsGuest::new(profile);
        guest.initialize(ops.clone(), &environment(None)).unwrap();
        (guest, ops)
    }
    fn evaluate<T>(guest: &RquickjsGuest, source: &str) -> T
    where
        for<'js> T: FromJs<'js>,
    {
        guest.with(|ctx| ctx.eval(source).unwrap()).unwrap()
    }
    #[test]
    fn namespace_omits_unregistered_providers_and_preserves_metadata_presence() {
        let (guest, _) = guest(BindingProfile::Canonical);
        assert!(evaluate::<bool>(
            &guest,
            "ui.__host==='binding-test' && ui.__tickHz===60 && ui.__viewport.w===480"
        ));
        assert_eq!(evaluate::<u32>(&guest, "ui.__hostAbi"), BINDING_GENERATION);
        assert!(evaluate::<bool>(
            &guest,
            "['svcOpen','videoOpen','appLaunch','physicsCreate','loadTileTexture','hitTestAuxiliary','setCompositorSurface','__textures','__sprites'].every(k=>!(k in ui))"
        ));
        assert!(evaluate::<bool>(
            &guest,
            "['setPropBatch','takeAnimationCompletions','fontStreamBatch','captureTexts','capturedTexts'].every(k=>typeof ui[k]==='function')"
        ));
        let mut native = RquickjsGuest::default();
        let assets = AssetRegistry::default();
        native
            .initialize(
                OpContext::from_ui(pocketjs_core::Ui::new()),
                &environment(Some(&assets)),
            )
            .unwrap();
        assert!(evaluate::<bool>(
            &native,
            "Object.getPrototypeOf(ui.__textures)===null && Object.keys(ui.__sprites).length===0"
        ));
    }
    #[test]
    fn binding_generation_is_checked_before_creating_or_replacing_a_guest() {
        for profile in [
            BindingProfile::Canonical,
            BindingProfile::LegacyC,
            BindingProfile::Idf,
        ] {
            let mut guest = RquickjsGuest::new(profile);
            let ops = OpContext::from_ui(pocketjs_core::Ui::new());
            for generation in (0..12).chain([BINDING_GENERATION + 1, u32::MAX]) {
                let mut env = environment(None);
                env.host_abi = generation;
                assert_eq!(
                    guest.initialize(ops.clone(), &env),
                    Err(RuntimeError::Guest)
                );
                assert!(guest
                    .last_error()
                    .unwrap()
                    .contains("Unsupported UI binding generation"));
                assert!(guest.context.is_none() && guest.runtime.is_none());
            }
            guest.initialize(ops.clone(), &environment(None)).unwrap();
            assert_eq!(evaluate::<u32>(&guest, "ui.__hostAbi"), BINDING_GENERATION);
            guest
                .evaluate(b"globalThis.retained=ui.createNode;globalThis.marker=42")
                .unwrap();
            let mut bad = environment(None);
            bad.host_abi = 0;
            assert_eq!(guest.initialize(ops, &bad), Err(RuntimeError::Guest));
            assert!(evaluate::<bool>(
                &guest,
                "marker===42 && retained===ui.createNode && retained(0)>0"
            ));
        }
    }
    #[test]
    fn host_owned_mount_rejects_other_generations_without_publishing_globals() {
        for profile in [
            BindingProfile::Canonical,
            BindingProfile::LegacyC,
            BindingProfile::Idf,
        ] {
            let engine = Runtime::new().unwrap();
            let context = Context::full(&engine).unwrap();
            let ops = OpContext::from_ui(pocketjs_core::Ui::new());
            context.with(|ctx| {
                for generation in (0..12).chain([BINDING_GENERATION + 1, u32::MAX]) {
                    let mut env = environment(None);
                    env.host_abi = generation;
                    env.pak = &[1, 2, 3];
                    assert!(mount_ui(&ctx, ops.clone(), &env, profile).is_err());
                    let _ = ctx.catch();
                    assert!(ctx.eval::<bool, _>("!('ui' in globalThis)&&!('__pak' in globalThis)&&!('console' in globalThis)").unwrap());
                }
                mount_ui(&ctx, ops.clone(), &environment(None), profile).unwrap();
                assert_eq!(ctx.eval::<u32, _>("ui.__hostAbi").unwrap(), BINDING_GENERATION);
            });
        }
    }
    #[test]
    fn typed_array_offset_is_borrowed_after_reentrant_scalar_coercion() {
        let (guest, ops) = guest(BindingProfile::Canonical);
        let handle = evaluate::<i32>(
            &guest,
            "ui.uploadTexture(new Uint8Array([99,99,99,99,10,20,30,255]).subarray(4), {valueOf(){ui.createNode(0);return 1}},1,3)",
        );
        let core = ops.core().unwrap();
        assert_eq!(core.ui.texture(handle).unwrap().pixels, &[10, 20, 30, 255]);
    }
    #[test]
    fn reentrant_string_coercion_does_not_hold_core_borrow() {
        let (guest, ops) = guest(BindingProfile::Canonical);
        let id = evaluate::<i32>(
            &guest,
            "(()=>{let id=ui.createNode(1);ui.setText(id,{toString(){ui.createNode(0);return 'ok'}});return id})()",
        );
        assert_eq!(ops.core().unwrap().ui.node_text(id), Some("ok"));
        let lone = evaluate::<i32>(
            &guest,
            "(()=>{let id=ui.createNode(1);ui.setText(id,'\\ud800');return id})()",
        );
        assert!(ops
            .core()
            .unwrap()
            .ui
            .node_text(lone)
            .unwrap()
            .contains('\u{fffd}'));
    }
    #[test]
    fn missing_arguments_and_empty_results_follow_profile() {
        let (canonical, _) = guest(BindingProfile::Canonical);
        assert!(evaluate::<bool>(
            &canonical,
            "(()=>{try{ui.createNode();return false}catch(e){return e instanceof TypeError}})()"
        ));
        assert_eq!(
            evaluate::<String>(&canonical, "ui.takeAnimationCompletions()"),
            "[]"
        );
        assert_eq!(
            evaluate::<String>(&canonical, "JSON.stringify(ui.wrapText('',0,100))"),
            "[]"
        );
        let (idf, _) = guest(BindingProfile::Idf);
        assert!(evaluate::<bool>(
            &idf,
            "ui.createNode()>0 && ui.measureText()===0 && ui.wrapText('text').length===0 && !('takeAnimationCompletions' in ui)"
        ));
        assert!(evaluate::<bool>(
            &idf,
            "(()=>{try{ui.uploadTexture(new ArrayBuffer(4),1,1,3);return false}catch(e){return e instanceof TypeError}})()"
        ));
        let (legacy, _) = guest(BindingProfile::LegacyC);
        assert!(evaluate::<bool>(
            &legacy,
            "!('wrapText' in ui) && !('__tickHz' in ui) && __simHz===60"
        ));
    }
    #[test]
    fn detached_views_are_rejected_after_coercion_before_dispatch() {
        let (guest, _) = guest(BindingProfile::Canonical);
        assert!(evaluate::<bool>(
            &guest,
            "(()=>{const buf=new ArrayBuffer(4);const view=new Uint8Array(buf);try{ui.uploadTexture(view,{valueOf(){buf.transfer();return 1}},1,3);return false}catch(e){return true}})()"
        ));
    }
    #[test]
    fn frame_passes_nine_arguments_and_drains_jobs() {
        let (mut guest, _) = guest(BindingProfile::Canonical);
        guest.evaluate(b"globalThis.frame=(...args)=>{globalThis.received=args;Promise.resolve().then(()=>globalThis.drained=true)}").unwrap();
        let delta = pocket_drivers::AxisDelta { id: 1, delta: -5 };
        let mut motion = pocket_drivers::MotionState::default();
        motion.timestamp = 100;
        guest
            .frame(&GuestFrame {
                buttons: 9,
                analog: 0x8080,
                touches: &[0x40040000],
                hits: &[0],
                touch_surfaces: &[1],
                right_analog: 0x807f,
                axis_deltas: &[delta],
                motion: Some(&motion),
                text: &[
                    pocket_drivers::TextEvent::Commit("hi".into()),
                    pocket_drivers::TextEvent::Key {
                        key: "Enter".into(),
                        pressed: true,
                        repeat: false,
                    },
                ],
            })
            .unwrap();
        assert!(evaluate::<bool>(
            &guest,
            "received.length===9 && received[2][0]===0x40040000 && received[4][0]===1 && received[6][0].axis===1 && received[6][0].delta===-5 && received[7].timestamp===100 && received[8].length===2 && received[8][0].kind===2 && received[8][0].text==='hi' && received[8][1].kind===0 && received[8][1].text==='Enter' && received[8][1].repeat===false && drained"
        ));
    }
    #[test]
    fn evaluates_the_nul_terminated_source_span_returned_by_package_admission() {
        let (mut guest, _) = guest(BindingProfile::Canonical);
        guest.evaluate(b"globalThis.fromPackage=41;\0").unwrap();
        guest.evaluate(b"globalThis.fromPackage++;").unwrap();
        assert_eq!(evaluate::<i32>(&guest, "fromPackage"), 42);
        assert!(guest.evaluate(b"globalThis.fromPackage=\0 1;\0").is_err());
    }
}
