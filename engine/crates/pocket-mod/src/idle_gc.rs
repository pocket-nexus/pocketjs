//! Between-frame cycle collection for a [`crate::Guest`].
//!
//! QuickJS frees most garbage by reference count; `JS_RunGC` only reclaims
//! cycles, and its cost scales with the number of **live** GC objects, not
//! with the garbage. The engine triggers it on **object allocation** once
//! `malloc_size` crosses `malloc_gc_threshold`, then re-arms the threshold
//! at 1.5× the surviving size. The pause therefore lands in whichever guest
//! turn happens to cross the threshold, on top of that turn's own work —
//! and only an object allocation checks the threshold: one turn can grow
//! the heap past it with a single large backing-store allocation.
//!
//! [`IdleGcPolicy`] moves the collection to the host's frame boundary:
//!
//!   - **soft limit** = `baseline + max(min_step, baseline / 2)`, where
//!     `baseline` is the tracked heap size after the last collection. This is
//!     the engine's own 1.5× rule, so a guest collects about as often as it
//!     did before; only the point in the frame changes. `min_step` defaults
//!     to the PSP host's 256 KiB arena-pressure step and only matters for
//!     small heaps.
//!   - **GC threshold** = `baseline + max(hard_min_step, baseline)` (2× the
//!     surviving size), written into QuickJS as `malloc_gc_threshold`. A
//!     turn that allocates past it through object allocations still collects
//!     inside the turn, through the engine's own trigger. After such a
//!     collection the engine re-arms at 1.5× on its own; the next boundary
//!     notices the changed threshold, rebases and counts it as a forced
//!     collection.
//!   - **memory limit** = `gc_threshold + max(memory_headroom, baseline)`,
//!     written into QuickJS with `JS_SetMemoryLimit`. This is the hard cap
//!     the GC threshold cannot provide: a turn whose growth is one large
//!     backing store (which never checks the GC threshold) fails the
//!     allocation with a JS out-of-memory exception instead of growing the
//!     heap without bound. The cap is armed by `Guest::arm_idle_gc`, called
//!     by the host after the product bundle is evaluated and before the
//!     first product frame; before that the realm is unlimited, like a
//!     plain QuickJS runtime. A host that never arms still gets the cap at
//!     the first `idle_gc` boundary (its first frame runs unbounded).
//!   - At a boundary past the soft limit the policy collects when the time
//!     left before the next tick covers the last measured collection, or
//!     when a collection cannot fit any tick (`last cost > period`) and
//!     this tick used at most half of its period, or after `max_defer`
//!     deferred boundaries. The first collection has no measured cost and
//!     runs at the first boundary past the soft limit.
//!
//! Tracking `malloc_size` per frame needs a cheap reading: QuickJS keeps it
//! private and `JS_ComputeMemoryUsage` walks the whole heap. A realm built
//! with [`crate::CountingAllocator`] maintains the engine's counters itself
//! (one header per block, `usable_size + MALLOC_OVERHEAD`, exactly what the
//! engine adds), so the policy reads them in constant time through the
//! public allocator trait — no QuickJS private layout is read.

use std::time::Duration;

/// Tuning for [`IdleGcPolicy`]. The defaults keep the engine's 1.5×/2×
/// growth ratios and the PSP host's 256 KiB minimum step.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct IdleGcConfig {
    /// Smallest growth past the baseline that requests a boundary collection.
    pub min_step: usize,
    /// Smallest growth past the baseline that collects inside a turn.
    pub hard_min_step: usize,
    /// Growth past the GC threshold that one turn may still allocate before
    /// the allocator refuses. The engine's GC trigger only fires on object
    /// allocation, so a single large backing-store allocation can otherwise
    /// grow the heap without bound; the memory limit
    /// (`gc_threshold + max(memory_headroom, baseline)`) is the hard cap.
    pub memory_headroom: usize,
    /// Boundaries a pending collection may wait for a tick with enough time
    /// left before it runs regardless.
    pub max_defer: u32,
}

impl Default for IdleGcConfig {
    fn default() -> Self {
        IdleGcConfig {
            min_step: 256 * 1024,
            hard_min_step: 1024 * 1024,
            memory_headroom: 8 * 1024 * 1024,
            max_defer: 30,
        }
    }
}

/// Time the host has before its next tick, measured after the turn's work.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct IdleBudget {
    /// Time left until the next tick is due (zero when the tick overran).
    pub remaining: Duration,
    /// The host's tick period.
    pub period: Duration,
}

