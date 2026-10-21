#![cfg(test)]
#![allow(dead_code, unused_unsafe)]
extern crate alloc;
// Compile the production composition/extension code. Only device services are
// substituted; QuickJS, generated bindings, runtime and core are real.
#[path = "../../../../programs/psp/src/service_bindings.rs"]
mod service_bindings;
#[path = "../../../../programs/psp/src/instance.rs"]
mod instance;
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
mod switch {
    pub fn multi() -> bool {
        false
    }
    pub fn upload_shot(_: &mut pocketjs_core::Ui) {}
    pub fn table_json() -> String {
        "{}".into()
    }
    pub fn find(_: &str) -> Option<usize> {
        None
    }
    pub fn request_launch(_: usize) {}
    pub fn shot_handle() -> i32 {
        -1
    }
}
use libquickjs_sys::*;
use pocket_drivers::*;
use pocket_runtime_cabi::{abi::*, embedding as embed};
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
    runtime: *mut PocketRuntime,
    guest: Box<instance::Guest>,
    input: Rc<RefCell<instance::Input>>,
    events: Rc<RefCell<Vec<&'static str>>>,
}
impl Drop for Program {
    fn drop(&mut self) {
        unsafe {
            pocket_runtime_cabi::pocket_runtime_destroy(self.runtime);
        }
    }
}
impl Program {
    unsafe fn new(code: &[u8]) -> Self {
        let p = Self::unbooted();
        assert_eq!(
            {
                assert_eq!(
                    embed::set_package_source(
                        p.runtime,
                        Box::new(pocket_package::source::MemorySource(
                            instance::package(code, &[], None).unwrap()
                        ))
                    ),
                    0
                );
                embed::boot_deferred(p.runtime)
            },
            0,
            "{}",
            p.guest.error()
        );
        assert!(p.events.borrow().is_empty());
        assert_eq!(embed::skip_presentation(p.runtime), 0);
        p
    }
    unsafe fn unbooted() -> Self {
        let profile = instance::profile().unwrap();
        let mut config = PocketRuntimeConfig::empty();
        config.profile_hash = pocket_package::sha256::sha256(&profile);
        config.host_abi = pocket_spec::BINDING_GENERATION;
        config.tick_hz = 60;
        config.heap_limit = 128 << 20;
        config.frame_buffer_budget = 1;
        config.profile_json = profile.as_ptr();
        config.profile_json_length = profile.len();
        let runtime = pocket_runtime_cabi::pocket_runtime_create(&config);
        assert!(!runtime.is_null());
        let ops = embed::op_context(runtime).unwrap();
        ops.add_provider(Box::new(instance::Services)).unwrap();
        let guest = instance::Guest::new(ops, 20).unwrap();
        let input = Rc::new(RefCell::new(instance::Input {
            analog: 0x8080,
            ..Default::default()
        }));
        let events = Rc::new(RefCell::new(Vec::new()));
        let mut p = Self {
            runtime,
            guest,
            input,
            events,
        };
        let renderer = embed::add_renderer(runtime, Render(p.events.clone())).unwrap();
        assert_eq!(
            embed::add_display(runtime, Display(p.events.clone()), renderer),
            0
        );
        assert_eq!(
            embed::add_input_source(runtime, Box::new(instance::InputDriver(p.input.clone()))),
            0
        );
        assert_eq!(
            pocket_runtime_cabi::pocket_runtime_set_guest(
                runtime,
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
    pub unsafe fn play(_: i32) {}
    pub unsafe fn pause(_: i32) {}
    pub unsafe fn stop(_: i32) {}
    pub unsafe fn set_volume(_: i32, _: f64) {}
    pub unsafe fn end_stream(_: i32) {}
    pub unsafe fn poll() -> Option<String> {
        None
    }
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
        audio_mod::PCM.with(|pcm| assert_eq!(&*pcm.borrow(), &[0x302, 0x504]));
        assert_eq!(host::MASKED.load(std::sync::atomic::Ordering::Relaxed), 0);
    }
}
#[test]
fn canonical_turns_preserve_input_and_wait_before_retiring() {
    unsafe {
        let p=Program::new(br#"globalThis.frames=0;globalThis.frame=function(buttons,analog,touches,hits,right,axes,motion,surfaces){frames++;if(buttons!==123||analog!==0x1234||touches.length!==0||hits.length!==0)throw Error('input');globalThis.seen=frames;};"#);
        p.input.borrow_mut().buttons = 123;
        p.input.borrow_mut().analog = 0x1234;
        assert_eq!(
            embed::advance_with_core_ticks(p.runtime, 3),
            0,
            "{}",
            p.guest.error()
        );
        p.assert_js("if(seen!==1)throw Error('duplicate guest turn')");
        assert_eq!(embed::advance(p.runtime), POCKET_STATUS_INVALID);
        assert_eq!(embed::present(p.runtime), 0);
        assert_eq!(
            &*p.events.borrow(),
            &["render", "wait", "flush", "display-wait", "retire"]
        );
    }
}
#[test]
fn original_package_facts_are_admitted_before_guest_initialization() {
    unsafe {
        let mut p = Program::unbooted();
        let identity =
            pocket_package::embedded::identity("original", "psp.fixture", "Fixture").unwrap();
        let package=pocket_package::embedded::encode(pocket_package::embedded::EmbeddedPackage{target:"psp",host_abi:pocket_spec::BINDING_GENERATION,profile_hash:pocket_package::sha256::sha256(&instance::profile().unwrap()),identity:&identity,plan:br#"{"viewport":{"logical":[480,272],"rasterDensity":1},"features":{"ui.physics":true}}"#,code:br#"globalThis.frame=function(){};if(typeof ui.physicsCreate!=='function')throw Error('plan lost');"#,pak:&[]}).unwrap();
        assert_eq!(
            embed::set_package_source(
                p.runtime,
                Box::new(pocket_package::source::MemorySource(package))
            ),
            0
        );
        assert_eq!(embed::boot_deferred(p.runtime), 0, "{}", p.guest.error());
        assert_eq!(embed::skip_presentation(p.runtime), 0);
        p.assert_js("globalThis.saved=ui.createNode");
        pocket_runtime_cabi::pocket_runtime_destroy(p.runtime);
        p.runtime = std::ptr::null_mut();
        p.assert_js("let failed=false;try{saved(0)}catch(e){failed=true}if(!failed)throw Error('stale binding active')");
    }
}
#[test]
fn malformed_package_never_runs_guest_or_submits_gpu() {
    unsafe {
        let p = Program::unbooted();
        let mut package = instance::package(
            b"globalThis.started=true;globalThis.frame=function(){}",
            &[],
            None,
        )
        .unwrap();
        *package.last_mut().unwrap() ^= 1;
        assert_eq!(
            embed::set_package_source(
                p.runtime,
                Box::new(pocket_package::source::MemorySource(package))
            ),
            0
        );
        assert_ne!(embed::boot_deferred(p.runtime), 0);
        p.assert_js("if(typeof started!=='undefined'||typeof ui!=='undefined')throw Error('ran before admission')");
        assert!(p.events.borrow().is_empty());
    }
}

#[test]
fn resolved_plan_embedding_retains_feature_and_identity_facts() {
    unsafe {
        let p = Program::unbooted();
        let plan = br#"{"app":{"output":"planned","id":"dev.fixture","title":"Plan"},"viewport":{"logical":[480,272],"rasterDensity":1},"features":{"ui.physics":true}}"#;
        let package = instance::package(br#"globalThis.frame=function(){};if(typeof ui.physicsCreate!=='function')throw Error('plan feature lost');"#, &[], Some(plan)).unwrap();
        assert_eq!(
            embed::set_package_source(
                p.runtime,
                Box::new(pocket_package::source::MemorySource(package))
            ),
            0
        );
        assert_eq!(embed::boot_deferred(p.runtime), 0, "{}", p.guest.error());
    }
}
