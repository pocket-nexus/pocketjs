//! Lossless triangle-strip assembly for two-sided cooked faces.
//! Winding may reverse; consumers must retain the cooked world's two-sided state.
use alloc::collections::TryReserveError;
#[cfg(test)]
use alloc::vec;
use alloc::vec::Vec;

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
struct Edge {
    a: u16,
    b: u16,
    triangle: u16,
    other: u16,
}

fn edge(a: u16, b: u16, triangle: u16, other: u16) -> Edge {
    Edge {
        a: a.min(b),
        b: a.max(b),
        triangle,
        other,
    }
}

/// Append strips joined by degenerate triangles. Every non-degenerate input
/// triangle appears once with the same three vertex indices; no vertex changes.
fn append_strips(indices: &[u16], out: &mut Vec<u16>) -> Result<(), TryReserveError> {
    let initial_len = out.len();
    assert_eq!(indices.len() % 3, 0);
    assert!(indices.len() / 3 <= u16::MAX as usize);
    // Reserve every worst-case append before mutating output. Failure leaves
    // the caller free to keep drawing the original triangle list.
    out.try_reserve_exact(indices.len() / 3 * 5)?;
    let mut edges = Vec::new();
    edges.try_reserve_exact(indices.len())?;
    for (i, t) in indices.chunks_exact(3).enumerate() {
        edges.push(edge(t[0], t[1], i as u16, t[2]));
        edges.push(edge(t[1], t[2], i as u16, t[0]));
        edges.push(edge(t[2], t[0], i as u16, t[1]));
    }
    edges.sort_unstable();
    let mut used = Vec::new();
    used.try_reserve_exact(indices.len() / 3)?;
    used.resize(indices.len() / 3, false);
    let neighbor = |a: u16, b: u16, used: &[bool]| -> Option<(usize, u16)> {
        let (a, b) = (a.min(b), a.max(b));
        let start = edges.partition_point(|e| (e.a, e.b) < (a, b));
        edges[start..]
            .iter()
            .take_while(|e| (e.a, e.b) == (a, b))
            .find(|e| !used[e.triangle as usize])
            .map(|e| (e.triangle as usize, e.other))
    };
    for (seed, tri) in indices.chunks_exact(3).enumerate() {
        if used[seed] {
            continue;
        }
        used[seed] = true;
        // Choose a seed edge with a continuation (a quad becomes four indices).
        let mut start = [tri[0], tri[1], tri[2]];
        for rotation in 0..3 {
            let trial = [
                tri[rotation],
                tri[(rotation + 1) % 3],
                tri[(rotation + 2) % 3],
            ];
            if neighbor(trial[1], trial[2], &used).is_some() {
                start = trial;
                break;
            }
        }
        if out.len() > initial_len {
            let last = *out.last().unwrap();
            out.push(last);
            out.push(start[0]);
        }
        out.extend_from_slice(&start);
        while let Some((next, vertex)) = neighbor(out[out.len() - 2], out[out.len() - 1], &used) {
            used[next] = true;
            out.push(vertex);
        }
    }
    Ok(())
}

// Optional PSP acceleration storage: at most 512 KiB of indices, 256 KiB
// of ranges, and less than 64 KiB of conversion scratch. No file format change.
const INDEX_BYTES: usize = 512 * 1024;
const RANGE_BYTES: usize = 256 * 1024;
const MAX_RUN_INDICES: usize = 4095;

#[derive(Clone, Copy, Default)]
struct Range {
    base: u32,
    count: u32,
}

pub struct StripCache {
    indices: Vec<u16>,
    ranges: Vec<Range>,
}

impl StripCache {
    /// Allocation failure, oversized faces and exhausted budgets retain the
    /// original triangle list. The cache never grows during rendering.
    pub fn new(map: &super::CookedMap<'_>) -> Option<Self> {
        let count = map.faces.len().checked_add(map.always_runs.len())?;
        let runs = map.faces.iter().chain(&map.always_runs).map(|run| {
            (run.batch != u16::MAX).then(|| {
                &map.indices
                    [run.index_base as usize..run.index_base as usize + run.index_count as usize]
            })
        });
        Self::build(count, runs, (INDEX_BYTES / 2).min(map.indices.len()))
    }

    fn build<'a>(
        count: usize,
        runs: impl Iterator<Item = Option<&'a [u16]>>,
        index_limit: usize,
    ) -> Option<Self> {
        if count > RANGE_BYTES / core::mem::size_of::<Range>() {
            return None;
        }
        let mut ranges = Vec::new();
        ranges.try_reserve_exact(count).ok()?;
        ranges.resize(count, Range::default());
        let mut indices = Vec::new();
        indices.try_reserve_exact(index_limit).ok()?;
        let mut scratch = Vec::new();
        for (i, source) in runs.enumerate() {
            let Some(source) = source else {
                continue;
            };
            if source.len() > MAX_RUN_INDICES {
                continue;
            }
            scratch.clear();
            if append_strips(source, &mut scratch).is_err() {
                break;
            }
            // Include the degenerate connector cost in the benefit check.
            if scratch.len() + 2 >= source.len() || indices.len() + scratch.len() > index_limit {
                continue;
            }
            ranges[i] = Range {
                base: indices.len() as u32,
                count: scratch.len() as u32,
            };
            indices.extend_from_slice(&scratch);
        }
        Some(Self { indices, ranges })
    }

    #[inline]
    pub fn get(&self, face: usize) -> Option<&[u16]> {
        let range = self.ranges.get(face)?;
        if range.count == 0 {
            return None;
        }
        Some(&self.indices[range.base as usize..(range.base + range.count) as usize])
    }
}

