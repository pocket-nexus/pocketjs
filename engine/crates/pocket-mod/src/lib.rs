//! pocket-mod — guest hosting for the Pocket runtime family.
//!
//! The mechanism half of the extension architecture (see docs/RUNTIMES.md):
//! a runtime is ⟨Cores, Surfaces, Guest⟩, and this crate owns the **Guest** —
//! one QuickJS realm evaluating one bundled product (an app, a game's mods,
//! or both), plus the plumbing every runtime shares:
//!
//!   - realm lifecycle: create, mount surfaces, eval the bundle;
//!   - surface mounting: a named namespace object on `globalThis`
//!     (`ui`, `strike`, …) populated with native op functions;
//!   - the guest turn: `frame(buttons, analog)` once per fixed-step tick,
//!     then the job queue drains (Law 3: one guest turn per host tick — the
//!     guest never owns a timer or a thread);
//!   - `console.*` routed to the host's `log` output.
//!
//! Cores never call the guest mid-tick; surfaces deliver facts as per-tick
//! event batches built through [`Guest::with`].
//!
//! The realm is deliberately capability-free: no filesystem, no network, no
//! process access. A guest can affect exactly what its mounted surfaces
//! express.

use anyhow::{Result, anyhow};
use rquickjs::{
    CatchResultExt, Context, Ctx, Error as QuickJsError, Function, Object, Runtime, qjs as raw_qjs,
};

// Surface crates implement ops against the same rquickjs the guest uses.
pub use rquickjs as qjs;

/// One QuickJS realm hosting one guest program.
pub struct Guest {
    rt: Runtime,
    ctx: Context,
}

/// Failure stage for trusted bytecode evaluation.
///
/// A host may fall back to source after [`BytecodeEvalError::Read`], because
/// QuickJS has not executed the program. An [`BytecodeEvalError::Execute`]
/// means the program started and may have mutated the realm; evaluating source
/// afterward would run application initialization twice.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BytecodeEvalError {
    Read(String),
    Execute(String),
}

impl std::fmt::Display for BytecodeEvalError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Read(error) => write!(f, "reading QuickJS bytecode failed: {error}"),
            Self::Execute(error) => write!(f, "executing QuickJS bytecode failed: {error}"),
        }
    }
}

impl std::error::Error for BytecodeEvalError {}

impl Guest {
    /// Create an empty realm with `console.*` installed. Mount surfaces and
    /// eval the product bundle next; drop and rebuild for a hot reload.
    pub fn new() -> Result<Guest> {
        Self::from_runtime(Runtime::new()?)
    }

    /// Create an empty realm backed by a host-selected QuickJS allocator.
    pub fn new_with_alloc<A>(allocator: A) -> Result<Guest>
    where
        A: qjs::allocator::Allocator + 'static,
    {
        Self::from_runtime(Runtime::new_with_alloc(allocator)?)
    }

    fn from_runtime(rt: Runtime) -> Result<Guest> {
        let ctx = Context::full(&rt)?;
        ctx.with(|ctx| install_console(&ctx))
            .map_err(|e| anyhow!("pocket-mod: installing console: {e}"))?;
        Ok(Guest { rt, ctx })
    }

    /// Run `f` with the realm's [`Ctx`]. Surface crates use this to build
    /// per-tick event payloads or to reach guest globals the helpers below
    /// don't cover.
    pub fn with<F, R>(&self, f: F) -> R
    where
        F: FnOnce(Ctx) -> R,
    {
        self.ctx.with(f)
    }

    /// Mount a surface: creates the namespace object, lets `build` populate
    /// it with op functions, and installs it as `globalThis.<name>`.
    pub fn mount<F>(&self, name: &str, build: F) -> Result<()>
    where
        F: for<'js> FnOnce(&Ctx<'js>, &Object<'js>) -> rquickjs::Result<()>,
    {
        self.ctx
            .with(|ctx| -> rquickjs::Result<()> {
                let ns = Object::new(ctx.clone())?;
                build(&ctx, &ns)?;
                ctx.globals().set(name, ns)?;
                Ok(())
            })
            .map_err(|e| anyhow!("pocket-mod: mounting surface '{name}': {e}"))
    }

