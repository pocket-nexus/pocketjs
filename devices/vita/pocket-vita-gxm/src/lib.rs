//! PS Vita device kernel: memory, shader registration, targets and textures.
//! Callers own frame submission, completion, presentation and render policy.
//! This crate has no scene format, material model, game or JavaScript dependency.

#[cfg(target_os = "vita")]
pub mod mem;
#[cfg(target_os = "vita")]
pub mod patcher;
#[cfg(target_os = "vita")]
pub mod program;
#[cfg(all(target_os = "vita", feature = "runtime-compiler"))]
pub mod shacccg;
#[cfg(target_os = "vita")]
pub mod target;
#[cfg(target_os = "vita")]
pub mod texture;

#[cfg(any(target_os = "vita", test))]
mod aligned;
#[cfg(any(target_os = "vita", test))]
mod allocation;
