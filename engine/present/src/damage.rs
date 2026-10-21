//! Backend-independent DrawList damage tracking.
//!
//! A [`DamageTracker`] snapshots the DrawList whose pixels currently live in
//! one persistent render target. On the next frame it compares operations in
//! order, adds both the old and new conservative bounds for changed
//! operations, and returns a small set of disjoint rectangles. Backends must
//! clear each returned rectangle and replay the complete current DrawList
//! clipped to that rectangle so painter order and translucent overlays remain
//! correct.
//!
//! Keep one tracker per physical framebuffer. Core-managed texture, font and
//! style mutations are detected through [`RenderResources::raster_revision`]. Hosts must
//! still call [`DamageTracker::invalidate`] for output-affecting mutations
//! performed outside `Ui`.

use pocket_drivers::RenderResources;
use alloc::vec::Vec;

use pocket_spec as spec;


/// Default fixed capacity used by the generic software rasterizer.
pub const DEFAULT_DAMAGE_REGIONS: usize = 8;

/// Failure to plan damage for a persistent target.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum DamageError {
    InvalidCapacity,
    InvalidPolicy,
    InvalidTarget,
    MalformedDrawList,
}

pub use pocket_drivers::DamageRect;

/// Backend policy for promoting accumulated damage to a full redraw.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DamagePolicy {
    /// Promote when damaged area reaches this percentage of the viewport.
    /// Valid values are 1 through 100.
    pub full_redraw_percent: u8,
}

impl DamagePolicy {
    pub const fn new(full_redraw_percent: u8) -> Self {
        Self {
            full_redraw_percent,
        }
    }

    fn is_valid(self) -> bool {
        (1..=100).contains(&self.full_redraw_percent)
    }
}

impl Default for DamagePolicy {
    fn default() -> Self {
        Self::new(75)
    }
}

/// Physical target identity used to decide when retained pixels are reusable.
///
/// `signature` is backend-defined and must change when pixel format, clear
/// color, sampling contract, or any other output-affecting configuration
/// changes without changing dimensions.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct DamageTarget {
    pub width: u32,
    pub height: u32,
    pub scale: u32,
    pub signature: u64,
}

impl DamageTarget {
    pub const fn new(width: u32, height: u32, scale: u32, signature: u64) -> Self {
        Self {
            width,
            height,
            scale,
            signature,
        }
    }
}

/// Damage decision for one frame.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DamagePlan<const MAX_REGIONS: usize = DEFAULT_DAMAGE_REGIONS> {
    rects: [DamageRect; MAX_REGIONS],
    len: usize,
    full_redraw: bool,
    screen: DamageRect,
}

impl<const MAX_REGIONS: usize> DamagePlan<MAX_REGIONS> {
    const fn empty(screen: DamageRect) -> Self {
        Self {
            rects: [DamageRect::empty(); MAX_REGIONS],
            len: 0,
            full_redraw: false,
            screen,
        }
    }

    /// Construct a complete redraw plan for `screen`.
    pub fn full(screen: DamageRect) -> Self {
        let mut damage = Self::empty(screen);
        if MAX_REGIONS > 0 && !screen.is_empty() {
            damage.rects[0] = screen;
            damage.len = 1;
        }
        damage.full_redraw = true;
        damage
    }

    /// Disjoint logical rectangles that must be repainted.
    pub fn regions(&self) -> &[DamageRect] {
        &self.rects[..self.len]
    }

    pub fn region_count(&self) -> usize {
        self.len
    }

    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    pub fn area(&self) -> u64 {
        self.regions().iter().map(|rect| rect.area()).sum()
    }

    pub fn bounds(&self) -> DamageRect {
        self.regions()
            .iter()
            .copied()
            .fold(DamageRect::empty(), DamageRect::union)
    }

    pub fn is_full_redraw(&self) -> bool {
        self.full_redraw
    }

    /// Apply a backend-selected full-redraw threshold.
    pub fn with_policy(mut self, policy: DamagePolicy) -> Result<Self, DamageError> {
        if !policy.is_valid() {
            return Err(DamageError::InvalidPolicy);
        }
        if !self.full_redraw && self.should_promote_to_full(self.screen, policy) {
            self = Self::full(self.screen);
        }
        Ok(self)
    }

    fn should_promote_to_full(&self, screen: DamageRect, policy: DamagePolicy) -> bool {
        let screen_area = screen.area();
        !self.is_empty()
            && screen_area > 0
            && self.area().saturating_mul(100)
                >= screen_area.saturating_mul(policy.full_redraw_percent as u64)
    }

