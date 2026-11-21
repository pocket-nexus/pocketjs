# Pocket3D animation

**One `no_std` + `alloc` implementation samples skeletal animation for desktop
and handheld consumers.** `pocket3d::anim` re-exports the public types so existing
desktop imports keep working.

`Skeleton` samples linear/step TRS channels into reusable local/global buffers.
Parents precede children in its evaluation order. `NodeTrs::interpolate` blends
local poses and preserves the endpoints. Callers own fixed-step timing, clip
selection, transition duration, procedural edits and discrete visibility.
Directly constructed channels and skeletons must have valid key widths and node
indices.

This crate contains no mesh, asset decoder, light, GPU, controller or application
state. [pocket3d-mesh](../pocket3d-mesh/README.md) owns skin bindings, P3M1 assets,
colored-mesh reference rendering and native vertex packing. It consumes these
animation types; animation has no dependency on mesh data.

Run `cargo test --locked --manifest-path engine/Cargo.toml -p pocket3d-anim`.
Tests cover different hierarchies, loop times, step channels and pose blending.
