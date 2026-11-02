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
/// A compiled package for the exported profile, as tools/psp.ts embeds one.
fn package(code: &[u8], plan: &[u8]) -> Vec<u8> {
    let identity = pocket_package::embedded::identity("fixture", "psp.fixture", "Fixture").unwrap();
    pocket_package::embedded::encode(pocket_package::embedded::EmbeddedPackage {
        target: profile::ID,
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
    unsafe fn new(code: &[u8]) -> Self {
        let p = Self::unbooted();
        assert_eq!(
            {
                assert_eq!(
                    embed::set_package_source(
                        p.runtime,
                        Box::new(pocket_package::source::MemorySource(package(code, PLAN)))
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
        let runtime = embed::create(pocket_runtime::RuntimeConfig {
            profile_hash: profile::PROFILE_HASH,
            host_abi: profile::HOST_ABI,
            heap_limit: 128 << 20,
            frame_buffer_budget: 1,
            profile: profile::profile().unwrap(),
        })
        .unwrap();
        let ops = embed::op_context(runtime).unwrap();
        ops.add_provider(Box::new(instance::Services)).unwrap();
        let guest = instance::Guest::new(ops, Some(20)).unwrap();
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
    pub unsafe fn register_fs(_: *mut libquickjs_sys::JSContext, _: libquickjs_sys::JSValue) {}
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
#[path = "../../../../programs/psp/src/media_wire.rs"]
mod media_wire;
mod media {
    thread_local! {pub static CALLS: std::cell::RefCell<Vec<String>> = std::cell::RefCell::new(Vec::new());}
    fn note(call: String) {
        CALLS.with(|calls| calls.borrow_mut().push(call));
    }
    pub fn open(token: &[u8]) -> bool {
        note(format!("open {}", String::from_utf8_lossy(token)));
        token.len() == 64
    }
    pub fn close() {
        note("close".into());
    }
    pub fn set_paused(value: bool) {
        note(format!("paused {value}"));
    }
    pub fn set_volume(value: f32) {
        note(format!("volume {value}"));
    }
    pub fn texture(_: &mut pocketjs_core::Ui) -> i32 {
        5
    }
    pub fn status() -> String {
        "{\"phase\":\"idle\",\"h264\":false}".into()
    }
}
mod link {
    pub fn start(target: &str) {
        assert_eq!(target, crate::profile::ID);
    }
    pub fn link_status() -> String {
        "{\"state\":\"searching\"}".into()
    }
}

#[test]
fn public_namespace_providers_and_private_extensions_share_one_runtime() {
    unsafe {
        let p=Program::new(r#"globalThis.frame=function(){};globalThis.node=ui.createNode(1);if(ui.__host!=='psp'||ui.__hostAbi!==EXPECTED_BINDING||ui.__tickHz!==60||__simHz!==20||ui.__viewport.w!==480)throw Error('metadata');if(!ui.__textures||!ui.__sprites)throw Error('assets');if(typeof ui.appTable!=='undefined'||typeof ui.physicsCreate!=='undefined')throw Error('missing provider');if(!ui.svcOpen('fixture')||ui.svcPoll()!=='reply'||ui.videoTick()!==7)throw Error('provider');if(ui.__dbgActive()!==false||audio.createStream(44100,2)!==1||offload.session()!==7)throw Error('private namespace');"#.replace("EXPECTED_BINDING", &pocket_spec::BINDING_GENERATION.to_string()).as_bytes());
        p.assert_js("if(node<=0)throw Error('core');let b=new Uint8Array([1,2,3,4,5,6]);if(audio.writePcm(1,b.subarray(1,5))!==2)throw Error('audio view');");
        p.assert_js(r#"const token='ab'.repeat(32);if(!media.open('127.0.0.1',9000,token)||media.texture()!==5||JSON.parse(media.status()).h264!==false)throw Error('media');media.paused(true);media.volume(0.5);media.close();"#);
        media::CALLS.with(|calls| {
            assert_eq!(*calls.borrow(), [format!("open {}", "ab".repeat(32)), "paused true".into(), "volume 0.5".into(), "close".into()])
        });
        p.assert_js(r#"if(typeof net!=='undefined')throw Error('net namespace');if(link.status()!=='{"state":"searching"}'||link.pair('x')!==false||link.catalog()!==-1)throw Error('link');"#);
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
        // The GE driver is Deferred: present returns after the kick, and the
        // list stays in flight through the next guest turn.
        assert_eq!(embed::present(p.runtime), 0);
        assert_eq!(&*p.events.borrow(), &["render"]);
        assert_eq!(embed::advance(p.runtime), 0, "{}", p.guest.error());
        // The next present syncs, swaps and retires that list before it kicks
        // its own; complete_presentation finishes the frame still in flight.
        assert_eq!(embed::present(p.runtime), 0);
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
        assert_eq!(embed::complete_presentation(p.runtime), 0);
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
        let mut package = package(
            b"globalThis.started=true;globalThis.frame=function(){}",
            PLAN,
        );
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
fn packages_the_profile_facts_do_not_satisfy_are_refused_before_the_guest_runs() {
    unsafe {
        let p = Program::unbooted();
        let identity =
            pocket_package::embedded::identity("fixture", "psp.fixture", "Fixture").unwrap();
        let mut other = profile::PROFILE_HASH;
        other[0] ^= 1;
        let package = pocket_package::embedded::encode(pocket_package::embedded::EmbeddedPackage {
            target: profile::ID,
            host_abi: profile::HOST_ABI,
            profile_hash: other,
            identity: &identity,
            plan: br#"{"animation":"composited","profile":{"tickHz":60},"viewport":{"logical":[480,272],"presentation":"native","rasterDensity":1},"features":{"net.http":true}}"#,
            code: b"globalThis.started=true;globalThis.frame=function(){}",
            pak: &[],
        })
        .unwrap();
        assert_eq!(
            embed::set_package_source(
                p.runtime,
                Box::new(pocket_package::source::MemorySource(package))
            ),
            0
        );
        assert_ne!(embed::boot_deferred(p.runtime), 0);
        p.assert_js("if(typeof started!=='undefined')throw Error('ran before admission')");
    }
}

/// Vectors from the companion's encoders (tools/media-stream.ts
/// createPal8Encoder, contracts/spec/media-adpcm.ts encodeMediaAudio), and the
/// PCM the 3DS's decoder (platforms/3ds/media_adpcm.h) gives for the block.
#[test]
fn media_wire_reads_what_the_companion_encodes() {
    let mut state = media_wire::Pal8::new();
    let mut reference = [9u8; 8];
    let first = [4, 0, 2, 0, 3, 0, 0, 0, 0, 0, 0, 248, 224, 7, 1, 7, 1, 2, 0, 1, 1, 2, 2];
    assert!(!media_wire::pal8_apply(&mut media_wire::Pal8::new(), &mut reference, &[4, 0, 2, 0, 0, 0, 0, 0, 8, 0]));
    reference = [0; 8];
    assert!(media_wire::pal8_apply(&mut state, &mut reference, &first));
    assert_eq!(reference, [0, 1, 2, 0, 1, 1, 2, 2]);
    assert_eq!(&state.clut[..12], &[0, 0, 0, 255, 255, 0, 0, 255, 0, 255, 0, 255]);
    assert!(media_wire::pal8_apply(&mut state, &mut reference, &[4, 0, 2, 0, 0, 0, 0, 0, 5, 1, 0, 2, 0]));
    assert_eq!(reference, [0, 1, 2, 0, 1, 0, 2, 2]);
    // A run past the picture, or a size change mid-stream, stops the stream.
    assert!(!media_wire::pal8_apply(&mut state, &mut reference, &[4, 0, 2, 0, 0, 0, 0, 0, 9, 0]));
    assert!(!media_wire::pal8_apply(&mut state, &mut reference, &[2, 0, 2, 0, 0, 0, 0, 0, 4, 0]));

    let block = [0, 0, 10, 0, 72, 244, 20, 0, 119, 119, 119, 119, 103, 25, 47, 31, 12, 0, 145];
    let mut pcm = [0i16; media_wire::AUDIO_FRAMES * 2];
    assert_eq!(media_wire::decode_audio(&block, &mut pcm), 12);
    assert_eq!(
        &pcm[..24],
        &[0, -3000, 34, -2907, 110, -2708, 275, -2278, 630, -1353, 1395, 369, 1067, 1072, -425, 2138, -3624, 2720, -7741, 2896, -7188, 3056, -5679, 2620]
    );
    let mut bad = block;
    bad[3] = 1;
    assert_eq!(media_wire::decode_audio(&bad, &mut pcm), 0);

    // The picture in the 512-wide plane, its last column and row repeated.
    let mut plane = vec![7u8; media_wire::WIDTH * media_wire::HEIGHT];
    media_wire::expand(&reference, 4, 2, &mut plane);
    assert_eq!(&plane[..5], &[0, 1, 2, 0, 0]);
    assert_eq!(&plane[512..517], &[1, 0, 2, 2, 2]);
    assert_eq!(&plane[1024..1029], &[1, 0, 2, 2, 2]);
    assert_eq!(plane[1029], 7);
}

#[test]
fn media_wire_checks_headers_and_packets() {
    let mut header = [0u8; media_wire::HEADER_BYTES];
    for (at, value) in [(0usize, 0x564d4b50u32), (16, 22050), (24, 1500), (28, 60_000)] {
        header[at..at + 4].copy_from_slice(&value.to_le_bytes());
    }
    for (at, value) in [(4usize, 1u16), (6, 32), (8, 512), (10, 256), (12, 12), (14, 2), (20, 2), (22, 2)] {
        header[at..at + 2].copy_from_slice(&value.to_le_bytes());
    }
    let parsed = media_wire::header(&header).expect("valid header");
    assert_eq!((parsed.fps, parsed.codec, parsed.origin_ms, parsed.duration_ms), (12, media_wire::CODEC_PAL8, 1500, 60_000));
    header[12] = 0;
    assert!(media_wire::header(&header).is_none());
    let packet = |kind: u8, size: u32| {
        let mut p = [0u8; media_wire::PACKET_HEADER_BYTES];
        p[0] = kind;
        p[4..8].copy_from_slice(&size.to_le_bytes());
        p[8..12].copy_from_slice(&40u32.to_le_bytes());
        p
    };
    assert_eq!(media_wire::packet(&packet(1, 100)), Some((1, 100, 40)));
    assert_eq!(media_wire::packet(&packet(2, 1031)), Some((2, 1031, 40)));
    assert_eq!(media_wire::packet(&packet(2, 1032)), None);
    assert_eq!(media_wire::packet(&packet(3, 1)), None);
    assert_eq!(media_wire::packet(&packet(5, 0)), None);
}
