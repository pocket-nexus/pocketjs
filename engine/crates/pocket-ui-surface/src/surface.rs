//! Compatibility surface over the runtime operation context and generated HostOps contract
//! (contracts/spec/spec.ts OP table; JS caller in framework/src/host.ts) mounted into a guest
//! as `globalThis.ui`.
//!
//! Boot contract mirrors the PSP host (`programs/psp/src/service_bindings.rs` + `pak.rs`):
//! styles/atlases feed the core natively BEFORE the bundle evals, pak images
//! and sprites upload natively, and the (name → handle) tables are exposed
//! as `ui.__textures` / `ui.__sprites`. Pocket System shells additionally get
//! a separate `ui.__surfaces` package-id table from the native compositor; surface
//! handles never enter the texture table.
//! This is exactly what routes
//! `framework/src/host.ts::detectHost` onto its PSP branch. One desktop addition:
//! `ui.__viewport = {w, h}` tells the framework the logical UI size (the PSP
//! host omits it and the framework defaults to 480x272).

use std::cell::RefCell;
use std::collections::VecDeque;
use std::rc::Rc;

use anyhow::{Result, anyhow};
use pocket_mod::Guest;
use pocket_mod::qjs::{Coerced, Ctx, FromJs, Function, Object, Value};
use pocketjs_core::Ui;

use crate::dbg::DbgMailbox;
use pocket_guest_rquickjs::{BindingProfile, mount_ui};
use pocket_runtime::{
    AssetRegistry, GuestEnvironment, OpArg, OpContext, OpProvider, OpResult, RuntimeError,
};

/// A JS string decoded tolerantly for host ops. JS strings are potentially
/// ill-formed UTF-16 — an app slicing between surrogate halves is legal JS
/// (note's wrap math measuring an emoji prefix, say) — and QuickJS hands
/// lone surrogates to the FFI as bytes that are not valid UTF-8, which the
/// strict conversion turns into a thrown guest frame. A host op must never
/// abort the frame transaction over a legal JS value, so every string op
/// decodes lossy: each lone surrogate reads as U+FFFD.
struct LossyString(String);

impl<'js> FromJs<'js> for LossyString {
    fn from_js(ctx: &Ctx<'js>, value: Value<'js>) -> pocket_mod::qjs::Result<LossyString> {
        // The strict coercion first: it handles non-strings (Solid passes
        // numbers through replaceText) and every well-formed string.
        match Coerced::<String>::from_js(ctx, value.clone()) {
            Ok(s) => Ok(LossyString(s.0)),
            Err(_) => {
                let js = value
                    .into_string()
                    .ok_or_else(|| pocket_mod::qjs::Error::new_from_js("value", "string"))?;
                let c = js.to_cstring()?;
                // CString::as_str assumes valid UTF-8, which lone
                // surrogates break — read the raw bytes instead.
                let bytes = unsafe { std::slice::from_raw_parts(c.as_ptr() as *const u8, c.len()) };
                Ok(LossyString(String::from_utf8_lossy(bytes).into_owned()))
            }
        }
    }
}

struct Inner {
    /// The fed pak, kept whole: `loadTileTexture` decodes TILESET entries
    /// out of it on demand (tile bytes never transit the JS heap).
    pak: Vec<u8>,
    assets: AssetRegistry,
    asset_error: Option<RuntimeError>,
    /// Installed Pocket System package id -> native compositor surface handle.
    surfaces: Vec<(String, i32)>,
    /// Host service channel (spec ops 30..32): in-process JSON-line queues.
    /// On consoles the mailbox is files under a tethered share; here the
    /// widget host *is* the companion process, so lines just cross a queue.
    svc_in: VecDeque<String>,
    svc_out: VecDeque<String>,
    /// Companion service names accepted by `svcOpen`. Deny-all by default —
    /// svcOpen must answer TRUTHFULLY, and a host that serves a companion
    /// declares it explicitly (an implicit allow-any default let apps
    /// believe in adapters nobody feeds).
    svc_allowlist: Vec<String>,
    /// Platform-contract identity published as `ui.__host`/`ui.__hostAbi`.
    /// Bundles built from a resolved plan refuse hosts whose identity does
    /// not match their target (framework/src/host.ts assertNativeHostContract).
    host_id: String,
    host_abi: Option<u32>,
}

/// The `ui` surface. Clone-cheap handle; single-threaded like the guest.
#[derive(Clone)]
pub struct UiSurface {
    ops: OpContext,
    inner: Rc<RefCell<Inner>>,
}