    /// Evaluate a product bundle (an iife script, the PocketJS build output)
    /// as a global script. Exceptions come back as errors with the JS stack.
    pub fn eval(&self, label: &str, source: &str) -> Result<()> {
        self.ctx.with(|ctx| -> Result<()> {
            ctx.eval::<(), _>(source.as_bytes())
                .catch(&ctx)
                .map_err(|e| anyhow!("pocket-mod: eval '{label}' failed: {e}"))?;
            Ok(())
        })?;
        self.drain_jobs();
        Ok(())
    }

    /// Evaluate trusted QuickJS bytecode for a global strict-mode script.
    ///
    /// The caller must establish that `bytecode` came from the same QuickJS
    /// source and build configuration as this runtime. QuickJS bytecode is not
    /// a safe interchange format; malformed or incompatible input can violate
    /// engine invariants before an exception can be reported.
    ///
    /// # Safety
    ///
    /// `bytecode` must have passed the host's package integrity and exact
    /// engine-ABI checks before this method is called.
    pub unsafe fn eval_trusted_bytecode(
        &self,
        label: &str,
        bytecode: &[u8],
    ) -> std::result::Result<(), BytecodeEvalError> {
        self.ctx.with(|ctx| {
            let raw_ctx = ctx.as_raw().as_ptr();
            let function = unsafe {
                raw_qjs::JS_ReadObject(
                    raw_ctx,
                    bytecode.as_ptr(),
                    bytecode.len() as _,
                    raw_qjs::JS_READ_OBJ_BYTECODE as i32,
                )
            };
            if unsafe { raw_qjs::JS_VALUE_GET_NORM_TAG(function) } == raw_qjs::JS_TAG_EXCEPTION {
                return Err(QuickJsError::Exception)
                    .catch(&ctx)
                    .map_err(|e| BytecodeEvalError::Read(format!("'{label}': {e}")));
            }

            // JS_EvalFunction consumes the compiled function. Unlike rquickjs'
            // module loader, this is a global-script object and needs no module
            // resolution or promise conversion.
            let value = unsafe { raw_qjs::JS_EvalFunction(raw_ctx, function) };
            if unsafe { raw_qjs::JS_VALUE_GET_NORM_TAG(value) } == raw_qjs::JS_TAG_EXCEPTION {
                return Err(QuickJsError::Exception)
                    .catch(&ctx)
                    .map_err(|e| BytecodeEvalError::Execute(format!("'{label}': {e}")));
            }
            unsafe { raw_qjs::JS_FreeValue(raw_ctx, value) };
            Ok(())
        })?;
        self.drain_jobs();
        Ok(())
    }

    /// One guest turn at a centered analog nub — hosts without a stick call
    /// this and the guest sees `spec::ANALOG_CENTER`, so pre-analog tapes
    /// and goldens hold.
    pub fn frame(&self, buttons: u32) -> Result<()> {
        self.frame_with_analog(buttons, pocketjs_core::spec::ANALOG_CENTER)
    }

    /// One guest turn: call `globalThis.frame(buttons, analog)` if the
    /// bundle installed it, then drain the job queue. `analog` packs the nub
    /// as (x << 8) | y, each axis 0..255 with 128 = center. Call exactly
    /// once per fixed-step tick.
    pub fn frame_with_analog(&self, buttons: u32, analog: u32) -> Result<()> {
        self.ctx.with(|ctx| -> Result<()> {
            let frame: Option<Function> = ctx.globals().get("frame").ok();
            if let Some(frame) = frame {
                frame
                    .call::<_, ()>((buttons, analog))
                    .catch(&ctx)
                    .map_err(|e| anyhow!("pocket-mod: frame() threw: {e}"))?;
            }
            Ok(())
        })?;
        self.drain_jobs();
        Ok(())
    }

    /// One guest turn with touch contacts. `touches` packs each contact as
    /// `(id << 18) | (y << 9) | x` (framework/src/touch.ts): 9 bits per axis
    /// (so logical coordinates must be ≤ 511), 8 bits of id, up to 8 contacts.
    /// A contact present in the array is down/move this frame; absent = released.
    /// Hosts without touch call [`Guest::frame`] / [`Guest::frame_with_analog`]
    /// instead; this is the 3-arg `globalThis.frame(buttons, analog, touches)`
    /// path for touch targets (Vita, PocketBook).
    pub fn frame_with_touches(&self, buttons: u32, analog: u32, touches: &[u32]) -> Result<()> {
        self.frame_with_touch_facts(buttons, analog, touches, None)
    }

