//! What a hardware executor can do, decided before any command is built.
//!
//! The planner reads [`Capabilities`] once per frame and never issues a
//! command the executor cannot run. On SiFli the values come from the chip's
//! SDK feature gates (`bf0_hal_epic.h`) and the VG Lite Kconfig.

/// Physical-pixel thresholds below which transaction overhead is not worth
/// paying and the CPU path is used instead.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Thresholds {
    pub min_fill: u32,
    pub min_gradient: u32,
    pub min_blend: u32,
    pub min_blit: u32,
}

/// Capabilities of one executor, read by the planner.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Capabilities {
    /// Opaque rectangle fills.
    pub fill_opaque: bool,
    /// Translucent solid fills blended in hardware (EPIC MONO layer).
    pub fill_alpha: bool,
    /// A8 coverage planes blended with one fixed color.
    pub a8_blend: bool,
    /// Opaque two-stop linear gradients covering an unclipped rectangle.
    pub gradient: bool,
    /// Axis-aligned blits of registered textures with scaling and
    /// horizontal mirroring.
    pub blit: bool,
    /// Axis-aligned blits mirror vertically.
    pub blit_mirror_y: bool,
    /// Four-point (affine or projective) blits of registered textures and
    /// of solid colors.
    pub blit_quad: bool,
    /// Native rotated rectangles accepted by the executor's read-only
    /// `can_blit_rotate` preflight. Does not imply arbitrary quad support.
    pub blit_rotate: bool,
    /// Blits multiply texels by the DrawList's RGB modulate color. When
    /// false only the modulate alpha applies and tinted blits stay on the
    /// CPU.
    pub blit_modulate: bool,
    /// Textures register in their portable PSM layouts; without it only
    /// native copies from the `.epic` table reach hardware.
    pub portable_textures: bool,
    /// Largest transaction extent in physical pixels per axis (EPIC
    /// coordinate registers).
    pub coordinate_limit: u32,
    /// Bytes per executor-owned A8 plane. A8 runs split into row bands that
    /// fit.
    pub mask_bytes: u32,
    /// Physical pixels per executor-owned RGB565 tile. CPU fallback renders
    /// into tiles that hardware copies out of and back into the target.
    pub tile_pixels: u32,
    pub thresholds: Thresholds,
}
