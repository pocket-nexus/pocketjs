//! An application instance owns the UI, package, guest and driver registration.
//! No platform I/O or script engine is selected by this crate.
#![no_std]
extern crate alloc;
#[cfg(test)]
extern crate std;

mod assets;
mod config;
pub mod generated_ops;
mod guest;
pub mod input;
pub mod timing;
pub use config::RuntimeConfig;
pub use guest::*;
pub use pocket_present::{DisplayId, RendererId};

use alloc::{boxed::Box, rc::Rc, vec::Vec};
use core::cell::{Cell, Ref, RefCell, RefMut};
use pocket_drivers::{
    DisplayOutput, DisplayRole, InputClasses, InputFrameBuilder, InputSource, PackageSource,
    Renderer,
};
use pocket_package::source::LoadedPackage;
use pocket_present::Coordinator;
use pocketjs_core::Ui;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum RuntimeError {
    InvalidArgument,
    UnsupportedOperation,
    InvalidConfiguration,
    ProfileMismatch,
    InvalidState,
    Busy,
    MissingPackage,
    MissingGuest,
    MissingDisplay,
    MissingInput,
    Package(pocket_package::source::LoadError),
    InvalidAssets,
    InvalidInput,
    Guest,
    Presentation(pocket_present::PresentError),
}
impl From<pocket_present::PresentError> for RuntimeError {
    fn from(error: pocket_present::PresentError) -> Self {
        Self::Presentation(error)
    }
}

#[derive(Clone, Copy, Debug)]
pub enum OpArg<'a> {
    Integer(i64),
    Real(f64),
    Bytes(&'a [u8]),
}
#[derive(Debug, PartialEq)]
pub enum OpResult {
    None,
    Integer(i64),
    Real(f64),
    Bytes(Vec<u8>),
}

