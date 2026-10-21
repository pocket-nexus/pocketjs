#![cfg(test)]
#![allow(dead_code, unused_unsafe)]
// Compile the production composition/extension code. Only device services are
// substituted; QuickJS, generated bindings, runtime and core are real.
#[path = "../../../../hosts/vita/src/ffi.rs"]
mod ffi;
#[path = "../../../../hosts/vita/src/instance.rs"]
mod instance;
#[path = "../../../../hosts/vita/src/registered_renderer.rs"]
mod registered_renderer;
mod renderer_drop;
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
            960,
            544,
            PixelFormat::Rgba8888,
            960 * 4,
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
            instance::boot_package(p.runtime, instance::package(code, &[]).unwrap()),
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
        config.host_abi = 2;
        config.tick_hz = 60;
        config.heap_limit = 128 << 20;
        config.frame_buffer_budget = 1;
        config.profile_json = profile.as_ptr();
        config.profile_json_length = profile.len();
        let runtime = pocket_runtime_cabi::pocket_runtime_create(&config);
        assert!(!runtime.is_null());
        let ops = embed::op_context(runtime).unwrap();
        ops.add_provider(Box::new(instance::Services)).unwrap();
        let guest = instance::Guest::new(ops).unwrap();
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

fn original_package(target: &str, abi: u32, plan: &[u8]) -> Vec<u8> {
    let identity =
        pocket_package::embedded::identity("fixture", "vita.original", "Original plan").unwrap();
    pocket_package::embedded::encode(pocket_package::embedded::EmbeddedPackage {
        target,
        host_abi: abi,
        profile_hash: pocket_package::sha256::sha256(&instance::profile().unwrap()),
        identity: &identity,
        plan,
        code: br#"globalThis.started=true;globalThis.frame=function(){};if(typeof ui.physicsCreate!=='function')throw Error('original feature lost');"#,
        pak: &[],
    }).unwrap()
}

const ORIGINAL_PLAN: &[u8] =
    br#"{"viewport":{"logical":[480,272],"rasterDensity":2},"features":{"ui.physics":true}}"#;

#[test]
fn original_package_plan_controls_generated_capability_namespaces() {
    unsafe {
        let p = Program::unbooted();
        let package = std::sync::Arc::<[u8]>::from(original_package("vita", 2, ORIGINAL_PLAN));
        assert_eq!(
            instance::boot_package(p.runtime, package.clone()),
            0,
            "{}",
            p.guest.error()
        );
        drop(package);
        assert_eq!(embed::skip_presentation(p.runtime), 0);
        p.assert_js("if(!started||typeof ui.physicsCreate!=='function')throw Error('original plan or lifetime lost')");
        assert!(p.events.borrow().is_empty());
    }
}

#[test]
fn original_package_admission_rejects_invalid_facts_before_guest_evaluation() {
    let mut corrupt = original_package("vita", 2, ORIGINAL_PLAN);
    *corrupt.last_mut().unwrap() ^= 1;
    let mut wrong_profile = original_package("vita", 2, ORIGINAL_PLAN);
    wrong_profile[64] ^= 1; // variant starts at 32; profile hash is its offset 32.
    let end = wrong_profile.len() - 8;
    let hash = pocket_package::package::fnv1a64(&[&wrong_profile[..end]]);
    wrong_profile[end..].copy_from_slice(&hash.to_le_bytes());
    for (reason, package) in [
        ("profile", wrong_profile),
        ("footer", corrupt),
        ("ABI", original_package("vita", 99, ORIGINAL_PLAN)),
        ("target", original_package("psp", 2, ORIGINAL_PLAN)),
        (
            "viewport",
            original_package(
                "vita",
                2,
                br#"{"viewport":{"logical":[240,136],"rasterDensity":2}}"#,
            ),
        ),
        (
            "density",
            original_package(
                "vita",
                2,
                br#"{"viewport":{"logical":[480,272],"rasterDensity":1}}"#,
            ),
        ),
        ("plan", original_package("vita", 2, b"{}")),
    ] {
        unsafe {
            let p = Program::unbooted();
            assert_ne!(
                instance::boot_package(p.runtime, package),
                0,
                "accepted {reason}"
            );
            p.assert_js("if(typeof started!=='undefined'||typeof ui!=='undefined')throw Error('guest ran before admission')");
            assert!(
                p.events.borrow().is_empty(),
                "submitted GPU work for {reason}"
            );
        }
    }
}
#[test]
fn production_instance_uses_generated_ops_and_keeps_native_extensions() {
    unsafe {
        let p=Program::new(br#"globalThis.frame=function(){};globalThis.node=ui.createNode(1);if(ui.__host!=='vita'||ui.__hostAbi!==2||ui.__tickHz!==60||ui.__viewport.w!==480)throw Error('metadata');if(!ui.__textures||!ui.__sprites)throw Error('assets');if(typeof ui.appTable!=='undefined'||typeof ui.physicsCreate!=='undefined')throw Error('missing services');if(!ui.svcOpen('fixture')||ui.svcPoll()!=='reply'||ui.videoTick()!==7)throw Error('provider');if(ui.__dbgActive()!==false)throw Error('native extension');"#);
        assert!(p.guest.ops.core().unwrap().ui.viewport().0 == 480.0);
        p.assert_js("if(node<=0)throw Error('core dispatch')");
    }
}
#[test]
fn sampled_input_and_native_overlay_run_before_terminal_wait() {
    unsafe {
        let p=Program::new(br#"globalThis.frames=0;globalThis.frame=function(buttons,analog,touches,hits,surfaces){frames++;if(buttons!==123||analog!==0x2040||touches.length!==1||((touches[0]&511)!==42)||((touches[0]>>9&511)!==23)||hits.length!==1||surfaces[0]!==0)throw Error('input');};"#);
        {
            let mut i = p.input.borrow_mut();
            i.buttons = 123;
            i.analog = 0x2040;
            i.contacts.push(Contact {
                surface: 0,
                id: 7,
                x: 42.,
                y: 23.,
                cancelled: false,
            });
        }
        assert_eq!(embed::advance(p.runtime), 0, "{}", p.guest.error());
        assert_ne!(embed::advance(p.runtime), 0);
        assert_eq!(
            embed::present_with_overlay(p.runtime, |_| p.events.borrow_mut().push("overlay")),
            0
        );
        assert_eq!(
            &*p.events.borrow(),
            &[
                "render",
                "overlay",
                "wait",
                "flush",
                "display-wait",
                "retire"
            ]
        );
        p.assert_js("if(frames!==1)throw Error('duplicate guest turn')");
    }
}
#[test]
fn independent_c_handles_do_not_share_ui_or_borrow_across_coercion() {
    unsafe {
        let a = Program::new(br#"globalThis.frame=function(){};globalThis.node=ui.createNode(1);"#);
        let b = Program::new(
            br#"globalThis.frame=function(){};globalThis.node=ui.createNode(1);ui.createNode(1);"#,
        );
        a.assert_js("if(ui.createNode(1)!==node+1)throw Error('shared ui');ui.setProp({valueOf(){ui.createNode(1);return node}},0,1);");
        b.assert_js("if(ui.createNode(1)!==node+2)throw Error('shared ui');");
        drop(a);
        assert_eq!(embed::advance(b.runtime), 0, "{}", b.guest.error());
        assert_eq!(embed::present(b.runtime), 0);
    }
}
