extern crate std;

use super::{orient, TriangleRow};
use std::vec::Vec;

/// The previous per-pixel traversal is an independent oracle: compare both
/// coverage and the exact weights consumed by color/UV interpolation.
fn compare(mut points: [(i64, i64); 3], y: i32, min_x: i32, max_x: i32) {
    let [a, b, c] = points;
    let area = orient(a.0, a.1, b.0, b.1, c.0, c.1);
    if area == 0 {
        return;
    }
    if area < 0 {
        points.swap(1, 2);
    }
    let [a, b, c] = points;
    let expected: Vec<_> = (min_x..max_x)
        .filter_map(|x| {
            let sx = 2 * x as i64 + 1;
            let sy = 2 * y as i64 + 1;
            let weights = [
                orient(b.0, b.1, c.0, c.1, sx, sy),
                orient(c.0, c.1, a.0, a.1, sx, sy),
                orient(a.0, a.1, b.0, b.1, sx, sy),
            ];
            weights.iter().all(|&w| w >= 0).then_some((x, weights))
        })
        .collect();
    let actual: Vec<_> = TriangleRow::new(a, b, c, y, min_x, max_x).collect();
    assert_eq!(
        actual, expected,
        "points={points:?} y={y} clip={min_x}..{max_x}"
    );
}

#[test]
fn spans_match_pixel_edge_tests_for_thin_and_extreme_triangles() {
    let triangles = [
        [(0, 0), (1, 60), (2, 60)],
        [(-60, 3), (60, 4), (60, 5)],
        [(0, 0), (32, 32), (32, 0)],
        [(-32768, -32768), (32767, 32767), (32767, -32768)],
        [(-32768, 0), (32767, 1), (32767, -1)],
        [(8, -32768), (9, 32767), (10, 32767)],
    ];
    for triangle in triangles {
        for scale in 1..=4 {
            let points = triangle.map(|(x, y)| (2 * scale * x, 2 * scale * y));
            for y in -3..36 {
                for (left, right) in [(-20, 40), (0, 32), (8, 9), (8, 8), (40, 20)] {
                    compare(points, y, left, right);
                }
            }
        }
    }
}

#[test]
fn clipped_random_triangle_rows_preserve_coverage_and_weights() {
    let mut seed = 0xa68c_519fu32;
    let mut next = || {
        seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
        ((seed >> 16) as i32 % 160) - 80
    };
    for _ in 0..2000 {
        let points = std::array::from_fn(|_| (2 * next() as i64, 2 * next() as i64));
        for y in -4..20 {
            compare(points, y, -16, 32);
        }
    }
}

#[test]
fn narrow_weights_round_to_the_same_float() {
    for center in [0i64, 1 << 16, 1 << 24, 1 << 30, i32::MAX as i64] {
        for offset in -256..=256 {
            let value = center + offset;
            if !(0..=i32::MAX as i64).contains(&value) {
                continue;
            }
            assert_eq!((value as f32).to_bits(), (value as i32 as f32).to_bits());
        }
    }
}