    fn add(&mut self, rect: DamageRect, screen: DamageRect) {
        let mut merged = rect.intersect(screen);
        if merged.is_empty() {
            return;
        }

        let mut index = 0usize;
        while index < self.len {
            if merged.touches(self.rects[index]) {
                merged = merged.union(self.rects[index]);
                self.remove(index);
                index = 0;
            } else {
                index += 1;
            }
        }

        if self.len < MAX_REGIONS {
            self.rects[self.len] = merged;
            self.len += 1;
            return;
        }

        let mut best = 0usize;
        let mut best_inflation = u64::MAX;
        for (candidate, &existing) in self.regions().iter().enumerate() {
            let union = existing.union(merged);
            let inflation = union
                .area()
                .saturating_sub(existing.area())
                .saturating_sub(merged.area());
            if inflation < best_inflation {
                best = candidate;
                best_inflation = inflation;
            }
        }
        merged = merged.union(self.rects[best]);
        self.remove(best);
        self.add(merged, screen);
    }

    fn remove(&mut self, index: usize) {
        self.len -= 1;
        self.rects[index] = self.rects[self.len];
        self.rects[self.len] = DamageRect::empty();
    }
}

/// DrawList snapshot associated with one persistent render target.
pub struct DamageTracker<const MAX_REGIONS: usize = DEFAULT_DAMAGE_REGIONS> {
    words: Vec<u32>,
    target: DamageTarget,
    raster_revision: u64,
    valid: bool,
}

impl<const MAX_REGIONS: usize> DamageTracker<MAX_REGIONS> {
    pub const fn new() -> Self {
        Self {
            words: Vec::new(),
            target: DamageTarget::new(0, 0, 0, 0),
            raster_revision: 0,
            valid: false,
        }
    }

    /// Force the next frame to repaint the complete target.
    pub fn invalidate(&mut self) {
        self.valid = false;
    }

    /// Compute damage without modifying the stored snapshot.
    ///
    /// Call [`commit`](Self::commit) only after the returned regions have
    /// successfully been rendered.
    pub fn prepare(
        &self,
        ui: &impl RenderResources,
        words: &[u32],
        target: DamageTarget,
    ) -> Result<DamagePlan<MAX_REGIONS>, DamageError> {
        if MAX_REGIONS == 0 {
            return Err(DamageError::InvalidCapacity);
        }
        if target.scale == 0 {
            return Err(DamageError::InvalidTarget);
        }
        let screen = target_screen(ui, target)?;
        let full_redraw =
            !self.valid || self.target != target || self.raster_revision != ui.raster_revision();
        let damage = if full_redraw {
            validate_draw_list(ui, words, screen)?;
            DamagePlan::full(screen)
        } else {
            draw_list_damage(ui, &self.words, words, screen)?
        };
        Ok(damage)
    }

    /// Record the DrawList after its [`DamagePlan`] has been rendered.
    pub fn commit(&mut self, ui: &impl RenderResources, words: &[u32], target: DamageTarget) {
        if self.words != words {
            self.words.clear();
            self.words.extend_from_slice(words);
        }
        self.target = target;
        self.raster_revision = ui.raster_revision();
        self.valid = true;
    }
}

impl<const MAX_REGIONS: usize> Default for DamageTracker<MAX_REGIONS> {
    fn default() -> Self {
        Self::new()
    }
}

fn target_screen(
    ui: &impl RenderResources,
    target: DamageTarget,
) -> Result<DamageRect, DamageError> {
    let (viewport_width, viewport_height) = ui.viewport();
    if viewport_width <= 0.0 || viewport_height <= 0.0 {
        return Err(DamageError::InvalidTarget);
    }
    let logical_width = viewport_width as u32;
    let logical_height = viewport_height as u32;
    if logical_width
        .checked_mul(target.scale)
        .ok_or(DamageError::InvalidTarget)?
        != target.width
        || logical_height
            .checked_mul(target.scale)
            .ok_or(DamageError::InvalidTarget)?
            != target.height
    {
        return Err(DamageError::InvalidTarget);
    }
    Ok(DamageRect::new(
        0,
        0,
        logical_width as i32,
        logical_height as i32,
    ))
}

struct DecodedOp<'a> {
    code: u32,
    words: &'a [u32],
    bounds: DamageRect,
}

struct DamageDecoder<'a> {
    operations: pocket_draw_ops::DrawOps<'a>,
}