impl UiSurface {
    /// A fresh core sized to `viewport` (logical px; pass (480, 272) to host
    /// stock PSP apps).
    pub fn new(viewport: (f32, f32)) -> UiSurface {
        Self::new_with_density(viewport, 1)
    }

    /// A fresh core with a raster density > 1 (the Vita model: logical
    /// layout unchanged, core-baked bitmaps and font coverage at `density`
    /// samples per logical px). Pair with density-`density` paks and
    /// `UiRenderer::render_words_scaled` for native-resolution output on
    /// high-DPI displays.
    pub fn new_with_density(viewport: (f32, f32), density: u32) -> UiSurface {
        let mut ui = Ui::new_with_raster_density(density);
        ui.set_viewport(viewport.0, viewport.1);
        let ops = OpContext::from_ui(ui);
        ops.set_compositor_enabled(true).expect("fresh context");
        ops.install_assets(&[]).expect("empty asset pack");
        Self::from_context(ops)
    }

    pub(crate) fn from_context(ops: OpContext) -> Self {
        let inner = Rc::new(RefCell::new(Inner {
            pak: Vec::new(),
            assets: AssetRegistry::default(),
            asset_error: None,
            surfaces: Vec::new(),
            svc_in: VecDeque::new(),
            svc_out: VecDeque::new(),
            svc_allowlist: Vec::new(),
            host_id: "desktop".into(),
            host_abi: None,
        }));
        ops.add_provider(Box::new(ServiceProvider(inner.clone())))
            .expect("fresh provider");
        UiSurface { ops, inner }
    }

    /// Declare this host's platform-contract identity (a POCKET_TARGETS id
    /// and its hostAbi) before `mount`. Plan-built bundles assert it; the
    /// default "desktop" (no ABI) serves plan-less development hosts.
    pub fn set_identity(&self, host_id: &str, host_abi: u32) {
        let mut inner = self.inner.borrow_mut();
        inner.host_id = host_id.to_string();
        inner.host_abi = Some(host_abi);
    }

