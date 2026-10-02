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
//!
//! A guest built with [`Guest::new_with_idle_gc`] also moves QuickJS cycle
//! collection out of the turn: the host calls [`Guest::idle_gc`] after the
//! turn's work and the policy in [`idle_gc`] decides whether to collect. The
//! realm is built on a counting allocator (see the `idle_gc` module), so the
//! policy reads the heap size in constant time without touching QuickJS
//! private state.

use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::time::Instant;

use anyhow::{Result, anyhow};
use rquickjs::{CatchResultExt, Context, Ctx, Function, Object, Runtime};

pub mod idle_gc;
pub use idle_gc::{IdleBudget, IdleGcConfig, IdleGcOutcome, IdleGcStats};
use idle_gc::{IdleGcDecision, IdleGcPolicy};

mod counting_alloc;
use counting_alloc::{CountingAllocator, CountingState};

// Surface crates implement ops against the same rquickjs the guest uses.
pub use rquickjs as qjs;

/// One QuickJS realm hosting one guest program.
pub struct Guest {
    rt: Runtime,
    ctx: Context,
    idle: Option<IdleGc>,
}

/// Idle-collection state: the live-allocation counters the allocator shares,
/// the policy, the `malloc_gc_threshold` value last written (to spot in-turn
/// collections), and whether the allocator memory limit has been armed.
struct IdleGc {
    state: Rc<CountingState>,
    policy: RefCell<IdleGcPolicy>,
    armed: Cell<usize>,
    limited: Cell<bool>,
    stats: Cell<IdleGcStats>,
}

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

    /// Create an empty realm whose cycle collection runs at frame boundaries
    /// ([`Guest::idle_gc`]) instead of at whichever allocation crosses the
    /// engine's threshold. The realm is built on a counting allocator that
    /// mirrors the engine's `malloc_state`, so the policy reads the heap size
    /// in constant time through the public allocator trait.
    pub fn new_with_idle_gc(config: IdleGcConfig) -> Result<Guest> {
        let state = Rc::new(CountingState::default());
        let mut guest = Self::from_runtime(Runtime::new_with_alloc(CountingAllocator::new(
            state.clone(),
        ))?)?;
        guest.idle = Some(IdleGc {
            state,
            policy: RefCell::new(IdleGcPolicy::new(config, 0)),
            armed: Cell::new(0),
            limited: Cell::new(false),
            stats: Cell::new(IdleGcStats::default()),
        });
        // Baseline after console install, before the product bundle.
        let bytes = guest.idle.as_ref().unwrap().state.malloc_size.get();
        guest
            .idle
            .as_ref()
            .unwrap()
            .policy
            .borrow_mut()
            .rebased(bytes);
        guest.arm();
        Ok(guest)
    }

    fn from_runtime(rt: Runtime) -> Result<Guest> {
        let ctx = Context::full(&rt)?;
        ctx.with(|ctx| install_console(&ctx))
            .map_err(|e| anyhow!("pocket-mod: installing console: {e}"))?;
        Ok(Guest {
            rt,
            ctx,
            idle: None,
        })
    }

    /// QuickJS's own `malloc_size` via `JS_ComputeMemoryUsage`. Walks the
    /// whole heap: for tests and reports, not for per-frame use.
    pub fn engine_malloc_size(&self) -> usize {
        self.engine_memory_usage().malloc_size.max(0) as usize
    }

    /// Full `JS_ComputeMemoryUsage` snapshot (walks the heap).
    pub fn engine_memory_usage(&self) -> qjs::qjs::JSMemoryUsage {
        self.ctx.with(|ctx| unsafe {
            let rt = qjs::qjs::JS_GetRuntime(ctx.as_raw().as_ptr());
            let mut usage: qjs::qjs::JSMemoryUsage = std::mem::zeroed();
            qjs::qjs::JS_ComputeMemoryUsage(rt, &mut usage);
            usage
        })
    }

    fn gc_threshold(&self) -> usize {
        self.ctx.with(|ctx| unsafe {
            qjs::qjs::JS_GetGCThreshold(qjs::qjs::JS_GetRuntime(ctx.as_raw().as_ptr())) as usize
        })
    }

    /// The engine's `malloc_size` in bytes, read from the counting
    /// allocator, or `None` without idle collection. Constant time.
    pub fn heap_bytes(&self) -> Option<usize> {
        self.idle.as_ref().map(|idle| idle.state.malloc_size.get())
    }

    /// Idle-collection counters, or `None` without idle collection.
    pub fn idle_gc_stats(&self) -> Option<IdleGcStats> {
        self.idle.as_ref().map(|idle| idle.stats.get())
    }

    /// Arm the allocator memory limit for product frames. Call once after the
    /// product bundle is evaluated and before the first [`Guest::frame`]: the
    /// idle-GC baseline rebases on the booted heap and the hard cap
    /// (`JS_SetMemoryLimit`) goes live, so the first product frame is bounded.
    /// Bundle evaluation itself stays unbounded, like a plain QuickJS runtime.
    ///
    /// Returns `true` when this call armed the limit, `false` when it was
    /// already armed or the guest has no idle collection. A host that never
    /// calls this still gets the cap at the first [`Guest::idle_gc`] boundary
    /// (the fallback arm), but its first frame runs unbounded.
    pub fn arm_idle_gc(&self) -> bool {
        let Some(idle) = &self.idle else { return false };
        if idle.limited.get() {
            return false;
        }
        let bytes = idle.state.malloc_size.get();
        idle.policy.borrow_mut().rebased(bytes);
        idle.limited.set(true);
        self.arm();
        true
    }

    /// Write the policy's GC threshold into QuickJS as `malloc_gc_threshold`,
    /// and the memory limit once the first boundary has armed it.
    fn arm(&self) {
        let Some(idle) = &self.idle else { return };
        let (hard, limit) = {
            let policy = idle.policy.borrow();
            (policy.hard_limit(), policy.memory_limit())
        };
        self.rt.set_gc_threshold(hard);
        if idle.limited.get() {
            self.rt.set_memory_limit(limit);
        }
        // Read back what the engine stored, so the comparison in `idle_gc`
        // is exact on every target's size_t.
        idle.armed.set(self.gc_threshold());
    }

    /// Frame-boundary collection. Call once per tick after the turn and its
    /// jobs, outside the turn's measured work, with the time left before the
    /// next tick (`None` = no deadline). Returns what the policy did; without
    /// [`Guest::new_with_idle_gc`] this is a no-op returning
    /// [`IdleGcOutcome::Disabled`].
    pub fn idle_gc(&self, budget: Option<IdleBudget>) -> IdleGcOutcome {
        let Some(idle) = &self.idle else {
            return IdleGcOutcome::Disabled;
        };
        let mut stats = idle.stats.get();
        let bytes = idle.state.malloc_size.get();
        stats.peak_bytes = stats.peak_bytes.max(bytes);
        if !idle.limited.get() {
            // Fallback arm for hosts that did not call `arm_idle_gc` after
            // eval: rebase on the live heap and arm the allocator memory
            // limit. The first frame already ran unbounded; product hosts
            // arm before the first frame instead.
            idle.policy.borrow_mut().rebased(bytes);
            idle.limited.set(true);
            idle.stats.set(stats);
            self.arm();
            return IdleGcOutcome::Idle;
        }
        if self.gc_threshold() != idle.armed.get() {
            // The engine collected inside a turn (GC threshold) and re-armed
            // its own 1.5x threshold. Rebase on the current heap and re-arm.
            stats.forced_collections += 1;
            idle.policy.borrow_mut().rebased(bytes);
            idle.stats.set(stats);
            self.arm();
            return IdleGcOutcome::Idle;
        }
        let decision = idle.policy.borrow_mut().decide(bytes, budget);
        let outcome = match decision {
            IdleGcDecision::Idle => IdleGcOutcome::Idle,
            IdleGcDecision::Defer => {
                stats.deferred_boundaries += 1;
                IdleGcOutcome::Deferred
            }
            IdleGcDecision::Collect => {
                let start = Instant::now();
                self.rt.run_gc();
                let pause = start.elapsed();
                idle.policy
                    .borrow_mut()
                    .collected(idle.state.malloc_size.get(), pause);
                stats.idle_collections += 1;
                stats.max_pause = stats.max_pause.max(pause);
                stats.total_pause += pause;
                IdleGcOutcome::Collected(pause)
            }
        };
        idle.stats.set(stats);
        if decision == IdleGcDecision::Collect {
            self.arm();
        }
        outcome
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

    /// One turn's worth of cyclic garbage: `n` two-object cycles that
    /// reference counting cannot free.
    const CYCLES: &str = "globalThis.frame = (n) => { \
        for (let i = 0; i < n; i++) { const a = { pad: new Array(16).fill(i) }; const b = { a }; a.b = b; } \
        globalThis.turns = (globalThis.turns || 0) + 1; };";

    #[test]
    fn counting_allocator_matches_the_engine_counter() {
        let g = Guest::new_with_idle_gc(IdleGcConfig::default()).unwrap();
        assert_eq!(g.heap_bytes(), Some(g.engine_malloc_size()));
        g.eval(
            "boot",
            "globalThis.keep = []; for (let i = 0; i < 5000; i++) keep.push({ s: 'x'.repeat(i % 64), a: [i, i + 1] });",
        )
        .unwrap();
        assert_eq!(g.heap_bytes(), Some(g.engine_malloc_size()));
        g.eval(
            "drop",
            "globalThis.keep = null; globalThis.big = new Array(100000).fill(1);",
        )
        .unwrap();
        assert_eq!(g.heap_bytes(), Some(g.engine_malloc_size()));
        g.eval("cycles", CYCLES).unwrap();
        g.frame(2000).unwrap();
        g.rt.run_gc();
        assert_eq!(g.heap_bytes(), Some(g.engine_malloc_size()));
    }

    #[test]
    fn plain_guest_reports_disabled() {
        let g = Guest::new().unwrap();
        assert_eq!(g.idle_gc(None), IdleGcOutcome::Disabled);
        assert_eq!(g.heap_bytes(), None);
        assert_eq!(g.idle_gc_stats(), None);
    }

    #[test]
    fn cycles_are_collected_at_the_boundary_not_in_the_turn() {
        let g = Guest::new_with_idle_gc(IdleGcConfig::default()).unwrap();
        g.eval("boot", CYCLES).unwrap();
        let mut collected = 0;
        for _ in 0..200 {
            let before = g.heap_bytes().unwrap();
            g.frame(200).unwrap();
            // Every byte the turn allocated is still there: no in-turn GC.
            assert!(g.heap_bytes().unwrap() >= before);
            if let IdleGcOutcome::Collected(_) = g.idle_gc(None) {
                collected += 1;
                assert!(
                    g.heap_bytes().unwrap()
                        <= g.idle.as_ref().unwrap().policy.borrow().soft_limit()
                );
            }
        }
        let stats = g.idle_gc_stats().unwrap();
        assert!(collected > 0, "{stats:?}");
        assert_eq!(stats.idle_collections, collected);
        assert_eq!(stats.forced_collections, 0, "{stats:?}");
        // Bounded by the soft limit plus one turn of garbage.
        assert!(stats.peak_bytes < 4 * 1024 * 1024, "{stats:?}");
    }

    #[test]
    fn hard_limit_still_collects_inside_a_turn() {
        let g = Guest::new_with_idle_gc(IdleGcConfig::default()).unwrap();
        g.eval("boot", CYCLES).unwrap();
        g.arm_idle_gc();
        let hard = g.idle.as_ref().unwrap().policy.borrow().hard_limit();
        // One turn allocates far more cyclic garbage than the hard step.
        let mut peak = 0;
        for _ in 0..4 {
            g.frame(40_000).unwrap();
            peak = peak.max(g.heap_bytes().unwrap());
        }
        assert!(
            peak < 4 * hard,
            "heap {peak} grew without bound past hard limit {hard}"
        );
        assert_eq!(g.idle_gc(None), IdleGcOutcome::Idle);
        let stats = g.idle_gc_stats().unwrap();
        assert_eq!(stats.forced_collections, 1, "{stats:?}");
        // Re-armed: the engine threshold is the policy's hard limit again.
        assert_eq!(
            g.gc_threshold(),
            g.idle.as_ref().unwrap().policy.borrow().hard_limit()
        );
    }

    #[test]
    fn a_single_large_allocation_is_bounded_by_the_memory_limit() {
        // The engine's GC trigger fires on JSObject allocation, so one turn
        // can grow the heap past the GC threshold with a single large
        // backing store (the review's counterexample reached 38,485,128
        // bytes against a 1,161,120-byte threshold). The allocator memory
        // limit (`JS_SetMemoryLimit`) is the hard cap: the allocation fails
        // with a JS out-of-memory exception instead of growing the heap
        // without bound.
        //
        // Production order: eval the bundle, arm the cap, then run the first
        // product frame. Before `arm_idle_gc` existed, the first frame ran
        // unbounded (the re-review's first-frame probe retained ~38 MiB).
        let g = Guest::new_with_idle_gc(IdleGcConfig::default()).unwrap();
        // Two cycles, each holding a 2,000,000-element array: ~38 MiB of
        // garbage in one turn.
        g.eval(
            "boot",
            "globalThis.frame = (n) => { \
                for (let i = 0; i < n; i++) { \
                    const a = { pad: new Array(2000000).fill(i) }; \
                    const b = { a }; a.b = b; \
                } \
            };",
        )
        .unwrap();
        // Boot complete: arm the cap before the first product frame.
        assert!(g.arm_idle_gc());
        assert!(!g.arm_idle_gc()); // idempotent
        let limit = g.idle.as_ref().unwrap().policy.borrow().memory_limit();
        let before = g.heap_bytes().unwrap();
        // One turn allocates far past the memory limit.
        let err = g.frame(2).unwrap_err();
        // The allocation failed: the heap did not grow past the cap.
        let after = g.heap_bytes().unwrap();
        assert!(
            after <= limit,
            "heap {after} grew past the memory limit {limit} (err: {err})"
        );
        assert!(
            after < before + 1024 * 1024,
            "heap grew {before} -> {after} for a refused allocation"
        );
        // No collection ran: the allocator refused the block.
        let stats = g.idle_gc_stats().unwrap();
        assert_eq!(stats.idle_collections, 0, "{stats:?}");
        assert_eq!(stats.forced_collections, 0, "{stats:?}");
        eprintln!("memory limit={limit} before={before} after={after}");
    }

    #[test]
    fn the_first_boundary_arms_the_limit_without_an_explicit_arm() {
        // Fallback contract for hosts that create an idle-GC guest and never
        // call `arm_idle_gc`: the first frame is unbounded (like a plain
        // QuickJS runtime), and the first `idle_gc` boundary rebases on the
        // live heap and arms the cap. A plain guest has nothing to arm.
        assert!(!Guest::new().unwrap().arm_idle_gc());
        let g = Guest::new_with_idle_gc(IdleGcConfig::default()).unwrap();
        // The turn pins its allocations to a global, so the engine's
        // threshold collection cannot reclaim them: the allocator memory
        // limit is the binding constraint once armed.
        g.eval(
            "boot",
            "globalThis.keep = []; \
             globalThis.frame = (n) => { \
                 for (let i = 0; i < n; i++) globalThis.keep.push(new Array(2000000).fill(i)); \
             };",
        )
        .unwrap();
        let before = g.heap_bytes().unwrap();
        // The first frame is unbounded: the 16 MiB backing store succeeds.
        g.frame(1).unwrap();
        assert!(
            g.heap_bytes().unwrap() > before + 8 * 1024 * 1024,
            "first frame should be unbounded without an explicit arm"
        );
        // The first boundary arms the cap on the booted heap.
        assert_eq!(g.idle_gc(None), IdleGcOutcome::Idle);
        let limit = g.idle.as_ref().unwrap().policy.borrow().memory_limit();
        assert!(g.heap_bytes().unwrap() <= limit);
        // The armed cap now refuses the same turn's growth.
        let err = g.frame(4).unwrap_err();
        assert!(
            g.heap_bytes().unwrap() <= limit,
            "heap grew past the memory limit {limit} (err: {err})"
        );
        let stats = g.idle_gc_stats().unwrap();
        assert_eq!(stats.idle_collections, 0, "{stats:?}");
    }

    #[test]
    fn a_collection_that_never_fits_runs_after_max_defer() {
        let config = IdleGcConfig {
            max_defer: 5,
            ..IdleGcConfig::default()
        };
        let g = Guest::new_with_idle_gc(config).unwrap();
        g.eval("boot", CYCLES).unwrap();
        let no_time = Some(IdleBudget {
            remaining: std::time::Duration::ZERO,
            period: std::time::Duration::from_secs(1),
        });
        // The first collection has no cost estimate and runs at once.
        let first = (0..1000).find(|_| {
            g.frame(200).unwrap();
            matches!(g.idle_gc(no_time), IdleGcOutcome::Collected(_))
        });
        assert!(first.is_some(), "{:?}", g.idle_gc_stats());
        let mut deferred = 0;
        let mut second = false;
        for _ in 0..1000 {
            g.frame(200).unwrap();
            match g.idle_gc(no_time) {
                IdleGcOutcome::Deferred => deferred += 1,
                IdleGcOutcome::Collected(_) => {
                    second = true;
                    break;
                }
                IdleGcOutcome::Idle => assert_eq!(deferred, 0),
                IdleGcOutcome::Disabled => unreachable!(),
            }
        }
        assert!(second, "{:?}", g.idle_gc_stats());
        assert_eq!(deferred, 5);
        let stats = g.idle_gc_stats().unwrap();
        assert_eq!(stats.deferred_boundaries, 5);
        assert_eq!(stats.idle_collections, 2);
    }

    #[test]
    fn weakref_clears_and_finalization_runs_after_the_boundary() {
        // Timing contract for weak references under idle collection:
        // - a `WeakRef` whose target becomes unreachable in a turn stays
        //   live through that turn; the first boundary collection clears it;
        // - a `FinalizationRegistry` cleanup callback is queued as a job by
        //   that collection and runs at the next job drain — `idle_gc` does
        //   not drain jobs.
        //
        // The target is in a cycle (`target.self = target`), so reference
        // counting cannot free it when the strong reference drops: only
        // `JS_RunGC` reclaims it, which is what the boundary collection is.
        let g = Guest::new_with_idle_gc(IdleGcConfig::default()).unwrap();
        g.eval(
            "boot",
            "globalThis.log = []; \
             globalThis.registry = new FinalizationRegistry((held) => globalThis.log.push(held)); \
             globalThis.frame = (n) => { \
                 if (n === 0) { \
                     const target = { payload: 'x'.repeat(64) }; \
                     target.self = target; \
                     globalThis.weak = new WeakRef(target); \
                     globalThis.registry.register(target, 'cleaned'); \
                     globalThis.strong = target; \
                 } else if (n === 1) { \
                     globalThis.strong = null; \
                 } else { \
                     for (let i = 0; i < n; i++) { const a = {}; const b = { a }; a.b = b; } \
                 } \
             };",
        )
        .unwrap();
        g.frame(0).unwrap();
        g.frame(1).unwrap();
        // First boundary: rebase on the booted heap.
        assert_eq!(g.idle_gc(None), IdleGcOutcome::Idle);
        // The target is only weakly reachable now, but no collection has
        // run: deref() still resolves.
        assert!(g.with(|ctx| {
            ctx.eval::<bool, _>("globalThis.weak.deref() !== undefined")
                .unwrap()
        }));
        // One turn of cyclic garbage past the soft limit, then the boundary
        // collection.
        g.frame(3_000).unwrap();
        let outcome = g.idle_gc(None);
        assert!(
            matches!(outcome, IdleGcOutcome::Collected(_)),
            "expected a boundary collection, got {outcome:?}"
        );
        assert_eq!(g.idle_gc_stats().unwrap().idle_collections, 1);
        // The boundary GC cleared the WeakRef ...
        assert!(g.with(|ctx| {
            ctx.eval::<bool, _>("globalThis.weak.deref() === undefined")
                .unwrap()
        }));
        // ... and queued the finalization job, which has not run yet:
        // idle_gc does not drain jobs.
        let logged: String = g.with(|ctx| ctx.eval("JSON.stringify(globalThis.log)").unwrap());
        assert_eq!(logged, "[]");
        // The next job drain runs the cleanup callback.
        g.drain_jobs();
        let logged: String = g.with(|ctx| ctx.eval("JSON.stringify(globalThis.log)").unwrap());
        assert_eq!(logged, r#"["cleaned"]"#);
    }

    #[test]
    fn weakref_clears_inside_a_turn_when_the_hard_threshold_is_crossed() {
        // The boundary timing contract is the soft-limit path only. A turn
        // that allocates past the GC threshold (2x the surviving heap)
        // through object allocations runs the engine's collection inside the
        // turn, as an unmodified QuickJS runtime would: the cyclic target is
        // reclaimed mid-turn, the WeakRef clears, and the finalization job
        // runs at the frame's own job drain — before `frame` returns, with
        // no `idle_gc` call.
        let g = Guest::new_with_idle_gc(IdleGcConfig::default()).unwrap();
        g.eval(
            "boot",
            "globalThis.log = []; \
             globalThis.registry = new FinalizationRegistry((held) => globalThis.log.push(held)); \
             globalThis.frame = (n) => { \
                 if (n === 0) { \
                     const target = { payload: 'x'.repeat(64) }; \
                     target.self = target; \
                     globalThis.weak = new WeakRef(target); \
                     globalThis.registry.register(target, 'cleaned'); \
                     globalThis.strong = target; \
                 } else if (n === 1) { \
                     globalThis.strong = null; \
                 } else { \
                     for (let i = 0; i < n; i++) { const a = {}; const b = { a }; a.b = b; } \
                 } \
             };",
        )
        .unwrap();
        g.arm_idle_gc();
        g.frame(0).unwrap();
        g.frame(1).unwrap(); // strong dropped; the cyclic target is now garbage
        assert!(g.with(|ctx| {
            ctx.eval::<bool, _>("globalThis.weak.deref() !== undefined")
                .unwrap()
        }));
        // One turn of cyclic garbage far past the hard threshold: the engine
        // collects inside the turn. No idle_gc call in this test.
        g.frame(200_000).unwrap();
        // The in-turn collection cleared the WeakRef ...
        assert!(g.with(|ctx| {
            ctx.eval::<bool, _>("globalThis.weak.deref() === undefined")
                .unwrap()
        }));
        // ... and the frame's own job drain ran the finalization callback.
        let logged: String = g.with(|ctx| ctx.eval("JSON.stringify(globalThis.log)").unwrap());
        assert_eq!(logged, r#"["cleaned"]"#);
        // The next boundary observes the engine's in-turn collection.
        assert_eq!(g.idle_gc(None), IdleGcOutcome::Idle);
        let stats = g.idle_gc_stats().unwrap();
        assert_eq!(stats.forced_collections, 1, "{stats:?}");
        assert_eq!(stats.idle_collections, 0, "{stats:?}");
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
