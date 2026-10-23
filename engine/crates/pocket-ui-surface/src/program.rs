//! A native program composition over the shared runtime. Raw JS/pak inputs
//! enter the ordinary package reader through its embedded-package adapter.
use std::{cell::RefCell, rc::Rc};

use anyhow::{Result, anyhow};
use pocket_drivers::{
    DisplayOutput, InputClasses, InputFrameBuilder, InputSource, Renderer,
};
use pocket_mod::{Guest, qjs::CatchResultExt};
use pocket_package::source::MemorySource;
use pocket_runtime::{
    Cow, GuestEnvironment, GuestFrame, OpContext, Profile, Runtime, RuntimeConfig, RuntimeError,
};
use serde_json::json;

use crate::UiSurface;

pub struct ProgramConfig {
    /// The profile the program was built for: `profile()` from the module
    /// `pocket profile export` wrote, or [`embedded_profile`] for a library
    /// embedding. Its id, tick rate and raster density describe the package
    /// [`UiProgram::boot`] encodes.
    pub profile: Profile,
    /// `PROFILE_HASH` from the same export; the encoded package carries it.
    pub profile_hash: [u8; 32],
    pub host_abi: u32,
    /// The logical viewport this embedding presents. The profile must list it
    /// or, for a window profile, contain it in its dynamic range.
    pub logical: [u32; 2],
    pub heap_limit: usize,
    pub frame_buffer_budget: usize,
}

/// The profile of a library embedding that has no `pocket build` export, such
/// as an overlay, a widget screen or a test: id `host`, one `logical` viewport
/// at raster `density`, no auxiliary display and no required input class. The
/// returned hash is all zero. Such an embedding has no exported identity: it
/// runs only the package [`UiProgram::boot`] encodes from the host's own
/// JavaScript and pak, and no compiled `.pocket` carries that hash.
pub fn embedded_profile(
    host: &str,
    logical: [u32; 2],
    density: u32,
    tick_hz: u32,
) -> (Profile, [u8; 32]) {
    let profile = Profile {
        id: Cow::Owned(host.to_owned()),
        tick_hz,
        viewport: [
            logical[0].saturating_mul(density),
            logical[1].saturating_mul(density),
        ],
        logical_viewports: Cow::Owned(vec![logical]),
        dynamic_viewport: None,
        auxiliary: None,
        auxiliary_logical: Cow::Borrowed(&[]),
        density,
        required_inputs: InputClasses::NONE,
    };
    (profile, [0; 32])
}

