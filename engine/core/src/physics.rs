//! The physics port of capability `ui.physics` (spec ops 52..56,
//! contracts/spec/physics.ts). The core owns the tick order and the
//! `physics_values` layer; the engine that fills that layer is a separate
//! crate a program installs with [`crate::Ui::set_physics`] before boot.
//!
//! Contract between the core and an implementation:
//!
//! - `Ui::tick` calls [`Physics::step`] once per core tick, after animation
//!   tracks and timelines advance, with layout of the primary and auxiliary
//!   surfaces current. It skips the call, and the relayout before it, while
//!   [`Physics::is_idle`] is true.
//! - An implementation writes only [`crate::tree::Node::physics_values`], and
//!   only on nodes it poses. `style::resolve` applies that layer after
//!   `anim_values`; `style::resolve_animated` stops before it, so `animate()`
//!   and `cancel_anim` never capture a physics pose.
//! - Releasing a view, by [`Physics::destroy`] or otherwise, clears that
//!   node's `physics_values` so the node returns to its styled pose.
//! - The same params, commands and tick count give the same bits on every
//!   host: the core's goldens and the guests' physics tests depend on it.

use alloc::vec::Vec;

use crate::tree::Tree;

/// A 2D physics engine driven by the core tick and the physics ops.
pub trait Physics {
    /// True when no world is alive; `Ui::tick` then skips [`Physics::step`].
    fn is_idle(&self) -> bool;
    /// Advance every world by one core tick of `dt` seconds and write poses
    /// into the views' `physics_values`. `aux_root` is the auxiliary surface
    /// root, 0 without one.
    fn step(&mut self, dt: f32, tree: &mut Tree, aux_root: i32);
    /// `physicsCreate(kind, params)`: a handle, or 0 when nothing was created.
    fn create(&mut self, kind: u32, params: &[f64]) -> i32;
    /// `physicsApply(records)`.
    fn apply(&mut self, records: &[f64]);
    /// `physicsDestroy(handle)`; released views get their styled pose back.
    fn destroy(&mut self, handle: i32, tree: &mut Tree);
    /// `physicsEvents()`: replace `out` with the pending event records.
    fn take_events(&mut self, out: &mut Vec<f64>);
    /// Whether `take_events` would return records.
    fn has_events(&self) -> bool;
    /// `physicsQuery(query, handle, a, b, c, d)`.
    fn query(&self, query: u32, handle: i32, a: f64, b: f64, c: f64, d: f64) -> f64;
}
