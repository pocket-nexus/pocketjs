#![cfg(test)]
#![allow(dead_code, unused_unsafe)]
extern crate alloc;
// Compile the production composition/extension code. Only device services are
// substituted; QuickJS, generated bindings, runtime and core are real.
#[path = "../../../../programs/psp/src/service_bindings.rs"]
mod service_bindings;
#[path = "../../../../programs/psp/src/instance.rs"]
mod instance;
/// The profile tools/test-psp-runtime.ts exports, as the program embeds it.
mod profile {
    include!(concat!(env!("OUT_DIR"), "/pocket_profile.rs"));
}
mod dbg {
    pub fn active() -> bool {
        false
    }
    pub fn poll() -> Option<String> {
        None
    }
    pub fn send(_: &[u8]) {}
    pub fn shot() -> bool {
        false
    }
}
mod svc {
    pub fn open(name: &str) -> bool {
        name == "fixture"
    }
    pub fn poll() -> Option<String> {
        Some("reply".into())
    }
    pub fn send(_: &[u8]) {}
    pub fn read_side_file(_: &str, _: usize) -> Option<Vec<u8>> {
        None
    }
}
mod vid {
    pub fn open(_: &mut pocketjs_core::Ui, _: &str) -> bool {
        true
    }
    pub fn tick(_: &mut pocketjs_core::Ui) -> i32 {
        7
    }
    pub fn texture() -> i32 {
        -1
    }
    pub fn close(_: &mut pocketjs_core::Ui) {}
}
mod stats {
    pub fn json() -> String {
        "{}".into()
    }
}
use libquickjs_sys::*;
use pocket_drivers::*;
use pocket_drivers::abi::*;
use pocket_runtime::{
    abi::{status_code, Handle},
    Runtime, RuntimeError,
};
// The archive defines the pocket_runtime_* symbols the C guest calls.
use pocket_archive as _;
use std::{cell::RefCell, rc::Rc};
struct Render(Rc<RefCell<Vec<&'static str>>>);
impl Renderer for Render {
    type Submission = ();
    fn descriptor(&self) -> RendererDescriptor {
        RendererDescriptor::new(
            &[PixelFormat::Rgba8888],
            TargetOwnership::DeviceOwned,
            Synchronization::Deferred,
            pocketjs_core::spec::DRAW_LIST_VERSION,
            false,
        )
        .unwrap()
    }
    fn render(&mut self, _: &mut FrameInput<'_>) -> Result<(), RenderError> {
        self.0.borrow_mut().push("render");
        Ok(())
    }
    fn wait(&mut self, _: &()) -> Result<(), RenderError> {
        self.0.borrow_mut().push("wait");
        Ok(())
    }
    fn retire(&mut self, _: ()) {
        self.0.borrow_mut().push("retire");
    }
}
struct Display(Rc<RefCell<Vec<&'static str>>>);
impl DisplayOutput for Display {
    type Token = ();
    fn vsync(&mut self) -> VsyncSource {
        VsyncSource::None
    }
    fn descriptor(&self) -> DisplayDescriptor {
        DisplayDescriptor::new(
            DisplayRole::Primary,
            480,
            272,
            PixelFormat::Rgba8888,
            480 * 4,
            TargetOwnership::DeviceOwned,
        )
    }
    fn acquire(&mut self, rect: Rect) -> Result<Target<'_>, DisplayError> {
        Ok(Target::DeviceOwned(DeviceTarget::new(
            1,
            rect,
            PixelFormat::Rgba8888,
        )))
    }
    fn flush(&mut self, _: &[Rect]) -> Result<(), DisplayError> {
        self.0.borrow_mut().push("flush");
        Ok(())
    }
    fn wait(&mut self, _: ()) -> Result<(), DisplayError> {
        self.0.borrow_mut().push("display-wait");
        Ok(())
    }
}
struct Program {
    /// Declared first: the instance shuts down before the guest adapter and
    /// its context drop. `None` once a test destroys it.
    runtime: Option<Box<Handle>>,
    guest: Box<instance::Guest>,
    input: Rc<RefCell<instance::Input>>,
    events: Rc<RefCell<Vec<&'static str>>>,
}
/// The C status of one runtime call on the program's instance.
fn status<T>(result: Result<T, RuntimeError>) -> i32 {
    result.map_or_else(status_code, |_| POCKET_STATUS_OK)
}
/// A compiled bundle for the exported profile, as tools/psp.ts embeds one.
fn package(code: &[u8], plan: &[u8]) -> Vec<u8> {
    let identity = pocket_package::embedded::identity("fixture", "psp.fixture", "Fixture").unwrap();
    pocket_package::embedded::encode(pocket_package::embedded::EmbeddedPackage {
        host_abi: profile::HOST_ABI,
        profile_hash: profile::PROFILE_HASH,
        identity: &identity,
        plan,
        code,
        pak: &[],
    })
    .unwrap()
}
const PLAN: &[u8] = br#"{"animation":"composited","profile":{"tickHz":60},"viewport":{"logical":[480,272],"presentation":"native","rasterDensity":1},"features":{}}"#;
impl Program {
    fn handle(&self) -> &Handle {
        self.runtime.as_deref().expect("live runtime")
    }
    fn call(&self, action: impl FnOnce(&mut Runtime) -> Result<(), RuntimeError>) -> i32 {
        status(self.handle().with_runtime(action))
    }
    unsafe fn new(code: &[u8]) -> Self {
        let p = Self::unbooted();
        assert_eq!(
            {
                assert_eq!(
                    p.call(|r| r.set_package_source(Box::new(pocket_package::source::MemorySource(package(code, PLAN))))),
                    0
                );
                p.call(Runtime::boot_deferred)
            },
            0,
            "{}",
            p.guest.error()
        );
        assert!(p.events.borrow().is_empty());
        assert_eq!(p.call(Runtime::skip_presentation), 0);
        p
    }
    unsafe fn unbooted() -> Self {
        let runtime = Handle::new(pocket_runtime::RuntimeConfig {
            profile_hash: profile::PROFILE_HASH,
            host_abi: profile::HOST_ABI,
            heap_limit: 128 << 20,
            frame_buffer_budget: 1,
            profile: profile::profile().unwrap(),
        })
        .unwrap();
        // The fixture profile adds ui.physics; the fixture installs the engine.
        runtime
            .with_runtime(|r| r.set_physics(Box::new(pocket_physics::Physics::new())))
            .unwrap();
        let ops = runtime.op_context();
        ops.add_provider(Box::new(instance::Services)).unwrap();
        let guest = instance::Guest::new(ops, Some(20), "fixture-data".into()).unwrap();
        let input = Rc::new(RefCell::new(instance::Input {
            analog: 0x8080,
            ..Default::default()
        }));
        let events = Rc::new(RefCell::new(Vec::new()));
        let mut p = Self {
            runtime: Some(runtime),
            guest,
            input,
            events,
        };
        let render = Render(p.events.clone());
        let renderer = p.handle().with_runtime(|r| r.add_renderer(render)).unwrap();
        let display = Display(p.events.clone());
        assert_eq!(p.call(|r| r.add_display(display, renderer).map(|_| ())), 0);
        let input = Box::new(instance::InputDriver(p.input.clone()));
        assert_eq!(p.call(|r| r.add_input_source(input)), 0);
        assert_eq!(
            pocket_runtime::abi::pocket_runtime_set_guest(
                p.handle().as_ptr(),
                &instance::GUEST,
                (&mut *p.guest as *mut instance::Guest).cast()
            ),
            0
        );
        p
    }
    unsafe fn assert_js(&self, source: &str) {
        let source = std::ffi::CString::new(source).unwrap();
        let v = JS_Eval(
            self.guest.context,
            source.as_ptr().cast(),
            source.as_bytes().len(),
            c"fixture".as_ptr(),
            JS_EVAL_TYPE_GLOBAL as i32,
        );
        if JS_IsException(v) {
            let err = JS_GetException(self.guest.context);
            let str = JS_ToCStringLen2(self.guest.context, std::ptr::null_mut(), err, 0);
            let message = std::ffi::CStr::from_ptr(str).to_string_lossy().into_owned();
            JS_FreeCString(self.guest.context, str);
            JS_FreeValue(self.guest.context, err);
            panic!("{message}");
        }
        JS_FreeValue(self.guest.context, v);
    }
}

mod qjs_alloc {
    pub unsafe fn new_runtime() -> *mut libquickjs_sys::JSRuntime {
        libquickjs_sys::JS_NewRuntime()
    }
}
mod host {
    use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
    static TIME: AtomicU64 = AtomicU64::new(1);
    pub static MASKED: AtomicUsize = AtomicUsize::new(0);
    pub fn now_us() -> u64 {
        TIME.fetch_add(1, Ordering::Relaxed)
    }
    pub struct FpuGuard;
    impl FpuGuard {
        pub unsafe fn masked() -> Self {
            MASKED.fetch_add(1, Ordering::Relaxed);
            Self
        }
    }
    impl Drop for FpuGuard {
        fn drop(&mut self) {
            MASKED.fetch_sub(1, Ordering::Relaxed);
        }
    }
}
mod audio_mod {
    thread_local! {pub static PCM:std::cell::RefCell<Vec<i16>>=std::cell::RefCell::new(Vec::new());}
    pub unsafe fn create_stream(_: u32, _: u32) -> i32 {
        1
    }
    pub unsafe fn destroy_stream(_: i32) {}
    pub unsafe fn write_pcm(_: i32, pcm: &[i16]) -> i32 {
        PCM.with(|out| out.borrow_mut().extend_from_slice(pcm));
        pcm.len() as i32
    }
    pub unsafe fn write_pcm_le(handle: i32, bytes: &[u8]) -> i32 {
        let pcm: Vec<i16> = bytes
            .chunks_exact(2)
            .map(|pair| i16::from_le_bytes([pair[0], pair[1]]))
            .collect();
        write_pcm(handle, &pcm)
    }
    pub unsafe fn play(_: i32) {}
    pub unsafe fn pause(_: i32) {}
    pub unsafe fn stop(_: i32) {}
    pub unsafe fn set_volume(_: i32, _: f64) {}
    pub unsafe fn end_stream(_: i32) {}
    pub unsafe fn poll() -> Option<String> {
        None
    }
}
mod fs_ops {
    thread_local! {pub static NAME: std::cell::RefCell<String> = std::cell::RefCell::new(String::new());}
    pub unsafe fn register_fs(
        _: *mut libquickjs_sys::JSContext,
        _: libquickjs_sys::JSValue,
        data_name: &str,
    ) {
        NAME.with(|name| *name.borrow_mut() = data_name.into());
    }
}
mod pack_ops {
    pub unsafe fn register_pack(_: *mut libquickjs_sys::JSContext, _: libquickjs_sys::JSValue) {}
}
mod offload {
    pub fn enabled() -> bool {
        true
    }
    pub fn start() {}
    pub fn session() -> i32 {
        7
    }
    pub fn submit(_: &[u8]) -> bool {
        true
    }
    pub fn take() -> Option<String> {
        None
    }
}
mod offload_local {
    pub struct Request {
        pub id: u32,
        pub op: u8,
        pub path: [u8; 128],
        pub generation: u32,
        pub slot: u8,
        pub count: u8,
        pub cps: [u32; 4],
    }
    impl Request {
        pub fn empty() -> Self {
            Self {
                id: 0,
                op: 0,
                path: [0; 128],
                generation: 0,
                slot: 0,
                count: 0,
                cps: [0; 4],
            }
        }
    }
    pub fn start() {}
    pub fn session() -> i32 {
        8
    }
    pub fn take() -> Option<String> {
        None
    }
    pub fn submit(_: Request) -> bool {
        true
    }
}
#[path = "../../../../programs/psp/src/offload_image.rs"]
mod offload_image;

#[test]
fn public_namespace_providers_and_private_extensions_share_one_runtime() {
    unsafe {
        let p=Program::new(r#"globalThis.frame=function(){};globalThis.node=ui.createNode(1);if(ui.__host!=='psp'||ui.__hostAbi!==EXPECTED_BINDING||ui.__tickHz!==60||__simHz!==20||ui.__viewport.w!==480)throw Error('metadata');if(!ui.__textures||!ui.__sprites)throw Error('assets');if(typeof ui.appTable!=='undefined'||typeof ui.physicsCreate!=='undefined')throw Error('missing provider');if(!ui.svcOpen('fixture')||ui.svcPoll()!=='reply'||ui.videoTick()!==7)throw Error('provider');if(ui.__dbgActive()!==false||audio.createStream(44100,2)!==1||offload.session()!==7)throw Error('private namespace');"#.replace("EXPECTED_BINDING", &pocket_spec::BINDING_GENERATION.to_string()).as_bytes());
        p.assert_js("if(node<=0)throw Error('core');let b=new Uint8Array([1,2,3,4,5,6]);if(audio.writePcm(1,b.subarray(1,5))!==2)throw Error('audio view');");
        // The library's own namespaces stop at audio, fs, pack and offload:
        // link and media are a program's (frame::Program::globals).
        p.assert_js(r#"if(typeof net!=='undefined'||typeof link!=='undefined'||typeof media!=='undefined')throw Error('product namespace');"#);
        audio_mod::PCM.with(|pcm| assert_eq!(&*pcm.borrow(), &[0x302, 0x504]));
        assert_eq!(host::MASKED.load(std::sync::atomic::Ordering::Relaxed), 0);
    }
}
/// What a program crate composing the library registers before boot for
/// operations the library does not implement, as a product that switches
/// guests answers appTable (39) and appShot (41).
struct ProgramOps {
    shot: Option<i32>,
}
impl pocket_runtime::OpProvider for ProgramOps {
    fn supports_op(&self, op: u16) -> bool {
        matches!(op, 39 | 41)
    }
    fn dispatch(
        &mut self,
        ui: &mut pocketjs_core::Ui,
        op: u16,
        _: &[pocket_runtime::OpArg<'_>],
    ) -> Result<pocket_runtime::OpResult, RuntimeError> {
        use pocketjs_core::spec;
        Ok(match op {
            39 => pocket_runtime::OpResult::Bytes(
                br#"{"apps":[],"current":"fixture","resume":null}"#.to_vec(),
            ),
            _ => pocket_runtime::OpResult::Integer(i64::from(*self.shot.get_or_insert_with(|| {
                ui.upload_texture_flags(&[255; 4 * 4 * 4], 4, 4, spec::psm::PSM_8888, spec::img::FLAG_LINEAR)
            }))),
        })
    }
}
#[test]
fn a_program_provider_answers_operations_the_library_leaves_and_names_the_data_directory() {
    unsafe {
        let p = Program::unbooted();
        assert_eq!(p.call(|r| r.add_provider(Box::new(ProgramOps { shot: None }))), 0);
        // An operation two providers support is refused.
        assert_ne!(p.call(|r| r.add_provider(Box::new(instance::Services))), 0);
        assert_eq!(
            p.call(|r| r.set_package_source(Box::new(pocket_package::source::MemorySource(package(b"globalThis.frame=function(){};", PLAN))))),
            0
        );
        assert_eq!(p.call(Runtime::boot_deferred), 0, "{}", p.guest.error());
        p.assert_js(r#"if(JSON.parse(ui.appTable()).current!=='fixture'||typeof ui.appLaunch!=='undefined'||typeof ui.appClose!=='undefined')throw Error('program ops');const shot=ui.appShot();if(shot<0||ui.appShot()!==shot)throw Error('shot texture');"#);
        fs_ops::NAME.with(|name| assert_eq!(*name.borrow(), "fixture-data"));
    }
}
unsafe extern "C" fn js_program_answer(ctx: *mut JSContext, _: JSValue, _: i32, _: *mut JSValue) -> JSValue {
    JS_NewInt32(ctx, 42)
}
/// What a program crate installs through `frame::Program::globals`
/// (`Runtime::boot`): the hook runs once, after the generated bindings
/// created `ui` and the library mounted its namespaces, and the bundle reads
/// what it installed when it evaluates.
#[test]
fn a_program_installs_native_globals_the_bundle_reads_when_it_evaluates() {
    unsafe {
        let p = Program::unbooted();
        assert_eq!(
            p.call(|r| r.set_package_source(Box::new(pocket_package::source::MemorySource(package(
                br#"if(program.answer()!==42||program.sawUi!==true||program.sawAudio!==true)throw Error('program globals');globalThis.frame=function(){};"#,
                PLAN
            ))))),
            0
        );
        let mut calls = 0;
        let status = p.guest.with_globals(
            &mut |ctx, global| {
                calls += 1;
                let program = JS_NewObject(ctx);
                for (name, key) in [(c"sawUi", c"ui"), (c"sawAudio", c"audio")] {
                    let value = JS_GetPropertyStr(ctx, global, key.as_ptr());
                    JS_SetPropertyStr(ctx, program, name.as_ptr(), JS_NewBool(ctx, JS_IsObject(value)));
                    JS_FreeValue(ctx, value);
                }
                service_bindings::add_fn(ctx, program, b"answer\0", js_program_answer, 0);
                JS_SetPropertyStr(ctx, global, c"program".as_ptr(), program);
            },
            || p.call(Runtime::boot_deferred),
        );
        assert_eq!(status, 0, "{}", p.guest.error());
        assert_eq!(calls, 1);
        p.assert_js("if(program.answer()!==42)throw Error('program global after boot')");
    }
}
#[test]
fn canonical_turns_preserve_input_and_wait_before_retiring() {
    unsafe {
        let p=Program::new(br#"globalThis.frames=0;globalThis.frame=function(buttons,analog,touches,hits,right,axes,motion,surfaces){frames++;if(buttons!==123||analog!==0x1234||touches.length!==0||hits.length!==0)throw Error('input');globalThis.seen=frames;};"#);
        p.input.borrow_mut().buttons = 123;
        p.input.borrow_mut().analog = 0x1234;
        assert_eq!(
            p.call(|r| r.advance_with_core_ticks(3)),
            0,
            "{}",
            p.guest.error()
        );
        p.assert_js("if(seen!==1)throw Error('duplicate guest turn')");
        assert_eq!(p.call(Runtime::advance), POCKET_STATUS_INVALID);
        // The GE driver is Deferred: present returns after the kick, and the
        // list stays in flight through the next guest turn.
        assert_eq!(p.call(Runtime::present), 0);
        assert_eq!(&*p.events.borrow(), &["render"]);
        assert_eq!(p.call(Runtime::advance), 0, "{}", p.guest.error());
        // The next present syncs, swaps and retires that list before it kicks
        // its own; complete_presentation finishes the frame still in flight.
        assert_eq!(p.call(Runtime::present), 0);
        assert_eq!(
            &*p.events.borrow(),
            &[
                "render",
                "wait",
                "flush",
                "display-wait",
                "retire",
                "render"
            ]
        );
        assert_eq!(p.call(Runtime::complete_presentation), 0);
        assert_eq!(
            &*p.events.borrow(),
            &[
                "render",
                "wait",
                "flush",
                "display-wait",
                "retire",
                "render",
                "wait",
                "flush",
                "display-wait",
                "retire"
            ]
        );
    }
}
#[test]
fn original_package_facts_are_admitted_before_guest_initialization() {
    unsafe {
        let mut p = Program::unbooted();
        let package = package(
            br#"globalThis.frame=function(){};if(typeof ui.physicsCreate!=='function')throw Error('plan lost');"#,
            br#"{"animation":"composited","profile":{"tickHz":60},"viewport":{"logical":[480,272],"presentation":"native","rasterDensity":1},"features":{"ui.physics":true}}"#,
        );
        assert_eq!(
            p.call(|r| r.set_package_source(Box::new(pocket_package::source::MemorySource(package)))),
            0
        );
        assert_eq!(p.call(Runtime::boot_deferred), 0, "{}", p.guest.error());
        assert_eq!(p.call(Runtime::skip_presentation), 0);
        p.assert_js("globalThis.saved=ui.createNode");
        drop(p.runtime.take());
        p.assert_js("let failed=false;try{saved(0)}catch(e){failed=true}if(!failed)throw Error('stale binding active')");
    }
}
#[test]
fn malformed_package_never_runs_guest_or_submits_gpu() {
    unsafe {
        let p = Program::unbooted();
        let mut package = package(
            b"globalThis.started=true;globalThis.frame=function(){}",
            PLAN,
        );
        *package.last_mut().unwrap() ^= 1;
        assert_eq!(
            p.call(|r| r.set_package_source(Box::new(pocket_package::source::MemorySource(package)))),
            0
        );
        assert_ne!(p.call(Runtime::boot_deferred), 0);
        p.assert_js("if(typeof started!=='undefined'||typeof ui!=='undefined')throw Error('ran before admission')");
        assert!(p.events.borrow().is_empty());
    }
}

#[test]
fn packages_the_profile_facts_do_not_satisfy_are_refused_before_the_guest_runs() {
    unsafe {
        let p = Program::unbooted();
        let identity =
            pocket_package::embedded::identity("fixture", "psp.fixture", "Fixture").unwrap();
        let mut other = profile::PROFILE_HASH;
        other[0] ^= 1;
        let package = pocket_package::embedded::encode(pocket_package::embedded::EmbeddedPackage {
            host_abi: profile::HOST_ABI,
            profile_hash: other,
            identity: &identity,
            plan: br#"{"animation":"composited","profile":{"tickHz":60},"viewport":{"logical":[480,272],"presentation":"native","rasterDensity":1},"features":{"net.http":true}}"#,
            code: b"globalThis.started=true;globalThis.frame=function(){}",
            pak: &[],
        })
        .unwrap();
        assert_eq!(
            p.call(|r| r.set_package_source(Box::new(pocket_package::source::MemorySource(package)))),
            0
        );
        assert_ne!(p.call(Runtime::boot_deferred), 0);
        p.assert_js("if(typeof started!=='undefined')throw Error('ran before admission')");
    }
}