pub trait OpProvider {
    fn supports_op(&self, op: u16) -> bool;
    fn dispatch(
        &mut self,
        ui: &mut Ui,
        op: u16,
        args: &[OpArg<'_>],
    ) -> Result<OpResult, RuntimeError>;
}

/// State shared with guest callbacks. A frame keeps an immutable borrow until
/// every render/display wait completes; dispatch then returns Busy.
pub struct CoreState {
    pub ui: Ui,
    pub epoch: u64,
    providers: Vec<Box<dyn OpProvider>>,
    compositor: bool,
    physics: bool,
}
impl CoreState {
    pub fn new(ui: Ui) -> Self {
        Self {
            ui,
            epoch: 1,
            providers: Vec::new(),
            compositor: false,
            physics: false,
        }
    }
    pub fn mutated(&mut self) {
        self.epoch = self.epoch.wrapping_add(1);
    }
}
impl core::ops::Deref for CoreState {
    type Target = Ui;
    fn deref(&self) -> &Ui {
        &self.ui
    }
}
impl core::ops::DerefMut for CoreState {
    fn deref_mut(&mut self) -> &mut Ui {
        self.mutated();
        &mut self.ui
    }
}

#[derive(Clone)]
pub struct OpContext {
    state: Rc<RefCell<CoreState>>,
    active: Rc<Cell<bool>>,
    package: Rc<RefCell<Option<PackageAssets>>>,
}
enum PackageAssets {
    Admitted(Rc<LoadedPackage>),
    Embedded(Rc<[u8]>),
}
impl PackageAssets {
    fn pak(&self) -> &[u8] {
        match self {
            Self::Admitted(package) => package.pak(),
            Self::Embedded(pak) => pak,
        }
    }
}
impl OpContext {
    pub fn from_ui(ui: Ui) -> Self {
        Self {
            state: Rc::new(RefCell::new(CoreState::new(ui))),
            active: Rc::new(Cell::new(true)),
            package: Rc::new(RefCell::new(None)),
        }
    }
    pub fn core(&self) -> Result<Ref<'_, CoreState>, RuntimeError> {
        self.state.try_borrow().map_err(|_| RuntimeError::Busy)
    }
    pub fn core_mut(&self) -> Result<RefMut<'_, CoreState>, RuntimeError> {
        self.state.try_borrow_mut().map_err(|_| RuntimeError::Busy)
    }
    /// Install an embedded asset pack for an embedding that owns admission and
    /// guest lifecycle. Full Runtime instances load assets from PackageSource.
    /// Validation completes before any core asset changes; tile loads retain
    /// an owned copy of this pack. Mount guest metadata after this call.
    pub fn install_assets(&self, pak: &[u8]) -> Result<AssetRegistry, RuntimeError> {
        if !self.active.get() {
            return Err(RuntimeError::InvalidState);
        }
        let mut state = self.core_mut()?;
        let registry = assets::install(&mut state.ui, pak)?;
        state.mutated();
        *self.package.borrow_mut() = Some(PackageAssets::Embedded(Rc::from(pak)));
        Ok(registry)
    }
    /// Declare that the embedding supplies the compositor raster namespace.
    pub fn set_compositor_enabled(&self, enabled: bool) -> Result<(), RuntimeError> {
        if !self.active.get() {
            return Err(RuntimeError::InvalidState);
        }
        self.core_mut()?.compositor = enabled;
        Ok(())
    }
    /// Register a provider before mounting generated guest bindings. Runtime
    /// additionally enforces its configuring/boot lifecycle around this call.
    pub fn add_provider(&self, provider: Box<dyn OpProvider>) -> Result<(), RuntimeError> {
        if !self.active.get() {
            return Err(RuntimeError::InvalidState);
        }
        let mut state = self.core_mut()?;
        let mut count = 0;
        for operation in generated_ops::OP_DESCRIPTORS {
            if provider.supports_op(operation.id) {
                if matches!(operation.provider, "core" | "package")
                    || state.providers.iter().any(|p| p.supports_op(operation.id))
                {
                    return Err(RuntimeError::InvalidArgument);
                }
                count += 1;
            }
        }
        if count == 0 {
            return Err(RuntimeError::InvalidArgument);
        }
        state.providers.push(provider);
        Ok(())
    }
    pub fn supports_op(&self, op: u16) -> bool {
        self.core()
            .map(|state| self.supported(&state, op))
            .unwrap_or(false)
    }
    fn supported(&self, state: &CoreState, op: u16) -> bool {
        if !self.active.get() {
            return false;
        }
        if op == 23 {
            return self.package.borrow().is_some();
        }
        if op == 44 && !state.compositor {
            return false;
        }
        if (op == 45 || op == 46) && state.ui.auxiliary_viewport().is_none() {
            return false;
        }
        if (52..=56).contains(&op) && !state.physics {
            return false;
        }
        generated_ops::supports_core_op(op)
            || state
                .providers
                .iter()
                .any(|provider| provider.supports_op(op))
    }
    pub fn dispatch(&self, op: u16, args: &[OpArg<'_>]) -> Result<OpResult, RuntimeError> {
        let mut state = self.core_mut()?;
        if !self.supported(&state, op) {
            return Err(RuntimeError::UnsupportedOperation);
        }
        generated_ops::validate_args(op, args)?;
        state.mutated();
        if op == 23 {
            let [OpArg::Bytes(key), OpArg::Integer(index)] = args else {
                return Err(RuntimeError::InvalidArgument);
            };
            let key = core::str::from_utf8(key).map_err(|_| RuntimeError::InvalidArgument)?;
            let package = self.package.borrow();
            let package = package.as_ref().ok_or(RuntimeError::MissingPackage)?;
            let handle = match pocket_package::pak::find(package.pak(), key) {
                Some(blob) if *index >= 0 => state.ui.upload_tileset_tile(blob, *index as u32),
                _ => -1,
            };
            return Ok(OpResult::Integer(handle as i64));
        }
        if generated_ops::supports_core_op(op) {
            return generated_ops::dispatch(&mut state.ui, op, args);
        }
        let CoreState { ui, providers, .. } = &mut *state;
        providers
            .iter_mut()
            .find(|p| p.supports_op(op))
            .ok_or(RuntimeError::UnsupportedOperation)?
            .dispatch(ui, op, args)
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum State {
    Configuring,
    Running,
    Failed,
    Stopped,
}
pub struct Runtime {
    config: RuntimeConfig,
    profile: config::Profile,
    ops: OpContext,
    source: Option<Box<dyn PackageSource>>,
    package: Option<Rc<LoadedPackage>>,
    guest: Option<Box<dyn Guest>>,
    guest_initialized: bool,
    inputs: Vec<Box<dyn InputSource>>,
    input: InputFrameBuilder,
    encoder: input::InputEncoder,
    presenter: Coordinator,
    state: State,
    native_assets: bool,
}
impl Runtime {
    pub fn new(config: RuntimeConfig) -> Result<Self, RuntimeError> {
        let profile = config.profile()?;
        let logical = profile.logical_viewports[0];
        let mut ui = Ui::new_with_raster_density(profile.density);
        ui.set_viewport(logical[0] as f32, logical[1] as f32);
        if !ui.set_tick_rate(config.tick_hz) {
            return Err(RuntimeError::InvalidConfiguration);
        }
        if let Some(aux) = profile.auxiliary_logical.first() {
            ui.create_auxiliary_surface(aux[0] as f32, aux[1] as f32);
        }
        let scale = profile.viewport[0]
            .checked_div(logical[0])
            .filter(|&s| s > 0 && s <= 4 && profile.viewport == [logical[0] * s, logical[1] * s])
            .ok_or(RuntimeError::InvalidConfiguration)?;
        let presenter = Coordinator::new(scale, config.frame_buffer_budget)?;
        Ok(Self {
            config,
            profile,
            ops: OpContext::from_ui(ui),
            source: None,
            package: None,
            guest: None,
            guest_initialized: false,
            inputs: Vec::new(),
            input: InputFrameBuilder::new(),
            encoder: input::InputEncoder::new(),
            presenter,
            state: State::Configuring,
            native_assets: true,
        })
    }
    pub fn op_context(&self) -> OpContext {
        self.ops.clone()
    }
    fn configuring(&self) -> Result<(), RuntimeError> {
        if self.state == State::Configuring {
            Ok(())
        } else {
            Err(RuntimeError::InvalidState)
        }
    }
    pub fn set_package_source(
        &mut self,
        source: Box<dyn PackageSource>,
    ) -> Result<(), RuntimeError> {
        self.configuring()?;
        self.source = Some(source);
        Ok(())
    }
    pub fn set_guest(&mut self, guest: Box<dyn Guest>) -> Result<(), RuntimeError> {
        self.configuring()?;
        self.guest = Some(guest);
        Ok(())
    }
    pub fn set_native_asset_loading(&mut self, enabled: bool) -> Result<(), RuntimeError> {
        self.configuring()?;
        self.native_assets = enabled;
        Ok(())
    }
    pub fn add_input_source(&mut self, input: Box<dyn InputSource>) -> Result<(), RuntimeError> {
        self.configuring()?;
        self.inputs.push(input);
        Ok(())
    }
    pub fn add_provider(&mut self, provider: Box<dyn OpProvider>) -> Result<(), RuntimeError> {
        self.configuring()?;
        self.ops.add_provider(provider)
    }
    pub fn add_renderer<R: Renderer + 'static>(
        &mut self,
        renderer: R,
    ) -> Result<RendererId, RuntimeError>
    where
        R::Submission: 'static,
    {
        self.configuring()?;
        Ok(self.presenter.add_renderer(renderer)?)
    }
    pub fn add_display<D: DisplayOutput + 'static>(
        &mut self,
        display: D,
        renderer: RendererId,
    ) -> Result<DisplayId, RuntimeError>
    where
        D::Token: 'static,
    {
        self.configuring()?;
        Ok(self.presenter.add_display(display, renderer)?)
    }
    pub fn boot(&mut self) -> Result<(), RuntimeError> {
        self.configuring()?;
        if self.guest.is_none() {
            return Err(RuntimeError::MissingGuest);
        }
        let mut primary = false;
        let mut auxiliary = false;
        for descriptor in self.presenter.display_descriptors() {
            let expected = match descriptor.role {
                DisplayRole::Primary => {
                    primary = true;
                    self.profile.viewport
                }
                DisplayRole::Auxiliary => {
                    auxiliary = true;
                    self.profile
                        .auxiliary
                        .ok_or(RuntimeError::ProfileMismatch)?
                }
                _ => return Err(RuntimeError::ProfileMismatch),
            };
            if [descriptor.width, descriptor.height] != expected {
                return Err(RuntimeError::ProfileMismatch);
            }
        }
        if !primary || self.profile.auxiliary.is_some() && !auxiliary {
            return Err(RuntimeError::MissingDisplay);
        }
        let classes = self
            .inputs
            .iter()
            .fold(InputClasses::NONE, |classes, source| {
                classes | source.classes()
            });
        if !classes.contains(self.profile.required_inputs) {
            return Err(RuntimeError::MissingInput);
        }
        let source = self.source.as_mut().ok_or(RuntimeError::MissingPackage)?;
        let package = Rc::new(
            LoadedPackage::load(
                source.as_mut(),
                &self.profile.id,
                self.config.host_abi,
                self.config.heap_limit,
            )
            .map_err(RuntimeError::Package)?,
        );
        let facts = pocket_package::plan_facts(package.plan())
            .map_err(|_| RuntimeError::ProfileMismatch)?;
        let viewport = [facts.viewport.width, facts.viewport.height];
        if !self.profile.logical_viewports.contains(&viewport)
            || facts.viewport.raster_density != self.profile.density
        {
            return Err(RuntimeError::ProfileMismatch);
        }
        let scale = self.profile.viewport[0]
            .checked_div(viewport[0])
            .filter(|&scale| {
                scale > 0
                    && scale <= 4
                    && self.profile.viewport == [viewport[0] * scale, viewport[1] * scale]
            })
            .ok_or(RuntimeError::ProfileMismatch)?;
        if let Some(aux) = facts.auxiliary {
            if !self
                .profile
                .auxiliary_logical
                .contains(&[aux.width, aux.height])
                || self.profile.auxiliary != Some([aux.width * scale, aux.height * scale])
                || aux.raster_density != self.profile.density
            {
                return Err(RuntimeError::ProfileMismatch);
            }
        }
        self.presenter.set_scale(scale)?;
        let (registry, auxiliary_root) = {
            let mut state = self.ops.core_mut()?;
            let registry = if self.native_assets {
                Some(assets::install(&mut state.ui, package.pak())?)
            } else {
                None
            };
            state
                .ui
                .set_viewport(viewport[0] as f32, viewport[1] as f32);
            state.physics = facts.feature("ui.physics");
            if let Some(aux) = facts.auxiliary {
                state
                    .ui
                    .create_auxiliary_surface(aux.width as f32, aux.height as f32);
            }
            *self.ops.package.borrow_mut() = Some(PackageAssets::Admitted(package.clone()));
            (registry, state.ui.auxiliary_surface_root())
        };
        self.package = Some(package.clone());
        let env = GuestEnvironment {
            host: &self.profile.id,
            host_abi: self.config.host_abi,
            tick_hz: self.config.tick_hz,
            viewport,
            auxiliary_viewport: facts.auxiliary.map(|a| [a.width, a.height]),
            auxiliary_root,
            raster_density: self.profile.density,
            heap_limit: self.config.heap_limit,
            pak: package.pak(),
            assets: registry.as_ref(),
        };
        let guest = self.guest.as_mut().unwrap();
        self.guest_initialized = true;
        let started = guest
            .initialize(self.ops.clone(), &env)
            .and_then(|()| guest.evaluate(package.javascript()));
        if let Err(error) = started {
            self.state = State::Failed;
            guest.shutdown();
            self.guest_initialized = false;
            return Err(error);
        }
        self.state = State::Running;
        // The initial frame is rendered from evaluated UI state. No animation
        // tick or guest frame is synthesized before the platform's first tick.
        self.render()
    }
    fn render(&mut self) -> Result<(), RuntimeError> {
        let mut state = self.ops.core_mut()?;
        state.ui.draw();
        state.ui.draw_auxiliary();
        self.presenter.present(
            state.ui.current_draw_list(),
            state.ui.current_auxiliary_draw_list(),
            &state.ui,
        )?;
        Ok(())
    }
    pub fn tick(&mut self) -> Result<(), RuntimeError> {
        if self.state != State::Running {
            return Err(RuntimeError::InvalidState);
        }
        self.input.clear();
        for source in &mut self.inputs {
            source.poll(&mut self.input);
        }
        let encoded = {
            let mut state = self.ops.core_mut()?;
            self.encoder.encode(&mut state.ui, &self.input.frame())?
        };
        let frame = GuestFrame {
            buttons: encoded.buttons,
            analog: encoded.analog,
            touches: &encoded.touches,
            hits: &encoded.hits,
            touch_surfaces: &encoded.surfaces,
            right_analog: encoded.right_analog,
            axis_deltas: &self.input.relative,
            motion: self.input.motion.as_ref(),
            text: &self.input.text,
        };
        if let Err(error) = self
            .guest
            .as_mut()
            .ok_or(RuntimeError::MissingGuest)?
            .frame(&frame)
        {
            self.state = State::Failed;
            return Err(error);
        }
        {
            let mut state = self.ops.core_mut()?;
            state.ui.tick();
            state.mutated();
        }
        self.render()
    }
    pub fn collect(&mut self) -> Result<(), RuntimeError> {
        if self.state != State::Running {
            return Err(RuntimeError::InvalidState);
        }
        self.guest
            .as_mut()
            .ok_or(RuntimeError::MissingGuest)?
            .collect()
    }
    pub fn shutdown(&mut self) -> Result<(), RuntimeError> {
        // Invalidation does not borrow the core: a caller may retain a read
        // guard while dropping Runtime. Package bytes remain in self.package
        // until guest shutdown, then all context-held package roots are gone.
        self.ops.active.set(false);
        self.ops.package.borrow_mut().take();
        // Coordinator::present returns only after all device work is terminal.
        if self.guest_initialized {
            if let Some(guest) = &mut self.guest {
                guest.shutdown();
            }
            self.guest_initialized = false;
        }
        self.package = None;
        self.state = State::Stopped;
        Ok(())
    }
}
impl Drop for Runtime {
    fn drop(&mut self) {
        let _ = self.shutdown();
    }
}