/// What one boundary check decided.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IdleGcOutcome {
    /// The guest was created without idle collection.
    Disabled,
    /// Heap growth is below the soft limit.
    Idle,
    /// Past the soft limit, but this tick has no room; retried next boundary.
    Deferred,
    /// Ran `JS_RunGC`; carries the measured pause.
    Collected(Duration),
}

/// Counters for reports and benchmarks.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct IdleGcStats {
    /// Collections run at a frame boundary.
    pub idle_collections: u64,
    /// Collections the engine ran inside a turn because the hard limit was
    /// crossed (observed at the next boundary).
    pub forced_collections: u64,
    /// Boundaries that deferred a pending collection.
    pub deferred_boundaries: u64,
    /// Longest boundary collection.
    pub max_pause: Duration,
    /// Sum of boundary collection pauses.
    pub total_pause: Duration,
    /// Highest tracked heap size seen at a boundary, in bytes.
    pub peak_bytes: usize,
}

/// The decision half of idle collection, free of QuickJS so it can be tested
/// with plain numbers. [`crate::Guest`] feeds it the tracked heap size.
#[derive(Clone, Debug)]
pub struct IdleGcPolicy {
    config: IdleGcConfig,
    baseline: usize,
    deferred: u32,
    last_cost: Option<Duration>,
}

/// What the policy wants done at a boundary.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IdleGcDecision {
    Idle,
    Defer,
    Collect,
}

impl IdleGcPolicy {
    pub fn new(config: IdleGcConfig, baseline: usize) -> IdleGcPolicy {
        IdleGcPolicy {
            config,
            baseline,
            deferred: 0,
            last_cost: None,
        }
    }

    pub fn config(&self) -> IdleGcConfig {
        self.config
    }

    /// Tracked heap size after the last collection.
    pub fn baseline(&self) -> usize {
        self.baseline
    }

    /// Boundary collection requested above this size.
    pub fn soft_limit(&self) -> usize {
        self.baseline
            .saturating_add(self.config.min_step.max(self.baseline / 2))
    }

    /// In-turn collection (QuickJS `malloc_gc_threshold`) above this size.
    /// The engine checks it on object allocation, like an unmodified
    /// QuickJS runtime.
    pub fn hard_limit(&self) -> usize {
        self.baseline
            .saturating_add(self.config.hard_min_step.max(self.baseline))
    }

    /// Allocator hard cap (`JS_SetMemoryLimit`) above this size. A turn that
    /// grows past the GC threshold without allocating objects (one large
    /// backing store) fails the allocation instead of growing the heap.
    pub fn memory_limit(&self) -> usize {
        self.hard_limit()
            .saturating_add(self.config.memory_headroom.max(self.baseline))
    }

    /// Decide at a frame boundary with the tracked heap at `bytes`. `None`
    /// budget means the host has no deadline: collect whenever requested.
    pub fn decide(&mut self, bytes: usize, budget: Option<IdleBudget>) -> IdleGcDecision {
        if bytes <= self.soft_limit() {
            self.deferred = 0;
            return IdleGcDecision::Idle;
        }
        let fits = match (budget, self.last_cost) {
            (None, _) | (_, None) => true,
            (Some(b), Some(cost)) => {
                cost <= b.remaining || (cost > b.period && b.remaining >= b.period / 2)
            }
        };
        if fits || self.deferred >= self.config.max_defer {
            IdleGcDecision::Collect
        } else {
            self.deferred += 1;
            IdleGcDecision::Defer
        }
    }

    /// Record a boundary collection that left the heap at `bytes`.
    pub fn collected(&mut self, bytes: usize, cost: Duration) {
        self.baseline = bytes;
        self.deferred = 0;
        self.last_cost = Some(cost);
    }

