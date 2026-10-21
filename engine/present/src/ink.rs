//! Allocation-free refresh scheduling for e-ink panels.
//!
//! The host supplies monotonic timestamps and the panel's busy state. Poll
//! cleanup before observing new damage: cleanup may change the panel's busy
//! state. After issuing an update, report its completion timestamp with
//! [`InkRefresh::applied`] so time spent in a platform call does not count
//! towards the next throttle interval. No framebuffer or panel handle is kept.

use core::time::Duration;
use pocket_drivers::Rect;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct InkTiming {
    /// Dynamic updates require elapsed time strictly greater than this value.
    pub dynamic_interval: Duration,
    /// Cleanup becomes due at this interval after the last busy damage.
    pub cleanup_quiet: Duration,
}

impl Default for InkTiming {
    fn default() -> Self {
        Self {
            dynamic_interval: Duration::from_millis(20),
            cleanup_quiet: Duration::from_millis(200),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InkUpdate {
    Partial(Rect),
    Dynamic(Rect),
    Full,
}

/// Coalesces busy-panel damage and schedules a final quality refresh.
pub struct InkRefresh {
    timing: InkTiming,
    last_draw: Duration,
    pending_cleanup: Option<Rect>,
    cleanup_after: Option<Duration>,
}

impl InkRefresh {
    pub const fn new(timing: InkTiming, now: Duration) -> Self {
        Self {
            timing,
            last_draw: now,
            pending_cleanup: None,
            cleanup_after: None,
        }
    }

    /// Return a due cleanup even when the panel still reports busy, matching
    /// partial-update hardware that queues a quality refresh behind its work.
    pub fn poll_cleanup(&mut self, now: Duration) -> Option<InkUpdate> {
        if self.cleanup_after.is_some_and(|deadline| now >= deadline) {
            self.cleanup_after = None;
            self.pending_cleanup.take().map(InkUpdate::Partial)
        } else {
            None
        }
    }

    /// Damage uses panel coordinates. Empty rectangles are ignored. While
    /// busy, damage accumulates until cleanup; throttling never loses it.
    pub fn damage(
        &mut self,
        now: Duration,
        panel_busy: bool,
        rects: impl IntoIterator<Item = Rect>,
    ) -> Option<InkUpdate> {
        let damage = rects
            .into_iter()
            .filter(|r| r.width != 0 && r.height != 0)
            .reduce(union)?;
        if panel_busy {
            let accumulated = self.pending_cleanup.map_or(damage, |r| union(r, damage));
            self.pending_cleanup = Some(accumulated);
            self.cleanup_after = Some(now.saturating_add(self.timing.cleanup_quiet));
            (now.saturating_sub(self.last_draw) > self.timing.dynamic_interval)
                .then_some(InkUpdate::Dynamic(accumulated))
        } else {
            // An idle partial does not discard older dynamic damage that
            // still needs its scheduled quality cleanup.
            Some(InkUpdate::Partial(damage))
        }
    }

    /// Record when the platform update call returned. Dynamic work restarts
    /// the quiet period; a partial preserves an existing cleanup deadline.
    pub fn applied(&mut self, update: InkUpdate, now: Duration) {
        self.last_draw = now;
        match update {
            InkUpdate::Dynamic(_) if self.pending_cleanup.is_some() => {
                self.cleanup_after = Some(now.saturating_add(self.timing.cleanup_quiet));
            }
            InkUpdate::Full => self.reset(now),
            _ => {}
        }
    }

    /// Discard old damage after a screen/mode reset or a full flashing update.
    pub fn reset(&mut self, now: Duration) {
        self.last_draw = now;
        self.pending_cleanup = None;
        self.cleanup_after = None;
    }

    pub fn full(&mut self, now: Duration) -> InkUpdate {
        self.reset(now);
        InkUpdate::Full
    }
}

fn union(a: Rect, b: Rect) -> Rect {
    let x = a.x.min(b.x);
    let y = a.y.min(b.y);
    let right = a.x.saturating_add(a.width).max(b.x.saturating_add(b.width));
    let bottom =
        a.y.saturating_add(a.height)
            .max(b.y.saturating_add(b.height));
    Rect::new(x, y, right - x, bottom - y)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn ms(n: u64) -> Duration {
        Duration::from_millis(n)
    }
    fn policy() -> InkRefresh {
        InkRefresh::new(InkTiming::default(), Duration::ZERO)
    }
    fn r(x: u32, y: u32, w: u32, h: u32) -> Rect {
        Rect::new(x, y, w, h)
    }

    #[test]
    fn busy_damage_merges_across_strict_throttle_boundary() {
        let mut p = policy();
        assert_eq!(p.damage(ms(10), true, [r(3, 4, 5, 6)]), None);
        assert_eq!(p.damage(ms(20), true, [r(0, 2, 3, 2)]), None);
        let later = ms(20) + Duration::from_nanos(1);
        let update = InkUpdate::Dynamic(r(0, 2, 8, 8));
        assert_eq!(p.damage(later, true, [r(6, 5, 1, 1)]), Some(update));
        p.applied(update, ms(25));
        assert_eq!(p.damage(ms(45), true, [r(2, 2, 1, 1)]), None);
        assert_eq!(p.poll_cleanup(ms(244)), None);
        assert_eq!(
            p.poll_cleanup(ms(245)),
            Some(InkUpdate::Partial(r(0, 2, 8, 8)))
        );
        assert_eq!(p.poll_cleanup(ms(500)), None);
    }

    #[test]
    fn cleanup_is_due_at_exact_quiet_deadline_without_new_damage() {
        let mut p = policy();
        assert_eq!(p.damage(ms(1), true, [r(2, 3, 4, 5)]), None);
        assert_eq!(p.damage(ms(100), true, []), None);
        assert_eq!(p.poll_cleanup(ms(200)), None);
        assert_eq!(
            p.poll_cleanup(ms(201)),
            Some(InkUpdate::Partial(r(2, 3, 4, 5)))
        );
    }

    #[test]
    fn cleanup_precedes_new_damage_and_idle_partial_preserves_pending_cleanup() {
        let mut p = policy();
        p.damage(ms(1), true, [r(0, 0, 8, 8)]);
        let idle = InkUpdate::Partial(r(40, 40, 2, 2));
        assert_eq!(p.damage(ms(10), false, [r(40, 40, 2, 2)]), Some(idle));
        p.applied(idle, ms(12));
        let cleanup = p.poll_cleanup(ms(201)).unwrap();
        assert_eq!(cleanup, InkUpdate::Partial(r(0, 0, 8, 8)));
        p.applied(cleanup, ms(205));
        // The host rechecks busy after the cleanup call, so new damage is
        // queued without immediately issuing another dynamic update.
        assert_eq!(p.damage(ms(205), true, [r(4, 4, 2, 2)]), None);
        assert_eq!(
            p.poll_cleanup(ms(405)),
            Some(InkUpdate::Partial(r(4, 4, 2, 2)))
        );
    }

    #[test]
    fn full_and_reset_discard_pending_damage() {
        let mut p = policy();
        p.damage(ms(1), true, [r(1, 1, 1, 1)]);
        assert_eq!(p.full(ms(2)), InkUpdate::Full);
        p.applied(InkUpdate::Full, ms(5));
        assert_eq!(p.poll_cleanup(ms(500)), None);
        assert_eq!(p.damage(ms(25), true, [r(20, 20, 2, 2)]), None);
        p.reset(ms(30));
        assert_eq!(p.poll_cleanup(ms(1000)), None);
    }

    #[test]
    fn configurable_thresholds_and_blocking_update_time() {
        let mut p = InkRefresh::new(
            InkTiming {
                dynamic_interval: ms(3),
                cleanup_quiet: ms(7),
            },
            Duration::ZERO,
        );
        let u = p.damage(ms(4), true, [r(1, 1, 1, 1)]).unwrap();
        p.applied(u, ms(10));
        assert_eq!(p.poll_cleanup(ms(16)), None);
        assert_eq!(
            p.poll_cleanup(ms(17)),
            Some(InkUpdate::Partial(r(1, 1, 1, 1)))
        );
    }

    #[test]
    fn empty_rectangles_and_clock_or_coordinate_extremes_do_not_overflow() {
        let mut p = policy();
        assert_eq!(p.damage(ms(5), true, [r(1, 1, 0, 4)]), None);
        assert_eq!(p.poll_cleanup(Duration::MAX), None);
        assert!(p
            .damage(
                Duration::MAX,
                true,
                [r(u32::MAX - 1, 0, 8, 2), r(0, 0, 1, 1)]
            )
            .is_some());
        assert!(p.poll_cleanup(Duration::MAX).is_some());
        p.reset(ms(100));
        assert_eq!(p.damage(ms(10), true, [r(0, 0, 1, 1)]), None);
    }
}