impl<'a> DamageDecoder<'a> {
    fn new(words: &'a [u32], screen: DamageRect) -> Self {
        Self { operations: pocket_draw_ops::DrawOps::new(words, screen) }
    }

    fn next(&mut self, ui: &impl RenderResources) -> Result<Option<DecodedOp<'a>>, ()> {
        let Some(operation) = self.operations.next().transpose().map_err(|_| ())? else {
            return Ok(None);
        };
        let code = operation.opcode;
        let words = operation.words;
        let clip = operation.clip;
        let bounds = match code {
            spec::draw_op::RECT | spec::draw_op::GRAD_RECT => {
                logical_rect(words[1], words[2]).intersect(clip)
            }
            spec::draw_op::GLYPH_RUN => glyph_run_bounds(ui, words, clip),
            spec::draw_op::TEX_QUAD => logical_rect(words[2], words[3]).intersect(clip),
            spec::draw_op::SCISSOR => clip,
            spec::draw_op::SCISSOR_POP => DamageRect::empty(),
            spec::draw_op::TRI => triangle_bounds([words[1], words[2], words[3]], clip),
            spec::draw_op::TEX_TRI => triangle_bounds([words[2], words[5], words[8]], clip),
            // Native text has no glyph geometry here. Its current clip is a
            // conservative bound for damage tracking.
            spec::draw_op::TEXT_RUN => clip,
            spec::draw_op::SURFACE_QUAD => logical_rect(words[6], words[7]).intersect(clip),
            _ => return Err(()),
        };
        Ok(Some(DecodedOp { code, words, bounds }))
    }
}

fn draw_list_damage<const MAX_REGIONS: usize>(
    ui: &impl RenderResources,
    previous: &[u32],
    current: &[u32],
    screen: DamageRect,
) -> Result<DamagePlan<MAX_REGIONS>, DamageError> {
    if previous == current {
        return Ok(DamagePlan::empty(screen));
    }

    let mut old = DamageDecoder::new(previous, screen);
    let mut new = DamageDecoder::new(current, screen);
    let mut damage = DamagePlan::empty(screen);
    loop {
        let old_op = old.next(ui).map_err(|_| DamageError::MalformedDrawList)?;
        let new_op = new.next(ui).map_err(|_| DamageError::MalformedDrawList)?;
        match (old_op, new_op) {
            (None, None) => break,
            (Some(old_op), Some(new_op)) if old_op.code == new_op.code => {
                if old_op.words != new_op.words {
                    damage.add(old_op.bounds, screen);
                    damage.add(new_op.bounds, screen);
                }
            }
            _ => return Ok(DamagePlan::full(screen)),
        }
    }
    Ok(damage)
}

fn validate_draw_list(
    ui: &impl RenderResources,
    words: &[u32],
    screen: DamageRect,
) -> Result<(), DamageError> {
    let mut decoder = DamageDecoder::new(words, screen);
    while decoder
        .next(ui)
        .map_err(|_| DamageError::MalformedDrawList)?
        .is_some()
    {}
    Ok(())
}

fn glyph_run_bounds(ui: &impl RenderResources, words: &[u32], clip: DamageRect) -> DamageRect {
    if words.len() < 3 || words[2] >> 24 == 0 {
        return DamageRect::empty();
    }
    let slot = (words[1] & 0xff) as u8;
    let Some(atlas) = ui.font_atlas(slot) else {
        return DamageRect::empty();
    };
    let mut bounds = DamageRect::empty();
    for glyph in words[3..].chunks_exact(2) {
        let gid = (glyph[1] & 0xffff) as u16;
        if gid >= atlas.glyph_count {
            continue;
        }
        let (x, y) = xy(glyph[0]);
        bounds = bounds.union(DamageRect::new(
            x,
            y,
            x + atlas.cell_w as i32,
            y + atlas.cell_h as i32,
        ));
    }
    bounds.intersect(clip)
}

fn triangle_bounds(vertices: [u32; 3], clip: DamageRect) -> DamageRect {
    let [(x0, y0), (x1, y1), (x2, y2)] = vertices.map(xy);
    DamageRect::new(
        x0.min(x1).min(x2),
        y0.min(y1).min(y2),
        x0.max(x1).max(x2),
        y0.max(y1).max(y2),
    )
    .intersect(clip)
}

#[inline]
fn xy(word: u32) -> (i32, i32) {
    (
        (word & 0xffff) as u16 as i16 as i32,
        (word >> 16) as u16 as i16 as i32,
    )
}

use pocket_draw_ops::logical_rect;
