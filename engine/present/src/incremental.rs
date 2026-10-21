//! Damage planning and commit around synchronous software rasterization.

use crate::damage::{DamageError, DamagePlan, DamagePolicy, DamageTarget, DamageTracker};
use pocket_drivers::{DamageRect, RenderResources};

const DAMAGE_SIGNATURE_RGBA8: u64 = u32::from_be_bytes(*b"RGBA") as u64;
const DAMAGE_SIGNATURE_ARGB8: u64 = u32::from_be_bytes(*b"ARGB") as u64;
const DAMAGE_SIGNATURE_RGB565: u64 = u32::from_be_bytes(*b"R565") as u64;

/// Render RGBA8 using one tracker per persistent framebuffer.
pub fn render_scaled_incremental<const MAX_REGIONS: usize>(
    ui: &impl RenderResources,
    words: &[u32],
    fb: &mut [u8],
    scale: u32,
    tracker: &mut DamageTracker<MAX_REGIONS>,
    policy: DamagePolicy,
) -> Result<DamagePlan<MAX_REGIONS>, DamageError> {
    render_incremental(
        ui,
        words,
        fb.len() / 4,
        scale,
        tracker,
        policy,
        DAMAGE_SIGNATURE_RGBA8,
        |regions| pocket_raster::render_scaled_regions(ui, words, fb, scale, regions),
    )
}

/// ARGB/BGRA-memory equivalent of [`render_scaled_incremental`].
pub fn render_scaled_argb_incremental<const MAX_REGIONS: usize>(
    ui: &impl RenderResources,
    words: &[u32],
    fb: &mut [u8],
    scale: u32,
    tracker: &mut DamageTracker<MAX_REGIONS>,
    policy: DamagePolicy,
) -> Result<DamagePlan<MAX_REGIONS>, DamageError> {
    render_incremental(
        ui,
        words,
        fb.len() / 4,
        scale,
        tracker,
        policy,
        DAMAGE_SIGNATURE_ARGB8,
        |regions| pocket_raster::render_scaled_argb_regions(ui, words, fb, scale, regions),
    )
}

/// RGB565 equivalent of [`render_scaled_incremental`].
pub fn render_scaled_rgb565_incremental<const MAX_REGIONS: usize>(
    ui: &impl RenderResources,
    words: &[u32],
    fb: &mut [u16],
    scale: u32,
    tracker: &mut DamageTracker<MAX_REGIONS>,
    policy: DamagePolicy,
) -> Result<DamagePlan<MAX_REGIONS>, DamageError> {
    render_incremental(
        ui,
        words,
        fb.len(),
        scale,
        tracker,
        policy,
        DAMAGE_SIGNATURE_RGB565,
        |regions| pocket_raster::render_scaled_rgb565_regions(ui, words, fb, scale, regions),
    )
}

#[allow(clippy::too_many_arguments)]
fn render_incremental<const MAX_REGIONS: usize>(
    ui: &impl RenderResources,
    words: &[u32],
    pixel_count: usize,
    scale: u32,
    tracker: &mut DamageTracker<MAX_REGIONS>,
    policy: DamagePolicy,
    signature: u64,
    render: impl FnOnce(&[DamageRect]),
) -> Result<DamagePlan<MAX_REGIONS>, DamageError> {
    let (width, height) = pocket_raster::validate_framebuffer(ui, pixel_count, scale);
    let target = DamageTarget::new(width as u32, height as u32, scale, signature);
    let plan = tracker.prepare(ui, words, target)?.with_policy(policy)?;
    render(plan.regions());
    tracker.commit(ui, words, target);
    Ok(plan)
}
