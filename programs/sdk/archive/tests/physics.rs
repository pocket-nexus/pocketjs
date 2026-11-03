//! The `physics` feature decides what `pocket_runtime_create` composes: with
//! it a runtime admits a `ui.physics` plan and supports ops 52..56.
#[path = "support/physics.rs"]
mod support;

#[test]
fn create_composes_physics_with_the_feature() {
    support::check(cfg!(feature = "physics"));
}