    /// One guest turn with touch contacts and host-resolved hit facts. `hits`
    /// is parallel to `touches`: the host resolves each contact against the
    /// committed frame at its down edge and carries that node id until release.
    pub fn frame_with_touch_hits(
        &self,
        buttons: u32,
        analog: u32,
        touches: &[u32],
        hits: &[i32],
    ) -> Result<()> {
        if touches.len() != hits.len() {
            anyhow::bail!(
                "pocket-mod: touch hit facts must be parallel to contacts ({} touches, {} hits)",
                touches.len(),
                hits.len()
            );
        }
        self.frame_with_touch_facts(buttons, analog, touches, Some(hits))
    }

    fn frame_with_touch_facts(
        &self,
        buttons: u32,
        analog: u32,
        touches: &[u32],
        hits: Option<&[i32]>,
    ) -> Result<()> {
        self.ctx.with(|ctx| -> Result<()> {
            let frame: Option<Function> = ctx.globals().get("frame").ok();
            if let Some(frame) = frame {
                let arr = rquickjs::Array::new(ctx.clone())
                    .map_err(|e| anyhow!("pocket-mod: allocating touch array: {e}"))?;
                for (i, t) in touches.iter().enumerate() {
                    arr.set(i, *t)
                        .map_err(|e| anyhow!("pocket-mod: setting touch {i}: {e}"))?;
                }
                if let Some(hits) = hits {
                    let hit_arr = rquickjs::Array::new(ctx.clone())
                        .map_err(|e| anyhow!("pocket-mod: allocating touch hit array: {e}"))?;
                    for (i, hit) in hits.iter().enumerate() {
                        hit_arr
                            .set(i, *hit)
                            .map_err(|e| anyhow!("pocket-mod: setting touch hit {i}: {e}"))?;
                    }
                    frame
                        .call::<_, ()>((buttons, analog, arr, hit_arr))
                        .catch(&ctx)
                        .map_err(|e| anyhow!("pocket-mod: frame() threw: {e}"))?;
                } else {
                    frame
                        .call::<_, ()>((buttons, analog, arr))
                        .catch(&ctx)
                        .map_err(|e| anyhow!("pocket-mod: frame() threw: {e}"))?;
                }
            }
            Ok(())
        })?;
        self.drain_jobs();
        Ok(())
    }

    /// Drain the microtask/job queue (promise reactions). Job exceptions are
    /// logged, not fatal — matching how hosts treat stray rejections.
    pub fn drain_jobs(&self) {
        loop {
            match self.rt.execute_pending_job() {
                Ok(true) => continue,
                Ok(false) => break,
                Err(e) => {
                    log::error!(target: "guest", "pocket-mod: pending job threw: {e:?}");
                }
            }
        }
    }

    /// Whether the evaluated bundle installed `globalThis.frame`.
    pub fn has_frame(&self) -> bool {
        self.ctx
            .with(|ctx| ctx.globals().get::<_, Function>("frame").is_ok())
    }
}

