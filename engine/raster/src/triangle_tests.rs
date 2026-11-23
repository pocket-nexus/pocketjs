extern crate std;

use super::{div_nonnegative, edge_bias, orient, TriangleRow, TriangleRows};
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
    let bias = [edge_bias(b, c), edge_bias(c, a), edge_bias(a, b)];
    let expected: Vec<_> = (min_x..max_x)
        .filter_map(|x| {
            let sx = 2 * x as i64 + 1;
            let sy = 2 * y as i64 + 1;
            let weights = [
                orient(b.0, b.1, c.0, c.1, sx, sy),
                orient(c.0, c.1, a.0, a.1, sx, sy),
                orient(a.0, a.1, b.0, b.1, sx, sy),
            ];
            weights
                .iter()
                .zip(bias)
                .all(|(&w, bias)| w >= bias)
                .then_some((x, weights))
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
fn triangles_sharing_an_edge_cover_each_pixel_centre_once() {
    // Quads fanned into two triangles, with diagonals that run through
    // pixel centres: every centre inside the quad belongs to exactly one
    // triangle, including the centres on the shared diagonal and on the
    // shared edges of neighbouring quads.
    let quads: [[(i64, i64); 4]; 4] = [
        [(0, 0), (8, 0), (8, 8), (0, 8)],
        [(8, 0), (0, 0), (0, 8), (8, 8)],
        [(4, 0), (8, 4), (4, 8), (0, 4)],
        [(1, 0), (10, 3), (7, 12), (-2, 9)],
    ];
    for quad in quads {
        let quad = quad.map(|(x, y)| (2 * x, 2 * y));
        let mut hits = std::collections::BTreeMap::<(i32, i32), u32>::new();
        for tri in [[quad[0], quad[1], quad[2]], [quad[0], quad[2], quad[3]]] {
            let mut tri = tri;
            if orient(tri[0].0, tri[0].1, tri[1].0, tri[1].1, tri[2].0, tri[2].1) < 0 {
                tri.swap(1, 2);
            }
            for y in -4..16 {
                for (x, _) in TriangleRow::new(tri[0], tri[1], tri[2], y, -4, 16) {
                    *hits.entry((x, y)).or_default() += 1;
                }
            }
        }
        assert!(!hits.is_empty());
        assert!(
            hits.values().all(|&n| n == 1),
            "quad {quad:?} covers {:?} twice",
            hits.iter().filter(|(_, &n)| n > 1).collect::<Vec<_>>()
        );
    }
    // Two 4x4 squares sharing the edge x = 4 (doubled coordinate 8) tile
    // the row without a gap or an overlap.
    let mut row = Vec::new();
    for tri in [
        [(0, 0), (8, 0), (8, 8)],
        [(0, 0), (8, 8), (0, 8)],
        [(8, 0), (16, 0), (16, 8)],
        [(8, 0), (16, 8), (8, 8)],
    ] {
        let mut tri = tri;
        if orient(tri[0].0, tri[0].1, tri[1].0, tri[1].1, tri[2].0, tri[2].1) < 0 {
            tri.swap(1, 2);
        }
        row.extend(TriangleRow::new(tri[0], tri[1], tri[2], 1, -4, 16).map(|(x, _)| x));
    }
    row.sort();
    assert_eq!(row, (0..8).collect::<Vec<_>>());
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

/// Rows stepped by addition equal rows set up from the vertices, for
/// vertices on the pixel grid (even doubled coordinates) and between its
/// lines (odd ones).
#[test]
fn stepped_rows_equal_rows_computed_from_the_vertices() {
    let mut seed = 0x51f1_5eedu32;
    let mut next = |range: i32| {
        seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
        ((seed >> 16) as i32 % range) - range / 2
    };
    for case in 0..4000 {
        // Mostly small triangles; every eighth spans the i16 range.
        let range = if case % 8 == 0 { 65536 } else { 200 };
        let grid = if case % 3 == 0 { 1 } else { 2 };
        let mut points: [(i64, i64); 3] =
            std::array::from_fn(|_| (grid * next(range) as i64, grid * next(range) as i64));
        let area = orient(
            points[0].0,
            points[0].1,
            points[1].0,
            points[1].1,
            points[2].0,
            points[2].1,
        );
        if area == 0 {
            continue;
        }
        if area < 0 {
            points.swap(1, 2);
        }
        let [a, b, c] = points;
        let (min_x, max_x) = (next(80), next(80) + 60);
        let first = next(60);
        let mut rows = TriangleRows::new(a, b, c, first, min_x, max_x);
        for y in first..first + 40 {
            // `compare` holds `TriangleRow::new` to the per-pixel edge tests.
            compare(points, y, min_x, max_x);
            let expected: Vec<_> = TriangleRow::new(a, b, c, y, min_x, max_x).collect();
            let actual: Vec<_> = rows.next_row().collect();
            assert_eq!(
                actual, expected,
                "points={points:?} y={y} clip={min_x}..{max_x}"
            );
        }
    }
}

/// Stepped rows keep the fill rule: a 3 x 3 block of equal parallelograms,
/// each fanned into two triangles, covers every pixel centre of the middle
/// parallelogram exactly once, its sides and corners included, with
/// vertices on the grid and half a pixel off it. The sides run at slopes
/// that pass through pixel centres; with odd doubled coordinates so do the
/// horizontal ones, where the top rule decides.
#[test]
fn stepped_rows_of_fanned_quads_cover_each_pixel_centre_once() {
    let mut seed = 0x0bad_5eedu32;
    let mut next = |range: i32| {
        seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
        (seed >> 16) as i32 % range
    };
    let (mut on_edge, mut on_horizontal_edge, mut inside) = (0, 0, 0);
    for case in 0..800 {
        let k = 1 + next(5) as i64;
        let (e, f) = match case % 5 {
            0 => ((k, 0), (0, k)),
            1 => ((k, k), (-k, k)),
            2 => ((3 * k, k), (-k, 3 * k)),
            3 => ((2 * k, -k), (k, 2 * k)),
            _ => (
                (1 + next(9) as i64, next(9) as i64 - 4),
                (next(9) as i64 - 4, 1 + next(9) as i64),
            ),
        };
        let cross = e.0 * f.1 - e.1 * f.0;
        if cross == 0 {
            continue;
        }
        // Doubled coordinates: even vertices sit on the grid, odd ones on
        // pixel centres or half way between grid lines.
        let grid = if case % 2 == 0 { 2 } else { 1 };
        let (e, f) = ((grid * e.0, grid * e.1), (grid * f.0, grid * f.1));
        let cross = grid * grid * cross;
        let origin = (grid * (next(12) as i64 - 4), grid * (next(12) as i64 - 4));
        let mut hits = std::collections::BTreeMap::<(i32, i32), u32>::new();
        for (i, j) in (0..3).flat_map(|i| (0..3).map(move |j| (i as i64, j as i64))) {
            let p0 = (origin.0 + i * e.0 + j * f.0, origin.1 + i * e.1 + j * f.1);
            let quad = [
                p0,
                (p0.0 + e.0, p0.1 + e.1),
                (p0.0 + e.0 + f.0, p0.1 + e.1 + f.1),
                (p0.0 + f.0, p0.1 + f.1),
            ];
            for tri in [[quad[0], quad[1], quad[2]], [quad[0], quad[2], quad[3]]] {
                let mut tri = tri;
                if orient(tri[0].0, tri[0].1, tri[1].0, tri[1].1, tri[2].0, tri[2].1) < 0 {
                    tri.swap(1, 2);
                }
                let mut rows = TriangleRows::new(tri[0], tri[1], tri[2], -40, -40, 110);
                for y in -40..110 {
                    for (x, weights) in rows.next_row() {
                        *hits.entry((x, y)).or_default() += 1;
                        // A centre with a zero weight lies on that edge.
                        let edges = [(tri[1], tri[2]), (tri[2], tri[0]), (tri[0], tri[1])];
                        for (&w, (u, v)) in weights.iter().zip(edges) {
                            if w == 0 {
                                on_edge += 1;
                                on_horizontal_edge += usize::from(u.1 == v.1);
                            }
                        }
                    }
                }
            }
        }
        // Every centre in the closed middle parallelogram is interior to
        // the block: p = middle + s * e + t * f with 0 <= s, t <= 1.
        let middle = (origin.0 + e.0 + f.0, origin.1 + e.1 + f.1);
        for y in -40..110 {
            for x in -40..110 {
                let d = (2 * x as i64 + 1 - middle.0, 2 * y as i64 + 1 - middle.1);
                let s = (d.0 * f.1 - d.1 * f.0) * cross.signum();
                let t = (e.0 * d.1 - e.1 * d.0) * cross.signum();
                if (0..=cross.abs()).contains(&s) && (0..=cross.abs()).contains(&t) {
                    inside += 1;
                    assert_eq!(
                        hits.get(&(x, y)).copied().unwrap_or(0),
                        1,
                        "case {case} e={e:?} f={f:?} origin={origin:?} centre ({x}, {y})"
                    );
                }
            }
        }
        assert!(
            hits.values().all(|&n| n == 1),
            "case {case} e={e:?} f={f:?} covers {:?} more than once",
            hits.iter().filter(|(_, &n)| n > 1).collect::<Vec<_>>()
        );
    }
    // The cases do hold centres, and put covered ones on edges, horizontal
    // ones included.
    assert!(inside > 10_000, "{inside} centres in the middle quads");
    assert!(on_edge > 1000, "{on_edge} covered centres on an edge");
    assert!(
        on_horizontal_edge > 100,
        "{on_horizontal_edge} covered centres on a horizontal edge"
    );
}

/// The top rule through stepped rows: pixel centres on a horizontal edge
/// (odd doubled y) belong to the triangle below it, whose top edge it is.
#[test]
fn stepped_rows_give_a_centre_on_a_horizontal_edge_to_the_triangle_below() {
    let row = |tri: [(i64, i64); 3]| -> Vec<i32> {
        let mut tri = tri;
        if orient(tri[0].0, tri[0].1, tri[1].0, tri[1].1, tri[2].0, tri[2].1) < 0 {
            tri.swap(1, 2);
        }
        // Row 2 has its centres at doubled y = 5, the shared edge.
        let mut rows = TriangleRows::new(tri[0], tri[1], tri[2], 2, -4, 12);
        rows.next_row().map(|(x, _)| x).collect()
    };
    let below = row([(1, 5), (9, 5), (5, 11)]);
    let above = row([(1, 5), (9, 5), (5, -1)]);
    // Centres at doubled x = 3, 5 and 7 lie inside the edge. The one at
    // x = 1 is the triangle's top-left corner, on two edges of bias 0; the
    // one at x = 9 is on its right edge.
    assert_eq!(below, [0, 1, 2, 3]);
    assert_eq!(above, [] as [i32; 0]);
}

#[test]
fn narrow_division_equals_wide_division() {
    for n in [
        0i64,
        1,
        2,
        255,
        u32::MAX as i64 - 1,
        u32::MAX as i64,
        u32::MAX as i64 + 1,
        1 << 40,
        i64::MAX,
    ] {
        for d in [
            1i64,
            2,
            3,
            7,
            1 << 20,
            u32::MAX as i64,
            u32::MAX as i64 + 1,
            1 << 40,
        ] {
            assert_eq!(div_nonnegative(n, d), n / d, "{n} / {d}");
        }
    }
}
