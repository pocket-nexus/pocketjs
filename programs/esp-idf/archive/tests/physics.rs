//! The IDF archive leaves pocket-archive's `physics` feature off: its
//! `pocket_runtime_create` rejects a `ui.physics` plan at boot and reports
//! ops 52..56 unsupported, with the pocket-archive features this crate's
//! dependency graph resolves.
#[path = "../../../sdk/archive/tests/support/physics.rs"]
mod support;

#[test]
fn create_leaves_physics_out() {
    support::check(false);
}