    /// Record a collection the engine ran inside a turn; the heap is at
    /// `bytes` now. The pause was not measured, so the cost estimate stays.
    pub fn rebased(&mut self, bytes: usize) {
        self.baseline = bytes;
        self.deferred = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIB: usize = 1024 * 1024;

    fn budget(remaining_ms: u64, period_ms: u64) -> Option<IdleBudget> {
        Some(IdleBudget {
            remaining: Duration::from_millis(remaining_ms),
            period: Duration::from_millis(period_ms),
        })
    }

    #[test]
    fn limits_follow_the_engine_ratios_with_floors() {
        let p = IdleGcPolicy::new(IdleGcConfig::default(), 40 * MIB);
        assert_eq!(p.soft_limit(), 60 * MIB);
        assert_eq!(p.hard_limit(), 80 * MIB);
        assert_eq!(p.memory_limit(), 80 * MIB + 40 * MIB);
        // Small heaps fall back to the fixed steps.
        let p = IdleGcPolicy::new(IdleGcConfig::default(), 100 * 1024);
        assert_eq!(p.soft_limit(), 100 * 1024 + 256 * 1024);
        assert_eq!(p.hard_limit(), 100 * 1024 + MIB);
        assert_eq!(p.memory_limit(), 100 * 1024 + MIB + 8 * MIB);
    }

    #[test]
    fn idle_until_strictly_past_the_soft_limit() {
        let mut p = IdleGcPolicy::new(IdleGcConfig::default(), 40 * MIB);
        assert_eq!(p.decide(60 * MIB, None), IdleGcDecision::Idle);
        assert_eq!(p.decide(60 * MIB + 1, None), IdleGcDecision::Collect);
    }

    #[test]
    fn first_collection_runs_without_a_cost_estimate() {
        let mut p = IdleGcPolicy::new(IdleGcConfig::default(), 40 * MIB);
        assert_eq!(p.decide(61 * MIB, budget(0, 16)), IdleGcDecision::Collect);
    }

    #[test]
    fn collects_when_the_last_cost_fits_the_remaining_time() {
        let mut p = IdleGcPolicy::new(IdleGcConfig::default(), 40 * MIB);
        p.collected(40 * MIB, Duration::from_millis(5));
        assert_eq!(p.decide(61 * MIB, budget(4, 16)), IdleGcDecision::Defer);
        assert_eq!(p.decide(61 * MIB, budget(5, 16)), IdleGcDecision::Collect);
    }

    #[test]
    fn a_cost_longer_than_the_period_waits_for_a_light_tick() {
        let mut p = IdleGcPolicy::new(IdleGcConfig::default(), 40 * MIB);
        p.collected(40 * MIB, Duration::from_millis(30));
        // A tick that used more than half of its 16 ms period defers ...
        assert_eq!(p.decide(61 * MIB, budget(7, 16)), IdleGcDecision::Defer);
        // ... one that used at most half collects.
        assert_eq!(p.decide(61 * MIB, budget(8, 16)), IdleGcDecision::Collect);
    }

    #[test]
    fn deferral_is_capped() {
        let config = IdleGcConfig {
            max_defer: 3,
            ..IdleGcConfig::default()
        };
        let mut p = IdleGcPolicy::new(config, 40 * MIB);
        p.collected(40 * MIB, Duration::from_millis(5));
        for _ in 0..3 {
            assert_eq!(p.decide(61 * MIB, budget(0, 16)), IdleGcDecision::Defer);
        }
        assert_eq!(p.decide(61 * MIB, budget(0, 16)), IdleGcDecision::Collect);
        p.collected(41 * MIB, Duration::from_millis(5));
        assert_eq!(p.baseline(), 41 * MIB);
        // The counter restarts after a collection.
        assert_eq!(p.decide(62 * MIB, budget(0, 16)), IdleGcDecision::Defer);
    }

    #[test]
    fn dropping_below_the_soft_limit_resets_deferral() {
        let config = IdleGcConfig {
            max_defer: 2,
            ..IdleGcConfig::default()
        };
        let mut p = IdleGcPolicy::new(config, 40 * MIB);
        p.collected(40 * MIB, Duration::from_millis(5));
        assert_eq!(p.decide(61 * MIB, budget(0, 16)), IdleGcDecision::Defer);
        assert_eq!(p.decide(61 * MIB, budget(0, 16)), IdleGcDecision::Defer);
        // Reference counting freed enough; the pending request lapses.
        assert_eq!(p.decide(50 * MIB, budget(0, 16)), IdleGcDecision::Idle);
        assert_eq!(p.decide(61 * MIB, budget(0, 16)), IdleGcDecision::Defer);
    }

    #[test]
    fn a_forced_collection_rebases_and_keeps_the_cost_estimate() {
        let mut p = IdleGcPolicy::new(IdleGcConfig::default(), 40 * MIB);
        p.collected(40 * MIB, Duration::from_millis(30));
        p.rebased(20 * MIB);
        assert_eq!(p.baseline(), 20 * MIB);
        assert_eq!(p.soft_limit(), 30 * MIB);
        assert_eq!(p.decide(31 * MIB, budget(7, 16)), IdleGcDecision::Defer);
    }
}