    /// Declare the exact companion service names this host serves (svcOpen
    /// answers false for everything else — and for everything, by default).
    /// Call this before `mount`, which installs the host-op closure into
    /// the guest.
    pub fn set_svc_allowlist<I, S>(&self, services: I)
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        self.inner.borrow_mut().svc_allowlist = services
            .into_iter()
            .map(Into::into)
            .collect::<Vec<String>>();
    }

    /// Queue one JSON line for the guest's next `svcPoll` (host → guest).
    pub fn svc_push(&self, line: impl Into<String>) {
        self.inner.borrow_mut().svc_in.push_back(line.into());
    }

    /// Drain the lines the guest sent with `svcSend` (guest → host).
    pub fn svc_drain(&self) -> Vec<String> {
        self.inner.borrow_mut().svc_out.drain(..).collect()
    }

    /// Take only matching guest → host service lines, retaining every other
    /// namespace in FIFO order for another companion adapter.
    pub fn svc_drain_matching(&self, mut predicate: impl FnMut(&str) -> bool) -> Vec<String> {
        let mut inner = self.inner.borrow_mut();
        let mut matched = Vec::new();
        let mut retained = VecDeque::new();
        while let Some(line) = inner.svc_out.pop_front() {
            if predicate(&line) {
                matched.push(line);
            } else {
                retained.push_back(line);
            }
        }
        inner.svc_out = retained;
        matched
    }

    /// Feed an app pak: styles + font atlases go straight to the core,
    /// images/sprites upload as core textures. Call before `mount`.
    pub fn feed_pak(&self, pak: &[u8]) {
        if let Err(error) = self.try_feed_pak(pak) {
            log::warn!("pocket-ui: asset pack rejected: {error}");
        }
    }

    /// Validate and install the whole pack before changing asset metadata.
    pub fn try_feed_pak(&self, pak: &[u8]) -> Result<()> {
        let assets = match self.ops.install_assets(pak) {
            Ok(assets) => assets,
            Err(error) => {
                self.inner.borrow_mut().asset_error = Some(error);
                return Err(anyhow!("invalid asset pack: {error:?}"));
            }
        };
        let mut inner = self.inner.borrow_mut();
        inner.assets.textures.extend(assets.textures);
        inner.assets.sprites.extend(assets.sprites);
        inner.pak = pak.to_vec();
        inner.asset_error = None;
        Ok(())
    }

    /// Register an installed Pocket System package before [`mount`](Self::mount).
    /// Handles live in the compositor namespace and are never valid textures.
    pub fn register_compositor_surface(&self, package: impl Into<String>) -> Option<i32> {
        let mut inner = self.inner.borrow_mut();
        let package = package.into();
        if let Some((_, handle)) = inner.surfaces.iter().find(|(known, _)| known == &package) {
            return Some(*handle);
        }
        let handle = i32::try_from(inner.surfaces.len()).ok()?;
        inner.surfaces.push((package, handle));
        Some(handle)
    }

    /// Declare how many ticks make one second of virtual time (default 60).
    /// Call before `mount`: the mount publishes the rate to the guest as
    /// `ui.__tickHz`, and bundles refuse a rate other than the one they were
    /// built for. Rejected once the core has ticked (see `Ui::set_tick_rate`);
    /// returns whether the rate was applied.
    pub fn set_tick_rate(&self, hz: u32) -> bool {
        self.with_ui(|ui| ui.set_tick_rate(hz))
    }

    /// Advance the core one fixed-dt frame (call once per host tick, after
    /// the guest turn, before rendering).
    pub fn tick(&self) {
        self.with_ui(Ui::tick);
    }

    /// Install a native text measurer (docs/BACKENDS.md). Call before
    /// `mount`, like `set_tick_rate`: measurement feeds layout, so the guest
    /// must never observe a provider swap mid-run.
    pub fn set_text_measure(&self, f: pocketjs_core::text::MeasureFn) {
        self.with_ui(|ui| ui.set_text_measure(Some(f)));
    }

    /// Install a native line wrapper next to the measurer (OP wrapText —
    /// break positions then come from the host text system). Same call-
    /// before-`mount` rule so the guest never observes a provider swap.
    pub fn set_text_wrap(&self, f: pocketjs_core::text::WrapFn) {
        self.with_ui(|ui| ui.set_text_wrap(Some(f)));
    }

    /// Borrow the core (the renderer reads the DrawList/textures/atlases
    /// through this; hosts can use it for `set_viewport` on resize).
    pub fn with_ui<R>(&self, f: impl FnOnce(&mut Ui) -> R) -> R {
        let mut core = self
            .ops
            .core_mut()
            .expect("UI borrow overlaps a guest call");
        core.mutated();
        f(&mut core.ui)
    }

    /// Mount `globalThis.ui` (ops + `__textures`/`__sprites`/`__viewport`)
    /// into `guest`. Call after `feed_pak`, before evaluating the bundle.
    pub fn mount(&self, guest: &Guest) -> Result<()> {
        let inner = self.inner.borrow();
        if let Some(error) = inner.asset_error {
            return Err(anyhow!("asset pack was rejected: {error:?}"));
        }
        let core = self
            .ops
            .core()
            .map_err(|error| anyhow!("UI borrow: {error:?}"))?;
        let viewport = core.ui.viewport();
        let environment = GuestEnvironment {
            host: &inner.host_id,
            host_abi: inner.host_abi.unwrap_or(pocket_spec::BINDING_GENERATION),
            tick_hz: core.ui.tick_rate(),
            sim_hz: core.ui.tick_rate(),
            viewport: [viewport.0 as u32, viewport.1 as u32],
            auxiliary_viewport: core
                .ui
                .auxiliary_viewport()
                .map(|(w, h)| [w as u32, h as u32]),
            auxiliary_root: core.ui.auxiliary_surface_root(),
            raster_density: core.ui.raster_density(),
            heap_limit: 0,
            pak: &inner.pak,
            worker_javascript: &[],
            assets: Some(&inner.assets),
        };
        drop(core);
        self.mount_environment(guest, &environment, inner.host_abi.is_some())
    }

    pub(crate) fn mount_environment(
        &self,
        guest: &Guest,
        environment: &GuestEnvironment<'_>,
        has_abi: bool,
    ) -> Result<()> {
        let inner = self.inner.borrow();
        guest
            .with(|ctx| -> pocket_mod::qjs::Result<()> {
                mount_ui(
                    &ctx,
                    self.ops.clone(),
                    environment,
                    BindingProfile::Canonical,
                )?;
                let ns: Object = ctx.globals().get("ui")?;
                if !has_abi {
                    ns.remove("__hostAbi")?;
                }
                let surfaces = Object::new(ctx.clone())?;
                for (package, handle) in &inner.surfaces {
                    surfaces.set(package.as_str(), *handle)?;
                }
                ns.set("__surfaces", surfaces)?;
                let mailbox = Rc::new(RefCell::new(DbgMailbox::probe()));
                let active = mailbox.clone();
                ns.set(
                    "__dbgActive",
                    Function::new(ctx.clone(), move || active.borrow().is_some())?,
                )?;
                let poll = mailbox.clone();
                ns.set(
                    "__dbgPoll",
                    Function::new(ctx.clone(), move || -> Option<String> {
                        poll.borrow_mut()
                            .as_mut()
                            .and_then(|mailbox| mailbox.poll())
                    })?,
                )?;
                ns.set(
                    "__dbgSend",
                    Function::new(ctx.clone(), move |line: LossyString| {
                        if let Some(mailbox) = mailbox.borrow().as_ref() {
                            mailbox.send(&line.0);
                        }
                    })?,
                )?;
                Ok(())
            })
            .map_err(|error| anyhow!("mounting generated UI bindings: {error}"))
    }
}