/// `console.log/info/warn/error/debug` → the host's `log` crate, target
/// "guest". Arguments are stringified and space-joined, browser-style.
fn install_console(ctx: &Ctx) -> rquickjs::Result<()> {
    let console = Object::new(ctx.clone())?;

    fn join(args: rquickjs::function::Rest<rquickjs::Value>) -> String {
        let mut out = String::new();
        for (i, v) in args.iter().enumerate() {
            if i > 0 {
                out.push(' ');
            }
            match stringify(v) {
                Some(s) => out.push_str(&s),
                None => out.push_str("<value>"),
            }
        }
        out
    }

    fn stringify(v: &rquickjs::Value) -> Option<String> {
        if let Some(s) = v.as_string() {
            return s.to_string().ok();
        }
        // Round-trip through the engine's own coercion for everything else.
        let ctx = v.ctx();
        let global = ctx.globals();
        let to_str: Function = global.get("String").ok()?;
        to_str.call::<_, String>((v.clone(),)).ok()
    }

    console.set(
        "log",
        Function::new(
            ctx.clone(),
            |args: rquickjs::function::Rest<rquickjs::Value>| {
                log::info!(target: "guest", "{}", join(args));
            },
        )?,
    )?;
    console.set(
        "info",
        Function::new(
            ctx.clone(),
            |args: rquickjs::function::Rest<rquickjs::Value>| {
                log::info!(target: "guest", "{}", join(args));
            },
        )?,
    )?;
    console.set(
        "debug",
        Function::new(
            ctx.clone(),
            |args: rquickjs::function::Rest<rquickjs::Value>| {
                log::debug!(target: "guest", "{}", join(args));
            },
        )?,
    )?;
    console.set(
        "warn",
        Function::new(
            ctx.clone(),
            |args: rquickjs::function::Rest<rquickjs::Value>| {
                log::warn!(target: "guest", "{}", join(args));
            },
        )?,
    )?;
    console.set(
        "error",
        Function::new(
            ctx.clone(),
            |args: rquickjs::function::Rest<rquickjs::Value>| {
                log::error!(target: "guest", "{}", join(args));
            },
        )?,
    )?;
    ctx.globals().set("console", console)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{ffi::CString, slice};

    fn compile_global_bytecode(source: &str, label: &str) -> Vec<u8> {
        let compiler = Guest::new().unwrap();
        compiler.with(|ctx| unsafe {
            let source = CString::new(source).unwrap();
            let label = CString::new(label).unwrap();
            let raw_ctx = ctx.as_raw().as_ptr();
            let function = raw_qjs::JS_Eval(
                raw_ctx,
                source.as_ptr(),
                source.as_bytes().len() as _,
                label.as_ptr(),
                (raw_qjs::JS_EVAL_TYPE_GLOBAL
                    | raw_qjs::JS_EVAL_FLAG_STRICT
                    | raw_qjs::JS_EVAL_FLAG_COMPILE_ONLY) as i32,
            );
            assert_ne!(
                raw_qjs::JS_VALUE_GET_NORM_TAG(function),
                raw_qjs::JS_TAG_EXCEPTION
            );
            let mut len = 0;
            let bytes = raw_qjs::JS_WriteObject(
                raw_ctx,
                &mut len,
                function,
                raw_qjs::JS_WRITE_OBJ_BYTECODE as i32,
            );
            raw_qjs::JS_FreeValue(raw_ctx, function);
            assert!(!bytes.is_null());
            assert_ne!(len, 0);
            let bytecode = slice::from_raw_parts(bytes, len as usize).to_vec();
            raw_qjs::js_free(raw_ctx, bytes.cast());
            bytecode
        })
    }

    #[test]
    fn eval_and_frame_turn() {
        let g = Guest::new().unwrap();
        g.eval(
            "boot",
            "globalThis.n = 0; globalThis.frame = (b) => { globalThis.n += b; };",
        )
        .unwrap();
        assert!(g.has_frame());
        g.frame(3).unwrap();
        g.frame(4).unwrap();
        let n: i32 = g.with(|ctx| ctx.globals().get("n").unwrap());
        assert_eq!(n, 7);
    }

    #[test]
    fn trusted_global_bytecode_eval_and_frame_turn() {
        let bytecode = compile_global_bytecode(
            "globalThis.n = 0; globalThis.frame = (b) => { globalThis.n += b; };",
            "bytecode-boot",
        );
        let g = Guest::new().unwrap();
        unsafe { g.eval_trusted_bytecode("bytecode-boot", &bytecode) }.unwrap();
        assert!(g.has_frame());
        g.frame(7).unwrap();
        let n: i32 = g.with(|ctx| ctx.globals().get("n").unwrap());
        assert_eq!(n, 7);
    }

    #[test]
    fn trusted_bytecode_eval_reports_js_stack() {
        let bytecode = compile_global_bytecode(
            "function inner(){ throw new Error('bytecode kaboom'); } inner();",
            "bytecode-boom",
        );
        let g = Guest::new().unwrap();
        let error = unsafe { g.eval_trusted_bytecode("bytecode-boom", &bytecode) }.unwrap_err();
        assert!(matches!(error, BytecodeEvalError::Execute(_)));
        let message = format!("{error:#}");
        assert!(message.contains("bytecode kaboom"), "got: {message}");
        assert!(message.contains("inner"), "got: {message}");
    }

    #[test]
    fn invalid_bytecode_is_a_read_error() {
        let g = Guest::new().unwrap();
        let error = unsafe { g.eval_trusted_bytecode("broken", &[0xff]) }.unwrap_err();
        assert!(matches!(error, BytecodeEvalError::Read(_)));
    }

    #[test]
    fn mounted_surface_ops_are_callable() {
        use std::cell::RefCell;
        use std::rc::Rc;

        let hits = Rc::new(RefCell::new(Vec::<i32>::new()));
        let g = Guest::new().unwrap();
        let h = hits.clone();
        g.mount("demo", |ctx, ns| {
            let h = h.clone();
            ns.set(
                "poke",
                Function::new(ctx.clone(), move |v: i32| {
                    h.borrow_mut().push(v);
                    v * 2
                })?,
            )?;
            Ok(())
        })
        .unwrap();
        g.eval("boot", "globalThis.out = demo.poke(21);").unwrap();
        let out: i32 = g.with(|ctx| ctx.globals().get("out").unwrap());
        assert_eq!(out, 42);
        assert_eq!(*hits.borrow(), vec![21]);
    }

    #[test]
    fn frame_passes_analog_and_defaults_to_center() {
        let g = Guest::new().unwrap();
        g.eval(
            "boot",
            "globalThis.a = -1; globalThis.frame = (b, analog) => { globalThis.a = analog; };",
        )
        .unwrap();
        g.frame_with_analog(0, 0x20e0).unwrap();
        let a: u32 = g.with(|ctx| ctx.globals().get("a").unwrap());
        assert_eq!(a, 0x20e0);
        g.frame(0).unwrap();
        let a: u32 = g.with(|ctx| ctx.globals().get("a").unwrap());
        assert_eq!(a, pocketjs_core::spec::ANALOG_CENTER);
    }

    #[test]
    fn frame_carries_packed_touches() {
        let g = Guest::new().unwrap();
        g.eval(
            "boot",
            "globalThis.res = ''; \
             globalThis.frame = (b, a, t) => { \
               globalThis.res = b + ':' + (t ? t.length : 0) + ':' + (t && t[0] !== undefined ? t[0] : -1); \
             };",
        )
        .unwrap();
        // (id<<18)|(y<<9)|x — contact id 0 at logical (10, 20):
        let packed = (20u32 << 9) | 10;
        g.frame_with_touches(5, pocketjs_core::spec::ANALOG_CENTER, &[packed])
            .unwrap();
        let res: String = g.with(|ctx| ctx.globals().get("res").unwrap());
        assert_eq!(res, format!("5:1:{packed}"));
        // No contacts → empty array, frame still turns.
        g.frame_with_touches(0, pocketjs_core::spec::ANALOG_CENTER, &[])
            .unwrap();
        let res: String = g.with(|ctx| ctx.globals().get("res").unwrap());
        assert_eq!(res, "0:0:-1");
    }

    #[test]
    fn frame_carries_parallel_touch_hit_facts() {
        let g = Guest::new().unwrap();
        g.eval(
            "boot",
            "globalThis.res = ''; \
             globalThis.frame = (b, a, t, h) => { \
               globalThis.res = t.length + ':' + h.length + ':' + h[0]; \
             };",
        )
        .unwrap();
        g.frame_with_touch_hits(
            0,
            pocketjs_core::spec::ANALOG_CENTER,
            &[(20u32 << 9) | 10],
            &[42],
        )
        .unwrap();
        let res: String = g.with(|ctx| ctx.globals().get("res").unwrap());
        assert_eq!(res, "1:1:42");

        let error = g
            .frame_with_touch_hits(0, pocketjs_core::spec::ANALOG_CENTER, &[1], &[])
            .unwrap_err();
        assert!(error.to_string().contains("parallel to contacts"));
    }

    #[test]
    fn exceptions_carry_js_stack() {
        let g = Guest::new().unwrap();
        let err = g.eval(
            "boom",
            "function inner(){ throw new Error('kaboom'); } inner();",
        );
        let msg = format!("{:#}", err.unwrap_err());
        assert!(msg.contains("kaboom"), "got: {msg}");
    }

    #[test]
    fn microtasks_drain_within_the_turn() {
        let g = Guest::new().unwrap();
        g.eval(
            "boot",
            "globalThis.v = 0; globalThis.frame = () => { Promise.resolve().then(() => { globalThis.v = 1; }); };",
        )
        .unwrap();
        g.frame(0).unwrap();
        let v: i32 = g.with(|ctx| ctx.globals().get("v").unwrap());
        assert_eq!(v, 1);
    }
}