/// Index ranges for GE draws backed by a 64-KiB frame-pool block. Triangle
/// lists split at triangle boundaries; strips carry the last two vertices.
pub fn draw_chunks(len: usize, strip: bool) -> impl Iterator<Item = core::ops::Range<usize>> {
    let mut start = 0;
    core::iter::from_fn(move || {
        if start >= len {
            return None;
        }
        let end = (start + 32766).min(len);
        let range = start..end;
        start = if end == len {
            len
        } else if strip {
            end - 2
        } else {
            end
        };
        Some(range)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn triangles(indices: &[u16], strip: bool) -> Vec<[u16; 3]> {
        let mut out = Vec::new();
        let mut push = |mut t: [u16; 3]| {
            if t[0] != t[1] && t[1] != t[2] && t[0] != t[2] {
                t.sort_unstable();
                out.push(t);
            }
        };
        if strip {
            for w in indices.windows(3) {
                push([w[0], w[1], w[2]]);
            }
        } else {
            for w in indices.chunks_exact(3) {
                push([w[0], w[1], w[2]]);
            }
        }
        out.sort_unstable();
        out
    }

    #[test]
    fn exhausted_or_oversized_cache_entries_keep_triangle_lists() {
        let face = [0, 1, 2, 2, 1, 3, 2, 3, 4, 4, 3, 5];
        let large = vec![0; MAX_RUN_INDICES + 3];
        let runs = [
            Some(face.as_slice()),
            Some(large.as_slice()),
            Some(face.as_slice()),
            None,
        ];
        let empty = StripCache::build(runs.len(), runs.into_iter(), 0).unwrap();
        assert!(runs.iter().enumerate().all(|(i, _)| empty.get(i).is_none()));
        let bounded = StripCache::build(runs.len(), runs.into_iter(), 10).unwrap();
        assert!(bounded.get(0).is_some());
        assert!(bounded.get(1).is_none());
        assert!(bounded.get(2).is_none());
        assert!(bounded.get(3).is_none());
        assert!(bounded.indices.capacity() <= 10);
        assert!(StripCache::build(RANGE_BYTES / 8 + 1, core::iter::empty(), 0).is_none());
    }

    #[test]
    fn append_does_not_connect_independent_batch_runs() {
        let mut out = vec![99, 98, 97];
        append_strips(&[0, 1, 2], &mut out).unwrap();
        assert_eq!(out, [99, 98, 97, 0, 1, 2]);
    }

    #[test]
    fn large_draws_preserve_triangle_boundaries_and_strip_continuations() {
        for strip in [false, true] {
            for len in [0, 3, 32766, 32769, 100002] {
                let source: Vec<u16> = (0..len).map(|i| (i % 50000) as u16).collect();
                let mut actual = Vec::new();
                for range in draw_chunks(len, strip) {
                    assert!(range.len() * 2 <= 65536);
                    actual.extend(triangles(&source[range], strip));
                }
                actual.sort_unstable();
                assert_eq!(actual, triangles(&source, strip));
            }
        }
    }

    #[cfg(feature = "std")]
    #[test]
    #[ignore = "requires POCKET3D_COOKED_MAPS containing user-supplied .p3d files"]
    fn real_maps_preserve_triangles_with_bounded_cache() {
        let dir = std::env::var("POCKET3D_COOKED_MAPS").unwrap();
        let mut maps = 0;
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.extension().is_none_or(|ext| ext != "p3d") {
                continue;
            }
            let bytes = std::fs::read(&path).unwrap();
            let map = super::super::read(&bytes).unwrap();
            let cache = StripCache::new(&map).unwrap();
            assert!(cache.indices.capacity() * 2 <= INDEX_BYTES);
            assert!(cache.ranges.capacity() * core::mem::size_of::<Range>() <= RANGE_BYTES);
            let mut converted = 0;
            for (i, run) in map.faces.iter().chain(&map.always_runs).enumerate() {
                if let Some(strip) = cache.get(i) {
                    let original = &map.indices[run.index_base as usize
                        ..run.index_base as usize + run.index_count as usize];
                    assert_eq!(
                        triangles(strip, true),
                        triangles(original, false),
                        "{} face {i}",
                        path.display()
                    );
                    converted += 1;
                }
            }
            println!(
                "{}: {converted} exact strips, {} cache bytes",
                path.display(),
                cache.indices.capacity() * 2 + cache.ranges.capacity() * 8
            );
            maps += 1;
        }
        assert!(maps > 0);
    }

    #[test]
    fn grids_preserve_every_triangle_with_fewer_indices() {
        for width in [2, 8, 24] {
            let mut source = Vec::new();
            for y in 0..width {
                for x in 0..width {
                    let a = y * (width + 1) + x;
                    let b = a + 1;
                    let c = a + width + 1;
                    let d = c + 1;
                    source.extend_from_slice(&[a, b, d, a, d, c]);
                }
            }
            let mut strip = Vec::new();
            append_strips(&source, &mut strip).unwrap();
            assert_eq!(triangles(&strip, true), triangles(&source, false));
            assert!(strip.len() < source.len());
        }
    }

    #[test]
    fn disconnected_duplicate_and_nonmanifold_faces_keep_triangle_multiplicity() {
        for source in [
            vec![],
            vec![0, 1, 2],
            vec![0, 1, 2, 10, 11, 12],
            vec![0, 1, 2, 1, 0, 3, 0, 1, 4, 0, 1, 2],
        ] {
            let mut strip = Vec::new();
            append_strips(&source, &mut strip).unwrap();
            assert_eq!(triangles(&strip, true), triangles(&source, false));
        }
    }
}
