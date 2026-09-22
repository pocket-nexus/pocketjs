//! Plain map data types shared by the std parsing/cooking path and the
//! no_std runtime path (collision tracing, visibility, cooked-map reading).
//!
//! Everything here is `alloc`-only: no file IO, no `anyhow`, no `log`.

use glam::Vec3;

pub const CONTENTS_EMPTY: i32 = -1;
pub const CONTENTS_SOLID: i32 = -2;
pub const CONTENTS_WATER: i32 = -3;
pub const CONTENTS_SLIME: i32 = -4;
pub const CONTENTS_LAVA: i32 = -5;
pub const CONTENTS_SKY: i32 = -6;

/// Quake space -> Pocket3D space (+Y up). Proper rotation, det = +1.
#[inline]
pub fn q2y(v: Vec3) -> Vec3 {
    Vec3::new(v.x, v.z, -v.y)
}

/// Pocket3D space -> Quake space.
#[inline]
pub fn y2q(v: Vec3) -> Vec3 {
    Vec3::new(v.x, -v.z, v.y)
}

/// Convert a Quake-space AABB to Y-up (the Y/Z swap flips one axis, so
/// min/max must be recomputed on that axis).
pub fn convert_bounds(mins_q: Vec3, maxs_q: Vec3) -> (Vec3, Vec3) {
    let a = q2y(mins_q);
    let b = q2y(maxs_q);
    (a.min(b), a.max(b))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum SurfaceKind {
    Opaque,
    /// `{`-prefixed cutout textures (fences, grates); alpha-tested.
    AlphaTest,
    Water,
    Sky,
}

impl SurfaceKind {
    pub fn as_u8(self) -> u8 {
        match self {
            SurfaceKind::Opaque => 0,
            SurfaceKind::AlphaTest => 1,
            SurfaceKind::Water => 2,
            SurfaceKind::Sky => 3,
        }
    }

    pub fn from_u8(v: u8) -> Option<Self> {
        Some(match v {
            0 => SurfaceKind::Opaque,
            1 => SurfaceKind::AlphaTest,
            2 => SurfaceKind::Water,
            3 => SurfaceKind::Sky,
            _ => return None,
        })
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Plane {
    pub normal: Vec3,
    pub dist: f32,
}

#[derive(Clone, Copy, Debug)]
pub struct ClipNode {
    pub plane: u32,
    /// Node index if >= 0, otherwise a CONTENTS_* value.
    pub children: [i32; 2],
}

#[derive(Clone, Copy, Debug)]
pub struct Node {
    pub plane: u32,
    /// Positive: node index. Negative: -(leaf_index + 1).
    pub children: [i16; 2],
}

#[derive(Clone, Copy, Debug)]
pub struct Leaf {
    pub contents: i32,
    /// Byte offset into the compressed visibility data, or -1.
    pub vis_offset: i32,
    /// AABB in Y-up space.
    pub mins: Vec3,
    pub maxs: Vec3,
    pub first_marksurface: u16,
    pub num_marksurfaces: u16,
}

#[derive(Clone, Copy, Debug)]
pub struct Model {
    pub mins: Vec3,
    pub maxs: Vec3,
    pub origin: Vec3,
    pub headnodes: [i32; 4],
    /// Number of visleaves (meaningful for model 0 / worldspawn).
    pub visleafs: usize,
    pub first_face: usize,
    pub num_faces: usize,
}

#[derive(Clone, Copy, Debug)]
pub struct SpawnPoint {
    pub pos: Vec3,
    pub yaw: f32,
}

#[derive(Clone, Copy, Debug)]
pub struct SunLight {
    /// Direction pointing from the scene towards the sun (Y-up space).
    pub dir: Vec3,
    pub color: Vec3,
}

/// Authored procedural sky colors, stored as linear channels in [0,1].
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SkyColors {
    pub zenith: glam::Vec3,
    pub horizon: glam::Vec3,
}