/// One runtime, one generated UI namespace, and one input snapshot. Hosts
/// register their real renderer/display before boot and publish device facts
/// before advance; the runtime resolves contact capture and drives core time.
pub struct UiProgram {
    runtime: Runtime,
    surface: UiSurface,
    input: Rc<RefCell<InputFrameBuilder>>,
    config: OwnedConfig,
}
struct OwnedConfig {
    host: String,
    host_abi: u32,
    profile_hash: [u8; 32],
    logical: [u32; 2],
    density: u32,
    tick_hz: u32,
}
impl UiProgram {
    pub fn new(config: ProgramConfig) -> Result<Self> {
        let profile = config.profile;
        anyhow::ensure!(
            profile.admits_viewport(config.logical),
            "profile {} does not admit the logical viewport {}x{}",
            profile.id,
            config.logical[0],
            config.logical[1]
        );
        let owned = OwnedConfig {
            host: profile.id.clone().into_owned(),
            host_abi: config.host_abi,
            profile_hash: config.profile_hash,
            logical: config.logical,
            density: profile.density,
            tick_hz: profile.tick_hz,
        };
        let mut runtime = Runtime::new(RuntimeConfig {
            profile_hash: config.profile_hash,
            host_abi: config.host_abi,
            heap_limit: config.heap_limit,
            frame_buffer_budget: config.frame_buffer_budget,
            profile,
        })
        .host()?;
        runtime.allow_embedded_viewport_changes().host()?;
        runtime.op_context().set_compositor_enabled(true).host()?;
        let surface = UiSurface::from_context(runtime.op_context());
        surface.set_identity(&owned.host, owned.host_abi);
        let input = Rc::new(RefCell::new(InputFrameBuilder::new()));
        runtime
            .add_input_source(Box::new(Input(input.clone())))
            .host()?;
        Ok(Self {
            runtime,
            surface,
            input,
            config: owned,
        })
    }
    pub fn surface(&self) -> UiSurface {
        self.surface.clone()
    }
    /// Driver registration is available only before boot, as enforced by Runtime.
    pub fn runtime_mut(&mut self) -> &mut Runtime {
        &mut self.runtime
    }
    pub fn add_display<D: DisplayOutput + 'static>(
        &mut self,
        display: D,
        renderer: pocket_runtime::RendererId,
    ) -> Result<()>
    where
        D::Token: 'static,
    {
        self.runtime.add_display(display, renderer).host()?;
        Ok(())
    }
    pub fn add_renderer<R: Renderer + 'static>(
        &mut self,
        renderer: R,
    ) -> Result<pocket_runtime::RendererId>
    where
        R::Submission: 'static,
    {
        self.runtime.add_renderer(renderer).host()
    }
    pub fn boot(&mut self, guest: Rc<Guest>, label: &str, source: &str, pak: &[u8]) -> Result<()> {
        let config = &self.config;
        let plan = serde_json::to_vec(&json!({
            "target":{"id":config.host,"hostAbi":config.host_abi},
            "viewport":{"logical":config.logical,"rasterDensity":config.density},
            "tickHz":config.tick_hz,
            "features":{"input.buttons":true,"input.analog.left":true,"input.touch":true,"text.layout.baked":true,"ui.physics":true}
        }))?;
        let identity = pocket_package::embedded::identity(label, label, label)
            .map_err(|error| anyhow!("package identity: {error:?}"))?;
        let bytes = pocket_package::embedded::encode(pocket_package::embedded::EmbeddedPackage {
            target: &config.host,
            host_abi: config.host_abi,
            profile_hash: config.profile_hash,
            identity: &identity,
            plan: &plan,
            code: source.as_bytes(),
            pak,
        })
        .map_err(|error| anyhow!("embedded package: {error:?}"))?;
        self.runtime
            .set_package_source(Box::new(MemorySource(bytes)))
            .host()?;
        self.runtime
            .set_guest(Box::new(NativeGuest {
                guest,
                surface: self.surface.clone(),
            }))
            .host()?;
        self.runtime.boot_deferred().host()?;
        // The program can prepare a GPU scene or e-ink policy before first paint.
        self.runtime.skip_presentation().host()?;
        Ok(())
    }
    pub fn set_input(&self, facts: InputFrameBuilder) {
        *self.input.borrow_mut() = facts;
    }
    pub fn advance(&mut self) -> Result<()> {
        // An idle/throttled display may defer a frame without submitting work.
        self.runtime.skip_presentation().host()?;
        self.runtime.advance().host()?;
        Ok(())
    }
    /// Present and complete the frame. The host composites the published
    /// output after this returns, so a Deferred renderer's frame completes
    /// here rather than at the next present.
    pub fn present(&mut self) -> Result<()> {
        self.runtime.present().host()?;
        self.runtime.complete_presentation().host()?;
        Ok(())
    }
    pub fn resize(&mut self, logical: [u32; 2], physical: [u32; 2]) -> Result<()> {
        self.runtime.resize_embedded(logical, physical).host()?;
        Ok(())
    }
}

struct Input(Rc<RefCell<InputFrameBuilder>>);
impl InputSource for Input {
    fn classes(&self) -> InputClasses {
        InputClasses::BUTTONS | InputClasses::AXIS_ABSOLUTE | InputClasses::CONTACT
    }
    fn poll(&mut self, output: &mut InputFrameBuilder) {
        let input = self.0.borrow();
        output.buttons |= input.buttons;
        output.axes.extend_from_slice(&input.axes);
        output.contacts.extend_from_slice(&input.contacts);
        output.cancelled.extend_from_slice(&input.cancelled);
    }
}
struct NativeGuest {
    guest: Rc<Guest>,
    surface: UiSurface,
}
impl pocket_runtime::Guest for NativeGuest {
    fn initialize(&mut self, _: OpContext, env: &GuestEnvironment<'_>) -> Result<(), RuntimeError> {
        self.guest.set_memory_limit(env.heap_limit);
        self.surface
            .mount_environment(&self.guest, env, true)
            .map_err(|error| {
                log::error!("native UI mount: {error:#}");
                RuntimeError::Guest
            })
    }
    fn evaluate(&mut self, source: &[u8]) -> Result<(), RuntimeError> {
        let source = source.strip_suffix(&[0]).unwrap_or(source);
        self.guest.with(|ctx| {
            ctx.eval::<(), _>(source).catch(&ctx).map_err(|error| {
                log::error!("native guest evaluate: {error}");
                RuntimeError::Guest
            })
        })?;
        self.collect()?;
        if !self.guest.has_frame() {
            return Err(RuntimeError::Guest);
        }
        Ok(())
    }
    fn frame(&mut self, frame: &GuestFrame<'_>) -> Result<(), RuntimeError> {
        self.guest.with(|ctx| {
            pocket_guest_rquickjs::call_frame(&ctx, frame)
                .catch(&ctx)
                .map_err(|error| {
                    log::error!("native guest frame: {error}");
                    RuntimeError::Guest
                })
        })?;
        self.collect()
    }
    fn collect(&mut self) -> Result<(), RuntimeError> {
        self.guest.collect_result().map_err(|error| {
            log::error!("native guest jobs: {error:#}");
            RuntimeError::Guest
        })
    }
}

