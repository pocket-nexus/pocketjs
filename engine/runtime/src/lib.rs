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
    BindingGenerationMismatch,
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
        if !self.active.get() {
            return Err(RuntimeError::InvalidState);
        }
        self.state.try_borrow().map_err(|_| RuntimeError::Busy)
    }
    pub fn core_mut(&self) -> Result<RefMut<'_, CoreState>, RuntimeError> {
        if !self.active.get() {
            return Err(RuntimeError::InvalidState);
        }
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
    /// Enable physics operations for a low-level embedding. Full Runtime boot
    /// replaces this setting with the admitted package's feature declaration.
    pub fn set_physics_enabled(&self, enabled: bool) -> Result<(), RuntimeError> {
        self.core_mut()?.physics = enabled;
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
        if !self.active.get() {
            return Err(RuntimeError::UnsupportedOperation);
        }
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
    pending_frame: bool,
    embedded_viewport: bool,
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
        // Output ownership is known after registration. CPU scale is selected
        // from admitted logical and registered physical sizes at boot.
        let presenter = Coordinator::new(1, config.frame_buffer_budget)?;
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
            pending_frame: false,
            embedded_viewport: false,
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
    /// Let an embedding program manage its presentation target dimensions.
    /// This opt-in must precede boot. Package hash and logical viewport admission
    /// still use the compiled profile; CPU targets still require integer scaling.
    pub fn allow_embedded_viewport_changes(&mut self) -> Result<(), RuntimeError> {
        self.configuring()?;
        self.embedded_viewport = true;
        Ok(())
    }
    /// Resize an opted-in raw-JavaScript embedding. The program must first
    /// prepare its display storage and descriptors for `physical`. On error it
    /// must restore those descriptors. This does not admit a different package.
    pub fn resize_embedded(
        &mut self,
        logical: [u32; 2],
        physical: [u32; 2],
    ) -> Result<(), RuntimeError> {
        if self.state != State::Running
            || !self.embedded_viewport
            || logical.contains(&0)
            || logical.iter().any(|v| *v > 32000)
        {
            return Err(RuntimeError::InvalidState);
        }
        let scale = physical[0] / logical[0];
        if !(1..=4).contains(&scale) || physical != [logical[0] * scale, logical[1] * scale] {
            return Err(RuntimeError::InvalidArgument);
        }
        let mut core = self.ops.core_mut()?;
        self.presenter.refresh_displays(scale, physical)?;
        core.ui.set_viewport(logical[0] as f32, logical[1] as f32);
        core.mutated();
        self.profile.viewport = physical;
        self.profile.logical_viewports[0] = logical;
        Ok(())
    }
    pub fn add_input_source(&mut self, input: Box<dyn InputSource>) -> Result<(), RuntimeError> {
        self.configuring()?;
        self.inputs.push(input);
        Ok(())
    }

    /// Resize a native GPU embedding's presentation target while keeping the
    /// application's logical viewport. The program prepares display descriptors
    /// first and restores them on failure. CPU raster targets use `resize_embedded`.
    pub fn resize_embedded_presentation(&mut self, physical: [u32; 2]) -> Result<(), RuntimeError> {
        self.validate_embedded_gpu_resize(physical)?;
        self.presenter
            .refresh_displays(self.presenter.scale(), physical)?;
        self.profile.viewport = physical;
        Ok(())
    }
    /// Resize a GPU embedding whose OS scale produces a fractional logical
    /// viewport. The program prepares its device targets and scale first and
    /// restores them on failure. The core retains its one-unit viewport minimum
    /// for windows smaller than the OS scale. Package admission keeps its profile.
    pub fn resize_embedded_gpu(
        &mut self,
        logical: [f32; 2],
        physical: [u32; 2],
    ) -> Result<(), RuntimeError> {
        self.validate_embedded_gpu_resize(physical)?;
        if logical
            .iter()
            .any(|v| !v.is_finite() || *v <= 0.0 || *v > 32000.0)
        {
            return Err(RuntimeError::InvalidArgument);
        }
        let mut core = self.ops.core_mut()?;
        self.presenter
            .refresh_displays(self.presenter.scale(), physical)?;
        core.ui.set_viewport(logical[0], logical[1]);
        core.mutated();
        self.profile.viewport = physical;
        Ok(())
    }
    fn validate_embedded_gpu_resize(&self, physical: [u32; 2]) -> Result<(), RuntimeError> {
        if self.state != State::Running || !self.embedded_viewport {
            return Err(RuntimeError::InvalidState);
        }
        if physical.contains(&0) || physical.iter().any(|v| *v > 65535) {
            return Err(RuntimeError::InvalidArgument);
        }
        if self
            .presenter
            .display_descriptors()
            .any(|d| d.target_ownership != pocket_drivers::TargetOwnership::DeviceOwned)
        {
            return Err(RuntimeError::InvalidArgument);
        }
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
    fn validate_boot_drivers(&self) -> Result<(), RuntimeError> {
        self.configuring()?;
        if self.guest.is_none() {
            return Err(RuntimeError::MissingGuest);
        }
        let mut primary = false;
        let mut auxiliary = false;
        for descriptor in self.presenter.display_descriptors() {
            match descriptor.role {
                DisplayRole::Primary => {
                    primary = true;
                }
                DisplayRole::Auxiliary => {
                    auxiliary = true;
                    if self.profile.auxiliary.is_none() {
                        return Err(RuntimeError::ProfileMismatch);
                    }
                }
                _ => return Err(RuntimeError::ProfileMismatch),
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
        Ok(())
    }
    fn presentation_layout(
        &self,
        viewport: [u32; 2],
        auxiliary: Option<[u32; 2]>,
    ) -> Result<(u32, Option<[u32; 2]>), RuntimeError> {
        if !self.profile.admits_viewport(viewport)
            || auxiliary.is_some_and(|size| !self.profile.auxiliary_logical.contains(&size))
        {
            return Err(RuntimeError::ProfileMismatch);
        }
        let candidates: Vec<Option<[u32; 2]>> = match auxiliary {
            Some(size) => alloc::vec![Some(size)],
            None if self.profile.auxiliary.is_some() => self
                .profile
                .auxiliary_logical
                .iter()
                .copied()
                .map(Some)
                .collect(),
            None => alloc::vec![None],
        };
        for auxiliary in candidates {
            let mut raster_scale = None;
            let mut primary_gpu_scale = None;
            let mut valid = true;
            for display in self.presenter.display_descriptors() {
                let (logical, panel, dynamic) = match display.role {
                    DisplayRole::Primary => (
                        viewport,
                        self.profile.viewport,
                        self.profile.dynamic_viewport.is_some(),
                    ),
                    DisplayRole::Auxiliary => (
                        auxiliary.ok_or(RuntimeError::ProfileMismatch)?,
                        self.profile
                            .auxiliary
                            .ok_or(RuntimeError::ProfileMismatch)?,
                        false,
                    ),
                    _ => return Err(RuntimeError::ProfileMismatch),
                };
                let physical = [display.width, display.height];
                if !self.embedded_viewport {
                    let expected = [
                        logical[0] * self.profile.density,
                        logical[1] * self.profile.density,
                    ];
                    if if dynamic {
                        physical != expected
                    } else {
                        physical != panel && physical != [panel[1], panel[0]]
                    } {
                        valid = false;
                        break;
                    }
                }
                let scale = physical[0] / logical[0];
                // The coordinator derives auxiliary resource geometry from the
                // shared integer scale. Primary GPU outputs own their mapping.
                if display.target_ownership == pocket_drivers::TargetOwnership::CpuVisible
                    || display.role == DisplayRole::Auxiliary
                {
                    if !(1..=4).contains(&scale)
                        || physical != [logical[0] * scale, logical[1] * scale]
                        || raster_scale.is_some_and(|previous| previous != scale)
                    {
                        valid = false;
                        break;
                    }
                    raster_scale = Some(scale);
                } else if (1..=4).contains(&scale)
                    && physical == [logical[0] * scale, logical[1] * scale]
                {
                    primary_gpu_scale = Some(scale);
                }
            }
            if valid {
                return Ok((raster_scale.or(primary_gpu_scale).unwrap_or(1), auxiliary));
            }
        }
        Err(RuntimeError::ProfileMismatch)
    }
    /// Start code and assets linked into an AOT program. No package source or
    /// JavaScript payload is read. The generated artifact's profile hash must
    /// match this instance, and its viewport must be declared by that profile.
    /// Presentation is deferred until `present` or `skip_presentation`.
    pub fn boot_aot_deferred(
        &mut self,
        profile_hash: [u8; 32],
        viewport: [u32; 2],
        physics: bool,
    ) -> Result<(), RuntimeError> {
        self.validate_boot_drivers()?;
        if profile_hash != self.config.profile_hash
            || !self.profile.admits_viewport(viewport)
            || self.source.is_some()
        {
            return Err(RuntimeError::ProfileMismatch);
        }
        let (scale, auxiliary_viewport) = self.presentation_layout(viewport, None)?;
        self.presenter.set_scale(scale)?;
        let auxiliary_root = {
            let mut state = self.ops.core_mut()?;
            state
                .ui
                .set_viewport(viewport[0] as f32, viewport[1] as f32);
            state.physics = physics;
            if let Some(aux) = auxiliary_viewport {
                state
                    .ui
                    .create_auxiliary_surface(aux[0] as f32, aux[1] as f32);
            }
            state.ui.auxiliary_surface_root()
        };
        let environment = GuestEnvironment {
            host: &self.profile.id,
            host_abi: self.config.host_abi,
            tick_hz: self.config.tick_hz,
            viewport,
            auxiliary_viewport,
            auxiliary_root,
            raster_density: self.profile.density,
            heap_limit: self.config.heap_limit,
            pak: &[],
            assets: None,
        };
        let guest = self.guest.as_mut().unwrap();
        self.guest_initialized = true;
        if let Err(error) = guest.initialize(self.ops.clone(), &environment) {
            self.state = State::Failed;
            guest.shutdown();
            self.guest_initialized = false;
            return Err(error);
        }
        self.state = State::Running;
        self.pending_frame = true;
        Ok(())
    }
    pub fn boot(&mut self) -> Result<(), RuntimeError> {
        self.boot_deferred()?;
        self.present()
    }
    /// Admit and evaluate the package without presenting its initial tree.
    /// The program must call `present` before advancing the first guest frame.
    /// This allows a native scene to be established before its UI overlay.
    pub fn boot_deferred(&mut self) -> Result<(), RuntimeError> {
        self.validate_boot_drivers()?;
        let source = self.source.as_mut().ok_or(RuntimeError::MissingPackage)?;
        let package = Rc::new(
            LoadedPackage::load(
                source.as_mut(),
                &self.profile.id,
                self.config.host_abi,
                &self.config.profile_hash,
                self.config.heap_limit,
            )
            .map_err(RuntimeError::Package)?,
        );
        let facts = pocket_package::plan_facts(package.plan())
            .map_err(|_| RuntimeError::ProfileMismatch)?;
        let viewport = [facts.viewport.width, facts.viewport.height];
        if facts.viewport.raster_density != self.profile.density
            || facts
                .auxiliary
                .is_some_and(|aux| aux.raster_density != self.profile.density)
        {
            return Err(RuntimeError::ProfileMismatch);
        }
        // A registered auxiliary display keeps its profile surface available
        // even when this package does not declare auxiliary content.
        let (scale, auxiliary_viewport) =
            self.presentation_layout(viewport, facts.auxiliary.map(|aux| [aux.width, aux.height]))?;
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
            if let Some(aux) = auxiliary_viewport {
                state
                    .ui
                    .create_auxiliary_surface(aux[0] as f32, aux[1] as f32);
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
            auxiliary_viewport,
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
        self.pending_frame = true;
        Ok(())
    }
    /// Present the current tree and wait for all render and display work.
    /// No driver retains frame references after this call. Both terminal
    /// outcomes permit another advance; a failed output can also be retried
    /// with `present` without running the guest again.
    pub fn present(&mut self) -> Result<(), RuntimeError> {
        if self.state != State::Running {
            return Err(RuntimeError::InvalidState);
        }
        let mut state = self.ops.core_mut()?;
        self.pending_frame = false;
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
        self.advance()?;
        self.present()
    }
    /// Present a device-owned UI and submit host overlays before terminal
    /// rendering completion. The callback runs with the core borrowed; UI
    /// mutation through retained operation contexts is rejected during it.
    pub fn present_with_overlay(
        &mut self,
        overlay: impl FnMut(DisplayId),
    ) -> Result<(), RuntimeError> {
        if self.state != State::Running {
            return Err(RuntimeError::InvalidState);
        }
        let mut state = self.ops.core_mut()?;
        self.pending_frame = false;
        state.ui.draw();
        state.ui.draw_auxiliary();
        self.presenter.present_with_overlay(
            state.ui.current_draw_list(),
            state.ui.current_auxiliary_draw_list(),
            &state.ui,
            overlay,
        )?;
        Ok(())
    }
    /// Sample input and advance the guest and core once. No rendering work is
    /// submitted. A subsequent advance is rejected until `present` completes,
    /// allowing the program to insert native scene commands between the two.
    pub fn advance(&mut self) -> Result<(), RuntimeError> {
        self.advance_with_core_ticks(1)
    }
    /// Run one guest frame followed by a bounded number of fixed core steps.
    /// Embeddings with a lower guest cadence retain the core simulation step;
    /// ordinary runtime ticks always use one. No presentation occurs here.
    pub fn advance_with_core_ticks(&mut self, ticks: u32) -> Result<(), RuntimeError> {
        if !(1..=60).contains(&ticks) {
            return Err(RuntimeError::InvalidArgument);
        }
        if self.state != State::Running || self.pending_frame {
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
            for _ in 0..ticks {
                state.ui.tick();
            }
            state.mutated();
        }
        self.pending_frame = true;
        Ok(())
    }
    /// Discard a frame that has not submitted rendering work. Embeddings use
    /// this for headless fast-forward or deferring the first native surface.
    /// The next advance still runs exactly one guest turn.
    pub fn skip_presentation(&mut self) -> Result<(), RuntimeError> {
        if self.state != State::Running {
            return Err(RuntimeError::InvalidState);
        }
        self.pending_frame = false;
        Ok(())
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
        self.pending_frame = false;
        Ok(())
    }
}
impl Drop for Runtime {
    fn drop(&mut self) {
        let _ = self.shutdown();
    }
}
