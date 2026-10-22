//! inkview adapter for the shared e-ink refresh policy.

use std::time::Instant;

use inkview::screen::Screen;
use pocket_drivers::Rect;
use pocket_present::ink::{InkRefresh, InkTiming, InkUpdate};

use crate::framebuffer::DirtyRect;

pub struct Refresh {
    epoch: Instant,
    policy: InkRefresh,
}

impl Refresh {
    pub fn new() -> Self {
        Self {
            epoch: Instant::now(),
            policy: InkRefresh::new(InkTiming::default(), std::time::Duration::ZERO),
        }
    }

    fn apply(&mut self, screen: &mut Screen, update: InkUpdate) {
        match update {
            InkUpdate::Partial(r) => {
                screen.partial_update(r.x as i32, r.y as i32, r.width, r.height)
            }
            InkUpdate::Dynamic(r) => {
                screen.dynamic_update(r.x as i32, r.y as i32, r.width, r.height)
            }
            InkUpdate::Full => screen.full_update(),
        }
        self.policy.applied(update, self.epoch.elapsed());
    }

    /// Rectangles are in screen coordinates after the integer-fit offset.
    pub fn present(&mut self, screen: &mut Screen, dirty: &[DirtyRect]) {
        if let Some(update) = self.policy.poll_cleanup(self.epoch.elapsed()) {
            self.apply(screen, update);
        }
        if dirty.is_empty() {
            return;
        }
        // Recheck the panel after cleanup: the quality refresh may have
        // started an update. Only the platform owns this hardware observation.
        let busy = screen.is_updating();
        let damage = dirty
            .iter()
            .map(|r| Rect::new(r.x as u32, r.y as u32, r.w as u32, r.h as u32));
        if let Some(update) = self.policy.damage(self.epoch.elapsed(), busy, damage) {
            self.apply(screen, update);
        }
    }

    pub fn full(&mut self, screen: &mut Screen) {
        let update = self.policy.full(self.epoch.elapsed());
        self.apply(screen, update);
    }
}

impl Default for Refresh {
    fn default() -> Self {
        Self::new()
    }
}
