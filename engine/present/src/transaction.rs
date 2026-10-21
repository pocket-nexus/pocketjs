//! Prepare, commit, and abort for a persistent presentation target.

use crate::damage::{DamageError, DamagePlan, DamagePolicy, DamageTarget, DamageTracker};
use pocket_drivers::RenderResources;

/// Presentation configuration independent of the renderer and pixel format.
/// The signature identifies clear color, format, and other output facts.
#[derive(Clone, Copy, Debug)]
pub struct DamageTransaction {
    pub scale: u32,
    pub signature: u64,
    pub policy: DamagePolicy,
}

impl DamageTransaction {
    pub const fn new(scale: u32, signature: u64, policy: DamagePolicy) -> Self {
        Self {
            scale,
            signature,
            policy,
        }
    }

    pub fn target(&self, resources: &impl RenderResources) -> Option<DamageTarget> {
        let (viewport_width, viewport_height) = resources.viewport();
        let width = (viewport_width as u32).checked_mul(self.scale)?;
        let height = (viewport_height as u32).checked_mul(self.scale)?;
        if width == 0 || height == 0 {
            return None;
        }
        Some(DamageTarget::new(width, height, self.scale, self.signature))
    }

    /// Planning leaves the prior committed snapshot unchanged. The caller
    /// commits after all corresponding output updates complete, or aborts
    /// after a failed or partial update.
    pub fn prepare<const MAX_REGIONS: usize>(
        &self,
        tracker: &DamageTracker<MAX_REGIONS>,
        resources: &impl RenderResources,
        words: &[u32],
    ) -> Result<DamagePlan<MAX_REGIONS>, DamageError> {
        let target = self.target(resources).ok_or(DamageError::InvalidTarget)?;
        tracker
            .prepare(resources, words, target)?
            .with_policy(self.policy)
    }

    /// Record completed output. Invalid target dimensions discard history.
    pub fn commit<const MAX_REGIONS: usize>(
        &self,
        tracker: &mut DamageTracker<MAX_REGIONS>,
        resources: &impl RenderResources,
        words: &[u32],
    ) -> bool {
        let Some(target) = self.target(resources) else {
            tracker.invalidate();
            return false;
        };
        tracker.commit(resources, words, target);
        true
    }

    pub fn abort<const MAX_REGIONS: usize>(&self, tracker: &mut DamageTracker<MAX_REGIONS>) {
        tracker.invalidate();
    }

    /// Run synchronous rendering and presentation as one transaction. The
    /// callback returns Some only once its output update has completed.
    /// Asynchronous/strip hosts call prepare, render, and commit/abort themselves.
    pub fn run<const MAX_REGIONS: usize, T>(
        &self,
        tracker: &mut DamageTracker<MAX_REGIONS>,
        resources: &impl RenderResources,
        words: &[u32],
        render: impl FnOnce(&DamagePlan<MAX_REGIONS>) -> Option<T>,
    ) -> Option<T> {
        let damage = self.prepare(tracker, resources, words).ok()?;
        let result = render(&damage);
        if result.is_some() {
            if !self.commit(tracker, resources, words) {
                return None;
            }
        } else {
            self.abort(tracker);
        }
        result
    }
}
