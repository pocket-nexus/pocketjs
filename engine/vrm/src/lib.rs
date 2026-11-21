//! pocket-vrm — VRM 0.x character semantics on the pocket3d substrate.
//!
//! Scope (engine infrastructure only; rendering, mesh loading, and app
//! behavior stay in the host):
//! - **Parsing**: the `extensions.VRM` block of a `.vrm` GLB — humanoid bone
//!   map, blend-shape expressions, spring-bone config, look-at ranges, MToon
//!   material facts — into plain-data structs ([`VrmDoc`]). VRM 1.0 files
//!   are rejected with a clear error.
//! - **Spring bones**: UniVRM-style verlet simulation ([`SpringSolver`])
//!   writing local rotations into a pocket3d skeleton pose.
//! - **VRMA**: `.vrma` (VRMC_vrm_animation) loading and humanoid retargeting
//!   onto a model skeleton as a pocket3d [`pocket3d::anim::Clip`]
//!   ([`load_vrma_bytes`], [`retarget`]).
//! - **Eye look-at**: bone-type yaw/pitch onto the eye bones, limited by the
//!   model's ranges ([`apply_eye_look`]).
//!
//! Conventions verified on the VRoid `AvatarSample_A` fixture:
//! - VRM 0.x glTF data faces **-Z**: the left eye rests at negative X, the
//!   right eye at positive X, so the model's left is -X and a face-on camera
//!   sits at -Z looking toward +Z.
//! - VRM0 `materialProperties` are index-aligned with glTF `materials`
//!   (same count and order).
//! - The normalized VRM0 rest pose has identity rotations and unit scales.

pub mod glb;
pub mod lookat;
pub mod parse;
pub mod spring;
pub mod vrma;

pub use lookat::apply_eye_look;
pub use parse::{
    ColliderGroup, LookAtDegreeMap, LookAtRanges, MorphBind, SphereCollider, SpringConfig,
    SpringGroup, VrmDoc, VrmExpression, VrmMaterialInfo, VrmMeta,
};
pub use spring::SpringSolver;
pub use vrma::{VrmaDoc, load_vrma_bytes, retarget};