struct ServiceProvider(Rc<RefCell<Inner>>);
impl OpProvider for ServiceProvider {
    fn supports_op(&self, op: u16) -> bool {
        (30..=32).contains(&op)
    }
    fn dispatch(
        &mut self,
        _: &mut Ui,
        op: u16,
        args: &[OpArg<'_>],
    ) -> Result<OpResult, RuntimeError> {
        let mut inner = self.0.try_borrow_mut().map_err(|_| RuntimeError::Busy)?;
        let text = |arg: &OpArg<'_>| -> Result<String, RuntimeError> {
            match arg {
                OpArg::Bytes(bytes) => {
                    String::from_utf8(bytes.to_vec()).map_err(|_| RuntimeError::InvalidArgument)
                }
                _ => Err(RuntimeError::InvalidArgument),
            }
        };
        match op {
            30 => Ok(OpResult::Integer(i64::from(
                inner.svc_allowlist.contains(&text(&args[0])?),
            ))),
            31 if inner.svc_in.is_empty() => Ok(OpResult::None),
            31 => {
                let mut batch = String::new();
                for line in inner.svc_in.drain(..) {
                    batch.push_str(&line);
                    batch.push('\n');
                }
                Ok(OpResult::Bytes(batch.into_bytes()))
            }
            32 => {
                inner.svc_out.push_back(text(&args[0])?);
                Ok(OpResult::None)
            }
            _ => Err(RuntimeError::UnsupportedOperation),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn implicit_identity_mounts_current_bindings_without_publishing_host_abi() {
        let guest = Guest::new().unwrap();
        let surface = UiSurface::new((16.0, 16.0));
        surface.mount(&guest).unwrap();
        guest
            .eval(
                "identity",
                "if('__hostAbi' in ui)throw Error('implicit identity leaked');ui.createNode(1);",
            )
            .unwrap();
        let guest = Guest::new().unwrap();
        let surface = UiSurface::new((16.0, 16.0));
        surface.set_identity("fixture", pocket_spec::BINDING_GENERATION);
        surface.mount(&guest).unwrap();
        guest
            .eval(
                "identity",
                &format!(
                    "if(ui.__host!=='fixture'||ui.__hostAbi!=={})throw Error('identity');",
                    pocket_spec::BINDING_GENERATION
                ),
            )
            .unwrap();
    }

    #[test]
    fn generated_ops_preserve_string_coercion_and_borrow_sliced_texture_views() {
        let guest = Guest::new().unwrap();
        let surface = UiSurface::new((16.0, 16.0));
        surface.mount(&guest).unwrap();
        guest
            .eval(
                "generated",
                r#"
            globalThis.node = ui.createNode(1);
            ui.setText(node, 42);
            ui.replaceText(node, '\ud800');
            const backing = new Uint8Array([7, 255, 0, 0, 255, 9]);
            globalThis.texture = ui.uploadTexture(backing.subarray(1, 5), 1, 1, 3);
            ui.setPropBatch(new Float64Array([node, 0, 8]).buffer);
        "#,
            )
            .unwrap();
        let (node, texture): (i32, i32) = guest.with(|ctx| {
            (
                ctx.globals().get("node").unwrap(),
                ctx.globals().get("texture").unwrap(),
            )
        });
        surface.with_ui(|ui| {
            // Preserve the old lossy UTF-8 conversion of QuickJS WTF-8.
            assert_eq!(ui.node_text(node), Some("\u{fffd}\u{fffd}\u{fffd}"));
            assert_eq!(ui.texture(texture).unwrap().pixels, [255, 0, 0, 255]);
        });
        let other = UiSurface::new((16.0, 16.0));
        other.with_ui(|ui| assert!(ui.texture(texture).is_none()));
    }

    #[test]
    fn rejected_assets_prevent_mount_and_can_be_replaced_before_boot() {
        let surface = UiSurface::new((16.0, 16.0));
        assert!(surface.try_feed_pak(b"broken").is_err());
        let guest = Guest::new().unwrap();
        assert!(surface.mount(&guest).is_err());
        surface.try_feed_pak(&[]).unwrap();
        surface.mount(&guest).unwrap();
    }

    #[test]
    fn svc_open_denies_by_default() {
        // Truthful-by-default: a host that never declares a companion must
        // answer false — apps otherwise enable UI over a channel nobody
        // feeds (the macos-app --editor regression, review round 3).
        let guest = Guest::new().unwrap();
        let surface = UiSurface::new((16.0, 16.0));
        surface.mount(&guest).unwrap();
        guest
            .eval("service", "globalThis.serviceOpen = ui.svcOpen('note');")
            .unwrap();
        let open: bool = guest.with(|ctx| ctx.globals().get("serviceOpen").unwrap());
        assert!(!open);
    }

    #[test]
    fn empty_service_allowlist_disables_the_companion() {
        let guest = Guest::new().unwrap();
        let surface = UiSurface::new((16.0, 16.0));
        surface.set_svc_allowlist(std::iter::empty::<&str>());
        surface.mount(&guest).unwrap();
        guest
            .eval("service", "globalThis.serviceOpen = ui.svcOpen('demo');")
            .unwrap();
        let open: bool = guest.with(|ctx| ctx.globals().get("serviceOpen").unwrap());
        assert!(!open);
    }

    #[test]
    fn service_allowlist_matches_exact_names() {
        let guest = Guest::new().unwrap();
        let surface = UiSurface::new((16.0, 16.0));
        surface.set_svc_allowlist(["ipod-nano"]);
        surface.mount(&guest).unwrap();
        guest
            .eval(
                "service",
                "globalThis.exact = ui.svcOpen('ipod-nano');\
                 globalThis.wrong = ui.svcOpen('other');",
            )
            .unwrap();
        let (exact, wrong): (bool, bool) = guest.with(|ctx| {
            (
                ctx.globals().get("exact").unwrap(),
                ctx.globals().get("wrong").unwrap(),
            )
        });
        assert!(exact);
        assert!(!wrong);
    }

    #[test]
    fn matching_service_drain_retains_other_namespaces_in_order() {
        let guest = Guest::new().unwrap();
        let surface = UiSurface::new((16.0, 16.0));
        surface.mount(&guest).unwrap();
        guest
            .eval(
                "service",
                "ui.svcSend('alpha'); ui.svcSend('media'); ui.svcSend('omega');",
            )
            .unwrap();

        assert_eq!(
            surface.svc_drain_matching(|line| line == "media"),
            vec!["media"]
        );
        assert_eq!(surface.svc_drain(), vec!["alpha", "omega"]);
    }

    #[test]
    fn compositor_surface_has_its_own_namespace_and_core_binding() {
        let guest = Guest::new().unwrap();
        let surface = UiSurface::new((16.0, 16.0));
        let handle = surface
            .register_compositor_surface("dev.pocket-nexus.hero")
            .unwrap();
        assert_eq!(
            surface.register_compositor_surface("dev.pocket-nexus.hero"),
            Some(handle)
        );
        surface.mount(&guest).unwrap();
        guest
            .eval(
                "surface",
                "globalThis.surface = ui.__surfaces['dev.pocket-nexus.hero'];\
                 globalThis.node = ui.createNode(3);\
                 ui.setCompositorSurface(globalThis.node, globalThis.surface, 1);",
            )
            .unwrap();
        let published: i32 = guest.with(|ctx| ctx.globals().get("surface").unwrap());
        assert_eq!(published, handle);
        surface.with_ui(|ui| {
            assert!(ui.texture(handle).is_none());
            assert_eq!(
                ui.compositor_surface_bindings(),
                vec![(handle as u32, true)]
            );
        });
    }
}
