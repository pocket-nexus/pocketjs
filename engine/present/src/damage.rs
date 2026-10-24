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
//!
//! [`DamageTracker::prepare_with_motion`] also looks for content that only
//! moved. When operations repeat with every position shifted by one offset
//! and an opaque one among them covers a rectangle that nothing else
//! paints over, the plan carries a [`DamageMotion`]: the display moves those
//! retained pixels first, then the renderer repaints the remaining regions.

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

/// Retained pixels a frame reuses by moving them. Every pixel of
/// `destination` equals the previous frame's pixel at `(-dx, -dy)` from it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DamageMotion {
    pub destination: DamageRect,
    pub dx: i32,
    pub dy: i32,
}

impl DamageMotion {
    /// The rectangle of the previous frame whose pixels move.
    pub fn source(&self) -> DamageRect {
        self.destination.offset(-self.dx, -self.dy)
    }
}

/// Damage decision for one frame.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DamagePlan<const MAX_REGIONS: usize = DEFAULT_DAMAGE_REGIONS> {
    rects: [DamageRect; MAX_REGIONS],
    len: usize,
    full_redraw: bool,
    screen: DamageRect,
    motion: Option<DamageMotion>,
}

impl<const MAX_REGIONS: usize> DamagePlan<MAX_REGIONS> {
    const fn empty(screen: DamageRect) -> Self {
        Self {
            rects: [DamageRect::empty(); MAX_REGIONS],
            len: 0,
            full_redraw: false,
            screen,
            motion: None,
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

    /// Pixels to move before repainting [`regions`](Self::regions). Only
    /// [`DamageTracker::prepare_with_motion`] produces one.
    pub fn motion(&self) -> Option<DamageMotion> {
        self.motion
    }

    /// Repaint `rect` (logical pixels) as well: a region the display asks
    /// for, or a declined move's destination.
    pub fn add_region(&mut self, rect: DamageRect) {
        let screen = self.screen;
        self.add(rect, screen);
    }

    /// Drop the plan's move: its destination is repainted instead.
    pub fn repaint_motion(&mut self) {
        if let Some(motion) = self.motion.take() {
            self.add_region(motion.destination);
        }
    }

    /// Apply a backend-selected full-redraw threshold. A plan that moves
    /// pixels keeps them: promoting it would repaint the moved content.
    pub fn with_policy(mut self, policy: DamagePolicy) -> Result<Self, DamageError> {
        if !policy.is_valid() {
            return Err(DamageError::InvalidPolicy);
        }
        if !self.full_redraw
            && self.motion.is_none()
            && self.should_promote_to_full(self.screen, policy)
        {
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
    resource_revision: u64,
    /// Textures `words` samples, each with the content revision it had when
    /// committed: a texture overwritten in place repaints the ops drawing it.
    textures: Vec<(i32, u64)>,
    valid: bool,
    /// Decoded operations of `words`, when `ops_valid`.
    ops: Vec<MotionOp>,
    ops_valid: bool,
    /// The list [`prepare_with_motion`](Self::prepare_with_motion) decoded
    /// last, adopted by a [`commit`](Self::commit) of the same words.
    pending_words: Vec<u32>,
    pending_ops: Vec<MotionOp>,
    pending: bool,
    /// Working storage of the motion planner, kept between frames.
    scratch: MotionScratch,
}

/// Buffers the motion planner refills every frame.
struct MotionScratch {
    pairs: Vec<OpPair>,
    covers: Vec<(usize, DamageRect)>,
    obstacles: Vec<(usize, DamageRect)>,
}

impl<const MAX_REGIONS: usize> DamageTracker<MAX_REGIONS> {
    pub const fn new() -> Self {
        Self {
            words: Vec::new(),
            target: DamageTarget::new(0, 0, 0, 0),
            raster_revision: 0,
            resource_revision: 0,
            textures: Vec::new(),
            valid: false,
            ops: Vec::new(),
            ops_valid: false,
            pending_words: Vec::new(),
            pending_ops: Vec::new(),
            pending: false,
            scratch: MotionScratch {
                pairs: Vec::new(),
                covers: Vec::new(),
                obstacles: Vec::new(),
            },
        }
    }

    /// Force the next frame to repaint the complete target.
    pub fn invalidate(&mut self) {
        self.valid = false;
        self.pending = false;
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
        let Some(updated) = self.updated_textures(ui, target) else {
            validate_draw_list(ui, words, screen)?;
            return Ok(DamagePlan::full(screen));
        };
        let mut damage = draw_list_damage(ui, &self.words, words, screen)?;
        if !updated.is_empty() {
            let mut decoder = DamageDecoder::new(words, screen);
            while let Some(op) = decoder.next(ui).map_err(|_| DamageError::MalformedDrawList)? {
                if sampled_texture(op.code, op.words).is_some_and(|handle| updated.contains(&handle)) {
                    damage.add(op.bounds, screen);
                }
            }
        }
        Ok(damage)
    }

    /// Handles of committed textures whose pixels were overwritten in place
    /// since the commit, or None when the target must be repainted whole:
    /// no valid snapshot, another target, other resources changed, or a
    /// texture revision the resources do not report.
    fn updated_textures(&self, ui: &impl RenderResources, target: DamageTarget) -> Option<Vec<i32>> {
        if !self.valid || self.target != target || self.resource_revision != ui.resource_revision() {
            return None;
        }
        let mut updated = Vec::new();
        if self.raster_revision != ui.raster_revision() {
            for &(handle, revision) in &self.textures {
                if ui.texture_revision(handle)? != revision {
                    updated.push(handle);
                }
            }
        }
        Some(updated)
    }

    /// [`prepare`](Self::prepare) that may also return a [`DamageMotion`].
    /// The caller must move the motion's pixels before repainting regions.
    /// The snapshot is unchanged; the decoded list is kept for the
    /// [`commit`](Self::commit) that records it.
    pub fn prepare_with_motion(
        &mut self,
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
        let updated = self.updated_textures(ui, target);
        let full = updated.is_none();
        let updated = updated.unwrap_or_default();
        if !full && updated.is_empty() && same_words(&self.words, words) {
            return Ok(DamagePlan::empty(screen));
        }
        // The pending buffers hold nothing worth keeping until this returns.
        self.pending = false;
        decode_ops_into(ui, words, screen, &mut self.pending_ops)?;
        let plan = if full {
            DamagePlan::full(screen)
        } else {
            if !self.ops_valid {
                decode_ops_into(ui, &self.words, screen, &mut self.ops)?;
                self.ops_valid = true;
            }
            let mut plan = motion_damage(
                &self.words,
                &self.ops,
                words,
                &self.pending_ops,
                screen,
                &mut self.scratch,
            );
            for op in &self.pending_ops {
                if sampled_texture(op.code, &words[op.start..op.end])
                    .is_some_and(|handle| updated.contains(&handle))
                {
                    plan.add(op.bounds, screen);
                }
            }
            plan
        };
        self.pending_words.clear();
        self.pending_words.extend_from_slice(words);
        self.pending = true;
        Ok(plan)
    }

    /// Record the DrawList after its [`DamagePlan`] has been rendered.
    pub fn commit(&mut self, ui: &impl RenderResources, words: &[u32], target: DamageTarget) {
        if !same_words(&self.words, words) {
            if self.pending && same_words(&self.pending_words, words) {
                core::mem::swap(&mut self.words, &mut self.pending_words);
                core::mem::swap(&mut self.ops, &mut self.pending_ops);
                self.ops_valid = true;
            } else {
                self.words.clear();
                self.words.extend_from_slice(words);
                self.ops_valid = false;
            }
        }
        self.pending = false;
        self.target = target;
        self.raster_revision = ui.raster_revision();
        self.resource_revision = ui.resource_revision();
        self.valid = true;
        self.textures.clear();
        let Ok(screen) = target_screen(ui, target) else { return };
        let mut decoder = DamageDecoder::new(&self.words, screen);
        while let Ok(Some(op)) = decoder.next(ui) {
            let Some(handle) = sampled_texture(op.code, op.words) else { continue };
            if self.textures.iter().any(|&(known, _)| known == handle) {
                continue;
            }
            // Resources without texture revisions report every content
            // change through resource_revision instead.
            if let Some(revision) = ui.texture_revision(handle) {
                self.textures.push((handle, revision));
            }
        }
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
    if same_words(previous, current) {
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
                if !same_words(old_op.words, new_op.words) {
                    damage.add(old_op.bounds, screen);
                    damage.add(new_op.bounds, screen);
                }
            }
            _ => return Ok(DamagePlan::full(screen)),
        }
    }
    Ok(damage)
}

/// The texture an operation samples.
fn sampled_texture(code: u32, words: &[u32]) -> Option<i32> {
    match code {
        spec::draw_op::TEX_QUAD | spec::draw_op::TEX_TRI => words.get(1).map(|&handle| handle as i32),
        _ => None,
    }
}

/// Word-by-word equality. Comparing eight words at a time with XOR keeps
/// short operations inline instead of a `memcmp` call per operation.
#[inline]
fn same_words(a: &[u32], b: &[u32]) -> bool {
    a.len() == b.len()
        && a.chunks(8)
            .zip(b.chunks(8))
            .all(|(x, y)| x.iter().zip(y).fold(0, |diff, (p, q)| diff | (p ^ q)) == 0)
}

/// One decoded operation of a DrawList: its word range and clipped bounds.
#[derive(Clone, Copy)]
struct MotionOp {
    code: u32,
    start: usize,
    end: usize,
    bounds: DamageRect,
}

/// How an operation of the current list relates to the previous one.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Relation {
    Same,
    /// Identical words except every position shifted by (dx, dy).
    Moved(i16, i16),
    Changed,
}

/// Operation index meaning "absent from this list" in an [`OpPair`].
const NO_OP: u32 = u32::MAX;

/// One step of the alignment: an operation of each list, or of one list
/// when it appeared or disappeared.
#[derive(Clone, Copy)]
struct OpPair {
    old: u32,
    new: u32,
    relation: Relation,
}

impl OpPair {
    fn new(old: Option<usize>, new: Option<usize>, relation: Relation) -> Self {
        let index = |op: Option<usize>| op.map_or(NO_OP, |op| op as u32);
        Self { old: index(old), new: index(new), relation }
    }

    fn old(&self) -> Option<usize> {
        (self.old != NO_OP).then_some(self.old as usize)
    }

    fn new_op(&self) -> Option<usize> {
        (self.new != NO_OP).then_some(self.new as usize)
    }
}

/// Operations searched ahead for a match after an insertion or removal.
const RESYNC_WINDOW: usize = 128;
/// Smallest destination worth a move, in logical pixels.
const MIN_MOTION_AREA: u64 = 1024;
/// Opaque covers evaluated per candidate offset, largest first.
const MAX_COVERS: usize = 16;

/// Decode `words` into `ops`, reusing its allocation.
fn decode_ops_into(
    ui: &impl RenderResources,
    words: &[u32],
    screen: DamageRect,
    ops: &mut Vec<MotionOp>,
) -> Result<(), DamageError> {
    let mut decoder = DamageDecoder::new(words, screen);
    ops.clear();
    let mut start = 0usize;
    while let Some(op) = decoder.next(ui).map_err(|_| DamageError::MalformedDrawList)? {
        let end = start + op.words.len();
        ops.push(MotionOp {
            code: op.code,
            start,
            end,
            bounds: op.bounds,
        });
        start = end;
    }
    Ok(())
}

fn shift(old: u32, new: u32) -> (i32, i32) {
    let (ox, oy) = xy(old);
    let (nx, ny) = xy(new);
    (nx - ox, ny - oy)
}

/// The common offset of `new` from `old`, zero when the words are equal,
/// when the words differ only by positions shifted together. One pass over
/// the words.
fn translation(code: u32, old: &[u32], new: &[u32]) -> Option<(i32, i32)> {
    if old.len() != new.len() {
        return None;
    }
    match code {
        spec::draw_op::RECT | spec::draw_op::GRAD_RECT => {
            same_words(&old[2..], &new[2..]).then(|| shift(old[1], new[1]))
        }
        spec::draw_op::TEX_QUAD => {
            (old[1] == new[1] && same_words(&old[3..], &new[3..])).then(|| shift(old[2], new[2]))
        }
        spec::draw_op::SCISSOR => (old[2] == new[2]).then(|| shift(old[1], new[1])),
        spec::draw_op::TRI => {
            let d = shift(old[1], new[1]);
            (same_words(&old[4..], &new[4..]) && shift(old[2], new[2]) == d && shift(old[3], new[3]) == d)
                .then_some(d)
        }
        spec::draw_op::GLYPH_RUN if old.len() >= 5 => {
            if !same_words(&old[1..3], &new[1..3]) {
                return None;
            }
            let d = shift(old[3], new[3]);
            let glyphs = old[3..].as_chunks::<2>().0.iter().zip(new[3..].as_chunks::<2>().0);
            for (a, b) in glyphs {
                if a[1] != b[1] || shift(a[0], b[0]) != d {
                    return None;
                }
            }
            Some(d)
        }
        _ => same_words(old, new).then_some((0, 0)),
    }
}

fn relate(previous: &[u32], old: &MotionOp, current: &[u32], new: &MotionOp) -> Relation {
    let a = &previous[old.start..old.end];
    let b = &current[new.start..new.end];
    match translation(old.code, a, b) {
        Some((0, 0)) => Relation::Same,
        Some((dx, dy)) => match (i16::try_from(dx), i16::try_from(dy)) {
            (Ok(dx), Ok(dy)) => Relation::Moved(dx, dy),
            _ => Relation::Changed,
        },
        None => Relation::Changed,
    }
}

/// Whether a pair's relation continues the latest motion: unchanged, or
/// moved by the same offset (any offset before the first move).
fn continues(relation: Relation, offset: Option<(i16, i16)>) -> bool {
    match relation {
        Relation::Same => true,
        Relation::Moved(dx, dy) => offset.is_none_or(|offset| offset == (dx, dy)),
        Relation::Changed => false,
    }
}

/// Pair operations in painter order, resynchronizing across operations that
/// appear or disappear (content entering or leaving a clip). Repeated
/// content (a row of identical keys) also matches its neighbor moved by one
/// item, so a pair that breaks the latest offset first looks for a resync
/// that keeps it.
fn align_into(previous: &[u32], old: &[MotionOp], current: &[u32], new: &[MotionOp], pairs: &mut Vec<OpPair>) {
    pairs.clear();
    let (mut i, mut j) = (0usize, 0usize);
    let mut offset = None;
    while i < old.len() || j < new.len() {
        if i == old.len() {
            pairs.push(OpPair::new(None, Some(j), Relation::Changed));
            j += 1;
            continue;
        }
        if j == new.len() {
            pairs.push(OpPair::new(Some(i), None, Relation::Changed));
            i += 1;
            continue;
        }
        let same_code = old[i].code == new[j].code;
        let relation = if same_code {
            relate(previous, &old[i], current, &new[j])
        } else {
            Relation::Changed
        };
        if continues(relation, offset) {
            if let Relation::Moved(dx, dy) = relation {
                offset = Some((dx, dy));
            }
            pairs.push(OpPair::new(Some(i), Some(j), relation));
            i += 1;
            j += 1;
            continue;
        }
        // Same-code edits look one operation ahead; code mismatches and
        // moves by another offset search the whole window.
        let window = if same_code && relation == Relation::Changed { 1 } else { RESYNC_WINDOW };
        let strong = |i: usize, j: usize| {
            old[i].code == new[j].code && continues(relate(previous, &old[i], current, &new[j]), offset)
        };
        // The nearest resync wins; an insertion wins a tie.
        let resync = (1..=window).find_map(|k| {
            if j + k < new.len() && strong(i, j + k) {
                Some((0, k))
            } else if i + k < old.len() && strong(i + k, j) {
                Some((k, 0))
            } else {
                None
            }
        });
        match resync {
            Some((0, k)) => {
                for t in j..j + k {
                    pairs.push(OpPair::new(None, Some(t), Relation::Changed));
                }
                j += k;
            }
            Some((k, _)) => {
                for t in i..i + k {
                    pairs.push(OpPair::new(Some(t), None, Relation::Changed));
                }
                i += k;
            }
            None => {
                // A move by another offset starts a new motion.
                if let Relation::Moved(dx, dy) = relation {
                    offset = Some((dx, dy));
                }
                pairs.push(OpPair::new(Some(i), Some(j), relation));
                i += 1;
                j += 1;
            }
        }
    }
}

/// The largest part of `rect` outside `obstacle`.
fn cut(rect: DamageRect, obstacle: DamageRect) -> DamageRect {
    if rect.intersect(obstacle).is_empty() {
        return rect;
    }
    [
        DamageRect::new(rect.x0, rect.y0, rect.x1, obstacle.y0.min(rect.y1)),
        DamageRect::new(rect.x0, obstacle.y1.max(rect.y0), rect.x1, rect.y1),
        DamageRect::new(rect.x0, rect.y0, obstacle.x0.min(rect.x1), rect.y1),
        DamageRect::new(obstacle.x1.max(rect.x0), rect.y0, rect.x1, rect.y1),
    ]
    .into_iter()
    .max_by_key(|piece| piece.area())
    .unwrap_or(DamageRect::empty())
}


/// RECT or GRAD_RECT that paints every pixel of its bounds opaquely.
fn opaque_cover(words: &[u32], op: &MotionOp) -> bool {
    let w = &words[op.start..op.end];
    match op.code {
        spec::draw_op::RECT => w[3] >> 24 == 255,
        spec::draw_op::GRAD_RECT => w[3] >> 24 == 255 && w[4] >> 24 == 255,
        _ => false,
    }
}

/// Scissors paint nothing; a clip change shows up as different clipped
/// bounds on the operations it affects.
fn painted(op: &MotionOp) -> bool {
    op.code != spec::draw_op::SCISSOR && op.code != spec::draw_op::SCISSOR_POP
}

/// The largest rectangle whose pixels all moved by `(dx, dy)`: covered by an
/// opaque operation that follows the offset, and painted over only by
/// operations that follow it. An operation follows the offset where both
/// frames paint it when it moved by the offset, or when it is a flat RECT
/// of one color, whose pixels do not depend on position.
#[allow(clippy::too_many_arguments)]
fn safe_rect(
    previous: &[u32],
    current: &[u32],
    old: &[MotionOp],
    new: &[MotionOp],
    pairs: &[OpPair],
    (dx, dy): (i16, i16),
    covers: &mut Vec<(usize, DamageRect)>,
    obstacles: &mut Vec<(usize, DamageRect)>,
) -> DamageRect {
    let moved = Relation::Moved(dx, dy);
    let (dx, dy) = (dx as i32, dy as i32);
    let flat = |o: usize, n: usize| {
        old[o].code == spec::draw_op::RECT
            && new[n].code == spec::draw_op::RECT
            && previous[old[o].start + 3] == current[new[n].start + 3]
    };
    covers.clear();
    // Rectangles whose pixels may differ from the moved ones, in painter
    // order of the pair that paints them.
    obstacles.clear();
    for (index, pair) in pairs.iter().enumerate() {
        match (pair.old(), pair.new_op()) {
            (Some(o), Some(n)) if pair.relation == moved || flat(o, n) => {
                if !painted(&new[n]) {
                    continue;
                }
                let before = old[o].bounds.offset(dx, dy);
                let both = new[n].bounds.intersect(before);
                if opaque_cover(current, &new[n]) && !both.is_empty() {
                    covers.push((index, both));
                }
                if new[n].bounds != before {
                    let pieces = new[n].bounds.subtract(before).into_iter().chain(before.subtract(new[n].bounds));
                    obstacles.extend(pieces.filter(|piece| !piece.is_empty()).map(|piece| (index, piece)));
                }
            }
            (o, n) => {
                if let Some(n) = n.filter(|&n| painted(&new[n]) && !new[n].bounds.is_empty()) {
                    obstacles.push((index, new[n].bounds));
                }
                if let Some(o) = o.filter(|&o| painted(&old[o]) && !old[o].bounds.is_empty()) {
                    obstacles.push((index, old[o].bounds.offset(dx, dy)));
                }
            }
        }
    }
    covers.sort_by_key(|(_, cover)| core::cmp::Reverse(cover.area()));
    covers.truncate(MAX_COVERS);
    let mut safe: Vec<DamageRect> = Vec::with_capacity(covers.len());
    for &(index, mut cover) in covers.iter() {
        let later = obstacles.partition_point(|&(at, _)| at <= index);
        for &(_, obstacle) in &obstacles[later..] {
            if cover.is_empty() {
                break;
            }
            cover = cut(cover, obstacle);
        }
        if !cover.is_empty() {
            safe.push(cover);
        }
    }
    // Safety holds per pixel, so rectangles that share a full edge merge.
    let mut best = DamageRect::empty();
    while let Some(start) = (0..safe.len()).max_by_key(|&k| safe[k].area()) {
        let mut merged = safe.swap_remove(start);
        loop {
            let next = safe.iter().position(|r| {
                (r.x0 == merged.x0 && r.x1 == merged.x1 && r.y0 <= merged.y1 && merged.y0 <= r.y1)
                    || (r.y0 == merged.y0 && r.y1 == merged.y1 && r.x0 <= merged.x1 && merged.x0 <= r.x1)
            });
            let Some(next) = next else { break };
            merged = merged.union(safe.swap_remove(next));
        }
        if merged.area() > best.area() {
            best = merged;
        }
    }
    best
}

fn motion_damage<const MAX_REGIONS: usize>(
    previous: &[u32],
    old: &[MotionOp],
    current: &[u32],
    new: &[MotionOp],
    screen: DamageRect,
    scratch: &mut MotionScratch,
) -> DamagePlan<MAX_REGIONS> {
    let MotionScratch { pairs, covers, obstacles } = scratch;
    align_into(previous, old, current, new, pairs);
    let mut damage = DamagePlan::empty(screen);
    let mut offsets: Vec<((i16, i16), u64)> = Vec::new();
    for pair in pairs.iter() {
        if pair.relation == Relation::Same {
            if let (Some(o), Some(n)) = (pair.old(), pair.new_op()) {
                if painted(&new[n]) && old[o].bounds != new[n].bounds {
                    damage.add(old[o].bounds, screen);
                    damage.add(new[n].bounds, screen);
                }
            }
            continue;
        }
        if let Some(o) = pair.old().filter(|&o| painted(&old[o])) {
            damage.add(old[o].bounds, screen);
        }
        if let Some(n) = pair.new_op().filter(|&n| painted(&new[n])) {
            damage.add(new[n].bounds, screen);
            if let Relation::Moved(dx, dy) = pair.relation {
                let area = new[n].bounds.area();
                match offsets.iter_mut().find(|(d, _)| *d == (dx, dy)) {
                    Some((_, total)) => *total += area,
                    None => offsets.push(((dx, dy), area)),
                }
            }
        }
    }
    offsets.sort_by_key(|&(_, area)| core::cmp::Reverse(area));
    // Only damaged pixels need to move; the rest already hold their value.
    let useful = |safe: DamageRect| {
        damage
            .regions()
            .iter()
            .fold(DamageRect::empty(), |bounds, &region| bounds.union(region.intersect(safe)))
    };
    let motion = offsets
        .iter()
        .take(3)
        .filter(|&&(_, area)| area >= MIN_MOTION_AREA)
        .map(|&(d, _)| (d, useful(safe_rect(previous, current, old, new, pairs, d, covers, obstacles).intersect(screen))))
        .max_by_key(|(_, rect)| rect.area())
        .filter(|(_, rect)| rect.area() >= MIN_MOTION_AREA);
    let Some(((dx, dy), destination)) = motion else {
        return damage;
    };
    let mut remaining = DamagePlan::empty(screen);
    for &region in damage.regions() {
        for piece in region.subtract(destination) {
            remaining.add(piece, screen);
        }
    }
    remaining.motion = Some(DamageMotion { destination, dx: dx as i32, dy: dy as i32 });
    remaining
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
    for glyph in words[3..].as_chunks::<2>().0 {
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