trait RuntimeResult<T> {
    fn host(self) -> Result<T>;
}
impl<T> RuntimeResult<T> for Result<T, RuntimeError> {
    fn host(self) -> Result<T> {
        self.map_err(|error| anyhow!("runtime: {error:?}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pocket_drivers::*;
    struct Display {
        pixels: Vec<u8>,
        pending: bool,
        count: Rc<RefCell<usize>>,
    }
    impl DisplayOutput for Display {
        type Token = ();
        fn descriptor(&self) -> DisplayDescriptor {
            DisplayDescriptor::new(
                DisplayRole::Primary,
                16,
                16,
                PixelFormat::Rgba8888,
                64,
                TargetOwnership::CpuVisible,
            )
        }
        fn acquire(&mut self, region: Rect) -> Result<Target<'_>, DisplayError> {
            if self.pending || region != Rect::new(0, 0, 16, 16) {
                return Err(DisplayError::InvalidTarget);
            }
            Ok(Target::CpuVisible(Surface::new(
                &mut self.pixels,
                region,
                64,
                PixelFormat::Rgba8888,
            )?))
        }
        fn flush(&mut self, _: &[Rect]) -> Result<(), DisplayError> {
            if self.pending {
                return Err(DisplayError::Failed);
            }
            self.pending = true;
            Ok(())
        }
        fn wait(&mut self, _: ()) -> Result<(), DisplayError> {
            if !self.pending {
                return Err(DisplayError::Failed);
            }
            self.pending = false;
            *self.count.borrow_mut() += 1;
            Ok(())
        }
        fn vsync(&mut self) -> VsyncSource {
            VsyncSource::None
        }
    }
    fn program() -> (UiProgram, Rc<RefCell<usize>>) {
        let (profile, profile_hash) = embedded_profile("native-test", [16, 16], 1, 60);
        program_with_profile(profile, profile_hash)
    }
    fn program_with_profile(
        profile: Profile,
        profile_hash: [u8; 32],
    ) -> (UiProgram, Rc<RefCell<usize>>) {
        let mut program = UiProgram::new(ProgramConfig {
            profile,
            profile_hash,
            host_abi: pocket_spec::BINDING_GENERATION,
            logical: [16, 16],
            heap_limit: 4 * 1024 * 1024,
            frame_buffer_budget: 1024,
        })
        .unwrap();
        let count = Rc::new(RefCell::new(0));
        program
            .add_display(
                Display {
                    pixels: vec![0; 1024],
                    pending: false,
                    count: count.clone(),
                },
                pocket_runtime::RendererId::SOFTWARE,
            )
            .unwrap();
        (program, count)
    }
    #[test]
    fn two_programs_accept_independent_profiles_in_one_binary() {
        // The shape `pocket profile export` writes into pocket_profile.rs.
        let profile = |id: &'static str| Profile {
            id: Cow::Borrowed(id),
            tick_hz: 60,
            viewport: [16, 16],
            logical_viewports: Cow::Borrowed(&[[16, 16]]),
            dynamic_viewport: None,
            auxiliary: None,
            auxiliary_logical: Cow::Borrowed(&[]),
            density: 1,
            required_inputs: InputClasses::BUTTONS | InputClasses::CONTACT,
        };
        let (mut first, first_count) = program_with_profile(profile("first-program"), [1; 32]);
        let (mut second, second_count) = program_with_profile(profile("second-program"), [2; 32]);
        for (program, host) in [
            (&mut first, "first-program"),
            (&mut second, "second-program"),
        ] {
            program.boot(
                Rc::new(Guest::new().unwrap()),
                host,
                &format!("if(ui.__host!=={host:?})throw Error('wrong profile');globalThis.frame=()=>{{}}"),
                &[],
            ).unwrap();
            program.advance().unwrap();
            program.present().unwrap();
        }
        assert_eq!(*first_count.borrow(), 1);
        assert_eq!(*second_count.borrow(), 1);
    }
    #[test]
    fn logical_viewport_outside_the_profile_is_rejected() {
        let config = |logical| {
            let (profile, profile_hash) = embedded_profile("native-test", [16, 16], 1, 60);
            ProgramConfig {
                profile,
                profile_hash,
                host_abi: pocket_spec::BINDING_GENERATION,
                logical,
                heap_limit: 4 * 1024 * 1024,
                frame_buffer_budget: 1024,
            }
        };
        assert!(UiProgram::new(config([16, 16])).is_ok());
        let error = UiProgram::new(config([32, 16])).err().unwrap();
        assert!(error.to_string().contains("does not admit"), "{error}");
    }
    #[test]
    fn full_runtime_mounts_one_context_and_preserves_services_metadata_and_jobs() {
        let (mut program, count) = program();
        let surface = program.surface();
        surface.set_svc_allowlist(["note"]);
        surface.svc_push("hello");
        surface.register_compositor_surface("child").unwrap();
        let guest = Rc::new(Guest::new().unwrap());
        program.boot(guest.clone(),"test",&r#"
            if(ui.__host!=='native-test'||ui.__hostAbi!==EXPECTED_BINDING||ui.__viewport.w!==16||ui.__tickHz!==60) throw Error('metadata');
            if(ui.__surfaces.child!==0||!ui.svcOpen('note')||ui.svcOpen('other')) throw Error('services');
            for (const name of ['physicsCreate','physicsApply','physicsDestroy','physicsEvents','physicsQuery']) {
                if(typeof ui[name]!=='function') throw Error('missing '+name);
            }
            const world=ui.physicsCreate(1,new ArrayBuffer(0));
            if(!world) throw Error('world create failed');
            ui.physicsApply(new ArrayBuffer(0));
            ui.physicsEvents();
            ui.physicsQuery(1,world,0,0,0,0);
            ui.physicsDestroy(world);
            globalThis.node=ui.createNode(1); ui.setText(node,'before');
            globalThis.seen=[];
            globalThis.frame=(buttons,analog,touches,hits)=>{
                seen.push([buttons,analog,touches.length,hits.length]);
                ui.svcSend(ui.svcPoll());
                Promise.resolve().then(()=>ui.replaceText(node,'after'));
            };
        "#.replace("EXPECTED_BINDING", &pocket_spec::BINDING_GENERATION.to_string()),&[]).unwrap();
        for op in 52..=56 {
            assert!(program.runtime_mut().op_context().supports_op(op));
        }
        let mut input = InputFrameBuilder::new();
        input.buttons = 7;
        input.contacts.push(Contact {
            surface: 0,
            id: 13,
            x: 2.,
            y: 3.,
            cancelled: false,
        });
        program.set_input(input);
        program.advance().unwrap();
        program.present().unwrap();
        assert_eq!(*count.borrow(), 1);
        assert_eq!(surface.svc_drain(), ["hello\n"]);
        let node = guest.with(|ctx| ctx.globals().get::<_, i32>("node").unwrap());
        surface.with_ui(|ui| assert_eq!(ui.node_text(node), Some("after")));
        guest
            .eval(
                "assert",
                "if(JSON.stringify(seen)!=='[[7,32896,1,1]]')throw Error(JSON.stringify(seen));",
            )
            .unwrap();
        drop(program);
        assert!(guest.eval("stopped", "ui.setText(node,'stale')").is_err());
    }
    #[test]
    fn guest_failure_stops_future_ticks_and_second_program_stays_independent() {
        let (mut first, _) = program();
        let (mut second, count) = program();
        first
            .boot(
                Rc::new(Guest::new().unwrap()),
                "bad",
                "globalThis.frame=()=>{throw Error('bad')}",
                &[],
            )
            .unwrap();
        let guest = Rc::new(Guest::new().unwrap());
        second
            .boot(
                guest.clone(),
                "good",
                "globalThis.n=0;globalThis.frame=()=>n++",
                &[],
            )
            .unwrap();
        assert!(first.advance().is_err());
        assert!(first.advance().is_err());
        second.advance().unwrap();
        second.present().unwrap();
        assert_eq!(*count.borrow(), 1);
        assert_eq!(
            guest.with(|ctx| ctx.globals().get::<_, u32>("n").unwrap()),
            1
        );
    }
}
