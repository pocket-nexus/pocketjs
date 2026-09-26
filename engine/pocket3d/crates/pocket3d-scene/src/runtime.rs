//! Surfaces a scene cannot cook: water, sky and particles.
//!
//! These are rebuilt every frame from the camera, so they keep full-precision
//! positions instead of the cooked chunk's quantized ones. Everything else
//! matches: the same `lit` and `fog` pair, so a backend draws them with the
//! same three passes and they sit in the same aerial perspective as the
//! cooked geometry around them.
//!
//! All of it is plain arithmetic over `alloc` vectors. A backend uploads the
//! result and draws it; the CPU reference rasterizer consumes the identical
//! vectors, so a still rendered on a desktop and a frame on the device are
//! built from the same numbers.

use alloc::vec::Vec;

use glam::Vec3;

/// `[u, v: f32][lit: u32][fog: u32][x, y, z: f32]`, 28 bytes.
///
/// The cooked layout's quantized twin. The attribute offsets are deliberately
/// the same so a backend's three vertex programs differ only in stride.
pub const DYNAMIC_VERTEX_STRIDE: usize = 28;
pub const DYNAMIC_UV_OFFSET: usize = 0;
pub const DYNAMIC_LIT_OFFSET: usize = 8;
pub const DYNAMIC_FOG_OFFSET: usize = 12;
pub const DYNAMIC_POSITION_OFFSET: usize = 16;

#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct DynamicVertex {
    pub u: f32,
    pub v: f32,
    pub lit: u32,
    pub fog: u32,
    pub x: f32,
    pub y: f32,
    pub z: f32,
}

impl DynamicVertex {
    pub fn new(position: Vec3, uv: [f32; 2], lit: u32, fog: u32) -> Self {
        Self {
            u: uv[0],
            v: uv[1],
            lit,
            fog,
            x: position.x,
            y: position.y,
            z: position.z,
        }
    }

    pub fn position(&self) -> Vec3 {
        Vec3::new(self.x, self.y, self.z)
    }
}

const _: () = {
    assert!(core::mem::size_of::<DynamicVertex>() == DYNAMIC_VERTEX_STRIDE);
};

/// An indexed triangle list rebuilt each frame, retained to avoid allocation.
#[derive(Clone, Debug, Default)]
pub struct DynamicMesh {
    pub vertices: Vec<DynamicVertex>,
    pub indices: Vec<u16>,
}

impl DynamicMesh {
    pub const fn new() -> Self {
        Self {
            vertices: Vec::new(),
            indices: Vec::new(),
        }
    }

    pub fn clear(&mut self) {
        self.vertices.clear();
        self.indices.clear();
    }

    pub fn is_empty(&self) -> bool {
        self.indices.is_empty()
    }

    pub fn triangle_count(&self) -> usize {
        self.indices.len() / 3
    }

    pub fn push_vertex(&mut self, vertex: DynamicVertex) -> u16 {
        let index = self.vertices.len() as u16;
        self.vertices.push(vertex);
        index
    }

    pub fn push_quad(&mut self, a: u16, b: u16, c: u16, d: u16) {
        self.indices.extend_from_slice(&[a, b, c, a, c, d]);
    }

    /// True when another `count` vertices would overflow the `u16` index space.
    pub fn would_overflow(&self, count: usize) -> bool {
        self.vertices.len() + count > u16::MAX as usize
    }

    /// Serialize the vertex array into the byte layout a GPU stream expects.
    ///
    /// Written field by field rather than reinterpreted, so the crate stays
    /// free of unsafe code and the layout is explicit at the one place that
    /// has to agree with the backend's vertex attributes.
    pub fn write_vertex_bytes(&self, out: &mut Vec<u8>) {
        out.clear();
        out.reserve(self.vertices.len() * DYNAMIC_VERTEX_STRIDE);
        for vertex in &self.vertices {
            out.extend_from_slice(&vertex.u.to_le_bytes());
            out.extend_from_slice(&vertex.v.to_le_bytes());
            out.extend_from_slice(&vertex.lit.to_le_bytes());
            out.extend_from_slice(&vertex.fog.to_le_bytes());
            out.extend_from_slice(&vertex.x.to_le_bytes());
            out.extend_from_slice(&vertex.y.to_le_bytes());
            out.extend_from_slice(&vertex.z.to_le_bytes());
        }
    }

    /// Serialize the index array as little-endian `u16`.
    pub fn write_index_bytes(&self, out: &mut Vec<u8>) {
        out.clear();
        out.reserve(self.indices.len() * 2);
        for index in &self.indices {
            out.extend_from_slice(&index.to_le_bytes());
        }
    }
}

/// The camera a runtime surface is built for.
#[derive(Clone, Copy, Debug)]
pub struct ViewPoint {
    pub eye: Vec3,
    pub forward: Vec3,
    pub right: Vec3,
    pub up: Vec3,
}

impl ViewPoint {
    pub fn new(eye: Vec3, forward: Vec3) -> Self {
        let forward = forward.normalize_or(Vec3::NEG_Z);
        let right = forward.cross(Vec3::Y).normalize_or(Vec3::X);
        Self {
            eye,
            forward,
            right,
            up: right.cross(forward).normalize_or(Vec3::Y),
        }
    }
}
