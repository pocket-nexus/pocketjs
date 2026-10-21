//! A native program composition over the shared runtime. Raw JS/pak inputs
//! enter the ordinary package reader through its embedded-package adapter.
use std::{cell::RefCell, rc::Rc};

use anyhow::{Result, anyhow};
use pocket_drivers::{
    DisplayOutput, InputClasses, InputFrameBuilder, InputSource, PackageSource, Renderer,
    SourceError,
};
use pocket_mod::{Guest, qjs::CatchResultExt};
use pocket_runtime::{
    GuestEnvironment, GuestFrame, OpContext, Runtime, RuntimeConfig, RuntimeError,
};
use serde_json::json;

use crate::UiSurface;

pub struct ProgramConfig<'a> {
    /// Independent exported profile, supplied by the program. Raw JS/pak
    /// adapters can use None to describe their explicit local configuration.
    pub profile: Option<pocket_package::profile::BuildProfile<'a>>,
    pub host: &'a str,
    pub host_abi: u32,
    pub logical: [u32; 2],
    pub density: u32,
    pub scale: u32,
    pub tick_hz: u32,
    pub heap_limit: usize,
    pub frame_buffer_budget: usize,
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
    pub fn new(config: ProgramConfig<'_>) -> Result<Self> {
        anyhow::ensure!(
            (1..=4).contains(&config.scale),
            "invalid presentation scale"
        );
        let physical = [
            config.logical[0]
                .checked_mul(config.scale)
                .ok_or_else(|| anyhow!("viewport overflow"))?,
            config.logical[1]
                .checked_mul(config.scale)
                .ok_or_else(|| anyhow!("viewport overflow"))?,
        ];
        let fallback = serde_json::to_vec(&json!({
            "id":config.host,"platform":config.host,"form":"native","tickHz":config.tick_hz,
            "display":{"physicalViewport":physical,"logicalViewports":[config.logical],"rasterDensity":config.density},
            "capabilities":["input.buttons","input.analog.left","input.touch","text.layout.baked","ui.physics"],
            "roleCapabilities":{}
        }))?;
        let (profile, profile_hash) = match config.profile {
            Some(profile) => (profile.json.to_vec(), profile.hash),
            None => {
                let hash = pocket_package::sha256::sha256(&fallback);
                (fallback, hash)
            }
        };
        let mut runtime = Runtime::new(RuntimeConfig {
            profile_hash,
            profile_json: profile,
            host_abi: config.host_abi,
            tick_hz: config.tick_hz,
            heap_limit: config.heap_limit,
            frame_buffer_budget: config.frame_buffer_budget,
        })
        .host()?;
        runtime.allow_embedded_viewport_changes().host()?;
        runtime.op_context().set_compositor_enabled(true).host()?;
        let surface = UiSurface::from_context(runtime.op_context());
        surface.set_identity(config.host, config.host_abi);
        let input = Rc::new(RefCell::new(InputFrameBuilder::new()));
        runtime
            .add_input_source(Box::new(Input(input.clone())))
            .host()?;
        Ok(Self {
            runtime,
            surface,
            input,
            config: OwnedConfig {
                host: config.host.to_owned(),
                host_abi: config.host_abi,
                profile_hash,
                logical: config.logical,
                density: config.density,
                tick_hz: config.tick_hz,
            },
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
            .set_package_source(Box::new(Source(bytes)))
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
    pub fn present(&mut self) -> Result<()> {
        self.runtime.present().host()?;
        Ok(())
    }
    pub fn resize(&mut self, logical: [u32; 2], physical: [u32; 2]) -> Result<()> {
        self.runtime.resize_embedded(logical, physical).host()?;
        Ok(())
    }
}

struct Source(Vec<u8>);
impl PackageSource for Source {
    fn length(&self) -> Result<usize, SourceError> {
        Ok(self.0.len())
    }
    fn all(&mut self) -> Result<&[u8], SourceError> {
        Ok(&self.0)
    }
    fn range(&mut self, offset: usize, output: &mut [u8]) -> Result<usize, SourceError> {
        let src = self.0.get(offset..).ok_or(SourceError::OutOfBounds)?;
        let n = src.len().min(output.len());
        output[..n].copy_from_slice(&src[..n]);
        Ok(n)
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
        program_with_profile("native-test", None)
    }
    fn program_with_profile(
        host: &str,
        profile: Option<pocket_package::profile::BuildProfile<'_>>,
    ) -> (UiProgram, Rc<RefCell<usize>>) {
        let mut program = UiProgram::new(ProgramConfig {
            profile,
            host,
            host_abi: 9,
            logical: [16, 16],
            density: 1,
            scale: 1,
            tick_hz: 60,
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
        let profile = |id| {
            serde_json::to_vec(&json!({
                "id":id,"platform":"native-test","form":"native","tickHz":60,
                "display":{"physicalViewport":[16,16],"logicalViewports":[[16,16]],"rasterDensity":1},
                "capabilities":["input.buttons","input.analog.left","input.touch","text.layout.baked","ui.physics"],
                "roleCapabilities":{}
            })).unwrap()
        };
        let first_json = profile("first-program");
        let second_json = profile("second-program");
        let first_profile = pocket_package::profile::BuildProfile {
            json: &first_json,
            hash: pocket_package::sha256::sha256(&first_json),
        };
        let second_profile = pocket_package::profile::BuildProfile {
            json: &second_json,
            hash: pocket_package::sha256::sha256(&second_json),
        };
        let (mut first, first_count) = program_with_profile("first-program", Some(first_profile));
        let (mut second, second_count) =
            program_with_profile("second-program", Some(second_profile));
        assert_ne!(first.config.profile_hash, second.config.profile_hash);
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
    fn full_runtime_mounts_one_context_and_preserves_services_metadata_and_jobs() {
        let (mut program, count) = program();
        let surface = program.surface();
        surface.set_svc_allowlist(["note"]);
        surface.svc_push("hello");
        surface.register_compositor_surface("child").unwrap();
        let guest = Rc::new(Guest::new().unwrap());
        program.boot(guest.clone(),"test",r#"
            if(ui.__host!=='native-test'||ui.__hostAbi!==9||ui.__viewport.w!==16||ui.__tickHz!==60) throw Error('metadata');
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
        "#,&[]).unwrap();
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
