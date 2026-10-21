//! Triangle construction and adjacent batching for graphics drivers.
//!
//! Drivers own vertex layouts, texture keys, clips, and submission. This crate
//! preserves vertex order and merges only consecutive ranges with equal keys;
//! it does not sort geometry or apply clipping.

#![no_std]

extern crate alloc;

use alloc::vec::Vec;
use core::ops::Range;

/// Construct the driver's vertex format from logical position, UV, and color.
///
/// Color is the DrawList's `0xAABBGGRR`. A driver may convert the components to
/// its hardware format here; this crate imposes no memory layout on the result.
pub trait Vertex: Copy {
    fn from_components(position: [f32; 2], uv: [f32; 2], color: u32) -> Self;
}

/// Emit two triangles in TL, TR, BR / TL, BR, BL order.
///
/// Colors are specified clockwise from top-left. UV endpoints are retained,
/// including reversed endpoints used for flipped images.
pub fn quad<V: Vertex>(
    top_left: [f32; 2],
    bottom_right: [f32; 2],
    uv0: [f32; 2],
    uv1: [f32; 2],
    colors: [u32; 4],
) -> [V; 6] {
    let tl = V::from_components(top_left, uv0, colors[0]);
    let tr = V::from_components([bottom_right[0], top_left[1]], [uv1[0], uv0[1]], colors[1]);
    let br = V::from_components(bottom_right, uv1, colors[2]);
    let bl = V::from_components([top_left[0], bottom_right[1]], [uv0[0], uv1[1]], colors[3]);
    [tl, tr, br, tl, br, bl]
}

/// Emit a triangle without changing its winding or per-vertex attributes.
pub fn triangle<V: Vertex>(
    positions: [[f32; 2]; 3],
    uvs: [[f32; 2]; 3],
    colors: [u32; 3],
) -> [V; 3] {
    core::array::from_fn(|index| V::from_components(positions[index], uvs[index], colors[index]))
}

/// A contiguous vertex range with the state required by its driver.
///
/// A texture key may include sampler or pipeline state when that state also
/// prevents merging. Drivers convert vertex indices to their API's index type
/// and enforce its submission limits.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Batch<Texture, Clip> {
    pub texture: Texture,
    pub first: usize,
    pub count: usize,
    pub clip: Clip,
}

/// Append a range, merging only with the final batch when its state matches.
///
/// Empty or reversed ranges produce no batch. A gap, overlap, different texture
/// key, or different clip starts a new batch. Earlier batches are never searched
/// or reordered, preserving painter order for overlapping translucent content.
pub fn append_batch<Texture: PartialEq, Clip: PartialEq>(
    batches: &mut Vec<Batch<Texture, Clip>>,
    texture: Texture,
    clip: Clip,
    vertices: Range<usize>,
) {
    if vertices.is_empty() {
        return;
    }
    if let Some(previous) = batches.last_mut() {
        if previous.texture == texture
            && previous.clip == clip
            && previous.first.checked_add(previous.count) == Some(vertices.start)
        {
            previous.count = vertices.end - previous.first;
            return;
        }
    }
    batches.push(Batch {
        texture,
        first: vertices.start,
        count: vertices.len(),
        clip,
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    // The driver chooses this packed UV/color/position field order, unlike GL.
    #[repr(C)]
    #[derive(Clone, Copy, Debug, PartialEq)]
    struct PackedVertex {
        uv: [i16; 2],
        color: u32,
        position: [i16; 2],
    }

    impl Vertex for PackedVertex {
        fn from_components(position: [f32; 2], uv: [f32; 2], color: u32) -> Self {
            Self {
                uv: uv.map(|value| (value * 256.0) as i16),
                color,
                position: position.map(|value| value as i16),
            }
        }
    }

    #[test]
    fn quad_retains_corner_attributes_and_flipped_uvs_in_driver_layout() {
        let vertices: [PackedVertex; 6] = quad(
            [-4.0, 8.0],
            [12.0, 24.0],
            [0.75, 0.5],
            [0.25, 0.0],
            [1, 2, 3, 4],
        );
        let expected = [
            PackedVertex {
                position: [-4, 8],
                uv: [192, 128],
                color: 1,
            },
            PackedVertex {
                position: [12, 8],
                uv: [64, 128],
                color: 2,
            },
            PackedVertex {
                position: [12, 24],
                uv: [64, 0],
                color: 3,
            },
            PackedVertex {
                position: [-4, 8],
                uv: [192, 128],
                color: 1,
            },
            PackedVertex {
                position: [12, 24],
                uv: [64, 0],
                color: 3,
            },
            PackedVertex {
                position: [-4, 24],
                uv: [192, 0],
                color: 4,
            },
        ];
        assert_eq!(vertices, expected);
    }

    #[test]
    fn triangle_retains_input_order_and_per_vertex_attributes() {
        let vertices: [PackedVertex; 3] = triangle(
            [[20.0, 3.0], [-4.0, 2.0], [5.0, -6.0]],
            [[0.5, 0.75], [0.0, 1.0], [0.25, 0.5]],
            [0x8040_3020, 0xff00_ff00, 0x1010_1010],
        );
        assert_eq!(
            vertices,
            [
                PackedVertex {
                    position: [20, 3],
                    uv: [128, 192],
                    color: 0x8040_3020
                },
                PackedVertex {
                    position: [-4, 2],
                    uv: [0, 256],
                    color: 0xff00_ff00
                },
                PackedVertex {
                    position: [5, -6],
                    uv: [64, 128],
                    color: 0x1010_1010
                },
            ]
        );
    }

    #[test]
    fn batches_merge_adjacent_equal_state_without_reordering() {
        let mut batches = Vec::new();
        append_batch(&mut batches, "a", [0, 0, 100, 50], 0..6);
        append_batch(&mut batches, "a", [0, 0, 100, 50], 6..9);
        append_batch(&mut batches, "b", [0, 0, 100, 50], 9..12);
        append_batch(&mut batches, "a", [0, 0, 100, 50], 12..18);
        append_batch(&mut batches, "a", [0, 0, 50, 50], 18..24);
        append_batch(&mut batches, "a", [0, 0, 100, 50], 24..27);
        assert_eq!(
            batches
                .iter()
                .map(|b| (b.texture, b.first, b.count))
                .collect::<Vec<_>>(),
            [
                ("a", 0, 9),
                ("b", 9, 3),
                ("a", 12, 6),
                ("a", 18, 6),
                ("a", 24, 3),
            ]
        );
    }

    #[test]
    fn gaps_overlaps_and_empty_ranges_do_not_join_geometry() {
        let mut batches = Vec::new();
        append_batch(&mut batches, 7, (), 0..3);
        append_batch(&mut batches, 8, (), 3..3);
        append_batch(&mut batches, 8, (), 4..3);
        append_batch(&mut batches, 7, (), 6..9);
        append_batch(&mut batches, 7, (), 6..9);
        assert_eq!(
            batches
                .iter()
                .map(|b| (b.first, b.count))
                .collect::<Vec<_>>(),
            [(0, 3), (6, 3), (6, 3)]
        );
    }
}
